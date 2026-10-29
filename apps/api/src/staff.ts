import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { DbClient } from "./db.ts";
import { AppError, badRequest, conflict, notFound } from "./errors.ts";
import type { KeyRole } from "./keys.ts";

// Employee and manager accounts. People sign in with their email and password and get a
// session token (st_…) that the app sends like an API key.

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SESSION_DAYS = 14;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: KeyRole;
  /** The job they do, such as Pro Shop or Cart Attendant. */
  employeeType: { id: string; name: string } | null;
  active: boolean;
  lastLoginAt: string | null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scrypt(password, salt, 32)).toString("base64")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(password, Buffer.from(salt, "base64"), 32);
  return timingSafeEqual(actual, Buffer.from(expected, "base64"));
}

export function validatePassword(password: string) {
  if (password.length < 8) throw badRequest("weak_password", "Passwords need at least 8 characters");
}

const toUser = (r: any): StaffUser => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  employeeType: r.employee_type_id ? { id: r.employee_type_id, name: r.employee_type_name } : null,
  active: r.active,
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
});

// Staff rows with their employee type's name, for toUser.
const USERS = `SELECT u.*, et.name AS employee_type_name FROM staff_users u LEFT JOIN employee_types et ON et.id = u.employee_type_id`;

async function getUser(db: DbClient, id: string) {
  const { rows } = await db.query(`${USERS} WHERE u.id = $1`, [id]);
  return toUser(rows[0]);
}

export const DEFAULT_EMPLOYEE_TYPES = ["Pro Shop", "Ranger/Starter", "Cart Attendant", "Bartender", "Food & Beverage", "Grounds Crew"];

export async function addDefaultEmployeeTypes(db: DbClient, courseId: string) {
  for (const [i, name] of DEFAULT_EMPLOYEE_TYPES.entries()) {
    await db.query("INSERT INTO employee_types (course_id, name, position) VALUES ($1, $2, $3)", [courseId, name, i + 1]);
  }
}

export interface EmployeeType {
  id: string;
  name: string;
  active: boolean;
  /** How many active accounts have this type. */
  staffCount: number;
}

export async function listEmployeeTypes(db: DbClient, courseId: string): Promise<EmployeeType[]> {
  const { rows } = await db.query(
    `SELECT et.*, (SELECT count(*)::int FROM staff_users u WHERE u.employee_type_id = et.id AND u.active) AS staff_count
       FROM employee_types et WHERE et.course_id = $1
      ORDER BY et.active DESC, et.position, lower(et.name)`,
    [courseId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.active, staffCount: r.staff_count }));
}

const typeTaken = (err: unknown) => (err as { code?: string }).code === "23505";

export async function createEmployeeType(db: DbClient, courseId: string, name: string): Promise<EmployeeType> {
  try {
    const { rows } = await db.query(
      `INSERT INTO employee_types (course_id, name, position)
       VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM employee_types WHERE course_id = $1)) RETURNING *`,
      [courseId, name.trim()],
    );
    return { id: rows[0].id, name: rows[0].name, active: true, staffCount: 0 };
  } catch (err) {
    if (typeTaken(err)) throw conflict("type_exists", `There's already a type called ${name.trim()}`);
    throw err;
  }
}

/** Renames a type, or removes it (active: false). People who had a removed type keep it until they're changed. */
export async function updateEmployeeType(db: DbClient, courseId: string, id: string, patch: { name?: string; active?: boolean }) {
  try {
    const { rowCount } = await db.query(
      "UPDATE employee_types SET name = COALESCE($3, name), active = COALESCE($4, active) WHERE id = $1 AND course_id = $2",
      [id, courseId, patch.name?.trim() ?? null, patch.active ?? null],
    );
    if (!rowCount) throw notFound("Employee type");
  } catch (err) {
    if (typeTaken(err)) throw conflict("type_exists", `There's already a type called ${patch.name?.trim()}`);
    throw err;
  }
  return (await listEmployeeTypes(db, courseId)).find((t) => t.id === id)!;
}

async function checkType(db: DbClient, courseId: string, typeId: string | null | undefined) {
  if (!typeId) return;
  const { rows } = await db.query("SELECT 1 FROM employee_types WHERE id = $1 AND course_id = $2 AND active", [typeId, courseId]);
  if (!rows[0]) throw badRequest("invalid_employee_type", "Choose one of the course's employee types");
}

// Slows down password guessing: after 5 wrong tries an email is locked for 15 minutes.
const failures = new Map<string, { count: number; until: number }>();

export async function login(db: DbClient, courseId: string, email: string, password: string) {
  const key = `${courseId}:${email.trim().toLowerCase()}`;
  const f = failures.get(key);
  if (f && f.count >= 5 && f.until > Date.now()) {
    throw new AppError(429, "too_many_attempts", "Too many wrong passwords. Try again in 15 minutes or ask a manager to reset it");
  }
  const { rows } = await db.query(`${USERS} WHERE u.course_id = $1 AND lower(u.email) = lower($2)`, [courseId, email.trim()]);
  const row = rows[0];
  // Check a password even when there's no such person, so timing doesn't reveal who has an account.
  const ok = await checkPassword(password, row?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!row || !ok || !row.active) {
    const prev = f && f.until > Date.now() ? f.count : 0;
    failures.set(key, { count: prev + 1, until: Date.now() + 15 * 60_000 });
    throw new AppError(401, "wrong_login", row && ok && !row.active ? "This account has been turned off. Ask a manager" : "Wrong email or password");
  }
  failures.delete(key);
  const token = `st_${randomBytes(24).toString("base64url")}`;
  await db.query("INSERT INTO staff_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + $3::interval)", [
    row.id,
    hash(token),
    `${SESSION_DAYS} days`,
  ]);
  await db.query("UPDATE staff_users SET last_login_at = now() WHERE id = $1", [row.id]);
  return { token, user: toUser(row) };
}

export interface SessionContext {
  sessionId: string;
  courseId: string;
  user: StaffUser;
}

/** Finds a live session for a token. Each use pushes the expiry out, so a busy iPad stays signed in. */
export async function lookupSession(db: DbClient, token: string): Promise<SessionContext | undefined> {
  const { rows } = await db.query(
    `UPDATE staff_sessions s SET expires_at = now() + $2::interval
       FROM staff_users u
      WHERE s.token_hash = $1 AND u.id = s.user_id AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active
      RETURNING s.id AS session_id, u.*, (SELECT name FROM employee_types WHERE id = u.employee_type_id) AS employee_type_name`,
    [hash(token), `${SESSION_DAYS} days`],
  );
  const r = rows[0];
  return r && { sessionId: r.session_id, courseId: r.course_id, user: toUser(r) };
}

export async function logout(db: DbClient, sessionId: string) {
  await db.query("UPDATE staff_sessions SET revoked_at = now() WHERE id = $1", [sessionId]);
}

export async function listStaff(db: DbClient, courseId: string): Promise<StaffUser[]> {
  const { rows } = await db.query(`${USERS} WHERE u.course_id = $1 ORDER BY u.active DESC, lower(u.name)`, [courseId]);
  return rows.map(toUser);
}

export async function createStaff(
  db: DbClient,
  courseId: string,
  input: { name: string; email: string; role: KeyRole; password: string; employeeTypeId?: string | null },
) {
  validatePassword(input.password);
  await checkType(db, courseId, input.employeeTypeId);
  try {
    const { rows } = await db.query(
      "INSERT INTO staff_users (course_id, name, email, role, password_hash, employee_type_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [courseId, input.name.trim(), input.email.trim().toLowerCase(), input.role, await hashPassword(input.password), input.employeeTypeId ?? null],
    );
    return getUser(db, rows[0].id);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("email_taken", "Someone here already uses that email");
    throw err;
  }
}

/**
 * Changes someone's name, role, password or whether they can sign in. Turning an account off or
 * resetting its password signs that person out everywhere. The course always keeps one active manager.
 */
export async function updateStaff(
  db: DbClient,
  courseId: string,
  actorId: string | undefined,
  id: string,
  patch: { name?: string; role?: KeyRole; active?: boolean; password?: string; employeeTypeId?: string | null },
) {
  const { rows } = await db.query("SELECT * FROM staff_users WHERE id = $1 AND course_id = $2", [id, courseId]);
  const current = rows[0];
  if (!current) throw notFound("Staff member");
  const losesManager = current.role === "manager" && current.active && (patch.role === "staff" || patch.active === false);
  if (losesManager) {
    if (id === actorId) throw conflict("self_demote", "You can't remove your own manager access. Ask another manager");
    const { rows: others } = await db.query(
      "SELECT count(*)::int AS n FROM staff_users WHERE course_id = $1 AND role = 'manager' AND active AND id <> $2",
      [courseId, id],
    );
    if (others[0].n === 0) throw conflict("last_manager", "The course needs at least one active manager");
  }
  if (patch.password !== undefined) validatePassword(patch.password);
  await checkType(db, courseId, patch.employeeTypeId);
  await db.query(
    `UPDATE staff_users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
            password_hash = COALESCE($5, password_hash),
            employee_type_id = CASE WHEN $6 THEN $7::uuid ELSE employee_type_id END
      WHERE id = $1`,
    [
      id,
      patch.name?.trim() ?? null,
      patch.role ?? null,
      patch.active ?? null,
      patch.password ? await hashPassword(patch.password) : null,
      patch.employeeTypeId !== undefined,
      patch.employeeTypeId ?? null,
    ],
  );
  if (patch.active === false || patch.password !== undefined) {
    await db.query("UPDATE staff_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
  }
  return getUser(db, id);
}

export async function changeOwnPassword(db: DbClient, user: StaffUser, sessionId: string, current: string, next: string) {
  const { rows } = await db.query("SELECT password_hash FROM staff_users WHERE id = $1", [user.id]);
  if (!(await checkPassword(current, rows[0].password_hash))) throw new AppError(400, "wrong_password", "Your current password isn't right");
  validatePassword(next);
  await db.query("UPDATE staff_users SET password_hash = $2 WHERE id = $1", [user.id, await hashPassword(next)]);
  // Other devices sign in again; this one stays signed in.
  await db.query("UPDATE staff_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [user.id, sessionId]);
}

export async function logActivity(
  db: DbClient,
  entry: { courseId: string; userId?: string; actor: string; action: string; bookingId?: string; detail?: object },
) {
  await db.query("INSERT INTO activity_log (course_id, user_id, actor, action, booking_id, detail) VALUES ($1, $2, $3, $4, $5, $6)", [
    entry.courseId,
    entry.userId ?? null,
    entry.actor,
    entry.action,
    entry.bookingId ?? null,
    JSON.stringify(entry.detail ?? {}),
  ]);
}

export async function listActivity(db: DbClient, courseId: string, limit = 100) {
  const { rows } = await db.query(
    `SELECT a.actor, a.action, a.detail, a.created_at, a.booking_id, c.name AS golfer
       FROM activity_log a LEFT JOIN bookings b ON b.id = a.booking_id LEFT JOIN customers c ON c.id = b.customer_id
      WHERE a.course_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [courseId, limit],
  );
  return rows.map((r) => ({ actor: r.actor, action: r.action, golfer: r.golfer ?? null, bookingId: r.booking_id, detail: r.detail, at: r.created_at.toISOString() }));
}
