import type {
  CanonicalModelEvent,
  RuntimeSemanticEvent,
} from "@rainver/protocol";
import { redactEvidenceText } from "./evidenceRedaction.js";
import { isAcpRuntimeAdapter } from "../runtimeAdapters/specs.js";
import { createAcpToolCallLifecycle } from "../runtimeAdapters/acpToolCallLifecycle.js";

export function normalizeManagedModelEvents(
  events: CanonicalModelEvent[],
  completedAt: string,
): RuntimeSemanticEvent[] {
  const normalized: RuntimeSemanticEvent[] = [];
  for (const event of events) {
    if (event.type === "model.message_stop") {
      normalized.push({
        schema_version: "runtime_event.v1",
        type: "assistant_message_completed",
        occurred_at: completedAt,
        call_id: null,
        summary: "Assistant message completed.",
        metadata_json: { finish_reason: event.finish_reason ?? null },
      });
    } else if (event.type === "model.error") {
      normalized.push({
        schema_version: "runtime_event.v1",
        type: "error",
        occurred_at: completedAt,
        call_id: null,
        summary: redactEvidenceText(event.error.message),
        metadata_json: { error_code: event.error.code },
      });
    }
    // text/tool deltas and token usage are intentionally not persisted as
    // semantic Run Events.
  }
  return normalized;
}

export function normalizeVendorEvents(
  runtimeKey: string,
  events: Record<string, unknown>[],
  completedAt: string,
): RuntimeSemanticEvent[] {
  const normalizer = createVendorEventNormalizer(runtimeKey);
  return events.flatMap((event) => normalizer.push(event, completedAt));
}

/**
 * Stateful normalizer for one vendor session/run.
 *
 * The stream owns lifecycle correlation. Callers processing events one at a
 * time must retain this instance; the batch helper above is for tests and
 * already-collected event arrays.
 */
export function createVendorEventNormalizer(runtimeKey: string): {
  push(event: Record<string, unknown>, occurredAt: string): RuntimeSemanticEvent[];
} {
  const toolCalls = createAcpToolCallLifecycle();

  const push = (event: Record<string, unknown>, occurredAt: string): RuntimeSemanticEvent[] => {
    // ACP runtime replatform P3/P4: all conversation runtimes speak the same
    // session/update vocabulary. This branch is protocol-shaped, not
    // vendor-specific.
    if (!isAcpRuntimeAdapter(runtimeKey) || event.method !== "session/update") return [];

    const update = recordValue(recordValue(event.params).update);
    const updateType = stringValue(update.sessionUpdate);
    const suppliedCallId = stringValue(update.toolCallId ?? update.tool_call_id);
    const toolName = redactToolName(stringValue(update.title ?? update.name));
    if (updateType?.toLowerCase().includes("compact")) {
      return [runtimeEvent("provider_compacted", occurredAt, null, "Provider compacted its session context.", {
        runtime_key: runtimeKey,
      })];
    }
    if (updateType === "tool_call") {
      const status = stringValue(update.status);
      const lifecycle = toolCalls.started({
        callId: suppliedCallId,
        name: toolName,
        status,
      });
      return [
        toolStartedEvent(runtimeKey, occurredAt, lifecycle.callId, toolName),
        ...((status === "completed" || status === "failed")
          ? [toolTerminalEvent(runtimeKey, occurredAt, lifecycle.callId, toolName, status)]
          : []),
      ];
    }
    if (updateType === "tool_call_update") {
      const status = stringValue(update.status);
      const lifecycle = toolCalls.updated({ callId: suppliedCallId, name: toolName, status });
      const inferredStart = lifecycle.missingStart
        ? [toolStartedEvent(runtimeKey, occurredAt, lifecycle.callId, toolName)]
        : [];
      if (status !== "completed" && status !== "failed") return inferredStart;
      return [
        ...inferredStart,
        toolTerminalEvent(runtimeKey, occurredAt, lifecycle.callId, toolName, status),
      ];
    }
    return [];
  };

  return { push };
}

function toolStartedEvent(
  runtimeKey: string,
  occurredAt: string,
  callId: string,
  toolName: string | null,
): RuntimeSemanticEvent {
  return runtimeEvent("tool_call_started", occurredAt, callId, "Tool call started.", {
    runtime_key: runtimeKey,
    tool_name: toolName,
  });
}

function toolTerminalEvent(
  runtimeKey: string,
  occurredAt: string,
  callId: string,
  toolName: string | null,
  status: "completed" | "failed",
): RuntimeSemanticEvent {
  return runtimeEvent(
    status === "failed" ? "tool_call_failed" : "tool_call_completed",
    occurredAt,
    callId,
    status === "failed" ? "Tool call failed." : "Tool call completed.",
    { runtime_key: runtimeKey, tool_name: toolName },
  );
}

export function terminalRuntimeEvents(input: {
  runtimeKey: string;
  success: boolean;
  completedAt: string;
  errorCode?: string | null;
}): RuntimeSemanticEvent[] {
  return [
    runtimeEvent(
      input.success ? "assistant_message_completed" : "error",
      input.completedAt,
      null,
      input.success ? "Assistant message completed." : "Runtime adapter failed.",
      {
        runtime_key: input.runtimeKey,
        error_code: input.errorCode ?? null,
      },
    ),
    runtimeEvent("state_transition", input.completedAt, null, "Runtime adapter reached a terminal state.", {
      runtime_key: input.runtimeKey,
      state: input.success ? "succeeded" : "failed",
    }),
  ];
}

function runtimeEvent(
  type: RuntimeSemanticEvent["type"],
  occurredAt: string,
  callId: string | null,
  summary: string,
  metadata: Record<string, unknown>,
): RuntimeSemanticEvent {
  return {
    schema_version: "runtime_event.v1",
    type,
    occurred_at: occurredAt,
    call_id: callId,
    summary,
    metadata_json: metadata as RuntimeSemanticEvent["metadata_json"],
  };
}

const MAX_TOOL_NAME_CHARS = 200;

/**
 * Vendor `command_execution`/`local_shell_call` events fall back to the raw
 * shell command string for tool_name (no vendor exposes a short handle for
 * these). That raw text can contain embedded secrets or full command bodies,
 * and this metadata is persisted into a durable, replayable Run Event —
 * apply the same secret-pattern redaction used for error text plus a name-
 * sized length bound, not the much larger evidence-body bound.
 */
function redactToolName(value: string | null): string | null {
  const redacted = redactEvidenceText(value);
  if (redacted === null) return null;
  return redacted.length > MAX_TOOL_NAME_CHARS
    ? `${redacted.slice(0, MAX_TOOL_NAME_CHARS)}...[truncated]`
    : redacted;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
