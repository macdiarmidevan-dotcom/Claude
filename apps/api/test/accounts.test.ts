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

describe("gift cards", () => {
  let code: string;
  let cap: string;

  it("sells a card that holds money but isn't revenue", async () => {
    const res = await call(staff, "POST", "/gift-cards", { amountCents: 5000, method: "cash", recipientName: "Dad" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ initialCents: 5000, balanceCents: 5000, recipientName: "Dad", status: "active" });
    code = res.json().code;
    expect(code).toMatch(/^GC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await call(staff, "POST", "/gift-cards", { amountCents: 2500, method: "comp" })).json().error.code).toBe("manager_only");
    const r = (await call(manager, "GET", `/reports?from=${today}&to=${today}`)).json();
    expect(r.other.giftCardsSoldCents).toBe(5000);
    expect(r.collected.cash).toBe(5000);
    expect(r.revenue.totalCents).toBe(0);
    const close = (await call(manager, "GET", `/closes/${today}`)).json();
    expect(close.expected.cash).toBe(5000);
  });

  it("pays a register sale in full, and refuses one it can't cover", async () => {
    cap = (await call(manager, "POST", "/products", { name: "Logo cap", priceCents: 2000, taxable: false, stock: 5 })).json().id;
    const sale = (await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 1 }], paymentMethod: "gift_card", giftCardCode: code.toLowerCase() })).json();
    expect(sale.totalCents).toBe(2000);
    expect((await call(staff, "GET", `/gift-cards?code=${code}`)).json().balanceCents).toBe(3000);
    const tooBig = (await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 2 }], paymentMethod: "gift_card", giftCardCode: code })).json();
    expect(tooBig.error.code).toBe("not_enough_on_card");
    // A refund puts it back on the card.
    await call(manager, "POST", `/sales/${sale.id}/refund`);
    expect((await call(staff, "GET", `/gift-cards?code=${code}`)).json().balanceCents).toBe(5000);
  });

  it("goes toward a round, with the rest paid another way", async () => {
    const b = await booking(2);
    const card = (await call(staff, "POST", "/gift-cards", { amountCents: 1000, method: "card" })).json();
    const res = await call(staff, "POST", `/bookings/${b.id}/check-in`, { giftCard: card.code, payment: { method: "cash" } });
    expect(res.json()).toMatchObject({ status: "checked_in" });
    const pays = (await db.query("SELECT method, amount_cents FROM booking_payments WHERE booking_id = $1 ORDER BY method", [b.id])).rows;
    expect(pays).toEqual([
      { method: "cash", amount_cents: b.totalCents - 1000 },
      { method: "gift_card", amount_cents: 1000 },
    ]);
    const after = (await call(staff, "GET", `/gift-cards/${card.id}`)).json();
    expect(after.balanceCents).toBe(0);
    expect(after.history.map((h: { kind: string }) => h.kind)).toEqual(["redeem", "sold"]);
    expect((await call(staff, "POST", `/bookings/${(await booking(1)).id}/check-in`, { giftCard: card.code, payment: { method: "cash" } })).json().error.code).toBe("gift_card_empty");
  });

  it("lets managers void a card", async () => {
    const card = (await call(staff, "GET", `/gift-cards?code=${code}`)).json();
    expect((await call(staff, "POST", `/gift-cards/${card.id}/adjust`, { void: true, note: "Lost" })).json().error.code).toBe("manager_only");
    const v = (await call(manager, "POST", `/gift-cards/${card.id}/adjust`, { void: true, note: "Reported stolen" })).json();
    expect(v).toMatchObject({ status: "void", balanceCents: 0 });
    expect((await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 1 }], paymentMethod: "gift_card", giftCardCode: code })).json().error.code).toBe("gift_card_void");
  });
});

describe("house accounts", () => {
  let golfer: string;
  let account: string;

  it("lets managers open an account with a limit", async () => {
    golfer = (await call(staff, "POST", "/golfers", { name: "Walt Brennan", email: "walt@example.com", phone: "630-555-0120" })).json().id;
    expect((await call(staff, "POST", "/house-accounts", { golferId: golfer })).json().error.code).toBe("manager_only");
    const res = await call(manager, "POST", "/house-accounts", { golferId: golfer, creditLimitCents: 10000 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ balanceCents: 0, availableCents: 10000, status: "active" });
    account = res.json().id;
    expect((await call(manager, "POST", "/house-accounts", { golferId: golfer })).json().error.code).toBe("account_exists");
    expect((await call(staff, "GET", `/golfers/${golfer}/wallet`)).json().houseAccount.id).toBe(account);
  });

  it("charges rounds, register sales and tabs, up to the limit", async () => {
    const b = await booking(2);
    await call(staff, "PUT", `/bookings/${b.id}/golfer`, { golferId: golfer });
    const checked = await call(staff, "POST", `/bookings/${b.id}/check-in`, { payment: { method: "house_account" } });
    expect(checked.json().status).toBe("checked_in");
    const cap = (await call(staff, "GET", "/products")).json().find((p: { name: string }) => p.name === "Logo cap").id;
    await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 1 }], paymentMethod: "house_account", golferId: golfer });
    const tab = (await call(staff, "POST", "/tabs", { golferId: golfer })).json();
    await call(staff, "POST", `/tabs/${tab.id}/items`, { lines: [{ description: "Club sandwich", unitCents: 1200, quantity: 1, taxable: false, station: "kitchen" }] });
    await call(staff, "POST", `/tabs/${tab.id}/close`, { paymentMethod: "house_account" });

    const a = (await call(staff, "GET", `/house-accounts/${account}`)).json();
    expect(a.balanceCents).toBe(b.totalCents + 2000 + 1200);
    expect(a.entries.map((e: { kind: string }) => e.kind)).toEqual(["charge", "charge", "charge"]);
    expect(a.entries.at(-1).description).toMatch(/^Round, 2 players/);

    const over = (await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 3 }], paymentMethod: "house_account", golferId: golfer })).json();
    expect(over.error.code).toBe("over_limit");
    // A golfer without an account can't charge.
    const other = (await call(staff, "POST", "/golfers", { name: "No Account", email: "none@example.com", phone: "630-555-0121" })).json().id;
    expect((await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 1 }], paymentMethod: "house_account", golferId: other })).json().error.code).toBe("no_house_account");
    // Suspended accounts can't charge either.
    await call(manager, "PATCH", `/house-accounts/${account}`, { status: "suspended" });
    expect((await call(staff, "POST", "/sales", { lines: [{ productId: cap, quantity: 1 }], paymentMethod: "house_account", golferId: golfer })).json().error.code).toBe("account_not_active");
    await call(manager, "PATCH", `/house-accounts/${account}`, { status: "active" });
  });

  it("counts charges as revenue and payments as money taken", async () => {
    const before = (await call(manager, "GET", `/reports?from=${today}&to=${today}`)).json();
    expect(before.collected.house_account).toBeGreaterThan(0);
    const paid = (await call(staff, "POST", `/house-accounts/${account}/payments`, { amountCents: 2000, method: "check", note: "1201" })).json();
    expect(paid.entries[0]).toMatchObject({ kind: "payment", amountCents: -2000, description: "Payment by check 1201" });
    const after = (await call(manager, "GET", `/reports?from=${today}&to=${today}`)).json();
    expect(after.other.accountPaymentsCents).toBe(2000);
    expect(after.collected.check).toBe(before.collected.check + 2000);
    expect(after.revenue.totalCents).toBe(before.revenue.totalCents);
  });

  it("makes monthly statements once the month is over, once", async () => {
    // Move this account's activity into last month, as if the month had ended.
    const last = now.minus({ months: 1 });
    await db.query("UPDATE house_entries SET created_at = $2 WHERE house_account_id = $1", [account, last.set({ day: 15 }).toUTC().toISO()]);
    expect((await call(staff, "POST", "/house-accounts/statements", { month: last.toFormat("yyyy-MM") })).json().error.code).toBe("manager_only");
    expect((await call(manager, "POST", "/house-accounts/statements", { month: now.plus({ months: 1 }).toFormat("yyyy-MM") })).json().error.code).toBe("month_not_over");
    const run = (await call(manager, "POST", "/house-accounts/statements", { month: last.toFormat("yyyy-MM") })).json();
    expect(run.statements).toBe(1);
    expect((await call(manager, "POST", "/house-accounts/statements", { month: last.toFormat("yyyy-MM") })).json().statements).toBe(0);
    const a = (await call(staff, "GET", `/house-accounts/${account}`)).json();
    expect(a.unbilledCents).toBe(0);
    const s = a.statements[0];
    expect(s).toMatchObject({ periodStart: last.startOf("month").toISODate(), openingCents: 0, paymentsCents: 2000, closingCents: a.balanceCents });
    const full = (await call(staff, "GET", `/statements/${s.id}`)).json();
    expect(full.entries).toHaveLength(4);
    expect(full.account.golfer.name).toBe("Walt Brennan");
    // Closing needs the balance settled.
    expect((await call(manager, "PATCH", `/house-accounts/${account}`, { status: "closed" })).json().error.code).toBe("balance_owing");
  });
});
