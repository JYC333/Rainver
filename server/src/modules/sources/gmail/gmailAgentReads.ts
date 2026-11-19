/**
 * The on-demand Agent read of the owner's mail (ADR 0032): the newest inbox
 * messages, or a Gmail search, at most five, with plain-text bodies for the
 * same private conversation to summarize.
 *
 * It is the owner read's sequence (`gmailMailReads.ts`) with a narrower
 * request set: (1) a short admission transaction locks the read authority —
 * active person, owner + Space mutex, the active connection carrying the
 * owner's Agent-read opt-in — and records its generation; (2) outside every
 * transaction, the Sources broker sends one `messages.list` and one
 * `messages.get format=full` per listed message (`gmailAgentReadContract.ts`:
 * exact allowlist, no redirects, a budget of six sends, 2 MiB / 15 s per
 * response, the account/owner quota groups), rerunning the authority check and
 * the caller's Run-consent check before each send; (3) the server normalizes
 * in memory. No Job, cache table, file, SourceItem or audit row is written
 * here: the caller's release gate rechecks everything under lock and writes
 * the audit rows before the result leaves the server.
 */
import { GMAIL_AGENT_READ_LIMITS, type GmailAgentMessage, type GmailAgentReadOutput } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import { admit, pageTransport, record } from "./gmailMailReads.js";
import { GmailReadError, type GmailReadSnapshot } from "./gmailReadAuthority.js";
import { gmailPageScope } from "./gmailReadDeadline.js";
import {
  createGmailAgentSendBudget, GMAIL_AGENT_EXCLUDED_LABELS, gmailAgentListUrl, gmailAgentMessageUrl, gmailAgentSourceRequestPolicy,
} from "./gmailAgentReadContract.js";
import { gmailId, headerValue, internalDateIso, normalizeMessageBody, type GmailApiMessage } from "./gmailMessageText.js";

export interface GmailAgentReadRequest {
  spaceId: string;
  ownerUserId: string;
  connectionId: string;
  /** null: the newest inbox messages; otherwise a Gmail search. */
  query: string | null;
  max: number;
  signal: AbortSignal;
  /** The caller's Run-consent recheck, before every physical send. */
  authorizeSend: (signal: AbortSignal) => Promise<void>;
}

export async function readGmailForAgent(config: ServerConfig, pool: Pool, input: GmailAgentReadRequest): Promise<{ output: GmailAgentReadOutput; snapshot: GmailReadSnapshot }> {
  if (!config.gmailOAuth) throw new GmailReadError(503, "gmail_not_configured");
  const scope = gmailPageScope(config, pool, input.signal);
  const snapshot = await admit(scope, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, projectId: null, connectionId: input.connectionId, agentRead: true }, async () => {});
  const transport = pageTransport(config, scope, snapshot, {
    scopeId: `gmail-agent-read:${snapshot.connectionId}`,
    policy: gmailAgentSourceRequestPolicy,
    budget: createGmailAgentSendBudget(),
    authorizeSend: input.authorizeSend,
  });
  const list = await transport.get(gmailAgentListUrl({ query: input.query, max: input.max }));
  if (list.kind !== "ok") throw new GmailReadError(502, "gmail_upstream_error");
  const listed = (Array.isArray(record(list.json).messages) ? record(list.json).messages as unknown[] : [])
    .map((m) => gmailId(record(m).id)).filter((id): id is string => id !== null);
  const ids = [...new Set(listed)].slice(0, input.max);
  let truncated = false;
  const items: GmailAgentMessage[] = [];
  for (const id of ids) {
    if (!transport.roomForAnotherSend()) { truncated = true; break; }
    const got = await transport.get(gmailAgentMessageUrl(id));
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
      ...normalizeMessageBody(full.payload, GMAIL_AGENT_READ_LIMITS.textBytesPerMessage),
    });
  }
  return {
    output: {
      mailbox_email: snapshot.mailboxEmail, source: input.query === null ? "recent_inbox" : "search",
      items, truncated: truncated || items.some((item) => item.text_truncated),
    },
    snapshot,
  };
}
