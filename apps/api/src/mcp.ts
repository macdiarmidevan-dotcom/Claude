import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { Course } from "./courses.ts";
import { daySummary, findGolfer, groupsForDay, revenue, todayAt } from "./insights.ts";

// The AI assistant's connector. A manager adds this course's MCP address and their key to
// Claude or ChatGPT and asks things like "how many rounds today?" or "who still owes?".
// Every tool here only reads; changes still go through the staff app.

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Local date at the course, YYYY-MM-DD. Leave out for today.");

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function buildMcpServer(db: Db, course: Course): McpServer {
  const server = new McpServer(
    { name: `${course.name} tee sheet`, version: "0.1.0" },
    {
      instructions:
        `Answers questions about ${course.name}'s tee sheet and money. ` +
        `Times are local to the course (${course.timeZone}). Amounts are in cents. ` +
        `"Checked in at shop" means paid and checked in at the pro shop; "on course" means the starter sent them off.`,
    },
  );

  server.registerTool(
    "day_summary",
    {
      title: "Day summary",
      description:
        "Groups and players for a day, how many are booked, checked in at the shop, on the course or no-shows, open spots, occupancy, money booked, collected and still owed, and carts out.",
      inputSchema: { date },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await daySummary(db, course, args.date ?? todayAt(course))),
  );

  server.registerTool(
    "list_groups",
    {
      title: "Groups on the tee sheet",
      description: "The groups booked on a day in tee time order, with what each owes. Filter to find who still owes, who hasn't checked in, who is on the course, or no-shows.",
      inputSchema: {
        date,
        filter: z.enum(["all", "unpaid", "not_checked_in", "checked_in", "on_course", "no_show"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await groupsForDay(db, course, args.date ?? todayAt(course), args.filter)),
  );

  server.registerTool(
    "find_golfer",
    {
      title: "Find a golfer",
      description: "A golfer's bookings from 30 days ago to 30 days ahead, searched by part of their name.",
      inputSchema: { name: z.string().trim().min(2).max(100) },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await findGolfer(db, course, args.name)),
  );

  server.registerTool(
    "revenue",
    {
      title: "Revenue",
      description:
        "Money per day between two dates (up to 92 days): green fees and add-ons booked for rounds on that day, and payments collected that day by method.",
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First local date, YYYY-MM-DD"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Last local date, YYYY-MM-DD (inclusive)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await revenue(db, course, args.from, args.to)),
  );

  return server;
}
