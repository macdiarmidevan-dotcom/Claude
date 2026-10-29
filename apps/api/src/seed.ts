import { fileURLToPath } from "node:url";
import { riverBend, riverBendAddOns, riverBendRates, riverBendTeeSheet } from "@golf/core";
import { createPool, withTransaction, type Db } from "./db.ts";
import { createApiKey } from "./keys.ts";
import { migrate } from "./migrate.ts";

const PLACEHOLDER_WAIVER = `SAMPLE TEXT, NOT LEGAL ADVICE. Replace with the course's own reviewed waiver.

By signing, I confirm that I am at least 16 years old and hold a valid driver's license, and that I will be the driver of this cart.

I will follow all posted cart rules and the instructions of course staff, keep the cart on paths where marked, and stay off greens, tees and wet areas. No more than two riders and two bags per cart. I will not drive under the influence of alcohol or drugs.

I understand that operating a golf cart involves risk of injury and property damage. I accept responsibility for the cart while it is assigned to me and for any damage caused by misuse, and I release the course and its operator from liability for injuries or damage caused by my own negligence, to the extent allowed by law.`;

/** Creates River Bend with its rates, add-ons and tee sheet, plus a staff API key. */
export async function seedRiverBend(db: Db) {
  return withTransaction(db, async (client) => {
    const existing = await client.query("SELECT id FROM courses WHERE slug = $1", [riverBend.slug]);
    if (existing.rows[0]) throw new Error(`Course "${riverBend.slug}" already exists`);

    const { rows: orgs } = await client.query<{ id: string }>(
      "INSERT INTO organizations (name) VALUES ('Lisle Park District') RETURNING id",
    );
    const { rows: courses } = await client.query<{ id: string }>(
      `INSERT INTO courses (organization_id, slug, name, time_zone, holes, address, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [orgs[0]!.id, riverBend.slug, riverBend.name, riverBend.timeZone, riverBend.holes, riverBend.address, riverBend.phone],
    );
    const courseId = courses[0]!.id;

    for (const [i, t] of riverBendTeeSheet.entries()) {
      await client.query(
        `INSERT INTO tee_sheet_templates (course_id, weekdays, first_tee, last_tee, interval_minutes, max_players, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [courseId, t.weekdays, t.firstTee, t.lastTee, t.intervalMinutes, t.maxPlayers, i],
      );
    }
    for (const r of riverBendRates) {
      await client.query(
        `INSERT INTO rate_rules (course_id, code, name, price_cents, days, start_time, end_time, residency, age_groups, is_replay)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [courseId, r.id, r.name, r.priceCents, r.days, r.startTime ?? null, r.endTime ?? null, r.residency ?? null, r.ageGroups ?? null, r.isReplay ?? false],
      );
    }
    for (const a of riverBendAddOns) {
      await client.query("INSERT INTO add_ons (course_id, code, name, price_cents) VALUES ($1, $2, $3, $4)", [
        courseId,
        a.code,
        a.name,
        a.priceCents,
      ]);
    }

    // Placeholder wording: the course (Lisle Park District) must supply its own reviewed waiver text.
    await client.query("INSERT INTO course_waivers (course_id, version, title, body) VALUES ($1, 1, $2, $3)", [
      courseId,
      "Golf Cart Rules and Liability Waiver",
      PLACEHOLDER_WAIVER,
    ]);

    const secretKey = await createApiKey(client, courseId, "secret", "River Bend staff");
    return { courseId, secretKey };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool();
  await migrate(db);
  const { secretKey } = await seedRiverBend(db);
  console.log("Seeded River Bend Golf Club. Save this key, it won't be shown again:");
  console.log(`  Secret key (staff): ${secretKey}`);
  await db.end();
}
