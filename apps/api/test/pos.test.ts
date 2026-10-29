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

const call = (token: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: object) =>
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

describe("pro shop", () => {
  let balls: string;
  let tokens: string;

  it("lets managers add products, and only managers", async () => {
    const res = await call(manager, "POST", "/products", { name: "Pro V1 (dozen)", sku: "PV1", category: "Balls", priceCents: 5499, costCents: 3800, stock: 10, reorderLevel: 4 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ stock: 10, low: false, taxable: true });
    balls = res.json().id;
    tokens = (await call(manager, "POST", "/products", { name: "Range bucket", category: "Range", priceCents: 800, trackStock: false, taxable: false })).json().id;
    expect((await call(manager, "POST", "/products", { name: "Other", sku: "pv1", priceCents: 1 })).json().error.code).toBe("sku_taken");
    expect((await call(staff, "POST", "/products", { name: "Hat", priceCents: 2500 })).json().error.code).toBe("manager_only");
    expect((await call(staff, "GET", "/products?q=pro")).json()).toHaveLength(1);
  });

  it("rings up a sale with tax, takes stock off the shelf and totals the day", async () => {
    await call(manager, "PUT", "/settings/pos", { salesTaxBps: 725 });
    const res = await call(staff, "POST", "/sales", {
      lines: [{ productId: balls, quantity: 7 }, { productId: tokens, quantity: 2 }, { description: "Divot tool", unitCents: 500, quantity: 1 }],
      paymentMethod: "card",
    });
    expect(res.statusCode).toBe(201);
    const sale = res.json();
    expect(sale.subtotalCents).toBe(7 * 5499 + 1600 + 500);
    // Range buckets aren't taxable.
    expect(sale.taxCents).toBe(Math.round((7 * 5499 + 500) * 0.0725));
    expect(sale.totalCents).toBe(sale.subtotalCents + sale.taxCents);
    expect(sale).toMatchObject({ number: 1, staff: "Jordan Price" });

    const product = (await call(staff, "GET", "/products")).json().find((p: { id: string }) => p.id === balls);
    expect(product).toMatchObject({ stock: 3, low: true });

    const day = (await call(staff, "GET", `/sales?date=${today}`)).json();
    expect(day.summary).toMatchObject({ count: 1, totalCents: sale.totalCents, byMethod: { card: sale.totalCents } });
    expect(day.summary.byCategory).toMatchObject({ Balls: 7 * 5499, Range: 1600, Other: 500 });
  });

  it("receives, counts and adjusts stock with a history", async () => {
    expect((await call(staff, "POST", `/products/${balls}/stock`, { kind: "receive", quantity: 12 })).json().stock).toBe(15);
    expect((await call(staff, "POST", `/products/${balls}/stock`, { kind: "count", quantity: 14 })).json().error.code).toBe("manager_only");
    expect((await call(manager, "POST", `/products/${balls}/stock`, { kind: "count", quantity: 14 })).json().stock).toBe(14);
    expect((await call(manager, "POST", `/products/${balls}/stock`, { kind: "adjust", quantity: -1 })).json().error.code).toBe("note_required");
    expect((await call(manager, "POST", `/products/${balls}/stock`, { kind: "adjust", quantity: -1, note: "Damaged" })).json().stock).toBe(13);
    const history = (await call(staff, "GET", `/products/${balls}/history`)).json();
    expect(history.map((h: { reason: string }) => h.reason)).toEqual(["adjust", "count", "receive", "sale", "receive"]);
    expect(history[3]).toMatchObject({ change: -7, saleNumber: 1 });
  });

  it("refunds a sale (managers only) and restocks", async () => {
    const sale = (await call(staff, "POST", "/sales", { lines: [{ productId: balls, quantity: 2 }], paymentMethod: "cash" })).json();
    expect(sale.number).toBe(2);
    expect((await call(staff, "POST", `/sales/${sale.id}/refund`)).json().error.code).toBe("manager_only");
    expect((await call(manager, "POST", `/sales/${sale.id}/refund`)).json().status).toBe("refunded");
    expect((await call(manager, "POST", `/sales/${sale.id}/refund`)).json().error.code).toBe("already_refunded");
    const product = (await call(staff, "GET", "/products")).json().find((p: { id: string }) => p.id === balls);
    expect(product.stock).toBe(13);
    const day = (await call(staff, "GET", `/sales?date=${today}`)).json();
    expect(day.summary).toMatchObject({ count: 1, refundedCents: sale.totalCents });
  });

  it("doesn't tax comps and refuses an empty sale or a removed product", async () => {
    const comp = (await call(staff, "POST", "/sales", { lines: [{ productId: balls, quantity: 1 }], paymentMethod: "comp" })).json();
    expect(comp.taxCents).toBe(0);
    expect((await call(staff, "POST", "/sales", { lines: [], paymentMethod: "cash" })).json().error.code).toBe("empty_sale");
    await call(manager, "PATCH", `/products/${tokens}`, { active: false });
    expect((await call(staff, "POST", "/sales", { lines: [{ productId: tokens, quantity: 1 }], paymentMethod: "cash" })).json().error.code).toBe("product_inactive");
    expect((await call(staff, "GET", "/products")).json()).toHaveLength(1);
    expect((await call(staff, "GET", "/products?all=1")).json()).toHaveLength(2);
  });
});
