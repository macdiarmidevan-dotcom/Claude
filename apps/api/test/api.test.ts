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
let publicKey: string;
let secretKey: string;

// Next Tuesday at least a day out, so it's inside the 14-day booking window and gets weekday rates.
const now = DateTime.now().setZone("America/Chicago");
let tuesday = now.plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
const date = tuesday.toISODate()!;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const golfer = { name: "Pat Golfer", email: "pat@example.com" };

async function teeTimeAt(localTime: string): Promise<string> {
  const res = await app.inject({ url: `/v1/courses/river-bend/tee-sheet?date=${date}`, headers: auth(secretKey) });
  const t = res.json().teeTimes.find((x: { localTime: string }) => x.localTime === localTime);
  if (!t) throw new Error(`No tee time at ${localTime}`);
  return t.id;
}

function book(key: string, body: object) {
  return app.inject({ method: "POST", url: "/v1/courses/river-bend/bookings", headers: auth(key), payload: body });
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  ({ publicKey, secretKey } = await seedRiverBend(db));
  app = buildApp(db);
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("auth", () => {
  it("rejects requests without a valid key", async () => {
    expect((await app.inject({ url: "/v1/courses/river-bend" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/courses/river-bend", headers: auth("pk_nope") })).statusCode).toBe(401);
  });

  it("keeps the staff tee sheet behind the secret key", async () => {
    const res = await app.inject({ url: `/v1/courses/river-bend/tee-sheet?date=${date}`, headers: auth(publicKey) });
    expect(res.statusCode).toBe(403);
  });
});

describe("course and availability", () => {
  it("returns course details and add-ons for the website", async () => {
    const res = await app.inject({ url: "/v1/courses/river-bend", headers: auth(publicKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "River Bend Golf Club", holes: 9, timeZone: "America/Chicago" });
    expect(res.json().addOns.map((a: { code: string }) => a.code)).toContain("gas_cart");
    expect(res.json().id).toBeUndefined();
  });

  it("lists the day's tee times on an 8-minute grid", async () => {
    const res = await app.inject({ url: `/v1/courses/river-bend/tee-times?date=${date}`, headers: auth(publicKey) });
    const times = res.json().teeTimes;
    expect(times[0]).toMatchObject({ localTime: "06:30", spotsLeft: 4 });
    expect(times[1].localTime).toBe("06:38");
    expect(times.at(-1).localTime).toBe("17:58"); // last slot on the grid before the 18:00 cutoff
  });
});

describe("booking", () => {
  it("books and prices a group, with replay and carts", async () => {
    const teeTimeId = await teeTimeAt("09:02");
    const res = await book(secretKey, {
      teeTimeId,
      holes: 18,
      customer: golfer,
      players: [
        { residency: "resident", ageGroup: "adult" },
        { residency: "nonresident", ageGroup: "senior" },
      ],
      addOns: [{ code: "gas_cart", quantity: 2 }],
    });
    expect(res.statusCode).toBe(201);
    const booking = res.json();
    expect(booking).toMatchObject({ players: 2, holes: 18, status: "confirmed", source: "staff" });
    // 2300 resident + 2400 nonresident senior + 2 x 1500 replay + 2 x 1300 cart
    expect(booking.totalCents).toBe(2300 + 2400 + 3000 + 2600);
    expect(booking.teeTime.bookedPlayers).toBe(2);
  });

  it("charges nonresident rates online until residency is verified", async () => {
    const teeTimeId = await teeTimeAt("10:06");
    const body = { teeTimeId, holes: 9, customer: { name: "Sam", email: "sam@example.com" }, players: [{ residency: "resident" }] };
    const unverified = await book(publicKey, body);
    expect(unverified.json().totalCents).toBe(2900);
    expect(unverified.json().source).toBe("widget");

    await db.query("UPDATE customers SET residency_verified = true WHERE email = 'sam@example.com'");
    const verified = await book(publicKey, body);
    expect(verified.json().totalCents).toBe(2300);
  });

  it("won't overbook a tee time, even with simultaneous requests", async () => {
    const teeTimeId = await teeTimeAt("11:02");
    const three = { teeTimeId, holes: 9, customer: golfer, players: [{}, {}, {}] };
    const results = await Promise.all([book(publicKey, three), book(publicKey, three)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe("not_enough_spots");

    const avail = await app.inject({ url: `/v1/courses/river-bend/tee-times?date=${date}&players=2`, headers: auth(publicKey) });
    expect(avail.json().teeTimes.find((t: { id: string }) => t.id === teeTimeId)).toBeUndefined();
  });

  it("frees the spots when a booking is cancelled", async () => {
    const teeTimeId = await teeTimeAt("12:06");
    const full = await book(secretKey, { teeTimeId, holes: 9, customer: golfer, players: [{}, {}, {}, {}] });
    expect((await book(publicKey, { teeTimeId, holes: 9, customer: golfer, players: [{}] })).statusCode).toBe(409);

    const cancel = await app.inject({
      method: "POST",
      url: `/v1/courses/river-bend/bookings/${full.json().id}/cancel`,
      headers: auth(secretKey),
    });
    expect(cancel.json().status).toBe("cancelled");
    expect((await book(publicKey, { teeTimeId, holes: 9, customer: golfer, players: [{}] })).statusCode).toBe(201);
  });

  it("lets staff block a tee time so it can't be booked online", async () => {
    const teeTimeId = await teeTimeAt("13:02");
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/courses/river-bend/tee-times/${teeTimeId}`,
      headers: auth(secretKey),
      payload: { status: "blocked", note: "Ladies league" },
    });
    expect(patch.json()).toMatchObject({ status: "blocked", note: "Ladies league" });
    const res = await book(publicKey, { teeTimeId, holes: 9, customer: golfer, players: [{}] });
    expect(res.json().error.code).toBe("tee_time_blocked");
  });

  it("checks golfers in and won't check in a cancelled booking", async () => {
    const teeTimeId = await teeTimeAt("14:06");
    const { id } = (await book(secretKey, { teeTimeId, holes: 9, customer: golfer, players: [{}] })).json();
    const post = (action: string) =>
      app.inject({ method: "POST", url: `/v1/courses/river-bend/bookings/${id}/${action}`, headers: auth(secretKey) });
    expect((await post("check-in")).json().status).toBe("checked_in");
    expect((await post("cancel")).statusCode).toBe(409);
  });

  it("rejects 18-hole math that doesn't fit a 9-hole course", async () => {
    const teeTimeId = await teeTimeAt("15:02");
    const res = await book(secretKey, { teeTimeId, holes: 12, customer: golfer, players: [{}] });
    expect(res.json().error.code).toBe("invalid_holes");
  });

  it("quotes a price without booking", async () => {
    const teeTimeId = await teeTimeAt("16:06");
    const res = await app.inject({
      method: "POST",
      url: "/v1/courses/river-bend/quotes",
      headers: auth(publicKey),
      payload: { teeTimeId, holes: 9, players: [{ ageGroup: "junior" }], addOns: [{ code: "pull_cart", quantity: 1 }] },
    });
    expect(res.json().totalCents).toBe(2400 + 650);
  });
});
