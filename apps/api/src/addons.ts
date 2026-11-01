import { addOnSettings, type AddOnKey, type AddOnSettings } from "@golf/core";
import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";

// Which add-ons the course has switched on. See ADD_ONS in @golf/core for the list.

export async function getAddOnSettings(db: DbClient, course: Course): Promise<AddOnSettings> {
  const { rows } = await db.query<{ key: string; enabled: boolean }>("SELECT key, enabled FROM course_add_ons WHERE course_id = $1", [course.id]);
  return addOnSettings(Object.fromEntries(rows.map((r) => [r.key, r.enabled])));
}

export async function setAddOn(db: DbClient, course: Course, key: AddOnKey, enabled: boolean): Promise<AddOnSettings> {
  await db.query(
    `INSERT INTO course_add_ons (course_id, key, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (course_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [course.id, key, enabled],
  );
  return getAddOnSettings(db, course);
}
