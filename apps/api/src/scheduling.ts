import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { AppError, badRequest, conflict, notFound } from "./errors.ts";
import type { StaffUser } from "./staff.ts";

// Staff scheduling. Managers put shifts on the schedule, everyone sees it, and people clock in
// and out against their shifts. A shift can be swapped or given to a coworker: the coworker has
// to accept, and then a manager approves it unless the course has turned that step off.

export interface Shift {
  id: string;
  staff: { id: string; name: string } | null;
  employeeType: { id: string; name: string } | null;
  date: string;
  start: string;
  end: string;
  startsAt: string;
  endsAt: string;
  hours: number;
  note: string | null;
}

export interface ShiftInput {
  staffUserId?: string | null;
  employeeTypeId?: string | null;
  date: string;
  start: string;
  end: string;
  note?: string | null;
}

const SHIFT_COLUMNS = `s.*, u.name AS staff_name, et.name AS type_name`;
const SHIFT_JOINS = `FROM shifts s LEFT JOIN staff_users u ON u.id = s.staff_user_id LEFT JOIN employee_types et ON et.id = s.employee_type_id`;

function toShift(r: any, course: Course): Shift {
  const start = DateTime.fromJSDate(r.starts_at).setZone(course.timeZone);
  const end = DateTime.fromJSDate(r.ends_at).setZone(course.timeZone);
  return {
    id: r.id,
    staff: r.staff_user_id ? { id: r.staff_user_id, name: r.staff_name } : null,
    employeeType: r.employee_type_id ? { id: r.employee_type_id, name: r.type_name } : null,
    date: start.toISODate()!,
    start: start.toFormat("HH:mm"),
    end: end.toFormat("HH:mm"),
    startsAt: start.toUTC().toISO()!,
    endsAt: end.toUTC().toISO()!,
    hours: Math.round(end.diff(start, "minutes").minutes / 6) / 10,
    note: r.note,
  };
}

/** A shift's start and end as instants. A shift that ends at or before it starts runs past midnight. */
function times(course: Course, input: { date: string; start: string; end: string }) {
  const startsAt = DateTime.fromISO(`${input.date}T${input.start}`, { zone: course.timeZone });
  let endsAt = DateTime.fromISO(`${input.date}T${input.end}`, { zone: course.timeZone });
  if (!startsAt.isValid || !endsAt.isValid) throw badRequest("invalid_time", "Enter the date and the start and end times");
  if (endsAt <= startsAt) endsAt = endsAt.plus({ days: 1 });
  if (endsAt.diff(startsAt, "hours").hours > 16) throw badRequest("invalid_time", "A shift can be at most 16 hours");
  return { startsAt: startsAt.toUTC().toISO()!, endsAt: endsAt.toUTC().toISO()! };
}

async function checkPeople(db: DbClient, course: Course, input: { staffUserId?: string | null; employeeTypeId?: string | null }) {
  if (input.staffUserId) {
    const { rows } = await db.query("SELECT 1 FROM staff_users WHERE id = $1 AND course_id = $2 AND active", [input.staffUserId, course.id]);
    if (!rows[0]) throw badRequest("invalid_staff", "Choose someone who works here");
  }
  if (input.employeeTypeId) {
    const { rows } = await db.query("SELECT 1 FROM employee_types WHERE id = $1 AND course_id = $2", [input.employeeTypeId, course.id]);
    if (!rows[0]) throw badRequest("invalid_employee_type", "Choose one of the course's employee types");
  }
}

/** Refuses to give someone two shifts at the same time. */
async function checkOverlap(db: DbClient, staffUserId: string | null | undefined, startsAt: string, endsAt: string, except: string[] = []) {
  if (!staffUserId) return;
  const { rows } = await db.query(
    `SELECT s.starts_at FROM shifts s
      WHERE s.staff_user_id = $1 AND s.starts_at < $3 AND s.ends_at > $2 AND NOT (s.id = ANY($4::uuid[])) LIMIT 1`,
    [staffUserId, startsAt, endsAt, except],
  );
  if (rows[0]) throw conflict("overlap", "That person already has a shift at that time");
}

/** The schedule between two dates (inclusive), for everyone. */
export async function listShifts(db: DbClient, course: Course, from: string, to: string): Promise<Shift[]> {
  const start = DateTime.fromISO(from, { zone: course.timeZone }).startOf("day");
  const end = DateTime.fromISO(to, { zone: course.timeZone }).plus({ days: 1 }).startOf("day");
  if (!start.isValid || !end.isValid || end <= start) throw badRequest("invalid_range", "Choose a start and end date");
  if (end.diff(start, "days").days > 62) throw badRequest("invalid_range", "Show at most two months at a time");
  const { rows } = await db.query(
    `SELECT ${SHIFT_COLUMNS} ${SHIFT_JOINS}
      WHERE s.course_id = $1 AND s.starts_at >= $2 AND s.starts_at < $3
      ORDER BY s.starts_at, lower(u.name)`,
    [course.id, start.toUTC().toISO(), end.toUTC().toISO()],
  );
  return rows.map((r) => toShift(r, course));
}

async function getShift(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`SELECT ${SHIFT_COLUMNS} ${SHIFT_JOINS} WHERE s.id = $1 AND s.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("Shift");
  return toShift(rows[0], course);
}

export async function createShift(db: DbClient, course: Course, input: ShiftInput) {
  await checkPeople(db, course, input);
  const { startsAt, endsAt } = times(course, input);
  await checkOverlap(db, input.staffUserId, startsAt, endsAt);
  const { rows } = await db.query(
    `INSERT INTO shifts (course_id, staff_user_id, employee_type_id, starts_at, ends_at, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [course.id, input.staffUserId ?? null, input.employeeTypeId ?? null, startsAt, endsAt, input.note?.trim() || null],
  );
  return getShift(db, course, rows[0].id);
}

export async function updateShift(db: DbClient, course: Course, id: string, patch: Partial<ShiftInput>) {
  const current = await getShift(db, course, id);
  const next = {
    staffUserId: patch.staffUserId !== undefined ? patch.staffUserId : (current.staff?.id ?? null),
    employeeTypeId: patch.employeeTypeId !== undefined ? patch.employeeTypeId : (current.employeeType?.id ?? null),
    date: patch.date ?? current.date,
    start: patch.start ?? current.start,
    end: patch.end ?? current.end,
    note: patch.note !== undefined ? patch.note : current.note,
  };
  await checkPeople(db, course, next);
  const { startsAt, endsAt } = times(course, next);
  await checkOverlap(db, next.staffUserId, startsAt, endsAt, [id]);
  await db.query(
    `UPDATE shifts SET staff_user_id = $2, employee_type_id = $3, starts_at = $4, ends_at = $5, note = $6 WHERE id = $1`,
    [id, next.staffUserId, next.employeeTypeId, startsAt, endsAt, next.note?.trim() || null],
  );
  // Pending swaps were agreed for the shift as it was; a manager changing it cancels them.
  await db.query(
    `UPDATE shift_swaps SET status = 'cancelled' WHERE status IN ('awaiting_coworker', 'awaiting_manager')
        AND (offered_shift_id = $1 OR requested_shift_id = $1)`,
    [id],
  );
  return getShift(db, course, id);
}

export async function deleteShift(db: DbClient, course: Course, id: string) {
  const { rowCount } = await db.query("DELETE FROM shifts WHERE id = $1 AND course_id = $2", [id, course.id]);
  if (!rowCount) throw notFound("Shift");
}

/**
 * Copies a week's shifts to another week, so managers don't build a regular schedule from
 * scratch. Shifts that would clash with one already there are skipped and counted.
 */
export async function copyWeek(db: Db, course: Course, fromMonday: string, toMonday: string) {
  const from = DateTime.fromISO(fromMonday, { zone: course.timeZone });
  const to = DateTime.fromISO(toMonday, { zone: course.timeZone });
  if (!from.isValid || !to.isValid || from.weekday !== 1 || to.weekday !== 1) throw badRequest("invalid_week", "Weeks start on a Monday");
  if (from.equals(to)) throw badRequest("invalid_week", "Choose a different week to copy to");
  const shifts = await listShifts(db, course, from.toISODate()!, from.plus({ days: 6 }).toISODate()!);
  const days = Math.round(to.diff(from, "days").days);
  let copied = 0;
  let skipped = 0;
  await withTransaction(db, async (client) => {
    for (const s of shifts) {
      // Shift by calendar days in the course's time zone, so daylight saving changes keep local times.
      const date = DateTime.fromISO(s.date).plus({ days }).toISODate()!;
      try {
        await client.query("SAVEPOINT copy");
        await createShift(client, course, { staffUserId: s.staff?.id ?? null, employeeTypeId: s.employeeType?.id ?? null, date, start: s.start, end: s.end, note: s.note });
        copied++;
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT copy");
        if (!(err instanceof AppError)) throw err;
        skipped++;
      }
    }
  });
  return { copied, skipped };
}

// ---- Time clock ----

export interface Punch {
  id: string;
  staff: { id: string; name: string };
  shiftId: string | null;
  clockIn: string;
  clockOut: string | null;
  hours: number | null;
  edited: boolean;
}

const toPunch = (r: any): Punch => ({
  id: r.id,
  staff: { id: r.staff_user_id, name: r.staff_name },
  shiftId: r.shift_id,
  clockIn: r.clock_in.toISOString(),
  clockOut: r.clock_out?.toISOString() ?? null,
  hours: r.clock_out ? Math.round((r.clock_out.getTime() - r.clock_in.getTime()) / 360_000) / 10 : null,
  edited: r.edited_at !== null,
});

const PUNCHES = `SELECT p.*, u.name AS staff_name FROM time_punches p JOIN staff_users u ON u.id = p.staff_user_id`;

/** Whether this person is clocked in now, and their next shift today. */
export async function myClock(db: DbClient, course: Course, user: StaffUser) {
  const { rows } = await db.query(`${PUNCHES} WHERE p.staff_user_id = $1 AND p.clock_out IS NULL`, [user.id]);
  const { rows: next } = await db.query(
    `SELECT ${SHIFT_COLUMNS} ${SHIFT_JOINS} WHERE s.staff_user_id = $1 AND s.ends_at > now() ORDER BY s.starts_at LIMIT 1`,
    [user.id],
  );
  return { open: rows[0] ? toPunch(rows[0]) : null, nextShift: next[0] ? toShift(next[0], course) : null };
}

export async function clockIn(db: DbClient, course: Course, user: StaffUser) {
  // Ties the punch to the shift it's for: one that's on now or starts within the next two hours.
  const { rows: shift } = await db.query(
    `SELECT id FROM shifts WHERE staff_user_id = $1 AND starts_at < now() + interval '2 hours' AND ends_at > now()
      ORDER BY starts_at LIMIT 1`,
    [user.id],
  );
  try {
    await db.query("INSERT INTO time_punches (course_id, staff_user_id, shift_id, clock_in) VALUES ($1, $2, $3, now())", [
      course.id,
      user.id,
      shift[0]?.id ?? null,
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("already_clocked_in", "You're already clocked in");
    throw err;
  }
  return myClock(db, course, user);
}

export async function clockOut(db: DbClient, course: Course, user: StaffUser) {
  const { rowCount } = await db.query("UPDATE time_punches SET clock_out = now() WHERE staff_user_id = $1 AND clock_out IS NULL", [user.id]);
  if (!rowCount) throw conflict("not_clocked_in", "You aren't clocked in");
  return myClock(db, course, user);
}

/** Hours worked per person between two dates, with each punch, for payroll. */
export async function timesheets(db: DbClient, course: Course, from: string, to: string) {
  const start = DateTime.fromISO(from, { zone: course.timeZone }).startOf("day");
  const end = DateTime.fromISO(to, { zone: course.timeZone }).plus({ days: 1 }).startOf("day");
  if (!start.isValid || !end.isValid || end <= start) throw badRequest("invalid_range", "Choose a start and end date");
  const { rows } = await db.query(`${PUNCHES} WHERE p.course_id = $1 AND p.clock_in >= $2 AND p.clock_in < $3 ORDER BY lower(u.name), p.clock_in`, [
    course.id,
    start.toUTC().toISO(),
    end.toUTC().toISO(),
  ]);
  const { rows: scheduled } = await db.query(
    `SELECT staff_user_id, SUM(EXTRACT(EPOCH FROM ends_at - starts_at))::float / 3600 AS hours FROM shifts
      WHERE course_id = $1 AND staff_user_id IS NOT NULL AND starts_at >= $2 AND starts_at < $3 GROUP BY staff_user_id`,
    [course.id, start.toUTC().toISO(), end.toUTC().toISO()],
  );
  const people = new Map<string, { staff: { id: string; name: string }; scheduledHours: number; workedHours: number; open: boolean; punches: Punch[] }>();
  for (const r of rows) {
    const p = toPunch(r);
    const person = people.get(p.staff.id) ?? { staff: p.staff, scheduledHours: 0, workedHours: 0, open: false, punches: [] };
    person.punches.push(p);
    person.workedHours = Math.round((person.workedHours + (p.hours ?? 0)) * 10) / 10;
    if (!p.clockOut) person.open = true;
    people.set(p.staff.id, person);
  }
  for (const s of scheduled) {
    const person = people.get(s.staff_user_id);
    if (person) person.scheduledHours = Math.round(s.hours * 10) / 10;
  }
  return [...people.values()];
}

/** A manager fixes a punch someone forgot or got wrong. */
export async function editPunch(db: DbClient, course: Course, managerId: string | undefined, id: string, patch: { clockIn?: string; clockOut?: string | null }) {
  const { rows } = await db.query("SELECT * FROM time_punches WHERE id = $1 AND course_id = $2", [id, course.id]);
  if (!rows[0]) throw notFound("Time punch");
  const clockIn = patch.clockIn ? new Date(patch.clockIn) : rows[0].clock_in;
  const clockOut = patch.clockOut === undefined ? rows[0].clock_out : patch.clockOut === null ? null : new Date(patch.clockOut);
  if (clockOut && clockOut <= clockIn) throw badRequest("invalid_time", "Clock out has to be after clock in");
  await db.query("UPDATE time_punches SET clock_in = $2, clock_out = $3, edited_by = $4, edited_at = now() WHERE id = $1", [
    id,
    clockIn,
    clockOut,
    managerId ?? null,
  ]);
  const { rows: updated } = await db.query(`${PUNCHES} WHERE p.id = $1`, [id]);
  return toPunch(updated[0]);
}

// ---- Shift swaps ----

export type SwapStatus = "awaiting_coworker" | "awaiting_manager" | "approved" | "declined" | "rejected" | "cancelled";

export interface Swap {
  id: string;
  status: SwapStatus;
  from: { id: string; name: string };
  to: { id: string; name: string };
  offered: Shift;
  requested: Shift | null;
  message: string | null;
  createdAt: string;
}

async function getSwap(db: DbClient, course: Course, id: string): Promise<Swap & { raw: any }> {
  const { rows } = await db.query(
    `SELECT w.*, f.name AS from_name, t.name AS to_name FROM shift_swaps w
       JOIN staff_users f ON f.id = w.from_user_id JOIN staff_users t ON t.id = w.to_user_id
      WHERE w.id = $1 AND w.course_id = $2`,
    [id, course.id],
  );
  const r = rows[0];
  if (!r) throw notFound("Swap request");
  return {
    id: r.id,
    status: r.status,
    from: { id: r.from_user_id, name: r.from_name },
    to: { id: r.to_user_id, name: r.to_name },
    offered: await getShift(db, course, r.offered_shift_id),
    requested: r.requested_shift_id ? await getShift(db, course, r.requested_shift_id) : null,
    message: r.message,
    createdAt: r.created_at.toISOString(),
    raw: r,
  };
}

const publicSwap = ({ raw: _, ...s }: Swap & { raw: any }): Swap => s;

/** Swaps this person is part of, plus every swap waiting on a manager when they are one. */
export async function listSwaps(db: DbClient, course: Course, user: StaffUser | undefined, isManager: boolean) {
  const { rows } = await db.query(
    `SELECT id FROM shift_swaps WHERE course_id = $1
        AND (from_user_id = $2 OR to_user_id = $2 OR ($3 AND status = 'awaiting_manager'))
        AND (status IN ('awaiting_coworker', 'awaiting_manager') OR created_at > now() - interval '14 days')
      ORDER BY created_at DESC LIMIT 100`,
    [course.id, user?.id ?? null, isManager],
  );
  return Promise.all(rows.map(async (r) => publicSwap(await getSwap(db, course, r.id))));
}

export async function requestSwap(
  db: DbClient,
  course: Course,
  user: StaffUser,
  input: { offeredShiftId: string; toUserId: string; requestedShiftId?: string | null; message?: string | null },
) {
  const offered = await getShift(db, course, input.offeredShiftId);
  if (offered.staff?.id !== user.id) throw badRequest("not_your_shift", "You can only swap your own shifts");
  if (new Date(offered.startsAt) <= new Date()) throw badRequest("shift_started", "That shift has already started");
  if (input.toUserId === user.id) throw badRequest("invalid_staff", "Choose a coworker");
  const { rows: to } = await db.query("SELECT 1 FROM staff_users WHERE id = $1 AND course_id = $2 AND active", [input.toUserId, course.id]);
  if (!to[0]) throw badRequest("invalid_staff", "Choose a coworker who works here");
  if (input.requestedShiftId) {
    const requested = await getShift(db, course, input.requestedShiftId);
    if (requested.staff?.id !== input.toUserId) throw badRequest("not_their_shift", "Pick one of your coworker's shifts");
    if (new Date(requested.startsAt) <= new Date()) throw badRequest("shift_started", "Their shift has already started");
  }
  const { rows: open } = await db.query(
    "SELECT 1 FROM shift_swaps WHERE offered_shift_id = $1 AND status IN ('awaiting_coworker', 'awaiting_manager')",
    [offered.id],
  );
  if (open[0]) throw conflict("swap_pending", "There's already a request open for this shift");
  const { rows } = await db.query(
    `INSERT INTO shift_swaps (course_id, offered_shift_id, requested_shift_id, from_user_id, to_user_id, message)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [course.id, offered.id, input.requestedShiftId ?? null, user.id, input.toUserId, input.message?.trim() || null],
  );
  return publicSwap(await getSwap(db, course, rows[0].id));
}

/** Moves the shifts between the two people, after checking nothing changed since the request. */
async function applySwap(client: DbClient, course: Course, swap: Swap & { raw: any }) {
  const ids = [swap.offered.id, ...(swap.requested ? [swap.requested.id] : [])];
  const { rows } = await client.query("SELECT id, staff_user_id, starts_at, ends_at FROM shifts WHERE id = ANY($1::uuid[]) FOR UPDATE", [ids]);
  const offered = rows.find((r) => r.id === swap.offered.id);
  const requested = swap.requested && rows.find((r) => r.id === swap.requested!.id);
  if (!offered || offered.staff_user_id !== swap.from.id || (swap.requested && requested?.staff_user_id !== swap.to.id)) {
    throw conflict("shift_changed", "The shifts changed since this was asked. Ask again");
  }
  await checkOverlap(client, swap.to.id, offered.starts_at.toISOString(), offered.ends_at.toISOString(), ids);
  if (requested) await checkOverlap(client, swap.from.id, requested.starts_at.toISOString(), requested.ends_at.toISOString(), ids);
  await client.query("UPDATE shifts SET staff_user_id = $2 WHERE id = $1", [offered.id, swap.to.id]);
  if (requested) await client.query("UPDATE shifts SET staff_user_id = $2 WHERE id = $1", [requested.id, swap.from.id]);
}

export type SwapAction = "accept" | "decline" | "approve" | "reject" | "cancel";

/**
 * Moves a swap along. The coworker accepts or declines; then, if the course needs it, a manager
 * approves or rejects. The person who asked can cancel while it's still waiting.
 */
export async function actOnSwap(db: Db, course: Course, user: StaffUser | undefined, isManager: boolean, id: string, action: SwapAction) {
  await withTransaction(db, async (client) => {
    await client.query("SELECT 1 FROM shift_swaps WHERE id = $1 FOR UPDATE", [id]);
    const swap = await getSwap(client, course, id);
    const waiting = swap.status === "awaiting_coworker" || swap.status === "awaiting_manager";
    if (!waiting) throw conflict("swap_closed", "This request has already been answered");
    const set = (status: SwapStatus, extra = "") => client.query(`UPDATE shift_swaps SET status = $2${extra} WHERE id = $1`, [id, status]);

    if (action === "cancel") {
      if (swap.from.id !== user?.id) throw new AppError(403, "not_yours", "Only the person who asked can cancel");
      return set("cancelled");
    }
    if (action === "accept" || action === "decline") {
      if (swap.to.id !== user?.id) throw new AppError(403, "not_yours", "Only the coworker who was asked can answer");
      if (swap.status !== "awaiting_coworker") throw conflict("swap_closed", "You've already answered this");
      if (action === "decline") return set("declined", ", coworker_responded_at = now()");
      const { rows } = await client.query("SELECT swaps_need_approval FROM courses WHERE id = $1", [course.id]);
      if (rows[0].swaps_need_approval) return set("awaiting_manager", ", coworker_responded_at = now()");
      await applySwap(client, course, swap);
      return set("approved", ", coworker_responded_at = now()");
    }
    // approve or reject
    if (!isManager) throw new AppError(403, "manager_only", "Only a manager can approve swaps");
    if (swap.status !== "awaiting_manager") throw conflict("awaiting_coworker", "The coworker hasn't accepted yet");
    await client.query("UPDATE shift_swaps SET manager_id = $2, manager_responded_at = now() WHERE id = $1", [id, user?.id ?? null]);
    if (action === "reject") return set("rejected");
    await applySwap(client, course, swap);
    return set("approved");
  });
  return publicSwap(await getSwap(db, course, id));
}

export async function getSchedulingSettings(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT swaps_need_approval FROM courses WHERE id = $1", [course.id]);
  return { swapsNeedApproval: rows[0].swaps_need_approval as boolean };
}

export async function saveSchedulingSettings(db: DbClient, course: Course, settings: { swapsNeedApproval: boolean }) {
  await db.query("UPDATE courses SET swaps_need_approval = $2 WHERE id = $1", [course.id, settings.swapsNeedApproval]);
  return getSchedulingSettings(db, course);
}
