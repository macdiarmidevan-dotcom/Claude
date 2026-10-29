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
let secretKey: string;
const base = "/v1/courses/river-bend";
const people: Record<string, { id: string; token: string }> = {};

// A Monday two weeks out, so every shift is in the future.
let monday = DateTime.now().setZone("America/Chicago").plus({ weeks: 2 }).startOf("week");
const day = (n: number) => monday.plus({ days: n }).toISODate()!;

const call = (token: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });
const shift = (body: object) => call(people.manager!.token, "POST", "/shifts", body);

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  secretKey = seeded.secretKey;
  app = buildApp(db);
  const login = async (email: string, password: string) =>
    (await app.inject({ method: "POST", url: `${base}/login`, payload: { email, password } })).json();
  const m = await login(seeded.manager.email, seeded.manager.password);
  people.manager = { id: m.user.id, token: m.token };
  for (const name of ["jordan", "sam"]) {
    const res = await call(m.token, "POST", "/staff", { name: name[0]!.toUpperCase() + name.slice(1), email: `${name}@riverbend.example`, role: "staff", password: "password-1" });
    const signed = await login(`${name}@riverbend.example`, "password-1");
    people[name] = { id: res.json().id, token: signed.token };
  }
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("scheduling", () => {
  let jordanMon: string;
  let samTue: string;

  it("lets managers build the schedule, and everyone see it", async () => {
    const types = (await call(people.manager!.token, "GET", "/employee-types")).json();
    const proShop = types.find((t: { name: string }) => t.name === "Pro Shop").id;
    const res = await shift({ staffUserId: people.jordan!.id, employeeTypeId: proShop, date: day(0), start: "06:00", end: "14:30" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ date: day(0), start: "06:00", end: "14:30", hours: 8.5, staff: { name: "Jordan" }, employeeType: { name: "Pro Shop" } });
    jordanMon = res.json().id;

    expect((await shift({ staffUserId: people.jordan!.id, date: day(0), start: "14:00", end: "18:00" })).json().error.code).toBe("overlap");
    samTue = (await shift({ staffUserId: people.sam!.id, date: day(1), start: "07:00", end: "15:00" })).json().id;
    const open = await shift({ date: day(2), start: "16:00", end: "21:00", note: "Bar, league night" });
    expect(open.json().staff).toBeNull();

    expect((await call(people.jordan!.token, "POST", "/shifts", { date: day(3), start: "07:00", end: "15:00" })).statusCode).toBe(403);
    const week = (await call(people.sam!.token, "GET", `/shifts?from=${day(0)}&to=${day(6)}`)).json();
    expect(week.map((s: { start: string }) => s.start)).toEqual(["06:00", "07:00", "16:00"]);
  });

  it("copies a week, skipping clashes", async () => {
    const next = monday.plus({ weeks: 1 }).toISODate()!;
    await shift({ staffUserId: people.sam!.id, date: monday.plus({ weeks: 1, days: 1 }).toISODate()!, start: "10:00", end: "12:00" });
    const res = (await call(people.manager!.token, "POST", "/shifts/copy-week", { from: day(0), to: next })).json();
    expect(res).toEqual({ copied: 2, skipped: 1 });
  });

  it("swaps only after the coworker accepts and a manager approves", async () => {
    const ask = await call(people.jordan!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.sam!.id, requestedShiftId: samTue, message: "Dentist Monday" });
    expect(ask.statusCode).toBe(201);
    const id = ask.json().id;
    expect((await call(people.jordan!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.sam!.id })).json().error.code).toBe("swap_pending");
    expect((await call(people.sam!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.jordan!.id })).json().error.code).toBe("not_your_shift");

    // Nobody but Sam can accept, and a manager can't approve before Sam does.
    expect((await call(people.jordan!.token, "POST", `/swaps/${id}/accept`)).statusCode).toBe(403);
    expect((await call(people.manager!.token, "POST", `/swaps/${id}/approve`)).json().error.code).toBe("awaiting_coworker");

    expect((await call(people.sam!.token, "POST", `/swaps/${id}/accept`)).json().status).toBe("awaiting_manager");
    expect((await call(people.sam!.token, "POST", `/swaps/${id}/approve`)).statusCode).toBe(403);
    const pending = (await call(people.manager!.token, "GET", "/swaps")).json();
    expect(pending.map((s: { id: string }) => s.id)).toContain(id);

    expect((await call(people.manager!.token, "POST", `/swaps/${id}/approve`)).json().status).toBe("approved");
    const week = (await call(people.sam!.token, "GET", `/shifts?from=${day(0)}&to=${day(1)}`)).json();
    expect(week.map((s: { date: string; staff: { name: string } }) => `${s.date} ${s.staff.name}`)).toEqual([`${day(0)} Sam`, `${day(1)} Jordan`]);
    expect((await call(people.manager!.token, "POST", `/swaps/${id}/reject`)).json().error.code).toBe("swap_closed");
  });

  it("skips the manager when the course turns approval off, and handles declines and cancels", async () => {
    expect((await call(people.jordan!.token, "GET", "/settings/scheduling")).json()).toEqual({ swapsNeedApproval: true });
    expect((await call(people.jordan!.token, "PUT", "/settings/scheduling", { swapsNeedApproval: false })).statusCode).toBe(403);
    await call(people.manager!.token, "PUT", "/settings/scheduling", { swapsNeedApproval: false });

    // Sam now has Monday; give it back to Jordan outright.
    const give = (await call(people.sam!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.jordan!.id })).json();
    expect((await call(people.jordan!.token, "POST", `/swaps/${give.id}/decline`)).json().status).toBe("declined");
    const again = (await call(people.sam!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.jordan!.id })).json();
    expect((await call(people.sam!.token, "POST", `/swaps/${again.id}/cancel`)).json().status).toBe("cancelled");
    const third = (await call(people.sam!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.jordan!.id })).json();
    expect((await call(people.jordan!.token, "POST", `/swaps/${third.id}/accept`)).json().status).toBe("approved");
    // Jordan now has both Monday and Tuesday.
    const week = (await call(people.jordan!.token, "GET", `/shifts?from=${day(0)}&to=${day(1)}`)).json();
    expect(week.every((s: { staff: { name: string } }) => s.staff.name === "Jordan")).toBe(true);
    await call(people.manager!.token, "PUT", "/settings/scheduling", { swapsNeedApproval: true });
  });

  it("won't swap someone into a clash, and a manager editing the shift cancels pending swaps", async () => {
    const clash = (await shift({ staffUserId: people.sam!.id, date: day(0), start: "12:00", end: "16:00" })).json();
    const ask = (await call(people.jordan!.token, "POST", "/swaps", { offeredShiftId: jordanMon, toUserId: people.sam!.id })).json();
    await call(people.sam!.token, "POST", `/swaps/${ask.id}/accept`);
    expect((await call(people.manager!.token, "POST", `/swaps/${ask.id}/approve`)).json().error.code).toBe("overlap");

    await call(people.manager!.token, "DELETE", `/shifts/${clash.id}`);
    const later = (await call(people.jordan!.token, "POST", "/swaps", { offeredShiftId: samTue, toUserId: people.sam!.id })).json();
    await call(people.manager!.token, "PATCH", `/shifts/${samTue}`, { start: "08:00" });
    const mine = (await call(people.jordan!.token, "GET", "/swaps")).json();
    expect(mine.find((s: { id: string }) => s.id === later.id).status).toBe("cancelled");
  });

  it("clocks people in and out and adds up their hours", async () => {
    const now = DateTime.now().setZone("America/Chicago");
    const today = await shift({ staffUserId: people.sam!.id, date: now.toISODate()!, start: now.minus({ minutes: 30 }).toFormat("HH:mm"), end: now.plus({ hours: 4 }).toFormat("HH:mm") });

    expect((await call(secretKey, "POST", "/clock/in")).json().error.code).toBe("no_account");
    const inRes = (await call(people.sam!.token, "POST", "/clock/in")).json();
    expect(inRes.open).toMatchObject({ shiftId: today.json().id, clockOut: null });
    expect((await call(people.sam!.token, "POST", "/clock/in")).json().error.code).toBe("already_clocked_in");
    expect((await call(people.sam!.token, "POST", "/clock/out")).json().open).toBeNull();
    expect((await call(people.sam!.token, "POST", "/clock/out")).json().error.code).toBe("not_clocked_in");

    // A manager fixes the punch to a 4-hour stretch.
    const sheets = (await call(people.manager!.token, "GET", `/timesheets?from=${now.toISODate()}&to=${now.toISODate()}`)).json();
    const punch = sheets[0].punches[0];
    const start = now.minus({ hours: 4 }).toUTC().toISO()!;
    const fixed = await call(people.manager!.token, "PATCH", `/punches/${punch.id}`, { clockIn: start, clockOut: now.toUTC().toISO() });
    expect(fixed.json()).toMatchObject({ hours: 4, edited: true });
    const after = (await call(people.manager!.token, "GET", `/timesheets?from=${now.toISODate()}&to=${now.toISODate()}`)).json();
    expect(after[0]).toMatchObject({ staff: { name: "Sam" }, workedHours: 4 });
    expect((await call(people.sam!.token, "GET", `/timesheets?from=${now.toISODate()}&to=${now.toISODate()}`)).statusCode).toBe(403);
  });
});
