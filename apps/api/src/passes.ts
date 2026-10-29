import { accountForGolfer, listGiftCards } from "./accounts.ts";
import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { changePoints, loyaltyRates } from "./loyalty.ts";
import { useCardPayment } from "./payments.ts";
import { insertSale, type SalePaymentMethod } from "./pos.ts";
import { listRainChecks } from "./rainchecks.ts";

// Punch cards and season passes. Managers set up what the course sells; the pro shop sells one to
// a golfer's account (rung up as a pro shop sale) and uses it at check-in to pay for rounds.

export type PassKind = "punch_card" | "season_pass";

export interface PassType {
  id: string;
  name: string;
  kind: PassKind;
  priceCents: number;
  rounds: number | null;
  validDays: number | null;
  coversCart: boolean;
  active: boolean;
}

const toPassType = (r: any): PassType => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  priceCents: r.price_cents,
  rounds: r.rounds,
  validDays: r.valid_days,
  coversCart: r.covers_cart,
  active: r.active,
});

export async function listPassTypes(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT * FROM pass_types WHERE course_id = $1 ORDER BY active DESC, price_cents", [course.id]);
  return rows.map(toPassType);
}

function checkTerms(kind: PassKind, rounds: number | null | undefined) {
  if (kind === "punch_card" && !rounds) throw badRequest("rounds_required", "Say how many rounds the punch card is for");
  if (kind === "season_pass" && rounds) throw badRequest("no_rounds", "A season pass is unlimited rounds, so it doesn't take a number of rounds");
}

export async function createPassType(
  db: DbClient,
  course: Course,
  input: { name: string; kind: PassKind; priceCents: number; rounds?: number | null; validDays?: number | null; coversCart?: boolean },
) {
  checkTerms(input.kind, input.rounds);
  const { rows } = await db.query(
    `INSERT INTO pass_types (course_id, name, kind, price_cents, rounds, valid_days, covers_cart) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [course.id, input.name.trim(), input.kind, input.priceCents, input.rounds ?? null, input.validDays ?? null, input.coversCart ?? false],
  );
  return toPassType(rows[0]);
}

/** Changes what's sold from now on. Passes already sold keep the terms they were sold with. */
export async function updatePassType(
  db: DbClient,
  course: Course,
  id: string,
  patch: { name?: string; priceCents?: number; rounds?: number | null; validDays?: number | null; coversCart?: boolean; active?: boolean },
) {
  const { rows: current } = await db.query("SELECT * FROM pass_types WHERE id = $1 AND course_id = $2", [id, course.id]);
  if (!current[0]) throw notFound("Pass type");
  const next = { ...toPassType(current[0]), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as PassType;
  checkTerms(next.kind, next.rounds);
  const { rows } = await db.query(
    `UPDATE pass_types SET name = $3, price_cents = $4, rounds = $5, valid_days = $6, covers_cart = $7, active = $8 WHERE id = $1 AND course_id = $2 RETURNING *`,
    [id, course.id, next.name.trim(), next.priceCents, next.rounds, next.validDays, next.coversCart, next.active],
  );
  return toPassType(rows[0]);
}

const toGolferPass = (r: any, now = Date.now()) => {
  const roundsLeft = r.rounds_total === null ? null : r.rounds_total - r.rounds_used;
  const expired = !!r.expires_at && r.expires_at.getTime() <= now;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as PassKind,
    roundsTotal: r.rounds_total as number | null,
    roundsUsed: r.rounds_used as number,
    roundsLeft,
    coversCart: r.covers_cart as boolean,
    expiresAt: r.expires_at?.toISOString() ?? null,
    soldAt: r.created_at.toISOString(),
    status: r.status as "active" | "cancelled",
    /** Can pay for a round today. */
    usable: r.status === "active" && !expired && (roundsLeft === null || roundsLeft > 0),
  };
};

async function golferRow(db: DbClient, course: Course, golferId: string) {
  const { rows } = await db.query("SELECT id, name, loyalty_points FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [
    golferId,
    course.organizationId,
  ]);
  if (!rows[0]) throw notFound("Golfer account");
  return rows[0];
}

/** A golfer's passes and points, for their account page and for checkout. */
export async function getWallet(db: DbClient, course: Course, golferId: string) {
  const golfer = await golferRow(db, course, golferId);
  const { rows: passes } = await db.query("SELECT * FROM golfer_passes WHERE customer_id = $1 AND course_id = $2 ORDER BY created_at DESC", [golferId, course.id]);
  const { rows: ledger } = await db.query(
    `SELECT l.*, s.name AS staff_name FROM loyalty_ledger l LEFT JOIN staff_users s ON s.id = l.staff_user_id
      WHERE l.customer_id = $1 AND l.course_id = $2 ORDER BY l.created_at DESC LIMIT 30`,
    [golferId, course.id],
  );
  const rates = await loyaltyRates(db, course);
  const points = golfer.loyalty_points as number;
  return {
    passes: passes.map((p) => toGolferPass(p)),
    rainChecks: await listRainChecks(db, course, { golferId }),
    giftCards: (await listGiftCards(db, course, { golferId })).filter((g) => g.status === "active" && g.balanceCents > 0),
    houseAccount: await accountForGolfer(db, course, golferId),
    loyalty: {
      enabled: rates.pointsPerDollar > 0,
      points,
      ...rates,
      /** How many rewards the points cover right now. */
      rewardsAvailable: Math.floor(points / rates.rewardPoints),
      history: ledger.map((l) => ({
        change: l.change,
        balanceAfter: l.balance_after,
        reason: l.reason,
        note: l.note,
        staff: l.staff_name ?? null,
        at: l.created_at.toISOString(),
      })),
    },
  };
}

/** Sells a pass to a golfer: rung up as a pro shop sale on their account, then added to it. */
export async function sellPass(
  db: Db,
  course: Course,
  staffId: string | undefined,
  golferId: string,
  input: { passTypeId: string; paymentMethod: SalePaymentMethod; cardPaymentId?: string | null },
) {
  await golferRow(db, course, golferId);
  await withTransaction(db, async (client) => {
    const { rows } = await client.query("SELECT * FROM pass_types WHERE id = $1 AND course_id = $2", [input.passTypeId, course.id]);
    const type = rows[0];
    if (!type) throw notFound("Pass type");
    if (!type.active) throw badRequest("pass_type_inactive", `${type.name} is no longer sold`);
    const saleId = await insertSale(client, course, staffId, {
      lines: [{ description: type.name, unitCents: type.price_cents, quantity: 1, taxable: false, category: "Passes" }],
      paymentMethod: input.paymentMethod,
      golferId,
    });
    if (input.cardPaymentId) {
      if (input.paymentMethod !== "card") throw badRequest("not_card", "A card payment can only pay a sale rung up as card");
      await useCardPayment(client, course, input.cardPaymentId, type.price_cents, { saleId });
      await client.query("UPDATE sales SET card_payment_id = $2 WHERE id = $1", [saleId, input.cardPaymentId]);
    }
    await client.query(
      `INSERT INTO golfer_passes (course_id, customer_id, pass_type_id, name, kind, rounds_total, covers_cart, expires_at, sale_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END, $9, $10)`,
      [course.id, golferId, type.id, type.name, type.kind, type.rounds, type.covers_cart, type.valid_days, saleId, staffId ?? null],
    );
  });
  return getWallet(db, course, golferId);
}

/** Managers fix a pass, e.g. cancel one sold by mistake (refund the sale separately). */
export async function cancelPass(db: DbClient, course: Course, golferId: string, passId: string) {
  const { rowCount } = await db.query("UPDATE golfer_passes SET status = 'cancelled' WHERE id = $1 AND customer_id = $2 AND course_id = $3", [passId, golferId, course.id]);
  if (!rowCount) throw notFound("Pass");
  return getWallet(db, course, golferId);
}

/** Managers give or take points by hand, with a reason. */
export async function adjustPoints(db: Db, course: Course, staffId: string | undefined, golferId: string, change: number, note: string) {
  await golferRow(db, course, golferId);
  if (!note.trim()) throw badRequest("note_required", "Say why the points are changing");
  await withTransaction(db, (client) => changePoints(client, course, golferId, change, "adjust", { note: note.trim(), staffId }));
  return getWallet(db, course, golferId);
}

export async function getLoyaltySettings(db: DbClient, course: Course) {
  return loyaltyRates(db, course);
}

export async function saveLoyaltySettings(db: DbClient, course: Course, s: { pointsPerDollar: number; rewardPoints: number; rewardCents: number }) {
  await db.query("UPDATE courses SET loyalty_points_per_dollar = $2, loyalty_reward_points = $3, loyalty_reward_cents = $4 WHERE id = $1", [
    course.id,
    s.pointsPerDollar,
    s.rewardPoints,
    s.rewardCents,
  ]);
  return loyaltyRates(db, course);
}

/**
 * Pays for rounds with a golfer's pass at check-in. Each round covers one player's green fee (and
 * cart, if the pass includes it), at what this booking charges per player. A season pass covers
 * the holder only, so one round per check-in.
 */
export async function redeemPass(
  client: DbClient,
  course: Course,
  booking: { id: string; customerId: string; players: number; balanceCents: number; lines: { kind: string; code: string; totalCents: number; quantity: number }[] },
  use: { golferPassId: string; rounds: number },
  staffId: string | undefined,
) {
  const { rows } = await client.query("SELECT * FROM golfer_passes WHERE id = $1 AND course_id = $2 FOR UPDATE", [use.golferPassId, course.id]);
  const pass = rows[0];
  if (!pass || pass.customer_id !== booking.customerId) throw badRequest("not_their_pass", "That pass is on someone else's account");
  const view = toGolferPass(pass);
  if (!view.usable) throw conflict("pass_unusable", view.status === "cancelled" ? "That pass was cancelled" : view.roundsLeft === 0 ? "That punch card is used up" : "That pass has expired");
  if (use.rounds > booking.players) throw badRequest("too_many_rounds", `This group only has ${booking.players} players`);
  if (view.roundsLeft !== null && use.rounds > view.roundsLeft) throw conflict("not_enough_rounds", `Only ${view.roundsLeft} rounds left on the card`);
  if (view.kind === "season_pass" && use.rounds !== 1) throw badRequest("season_pass_holder_only", "A season pass covers the holder only");
  const sum = (pick: (l: { kind: string; code: string }) => boolean) => booking.lines.filter(pick).reduce((s, l) => s + l.totalCents, 0);
  const perPlayer = sum((l) => l.kind === "green_fee") / booking.players + (view.coversCart ? sum((l) => l.code === "gas_cart") / booking.players : 0);
  const covered = Math.min(booking.balanceCents, Math.round(perPlayer * use.rounds));
  await client.query("UPDATE golfer_passes SET rounds_used = rounds_used + $2 WHERE id = $1", [pass.id, view.kind === "punch_card" ? use.rounds : 0]);
  await client.query("INSERT INTO pass_uses (golfer_pass_id, booking_id, rounds, covered_cents, created_by) VALUES ($1, $2, $3, $4, $5)", [
    pass.id,
    booking.id,
    use.rounds,
    covered,
    staffId ?? null,
  ]);
  if (covered > 0) {
    await client.query("INSERT INTO booking_payments (booking_id, amount_cents, method, golfer_pass_id) VALUES ($1, $2, $3, $4)", [booking.id, covered, pass.kind, pass.id]);
  }
  return covered;
}

/** Spends points on money off the round at check-in, in whole rewards. */
export async function redeemPoints(client: DbClient, course: Course, booking: { id: string; customerId: string; balanceCents: number }, points: number, staffId: string | undefined) {
  const rates = await loyaltyRates(client, course);
  if (points % rates.rewardPoints !== 0) throw badRequest("whole_rewards", `Points are used ${rates.rewardPoints} at a time`);
  const { rows } = await client.query("SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE", [booking.customerId]);
  if ((rows[0]?.loyalty_points ?? 0) < points) throw conflict("not_enough_points", `The golfer only has ${rows[0]?.loyalty_points ?? 0} points`);
  const value = (points / rates.rewardPoints) * rates.rewardCents;
  if (value > booking.balanceCents) throw badRequest("too_many_points", "That's more off than the round costs. Use fewer points");
  await changePoints(client, course, booking.customerId, -points, "redeem", { bookingId: booking.id, staffId });
  if (value > 0) await client.query("INSERT INTO booking_payments (booking_id, amount_cents, method) VALUES ($1, $2, 'loyalty')", [booking.id, value]);
  return value;
}
