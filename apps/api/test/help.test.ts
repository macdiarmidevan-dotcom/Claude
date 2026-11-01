import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { answerFromArticles, searchHelp } from "@golf/core";
import { buildApp } from "../src/app.ts";
import { askHelp, type HelpAi } from "../src/help.ts";
import type { Course } from "../src/courses.ts";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { seedRiverBend } from "../src/seed.ts";

process.env.NODE_ENV = "test";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let manager: string;
let staff: string;

// Stands in for Claude: records what it was sent and answers from a fixed script.
const aiCalls: Parameters<HelpAi>[0][] = [];
const fakeAi: HelpAi = async (input) => {
  aiCalls.push(input);
  return { answer: "Tap the group, then Rain check.", articleIds: ["rain-check", "not-an-article"] };
};
const sent: { to: string; subject: string | null; body: string; replyTo: string | null }[] = [];
const sender = { name: "test", send: async (m: { to: string; subject: string | null; body: string; replyTo: string | null }) => (sent.push(m), { ok: true as const }) };

const base = "/v1/courses/river-bend";
const call = (token: string, method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db, { helpAi: fakeAi, supportSender: sender });
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
  await call(manager, "POST", "/staff", { name: "Jordan Price", email: "jordan@example.com", role: "staff", password: "proshop-pass1" });
  staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "jordan@example.com", password: "proshop-pass1" } })).json().token;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("help search", () => {
  it("ranks the article that matches the question first", () => {
    expect(searchHelp("how do I give a rain check")[0]?.id).toBe("rain-check");
    expect(searchHelp("frost delay")[0]?.id).toBe("weather-delay");
    expect(searchHelp("forgot my password")[0]?.id).toBe("my-account");
    expect(searchHelp("   ")).toEqual([]);
  });

  it("answers from the closest paragraph without the assistant", () => {
    const a = answerFromArticles("how do I change my password");
    expect(a.articles[0]?.id).toBe("my-account");
    expect(a.answer).toContain("current password");
    expect(answerFromArticles("zzqx").articles).toEqual([]);
  });
});

describe("help assistant", () => {
  it("answers from the articles and drops ids it doesn't know", async () => {
    const res = await call(staff, "POST", "/help/ask", { question: "How do I give a rain check?", page: "Tee sheet", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answer: "Tap the group, then Rain check.", articles: [{ id: "rain-check", title: "Rain checks and refunds" }], via: "ai" });
    const last = aiCalls.at(-1)!;
    expect(last.system).toContain("River Bend");
    expect(last.system).toContain("This person is staff, not a manager");
    expect(last.system).toContain('<article id="rain-check"');
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("rejects an empty question", async () => {
    expect((await call(staff, "POST", "/help/ask", { question: "  " })).statusCode).toBe(400);
  });

  it("falls back to the closest articles without an assistant or when it fails", async () => {
    const course = { name: "River Bend Golf Club" } as Course;
    const input = { question: "how do I add a walk-in", history: [], page: null, isManager: false };
    const plain = await askHelp(undefined, course, input);
    expect(plain.via).toBe("search");
    expect(plain.articles[0]?.id).toBe("walk-in");
    expect(plain.answer).toContain("Add a walk-in");
    const failing = await askHelp(async () => { throw new Error("down"); }, course, input);
    expect(failing.via).toBe("search");
    expect((await askHelp(undefined, course, { ...input, question: "zzqx" })).articles).toEqual([]);
  });
});

describe("support requests", () => {
  it("saves a request, emails support with a reference, and shows staff only their own", async () => {
    const bad = await call(staff, "POST", "/support", { topic: "problem", subject: "x", body: "y", replyTo: "not-an-email" });
    expect(bad.statusCode).toBe(400);

    const res = await call(staff, "POST", "/support", { topic: "problem", subject: "Card reader won't connect", body: "It says offline.", replyTo: "jordan@example.com", page: "Settings" });
    expect(res.statusCode).toBe(201);
    const req = res.json();
    expect(req).toMatchObject({ topic: "problem", subject: "Card reader won't connect", status: "sent", staff: "Jordan Price", page: "Settings" });
    expect(req.reference).toMatch(/^SR-\d{5}$/);
    const email = sent.at(-1)!;
    expect(email.subject).toBe(`[${req.reference}] Something isn't working: Card reader won't connect`);
    expect(email.replyTo).toBe("jordan@example.com");
    expect(email.body).toContain("Course: River Bend Golf Club");

    await call(manager, "POST", "/support", { topic: "billing", subject: "Invoice", body: "Question about our invoice", replyTo: "manager@example.com" });
    const mine = (await call(staff, "GET", "/support")).json();
    expect(mine.map((r: { subject: string }) => r.subject)).toEqual(["Card reader won't connect"]);
    const all = (await call(manager, "GET", "/support")).json();
    expect(all).toHaveLength(2);
  });
});
