import { createHash } from "node:crypto";
import type { HostThreadEventType } from "./threadEventRepository.js";
import { createAcpToolCallLifecycle, isTerminalAcpToolStatus } from "../runtimeAdapters/acpToolCallLifecycle.js";
import { normalizeToolName } from "../runtimeAdapters/toolName.js";
import { createAcpRuntimeStatusProjector } from "../runtimeAdapters/acpRuntimeStatus.js";
import type { ToolCallDetails } from "@rainver/protocol";
import { createAcpToolPresentation, safeToolText } from "./acpToolPresentation.js";

export interface ThreadEventDraft {
  event_type: HostThreadEventType;
  text?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_input_summary?: string | null;
  tool_kind?: string | null;
  tool_result_summary?: string | null;
  tool_details_json?: ToolCallDetails | null;
  status?: string | null;
}

const MAX_TOOL_INPUT_SUMMARY_CHARS = 8_000;

/**
 * Turns a remote-host vendor CLI's ACP protocol traffic into the thread's
 * normalized conversation events, incrementally as it arrives.
 *
 * This is a thin ACP projection. Agent-message and agent-thought chunks stay
 * on the channel the protocol assigned, in arrival order. ToolCall creates or
 * replaces an entry and ToolCallUpdate carries patch fields for that same id.
 * It never infers reasoning from message text.
 */
export function createThreadEventNormalizer(onDeferredOutput?: (drafts: ThreadEventDraft[]) => void): {
  pushStderr(chunk: string): ThreadEventDraft[];
  pushAcpTextDelta(delta: string): ThreadEventDraft[];
  pushAcpThoughtDelta(delta: string): ThreadEventDraft[];
  pushAcpProtocolEvent(event: Record<string, unknown>): ThreadEventDraft[];
  finish(): ThreadEventDraft[];
} {
  let stderrBuffer = "";
  const projectRuntimeStatus = createAcpRuntimeStatusProjector();
  const toolCalls = createAcpToolCallLifecycle();
  const toolFingerprints = new Map<string, string>();
  const terminalTools = new Map<string, string>();
  const presentTool = createAcpToolPresentation();
  const pendingOutput = new Map<string, ThreadEventDraft>();
  const outputEmittedAt = new Map<string, number>();
  let outputTimer: ReturnType<typeof setTimeout> | null = null;

  function changedToolEvents(drafts: ThreadEventDraft[]): ThreadEventDraft[] {
    return drafts.filter(draft => {
      const id = draft.tool_call_id!;
      const fingerprint = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
      if (toolFingerprints.get(id) === fingerprint) {
        pendingOutput.delete(id);
        return false;
      }
      if (draft.event_type === "tool_activity_finished" && draft.status === null && draft.tool_result_summary !== null) {
        if (Date.now() - (outputEmittedAt.get(id) ?? 0) < 250) {
          pendingOutput.set(id, draft);
          if (onDeferredOutput && outputTimer === null) outputTimer = setTimeout(() => {
            outputTimer = null;
            const ready = [...pendingOutput.values()];
            pendingOutput.clear();
            for (const event of ready) {
              toolFingerprints.set(event.tool_call_id!, createHash("sha256").update(JSON.stringify(event)).digest("hex"));
              outputEmittedAt.set(event.tool_call_id!, Date.now());
            }
            if (ready.length) onDeferredOutput(ready);
          }, 250);
          return false;
        }
      }
      pendingOutput.delete(id);
      toolFingerprints.set(id, fingerprint);
      if (draft.tool_result_summary != null) outputEmittedAt.set(id, Date.now());
      return true;
    });
  }
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
    const statuses = projectRuntimeStatus(event);
    if (statuses.length) return [...flushTextSegment(), ...statuses.map(value => ({ event_type: "status" as const, ...value }))];
    if (event.method !== "session/update") return [];
    const update = recordValue(recordValue(event.params).update);
    if (update.sessionUpdate === "notice") {
      const notice = recordValue(update.notice);
      if (typeof notice.title !== "string") return [];
      return [...flushTextSegment(), {
        event_type: "status", status: "runtime_notice",
        text: JSON.stringify({ severity: notice.severity === "error" || notice.severity === "warning" ? notice.severity : "info", title: safeToolText(notice.title, 1_000), description: typeof notice.description === "string" ? safeToolText(notice.description, 4_000) : null }),
      }];
    }
    const callId = stringValue(update.toolCallId ?? update.tool_call_id);
    if (update.sessionUpdate === "tool_call") {
      const status = acpToolStatus(stringValue(update.status)) ?? "pending";
      const toolName = normalizeToolName(stringValue(update.title ?? update.name));
      const lifecycle = toolCalls.started({ callId, name: toolName, status: stringValue(update.status) });
      if (terminalTools.has(lifecycle.callId) && !isTerminalAcpToolStatus(stringValue(update.status))) return flushTextSegment();
      const presentation = presentTool(lifecycle.callId, update);
      const input = summarizeInput(update.rawInput ?? update.raw_input);
      if (input !== null) presentation.details = { ...presentation.details, input_truncated: input.length > MAX_TOOL_INPUT_SUMMARY_CHARS };
      if (isTerminalAcpToolStatus(stringValue(update.status))) terminalTools.set(lifecycle.callId, stringValue(update.status)!);
      return [
        ...flushTextSegment(),
        ...changedToolEvents([{
          event_type: "tool_activity_started",
          tool_call_id: lifecycle.callId,
          tool_name: toolName,
          tool_input_summary: input,
          // The 9-category kind is what
          // makes claude/codex/opencode tool rows comparable in the UI.
          tool_kind: stringValue(update.kind),
          tool_result_summary: presentation.output,
          ...(presentation.details ? { tool_details_json: presentation.details } : {}),
          status,
        }]),
      ];
    }
    if (update.sessionUpdate === "tool_call_update") {
      const status = stringValue(update.status);
      if (status !== null && !["pending", "in_progress", "completed", "failed", "cancelled", "canceled"].includes(status)) return [];
      const toolName = normalizeToolName(stringValue(update.title ?? update.name));
      const toolKind = stringValue(update.kind);
      const toolInput = summarizeInput(update.rawInput ?? update.raw_input);
      const lifecycle = toolCalls.updated({ callId, name: toolName, status });
      const terminal = terminalTools.get(lifecycle.callId);
      if (terminal && status && !isTerminalAcpToolStatus(status)) return flushTextSegment();
      const presentation = presentTool(lifecycle.callId, update);
      if (toolInput !== null) presentation.details = { ...presentation.details, input_truncated: toolInput.length > MAX_TOOL_INPUT_SUMMARY_CHARS };
      if (isTerminalAcpToolStatus(status)) terminalTools.set(lifecycle.callId, status!);
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
        ...changedToolEvents([...start, {
          event_type: "tool_activity_finished",
          tool_call_id: lifecycle.callId,
          tool_name: toolName,
          tool_input_summary: toolInput,
          tool_kind: toolKind,
          status: acpToolStatus(status ?? terminal ?? null),
          tool_result_summary: presentation.output,
          ...(presentation.details ? { tool_details_json: presentation.details } : {}),
        }]),
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
      .map((line): ThreadEventDraft => ({ event_type: "diagnostic", text: safeToolText(line, 8_000) }));
  }

  function finish(): ThreadEventDraft[] {
    if (outputTimer !== null) clearTimeout(outputTimer);
    outputTimer = null;
    const drafts: ThreadEventDraft[] = [];
    drafts.push(...flushTextSegment());
    drafts.push(...pendingOutput.values());
    pendingOutput.clear();
    if (stderrBuffer.trim()) {
      drafts.push({ event_type: "diagnostic", text: safeToolText(stderrBuffer.trim(), 8_000) });
    }
    stderrBuffer = "";
    return drafts;
  }

  return { pushStderr, pushAcpTextDelta, pushAcpThoughtDelta, pushAcpProtocolEvent, finish };
}

function acpToolStatus(status: string | null): string | null {
  if (status === null) return null;
  if (status === "failed" || status === "cancelled" || status === "canceled") return "failed";
  if (status === "completed") return "succeeded";
  if (status === "pending") return "pending";
  return "in_progress";
}

function summarizeInput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return null;
  }
  return safeToolText(text, MAX_TOOL_INPUT_SUMMARY_CHARS, "head");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
