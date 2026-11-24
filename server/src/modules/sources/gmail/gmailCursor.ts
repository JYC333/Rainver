/**
 * Gmail page cursors: `base64url(JSON payload).base64url(HMAC-SHA256)` under a
 * key derived from the instance master key (HKDF "gmail-cursor-v1"). A cursor
 * binds the owner, Space, connection and its generation, the Project, and either
 * the exact effective search (query + window digest) or the selection, its
 * thread and read window, plus the Google page token / the last released
 * message's (internal date, id) boundary, and an expiry. It is
 * never a URL and authorizes nothing by itself: every use reruns the full read
 * admission, and a mismatch in any bound field refuses it.
 *
 * Expiry is issued and judged on the database clock (`clock_timestamp()`, read
 * after the admission locks), never on the application clock.
 */
import { GMAIL_AGENT_PAGE_SIZE } from "@rainver/protocol";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../../../config.js";
import type { Queryable } from "../../routeUtils/common.js";
import { loadOrCreateModelProviderApiKeyMasterKey } from "../../providers/secretRefCrypto.js";

export const GMAIL_CURSOR_TTL_SQL = "interval '15 minutes'";

interface CursorBase { v: 1; o: string; s: string; c: string; g: number; p: string; e: string }
/** `th` the selection's thread; `ba`/`bi` the last released message's internal date (ISO) and id (newest-first order). */
export interface GmailReadCursor extends CursorBase { k: "read"; sel: string; w: string; th: string; ba: string; bi: string }
export interface GmailDigestCursor extends CursorBase { k: "digest"; delivery: string; page: string; index: number }
export interface GmailAgentCursor extends CursorBase {
  k: "agent"; query: string | null; max: number; remaining: string[]; next: string | null;
}
export type GmailCursor = GmailReadCursor | GmailDigestCursor | GmailAgentCursor;

export class GmailCursorError extends Error {
  constructor() { super("gmail_cursor_invalid"); this.name = "GmailCursorError"; }
}

async function cursorKey(config: ServerConfig): Promise<Buffer> {
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "gmail-cursor-v1", 32));
}

/** The selection's window as one comparable string; a changed window invalidates outstanding cursors. */
export function gmailWindowKey(readAfter: string | null, readBefore: string | null): string {
  return `${readAfter ? new Date(readAfter).toISOString() : ""}|${readBefore ? new Date(readBefore).toISOString() : ""}`;
}

/** The database's expiry instant for a cursor issued now. */
export async function gmailCursorExpiry(db: Queryable): Promise<string> {
  return (await db.query<{ e: string }>(`SELECT to_char((clock_timestamp() + ${GMAIL_CURSOR_TTL_SQL}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS e`)).rows[0]!.e;
}

/** True while the cursor's expiry is after the database's actual time (call after the admission locks). */
export async function gmailCursorLive(db: Queryable, cursor: GmailCursor): Promise<boolean> {
  return (await db.query<{ live: boolean }>(`SELECT $1::timestamptz > clock_timestamp() AS live`, [cursor.e])).rows[0]!.live;
}

export async function signGmailCursor(config: ServerConfig, cursor: GmailCursor): Promise<string> {
  const body = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const mac = createHmac("sha256", await cursorKey(config)).update(body, "utf8").digest("base64url");
  return `${body}.${mac}`;
}

/** Verifies the MAC and shape; it does not judge binding or expiry (the admission does, under its locks). */
export async function openGmailCursor<K extends GmailCursor["k"]>(
  config: ServerConfig, raw: string, kind: K,
): Promise<Extract<GmailCursor, { k: K }>> {
  const [body, mac, extra] = raw.split(".");
  if (!body || !mac || extra !== undefined) throw new GmailCursorError();
  const expected = createHmac("sha256", await cursorKey(config)).update(body, "utf8").digest();
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new GmailCursorError();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new GmailCursorError(); }
  const c = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const str = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1024;
  if (c.v !== 1 || c.k !== kind || !str(c.o) || !str(c.s) || !str(c.c) || !str(c.p) || !str(c.e) || !Number.isInteger(c.g)) throw new GmailCursorError();
  if (kind === "read" && (!str(c.sel) || typeof c.w !== "string" || !str(c.th) || typeof c.ba !== "string" || Number.isNaN(Date.parse(c.ba))
    || new Date(c.ba).toISOString() !== c.ba || typeof c.bi !== "string" || !/^[0-9a-f]{1,64}$/.test(c.bi))) throw new GmailCursorError();
  if (kind === "digest" && (!str(c.delivery) || !Number.isSafeInteger(c.index) || Number(c.index) < 1 || typeof c.page !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(c.page))) throw new GmailCursorError();
  if (kind === "agent" && ((c.query !== null && !str(c.query)) ||
    typeof c.max !== "number" || !Number.isInteger(c.max) || c.max < 1 || c.max > GMAIL_AGENT_PAGE_SIZE.maximum ||
    !Array.isArray(c.remaining) || !c.remaining.length || c.remaining.length > c.max ||
    !c.remaining.every((id) => typeof id === "string" && /^[0-9a-f]{1,64}$/.test(id)) ||
    (c.next !== null && (typeof c.next !== "string" || !/^[^\x00-\x20\x7f]+$/.test(c.next))))) throw new GmailCursorError();
  return c as unknown as Extract<GmailCursor, { k: K }>;
}
