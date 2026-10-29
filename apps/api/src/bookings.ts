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
  notes: string | null;
  createdAt: string;
}

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
    `SELECT b.*, c.name AS customer_name, c.email, c.phone,
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
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

const transitions: Record<string, string[]> = {
  cancelled: ["confirmed"],
  checked_in: ["confirmed", "no_show"],
  no_show: ["confirmed"],
};

export async function setBookingStatus(
  db: Db,
  course: Course,
  id: string,
  status: "cancelled" | "checked_in" | "no_show",
): Promise<Booking> {
  const { rowCount, rows } = await db.query(
    `UPDATE bookings SET status = $3, cancelled_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE cancelled_at END
      WHERE id = $1 AND course_id = $2 AND status = ANY($4::text[])
      RETURNING id`,
    [id, course.id, status, transitions[status]],
  );
  if (!rowCount) {
    const current = await getBooking(db, course, id); // throws 404 if missing
    throw conflict("invalid_status", `Can't change a ${current.status} booking to ${status}`);
  }
  return getBooking(db, course, rows[0].id);
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

export async function setCartNumbers(db: Db, course: Course, id: string, cartNumbers: string[]): Promise<Booking> {
  const { rowCount } = await db.query(
    "UPDATE bookings SET cart_numbers = $3 WHERE id = $1 AND course_id = $2 AND status <> 'cancelled'",
    [id, course.id, cartNumbers],
  );
  if (!rowCount) throw notFound("Booking");
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
    `SELECT b.id, b.tee_time_id, b.players, b.holes, b.status, b.source, b.total_cents, b.cart_numbers, c.name, c.phone
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
  }));
}
