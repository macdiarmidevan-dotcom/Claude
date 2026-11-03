import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import { dayRange } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest } from "./errors.ts";
import { budgetFor } from "./budgets.ts";
import { report } from "./reports.ts";

// Manager reports: the revenue dashboard, rounds and utilization, revenue per round and the
// rate mix, for any stretch of up to a year, compared with the period before or last year.
//
// "Rounds" here are players booked on tee times in the period who weren't no-shows, the same
// rounds the booked revenue comes from. Utilization compares them with the open spots on the
// tee sheet (blocked times don't count as available).

export type Compare = "previous" | "last_year" | "none";
const MAX_DAYS = 366;

export interface Departments {
  greenFeesCents: number;
  cartsAndExtrasCents: number;
  proShopCents: number;
  foodBevCents: number;
  eventsCents: number;
  totalCents: number;
}

interface Split {
  rounds: number;
  spots: number;
  occupancy: number | null;
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const per = (cents: number, n: number) => (n ? Math.round(cents / n) : null);

/** Fri-Sun count as the weekend, as River Bend prices them; Mon-Thu are weekdays. */
const isWeekend = (isoDow: number) => isoDow >= 5;

async function period(db: DbClient, course: Course, from: string, to: string) {
  const r = await report(db, course, from, to, MAX_DAYS);
  const start = dayRange(course, from).start.toUTC().toISO();
  const end = dayRange(course, to).end.toUTC().toISO();
  const range = [course.id, start, end, course.timeZone];

  const { rows: groups } = await db.query(
    `SELECT EXTRACT(ISODOW FROM t.starts_at AT TIME ZONE $4)::int AS dow, EXTRACT(HOUR FROM t.starts_at AT TIME ZONE $4)::int AS hour,
            b.status, b.players, b.holes,
            (cardinality(b.cart_numbers) > 0 OR EXISTS (SELECT 1 FROM booking_lines l WHERE l.booking_id = b.id AND l.code = 'gas_cart')) AS riding
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
      WHERE b.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND b.status <> 'cancelled'`,
    range,
  );
  const { rows: capacity } = await db.query(
    `SELECT EXTRACT(ISODOW FROM starts_at AT TIME ZONE $4)::int AS dow, EXTRACT(HOUR FROM starts_at AT TIME ZONE $4)::int AS hour, SUM(max_players)::int AS spots
       FROM tee_times WHERE course_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'open'
      GROUP BY 1, 2`,
    range,
  );
  const { rows: mix } = await db.query(
    `SELECT l.code, COALESCE(MAX(r.name), MAX(l.description)) AS name, COALESCE(BOOL_OR(r.is_replay), false) AS is_replay,
            SUM(l.quantity)::int AS rounds, SUM(l.total_cents)::int AS cents
       FROM booking_lines l JOIN bookings b ON b.id = l.booking_id JOIN tee_times t ON t.id = b.tee_time_id
       LEFT JOIN rate_rules r ON r.course_id = b.course_id AND r.code = l.code
      WHERE b.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND b.status NOT IN ('cancelled', 'no_show') AND l.kind = 'green_fee'
      GROUP BY l.code ORDER BY 4 DESC, 5 DESC`,
    range.slice(0, 3),
  );

  const live = groups.filter((g) => g.status !== "no_show");
  const sum = (list: typeof groups) => list.reduce((s, g) => s + g.players, 0);
  const rounds = sum(live);
  const spots = capacity.reduce((s, c) => s + c.spots, 0);
  const split = (weekend: boolean): Split => {
    const n = sum(live.filter((g) => isWeekend(g.dow) === weekend));
    const cap = capacity.filter((c) => isWeekend(c.dow) === weekend).reduce((s, c) => s + c.spots, 0);
    return { rounds: n, spots: cap, occupancy: pct(n, cap) };
  };

  // Booked players against open spots for each weekday and hour, for the heat map.
  const heat = new Map<string, { weekday: number; hour: number; players: number; spots: number }>();
  const cell = (dow: number, hour: number) => {
    const k = `${dow}-${hour}`;
    if (!heat.has(k)) heat.set(k, { weekday: dow, hour, players: 0, spots: 0 });
    return heat.get(k)!;
  };
  for (const c of capacity) cell(c.dow, c.hour).spots += c.spots;
  for (const g of live) cell(g.dow, g.hour).players += g.players;

  const revenue: Departments = {
    greenFeesCents: r.revenue.greenFeesCents,
    cartsAndExtrasCents: r.revenue.cartsAndExtrasCents,
    proShopCents: r.revenue.proShopCents,
    foodBevCents: r.revenue.foodBevCents,
    eventsCents: r.revenue.eventsCents,
    totalCents: r.revenue.totalCents,
  };
  const rateMix = mix.map((m) => ({ code: m.code, name: m.name, isReplay: m.is_replay, rounds: m.rounds, revenueCents: m.cents, avgCents: per(m.cents, m.rounds) }));
  // Replays are extra loops, so a round is counted once, by its first-loop green fee.
  const firstLoops = rateMix.filter((m) => !m.isReplay);
  const firstLoopRounds = firstLoops.reduce((s, m) => s + m.rounds, 0);
  return {
    revenue,
    days: r.days.map((d) => ({
      date: d.date,
      greenFeesCents: d.greenFeesCents,
      cartsAndExtrasCents: d.cartsAndExtrasCents,
      proShopCents: d.proShopCents,
      foodBevCents: d.foodBevCents,
      eventsCents: d.eventsCents,
      totalCents: d.greenFeesCents + d.cartsAndExtrasCents + d.proShopCents + d.foodBevCents + d.eventsCents,
    })),
    rounds: {
      rounds,
      played: r.rounds.played,
      noShows: sum(groups.filter((g) => g.status === "no_show")),
      spots,
      occupancy: pct(rounds, spots),
      holes9: sum(live.filter((g) => g.holes <= 9)),
      holes18: sum(live.filter((g) => g.holes > 9)),
      riding: sum(live.filter((g) => g.riding)),
      walking: sum(live.filter((g) => !g.riding)),
      weekday: split(false),
      weekend: split(true),
      bySource: r.rounds.bySource,
    },
    yield: {
      avgGreenFeeCents: per(revenue.greenFeesCents, rounds),
      revenuePerRoundCents: per(revenue.totalCents, rounds),
      // Revenue per available tee time spot: green fees spread over every open spot, played or not.
      revPattCents: per(revenue.greenFeesCents, spots),
    },
    heat: [...heat.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
    rateMix,
    firstLoop: { rounds: firstLoopRounds, cents: firstLoops.reduce((s, m) => s + m.revenueCents, 0) },
  };
}

/** The dates to compare with: the same number of days just before, or the same dates last year. */
export function compareRange(from: string, to: string, compare: Compare) {
  if (compare === "none") return null;
  const a = DateTime.fromISO(from);
  const b = DateTime.fromISO(to);
  if (compare === "last_year") return { from: a.minus({ years: 1 }).toISODate()!, to: b.minus({ years: 1 }).toISODate()! };
  const days = b.diff(a, "days").days + 1;
  return { from: a.minus({ days }).toISODate()!, to: a.minus({ days: 1 }).toISODate()! };
}

export async function managerOverview(db: DbClient, course: Course, from: string, to: string, compare: Compare = "previous") {
  if (to < from) throw badRequest("invalid_range", "from must be on or before to");
  const range = compareRange(from, to, compare);
  const [now, before, budget] = await Promise.all([
    period(db, course, from, to),
    range ? period(db, course, range.from, range.to) : null,
    budgetFor(db, course, from, to),
  ]);
  const { rows } = await db.query<{ cents: number | null }>("SELECT MAX(price_cents)::int AS cents FROM rate_rules WHERE course_id = $1 AND active AND NOT is_replay", [course.id]);
  const topRateCents = rows[0]?.cents ?? null;
  // How far below the top green fee the average first-loop round went.
  const discount = (p: { firstLoop: { rounds: number; cents: number } }) =>
    topRateCents && p.firstLoop.rounds ? Math.round((1 - p.firstLoop.cents / (p.firstLoop.rounds * topRateCents)) * 1000) / 10 : null;
  return {
    from,
    to,
    compare: range ? { kind: compare, ...range } : null,
    revenue: now.revenue,
    days: now.days,
    rounds: now.rounds,
    yield: now.yield,
    heat: now.heat,
    rateMix: now.rateMix,
    topRateCents,
    avgDiscountPct: discount(now),
    // The manager's monthly budget, prorated to these dates; null when none of the months has one.
    budget,
    previous: before && {
      revenue: before.revenue,
      days: before.days,
      rounds: before.rounds,
      yield: before.yield,
      rateMix: before.rateMix,
      avgDiscountPct: discount(before),
    },
  };
}
