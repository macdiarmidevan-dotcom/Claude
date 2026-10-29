import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { buildApp } from "../src/app.ts";
import { seedRiverBend } from "../src/seed.ts";

process.env.NODE_ENV = "test";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let secretKey: string;
let managerKey: string;
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

// A Wednesday a few weeks out, so it isn't affected by today's date.
let day = DateTime.now().setZone("America/Chicago").plus({ weeks: 3 });
while (day.weekday !== 3) day = day.plus({ days: 1 });
const iso = day.toISODate()!;
const us = day.toFormat("M/d/yyyy");

const header = "Confirmation #,Tee Date,Tee Time,Golfer Name,# Players,Holes,Total,Paid Online,Status";
const csv = (...rows: string[]) => [header, ...rows].join("\n");

function upload(body: object, key = managerKey) {
  return app.inject({ method: "POST", url: "/v1/courses/river-bend/imports", headers: auth(key), payload: { source: "teeitup", ...body } });
}

async function sheet() {
  const res = await app.inject({ url: `/v1/courses/river-bend/tee-sheet?date=${iso}`, headers: auth(secretKey) });
  return res.json().teeTimes as { localTime: string; maxPlayers: number; bookings: { customerName: string; players: number; status: string; totalCents: number; payment: { paidCents: number; methods: string[] } }[] }[];
}
const at = async (time: string) => (await sheet()).find((t) => t.localTime === time);

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  ({ secretKey, managerKey } = await seedRiverBend(db));
  app = buildApp(db);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("tee sheet import", () => {
  it("is for managers only", async () => {
    expect((await upload({ csv: csv() }, secretKey)).statusCode).toBe(403);
  });

  it("previews without saving, then imports", async () => {
    const file = csv(
      `TIU-1,${us},7:02 AM,Mike Sullivan,4,18,$116.00,$116.00,Confirmed`,
      `TIU-2,${us},7:10 AM,Dana Kowalski,2,9,,No,Confirmed`,
      `TIU-3,${us},7:18 AM,Jim Nowak,2,9,$58.00,,Cancelled`,
      `TIU-4,${us},sometime,Nobody,1,9,,,`,
    );
    const preview = (await upload({ csv: file, dryRun: true })).json();
    expect(preview).toMatchObject({ dryRun: true, dates: [iso], counts: { created: 2, problems: 1 } });
    expect(preview.problems[0]).toMatchObject({ line: 5 });
    expect((await at("07:02"))!.bookings).toEqual([]);

    const done = (await upload({ csv: file, fileName: "teeitup.csv" })).json();
    expect(done.counts).toMatchObject({ created: 2, updated: 0, cancelled: 0 });
    const mike = (await at("07:02"))!.bookings[0]!;
    expect(mike).toMatchObject({ customerName: "Mike Sullivan", players: 4, totalCents: 11600, payment: { paidCents: 11600, methods: ["prepaid"] } });
    // No price in the file: our own nonresident weekday rate, $29 each.
    expect((await at("07:10"))!.bookings[0]).toMatchObject({ players: 2, totalCents: 5800, payment: { paidCents: 0 } });
    // Cancelled before it ever reached us: nothing to add.
    expect((await at("07:18"))!.bookings).toEqual([]);

    const runs = (await app.inject({ url: "/v1/courses/river-bend/imports", headers: auth(managerKey) })).json();
    expect(runs[0]).toMatchObject({ source: "teeitup", fileName: "teeitup.csv", counts: { created: 2, problems: 1 } });
  });

  it("re-imports without duplicates, applies changes and cancels removed bookings", async () => {
    const same = (await upload({ csv: csv(`TIU-1,${us},7:02 AM,Mike Sullivan,4,18,$116.00,$116.00,Confirmed`, `TIU-2,${us},7:10 AM,Dana Kowalski,2,9,,No,Confirmed`) })).json();
    expect(same.counts).toMatchObject({ created: 0, updated: 0, unchanged: 2, cancelled: 0 });

    // Dana moved to 7:26 with a third player; Mike's booking was cancelled on TeeItUp (gone from the file).
    const changed = (await upload({ csv: csv(`TIU-2,${us},7:26 AM,Dana Kowalski,3,9,,No,Confirmed`) })).json();
    expect(changed.counts).toMatchObject({ updated: 1, cancelled: 1 });
    expect(changed.changes.find((c: { externalId: string }) => c.externalId === "TIU-2").detail).toMatch(/moved, players 2 → 3/);
    expect((await at("07:10"))!.bookings).toEqual([]);
    expect((await at("07:26"))!.bookings[0]).toMatchObject({ players: 3, totalCents: 8700 });
    expect((await at("07:02"))!.bookings).toEqual([]);
  });

  it("never changes a group that's already checked in", async () => {
    const t = await sheet();
    const dana = t.find((x) => x.localTime === "07:26")!.bookings[0]!;
    const id = (await db.query("SELECT id FROM bookings WHERE external_id = 'TIU-2'")).rows[0].id;
    await app.inject({ method: "POST", url: `/v1/courses/river-bend/bookings/${id}/check-in`, headers: auth(secretKey), payload: { payment: { method: "card" } } });
    const res = (await upload({ csv: csv(`TIU-2,${us},8:06 AM,Dana Kowalski,1,9,,No,Confirmed`) })).json();
    expect(res.changes[0]).toMatchObject({ action: "unchanged", detail: "Already checked in, left as it is" });
    expect((await at("07:26"))!.bookings[0]).toMatchObject({ players: dana.players, status: "checked_in" });
  });

  it("adds a tee time the provider has and we don't, and flags overbooking", async () => {
    const res = (await upload({
      source: "golfnow",
      csv: csv(`GN-1,${us},7:05 AM,Shotgun Group,4,9,,,`, `GN-2,${us},8:14 AM,Big Group,3,9,,,`, `GN-3,${us},8:14 AM,Other Group,3,9,,,`),
    })).json();
    expect(res.counts.created).toBe(3);
    expect(res.changes[0].detail).toMatch(/Added a tee time/);
    expect((await at("07:05"))!.bookings[0]).toMatchObject({ customerName: "Shotgun Group" });
    expect(res.overbooked).toEqual([{ date: iso, time: "08:14", players: 6, maxPlayers: 4 }]);
  });
});
