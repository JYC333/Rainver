import type {
  CanonicalModelEvent,
  RuntimeSemanticEvent,
} from "@rainver/protocol";
import { redactEvidenceText } from "./evidenceRedaction.js";

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
  adapterType: string,
  events: Record<string, unknown>[],
  completedAt: string,
): RuntimeSemanticEvent[] {
  return events.flatMap((event) => {
    const native = normalizeNativeProtocolEvent(adapterType, event, completedAt);
    return native ? [native] : [];
  });
}

function normalizeNativeProtocolEvent(
  adapterType: string,
  event: Record<string, unknown>,
  occurredAt: string,
): RuntimeSemanticEvent | null {
  // ACP runtime replatform P3/P4: all conversation runtimes speak the same
  // session/update vocabulary. This branch is protocol-shaped, not
  // vendor-specific.
  if (
    (adapterType === "claude_code" || adapterType === "opencode" || adapterType === "codex_cli")
    && event.method === "session/update"
  ) {
    const update = recordValue(recordValue(event.params).update);
    const updateType = stringValue(update.sessionUpdate);
    const callId = stringValue(update.toolCallId ?? update.tool_call_id);
    if (updateType?.toLowerCase().includes("compact")) {
      return runtimeEvent("provider_compacted", occurredAt, null, "Provider compacted its session context.", {
        adapter_type: adapterType,
      });
    }
    if (updateType === "tool_call") {
      return runtimeEvent(
        "tool_call_started",
        occurredAt,
        callId,
        "Tool call started.",
        {
          adapter_type: adapterType,
          tool_name: redactToolName(stringValue(update.title ?? update.name)),
        },
      );
    }
    if (updateType === "tool_call_update") {
      const status = stringValue(update.status);
      if (status !== "completed" && status !== "failed") return null;
      return runtimeEvent(
        status === "failed" ? "tool_call_failed" : "tool_call_completed",
        occurredAt,
        callId,
        status === "failed" ? "Tool call failed." : "Tool call completed.",
        {
          adapter_type: adapterType,
          tool_name: redactToolName(stringValue(update.title ?? update.name)),
        },
      );
    }
  }
  return null;
}

export function terminalRuntimeEvents(input: {
  adapterType: string;
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
        adapter_type: input.adapterType,
        error_code: input.errorCode ?? null,
      },
    ),
    runtimeEvent("state_transition", input.completedAt, null, "Runtime adapter reached a terminal state.", {
      adapter_type: input.adapterType,
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
