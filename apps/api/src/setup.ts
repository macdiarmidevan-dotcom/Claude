import type { Course } from "./courses.ts";
import type { DbClient } from "./db.ts";

// A go-live checklist for managers: what a course still has to set up before it can run a
// day on this system. Every item is worked out from what's saved, so it ticks itself off.

export interface SetupItem {
  id: string;
  title: string;
  detail: string;
  /** done counts toward ready; optional items never block it. */
  status: "done" | "todo" | "optional";
  /** The screen that fixes it, for the app's link. */
  where: "staff" | "pricing" | "sync" | "settings" | "inventory" | "reports" | "none";
}

const count = async (db: DbClient, sql: string, params: unknown[]) => (await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0;

export async function setupChecklist(db: DbClient, course: Course) {
  const id = [course.id];
  const staff = await count(db, "SELECT count(*)::int AS n FROM staff_users WHERE course_id = $1 AND active", id);
  const unpaid = await count(db, "SELECT count(*)::int AS n FROM staff_users WHERE course_id = $1 AND active AND pay_type IS NULL", id);
  const rates = await count(db, "SELECT count(*)::int AS n FROM rate_rules WHERE course_id = $1 AND active", id);
  const tax = await count(db, "SELECT count(*)::int AS n FROM courses WHERE id = $1 AND sales_tax_bps > 0", id);
  const sync = (await db.query<{ enabled: boolean; last_status: string | null }>("SELECT enabled, last_status FROM sync_connections WHERE course_id = $1", id)).rows[0];
  const cards = await count(db, "SELECT count(*)::int AS n FROM payment_settings WHERE course_id = $1 AND provider <> 'standalone'", id);
  const waiver = await count(db, "SELECT count(*)::int AS n FROM course_waivers WHERE course_id = $1 AND version > 1", id);
  const products = await count(db, "SELECT count(*)::int AS n FROM products WHERE course_id = $1 AND active", id);
  const carts = await count(db, "SELECT count(*)::int AS n FROM fleet_assets WHERE course_id = $1", id);
  const opened = await count(db, "SELECT count(*)::int AS n FROM day_opens WHERE course_id = $1", id);

  const items: SetupItem[] = [
    {
      id: "staff",
      title: "Add your staff",
      detail: staff > 1 ? `${staff} people can sign in.` : "Only one account so far. Add the pro shop, starters and cart staff so each person signs in as themselves.",
      status: staff > 1 ? "done" : "todo",
      where: "staff",
    },
    {
      id: "pay",
      title: "Set everyone's pay",
      detail: unpaid === 0 ? "Pay is set for everyone, so the labor report is complete." : `${unpaid} ${unpaid === 1 ? "person has" : "people have"} no pay set, so ${unpaid === 1 ? "their" : "their"} hours cost nothing in the labor report.`,
      status: unpaid === 0 ? "done" : "todo",
      where: "staff",
    },
    {
      id: "rates",
      title: "Check your green fees",
      detail: rates ? `${rates} rates are set up. Open Pricing and check them against your rate sheet.` : "No green fees yet. Add them in Pricing before the tee sheet can price a round.",
      status: rates ? "done" : "todo",
      where: "pricing",
    },
    {
      id: "tax",
      title: "Set the sales tax rate",
      detail: tax ? "Sales tax is set for the register." : "The register is charging no sales tax. Set your rate under Pro shop settings.",
      status: tax ? "done" : "todo",
      where: "inventory",
    },
    {
      id: "sync",
      title: "Connect your booking system",
      detail: !sync
        ? "Not connected. Add the TeeItUp report link in Sync tee sheet so bookings flow in on their own."
        : !sync.enabled
          ? "Sync is turned off."
          : sync.last_status === "ok"
            ? "Syncing. The last pull worked."
            : sync.last_status === "waiting"
              ? "Waiting for the provider to grant access."
              : "The last sync failed. Open Sync tee sheet for the reason.",
      status: sync?.enabled && sync.last_status === "ok" ? "done" : "todo",
      where: "sync",
    },
    {
      id: "waiver",
      title: "Put your own wording in the cart waiver",
      detail: waiver ? "Your waiver is in use. Have the course's lawyer or park district review it." : "Drivers are signing the sample waiver. Replace it with text your lawyer approves.",
      status: waiver ? "done" : "todo",
      where: "settings",
    },
    {
      id: "carts",
      title: "Add your carts to the fleet",
      detail: carts ? `${carts} in the fleet.` : "No carts yet. Once added, the starter can only assign carts that are in service.",
      status: carts ? "done" : "todo",
      where: "reports",
    },
    {
      id: "drawer",
      title: "Do a practice start-of-day",
      detail: opened ? "A day has been opened with starting cash." : "Open the day with a starting cash amount at the pro shop, once, to be sure it works.",
      status: opened ? "done" : "todo",
      where: "reports",
    },
    {
      id: "products",
      title: "Enter your pro shop stock",
      detail: products ? `${products} products are set up.` : "No products yet. Add them (with cost, for margin reports) or skip this if the pro shop isn't on this system.",
      status: products ? "done" : "optional",
      where: "inventory",
    },
    {
      id: "cards",
      title: "Connect a card reader",
      detail: cards ? "A card processor is connected." : "Cards are recorded only, taken on your own terminal. Connect Stripe or Square to charge from here.",
      status: cards ? "done" : "optional",
      where: "settings",
    },
    {
      id: "server-sync",
      title: "Server: set SYNC_SECRET",
      detail: process.env.SYNC_SECRET ? "Set." : "Needed to store a provider's API sign-in. Set it to a long random string on the server.",
      status: process.env.SYNC_SECRET ? "done" : "optional",
      where: "none",
    },
    {
      id: "server-ai",
      title: "Server: set ANTHROPIC_API_KEY",
      detail: process.env.ANTHROPIC_API_KEY ? "Set. The help assistant and Ask your data use Claude." : "Without it the help assistant answers from the guides only, and Ask your data gives a quick summary of one report.",
      status: process.env.ANTHROPIC_API_KEY ? "done" : "optional",
      where: "none",
    },
  ];
  const needed = items.filter((i) => i.status !== "optional");
  return { items, done: needed.filter((i) => i.status === "done").length, total: needed.length };
}
