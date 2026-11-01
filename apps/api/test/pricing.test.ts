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
const call = (token: string, method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
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


describe("pricing", () => {
  it("lists the course's rates and add-ons to everyone", async () => {
    const rates = (await call(staff, "GET", "/pricing/rates")).json();
    expect(rates.length).toBeGreaterThan(5);
    expect(rates.find((r: any) => r.code === "we-nonres")).toMatchObject({ name: "Weekend nonresident", priceCents: 3100, residency: "nonresident" });
    const addOns = (await call(staff, "GET", "/pricing/add-ons")).json();
    expect(addOns.find((a: any) => a.code === "gas_cart")).toMatchObject({ locked: true, priceCents: 1300 });
  });

  it("lets only managers add and change rates", async () => {
    const body = { name: "Twilight", priceCents: 1900, days: [1, 2, 3, 4, 5, 6, 7], startTime: "16:00" };
    expect((await call(staff, "POST", "/pricing/rates", body)).statusCode).toBe(403);
    expect((await call(manager, "POST", "/pricing/rates", { ...body, startTime: "18:00", endTime: "16:00" })).statusCode).toBe(400);
    const made = await call(manager, "POST", "/pricing/rates", body);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ code: "twilight", startTime: "16:00", endTime: null, residency: null, ageGroups: null });
    expect((await call(manager, "POST", "/pricing/rates", body)).json().code).toBe("twilight-2");

    const changed = await call(manager, "PATCH", `/pricing/rates/${made.json().id}`, { priceCents: 1700, ageGroups: ["senior"] });
    expect(changed.json()).toMatchObject({ priceCents: 1700, ageGroups: ["senior"], startTime: "16:00" });

    const removed = await call(manager, "PATCH", `/pricing/rates/${made.json().id}`, { active: false });
    expect(removed.json().active).toBe(false);
    const rates = (await call(staff, "GET", "/pricing/rates")).json();
    expect(rates.some((r: any) => r.id === made.json().id)).toBe(false);
  });

  it("adds, reprices and removes add-ons, but keeps the gas cart", async () => {
    expect((await call(staff, "POST", "/pricing/add-ons", { name: "Range balls", priceCents: 800 })).statusCode).toBe(403);
    const made = (await call(manager, "POST", "/pricing/add-ons", { name: "Range balls", priceCents: 800 })).json();
    expect(made).toMatchObject({ code: "range_balls", locked: false });
    expect((await call(manager, "PATCH", `/pricing/add-ons/${made.id}`, { priceCents: 900 })).json().priceCents).toBe(900);
    expect((await call(manager, "PATCH", `/pricing/add-ons/${made.id}`, { active: false })).json().active).toBe(false);

    const gas = (await call(staff, "GET", "/pricing/add-ons")).json().find((a: any) => a.code === "gas_cart");
    expect((await call(manager, "PATCH", `/pricing/add-ons/${gas.id}`, { active: false })).statusCode).toBe(409);
    expect((await call(manager, "PATCH", `/pricing/add-ons/${gas.id}`, { priceCents: 1400 })).json().priceCents).toBe(1400);
  });
});
