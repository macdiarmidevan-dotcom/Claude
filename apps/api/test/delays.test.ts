import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { seedRiverBend } from "../src/seed.ts";

process.env.NODE_ENV = "test";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let manager: string;
let staff: string;

const base = "/v1/courses/river-bend";
// A Wednesday a few weeks out, so the time of day the tests run doesn't matter.
let day = DateTime.now().setZone("America/Chicago").plus({ weeks: 3 });
while (day.weekday !== 3) day = day.plus({ days: 1 });
const date = day.toISODate()!;
const us = day.toFormat("M/d/yyyy");
const call = (token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db);
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
  await call(manager, "POST", "/staff", { name: "Jordan Price", email: "jordan@example.com", role: "staff", password: "proshop-pass1" });
  staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "jordan@example.com", password: "proshop-pass1" } })).json().token;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

async function sheet() {
  return (await call(staff, "GET", `/tee-sheet?date=${date}`)).json().teeTimes as { id: string; localTime: string; bookings: { id: string; customerName: string }[] }[];
}
async function bookAt(time: string, name: string, phone: string) {
  const t = (await sheet()).find((x) => x.localTime === time)!;
  const b = (await call(staff, "POST", "/bookings", { teeTimeId: t.id, holes: 18, customer: { name, email: `${name.split(" ")[0]!.toLowerCase()}@example.com` }, players: [{}, {}], source: "staff" })).json();
  const g = (await call(staff, "POST", "/golfers", { name, email: `${name.split(" ")[0]!.toLowerCase()}@example.com`, phone })).json();
  await call(staff, "PUT", `/bookings/${b.id}/golfer`, { golferId: g.id });
  return b;
}

describe("weather delays", () => {
  it("pushes the tee sheet back, groups and all, and texts the golfers their new time", async () => {
    await bookAt("06:30", "Ann Lake", "630-555-0101");
    await bookAt("07:02", "Bo Park", "630-555-0102");
    const before = await sheet();
    expect(before[0]!.localTime).toBe("06:30");

    const res = (
      await call(staff, "POST", "/tee-sheet/delays", { date, from: "06:30", minutes: 45, reason: "frost", note: "Greens white", notify: { channels: ["sms"] } })
    ).json();
    expect(res.delay).toMatchObject({ fromTime: "06:30", minutes: 45, reason: "frost", teeTimes: before.length, groups: 2, staff: "Jordan Price" });
    expect(res.campaign).toMatchObject({ golfers: 2, sent: 2, kind: "operational" });
    expect(res.campaign.messages.find((m: any) => m.name === "Ann Lake").body).toBe(
      "Hi Ann, Frost delay at River Bend Golf Club today: tee times are running 45 minutes late. Your tee time is now 7:15 AM. Questions? Call the pro shop.",
    );

    // Loading the sheet again doesn't fill the gap with fresh template times.
    const after = await sheet();
    expect(after.length).toBe(before.length);
    expect(after[0]!.localTime).toBe("07:15");
    expect(after.find((t) => t.bookings.some((b) => b.customerName === "Ann Lake"))!.localTime).toBe("07:15");
    expect(after.find((t) => t.bookings.some((b) => b.customerName === "Bo Park"))!.localTime).toBe("07:47");
  });

  it("puts synced bookings on the delayed sheet, and can be taken back", async () => {
    const csv = ["Confirmation #,Tee Date,Tee Time,Golfer Name,# Players,Holes,Total,Paid Online,Status", `TIU-9,${us},6:38 AM,Cy Young,2,18,,No,Confirmed`].join("\n");
    expect((await call(manager, "POST", "/imports", { source: "teeitup", csv })).statusCode).toBe(200);
    let after = await sheet();
    expect(after.find((t) => t.bookings.some((b) => b.customerName === "Cy Young"))!.localTime).toBe("07:23");

    const delays = (await call(staff, "GET", `/tee-sheet/delays?date=${date}`)).json();
    expect(delays).toHaveLength(1);
    await call(staff, "POST", `/tee-sheet/delays/${delays[0].id}/undo`);
    expect((await call(staff, "POST", `/tee-sheet/delays/${delays[0].id}/undo`)).json().error.code).toBe("already_undone");
    after = await sheet();
    expect(after[0]!.localTime).toBe("06:30");
    expect(after.find((t) => t.bookings.some((b) => b.customerName === "Cy Young"))!.localTime).toBe("06:38");
    expect(after.find((t) => t.bookings.some((b) => b.customerName === "Bo Park"))!.localTime).toBe("07:02");
  });
});
