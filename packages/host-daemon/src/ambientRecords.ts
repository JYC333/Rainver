/**
 * Folding a replay's update stream into records.
 *
 * A record is a whole message or a whole tool call, never a chunk: text
 * arrives split across many `*_message_chunk` updates sharing a `messageId`,
 * and a tool call arrives as a `tool_call` followed by `tool_call_update`s
 * carrying its result. Thoughts are dropped — the least stable part across
 * runtimes, and reasoning rather than conclusion.
 *
 * Pure by construction: given the updates, the records. That is what lets the
 * shapes each runtime really produces be pinned in tests without starting a
 * child process.
 */

import { clean, redactAmbientText } from "./ambientRedaction.js";
import {
  DEFAULT_LIMITS,
  type AmbientRecord,
  type AmbientTrimLimits,
  type AmbientUsage,
} from "./ambientSessions.js";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return contentText(record.content);
  }
  return "";
}

interface RecordDraft {
  kind: AmbientRecord["kind"];
  sequence: number;
  text: string;
  toolName: string | null;
  toolStatus: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  raw: string | null;
}

/**
 * Folds a replay's update stream into records.
 *
 * A record is a whole message or a whole tool call, never a chunk: text
 * arrives split across many `*_message_chunk` updates sharing a `messageId`,
 * and a tool call arrives as a `tool_call` followed by `tool_call_update`s
 * carrying its result. Thoughts are dropped — the least stable part across
 * runtimes, and reasoning rather than conclusion.
 */
export function buildAmbientRecords(
  updates: readonly Record<string, unknown>[],
  limits: AmbientTrimLimits = DEFAULT_LIMITS,
): { records: AmbientRecord[]; usage: AmbientUsage[] } {
  const drafts = new Map<string, RecordDraft>();
  const usage: AmbientUsage[] = [];
  let sequence = 0;
  let unknownIndex = 0;
  // Chunks of one message share a `messageId` in every runtime verified so
  // far. One that omits it would otherwise turn a single message into one
  // record per chunk, with keys that move whenever the text does — which
  // breaks reconciliation, not just the display. Consecutive chunks of the
  // same kind are treated as one message instead.
  let anonymous: { kind: string; key: string } | null = null as { kind: string; key: string } | null;

  const draftFor = (key: string, kind: AmbientRecord["kind"]): RecordDraft => {
    const existing = drafts.get(key);
    if (existing) return existing;
    const created: RecordDraft = {
      kind,
      sequence: sequence++,
      text: "",
      toolName: null,
      toolStatus: null,
      toolInput: null,
      toolOutput: null,
      raw: null,
    };
    drafts.set(key, created);
    return created;
  };

  for (const update of updates) {
    const kind = stringOrNull(update.sessionUpdate);
    if (!kind) continue;
    switch (kind) {
      case "user_message_chunk":
      case "agent_message_chunk": {
        const explicitId = stringOrNull(update.messageId);
        let messageId = explicitId;
        if (!messageId) {
          if (anonymous?.kind !== kind) anonymous = { kind, key: `anonymous-${drafts.size}` };
          messageId = anonymous.key;
        } else {
          anonymous = null;
        }
        const draft = draftFor(
          `message:${messageId}`,
          kind === "user_message_chunk" ? "user_message" : "agent_message",
        );
        draft.text += contentText(update.content);
        break;
      }
      case "tool_call": {
        const toolCallId = stringOrNull(update.toolCallId);
        if (!toolCallId) break;
        const draft = draftFor(`tool:${toolCallId}`, "tool_call");
        const meta = (update._meta ?? {}) as Record<string, unknown>;
        const vendorMeta = Object.values(meta).find((value) => value && typeof value === "object") as Record<string, unknown> | undefined;
        draft.toolName = stringOrNull(update.title)
          ?? stringOrNull(vendorMeta?.toolName)
          ?? stringOrNull(update.kind);
        draft.toolStatus = stringOrNull(update.status);
        if (update.rawInput !== undefined) draft.toolInput = JSON.stringify(update.rawInput);
        break;
      }
      case "tool_call_update": {
        const toolCallId = stringOrNull(update.toolCallId);
        if (!toolCallId) break;
        const draft = draftFor(`tool:${toolCallId}`, "tool_call");
        draft.toolStatus = stringOrNull(update.status) ?? draft.toolStatus;
        draft.toolName = draft.toolName ?? stringOrNull(update.title);
        if (update.rawOutput !== undefined) draft.toolOutput = JSON.stringify(update.rawOutput);
        else if (update.content !== undefined && !draft.toolOutput) draft.toolOutput = contentText(update.content);
        break;
      }
      case "plan": {
        // Only the last plan survives: earlier ones are superseded by it, and
        // a record per revision would bury the conversation in bookkeeping.
        const draft = draftFor("plan:current", "plan");
        draft.raw = JSON.stringify(update.entries ?? update);
        break;
      }
      case "usage_update": {
        const value = (update.usage ?? update) as Record<string, unknown>;
        const number = (name: string): number | null => {
          const candidate = value[name];
          return typeof candidate === "number" && Number.isFinite(candidate) ? Math.max(0, Math.trunc(candidate)) : null;
        };
        const entry: AmbientUsage = {
          record_key: `usage-${usage.length}`,
          model: stringOrNull(value.model) ?? stringOrNull(update.model),
          occurred_at: stringOrNull(update.timestamp),
          input_tokens: number("inputTokens"),
          output_tokens: number("outputTokens"),
          cache_read_input_tokens: number("cachedReadTokens"),
          cache_creation_input_tokens: number("cachedWriteTokens"),
          reasoning_tokens: number("thoughtTokens"),
        };
        if (entry.input_tokens !== null || entry.output_tokens !== null) usage.push(entry);
        break;
      }
      case "agent_thought_chunk":
        // A thought interrupts a run of anonymous chunks the same way any
        // other update does, so the next one starts a new message.
        anonymous = null;
        break;
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        break;
      default: {
        // Not a failure: an update this version does not model is kept raw so
        // a later parser version can re-derive it, rather than being lost at
        // the one moment the source still exists.
        const draft = draftFor(`unknown:${kind}:${unknownIndex++}`, "unknown");
        draft.raw = JSON.stringify(update);
        break;
      }
    }
  }

  const records: AmbientRecord[] = [];
  for (const [key, draft] of drafts) {
    const state = { truncated: false };
    const text = draft.kind === "user_message" || draft.kind === "agent_message"
      ? clean(draft.text, limits.text_max_bytes, state)
      : null;
    const toolInput = clean(draft.toolInput, limits.tool_input_max_bytes, state);
    const toolOutput = clean(draft.toolOutput, limits.tool_output_max_bytes, state);
    const raw = clean(draft.raw, limits.raw_max_bytes, state);
    if (text === null && toolInput === null && toolOutput === null && raw === null && draft.toolName === null) continue;
    records.push({
      record_key: key.slice(0, 256),
      kind: draft.kind,
      sequence: draft.sequence,
      occurred_at: null,
      text,
      tool_name: draft.toolName ? redactAmbientText(draft.toolName).slice(0, 256) : null,
      tool_status: draft.toolStatus?.slice(0, 64) ?? null,
      tool_input: toolInput,
      tool_output: toolOutput,
      raw_json: raw,
      truncated: state.truncated,
    });
  }
  records.sort((left, right) => left.sequence - right.sequence);
  return { records, usage };
}
