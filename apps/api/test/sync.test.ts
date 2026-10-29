import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { createPool, type Db } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { buildApp } from "../src/app.ts";
import { seedRiverBend } from "../src/seed.ts";
import { checkReportUrl, fetchReport, runDueSyncs } from "../src/sync.ts";

process.env.NODE_ENV = "test";
process.env.SYNC_SECRET = "test-secret";
const url = process.env.TEST_DATABASE_URL ?? "postgres://golf:golf@localhost:5432/golf_test";

let db: Db;
let app: FastifyInstance;
let secretKey: string;
let managerKey: string;
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const base = "/v1/courses/river-bend";

let day = DateTime.now().setZone("America/Chicago").plus({ weeks: 4 });
while (day.weekday !== 4) day = day.plus({ days: 1 });
const iso = day.toISODate()!;
const us = day.toFormat("M/d/yyyy");
const header = "Confirmation #,Tee Date,Tee Time,Golfer Name,# Players,Holes,Total,Paid Online,Status";

// What the provider's report link returns. Tests change it between syncs.
let report = "";
let fetched: string[] = [];
const fakeFetch = async (link: string) => {
  fetched.push(link);
  if (report === "down") throw new Error("The report link answered 503 Service Unavailable");
  return report;
};

const call = (method: "GET" | "PUT" | "POST" | "DELETE", path: string, payload?: object, key = managerKey) =>
  app.inject({ method, url: base + path, headers: auth(key), payload });

async function names() {
  const res = await app.inject({ url: `${base}/tee-sheet?date=${iso}`, headers: auth(secretKey) });
  return res.json().teeTimes.flatMap((t: { bookings: { customerName: string }[] }) => t.bookings.map((b) => b.customerName)).sort();
}

beforeAll(async () => {
  db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  ({ secretKey, managerKey } = await seedRiverBend(db));
  app = buildApp(db, { fetchReport: fakeFetch });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("tee sheet sync", () => {
  it("is for managers only and checks the link", async () => {
    expect((await call("GET", "/sync", undefined, secretKey)).statusCode).toBe(403);
    expect((await call("GET", "/sync")).json()).toBeNull();
    const plain = await call("PUT", "/sync", { source: "teeitup", method: "report_url", reportUrl: "http://example.com/sheet.csv" });
    expect(plain.json().error.code).toBe("invalid_url");
    const missing = await call("PUT", "/sync", { source: "teeitup", method: "report_url" });
    expect(missing.json().error.code).toBe("url_required");
  });

  it("pulls the report and imports it, then keeps it in step", async () => {
    const saved = await call("PUT", "/sync", { source: "teeitup", method: "report_url", reportUrl: "https://reports.example.com/river-bend.csv", intervalMinutes: 10 });
    expect(saved.json()).toMatchObject({ method: "report_url", enabled: true, intervalMinutes: 10, lastRunAt: null });

    report = [header, `TIU-1,${us},7:02 AM,Mike Sullivan,4,18,$116.00,,Confirmed`, `TIU-2,${us},7:10 AM,Dana Kowalski,2,9,,,Confirmed`].join("\n");
    const first = (await call("POST", "/sync/run")).json();
    expect(first.connection).toMatchObject({ lastStatus: "ok", lastMessage: "2 new, 0 changed, 0 cancelled" });
    expect(await names()).toEqual(["Dana Kowalski", "Mike Sullivan"]);

    // Dana cancelled on TeeItUp and someone new booked.
    report = [header, `TIU-1,${us},7:02 AM,Mike Sullivan,4,18,$116.00,,Confirmed`, `TIU-3,${us},7:26 AM,Tom Reyes,3,9,,,Confirmed`].join("\n");
    const second = (await call("POST", "/sync/run")).json();
    expect(second.result.counts).toMatchObject({ created: 1, cancelled: 1, unchanged: 1 });
    expect(await names()).toEqual(["Mike Sullivan", "Tom Reyes"]);

    const runs = (await call("GET", "/imports")).json();
    expect(runs[0]).toMatchObject({ via: "sync", fileName: "Automatic sync" });
  });

  it("records a failure without changing the tee sheet", async () => {
    report = "down";
    const res = (await call("POST", "/sync/run")).json();
    expect(res.connection).toMatchObject({ lastStatus: "error", lastMessage: "The report link answered 503 Service Unavailable" });
    report = "not,a,tee,sheet\n1,2,3,4";
    expect((await call("POST", "/sync/run")).json().connection.lastStatus).toBe("error");
    expect(await names()).toEqual(["Mike Sullivan", "Tom Reyes"]);
  });

  it("runs due syncs on schedule, once per interval", async () => {
    report = [header, `TIU-1,${us},7:02 AM,Mike Sullivan,4,18,$116.00,,Confirmed`].join("\n");
    await db.query("UPDATE sync_connections SET last_run_at = now() - interval '11 minutes'");
    fetched = [];
    expect(await runDueSyncs(db, fakeFetch)).toBe(1);
    expect(await runDueSyncs(db, fakeFetch)).toBe(0);
    expect(fetched).toHaveLength(1);
    expect(await names()).toEqual(["Mike Sullivan"]);

    await call("PUT", "/sync", { source: "teeitup", method: "report_url", reportUrl: "https://reports.example.com/river-bend.csv", enabled: false });
    await db.query("UPDATE sync_connections SET last_run_at = now() - interval '1 day'");
    expect(await runDueSyncs(db, fakeFetch)).toBe(0);
  });

  it("keeps provider sign-in details encrypted and says when API access is still missing", async () => {
    const saved = await call("PUT", "/sync", { source: "teeitup", method: "provider_api", credentials: { facilityId: "RB-123", apiKey: "secret-key-value" } });
    expect(saved.json()).toMatchObject({ method: "provider_api", hasCredentials: true });
    expect(JSON.stringify(saved.json())).not.toContain("secret-key-value");
    const { rows } = await db.query("SELECT credentials_enc FROM sync_connections");
    expect(rows[0].credentials_enc).not.toContain("secret-key-value");

    // Saving again without credentials keeps them.
    await call("PUT", "/sync", { source: "teeitup", method: "provider_api" });
    expect((await call("GET", "/sync")).json().hasCredentials).toBe(true);

    const run = (await call("POST", "/sync/run")).json();
    expect(run.connection.lastStatus).toBe("waiting");
    expect(run.connection.lastMessage).toMatch(/TeeItUp hasn't given this course API access/);

    expect((await call("DELETE", "/sync")).statusCode).toBe(200);
    expect((await call("GET", "/sync")).json()).toBeNull();
  });

  it("refuses links into private networks", async () => {
    expect(() => checkReportUrl("https://user:pw@example.com/x.csv")).toThrow(/sign-in details/);
    await expect(fetchReport("https://127.0.0.1/x.csv")).rejects.toThrow(/private network/);
    await expect(fetchReport("https://[::1]/x.csv")).rejects.toThrow(/private network/);
    await expect(fetchReport("https://10.1.2.3/x.csv")).rejects.toThrow(/private network/);
    await expect(fetchReport("https://169.254.169.254/latest")).rejects.toThrow(/private network/);
  });
});
