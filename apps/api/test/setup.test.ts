import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { buildApp } from "../src/app.ts";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { seedRiverBend } from "../src/seed.ts";
import { serveWeb } from "../src/web.ts";

process.env.NODE_ENV = "test";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let manager: string;
let staff: string;
const base = "/v1/courses/river-bend";
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

describe("health and setup checklist", () => {
  it("reports ready when the database answers", async () => {
    expect((await app.inject({ url: "/health" })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: "/ready" })).json()).toEqual({ ok: true });
  });

  it("is for managers and ticks items off as they're done", async () => {
    expect((await call(staff, "GET", "/setup")).json().error.code).toBe("manager_only");
    const before = (await call(manager, "GET", "/setup")).json();
    const item = (r: typeof before, id: string) => r.items.find((i: { id: string }) => i.id === id);
    expect(item(before, "staff").status).toBe("done"); // the manager and Jordan
    expect(item(before, "pay").status).toBe("todo");
    expect(item(before, "rates").status).toBe("done");
    expect(item(before, "tax").status).toBe("todo");
    expect(item(before, "sync").status).toBe("todo");
    expect(item(before, "waiver").status).toBe("todo");
    expect(item(before, "products").status).toBe("optional");
    expect(before.done).toBeLessThan(before.total);

    await call(manager, "PUT", "/settings/pos", { salesTaxBps: 725 });
    const people = (await call(manager, "GET", "/staff")).json();
    for (const p of people) await call(manager, "PATCH", `/staff/${p.id}`, { pay: { type: "hourly", cents: 1500 } });
    const after = (await call(manager, "GET", "/setup")).json();
    expect(item(after, "tax").status).toBe("done");
    expect(item(after, "pay").status).toBe("done");
    expect(after.done).toBe(before.done + 2);
  });
});

describe("serving the staff app", () => {
  it("serves files and falls back to the app, leaving the API alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await mkdir(join(dir, "_expo"));
    await writeFile(join(dir, "index.html"), "<html>app</html>");
    await writeFile(join(dir, "_expo", "app.js"), "console.log(1)");
    const web = Fastify();
    web.get("/health", async () => ({ ok: true }));
    serveWeb(web, dir);

    expect((await web.inject({ url: "/" })).body).toBe("<html>app</html>");
    expect((await web.inject({ url: "/reports/anything" })).body).toBe("<html>app</html>");
    const js = await web.inject({ url: "/_expo/app.js" });
    expect(js.body).toBe("console.log(1)");
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect((await web.inject({ url: "/index.html" })).headers["cache-control"]).toBe("no-cache");
    expect((await web.inject({ url: "/v1/nope" })).statusCode).toBe(404);
    expect((await web.inject({ url: "/..%2f..%2fetc/passwd" })).statusCode).toBe(404);
    expect((await web.inject({ method: "POST", url: "/anything" })).statusCode).toBe(404);
    await web.close();
  });
});
