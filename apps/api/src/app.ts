import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import type { Db } from "./db.ts";
import { AppError, badRequest, notFound } from "./errors.ts";
import { lookupApiKey, type ApiKeyContext } from "./keys.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.ts";
import { importTeeSheet, listImports } from "./imports.ts";
import {
  actOnSwap,
  clockIn,
  clockOut,
  copyWeek,
  createShift,
  deleteShift,
  editPunch,
  getSchedulingSettings,
  listShifts,
  listSwaps,
  myClock,
  requestSwap,
  saveSchedulingSettings,
  timesheets,
  updateShift,
} from "./scheduling.ts";
import {
  changeStock,
  createProduct,
  createSale,
  getPosSettings,
  getSale,
  listProducts,
  listSales,
  productHistory,
  refundSale,
  savePosSettings,
  updateProduct,
} from "./pos.ts";
import { closeDay, getDayClose, report } from "./reports.ts";
import {
  cancelCardPayment,
  createTerminal,
  discoverReaders,
  getCardPayment,
  getPaymentSettings,
  handlePaymentWebhook,
  listCardPayments,
  listTerminals,
  refundCardPayment,
  savePaymentSettings,
  startCardPayment,
  updateTerminal,
} from "./payments.ts";
import { providers, type PaymentsFetch } from "./terminals.ts";
import {
  adjustPoints,
  cancelPass,
  createPassType,
  getLoyaltySettings,
  getWallet,
  listPassTypes,
  saveLoyaltySettings,
  sellPass,
  updatePassType,
} from "./passes.ts";
import {
  addEventDate,
  addEventPayment,
  addEventPlayer,
  autoPair,
  bookAhead,
  bookStandingForDate,
  cancelEventDate,
  createEvent,
  createStandingTime,
  getEvent,
  getEventDate,
  listEvents,
  listStandingTimes,
  removeEventPlayer,
  setCheckedIn,
  setPairing,
  setStandingTimeActive,
  updateEvent,
} from "./events.ts";
import { ACCOUNT_KEYS, exportJournal, getAccountingSettings, journal, saveAccountingSettings } from "./accounting.ts";
import {
  adjustAccount,
  adjustGiftCard,
  findGiftCard,
  getAccount,
  getGiftCard,
  getStatement,
  listAccounts,
  listGiftCards,
  openAccount,
  payAccount,
  runStatements,
  sellGiftCard,
  updateAccount,
} from "./accounts.ts";
import { addTabItems, closeTab, getTab, listTabs, openTab, prepTickets, renameTab, setItemStatus, voidTab, voidTabItem } from "./tabs.ts";
import { findRainCheck, getRainCheckDays, issueRainCheck, listRainChecks, refundRound, saveRainCheckDays, voidRainCheck } from "./rainchecks.ts";
import { deleteSync, getSync, runSync, saveSync, type FetchReport } from "./sync.ts";
import { createGolfer, getGolfer, linkGolfer, searchGolfers, updateGolfer } from "./golfers.ts";
import {
  changeOwnPassword,
  createEmployeeType,
  createStaff,
  listEmployeeTypes,
  updateEmployeeType,
  listActivity,
  listStaff,
  logActivity,
  login,
  logout,
  lookupSession,
  updateStaff,
  type StaffUser,
} from "./staff.ts";
import { dayRange, getAddOns, getCourseBySlug, getRates, getTeeSheet, type Course } from "./courses.ts";
import {
  createBooking,
  getBooking,
  listBookingsForDay,
  checkIn,
  getActiveWaiver,
  updateWaiver,
  moveBooking,
  addGuests,
  removePlayers,
  undoNoShow,
  recordPayment,
  setCartNumbers,
  teeOff,
  quote,
  setBookingStatus,
  updateTeeTime,
} from "./bookings.ts";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: ApiKeyContext;
    /** The signed-in employee or manager, when the request uses a session rather than a device key. */
    staff?: { user: StaffUser; sessionId: string };
  }
}

// What the activity log calls each change, by route.
const ACTIONS: Record<string, string> = {
  "POST /v1/courses/:slug/bookings": "Added a booking",
  "POST /v1/courses/:slug/bookings/:id/check-in": "Checked in at the pro shop",
  "POST /v1/courses/:slug/bookings/:id/tee-off": "Sent off the first tee",
  "POST /v1/courses/:slug/bookings/:id/payments": "Took a payment",
  "PUT /v1/courses/:slug/bookings/:id/carts": "Changed carts",
  "POST /v1/courses/:slug/bookings/:id/move": "Moved a booking",
  "POST /v1/courses/:slug/bookings/:id/guests": "Added guests to a group",
  "POST /v1/courses/:slug/bookings/:id/remove-players": "Removed players from a group",
  "POST /v1/courses/:slug/bookings/:id/cancel": "Cancelled a booking",
  "POST /v1/courses/:slug/bookings/:id/undo-no-show": "Undid a no-show",
  "POST /v1/courses/:slug/bookings/:id/no-show": "Marked a no-show",
  "PATCH /v1/courses/:slug/tee-times/:id": "Changed a tee time",
  "PUT /v1/courses/:slug/waiver": "Changed the cart waiver",
  "POST /v1/courses/:slug/imports": "Imported the tee sheet",
  "POST /v1/courses/:slug/staff": "Added a staff account",
  "POST /v1/courses/:slug/golfers": "Created a golfer account",
  "PUT /v1/courses/:slug/sync": "Changed tee sheet sync",
  "DELETE /v1/courses/:slug/sync": "Turned off tee sheet sync",
  "POST /v1/courses/:slug/sync/run": "Synced the tee sheet",
  "PATCH /v1/courses/:slug/golfers/:id": "Changed a golfer account",
  "PUT /v1/courses/:slug/bookings/:id/golfer": "Linked a golfer account",
  "PATCH /v1/courses/:slug/staff/:id": "Changed a staff account",
  "POST /v1/courses/:slug/employee-types": "Added an employee type",
  "POST /v1/courses/:slug/shifts": "Added a shift",
  "PATCH /v1/courses/:slug/shifts/:id": "Changed a shift",
  "DELETE /v1/courses/:slug/shifts/:id": "Removed a shift",
  "POST /v1/courses/:slug/shifts/copy-week": "Copied a week of shifts",
  "POST /v1/courses/:slug/clock/in": "Clocked in",
  "POST /v1/courses/:slug/clock/out": "Clocked out",
  "PATCH /v1/courses/:slug/punches/:id": "Corrected a time punch",
  "POST /v1/courses/:slug/swaps": "Asked to swap a shift",
  "POST /v1/courses/:slug/swaps/:id/:action": "Answered a shift swap",
  "PUT /v1/courses/:slug/settings/scheduling": "Changed scheduling settings",
  "POST /v1/courses/:slug/products": "Added a product",
  "PATCH /v1/courses/:slug/products/:id": "Changed a product",
  "POST /v1/courses/:slug/products/:id/stock": "Changed stock",
  "POST /v1/courses/:slug/sales": "Made a sale",
  "POST /v1/courses/:slug/sales/:id/refund": "Refunded a sale",
  "PUT /v1/courses/:slug/settings/pos": "Changed sales tax",
  "PUT /v1/courses/:slug/closes/:date": "Closed the day",
  "PUT /v1/courses/:slug/settings/payments": "Changed card payment settings",
  "POST /v1/courses/:slug/terminals": "Added a card reader",
  "PATCH /v1/courses/:slug/terminals/:id": "Changed a card reader",
  "POST /v1/courses/:slug/card-payments/:id/refund": "Refunded a card payment",
  "POST /v1/courses/:slug/pass-types": "Added a pass type",
  "PATCH /v1/courses/:slug/pass-types/:id": "Changed a pass type",
  "PUT /v1/courses/:slug/settings/loyalty": "Changed loyalty points",
  "POST /v1/courses/:slug/golfers/:id/passes": "Sold a pass",
  "POST /v1/courses/:slug/golfers/:id/passes/:passId/cancel": "Cancelled a pass",
  "POST /v1/courses/:slug/golfers/:id/points": "Adjusted loyalty points",
  "POST /v1/courses/:slug/bookings/:id/rain-checks": "Issued a rain check",
  "POST /v1/courses/:slug/rain-checks/:id/void": "Voided a rain check",
  "POST /v1/courses/:slug/bookings/:id/refund": "Refunded a round",
  "PUT /v1/courses/:slug/settings/rain-checks": "Changed rain check settings",
  "POST /v1/courses/:slug/standing-times": "Added a standing tee time",
  "PATCH /v1/courses/:slug/standing-times/:id": "Changed a standing tee time",
  "POST /v1/courses/:slug/events": "Added a league or outing",
  "PATCH /v1/courses/:slug/events/:id": "Changed a league or outing",
  "POST /v1/courses/:slug/events/:id/dates": "Added an event date",
  "POST /v1/courses/:slug/event-dates/:id/cancel": "Cancelled an event date",
  "POST /v1/courses/:slug/events/:id/players": "Added a player to an event",
  "DELETE /v1/courses/:slug/events/:id/players/:playerId": "Removed a player from an event",
  "POST /v1/courses/:slug/event-dates/:id/pairings/auto": "Paired an event",
  "PUT /v1/courses/:slug/event-dates/:id/pairings/:playerId": "Moved a player between groups",
  "POST /v1/courses/:slug/event-dates/:id/check-in": "Checked in event players",
  "POST /v1/courses/:slug/events/:id/payments": "Took an event payment",
  "PATCH /v1/courses/:slug/employee-types/:id": "Changed an employee type",
  "POST /v1/courses/:slug/tabs": "Opened a tab",
  "POST /v1/courses/:slug/tabs/:id/close": "Closed a tab",
  "POST /v1/courses/:slug/tabs/:id/void": "Voided a tab",
  "DELETE /v1/courses/:slug/tabs/:id/items/:itemId": "Took an item off a tab",
  "POST /v1/courses/:slug/gift-cards": "Sold a gift card",
  "POST /v1/courses/:slug/gift-cards/:id/adjust": "Changed a gift card",
  "POST /v1/courses/:slug/house-accounts": "Opened a house account",
  "PATCH /v1/courses/:slug/house-accounts/:id": "Changed a house account",
  "POST /v1/courses/:slug/house-accounts/:id/payments": "Took a house account payment",
  "POST /v1/courses/:slug/house-accounts/:id/adjust": "Adjusted a house account",
  "POST /v1/courses/:slug/house-accounts/statements": "Made house account statements",
  "PUT /v1/courses/:slug/settings/accounting": "Changed accounting settings",
  "POST /v1/courses/:slug/accounting/export": "Exported to accounting",
};

const player = z.object({
  residency: z.enum(["resident", "nonresident"]).default("nonresident"),
  ageGroup: z.enum(["adult", "senior", "junior"]).default("adult"),
});
const addOn = z.object({ code: z.string(), quantity: z.number().int().min(0).max(8) });
const removePlayersBody = z.object({ count: z.number().int().min(1).max(7) });

const guestsBody = z.object({
  count: z.number().int().min(1).max(7),
  riding: z.boolean().default(false),
  residency: z.enum(["resident", "nonresident"]).optional(),
});
const quoteBody = z.object({
  teeTimeId: z.uuid(),
  holes: z.number().int().positive(),
  players: z.array(player).min(1).max(8),
  addOns: z.array(addOn).default([]),
});
const bookingBody = quoteBody.extend({
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.email(),
    phone: z.string().max(40).optional(),
  }),
  source: z.enum(["staff", "teeitup", "golfnow", "phone"]).optional(),
  notes: z.string().max(1000).optional(),
});
const dateQuery = z.object({ date: z.string() });
const teeTimePatch = z.object({
  status: z.enum(["open", "blocked"]).optional(),
  note: z.string().max(500).nullable().optional(),
});
const moveBody = z.object({ teeTimeId: z.uuid() });
const cartNumbers = z.array(z.string().trim().min(1).max(10)).max(8);
const waiverSignature = z.object({
  cartNumber: z.string().trim().min(1).max(10),
  driverName: z.string().trim().min(1).max(200),
  // SVG path data: move/line/curve commands and numbers only.
  signature: z
    .string()
    .min(10)
    .max(50_000)
    .regex(/^[MLQCZmlqcz0-9.,\s-]+$/, "signature must be SVG path data"),
});
const waivers = z.array(waiverSignature).max(8).optional();
const paymentMethod = z.enum(["card", "cash", "prepaid", "punch_card", "season_pass", "loyalty", "rain_check", "gift_card", "house_account", "comp"]);
const saleLine = z.union([
  z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(999) }),
  z.object({ description: z.string().max(200), unitCents: z.number().int().min(0).max(10_000_000), quantity: z.number().int().min(1).max(999), taxable: z.boolean().optional() }),
]);
const salePaymentMethod = z.enum(["card", "cash", "gift_card", "house_account", "comp"]);
const giftCardCode = z.string().trim().min(6).max(20);
const checkInBody = z.object({
  cartNumbers: cartNumbers.optional(),
  waivers,
  payment: z.object({ method: paymentMethod }).optional(),
  items: z.object({ lines: z.array(saleLine).max(100), paymentMethod: salePaymentMethod, giftCardCode: giftCardCode.optional() }).optional(),
  round: z.object({ residency: z.enum(["resident", "nonresident"]), riding: z.boolean() }).optional(),
  cardPaymentId: z.uuid().optional(),
  pass: z.object({ golferPassId: z.uuid(), rounds: z.number().int().min(1).max(8) }).optional(),
  points: z.number().int().positive().max(10_000_000).optional(),
  rainCheck: z.string().trim().min(4).max(20).optional(),
  /** A gift card put toward the round; anything it doesn't cover is paid the usual way. */
  giftCard: giftCardCode.optional(),
});
const teeOffBody = z.object({ cartNumbers: cartNumbers.optional(), waivers });
const cartsBody = z.object({ cartNumbers, waivers });
const waiverBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(20).max(50_000),
});
const importBody = z.object({
  source: z.enum(["teeitup", "golfnow", "import"]),
  csv: z.string().min(1).max(5_000_000),
  fileName: z.string().max(200).optional(),
  dryRun: z.boolean().optional(),
});
const loginBody = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });
const role = z.enum(["staff", "manager"]);
const newStaffBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email(),
  role,
  password: z.string().max(200),
  employeeTypeId: z.uuid().nullish(),
});
const staffPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: role.optional(),
  active: z.boolean().optional(),
  password: z.string().max(200).optional(),
  employeeTypeId: z.uuid().nullable().optional(),
});
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const shiftBody = z.object({
  staffUserId: z.uuid().nullish(),
  employeeTypeId: z.uuid().nullish(),
  date: z.iso.date(),
  start: hhmm,
  end: hhmm,
  note: z.string().max(500).nullish(),
});
const rangeQuery = z.object({ from: z.iso.date(), to: z.iso.date() });
const typeBody = z.object({ name: z.string().trim().min(1).max(60) });
const typePatch = z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() });
const golferBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(40),
  bookingId: z.uuid().optional(),
});
const golferPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
});
const syncBody = z.object({
  source: z.enum(["teeitup", "golfnow", "import"]),
  method: z.enum(["report_url", "provider_api"]),
  reportUrl: z.string().trim().max(2000).nullish(),
  credentials: z.record(z.string().max(100), z.string().max(2000)).nullish(),
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(5).max(1440).default(10),
});
const passwordBody = z.object({ current: z.string().max(200), next: z.string().max(200) });
const paymentBody = z.object({ amountCents: z.number().int().positive(), method: paymentMethod });
const idParams = z.object({ slug: z.string(), id: z.uuid() });
const slugParams = z.object({ slug: z.string() });

export function buildApp(db: Db, opts: { fetchReport?: FetchReport; paymentsFetch?: PaymentsFetch } = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const processors = providers(opts.paymentsFetch);

  // The staff web app calls the API from the browser. Auth is by API key, not cookies,
  // so allowing any origin doesn't expose anything.
  app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"] });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "invalid_request", message: "Invalid request", issues: err.issues } });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: "invalid_request", message: (err as Error).message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
  });

  app.get("/health", async () => ({ ok: true }));

  // Every /v1 route needs a signed-in employee (st_ session) or a staff device key (sk_), apart
  // from signing in. Golfers don't book through this API: they book with the course's
  // existing provider and those bookings are imported.
  app.addHook("onRequest", async (req) => {
    // Processors' webhooks prove themselves with a signature instead.
    if (!req.url.startsWith("/v1/") || req.routeOptions.url === "/v1/courses/:slug/login" || req.url.startsWith("/v1/webhooks/")) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (token?.startsWith("st_")) {
      const session = await lookupSession(db, token);
      if (!session) throw new AppError(401, "unauthorized", "Your sign-in has expired. Please sign in again");
      req.staff = { user: session.user, sessionId: session.sessionId };
      req.apiKey = { keyId: session.sessionId, courseId: session.courseId, kind: "secret", role: session.user.role };
      return;
    }
    const ctx = token ? await lookupApiKey(db, token) : undefined;
    if (!ctx) throw new AppError(401, "unauthorized", "A valid API key is required");
    req.apiKey = ctx;
  });

  // Record who made each change. Signatures, files and passwords are never copied into the log.
  app.addHook("onResponse", async (req, reply) => {
    const action = ACTIONS[`${req.method} ${req.routeOptions.url}`];
    if (!action || reply.statusCode >= 300 || !req.apiKey) return;
    const body = (req.body ?? {}) as Record<string, any>;
    if (action === "Imported the tee sheet" && body.dryRun) return;
    const params = req.params as { id?: string };
    const detail: Record<string, unknown> = {};
    for (const k of ["method", "amountCents", "cartNumbers", "status", "note", "teeTimeId", "source", "fileName", "name", "role", "active", "golferId"]) {
      if (body[k] !== undefined) detail[k] = body[k];
    }
    if (body.payment?.method) detail.method = body.payment.method;
    if (body.password !== undefined && req.routeOptions.url?.includes("/staff")) detail.passwordReset = true;
    const bookingId = req.routeOptions.url?.includes("/bookings/:id") ? params.id : typeof body.bookingId === "string" ? body.bookingId : undefined;
    await logActivity(db, {
      courseId: req.apiKey.courseId,
      userId: req.staff?.user.id,
      actor: req.staff?.user.name ?? "Shared device key",
      action,
      bookingId,
      detail,
    }).catch((err) => app.log.error(err));
  });

  /** Loads the course in the URL and checks the API key is a staff key for it. */
  async function courseFor(req: FastifyRequest): Promise<Course> {
    const { slug } = slugParams.parse(req.params);
    const course = await getCourseBySlug(db, slug).catch(() => undefined);
    // A key for another course gets the same 404 as a missing course.
    if (!course || course.id !== req.apiKey!.courseId) throw notFound("Course");
    if (req.apiKey!.kind !== "secret") throw new AppError(403, "forbidden", "This API needs a staff (sk_) key");
    return course;
  }

  /** Like courseFor, but only a manager's key may make the change. */
  async function managedCourseFor(req: FastifyRequest): Promise<Course> {
    const course = await courseFor(req);
    if (req.apiKey!.role !== "manager") throw new AppError(403, "manager_only", "Only a manager can change this");
    return course;
  }

  // Signing in. A device key isn't needed: the email and password are the credentials.
  app.post("/v1/courses/:slug/login", async (req) => {
    const { slug } = slugParams.parse(req.params);
    const course = await getCourseBySlug(db, slug).catch(() => undefined);
    if (!course) throw notFound("Course");
    const { email, password } = loginBody.parse(req.body);
    return login(db, course.id, email, password);
  });

  app.post("/v1/courses/:slug/logout", async (req) => {
    await courseFor(req);
    if (req.staff) await logout(db, req.staff.sessionId);
    return { ok: true };
  });

  // Who is signed in and what they may do, so the app only shows manager tools to managers.
  app.get("/v1/courses/:slug/me", async (req) => {
    await courseFor(req);
    return { role: req.apiKey!.role, user: req.staff?.user ?? null };
  });

  app.put("/v1/courses/:slug/me/password", async (req) => {
    await courseFor(req);
    if (!req.staff) throw badRequest("no_account", "Device keys don't have a password");
    const { current, next } = passwordBody.parse(req.body);
    await changeOwnPassword(db, req.staff.user, req.staff.sessionId, current, next);
    return { ok: true };
  });

  // Staff accounts: managers add people, change roles, reset passwords and turn accounts off.
  app.get("/v1/courses/:slug/staff", async (req) => listStaff(db, (await managedCourseFor(req)).id));
  app.post("/v1/courses/:slug/staff", async (req, reply) => {
    const course = await managedCourseFor(req);
    return reply.status(201).send(await createStaff(db, course.id, newStaffBody.parse(req.body)));
  });
  app.patch("/v1/courses/:slug/staff/:id", async (req) => {
    const course = await managedCourseFor(req);
    const { id } = idParams.parse(req.params);
    return updateStaff(db, course.id, req.staff?.user.id, id, staffPatch.parse(req.body));
  });

  // Golfer accounts: created at a golfer's first check-in, then found by name.
  app.get("/v1/courses/:slug/golfers", async (req) => {
    const course = await courseFor(req);
    const { q } = z.object({ q: z.string().max(200).default("") }).parse(req.query);
    return searchGolfers(db, course, q);
  });
  app.post("/v1/courses/:slug/golfers", async (req, reply) => {
    const course = await courseFor(req);
    return reply.status(201).send(await createGolfer(db, course, req.staff?.user.id, golferBody.parse(req.body)));
  });
  app.get("/v1/courses/:slug/golfers/:id", async (req) => {
    const course = await courseFor(req);
    return getGolfer(db, course, idParams.parse(req.params).id);
  });
  app.patch("/v1/courses/:slug/golfers/:id", async (req) => {
    const course = await courseFor(req);
    return updateGolfer(db, course, idParams.parse(req.params).id, golferPatch.parse(req.body));
  });
  app.put("/v1/courses/:slug/bookings/:id/golfer", async (req) => {
    const course = await courseFor(req);
    const { golferId } = z.object({ golferId: z.uuid() }).parse(req.body);
    return linkGolfer(db, course, idParams.parse(req.params).id, golferId);
  });

  // Automatic tee sheet sync with the course's booking provider. Managers only.
  app.get("/v1/courses/:slug/sync", async (req) => getSync(db, await managedCourseFor(req)));
  app.put("/v1/courses/:slug/sync", async (req) => saveSync(db, await managedCourseFor(req), syncBody.parse(req.body)));
  app.delete("/v1/courses/:slug/sync", async (req) => {
    await deleteSync(db, await managedCourseFor(req));
    return { ok: true };
  });
  app.post("/v1/courses/:slug/sync/run", async (req) => runSync(db, await managedCourseFor(req), opts.fetchReport));

  // Employee types (Pro Shop, Cart Attendant, ...). Managers add their own, rename and remove them.
  app.get("/v1/courses/:slug/employee-types", async (req) => listEmployeeTypes(db, (await managedCourseFor(req)).id));
  app.post("/v1/courses/:slug/employee-types", async (req, reply) => {
    const course = await managedCourseFor(req);
    return reply.status(201).send(await createEmployeeType(db, course.id, typeBody.parse(req.body).name));
  });
  app.patch("/v1/courses/:slug/employee-types/:id", async (req) => {
    const course = await managedCourseFor(req);
    return updateEmployeeType(db, course.id, idParams.parse(req.params).id, typePatch.parse(req.body));
  });

  // Staff scheduling. Everyone sees the schedule; managers build it.
  const signedIn = (req: { staff?: { user: StaffUser } }) => {
    if (!req.staff) throw badRequest("no_account", "Sign in with your own account to use the time clock and swaps");
    return req.staff.user;
  };
  app.get("/v1/courses/:slug/shifts", async (req) => {
    const course = await courseFor(req);
    const { from, to } = rangeQuery.parse(req.query);
    return listShifts(db, course, from, to);
  });
  app.post("/v1/courses/:slug/shifts", async (req, reply) => {
    const course = await managedCourseFor(req);
    return reply.status(201).send(await createShift(db, course, shiftBody.parse(req.body)));
  });
  app.patch("/v1/courses/:slug/shifts/:id", async (req) => {
    const course = await managedCourseFor(req);
    return updateShift(db, course, idParams.parse(req.params).id, shiftBody.partial().parse(req.body));
  });
  app.delete("/v1/courses/:slug/shifts/:id", async (req) => {
    const course = await managedCourseFor(req);
    await deleteShift(db, course, idParams.parse(req.params).id);
    return { ok: true };
  });
  app.post("/v1/courses/:slug/shifts/copy-week", async (req) => {
    const course = await managedCourseFor(req);
    const { from, to } = rangeQuery.parse(req.body);
    return copyWeek(db, course, from, to);
  });

  app.get("/v1/courses/:slug/clock", async (req) => myClock(db, await courseFor(req), signedIn(req)));
  app.post("/v1/courses/:slug/clock/in", async (req) => {
    const course = await courseFor(req);
    return clockIn(db, course, signedIn(req));
  });
  app.post("/v1/courses/:slug/clock/out", async (req) => {
    const course = await courseFor(req);
    return clockOut(db, course, signedIn(req));
  });
  app.get("/v1/courses/:slug/timesheets", async (req) => {
    const course = await managedCourseFor(req);
    const { from, to } = rangeQuery.parse(req.query);
    return timesheets(db, course, from, to);
  });
  app.patch("/v1/courses/:slug/punches/:id", async (req) => {
    const course = await managedCourseFor(req);
    const patch = z.object({ clockIn: z.iso.datetime({ offset: true }).optional(), clockOut: z.iso.datetime({ offset: true }).nullable().optional() }).parse(req.body);
    return editPunch(db, course, req.staff?.user.id, idParams.parse(req.params).id, patch);
  });

  app.get("/v1/courses/:slug/swaps", async (req) => {
    const course = await courseFor(req);
    return listSwaps(db, course, req.staff?.user, req.apiKey!.role === "manager");
  });
  app.post("/v1/courses/:slug/swaps", async (req, reply) => {
    const course = await courseFor(req);
    const body = z
      .object({ offeredShiftId: z.uuid(), toUserId: z.uuid(), requestedShiftId: z.uuid().nullish(), message: z.string().max(500).nullish() })
      .parse(req.body);
    return reply.status(201).send(await requestSwap(db, course, signedIn(req), body));
  });
  app.post("/v1/courses/:slug/swaps/:id/:action", async (req) => {
    const course = await courseFor(req);
    const { id, action } = z.object({ id: z.uuid(), action: z.enum(["accept", "decline", "approve", "reject", "cancel"]) }).parse(req.params);
    return actOnSwap(db, course, req.staff?.user, req.apiKey!.role === "manager", id, action);
  });
  // Coworkers to swap with: everyone signed in can see who works here, but not their emails.
  app.get("/v1/courses/:slug/coworkers", async (req) => {
    const course = await courseFor(req);
    const { rows } = await db.query(
      `SELECT u.id, u.name, et.name AS type FROM staff_users u LEFT JOIN employee_types et ON et.id = u.employee_type_id
        WHERE u.course_id = $1 AND u.active ORDER BY lower(u.name)`,
      [course.id],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, employeeType: r.type }));
  });

  app.get("/v1/courses/:slug/settings/scheduling", async (req) => getSchedulingSettings(db, await courseFor(req)));
  app.put("/v1/courses/:slug/settings/scheduling", async (req) => {
    const course = await managedCourseFor(req);
    return saveSchedulingSettings(db, course, z.object({ swapsNeedApproval: z.boolean() }).parse(req.body));
  });

  // Pro shop: products, stock and the register. Anyone can sell and receive deliveries;
  // managers set prices, count and adjust stock, and refund.
  const money = z.number().int().min(0).max(10_000_000);
  const productBody = z.object({
    name: z.string().trim().min(1).max(200),
    sku: z.string().trim().max(60).nullish(),
    category: z.string().trim().max(60).optional(),
    priceCents: money,
    costCents: money.nullish(),
    taxable: z.boolean().optional(),
    trackStock: z.boolean().optional(),
    reorderLevel: z.number().int().min(0).max(100_000).optional(),
    stock: z.number().int().min(0).max(100_000).optional(),
    foodBev: z.boolean().optional(),
    station: z.enum(["kitchen", "bar"]).nullish(),
  });
  app.get("/v1/courses/:slug/products", async (req) => {
    const course = await courseFor(req);
    const { q, all } = z.object({ q: z.string().max(100).optional(), all: z.enum(["1", "0"]).optional() }).parse(req.query);
    return listProducts(db, course, { q, includeInactive: all === "1" });
  });
  app.post("/v1/courses/:slug/products", async (req, reply) => {
    const course = await managedCourseFor(req);
    return reply.status(201).send(await createProduct(db, course, req.staff?.user.id, productBody.parse(req.body)));
  });
  app.patch("/v1/courses/:slug/products/:id", async (req) => {
    const course = await managedCourseFor(req);
    const patch = productBody.omit({ stock: true }).partial().extend({ active: z.boolean().optional() }).parse(req.body);
    return updateProduct(db, course, idParams.parse(req.params).id, patch);
  });
  app.get("/v1/courses/:slug/products/:id/history", async (req) => productHistory(db, await courseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/products/:id/stock", async (req) => {
    const body = z
      .object({ kind: z.enum(["receive", "count", "adjust"]), quantity: z.number().int().min(-100_000).max(100_000), note: z.string().max(300).nullish() })
      .parse(req.body);
    const course = body.kind === "receive" ? await courseFor(req) : await managedCourseFor(req);
    return changeStock(db, course, req.staff?.user.id, idParams.parse(req.params).id, body);
  });
  app.post("/v1/courses/:slug/sales", async (req, reply) => {
    const course = await courseFor(req);
    const body = z
      .object({ lines: z.array(saleLine).max(100), paymentMethod: salePaymentMethod, golferId: z.uuid().nullish(), cardPaymentId: z.uuid().nullish(), giftCardCode: giftCardCode.nullish() })
      .parse(req.body);
    return reply.status(201).send(await createSale(db, course, req.staff?.user.id, body));
  });
  app.get("/v1/courses/:slug/sales", async (req) => {
    const course = await courseFor(req);
    return listSales(db, course, z.object({ date: z.iso.date() }).parse(req.query).date);
  });
  app.get("/v1/courses/:slug/sales/:id", async (req) => getSale(db, await courseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/sales/:id/refund", async (req) => {
    const course = await managedCourseFor(req);
    return refundSale(db, course, req.staff?.user.id, idParams.parse(req.params).id, (client, cardPaymentId, cents) =>
      refundCardPayment(client, course, processors, cardPaymentId, cents),
    );
  });
  app.get("/v1/courses/:slug/settings/pos", async (req) => getPosSettings(db, await courseFor(req)));
  app.put("/v1/courses/:slug/settings/pos", async (req) => {
    const course = await managedCourseFor(req);
    return savePosSettings(db, course, z.object({ salesTaxBps: z.number().int().min(0).max(2000) }).parse(req.body));
  });

  // Reports are for managers; anyone can close the day by counting the drawer.
  app.get("/v1/courses/:slug/reports", async (req) => {
    const course = await managedCourseFor(req);
    const { from, to } = rangeQuery.parse(req.query);
    return report(db, course, from, to);
  });
  const dateParams = z.object({ date: z.iso.date() });
  app.get("/v1/courses/:slug/closes/:date", async (req) => getDayClose(db, await courseFor(req), dateParams.parse(req.params).date));
  app.put("/v1/courses/:slug/closes/:date", async (req) => {
    const course = await courseFor(req);
    const body = z.object({ countedCashCents: z.number().int().min(0).max(100_000_000), note: z.string().max(500).nullish() }).parse(req.body);
    return closeDay(db, course, { id: req.staff?.user.id, isManager: req.apiKey!.role === "manager" }, dateParams.parse(req.params).date, body);
  });

  app.get("/v1/courses/:slug/activity", async (req) => listActivity(db, (await managedCourseFor(req)).id));

  // Card readers. Everyone can see how cards are taken and use the readers; managers connect
  // the processor, add readers and refund.
  app.get("/v1/courses/:slug/settings/payments", async (req) => getPaymentSettings(db, await courseFor(req), processors));
  app.put("/v1/courses/:slug/settings/payments", async (req) => {
    const course = await managedCourseFor(req);
    const body = z
      .object({
        provider: z.string().max(40),
        account: z.record(z.string().max(60), z.string().max(500)).optional(),
        credentials: z.record(z.string().max(60), z.string().max(2000)).optional(),
        tipping: z.boolean().optional(),
      })
      .parse(req.body);
    return savePaymentSettings(db, course, processors, body);
  });
  app.get("/v1/courses/:slug/settings/payments/readers", async (req) => discoverReaders(db, await managedCourseFor(req), processors));
  app.get("/v1/courses/:slug/terminals", async (req) => listTerminals(db, await courseFor(req), processors));
  const terminalBody = z.object({ name: z.string().trim().min(1).max(80), readerId: z.string().trim().min(1).max(200), location: z.string().trim().max(80).nullish() });
  app.post("/v1/courses/:slug/terminals", async (req, reply) => {
    const course = await managedCourseFor(req);
    return reply.status(201).send(await createTerminal(db, course, processors, terminalBody.parse(req.body)));
  });
  app.patch("/v1/courses/:slug/terminals/:id", async (req) => {
    const course = await managedCourseFor(req);
    const patch = z.object({ name: z.string().trim().min(1).max(80).optional(), location: z.string().trim().max(80).nullish(), active: z.boolean().optional() }).parse(req.body);
    return updateTerminal(db, course, idParams.parse(req.params).id, patch);
  });
  app.post("/v1/courses/:slug/card-payments", async (req, reply) => {
    const course = await courseFor(req);
    const body = z.object({ terminalId: z.uuid(), amountCents: z.number().int().positive().max(10_000_000), description: z.string().trim().max(200).optional() }).parse(req.body);
    return reply.status(201).send(await startCardPayment(db, course, processors, req.staff?.user.id, { ...body, description: body.description || course.name }));
  });
  app.get("/v1/courses/:slug/card-payments", async (req) => {
    const course = await managedCourseFor(req);
    const { date } = z.object({ date: z.iso.date() }).parse(req.query);
    const { start, end } = dayRange(course, date);
    return listCardPayments(db, course, start.toJSDate(), end.toJSDate());
  });
  app.get("/v1/courses/:slug/card-payments/:id", async (req) => getCardPayment(db, await courseFor(req), processors, idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/card-payments/:id/cancel", async (req) =>
    cancelCardPayment(db, await courseFor(req), processors, idParams.parse(req.params).id),
  );
  app.post("/v1/courses/:slug/card-payments/:id/refund", async (req) => {
    const course = await managedCourseFor(req);
    const { amountCents } = z.object({ amountCents: z.number().int().positive().optional() }).parse(req.body ?? {});
    return refundCardPayment(db, course, processors, idParams.parse(req.params).id, amountCents);
  });

  // Punch cards, season passes and loyalty points. Managers set them up; anyone sells and uses them.
  const passTypeBody = z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["punch_card", "season_pass"]),
    priceCents: z.number().int().min(0).max(10_000_000),
    rounds: z.number().int().min(1).max(500).nullish(),
    validDays: z.number().int().min(1).max(3660).nullish(),
    coversCart: z.boolean().optional(),
  });
  app.get("/v1/courses/:slug/pass-types", async (req) => listPassTypes(db, await courseFor(req)));
  app.post("/v1/courses/:slug/pass-types", async (req, reply) => {
    const course = await managedCourseFor(req);
    return reply.status(201).send(await createPassType(db, course, passTypeBody.parse(req.body)));
  });
  app.patch("/v1/courses/:slug/pass-types/:id", async (req) => {
    const course = await managedCourseFor(req);
    const patch = passTypeBody.omit({ kind: true }).partial().extend({ active: z.boolean().optional() }).parse(req.body);
    return updatePassType(db, course, idParams.parse(req.params).id, patch);
  });
  app.get("/v1/courses/:slug/settings/loyalty", async (req) => getLoyaltySettings(db, await courseFor(req)));
  app.put("/v1/courses/:slug/settings/loyalty", async (req) => {
    const course = await managedCourseFor(req);
    const body = z
      .object({ pointsPerDollar: z.number().int().min(0).max(100), rewardPoints: z.number().int().min(1).max(1_000_000), rewardCents: z.number().int().min(0).max(1_000_000) })
      .parse(req.body);
    return saveLoyaltySettings(db, course, body);
  });
  app.get("/v1/courses/:slug/golfers/:id/wallet", async (req) => getWallet(db, await courseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/golfers/:id/passes", async (req, reply) => {
    const course = await courseFor(req);
    const body = z.object({ passTypeId: z.uuid(), paymentMethod: salePaymentMethod, cardPaymentId: z.uuid().nullish() }).parse(req.body);
    return reply.status(201).send(await sellPass(db, course, req.staff?.user.id, idParams.parse(req.params).id, body));
  });
  app.post("/v1/courses/:slug/golfers/:id/passes/:passId/cancel", async (req) => {
    const course = await managedCourseFor(req);
    const { id, passId } = z.object({ slug: z.string(), id: z.uuid(), passId: z.uuid() }).parse(req.params);
    return cancelPass(db, course, id, passId);
  });
  app.post("/v1/courses/:slug/golfers/:id/points", async (req) => {
    const course = await managedCourseFor(req);
    const { change, note } = z.object({ change: z.number().int().min(-1_000_000).max(1_000_000), note: z.string().max(300) }).parse(req.body);
    return adjustPoints(db, course, req.staff?.user.id, idParams.parse(req.params).id, change, note);
  });

  // Rain checks and refunds on rounds cut short. Anyone can issue a rain check; setting its amount
  // by hand, voiding one and giving money back are for managers.
  app.post("/v1/courses/:slug/bookings/:id/rain-checks", async (req, reply) => {
    const body = z
      .object({
        players: z.number().int().min(1).max(8),
        holesPlayed: z.number().int().min(0).max(72),
        includeCart: z.boolean().optional(),
        amountCents: z.number().int().positive().max(10_000_000).optional(),
        note: z.string().max(300).nullish(),
      })
      .parse(req.body);
    const course = body.amountCents !== undefined ? await managedCourseFor(req) : await courseFor(req);
    return reply.status(201).send(await issueRainCheck(db, course, req.staff?.user.id, idParams.parse(req.params).id, body));
  });
  app.get("/v1/courses/:slug/bookings/:id/rain-checks", async (req) => listRainChecks(db, await courseFor(req), { bookingId: idParams.parse(req.params).id }));
  app.get("/v1/courses/:slug/rain-checks/:code", async (req) => {
    const { code } = z.object({ slug: z.string(), code: z.string().trim().min(4).max(20) }).parse(req.params);
    return findRainCheck(db, await courseFor(req), code);
  });
  app.post("/v1/courses/:slug/rain-checks/:id/void", async (req) => voidRainCheck(db, await managedCourseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/bookings/:id/refund", async (req) => {
    const course = await managedCourseFor(req);
    const body = z.object({ amountCents: z.number().int().positive().max(10_000_000), method: z.enum(["cash", "card"]), reason: z.string().max(300) }).parse(req.body);
    return refundRound(db, course, req.staff?.user.id, idParams.parse(req.params).id, body, (client, cardPaymentId, cents) =>
      refundCardPayment(client, course, processors, cardPaymentId, cents),
    );
  });
  app.get("/v1/courses/:slug/settings/rain-checks", async (req) => getRainCheckDays(db, await courseFor(req)));
  app.put("/v1/courses/:slug/settings/rain-checks", async (req) => {
    const course = await managedCourseFor(req);
    return saveRainCheckDays(db, course, z.object({ rainCheckDays: z.number().int().min(1).max(3660) }).parse(req.body).rainCheckDays);
  });

  // Standing tee times, leagues and outings. Managers set them up; the pro shop runs the day
  // (pairings, check-in, payments).
  const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
  app.get("/v1/courses/:slug/standing-times", async (req) => listStandingTimes(db, await courseFor(req)));
  app.post("/v1/courses/:slug/standing-times", async (req, reply) => {
    const course = await managedCourseFor(req);
    const body = z
      .object({
        golferId: z.uuid(),
        weekday: z.number().int().min(1).max(7),
        localTime: hhmm,
        players: z.number().int().min(1).max(8),
        holes: z.number().int().min(9).max(72),
        riding: z.boolean().default(false),
        residency: z.enum(["resident", "nonresident"]).default("nonresident"),
        startsOn: z.iso.date(),
        endsOn: z.iso.date().nullish(),
      })
      .parse(req.body);
    return reply.status(201).send(await createStandingTime(db, course, req.staff?.user.id, body));
  });
  app.patch("/v1/courses/:slug/standing-times/:id", async (req) => {
    const course = await managedCourseFor(req);
    return setStandingTimeActive(db, course, idParams.parse(req.params).id, z.object({ active: z.boolean() }).parse(req.body).active);
  });
  app.post("/v1/courses/:slug/standing-times/book-ahead", async (req) => {
    const course = await courseFor(req);
    await bookAhead(db, course);
    return listStandingTimes(db, course);
  });

  const eventBody = z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["league", "outing"]),
    format: z.enum(["tee_times", "shotgun"]),
    holes: z.number().int().min(9).max(72),
    pricePerPlayerCents: z.number().int().min(0).max(10_000_000),
    includesCart: z.boolean().optional(),
    contactName: z.string().max(120).nullish(),
    contactEmail: z.string().max(200).nullish(),
    contactPhone: z.string().max(40).nullish(),
    notes: z.string().max(1000).nullish(),
  });
  const dateBody = z.object({ date: z.iso.date(), startTime: hhmm, slots: z.number().int().min(1).max(60) });
  app.get("/v1/courses/:slug/events", async (req) => listEvents(db, await courseFor(req)));
  app.post("/v1/courses/:slug/events", async (req, reply) => {
    const course = await managedCourseFor(req);
    const body = eventBody.extend({ schedule: z.object({ startsOn: z.iso.date(), endsOn: z.iso.date().nullish(), startTime: hhmm, slots: z.number().int().min(1).max(60) }) }).parse(req.body);
    return reply.status(201).send(await createEvent(db, course, body));
  });
  app.get("/v1/courses/:slug/events/:id", async (req) => getEvent(db, await courseFor(req), idParams.parse(req.params).id));
  app.patch("/v1/courses/:slug/events/:id", async (req) => {
    const course = await managedCourseFor(req);
    const patch = eventBody.omit({ kind: true, format: true }).partial().extend({ active: z.boolean().optional() }).parse(req.body);
    return updateEvent(db, course, idParams.parse(req.params).id, patch);
  });
  app.post("/v1/courses/:slug/events/:id/dates", async (req, reply) => {
    const course = await managedCourseFor(req);
    const id = idParams.parse(req.params).id;
    const { conflicts } = await addEventDate(db, course, id, dateBody.parse(req.body));
    return reply.status(201).send({ event: await getEvent(db, course, id), conflicts });
  });
  app.post("/v1/courses/:slug/event-dates/:id/cancel", async (req) => cancelEventDate(db, await managedCourseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/events/:id/players", async (req, reply) => {
    const course = await courseFor(req);
    const body = z
      .object({ name: z.string().max(120).optional(), golferId: z.uuid().nullish(), email: z.string().max(200).nullish(), phone: z.string().max(40).nullish(), handicap: z.number().min(-10).max(54).nullish() })
      .parse(req.body);
    return reply.status(201).send(await addEventPlayer(db, course, idParams.parse(req.params).id, body));
  });
  app.delete("/v1/courses/:slug/events/:id/players/:playerId", async (req) => {
    const course = await courseFor(req);
    const { id, playerId } = z.object({ slug: z.string(), id: z.uuid(), playerId: z.uuid() }).parse(req.params);
    return removeEventPlayer(db, course, id, playerId);
  });
  app.get("/v1/courses/:slug/event-dates/:id", async (req) => getEventDate(db, await courseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/event-dates/:id/pairings/auto", async (req) => {
    const course = await courseFor(req);
    const body = z.object({ groupSize: z.number().int().min(1).max(5).default(4), order: z.enum(["name", "random", "handicap"]).default("name"), playerIds: z.array(z.uuid()).max(500).optional() }).parse(req.body ?? {});
    return autoPair(db, course, idParams.parse(req.params).id, body);
  });
  app.put("/v1/courses/:slug/event-dates/:id/pairings/:playerId", async (req) => {
    const course = await courseFor(req);
    const { id, playerId } = z.object({ slug: z.string(), id: z.uuid(), playerId: z.uuid() }).parse(req.params);
    return setPairing(db, course, id, playerId, z.object({ groupNo: z.number().int().min(1).max(200).nullable() }).parse(req.body).groupNo);
  });
  app.post("/v1/courses/:slug/event-dates/:id/check-in", async (req) => {
    const course = await courseFor(req);
    const body = z.object({ playerIds: z.array(z.uuid()).min(1).max(500), checkedIn: z.boolean().default(true) }).parse(req.body);
    return setCheckedIn(db, course, idParams.parse(req.params).id, body.playerIds, body.checkedIn);
  });
  app.post("/v1/courses/:slug/events/:id/payments", async (req, reply) => {
    const course = await courseFor(req);
    const body = z
      .object({
        amountCents: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, "Enter an amount"),
        method: z.enum(["card", "cash", "check", "gift_card", "comp"]),
        eventDateId: z.uuid().nullish(),
        note: z.string().max(300).nullish(),
        cardPaymentId: z.uuid().nullish(),
      })
      .parse(req.body);
    // Giving money back is for managers.
    if (body.amountCents < 0) await managedCourseFor(req);
    return reply.status(201).send(await addEventPayment(db, course, req.staff?.user.id, idParams.parse(req.params).id, body));
  });

  // Gift cards and house accounts. Anyone can sell a gift card, look one up, or take a payment on
  // an account; managers open accounts, set limits, fix balances and make the monthly statements.
  app.get("/v1/courses/:slug/gift-cards", async (req) => {
    const course = await courseFor(req);
    const { q, code } = z.object({ q: z.string().max(100).optional(), code: z.string().max(30).optional() }).parse(req.query);
    return code ? findGiftCard(db, course, code) : listGiftCards(db, course, { q });
  });
  app.get("/v1/courses/:slug/gift-cards/:id", async (req) => getGiftCard(db, await courseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/gift-cards", async (req, reply) => {
    const body = z
      .object({
        amountCents: z.number().int().min(100).max(1_000_000),
        method: z.enum(["card", "cash", "check", "comp"]),
        cardPaymentId: z.uuid().nullish(),
        golferId: z.uuid().nullish(),
        recipientName: z.string().max(100).nullish(),
        code: giftCardCode.nullish(),
        note: z.string().max(300).nullish(),
      })
      .parse(req.body);
    // Giving a card away (a prize or a make-good) is a manager's call.
    const course = body.method === "comp" ? await managedCourseFor(req) : await courseFor(req);
    return reply.status(201).send(await sellGiftCard(db, course, req.staff?.user.id, body));
  });
  app.post("/v1/courses/:slug/gift-cards/:id/adjust", async (req) => {
    const course = await managedCourseFor(req);
    const body = z.object({ changeCents: z.number().int().min(-1_000_000).max(1_000_000).optional(), void: z.boolean().optional(), note: z.string().max(300) }).parse(req.body);
    return adjustGiftCard(db, course, req.staff?.user.id, idParams.parse(req.params).id, body);
  });
  app.get("/v1/courses/:slug/house-accounts", async (req) => listAccounts(db, await courseFor(req)));
  app.get("/v1/courses/:slug/house-accounts/:id", async (req) => getAccount(db, await courseFor(req), idParams.parse(req.params).id));
  app.post("/v1/courses/:slug/house-accounts", async (req, reply) => {
    const course = await managedCourseFor(req);
    const body = z
      .object({ golferId: z.uuid(), creditLimitCents: z.number().int().min(0).max(10_000_000).nullish(), billingEmail: z.email().nullish(), notes: z.string().max(500).nullish() })
      .parse(req.body);
    return reply.status(201).send(await openAccount(db, course, body));
  });
  app.patch("/v1/courses/:slug/house-accounts/:id", async (req) => {
    const course = await managedCourseFor(req);
    const body = z
      .object({
        creditLimitCents: z.number().int().min(0).max(10_000_000).nullish(),
        status: z.enum(["active", "suspended", "closed"]).optional(),
        billingEmail: z.email().nullish(),
        notes: z.string().max(500).nullish(),
      })
      .parse(req.body);
    return updateAccount(db, course, idParams.parse(req.params).id, body);
  });
  app.post("/v1/courses/:slug/house-accounts/:id/payments", async (req, reply) => {
    const course = await courseFor(req);
    const body = z
      .object({ amountCents: z.number().int().min(1).max(10_000_000), method: z.enum(["card", "cash", "check"]), cardPaymentId: z.uuid().nullish(), note: z.string().max(200).nullish() })
      .parse(req.body);
    return reply.status(201).send(await payAccount(db, course, req.staff?.user.id, idParams.parse(req.params).id, body));
  });
  app.post("/v1/courses/:slug/house-accounts/:id/adjust", async (req) => {
    const course = await managedCourseFor(req);
    const body = z.object({ amountCents: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, "Enter an amount"), description: z.string().max(200) }).parse(req.body);
    return adjustAccount(db, course, req.staff?.user.id, idParams.parse(req.params).id, body);
  });
  app.post("/v1/courses/:slug/house-accounts/statements", async (req) => {
    const course = await managedCourseFor(req);
    return runStatements(db, course, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body).month);
  });
  app.get("/v1/courses/:slug/statements/:id", async (req) => getStatement(db, await courseFor(req), idParams.parse(req.params).id));

  // The bookkeeper's daily summary, for QuickBooks or Xero. Managers only.
  const accountingFormat = z.enum(["quickbooks", "xero"]);
  app.get("/v1/courses/:slug/settings/accounting", async (req) => getAccountingSettings(db, await managedCourseFor(req)));
  app.put("/v1/courses/:slug/settings/accounting", async (req) => {
    const course = await managedCourseFor(req);
    const body = z
      .object({ format: accountingFormat.optional(), accounts: z.partialRecord(z.enum(ACCOUNT_KEYS), z.string().max(100)).optional() })
      .parse(req.body);
    return saveAccountingSettings(db, course, body);
  });
  app.get("/v1/courses/:slug/accounting/journal", async (req) => {
    const course = await managedCourseFor(req);
    const { from, to } = rangeQuery.parse(req.query);
    return journal(db, course, from, to);
  });
  app.post("/v1/courses/:slug/accounting/export", async (req) => {
    const course = await managedCourseFor(req);
    const body = rangeQuery.extend({ format: accountingFormat.optional() }).parse(req.body);
    return exportJournal(db, course, req.staff?.user.id, body.from, body.to, body.format);
  });

  // Food and bar: open tabs, the kitchen and bar screens, and paying a tab at the end.
  const isManager = (req: FastifyRequest) => req.apiKey!.role === "manager";
  const tabItem = z.union([
    z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(99), note: z.string().max(200).nullish() }),
    z.object({
      description: z.string().max(200),
      unitCents: money,
      quantity: z.number().int().min(1).max(99),
      taxable: z.boolean().optional(),
      station: z.enum(["kitchen", "bar"]).nullish(),
      note: z.string().max(200).nullish(),
    }),
  ]);
  app.get("/v1/courses/:slug/tabs", async (req) => {
    const course = await courseFor(req);
    return listTabs(db, course, z.object({ status: z.enum(["open", "closed"]).optional() }).parse(req.query));
  });
  app.post("/v1/courses/:slug/tabs", async (req, reply) => {
    const course = await courseFor(req);
    const body = z
      .object({ name: z.string().max(80).nullish(), location: z.enum(["grill", "bar", "turn", "cart"]).optional(), golferId: z.uuid().nullish(), bookingId: z.uuid().nullish() })
      .parse(req.body);
    return reply.status(201).send(await openTab(db, course, req.staff?.user.id, body));
  });
  app.get("/v1/courses/:slug/tabs/:id", async (req) => getTab(db, await courseFor(req), idParams.parse(req.params).id));
  app.patch("/v1/courses/:slug/tabs/:id", async (req) => {
    const course = await courseFor(req);
    return renameTab(db, course, idParams.parse(req.params).id, z.object({ name: z.string().max(80) }).parse(req.body).name);
  });
  app.post("/v1/courses/:slug/tabs/:id/items", async (req, reply) => {
    const course = await courseFor(req);
    const { lines } = z.object({ lines: z.array(tabItem).min(1).max(50) }).parse(req.body);
    return reply.status(201).send(await addTabItems(db, course, req.staff?.user.id, idParams.parse(req.params).id, lines));
  });
  app.delete("/v1/courses/:slug/tabs/:id/items/:itemId", async (req) => {
    const course = await courseFor(req);
    const { id, itemId } = z.object({ id: z.uuid(), itemId: z.uuid() }).parse(req.params);
    return voidTabItem(db, course, id, itemId, isManager(req));
  });
  app.post("/v1/courses/:slug/tabs/:id/close", async (req) => {
    const course = await courseFor(req);
    const body = z.object({ paymentMethod: salePaymentMethod, cardPaymentId: z.uuid().nullish(), giftCardCode: giftCardCode.nullish() }).parse(req.body);
    return closeTab(db, course, req.staff?.user.id, idParams.parse(req.params).id, body);
  });
  app.post("/v1/courses/:slug/tabs/:id/void", async (req) => {
    const course = await courseFor(req);
    const { reason } = z.object({ reason: z.string().max(300) }).parse(req.body);
    return voidTab(db, course, req.staff?.user.id, idParams.parse(req.params).id, reason, isManager(req));
  });
  app.get("/v1/courses/:slug/prep/:station", async (req) => {
    const course = await courseFor(req);
    return prepTickets(db, course, z.object({ station: z.enum(["kitchen", "bar"]) }).parse(req.params).station);
  });
  app.post("/v1/courses/:slug/prep/items", async (req) => {
    const course = await courseFor(req);
    const body = z.object({ itemIds: z.array(z.uuid()).min(1).max(100), status: z.enum(["sent", "ready", "served"]) }).parse(req.body);
    return setItemStatus(db, course, body.itemIds, body.status);
  });

  // Processors call these when a card goes through. The raw body is kept for the signature check.
  app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hooks.post("/v1/webhooks/payments/:slug/:provider", async (req) => {
      const { slug, provider } = z.object({ slug: z.string(), provider: z.string() }).parse(req.params);
      const url = `${req.protocol}://${req.hostname}${req.url}`;
      return handlePaymentWebhook(db, processors, slug, provider, { headers: req.headers, body: String(req.body ?? ""), url: process.env.PUBLIC_URL ? process.env.PUBLIC_URL + req.url : url });
    });
  });

  // The AI assistant connector (MCP over streamable HTTP). Managers only, since it shows revenue.
  // Stateless: each request gets its own server, so nothing is held between calls.
  app.post("/v1/courses/:slug/mcp", async (req, reply) => {
    const course = await managedCourseFor(req);
    const server = buildMcpServer(db, course);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get("/v1/courses/:slug/mcp", async (_req, reply) =>
    reply.status(405).send({ error: { code: "method_not_allowed", message: "Use POST" } }),
  );

  // A manager uploads the booking provider's tee sheet export. dryRun previews the changes.
  app.post("/v1/courses/:slug/imports", { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const course = await managedCourseFor(req);
    return importTeeSheet(db, course, importBody.parse(req.body));
  });
  app.get("/v1/courses/:slug/imports", async (req) => listImports(db, await managedCourseFor(req)));

  // The liability waiver each cart driver signs.
  app.get("/v1/courses/:slug/waiver", async (req) => {
    const course = await courseFor(req);
    const waiver = await getActiveWaiver(db, course);
    if (!waiver) throw notFound("Waiver");
    return waiver;
  });

  // A manager rewords the waiver. Drivers sign the new version from now on.
  app.put("/v1/courses/:slug/waiver", async (req) => {
    const course = await managedCourseFor(req);
    return updateWaiver(db, course, waiverBody.parse(req.body));
  });

  app.get("/v1/courses/:slug", async (req) => {
    const course = await courseFor(req);
    const { id, organizationId, ...publicFields } = course;
    // Rates let the tee sheet show each time's price.
    return { ...publicFields, addOns: await getAddOns(db, course.id), rates: await getRates(db, course.id) };
  });

  // Staff tee sheet: every tee time for the day with its bookings.
  app.get("/v1/courses/:slug/tee-sheet", async (req) => {
    const course = await courseFor(req);
    const { date } = dateQuery.parse(req.query);
    // Standing tee times land on the sheet the first time a day is opened.
    await bookStandingForDate(db, course, date);
    const sheet = await getTeeSheet(db, course, date);
    const { start, end } = dayRange(course, date);
    const bookings = await listBookingsForDay(db, course, start, end);
    return {
      date,
      teeTimes: sheet.map((t) => ({ ...t, bookings: bookings.filter((b) => b.teeTimeId === t.id) })),
    };
  });

  app.patch("/v1/courses/:slug/tee-times/:id", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return updateTeeTime(db, course, id, teeTimePatch.parse(req.body));
  });

  app.post("/v1/courses/:slug/quotes", async (req) => {
    const course = await courseFor(req);
    return quote(db, course, quoteBody.parse(req.body));
  });

  app.post("/v1/courses/:slug/bookings", async (req, reply) => {
    const course = await courseFor(req);
    const body = bookingBody.parse(req.body);
    const booking = await createBooking(db, course, { ...body, source: body.source ?? "staff" });
    return reply.status(201).send(booking);
  });

  app.get("/v1/courses/:slug/bookings/:id", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return getBooking(db, course, id);
  });

  app.post("/v1/courses/:slug/bookings/:id/move", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return moveBooking(db, course, id, moveBody.parse(req.body).teeTimeId);
  });

  app.post("/v1/courses/:slug/bookings/:id/guests", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return addGuests(db, course, id, guestsBody.parse(req.body));
  });

  app.post("/v1/courses/:slug/bookings/:id/remove-players", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return removePlayers(db, course, id, removePlayersBody.parse(req.body).count);
  });

  app.post("/v1/courses/:slug/bookings/:id/undo-no-show", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return undoNoShow(db, course, id);
  });

  // Pro shop check-in: takes any balance due, then marks the group checked in.
  app.post("/v1/courses/:slug/bookings/:id/check-in", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return checkIn(db, course, id, { ...checkInBody.parse(req.body ?? {}), staffId: req.staff?.user.id });
  });

  // Starter check-in at the first tee.
  app.post("/v1/courses/:slug/bookings/:id/tee-off", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    const body = teeOffBody.parse(req.body ?? {});
    return teeOff(db, course, id, body.cartNumbers, body.waivers);
  });

  app.post("/v1/courses/:slug/bookings/:id/payments", async (req, reply) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    const { amountCents, method } = paymentBody.parse(req.body);
    return reply.status(201).send(await recordPayment(db, course, id, amountCents, method));
  });

  app.put("/v1/courses/:slug/bookings/:id/carts", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    const body = cartsBody.parse(req.body);
    return setCartNumbers(db, course, id, body.cartNumbers, body.waivers);
  });

  for (const [action, status] of [
    ["cancel", "cancelled"],
    ["no-show", "no_show"],
  ] as const) {
    app.post(`/v1/courses/:slug/bookings/:id/${action}`, async (req) => {
      const course = await courseFor(req);
      const { id } = idParams.parse(req.params);
      return setBookingStatus(db, course, id, status);
    });
  }

  return app;
}
