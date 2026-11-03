import { DateTime } from "luxon";
import type { Departments } from "./analytics.ts";
import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest } from "./errors.ts";

// Monthly revenue budgets by department, for the revenue dashboard's "vs budget". Managers set
// a budget per month; a stretch of days gets each month's budget prorated by the days it covers
// (10 days of a 30-day month get a third of it). A month with no budget counts as none, not zero.

export type BudgetMonth = Omit<Departments, "totalCents">;
const KEYS = ["greenFeesCents", "cartsAndExtrasCents", "proShopCents", "foodBevCents", "eventsCents"] as const;
const COLUMNS: Record<(typeof KEYS)[number], string> = {
  greenFeesCents: "green_fees_cents",
  cartsAndExtrasCents: "carts_and_extras_cents",
  proShopCents: "pro_shop_cents",
  foodBevCents: "food_bev_cents",
  eventsCents: "events_cents",
};

const total = (m: BudgetMonth) => KEYS.reduce((s, k) => s + m[k], 0);
const fromRow = (r: Record<string, number>): BudgetMonth => Object.fromEntries(KEYS.map((k) => [k, r[COLUMNS[k]]])) as BudgetMonth;

async function months(db: DbClient, course: Course, first: string, last: string) {
  const { rows } = await db.query(
    `SELECT to_char(month, 'YYYY-MM') AS month, ${Object.values(COLUMNS).join(", ")} FROM revenue_budgets
      WHERE course_id = $1 AND month >= $2::date AND month <= $3::date ORDER BY month`,
    [course.id, `${first}-01`, `${last}-01`],
  );
  return new Map(rows.map((r) => [r.month as string, fromRow(r)]));
}

/** A year's budget, month by month. Months without a budget come back with set: false. */
export async function getBudget(db: DbClient, course: Course, year: number) {
  const saved = await months(db, course, `${year}-01`, `${year}-12`);
  return {
    year,
    months: Array.from({ length: 12 }, (_, i) => {
      const month = `${year}-${String(i + 1).padStart(2, "0")}`;
      const m = saved.get(month);
      const values = m ?? (Object.fromEntries(KEYS.map((k) => [k, 0])) as BudgetMonth);
      return { month, set: !!m, ...values, totalCents: total(values) };
    }),
  };
}

/** Saves budgets for some months. A month with every department at zero clears its budget. */
export async function saveBudget(db: DbClient, course: Course, staffId: string | undefined, input: (BudgetMonth & { month: string })[]) {
  if (!input.length) throw badRequest("no_months", "Send at least one month");
  const years = new Set(input.map((m) => m.month.slice(0, 4)));
  if (years.size > 1) throw badRequest("one_year", "Save one year's budget at a time");
  for (const m of input) {
    if (total(m) === 0) {
      await db.query("DELETE FROM revenue_budgets WHERE course_id = $1 AND month = $2::date", [course.id, `${m.month}-01`]);
      continue;
    }
    await db.query(
      `INSERT INTO revenue_budgets (course_id, month, ${Object.values(COLUMNS).join(", ")}, updated_by)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (course_id, month) DO UPDATE SET ${Object.values(COLUMNS)
         .map((c) => `${c} = EXCLUDED.${c}`)
         .join(", ")}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [course.id, `${m.month}-01`, ...KEYS.map((k) => m[k]), staffId ?? null],
    );
  }
  return getBudget(db, course, Number([...years][0]));
}

/**
 * The budget for a stretch of local dates (inclusive), prorated by day, or null when no month in
 * it has a budget. Each month also says its daily share, for budget lines on a trend chart.
 */
export async function budgetFor(db: DbClient, course: Course, from: string, to: string) {
  const a = DateTime.fromISO(from);
  const b = DateTime.fromISO(to);
  const saved = await months(db, course, from.slice(0, 7), to.slice(0, 7));
  if (!saved.size) return null;
  const revenue: Departments = { greenFeesCents: 0, cartsAndExtrasCents: 0, proShopCents: 0, foodBevCents: 0, eventsCents: 0, totalCents: 0 };
  const list: { month: string; daysInMonth: number; daysInRange: number; totalCents: number }[] = [];
  for (let m = a.startOf("month"); m <= b; m = m.plus({ months: 1 })) {
    const month = m.toFormat("yyyy-MM");
    const budget = saved.get(month);
    if (!budget) continue;
    const first = DateTime.max(m, a);
    const last = DateTime.min(m.endOf("month").startOf("day"), b);
    const daysInRange = last.diff(first, "days").days + 1;
    const daysInMonth = m.daysInMonth!;
    for (const k of KEYS) revenue[k] += Math.round((budget[k] * daysInRange) / daysInMonth);
    list.push({ month, daysInMonth, daysInRange, totalCents: total(budget) });
  }
  revenue.totalCents = KEYS.reduce((s, k) => s + revenue[k], 0);
  return { revenue, months: list };
}
