import { randomInt } from "node:crypto";
import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { getBooking } from "./bookings.ts";

// Rain checks and refunds on rounds. When weather cuts a round short, the pro shop either gives the
// group credit for the holes they didn't play (a rain check, used on a later round) or gives the
// money back. Both take that amount off the original round, so revenue stays honest.

// No 0/O or 1/I, so a code read aloud or off a receipt is hard to get wrong.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => "RC-" + Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

export interface RainCheck {
  id: string;
  code: string;
  bookingId: string;
  golferId: string | null;
  name: string;
  players: number;
  holesUnplayed: number;
  amountCents: number;
  remainingCents: number;
  expiresAt: string | null;
  status: "active" | "void";
  note: string | null;
  issuedBy: string | null;
  issuedAt: string;
  /** Can pay for a round today. */
  usable: boolean;
}

const SELECT = `SELECT r.*, u.name AS issued_by_name FROM rain_checks r LEFT JOIN staff_users u ON u.id = r.issued_by`;

const toRainCheck = (r: any): RainCheck => {
  const expired = !!r.expires_at && r.expires_at.getTime() <= Date.now();
  return {
    id: r.id,
    code: r.code,
    bookingId: r.booking_id,
    golferId: r.customer_id,
    name: r.name,
    players: r.players,
    holesUnplayed: r.holes_unplayed,
    amountCents: r.amount_cents,
    remainingCents: r.remaining_cents,
    expiresAt: r.expires_at?.toISOString() ?? null,
    status: r.status,
    note: r.note,
    issuedBy: r.issued_by_name ?? null,
    issuedAt: r.created_at.toISOString(),
    usable: r.status === "active" && !expired && r.remaining_cents > 0,
  };
};

/** What the round can still give back: what's been paid toward it, less any credit already given. */
async function roundMoney(client: DbClient, course: Course, id: string) {
  const booking = await getBooking(client, course, id);
  if (booking.status !== "checked_in" && booking.status !== "teed_off") throw conflict("invalid_status", "Only groups that have checked in can get a rain check or refund");
  const sum = (pick: (l: (typeof booking.lines)[number]) => boolean) => booking.lines.filter(pick).reduce((s, l) => s + l.totalCents, 0);
  return {
    booking,
    green: sum((l) => l.kind === "green_fee" && l.totalCents > 0),
    carts: sum((l) => l.code === "gas_cart" && l.totalCents > 0),
    // Paid by anything but an earlier rain check: credit for credit would never run out.
    givable: Math.min(booking.totalCents, booking.payment.paidCents),
  };
}

/** Takes an amount off the round as its own line, so reports count the round at what it ended up costing. */
async function creditRound(client: DbClient, bookingId: string, description: string, green: number, cart: number) {
  for (const [kind, code, cents] of [["green_fee", "credit", green], ["add_on", "gas_cart_credit", cart]] as const) {
    if (cents <= 0) continue;
    await client.query(
      `INSERT INTO booking_lines (booking_id, kind, code, description, quantity, unit_cents, total_cents) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
      [bookingId, kind, code, description, -cents],
    );
  }
  await client.query("UPDATE bookings SET total_cents = total_cents - $2 WHERE id = $1", [bookingId, green + cart]);
}

/** What the unplayed holes are worth for some of the group: green fees, and carts when asked. */
function unplayedValue(m: { green: number; carts: number; booking: { players: number; holes: number } }, players: number, holesPlayed: number, includeCart: boolean) {
  const share = (players / m.booking.players) * ((m.booking.holes - holesPlayed) / m.booking.holes);
  return { green: Math.round(m.green * share), cart: includeCart ? Math.round(m.carts * share) : 0 };
}

export async function issueRainCheck(
  db: Db,
  course: Course,
  staffId: string | undefined,
  bookingId: string,
  input: { players: number; holesPlayed: number; includeCart?: boolean; amountCents?: number; note?: string | null },
): Promise<RainCheck> {
  return withTransaction(db, async (client) => {
    await client.query("SELECT 1 FROM bookings WHERE id = $1 AND course_id = $2 FOR UPDATE", [bookingId, course.id]);
    const m = await roundMoney(client, course, bookingId);
    if (input.players > m.booking.players) throw badRequest("too_many_players", `This group only has ${m.booking.players} players`);
    if (input.holesPlayed >= m.booking.holes) throw badRequest("round_finished", "They played every hole, so there's nothing to credit");
    let { green, cart } = unplayedValue(m, input.players, input.holesPlayed, input.includeCart ?? true);
    if (input.amountCents !== undefined) {
      // A set amount, e.g. the course's flat rain check policy. Split like the calculated one.
      const calc = green + cart;
      cart = calc ? Math.round((input.amountCents * cart) / calc) : 0;
      green = input.amountCents - cart;
    }
    const amount = green + cart;
    if (amount <= 0) throw badRequest("nothing_to_credit", "That comes to nothing");
    if (amount > m.givable) throw conflict("too_much", `Only ${m.givable} cents is left on this round to give back`);
    const { rows: c } = await client.query(
      `SELECT CASE WHEN cu.account_created_at IS NOT NULL THEN cu.id END AS golfer_id, cu.name, co.rain_check_days
         FROM bookings b JOIN customers cu ON cu.id = b.customer_id JOIN courses co ON co.id = b.course_id WHERE b.id = $1`,
      [bookingId],
    );
    let code = newCode();
    while ((await client.query("SELECT 1 FROM rain_checks WHERE course_id = $1 AND code = $2", [course.id, code])).rows.length) code = newCode();
    const { rows } = await client.query(
      `INSERT INTO rain_checks (course_id, code, booking_id, customer_id, name, players, holes_unplayed, amount_cents, remaining_cents, expires_at, note, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, now() + make_interval(days => $9::int), $10, $11) RETURNING id`,
      [course.id, code, bookingId, c[0].golfer_id, c[0].name, input.players, m.booking.holes - input.holesPlayed, amount, c[0].rain_check_days, input.note?.trim() || null, staffId ?? null],
    );
    await creditRound(client, bookingId, `Rain check ${code}`, green, cart);
    return getRainCheck(client, course, rows[0].id);
  });
}

async function getRainCheck(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`${SELECT} WHERE r.id = $1 AND r.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("Rain check");
  return toRainCheck(rows[0]);
}

export async function findRainCheck(db: DbClient, course: Course, code: string) {
  const { rows } = await db.query(`${SELECT} WHERE r.course_id = $1 AND r.code = $2`, [course.id, code.trim().toUpperCase()]);
  if (!rows[0]) throw notFound("Rain check");
  return toRainCheck(rows[0]);
}

/** Rain checks issued for a booking or held by a golfer, newest first. */
export async function listRainChecks(db: DbClient, course: Course, filter: { bookingId?: string; golferId?: string }) {
  const { rows } = await db.query(
    `${SELECT} WHERE r.course_id = $1 AND ($2::uuid IS NULL OR r.booking_id = $2) AND ($3::uuid IS NULL OR r.customer_id = $3) ORDER BY r.created_at DESC LIMIT 100`,
    [course.id, filter.bookingId ?? null, filter.golferId ?? null],
  );
  return rows.map(toRainCheck);
}

/** Managers void one issued by mistake. Only an unused one, so the round's credit can be put back. */
export async function voidRainCheck(db: Db, course: Course, id: string) {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query("SELECT * FROM rain_checks WHERE id = $1 AND course_id = $2 FOR UPDATE", [id, course.id]);
    const r = rows[0];
    if (!r) throw notFound("Rain check");
    if (r.status === "void") throw conflict("already_void", "This rain check is already void");
    if (r.remaining_cents !== r.amount_cents) throw conflict("already_used", "Part of this rain check has been used, so it can't be voided");
    await client.query("UPDATE rain_checks SET status = 'void' WHERE id = $1", [id]);
    const { rows: credit } = await client.query("DELETE FROM booking_lines WHERE booking_id = $1 AND description = $2 RETURNING total_cents", [r.booking_id, `Rain check ${r.code}`]);
    const back = -credit.reduce((s, l) => s + l.total_cents, 0);
    await client.query("UPDATE bookings SET total_cents = total_cents + $2 WHERE id = $1", [r.booking_id, back]);
  });
  return getRainCheck(db, course, id);
}

/**
 * Pays toward a round with a rain check at check-in, up to what's left on it or what the round
 * costs. Called inside check-in's transaction.
 */
export async function redeemRainCheck(client: DbClient, course: Course, booking: { id: string; balanceCents: number }, code: string, staffId: string | undefined) {
  const { rows } = await client.query("SELECT * FROM rain_checks WHERE course_id = $1 AND code = $2 FOR UPDATE", [course.id, code.trim().toUpperCase()]);
  if (!rows[0]) throw notFound("Rain check");
  const r = toRainCheck(rows[0]);
  if (!r.usable) throw conflict("rain_check_unusable", r.status === "void" ? "That rain check was voided" : r.remainingCents === 0 ? "That rain check has been used up" : "That rain check has expired");
  if (r.bookingId === booking.id) throw badRequest("same_round", "A rain check is for a later round");
  const amount = Math.min(r.remainingCents, booking.balanceCents);
  if (amount <= 0) return 0;
  await client.query("UPDATE rain_checks SET remaining_cents = remaining_cents - $2 WHERE id = $1", [r.id, amount]);
  await client.query("INSERT INTO booking_payments (booking_id, amount_cents, method, rain_check_id, staff_user_id) VALUES ($1, $2, 'rain_check', $3, $4)", [
    booking.id,
    amount,
    r.id,
    staffId ?? null,
  ]);
  return amount;
}

/**
 * Gives money back on a round, by cash or back to the card it was paid with. The refund is a
 * negative payment on today's date (so the drawer and money taken net it out) and the same amount
 * comes off the round.
 */
export async function refundRound(
  db: Db,
  course: Course,
  staffId: string | undefined,
  bookingId: string,
  input: { amountCents: number; method: "cash" | "card"; reason: string },
  refundCard: (client: DbClient, cardPaymentId: string, cents: number) => Promise<unknown>,
) {
  if (!input.reason.trim()) throw badRequest("reason_required", "Say why the round is being refunded");
  await withTransaction(db, async (client) => {
    await client.query("SELECT 1 FROM bookings WHERE id = $1 AND course_id = $2 FOR UPDATE", [bookingId, course.id]);
    const m = await roundMoney(client, course, bookingId);
    const { rows: paid } = await client.query(
      `SELECT method, SUM(amount_cents)::int AS cents FROM booking_payments WHERE booking_id = $1 AND method IN ('cash', 'card') GROUP BY 1`,
      [bookingId],
    );
    const inMethod = paid.find((p) => p.method === input.method)?.cents ?? 0;
    if (input.amountCents > Math.min(m.givable, inMethod)) {
      throw conflict("too_much", `Only ${Math.min(m.givable, inMethod)} cents paid by ${input.method} can be refunded on this round`);
    }
    let cardPaymentId: string | null = null;
    if (input.method === "card") {
      // Back to the card on the reader if it went through one; otherwise staff run it on their terminal.
      const { rows } = await client.query(
        `SELECT card_payment_id FROM booking_payments WHERE booking_id = $1 AND card_payment_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [bookingId],
      );
      cardPaymentId = rows[0]?.card_payment_id ?? null;
      if (cardPaymentId) await refundCard(client, cardPaymentId, input.amountCents);
    }
    await client.query(
      "INSERT INTO booking_payments (booking_id, amount_cents, method, card_payment_id, note, staff_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [bookingId, -input.amountCents, input.method, cardPaymentId, input.reason.trim(), staffId ?? null],
    );
    const cartShare = m.green + m.carts ? Math.round((input.amountCents * m.carts) / (m.green + m.carts)) : 0;
    await creditRound(client, bookingId, `Refund: ${input.reason.trim()}`, input.amountCents - cartShare, cartShare);
  });
  return getBooking(db, course, bookingId);
}

export async function getRainCheckDays(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT rain_check_days FROM courses WHERE id = $1", [course.id]);
  return { rainCheckDays: rows[0].rain_check_days as number };
}

export async function saveRainCheckDays(db: DbClient, course: Course, days: number) {
  await db.query("UPDATE courses SET rain_check_days = $2 WHERE id = $1", [course.id, days]);
  return { rainCheckDays: days };
}
