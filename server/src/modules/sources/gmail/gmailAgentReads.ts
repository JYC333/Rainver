/**
 * The on-demand Agent read of the owner's mail (ADR 0032): the newest inbox
 * messages, or a Gmail search, one page at a time, with plain-text bodies for the
 * same private conversation to summarize.
 *
 * It is the owner read's sequence (`gmailMailReads.ts`) with a narrower
 * request set: (1) a short admission transaction locks the read authority —
 * active person, owner + Space mutex, the active connection carrying the
 * owner's Agent-read opt-in — and records its generation; (2) outside every
 * transaction, the Sources broker sends one `messages.list` and one
 * `messages.get format=full` per listed message (`gmailAgentReadContract.ts`:
 * exact allowlist, no redirects, one list plus one fetch per requested message, 2 MiB / 15 s per
 * response, upstream cooldowns shared by account and owner), rerunning the authority check and
 * the caller's Run-consent check before each send; (3) the server normalizes
 * in memory. No Job, cache table, file, SourceItem or audit row is written
 * here: the caller's release gate rechecks everything under lock and writes
 * the audit rows before the result leaves the server.
 */
import { type GmailAgentMessage, type GmailAgentReadOutput } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Queryable } from "../../routeUtils/common.js";
import type { Pool } from "../../../db/pool.js";
import { admit, pageTransport, record } from "./gmailMailReads.js";
import { GmailReadError, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { withGmailReadStage, type GmailReadStage } from "./gmailReadErrors.js";
import { GmailCursorError, gmailCursorExpiry, gmailCursorLive, openGmailCursor, signGmailCursor } from "./gmailCursor.js";
import { gmailPageScope } from "./gmailReadDeadline.js";
import {
  createGmailAgentSendBudget, GMAIL_AGENT_EXCLUDED_LABELS, gmailAgentListUrl, gmailAgentMessageUrl, gmailAgentSourceRequestPolicy,
} from "./gmailAgentReadContract.js";
import { gmailId, headerValue, internalDateIso, normalizeMessageBody, type GmailApiMessage } from "./gmailMessageText.js";

export interface GmailAgentReadRequest {
  spaceId: string;
  ownerUserId: string;
  connectionId: string;
  projectId: string;
  /** null: the newest inbox messages; otherwise a Gmail search. */
  query: string | null;
  max: number;
  pageToken?: string;
  signal: AbortSignal;
  /** The caller's Run-consent recheck, before every physical send. */
  authorizeSend: (db: Queryable) => Promise<void>;
}

const RESUME_PREFIX = "resume:";

async function openAgentResume(config: ServerConfig, token: string | undefined) {
  if (!token?.startsWith(RESUME_PREFIX)) return null;
  try {
    return await openGmailCursor(config, token.slice(RESUME_PREFIX.length), "agent");
  } catch (error) {
    if (error instanceof GmailCursorError) throw new GmailReadError(422, "gmail_cursor_invalid");
    throw error;
  }
}

export async function readGmailForAgent(config: ServerConfig, pool: Pool, input: GmailAgentReadRequest): Promise<{ output: GmailAgentReadOutput; snapshot: GmailReadSnapshot }> {
  if (!config.gmailOAuth) throw new GmailReadError(503, "gmail_not_configured", undefined, { stage: "admission" });
  const scope = gmailPageScope(config, pool, input.signal);
  const resume = await openAgentResume(config, input.pageToken);
  let expiry = "";
  const snapshot = await withGmailReadStage("admission", () => admit(scope, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, projectId: null, connectionId: input.connectionId, agentRead: true }, async (db, current) => {
    if (resume) {
      if (resume.o !== input.ownerUserId || resume.s !== input.spaceId || resume.c !== input.connectionId ||
        resume.g !== current.generation || resume.p !== input.projectId || resume.query !== input.query || resume.max !== input.max) {
        throw new GmailReadError(422, "gmail_cursor_invalid");
      }
      if (!await gmailCursorLive(db, resume)) throw new GmailReadError(422, "gmail_cursor_expired");
    }
    expiry = await gmailCursorExpiry(db);
  }));
  const transport = pageTransport(config, scope, snapshot, {
    scopeId: `gmail-agent-read:${snapshot.connectionId}`,
    policy: gmailAgentSourceRequestPolicy,
    upstreamCooldownOnly: true,
    budget: createGmailAgentSendBudget(input.max),
    authorizeSend: input.authorizeSend,
  });
  let ids: string[];
  let nextPageToken: string | null;
  if (resume) {
    ids = resume.remaining;
    nextPageToken = resume.next;
  } else {
    const stage: GmailReadStage = input.pageToken ? "list_next_page" : "list_first_page";
    const listUrl = gmailAgentListUrl({ query: input.query, max: input.max, pageToken: input.pageToken });
    const list = await withGmailReadStage(stage, () => transport.get(listUrl));
    if (list.kind !== "ok") {
      const diagnostic = list.kind === "not_found"
        ? { stage, cause: "upstream_http" as const, upstream_status: 404 }
        : { stage, cause: "response_too_large" as const };
      throw new GmailReadError(502, "gmail_upstream_error", undefined, diagnostic);
    }
    const page = record(list.json);
    const listed = (Array.isArray(page.messages) ? page.messages : [])
      .map((m) => gmailId(record(m).id)).filter((id): id is string => id !== null);
    ids = [...new Set(listed)].slice(0, input.max);
    nextPageToken = typeof page.nextPageToken === "string" && /^[^\x00-\x20\x7f]+$/.test(page.nextPageToken) ? page.nextPageToken : null;
    if (nextPageToken === input.pageToken) {
      throw new GmailReadError(502, "gmail_upstream_error", undefined, { stage, cause: "repeated_page_token" });
    }
  }
  let truncated = false;
  const items: GmailAgentMessage[] = [];
  for (const [index, id] of ids.entries()) {
    if (!transport.roomForAnotherSend()) {
      nextPageToken = RESUME_PREFIX + await signGmailCursor(config, {
        v: 1, k: "agent", o: input.ownerUserId, s: input.spaceId, c: input.connectionId,
        g: snapshot.generation, p: input.projectId, e: expiry, query: input.query,
        max: input.max, remaining: ids.slice(index), next: nextPageToken,
      });
      break;
    }
    const got = await withGmailReadStage("fetch_message", () => transport.get(gmailAgentMessageUrl(id)));
    // Too large or gone since listing: left out and reported, never shown partially.
    if (got.kind !== "ok") { truncated = true; continue; }
    const full = record(got.json) as GmailApiMessage;
    const labels = Array.isArray(full.labelIds) ? full.labelIds.filter((l): l is string => typeof l === "string") : [];
    if (labels.some((label) => GMAIL_AGENT_EXCLUDED_LABELS.has(label))) continue;
    const at = internalDateIso(full.internalDate);
    if (gmailId(full.id) !== id || !at) { truncated = true; continue; }
    const headers = full.payload?.headers;
    items.push({
      id, internal_date: at,
      subject: headerValue(headers, "Subject"), from: headerValue(headers, "From"), to: headerValue(headers, "To"),
      cc: headerValue(headers, "Cc"), date_header: headerValue(headers, "Date"),
      ...normalizeMessageBody(full.payload, Infinity),
    });
  }
  return {
    output: {
      mailbox_email: snapshot.mailboxEmail, source: input.query === null ? "recent_inbox" : "search",
      items, next_page_token: nextPageToken,
      truncated: truncated || items.some((item) => item.text_truncated),
    },
    snapshot,
  };
}
