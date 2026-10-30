import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import { dayRange } from "./courses.ts";
import type { DbClient } from "./db.ts";
import { badRequest } from "./errors.ts";
import { report } from "./reports.ts";

// The daily summary for the bookkeeper: one balanced journal entry per day, from the same numbers
// as the reports, in a file QuickBooks Online or Xero can import. Money taken is debited to where
// it went (the drawer, card clearing, receivables, liabilities); revenue, sales tax and money held
// for golfers are credited. Rounds paid on a different day than they're played leave a timing
// difference, which goes to a clearing account so every entry balances.

export type AccountingFormat = "quickbooks" | "xero";

export const ACCOUNT_KEYS = [
  "cash",
  "card",
  "check",
  "house_account",
  "gift_card",
  "rain_check",
  "loyalty",
  "punch_card",
  "season_pass",
  "prepaid",
  "comp",
  "green_fees",
  "carts_extras",
  "pro_shop",
  "food_bev",
  "events",
  "sales_tax",
  "clearing",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export const DEFAULT_ACCOUNTS: Record<AccountKey, string> = {
  cash: "Undeposited Funds",
  card: "Card Clearing",
  check: "Undeposited Funds",
  house_account: "Accounts Receivable - House Accounts",
  gift_card: "Gift Cards Outstanding",
  rain_check: "Rain Checks Outstanding",
  loyalty: "Loyalty Rewards",
  punch_card: "Prepaid Rounds",
  season_pass: "Prepaid Rounds",
  prepaid: "Booking Provider Receivable",
  comp: "Comps and Promotions",
  green_fees: "Green Fees",
  carts_extras: "Cart Rentals and Extras",
  pro_shop: "Pro Shop Sales",
  food_bev: "Food and Beverage Sales",
  events: "League and Outing Revenue",
  sales_tax: "Sales Tax Payable",
  clearing: "Tee Sheet Clearing",
};

export async function getAccountingSettings(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT accounting_accounts, accounting_format FROM courses WHERE id = $1", [course.id]);
  const saved = rows[0].accounting_accounts as Partial<Record<AccountKey, string>>;
  const { rows: last } = await db.query(
    `SELECT e.from_date, e.to_date, e.format, e.created_at, u.name AS staff FROM accounting_exports e LEFT JOIN staff_users u ON u.id = e.staff_user_id
      WHERE e.course_id = $1 ORDER BY e.created_at DESC LIMIT 5`,
    [course.id],
  );
  return {
    format: rows[0].accounting_format as AccountingFormat,
    accounts: Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, saved[k] || DEFAULT_ACCOUNTS[k]])) as Record<AccountKey, string>,
    defaults: DEFAULT_ACCOUNTS,
    recentExports: last.map((e) => ({ from: e.from_date, to: e.to_date, format: e.format, staff: e.staff ?? null, at: e.created_at.toISOString() })),
  };
}

export async function saveAccountingSettings(db: DbClient, course: Course, input: { format?: AccountingFormat; accounts?: Partial<Record<AccountKey, string>> }) {
  const current = await getAccountingSettings(db, course);
  const accounts = { ...current.accounts, ...input.accounts };
  // Only keep names that differ from the defaults, so a later change to a default still applies.
  const kept = Object.fromEntries(Object.entries(accounts).filter(([k, v]) => v?.trim() && v.trim() !== DEFAULT_ACCOUNTS[k as AccountKey]).map(([k, v]) => [k, v!.trim()]));
  await db.query("UPDATE courses SET accounting_accounts = $2, accounting_format = COALESCE($3, accounting_format) WHERE id = $1", [course.id, JSON.stringify(kept), input.format ?? null]);
  return getAccountingSettings(db, course);
}

export interface JournalLine {
  key: AccountKey;
  account: string;
  description: string;
  debitCents: number;
  creditCents: number;
}

const MONEY_LABEL: Partial<Record<AccountKey, string>> = {
  cash: "Cash taken",
  card: "Card payments",
  check: "Checks taken",
  house_account: "Charged to house accounts",
  gift_card: "Gift cards spent",
  rain_check: "Rain checks used",
  loyalty: "Loyalty points used",
  punch_card: "Punch card rounds",
  season_pass: "Season pass rounds",
  prepaid: "Prepaid online through the booking provider",
  comp: "Comps",
};

/** One day's balanced journal entry. */
export async function dayJournal(db: DbClient, course: Course, date: string, accounts: Record<AccountKey, string>) {
  const r = await report(db, course, date, date);
  const { start, end } = dayRange(course, date);
  // League comps are left out of league revenue in reports; here they're revenue given away, like a comped sale.
  const { rows: ec } = await db.query(
    `SELECT COALESCE(SUM(p.amount_cents), 0)::int AS cents FROM event_payments p JOIN events e ON e.id = p.event_id
      WHERE e.course_id = $1 AND p.method = 'comp' AND p.created_at >= $2 AND p.created_at < $3`,
    [course.id, start.toUTC().toISO(), end.toUTC().toISO()],
  );
  const lines: JournalLine[] = [];
  const line = (key: AccountKey, description: string, cents: number, side: "debit" | "credit") => {
    if (!cents) return;
    // A negative amount (refunds outweighing sales) goes on the other side.
    const debit = (side === "debit") === cents > 0;
    lines.push({ key, account: accounts[key], description, debitCents: debit ? Math.abs(cents) : 0, creditCents: debit ? 0 : Math.abs(cents) });
  };
  for (const key of Object.keys(MONEY_LABEL) as AccountKey[]) line(key, MONEY_LABEL[key]!, r.collected[key as keyof typeof r.collected] ?? 0, "debit");
  line("green_fees", "Green fees", r.revenue.greenFeesCents, "credit");
  line("carts_extras", "Carts and extras", r.revenue.cartsAndExtrasCents, "credit");
  line("pro_shop", "Pro shop sales", r.revenue.proShopCents, "credit");
  line("food_bev", "Food and drink sales", r.revenue.foodBevCents, "credit");
  line("events", "Leagues and outings", r.revenue.eventsCents + ec[0].cents, "credit");
  line("sales_tax", "Sales tax collected", r.revenue.salesTaxCents, "credit");
  line("gift_card", "Gift cards sold", r.other.giftCardsSoldCents, "credit");
  line("house_account", "Payments on house accounts", r.other.accountPaymentsCents, "credit");
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);
  line("clearing", "Rounds paid on a different day than played", debits - credits, "credit");
  return { date, lines, totalCents: Math.max(debits, credits) };
}

/** Every day in a range (inclusive, at most 62 days) with anything on it. */
export async function journal(db: DbClient, course: Course, from: string, to: string) {
  const a = DateTime.fromISO(from);
  const b = DateTime.fromISO(to);
  if (!a.isValid || !b.isValid || b < a) throw badRequest("invalid_range", "Pick a from date on or before the to date");
  if (b.diff(a, "days").days > 61) throw badRequest("range_too_long", "Export up to two months at a time");
  const { accounts, format } = await getAccountingSettings(db, course);
  const days = [];
  for (let d = a; d <= b; d = d.plus({ days: 1 })) {
    const day = await dayJournal(db, course, d.toISODate()!, accounts);
    if (day.lines.length) days.push(day);
  }
  return { from, to, format, days };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const amount = (cents: number) => (cents / 100).toFixed(2);

/** The import file for the course's bookkeeping system, and a record that it was exported. */
export async function exportJournal(db: DbClient, course: Course, staffId: string | undefined, from: string, to: string, format?: AccountingFormat) {
  const j = await journal(db, course, from, to);
  const fmt = format ?? j.format;
  const rows: (string | number)[][] = [];
  if (fmt === "quickbooks") {
    // QuickBooks Online's journal entry import: one row per line, grouped by journal number.
    rows.push(["Journal No", "Journal Date", "Account", "Debits", "Credits", "Description"]);
    for (const d of j.days) {
      const no = `GOLF-${d.date.replace(/-/g, "")}`;
      const when = DateTime.fromISO(d.date).toFormat("MM/dd/yyyy");
      for (const l of d.lines) rows.push([no, when, l.account, l.debitCents ? amount(l.debitCents) : "", l.creditCents ? amount(l.creditCents) : "", l.description]);
    }
  } else {
    // Xero's manual journal import: debits positive, credits negative, one narration per day.
    rows.push(["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount"]);
    for (const d of j.days) {
      const when = DateTime.fromISO(d.date).toFormat("dd/MM/yyyy");
      for (const l of d.lines) rows.push([`${course.name} daily summary ${d.date}`, when, l.description, l.account, "Tax Exempt", amount(l.debitCents - l.creditCents)]);
    }
  }
  const total = j.days.reduce((s, d) => s + d.totalCents, 0);
  await db.query("INSERT INTO accounting_exports (course_id, from_date, to_date, format, total_cents, staff_user_id) VALUES ($1, $2, $3, $4, $5, $6)", [
    course.id,
    from,
    to,
    fmt,
    total,
    staffId ?? null,
  ]);
  return {
    fileName: `${course.slug}-${fmt}-${from}${to !== from ? `-to-${to}` : ""}.csv`,
    csv: rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n",
    days: j.days.length,
  };
}
