import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Db } from "./db.ts";
import { AppError, notFound } from "./errors.ts";
import { lookupApiKey, type ApiKeyContext } from "./keys.ts";
import { dayRange, getAddOns, getCourseBySlug, getTeeSheet, type Course } from "./courses.ts";
import {
  createBooking,
  getBooking,
  listBookingsForDay,
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
  email: z.email().optional(),
});
const bookingBody = quoteBody.omit({ email: true }).extend({
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.email(),
    phone: z.string().max(40).optional(),
  }),
  source: z.enum(["web", "widget", "api", "staff", "golfnow"]).optional(),
  notes: z.string().max(1000).optional(),
});
const dateQuery = z.object({ date: z.string() });
const availabilityQuery = dateQuery.extend({
  players: z.coerce.number().int().min(1).max(8).default(1),
});
const teeTimePatch = z.object({
  status: z.enum(["open", "blocked"]).optional(),
  note: z.string().max(500).nullable().optional(),
});
const idParams = z.object({ slug: z.string(), id: z.uuid() });
const slugParams = z.object({ slug: z.string() });

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

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

  // Every /v1 route needs an API key: public (pk_) keys for course websites, secret (sk_) keys for staff apps.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const ctx = key ? await lookupApiKey(db, key) : undefined;
    if (!ctx) throw new AppError(401, "unauthorized", "A valid API key is required");
    req.apiKey = ctx;
  });

  /** Loads the course in the URL and checks the API key belongs to it. */
  async function courseFor(req: FastifyRequest, requireSecret = false): Promise<Course> {
    const { slug } = slugParams.parse(req.params);
    const course = await getCourseBySlug(db, slug).catch(() => undefined);
    // A key for another course gets the same 404 as a missing course.
    if (!course || course.id !== req.apiKey!.courseId) throw notFound("Course");
    if (requireSecret && req.apiKey!.kind !== "secret") {
      throw new AppError(403, "forbidden", "This action needs a secret API key");
    }
    return course;
  }

  const isStaff = (req: FastifyRequest) => req.apiKey!.kind === "secret";

  app.get("/v1/courses/:slug", async (req) => {
    const course = await courseFor(req);
    const { id, organizationId, ...publicFields } = course;
    return { ...publicFields, addOns: await getAddOns(db, course.id) };
  });

  // Golfer-facing availability: open tee times with enough room for the group.
  app.get("/v1/courses/:slug/tee-times", async (req) => {
    const course = await courseFor(req);
    const { date, players } = availabilityQuery.parse(req.query);
    const now = Date.now();
    const sheet = await getTeeSheet(db, course, date);
    return {
      date,
      teeTimes: sheet
        .filter((t) => t.status === "open" && Date.parse(t.startsAt) > now)
        .map((t) => ({ id: t.id, startsAt: t.startsAt, localTime: t.localTime, spotsLeft: t.maxPlayers - t.bookedPlayers }))
        .filter((t) => t.spotsLeft >= players),
    };
  });

  // Staff tee sheet: every tee time for the day with its bookings.
  app.get("/v1/courses/:slug/tee-sheet", async (req) => {
    const course = await courseFor(req, true);
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
    const course = await courseFor(req, true);
    const { id } = idParams.parse(req.params);
    return updateTeeTime(db, course, id, teeTimePatch.parse(req.body));
  });

  app.post("/v1/courses/:slug/quotes", async (req) => {
    const course = await courseFor(req);
    return quote(db, course, quoteBody.parse(req.body), isStaff(req));
  });

  app.post("/v1/courses/:slug/bookings", async (req, reply) => {
    const course = await courseFor(req);
    const body = bookingBody.parse(req.body);
    // Website keys can only create website bookings; staff choose the source.
    const source = isStaff(req) ? (body.source ?? "staff") : body.source === "web" ? "web" : "widget";
    const booking = await createBooking(db, course, { ...body, source }, isStaff(req));
    return reply.status(201).send(booking);
  });

  app.get("/v1/courses/:slug/bookings/:id", async (req) => {
    const course = await courseFor(req, true);
    const { id } = idParams.parse(req.params);
    return getBooking(db, course, id);
  });

  for (const [action, status] of [
    ["cancel", "cancelled"],
    ["check-in", "checked_in"],
    ["no-show", "no_show"],
  ] as const) {
    app.post(`/v1/courses/:slug/bookings/:id/${action}`, async (req) => {
      const course = await courseFor(req, true);
      const { id } = idParams.parse(req.params);
      return setBookingStatus(db, course, id, status);
    });
  }

  return app;
}
