import type { HostThreadEventType } from "./threadEventRepository.js";
import { createAcpToolCallLifecycle } from "../runtimeAdapters/acpToolCallLifecycle.js";
import { normalizeToolName } from "../runtimeAdapters/toolName.js";
import { isRuntimeMetadataDiagnostic } from "../runtimeAdapters/runtimeDiagnostic.js";
import { redactSecretPatterns } from "../runs/evidenceRedaction.js";

export interface ThreadEventDraft {
  event_type: HostThreadEventType;
  text?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_input_summary?: string | null;
  tool_kind?: string | null;
  tool_result_summary?: string | null;
  status?: string | null;
}

const MAX_TOOL_RESULT_SUMMARY_CHARS = 4_000;
const MAX_TOOL_INPUT_SUMMARY_CHARS = 200;

/**
 * Turns a remote-host vendor CLI's ACP protocol traffic into the thread's
 * normalized conversation events, incrementally as it arrives.
 *
 * This is a thin ACP projection. Agent-message and agent-thought chunks stay
 * on the channel the protocol assigned, in arrival order. ToolCall creates or
 * replaces an entry and ToolCallUpdate carries patch fields for that same id.
 * It never infers reasoning from message text.
 */
export function createThreadEventNormalizer(runtimeKey?: string): {
  pushStderr(chunk: string): ThreadEventDraft[];
  pushAcpTextDelta(delta: string): ThreadEventDraft[];
  pushAcpThoughtDelta(delta: string): ThreadEventDraft[];
  pushAcpProtocolEvent(event: Record<string, unknown>): ThreadEventDraft[];
  finish(): ThreadEventDraft[];
} {
  let stderrBuffer = "";
  const toolCalls = createAcpToolCallLifecycle();
  let assistantSegment: {
    kind: "assistant_text" | "assistant_thought";
    text: string;
  } | null = null;

  function flushAssistantSegment(): ThreadEventDraft[] {
    if (!assistantSegment?.text) return [];
    const draft = { event_type: assistantSegment.kind, text: assistantSegment.text };
    assistantSegment = null;
    return [draft];
  }

  function flushTextSegment(): ThreadEventDraft[] {
    return flushAssistantSegment();
  }

  function appendDelta(
    kind: "assistant_text" | "assistant_thought",
    text: string,
  ): ThreadEventDraft[] {
    const drafts: ThreadEventDraft[] = [];
    if (assistantSegment && assistantSegment.kind !== kind) {
      drafts.push(...flushAssistantSegment());
    }
    if (!assistantSegment) assistantSegment = { kind, text: "" };
    assistantSegment.text += text;
    let rest = assistantSegment.text;
    if (!rest.includes("\n")) return drafts;
    // A chunk can carry more than one completed line.
    let at = rest.indexOf("\n");
    while (at !== -1) {
      const line = rest.slice(0, at + 1);
      if (line) drafts.push({ event_type: kind, text: line });
      rest = rest.slice(at + 1);
      at = rest.indexOf("\n");
    }
    assistantSegment.text = rest;
    if (!rest) assistantSegment = null;
    return drafts;
  }

  function pushAcpTextDelta(delta: string): ThreadEventDraft[] {
    return delta ? appendDelta("assistant_text", delta) : [];
  }

  function pushAcpThoughtDelta(delta: string): ThreadEventDraft[] {
    return delta ? appendDelta("assistant_thought", delta) : [];
  }

  function pushAcpProtocolEvent(event: Record<string, unknown>): ThreadEventDraft[] {
    if (event.method !== "session/update") return [];
    const update = recordValue(recordValue(event.params).update);
    const callId = stringValue(update.toolCallId ?? update.tool_call_id);
    if (update.sessionUpdate === "tool_call") {
      const status = acpToolStatus(stringValue(update.status)) ?? "pending";
      const toolName = normalizeToolName(stringValue(update.title ?? update.name));
      const lifecycle = toolCalls.started({ callId, name: toolName, status: stringValue(update.status) });
      return [
        ...flushTextSegment(),
        {
          event_type: "tool_activity_started",
          tool_call_id: lifecycle.callId,
          tool_name: toolName,
          tool_input_summary: summarizeJson(update.rawInput ?? update.raw_input, MAX_TOOL_INPUT_SUMMARY_CHARS, "head"),
          // The 9-category kind is what
          // makes claude/codex/opencode tool rows comparable in the UI.
          tool_kind: stringValue(update.kind),
          tool_result_summary: summarizeToolOutput(update),
          status,
        },
      ];
    }
    if (update.sessionUpdate === "tool_call_update") {
      const status = stringValue(update.status);
      if (status !== null && !["pending", "in_progress", "completed", "failed"].includes(status)) return [];
      const toolName = normalizeToolName(stringValue(update.title ?? update.name));
      const toolKind = stringValue(update.kind);
      const toolInput = summarizeJson(update.rawInput ?? update.raw_input, MAX_TOOL_INPUT_SUMMARY_CHARS, "head");
      const toolOutput = summarizeToolOutput(update);
      const lifecycle = toolCalls.updated({ callId, name: toolName, status });
      const start: ThreadEventDraft[] = lifecycle.missingStart
        ? [{
            event_type: "tool_activity_started",
            tool_call_id: lifecycle.callId,
            tool_name: toolName,
            tool_input_summary: toolInput,
            tool_kind: toolKind,
            tool_result_summary: null,
            status: "pending",
          }]
        : [];
      return [
        ...flushTextSegment(),
        ...start,
        {
          event_type: "tool_activity_finished",
          tool_call_id: lifecycle.callId,
          tool_name: toolName,
          tool_input_summary: toolInput,
          tool_kind: toolKind,
          status: acpToolStatus(status),
          // Absorbed for claude/opencode; codex-acp reports none
          // (a known adapter asymmetry, not a bug).
          tool_result_summary: toolOutput,
        },
      ];
    }
    if (update.sessionUpdate === "plan") {
      // Appended as a snapshot, never mutated — a reader takes the
      // thread's latest plan_updated event, not a running diff of them.
      return [
        ...flushTextSegment(),
        { event_type: "plan_updated", text: JSON.stringify(update.entries ?? []) },
      ];
    }
    // agent_message_chunk (and any other update kind) carries no lifecycle
    // signal this normalizer surfaces — text arrives via pushAcpTextDelta
    // instead, never both, matching the raw-stdout path's separation.
    return [];
  }

  function pushStderr(chunk: string): ThreadEventDraft[] {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isRuntimeMetadataDiagnostic(runtimeKey, line))
      .map((line): ThreadEventDraft => ({ event_type: "diagnostic", text: line }));
  }

  function finish(): ThreadEventDraft[] {
    const drafts: ThreadEventDraft[] = [];
    drafts.push(...flushTextSegment());
    if (stderrBuffer.trim() && !isRuntimeMetadataDiagnostic(runtimeKey, stderrBuffer.trim())) {
      drafts.push({ event_type: "diagnostic", text: stderrBuffer.trim() });
    }
    stderrBuffer = "";
    return drafts;
  }

  return { pushStderr, pushAcpTextDelta, pushAcpThoughtDelta, pushAcpProtocolEvent, finish };
}

function acpToolStatus(status: string | null): string | null {
  if (status === null) return null;
  if (status === "failed") return "failed";
  if (status === "completed") return "succeeded";
  if (status === "pending") return "pending";
  return "in_progress";
}

/** `head` keeps the start (a call's input); `middle` keeps both ends (its output). */
type SummaryShape = "head" | "middle";

function summarizeJson(value: unknown, maxChars: number, shape: SummaryShape): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return null;
  }
  return boundedSummary(text, maxChars, shape);
}

/**
 * How far past what is kept the redaction still reads. Far beyond any secret
 * shape, so a credential straddling a cut is matched whole before the cut,
 * while a multi-megabyte output is never scanned in full.
 */
const REDACTION_WINDOW_FACTOR = 16;

/**
 * Persisted tool summaries are redacted with the canonical evidence rule
 * before they are bounded: a command's output is exactly where an agent
 * prints a token it just read.
 */
function boundedSummary(text: string, limit: number, shape: SummaryShape = "middle"): string {
  const window = limit * REDACTION_WINDOW_FACTOR;
  if (shape === "head") {
    const redacted = redactSecretPatterns(text.slice(0, window));
    return redacted.length > limit || text.length > window ? `${redacted.slice(0, limit)}…` : redacted;
  }
  const marker = "\n… [output truncated; middle omitted] …\n";
  const redacted = text.length > window * 2
    ? `${redactSecretPatterns(text.slice(0, window))}${marker}${redactSecretPatterns(text.slice(-window))}`
    : redactSecretPatterns(text);
  if (redacted.length <= limit) return redacted;
  const half = Math.floor((limit - marker.length) / 2);
  return `${redacted.slice(0, half)}${marker}${redacted.slice(-(limit - marker.length - half))}`;
}

function summarizeToolOutput(update: Record<string, unknown>): string | null {
  const raw = update.rawOutput ?? update.raw_output;
  const result = recordValue(raw);
  if (typeof result.formatted_output === "string") {
    const code = typeof result.exit_code === "number" ? result.exit_code
      : typeof result.exit_code === "string" && /^-?\d+$/.test(result.exit_code) ? Number(result.exit_code) : null;
    // Preserve execution metadata outside the bounded text. A warning-heavy
    // prefix must not consume the exit code or the end of the command output.
    return JSON.stringify({
      exit_code: code !== null && Number.isSafeInteger(code) ? code : null,
      formatted_output: boundedSummary(result.formatted_output, MAX_TOOL_RESULT_SUMMARY_CHARS),
      truncated: result.formatted_output.length > MAX_TOOL_RESULT_SUMMARY_CHARS,
    });
  }
  return summarizeToolResultContent(update.content) ?? summarizeJson(raw, MAX_TOOL_RESULT_SUMMARY_CHARS, "middle");
}

/**
 * Only the "content" tool-call-content
 * variant is absorbed — text an agent explicitly reported as a tool's
 * result. The "diff" variant is declined by design (the daemon's own
 * `git diff HEAD` captures the workspace's true state, including changes the
 * agent never reported — strictly better for review than trusting the
 * agent's self-reported diff).
 */
function summarizeToolResultContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content
    .map(recordValue)
    .filter((block) => block.type === "content")
    .map((block) => stringValue(recordValue(block.content).text))
    .filter((text): text is string => text !== null);
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  return boundedSummary(joined, MAX_TOOL_RESULT_SUMMARY_CHARS);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
