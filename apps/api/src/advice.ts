import { DateTime } from "luxon";
import { recommendRates, ADVICE_ASSUMPTIONS, type AdviceTeeTime, type RateRule } from "@golf/core";
import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { listRates } from "./pricing.ts";

// Recommended rates for managers: what the tee sheet says each day and time of day could be
// priced at. The logic lives in packages/core/src/advice.ts so the demo gives the same answers;
// this module only gathers the course's tee times. Nothing here changes a price.

export type AdviceBasis = "recent" | "last_year";

/**
 * "recent" looks at the last `weeks` weeks, up to yesterday. "last_year" looks at the coming
 * `weeks` weeks one year ago, so a course in spring isn't priced from last autumn.
 */
export function adviceRange(today: string, weeks: number, basis: AdviceBasis) {
  const t = DateTime.fromISO(today);
  if (basis === "last_year") {
    const from = t.minus({ years: 1 });
    return { from: from.toISODate()!, to: from.plus({ days: weeks * 7 - 1 }).toISODate()! };
  }
  return { from: t.minus({ days: weeks * 7 }).toISODate()!, to: t.minus({ days: 1 }).toISODate()! };
}

export async function rateAdvice(db: DbClient, course: Course, weeks: number, basis: AdviceBasis) {
  const today = DateTime.now().setZone(course.timeZone).toISODate()!;
  const { from, to } = adviceRange(today, weeks, basis);
  const start = DateTime.fromISO(from, { zone: course.timeZone }).startOf("day").toUTC().toISO();
  const end = DateTime.fromISO(to, { zone: course.timeZone }).plus({ days: 1 }).startOf("day").toUTC().toISO();

  // One row per open tee time. Replays are extra loops, so only first-loop green fees count.
  const { rows } = await db.query(
    `SELECT EXTRACT(ISODOW FROM t.starts_at AT TIME ZONE $4)::int AS weekday,
            to_char(t.starts_at AT TIME ZONE $4, 'HH24:MI') AS time,
            t.max_players AS spots,
            COALESCE(SUM(b.players) FILTER (WHERE b.status <> 'no_show'), 0)::int AS players,
            COALESCE(SUM(b.players) FILTER (WHERE b.status = 'no_show'), 0)::int AS no_shows,
            COALESCE(SUM(x.green), 0)::int AS green,
            COALESCE(SUM(x.extras), 0)::int AS extras
       FROM tee_times t
       LEFT JOIN bookings b ON b.tee_time_id = t.id AND b.status <> 'cancelled'
       LEFT JOIN LATERAL (
         SELECT SUM(l.total_cents) FILTER (WHERE l.kind = 'green_fee' AND NOT COALESCE(r.is_replay, false)) AS green,
                SUM(l.total_cents) FILTER (WHERE l.kind = 'add_on') AS extras
           FROM booking_lines l LEFT JOIN rate_rules r ON r.course_id = b.course_id AND r.code = l.code
          WHERE l.booking_id = b.id AND b.status <> 'no_show'
       ) x ON true
      WHERE t.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND t.status = 'open'
      GROUP BY t.id`,
    [course.id, start, end, course.timeZone],
  );
  const teeTimes: AdviceTeeTime[] = rows.map((r) => ({
    weekday: r.weekday,
    time: r.time,
    spots: r.spots,
    players: r.players,
    noShows: r.no_shows,
    greenFeeCents: r.green,
    extrasCents: r.extras,
  }));
  const rates: RateRule[] = (await listRates(db, course)).map((r) => ({
    id: r.code,
    name: r.name,
    priceCents: r.priceCents,
    days: r.days,
    startTime: r.startTime,
    endTime: r.endTime,
    residency: r.residency,
    ageGroups: r.ageGroups,
    isReplay: r.isReplay,
  }));
  return { from, to, weeks, basis, assumptions: ADVICE_ASSUMPTIONS, ...recommendRates({ teeTimes, rates, timeZone: course.timeZone, weeks }) };
}
