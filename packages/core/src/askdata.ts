import { DateTime } from "luxon";

// "Ask your data": managers ask about the course's numbers in plain words. With Claude set up on
// the server, Claude reads the reports and answers; without it (and in the demo) the question is
// matched to one report and period here, and quickAnswer sums that report up in a few sentences.

/** The manager reports an answer can come from, named after their tabs. */
export type DataTopic = "revenue" | "rounds" | "labor" | "inventory" | "balances";

export const DATA_TOPIC_LABEL: Record<DataTopic, string> = {
  revenue: "Revenue",
  rounds: "Rounds & tee sheet",
  labor: "Labor",
  inventory: "Inventory",
  balances: "Payments & balances",
};

/** A report the answer used, so the app can open it on the same dates. */
export interface DataSource {
  tab: DataTopic;
  from: string;
  to: string;
}

export interface DataAnswer {
  answer: string;
  sources: DataSource[];
  /** "ai" when Claude wrote the answer; "summary" when it's the quick summary of one report. */
  via: "ai" | "summary";
}

export interface DataTurn {
  role: "user" | "assistant";
  content: string;
}

export const ASK_DATA_EXAMPLES = [
  "How did revenue this month compare with last month?",
  "How full was the tee sheet last week?",
  "What was labor cost as a share of revenue this month?",
  "What needs reordering in the pro shop?",
  "How much do members owe on house accounts?",
];

export interface DataQuestion {
  topic: DataTopic;
  from: string;
  to: string;
  /** The period in words, such as "this month" or "October". */
  period: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const TOPIC_WORDS: [DataTopic, RegExp][] = [
  ["labor", /\b(labou?r|payroll|wages?|overtime|hours worked|staff(ing)? cost|pay)\b/],
  ["inventory", /\b(inventory|stock\w*|reorder\w*|restock\w*|margins?|best.?sell|selling|sold|slow.?mov|shrink|merchandise|products?|items?)\b/],
  ["balances", /\b(gift ?cards?|house accounts?|owes?|owed|owing|outstanding|liabilit\w*|rain ?checks?|punch ?cards?|loyalty|balances?|tenders?|cash|card payments|collected|paid by)\b/],
  ["rounds", /\b(rounds?|players?|golfers?|occupancy|utili[sz]\w*|full|busy|busiest|quiet|no.?shows?|tee ?times?|booked|bookings?|spots|rate mix|walking|riding|9 holes|18 holes)\b/],
];

/** Which report and dates a question is about. Questions with no period mean the last 7 days. */
export function parseDataQuestion(question: string, today: string): DataQuestion {
  const q = question.toLowerCase();
  const topic = TOPIC_WORDS.find(([, re]) => re.test(q))?.[0] ?? "revenue";
  return { topic, ...periodOf(q, DateTime.fromISO(today)) };
}

function periodOf(q: string, today: DateTime): { from: string; to: string; period: string } {
  const d = (x: DateTime) => x.toISODate()!;
  const t = d(today);
  const lastWeek = today.startOf("week").minus({ weeks: 1 });
  const lastMonth = today.startOf("month").minus({ months: 1 });
  const lastYear = today.startOf("year").minus({ years: 1 });
  const periods: [RegExp, () => { from: string; to: string; period: string }][] = [
    [/\byesterday\b/, () => ({ from: d(today.minus({ days: 1 })), to: d(today.minus({ days: 1 })), period: "yesterday" })],
    [/\btoday\b/, () => ({ from: t, to: t, period: "today" })],
    [/\blast week\b/, () => ({ from: d(lastWeek), to: d(lastWeek.plus({ days: 6 })), period: "last week" })],
    [/\bthis week\b/, () => ({ from: d(today.startOf("week")), to: t, period: "this week" })],
    [/\b(last|past) 30 days\b/, () => ({ from: d(today.minus({ days: 29 })), to: t, period: "the last 30 days" })],
    [/\blast month\b/, () => ({ from: d(lastMonth), to: d(lastMonth.endOf("month")), period: "last month" })],
    [/\b(this month|month to date|mtd)\b/, () => ({ from: d(today.startOf("month")), to: t, period: "this month" })],
    [/\blast year\b/, () => ({ from: d(lastYear), to: d(lastYear.endOf("year")), period: "last year" })],
    [/\b(this year|year to date|ytd|this season)\b/, () => ({ from: d(today.startOf("year")), to: t, period: "this year so far" })],
    // A month by name: "in October". "May" needs "in" or "for" in front, since it's also a verb.
    ...MONTHS.map((m, i): [RegExp, () => { from: string; to: string; period: string }] => [
      m === "may" ? /\b(in|for|during|of) may\b/ : new RegExp(`\\b${m}\\b`),
      () => {
        let start = today.set({ month: i + 1, day: 1 });
        if (start > today) start = start.minus({ years: 1 });
        const end = DateTime.min(start.endOf("month"), today);
        return { from: d(start), to: d(end), period: start.year === today.year ? cap(m) : `${cap(m)} ${start.year}` };
      },
    ]),
  ];
  // The period named first is the one asked about: "this month compared with last month" means this month.
  let best: { at: number; make: () => { from: string; to: string; period: string } } | undefined;
  for (const [re, make] of periods) {
    const at = q.search(re);
    if (at >= 0 && (!best || at < best.at)) best = { at, make };
  }
  return best ? best.make() : { from: d(today.minus({ days: 6 })), to: t, period: "the last 7 days" };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The parts of each report the quick summary reads. The full reports have more.

interface DepartmentsLike {
  greenFeesCents: number;
  cartsAndExtrasCents: number;
  proShopCents: number;
  foodBevCents: number;
  eventsCents: number;
  totalCents: number;
}
interface RoundsLike {
  rounds: number;
  noShows: number;
  occupancy: number | null;
  holes9: number;
  holes18: number;
  riding: number;
  walking: number;
  weekday: { occupancy: number | null };
  weekend: { occupancy: number | null };
}
export interface OverviewLike {
  from: string;
  to: string;
  compare: { kind: string } | null;
  revenue: DepartmentsLike;
  rounds: RoundsLike;
  yield: { revenuePerRoundCents: number | null; avgGreenFeeCents: number | null };
  budget: { revenue: { totalCents: number } } | null;
  previous: { revenue: { totalCents: number }; rounds: { rounds: number; occupancy: number | null } } | null;
}
export interface LaborLike {
  totals: { hours: number; overtimeHours: number; costCents: number; revenueCents: number; laborPct: number | null; revenuePerHourCents: number | null };
  people: { name: string; costCents: number }[];
  missingPay: number;
}
export interface InventoryLike {
  sales: { revenueCents: number; units: number; marginPct: number | null };
  items: { name: string; units: number; revenueCents: number; foodBev?: boolean }[];
  stock: { products: number; costCents: number; retailCents: number };
  reorder: { name: string; stock: number; reorderLevel: number }[];
}
export interface BalancesLike {
  collected: Record<string, number> & { totalCents: number };
  held: { giftCards: { cents: number }; rainChecks: { cents: number; open: number }; punchCards: { cents: number }; loyalty: { cents: number }; totalCents: number };
  receivable: { accounts: number; cents: number; overLimit: number; largest: { name: string; balanceCents: number }[] };
}
export type DataReport =
  | { topic: "revenue" | "rounds"; data: OverviewLike }
  | { topic: "labor"; data: LaborLike }
  | { topic: "inventory"; data: InventoryLike }
  | { topic: "balances"; data: BalancesLike };

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const money2 = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const n = (x: number) => x.toLocaleString("en-US");
const pctOf = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (date: string) => `${MONTH_SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

/** Dates in words, e.g. "Nov 1 to Nov 8", or "Nov 8" for one day. */
export function dateSpan(from: string, to: string) {
  return from === to ? short(from) : `${short(from)} to ${short(to)}`;
}

/** The period with its dates, e.g. "this month (Nov 1 to Nov 8)". */
export function periodWithDates(period: string, from: string, to: string) {
  return `${period} (${dateSpan(from, to)})`;
}

function change(now: number, before: number, kind: string) {
  if (!before) return "";
  const p = Math.round(((now - before) / before) * 100);
  const vs = kind === "last_year" ? "the same dates last year" : "the period before";
  return p === 0 ? ` That's level with ${vs}.` : ` That's ${p > 0 ? "up" : "down"} ${Math.abs(p)}% on ${vs} (${money(before)}).`;
}

const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** A few sentences that answer the question from one report, for when Claude isn't set up. */
export function quickAnswer(q: DataQuestion, report: DataReport): string {
  const when = periodWithDates(q.period, q.from, q.to);
  switch (report.topic) {
    case "revenue": {
      const o = report.data;
      const r = o.revenue;
      const parts = (
        [
          ["green fees", r.greenFeesCents],
          ["carts and extras", r.cartsAndExtrasCents],
          ["pro shop", r.proShopCents],
          ["food and drink", r.foodBevCents],
          ["leagues and outings", r.eventsCents],
        ] as const
      )
        .filter(([, c]) => c > 0)
        .map(([label, c]) => `${label} ${money(c)}`);
      let s = `Revenue for ${when} was ${money(r.totalCents)}${parts.length ? `: ${list(parts)}` : ""}.`;
      if (o.previous && o.compare) s += change(r.totalCents, o.previous.revenue.totalCents, o.compare.kind);
      if (o.rounds.rounds) s += ` ${n(o.rounds.rounds)} rounds brought in ${o.yield.revenuePerRoundCents == null ? "–" : money2(o.yield.revenuePerRoundCents)} each.`;
      if (o.budget?.revenue.totalCents) s += ` That's ${Math.round((r.totalCents / o.budget.revenue.totalCents) * 100)}% of budget (${money(o.budget.revenue.totalCents)}).`;
      return s;
    }
    case "rounds": {
      const o = report.data;
      const r = o.rounds;
      let s = `${n(r.rounds)} rounds for ${when}, filling ${pctOf(r.occupancy)} of the open spots on the tee sheet.`;
      if (o.previous && o.compare) {
        const before = o.previous.rounds.rounds;
        if (before) {
          const p = Math.round(((r.rounds - before) / before) * 100);
          s += ` That's ${p === 0 ? "level with" : `${p > 0 ? "up" : "down"} ${Math.abs(p)}% on`} ${o.compare.kind === "last_year" ? "the same dates last year" : "the period before"} (${n(before)}).`;
        }
      }
      s += ` Weekdays were ${pctOf(r.weekday.occupancy)} full and weekends ${pctOf(r.weekend.occupancy)}.`;
      if (r.rounds) s += ` ${n(r.holes18)} were 18 holes and ${n(r.holes9)} were 9; ${n(r.riding)} rode and ${n(r.walking)} walked.`;
      s += r.noShows ? ` ${n(r.noShows)} players didn't show.` : " Nobody was a no-show.";
      return s;
    }
    case "labor": {
      const l = report.data;
      const t = l.totals;
      let s = `Labor cost ${money(t.costCents)} for ${when}: ${n(Math.round(t.hours))} hours${t.overtimeHours ? `, ${n(Math.round(t.overtimeHours))} of them overtime` : ""}.`;
      if (t.laborPct != null) s += ` That's ${t.laborPct}% of revenue (${money(t.revenueCents)}), or ${t.revenuePerHourCents == null ? "–" : money2(t.revenuePerHourCents)} of revenue per labor hour.`;
      const top = [...l.people].sort((a, b) => b.costCents - a.costCents).filter((p) => p.costCents > 0).slice(0, 3);
      if (top.length) s += ` The biggest costs were ${list(top.map((p) => `${p.name} (${money(p.costCents)})`))}.`;
      if (l.missingPay) s += ` ${l.missingPay} ${l.missingPay === 1 ? "person has" : "people have"} hours but no pay set, so their hours aren't counted.`;
      return s;
    }
    case "inventory": {
      const i = report.data;
      let s = `For ${when}, register sales were ${n(i.sales.units)} items for ${money(i.sales.revenueCents)}${i.sales.marginPct == null ? "" : `, at a ${i.sales.marginPct}% margin`}.`;
      const best = i.items.filter((x) => !x.foodBev).sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 3);
      if (best.length) s += ` Best sellers: ${list(best.map((b) => `${b.name} (${money(b.revenueCents)})`))}.`;
      if (i.reorder.length) {
        const names = i.reorder.slice(0, 5).map((r) => `${r.name} (${r.stock} left)`);
        s += ` ${i.reorder.length} ${i.reorder.length === 1 ? "product is" : "products are"} at or below the reorder level: ${list(names)}${i.reorder.length > 5 ? " and more" : ""}.`;
      } else s += " Nothing is at its reorder level.";
      s += ` Stock on hand is worth ${money(i.stock.costCents)} at cost.`;
      return s;
    }
    case "balances": {
      const b = report.data;
      const tenders = (
        [
          ["cash", "cash"],
          ["card", "card"],
          ["check", "check"],
          ["gift_card", "gift cards"],
          ["house_account", "house accounts"],
        ] as const
      )
        .filter(([k]) => (b.collected[k] ?? 0) > 0)
        .map(([k, label]) => `${label} ${money(b.collected[k]!)}`);
      let s = `For ${when}, the course took in ${money(b.collected.totalCents)}${tenders.length ? `: ${list(tenders)}` : ""}.`;
      const h = b.held;
      s += ` Right now it holds ${money(h.totalCents)} for golfers: gift cards ${money(h.giftCards.cents)}, ${h.rainChecks.open} open rain checks ${money(h.rainChecks.cents)}, punch cards ${money(h.punchCards.cents)} and loyalty points ${money(h.loyalty.cents)}.`;
      const r = b.receivable;
      if (r.accounts) {
        s += ` Members owe ${money(r.cents)} on ${r.accounts} house ${r.accounts === 1 ? "account" : "accounts"}`;
        if (r.largest[0]) s += `; the largest is ${r.largest[0].name} at ${money(r.largest[0].balanceCents)}`;
        s += r.overLimit ? `, and ${r.overLimit} ${r.overLimit === 1 ? "is" : "are"} over the limit.` : ".";
      }
      return s;
    }
  }
}
