import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { compareRange } from "../src/analytics.ts";
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
const date = tuesday.toISODate()!;
const saturday = tuesday.plus({ days: 4 }).toISODate()!;

const call = (token: string, method: "GET" | "POST" | "PUT", path: string, payload?: object) =>
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

async function book(day: string, time: string, players: number, holes: 9 | 18, riding: boolean, n: number) {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${day}`)).json();
  const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime >= time).id;
  const res = await call(staff, "POST", "/bookings", {
    teeTimeId,
    holes,
    customer: { name: `Golfer ${n}`, email: `golfer${n}@example.com` },
    players: Array.from({ length: players }, () => ({})),
    addOns: riding ? [{ code: "gas_cart", quantity: players }] : [],
    source: "staff",
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe("manager overview report", () => {
  it("works out the comparison dates", () => {
    expect(compareRange("2026-06-08", "2026-06-14", "previous")).toEqual({ from: "2026-06-01", to: "2026-06-07" });
    expect(compareRange("2026-01-01", "2026-06-30", "last_year")).toEqual({ from: "2025-01-01", to: "2025-06-30" });
    expect(compareRange("2026-06-08", "2026-06-14", "none")).toBeNull();
  });

  it("reports revenue, rounds, utilization, yield and rate mix", async () => {
    const a = await book(date, "09:02", 2, 18, true, 1);
    const b = await book(saturday, "10:00", 3, 9, false, 2);
    const c = await book(saturday, "11:00", 1, 18, false, 3);
    await call(staff, "POST", `/bookings/${c.id}/no-show`);

    expect((await call(staff, "GET", `/reports/overview?from=${date}&to=${saturday}`)).json().error.code).toBe("manager_only");
    const res = await call(manager, "GET", `/reports/overview?from=${date}&to=${saturday}&compare=last_year`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();

    expect(r.compare).toMatchObject({ kind: "last_year" });
    expect(r.revenue.greenFeesCents + r.revenue.cartsAndExtrasCents).toBe(a.totalCents + b.totalCents);
    expect(r.revenue.cartsAndExtrasCents).toBe(2 * 1300);
    expect(r.rounds).toMatchObject({ rounds: 5, noShows: 1, holes9: 3, holes18: 2, riding: 2, walking: 3 });
    expect(r.rounds.weekday.rounds).toBe(2);
    expect(r.rounds.weekend.rounds).toBe(3);
    expect(r.rounds.spots).toBeGreaterThan(5);
    expect(r.rounds.occupancy).toBeGreaterThan(0);
    expect(r.yield.avgGreenFeeCents).toBe(Math.round(r.revenue.greenFeesCents / 5));
    expect(r.yield.revPattCents).toBe(Math.round(r.revenue.greenFeesCents / r.rounds.spots));

    const nine = r.heat.find((h: { weekday: number; hour: number }) => h.weekday === 2 && h.hour === 9);
    expect(nine.players).toBe(2);
    expect(nine.spots).toBeGreaterThanOrEqual(4);

    // An 18-hole weekday round is priced as a first loop plus a replay; rounds count first loops only.
    type Mix = { rounds: number; isReplay: boolean };
    expect(r.rateMix.filter((m: Mix) => !m.isReplay).reduce((s: number, m: Mix) => s + m.rounds, 0)).toBe(5);
    expect(r.rateMix.some((m: Mix) => m.isReplay)).toBe(true);
    expect(r.rateMix.reduce((s: number, m: { revenueCents: number }) => s + m.revenueCents, 0)).toBe(r.revenue.greenFeesCents);
    expect(r.rateMix[0].name).toBeTruthy();
    expect(r.topRateCents).toBeGreaterThan(0);
    expect(r.avgDiscountPct).toBeGreaterThanOrEqual(0);
    expect(r.previous.rounds.rounds).toBe(0);
  });

  it("takes up to a year and refuses longer", async () => {
    const from = tuesday.minus({ days: 300 }).toISODate();
    expect((await call(manager, "GET", `/reports/overview?from=${from}&to=${date}`)).statusCode).toBe(200);
    const long = await call(manager, "GET", `/reports/overview?from=${tuesday.minus({ days: 400 }).toISODate()}&to=${date}`);
    expect(long.json().error.code).toBe("invalid_range");
  });
});
