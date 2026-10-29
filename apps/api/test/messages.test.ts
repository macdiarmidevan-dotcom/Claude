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

let n = 0;
async function booking(name: string, email: string) {
  const sheet = (await call(staff, "GET", `/tee-sheet?date=${today}`)).json();
  const teeTimeId = sheet.teeTimes.at(-1 - n++).id;
  return (await call(staff, "POST", "/bookings", { teeTimeId, holes: 9, customer: { name, email }, players: [{}, {}], source: "staff" })).json();
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

describe("golfer messaging", () => {
  it("messages everyone booked on a day, skipping who can't be reached", async () => {
    const a = await booking("Ann Lake", "ann@example.com");
    await booking("Bo Park", "teeitup-123@import.invalid");
    const golfer = (await call(staff, "POST", "/golfers", { name: "Ann Lake", email: "ann@example.com", phone: "630-555-0101" })).json();
    await call(staff, "PUT", `/bookings/${a.id}/golfer`, { golferId: golfer.id });

    const audience = { type: "date", date: today };
    const preview = (await call(staff, "POST", "/messages/preview", { audience, channels: ["email", "sms"] })).json();
    expect(preview).toMatchObject({ kind: "operational", golfers: 2, email: 1, unreachable: 1 });

    expect((await call(staff, "POST", "/messages", { audience, channels: ["email"], body: "Hi" })).json().error.code).toBe("subject_required");
    const sent = (
      await call(staff, "POST", "/messages", { audience, channels: ["email", "sms"], subject: "Frost delay at {course}", body: "Hi {first_name}, your {tee_time} start is pushed back." })
    ).json();
    expect(sent).toMatchObject({ golfers: 2, sent: 2, skipped: 2, sentBy: "Jordan Price" });
    const ann = sent.messages.filter((m: any) => m.name === "Ann Lake");
    expect(ann.map((m: any) => [m.channel, m.status, m.to])).toEqual([
      ["email", "sent", "ann@example.com"],
      ["sms", "sent", "+16305550101"],
    ]);
    expect(ann[0].subject).toBe("Frost delay at River Bend Golf Club");
    expect(ann[0].body).toMatch(/^Hi Ann, your \d{1,2}:\d{2} [AP]M start is pushed back\.$/);
    expect(sent.messages.filter((m: any) => m.name === "Bo Park").map((m: any) => m.reason)).toEqual(["No email address", "No mobile number"]);
    expect((await call(staff, "GET", `/golfers/${golfer.id}/messages`)).json()).toHaveLength(2);
  });

  it("leaves opted-out golfers off marketing, which only managers send", async () => {
    const golfers = (await call(staff, "GET", "/golfers?q=Ann")).json();
    await call(staff, "PATCH", `/golfers/${golfers[0].id}`, { emailOptOut: true });
    expect((await call(staff, "GET", `/golfers/${golfers[0].id}`)).json()).toMatchObject({ emailOptOut: true, smsOptOut: false });
    expect((await call(staff, "POST", "/messages", { audience: { type: "golfers" }, channels: ["email"], subject: "Spring sale", body: "20% off" })).json().error.code).toBe("manager_only");
    await call(manager, "PUT", "/settings/messaging", { signature: "See you on the course,\nRiver Bend" });
    const sent = (await call(manager, "POST", "/messages", { audience: { type: "golfers" }, channels: ["email", "sms"], subject: "Spring sale", body: "20% off" })).json();
    expect(sent.kind).toBe("marketing");
    expect(sent.messages.map((m: any) => [m.channel, m.status, m.reason])).toEqual([
      ["email", "skipped", "Opted out of email"],
      ["sms", "sent", null],
    ]);
    // The signature goes on email only.
    const one = (await call(manager, "POST", "/messages", { audience: { type: "golfer_list", golferIds: [golfers[0].id] }, channels: ["email", "sms"], subject: "Your clubs", body: "Left in cart 4" })).json();
    expect(one.kind).toBe("operational");
    expect(one.messages.map((m: any) => m.body)).toEqual(["Left in cart 4\n\nSee you on the course,\nRiver Bend", "Left in cart 4"]);
    expect((await call(staff, "GET", "/messages")).json().map((c: any) => c.audienceLabel)).toEqual(["Ann Lake", "All golfers with an account", expect.stringMatching(/^Everyone booked /)]);
  });
});
