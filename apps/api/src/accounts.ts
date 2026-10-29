import { randomInt } from "node:crypto";
import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { useCardPayment } from "./payments.ts";

// Gift cards and house accounts. A gift card is money held for the golfer: selling one is money
// taken but not revenue, and the revenue counts when it's spent. A house account is the other way
// round: rounds, food and pro shop items are charged now and paid when the monthly statement is.

// ---------------------------------------------------------------------------------------------
// Gift cards

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => {
  const part = () => Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
  return `GC-${part()}-${part()}`;
};
const cleanCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

const toGiftCard = (r: any) => ({
  id: r.id,
  code: r.code,
  initialCents: r.initial_cents,
  balanceCents: r.balance_cents,
  golfer: r.customer_id ? { id: r.customer_id, name: r.golfer_name ?? null } : null,
  recipientName: r.recipient_name,
  status: r.status as "active" | "void",
  issuedBy: r.issued_by_name ?? null,
  createdAt: r.created_at.toISOString(),
});

const giftCardSelect = `SELECT g.*, c.name AS golfer_name, u.name AS issued_by_name FROM gift_cards g
  LEFT JOIN customers c ON c.id = g.customer_id LEFT JOIN staff_users u ON u.id = g.issued_by`;

async function addEntry(
  client: DbClient,
  cardId: string,
  change: number,
  kind: "sold" | "reload" | "redeem" | "adjust" | "void",
  extra: { method?: string | null; cardPaymentId?: string | null; saleId?: string | null; bookingId?: string | null; note?: string | null; staffId?: string | undefined } = {},
) {
  const { rows } = await client.query("UPDATE gift_cards SET balance_cents = balance_cents + $2 WHERE id = $1 RETURNING balance_cents", [cardId, change]);
  await client.query(
    `INSERT INTO gift_card_entries (gift_card_id, change_cents, balance_after, kind, method, card_payment_id, sale_id, booking_id, note, staff_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [cardId, change, rows[0].balance_cents, kind, extra.method ?? null, extra.cardPaymentId ?? null, extra.saleId ?? null, extra.bookingId ?? null, extra.note ?? null, extra.staffId ?? null],
  );
}

export type GiftCardMethod = "card" | "cash" | "check" | "comp";

/** Sells a new gift card, or puts more on one. The money taken counts under how it was paid. */
export async function sellGiftCard(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { amountCents: number; method: GiftCardMethod; cardPaymentId?: string | null; golferId?: string | null; recipientName?: string | null; code?: string | null; note?: string | null },
) {
  if (input.cardPaymentId && input.method !== "card") throw badRequest("not_card", "A card payment can only pay for a gift card sold by card");
  const id = await withTransaction(db, async (client) => {
    if (input.golferId) {
      const { rows } = await client.query("SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [input.golferId, course.organizationId]);
      if (!rows[0]) throw notFound("Golfer account");
    }
    if (input.cardPaymentId) await useCardPayment(client, course, input.cardPaymentId, input.amountCents, {});
    const extra = { method: input.method, cardPaymentId: input.cardPaymentId, note: input.note?.trim() || null, staffId };
    if (input.code) {
      // Reloading a card the golfer already has.
      const { rows } = await client.query("SELECT * FROM gift_cards WHERE course_id = $1 AND code = $2 FOR UPDATE", [course.id, cleanCode(input.code)]);
      if (!rows[0]) throw notFound("Gift card");
      if (rows[0].status !== "active") throw conflict("gift_card_void", "That gift card was voided");
      await addEntry(client, rows[0].id, input.amountCents, "reload", extra);
      return rows[0].id as string;
    }
    for (let attempt = 0; ; attempt++) {
      const { rows } = await client.query(
        `INSERT INTO gift_cards (course_id, code, initial_cents, balance_cents, customer_id, recipient_name, issued_by)
         VALUES ($1, $2, $3, 0, $4, $5, $6) ON CONFLICT (course_id, code) DO NOTHING RETURNING id`,
        [course.id, newCode(), input.amountCents, input.golferId ?? null, input.recipientName?.trim() || null, staffId ?? null],
      );
      if (rows[0]) {
        await addEntry(client, rows[0].id, input.amountCents, "sold", extra);
        return rows[0].id as string;
      }
      if (attempt > 5) throw new Error("Couldn't make a unique gift card code");
    }
  });
  return getGiftCard(db, course, id);
}

export async function getGiftCard(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`${giftCardSelect} WHERE g.id = $1 AND g.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("Gift card");
  const { rows: entries } = await db.query(
    `SELECT e.*, u.name AS staff_name, s.number AS sale_number FROM gift_card_entries e
       LEFT JOIN staff_users u ON u.id = e.staff_user_id LEFT JOIN sales s ON s.id = e.sale_id
      WHERE e.gift_card_id = $1 ORDER BY e.created_at DESC`,
    [id],
  );
  return {
    ...toGiftCard(rows[0]),
    history: entries.map((e) => ({
      changeCents: e.change_cents,
      balanceAfter: e.balance_after,
      kind: e.kind,
      method: e.method,
      saleNumber: e.sale_number,
      bookingId: e.booking_id,
      note: e.note,
      staff: e.staff_name ?? null,
      at: e.created_at.toISOString(),
    })),
  };
}

export async function findGiftCard(db: DbClient, course: Course, code: string) {
  const { rows } = await db.query("SELECT id FROM gift_cards WHERE course_id = $1 AND code = $2", [course.id, cleanCode(code)]);
  if (!rows[0]) throw notFound("Gift card");
  return getGiftCard(db, course, rows[0].id);
}

export async function listGiftCards(db: DbClient, course: Course, opts: { golferId?: string; q?: string } = {}) {
  const q = opts.q?.trim().toLowerCase() ?? "";
  const { rows } = await db.query(
    `${giftCardSelect} WHERE g.course_id = $1 AND ($2::uuid IS NULL OR g.customer_id = $2)
        AND ($3 = '' OR lower(g.code) LIKE '%' || $3 || '%' OR lower(g.recipient_name) LIKE '%' || $3 || '%' OR lower(c.name) LIKE '%' || $3 || '%')
      ORDER BY g.created_at DESC LIMIT 100`,
    [course.id, opts.golferId ?? null, q.replace(/[\\%_]/g, "\\$&")],
  );
  return rows.map(toGiftCard);
}

/** Managers: fix a balance (with a reason) or void a lost or disputed card. */
export async function adjustGiftCard(db: Db, course: Course, staffId: string | undefined, id: string, input: { changeCents?: number; void?: boolean; note: string }) {
  if (!input.note.trim()) throw badRequest("note_required", "Say why");
  await withTransaction(db, async (client) => {
    const { rows } = await client.query("SELECT * FROM gift_cards WHERE id = $1 AND course_id = $2 FOR UPDATE", [id, course.id]);
    if (!rows[0]) throw notFound("Gift card");
    if (rows[0].status !== "active") throw conflict("gift_card_void", "That gift card was voided");
    if (input.void) {
      await addEntry(client, id, -rows[0].balance_cents, "void", { note: input.note.trim(), staffId });
      await client.query("UPDATE gift_cards SET status = 'void' WHERE id = $1", [id]);
    } else if (input.changeCents) {
      if (rows[0].balance_cents + input.changeCents < 0) throw badRequest("negative_balance", "That would take the card below zero");
      await addEntry(client, id, input.changeCents, "adjust", { note: input.note.trim(), staffId });
    }
  });
  return getGiftCard(db, course, id);
}

/**
 * Takes money off a gift card inside the caller's transaction. With `upTo`, takes what's there
 * (for a round, where the rest is paid another way); otherwise the card must cover it all.
 */
export async function spendGiftCard(
  client: DbClient,
  course: Course,
  code: string,
  amountCents: number,
  link: { saleId?: string; bookingId?: string; staffId?: string | undefined },
  opts: { upTo?: boolean } = {},
) {
  const { rows } = await client.query("SELECT * FROM gift_cards WHERE course_id = $1 AND code = $2 FOR UPDATE", [course.id, cleanCode(code)]);
  if (!rows[0]) throw notFound("Gift card");
  const card = rows[0];
  if (card.status !== "active") throw conflict("gift_card_void", "That gift card was voided");
  if (card.balance_cents <= 0) throw conflict("gift_card_empty", "That gift card has nothing left on it");
  if (!opts.upTo && card.balance_cents < amountCents) {
    throw conflict("not_enough_on_card", `The gift card only has ${card.balance_cents} cents left. Use it toward a round, or pay another way`);
  }
  const amount = Math.min(amountCents, card.balance_cents);
  if (amount > 0) await addEntry(client, card.id, -amount, "redeem", { saleId: link.saleId, bookingId: link.bookingId, staffId: link.staffId });
  return { id: card.id as string, amountCents: amount };
}

/** Puts a refunded sale's money back where it came from, if that was a gift card or house account. */
export async function reverseSalePayment(client: DbClient, saleId: string, staffId: string | undefined) {
  const { rows } = await client.query("SELECT number, total_cents, payment_method, gift_card_id, customer_id, course_id FROM sales WHERE id = $1", [saleId]);
  const sale = rows[0];
  if (sale.gift_card_id) await addEntry(client, sale.gift_card_id, sale.total_cents, "adjust", { saleId, note: `Refund of sale #${sale.number}`, staffId });
  if (sale.payment_method === "house_account") {
    await client.query(
      `INSERT INTO house_entries (house_account_id, amount_cents, kind, description, sale_id, staff_user_id)
       SELECT id, $3, 'adjustment', $4, $5, $6 FROM house_accounts WHERE course_id = $1 AND customer_id = $2`,
      [sale.course_id, sale.customer_id, -sale.total_cents, `Refund of sale #${sale.number}`, saleId, staffId ?? null],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// House accounts

export type AccountStatus = "active" | "suspended" | "closed";

const accountSelect = `SELECT a.*, c.name AS golfer_name, c.email AS golfer_email, c.phone AS golfer_phone,
    COALESCE((SELECT SUM(amount_cents) FROM house_entries e WHERE e.house_account_id = a.id), 0)::int AS balance_cents,
    COALESCE((SELECT SUM(amount_cents) FROM house_entries e WHERE e.house_account_id = a.id AND e.statement_id IS NULL), 0)::int AS unbilled_cents,
    (SELECT row_to_json(s) FROM house_statements s WHERE s.house_account_id = a.id ORDER BY s.period_start DESC LIMIT 1) AS last_statement
  FROM house_accounts a JOIN customers c ON c.id = a.customer_id`;

// Date columns come back as "yyyy-MM-dd" strings (see db.ts), in JSON too.
const toStatement = (s: any) => ({
  id: s.id as string,
  periodStart: s.period_start as string,
  periodEnd: s.period_end as string,
  openingCents: s.opening_cents as number,
  chargesCents: s.charges_cents as number,
  paymentsCents: s.payments_cents as number,
  closingCents: s.closing_cents as number,
  dueOn: s.due_on as string,
});

const toAccount = (r: any) => ({
  id: r.id,
  golfer: { id: r.customer_id, name: r.golfer_name, email: r.golfer_email, phone: r.golfer_phone },
  creditLimitCents: r.credit_limit_cents as number | null,
  status: r.status as AccountStatus,
  billingEmail: r.billing_email ?? r.golfer_email,
  notes: r.notes,
  balanceCents: r.balance_cents as number,
  unbilledCents: r.unbilled_cents as number,
  availableCents: r.credit_limit_cents === null ? null : Math.max(0, r.credit_limit_cents - r.balance_cents),
  lastStatement: r.last_statement ? toStatement(r.last_statement) : null,
  createdAt: r.created_at.toISOString(),
});

export async function listAccounts(db: DbClient, course: Course) {
  const { rows } = await db.query(`${accountSelect} WHERE a.course_id = $1 ORDER BY a.status, lower(c.name)`, [course.id]);
  return rows.map(toAccount);
}

export async function accountForGolfer(db: DbClient, course: Course, golferId: string) {
  const { rows } = await db.query(`${accountSelect} WHERE a.course_id = $1 AND a.customer_id = $2`, [course.id, golferId]);
  return rows[0] ? toAccount(rows[0]) : null;
}

export async function getAccount(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`${accountSelect} WHERE a.id = $1 AND a.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("House account");
  const { rows: entries } = await db.query(
    `SELECT e.*, u.name AS staff_name, s.number AS sale_number FROM house_entries e
       LEFT JOIN staff_users u ON u.id = e.staff_user_id LEFT JOIN sales s ON s.id = e.sale_id
      WHERE e.house_account_id = $1 ORDER BY e.created_at DESC LIMIT 300`,
    [id],
  );
  const { rows: statements } = await db.query("SELECT * FROM house_statements WHERE house_account_id = $1 ORDER BY period_start DESC", [id]);
  return { ...toAccount(rows[0]), entries: entries.map(toEntry), statements: statements.map(toStatement) };
}

const toEntry = (e: any) => ({
  id: e.id,
  amountCents: e.amount_cents,
  kind: e.kind as "charge" | "payment" | "adjustment",
  description: e.description,
  method: e.method,
  saleNumber: e.sale_number ?? null,
  bookingId: e.booking_id,
  statementId: e.statement_id,
  staff: e.staff_name ?? null,
  at: e.created_at.toISOString(),
});

export async function openAccount(db: DbClient, course: Course, input: { golferId: string; creditLimitCents?: number | null; billingEmail?: string | null; notes?: string | null }) {
  const { rows: g } = await db.query("SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [input.golferId, course.organizationId]);
  if (!g[0]) throw notFound("Golfer account");
  const { rows } = await db.query(
    `INSERT INTO house_accounts (course_id, customer_id, credit_limit_cents, billing_email, notes) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_id, customer_id) DO NOTHING RETURNING id`,
    [course.id, input.golferId, input.creditLimitCents ?? null, input.billingEmail?.trim() || null, input.notes?.trim() || null],
  );
  if (!rows[0]) throw conflict("account_exists", "This golfer already has a house account");
  return getAccount(db, course, rows[0].id);
}

export async function updateAccount(
  db: DbClient,
  course: Course,
  id: string,
  patch: { creditLimitCents?: number | null; status?: AccountStatus; billingEmail?: string | null; notes?: string | null },
) {
  const before = await getAccount(db, course, id);
  if (patch.status === "closed" && before.balanceCents !== 0) throw conflict("balance_owing", "Settle the balance before closing the account");
  await db.query(
    `UPDATE house_accounts SET
       credit_limit_cents = CASE WHEN $2 THEN $3 ELSE credit_limit_cents END,
       status = COALESCE($4, status),
       billing_email = CASE WHEN $5 THEN $6 ELSE billing_email END,
       notes = CASE WHEN $7 THEN $8 ELSE notes END
     WHERE id = $1`,
    [id, patch.creditLimitCents !== undefined, patch.creditLimitCents ?? null, patch.status ?? null, patch.billingEmail !== undefined, patch.billingEmail?.trim() || null, patch.notes !== undefined, patch.notes?.trim() || null],
  );
  return getAccount(db, course, id);
}

/** Puts a charge on a golfer's house account inside the caller's transaction. */
export async function chargeAccount(
  client: DbClient,
  course: Course,
  golferId: string | null | undefined,
  amountCents: number,
  link: { description: string; saleId?: string; bookingId?: string; staffId?: string | undefined },
) {
  if (!golferId) throw badRequest("no_account", "Pick the golfer's account to charge it");
  const { rows } = await client.query(
    `SELECT a.id, a.status, a.credit_limit_cents, COALESCE((SELECT SUM(amount_cents) FROM house_entries e WHERE e.house_account_id = a.id), 0)::int AS balance
       FROM house_accounts a WHERE a.course_id = $1 AND a.customer_id = $2 FOR UPDATE OF a`,
    [course.id, golferId],
  );
  const a = rows[0];
  if (!a) throw conflict("no_house_account", "This golfer doesn't have a house account");
  if (a.status !== "active") throw conflict("account_not_active", a.status === "suspended" ? "This house account is on hold. Ask a manager" : "This house account is closed");
  if (a.credit_limit_cents !== null && a.balance + amountCents > a.credit_limit_cents) {
    throw conflict("over_limit", `That would go over the account's limit. ${Math.max(0, a.credit_limit_cents - a.balance)} cents available`);
  }
  if (amountCents <= 0) return;
  await client.query(
    "INSERT INTO house_entries (house_account_id, amount_cents, kind, description, sale_id, booking_id, staff_user_id) VALUES ($1, $2, 'charge', $3, $4, $5, $6)",
    [a.id, amountCents, link.description, link.saleId ?? null, link.bookingId ?? null, link.staffId ?? null],
  );
}

/** A payment toward the account (the statement, usually). Counts as money taken that day. */
export async function payAccount(
  db: Db,
  course: Course,
  staffId: string | undefined,
  id: string,
  input: { amountCents: number; method: "card" | "cash" | "check"; cardPaymentId?: string | null; note?: string | null },
) {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query("SELECT id FROM house_accounts WHERE id = $1 AND course_id = $2 FOR UPDATE", [id, course.id]);
    if (!rows[0]) throw notFound("House account");
    if (input.cardPaymentId) {
      if (input.method !== "card") throw badRequest("not_card", "A card payment can only pay a card payment");
      await useCardPayment(client, course, input.cardPaymentId, input.amountCents, {});
    }
    const what = input.method === "check" ? `Payment by check${input.note?.trim() ? ` ${input.note.trim()}` : ""}` : `Payment by ${input.method}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`;
    await client.query(
      "INSERT INTO house_entries (house_account_id, amount_cents, kind, description, method, card_payment_id, staff_user_id) VALUES ($1, $2, 'payment', $3, $4, $5, $6)",
      [id, -input.amountCents, what, input.method, input.cardPaymentId ?? null, staffId ?? null],
    );
  });
  return getAccount(db, course, id);
}

/** Managers: a credit or extra charge that isn't a sale, e.g. monthly dues or a courtesy credit. */
export async function adjustAccount(db: DbClient, course: Course, staffId: string | undefined, id: string, input: { amountCents: number; description: string }) {
  await getAccount(db, course, id);
  if (!input.description.trim()) throw badRequest("description_required", "Say what it's for");
  await db.query("INSERT INTO house_entries (house_account_id, amount_cents, kind, description, staff_user_id) VALUES ($1, $2, 'adjustment', $3, $4)", [
    id,
    input.amountCents,
    input.description.trim(),
    staffId ?? null,
  ]);
  return getAccount(db, course, id);
}

/**
 * Makes the month's statements: for each account with a balance or activity, everything not yet
 * on a statement from before the month ended. Running it again for the same month does nothing new.
 */
export async function runStatements(db: Db, course: Course, month: string, dueDays = 15) {
  const start = DateTime.fromISO(`${month}-01`, { zone: course.timeZone });
  if (!start.isValid || !/^\d{4}-\d{2}$/.test(month)) throw badRequest("invalid_month", "Use a month like 2026-10");
  const end = start.plus({ months: 1 });
  if (end > DateTime.now().setZone(course.timeZone).plus({ days: 1 })) throw badRequest("month_not_over", "Statements are made once the month is over");
  const made: string[] = [];
  await withTransaction(db, async (client) => {
    const { rows: accounts } = await client.query("SELECT id FROM house_accounts WHERE course_id = $1 AND status <> 'closed' ORDER BY id FOR UPDATE", [course.id]);
    for (const a of accounts) {
      const { rows: done } = await client.query("SELECT 1 FROM house_statements WHERE house_account_id = $1 AND period_start = $2", [a.id, start.toISODate()]);
      if (done[0]) continue;
      const { rows: prev } = await client.query("SELECT COALESCE(SUM(amount_cents), 0)::int AS cents FROM house_entries WHERE house_account_id = $1 AND statement_id IS NOT NULL", [a.id]);
      const { rows: entries } = await client.query(
        "SELECT id, amount_cents FROM house_entries WHERE house_account_id = $1 AND statement_id IS NULL AND created_at < $2",
        [a.id, end.toUTC().toISO()],
      );
      const opening = prev[0].cents as number;
      if (!entries.length && opening === 0) continue;
      const charges = entries.filter((e) => e.amount_cents > 0).reduce((s, e) => s + e.amount_cents, 0);
      const payments = -entries.filter((e) => e.amount_cents < 0).reduce((s, e) => s + e.amount_cents, 0);
      const { rows } = await client.query(
        `INSERT INTO house_statements (house_account_id, period_start, period_end, opening_cents, charges_cents, payments_cents, closing_cents, due_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [a.id, start.toISODate(), end.minus({ days: 1 }).toISODate(), opening, charges, payments, opening + charges - payments, end.plus({ days: dueDays - 1 }).toISODate()],
      );
      if (entries.length) await client.query("UPDATE house_entries SET statement_id = $2 WHERE id = ANY($1)", [entries.map((e) => e.id), rows[0].id]);
      made.push(rows[0].id);
    }
  });
  return { month, statements: made.length };
}

export async function getStatement(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(
    `SELECT s.*, a.id AS account_id FROM house_statements s JOIN house_accounts a ON a.id = s.house_account_id WHERE s.id = $1 AND a.course_id = $2`,
    [id, course.id],
  );
  if (!rows[0]) throw notFound("Statement");
  const account = await getAccount(db, course, rows[0].account_id);
  const { rows: entries } = await db.query(
    `SELECT e.*, u.name AS staff_name, s.number AS sale_number FROM house_entries e
       LEFT JOIN staff_users u ON u.id = e.staff_user_id LEFT JOIN sales s ON s.id = e.sale_id
      WHERE e.statement_id = $1 ORDER BY e.created_at`,
    [id],
  );
  const { entries: _, statements: __, ...rest } = account;
  return { ...toStatement(rows[0]), account: rest, entries: entries.map(toEntry) };
}
