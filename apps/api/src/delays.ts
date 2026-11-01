import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import { dayRange, getTeeSheet } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { deliver, resolveAudience, type Channel } from "./messages.ts";

// Weather delays. Frost, fog or lightning holds the first tee: the pro shop pushes every tee time
// from a point in the day back by the same number of minutes, groups and all, and can text and
// email the golfers whose times moved. Delays are kept so the times made from the course's
// templates, and bookings synced from the booking system, land on the delayed sheet too.

export type DelayReason = "frost" | "fog" | "rain" | "lightning" | "heat" | "course" | "other";
export const REASON_LABEL: Record<DelayReason, string> = {
  frost: "Frost",
  fog: "Fog",
  rain: "Rain",
  lightning: "Lightning",
  heat: "Heat",
  course: "Course conditions",
  other: "Weather",
};

const toDelay = (r: any, course: Course) => ({
  id: r.id as string,
  date: r.date as string,
  fromTime: DateTime.fromJSDate(r.from_at).setZone(course.timeZone).toFormat("HH:mm"),
  minutes: r.minutes as number,
  reason: r.reason as DelayReason,
  note: (r.note ?? null) as string | null,
  teeTimes: r.tee_times as number,
  groups: r.groups as number,
  campaignId: (r.campaign_id ?? null) as string | null,
  staff: (r.staff ?? null) as string | null,
  at: r.created_at.toISOString() as string,
  undoneAt: (r.undone_at?.toISOString() ?? null) as string | null,
});

export async function listDelays(db: DbClient, course: Course, date: string) {
  const { rows } = await db.query(
    `SELECT d.*, to_char(d.date, 'YYYY-MM-DD') AS date, u.name AS staff FROM tee_sheet_delays d LEFT JOIN staff_users u ON u.id = d.staff_user_id
      WHERE d.course_id = $1 AND d.date = $2 ORDER BY d.created_at`,
    [course.id, date],
  );
  return rows.map((r) => toDelay(r, course));
}

/** Moves a set of tee times by some minutes without tripping over each other's slots. */
async function shift(client: DbClient, ids: string[], minutes: number) {
  // Far out of the way first, then back to where they belong: a unique index checks each row as
  // it's updated, so moving them straight there could collide with a neighbour not moved yet.
  await client.query("UPDATE tee_times SET starts_at = starts_at + interval '100 years' WHERE id = ANY ($1::uuid[])", [ids]);
  await client.query("UPDATE tee_times SET starts_at = starts_at - interval '100 years' + make_interval(mins => $2) WHERE id = ANY ($1::uuid[])", [ids, minutes]);
}

const DEFAULT_MESSAGE = "Hi {first_name}, {reason} delay at {course} today: tee times are running {minutes} minutes late. Your tee time is now {tee_time}. Questions? Call the pro shop.";

/**
 * Pushes the day's tee times from `from` onward back by `minutes`, and optionally messages the
 * golfers booked on them with their new time.
 */
export async function delayTeeSheet(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { date: string; from: string; minutes: number; reason: DelayReason; note?: string | null; notify?: { channels: Channel[]; body?: string | null } | null },
) {
  const fromAt = DateTime.fromISO(`${input.date}T${input.from}`, { zone: course.timeZone });
  if (!fromAt.isValid) throw badRequest("invalid_time", "Pick the first tee time to push back");
  // Make sure the day's template times exist, so they move with the rest.
  await getTeeSheet(db, course, input.date);
  const { end } = dayRange(course, input.date);
  const { delayId, bookingIds } = await withTransaction(db, async (client) => {
    await client.query("SELECT 1 FROM courses WHERE id = $1 FOR UPDATE", [course.id]);
    const { rows: times } = await client.query<{ id: string }>("SELECT id FROM tee_times WHERE course_id = $1 AND starts_at >= $2 AND starts_at < $3", [
      course.id,
      fromAt.toUTC().toISO(),
      end.toUTC().toISO(),
    ]);
    if (!times.length) throw badRequest("no_tee_times", "There are no tee times from then on to push back");
    const ids = times.map((t) => t.id);
    const { rows: booked } = await client.query<{ id: string }>("SELECT id FROM bookings WHERE tee_time_id = ANY ($1::uuid[]) AND status IN ('confirmed', 'checked_in')", [ids]);
    await shift(client, ids, input.minutes);
    const { rows } = await client.query(
      `INSERT INTO tee_sheet_delays (course_id, date, from_at, minutes, reason, note, tee_times, groups, staff_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [course.id, input.date, fromAt.toUTC().toISO(), input.minutes, input.reason, input.note?.trim() || null, ids.length, booked.length, staffId ?? null],
    );
    return { delayId: rows[0].id as string, bookingIds: booked.map((b) => b.id) };
  });

  let campaign = null;
  if (input.notify?.channels.length && bookingIds.length) {
    const { recipients } = await resolveAudience(db, course, { type: "bookings", bookingIds });
    const reason = REASON_LABEL[input.reason];
    const body = (input.notify.body?.trim() || DEFAULT_MESSAGE).replace(/\{reason\}/g, reason).replace(/\{minutes\}/g, String(input.minutes));
    campaign = await deliver(db, course, staffId, {
      kind: "operational",
      audience: { type: "bookings", bookingIds },
      label: `${reason} delay, ${input.minutes} minutes`,
      channels: input.notify.channels,
      subject: `${reason} delay: your tee time at {course} is now {tee_time}`,
      body,
      recipients,
    });
    await db.query("UPDATE tee_sheet_delays SET campaign_id = $2 WHERE id = $1", [delayId, campaign.id]);
  }
  const delays = await listDelays(db, course, input.date);
  return { delay: delays.find((d) => d.id === delayId)!, campaign, lastTeeTime: await lastTeeTime(db, course, input.date) };
}

async function lastTeeTime(db: DbClient, course: Course, date: string) {
  const { start, end } = dayRange(course, date);
  const { rows } = await db.query("SELECT max(starts_at) AS last FROM tee_times WHERE course_id = $1 AND starts_at >= $2 AND starts_at < $3", [
    course.id,
    start.toUTC().toISO(),
    end.toUTC().toISO(),
  ]);
  return rows[0].last ? DateTime.fromJSDate(rows[0].last).setZone(course.timeZone).toFormat("HH:mm") : null;
}

/** Takes back the day's latest delay (one entered by mistake, or the frost lifted early). */
export async function undoDelay(db: Db, course: Course, staffId: string | undefined, id: string) {
  const date = await withTransaction(db, async (client) => {
    await client.query("SELECT 1 FROM courses WHERE id = $1 FOR UPDATE", [course.id]);
    const { rows } = await client.query("SELECT *, to_char(date, 'YYYY-MM-DD') AS day FROM tee_sheet_delays WHERE id = $1 AND course_id = $2", [id, course.id]);
    const d = rows[0];
    if (!d) throw notFound("Delay");
    if (d.undone_at) throw conflict("already_undone", "This delay was already taken back");
    // Compared in the database: a JavaScript date drops the microseconds and would match itself.
    const { rows: later } = await client.query(
      "SELECT 1 FROM tee_sheet_delays WHERE course_id = $1 AND date = $2 AND undone_at IS NULL AND created_at > (SELECT created_at FROM tee_sheet_delays WHERE id = $3)",
      [course.id, d.day, id],
    );
    if (later.length) throw conflict("not_latest", "Take back the later delay first");
    const { end } = dayRange(course, d.day);
    const movedFrom = DateTime.fromJSDate(d.from_at).plus({ minutes: d.minutes });
    const { rows: times } = await client.query<{ id: string }>("SELECT id FROM tee_times WHERE course_id = $1 AND starts_at >= $2 AND starts_at < $3", [
      course.id,
      movedFrom.toUTC().toISO(),
      end.plus({ minutes: d.minutes }).toUTC().toISO(),
    ]);
    try {
      await shift(client, times.map((t) => t.id), -d.minutes);
    } catch (e: any) {
      if (e.code === "23505") throw conflict("time_taken", "A tee time was added in the gap the delay left, so it can't be taken back");
      throw e;
    }
    await client.query("UPDATE tee_sheet_delays SET undone_at = now(), undone_by = $2 WHERE id = $1", [id, staffId ?? null]);
    return d.day as string;
  });
  return listDelays(db, course, date);
}
