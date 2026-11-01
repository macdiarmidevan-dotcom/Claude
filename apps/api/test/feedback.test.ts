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
const call = (token: string, method: "GET" | "POST", path: string, payload?: object) =>
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

describe("staff feedback", () => {
  it("lets anyone send feedback and only managers read it", async () => {
    expect((await call(staff, "POST", "/feedback", { body: "  " })).statusCode).toBe(400);
    const sent = await call(staff, "POST", "/feedback", { body: "The waiver screen is slow on the iPad", page: "Tee sheet" });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ body: "The waiver screen is slow on the iPad", page: "Tee sheet", staff: "Jordan Price" });

    expect((await call(staff, "GET", "/feedback")).statusCode).toBe(403);
    const list = (await call(manager, "GET", "/feedback")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ staff: "Jordan Price", page: "Tee sheet" });
  });
});
