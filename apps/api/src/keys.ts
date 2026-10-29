import { createHash, randomBytes } from "node:crypto";
import type { DbClient } from "./db.ts";

export type KeyKind = "public" | "secret";

export interface ApiKeyContext {
  keyId: string;
  courseId: string;
  kind: KeyKind;
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * Creates an API key for a course and returns the plain key. Only the hash is stored,
 * so the key can't be shown again.
 * Public keys (pk_) are safe to put in a course's website for availability and booking.
 * Secret keys (sk_) are for staff apps and servers.
 */
export async function createApiKey(db: DbClient, courseId: string, kind: KeyKind, label?: string): Promise<string> {
  const key = `${kind === "public" ? "pk" : "sk"}_${randomBytes(24).toString("base64url")}`;
  await db.query(
    "INSERT INTO api_keys (course_id, kind, key_prefix, key_hash, label) VALUES ($1, $2, $3, $4, $5)",
    [courseId, kind, key.slice(0, 7), hash(key), label ?? null],
  );
  return key;
}

export async function lookupApiKey(db: DbClient, key: string): Promise<ApiKeyContext | undefined> {
  const { rows } = await db.query<{ id: string; course_id: string; kind: KeyKind }>(
    "SELECT id, course_id, kind FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [hash(key)],
  );
  const row = rows[0];
  return row && { keyId: row.id, courseId: row.course_id, kind: row.kind };
}
