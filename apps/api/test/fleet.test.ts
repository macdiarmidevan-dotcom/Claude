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
const signature = "M10 100 L40 60 L80 120 L120 70";
const signed = (...carts: string[]) => carts.map((cartNumber) => ({ cartNumber, driverName: "Pat Golfer", signature }));

let n = 0;
async function checkedIn() {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${today}`)).json();
  const teeTimeId = sheet.teeTimes.at(-1 - n++).id;
  const b = (await call(staff, "POST", "/bookings", { teeTimeId, holes: 9, customer: { name: `Golfer ${n}`, email: `g${n}@example.com` }, players: [{}, {}], source: "staff" })).json();
  await call(staff, "POST", `/bookings/${b.id}/check-in`, { payment: { method: "cash" } });
  return b.id as string;
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

describe("cart fleet", () => {
  it("lets any cart number through until the fleet is set up, then only carts in service", async () => {
    const first = await checkedIn();
    expect((await call(staff, "POST", `/bookings/${first}/tee-off`, { cartNumbers: ["99"], waivers: signed("99") })).statusCode).toBe(200);

    expect((await call(staff, "POST", "/fleet/carts", { from: 1, to: 10 })).json().error.code).toBe("manager_only");
    const added = (await call(manager, "POST", "/fleet/carts", { from: 1, to: 10, model: "Club Car Tempo", power: "gas", serviceEvery: 2 })).json();
    expect(added.added).toBe(10);
    expect(added.carts.map((c: any) => c.number).slice(0, 3)).toEqual(["1", "2", "3"]);
    // Adding the same range again skips what's there.
    expect((await call(manager, "POST", "/fleet/carts", { from: 9, to: 12 })).json().added).toBe(2);

    const b = await checkedIn();
    const unknown = await call(staff, "POST", `/bookings/${b}/tee-off`, { cartNumbers: ["40"], waivers: signed("40") });
    expect(unknown.json().error.code).toBe("unknown_cart");

    const cart3 = added.carts.find((c: any) => c.number === "3");
    expect((await call(staff, "POST", `/fleet/${cart3.id}/status`, { status: "out_of_service" })).json().error.code).toBe("note_required");
    await call(staff, "POST", `/fleet/${cart3.id}/status`, { status: "out_of_service", note: "Flat tire" });
    const down = await call(staff, "POST", `/bookings/${b}/tee-off`, { cartNumbers: ["3"], waivers: signed("3") });
    expect(down.json().error).toMatchObject({ code: "cart_out_of_service", message: "Cart 3 is out of service (Flat tire)" });

    expect((await call(staff, "POST", `/bookings/${b}/tee-off`, { cartNumbers: ["4"], waivers: signed("4") })).statusCode).toBe(200);
    let carts = (await call(staff, "GET", "/fleet?kind=cart")).json();
    const four = carts.find((c: any) => c.number === "4");
    expect(four.out).toMatchObject({ bookingId: b, name: expect.stringMatching(/^Golfer/) });
    expect(four.sinceService).toBe(1);
    expect(four.serviceDue).toBe(false);

    // Back in, then out again on a second round: service comes due at two rounds.
    await call(staff, "POST", `/bookings/${b}/carts-in`);
    const c = await checkedIn();
    await call(staff, "POST", `/bookings/${c}/tee-off`, { cartNumbers: ["4"], waivers: signed("4") });
    carts = (await call(staff, "GET", "/fleet?kind=cart")).json();
    expect(carts.find((x: any) => x.number === "4")).toMatchObject({ sinceService: 2, serviceDue: true });

    const serviced = (await call(staff, "POST", `/fleet/${four.id}/service`, { kind: "service", note: "Oil change", costCents: 4500 })).json();
    expect(serviced).toMatchObject({ sinceService: 0, serviceDue: false });
    expect(serviced.service[0]).toMatchObject({ kind: "service", note: "Oil change", costCents: 4500, staff: "Jordan Price" });
  });

  it("tracks equipment hours toward its service", async () => {
    const mower = (await call(manager, "POST", "/fleet", { kind: "equipment", number: "Greens mower 1", model: "Toro Greensmaster 3150", power: "diesel", hours: 400, serviceEvery: 50 })).json();
    expect(mower).toMatchObject({ sinceService: 0, serviceDue: false });
    expect((await call(manager, "POST", "/fleet", { kind: "equipment", number: "Greens mower 1" })).json().error.code).toBe("asset_exists");
    expect((await call(staff, "PUT", `/fleet/${mower.id}/hours`, { hours: 390 })).json().error.code).toBe("hours_back");
    expect((await call(staff, "PUT", `/fleet/${mower.id}/hours`, { hours: 455.5 })).json()).toMatchObject({ hours: 455.5, sinceService: 55.5, serviceDue: true });
    const done = (await call(staff, "POST", `/fleet/${mower.id}/service`, { kind: "service", note: "Reel sharpened", hours: 456 })).json();
    expect(done).toMatchObject({ hours: 456, sinceService: 0, serviceDue: false });
    // Retired machines drop off the list.
    await call(manager, "PATCH", `/fleet/${mower.id}`, { retired: true });
    expect((await call(staff, "GET", "/fleet?kind=equipment")).json()).toHaveLength(0);
    expect((await call(staff, "GET", "/fleet?kind=equipment&retired=true")).json()).toHaveLength(1);
  });
});

describe("work orders", () => {
  it("takes a reported cart out of service and puts it back when the work is done", async () => {
    const carts = (await call(staff, "GET", "/fleet?kind=cart")).json();
    const seven = carts.find((c: any) => c.number === "7");
    const people = (await call(staff, "GET", "/coworkers")).json();
    const jordan = people.find((p: any) => p.name === "Jordan Price").id;
    const order = (
      await call(staff, "POST", "/work-orders", { title: "Brakes squeal", area: "other", assetId: seven.id, priority: "high", outOfService: true, assignedTo: jordan })
    ).json();
    expect(order).toMatchObject({ number: 1, area: "carts", status: "open", priority: "high", asset: { number: "7" }, assignedTo: { name: "Jordan Price" }, reportedBy: "Jordan Price" });
    expect((await call(staff, "GET", `/fleet/${seven.id}`)).json()).toMatchObject({ status: "out_of_service", statusNote: "Brakes squeal", openWorkOrders: 1 });

    const course = (await call(staff, "POST", "/work-orders", { title: "Bunker washed out", area: "course", location: "Hole 7 greenside", priority: "low", dueDate: "2020-01-01" })).json();
    expect(course).toMatchObject({ number: 2, area: "course", overdue: true });
    // Most urgent first.
    expect((await call(staff, "GET", "/work-orders")).json().map((w: any) => w.number)).toEqual([1, 2]);
    expect((await call(staff, "POST", `/work-orders/${course.id}/status`, { status: "cancelled" })).json().error.code).toBe("manager_only");

    await call(staff, "POST", `/work-orders/${order.id}/status`, { status: "in_progress", note: "Pads ordered" });
    await call(staff, "POST", `/work-orders/${order.id}/notes`, { note: "Pads came in" });
    const done = (await call(staff, "POST", `/work-orders/${order.id}/status`, { status: "done", note: "New brake pads", costCents: 6000, backInService: true })).json();
    expect(done).toMatchObject({ status: "done", costCents: 6000, completedAt: expect.any(String) });
    expect(done.notes.map((x: any) => [x.status, x.note])).toEqual([
      ["in_progress", "Pads ordered"],
      [null, "Pads came in"],
      ["done", "New brake pads"],
    ]);
    const cart = (await call(staff, "GET", `/fleet/${seven.id}`)).json();
    expect(cart).toMatchObject({ status: "in_service", openWorkOrders: 0 });
    expect(cart.service[0]).toMatchObject({ kind: "repair", note: "New brake pads", costCents: 6000, workOrderNumber: 1 });
    expect((await call(staff, "GET", "/work-orders?status=closed")).json().map((w: any) => w.number)).toEqual([1]);

    expect((await call(manager, "POST", `/work-orders/${course.id}/status`, { status: "cancelled", note: "Fixed by the grounds crew already" })).json().status).toBe("cancelled");
  });
});
