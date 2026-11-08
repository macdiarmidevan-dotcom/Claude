import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { parseDataQuestion, quickAnswer } from "@golf/core";
import { buildApp } from "../src/app.ts";
import type { DataAi } from "../src/askdata.ts";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { seedRiverBend } from "../src/seed.ts";

process.env.NODE_ENV = "test";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let offline: FastifyInstance;
let manager: string;
let staff: string;

const base = "/v1/courses/river-bend";
const zone = "America/Chicago";
const today = DateTime.now().setZone(zone);
let tuesday = today.plus({ days: 1 });
while (tuesday.weekday !== 2) tuesday = tuesday.plus({ days: 1 });
const date = tuesday.toISODate()!;

// Stands in for Claude: calls the tools it's told to, records what it saw, and answers.
let script: { name: string; input: unknown }[] = [];
const seen: { system: string; messages: { role: string; content: string }[]; results: string[]; errors: string[] }[] = [];
const fakeAi: DataAi = async ({ system, messages, tools, runTool }) => {
  expect(tools.map((t) => t.name)).toContain("revenue");
  const results: string[] = [];
  const errors: string[] = [];
  for (const call of script) {
    try {
      results.push(await runTool(call.name, call.input));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  seen.push({ system, messages, results, errors });
  if (script[0]?.name === "fail") throw new Error("Claude is down");
  return "Revenue was $123.";
};

const call = (a: FastifyInstance, token: string, method: "GET" | "POST", path: string, payload?: object) =>
  a.inject({ method, url: base + path, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const seeded = await seedRiverBend(db);
  app = buildApp(db, { dataAi: fakeAi });
  offline = buildApp(db, { dataAi: null });
  manager = (await app.inject({ method: "POST", url: `${base}/login`, payload: seeded.manager })).json().token;
  await call(app, manager, "POST", "/staff", { name: "Jordan Price", email: "jordan@example.com", role: "staff", password: "proshop-pass1" });
  staff = (await app.inject({ method: "POST", url: `${base}/login`, payload: { email: "jordan@example.com", password: "proshop-pass1" } })).json().token;

  const sheet = (await call(app, staff, "GET", `/tee-sheet?date=${date}`)).json();
  const teeTimeId = sheet.teeTimes.find((t: { localTime: string }) => t.localTime >= "09:00").id;
  const res = await call(app, staff, "POST", "/bookings", {
    teeTimeId,
    holes: 18,
    customer: { name: "Pat Golfer", email: "pat@example.com" },
    players: [{}, {}],
    addOns: [{ code: "gas_cart", quantity: 2 }],
    source: "staff",
  });
  expect(res.statusCode, res.body).toBe(201);
});

afterAll(async () => {
  await app?.close();
  await offline?.close();
  await db?.end();
});

describe("reading a question", () => {
  const day = "2026-11-08"; // a Sunday
  it("finds the report and the dates", () => {
    expect(parseDataQuestion("How did revenue this month compare?", day)).toEqual({ topic: "revenue", from: "2026-11-01", to: day, period: "this month" });
    expect(parseDataQuestion("how full was the tee sheet last week", day)).toMatchObject({ topic: "rounds", from: "2026-10-26", to: "2026-11-01" });
    expect(parseDataQuestion("labor cost yesterday", day)).toMatchObject({ topic: "labor", from: "2026-11-07", to: "2026-11-07" });
    expect(parseDataQuestion("what needs reordering", day)).toMatchObject({ topic: "inventory", from: "2026-11-02", to: day, period: "the last 7 days" });
    expect(parseDataQuestion("How much do members owe on house accounts?", day).topic).toBe("balances");
    expect(parseDataQuestion("revenue in October", day)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", period: "October" });
    // A month that hasn't come yet this year means last year's.
    expect(parseDataQuestion("rounds in december", day)).toMatchObject({ from: "2025-12-01", to: "2025-12-31", period: "December 2025" });
    expect(parseDataQuestion("may I see sales", day).period).toBe("the last 7 days");
    expect(parseDataQuestion("revenue this month compared with last month", day).period).toBe("this month");
    expect(parseDataQuestion("last month against this month", day).period).toBe("last month");
    expect(parseDataQuestion("sales year to date", day)).toMatchObject({ from: "2026-01-01", to: day });
  });

  it("sums up a report in sentences", () => {
    const q = { topic: "inventory" as const, from: "2026-11-02", to: day, period: "the last 7 days" };
    const text = quickAnswer(q, {
      topic: "inventory",
      data: {
        sales: { revenueCents: 45000, units: 12, marginPct: 41.5 },
        items: [{ name: "Pro V1 dozen", units: 5, revenueCents: 27500 }],
        stock: { products: 3, costCents: 120000, retailCents: 200000 },
        reorder: [{ name: "Tees", stock: 2, reorderLevel: 10 }],
      },
    });
    expect(text).toBe(
      "For the last 7 days (Nov 2 to Nov 8), register sales were 12 items for $450, at a 41.5% margin. Best sellers: Pro V1 dozen ($275). 1 product is at or below the reorder level: Tees (2 left). Stock on hand is worth $1,200 at cost.",
    );
  });
});

describe("ask your data", () => {
  it("is for managers only", async () => {
    const res = await call(app, staff, "POST", "/reports/ask", { question: "How much did we make?" });
    expect(res.json().error.code).toBe("manager_only");
  });

  it("lets Claude read the reports and lists the ones it used", async () => {
    script = [
      { name: "revenue", input: { from: date, to: date, compare: "previous" } },
      { name: "rounds", input: { from: date, to: date, compare: "none" } },
      { name: "tee_sheet_day", input: { date } },
      { name: "labor", input: { from: date, to: date } },
      { name: "revenue", input: { from: date, to: date, compare: "last_year" } },
      { name: "revenue", input: { from: "2020-01-01", to: date, compare: "none" } },
      { name: "nope", input: {} },
    ];
    const res = await call(app, manager, "POST", "/reports/ask", {
      question: "How did next Tuesday look?",
      history: [
        { role: "assistant", content: "Ask me anything" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      answer: "Revenue was $123.",
      via: "ai",
      sources: [
        { tab: "revenue", from: date, to: date },
        { tab: "rounds", from: date, to: date },
        { tab: "labor", from: date, to: date },
      ],
    });
    const s = seen.at(-1)!;
    // The conversation starts with a question, and today's date is in the instructions.
    expect(s.messages[0]).toEqual({ role: "user", content: "Hi" });
    expect(s.messages.at(-1)).toEqual({ role: "user", content: "How did next Tuesday look?" });
    expect(s.system).toContain(today.toISODate()!);
    const revenue = JSON.parse(s.results[0]!);
    expect(revenue.revenue.totalCents).toBeGreaterThan(0);
    expect(revenue.rounds).toBe(2);
    expect(JSON.parse(s.results[1]!).rounds.riding).toBe(2);
    expect(JSON.parse(s.results[2]!).groupsOnTheSheet[0].name).toBe("Pat Golfer");
    expect(s.errors).toHaveLength(2);
    expect(s.errors[0]).toContain("366 days");
    expect(s.errors[1]).toContain("no tool");
  });

  it("falls back to a summary of one report when Claude can't answer", async () => {
    script = [{ name: "fail", input: {} }];
    const res = await call(app, manager, "POST", "/reports/ask", { question: "How full was the tee sheet this week?" });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json();
    expect(a.via).toBe("summary");
    expect(a.sources).toEqual([{ tab: "rounds", from: today.startOf("week").toISODate(), to: today.toISODate() }]);
    expect(a.answer).toMatch(/^\d+ rounds for this week/);
  });

  it("answers from the reports without Claude set up", async () => {
    for (const [question, start] of [
      ["What did we make yesterday?", /^Revenue for yesterday/],
      ["labor cost this month", /^Labor cost \$/],
      ["what needs reordering", /^For the last 7 days .*, register sales were/],
      ["how much do members owe", /^For the last 7 days .*, the course took in/],
    ] as const) {
      const res = await call(offline, manager, "POST", "/reports/ask", { question });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().via).toBe("summary");
      expect(res.json().answer).toMatch(start);
    }
    expect((await call(offline, manager, "POST", "/reports/ask", { question: "  " })).statusCode).toBe(400);
  });
});
