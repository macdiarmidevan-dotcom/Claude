import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const call = (token: string, method: "GET" | "PUT", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });
const month = (m: string, greenFeesCents: number, rest = 0) => ({ month: m, greenFeesCents, cartsAndExtrasCents: rest, proShopCents: rest, foodBevCents: rest, eventsCents: rest });

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db);
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
  await app.inject({
    method: "POST",
    url: `${base}/staff`,
    headers: { authorization: `Bearer ${manager}` },
    payload: { name: "Jordan Price", email: "jordan@example.com", role: "staff", password: "proshop-pass1" },
  });
  staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "jordan@example.com", password: "proshop-pass1" } })).json().token;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("revenue budgets", () => {
  it("starts with no budget for the year", async () => {
    const res = await call(manager, "GET", "/reports/budget?year=2026");
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.months).toHaveLength(12);
    expect(b.months[0]).toMatchObject({ month: "2026-01", set: false, totalCents: 0 });
  });

  it("saves months and adds up their totals", async () => {
    const res = await call(manager, "PUT", "/reports/budget", { months: [month("2026-06", 3_000_000, 600_000), month("2026-07", 3_100_000)] });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.months[5]).toMatchObject({ month: "2026-06", set: true, greenFeesCents: 3_000_000, proShopCents: 600_000, totalCents: 5_400_000 });
    expect(b.months[6]).toMatchObject({ month: "2026-07", set: true, totalCents: 3_100_000 });
    expect(b.months[7].set).toBe(false);
  });

  it("prorates the budget by day on the dashboard", async () => {
    // June 21-30 is a third of June; July 1-10 is ten of its 31 days.
    const o = (await call(manager, "GET", "/reports/overview?from=2026-06-21&to=2026-07-10&compare=none")).json();
    expect(o.budget.revenue.greenFeesCents).toBe(1_000_000 + 1_000_000);
    expect(o.budget.revenue.proShopCents).toBe(200_000);
    expect(o.budget.revenue.totalCents).toBe(1_000_000 + 4 * 200_000 + 1_000_000);
    expect(o.budget.months).toEqual([
      { month: "2026-06", daysInMonth: 30, daysInRange: 10, totalCents: 5_400_000 },
      { month: "2026-07", daysInMonth: 31, daysInRange: 10, totalCents: 3_100_000 },
    ]);
  });

  it("has no budget for dates without one, and gives the comparison's days", async () => {
    const o = (await call(manager, "GET", "/reports/overview?from=2026-09-01&to=2026-09-30&compare=last_year")).json();
    expect(o.budget).toBeNull();
    expect(Array.isArray(o.previous.days)).toBe(true);
  });

  it("clears a month saved as all zeros", async () => {
    const b = (await call(manager, "PUT", "/reports/budget", { months: [month("2026-07", 0)] })).json();
    expect(b.months[6]).toMatchObject({ set: false, totalCents: 0 });
  });

  it("refuses bad months, mixed years and pro shop staff", async () => {
    expect((await call(manager, "PUT", "/reports/budget", { months: [month("2026-13", 100)] })).statusCode).toBe(400);
    expect((await call(manager, "PUT", "/reports/budget", { months: [month("2026-12", 100), month("2027-01", 100)] })).statusCode).toBe(400);
    expect((await call(manager, "PUT", "/reports/budget", { months: [month("2026-12", -1)] })).statusCode).toBe(400);
    expect((await call(staff, "GET", "/reports/budget?year=2026")).statusCode).toBe(403);
    expect((await call(staff, "PUT", "/reports/budget", { months: [month("2026-12", 100)] })).statusCode).toBe(403);
  });
});
