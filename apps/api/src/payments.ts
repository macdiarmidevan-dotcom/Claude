import type { Db, DbClient } from "./db.ts";
import { getCourseBySlug, type Course } from "./courses.ts";
import { AppError, badRequest, conflict, notFound } from "./errors.ts";
import { decryptCredentials, encryptCredentials } from "./sync.ts";
import type { PaymentRef, ProviderConfig, ProviderId, TerminalProvider } from "./terminals.ts";

// Taking cards. A course starts on "standalone": cards go through the course's own terminal and
// the register records them, as most courses do today. Once a manager connects a processor and
// adds the course's readers, the register sends the amount to a reader, waits for the card, and
// only finishes the check-in or sale once the processor says it went through.

export type Providers = Record<ProviderId, TerminalProvider>;

export interface CardPayment {
  id: string;
  terminalId: string;
  terminal: string;
  amountCents: number;
  tipCents: number;
  status: "processing" | "succeeded" | "failed" | "cancelled";
  failureMessage: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  refundedCents: number;
  bookingId: string | null;
  saleId: string | null;
  createdAt: string;
  completedAt: string | null;
}

const toCardPayment = (r: any): CardPayment => ({
  id: r.id,
  terminalId: r.terminal_id,
  terminal: r.terminal_name,
  amountCents: r.amount_cents,
  tipCents: r.tip_cents,
  status: r.status,
  failureMessage: r.failure_message,
  cardBrand: r.card_brand,
  cardLast4: r.card_last4,
  refundedCents: r.refunded_cents,
  bookingId: r.booking_id,
  saleId: r.sale_id,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});

const toTerminal = (r: any) => ({ id: r.id, name: r.name, readerId: r.reader_id, location: r.location, provider: r.provider as ProviderId, active: r.active });

async function settingsRow(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT * FROM payment_settings WHERE course_id = $1", [course.id]);
  return rows[0] as { provider: ProviderId; account: Record<string, string>; credentials_enc: string | null; currency: string; tipping: boolean } | undefined;
}

async function connection(db: DbClient, course: Course, reg: Providers) {
  const row = await settingsRow(db, course);
  const provider = reg[row?.provider ?? "standalone"] ?? reg.standalone;
  const cfg: ProviderConfig = {
    account: row?.account ?? {},
    credentials: row?.credentials_enc ? decryptCredentials(row.credentials_enc) : {},
    currency: row?.currency ?? "usd",
    tipping: row?.tipping ?? false,
  };
  return { provider, cfg };
}

/** How this course takes cards. Secrets are never sent back, only whether they're saved. */
export async function getPaymentSettings(db: DbClient, course: Course, reg: Providers) {
  const row = await settingsRow(db, course);
  const provider = reg[row?.provider ?? "standalone"] ?? reg.standalone;
  return {
    provider: provider.id,
    connected: provider.connected,
    account: row?.account ?? {},
    hasCredentials: !!row?.credentials_enc,
    tipping: row?.tipping ?? false,
    currency: row?.currency ?? "usd",
    providers: Object.values(reg).map((p) => ({ id: p.id, name: p.name, connected: p.connected, fields: p.fields })),
  };
}

export async function savePaymentSettings(
  db: DbClient,
  course: Course,
  reg: Providers,
  input: { provider: string; account?: Record<string, string>; credentials?: Record<string, string>; tipping?: boolean },
) {
  const provider = reg[input.provider as ProviderId];
  if (!provider) throw badRequest("unknown_provider", `${input.provider} isn't a processor this app can connect to yet`);
  const row = await settingsRow(db, course);
  const switching = (row?.provider ?? "standalone") !== provider.id;
  // Only the fields this processor uses are kept, so a leftover key from another one can't linger.
  const pick = (src: Record<string, string> | undefined, secret: boolean) =>
    Object.fromEntries(provider.fields.filter((f) => f.secret === secret && src?.[f.key]?.trim()).map((f) => [f.key, src![f.key]!.trim()]));
  const account = pick(input.account ?? (switching ? {} : row?.account), false);
  // Leaving secrets out keeps the saved ones, unless the processor changed.
  const kept = !switching && row?.credentials_enc ? decryptCredentials(row.credentials_enc) : {};
  const credentials = { ...kept, ...pick(input.credentials, true) };
  for (const f of provider.fields.filter((x) => x.required)) {
    if (!(f.secret ? credentials : account)[f.key]) throw badRequest("missing_field", `Enter the ${f.label.toLowerCase()} for ${provider.name}`);
  }
  const enc = Object.keys(credentials).length ? encryptCredentials(credentials) : null;
  await db.query(
    `INSERT INTO payment_settings (course_id, provider, account, credentials_enc, tipping, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (course_id) DO UPDATE SET provider = $2, account = $3, credentials_enc = $4, tipping = $5, updated_at = now()`,
    [course.id, provider.id, account, enc, input.tipping ?? row?.tipping ?? false],
  );
  return getPaymentSettings(db, course, reg);
}

/** The readers the connected processor knows about, for adding them here. Also proves the keys work. */
export async function discoverReaders(db: DbClient, course: Course, reg: Providers) {
  const { provider, cfg } = await connection(db, course, reg);
  return provider.listReaders(cfg);
}

export async function listTerminals(db: DbClient, course: Course, reg: Providers) {
  const { provider } = await connection(db, course, reg);
  const { rows } = await db.query("SELECT * FROM card_terminals WHERE course_id = $1 AND provider = $2 ORDER BY active DESC, lower(name)", [course.id, provider.id]);
  return rows.map(toTerminal);
}

export async function createTerminal(db: DbClient, course: Course, reg: Providers, input: { name: string; readerId: string; location?: string | null }) {
  const { provider } = await connection(db, course, reg);
  if (!provider.connected) throw badRequest("not_connected", "Connect a card processor before adding readers");
  try {
    const { rows } = await db.query(
      "INSERT INTO card_terminals (course_id, name, provider, reader_id, location) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [course.id, input.name.trim(), provider.id, input.readerId.trim(), input.location?.trim() || null],
    );
    return toTerminal(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("reader_taken", "That reader is already added");
    throw err;
  }
}

export async function updateTerminal(db: DbClient, course: Course, id: string, patch: { name?: string; location?: string | null; active?: boolean }) {
  const { rows } = await db.query(
    `UPDATE card_terminals SET name = COALESCE($3, name), location = CASE WHEN $4::boolean THEN $5 ELSE location END, active = COALESCE($6, active)
      WHERE id = $1 AND course_id = $2 RETURNING *`,
    [id, course.id, patch.name?.trim() ?? null, patch.location !== undefined, patch.location?.trim() || null, patch.active ?? null],
  );
  if (!rows[0]) throw notFound("Card reader");
  return toTerminal(rows[0]);
}

const PAYMENT_SELECT = `SELECT p.*, t.name AS terminal_name, t.reader_id FROM card_payments p JOIN card_terminals t ON t.id = p.terminal_id`;

async function paymentRow(db: DbClient, course: Course, id: string, lock = false) {
  const { rows } = await db.query(`${PAYMENT_SELECT} WHERE p.id = $1 AND p.course_id = $2${lock ? " FOR UPDATE OF p" : ""}`, [id, course.id]);
  if (!rows[0]) throw notFound("Card payment");
  return rows[0];
}

const refOf = (r: any): PaymentRef => ({ providerPaymentId: r.provider_payment_id, readerId: r.reader_id, amountCents: r.amount_cents, startedAt: r.created_at });

/** Sends an amount to a card reader. The app then checks back until the card has gone through. */
export async function startCardPayment(
  db: Db,
  course: Course,
  reg: Providers,
  staffId: string | undefined,
  input: { terminalId: string; amountCents: number; description: string },
) {
  const { provider, cfg } = await connection(db, course, reg);
  if (!provider.connected) throw badRequest("not_connected", "Cards are taken on a standalone terminal here, so there's no reader to send to");
  const { rows: terminals } = await db.query("SELECT * FROM card_terminals WHERE id = $1 AND course_id = $2", [input.terminalId, course.id]);
  const terminal = terminals[0];
  if (!terminal || !terminal.active || terminal.provider !== provider.id) throw badRequest("reader_unavailable", "That card reader isn't set up any more. Pick another in Settings");
  const { rows } = await db.query(
    `INSERT INTO card_payments (course_id, terminal_id, provider, amount_cents, currency, description, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7) RETURNING id`,
    [course.id, terminal.id, provider.id, input.amountCents, cfg.currency, input.description, staffId ?? null],
  );
  const id = rows[0].id as string;
  try {
    const { providerPaymentId } = await provider.startPayment(cfg, { readerId: terminal.reader_id, amountCents: input.amountCents, reference: id, description: input.description });
    await db.query("UPDATE card_payments SET provider_payment_id = $2 WHERE id = $1", [id, providerPaymentId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "The reader didn't respond";
    await db.query("UPDATE card_payments SET status = 'failed', failure_message = $2, completed_at = now() WHERE id = $1", [id, message]);
    throw err instanceof AppError ? err : new AppError(502, "processor_error", message);
  }
  return toCardPayment(await paymentRow(db, course, id));
}

/** A card payment, asking the processor for news first if the card hasn't gone through yet. */
export async function getCardPayment(db: Db, course: Course, reg: Providers, id: string) {
  const row = await paymentRow(db, course, id);
  if (row.status !== "processing" || !row.provider_payment_id) return toCardPayment(row);
  const { cfg } = await connection(db, course, reg);
  const state = await reg[row.provider as ProviderId].getPayment(cfg, refOf(row));
  if (state.status !== "processing") {
    await db.query(
      `UPDATE card_payments SET status = $2, failure_message = $3, provider_charge_id = $4, card_brand = $5, card_last4 = $6, tip_cents = $7, completed_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id, state.status, state.failureMessage ?? null, state.chargeId ?? null, state.cardBrand ?? null, state.cardLast4 ?? null, state.tipCents ?? 0],
    );
  }
  return toCardPayment(await paymentRow(db, course, id));
}

/** Stops waiting on the reader, e.g. the golfer wants to pay cash after all. */
export async function cancelCardPayment(db: Db, course: Course, reg: Providers, id: string) {
  const current = await getCardPayment(db, course, reg, id);
  if (current.status !== "processing") return current;
  const row = await paymentRow(db, course, id);
  const { cfg } = await connection(db, course, reg);
  if (row.provider_payment_id) await reg[row.provider as ProviderId].cancelPayment(cfg, refOf(row));
  await db.query("UPDATE card_payments SET status = 'cancelled', completed_at = now() WHERE id = $1 AND status = 'processing'", [id]);
  return toCardPayment(await paymentRow(db, course, id));
}

/** Gives money back on the card it came from. */
export async function refundCardPayment(client: DbClient, course: Course, reg: Providers, id: string, amountCents?: number) {
  const row = await paymentRow(client, course, id, true);
  if (row.status !== "succeeded") throw conflict("not_paid", "That card payment didn't go through, so there's nothing to refund");
  const amount = amountCents ?? row.amount_cents + row.tip_cents - row.refunded_cents;
  if (amount <= 0 || amount > row.amount_cents + row.tip_cents - row.refunded_cents) throw badRequest("refund_too_big", "That's more than is left on this card payment");
  const { cfg } = await connection(client, course, reg);
  await reg[row.provider as ProviderId].refund(cfg, row.provider_charge_id, amount);
  await client.query("UPDATE card_payments SET refunded_cents = refunded_cents + $2 WHERE id = $1", [id, amount]);
  return toCardPayment(await paymentRow(client, course, id));
}

/**
 * Ties a card payment that went through to what it paid for, inside the check-in or sale's own
 * transaction. It must be for exactly the amount being charged and can only be used once.
 */
export async function useCardPayment(client: DbClient, course: Course, id: string, expectedCents: number, link: { bookingId?: string; saleId?: string }) {
  const row = await paymentRow(client, course, id, true);
  if (row.status !== "succeeded") throw conflict("card_not_paid", "The card hasn't gone through on the reader yet");
  if (row.booking_id || row.sale_id) throw conflict("card_payment_used", "That card payment has already paid for something else");
  if (row.amount_cents !== expectedCents) {
    throw conflict("card_amount_mismatch", `The card was charged ${row.amount_cents} cents but this comes to ${expectedCents} cents`);
  }
  await client.query("UPDATE card_payments SET booking_id = $2, sale_id = $3 WHERE id = $1", [id, link.bookingId ?? null, link.saleId ?? null]);
}

/** The day's card payments, for matching against the processor's payout. */
export async function listCardPayments(db: DbClient, course: Course, from: Date, to: Date) {
  const { rows } = await db.query(`${PAYMENT_SELECT} WHERE p.course_id = $1 AND p.created_at >= $2 AND p.created_at < $3 ORDER BY p.created_at DESC`, [
    course.id,
    from,
    to,
  ]);
  return rows.map(toCardPayment);
}

/** A processor telling us a card went through (or didn't). Checked by its signature, then looked up fresh. */
export async function handlePaymentWebhook(
  db: Db,
  reg: Providers,
  slug: string,
  providerId: string,
  req: { headers: Record<string, string | string[] | undefined>; body: string; url: string },
) {
  const course = await getCourseBySlug(db, slug).catch(() => undefined);
  const provider = reg[providerId as ProviderId];
  if (!course || !provider?.webhookPaymentId) throw notFound("Webhook");
  const { provider: current, cfg } = await connection(db, course, reg);
  if (current.id !== provider.id) throw notFound("Webhook");
  const providerPaymentId = provider.webhookPaymentId(cfg, req);
  if (!providerPaymentId) throw new AppError(401, "bad_signature", "The webhook signature didn't match");
  const { rows } = await db.query("SELECT id FROM card_payments WHERE course_id = $1 AND provider = $2 AND provider_payment_id = $3", [
    course.id,
    provider.id,
    providerPaymentId,
  ]);
  if (rows[0]) await getCardPayment(db, course, reg, rows[0].id);
  return { ok: true };
}
