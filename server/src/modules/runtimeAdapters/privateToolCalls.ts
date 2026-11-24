/**
 * Tool calls whose arguments and result are private to the instructing person.
 *
 * A Rainver action listed here carries what one person waits for (a Gmail
 * monitor's senders, subjects, labels, purpose, mailbox) or the person's mail
 * itself (`source.gmail.mail.read`: the search words and every message read). Its Run may still be
 * readable by others — Space oversight, or every reader of a shared Room when
 * the action refuses — and before the draft commits nothing marks the Run
 * owner-only. So the call is reduced at the ACP boundary, before either event
 * log persists it and therefore before the live turn stream (which polls those
 * rows) can show it: only the call id, status, kind and a fixed title remain.
 * The person's own message keeps its own read rules; this touches only the
 * tool call.
 *
 * A call is recognised by the action id in its title, name or raw input (a CLI
 * command line, or an MCP-style tool name with `_` separators) and stays
 * reduced for every later update of the same call id, which usually carries
 * only output.
 */
export const PRIVATE_TOOL_CALL_ACTIONS: readonly string[] = Object.freeze(["source.gmail.monitor.propose", "source.gmail.mail.read", "source.gmail.digest.propose", "source.gmail.digest.read", "source.gmail.private_check.request",
  // ADR 0034: the owner's application-update automation and the facts its Run records from their mail.
  "source.gmail.application_updates.propose", "source.gmail.application_updates.list", "source.gmail.application_updates.flag", "plugin.applications.mail_fact.apply",
  "plugin.applications.mail_fact.list",
  // ADR 0035: the combined card, the owner's delegations and a member's delegated read of the owner's mail.
  "source.gmail.setup.propose", "source.gmail.delegation.propose", "source.gmail.delegation.list", "source.gmail.delegated.read",
  // Withdrawn (ADR 0033 §6); a model that still names it stays reduced.
  "source.gmail.private_read.request"]);

const PATTERNS = PRIVATE_TOOL_CALL_ACTIONS.map((id) => new RegExp(id.split(".").map(escape).join("[._-]"), "i"));

function escape(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function privateAction(update: Record<string, unknown>): string | null {
  let text: string;
  try {
    text = [update.title, update.name, update.rawInput, update.raw_input]
      .map((value) => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)).join("\n");
  } catch {
    return null;
  }
  const index = PATTERNS.findIndex((pattern) => pattern.test(text));
  return index >= 0 ? PRIVATE_TOOL_CALL_ACTIONS[index]! : null;
}

/** Call ids remembered per session and per kind (private, ordinary); the least recently seen is dropped first. */
export const PRIVATE_TOOL_CALL_TRACKING_LIMIT = 512;

function remember(calls: Map<string, string>, callId: string, value: string): boolean {
  calls.delete(callId);
  calls.set(callId, value);
  if (calls.size <= PRIVATE_TOOL_CALL_TRACKING_LIMIT) return false;
  calls.delete(calls.keys().next().value!);
  return true;
}

/**
 * One filter per runtime session. Returns the event unchanged unless it is a
 * tool call (or update) of a private action, in which case it returns a copy
 * whose update keeps only `sessionUpdate`, the call id, `status`, `kind` and
 * the action id as title.
 *
 * Tracking is bounded. Once a private call id has been dropped, an update
 * that names neither a private action nor a remembered call cannot be shown
 * to be ordinary, so it is reduced the same way but without a title. An
 * ordinary call whose start was seen stays remembered and keeps its output.
 * Without an id, an update cannot be attributed to its start. Once any
 * private anonymous call has been seen, every later anonymous update that does
 * not itself name a private action is reduced until the session ends — also
 * late ones after a terminal status and ones following an ordinary anonymous
 * start, which itself still passes through. That reduction carries no title,
 * so it is not attributed to the private action either.
 */
export function createPrivateToolCallFilter(): (event: Record<string, unknown>) => Record<string, unknown> {
  const privateCalls = new Map<string, string>();
  const ordinaryCalls = new Map<string, string>();
  let privateCallDropped = false;
  let anonymousPrivateSeen = false;
  return (event) => {
    if (event.method !== "session/update") return event;
    const params = record(event.params);
    const update = record(params.update);
    const start = update.sessionUpdate === "tool_call";
    if (!start && update.sessionUpdate !== "tool_call_update") return event;
    const rawId = update.toolCallId ?? update.tool_call_id;
    const callId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
    let action = privateAction(update);
    if (!action && callId) action = privateCalls.get(callId) ?? null;
    let title: string | null = action;
    if (!action) {
      if (!callId) {
        if (start || !anonymousPrivateSeen) return event;
        // Unattributable: an earlier private anonymous call may be the one this update continues.
        title = null;
      } else if (start || ordinaryCalls.has(callId) || !privateCallDropped) {
        remember(ordinaryCalls, callId, "");
        return event;
      } else {
        // Unconfirmable: a dropped private call may be the one this update continues.
        title = null;
      }
    } else if (callId) {
      ordinaryCalls.delete(callId);
      if (remember(privateCalls, callId, action)) privateCallDropped = true;
    } else {
      anonymousPrivateSeen = true;
    }
    const reduced: Record<string, unknown> = { sessionUpdate: update.sessionUpdate };
    if (title) reduced.title = title;
    if (callId) reduced.toolCallId = callId;
    if (typeof update.status === "string") reduced.status = update.status;
    if (typeof update.kind === "string") reduced.kind = update.kind;
    return { ...event, params: { ...params, update: reduced } };
  };
}
