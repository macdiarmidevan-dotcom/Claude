import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest } from "./errors.ts";
import { report } from "./reports.ts";

// Labor cost: hours worked from the time clock and what they cost, against the revenue they
// supported. Hourly people are paid for the hours they punched, with overtime after 40 hours in
// a Monday to Sunday week at time and a half (the federal rule). Salaried people cost their
// yearly pay spread evenly over every day. Hours count on the day the punch started.

const OVERTIME_AFTER = 40;
const OVERTIME_RATE = 1.5;

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export async function laborReport(db: DbClient, course: Course, from: string, to: string) {
  const zone = course.timeZone;
  const start = DateTime.fromISO(from, { zone }).startOf("day");
  const end = DateTime.fromISO(to, { zone }).startOf("day").plus({ days: 1 });
  if (end <= start) throw badRequest("invalid_range", "from must be on or before to");
  const r = await report(db, course, from, to, 366);

  // Whole weeks around the range, so overtime counts hours earlier in the week too.
  const weekFrom = start.startOf("week");
  const weekTo = end.minus({ days: 1 }).endOf("week");
  const { rows: staff } = await db.query(
    `SELECT u.id, u.name, u.role, u.active, u.created_at, u.pay_type, u.pay_cents, et.name AS type
       FROM staff_users u LEFT JOIN employee_types et ON et.id = u.employee_type_id WHERE u.course_id = $1`,
    [course.id],
  );
  const { rows: punches } = await db.query(
    `SELECT staff_user_id AS staff, clock_in, clock_out FROM time_punches
      WHERE course_id = $1 AND clock_in >= $2 AND clock_in <= $3 AND clock_out IS NOT NULL ORDER BY clock_in`,
    [course.id, weekFrom.toJSDate(), weekTo.toJSDate()],
  );
  const { rows: open } = await db.query("SELECT count(*)::int AS n FROM time_punches WHERE course_id = $1 AND clock_out IS NULL", [course.id]);
  const { rows: shifts } = await db.query(
    `SELECT staff_user_id AS staff, SUM(EXTRACT(EPOCH FROM ends_at - starts_at) / 3600)::float AS hours
       FROM shifts WHERE course_id = $1 AND staff_user_id IS NOT NULL AND starts_at >= $2 AND starts_at < $3 GROUP BY 1`,
    [course.id, start.toJSDate(), end.toJSDate()],
  );
  const scheduled = new Map<string, number>(shifts.map((s) => [s.staff, s.hours]));

  type Person = { id: string; name: string; type: string; pay: { type: "hourly" | "salary"; cents: number } | null; hours: number; overtimeHours: number; scheduledHours: number; costCents: number };
  const people = new Map<string, Person>();
  for (const s of staff)
    people.set(s.id, {
      id: s.id,
      name: s.name,
      type: s.type ?? (s.role === "manager" ? "Management" : "No job set"),
      pay: s.pay_type ? { type: s.pay_type, cents: s.pay_cents } : null,
      hours: 0,
      overtimeHours: 0,
      scheduledHours: round1(scheduled.get(s.id) ?? 0),
      costCents: 0,
    });

  const days = new Map<string, { date: string; hours: number; costCents: number }>();
  for (let d = start; d < end; d = d.plus({ days: 1 })) days.set(d.toISODate()!, { date: d.toISODate()!, hours: 0, costCents: 0 });

  // Each person's week so far, so the hours past 40 are the overtime ones.
  const weekHours = new Map<string, number>();
  for (const p of punches) {
    const person = people.get(p.staff);
    if (!person) continue;
    const at = DateTime.fromJSDate(p.clock_in, { zone });
    const hours = (p.clock_out.getTime() - p.clock_in.getTime()) / 3_600_000;
    const key = `${p.staff}|${at.startOf("week").toISODate()}`;
    const before = weekHours.get(key) ?? 0;
    weekHours.set(key, before + hours);
    const day = days.get(at.toISODate()!);
    if (!day) continue;
    const hourly = person.pay?.type === "hourly";
    const overtime = hourly ? Math.max(0, before + hours - Math.max(before, OVERTIME_AFTER)) : 0;
    const cost = hourly ? Math.round(((hours - overtime) + overtime * OVERTIME_RATE) * person.pay!.cents) : 0;
    person.hours += hours;
    person.overtimeHours += overtime;
    person.costCents += cost;
    day.hours += hours;
    day.costCents += cost;
  }

  // Salaries count every day the account existed and is still active.
  for (const s of staff) {
    const person = people.get(s.id)!;
    if (person.pay?.type !== "salary" || !s.active) continue;
    const created = DateTime.fromJSDate(s.created_at, { zone }).toISODate()!;
    for (const day of days.values()) {
      if (day.date < created) continue;
      const cents = person.pay.cents / 365;
      person.costCents += cents;
      day.costCents += cents;
    }
  }

  const list = [...people.values()].filter((p) => p.hours > 0 || p.scheduledHours > 0 || (p.costCents > 0 && p.pay?.type === "salary"));
  const revenueByDay = new Map(r.days.map((d) => [d.date, d.greenFeesCents + d.cartsAndExtrasCents + d.proShopCents + d.foodBevCents + d.eventsCents]));
  const hours = list.reduce((s, p) => s + p.hours, 0);
  const overtimeHours = list.reduce((s, p) => s + p.overtimeHours, 0);
  const costCents = Math.round(list.reduce((s, p) => s + p.costCents, 0));
  const salaryCents = Math.round(list.filter((p) => p.pay?.type === "salary").reduce((s, p) => s + p.costCents, 0));
  const overtimeCents = Math.round(list.reduce((s, p) => s + (p.pay?.type === "hourly" ? p.overtimeHours * OVERTIME_RATE * p.pay.cents : 0), 0));
  const revenueCents = r.revenue.totalCents;
  const rounds = r.rounds.booked;

  const types = new Map<string, { type: string; people: number; hours: number; costCents: number }>();
  for (const p of list) {
    const t = types.get(p.type) ?? { type: p.type, people: 0, hours: 0, costCents: 0 };
    t.people += 1;
    t.hours += p.hours;
    t.costCents += p.costCents;
    types.set(p.type, t);
  }

  return {
    from,
    to,
    overtimeRule: { afterHours: OVERTIME_AFTER, rate: OVERTIME_RATE },
    totals: {
      hours: round1(hours),
      overtimeHours: round1(overtimeHours),
      scheduledHours: round1(list.reduce((s, p) => s + p.scheduledHours, 0)),
      costCents,
      hourlyCents: costCents - salaryCents,
      overtimeCents,
      salaryCents,
      revenueCents,
      laborPct: pct(costCents, revenueCents),
      revenuePerHourCents: hours ? Math.round(revenueCents / hours) : null,
      rounds,
      roundsPerHour: hours ? Math.round((rounds / hours) * 10) / 10 : null,
    },
    byType: [...types.values()].map((t) => ({ ...t, hours: round1(t.hours), costCents: Math.round(t.costCents) })).sort((a, b) => b.costCents - a.costCents),
    people: list
      .map((p) => ({ ...p, hours: round1(p.hours), overtimeHours: round1(p.overtimeHours), costCents: Math.round(p.costCents), missingPay: !p.pay && p.hours > 0 }))
      .sort((a, b) => b.costCents - a.costCents || b.hours - a.hours),
    days: [...days.values()].map((d) => {
      const revenue = revenueByDay.get(d.date) ?? 0;
      return { date: d.date, hours: round1(d.hours), costCents: Math.round(d.costCents), revenueCents: revenue, laborPct: pct(d.costCents, revenue) };
    }),
    missingPay: list.filter((p) => !p.pay && p.hours > 0).length,
    openPunches: open[0].n,
  };
}
