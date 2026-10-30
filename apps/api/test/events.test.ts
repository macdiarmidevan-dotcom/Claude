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

const sheetAt = async (date: string, time: string) =>
  (await call(staff, "GET", `/tee-sheet?date=${date}`)).json().teeTimes.find((t: { localTime: string }) => t.localTime === time);

describe("standing tee times", () => {
  let golfer: string;
  let standing: string;
  const nextTuesday = tuesday.toISODate()!;
  const weekAfter = tuesday.plus({ weeks: 1 }).toISODate()!;

  it("books a golfer's weekly time a few weeks ahead", async () => {
    golfer = (await call(staff, "POST", "/golfers", { name: "Walt Brennan", email: `walt${++n}@example.com`, phone: "630-555-0120" })).json().id;
    expect((await call(staff, "POST", "/standing-times", { golferId: golfer, weekday: 2, localTime: "07:02", players: 4, holes: 18, startsOn: nextTuesday })).statusCode).toBe(403);
    const res = await call(manager, "POST", "/standing-times", { golferId: golfer, weekday: 2, localTime: "07:02", players: 4, holes: 18, riding: true, residency: "resident", startsOn: nextTuesday });
    expect(res.statusCode).toBe(201);
    standing = res.json().id;
    expect(res.json().upcoming.filter((u: { bookingId: string | null }) => u.bookingId).length).toBeGreaterThanOrEqual(7);
    const t = await sheetAt(weekAfter, "07:02");
    expect(t.bookings[0]).toMatchObject({ customerName: "Walt Brennan", players: 4, source: "standing", riding: true, resident: true });
  });

  it("notes a week it can't book, and cancels future weeks when stopped", async () => {
    // Someone else has 07:10 three weeks out; the standing time can't fit there.
    const date = tuesday.plus({ weeks: 9 }).toISODate()!;
    const t = await sheetAt(date, "07:10");
    await call(staff, "POST", "/bookings", { teeTimeId: t.id, holes: 9, customer: { name: "Busy", email: "busy@example.com" }, players: [{}, {}, {}], source: "staff" });
    const s2 = (await call(manager, "POST", "/standing-times", { golferId: golfer, weekday: 2, localTime: "07:10", players: 2, holes: 9, startsOn: date, endsOn: date })).json();
    // Nine weeks out is past the booking window, so it waits until that day's sheet is opened.
    expect(s2.upcoming).toHaveLength(0);
    await sheetAt(date, "07:10");
    const listed = (await call(staff, "GET", "/standing-times")).json().find((s: { id: string }) => s.id === s2.id);
    expect(listed.upcoming[0]).toMatchObject({ date, bookingId: null });
    expect(listed.upcoming[0].problem).toMatch(/spot/);

    const stopped = (await call(manager, "PATCH", `/standing-times/${standing}`, { active: false })).json();
    expect(stopped).toMatchObject({ active: false, upcoming: [] });
    expect((await sheetAt(weekAfter, "07:02")).bookings).toHaveLength(0);
  });
});

describe("leagues and outings", () => {
  let league: string;
  let firstDate: string;
  const day = tuesday.plus({ weeks: 2 });

  it("holds a block of tee times on each league date, leaving booked times alone", async () => {
    // A group already has 15:06 on the first night.
    const t = await sheetAt(day.toISODate()!, "15:02");
    await call(staff, "POST", "/bookings", { teeTimeId: t.id, holes: 9, customer: { name: "Early Bird", email: "early@example.com" }, players: [{}], source: "staff" });

    const res = await call(manager, "POST", "/events", {
      name: "Tuesday Men's League",
      kind: "league",
      format: "tee_times",
      holes: 9,
      pricePerPlayerCents: 2500,
      includesCart: true,
      contactName: "Ray Ortiz",
      schedule: { startsOn: day.toISODate(), endsOn: day.plus({ weeks: 3 }).toISODate(), startTime: "14:46", slots: 4 },
    });
    expect(res.statusCode).toBe(201);
    const { event, conflicts } = res.json();
    league = event.id;
    expect(event.dates).toHaveLength(4);
    expect(conflicts).toEqual([{ date: day.toISODate(), localTime: "15:02", detail: "Booked: Early Bird" }]);
    expect(event.dates[0]).toMatchObject({ held: 3, slots: 4 });
    expect(event.dates[1]).toMatchObject({ held: 4 });
    firstDate = event.dates[0].id;

    const held = await sheetAt(day.toISODate()!, "14:46");
    expect(held).toMatchObject({ status: "blocked", note: "Tuesday Men's League" });
    // Nobody can book into a held time.
    const blocked = await call(staff, "POST", "/bookings", { teeTimeId: held.id, holes: 9, customer: { name: "X", email: "x@example.com" }, players: [{}], source: "staff" });
    expect(blocked.json().error.code).toBe("tee_time_blocked");
  });

  it("pairs the roster into groups with tee times, and checks them in", async () => {
    const golfer = (await call(staff, "POST", "/golfers", { name: "Al Green", email: `al${++n}@example.com`, phone: "630-555-0130" })).json().id;
    await call(staff, "POST", `/events/${league}/players`, { golferId: golfer, handicap: 4 });
    expect((await call(staff, "POST", `/events/${league}/players`, { golferId: golfer })).json().error.code).toBe("already_playing");
    for (const [name, hcp] of [["Bo", 18], ["Cy", 9], ["Di", 22], ["Ed", 12], ["Flo", 30]] as const) await call(staff, "POST", `/events/${league}/players`, { name, handicap: hcp });

    const paired = (await call(staff, "POST", `/event-dates/${firstDate}/pairings/auto`, { groupSize: 3, order: "handicap" })).json();
    expect(paired.groups).toHaveLength(2);
    // Low and high handicaps are spread across groups.
    expect(paired.groups.map((g: { players: { handicap: number }[] }) => g.players.map((p) => p.handicap).sort((a, b) => a - b))).toEqual([
      [4, 18, 22],
      [9, 12, 30],
    ]);
    expect(paired.groups.map((g: { start: string }) => g.start)).toEqual(["14:46", "14:54"]);

    const bo = paired.groups.flatMap((g: { players: { id: string; name: string }[] }) => g.players).find((p: { name: string }) => p.name === "Bo").id;
    const moved = (await call(staff, "PUT", `/event-dates/${firstDate}/pairings/${bo}`, { groupNo: 3 })).json();
    expect(moved.groups).toHaveLength(3);

    const ids = moved.groups.slice(0, 2).flatMap((g: { players: { id: string }[] }) => g.players.map((p) => p.id));
    const checked = (await call(staff, "POST", `/event-dates/${firstDate}/check-in`, { playerIds: ids })).json();
    expect(checked.checkedIn).toBe(5);
  });

  it("bills the league as one account and counts what it pays", async () => {
    const ev = (await call(staff, "GET", `/events/${league}`)).json();
    // Five checked in on the first night; the other nights have nobody paired yet.
    expect(ev.billing).toMatchObject({ chargedCents: 5 * 2500, paidCents: 0, balanceCents: 12500 });
    const today = DateTime.now().setZone("America/Chicago").toISODate();
    const before = (await call(staff, "GET", `/closes/${today}`)).json().expected;
    const paid = (await call(staff, "POST", `/events/${league}/payments`, { amountCents: 12500, method: "check", eventDateId: firstDate, note: "Check #1042" })).json();
    expect(paid.billing).toMatchObject({ paidCents: 12500, balanceCents: 0 });
    expect(paid.billing.payments[0]).toMatchObject({ method: "check", note: "Check #1042", staff: "Jordan Price" });
    expect((await call(staff, "GET", `/closes/${today}`)).json().expected.check).toBe((before.check ?? 0) + 12500);
    const report = (await call(manager, "GET", `/reports?from=${today}&to=${today}`)).json();
    expect(report.revenue.eventsCents).toBeGreaterThanOrEqual(12500);
    // Refunds are for managers.
    expect((await call(staff, "POST", `/events/${league}/payments`, { amountCents: -500, method: "cash" })).statusCode).toBe(403);
  });

  it("cancels a rained-out night: its tee times open and it isn't billed", async () => {
    const ev = (await call(staff, "GET", `/events/${league}`)).json();
    const second = ev.dates[1];
    await call(staff, "POST", `/event-dates/${second.id}/pairings/auto`, {});
    const after = (await call(manager, "POST", `/event-dates/${second.id}/cancel`)).json();
    expect(after.dates[1]).toMatchObject({ status: "cancelled", held: 0, chargeCents: 0 });
    expect(after.billing.chargedCents).toBe(12500);
    expect((await sheetAt(second.date, "14:46")).status).toBe("open");
  });

  it("runs an outing as a shotgun, with a group on each hole", async () => {
    const res = (
      await call(manager, "POST", "/events", {
        name: "Lisle Chamber Outing",
        kind: "outing",
        format: "shotgun",
        holes: 18,
        pricePerPlayerCents: 9500,
        schedule: { startsOn: tuesday.plus({ weeks: 5 }).toISODate(), startTime: "07:58", slots: 10 },
      })
    ).json();
    expect(res.event.dates).toHaveLength(1);
    const id = res.event.id;
    for (let i = 1; i <= 40; i++) await call(staff, "POST", `/events/${id}/players`, { name: `Player ${String(i).padStart(2, "0")}` });
    const paired = (await call(staff, "POST", `/event-dates/${res.event.dates[0].id}/pairings/auto`, { groupSize: 4 })).json();
    expect(paired.groups).toHaveLength(10);
    expect(paired.groups.map((g: { start: string }) => g.start).slice(0, 3)).toEqual(["Hole 1A", "Hole 2A", "Hole 3A"]);
    expect((await call(staff, "GET", `/events/${id}`)).json().billing.chargedCents).toBe(40 * 9500);
  });
});
