import { DateTime } from "luxon";
import { getTeeSheet, type Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { createBooking } from "./bookings.ts";
import { useCardPayment } from "./payments.ts";

// Leagues, outings and standing tee times.
//
// A standing tee time is one golfer's permanent weekly time; the tee sheet books it for them a few
// weeks ahead. A league or outing holds a block of tee times on each of its dates (one group per
// tee time, or a shotgun with a group on every hole), keeps a roster, pairs players into groups,
// checks them in, and is billed as one account.

const WEEKS_AHEAD = 8;
const ISO_DATE = "yyyy-MM-dd";

// ---------------------------------------------------------------------------------------------
// Standing tee times

export interface StandingTime {
  id: string;
  golferId: string;
  golferName: string;
  weekday: number;
  localTime: string;
  players: number;
  holes: number;
  riding: boolean;
  residency: "resident" | "nonresident";
  startsOn: string;
  endsOn: string | null;
  active: boolean;
  /** The next few weeks: booked, or why it couldn't be. */
  upcoming: { date: string; bookingId: string | null; problem: string | null }[];
}

const isoDate = (d: Date | string) => (typeof d === "string" ? d : DateTime.fromJSDate(d, { zone: "UTC" }).toFormat(ISO_DATE));

export async function listStandingTimes(db: DbClient, course: Course): Promise<StandingTime[]> {
  const today = DateTime.now().setZone(course.timeZone).toISODate();
  const { rows } = await db.query(
    `SELECT s.*, c.name AS golfer_name,
            COALESCE((SELECT json_agg(json_build_object('date', r.date, 'bookingId', r.booking_id, 'problem', r.problem) ORDER BY r.date)
                        FROM standing_runs r WHERE r.standing_time_id = s.id AND r.date >= $2), '[]') AS upcoming
       FROM standing_times s JOIN customers c ON c.id = s.customer_id
      WHERE s.course_id = $1 ORDER BY s.active DESC, s.weekday, s.local_time`,
    [course.id, today],
  );
  return rows.map((r) => ({
    id: r.id,
    golferId: r.customer_id,
    golferName: r.golfer_name,
    weekday: r.weekday,
    localTime: r.local_time,
    players: r.players,
    holes: r.holes,
    riding: r.riding,
    residency: r.residency,
    startsOn: isoDate(r.starts_on),
    endsOn: r.ends_on ? isoDate(r.ends_on) : null,
    active: r.active,
    upcoming: r.upcoming,
  }));
}

export async function createStandingTime(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { golferId: string; weekday: number; localTime: string; players: number; holes: number; riding: boolean; residency: "resident" | "nonresident"; startsOn: string; endsOn?: string | null },
) {
  if (input.holes % course.holes !== 0) throw badRequest("invalid_holes", `Book a multiple of ${course.holes} holes`);
  if (input.endsOn && input.endsOn < input.startsOn) throw badRequest("invalid_range", "It can't end before it starts");
  const { rows: g } = await db.query("SELECT id FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [input.golferId, course.organizationId]);
  if (!g[0]) throw notFound("Golfer account");
  const { rows } = await db.query(
    `INSERT INTO standing_times (course_id, customer_id, weekday, local_time, players, holes, riding, residency, starts_on, ends_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [course.id, input.golferId, input.weekday, input.localTime, input.players, input.holes, input.riding, input.residency, input.startsOn, input.endsOn ?? null, staffId ?? null],
  );
  await bookAhead(db, course, rows[0].id);
  return (await listStandingTimes(db, course)).find((s) => s.id === rows[0].id)!;
}

/**
 * Stops a standing time (or starts it again). Stopping cancels the bookings it made from today on
 * that the golfer hasn't checked in for, so their spots open up.
 */
export async function setStandingTimeActive(db: Db, course: Course, id: string, active: boolean) {
  const { rowCount } = await db.query("UPDATE standing_times SET active = $3 WHERE id = $1 AND course_id = $2", [id, course.id, active]);
  if (!rowCount) throw notFound("Standing tee time");
  const today = DateTime.now().setZone(course.timeZone).toISODate();
  if (!active) {
    await db.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
        WHERE status = 'confirmed' AND id IN (SELECT booking_id FROM standing_runs WHERE standing_time_id = $1 AND date >= $2)`,
      [id, today],
    );
    await db.query("DELETE FROM standing_runs WHERE standing_time_id = $1 AND date >= $2", [id, today]);
  } else {
    await bookAhead(db, course, id);
  }
  return (await listStandingTimes(db, course)).find((s) => s.id === id)!;
}

/** Books standing times for the next few weeks: one, or all of the course's. */
export async function bookAhead(db: Db, course: Course, standingId?: string) {
  const today = DateTime.now().setZone(course.timeZone).startOf("day");
  for (let i = 0; i < WEEKS_AHEAD * 7; i++) await bookStandingForDate(db, course, today.plus({ days: i }).toFormat(ISO_DATE), standingId);
}

/**
 * Books each standing time that falls on this date and hasn't been tried yet. Run when a day's
 * tee sheet is opened, so standing times are always on the sheet however far ahead staff look.
 */
export async function bookStandingForDate(db: Db, course: Course, date: string, standingId?: string) {
  const day = DateTime.fromISO(date, { zone: course.timeZone });
  if (day < DateTime.now().setZone(course.timeZone).startOf("day")) return;
  const { rows: due } = await db.query(
    `SELECT s.*, c.name, c.email, c.phone FROM standing_times s JOIN customers c ON c.id = s.customer_id
      WHERE s.course_id = $1 AND s.active AND s.weekday = $2 AND s.starts_on <= $3 AND (s.ends_on IS NULL OR s.ends_on >= $3)
        AND ($4::uuid IS NULL OR s.id = $4)
        AND NOT EXISTS (SELECT 1 FROM standing_runs r WHERE r.standing_time_id = s.id AND r.date = $3)`,
    [course.id, day.weekday, date, standingId ?? null],
  );
  if (!due.length) return;
  const sheet = await getTeeSheet(db, course, date);
  for (const s of due) {
    // Claim the week first, so two people opening the same day can't book it twice.
    const { rowCount } = await db.query("INSERT INTO standing_runs (standing_time_id, date) VALUES ($1, $2) ON CONFLICT DO NOTHING", [s.id, date]);
    if (!rowCount) continue;
    const teeTime = sheet.find((t) => t.localTime === s.local_time);
    let problem: string | null = null;
    let bookingId: string | null = null;
    if (!teeTime) problem = "No tee time at that time on this day";
    else {
      try {
        const b = await createBooking(db, course, {
          teeTimeId: teeTime.id,
          holes: s.holes,
          players: Array.from({ length: s.players }, () => ({ residency: s.residency, ageGroup: "adult" as const })),
          addOns: s.riding ? [{ code: "gas_cart", quantity: s.players }] : [],
          customer: { name: s.name, email: s.email, phone: s.phone ?? undefined },
          source: "standing",
          notes: "Standing tee time",
        });
        bookingId = b.id;
      } catch (e) {
        problem = e instanceof Error ? e.message : "Couldn't book it";
      }
    }
    await db.query("UPDATE standing_runs SET booking_id = $3, problem = $4 WHERE standing_time_id = $1 AND date = $2", [s.id, date, bookingId, problem]);
  }
}

// ---------------------------------------------------------------------------------------------
// Leagues and outings

export type EventKind = "league" | "outing";
export type EventFormat = "tee_times" | "shotgun";
export type EventPaymentMethod = "card" | "cash" | "check" | "gift_card" | "comp";

export interface EventInput {
  name: string;
  kind: EventKind;
  format: EventFormat;
  holes: number;
  pricePerPlayerCents: number;
  includesCart?: boolean;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
}

const toEvent = (r: any) => ({
  id: r.id as string,
  name: r.name as string,
  kind: r.kind as EventKind,
  format: r.format as EventFormat,
  holes: r.holes as number,
  pricePerPlayerCents: r.price_per_player_cents as number,
  includesCart: r.includes_cart as boolean,
  contactName: r.contact_name as string | null,
  contactEmail: r.contact_email as string | null,
  contactPhone: r.contact_phone as string | null,
  notes: r.notes as string | null,
  active: r.active as boolean,
});

/** Players charged for a date: those checked in once check-in starts, else everyone in a group. */
const CHARGED_PLAYERS = `(SELECT CASE WHEN COUNT(*) FILTER (WHERE p.checked_in_at IS NOT NULL) > 0
                                     THEN COUNT(*) FILTER (WHERE p.checked_in_at IS NOT NULL) ELSE COUNT(*) END
                            FROM event_pairings p WHERE p.event_date_id = d.id)::int`;

export async function listEvents(db: DbClient, course: Course) {
  const today = DateTime.now().setZone(course.timeZone).toISODate();
  const { rows } = await db.query(
    `SELECT e.*,
            (SELECT MIN(d.date) FROM event_dates d WHERE d.event_id = e.id AND d.status = 'scheduled' AND d.date >= $2) AS next_date,
            (SELECT COUNT(*) FROM event_dates d WHERE d.event_id = e.id AND d.status = 'scheduled')::int AS dates,
            (SELECT COUNT(*) FROM event_players p WHERE p.event_id = e.id)::int AS players
       FROM events e WHERE e.course_id = $1 ORDER BY e.active DESC, next_date NULLS LAST, e.name`,
    [course.id, today],
  );
  return rows.map((r) => ({ ...toEvent(r), nextDate: r.next_date ? isoDate(r.next_date) : null, dates: r.dates, players: r.players }));
}

export async function getEvent(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query("SELECT * FROM events WHERE id = $1 AND course_id = $2", [id, course.id]);
  if (!rows[0]) throw notFound("Event");
  const event = toEvent(rows[0]);
  const { rows: dates } = await db.query(
    `SELECT d.*, (SELECT COUNT(*) FROM tee_times t WHERE t.event_date_id = d.id)::int AS held, ${CHARGED_PLAYERS} AS charged_players,
            (SELECT COUNT(*) FROM event_pairings p WHERE p.event_date_id = d.id)::int AS paired
       FROM event_dates d WHERE d.event_id = $1 ORDER BY d.date`,
    [id],
  );
  const { rows: players } = await db.query(
    "SELECT p.*, CASE WHEN c.account_created_at IS NOT NULL THEN c.id END AS golfer_id FROM event_players p LEFT JOIN customers c ON c.id = p.customer_id WHERE p.event_id = $1 ORDER BY p.name",
    [id],
  );
  const { rows: payments } = await db.query(
    `SELECT p.*, u.name AS staff_name, d.date FROM event_payments p LEFT JOIN staff_users u ON u.id = p.staff_user_id LEFT JOIN event_dates d ON d.id = p.event_date_id
      WHERE p.event_id = $1 ORDER BY p.created_at DESC`,
    [id],
  );
  const scheduled = dates.filter((d) => d.status === "scheduled");
  const chargedCents = scheduled.reduce((s, d) => s + d.charged_players * event.pricePerPlayerCents, 0);
  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  return {
    ...event,
    dates: dates.map((d) => ({
      id: d.id as string,
      date: isoDate(d.date),
      startTime: d.start_time as string,
      slots: d.slots as number,
      held: d.held as number,
      status: d.status as "scheduled" | "cancelled",
      paired: d.paired as number,
      chargedPlayers: d.charged_players as number,
      chargeCents: d.status === "scheduled" ? d.charged_players * event.pricePerPlayerCents : 0,
    })),
    players: players.map((p) => ({ id: p.id as string, name: p.name as string, golferId: p.golfer_id as string | null, email: p.email as string | null, phone: p.phone as string | null, handicap: p.handicap === null ? null : Number(p.handicap) })),
    billing: {
      chargedCents,
      paidCents,
      balanceCents: chargedCents - paidCents,
      payments: payments.map((p) => ({
        id: p.id as string,
        amountCents: p.amount_cents as number,
        method: p.method as EventPaymentMethod,
        date: p.date ? isoDate(p.date) : null,
        note: p.note as string | null,
        staff: (p.staff_name as string | null) ?? null,
        at: p.created_at.toISOString(),
      })),
    },
  };
}

function scheduleDates(kind: EventKind, startsOn: string, endsOn?: string | null) {
  const first = DateTime.fromISO(startsOn);
  if (!first.isValid) throw badRequest("invalid_date", "startsOn must be YYYY-MM-DD");
  if (kind === "outing" || !endsOn) return [startsOn];
  const last = DateTime.fromISO(endsOn);
  if (!last.isValid || last < first) throw badRequest("invalid_range", "The season can't end before it starts");
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 60; d = d.plus({ weeks: 1 })) out.push(d.toFormat(ISO_DATE));
  return out;
}

export async function createEvent(db: Db, course: Course, input: EventInput & { schedule: { startsOn: string; endsOn?: string | null; startTime: string; slots: number } }) {
  if (input.holes % course.holes !== 0) throw badRequest("invalid_holes", `Play a multiple of ${course.holes} holes`);
  const dates = scheduleDates(input.kind, input.schedule.startsOn, input.schedule.endsOn);
  const { rows } = await db.query(
    `INSERT INTO events (course_id, name, kind, format, holes, price_per_player_cents, includes_cart, contact_name, contact_email, contact_phone, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      course.id,
      input.name.trim(),
      input.kind,
      input.format,
      input.holes,
      input.pricePerPlayerCents,
      input.includesCart ?? false,
      input.contactName?.trim() || null,
      input.contactEmail?.trim() || null,
      input.contactPhone?.trim() || null,
      input.notes?.trim() || null,
    ],
  );
  const conflicts: HoldConflict[] = [];
  for (const date of dates) conflicts.push(...(await addEventDate(db, course, rows[0].id, { date, startTime: input.schedule.startTime, slots: input.schedule.slots })).conflicts);
  return { event: await getEvent(db, course, rows[0].id), conflicts };
}

export async function updateEvent(db: DbClient, course: Course, id: string, patch: Partial<EventInput> & { active?: boolean }) {
  const { rows } = await db.query("SELECT * FROM events WHERE id = $1 AND course_id = $2", [id, course.id]);
  if (!rows[0]) throw notFound("Event");
  const next = { ...toEvent(rows[0]), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  await db.query(
    `UPDATE events SET name = $2, holes = $3, price_per_player_cents = $4, includes_cart = $5, contact_name = $6, contact_email = $7, contact_phone = $8, notes = $9, active = $10
      WHERE id = $1`,
    [id, next.name.trim(), next.holes, next.pricePerPlayerCents, next.includesCart, next.contactName, next.contactEmail, next.contactPhone, next.notes, next.active],
  );
  // The held tee times carry the event's name.
  if (patch.name) await db.query("UPDATE tee_times SET note = $2 WHERE event_date_id IN (SELECT id FROM event_dates WHERE event_id = $1)", [id, next.name.trim()]);
  return getEvent(db, course, id);
}

export interface HoldConflict {
  date: string;
  localTime: string;
  detail: string;
}

/**
 * Adds a date to an event and holds its tee times: `slots` tee times in a row from the start
 * time. A time that already has golfers booked is left alone and reported, so staff can move
 * them; blocking it would strand them.
 */
export async function addEventDate(db: Db, course: Course, eventId: string, input: { date: string; startTime: string; slots: number }) {
  const { rows: ev } = await db.query("SELECT name FROM events WHERE id = $1 AND course_id = $2", [eventId, course.id]);
  if (!ev[0]) throw notFound("Event");
  const sheet = await getTeeSheet(db, course, input.date);
  const conflicts: HoldConflict[] = [];
  await withTransaction(db, async (client) => {
    const { rows } = await client.query(
      "INSERT INTO event_dates (event_id, date, start_time, slots) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, date) DO NOTHING RETURNING id",
      [eventId, input.date, input.startTime, input.slots],
    );
    if (!rows[0]) throw conflict("date_taken", "This event already has that date");
    const times = sheet.filter((t) => t.localTime >= input.startTime).slice(0, input.slots);
    if (!times.length) throw badRequest("no_tee_times", "There are no tee times from that time on this day");
    for (const t of times) {
      const { rows: held } = await client.query("SELECT event_date_id FROM tee_times WHERE id = $1 FOR UPDATE", [t.id]);
      if (held[0].event_date_id) {
        conflicts.push({ date: input.date, localTime: t.localTime, detail: "Already held for another event" });
        continue;
      }
      const { rows: booked } = await client.query(
        "SELECT string_agg(c.name, ', ') AS names FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.tee_time_id = $1 AND b.status <> 'cancelled'",
        [t.id],
      );
      if (booked[0].names) {
        conflicts.push({ date: input.date, localTime: t.localTime, detail: `Booked: ${booked[0].names}` });
        continue;
      }
      await client.query("UPDATE tee_times SET status = 'blocked', note = $2, event_date_id = $3 WHERE id = $1", [t.id, ev[0].name, rows[0].id]);
    }
  });
  return { conflicts };
}

/** Cancels one date (rained out, holiday): its tee times open up again and it isn't billed. */
export async function cancelEventDate(db: Db, course: Course, dateId: string) {
  const d = await dateRow(db, course, dateId);
  await withTransaction(db, async (client) => {
    await client.query("UPDATE event_dates SET status = 'cancelled' WHERE id = $1", [dateId]);
    await client.query("UPDATE tee_times SET status = 'open', note = NULL, event_date_id = NULL WHERE event_date_id = $1", [dateId]);
  });
  return getEvent(db, course, d.event_id);
}

async function dateRow(db: DbClient, course: Course, dateId: string) {
  const { rows } = await db.query(
    "SELECT d.*, e.format, e.name, e.course_id FROM event_dates d JOIN events e ON e.id = d.event_id WHERE d.id = $1 AND e.course_id = $2",
    [dateId, course.id],
  );
  if (!rows[0]) throw notFound("Event date");
  return rows[0];
}

export async function addEventPlayer(db: DbClient, course: Course, eventId: string, input: { name?: string; golferId?: string | null; email?: string | null; phone?: string | null; handicap?: number | null }) {
  const { rows: ev } = await db.query("SELECT 1 FROM events WHERE id = $1 AND course_id = $2", [eventId, course.id]);
  if (!ev[0]) throw notFound("Event");
  let { name, email, phone } = input;
  if (input.golferId) {
    const { rows } = await db.query("SELECT name, email, phone FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [input.golferId, course.organizationId]);
    if (!rows[0]) throw notFound("Golfer account");
    const { rows: dup } = await db.query("SELECT 1 FROM event_players WHERE event_id = $1 AND customer_id = $2", [eventId, input.golferId]);
    if (dup[0]) throw conflict("already_playing", `${rows[0].name} is already in this event`);
    ({ name, email, phone } = { name: rows[0].name, email: email ?? rows[0].email, phone: phone ?? rows[0].phone });
  }
  if (!name?.trim()) throw badRequest("name_required", "Give the player's name");
  await db.query("INSERT INTO event_players (event_id, customer_id, name, email, phone, handicap) VALUES ($1, $2, $3, $4, $5, $6)", [
    eventId,
    input.golferId ?? null,
    name.trim(),
    email?.trim() || null,
    phone?.trim() || null,
    input.handicap ?? null,
  ]);
  return getEvent(db, course, eventId);
}

export async function removeEventPlayer(db: DbClient, course: Course, eventId: string, playerId: string) {
  const { rowCount } = await db.query("DELETE FROM event_players p USING events e WHERE p.id = $1 AND p.event_id = $2 AND e.id = p.event_id AND e.course_id = $3", [playerId, eventId, course.id]);
  if (!rowCount) throw notFound("Player");
  return getEvent(db, course, eventId);
}

/** Where group N starts: its tee time, or its hole for a shotgun (1A, 2A … then 1B for a second group on a hole). */
function startFor(format: EventFormat, groupNo: number, heldTimes: string[], courseHoles: number) {
  if (format === "shotgun") return `Hole ${((groupNo - 1) % courseHoles) + 1}${groupNo > courseHoles ? "B" : "A"}`;
  return heldTimes[groupNo - 1] ?? "No tee time held";
}

/** One date of an event: its groups and where they start, who's checked in, and who isn't in a group. */
export async function getEventDate(db: DbClient, course: Course, dateId: string) {
  const d = await dateRow(db, course, dateId);
  const { start, end } = { start: DateTime.fromISO(isoDate(d.date), { zone: course.timeZone }), end: DateTime.fromISO(isoDate(d.date), { zone: course.timeZone }).plus({ days: 1 }) };
  const { rows: held } = await db.query("SELECT starts_at FROM tee_times WHERE event_date_id = $1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at", [
    dateId,
    start.toUTC().toISO(),
    end.toUTC().toISO(),
  ]);
  const heldTimes = held.map((h) => DateTime.fromJSDate(h.starts_at, { zone: course.timeZone }).toFormat("HH:mm"));
  const { rows: players } = await db.query(
    `SELECT p.id, p.name, p.handicap, CASE WHEN c.account_created_at IS NOT NULL THEN c.id END AS golfer_id, pr.group_no, pr.checked_in_at
       FROM event_players p LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN event_pairings pr ON pr.player_id = p.id AND pr.event_date_id = $2
      WHERE p.event_id = $1 ORDER BY pr.group_no NULLS LAST, p.name`,
    [d.event_id, dateId],
  );
  const groups = new Map<number, { groupNo: number; start: string; players: { id: string; name: string; golferId: string | null; handicap: number | null; checkedIn: boolean }[] }>();
  for (const p of players.filter((x) => x.group_no !== null)) {
    if (!groups.has(p.group_no)) groups.set(p.group_no, { groupNo: p.group_no, start: startFor(d.format, p.group_no, heldTimes, course.holes), players: [] });
    groups.get(p.group_no)!.players.push({ id: p.id, name: p.name, golferId: p.golfer_id, handicap: p.handicap === null ? null : Number(p.handicap), checkedIn: !!p.checked_in_at });
  }
  return {
    id: d.id as string,
    eventId: d.event_id as string,
    eventName: d.name as string,
    format: d.format as EventFormat,
    date: isoDate(d.date),
    startTime: d.start_time as string,
    status: d.status as "scheduled" | "cancelled",
    heldTimes,
    groups: [...groups.values()].sort((a, b) => a.groupNo - b.groupNo),
    unpaired: players.filter((p) => p.group_no === null).map((p) => ({ id: p.id as string, name: p.name as string, handicap: p.handicap === null ? null : Number(p.handicap) })),
    checkedIn: players.filter((p) => p.checked_in_at).length,
  };
}

/**
 * Puts the roster into groups for a date. By signup order, at random, or by handicap (low with
 * high, so groups are even). Anyone already checked in keeps their check-in.
 */
export async function autoPair(db: Db, course: Course, dateId: string, opts: { groupSize: number; order: "name" | "random" | "handicap"; playerIds?: string[] }) {
  const d = await dateRow(db, course, dateId);
  const { rows } = await db.query("SELECT id, name, handicap FROM event_players WHERE event_id = $1 ORDER BY name", [d.event_id]);
  let list = opts.playerIds ? rows.filter((r) => opts.playerIds!.includes(r.id)) : rows;
  if (opts.order === "random") list = list.map((r) => ({ r, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.r);
  const groupsNeeded = Math.ceil(list.length / opts.groupSize);
  const assignment = new Map<string, number>();
  if (opts.order === "handicap") {
    // Snake order across groups: best players spread out, so each group has a mix.
    const sorted = [...list].sort((a, b) => Number(a.handicap ?? 99) - Number(b.handicap ?? 99));
    sorted.forEach((r, i) => {
      const round = Math.floor(i / groupsNeeded);
      const pos = i % groupsNeeded;
      assignment.set(r.id, (round % 2 === 0 ? pos : groupsNeeded - 1 - pos) + 1);
    });
  } else {
    list.forEach((r, i) => assignment.set(r.id, Math.floor(i / opts.groupSize) + 1));
  }
  await withTransaction(db, async (client) => {
    const { rows: kept } = await client.query("SELECT player_id, checked_in_at FROM event_pairings WHERE event_date_id = $1", [dateId]);
    const checkedIn = new Map(kept.map((k) => [k.player_id, k.checked_in_at]));
    await client.query("DELETE FROM event_pairings WHERE event_date_id = $1", [dateId]);
    for (const [playerId, groupNo] of assignment) {
      await client.query("INSERT INTO event_pairings (event_date_id, player_id, group_no, checked_in_at) VALUES ($1, $2, $3, $4)", [dateId, playerId, groupNo, checkedIn.get(playerId) ?? null]);
    }
  });
  return getEventDate(db, course, dateId);
}

/** Moves one player to a group (a new group number makes a new group), or out of the groups. */
export async function setPairing(db: DbClient, course: Course, dateId: string, playerId: string, groupNo: number | null) {
  const d = await dateRow(db, course, dateId);
  const { rows } = await db.query("SELECT 1 FROM event_players WHERE id = $1 AND event_id = $2", [playerId, d.event_id]);
  if (!rows[0]) throw notFound("Player");
  if (groupNo === null) await db.query("DELETE FROM event_pairings WHERE event_date_id = $1 AND player_id = $2", [dateId, playerId]);
  else
    await db.query(
      "INSERT INTO event_pairings (event_date_id, player_id, group_no) VALUES ($1, $2, $3) ON CONFLICT (event_date_id, player_id) DO UPDATE SET group_no = EXCLUDED.group_no",
      [dateId, playerId, groupNo],
    );
  return getEventDate(db, course, dateId);
}

export async function setCheckedIn(db: DbClient, course: Course, dateId: string, playerIds: string[], checkedIn: boolean) {
  await dateRow(db, course, dateId);
  const { rows } = await db.query(
    `UPDATE event_pairings SET checked_in_at = CASE WHEN $3 THEN COALESCE(checked_in_at, now()) END WHERE event_date_id = $1 AND player_id = ANY($2::uuid[]) RETURNING player_id`,
    [dateId, playerIds, checkedIn],
  );
  if (rows.length !== playerIds.length) throw badRequest("not_in_group", "Put everyone in a group before checking them in");
  return getEventDate(db, course, dateId);
}

/**
 * Takes a payment on the event's account: usually one payment from the league or the company for
 * a date or the whole season. A negative amount is a refund.
 */
export async function addEventPayment(
  db: Db,
  course: Course,
  staffId: string | undefined,
  eventId: string,
  input: { amountCents: number; method: EventPaymentMethod; eventDateId?: string | null; note?: string | null; cardPaymentId?: string | null },
) {
  await withTransaction(db, async (client) => {
    const { rows: ev } = await client.query("SELECT 1 FROM events WHERE id = $1 AND course_id = $2 FOR UPDATE", [eventId, course.id]);
    if (!ev[0]) throw notFound("Event");
    if (input.eventDateId) {
      const { rows } = await client.query("SELECT 1 FROM event_dates WHERE id = $1 AND event_id = $2", [input.eventDateId, eventId]);
      if (!rows[0]) throw notFound("Event date");
    }
    if (input.cardPaymentId) {
      if (input.method !== "card" || input.amountCents <= 0) throw badRequest("not_card", "A card payment can only pay a card amount");
      const { rows } = await client.query("SELECT 1 FROM event_payments WHERE card_payment_id = $1", [input.cardPaymentId]);
      if (rows[0]) throw conflict("card_payment_used", "That card payment has already paid for something else");
      await useCardPayment(client, course, input.cardPaymentId, input.amountCents, {});
    }
    await client.query(
      "INSERT INTO event_payments (event_id, event_date_id, amount_cents, method, card_payment_id, note, staff_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [eventId, input.eventDateId ?? null, input.amountCents, input.method, input.cardPaymentId ?? null, input.note?.trim() || null, staffId ?? null],
    );
  });
  return getEvent(db, course, eventId);
}
