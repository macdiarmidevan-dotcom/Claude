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
async function book(time: string, players: number, email: string) {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${tuesday.toISODate()}`)).json();
  const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime === time).id;
  return (await call(staff, "POST", "/bookings", { teeTimeId, holes: 9, customer: { name: "Golfer", email }, players: Array.from({ length: players }, () => ({})), source: "staff" })).json();
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

describe("punch cards, passes and points", () => {
  let punch: string;
  let season: string;
  let golfer: string;
  let other: string;

  it("lets managers set up what's sold", async () => {
    expect((await call(staff, "POST", "/pass-types", { name: "x", kind: "punch_card", priceCents: 100, rounds: 5 })).statusCode).toBe(403);
    expect((await call(manager, "POST", "/pass-types", { name: "10-round card", kind: "punch_card", priceCents: 20000 })).json().error.code).toBe("rounds_required");
    punch = (await call(manager, "POST", "/pass-types", { name: "10-round card", kind: "punch_card", priceCents: 20000, rounds: 10, validDays: 365 })).json().id;
    season = (await call(manager, "POST", "/pass-types", { name: "Season pass", kind: "season_pass", priceCents: 90000, coversCart: true })).json().id;
    expect((await call(staff, "GET", "/pass-types")).json()).toHaveLength(2);
    const saved = (await call(manager, "PUT", "/settings/loyalty", { pointsPerDollar: 1, rewardPoints: 100, rewardCents: 500 })).json();
    expect(saved).toEqual({ pointsPerDollar: 1, rewardPoints: 100, rewardCents: 500 });

    golfer = (await call(staff, "POST", "/golfers", { name: "Pat Doyle", email: `pat${++n}@example.com`, phone: "630-555-0101" })).json().id;
    other = (await call(staff, "POST", "/golfers", { name: "Sam Lee", email: `sam${++n}@example.com`, phone: "630-555-0102" })).json().id;
  });

  it("sells a punch card onto the golfer's account and earns points", async () => {
    const after = (await call(staff, "POST", `/golfers/${golfer}/passes`, { passTypeId: punch, paymentMethod: "cash" })).json();
    expect(after.passes[0]).toMatchObject({ name: "10-round card", roundsLeft: 10, usable: true });
    expect(after.passes[0].expiresAt).toBeTruthy();
    expect(after.loyalty).toMatchObject({ enabled: true, points: 200, rewardsAvailable: 2 });
    const sale = (await db.query("SELECT l.category, s.payment_method FROM sales s JOIN sale_lines l ON l.sale_id = s.id WHERE s.customer_id = $1", [golfer])).rows;
    expect(sale).toEqual([{ category: "Passes", payment_method: "cash" }]);
  });

  it("pays a player's round with the punch card and the rest by card", async () => {
    const b = await book("10:06", 2, `pat${n}@example.com`);
    await call(staff, "PUT", `/bookings/${b.id}/golfer`, { golferId: golfer });
    const perPlayer = b.totalCents / 2;
    const res = await call(staff, "POST", `/bookings/${b.id}/check-in`, { pass: { golferPassId: (await wallet(golfer)).passes[0].id, rounds: 1 }, payment: { method: "card" } });
    expect(res.json()).toMatchObject({ status: "checked_in", payment: { balanceCents: 0 } });
    expect(await payments(b.id)).toEqual(
      expect.arrayContaining([
        { method: "card", amount_cents: perPlayer },
        { method: "punch_card", amount_cents: perPlayer },
      ]),
    );
    const w = await wallet(golfer);
    expect(w.passes[0].roundsLeft).toBe(9);
    // Points on what was paid by card, not on the punch.
    expect(w.loyalty.points).toBe(200 + Math.floor(perPlayer / 100));
  });

  it("spends points in whole rewards", async () => {
    const b = await book("10:14", 1, `pat${n}@example.com`);
    await call(staff, "PUT", `/bookings/${b.id}/golfer`, { golferId: golfer });
    const before = (await wallet(golfer)).loyalty.points;
    expect((await call(staff, "POST", `/bookings/${b.id}/check-in`, { points: 150, payment: { method: "cash" } })).json().error.code).toBe("whole_rewards");
    expect((await call(staff, "POST", `/bookings/${b.id}/check-in`, { points: 100_000, payment: { method: "cash" } })).json().error.code).toBe("not_enough_points");
    const res = await call(staff, "POST", `/bookings/${b.id}/check-in`, { points: 200, payment: { method: "cash" } });
    expect(res.json().payment.balanceCents).toBe(0);
    expect(await payments(b.id)).toContainEqual({ method: "loyalty", amount_cents: 1000 });
    const after = (await wallet(golfer)).loyalty;
    expect(after.points).toBe(before - 200 + Math.floor((b.totalCents - 1000) / 100));
    expect(after.history.map((h: { reason: string }) => h.reason)).toContain("redeem");
  });

  it("keeps passes to their owner and season passes to the holder", async () => {
    const sold = (await call(staff, "POST", `/golfers/${other}/passes`, { passTypeId: season, paymentMethod: "card" })).json();
    const seasonPass = sold.passes[0];
    expect(seasonPass).toMatchObject({ kind: "season_pass", roundsLeft: null, usable: true, coversCart: true });

    const mine = await book("10:22", 2, `pat${n}@example.com`);
    await call(staff, "PUT", `/bookings/${mine.id}/golfer`, { golferId: golfer });
    const stolen = await call(staff, "POST", `/bookings/${mine.id}/check-in`, { pass: { golferPassId: seasonPass.id, rounds: 1 }, payment: { method: "card" } });
    expect(stolen.json().error.code).toBe("not_their_pass");

    const theirs = await book("10:30", 2, `sam${n}@example.com`);
    await call(staff, "PUT", `/bookings/${theirs.id}/golfer`, { golferId: other });
    expect((await call(staff, "POST", `/bookings/${theirs.id}/check-in`, { pass: { golferPassId: seasonPass.id, rounds: 2 } })).json().error.code).toBe("season_pass_holder_only");
    const ok = await call(staff, "POST", `/bookings/${theirs.id}/check-in`, { pass: { golferPassId: seasonPass.id, rounds: 1 }, payment: { method: "cash" } });
    expect(ok.json().status).toBe("checked_in");

    // A walk-in with no account can't use anyone's pass.
    const anon = await book("10:38", 1, "nobody@walkin.local");
    expect((await call(staff, "POST", `/bookings/${anon.id}/check-in`, { points: 100 })).json().error.code).toBe("no_account");
  });

  it("takes back a sale's points when it's refunded, and lets managers adjust", async () => {
    const before = (await wallet(other)).loyalty.points;
    const { rows } = await db.query("SELECT id FROM sales WHERE customer_id = $1", [other]);
    await call(manager, "POST", `/sales/${rows[0].id}/refund`);
    expect((await wallet(other)).loyalty.points).toBe(Math.max(0, before - 900));
    expect((await call(staff, "POST", `/golfers/${other}/points`, { change: 50, note: "Sorry for the wait" })).statusCode).toBe(403);
    expect((await call(manager, "POST", `/golfers/${other}/points`, { change: 50, note: "" })).json().error.code).toBe("note_required");
    const adjusted = (await call(manager, "POST", `/golfers/${other}/points`, { change: 50, note: "Sorry for the wait" })).json();
    expect(adjusted.loyalty.history[0]).toMatchObject({ change: 50, reason: "adjust", note: "Sorry for the wait" });
  });
});
