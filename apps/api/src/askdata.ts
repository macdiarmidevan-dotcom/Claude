import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { z } from "zod";
import { parseDataQuestion, quickAnswer, type DataAnswer, type DataReport, type DataSource, type DataTopic, type DataTurn } from "@golf/core";
import type { Course } from "./courses.ts";
import type { Db } from "./db.ts";
import { badRequest } from "./errors.ts";
import { managerOverview } from "./analytics.ts";
import { laborReport } from "./labor.ts";
import { balancesReport, inventoryReport } from "./shopreports.ts";
import { getBudget } from "./budgets.ts";
import { daySummary, groupsForDay } from "./insights.ts";

// "Ask your data" for managers: a question about the course's numbers, answered from the manager
// reports. With ANTHROPIC_API_KEY set on the server, Claude reads the reports through the tools
// below (all read-only) and writes the answer; without it, or if Claude can't be reached, the
// question is matched to one report and period and that report is summed up (quickAnswer).
// Each answer lists the reports it used, so the manager can open them on the same dates.

export interface DataTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

/** Runs the conversation with Claude. Swappable so tests don't call Claude. */
export type DataAi = (input: {
  system: string;
  messages: DataTurn[];
  tools: DataTool[];
  /** Runs one tool and returns its JSON. Throws with a message Claude can read if the input is wrong. */
  runTool: (name: string, input: unknown) => Promise<string>;
}) => Promise<string>;

export const DATA_MODEL = "claude-opus-5-5";
const MAX_TURNS = 8;

/** The Claude-backed version, or undefined when the server has no API key. */
export function claudeDataAi(apiKey = process.env.ANTHROPIC_API_KEY): DataAi | undefined {
  if (!apiKey) return undefined;
  const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  return async ({ system, messages, tools, runTool }) => {
    const convo: Anthropic.Beta.BetaMessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await client.beta.messages.create({
        model: DATA_MODEL,
        max_tokens: 16000,
        // If a safety check declines, the API retries on a fallback model it picks.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        // The tools and instructions are the same for every question on a day, so they're cached.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: tools.map((t) => ({ ...t, strict: true })),
        messages: convo,
      });
      if (res.stop_reason === "refusal") throw new Error("declined");
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !calls.length) {
        if (!text) throw new Error("no answer");
        return text;
      }
      // Keep the whole reply (thinking included) and answer every tool call in one message.
      convo.push({ role: "assistant", content: res.content });
      const results = await Promise.all(
        calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          try {
            return { type: "tool_result", tool_use_id: c.id, content: await runTool(c.name, c.input) };
          } catch (e) {
            return { type: "tool_result", tool_use_id: c.id, content: e instanceof Error ? e.message : "That didn't work", is_error: true };
          }
        }),
      );
      convo.push({ role: "user", content: results });
    }
    throw new Error("too many steps");
  };
}

const isoDate = z.iso.date();
const rangeInput = z.object({ from: isoDate, to: isoDate });
const compareInput = z.enum(["previous", "last_year", "none"]);
const dateProps = {
  from: { type: "string", description: "First local date, YYYY-MM-DD" },
  to: { type: "string", description: "Last local date, YYYY-MM-DD (inclusive)" },
};
const compareProp = {
  type: "string",
  enum: ["previous", "last_year", "none"],
  description: "Compare with the period just before (previous), the same dates last year (last_year), or nothing (none).",
};

export const DATA_TOOLS: DataTool[] = [
  {
    name: "revenue",
    description:
      "Revenue for a date range by department (green fees, carts and extras, pro shop, food and drink, leagues and outings), revenue per round, the average green fee, the prorated budget, a comparison period, and revenue per day for ranges up to 62 days.",
    input_schema: { type: "object", properties: { ...dateProps, compare: compareProp }, required: ["from", "to", "compare"], additionalProperties: false },
  },
  {
    name: "rounds",
    description:
      "Rounds and tee sheet use for a date range: rounds, occupancy, no-shows, 9 and 18 holes, riding and walking, weekdays (Mon-Thu) against weekends (Fri-Sun), booking sources, the rate mix (rounds and revenue by green fee) and occupancy by weekday and hour, with a comparison period.",
    input_schema: { type: "object", properties: { ...dateProps, compare: compareProp }, required: ["from", "to", "compare"], additionalProperties: false },
  },
  {
    name: "labor",
    description:
      "Labor for a date range: hours from the time clock, overtime, labor cost, cost as a share of revenue, revenue and rounds per labor hour, cost by job and by person, and labor per day.",
    input_schema: { type: "object", properties: dateProps, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "inventory",
    description: "Pro shop for a date range: sales and margin, sales by category, best sellers, stock on hand, products at or below their reorder level, slow movers and shrink.",
    input_schema: { type: "object", properties: dateProps, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "payments_and_balances",
    description:
      "Money taken in a date range by how it was paid, money in that isn't revenue (gift cards sold, house account payments), and balances right now: gift cards, open rain checks, punch cards, loyalty points, and what members owe on house accounts (with the largest balances).",
    input_schema: { type: "object", properties: dateProps, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "tee_sheet_day",
    description: "One day on the tee sheet: groups, players, check-ins, no-shows, open spots, money booked, collected and still owed, and each group with its tee time and what it owes.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "Local date, YYYY-MM-DD" } }, required: ["date"], additionalProperties: false },
  },
  {
    name: "budget",
    description: "The revenue budget the manager set for each month of a year, by department. A month with set=false has no budget.",
    input_schema: { type: "object", properties: { year: { type: "integer", description: "The year, e.g. 2026" } }, required: ["year"], additionalProperties: false },
  },
];

const TOOL_TAB: Record<string, DataTopic> = { revenue: "revenue", rounds: "rounds", labor: "labor", inventory: "inventory", payments_and_balances: "balances", tee_sheet_day: "rounds" };

function checkRange(from: string, to: string) {
  if (to < from) throw badRequest("invalid_range", "from must be on or before to");
  if (DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days > 365) throw badRequest("invalid_range", "Ask for 366 days or fewer at a time");
}

/** Runs a tool and notes the report it came from. */
async function runTool(db: Db, course: Course, name: string, input: unknown, sources: DataSource[]): Promise<unknown> {
  const note = (tab: DataTopic, from: string, to: string) => {
    if (!sources.some((s) => s.tab === tab && s.from === from && s.to === to)) sources.push({ tab, from, to });
  };
  switch (name) {
    case "revenue":
    case "rounds": {
      const { from, to, compare } = rangeInput.extend({ compare: compareInput }).parse(input);
      checkRange(from, to);
      const o = await managerOverview(db, course, from, to, compare);
      note(TOOL_TAB[name]!, from, to);
      if (name === "revenue") {
        return {
          from,
          to,
          compare: o.compare,
          revenue: o.revenue,
          budget: o.budget,
          yield: o.yield,
          rounds: o.rounds.rounds,
          topRateCents: o.topRateCents,
          avgDiscountPct: o.avgDiscountPct,
          days: o.days.length <= 62 ? o.days : "Left out for ranges over 62 days; ask for a shorter range to see each day.",
          previous: o.previous && { revenue: o.previous.revenue, yield: o.previous.yield, rounds: o.previous.rounds.rounds },
        };
      }
      return {
        from,
        to,
        compare: o.compare,
        rounds: o.rounds,
        yield: o.yield,
        rateMix: o.rateMix,
        heat: o.heat.filter((h) => h.spots > 0),
        previous: o.previous && { rounds: o.previous.rounds, rateMix: o.previous.rateMix },
      };
    }
    case "labor": {
      const { from, to } = rangeInput.parse(input);
      checkRange(from, to);
      const r = await laborReport(db, course, from, to);
      note("labor", from, to);
      return r;
    }
    case "inventory": {
      const { from, to } = rangeInput.parse(input);
      checkRange(from, to);
      const r = await inventoryReport(db, course, from, to);
      note("inventory", from, to);
      return { ...r, items: [...r.items].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 25) };
    }
    case "payments_and_balances": {
      const { from, to } = rangeInput.parse(input);
      checkRange(from, to);
      const r = await balancesReport(db, course, from, to);
      note("balances", from, to);
      return r;
    }
    case "tee_sheet_day": {
      const { date } = z.object({ date: isoDate }).parse(input);
      const [summary, groups] = await Promise.all([daySummary(db, course, date), groupsForDay(db, course, date)]);
      note("rounds", date, date);
      return { ...summary, groupsOnTheSheet: groups };
    }
    case "budget": {
      const { year } = z.object({ year: z.number().int().min(2000).max(2100) }).parse(input);
      return getBudget(db, course, year);
    }
    default:
      throw new Error(`There's no tool called ${name}`);
  }
}

function instructions(course: Course, today: DateTime): string {
  return [
    `You answer a golf course manager's questions about ${course.name}'s numbers, inside the course's management software.`,
    `Today is ${today.toFormat("cccc, LLLL d, yyyy")} (${today.toISODate()}), in the course's time zone (${course.timeZone}). Weeks run Monday to Sunday. "This month" and "this year" run to today.`,
    "Use the tools to look up the numbers; every answer must come from them. Work out the dates the question means, and say which dates you used. When the question is vague, pick the most likely reading and say so in a few words.",
    "Amounts from the tools are in cents: write them as dollars. Occupancy is a fraction (0.62 means 62%); percents ending in Pct are already percents. A round is a player booked on a tee time who wasn't a no-show; blocked tee times don't count as open spots.",
    "Answer in two to five plain sentences, leading with the number asked for, then what stands out (a comparison, the biggest part, anything unusual). No headings, tables or bullet lists unless the manager asks for a list.",
    "If the tools can't answer it (for example expenses, weather or anything the course doesn't record), say so plainly and say what the reports do cover. Don't guess or estimate numbers the tools didn't give.",
    "You can only read. If the manager asks you to change something, say where in the app they can do it.",
  ].join("\n");
}

/** The last few turns, starting with a question, since the conversation has to open with one. */
function trimHistory(history: DataTurn[]) {
  const recent = history.slice(-8);
  while (recent[0] && recent[0].role !== "user") recent.shift();
  return recent;
}

/** Today at the course, as a local date. */
const todayAt = (course: Course) => DateTime.now().setZone(course.timeZone);

/** The answer without Claude: the closest report for the dates the question names, summed up. */
async function summaryAnswer(db: Db, course: Course, question: string, today: string): Promise<DataAnswer> {
  const q = parseDataQuestion(question, today);
  let report: DataReport;
  if (q.topic === "revenue" || q.topic === "rounds") report = { topic: q.topic, data: await managerOverview(db, course, q.from, q.to, "previous") };
  else if (q.topic === "labor") report = { topic: "labor", data: await laborReport(db, course, q.from, q.to) };
  else if (q.topic === "inventory") report = { topic: "inventory", data: await inventoryReport(db, course, q.from, q.to) };
  else report = { topic: "balances", data: await balancesReport(db, course, q.from, q.to) };
  return { answer: quickAnswer(q, report), sources: [{ tab: q.topic, from: q.from, to: q.to }], via: "summary" };
}

export async function askData(db: Db, ai: DataAi | undefined, course: Course, input: { question: string; history: DataTurn[] }): Promise<DataAnswer> {
  const question = input.question.trim();
  if (!question) throw badRequest("empty_question", "Type a question");
  const today = todayAt(course);
  if (!ai) return summaryAnswer(db, course, question, today.toISODate()!);
  const sources: DataSource[] = [];
  try {
    const answer = await ai({
      system: instructions(course, today),
      messages: [...trimHistory(input.history), { role: "user", content: question }],
      tools: DATA_TOOLS,
      runTool: async (name, args) => JSON.stringify(await runTool(db, course, name, args, sources)),
    });
    return { answer, sources: sources.slice(0, 4), via: "ai" };
  } catch {
    // Claude unreachable or declined: answer from the closest report rather than an error.
    return summaryAnswer(db, course, question, today.toISODate()!);
  }
}
