import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";

// Loyalty points. Golfers with an account earn points on what they spend (rounds and pro shop
// sales), at a rate the course sets; a set number of points is worth money off a round. Every
// change goes in a ledger, so a balance can always be explained.

export type PointsReason = "round" | "sale" | "redeem" | "adjust" | "refund";

export async function loyaltyRates(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT loyalty_points_per_dollar, loyalty_reward_points, loyalty_reward_cents FROM courses WHERE id = $1", [course.id]);
  return {
    /** 0 means loyalty is off. */
    pointsPerDollar: rows[0].loyalty_points_per_dollar as number,
    rewardPoints: rows[0].loyalty_reward_points as number,
    rewardCents: rows[0].loyalty_reward_cents as number,
  };
}

/** Adds (or takes away) points. A balance never goes below zero. */
export async function changePoints(
  client: DbClient,
  course: Course,
  customerId: string,
  change: number,
  reason: PointsReason,
  link: { bookingId?: string | undefined; saleId?: string | undefined; note?: string | undefined; staffId?: string | undefined } = {},
) {
  const { rows } = await client.query("SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
  const before = rows[0].loyalty_points as number;
  const balance = Math.max(0, before + change);
  // What actually changed, if taking points back would have gone below zero.
  change = balance - before;
  if (!change) return balance;
  await client.query("UPDATE customers SET loyalty_points = $2 WHERE id = $1", [customerId, balance]);
  await client.query(
    `INSERT INTO loyalty_ledger (course_id, customer_id, change, balance_after, reason, booking_id, sale_id, note, staff_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [course.id, customerId, change, balance, reason, link.bookingId ?? null, link.saleId ?? null, link.note ?? null, link.staffId ?? null],
  );
  return balance;
}

/** Points for money a golfer spent: whole dollars times the course's rate. */
export async function earnPoints(
  client: DbClient,
  course: Course,
  customerId: string,
  cents: number,
  reason: "round" | "sale",
  link: { bookingId?: string | undefined; saleId?: string | undefined; staffId?: string | undefined },
) {
  const { pointsPerDollar } = await loyaltyRates(client, course);
  const points = Math.floor(cents / 100) * pointsPerDollar;
  if (points > 0) await changePoints(client, course, customerId, points, reason, link);
  return points;
}

/** Takes back the points a sale earned, when it's refunded. */
export async function reverseSalePoints(client: DbClient, course: Course, saleId: string, staffId: string | undefined) {
  const { rows } = await client.query("SELECT customer_id, sum(change)::int AS points FROM loyalty_ledger WHERE sale_id = $1 AND reason = 'sale' GROUP BY customer_id", [saleId]);
  for (const r of rows) if (r.points > 0) await changePoints(client, course, r.customer_id, -r.points, "refund", { saleId, staffId });
}
