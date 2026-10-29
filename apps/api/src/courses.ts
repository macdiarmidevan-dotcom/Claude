import { DateTime } from "luxon";
import { generateTeeTimes, type AgeGroup, type RateRule, type Residency, type TeeSheetTemplate } from "@golf/core";
import type { DbClient } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";

export interface Course {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  timeZone: string;
  holes: number;
  address: string | null;
  phone: string | null;
  bookingWindowDays: number;
}

export interface AddOn {
  code: string;
  name: string;
  priceCents: number;
}

export interface TeeTime {
  id: string;
  startsAt: string;
  localTime: string;
  maxPlayers: number;
  bookedPlayers: number;
  status: "open" | "blocked";
  note: string | null;
}

export async function getCourseBySlug(db: DbClient, slug: string): Promise<Course> {
  const { rows } = await db.query(
    `SELECT id, organization_id, slug, name, time_zone, holes, address, phone, booking_window_days
       FROM courses WHERE slug = $1`,
    [slug],
  );
  const r = rows[0];
  if (!r) throw notFound("Course");
  return {
    id: r.id,
    organizationId: r.organization_id,
    slug: r.slug,
    name: r.name,
    timeZone: r.time_zone,
    holes: r.holes,
    address: r.address,
    phone: r.phone,
    bookingWindowDays: r.booking_window_days,
  };
}

export async function getRates(db: DbClient, courseId: string): Promise<RateRule[]> {
  const { rows } = await db.query(
    `SELECT code, name, price_cents, days, start_time, end_time, residency, age_groups, is_replay
       FROM rate_rules WHERE course_id = $1 AND active`,
    [courseId],
  );
  return rows.map((r) => ({
    id: r.code,
    name: r.name,
    priceCents: r.price_cents,
    days: r.days,
    startTime: r.start_time,
    endTime: r.end_time,
    residency: r.residency as Residency | null,
    ageGroups: r.age_groups as AgeGroup[] | null,
    isReplay: r.is_replay,
  }));
}

export async function getAddOns(db: DbClient, courseId: string): Promise<AddOn[]> {
  const { rows } = await db.query(
    "SELECT code, name, price_cents FROM add_ons WHERE course_id = $1 AND active ORDER BY name",
    [courseId],
  );
  return rows.map((r) => ({ code: r.code, name: r.name, priceCents: r.price_cents }));
}

export async function getHolidays(db: DbClient, courseId: string): Promise<string[]> {
  const { rows } = await db.query<{ date: string }>("SELECT date FROM course_holidays WHERE course_id = $1", [
    courseId,
  ]);
  return rows.map((r) => r.date);
}

async function getTemplates(db: DbClient, courseId: string): Promise<TeeSheetTemplate[]> {
  const { rows } = await db.query(
    `SELECT weekdays, first_tee, last_tee, interval_minutes, max_players
       FROM tee_sheet_templates WHERE course_id = $1 ORDER BY position`,
    [courseId],
  );
  return rows.map((r) => ({
    weekdays: r.weekdays,
    firstTee: r.first_tee,
    lastTee: r.last_tee,
    intervalMinutes: r.interval_minutes,
    maxPlayers: r.max_players,
  }));
}

/** The UTC range covering one local day at the course. */
export function dayRange(course: Course, date: string): { start: DateTime; end: DateTime } {
  const start = DateTime.fromISO(date, { zone: course.timeZone }).startOf("day");
  if (!start.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("invalid_date", "date must be YYYY-MM-DD");
  return { start, end: start.plus({ days: 1 }) };
}

/**
 * Returns the tee sheet for a local date, creating that day's tee times from the
 * course's templates the first time the day is opened.
 */
export async function getTeeSheet(db: DbClient, course: Course, date: string): Promise<TeeTime[]> {
  const { start, end } = dayRange(course, date);
  const generated = generateTeeTimes(date, course.timeZone, await getTemplates(db, course.id));
  if (generated.length > 0) {
    await db.query(
      `INSERT INTO tee_times (course_id, starts_at, max_players)
         SELECT $1, s, m FROM unnest($2::timestamptz[], $3::int[]) AS t(s, m)
       ON CONFLICT (course_id, starts_at) DO NOTHING`,
      [course.id, generated.map((g) => g.startsAt), generated.map((g) => g.maxPlayers)],
    );
  }
  const { rows } = await db.query(
    `SELECT t.id, t.starts_at, t.max_players, t.status, t.note,
            COALESCE(SUM(b.players) FILTER (WHERE b.status <> 'cancelled'), 0)::int AS booked
       FROM tee_times t LEFT JOIN bookings b ON b.tee_time_id = t.id
      WHERE t.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3
      GROUP BY t.id ORDER BY t.starts_at`,
    [course.id, start.toUTC().toISO(), end.toUTC().toISO()],
  );
  return rows.map((r) => toTeeTime(r, course.timeZone));
}

export function toTeeTime(r: any, timeZone: string): TeeTime {
  const startsAt = DateTime.fromJSDate(r.starts_at, { zone: timeZone });
  return {
    id: r.id,
    startsAt: startsAt.toISO()!,
    localTime: startsAt.toFormat("HH:mm"),
    maxPlayers: r.max_players,
    bookedPlayers: r.booked ?? 0,
    status: r.status,
    note: r.note,
  };
}
