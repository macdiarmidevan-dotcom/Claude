import { DateTime } from "luxon";
import type { DbClient } from "./db.ts";
import { badRequest } from "./errors.ts";
import { dayRange, getTeeSheet, type Course } from "./courses.ts";
import { listBookingsForDay } from "./bookings.ts";

// Read-only answers to the questions managers ask about a day or a stretch of days.
// The AI assistant (mcp.ts) calls these; they never change anything.

export const todayAt = (course: Course) => DateTime.now().setZone(course.timeZone).toISODate()!;

export type GroupFilter = "all" | "unpaid" | "not_checked_in" | "checked_in" | "on_course" | "no_show";

async function day(db: DbClient, course: Course, date: string) {
  const { start, end } = dayRange(course, date);
  const sheet = await getTeeSheet(db, course, date);
  const bookings = await listBookingsForDay(db, course, start, end);
  const timeOf = new Map(sheet.map((t) => [t.id, t.localTime]));
  return { sheet, bookings: bookings.map((b) => ({ ...b, localTime: timeOf.get(b.teeTimeId) ?? "" })) };
}

/** Rounds, players, check-ins, open spots and money for one day. */
export async function daySummary(db: DbClient, course: Course, date: string) {
  const { sheet, bookings } = await day(db, course, date);
  const playing = bookings.filter((b) => b.status !== "no_show");
  const count = (status: string) => bookings.filter((b) => b.status === status).reduce((s, b) => s + b.players, 0);
  const players = playing.reduce((s, b) => s + b.players, 0);
  const open = sheet.filter((t) => t.status === "open");
  const capacity = open.reduce((s, t) => s + t.maxPlayers, 0);
  return {
    date,
    course: course.name,
    groups: playing.length,
    players,
    playersBooked: count("confirmed"),
    playersCheckedInAtShop: count("checked_in"),
    playersOnCourse: count("teed_off"),
    noShowPlayers: count("no_show"),
    openSpots: Math.max(0, capacity - players),
    blockedTeeTimes: sheet.filter((t) => t.status === "blocked").length,
    occupancyPercent: capacity ? Math.round((players / capacity) * 100) : 0,
    bookedCents: playing.reduce((s, b) => s + b.totalCents, 0),
    collectedCents: bookings.reduce((s, b) => s + b.payment.paidCents, 0),
    owedCents: playing.reduce((s, b) => s + b.payment.balanceCents, 0),
    cartsOut: bookings.filter((b) => b.status === "teed_off").flatMap((b) => b.cartNumbers),
  };
}

/** The groups on one day, optionally only those that still owe, haven't checked in, and so on. */
export async function groupsForDay(db: DbClient, course: Course, date: string, filter: GroupFilter = "all") {
  const { bookings } = await day(db, course, date);
  const keep = {
    all: () => true,
    unpaid: (b: (typeof bookings)[number]) => b.status !== "no_show" && b.payment.balanceCents > 0,
    not_checked_in: (b: (typeof bookings)[number]) => b.status === "confirmed",
    checked_in: (b: (typeof bookings)[number]) => b.status === "checked_in",
    on_course: (b: (typeof bookings)[number]) => b.status === "teed_off",
    no_show: (b: (typeof bookings)[number]) => b.status === "no_show",
  }[filter];
  return bookings
    .filter(keep)
    .sort((a, b) => a.localTime.localeCompare(b.localTime))
    .map((b) => ({
      teeTime: b.localTime,
      name: b.customerName,
      players: b.players,
      holes: b.holes,
      status: b.status,
      totalCents: b.totalCents,
      owedCents: b.payment.balanceCents,
      paidBy: b.payment.methods,
      carts: b.cartNumbers,
    }));
}

/** A golfer's bookings from 30 days back to 30 days ahead, by name. */
export async function findGolfer(db: DbClient, course: Course, name: string) {
  const now = DateTime.now().setZone(course.timeZone);
  const { rows } = await db.query(
    `SELECT c.name, c.phone, t.starts_at, b.players, b.holes, b.status, b.total_cents
       FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN tee_times t ON t.id = b.tee_time_id
      WHERE b.course_id = $1 AND c.name ILIKE $2 AND b.status <> 'cancelled'
        AND t.starts_at BETWEEN $3 AND $4
      ORDER BY t.starts_at LIMIT 50`,
    [course.id, `%${name.replace(/[%_\\]/g, "\\$&")}%`, now.minus({ days: 30 }).toUTC().toISO(), now.plus({ days: 30 }).toUTC().toISO()],
  );
  return rows.map((r) => ({
    name: r.name,
    phone: r.phone,
    teeTime: DateTime.fromJSDate(r.starts_at).setZone(course.timeZone).toFormat("yyyy-MM-dd HH:mm"),
    players: r.players,
    holes: r.holes,
    status: r.status,
    totalCents: r.total_cents,
  }));
}

/** Money per day between two local dates (inclusive): what was booked and what was collected, by type. */
export async function revenue(db: DbClient, course: Course, from: string, to: string) {
  const start = dayRange(course, from).start;
  const end = dayRange(course, to).end;
  if (end <= start) throw badRequest("invalid_range", "from must be on or before to");
  if (end.diff(start, "days").days > 92) throw badRequest("invalid_range", "Ask for 92 days or fewer at a time");
  const range = [course.id, start.toUTC().toISO(), end.toUTC().toISO(), course.timeZone];
  // Booked revenue counts by the day of the round; no-shows and cancellations are left out.
  const { rows: booked } = await db.query(
    `SELECT to_char(t.starts_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, l.kind, SUM(l.total_cents)::int AS cents,
            COUNT(DISTINCT b.id)::int AS groups
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN booking_lines l ON l.booking_id = b.id
      WHERE b.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND b.status NOT IN ('cancelled', 'no_show')
      GROUP BY 1, 2`,
    range,
  );
  // Collected money counts by the day it was taken.
  const { rows: collected } = await db.query(
    `SELECT to_char(p.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, p.method, SUM(p.amount_cents)::int AS cents
       FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
      WHERE b.course_id = $1 AND p.created_at >= $2 AND p.created_at < $3
      GROUP BY 1, 2`,
    range,
  );
  const days = new Map<string, { date: string; greenFeesCents: number; addOnsCents: number; collectedCents: number; collectedBy: Record<string, number> }>();
  const at = (date: string) => {
    if (!days.has(date)) days.set(date, { date, greenFeesCents: 0, addOnsCents: 0, collectedCents: 0, collectedBy: {} });
    return days.get(date)!;
  };
  for (const r of booked) at(r.day)[r.kind === "green_fee" ? "greenFeesCents" : "addOnsCents"] += r.cents;
  for (const r of collected) {
    const d = at(r.day);
    d.collectedCents += r.cents;
    d.collectedBy[r.method] = (d.collectedBy[r.method] ?? 0) + r.cents;
  }
  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    from,
    to,
    totalBookedCents: list.reduce((s, d) => s + d.greenFeesCents + d.addOnsCents, 0),
    totalCollectedCents: list.reduce((s, d) => s + d.collectedCents, 0),
    days: list,
  };
}
