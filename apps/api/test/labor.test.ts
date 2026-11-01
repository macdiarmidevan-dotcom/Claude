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
const zone = "America/Chicago";
// A Monday two weeks back, so the whole week is in the past.
const monday = DateTime.now().setZone(zone).startOf("week").minus({ weeks: 2 });

const call = (token: string, method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

async function punch(userId: string, day: number, hours: number) {
  const start = monday.plus({ days: day }).set({ hour: 7 });
  await db.query(
    "INSERT INTO time_punches (course_id, staff_user_id, clock_in, clock_out) SELECT id, $1, $2, $3 FROM courses WHERE slug = 'river-bend'",
    [userId, start.toJSDate(), start.plus({ hours }).toJSDate()],
  );
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db);
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("pay rates and labor cost", () => {
  let jordan: string;
  let casey: string;
  let pat: string;

  it("keeps pay on staff accounts for managers", async () => {
    const res = await call(manager, "POST", "/staff", { name: "Jordan Price", email: "jordan@example.com", role: "staff", password: "proshop-pass1", pay: { type: "hourly", cents: 1600 } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().pay).toEqual({ type: "hourly", cents: 1600 });
    jordan = res.json().id;
    casey = (await call(manager, "POST", "/staff", { name: "Casey Moore", email: "casey@example.com", role: "staff", password: "carts-pass12" })).json().id;
    pat = (await call(manager, "POST", "/staff", { name: "Pat Green", email: "pat@example.com", role: "manager", password: "super-pass12", pay: { type: "salary", cents: 5_475_000 } })).json().id;
    staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "jordan@example.com", password: "proshop-pass1" } })).json().token;

    const patched = await call(manager, "PATCH", `/staff/${jordan}`, { pay: { type: "hourly", cents: 2000 } });
    expect(patched.json().pay).toEqual({ type: "hourly", cents: 2000 });
    expect((await call(manager, "PATCH", `/staff/${casey}`, { pay: { type: "hourly", cents: 900_000 } })).statusCode).toBe(400);
    const list = (await call(manager, "GET", "/staff")).json();
    expect(list.find((s: { id: string }) => s.id === casey).pay).toBeNull();
    // Staff can't see the list, so they never see anyone's pay.
    expect((await call(staff, "GET", "/staff")).statusCode).toBe(403);
  });

  it("adds up hours, overtime past 40 a week, salaries and labor percent", async () => {
    // Jordan works five 9-hour days: 45 hours, so the last 5 are overtime.
    for (let d = 0; d < 5; d++) await punch(jordan, d, 9);
    await punch(casey, 1, 4);
    const from = monday.toISODate();
    const to = monday.plus({ days: 6 }).toISODate();

    expect((await call(staff, "GET", `/reports/labor?from=${from}&to=${to}`)).json().error.code).toBe("manager_only");
    const res = await call(manager, "GET", `/reports/labor?from=${from}&to=${to}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    const j = r.people.find((p: { id: string }) => p.id === jordan);
    expect(j).toMatchObject({ hours: 45, overtimeHours: 5, costCents: 40 * 2000 + 5 * 3000 });
    const c = r.people.find((p: { id: string }) => p.id === casey);
    expect(c).toMatchObject({ hours: 4, costCents: 0, missingPay: true });
    const p = r.people.find((x: { id: string }) => x.id === pat);
    // Pat's account is new, so only days from today count; this week is in the past.
    expect(p).toBeUndefined();
    expect(r.totals).toMatchObject({ hours: 49, overtimeHours: 5, costCents: 95_000, overtimeCents: 15_000, salaryCents: 0 });
    expect(r.missingPay).toBe(1);
    expect(r.days).toHaveLength(7);
    expect(r.days[0]).toMatchObject({ hours: 9, costCents: 18_000 });
    expect(r.days[4]).toMatchObject({ hours: 9, costCents: 4 * 2000 + 5 * 3000 });

    // Only Wednesday to Friday: overtime still counts Monday and Tuesday's hours.
    const mid = (await call(manager, "GET", `/reports/labor?from=${monday.plus({ days: 2 }).toISODate()}&to=${monday.plus({ days: 4 }).toISODate()}`)).json();
    expect(mid.people.find((x: { id: string }) => x.id === jordan)).toMatchObject({ hours: 27, overtimeHours: 5 });
  });

  it("spreads a salary over the days", async () => {
    const today = DateTime.now().setZone(zone).toISODate();
    const r = (await call(manager, "GET", `/reports/labor?from=${today}&to=${today}`)).json();
    expect(r.people.find((x: { id: string }) => x.id === pat)).toMatchObject({ costCents: 15_000 });
    expect(r.totals.salaryCents).toBe(15_000);
  });
});
