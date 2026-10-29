import type { DateTime } from "luxon";
import { NoRateError, quotePlayer, type PlayerProfile } from "@golf/core";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { getAddOns, getHolidays, getRates, toTeeTime, type Course, type TeeTime } from "./courses.ts";

export type BookingSource = "staff" | "phone" | "teeitup" | "golfnow";

export interface QuoteRequest {
  teeTimeId: string;
  holes: number;
  players: PlayerProfile[];
  addOns: { code: string; quantity: number }[];
}

export interface QuoteLine {
  kind: "green_fee" | "add_on";
  code: string;
  description: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
}

export interface Quote {
  teeTime: TeeTime;
  holes: number;
  lines: QuoteLine[];
  totalCents: number;
}

export interface CreateBookingRequest extends QuoteRequest {
  customer: { name: string; email: string; phone?: string | undefined };
  source: BookingSource;
  notes?: string | undefined;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface Booking {
  id: string;
  courseId: string;
  teeTime: TeeTime;
  customer: { id: string; name: string; email: string; phone: string | null };
  players: number;
  holes: number;
  status: string;
  source: BookingSource;
  totalCents: number;
  lines: QuoteLine[];
  cartNumbers: string[];
  payment: PaymentSummary;
  waivers: { cartNumber: string; driverName: string; signedAt: string }[];
  checkedInAt: string | null;
  teedOffAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface WaiverSignature {
  cartNumber: string;
  driverName: string;
  /** SVG path data of the drawn signature. */
  signature: string;
}

export type PaymentMethod = "card" | "cash" | "prepaid" | "punch_card" | "gift_card" | "comp";

export interface PaymentSummary {
  status: "paid" | "partial" | "unpaid";
  paidCents: number;
  balanceCents: number;
  methods: PaymentMethod[];
}

function paymentSummary(totalCents: number, paidCents: number, methods: PaymentMethod[] | null): PaymentSummary {
  const balanceCents = Math.max(0, totalCents - paidCents);
  return {
    status: balanceCents === 0 ? "paid" : paidCents > 0 ? "partial" : "unpaid",
    paidCents,
    balanceCents,
    methods: methods ?? [],
  };
}

// Paid amount and methods for a booking, as SQL columns on a query that has bookings as "b".
const PAYMENT_COLUMNS = `
  (SELECT COALESCE(SUM(amount_cents), 0)::int FROM booking_payments WHERE booking_id = b.id) AS paid_cents,
  (SELECT array_agg(DISTINCT method) FROM booking_payments WHERE booking_id = b.id) AS payment_methods`;

async function lockTeeTime(client: DbClient, course: Course, teeTimeId: string, forUpdate: boolean) {
  const { rows } = await client.query(
    `SELECT t.id, t.starts_at, t.max_players, t.status, t.note,
            (SELECT COALESCE(SUM(players), 0)::int FROM bookings
              WHERE tee_time_id = t.id AND status <> 'cancelled') AS booked
       FROM tee_times t WHERE t.id = $1 AND t.course_id = $2
       ${forUpdate ? "FOR UPDATE OF t" : ""}`,
    [teeTimeId, course.id],
  );
  if (!rows[0]) throw notFound("Tee time");
  return toTeeTime(rows[0], course.timeZone);
}

async function buildQuote(client: DbClient, course: Course, req: QuoteRequest, teeTime: TeeTime): Promise<Quote> {
  if (req.holes % course.holes !== 0) {
    throw badRequest("invalid_holes", `${course.name} has ${course.holes} holes; book a multiple of ${course.holes}`);
  }
  const loops = req.holes / course.holes;
  // Sequential: inside a transaction these share one connection.
  const rates = await getRates(client, course.id);
  const holidays = await getHolidays(client, course.id);
  const addOns = await getAddOns(client, course.id);

  const greenFees = new Map<string, QuoteLine>();
  for (const player of req.players) {
    let quote;
    try {
      quote = quotePlayer(rates, player, { startsAt: teeTime.startsAt, timeZone: course.timeZone, holidays }, loops);
    } catch (err) {
      if (err instanceof NoRateError) throw badRequest("no_rate", err.message);
      throw err;
    }
    for (const line of quote.lines) {
      const existing = greenFees.get(line.rateId);
      if (existing) {
        existing.quantity++;
        existing.totalCents += line.priceCents;
      } else {
        greenFees.set(line.rateId, {
          kind: "green_fee",
          code: line.rateId,
          description: line.name,
          quantity: 1,
          unitCents: line.priceCents,
          totalCents: line.priceCents,
        });
      }
    }
  }

  const addOnLines: QuoteLine[] = req.addOns
    .filter((a) => a.quantity > 0)
    .map((a) => {
      const addOn = addOns.find((x) => x.code === a.code);
      if (!addOn) throw badRequest("unknown_add_on", `Unknown add-on "${a.code}"`);
      return {
        kind: "add_on",
        code: addOn.code,
        description: addOn.name,
        quantity: a.quantity,
        unitCents: addOn.priceCents,
        totalCents: addOn.priceCents * a.quantity,
      };
    });

  const lines = [...greenFees.values(), ...addOnLines];
  return { teeTime, holes: req.holes, lines, totalCents: lines.reduce((s, l) => s + l.totalCents, 0) };
}

export async function quote(db: Db, course: Course, req: QuoteRequest): Promise<Quote> {
  const teeTime = await lockTeeTime(db, course, req.teeTimeId, false);
  return buildQuote(db, course, req, teeTime);
}

/**
 * Books a tee time. The tee time row is locked for the transaction, so two golfers
 * grabbing the last spots at the same moment can't overbook it.
 */
export async function createBooking(
  db: Db,
  course: Course,
  req: CreateBookingRequest,
): Promise<Booking> {
  const id = await withTransaction(db, async (client) => {
    const teeTime = await lockTeeTime(client, course, req.teeTimeId, true);
    if (teeTime.status === "blocked") throw conflict("tee_time_blocked", "This tee time isn't available");
    const spotsLeft = teeTime.maxPlayers - teeTime.bookedPlayers;
    if (req.players.length > spotsLeft) {
      throw conflict("not_enough_spots", `Only ${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} left at this time`);
    }

    const q = await buildQuote(client, course, req, teeTime);

    const email = normalizeEmail(req.customer.email);
    const { rows: customers } = await client.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, email, phone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, email)
         DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id`,
      [course.organizationId, req.customer.name, email, req.customer.phone ?? null],
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bookings (course_id, tee_time_id, customer_id, players, holes, source, total_cents, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [course.id, teeTime.id, customers[0]!.id, req.players.length, req.holes, req.source, q.totalCents, req.notes ?? null],
    );
    const bookingId = rows[0]!.id;
    for (const line of q.lines) {
      await client.query(
        `INSERT INTO booking_lines (booking_id, kind, code, description, quantity, unit_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [bookingId, line.kind, line.code, line.description, line.quantity, line.unitCents, line.totalCents],
      );
    }
    return bookingId;
  });
  return getBooking(db, course, id);
}

export async function getBooking(db: DbClient, course: Course, id: string): Promise<Booking> {
  const { rows } = await db.query(
    `SELECT b.*, c.name AS customer_name, c.email, c.phone, ${PAYMENT_COLUMNS},
            t.id AS t_id, t.starts_at, t.max_players, t.status AS t_status, t.note AS t_note,
            (SELECT COALESCE(SUM(players), 0)::int FROM bookings
              WHERE tee_time_id = t.id AND status <> 'cancelled') AS booked
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN tee_times t ON t.id = b.tee_time_id
      WHERE b.id = $1 AND b.course_id = $2`,
    [id, course.id],
  );
  const r = rows[0];
  if (!r) throw notFound("Booking");
  const { rows: waivers } = await db.query(
    `SELECT w.cart_number, w.driver_name, w.signed_at, cw.version
       FROM cart_waivers w JOIN course_waivers cw ON cw.id = w.waiver_id
      WHERE w.booking_id = $1 ORDER BY w.cart_number`,
    [id],
  );
  const { rows: lines } = await db.query(
    "SELECT kind, code, description, quantity, unit_cents, total_cents FROM booking_lines WHERE booking_id = $1 ORDER BY kind DESC, code",
    [id],
  );
  return {
    id: r.id,
    courseId: r.course_id,
    teeTime: toTeeTime(
      { id: r.t_id, starts_at: r.starts_at, max_players: r.max_players, status: r.t_status, note: r.t_note, booked: r.booked },
      course.timeZone,
    ),
    customer: { id: r.customer_id, name: r.customer_name, email: r.email, phone: r.phone },
    players: r.players,
    holes: r.holes,
    status: r.status,
    source: r.source,
    totalCents: r.total_cents,
    lines: lines.map((l) => ({
      kind: l.kind,
      code: l.code,
      description: l.description,
      quantity: l.quantity,
      unitCents: l.unit_cents,
      totalCents: l.total_cents,
    })),
    cartNumbers: r.cart_numbers,
    payment: paymentSummary(r.total_cents, r.paid_cents, r.payment_methods),
    waivers: waivers.map((w) => ({
      cartNumber: w.cart_number,
      driverName: w.driver_name,
      signedAt: w.signed_at.toISOString(),
      waiverVersion: w.version,
    })),
    checkedInAt: r.checked_in_at?.toISOString() ?? null,
    teedOffAt: r.teed_off_at?.toISOString() ?? null,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

// Which statuses each status can be reached from.
const transitions: Record<string, string[]> = {
  cancelled: ["confirmed"],
  no_show: ["confirmed"],
  checked_in: ["confirmed", "no_show"],
  teed_off: ["checked_in"],
};

async function changeStatus(
  client: DbClient,
  course: Course,
  id: string,
  status: "cancelled" | "no_show" | "checked_in" | "teed_off",
): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE bookings SET status = $3,
        cancelled_at  = CASE WHEN $3 = 'cancelled'  THEN now() ELSE cancelled_at END,
        checked_in_at = CASE WHEN $3 = 'checked_in' THEN now() ELSE checked_in_at END,
        teed_off_at   = CASE WHEN $3 = 'teed_off'   THEN now() ELSE teed_off_at END
      WHERE id = $1 AND course_id = $2 AND status = ANY($4::text[])`,
    [id, course.id, status, transitions[status]],
  );
  if (!rowCount) {
    const current = await getBooking(client, course, id); // throws 404 if missing
    if (status === "teed_off" && current.status === "confirmed") {
      throw conflict("not_checked_in", "Send this group to the pro shop to check in first");
    }
    throw conflict("invalid_status", `Can't change a ${current.status} booking to ${status}`);
  }
}

export async function setBookingStatus(
  db: Db,
  course: Course,
  id: string,
  status: "cancelled" | "no_show",
): Promise<Booking> {
  await changeStatus(db, course, id, status);
  return getBooking(db, course, id);
}

/** Records a payment against a booking. Overpaying is refused so the balance never goes negative. */
async function addPayment(client: DbClient, course: Course, id: string, amountCents: number, method: PaymentMethod) {
  const booking = await getBooking(client, course, id);
  if (amountCents > booking.payment.balanceCents) {
    throw badRequest("overpayment", `The balance is only ${booking.payment.balanceCents} cents`);
  }
  await client.query("INSERT INTO booking_payments (booking_id, amount_cents, method) VALUES ($1, $2, $3)", [
    id,
    amountCents,
    method,
  ]);
}

export async function recordPayment(db: Db, course: Course, id: string, amountCents: number, method: PaymentMethod) {
  await withTransaction(db, (client) => addPayment(client, course, id, amountCents, method));
  return getBooking(db, course, id);
}

/**
 * Pro shop check-in. The group must be paid in full: pass `payment` to take the
 * remaining balance in the same step.
 */
export async function checkIn(
  db: Db,
  course: Course,
  id: string,
  opts: {
    payment?: { method: PaymentMethod } | undefined;
    cartNumbers?: string[] | undefined;
    waivers?: WaiverSignature[] | undefined;
  },
): Promise<Booking> {
  await withTransaction(db, async (client) => {
    await client.query("SELECT id FROM bookings WHERE id = $1 AND course_id = $2 FOR UPDATE", [id, course.id]);
    const booking = await getBooking(client, course, id);
    if (opts.payment && booking.payment.balanceCents > 0) {
      await addPayment(client, course, id, booking.payment.balanceCents, opts.payment.method);
    } else if (booking.payment.balanceCents > 0) {
      throw conflict("payment_required", `This group still owes ${booking.payment.balanceCents} cents`);
    }
    if (opts.cartNumbers) await updateCarts(client, course, id, opts.cartNumbers, opts.waivers);
    await changeStatus(client, course, id, "checked_in");
  });
  return getBooking(db, course, id);
}

/** Starter check-in at the first tee. Only groups the pro shop has checked in can go. */
export async function teeOff(
  db: Db,
  course: Course,
  id: string,
  cartNumbers?: string[],
  waivers?: WaiverSignature[],
): Promise<Booking> {
  await withTransaction(db, async (client) => {
    if (cartNumbers) await updateCarts(client, course, id, cartNumbers, waivers);
    await changeStatus(client, course, id, "teed_off");
  });
  return getBooking(db, course, id);
}

/**
 * Moves a booking to another tee time (staff only), e.g. when a starter sends a group
 * off early. Both tee times are locked, in a fixed order so two moves can't deadlock.
 */
export async function moveBooking(db: Db, course: Course, id: string, toTeeTimeId: string): Promise<Booking> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query(
      "SELECT tee_time_id, players, status FROM bookings WHERE id = $1 AND course_id = $2 FOR UPDATE",
      [id, course.id],
    );
    const booking = rows[0];
    if (!booking) throw notFound("Booking");
    if (booking.status === "cancelled") throw conflict("invalid_status", "Can't move a cancelled booking");
    if (booking.tee_time_id === toTeeTimeId) return;

    const [first, second] = [booking.tee_time_id, toTeeTimeId].sort();
    await lockTeeTime(client, course, first, true);
    await lockTeeTime(client, course, second, true);
    const target = await lockTeeTime(client, course, toTeeTimeId, false);
    if (target.status === "blocked") throw conflict("tee_time_blocked", "That tee time is blocked");
    const spotsLeft = target.maxPlayers - target.bookedPlayers;
    if (booking.players > spotsLeft) {
      throw conflict("not_enough_spots", `Only ${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} left at that time`);
    }
    await client.query("UPDATE bookings SET tee_time_id = $2 WHERE id = $1", [id, toTeeTimeId]);
  });
  return getBooking(db, course, id);
}

export async function getActiveWaiver(db: DbClient, course: Course) {
  const { rows } = await db.query(
    "SELECT id, version, title, body FROM course_waivers WHERE course_id = $1 AND active",
    [course.id],
  );
  return rows[0] as { id: string; version: number; title: string; body: string } | undefined;
}

/**
 * Replaces the wording drivers sign. The old version stays on file so every signed
 * waiver still points at the exact text that driver agreed to.
 */
export async function updateWaiver(db: Db, course: Course, waiver: { title: string; body: string }) {
  return withTransaction(db, async (client) => {
    // Lock the course's waivers so two managers saving at once can't both take the next version.
    const { rows } = await client.query<{ version: number }>(
      "SELECT version FROM course_waivers WHERE course_id = $1 ORDER BY version DESC FOR UPDATE",
      [course.id],
    );
    const version = (rows[0]?.version ?? 0) + 1;
    await client.query("UPDATE course_waivers SET active = false WHERE course_id = $1 AND active", [course.id]);
    await client.query("INSERT INTO course_waivers (course_id, version, title, body) VALUES ($1, $2, $3, $4)", [
      course.id,
      version,
      waiver.title,
      waiver.body,
    ]);
    return (await getActiveWaiver(client, course))!;
  });
}

/**
 * Assigns carts to a booking. Every cart needs a signed waiver from its driver,
 * either already on file for this booking or passed in `waivers`.
 */
async function updateCarts(
  client: DbClient,
  course: Course,
  id: string,
  cartNumbers: string[],
  waivers: WaiverSignature[] = [],
) {
  const { rowCount } = await client.query(
    "SELECT 1 FROM bookings WHERE id = $1 AND course_id = $2 AND status <> 'cancelled' FOR UPDATE",
    [id, course.id],
  );
  if (!rowCount) throw notFound("Booking");

  if (cartNumbers.length > 0) {
    const waiver = await getActiveWaiver(client, course);
    if (!waiver) throw conflict("no_waiver", "Set up the course's cart waiver before assigning carts");
    for (const w of waivers.filter((w) => cartNumbers.includes(w.cartNumber))) {
      await client.query(
        `INSERT INTO cart_waivers (booking_id, waiver_id, cart_number, driver_name, signature)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (booking_id, cart_number)
           DO UPDATE SET waiver_id = EXCLUDED.waiver_id, driver_name = EXCLUDED.driver_name,
                         signature = EXCLUDED.signature, signed_at = now()`,
        [id, waiver.id, w.cartNumber, w.driverName, w.signature],
      );
    }
    const { rows } = await client.query<{ cart_number: string }>(
      "SELECT cart_number FROM cart_waivers WHERE booking_id = $1",
      [id],
    );
    const signed = new Set(rows.map((r) => r.cart_number));
    const missing = cartNumbers.filter((c) => !signed.has(c));
    if (missing.length > 0) {
      throw conflict("waiver_required", `The driver of cart ${missing.join(", ")} needs to sign the waiver`);
    }
  }
  await client.query("UPDATE bookings SET cart_numbers = $2 WHERE id = $1", [id, cartNumbers]);
}

export async function setCartNumbers(
  db: Db,
  course: Course,
  id: string,
  cartNumbers: string[],
  waivers?: WaiverSignature[],
): Promise<Booking> {
  await withTransaction(db, (client) => updateCarts(client, course, id, cartNumbers, waivers));
  return getBooking(db, course, id);
}

export async function updateTeeTime(
  db: Db,
  course: Course,
  id: string,
  patch: { status?: "open" | "blocked" | undefined; note?: string | null | undefined },
): Promise<TeeTime> {
  const { rowCount } = await db.query(
    `UPDATE tee_times SET status = COALESCE($3, status), note = CASE WHEN $4 THEN $5 ELSE note END
      WHERE id = $1 AND course_id = $2`,
    [id, course.id, patch.status ?? null, patch.note !== undefined, patch.note ?? null],
  );
  if (!rowCount) throw notFound("Tee time");
  return lockTeeTime(db, course, id, false);
}

export async function listBookingsForDay(db: DbClient, course: Course, start: DateTime, end: DateTime) {
  const { rows } = await db.query(
    `SELECT b.id, b.tee_time_id, b.players, b.holes, b.status, b.source, b.total_cents, b.cart_numbers, c.name, c.phone,
            ${PAYMENT_COLUMNS},
            (SELECT array_agg(cart_number) FROM cart_waivers WHERE booking_id = b.id) AS signed_carts
       FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN tee_times t ON t.id = b.tee_time_id
      WHERE b.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND b.status <> 'cancelled'
      ORDER BY b.created_at`,
    [course.id, start.toUTC().toISO(), end.toUTC().toISO()],
  );
  return rows.map((r) => ({
    id: r.id,
    teeTimeId: r.tee_time_id,
    customerName: r.name,
    customerPhone: r.phone,
    players: r.players,
    holes: r.holes,
    status: r.status,
    source: r.source,
    totalCents: r.total_cents,
    cartNumbers: r.cart_numbers as string[],
    payment: paymentSummary(r.total_cents, r.paid_cents, r.payment_methods),
    // Carts whose driver has signed the waiver for this booking.
    signedCarts: (r.signed_carts ?? []) as string[],
  }));
}
