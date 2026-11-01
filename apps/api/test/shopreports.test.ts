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
const today = DateTime.now().setZone("America/Chicago").toISODate()!;
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

describe("pro shop inventory report", () => {
  it("adds up sales, margin, stock value, reorder list, slow movers and shrink", async () => {
    const product = async (body: object) => (await call(manager, "POST", "/products", body)).json().id as string;
    const balls = await product({ name: "Pro V1 (dozen)", category: "Balls", priceCents: 5000, costCents: 3000, stock: 10, reorderLevel: 4 });
    const glove = await product({ name: "Glove", category: "Gloves", priceCents: 2000, stock: 6, reorderLevel: 2 });
    const towel = await product({ name: "Towel", category: "Accessories", priceCents: 1500, costCents: 500, stock: 8 });
    // Older than the period, so it can count as a slow mover.
    await db.query("UPDATE products SET created_at = now() - interval '30 days' WHERE id = $1", [towel]);
    await call(staff, "POST", "/sales", { lines: [{ productId: balls, quantity: 7 }, { productId: glove, quantity: 1 }], paymentMethod: "card" });
    await call(manager, "POST", `/products/${towel}/stock`, { kind: "count", quantity: 6 });

    expect((await call(staff, "GET", `/reports/inventory?from=${today}&to=${today}`)).json().error.code).toBe("manager_only");
    const r = (await call(manager, "GET", `/reports/inventory?from=${today}&to=${today}`)).json();
    expect(r.sales).toMatchObject({ revenueCents: 37000, units: 8, costCents: 21000, marginCents: 14000, uncostedRevenueCents: 2000 });
    expect(r.sales.marginPct).toBe(40);
    expect(r.items[0]).toMatchObject({ name: "Pro V1 (dozen)", units: 7, revenueCents: 35000, marginPct: 40 });
    expect(r.items.find((i: { name: string }) => i.name === "Glove").marginPct).toBeNull();
    expect(r.stock).toMatchObject({ units: 3 + 5 + 6, costCents: 3 * 3000 + 6 * 500, retailCents: 3 * 5000 + 5 * 2000 + 6 * 1500, missingCost: 1 });
    expect(r.reorder.map((x: { name: string }) => x.name)).toEqual(["Pro V1 (dozen)"]);
    expect(r.slowMovers.map((x: { name: string }) => x.name)).toEqual(["Towel"]);
    expect(r.shrink).toEqual([{ id: towel, name: "Towel", units: -2, costCents: -1000 }]);
  });
});

describe("payments and balances report", () => {
  it("shows money held for golfers and owed by them", async () => {
    await call(staff, "POST", "/gift-cards", { amountCents: 5000, method: "cash" });
    const golfer = (await call(staff, "POST", "/golfers", { name: "Walt Brennan", email: "walt@example.com", phone: "630-555-0120" })).json().id;
    await call(manager, "POST", "/house-accounts", { golferId: golfer, creditLimitCents: 1000 });
    const cap = (await call(manager, "POST", "/products", { name: "Logo cap", priceCents: 2000, taxable: false, stock: 5 })).json().id;
    const sale = await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 1 }], paymentMethod: "house_account", golferId: golfer });
    expect(sale.statusCode, sale.body).toBe(409); // over the $10 limit
    const tee = (await call(manager, "POST", "/products", { name: "Tees", priceCents: 800, taxable: false, stock: 5 })).json().id;
    expect((await call(staff, "POST", "/sales", { lines: [{ productId: tee, quantity: 1 }], paymentMethod: "house_account", golferId: golfer })).statusCode).toBe(201);
    await call(manager, "PUT", "/settings/loyalty", { pointsPerDollar: 1, rewardPoints: 100, rewardCents: 500 });
    await db.query("UPDATE customers SET loyalty_points = 250 WHERE id = $1", [golfer]);
    await db.query(
      `INSERT INTO golfer_passes (course_id, customer_id, name, kind, rounds_total, rounds_used, covers_cart)
       SELECT (SELECT id FROM courses WHERE slug = 'river-bend'), id, '10-round card', 'punch_card', 10, 3, false FROM customers WHERE id = $1`,
      [golfer],
    );

    expect((await call(staff, "GET", `/reports/balances?from=${today}&to=${today}`)).json().error.code).toBe("manager_only");
    const r = (await call(manager, "GET", `/reports/balances?from=${today}&to=${today}`)).json();
    expect(r.held.giftCards).toMatchObject({ cards: 1, cents: 5000, soldInPeriodCents: 5000, redeemedInPeriodCents: 0 });
    expect(r.held.punchCards).toMatchObject({ cards: 1, roundsLeft: 7, unpriced: 1 });
    expect(r.held.loyalty.points).toBe(250);
    expect(r.receivable).toMatchObject({ accounts: 1, cents: 800, chargedInPeriodCents: 800, overLimit: 0 });
    expect(r.receivable.largest[0]).toMatchObject({ name: "Walt Brennan", balanceCents: 800, limitCents: 1000 });
    expect(r.collected.cash).toBeGreaterThanOrEqual(5000);
  });
});
