import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import type { Db } from "./db.ts";
import { AppError, notFound } from "./errors.ts";
import { lookupApiKey, type ApiKeyContext } from "./keys.ts";
import { dayRange, getAddOns, getCourseBySlug, getTeeSheet, type Course } from "./courses.ts";
import {
  createBooking,
  getBooking,
  listBookingsForDay,
  checkIn,
  getActiveWaiver,
  moveBooking,
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
  }
}

const player = z.object({
  residency: z.enum(["resident", "nonresident"]).default("nonresident"),
  ageGroup: z.enum(["adult", "senior", "junior"]).default("adult"),
});
const addOn = z.object({ code: z.string(), quantity: z.number().int().min(0).max(8) });
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
const paymentMethod = z.enum(["card", "cash", "prepaid", "punch_card", "gift_card", "comp"]);
const checkInBody = z.object({
  cartNumbers: cartNumbers.optional(),
  waivers,
  payment: z.object({ method: paymentMethod }).optional(),
});
const teeOffBody = z.object({ cartNumbers: cartNumbers.optional(), waivers });
const cartsBody = z.object({ cartNumbers, waivers });
const paymentBody = z.object({ amountCents: z.number().int().positive(), method: paymentMethod });
const idParams = z.object({ slug: z.string(), id: z.uuid() });
const slugParams = z.object({ slug: z.string() });

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

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

  // Every /v1 route needs a staff (sk_) API key. Golfers don't book through this API:
  // they book with the course's existing provider and those bookings are imported.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const ctx = key ? await lookupApiKey(db, key) : undefined;
    if (!ctx) throw new AppError(401, "unauthorized", "A valid API key is required");
    req.apiKey = ctx;
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

  // The liability waiver each cart driver signs.
  app.get("/v1/courses/:slug/waiver", async (req) => {
    const course = await courseFor(req);
    const waiver = await getActiveWaiver(db, course);
    if (!waiver) throw notFound("Waiver");
    return waiver;
  });

  app.get("/v1/courses/:slug", async (req) => {
    const course = await courseFor(req);
    const { id, organizationId, ...publicFields } = course;
    return { ...publicFields, addOns: await getAddOns(db, course.id) };
  });

  // Staff tee sheet: every tee time for the day with its bookings.
  app.get("/v1/courses/:slug/tee-sheet", async (req) => {
    const course = await courseFor(req);
    const { date } = dateQuery.parse(req.query);
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

  // Pro shop check-in: takes any balance due, then marks the group checked in.
  app.post("/v1/courses/:slug/bookings/:id/check-in", async (req) => {
    const course = await courseFor(req);
    const { id } = idParams.parse(req.params);
    return checkIn(db, course, id, checkInBody.parse(req.body ?? {}));
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
