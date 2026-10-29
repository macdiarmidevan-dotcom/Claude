import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { seedRiverBend } from "../src/seed.ts";
import type { PaymentsFetch } from "../src/terminals.ts";

process.env.NODE_ENV = "test";
process.env.SYNC_SECRET = "test-secret";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let manager: string;
let staff: string;

// A pretend Stripe/Square API: each test sets what the next calls answer.
const calls: { url: string; method: string; body?: string }[] = [];
let answer: (url: string, method: string) => { status: number; body: any } = () => ({ status: 404, body: {} });
const fakeFetch: PaymentsFetch = async (u, init) => {
  calls.push({ url: u, method: init.method, ...(init.body ? { body: init.body } : {}) });
  const a = answer(u, init.method);
  return { status: a.status, json: async () => a.body };
};

const base = "/v1/courses/river-bend";
const call = (token: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

let tuesday = DateTime.now().setZone("America/Chicago").plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
let walkIns = 0;
async function walkIn(time: string) {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${tuesday.toISODate()}`)).json();
  const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime === time).id;
  return (await call(staff, "POST", "/bookings", { teeTimeId, holes: 9, customer: { name: "Walk-in", email: `walkin+${++walkIns}@walkin.local` }, players: [{}], source: "staff" })).json();
}

async function waitForCard(id: string) {
  for (let i = 0; i < 20; i++) {
    const p = (await call(staff, "GET", `/card-payments/${id}`)).json();
    if (p.status !== "processing") return p;
  }
  throw new Error("card never finished");
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db, { paymentsFetch: fakeFetch });
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
  await call(manager, "POST", "/staff", { name: "Jordan Price", email: "jordan@example.com", role: "staff", password: "proshop-pass1" });
  staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "jordan@example.com", password: "proshop-pass1" } })).json().token;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("card terminals", () => {
  it("starts on a standalone terminal, where the register only records cards", async () => {
    const settings = (await call(staff, "GET", "/settings/payments")).json();
    expect(settings).toMatchObject({ provider: "standalone", connected: false, hasCredentials: false });
    expect(settings.providers.map((p: { id: string }) => p.id)).toEqual(["standalone", "simulator", "stripe", "square"]);
    expect((await call(staff, "PUT", "/settings/payments", { provider: "simulator" })).statusCode).toBe(403);
    const booking = await walkIn("09:02");
    const res = await call(staff, "POST", `/bookings/${booking.id}/check-in`, { payment: { method: "card" } });
    expect(res.json()).toMatchObject({ status: "checked_in", payment: { balanceCents: 0 } });
  });

  let reader: string;
  it("sends the amount to a reader and checks in once the card goes through", async () => {
    await call(manager, "PUT", "/settings/payments", { provider: "simulator", account: { delayMs: "0" } });
    const found = (await call(manager, "GET", "/settings/payments/readers")).json();
    const added = await call(manager, "POST", "/terminals", { name: "Pro shop counter", readerId: found[0].readerId, location: "Pro shop" });
    expect(added.statusCode).toBe(201);
    reader = added.json().id;
    expect((await call(manager, "POST", "/terminals", { name: "Again", readerId: found[0].readerId })).json().error.code).toBe("reader_taken");
    expect((await call(staff, "GET", "/terminals")).json()).toHaveLength(1);

    const booking = await walkIn("09:10");
    const started = (await call(staff, "POST", "/card-payments", { terminalId: reader, amountCents: booking.totalCents })).json();
    expect(started.status).toBe("processing");
    const paid = await waitForCard(started.id);
    expect(paid).toMatchObject({ status: "succeeded", cardBrand: "visa", cardLast4: "4242" });

    // The card must match what's being charged, and only pays once.
    const short = (await call(staff, "POST", "/card-payments", { terminalId: reader, amountCents: booking.totalCents - 100 })).json();
    await waitForCard(short.id);
    const mismatch = await call(staff, "POST", `/bookings/${booking.id}/check-in`, { payment: { method: "card" }, cardPaymentId: short.id });
    expect(mismatch.json().error.code).toBe("card_amount_mismatch");

    const ok = await call(staff, "POST", `/bookings/${booking.id}/check-in`, { payment: { method: "card" }, cardPaymentId: paid.id });
    expect(ok.json()).toMatchObject({ status: "checked_in", payment: { balanceCents: 0 } });
    expect((await call(staff, "GET", `/card-payments/${paid.id}`)).json().bookingId).toBe(booking.id);

    const other = await walkIn("09:18");
    const reused = await call(staff, "POST", `/bookings/${other.id}/check-in`, { payment: { method: "card" }, cardPaymentId: paid.id });
    expect(reused.json().error.code).toBe("card_payment_used");
  });

  it("covers the round and items in one tap, and declines show up", async () => {
    const booking = await walkIn("09:26");
    const product = (await call(manager, "POST", "/products", { name: "Bottled water", priceCents: 250, stock: 10, taxable: false })).json();
    const amount = booking.totalCents + 250;
    const card = await waitForCard((await call(staff, "POST", "/card-payments", { terminalId: reader, amountCents: amount })).json().id);
    const res = await call(staff, "POST", `/bookings/${booking.id}/check-in`, {
      payment: { method: "card" },
      items: { lines: [{ productId: product.id, quantity: 1 }], paymentMethod: "card" },
      cardPaymentId: card.id,
    });
    expect(res.statusCode).toBe(200);
    const linked = (await call(staff, "GET", `/card-payments/${card.id}`)).json();
    expect(linked.bookingId).toBe(booking.id);
    expect(linked.saleId).toBeTruthy();

    const declined = await waitForCard((await call(staff, "POST", "/card-payments", { terminalId: reader, amountCents: 4513 })).json().id);
    expect(declined).toMatchObject({ status: "failed", failureMessage: "Card declined (simulated)" });
  });

  it("refunds a register sale back to the card", async () => {
    const product = (await call(manager, "POST", "/products", { name: "Sleeve of balls", priceCents: 1200, stock: 5, taxable: false })).json();
    const card = await waitForCard((await call(staff, "POST", "/card-payments", { terminalId: reader, amountCents: 1200 })).json().id);
    const sale = (await call(staff, "POST", "/sales", { lines: [{ productId: product.id, quantity: 1 }], paymentMethod: "card", cardPaymentId: card.id })).json();
    expect((await call(staff, "GET", `/card-payments/${card.id}`)).json().saleId).toBe(sale.id);
    await call(manager, "POST", `/sales/${sale.id}/refund`);
    expect((await call(staff, "GET", `/card-payments/${card.id}`)).json().refundedCents).toBe(1200);
  });

  it("drives a Stripe reader and trusts only signed webhooks", async () => {
    expect((await call(manager, "PUT", "/settings/payments", { provider: "stripe" })).json().error.code).toBe("missing_field");
    const saved = (await call(manager, "PUT", "/settings/payments", { provider: "stripe", credentials: { secretKey: "sk_test_123", webhookSecret: "whsec_abc" } })).json();
    expect(saved).toMatchObject({ provider: "stripe", hasCredentials: true });
    expect(JSON.stringify(saved)).not.toContain("sk_test_123");

    answer = (u) => (u.includes("/terminal/readers?") ? { status: 200, body: { data: [{ id: "tmr_1", label: "Counter", status: "online" }] } } : { status: 404, body: {} });
    expect((await call(manager, "GET", "/settings/payments/readers")).json()).toEqual([{ readerId: "tmr_1", label: "Counter", online: true }]);
    const terminal = (await call(manager, "POST", "/terminals", { name: "Counter", readerId: "tmr_1" })).json();

    let piStatus = "requires_payment_method";
    answer = (u, method) => {
      if (u.endsWith("/payment_intents") && method === "POST") return { status: 200, body: { id: "pi_1" } };
      if (u.includes("/process_payment_intent")) return { status: 200, body: { id: "tmr_1" } };
      if (u.includes("/payment_intents/pi_1")) {
        return { status: 200, body: { id: "pi_1", status: piStatus, latest_charge: { id: "ch_1", payment_method_details: { card_present: { brand: "mastercard", last4: "5555" } } } } };
      }
      return { status: 404, body: { error: { message: "nope" } } };
    };
    calls.length = 0;
    const started = (await call(staff, "POST", "/card-payments", { terminalId: terminal.id, amountCents: 3000 })).json();
    expect(calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/payment_intents", "https://api.stripe.com/v1/terminal/readers/tmr_1/process_payment_intent"]);
    expect(calls[0]!.body).toContain("amount=3000");
    expect(calls[0]!.body).toContain("payment_method_types%5B%5D=card_present");

    // A forged webhook is turned away; a signed one makes the server look the payment up.
    const body = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { object: "payment_intent", id: "pi_1" } } });
    const hook = (signature: string) =>
      app.inject({ method: "POST", url: "/v1/webhooks/payments/river-bend/stripe", headers: { "content-type": "application/json", "stripe-signature": signature }, payload: body });
    const t = Math.floor(Date.now() / 1000);
    expect((await hook(`t=${t},v1=deadbeef`)).statusCode).toBe(401);
    piStatus = "succeeded";
    const signed = createHmac("sha256", "whsec_abc").update(`${t}.${body}`).digest("hex");
    expect((await hook(`t=${t},v1=${signed}`)).statusCode).toBe(200);
    const row = (await db.query("SELECT status, card_last4 FROM card_payments WHERE id = $1", [started.id])).rows[0];
    expect(row).toEqual({ status: "succeeded", card_last4: "5555" });
  });

  it("drives a Square Terminal checkout", async () => {
    await call(manager, "PUT", "/settings/payments", { provider: "square", account: { locationId: "L1", environment: "sandbox" }, credentials: { accessToken: "EAAA" } });
    const terminal = (await call(manager, "POST", "/terminals", { name: "Bar", readerId: "device-9", location: "Bar" })).json();
    answer = (u, method) => {
      if (u.endsWith("/v2/terminals/checkouts") && method === "POST") return { status: 200, body: { checkout: { id: "chk_1", status: "PENDING" } } };
      if (u.endsWith("/v2/terminals/checkouts/chk_1")) return { status: 200, body: { checkout: { id: "chk_1", status: "COMPLETED", payment_ids: ["pay_1"] } } };
      if (u.endsWith("/v2/payments/pay_1")) return { status: 200, body: { payment: { card_details: { card: { card_brand: "AMERICAN_EXPRESS", last_4: "0005" } }, tip_money: { amount: 200 } } } };
      return { status: 404, body: { errors: [{ detail: "nope" }] } };
    };
    calls.length = 0;
    const started = (await call(staff, "POST", "/card-payments", { terminalId: terminal.id, amountCents: 1800 })).json();
    expect(calls[0]!.url).toBe("https://connect.squareupsandbox.com/v2/terminals/checkouts");
    expect(JSON.parse(calls[0]!.body!).checkout).toMatchObject({ amount_money: { amount: 1800, currency: "USD" }, device_options: { device_id: "device-9" } });
    expect(await waitForCard(started.id)).toMatchObject({ status: "succeeded", cardBrand: "american_express", cardLast4: "0005", tipCents: 200 });
  });
});
