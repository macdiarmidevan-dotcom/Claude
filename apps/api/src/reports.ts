import type { Course } from "./courses.ts";
import { dayRange } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest, conflict } from "./errors.ts";
import { revenue } from "./insights.ts";

// Reports for managers and the end-of-day close. Tee sheet money comes from bookings and
// their payments; pro shop money from register sales. Everything is read-only except the close.

const METHODS = ["cash", "card", "gift_card", "punch_card", "season_pass", "loyalty", "rain_check", "prepaid", "comp"] as const;
type Method = (typeof METHODS)[number];
const emptyMethods = () => Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<Method, number>;

/**
 * Everything a manager or the bookkeeper needs for a stretch of days (local dates, inclusive):
 * revenue by source and category, money taken by payment type, sales tax, rounds and
 * occupancy, and hours worked.
 */
export async function report(db: DbClient, course: Course, from: string, to: string) {
  const tee = await revenue(db, course, from, to);
  const start = dayRange(course, from).start;
  const end = dayRange(course, to).end;
  const range = [course.id, start.toUTC().toISO(), end.toUTC().toISO(), course.timeZone];

  const { rows: sales } = await db.query(
    `SELECT to_char(s.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, s.payment_method, s.status,
            SUM(s.subtotal_cents)::int AS subtotal, SUM(s.tax_cents)::int AS tax, SUM(s.total_cents)::int AS total, COUNT(*)::int AS n
       FROM sales s WHERE s.course_id = $1 AND s.created_at >= $2 AND s.created_at < $3
      GROUP BY 1, 2, 3`,
    range,
  );
  const { rows: categories } = await db.query(
    `SELECT l.category, SUM(l.total_cents)::int AS cents, SUM(l.quantity)::int AS items
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id
      WHERE s.course_id = $1 AND s.created_at >= $2 AND s.created_at < $3 AND s.status = 'completed'
      GROUP BY 1 ORDER BY 2 DESC`,
    range.slice(0, 3),
  );
  const { rows: rounds } = await db.query(
    `SELECT to_char(t.starts_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, b.status, b.source, SUM(b.players)::int AS players, COUNT(*)::int AS groups
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
      WHERE b.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND b.status <> 'cancelled'
      GROUP BY 1, 2, 3`,
    range,
  );
  // Capacity only counts days whose tee sheet exists (it's made the first time a day is opened).
  const { rows: capacity } = await db.query(
    `SELECT COALESCE(SUM(max_players), 0)::int AS spots FROM tee_times
      WHERE course_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'open'`,
    range.slice(0, 3),
  );
  const { rows: labor } = await db.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out - clock_in))) / 3600, 0)::float AS hours, COUNT(DISTINCT staff_user_id)::int AS people
       FROM time_punches WHERE course_id = $1 AND clock_in >= $2 AND clock_in < $3 AND clock_out IS NOT NULL`,
    range.slice(0, 3),
  );

  const days = new Map<string, { date: string; greenFeesCents: number; cartsAndExtrasCents: number; proShopCents: number; taxCents: number; collectedCents: number; rounds: number }>();
  const at = (date: string) => {
    if (!days.has(date)) days.set(date, { date, greenFeesCents: 0, cartsAndExtrasCents: 0, proShopCents: 0, taxCents: 0, collectedCents: 0, rounds: 0 });
    return days.get(date)!;
  };
  const collected = emptyMethods();
  for (const d of tee.days) {
    const row = at(d.date);
    row.greenFeesCents += d.greenFeesCents;
    row.cartsAndExtrasCents += d.addOnsCents;
    row.collectedCents += d.collectedCents;
    for (const [m, c] of Object.entries(d.collectedBy)) collected[m as Method] += c;
  }
  let proShop = { subtotalCents: 0, taxCents: 0, totalCents: 0, sales: 0, refundedCents: 0 };
  for (const s of sales) {
    if (s.status === "refunded") {
      proShop.refundedCents += s.total;
      continue;
    }
    const row = at(s.day);
    row.proShopCents += s.subtotal;
    row.taxCents += s.tax;
    row.collectedCents += s.total;
    collected[s.payment_method as Method] += s.total;
    proShop = { ...proShop, subtotalCents: proShop.subtotalCents + s.subtotal, taxCents: proShop.taxCents + s.tax, totalCents: proShop.totalCents + s.total, sales: proShop.sales + s.n };
  }
  const played = rounds.filter((r) => r.status === "checked_in" || r.status === "teed_off");
  for (const r of played) at(r.day).rounds += r.players;
  const sources: Record<string, number> = {};
  for (const r of rounds.filter((x) => x.status !== "no_show")) sources[r.source] = (sources[r.source] ?? 0) + r.players;
  const booked = rounds.filter((r) => r.status !== "no_show").reduce((s, r) => s + r.players, 0);
  const greenFees = tee.days.reduce((s, d) => s + d.greenFeesCents, 0);
  const extras = tee.days.reduce((s, d) => s + d.addOnsCents, 0);

  return {
    from,
    to,
    revenue: {
      greenFeesCents: greenFees,
      cartsAndExtrasCents: extras,
      proShopCents: proShop.subtotalCents,
      // Sales tax is owed to the state, so it's kept out of revenue.
      totalCents: greenFees + extras + proShop.subtotalCents,
      salesTaxCents: proShop.taxCents,
      proShopRefundsCents: proShop.refundedCents,
      proShopByCategory: categories.map((c) => ({ category: c.category, cents: c.cents, items: c.items })),
    },
    // Money taken by type. Prepaid is what the booking provider collected online; comps are free.
    collected: { ...collected, totalCents: Object.values(collected).reduce((s, c) => s + c, 0) },
    rounds: {
      played: played.reduce((s, r) => s + r.players, 0),
      booked,
      noShows: rounds.filter((r) => r.status === "no_show").reduce((s, r) => s + r.players, 0),
      openSpots: capacity[0].spots,
      occupancy: capacity[0].spots ? Math.round((booked / capacity[0].spots) * 1000) / 10 : null,
      bySource: sources,
    },
    labor: { hours: Math.round(labor[0].hours * 10) / 10, people: labor[0].people },
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** What the system says was taken on one day, by payment type, for counting the drawer. */
async function expectedFor(db: DbClient, course: Course, date: string) {
  const { start, end } = dayRange(course, date);
  const range = [course.id, start.toUTC().toISO(), end.toUTC().toISO()];
  const totals = emptyMethods();
  const { rows: tee } = await db.query(
    `SELECT p.method, SUM(p.amount_cents)::int AS cents FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
      WHERE b.course_id = $1 AND p.created_at >= $2 AND p.created_at < $3 GROUP BY 1`,
    range,
  );
  const { rows: shop } = await db.query(
    `SELECT payment_method AS method, SUM(total_cents)::int AS cents FROM sales
      WHERE course_id = $1 AND created_at >= $2 AND created_at < $3 AND status = 'completed' GROUP BY 1`,
    range,
  );
  for (const r of [...tee, ...shop]) totals[r.method as Method] += r.cents;
  return totals;
}

export async function getDayClose(db: DbClient, course: Course, date: string) {
  const expected = await expectedFor(db, course, date);
  const { rows } = await db.query(
    `SELECT d.*, u.name AS closed_by_name FROM day_closes d LEFT JOIN staff_users u ON u.id = d.closed_by
      WHERE d.course_id = $1 AND d.date = $2`,
    [course.id, date],
  );
  const r = rows[0];
  return {
    date,
    expected,
    close: r
      ? {
          // As counted at the time. Sales after the close show up in expected but not here.
          expectedCashCents: r.expected_cash_cents,
          countedCashCents: r.counted_cash_cents,
          overShortCents: r.counted_cash_cents - r.expected_cash_cents,
          note: r.note,
          closedBy: r.closed_by_name ?? null,
          closedAt: r.closed_at.toISOString(),
        }
      : null,
  };
}

/**
 * Closes a day: staff count the cash drawer and the difference from expected is kept. Once a
 * day is closed only a manager can close it again (say, after a recount).
 */
export async function closeDay(
  db: DbClient,
  course: Course,
  staff: { id?: string; isManager: boolean },
  date: string,
  input: { countedCashCents: number; note?: string | null },
) {
  dayRange(course, date);
  const expected = await expectedFor(db, course, date);
  const diff = input.countedCashCents - expected.cash;
  if (diff !== 0 && !input.note?.trim()) throw badRequest("note_required", "The drawer is over or short. Add a note saying why");
  const { rowCount } = await db.query(
    `INSERT INTO day_closes (course_id, date, expected, expected_cash_cents, counted_cash_cents, note, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (course_id, date) DO UPDATE SET expected = EXCLUDED.expected, expected_cash_cents = EXCLUDED.expected_cash_cents,
       counted_cash_cents = EXCLUDED.counted_cash_cents, note = EXCLUDED.note, closed_by = EXCLUDED.closed_by, closed_at = now()
     WHERE $8`,
    [course.id, date, JSON.stringify(expected), expected.cash, input.countedCashCents, input.note?.trim() || null, staff.id ?? null, staff.isManager],
  );
  if (!rowCount) throw conflict("already_closed", "This day is already closed. Ask a manager to close it again");
  return getDayClose(db, course, date);
}
