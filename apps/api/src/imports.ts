import { DateTime } from "luxon";
import { parseTeeSheetCsv, type ImportedBooking, type ImportProblem } from "@golf/core";
import type { Db, DbClient } from "./db.ts";
import { getTeeSheet, toTeeTime, type Course } from "./courses.ts";
import { buildQuote } from "./bookings.ts";

// Brings the course's booking provider's tee sheet into ours. Golfers keep booking on
// TeeItUp or GolfNow; this keeps our sheet in step so staff can check them in.

export type ImportSource = "teeitup" | "golfnow" | "import";

export interface ImportChange {
  action: "create" | "update" | "cancel" | "no_show" | "unchanged" | "skip";
  externalId: string;
  date: string;
  time: string;
  name: string;
  players: number;
  detail?: string;
}

export interface ImportResult {
  dryRun: boolean;
  dates: string[];
  counts: { created: number; updated: number; cancelled: number; unchanged: number; problems: number };
  changes: ImportChange[];
  problems: ImportProblem[];
  /** Tee times holding more players than they allow after the import. */
  overbooked: { date: string; time: string; players: number; maxPlayers: number }[];
}

interface Existing {
  id: string;
  tee_time_id: string;
  status: string;
  players: number;
  holes: number;
  total_cents: number;
  name: string;
  prepaid_cents: number;
}

/**
 * Imports a tee sheet export. With dryRun nothing is saved and the result says what would change.
 * Bookings already checked in or on the course are never changed by an import.
 */
export async function importTeeSheet(
  db: Db,
  course: Course,
  input: { source: ImportSource; csv: string; fileName?: string; dryRun?: boolean },
): Promise<ImportResult> {
  const parsed = parseTeeSheetCsv(input.csv);
  const dates = [...new Set(parsed.bookings.map((b) => b.date))].sort();
  const result: ImportResult = {
    dryRun: input.dryRun ?? false,
    dates,
    counts: { created: 0, updated: 0, cancelled: 0, unchanged: 0, problems: parsed.problems.length },
    changes: [],
    problems: parsed.problems,
    overbooked: [],
  };
  if (parsed.bookings.length === 0) return result;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One import at a time per course, so two uploads can't both add the same booking.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`import:${course.id}`]);
    for (const date of dates) await getTeeSheet(client, course, date);

    const touched = new Set<string>();
    for (const b of parsed.bookings) {
      const change = await applyOne(client, course, input.source, b, touched);
      result.changes.push(change);
      if (change.action === "create") result.counts.created++;
      else if (change.action === "update" || change.action === "no_show") result.counts.updated++;
      else if (change.action === "cancel") result.counts.cancelled++;
      else if (change.action === "unchanged") result.counts.unchanged++;
    }

    // Bookings from this provider on the file's days that are no longer in the file were
    // cancelled there. Only untouched bookings are cancelled here: checked-in groups stay.
    const { rows: gone } = await client.query(
      `SELECT b.id, b.external_id, b.players, b.tee_time_id, t.starts_at, c.name
         FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN customers c ON c.id = b.customer_id
        WHERE b.course_id = $1 AND b.source = $2 AND b.status = 'confirmed' AND b.external_id IS NOT NULL
          AND to_char(t.starts_at AT TIME ZONE $3, 'YYYY-MM-DD') = ANY($4)
          AND NOT (b.external_id = ANY($5))`,
      [course.id, input.source, course.timeZone, dates, parsed.bookings.map((b) => b.externalId)],
    );
    for (const g of gone) {
      await client.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [g.id]);
      const local = DateTime.fromJSDate(g.starts_at).setZone(course.timeZone);
      result.changes.push({
        action: "cancel",
        externalId: g.external_id,
        date: local.toISODate()!,
        time: local.toFormat("HH:mm"),
        name: g.name,
        players: g.players,
        detail: "No longer in the provider's tee sheet",
      });
      result.counts.cancelled++;
    }

    if (touched.size > 0) {
      const { rows: full } = await client.query(
        `SELECT t.starts_at, t.max_players,
                (SELECT COALESCE(SUM(players), 0)::int FROM bookings WHERE tee_time_id = t.id AND status NOT IN ('cancelled', 'no_show')) AS booked
           FROM tee_times t WHERE t.id = ANY($1)`,
        [[...touched]],
      );
      for (const t of full.filter((t) => t.booked > t.max_players)) {
        const local = DateTime.fromJSDate(t.starts_at).setZone(course.timeZone);
        result.overbooked.push({ date: local.toISODate()!, time: local.toFormat("HH:mm"), players: t.booked, maxPlayers: t.max_players });
      }
    }

    if (result.dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query(
        `INSERT INTO import_runs (course_id, source, file_name, dates, created, updated, cancelled, unchanged, problems)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [course.id, input.source, input.fileName ?? null, dates, result.counts.created, result.counts.updated, result.counts.cancelled, result.counts.unchanged, JSON.stringify(result.problems)],
      );
      await client.query("COMMIT");
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function teeTimeFor(client: DbClient, course: Course, b: ImportedBooking): Promise<{ id: string; added: boolean }> {
  const startsAt = DateTime.fromISO(`${b.date}T${b.time}`, { zone: course.timeZone }).toUTC().toISO()!;
  const { rows } = await client.query<{ id: string }>("SELECT id FROM tee_times WHERE course_id = $1 AND starts_at = $2", [course.id, startsAt]);
  if (rows[0]) return { id: rows[0].id, added: false };
  // The provider has a time our sheet doesn't (a shotgun start or a changed interval): add it.
  const { rows: added } = await client.query<{ id: string }>(
    "INSERT INTO tee_times (course_id, starts_at, max_players) VALUES ($1, $2, $3) RETURNING id",
    [course.id, startsAt, Math.max(4, b.players)],
  );
  return { id: added[0]!.id, added: true };
}

async function applyOne(client: DbClient, course: Course, source: ImportSource, b: ImportedBooking, touched: Set<string>): Promise<ImportChange> {
  const base = { externalId: b.externalId, date: b.date, time: b.time, name: b.name, players: b.players };
  const { rows } = await client.query<Existing>(
    `SELECT b.id, b.tee_time_id, b.status, b.players, b.holes, b.total_cents, c.name,
            (SELECT COALESCE(SUM(amount_cents), 0)::int FROM booking_payments WHERE booking_id = b.id AND method = 'prepaid') AS prepaid_cents
       FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE b.course_id = $1 AND b.source = $2 AND b.external_id = $3`,
    [course.id, source, b.externalId],
  );
  const existing = rows[0];

  if (b.status === "cancelled") {
    if (existing?.status === "confirmed") {
      await client.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [existing.id]);
      return { ...base, action: "cancel", detail: "Cancelled in the provider's tee sheet" };
    }
    return { ...base, action: existing ? "unchanged" : "skip", detail: existing ? undefined : "Cancelled before it reached us" };
  }

  if (existing && existing.status !== "confirmed" && existing.status !== "cancelled") {
    // Checked in, on the course or already a no-show here: staff know best.
    return { ...base, action: "unchanged", detail: existing.status === "no_show" ? undefined : "Already checked in, left as it is" };
  }

  const teeTime = await teeTimeFor(client, course, b);
  touched.add(teeTime.id);
  const holes = b.holes ?? existing?.holes ?? course.holes;
  const lines = await priceLines(client, course, b, teeTime.id, holes);
  const total = lines.reduce((s, l) => s + l.totalCents, 0);
  const status = b.status === "no_show" ? "no_show" : "confirmed";

  if (!existing) {
    const email = (b.email ?? `${source}-${b.externalId}@import.invalid`).trim().toLowerCase();
    const { rows: customers } = await client.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, email, phone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, email) DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id`,
      [course.organizationId, b.name, email, b.phone ?? null],
    );
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO bookings (course_id, tee_time_id, customer_id, players, holes, source, total_cents, notes, status, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [course.id, teeTime.id, customers[0]!.id, b.players, holes, source, total, b.notes ?? null, status, b.externalId],
    );
    await writeLines(client, created[0]!.id, lines);
    await topUpPrepaid(client, created[0]!.id, b.paidCents, total, 0);
    return { ...base, action: "create", detail: teeTime.added ? "Added a tee time the provider has and we didn't" : undefined };
  }

  const differences: string[] = [];
  if (existing.status === "cancelled") differences.push("rebooked");
  if (existing.tee_time_id !== teeTime.id) differences.push("moved");
  if (existing.players !== b.players) differences.push(`players ${existing.players} → ${b.players}`);
  if (existing.holes !== holes) differences.push(`holes ${existing.holes} → ${holes}`);
  if (existing.total_cents !== total) differences.push("price");
  if (existing.name !== b.name) differences.push("name");
  if (status === "no_show") differences.push("no-show");
  const paidMore = (b.paidCents ?? 0) > existing.prepaid_cents;
  if (paidMore) differences.push("paid online");
  if (differences.length === 0) return { ...base, action: "unchanged" };

  await client.query(
    `UPDATE bookings SET tee_time_id = $2, players = $3, holes = $4, total_cents = $5, status = $6, cancelled_at = NULL WHERE id = $1`,
    [existing.id, teeTime.id, b.players, holes, total, status],
  );
  await client.query("UPDATE customers SET name = $2 WHERE id = (SELECT customer_id FROM bookings WHERE id = $1)", [existing.id, b.name]);
  if (existing.total_cents !== total) {
    await client.query("DELETE FROM booking_lines WHERE booking_id = $1", [existing.id]);
    await writeLines(client, existing.id, lines);
  }
  await topUpPrepaid(client, existing.id, b.paidCents, total, existing.prepaid_cents);
  return { ...base, action: status === "no_show" ? "no_show" : "update", detail: differences.join(", ") };
}

type Line = { kind: string; code: string; description: string; quantity: number; unitCents: number; totalCents: number };

/** The provider's price when the file has one, otherwise our own rates for a nonresident adult. */
async function priceLines(client: DbClient, course: Course, b: ImportedBooking, teeTimeId: string, holes: number): Promise<Line[]> {
  if (b.totalCents !== undefined) {
    return [{ kind: "green_fee", code: "imported", description: "Green fees (from booking provider)", quantity: 1, unitCents: b.totalCents, totalCents: b.totalCents }];
  }
  const { rows } = await client.query(
    "SELECT t.id, t.starts_at, t.max_players, t.status, t.note, 0 AS booked FROM tee_times t WHERE t.id = $1",
    [teeTimeId],
  );
  const q = await buildQuote(
    client,
    course,
    { teeTimeId, holes, players: Array.from({ length: b.players }, () => ({ residency: "nonresident" as const, ageGroup: "adult" as const })), addOns: [] },
    toTeeTime(rows[0], course.timeZone),
  );
  return q.lines;
}

async function writeLines(client: DbClient, bookingId: string, lines: Line[]) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO booking_lines (booking_id, kind, code, description, quantity, unit_cents, total_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [bookingId, l.kind, l.code, l.description, l.quantity, l.unitCents, l.totalCents],
    );
  }
}

/** Records money the golfer paid online, never more than the booking costs. */
async function topUpPrepaid(client: DbClient, bookingId: string, paidCents: number | undefined, total: number, already: number) {
  const add = Math.min(paidCents ?? 0, total) - already;
  if (add > 0) await client.query("INSERT INTO booking_payments (booking_id, amount_cents, method) VALUES ($1, $2, 'prepaid')", [bookingId, add]);
}

export async function listImports(db: DbClient, course: Course) {
  const { rows } = await db.query(
    `SELECT id, source, file_name, dates, created, updated, cancelled, unchanged, jsonb_array_length(problems) AS problems, created_at
       FROM import_runs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [course.id],
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    fileName: r.file_name,
    dates: r.dates,
    counts: { created: r.created, updated: r.updated, cancelled: r.cancelled, unchanged: r.unchanged, problems: r.problems },
    createdAt: r.created_at.toISOString(),
  }));
}
