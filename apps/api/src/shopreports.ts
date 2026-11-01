import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest } from "./errors.ts";
import { report } from "./reports.ts";

// Two manager reports: pro shop inventory (what sold, at what margin, what's on the shelf, what
// to reorder and what went missing) and payments and balances (money taken by tender, and the
// money the course holds for golfers or is owed by them right now).

function range(course: Course, from: string, to: string) {
  const start = DateTime.fromISO(from, { zone: course.timeZone }).startOf("day");
  const end = DateTime.fromISO(to, { zone: course.timeZone }).startOf("day").plus({ days: 1 });
  if (!start.isValid || !end.isValid || end <= start) throw badRequest("invalid_range", "from must be on or before to");
  if (end.diff(start, "days").days > 366) throw badRequest("invalid_range", "Ask for 366 days or fewer at a time");
  return [start.toJSDate(), end.toJSDate()] as const;
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export async function inventoryReport(db: DbClient, course: Course, from: string, to: string) {
  const [start, end] = range(course, from, to);
  // Sales by product. Cost is the product's cost now, since sales don't keep the cost at the time.
  const { rows: sold } = await db.query(
    `SELECT l.product_id AS id, MAX(l.description) AS name, MAX(l.category) AS category, BOOL_OR(l.food_bev) AS food_bev,
            SUM(l.quantity)::int AS units, SUM(l.total_cents)::int AS cents, MAX(p.cost_cents) AS cost_cents
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id LEFT JOIN products p ON p.id = l.product_id
      WHERE s.course_id = $1 AND s.status = 'completed' AND s.created_at >= $2 AND s.created_at < $3
      GROUP BY l.product_id, CASE WHEN l.product_id IS NULL THEN l.description END`,
    [course.id, start, end],
  );
  const { rows: products } = await db.query(
    `SELECT id, name, sku, category, price_cents, cost_cents, stock, reorder_level, food_bev, created_at
       FROM products WHERE course_id = $1 AND active AND track_stock ORDER BY lower(name)`,
    [course.id],
  );
  const { rows: shrinkRows } = await db.query(
    `SELECT m.product_id AS id, SUM(m.change)::int AS units, SUM(m.change * COALESCE(p.cost_cents, 0))::bigint AS cost
       FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE p.course_id = $1 AND m.reason IN ('count', 'adjust') AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1`,
    [course.id, start, end],
  );

  const items = sold.map((s) => {
    const costCents = s.cost_cents == null ? null : s.cost_cents * s.units;
    return {
      productId: s.id as string | null,
      name: s.name as string,
      category: s.category as string,
      foodBev: s.food_bev as boolean,
      units: s.units as number,
      revenueCents: s.cents as number,
      costCents,
      marginCents: costCents == null ? null : s.cents - costCents,
      marginPct: costCents == null ? null : pct(s.cents - costCents, s.cents),
    };
  });
  items.sort((a, b) => b.revenueCents - a.revenueCents);
  const withCost = items.filter((i) => i.costCents != null);
  const categories = new Map<string, { category: string; foodBev: boolean; units: number; revenueCents: number; costCents: number; costedRevenueCents: number }>();
  for (const i of items) {
    const c = categories.get(i.category) ?? { category: i.category, foodBev: i.foodBev, units: 0, revenueCents: 0, costCents: 0, costedRevenueCents: 0 };
    c.units += i.units;
    c.revenueCents += i.revenueCents;
    if (i.costCents != null) {
      c.costCents += i.costCents;
      c.costedRevenueCents += i.revenueCents;
    }
    categories.set(i.category, c);
  }
  const soldUnits = new Map(items.filter((i) => i.productId).map((i) => [i.productId!, i.units]));
  const shrink = new Map(shrinkRows.map((s) => [s.id, s]));
  const onHand = products.filter((p) => p.stock > 0);
  const revenueCents = items.reduce((s, i) => s + i.revenueCents, 0);
  const costedRevenue = withCost.reduce((s, i) => s + i.revenueCents, 0);
  const costCents = withCost.reduce((s, i) => s + i.costCents!, 0);

  return {
    from,
    to,
    sales: {
      revenueCents,
      units: items.reduce((s, i) => s + i.units, 0),
      costCents,
      marginCents: costedRevenue - costCents,
      // Margin over the sales whose products have a cost set, so missing costs don't inflate it.
      marginPct: pct(costedRevenue - costCents, costedRevenue),
      uncostedRevenueCents: revenueCents - costedRevenue,
    },
    categories: [...categories.values()]
      .map((c) => ({ category: c.category, foodBev: c.foodBev, units: c.units, revenueCents: c.revenueCents, marginPct: pct(c.costedRevenueCents - c.costCents, c.costedRevenueCents) }))
      .sort((a, b) => b.revenueCents - a.revenueCents),
    items,
    stock: {
      products: products.length,
      units: onHand.reduce((s, p) => s + p.stock, 0),
      costCents: onHand.reduce((s, p) => s + p.stock * (p.cost_cents ?? 0), 0),
      retailCents: onHand.reduce((s, p) => s + p.stock * p.price_cents, 0),
      missingCost: onHand.filter((p) => p.cost_cents == null).length,
    },
    reorder: products
      .filter((p) => p.stock <= p.reorder_level || p.stock <= 0)
      .map((p) => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, stock: p.stock, reorderLevel: p.reorder_level, soldInPeriod: soldUnits.get(p.id) ?? 0 }))
      .sort((a, b) => a.stock - b.stock || b.soldInPeriod - a.soldInPeriod),
    // On the shelf for the whole period and nothing sold.
    slowMovers: onHand
      .filter((p) => !soldUnits.has(p.id) && p.created_at < start)
      .map((p) => ({ id: p.id, name: p.name, category: p.category, stock: p.stock, costCents: p.cost_cents == null ? null : p.stock * p.cost_cents, retailCents: p.stock * p.price_cents }))
      .sort((a, b) => b.retailCents - a.retailCents),
    // Counts and adjustments: negative is stock that went missing (or was damaged), positive was found.
    shrink: products
      .filter((p) => shrink.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, units: shrink.get(p.id).units as number, costCents: Number(shrink.get(p.id).cost) }))
      .filter((s) => s.units !== 0)
      .sort((a, b) => a.costCents - b.costCents),
  };
}

export async function balancesReport(db: DbClient, course: Course, from: string, to: string) {
  const [start, end] = range(course, from, to);
  const r = await report(db, course, from, to, 366);
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0];

  const gift = await one(
    `SELECT count(*) FILTER (WHERE balance_cents > 0)::int AS cards, COALESCE(SUM(balance_cents), 0)::int AS cents
       FROM gift_cards WHERE course_id = $1 AND status = 'active'`,
    [course.id],
  );
  const giftFlow = await one(
    `SELECT COALESCE(SUM(e.change_cents) FILTER (WHERE e.kind IN ('sold', 'reload')), 0)::int AS sold,
            COALESCE(-SUM(e.change_cents) FILTER (WHERE e.kind = 'redeem'), 0)::int AS redeemed
       FROM gift_card_entries e JOIN gift_cards g ON g.id = e.gift_card_id
      WHERE g.course_id = $1 AND e.created_at >= $2 AND e.created_at < $3`,
    [course.id, start, end],
  );
  const { rows: accounts } = await db.query(
    `SELECT a.id, c.name, a.credit_limit_cents AS limit_cents, a.status,
            COALESCE((SELECT SUM(amount_cents) FROM house_entries e WHERE e.house_account_id = a.id), 0)::int AS balance
       FROM house_accounts a JOIN customers c ON c.id = a.customer_id WHERE a.course_id = $1 AND a.status <> 'closed'`,
    [course.id],
  );
  const houseFlow = await one(
    `SELECT COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind = 'charge'), 0)::int AS charged,
            COALESCE(-SUM(e.amount_cents) FILTER (WHERE e.kind = 'payment'), 0)::int AS paid
       FROM house_entries e JOIN house_accounts a ON a.id = e.house_account_id
      WHERE a.course_id = $1 AND e.created_at >= $2 AND e.created_at < $3`,
    [course.id, start, end],
  );
  const rain = await one(
    `SELECT count(*) FILTER (WHERE expires_at IS NULL OR expires_at > now())::int AS open,
            COALESCE(SUM(remaining_cents) FILTER (WHERE expires_at IS NULL OR expires_at > now()), 0)::int AS cents,
            COALESCE(SUM(remaining_cents) FILTER (WHERE expires_at <= now()), 0)::int AS expired
       FROM rain_checks WHERE course_id = $1 AND status = 'active' AND remaining_cents > 0`,
    [course.id],
  );
  // Punch card rounds left, valued at what each round cost on the card when its price is known.
  const punch = await one(
    `SELECT count(*)::int AS cards, COALESCE(SUM(g.rounds_total - g.rounds_used), 0)::int AS rounds,
            COALESCE(SUM((g.rounds_total - g.rounds_used) * t.price_cents::numeric / NULLIF(t.rounds, 0)), 0)::int AS cents,
            count(*) FILTER (WHERE t.price_cents IS NULL)::int AS unpriced
       FROM golfer_passes g LEFT JOIN pass_types t ON t.id = g.pass_type_id
      WHERE g.course_id = $1 AND g.status = 'active' AND g.kind = 'punch_card' AND g.rounds_total > g.rounds_used
        AND (g.expires_at IS NULL OR g.expires_at > now())`,
    [course.id],
  );
  const season = await one(
    `SELECT count(*)::int AS passes FROM golfer_passes WHERE course_id = $1 AND status = 'active' AND kind = 'season_pass' AND (expires_at IS NULL OR expires_at > now())`,
    [course.id],
  );
  const loyalty = await one(
    `SELECT COALESCE(SUM(c.loyalty_points), 0)::int AS points, count(*) FILTER (WHERE c.loyalty_points > 0)::int AS golfers,
            MAX(co.loyalty_reward_points) AS per, MAX(co.loyalty_reward_cents) AS worth
       FROM customers c JOIN courses co ON co.id = $1 WHERE c.organization_id = co.organization_id`,
    [course.id],
  );

  const owed = accounts.filter((a) => a.balance > 0);
  const giftCents = gift.cents;
  const loyaltyCents = loyalty.per ? Math.round((loyalty.points / loyalty.per) * loyalty.worth) : 0;
  return {
    from,
    to,
    collected: r.collected,
    other: r.other,
    // Money the course holds that golfers can still spend: it owes them rounds or goods.
    held: {
      giftCards: { cards: gift.cards, cents: giftCents, soldInPeriodCents: giftFlow.sold, redeemedInPeriodCents: giftFlow.redeemed },
      rainChecks: { open: rain.open, cents: rain.cents, expiredCents: rain.expired },
      punchCards: { cards: punch.cards, roundsLeft: punch.rounds, cents: punch.cents, unpriced: punch.unpriced },
      seasonPasses: { active: season.passes },
      loyalty: { golfers: loyalty.golfers, points: loyalty.points, cents: loyaltyCents },
      totalCents: giftCents + rain.cents + punch.cents + loyaltyCents,
    },
    // Money golfers owe the course on house accounts.
    receivable: {
      accounts: owed.length,
      cents: owed.reduce((s, a) => s + a.balance, 0),
      creditCents: -accounts.filter((a) => a.balance < 0).reduce((s, a) => s + a.balance, 0),
      chargedInPeriodCents: houseFlow.charged,
      paidInPeriodCents: houseFlow.paid,
      overLimit: owed.filter((a) => a.limit_cents != null && a.balance > a.limit_cents).length,
      largest: owed
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10)
        .map((a) => ({ id: a.id, name: a.name, balanceCents: a.balance, limitCents: a.limit_cents, status: a.status })),
    },
  };
}
