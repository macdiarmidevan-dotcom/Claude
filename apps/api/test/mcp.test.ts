import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { buildApp } from "../src/app.ts";
import { seedRiverBend } from "../src/seed.ts";

process.env.NODE_ENV = "test";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let secretKey: string;
let managerKey: string;
const today = DateTime.now().setZone("America/Chicago").toISODate()!;
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

function rpc(key: string, method: string, params: object = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/courses/river-bend/mcp",
    headers: { ...auth(key), accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(name: string, args: object = {}) {
  const res = await rpc(managerKey, "tools/call", { name, arguments: args });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.result.isError).toBeFalsy();
  return JSON.parse(body.result.content[0].text);
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  ({ secretKey, managerKey } = await seedRiverBend(db));
  app = buildApp(db);

  // Two groups today: one paid and on the course, one booked and owing.
  const sheet = (await app.inject({ url: `/v1/courses/river-bend/tee-sheet?date=${today}`, headers: auth(secretKey) })).json();
  const at = (time: string) => sheet.teeTimes.find((t: { localTime: string }) => t.localTime === time).id;
  const book = async (time: string, name: string, players: number) =>
    (
      await app.inject({
        method: "POST",
        url: "/v1/courses/river-bend/bookings",
        headers: auth(secretKey),
        payload: { teeTimeId: at(time), holes: 9, customer: { name, email: `${name.split(" ")[0]}@example.com` }, players: Array(players).fill({}) },
      })
    ).json();
  const paid = await book("09:02", "Mike Sullivan", 2);
  await app.inject({ method: "POST", url: `/v1/courses/river-bend/bookings/${paid.id}/check-in`, headers: auth(secretKey), payload: { payment: { method: "card" } } });
  await app.inject({ method: "POST", url: `/v1/courses/river-bend/bookings/${paid.id}/tee-off`, headers: auth(secretKey), payload: {} });
  await book("09:10", "Tom Reyes", 3);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("AI assistant connector", () => {
  it("is for managers only", async () => {
    expect((await rpc(secretKey, "tools/list")).statusCode).toBe(403);
    expect((await rpc(managerKey, "tools/list")).statusCode).toBe(200);
  });

  it("lists read-only tools", async () => {
    const init = await rpc(managerKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.json().result.serverInfo.name).toBe("River Bend Golf Club tee sheet");
    const tools = (await rpc(managerKey, "tools/list")).json().result.tools;
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(["day_summary", "find_golfer", "list_groups", "revenue"]);
    expect(tools.every((t: { annotations?: { readOnlyHint?: boolean } }) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("answers how today is going", async () => {
    const summary = await callTool("day_summary");
    expect(summary).toMatchObject({ date: today, groups: 2, players: 5, playersOnCourse: 2, playersBooked: 3 });
    // Weekday or weekend rates depending on today; either way the paid group owes nothing.
    const owing = await callTool("list_groups", { filter: "unpaid" });
    expect(owing).toHaveLength(1);
    expect(owing[0]).toMatchObject({ teeTime: "09:10", name: "Tom Reyes", players: 3 });
    expect(summary.owedCents).toBe(owing[0].owedCents);
    expect(summary.collectedCents).toBe(summary.bookedCents - summary.owedCents);
  });

  it("finds a golfer and reports revenue", async () => {
    expect((await callTool("find_golfer", { name: "sulliv" }))[0]).toMatchObject({ name: "Mike Sullivan", status: "teed_off" });
    const money = await callTool("revenue", { from: today, to: today });
    expect(money.days).toHaveLength(1);
    expect(money.days[0].collectedBy.card).toBe(money.totalCollectedCents);
    expect(money.totalBookedCents).toBeGreaterThan(money.totalCollectedCents);
  });
});
