import type { Course } from "./courses.ts";
import { dayRange } from "./courses.ts";
import type { Db, DbClient } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";
import { getStatement } from "./accounts.ts";

// Email and text messages to golfers: a note to everyone booked on a day, a league, all golfers,
// or one golfer, plus statements. Until the course picks a provider, messages go through the
// simulator, which records each one as sent without delivering it.
//
// Marketing (all golfers, house account holders) respects a golfer's opt-out. Operational
// messages about a round they're booked for, and statements, don't.

export type Channel = "email" | "sms";
export type MessageKind = "marketing" | "operational" | "statement";

export type Audience =
  | { type: "date"; date: string; from?: string; to?: string }
  | { type: "event"; eventId: string }
  | { type: "golfers" }
  | { type: "house_accounts" }
  | { type: "golfer_list"; golferIds: string[] }
  | { type: "bookings"; bookingIds: string[] };

export interface Recipient {
  customerId: string | null;
  bookingId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  emailOptOut: boolean;
  smsOptOut: boolean;
  /** Filled into {tee_time} and {date}. */
  teeTime?: string;
  date?: string;
}

/** Sends one message. The simulator is the only one until a provider is picked. */
export interface MessageSender {
  name: string;
  send(m: { channel: Channel; to: string; subject: string | null; body: string; fromName: string; replyTo: string | null }): Promise<{ ok: true } | { ok: false; error: string }>;
}
export const simulator: MessageSender = { name: "simulator", send: async () => ({ ok: true }) };

const usableEmail = (e: string | null) => (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !e.endsWith(".invalid") ? e : null);
/** A US number with area code becomes +1XXXXXXXXXX; anything else with enough digits is kept as typed digits. */
const usablePhone = (p: string | null) => {
  const d = (p ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length >= 11 && d.length <= 15 ? `+${d}` : null;
};

const localTime = (course: Course, d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: course.timeZone, hour: "numeric", minute: "2-digit" }).format(d);
const localDate = (course: Course, d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: course.timeZone, weekday: "long", month: "long", day: "numeric" }).format(d);

const golferCols = `c.id AS customer_id, c.name, c.email, c.phone, c.email_opt_out, c.sms_opt_out`;
const toRecipient = (r: any, course?: Course): Recipient => ({
  customerId: r.customer_id ?? null,
  bookingId: r.booking_id ?? null,
  name: r.name,
  email: r.email ?? null,
  phone: r.phone ?? null,
  emailOptOut: !!r.email_opt_out,
  smsOptOut: !!r.sms_opt_out,
  ...(r.starts_at && course ? { teeTime: localTime(course, r.starts_at), date: localDate(course, r.starts_at) } : {}),
});

/** Who an audience is, what to call it, and whether it counts as marketing. */
export async function resolveAudience(db: DbClient, course: Course, audience: Audience): Promise<{ label: string; kind: MessageKind; recipients: Recipient[] }> {
  if (audience.type === "date" || audience.type === "bookings") {
    let rows: any[];
    let label: string;
    if (audience.type === "date") {
      const { start, end } = dayRange(course, audience.date);
      ({ rows } = await db.query(
        `SELECT b.id AS booking_id, t.starts_at, ${golferCols} FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN customers c ON c.id = b.customer_id
          WHERE b.course_id = $1 AND t.starts_at >= $2 AND t.starts_at < $3 AND b.status IN ('confirmed', 'checked_in')
            AND ($4::text IS NULL OR to_char(t.starts_at AT TIME ZONE $6, 'HH24:MI') >= $4)
            AND ($5::text IS NULL OR to_char(t.starts_at AT TIME ZONE $6, 'HH24:MI') <= $5)
          ORDER BY t.starts_at`,
        [course.id, start.toUTC().toISO(), end.toUTC().toISO(), audience.from ?? null, audience.to ?? null, course.timeZone],
      ));
      const day = localDate(course, new Date(`${audience.date}T12:00:00Z`));
      label = audience.from || audience.to ? `Booked ${day}, ${audience.from ?? "first tee time"} to ${audience.to ?? "last"}` : `Everyone booked ${day}`;
    } else {
      ({ rows } = await db.query(
        `SELECT b.id AS booking_id, t.starts_at, ${golferCols} FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN customers c ON c.id = b.customer_id
          WHERE b.course_id = $1 AND b.id = ANY ($2::uuid[]) ORDER BY t.starts_at`,
        [course.id, audience.bookingIds],
      ));
      label = `${rows.length} ${rows.length === 1 ? "group" : "groups"} on the tee sheet`;
    }
    // One message per golfer, about their first tee time that day.
    const seen = new Set<string>();
    const recipients = rows.filter((r) => !seen.has(r.customer_id) && seen.add(r.customer_id)).map((r) => toRecipient(r, course));
    return { label, kind: "operational", recipients };
  }
  if (audience.type === "event") {
    const { rows: ev } = await db.query("SELECT name FROM events WHERE id = $1 AND course_id = $2", [audience.eventId, course.id]);
    if (!ev[0]) throw notFound("League or outing");
    const { rows } = await db.query(
      `SELECT p.customer_id, p.name, COALESCE(p.email, c.email) AS email, COALESCE(p.phone, c.phone) AS phone, c.email_opt_out, c.sms_opt_out
         FROM event_players p LEFT JOIN customers c ON c.id = p.customer_id WHERE p.event_id = $1 ORDER BY p.name`,
      [audience.eventId],
    );
    return { label: `Players in ${ev[0].name}`, kind: "operational", recipients: rows.map((r) => toRecipient(r)) };
  }
  if (audience.type === "golfers") {
    const { rows } = await db.query(`SELECT ${golferCols} FROM customers c WHERE c.organization_id = $1 AND c.account_created_at IS NOT NULL ORDER BY lower(c.name)`, [
      course.organizationId,
    ]);
    return { label: "All golfers with an account", kind: "marketing", recipients: rows.map((r) => toRecipient(r)) };
  }
  if (audience.type === "house_accounts") {
    const { rows } = await db.query(
      `SELECT ${golferCols.replace("c.email,", "COALESCE(a.billing_email, c.email) AS email,")} FROM house_accounts a JOIN customers c ON c.id = a.customer_id
        WHERE a.course_id = $1 AND a.status = 'active' ORDER BY lower(c.name)`,
      [course.id],
    );
    return { label: "House account holders", kind: "marketing", recipients: rows.map((r) => toRecipient(r)) };
  }
  const { rows } = await db.query(
    `SELECT ${golferCols} FROM customers c WHERE c.organization_id = $1 AND c.account_created_at IS NOT NULL AND c.id = ANY ($2::uuid[]) ORDER BY lower(c.name)`,
    [course.organizationId, audience.golferIds],
  );
  if (!rows.length) throw notFound("Golfer account");
  return { label: rows.length === 1 ? rows[0].name : `${rows.length} golfers`, kind: "operational", recipients: rows.map((r) => toRecipient(r)) };
}

/** The address a message would go to, or why it can't. */
function addressFor(r: Recipient, channel: Channel, kind: MessageKind): { to: string } | { skip: string } {
  const to = channel === "email" ? usableEmail(r.email) : usablePhone(r.phone);
  if (!to) return { skip: channel === "email" ? "No email address" : "No mobile number" };
  if (kind === "marketing" && (channel === "email" ? r.emailOptOut : r.smsOptOut)) return { skip: channel === "email" ? "Opted out of email" : "Opted out of texts" };
  return { to };
}

const fill = (template: string, course: Course, r: Recipient) =>
  template
    .replace(/\{first_name\}/g, r.name.split(/\s+/)[0] ?? r.name)
    .replace(/\{name\}/g, r.name)
    .replace(/\{tee_time\}/g, r.teeTime ?? "your tee time")
    .replace(/\{date\}/g, r.date ?? "")
    .replace(/\{course\}/g, course.name);

export async function previewAudience(db: DbClient, course: Course, audience: Audience, channels: Channel[]) {
  const { label, kind, recipients } = await resolveAudience(db, course, audience);
  const count = (c: Channel) => (channels.includes(c) ? recipients.filter((r) => "to" in addressFor(r, c, kind)).length : 0);
  const reached = recipients.filter((r) => channels.some((c) => "to" in addressFor(r, c, kind))).length;
  return { label, kind, golfers: recipients.length, email: count("email"), sms: count("sms"), unreachable: recipients.length - reached, sample: recipients.slice(0, 8).map((r) => r.name) };
}

export interface MessageSettings {
  fromName: string;
  replyTo: string | null;
  signature: string | null;
  provider: string;
}

export async function getMessageSettings(db: DbClient, course: Course): Promise<MessageSettings> {
  const { rows } = await db.query("SELECT message_from_name, message_reply_to, message_signature FROM courses WHERE id = $1", [course.id]);
  return { fromName: rows[0].message_from_name ?? course.name, replyTo: rows[0].message_reply_to, signature: rows[0].message_signature, provider: simulator.name };
}

export async function saveMessageSettings(db: DbClient, course: Course, input: { fromName?: string | null; replyTo?: string | null; signature?: string | null }) {
  if (input.replyTo && !usableEmail(input.replyTo)) throw badRequest("invalid_email", "Enter a real reply-to email address");
  await db.query(
    `UPDATE courses SET message_from_name = CASE WHEN $2 THEN $3 ELSE message_from_name END, message_reply_to = CASE WHEN $4 THEN $5 ELSE message_reply_to END,
       message_signature = CASE WHEN $6 THEN $7 ELSE message_signature END WHERE id = $1`,
    [
      course.id,
      input.fromName !== undefined,
      input.fromName?.trim() || null,
      input.replyTo !== undefined,
      input.replyTo?.trim() || null,
      input.signature !== undefined,
      input.signature?.trim() || null,
    ],
  );
  return getMessageSettings(db, course);
}

/**
 * Sends one message per golfer per channel and records every one, including the ones skipped for
 * a missing address or an opt-out, so staff can see who wasn't reached.
 */
export async function deliver(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { kind: MessageKind; audience: Audience | { type: "statement"; statementId: string }; label: string; channels: Channel[]; subject: string | null; body: string; recipients: Recipient[] },
  sender: MessageSender = simulator,
) {
  const settings = await getMessageSettings(db, course);
  const { rows } = await db.query(
    `INSERT INTO message_campaigns (course_id, kind, audience, audience_label, channels, subject, body, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [course.id, input.kind, JSON.stringify(input.audience), input.label, input.channels, input.subject, input.body, staffId ?? null],
  );
  const campaignId: string = rows[0].id;
  for (const r of input.recipients) {
    for (const channel of input.channels) {
      const address = addressFor(r, channel, input.kind);
      const subject = channel === "email" ? fill(input.subject ?? course.name, course, r) : null;
      let body = fill(input.body, course, r);
      if (channel === "email" && settings.signature) body += `\n\n${settings.signature}`;
      let status: "sent" | "failed" | "skipped" = "skipped";
      let reason: string | null = "skip" in address ? address.skip : null;
      if ("to" in address) {
        const result = await sender.send({ channel, to: address.to, subject, body, fromName: settings.fromName, replyTo: settings.replyTo });
        status = result.ok ? "sent" : "failed";
        reason = result.ok ? null : result.error;
      }
      await db.query(
        `INSERT INTO messages (course_id, campaign_id, customer_id, booking_id, name, channel, to_address, subject, body, status, reason, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [course.id, campaignId, r.customerId, r.bookingId, r.name, channel, "to" in address ? address.to : null, subject, body, status, reason, sender.name],
      );
    }
  }
  return getCampaign(db, course, campaignId);
}

/** Staff send a message to an audience. */
export async function sendMessage(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { audience: Audience; channels: Channel[]; subject?: string | null; body: string },
  sender?: MessageSender,
) {
  if (!input.channels.length) throw badRequest("no_channel", "Pick email, text or both");
  if (input.channels.includes("email") && !input.subject?.trim()) throw badRequest("subject_required", "Add a subject for the email");
  const { label, kind, recipients } = await resolveAudience(db, course, input.audience);
  if (!recipients.length) throw badRequest("no_recipients", "Nobody matches. Pick another day or group");
  return deliver(db, course, staffId, { kind, audience: input.audience, label, channels: input.channels, subject: input.subject?.trim() || null, body: input.body.trim(), recipients }, sender);
}

const CAMPAIGN_SELECT = `
  SELECT m.*, u.name AS staff,
    (SELECT count(*)::int FROM messages x WHERE x.campaign_id = m.id AND x.status = 'sent') AS sent,
    (SELECT count(*)::int FROM messages x WHERE x.campaign_id = m.id AND x.status = 'skipped') AS skipped,
    (SELECT count(*)::int FROM messages x WHERE x.campaign_id = m.id AND x.status = 'failed') AS failed,
    (SELECT count(DISTINCT COALESCE(x.customer_id::text, x.name))::int FROM messages x WHERE x.campaign_id = m.id) AS golfers
  FROM message_campaigns m LEFT JOIN staff_users u ON u.id = m.sent_by`;

const toCampaign = (r: any) => ({
  id: r.id as string,
  kind: r.kind as MessageKind,
  audienceLabel: r.audience_label as string,
  channels: r.channels as Channel[],
  subject: r.subject as string | null,
  body: r.body as string,
  sentBy: (r.staff ?? null) as string | null,
  sentAt: r.created_at.toISOString() as string,
  golfers: r.golfers as number,
  sent: r.sent as number,
  skipped: r.skipped as number,
  failed: r.failed as number,
});

const toMessage = (m: any) => ({
  id: m.id as string,
  golferId: (m.customer_id ?? null) as string | null,
  name: m.name as string,
  channel: m.channel as Channel,
  to: (m.to_address ?? null) as string | null,
  subject: (m.subject ?? null) as string | null,
  body: m.body as string,
  status: m.status as "sent" | "failed" | "skipped",
  reason: (m.reason ?? null) as string | null,
  provider: m.provider as string,
  at: m.created_at.toISOString() as string,
});

export async function listCampaigns(db: DbClient, course: Course) {
  const { rows } = await db.query(`${CAMPAIGN_SELECT} WHERE m.course_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [course.id]);
  return rows.map(toCampaign);
}

export async function getCampaign(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`${CAMPAIGN_SELECT} WHERE m.id = $1 AND m.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("Message");
  const { rows: messages } = await db.query("SELECT * FROM messages WHERE campaign_id = $1 ORDER BY name, channel", [id]);
  return { ...toCampaign(rows[0]), messages: messages.map(toMessage) };
}

/** Everything sent to one golfer, newest first. */
export async function golferMessages(db: DbClient, course: Course, golferId: string) {
  const { rows } = await db.query("SELECT * FROM messages WHERE course_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 100", [course.id, golferId]);
  return rows.map(toMessage);
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Emails a house account statement to the account's billing email. */
export async function emailStatement(db: Db, course: Course, staffId: string | undefined, statementId: string, sender?: MessageSender) {
  const st = await getStatement(db, course, statementId);
  const month = new Date(`${st.periodStart}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const due = new Date(`${st.dueOn}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const lines = st.entries.map((e: any) => `${e.at.slice(0, 10)}  ${e.description}  ${dollars(e.amountCents)}`);
  const body = [
    `Hi {first_name},`,
    ``,
    `Here is your ${course.name} house account statement for ${month}.`,
    ``,
    `Opening balance: ${dollars(st.openingCents)}`,
    `Charges: ${dollars(st.chargesCents)}`,
    `Payments: ${dollars(st.paymentsCents)}`,
    `Amount due: ${dollars(st.closingCents)} by ${due}`,
    ...(lines.length ? [``, ...lines] : []),
    ``,
    `You can pay at the pro shop by check, cash or card.`,
  ].join("\n");
  const { rows } = await db.query(`SELECT ${golferCols} FROM customers c WHERE c.id = $1`, [st.account.golfer.id]);
  const recipient = { ...toRecipient(rows[0]), email: st.account.billingEmail };
  return deliver(
    db,
    course,
    staffId,
    { kind: "statement", audience: { type: "statement", statementId }, label: `Statement for ${recipient.name}`, channels: ["email"], subject: `${course.name} statement for ${month}`, body, recipients: [recipient] },
    sender,
  );
}
