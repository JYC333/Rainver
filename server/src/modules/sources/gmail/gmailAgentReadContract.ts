/**
 * The Gmail requests an on-demand Agent read may send (ADR 0032): one
 * `messages.list` (the newest inbox messages, or a Gmail search) and one
 * `messages.get format=full` per listed message. Nothing else: no profile,
 * thread, history, attachment, raw format, label, settings or watch request,
 * and no mutation method (the routes are GET only). Every hop is checked
 * against this exact allowlist before credentials resolve, redirects are
 * refused, and the per-read physical-send budget is one list plus one fetch per requested message.
 *
 * Pure rules only; the reader (`gmailAgentReads.ts`) builds every URL here.
 */
import { GMAIL_AGENT_PAGE_SIZE } from "@rainver/protocol";
import type { SourceRequestGrant, SourceRequestRoute } from "../sourceRequestBroker.js";
import {
  createGmailSendBudget, GMAIL_API_ORIGIN, GMAIL_READ_LIMITS, GmailContractError, gmailMessageFullUrl, type GmailSendBudget,
} from "./gmailReadContract.js";

const MESSAGES = "/gmail/v1/users/me/messages";
/** The person's words plus the fixed exclusions; Gmail's own search syntax applies. */
const QUERY_MAX = 300;
/**
 * Never part of a search: drafts (unsent text), chats, spam and trash. The
 * reader also drops any listed message carrying one of these labels.
 */
const SEARCH_EXCLUSIONS = "-in:drafts -in:chats -in:spam -in:trash";
export const GMAIL_AGENT_EXCLUDED_LABELS: ReadonlySet<string> = new Set(["DRAFT", "CHAT", "SPAM", "TRASH"]);

/** The newest `max` inbox messages, or a search: never both, never another label. */
export function gmailAgentListUrl(input: { query: string | null; max: number; pageToken?: string }): string {
  if (!Number.isInteger(input.max) || input.max < 1 || input.max > GMAIL_AGENT_PAGE_SIZE.maximum) throw new GmailContractError("gmail_query_invalid");
  const url = new URL(`${GMAIL_API_ORIGIN}${MESSAGES}`);
  url.searchParams.set("maxResults", String(input.max));
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  if (input.query === null) url.searchParams.set("labelIds", "INBOX");
  else {
    const query = input.query.trim();
    if (!query || /[\x00-\x1f\x7f]/.test(query)) throw new GmailContractError("gmail_query_invalid");
    url.searchParams.set("q", `${query} ${SEARCH_EXCLUSIONS}`);
  }
  assertGmailAgentReadUrl(url.toString());
  return url.toString();
}

export { gmailMessageFullUrl as gmailAgentMessageUrl };

const only = (params: URLSearchParams, keys: readonly string[]) => [...params.keys()].every((key) => keys.includes(key));
const atMostOnce = (params: URLSearchParams, key: string) => params.getAll(key).length <= 1;

export function assertGmailAgentReadUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new GmailContractError("gmail_url_refused"); }
  if (url.origin !== GMAIL_API_ORIGIN || url.username || url.password || url.hash || url.port) throw new GmailContractError("gmail_url_refused");
  const p = url.searchParams;
  if (url.pathname === MESSAGES) {
    const max = Number(p.get("maxResults"));
    const ok = only(p, ["maxResults", "labelIds", "q", "pageToken"]) && ["maxResults", "labelIds", "q", "pageToken"].every((key) => atMostOnce(p, key))
      && /^[1-9][0-9]*$/.test(p.get("maxResults") ?? "") && max <= GMAIL_AGENT_PAGE_SIZE.maximum
      && (!p.has("pageToken") || /^[^\x00-\x20\x7f]+$/.test(p.get("pageToken")!))
      // Exactly one of: the inbox (no search), or a search carrying the fixed exclusions.
      && (p.has("labelIds") ? p.get("labelIds") === "INBOX" && !p.has("q")
        : !!p.get("q") && p.get("q")!.length <= QUERY_MAX && p.get("q")!.endsWith(` ${SEARCH_EXCLUSIONS}`));
    if (!ok) throw new GmailContractError("gmail_url_refused");
    return url;
  }
  if (/^\/gmail\/v1\/users\/me\/messages\/[0-9a-f]{1,64}$/.test(url.pathname) && only(p, ["format"]) && p.getAll("format").length === 1 && p.get("format") === "full") return url;
  throw new GmailContractError("gmail_url_refused");
}

function routes(credentialHeaders: () => Promise<Record<string, string>>): SourceRequestRoute[] {
  return [{ origin: GMAIL_API_ORIGIN, path_prefix: MESSAGES, methods: ["GET"], query_keys: ["maxResults", "labelIds", "q", "pageToken", "format"], credentialHeaders }];
}

/** The transport half of an Agent-read broker grant, like `gmailSourceRequestPolicy` with this allowlist. */
export function gmailAgentSourceRequestPolicy(input: {
  credentialHeaders: () => Promise<Record<string, string>>;
  budget: GmailSendBudget;
}): Pick<SourceRequestGrant, "routes" | "maxRedirects" | "assertHopUrl" | "beforePhysicalSend" | "maxBytes" | "deadlineMs"> {
  return {
    routes: routes(input.credentialHeaders),
    maxRedirects: 0,
    assertHopUrl: (url) => { assertGmailAgentReadUrl(url.toString()); },
    beforePhysicalSend: (url) => input.budget.consume(url),
    maxBytes: GMAIL_READ_LIMITS.responseBytes,
    deadlineMs: GMAIL_READ_LIMITS.perSendDeadlineMs,
  };
}

export const createGmailAgentSendBudget = (pageSize: number) => createGmailSendBudget(1 + pageSize);
