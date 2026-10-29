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
let tuesday = now.plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
const date = tuesday.toISODate()!;

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

describe("reports and day close", () => {
  let roundCents = 0;
  let saleCents = 0;
  let saleTax = 0;

  it("adds up tee sheet and pro shop money, rounds and tax", async () => {
    const sheet = (await call(staff, "GET", `/tee-sheet?date=${date}`)).json();
    const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime === "09:02").id;
    const booking = (
      await call(staff, "POST", "/bookings", {
        teeTimeId,
        holes: 18,
        customer: { name: "Walk-in", email: "walkin+1@walkin.local" },
        players: [{}, {}],
        addOns: [{ code: "gas_cart", quantity: 2 }],
        source: "staff",
      })
    ).json();
    roundCents = booking.totalCents;
    await call(staff, "POST", `/bookings/${booking.id}/check-in`, { payment: { method: "cash" } });

    await call(manager, "PUT", "/settings/pos", { salesTaxBps: 1000 });
    const hat = (await call(manager, "POST", "/products", { name: "Cap", category: "Apparel", priceCents: 2000, stock: 5 })).json();
    const sale = (await call(staff, "POST", "/sales", { lines: [{ productId: hat.id, quantity: 2 }], paymentMethod: "card" })).json();
    saleCents = sale.totalCents;
    saleTax = sale.taxCents;

    expect((await call(staff, "GET", `/reports?from=${today}&to=${date}`)).json().error.code).toBe("manager_only");
    const r = (await call(manager, "GET", `/reports?from=${today}&to=${date}`)).json();
    expect(r.revenue).toMatchObject({ greenFeesCents: roundCents - 2 * 1300, cartsAndExtrasCents: 2 * 1300, proShopCents: 4000, salesTaxCents: 400 });
    expect(r.revenue.totalCents).toBe(roundCents + 4000);
    expect(r.revenue.proShopByCategory).toEqual([{ category: "Apparel", cents: 4000, items: 2 }]);
    expect(r.collected).toMatchObject({ cash: roundCents, card: saleCents, totalCents: roundCents + saleCents });
    expect(r.rounds).toMatchObject({ played: 2, booked: 2, noShows: 0, bySource: { staff: 2 } });
    expect(r.rounds.openSpots).toBeGreaterThan(0);
    expect(r.days.find((d: { date: string }) => d.date === date)).toMatchObject({ rounds: 2, greenFeesCents: roundCents - 2600 });
    expect(r.days.find((d: { date: string }) => d.date === today)).toMatchObject({ proShopCents: 4000, taxCents: saleTax });
  });

  it("closes the day against the cash drawer", async () => {
    const before = (await call(staff, "GET", `/closes/${today}`)).json();
    expect(before.close).toBeNull();
    expect(before.expected).toMatchObject({ cash: roundCents, card: saleCents });

    const short = await call(staff, "PUT", `/closes/${today}`, { countedCashCents: roundCents - 500 });
    expect(short.json().error.code).toBe("note_required");
    const closed = (await call(staff, "PUT", `/closes/${today}`, { countedCashCents: roundCents - 500, note: "Gave change twice" })).json();
    expect(closed.close).toMatchObject({ expectedCashCents: roundCents, overShortCents: -500, closedBy: "Jordan Price" });

    expect((await call(staff, "PUT", `/closes/${today}`, { countedCashCents: roundCents })).json().error.code).toBe("already_closed");
    const redo = (await call(manager, "PUT", `/closes/${today}`, { countedCashCents: roundCents })).json();
    expect(redo.close).toMatchObject({ overShortCents: 0, closedBy: "Course Manager" });
  });
});
