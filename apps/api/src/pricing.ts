import type { AgeGroup, Residency } from "@golf/core";
import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";

// Pricing: the green fee rates and the add-ons (carts, rentals) managers set for the course.
//
// Bookings keep the code of each rate and add-on they were priced with, so codes never change
// and removing one only switches it off. The gas cart add-on prices riding, so it can be
// renamed and repriced but not removed.

export const RIDING_ADD_ON = "gas_cart";

export interface PriceRate {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  days: number[];
  startTime: string | null;
  endTime: string | null;
  residency: Residency | null;
  ageGroups: AgeGroup[] | null;
  isReplay: boolean;
  active: boolean;
}

export interface PriceAddOn {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  active: boolean;
  /** Prices riding, so it can't be removed. */
  locked: boolean;
}

export interface RateInput {
  name: string;
  priceCents: number;
  days: number[];
  startTime?: string | null;
  endTime?: string | null;
  residency?: Residency | null;
  ageGroups?: AgeGroup[] | null;
  isReplay?: boolean;
}

const toRate = (r: any): PriceRate => ({
  id: r.id,
  code: r.code,
  name: r.name,
  priceCents: r.price_cents,
  days: r.days,
  startTime: r.start_time,
  endTime: r.end_time,
  residency: r.residency,
  ageGroups: r.age_groups && r.age_groups.length ? r.age_groups : null,
  isReplay: r.is_replay,
  active: r.active,
});

const toAddOn = (r: any): PriceAddOn => ({
  id: r.id,
  code: r.code,
  name: r.name,
  priceCents: r.price_cents,
  active: r.active,
  locked: r.code === RIDING_ADD_ON,
});

/** A code from the name that no other rate or add-on at the course uses yet. */
async function newCode(db: DbClient, table: "rate_rules" | "add_ons", courseId: string, name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
  const { rows } = await db.query<{ code: string }>(`SELECT code FROM ${table} WHERE course_id = $1 AND code LIKE $2`, [courseId, `${base}%`]);
  const taken = new Set(rows.map((r) => r.code));
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}-${i}`;
  return code;
}

function checkWindow(input: Partial<RateInput>) {
  if (input.startTime && input.endTime && input.startTime >= input.endTime) throw badRequest("bad_window", "The start time must be before the end time");
}

export async function listRates(db: DbClient, course: Course): Promise<PriceRate[]> {
  const { rows } = await db.query(
    `SELECT * FROM rate_rules WHERE course_id = $1 AND active
      ORDER BY is_replay, days[1], start_time NULLS FIRST, residency NULLS FIRST, price_cents DESC, name`,
    [course.id],
  );
  return rows.map(toRate);
}

export async function createRate(db: DbClient, course: Course, input: RateInput): Promise<PriceRate> {
  checkWindow(input);
  const code = await newCode(db, "rate_rules", course.id, input.name);
  const { rows } = await db.query(
    `INSERT INTO rate_rules (course_id, code, name, price_cents, days, start_time, end_time, residency, age_groups, is_replay)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [course.id, code, input.name, input.priceCents, input.days, input.startTime ?? null, input.endTime ?? null, input.residency ?? null, input.ageGroups?.length ? input.ageGroups : null, input.isReplay ?? false],
  );
  return toRate(rows[0]);
}

export async function updateRate(db: DbClient, course: Course, id: string, patch: Partial<RateInput> & { active?: boolean }): Promise<PriceRate> {
  const { rows: found } = await db.query("SELECT * FROM rate_rules WHERE id = $1 AND course_id = $2", [id, course.id]);
  const cur = found[0];
  if (!cur) throw notFound("Rate");
  const next = {
    startTime: patch.startTime !== undefined ? patch.startTime : cur.start_time,
    endTime: patch.endTime !== undefined ? patch.endTime : cur.end_time,
  };
  checkWindow(next);
  const { rows } = await db.query(
    `UPDATE rate_rules SET name = $3, price_cents = $4, days = $5, start_time = $6, end_time = $7, residency = $8, age_groups = $9, is_replay = $10, active = $11
      WHERE id = $1 AND course_id = $2 RETURNING *`,
    [
      id,
      course.id,
      patch.name ?? cur.name,
      patch.priceCents ?? cur.price_cents,
      patch.days ?? cur.days,
      next.startTime,
      next.endTime,
      patch.residency !== undefined ? patch.residency : cur.residency,
      patch.ageGroups !== undefined ? (patch.ageGroups?.length ? patch.ageGroups : null) : cur.age_groups,
      patch.isReplay ?? cur.is_replay,
      patch.active ?? cur.active,
    ],
  );
  return toRate(rows[0]);
}

export async function listAddOns(db: DbClient, course: Course): Promise<PriceAddOn[]> {
  const { rows } = await db.query("SELECT * FROM add_ons WHERE course_id = $1 AND active ORDER BY name", [course.id]);
  return rows.map(toAddOn);
}

export async function createAddOn(db: DbClient, course: Course, input: { name: string; priceCents: number }): Promise<PriceAddOn> {
  const code = (await newCode(db, "add_ons", course.id, input.name)).replace(/-/g, "_");
  const { rows } = await db.query("INSERT INTO add_ons (course_id, code, name, price_cents) VALUES ($1, $2, $3, $4) RETURNING *", [course.id, code, input.name, input.priceCents]);
  return toAddOn(rows[0]);
}

export async function updateAddOn(db: DbClient, course: Course, id: string, patch: { name?: string; priceCents?: number; active?: boolean }): Promise<PriceAddOn> {
  const { rows: found } = await db.query("SELECT * FROM add_ons WHERE id = $1 AND course_id = $2", [id, course.id]);
  const cur = found[0];
  if (!cur) throw notFound("Add-on");
  if (patch.active === false && cur.code === RIDING_ADD_ON) throw conflict("add_on_in_use", "The gas cart prices riding golfers, so it can't be removed. Change its price instead.");
  const { rows } = await db.query("UPDATE add_ons SET name = $3, price_cents = $4, active = $5 WHERE id = $1 AND course_id = $2 RETURNING *", [
    id,
    course.id,
    patch.name ?? cur.name,
    patch.priceCents ?? cur.price_cents,
    patch.active ?? cur.active,
  ]);
  return toAddOn(rows[0]);
}
