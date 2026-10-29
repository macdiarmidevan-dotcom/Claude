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
const call = (token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db);
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
  await call(manager, "POST", "/staff", { name: "Casey Grill", email: "casey@example.com", role: "staff", password: "grill-pass-1" });
  staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "casey@example.com", password: "grill-pass-1" } })).json().token;
  await call(manager, "PUT", "/settings/pos", { salesTaxBps: 1000 });
  await call(manager, "PUT", "/settings/loyalty", { pointsPerDollar: 1, rewardPoints: 100, rewardCents: 500 });
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("food and bar", () => {
  let burger: string;
  let beer: string;
  let water: string;
  let balls: string;

  it("adds menu items with a prep station", async () => {
    const add = (body: object) => call(manager, "POST", "/products", body).then((r) => r.json());
    burger = (await add({ name: "Turn burger", category: "Grill", priceCents: 900, trackStock: false, station: "kitchen" })).id;
    const b = await add({ name: "Draft beer", category: "Beer", priceCents: 600, stock: 100, station: "bar" });
    expect(b).toMatchObject({ station: "bar", foodBev: true });
    beer = b.id;
    water = (await add({ name: "Bottled water", category: "Drinks", priceCents: 200, stock: 48, foodBev: true })).id;
    balls = (await add({ name: "Sleeve of balls", category: "Balls", priceCents: 1500, stock: 20 })).id;
  });

  it("opens a tab for a group on the tee sheet and sends orders to the kitchen and bar", async () => {
    const golfer = (await call(staff, "POST", "/golfers", { name: "Rita Moreno", email: "rita@example.com", phone: "630-555-0199" })).json().id;
    const sheet = (await call(staff, "GET", `/tee-sheet?date=${today}`)).json();
    const teeTimeId = sheet.teeTimes.at(-1).id;
    const booking = (await call(staff, "POST", "/bookings", { teeTimeId, holes: 18, customer: { name: "Rita Moreno", email: "rita@example.com" }, players: [{}, {}], source: "staff" })).json();
    await call(staff, "PUT", `/bookings/${booking.id}/golfer`, { golferId: golfer });

    const tab = await call(staff, "POST", "/tabs", { bookingId: booking.id, location: "turn" });
    expect(tab.statusCode).toBe(201);
    expect(tab.json()).toMatchObject({ name: "Rita Moreno", location: "turn", status: "open" });
    const id = tab.json().id;
    expect((await call(staff, "POST", "/tabs", { bookingId: booking.id })).json().error.code).toBe("tab_open");

    const after = (
      await call(staff, "POST", `/tabs/${id}/items`, {
        lines: [
          { productId: burger, quantity: 2, note: "One no onions" },
          { productId: beer, quantity: 2 },
          { productId: water, quantity: 1 },
          { productId: balls, quantity: 1 },
        ],
      })
    ).json();
    expect(after.subtotalCents).toBe(1800 + 1200 + 200 + 1500);
    expect(after.taxCents).toBe(470);
    expect(after.waiting).toBe(2);
    expect(after.items.find((i: { productId: string }) => i.productId === water).status).toBe("served");

    const kitchen = (await call(staff, "GET", "/prep/kitchen")).json();
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0]).toMatchObject({ tabName: "Rita Moreno", location: "turn" });
    expect(kitchen[0].items[0]).toMatchObject({ description: "Turn burger", quantity: 2, note: "One no onions" });
    const bar = (await call(staff, "GET", "/prep/bar")).json();
    expect(bar[0].items[0].description).toBe("Draft beer");

    // The kitchen makes it; once it's made, only a manager can take it off.
    const burgerItem = kitchen[0].items[0].id;
    await call(staff, "POST", "/prep/items", { itemIds: [burgerItem], status: "ready" });
    expect((await call(staff, "DELETE", `/tabs/${id}/items/${burgerItem}`)).json().error.code).toBe("already_made");
    await call(staff, "POST", "/prep/items", { itemIds: [burgerItem], status: "served" });
    expect((await call(staff, "GET", "/prep/kitchen")).json()).toHaveLength(0);

    // Anyone can take off a drink the bar hasn't poured.
    const beerItem = bar[0].items[0].id;
    const voided = (await call(staff, "DELETE", `/tabs/${id}/items/${beerItem}`)).json();
    expect(voided.subtotalCents).toBe(1800 + 200 + 1500);

    // A price change mid-round doesn't change what's on the tab.
    await call(manager, "PATCH", `/products/${burger}`, { priceCents: 1100 });

    const closed = (await call(staff, "POST", `/tabs/${id}/close`, { paymentMethod: "cash" })).json();
    expect(closed.tab.status).toBe("closed");
    expect(closed.sale).toMatchObject({ subtotalCents: 3500, taxCents: 350, totalCents: 3850, golfer: { id: golfer } });
    expect((await call(staff, "POST", `/tabs/${id}/items`, { lines: [{ productId: water, quantity: 1 }] })).json().error.code).toBe("tab_closed");
    expect((await call(staff, "GET", "/tabs")).json()).toHaveLength(0);
    // Stock came off when it was paid.
    const products = (await call(staff, "GET", "/products")).json();
    expect(products.find((p: { id: string }) => p.id === water).stock).toBe(47);
    expect(products.find((p: { id: string }) => p.id === beer).stock).toBe(100);

    // Points were earned on the tab.
    const wallet = (await call(staff, "GET", `/golfers/${golfer}/wallet`)).json();
    expect(wallet.loyalty.points).toBe(35);
  });

  it("splits food and drink from the pro shop in reports", async () => {
    const r = (await call(manager, "GET", `/reports?from=${today}&to=${today}`)).json();
    expect(r.revenue.foodBevCents).toBe(2000);
    expect(r.revenue.proShopCents).toBe(1500);
    expect(r.revenue.foodBevByCategory.map((c: { category: string }) => c.category).sort()).toEqual(["Drinks", "Grill"]);
    expect(r.days[0]).toMatchObject({ foodBevCents: 2000, proShopCents: 1500 });
  });

  it("only lets managers void a tab that has items", async () => {
    const tab = (await call(staff, "POST", "/tabs", { name: "Table 4", location: "grill" })).json();
    await call(staff, "POST", `/tabs/${tab.id}/items`, { lines: [{ description: "Soup of the day", unitCents: 500, quantity: 1, station: "kitchen" }] });
    expect((await call(staff, "GET", "/prep/kitchen")).json()[0].items[0].description).toBe("Soup of the day");
    expect((await call(staff, "POST", `/tabs/${tab.id}/void`, { reason: "Walked out" })).json().error.code).toBe("tab_has_items");
    const v = (await call(manager, "POST", `/tabs/${tab.id}/void`, { reason: "Walked out" })).json();
    expect(v).toMatchObject({ status: "void", voidReason: "Walked out" });
    expect((await call(staff, "GET", "/prep/kitchen")).json()).toHaveLength(0);
    const empty = (await call(staff, "POST", "/tabs", { name: "Oops" })).json();
    expect((await call(staff, "POST", `/tabs/${empty.id}/close`, { paymentMethod: "cash" })).json().error.code).toBe("empty_tab");
    expect((await call(staff, "POST", `/tabs/${empty.id}/void`, { reason: "Opened by mistake" })).json().status).toBe("void");
  });
});
