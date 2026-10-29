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
const call = (token: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

let tuesday = DateTime.now().setZone("America/Chicago").plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
let n = 0;
async function book(time: string, players: number, email: string, holes = 18) {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${tuesday.toISODate()}`)).json();
  const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime === time).id;
  return (await call(staff, "POST", "/bookings", { teeTimeId, holes, customer: { name: "Golfer", email }, players: Array.from({ length: players }, () => ({})), source: "staff" })).json();
}
const wallet = async (golferId: string) => (await call(staff, "GET", `/golfers/${golferId}/wallet`)).json();
const payments = async (bookingId: string) =>
  (await db.query("SELECT method, amount_cents FROM booking_payments WHERE booking_id = $1 ORDER BY amount_cents", [bookingId])).rows;

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

describe("rain checks and refunds", () => {
  let golfer: string;
  let rained: { id: string; totalCents: number };
  let code: string;

  it("gives credit for the holes a group didn't play, off the round they paid for", async () => {
    golfer = (await call(staff, "POST", "/golfers", { name: "Kim Ortiz", email: `kim${++n}@example.com`, phone: "630-555-0111" })).json().id;
    rained = await book("08:06", 2, "rain@example.com");
    await call(staff, "PUT", `/bookings/${rained.id}/golfer`, { golferId: golfer });
    // Can't give credit before they've paid and gone out.
    expect((await call(staff, "POST", `/bookings/${rained.id}/rain-checks`, { players: 2, holesPlayed: 9 })).json().error.code).toBe("invalid_status");
    await call(staff, "POST", `/bookings/${rained.id}/check-in`, { payment: { method: "cash" } });

    // Setting the amount by hand is for managers.
    expect((await call(staff, "POST", `/bookings/${rained.id}/rain-checks`, { players: 2, holesPlayed: 9, amountCents: 100 })).statusCode).toBe(403);
    const res = await call(staff, "POST", `/bookings/${rained.id}/rain-checks`, { players: 2, holesPlayed: 9 });
    expect(res.statusCode).toBe(201);
    const rc = res.json();
    code = rc.code;
    expect(code).toMatch(/^RC-[A-Z2-9]{6}$/);
    // Half the round (9 of 18 holes) for both players.
    expect(rc).toMatchObject({ golferId: golfer, players: 2, holesUnplayed: 9, amountCents: Math.round(rained.totalCents / 2), remainingCents: Math.round(rained.totalCents / 2), usable: true });
    const after = (await call(staff, "GET", `/bookings/${rained.id}`)).json();
    expect(after.totalCents).toBe(rained.totalCents - rc.amountCents);
    expect(after.payment.status).toBe("paid");
    expect((await wallet(golfer)).rainChecks[0].code).toBe(code);

    // Not more than the round has left to give.
    expect((await call(staff, "POST", `/bookings/${rained.id}/rain-checks`, { players: 2, holesPlayed: 0 })).json().error.code).toBe("too_much");
  });

  it("pays toward a later round with the code, and keeps what's left", async () => {
    const later = await book("09:02", 1, "later@example.com", 9);
    expect((await call(staff, "GET", `/rain-checks/${code.toLowerCase()}`)).json().remainingCents).toBeGreaterThan(later.totalCents);
    const done = (await call(staff, "POST", `/bookings/${later.id}/check-in`, { rainCheck: code })).json();
    expect(done).toMatchObject({ status: "checked_in", payment: { status: "paid", methods: ["rain_check"] } });
    const rc = (await call(staff, "GET", `/rain-checks/${code}`)).json();
    expect(rc.remainingCents).toBe(rc.amountCents - later.totalCents);

    // Part of it is spent, so it can't be voided.
    expect((await call(manager, "POST", `/rain-checks/${rc.id}/void`)).json().error.code).toBe("already_used");
  });

  it("voids an unused rain check and puts the round back", async () => {
    const b = await book("09:10", 1, "void@example.com");
    await call(staff, "POST", `/bookings/${b.id}/check-in`, { payment: { method: "card" } });
    const rc = (await call(staff, "POST", `/bookings/${b.id}/rain-checks`, { players: 1, holesPlayed: 12, includeCart: false })).json();
    expect(rc.amountCents).toBe(Math.round(b.totalCents / 3));
    expect((await call(staff, "POST", `/rain-checks/${rc.id}/void`)).statusCode).toBe(403);
    expect((await call(manager, "POST", `/rain-checks/${rc.id}/void`)).json()).toMatchObject({ status: "void", usable: false });
    expect((await call(staff, "GET", `/bookings/${b.id}`)).json().totalCents).toBe(b.totalCents);
  });

  it("refunds a round by cash, and the drawer and round both net it out", async () => {
    const b = await book("09:18", 2, "refund@example.com");
    await call(staff, "POST", `/bookings/${b.id}/check-in`, { payment: { method: "cash" } });
    const today = DateTime.now().setZone("America/Chicago").toISODate();
    const cashBefore = (await call(staff, "GET", `/closes/${today}`)).json().expected.cash;

    expect((await call(staff, "POST", `/bookings/${b.id}/refund`, { amountCents: 1000, method: "cash", reason: "Frost" })).statusCode).toBe(403);
    expect((await call(manager, "POST", `/bookings/${b.id}/refund`, { amountCents: 1000, method: "cash", reason: " " })).json().error.code).toBe("reason_required");
    expect((await call(manager, "POST", `/bookings/${b.id}/refund`, { amountCents: 1000, method: "card", reason: "Frost" })).json().error.code).toBe("too_much");
    const after = (await call(manager, "POST", `/bookings/${b.id}/refund`, { amountCents: 1000, method: "cash", reason: "Frost delay, left after 3" })).json();
    expect(after).toMatchObject({ totalCents: b.totalCents - 1000, payment: { status: "paid", paidCents: b.totalCents - 1000 } });
    expect(after.lines.some((l: { description: string; totalCents: number }) => l.description.startsWith("Refund:") && l.totalCents < 0)).toBe(true);
    expect((await call(staff, "GET", `/closes/${today}`)).json().expected.cash).toBe(cashBefore - 1000);
    expect((await payments(b.id)).find((p: { amount_cents: number }) => p.amount_cents === -1000)).toMatchObject({ method: "cash" });
  });

  it("lets managers set how long rain checks are good for", async () => {
    expect((await call(staff, "GET", "/settings/rain-checks")).json()).toEqual({ rainCheckDays: 365 });
    expect((await call(staff, "PUT", "/settings/rain-checks", { rainCheckDays: 30 })).statusCode).toBe(403);
    expect((await call(manager, "PUT", "/settings/rain-checks", { rainCheckDays: 30 })).json()).toEqual({ rainCheckDays: 30 });
  });
});
