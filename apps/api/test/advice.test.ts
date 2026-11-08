import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { adviceRange } from "../src/advice.ts";
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
let tuesday = DateTime.now().setZone("America/Chicago").plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
const tuesdays = [tuesday, tuesday.plus({ days: 7 })].map((d) => d.toISODate()!);

const call = (token: string, method: "GET" | "POST", path: string, payload?: object) =>
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

describe("recommended rates", () => {
  it("looks back over recent weeks or the coming weeks last year", () => {
    expect(adviceRange("2026-11-08", 8, "recent")).toEqual({ from: "2026-09-13", to: "2026-11-07" });
    expect(adviceRange("2026-11-08", 4, "last_year")).toEqual({ from: "2025-11-08", to: "2025-12-05" });
  });

  it("recommends a higher price where the tee sheet was full, for managers only", async () => {
    // Fill every Tuesday morning tee time on two weeks, a few riding, then move those days five weeks back.
    let n = 0;
    for (const date of tuesdays) {
      const sheet = (await call(staff, "GET", `/tee-sheet?date=${date}`)).json();
      for (const t of sheet.teeTimes.filter((t: { localTime: string }) => t.localTime >= "09:00" && t.localTime < "12:00")) {
        n++;
        const res = await call(staff, "POST", "/bookings", {
          teeTimeId: t.id,
          holes: 9,
          customer: { name: `Golfer ${n}`, email: `golfer${n}@example.com` },
          players: [{}, {}, {}, {}],
          addOns: n % 3 === 0 ? [{ code: "gas_cart", quantity: 4 }] : [],
          source: "staff",
        });
        expect(res.statusCode, res.body).toBe(201);
      }
    }
    // Keep the local clock time, in case the move crosses a daylight saving change.
    await db.query("UPDATE tee_times SET starts_at = ((starts_at AT TIME ZONE 'America/Chicago') - interval '35 days') AT TIME ZONE 'America/Chicago'");

    expect((await call(staff, "GET", "/pricing/recommendations")).json().error.code).toBe("manager_only");
    const res = await call(manager, "GET", "/pricing/recommendations?weeks=8");
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.cells).toHaveLength(28);
    expect(r.averageFillPct).toBeGreaterThan(0);
    const morning = r.cells.find((c: { weekday: number; band: string }) => c.weekday === 2 && c.band === "morning");
    expect(morning).toMatchObject({ status: "raise", fillPct: 100, currentCents: 2900 });
    expect(morning.recommendedCents).toBeGreaterThan(2900);
    expect(morning.weeklyGainCents).toBeGreaterThan(0);
    expect(r.weeklyGainCents).toBeGreaterThanOrEqual(morning.weeklyGainCents);
    // Days nobody opened have no tee times, so there's nothing to go on.
    expect(r.cells.find((c: { weekday: number; band: string }) => c.weekday === 4 && c.band === "morning").status).toBe("no_data");

    expect((await call(manager, "GET", "/pricing/recommendations?weeks=2")).statusCode).toBe(400);
  });
});
