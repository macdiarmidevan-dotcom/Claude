import Anthropic from "@anthropic-ai/sdk";
import { HELP_ARTICLES, answerFromArticles, helpArticlesText, type HelpArticle } from "@golf/core";
import type { Course } from "./courses.ts";
import type { Db } from "./db.ts";
import { badRequest } from "./errors.ts";
import type { MessageSender } from "./messages.ts";

// The help center's assistant and support requests.
//
// The assistant answers staff questions about the software from the help articles only. With
// ANTHROPIC_API_KEY set on the server it asks Claude; without it (or if Claude can't be reached)
// it answers with the closest articles, so the help center always gives something useful.
//
// Support requests are saved for the course and emailed to SUPPORT_EMAIL.

export interface HelpTurn {
  role: "user" | "assistant";
  content: string;
}

export interface HelpAnswer {
  answer: string;
  /** Articles the answer is based on, best first. */
  articles: { id: string; title: string }[];
  /** "ai" when Claude wrote the answer; "search" when it's the closest articles. */
  via: "ai" | "search";
}

/** Writes an answer from the instructions and conversation. Swappable so tests don't call Claude. */
export type HelpAi = (input: { system: string; messages: HelpTurn[] }) => Promise<{ answer: string; articleIds: string[] }>;

export const HELP_MODEL = "claude-opus-5-5";

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The reply to the staff member, in plain sentences." },
    article_ids: { type: "array", items: { type: "string" }, description: "ids of the articles the answer used, most relevant first." },
  },
  required: ["answer", "article_ids"],
  additionalProperties: false,
};

/** The Claude-backed assistant, or undefined when the server has no API key. */
export function claudeHelpAi(apiKey = process.env.ANTHROPIC_API_KEY): HelpAi | undefined {
  if (!apiKey) return undefined;
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return async ({ system, messages }) => {
    const res = await client.beta.messages.create({
      model: HELP_MODEL,
      max_tokens: 4000,
      // If a safety check declines, the API retries on a fallback model it picks.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Short how-to answers don't need deep thinking.
      output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
      // The articles don't change between questions, so they're cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    });
    if (res.stop_reason === "refusal") throw new Error("declined");
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no answer");
    const parsed = JSON.parse(text.text) as { answer: string; article_ids: string[] };
    return { answer: parsed.answer, articleIds: parsed.article_ids };
  };
}

function instructions(course: Course, isManager: boolean, page: string | null): string {
  return [
    `You are the help assistant inside the staff app of a golf course management system, used at ${course.name}.`,
    "Answer questions about how to use the software, from the help articles below and nothing else. Keep answers short: a sentence or two, or a few numbered steps, using the button and menu names the articles use.",
    "If the articles don't cover the question, say so plainly and suggest Email support in the help center. Don't guess at features, prices, policies or course rules.",
    isManager ? "This person is a manager." : "This person is staff, not a manager. If something is managers-only, say a manager needs to do it.",
    page ? `They are on the ${page} page.` : "",
    "List in article_ids the articles your answer used, most relevant first, or none if none apply.",
    "",
    helpArticlesText(),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const byId = new Map(HELP_ARTICLES.map((a) => [a.id, a]));
const ref = (a: HelpArticle) => ({ id: a.id, title: a.title });

function searchAnswer(question: string): HelpAnswer {
  return { ...answerFromArticles(question), via: "search" };
}

export async function askHelp(
  ai: HelpAi | undefined,
  course: Course,
  input: { question: string; history: HelpTurn[]; page: string | null; isManager: boolean },
): Promise<HelpAnswer> {
  const question = input.question.trim();
  if (!question) throw badRequest("empty_question", "Type a question");
  if (!ai) return searchAnswer(question);
  try {
    const { answer, articleIds } = await ai({
      system: instructions(course, input.isManager, input.page),
      messages: [...input.history.slice(-8), { role: "user", content: question }],
    });
    const articles = articleIds.map((id) => byId.get(id)).filter((a): a is HelpArticle => !!a).slice(0, 3).map(ref);
    return { answer: answer.trim(), articles, via: "ai" };
  } catch {
    // Claude unreachable or declined: fall back to the closest articles rather than an error.
    return searchAnswer(question);
  }
}

// Support requests

export type SupportTopic = "question" | "problem" | "billing" | "idea";
const TOPIC_LABEL: Record<SupportTopic, string> = { question: "Question", problem: "Something isn't working", billing: "Billing", idea: "Feature idea" };

export interface SupportRequest {
  id: string;
  reference: string;
  topic: SupportTopic;
  subject: string;
  body: string;
  replyTo: string;
  page: string | null;
  status: "sent" | "failed";
  staff: string | null;
  at: string;
}

const toRequest = (r: any): SupportRequest => ({
  id: r.id,
  reference: `SR-${String(r.number).padStart(5, "0")}`,
  topic: r.topic,
  subject: r.subject,
  body: r.body,
  replyTo: r.reply_to,
  page: r.page,
  status: r.status,
  staff: r.staff ?? null,
  at: r.created_at.toISOString(),
});

export async function createSupportRequest(
  db: Db,
  sender: MessageSender,
  course: Course,
  staff: { id: string; name: string } | null,
  input: { topic: SupportTopic; subject: string; body: string; replyTo: string; page: string | null },
  supportEmail = process.env.SUPPORT_EMAIL ?? "support@example.com",
): Promise<SupportRequest> {
  const { rows } = await db.query(
    `INSERT INTO support_requests (course_id, staff_user_id, topic, subject, body, reply_to, page)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [course.id, staff?.id ?? null, input.topic, input.subject, input.body, input.replyTo, input.page],
  );
  const row = rows[0];
  const reference = `SR-${String(row.number).padStart(5, "0")}`;
  const sent = await sender.send({
    channel: "email",
    to: supportEmail,
    subject: `[${reference}] ${TOPIC_LABEL[input.topic]}: ${input.subject}`,
    body: [
      input.body,
      "",
      `From: ${staff?.name ?? "A shared device"} <${input.replyTo}>`,
      `Course: ${course.name}`,
      input.page ? `Page: ${input.page}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    fromName: staff?.name ?? course.name,
    replyTo: input.replyTo,
  });
  const status = sent.ok ? "sent" : "failed";
  const { rows: updated } = await db.query(`UPDATE support_requests SET status = $2 WHERE id = $1 RETURNING *`, [row.id, status]);
  return toRequest({ ...updated[0], staff: staff?.name ?? null });
}

/** A person's own requests, or every request at the course for a manager. */
export async function listSupportRequests(db: Db, course: Course, staffId: string | null, all: boolean): Promise<SupportRequest[]> {
  const { rows } = await db.query(
    `SELECT s.*, u.name AS staff FROM support_requests s LEFT JOIN staff_users u ON u.id = s.staff_user_id
      WHERE s.course_id = $1 AND ($2::boolean OR s.staff_user_id IS NOT DISTINCT FROM $3)
      ORDER BY s.created_at DESC LIMIT 100`,
    [course.id, all, staffId],
  );
  return rows.map(toRequest);
}
