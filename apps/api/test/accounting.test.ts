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
const now = DateTime.now().setZone("America/Chicago");
const today = now.toISODate()!;
const call = (token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

let n = 0;
async function booking(players = 2) {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${today}`)).json();
  const teeTimeId = sheet.teeTimes.at(-1 - n++).id;
  return (await call(staff, "POST", "/bookings", { teeTimeId, holes: 9, customer: { name: "Golfer", email: `g${n}@example.com` }, players: Array.from({ length: players }, () => ({})), source: "staff" })).json();
}

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

describe("accounting export", () => {
  it("makes one balanced journal entry per day from the day's money", async () => {
    await call(manager, "PUT", "/settings/pos", { salesTaxBps: 1000 });
    // A round paid in cash, a taxed pro shop sale on card, a gift card sold, and a member's charge and payment.
    const b = await booking(2);
    await call(staff, "POST", `/bookings/${b.id}/check-in`, { payment: { method: "cash" } });
    const hat = (await call(manager, "POST", "/products", { name: "Hat", priceCents: 2000, stock: 5 })).json().id;
    await call(staff, "POST", "/sales", { lines: [{ productId: hat, quantity: 1 }], paymentMethod: "card" });
    await call(staff, "POST", "/gift-cards", { amountCents: 5000, method: "cash" });
    const golfer = (await call(staff, "POST", "/golfers", { name: "Walt Brennan", email: "walt@example.com", phone: "630-555-0120" })).json().id;
    const acct = (await call(manager, "POST", "/house-accounts", { golferId: golfer })).json().id;
    await call(staff, "POST", "/sales", { lines: [{ productId: hat, quantity: 1 }], paymentMethod: "house_account", golferId: golfer });
    await call(staff, "POST", `/house-accounts/${acct}/payments`, { amountCents: 1000, method: "check" });

    expect((await call(staff, "GET", `/accounting/journal?from=${today}&to=${today}`)).json().error.code).toBe("manager_only");
    const j = (await call(manager, "GET", `/accounting/journal?from=${today}&to=${today}`)).json();
    expect(j.days).toHaveLength(1);
    const lines: { key: string; account: string; debitCents: number; creditCents: number }[] = j.days[0].lines;
    const debit = (k: string) => lines.filter((l) => l.key === k).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(lines.reduce((s, l) => s + l.creditCents, 0));
    expect(debit("cash")).toBe(b.totalCents + 5000);
    expect(debit("card")).toBe(2200);
    expect(debit("check")).toBe(1000);
    // Charged 2200 to the account, 1000 paid on it.
    expect(debit("house_account")).toBe(1200);
    expect(debit("gift_card")).toBe(-5000);
    expect(debit("green_fees") + debit("carts_extras")).toBe(-b.totalCents);
    expect(debit("pro_shop")).toBe(-4000);
    expect(debit("sales_tax")).toBe(-400);
    // The round was played today, so there's no timing difference.
    expect(lines.some((l) => l.key === "clearing")).toBe(false);
  });

  it("uses the course's account names and exports QuickBooks and Xero files", async () => {
    const saved = (await call(manager, "PUT", "/settings/accounting", { format: "xero", accounts: { cash: "1010", green_fees: "4000" } })).json();
    expect(saved).toMatchObject({ format: "xero", accounts: { cash: "1010", green_fees: "4000", card: "Card Clearing" } });
    const xero = (await call(manager, "POST", "/accounting/export", { from: today, to: today })).json();
    const rows = xero.csv.trim().split("\n");
    expect(rows[0]).toBe("*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount");
    expect(rows.find((r: string) => r.includes(",1010,"))).toMatch(/,1010,Tax Exempt,\d+\.\d\d$/);
    expect(rows.slice(1).reduce((s: number, r: string) => s + Math.round(Number(r.split(",").at(-1)) * 100), 0)).toBe(0);
    const qb = (await call(manager, "POST", "/accounting/export", { from: today, to: today, format: "quickbooks" })).json();
    expect(qb.fileName).toBe(`river-bend-quickbooks-${today}.csv`);
    expect(qb.csv.split("\n")[0]).toBe("Journal No,Journal Date,Account,Debits,Credits,Description");
    expect(qb.csv).toContain(`GOLF-${today.replace(/-/g, "")}`);
    const settings = (await call(manager, "GET", "/settings/accounting")).json();
    expect(settings.recentExports.map((e: { format: string }) => e.format)).toEqual(["quickbooks", "xero"]);
    // Going back to the default name drops the override.
    expect((await call(manager, "PUT", "/settings/accounting", { accounts: { cash: "Undeposited Funds" } })).json().accounts.cash).toBe("Undeposited Funds");
  });

  it("puts a round paid ahead of the day it's played in clearing", async () => {
    const tomorrow = now.plus({ days: 1 }).toISODate()!;
    const sheet = (await call(staff, "GET", `/tee-sheet?date=${tomorrow}`)).json();
    const ahead = (await call(staff, "POST", "/bookings", { teeTimeId: sheet.teeTimes[5].id, holes: 9, customer: { name: "Early", email: "early@example.com" }, players: [{}], source: "staff" })).json();
    await call(staff, "POST", `/bookings/${ahead.id}/payments`, { amountCents: ahead.totalCents, method: "card" });
    const j = (await call(manager, "GET", `/accounting/journal?from=${today}&to=${tomorrow}`)).json();
    const todayLines = j.days.find((d: { date: string }) => d.date === today).lines;
    const clearing = todayLines.find((l: { key: string }) => l.key === "clearing");
    expect(clearing).toMatchObject({ creditCents: ahead.totalCents });
    const tomorrowLines = j.days.find((d: { date: string }) => d.date === tomorrow).lines;
    expect(tomorrowLines.find((l: { key: string }) => l.key === "clearing")).toMatchObject({ debitCents: ahead.totalCents });
  });
});
