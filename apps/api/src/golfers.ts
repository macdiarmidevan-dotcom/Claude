import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";

// Golfer accounts. The pro shop creates one the first time someone is checked in, with that
// golfer's phone and email. After that staff find the account by name and link the day's booking
// to it, so every round they play is kept on one account.

export interface GolferAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  roundsPlayed: number;
  lastPlayed: string | null;
  createdAt: string;
  /** Left off marketing email or texts. Messages about their own tee times still go. */
  emailOptOut: boolean;
  smsOptOut: boolean;
}

const digits = (phone: string) => phone.replace(/\D/g, "");

// Rounds count once the pro shop has checked the group in.
const PLAYED = "('checked_in', 'teed_off')";

const STATS = `
  (SELECT count(*)::int FROM bookings x WHERE x.customer_id = c.id AND x.status IN ${PLAYED}) AS rounds_played,
  (SELECT max(t.starts_at) FROM bookings x JOIN tee_times t ON t.id = x.tee_time_id
    WHERE x.customer_id = c.id AND x.status IN ${PLAYED}) AS last_played`;

const toAccount = (r: any): GolferAccount => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  roundsPlayed: r.rounds_played ?? 0,
  lastPlayed: r.last_played?.toISOString() ?? null,
  createdAt: r.account_created_at.toISOString(),
  emailOptOut: !!r.email_opt_out,
  smsOptOut: !!r.sms_opt_out,
});

function validate(input: { name?: string; email?: string; phone?: string }) {
  if (input.name !== undefined && !input.name.trim()) throw badRequest("name_required", "Enter the golfer's name");
  if (input.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    throw badRequest("invalid_email", "Enter a real email address");
  }
  if (input.phone !== undefined && (digits(input.phone).length < 10 || digits(input.phone).length > 15)) {
    throw badRequest("invalid_phone", "Enter a phone number with area code");
  }
}

/**
 * Finds golfer accounts by name, phone or email. Every word typed must match part of the name,
 * so "jim sul" finds Jim Sullivan. Most rounds first, since regulars are who staff look up most.
 */
export async function searchGolfers(db: DbClient, course: Course, q: string): Promise<GolferAccount[]> {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return [];
  const phone = digits(q);
  const params: unknown[] = [course.organizationId, words.map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`), phone, q.trim().toLowerCase()];
  const { rows } = await db.query(
    `SELECT c.*, ${STATS} FROM customers c
      WHERE c.organization_id = $1 AND c.account_created_at IS NOT NULL
        AND ((SELECT bool_and(lower(c.name) LIKE w) FROM unnest($2::text[]) w)
             OR (length($3) >= 4 AND regexp_replace(c.phone, '\\D', '', 'g') LIKE '%' || $3 || '%')
             OR lower(c.email) = $4)
      ORDER BY rounds_played DESC, lower(c.name)
      LIMIT 20`,
    params,
  );
  return rows.map(toAccount);
}

async function accountRow(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(
    `SELECT c.*, ${STATS}, s.name AS created_by_name FROM customers c
       LEFT JOIN staff_users s ON s.id = c.account_created_by
      WHERE c.id = $1 AND c.organization_id = $2 AND c.account_created_at IS NOT NULL`,
    [id, course.organizationId],
  );
  if (!rows[0]) throw notFound("Golfer account");
  return rows[0];
}

/** A golfer's account with their totals and every booking they've had, newest first. */
export async function getGolfer(db: DbClient, course: Course, id: string) {
  const r = await accountRow(db, course, id);
  const { rows: history } = await db.query(
    `SELECT b.id, b.players, b.holes, b.status, b.total_cents, b.source, t.starts_at, co.name AS course_name, co.time_zone,
            (SELECT COALESCE(SUM(amount_cents), 0)::int FROM booking_payments WHERE booking_id = b.id) AS paid_cents
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN courses co ON co.id = b.course_id
      WHERE b.customer_id = $1 ORDER BY t.starts_at DESC LIMIT 200`,
    [id],
  );
  const now = Date.now();
  // Everyone else in a golfer's group is their guest. Guests' fees still count toward the
  // course's revenue, but not toward what this golfer spent: their own share is the group's
  // payments split evenly across its players.
  const ownCents = (h: { paid_cents: number; players: number }) => Math.round(h.paid_cents / Math.max(1, h.players));
  const played = history.filter((h) => h.status === "checked_in" || h.status === "teed_off");
  return {
    ...toAccount(r),
    createdBy: r.created_by_name ?? null,
    stats: {
      roundsPlayed: played.length,
      holesPlayed: played.reduce((s, h) => s + h.holes, 0),
      noShows: history.filter((h) => h.status === "no_show").length,
      cancelled: history.filter((h) => h.status === "cancelled").length,
      upcoming: history.filter((h) => h.status === "confirmed" && h.starts_at.getTime() > now).length,
      guestsBrought: played.reduce((s, h) => s + h.players - 1, 0),
      /** What the golfer paid for their own rounds, leaving out their guests. */
      paidCents: history.reduce((s, h) => s + ownCents(h), 0),
    },
    history: history.map((h) => ({
      bookingId: h.id,
      startsAt: h.starts_at.toISOString(),
      course: h.course_name,
      players: h.players,
      guests: h.players - 1,
      holes: h.holes,
      status: h.status,
      source: h.source,
      /** The golfer's own share; the group's full amount stays on the booking and in revenue. */
      paidCents: ownCents(h),
    })),
  };
}

async function bookingForLink(client: DbClient, course: Course, bookingId: string) {
  const { rows } = await client.query(
    "SELECT id, customer_id FROM bookings WHERE id = $1 AND course_id = $2 AND status <> 'cancelled' FOR UPDATE",
    [bookingId, course.id],
  );
  if (!rows[0]) throw notFound("Booking");
  return rows[0] as { id: string; customer_id: string };
}

/**
 * Creates a golfer's account, usually at their first check-in, and links that booking to it.
 * If the golfer already booked with this email (online, say) but has no account yet, that
 * record becomes the account, so their earlier bookings count too.
 */
export async function createGolfer(
  db: Db,
  course: Course,
  createdBy: string | undefined,
  input: { name: string; email: string; phone: string; bookingId?: string },
) {
  validate(input);
  const email = input.email.trim().toLowerCase();
  const id = await withTransaction(db, async (client) => {
    const booking = input.bookingId ? await bookingForLink(client, course, input.bookingId) : undefined;
    const { rows: byEmail } = await client.query("SELECT * FROM customers WHERE organization_id = $1 AND email = $2 FOR UPDATE", [
      course.organizationId,
      email,
    ]);
    if (byEmail[0]?.account_created_at) {
      throw conflict("account_exists", `${byEmail[0].name} already has an account with that email. Search for them instead`);
    }
    const { rows: byPhone } = await client.query(
      `SELECT name FROM customers WHERE organization_id = $1 AND account_created_at IS NOT NULL
          AND regexp_replace(phone, '\\D', '', 'g') = $2`,
      [course.organizationId, digits(input.phone)],
    );
    if (byPhone[0]) throw conflict("phone_taken", `${byPhone[0].name} already has an account with that phone number. Search for them instead`);

    const values = [input.name.trim(), input.phone.trim(), createdBy ?? null];
    const { rows } = byEmail[0]
      ? await client.query(
          `UPDATE customers SET name = $2, phone = $3, account_created_by = $4, account_created_at = now() WHERE id = $1 RETURNING id`,
          [byEmail[0].id, ...values],
        )
      : await client.query(
          `INSERT INTO customers (organization_id, email, name, phone, account_created_by, account_created_at)
           VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
          [course.organizationId, email, ...values],
        );
    if (booking) await client.query("UPDATE bookings SET customer_id = $2 WHERE id = $1", [booking.id, rows[0].id]);
    return rows[0].id as string;
  }).catch((err) => {
    // Two people creating the same account at once: the unique indexes catch the loser.
    if ((err as { code?: string }).code === "23505") throw conflict("account_exists", "That golfer already has an account. Search for them instead");
    throw err;
  });
  return getGolfer(db, course, id);
}

/** Links a booking to a golfer's existing account, so the round counts on their account. */
export async function linkGolfer(db: Db, course: Course, bookingId: string, golferId: string) {
  await accountRow(db, course, golferId);
  await withTransaction(db, async (client) => {
    await bookingForLink(client, course, bookingId);
    await client.query("UPDATE bookings SET customer_id = $2 WHERE id = $1", [bookingId, golferId]);
  });
  return getGolfer(db, course, golferId);
}

/** Fixes a typo in a golfer's name, phone or email. */
export async function updateGolfer(
  db: DbClient,
  course: Course,
  id: string,
  patch: { name?: string; email?: string; phone?: string; emailOptOut?: boolean; smsOptOut?: boolean },
) {
  validate(patch);
  await accountRow(db, course, id);
  try {
    await db.query(
      `UPDATE customers SET name = COALESCE($2, name), email = COALESCE($3, email), phone = COALESCE($4, phone),
         email_opt_out = COALESCE($5, email_opt_out), sms_opt_out = COALESCE($6, sms_opt_out) WHERE id = $1`,
      [id, patch.name?.trim() ?? null, patch.email?.trim().toLowerCase() ?? null, patch.phone?.trim() ?? null, patch.emailOptOut ?? null, patch.smsOptOut ?? null],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("account_exists", "Another golfer already uses that email or phone number");
    throw err;
  }
  return getGolfer(db, course, id);
}
