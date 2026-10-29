import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Db, DbClient } from "./db.ts";
import { getCourseBySlug, type Course } from "./courses.ts";
import { AppError, badRequest } from "./errors.ts";
import { importTeeSheet, type ImportResult, type ImportSource } from "./imports.ts";

// Automatic tee sheet sync. A manager connects the course's booking provider once; then the
// server pulls the provider's tee sheet every few minutes (and whenever someone presses Sync now)
// and runs it through the same import as an uploaded file, so the rules are identical: bookings
// already checked in are never changed, and nothing is duplicated.

export type SyncMethod = "report_url" | "provider_api";

export interface SyncConnection {
  source: ImportSource;
  method: SyncMethod;
  reportUrl: string | null;
  hasCredentials: boolean;
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "waiting" | null;
  lastMessage: string | null;
}

/** Fetches a report. Swapped out in tests. */
export type FetchReport = (url: string) => Promise<string>;

const MAX_BYTES = 6 * 1024 * 1024;

const toConnection = (r: any): SyncConnection => ({
  source: r.source,
  method: r.method,
  reportUrl: r.report_url,
  hasCredentials: r.credentials_enc !== null,
  enabled: r.enabled,
  intervalMinutes: r.interval_minutes,
  lastRunAt: r.last_run_at?.toISOString() ?? null,
  lastStatus: r.last_status,
  lastMessage: r.last_message,
});

// Provider passwords and API keys are encrypted with a key only the server has.
function secretKey() {
  const secret = process.env.SYNC_SECRET;
  if (!secret) throw new AppError(503, "sync_not_configured", "The server needs SYNC_SECRET set before it can store provider sign-in details");
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: object) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptCredentials(enc: string): Record<string, string> {
  const [iv, tag, data] = enc.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

// The server fetches whatever link a manager pastes, so it refuses links into private networks.
function privateAddress(ip: string) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function checkReportUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("invalid_url", "That isn't a web address. Copy the whole link, starting with https://");
  }
  if (url.protocol !== "https:") throw badRequest("invalid_url", "The report link must start with https://");
  if (url.username || url.password) throw badRequest("invalid_url", "Put sign-in details in the provider settings, not in the link");
  return url;
}

/** Downloads a report link, refusing private addresses, redirects, slow servers and huge files. */
export const fetchReport: FetchReport = async (raw) => {
  const url = checkReportUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(privateAddress)) throw badRequest("invalid_url", "That link points to a private network address");
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { accept: "text/csv, text/plain, */*" } });
  if (!res.ok) throw new Error(`The report link answered ${res.status} ${res.statusText}`.trim());
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("The report is larger than 6 MB");
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("The report is larger than 6 MB");
  return text;
};

export async function getSync(db: DbClient, course: Course): Promise<SyncConnection | null> {
  const { rows } = await db.query("SELECT * FROM sync_connections WHERE course_id = $1", [course.id]);
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function saveSync(
  db: DbClient,
  course: Course,
  input: {
    source: ImportSource;
    method: SyncMethod;
    reportUrl?: string | null;
    credentials?: Record<string, string> | null;
    enabled: boolean;
    intervalMinutes: number;
  },
): Promise<SyncConnection> {
  if (input.method === "report_url") {
    if (!input.reportUrl) throw badRequest("url_required", "Paste the report link from your booking system");
    checkReportUrl(input.reportUrl);
  }
  // Leaving credentials out keeps the saved ones; null removes them.
  const creds = input.credentials === undefined ? undefined : input.credentials === null ? null : encrypt(input.credentials);
  const { rows } = await db.query(
    `INSERT INTO sync_connections (course_id, source, method, report_url, credentials_enc, enabled, interval_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (course_id) DO UPDATE SET
       source = EXCLUDED.source, method = EXCLUDED.method, report_url = EXCLUDED.report_url,
       credentials_enc = CASE WHEN $8 THEN EXCLUDED.credentials_enc ELSE sync_connections.credentials_enc END,
       enabled = EXCLUDED.enabled, interval_minutes = EXCLUDED.interval_minutes, updated_at = now(),
       last_status = NULL, last_message = NULL
     RETURNING *`,
    [course.id, input.source, input.method, input.reportUrl?.trim() || null, creds ?? null, input.enabled, input.intervalMinutes, creds !== undefined],
  );
  return toConnection(rows[0]);
}

export async function deleteSync(db: DbClient, course: Course) {
  await db.query("DELETE FROM sync_connections WHERE course_id = $1", [course.id]);
}

const PROVIDER = { teeitup: "TeeItUp", golfnow: "GolfNow", import: "your booking system" } as const;

/**
 * Pulls the provider's tee sheet now and imports it. The outcome is saved on the connection
 * so the app can show when the last sync ran and whether it worked.
 */
export async function runSync(db: Db, course: Course, fetcher: FetchReport = fetchReport): Promise<{ connection: SyncConnection; result?: ImportResult }> {
  const { rows } = await db.query("SELECT * FROM sync_connections WHERE course_id = $1", [course.id]);
  const conn = rows[0];
  if (!conn) throw badRequest("not_connected", "Set up tee sheet sync first");

  let status: "ok" | "error" | "waiting";
  let message: string;
  let result: ImportResult | undefined;
  if (conn.method === "provider_api") {
    // The provider API needs partner access the provider hasn't granted yet, so there's
    // nothing to call. Say so plainly rather than pretending it synced.
    status = "waiting";
    message = `${PROVIDER[conn.source as ImportSource]} hasn't given this course API access yet. Ask your rep for it, and use a report link or a file upload until then.`;
  } else {
    try {
      const csv = await fetcher(conn.report_url);
      result = await importTeeSheet(db, course, { source: conn.source, csv, fileName: "Automatic sync", via: "sync" });
      const c = result.counts;
      if (result.dates.length === 0) {
        status = "error";
        message = result.problems[0]?.message ?? "The report had no bookings in it. Check that the link is the tee sheet export";
      } else {
        status = "ok";
        message = `${c.created} new, ${c.updated} changed, ${c.cancelled} cancelled${c.problems ? `, ${c.problems} rows skipped` : ""}`;
      }
    } catch (err) {
      status = "error";
      message = err instanceof Error ? err.message : "The sync failed";
    }
  }
  const { rows: updated } = await db.query(
    "UPDATE sync_connections SET last_run_at = now(), last_status = $2, last_message = $3 WHERE course_id = $1 RETURNING *",
    [course.id, status, message.slice(0, 500)],
  );
  return { connection: toConnection(updated[0]), result };
}

/**
 * Runs every connection that is due. Each one is claimed first, so two servers never sync the
 * same course at once.
 */
export async function runDueSyncs(db: Db, fetcher: FetchReport = fetchReport) {
  const { rows } = await db.query(
    `UPDATE sync_connections s SET last_run_at = now()
       FROM courses c
      WHERE c.id = s.course_id AND s.enabled AND s.method = 'report_url'
        AND (s.last_run_at IS NULL OR s.last_run_at < now() - make_interval(mins => s.interval_minutes))
      RETURNING c.slug`,
  );
  for (const r of rows) {
    const course = await getCourseBySlug(db, r.slug);
    await runSync(db, course, fetcher).catch(() => undefined);
  }
  return rows.length;
}

/** Checks for due syncs once a minute while the server runs. */
export function startSyncLoop(db: Db, log: (err: unknown) => void) {
  const timer = setInterval(() => runDueSyncs(db).catch(log), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
