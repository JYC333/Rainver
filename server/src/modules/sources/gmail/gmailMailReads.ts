/**
 * Synchronous, owner-private Gmail read: one page of a legacy selected
 * thread's messages (the manual search was retired with Gmail V2; new mail is
 * found by server-side monitors, `gmailMailboxSync.ts`). No Job, operation
 * result, cache table, file, SourceItem or shared context holds mail.
 *
 * Sequence: (1) a short admission transaction locks the read authority
 * (`gmailReadAuthority.ts`) and verifies any cursor against it on the database
 * clock; (2) outside every transaction, a Sources broker built from
 * `gmailSourceRequestPolicy` (exact URL per hop, no redirects, per-physical-send
 * budget of 21, 2 MiB / 15 s per response, stable-subject quota) performs the
 * GETs, rerunning the authority check before each send and resolving the access
 * token per hop; (3) the server normalizes in memory; (4) a final short
 * transaction reruns the check and inserts the owner-read audit row; (5) only
 * after that commit does the caller serialize the body. A refusal at any step,
 * or an audit failure, returns a fixed error code and no content.
 *
 * Gmail facts this relies on: `threads.get` returns every message of a thread with
 * no message paging, so the reader pages over the metadata itself (newest first)
 * and fetches each message on the page with `messages.get format=full`.
 */
import { randomUUID } from "node:crypto";
import type { GmailMessage, GmailThreadReadOutput } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import type { TransactionRunner } from "../../../db/tx.js";
import type { Queryable } from "../../routeUtils/common.js";
import { createSourceRequestBroker, SourceRequestError, type SourceRequestBroker } from "../sourceRequestBroker.js";
import type { OutboundGuard } from "../outboundUrlSafety.js";
import {
  createGmailSendBudget, GMAIL_READ_LIMITS, gmailMessageFullUrl, gmailSourceRequestPolicy,
  gmailThreadMetadataUrl, type GmailSendBudget,
} from "./gmailReadContract.js";
import { GMAIL_ACCOUNT_QUOTA, GMAIL_OWNER_QUOTA, gmailQuotaGroups } from "./gmailQuota.js";
import { GmailTokenError, resolveGmailAccessToken } from "./gmailTokenRefresh.js";
import { admitGmailRead, authorizeGmailSend, GmailReadError, recheckGmailRead, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { gmailPageRunner, gmailPageScope, withGmailReadTransaction, type GmailPageScope } from "./gmailReadDeadline.js";
import {
  gmailCursorExpiry, gmailCursorLive, GmailCursorError, openGmailCursor, signGmailCursor,
  type GmailReadCursor,
} from "./gmailCursor.js";
import {
  gmailId, gmailWebUrl, headerValue, internalDateIso, normalizeMessageBody, type GmailApiMessage,
} from "./gmailMessageText.js";

/** Newest messages considered per thread; an older remainder is reported as `thread_message_limit`. */
export const GMAIL_THREAD_MESSAGE_LIMIT = 500;

let guardOverride: OutboundGuard | undefined;
/** Tests inject a DNS-stubbed guard; production uses the strict instance guard. */
export function __setGmailReadGuardForTests(guard: OutboundGuard | null): void { guardOverride = guard ?? undefined; }

type Truncation = GmailThreadReadOutput["truncation"][number];

/** What a reader other than the owner's thread page changes in the transport (the Agent read, ADR 0032). */
export interface GmailTransportOptions {
  scopeId?: string;
  upstreamCooldownOnly?: boolean;
  policy?: typeof gmailSourceRequestPolicy;
  budget?: GmailSendBudget;
  /** A further check before every physical send, after the authority recheck; its refusal is kept as the failure. */
  authorizeSend?: (db: Queryable) => Promise<void>;
}

/** The page's broker, budget and byte accounting; every failure is mapped to a fixed code. */
export function pageTransport(config: ServerConfig, scope: GmailPageScope, snapshot: GmailReadSnapshot, options: GmailTransportOptions = {}) {
  const signal = scope.signal;
  const pageRun = gmailPageRunner(scope);
  let refusal: GmailReadError | null = null;
  // Quota admission/cooldown and token refresh run here; the broker wraps their errors, so keep the refusal class.
  const run: TransactionRunner = async (work) => {
    try { return await pageRun(work); } catch (error) {
      if (error instanceof GmailReadError) refusal ??= error;
      throw error;
    }
  };
  let tokenError: GmailTokenError | null = null;
  const keys = gmailQuotaGroups({ googleSubject: snapshot.googleSubject, ownerUserId: snapshot.ownerUserId });
  const tokenSnapshot = { connectionId: snapshot.connectionId, ownerUserId: snapshot.ownerUserId, spaceId: snapshot.spaceId, generation: snapshot.generation };
  const broker: SourceRequestBroker = createSourceRequestBroker(run, {
    scopeId: options.scopeId ?? `gmail-read:${snapshot.connectionId}`,
    quotaGroup: keys.account,
    upstreamCooldownOnly: options.upstreamCooldownOnly,
    quota: GMAIL_ACCOUNT_QUOTA,
    endpointQuotas: [{ key: keys.owner, windows: GMAIL_OWNER_QUOTA }],
    authorize: async (sendSignal) => {
      try {
        await authorizeGmailSend(scope, snapshot, sendSignal ?? signal);
        if (options.authorizeSend) await withGmailReadTransaction(scope, options.authorizeSend, sendSignal ?? signal);
      } catch (error) {
        refusal = error instanceof GmailReadError ? error : new GmailReadError(503, "gmail_upstream_error", undefined, { cause: "authority_check_failed" });
        throw error;
      }
    },
    ...(options.policy ?? gmailSourceRequestPolicy)({
      credentialHeaders: async () => {
        try { return { authorization: `Bearer ${await resolveGmailAccessToken(config, run, tokenSnapshot, signal)}` }; } catch (error) {
          if (error instanceof GmailTokenError) tokenError = error;
          else if (error instanceof GmailReadError) refusal = error;
          throw error;
        }
      },
      budget: options.budget ?? createGmailSendBudget(),
    }),
  }, signal, guardOverride);
  let sequence = 0;
  let rawBytes = 0;
  const failure = (error: unknown): GmailReadError => {
    if (refusal) return refusal;
    if (tokenError) {
      const code = (tokenError as GmailTokenError).code;
      if (code === "gmail_authority_revoked") return new GmailReadError(404, "gmail_not_found");
      if (code === "gmail_connection_changed") return new GmailReadError(409, "gmail_connection_changed");
      if (code === "gmail_reauth_required") return new GmailReadError(409, "gmail_reauth_required");
      if (code === "gmail_not_configured") return new GmailReadError(503, "gmail_not_configured");
      return new GmailReadError(503, "gmail_refresh_unavailable");
    }
    if (error instanceof SourceRequestError) {
      if (error.code === "source_upstream_cooldown") return new GmailReadError(429, "gmail_rate_limited", error.retryAt);
      if (error.code === "source_quota_exhausted") return new GmailReadError(429, "gmail_quota_exhausted", error.retryAt);
      if (error.code === "source_timeout") return new GmailReadError(504, "gmail_upstream_timeout");
      if (error.code === "source_cancelled") return new GmailReadError(499, "gmail_cancelled");
      if (error.code === "source_network_failed") return new GmailReadError(502, "gmail_upstream_error", undefined, { cause: "network_failed" });
      if (error.code === "source_network_refused" || error.code === "source_scope_refused") {
        return new GmailReadError(502, "gmail_upstream_error", undefined, { cause: "request_refused" });
      }
    }
    return new GmailReadError(502, "gmail_upstream_error", undefined, { cause: "broker_failed" });
  };
  return {
    /** Bytes still allowed before the next send could pass the page's raw ceiling. */
    roomForAnotherSend: () => rawBytes + GMAIL_READ_LIMITS.responseBytes <= GMAIL_READ_LIMITS.pageRawBytes,
    /** One GET. `too_large` is a per-item outcome; Google 404 is `unavailable`; other failures throw a fixed code. */
    async get(url: string): Promise<{ kind: "ok"; json: unknown } | { kind: "too_large" } | { kind: "not_found" }> {
      sequence += 1;
      let response;
      try {
        response = await broker({ sequence, method: "GET", url });
      } catch (error) {
        if (error instanceof SourceRequestError && error.code === "source_response_too_large" && !refusal && !tokenError) {
          rawBytes += GMAIL_READ_LIMITS.responseBytes;
          return { kind: "too_large" };
        }
        throw failure(error);
      }
      const body = Buffer.from(response.body_base64, "base64");
      rawBytes += body.length;
      if (response.status === 404) return { kind: "not_found" };
      if (response.status !== 200) {
        const reason = googleErrorReason(body);
        const diagnostic = { cause: "upstream_http" as const, upstream_status: response.status, ...(reason ? { upstream_reason: reason } : {}) };
        if (response.status === 429 || response.status === 503) throw new GmailReadError(429, "gmail_rate_limited", response.retry_at, diagnostic);
        throw new GmailReadError(502, "gmail_upstream_error", undefined, diagnostic);
      }
      try { return { kind: "ok", json: JSON.parse(body.toString("utf8")) }; }
      catch { throw new GmailReadError(502, "gmail_upstream_error", undefined, { cause: "invalid_json", upstream_status: 200 }); }
    },
  };
}

export const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const GOOGLE_READ_ERROR_REASONS = new Set([
  "authError", "backendError", "dailyLimitExceeded", "forbidden", "insufficientPermissions",
  "invalidArgument", "invalidParameter", "rateLimitExceeded", "userRateLimitExceeded",
]);

function googleErrorReason(body: Buffer): string | undefined {
  try {
    const errors = record(record(JSON.parse(body.toString("utf8"))).error).errors;
    const reason = Array.isArray(errors) ? record(errors[0]).reason : undefined;
    if (typeof reason === "string" && GOOGLE_READ_ERROR_REASONS.has(reason)) return reason;
  } catch { /* An HTTP error may have no JSON body. */ }
}
const messagesOf = (thread: unknown): GmailApiMessage[] => Array.isArray(record(thread).messages) ? (record(thread).messages as unknown[]).map(record) as GmailApiMessage[] : [];
const isDraft = (message: GmailApiMessage) => Array.isArray(message.labelIds) && message.labelIds.includes("DRAFT");

/** Writes the owner-read audit row; any failure here withholds the content. */
async function insertReadAudit(db: Queryable, snapshot: GmailReadSnapshot, input: { operation: "thread_read"; itemCount: number; truncated: boolean; requestId: string }) {
  await db.query(
    `INSERT INTO gmail_read_audit_events (id,space_id,owner_user_id,actor_user_id,gmail_connection_id,project_id,selection_id,operation,
       google_thread_id,item_count,truncated,request_id,accessed_at)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())`,
    [randomUUID(), snapshot.spaceId, snapshot.ownerUserId, snapshot.connectionId, snapshot.projectId, snapshot.selectionId ?? null,
      input.operation, snapshot.selection?.googleThreadId ?? null, input.itemCount, input.truncated, input.requestId.slice(0, 128)],
  );
}

/** Final release: authority recheck, the audit row and the cursor expiry, in one short transaction. */
async function release<T>(scope: GmailPageScope, snapshot: GmailReadSnapshot, work: (db: Queryable) => Promise<T>): Promise<T> {
  try {
    return await withGmailReadTransaction(scope, async (tx) => {
      await recheckGmailRead(tx, snapshot);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof GmailReadError) throw error;
    throw new GmailReadError(503, "gmail_audit_unavailable");
  }
}

export async function admit(scope: GmailPageScope, target: Parameters<typeof admitGmailRead>[1], verify: (db: Queryable, snapshot: GmailReadSnapshot) => Promise<void>): Promise<GmailReadSnapshot> {
  return withGmailReadTransaction(scope, async (tx) => {
    const snapshot = await admitGmailRead(tx, target);
    await verify(tx, snapshot);
    return snapshot;
  });
}

function cursorMatches(cursor: GmailReadCursor, snapshot: GmailReadSnapshot): boolean {
  return cursor.o === snapshot.ownerUserId && cursor.s === snapshot.spaceId && cursor.c === snapshot.connectionId && cursor.p === snapshot.projectId;
}

async function verifyCursorIn(db: Queryable, cursor: GmailReadCursor, snapshot: GmailReadSnapshot, bound: boolean): Promise<void> {
  if (!cursorMatches(cursor, snapshot) || !bound) throw new GmailReadError(409, "gmail_cursor_invalid");
  if (cursor.g !== snapshot.generation) throw new GmailReadError(409, "gmail_connection_changed");
  if (!(await gmailCursorLive(db, cursor))) throw new GmailReadError(409, "gmail_cursor_expired");
}

async function openCursor(config: ServerConfig, raw: string | undefined, kind: "read") {
  if (raw === undefined) return null;
  try { return await openGmailCursor(config, raw, kind) as GmailReadCursor; } catch (error) {
    if (error instanceof GmailCursorError) throw new GmailReadError(409, "gmail_cursor_invalid");
    throw error;
  }
}

export interface GmailThreadReadInput {
  spaceId: string;
  userId: string;
  selectionId: string;
  cursor?: string;
  requestId: string;
  signal: AbortSignal;
}

/** Locates the caller's own selection (routing only; admission re-locks and rechecks it), inside the page's bounds. */
async function routeSelection(scope: GmailPageScope, input: { spaceId: string; userId: string; selectionId: string }) {
  const row = (await withGmailReadTransaction(scope, (tx) => tx.query<{ project_id: string; gmail_connection_id: string }>(
    `SELECT project_id,gmail_connection_id FROM gmail_project_thread_selections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3`,
    [input.selectionId, input.spaceId, input.userId],
  ))).rows[0];
  if (!row) throw new GmailReadError(404, "gmail_not_found");
  return row;
}

/** One page (≤ 20, newest first) of a selected thread's messages inside the selection's window. */
export async function readGmailThread(config: ServerConfig, pool: Pool, input: GmailThreadReadInput): Promise<GmailThreadReadOutput> {
  if (!config.gmailOAuth) throw new GmailReadError(503, "gmail_not_configured");
  const cursor = await openCursor(config, input.cursor, "read");
  const scope = gmailPageScope(config, pool, input.signal);
  const routed = await routeSelection(scope, input);
  const snapshot = await admit(scope, { spaceId: input.spaceId, ownerUserId: input.userId, projectId: routed.project_id, connectionId: routed.gmail_connection_id, selectionId: input.selectionId },
    async (db, current) => {
      if (cursor) await verifyCursorIn(db, cursor, current, cursor.sel === input.selectionId && cursor.w === current.selection!.windowKey && cursor.th === current.selection!.googleThreadId);
    });
  const selection = snapshot.selection!;
  const transport = pageTransport(config, scope, snapshot);

  const thread = await transport.get(gmailThreadMetadataUrl(selection.googleThreadId));
  if (thread.kind === "not_found") throw new GmailReadError(404, "gmail_thread_unavailable");
  if (thread.kind !== "ok") throw new GmailReadError(502, "gmail_upstream_error");
  const truncation = new Set<Truncation>();
  const after = selection.readAfter ? Date.parse(selection.readAfter) : -Infinity;
  const before = selection.readBefore ? Date.parse(selection.readBefore) : Infinity;
  const all = messagesOf(thread.json).filter((m) => !isDraft(m))
    .map((m) => ({ m, id: gmailId(m.id), at: internalDateIso(m.internalDate) }))
    .filter((x): x is { m: GmailApiMessage; id: string; at: string } => x.id !== null && x.at !== null)
    // Code-unit order (not locale) so the cursor boundary below compares exactly like the sort.
    .sort((a, b) => a.at === b.at ? (a.id === b.id ? 0 : a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1);
  const inWindow = all.filter((x) => { const t = Date.parse(x.at); return t >= after && t < before; });
  // The thread subject is the oldest message *inside* the window; nothing outside it is released.
  const subject = headerValue(inWindow.at(-1)?.m.payload?.headers, "Subject");
  if (inWindow.length > GMAIL_THREAD_MESSAGE_LIMIT) truncation.add("thread_message_limit");
  const considered = inWindow.slice(0, GMAIL_THREAD_MESSAGE_LIMIT);
  // A next page continues strictly after the last released (internal date, id) in the newest-first order,
  // so mail that arrives or is deleted between pages never repeats or skips an unread message.
  const remaining = cursor ? considered.filter((x) => x.at < cursor.ba || (x.at === cursor.ba && x.id < cursor.bi)) : considered;
  const page = remaining.slice(0, GMAIL_READ_LIMITS.messagesPerPage);

  const messages: GmailMessage[] = [];
  let textBytes = 0;
  for (const item of page) {
    const headers = item.m.payload?.headers;
    const base = {
      google_message_id: item.id, internal_date: item.at,
      subject: headerValue(headers, "Subject"), from: headerValue(headers, "From"), to: headerValue(headers, "To"),
      cc: null as string | null, date_header: headerValue(headers, "Date"), gmail_url: gmailWebUrl(snapshot.mailboxEmail, item.id),
    };
    if (!transport.roomForAnotherSend()) { truncation.add("page_raw_bytes"); break; }
    const got = await transport.get(gmailMessageFullUrl(item.id));
    let message: GmailMessage;
    if (got.kind === "ok") {
      const full = record(got.json) as GmailApiMessage;
      const fullHeaders = full.payload?.headers;
      const body = normalizeMessageBody(full.payload);
      message = { ...base, cc: headerValue(fullHeaders, "Cc"), ...body, omitted: null };
    } else {
      message = { ...base, text: "", text_format: "none", text_truncated: false, attachment_count: 0, omitted: got.kind === "too_large" ? "too_large" : "unavailable" };
    }
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (textBytes + size > GMAIL_READ_LIMITS.normalizedPageBytes && messages.length > 0) { truncation.add("page_text_bytes"); break; }
    textBytes += size;
    messages.push(message);
  }
  const boundary = messages.at(-1);

  return release(scope, snapshot, async (db) => {
    const truncated = truncation.size > 0 || messages.some((m) => m.omitted !== null || m.text_truncated);
    await insertReadAudit(db, snapshot, { operation: "thread_read", itemCount: messages.length, truncated, requestId: input.requestId });
    const nextCursor = boundary && messages.length < remaining.length ? await signGmailCursor(config, {
      v: 1, k: "read", o: snapshot.ownerUserId, s: snapshot.spaceId, c: snapshot.connectionId, g: snapshot.generation, p: routed.project_id,
      sel: input.selectionId, w: selection.windowKey, th: selection.googleThreadId, ba: boundary.internal_date, bi: boundary.google_message_id,
      e: await gmailCursorExpiry(db),
    }) : null;
    return {
      selection_id: input.selectionId, project_id: routed.project_id, connection_id: snapshot.connectionId,
      google_thread_id: selection.googleThreadId, gmail_url: gmailWebUrl(snapshot.mailboxEmail, selection.googleThreadId),
      subject, messages_in_window: considered.length, messages, next_cursor: nextCursor, truncated, truncation: [...truncation],
    };
  });
}
