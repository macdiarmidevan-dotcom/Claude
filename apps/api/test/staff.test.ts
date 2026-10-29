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
let secretKey: string;
let manager: { email: string; password: string };

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const base = "/v1/courses/river-bend";

async function signIn(email: string, password: string) {
  return app.inject({ method: "POST", url: `${base}/login`, payload: { email, password } });
}

async function managerToken() {
  return (await signIn(manager.email, manager.password)).json().token as string;
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  secretKey = seeded.secretKey;
  manager = seeded.manager;
  app = buildApp(db);
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("staff logins", () => {
  it("signs a manager in and out", async () => {
    const res = await signIn(manager.email.toUpperCase(), manager.password);
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json();
    expect(token).toMatch(/^st_/);
    expect(user).toMatchObject({ name: "Course Manager", role: "manager" });
    expect(user.passwordHash).toBeUndefined();

    const me = await app.inject({ url: `${base}/me`, headers: auth(token) });
    expect(me.json()).toMatchObject({ role: "manager", user: { email: manager.email } });

    expect((await app.inject({ method: "POST", url: `${base}/logout`, headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/me`, headers: auth(token) })).statusCode).toBe(401);
  });

  it("gives the same answer for a wrong password and an unknown email, then locks after 5 tries", async () => {
    const wrong = await signIn(manager.email, "not-the-password");
    const unknown = await signIn("nobody@example.com", "whatever123");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);

    for (let i = 0; i < 5; i++) await signIn("locked@example.com", "wrong-password");
    expect((await signIn("locked@example.com", "wrong-password")).statusCode).toBe(429);
  });

  it("lets managers add employees, and employees can't manage accounts", async () => {
    const token = await managerToken();
    const added = await app.inject({
      method: "POST",
      url: `${base}/staff`,
      headers: auth(token),
      payload: { name: "Sam Starter", email: "sam@riverbend.example", role: "staff", password: "first-tee-1" },
    });
    expect(added.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: `${base}/staff`,
      headers: auth(token),
      payload: { name: "Sam Again", email: "SAM@riverbend.example", role: "staff", password: "first-tee-1" },
    });
    expect(dup.json().error.code).toBe("email_taken");
    const weak = await app.inject({
      method: "POST",
      url: `${base}/staff`,
      headers: auth(token),
      payload: { name: "Short", email: "short@riverbend.example", role: "staff", password: "abc" },
    });
    expect(weak.json().error.code).toBe("weak_password");

    const sam = (await signIn("sam@riverbend.example", "first-tee-1")).json().token;
    expect((await app.inject({ url: `${base}/me`, headers: auth(sam) })).json().role).toBe("staff");
    // Employees can run the tee sheet but not manager tools.
    expect((await app.inject({ url: `${base}/waiver`, headers: auth(sam) })).statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/staff`, headers: auth(sam) })).json().error.code).toBe("manager_only");
    expect(
      (await app.inject({ method: "PUT", url: `${base}/waiver`, headers: auth(sam), payload: { title: "Mine", body: "Twenty characters of wording." } })).statusCode,
    ).toBe(403);

    const list = await app.inject({ url: `${base}/staff`, headers: auth(token) });
    expect(list.json().map((u: { name: string }) => u.name)).toEqual(["Course Manager", "Sam Starter"]);
  });

  it("signs someone out everywhere when their account is turned off or reset", async () => {
    const token = await managerToken();
    const list = (await app.inject({ url: `${base}/staff`, headers: auth(token) })).json();
    const sam = list.find((u: { name: string }) => u.name === "Sam Starter");
    const samToken = (await signIn("sam@riverbend.example", "first-tee-1")).json().token;

    const reset = await app.inject({ method: "PATCH", url: `${base}/staff/${sam.id}`, headers: auth(token), payload: { password: "second-tee-2" } });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/me`, headers: auth(samToken) })).statusCode).toBe(401);
    expect((await signIn("sam@riverbend.example", "second-tee-2")).statusCode).toBe(200);

    await app.inject({ method: "PATCH", url: `${base}/staff/${sam.id}`, headers: auth(token), payload: { active: false } });
    const off = await signIn("sam@riverbend.example", "second-tee-2");
    expect(off.statusCode).toBe(401);
    expect(off.json().error.message).toMatch(/turned off/);
  });

  it("always keeps a manager", async () => {
    const token = await managerToken();
    const me = (await app.inject({ url: `${base}/me`, headers: auth(token) })).json().user;
    const self = await app.inject({ method: "PATCH", url: `${base}/staff/${me.id}`, headers: auth(token), payload: { role: "staff" } });
    expect(self.json().error.code).toBe("self_demote");
    // A manager device key has no account of its own, but still can't remove the last manager.
    const seededManagerKey = await seedKeyFor("manager");
    const last = await app.inject({ method: "PATCH", url: `${base}/staff/${me.id}`, headers: auth(seededManagerKey), payload: { active: false } });
    expect(last.json().error.code).toBe("last_manager");
  });

  it("lets people change their own password and keeps this device signed in", async () => {
    const token = await managerToken();
    const other = await managerToken();
    const bad = await app.inject({ method: "PUT", url: `${base}/me/password`, headers: auth(token), payload: { current: "nope", next: "new-password-1" } });
    expect(bad.json().error.code).toBe("wrong_password");
    const ok = await app.inject({ method: "PUT", url: `${base}/me/password`, headers: auth(token), payload: { current: manager.password, next: "new-password-1" } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/me`, headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/me`, headers: auth(other) })).statusCode).toBe(401);
    manager = { ...manager, password: "new-password-1" };
    const keyOnly = await app.inject({ method: "PUT", url: `${base}/me/password`, headers: auth(secretKey), payload: { current: "x", next: "new-password-1" } });
    expect(keyOnly.json().error.code).toBe("no_account");
  });

  it("logs who made each change, without passwords", async () => {
    const token = await managerToken();
    const log = (await app.inject({ url: `${base}/activity`, headers: auth(token) })).json();
    const actions = log.map((a: { actor: string; action: string }) => `${a.actor}: ${a.action}`);
    expect(actions).toContain("Course Manager: Added a staff account");
    expect(actions).toContain("Course Manager: Changed a staff account");
    expect(JSON.stringify(log)).not.toMatch(/first-tee|second-tee/);
    expect(log.find((a: { detail: { passwordReset?: boolean } }) => a.detail.passwordReset)).toBeTruthy();
    expect((await app.inject({ url: `${base}/activity`, headers: auth(secretKey) })).statusCode).toBe(403);
  });
});

async function seedKeyFor(role: "manager") {
  const { createApiKey } = await import("../src/keys.ts");
  const { rows } = await db.query("SELECT id FROM courses WHERE slug = 'river-bend'");
  return createApiKey(db, rows[0].id, "secret", "test", role);
}
