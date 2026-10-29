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
let token: string;

const base = "/v1/courses/river-bend";
const now = DateTime.now().setZone("America/Chicago");
let tuesday = now.plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
const date = tuesday.toISODate()!;

const call = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

async function walkIn(localTime: string, name: string) {
  const sheet = (await call("GET", `/tee-sheet?date=${date}`)).json();
  const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime === localTime).id;
  const res = await call("POST", "/bookings", {
    teeTimeId,
    holes: 18,
    customer: { name, email: `walkin+${localTime.replace(":", "")}@walkin.local` },
    players: [{}],
    source: "staff",
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const { manager } = await seedRiverBend(db);
  app = buildApp(db);
  token = (await app.inject({ method: "POST", url: `${base}/login`, payload: manager })).json().token;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("golfer accounts", () => {
  let jim: string;

  it("creates an account at a golfer's first check-in and links the booking", async () => {
    const booking = await walkIn("09:02", "Jim");
    const bad = await call("POST", "/golfers", { name: "Jim Sullivan", email: "jim@", phone: "555", bookingId: booking });
    expect(bad.json().error.code).toBe("invalid_email");

    const res = await call("POST", "/golfers", { name: "Jim Sullivan", email: "Jim@Example.com", phone: "(630) 555-0101", bookingId: booking });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Jim Sullivan", email: "jim@example.com", phone: "(630) 555-0101", createdBy: "Course Manager" });
    jim = res.json().id;

    const sheet = (await call("GET", `/tee-sheet?date=${date}`)).json();
    const row = sheet.teeTimes.flatMap((t: { bookings: object[] }) => t.bookings).find((b: { id: string }) => b.id === booking);
    expect(row).toMatchObject({ golferId: jim, customerName: "Jim Sullivan" });

    expect((await call("POST", `/bookings/${booking}/check-in`, { payment: { method: "card" } })).statusCode).toBe(200);
    expect((await call("GET", `/golfers/${jim}`)).json().stats).toMatchObject({ roundsPlayed: 1, holesPlayed: 18 });
  });

  it("refuses a second account with the same phone or email", async () => {
    const sameEmail = await call("POST", "/golfers", { name: "James S", email: "jim@example.com", phone: "630-555-0199" });
    expect(sameEmail.json().error.code).toBe("account_exists");
    const samePhone = await call("POST", "/golfers", { name: "James S", email: "james@example.com", phone: "630.555.0101" });
    expect(samePhone.json().error.code).toBe("phone_taken");
  });

  it("finds accounts by any part of the name, by phone and by email", async () => {
    await call("POST", "/golfers", { name: "Linda Hart", email: "linda@example.com", phone: "630-555-0102" });
    const names = async (q: string) => (await call("GET", `/golfers?q=${encodeURIComponent(q)}`)).json().map((g: { name: string }) => g.name);
    expect(await names("jim sul")).toEqual(["Jim Sullivan"]);
    expect(await names("SULLIVAN")).toEqual(["Jim Sullivan"]);
    expect(await names("5550102")).toEqual(["Linda Hart"]);
    expect(await names("linda@example.com")).toEqual(["Linda Hart"]);
    expect(await names("630")).toEqual([]);
    expect(await names("%")).toEqual([]);
    // Walk-ins and imports without an account aren't offered.
    expect(await names("jim")).toEqual(["Jim Sullivan"]);
  });

  it("keeps every round on one account when later bookings are linked", async () => {
    const second = await walkIn("10:06", "Jim S");
    const linked = await call("PUT", `/bookings/${second}/golfer`, { golferId: jim });
    expect(linked.statusCode).toBe(200);
    await call("POST", `/bookings/${second}/check-in`, { payment: { method: "cash" } });
    const third = await walkIn("11:02", "Jim");
    await call("PUT", `/bookings/${third}/golfer`, { golferId: jim });
    await call("POST", `/bookings/${third}/no-show`);

    const profile = (await call("GET", `/golfers/${jim}`)).json();
    expect(profile.stats).toMatchObject({ roundsPlayed: 2, holesPlayed: 36, noShows: 1 });
    expect(profile.history).toHaveLength(3);
    expect(profile.stats.paidCents).toBeGreaterThan(0);
    expect((await call("GET", `/golfers?q=jim`)).json()[0].roundsPlayed).toBe(2);
  });

  it("turns an earlier booking's customer into the account when the email matches", async () => {
    const sheet = (await call("GET", `/tee-sheet?date=${date}`)).json();
    const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime === "12:06").id;
    const online = (await call("POST", "/bookings", { teeTimeId, holes: 9, customer: { name: "Ana Ruiz", email: "ana@example.com" }, players: [{}] })).json();
    const created = await call("POST", "/golfers", { name: "Ana Ruiz", email: "ana@example.com", phone: "630-555-0103" });
    expect(created.statusCode).toBe(201);
    expect(created.json().history.map((h: { bookingId: string }) => h.bookingId)).toEqual([online.id]);
  });

  it("lets staff fix a typo and logs account changes", async () => {
    const fixed = await call("PATCH", `/golfers/${jim}`, { name: "Jim Sullivan Jr" });
    expect(fixed.json().name).toBe("Jim Sullivan Jr");
    expect((await call("PATCH", `/golfers/${jim}`, { email: "linda@example.com" })).json().error.code).toBe("account_exists");
    const actions = (await call("GET", "/activity")).json().map((a: { action: string }) => a.action);
    expect(actions).toContain("Created a golfer account");
    expect(actions).toContain("Linked a golfer account");
  });

  it("adds guests to a golfer's group: they pay into the booking but not the golfer's own spending", async () => {
    const booking = await walkIn("13:02", "Jim");
    await call("PUT", `/bookings/${booking}/golfer`, { golferId: jim });
    const before = (await call("GET", `/golfers/${jim}`)).json();
    const single = (await call("GET", `/bookings/${booking}`)).json().totalCents;

    const res = await call("POST", `/bookings/${booking}/guests`, { count: 2, riding: true });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.players).toBe(3);
    expect(after.totalCents).toBe(single * 3 + 2 * 1300);
    const guestLines = after.lines.filter((l: { description: string }) => l.description.startsWith("Guest:"));
    expect(guestLines.reduce((t: number, l: { totalCents: number }) => t + l.totalCents, 0)).toBe(after.totalCents - single);

    const row = (await call("GET", `/tee-sheet?date=${date}`)).json().teeTimes.flatMap((t: { bookings: object[] }) => t.bookings).find((b: { id: string }) => b.id === booking);
    expect(row).toMatchObject({ players: 3, riding: true });

    expect((await call("POST", `/bookings/${booking}/guests`, { count: 2 })).json().error.code).toBe("not_enough_spots");

    await call("POST", `/bookings/${booking}/check-in`, { payment: { method: "card" } });
    const profile = (await call("GET", `/golfers/${jim}`)).json();
    expect(profile.stats.guestsBrought).toBe(before.stats.guestsBrought + 2);
    expect(profile.stats.paidCents - before.stats.paidCents).toBe(Math.round(after.totalCents / 3));
    expect(profile.history.find((h: { bookingId: string }) => h.bookingId === booking)).toMatchObject({ guests: 2, players: 3 });
  });
});
