import type {
  CanonicalModelEvent,
  RuntimeSemanticEvent,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { redactEvidenceText } from "./evidenceRedaction";

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
  const normalized: RuntimeSemanticEvent[] = [];
  for (const event of events) {
    const native = normalizeNativeProtocolEvent(adapterType, event, completedAt);
    if (native) {
      normalized.push(native);
      continue;
    }
    const type = stringValue(event.type)?.toLowerCase() ?? "";
    const item = recordValue(event.item);
    const message = recordValue(event.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolBlock = content
      .map(recordValue)
      .find((block) => block.type === "tool_use" || block.type === "tool_result");
    const semanticType = [
      type,
      stringValue(event.subtype)?.toLowerCase() ?? "",
      stringValue(item.type)?.toLowerCase() ?? "",
      stringValue(toolBlock?.type)?.toLowerCase() ?? "",
    ].filter(Boolean).join(".");
    const callId = stringValue(
      event.call_id ??
      event.tool_call_id ??
      item.id ??
      toolBlock?.id ??
      toolBlock?.tool_use_id ??
      event.id,
    );
    const toolName = redactToolName(stringValue(
      event.name ??
      item.name ??
      item.command ??
      toolBlock?.name ??
      recordValue(event.tool).name,
    ));
    if (semanticType.includes("compact")) {
      normalized.push(runtimeEvent("provider_compacted", completedAt, null, "Provider compacted its session context.", {
        adapter_type: adapterType,
      }));
      continue;
    }
    const started =
      semanticType.includes("tool_use") ||
      (semanticType.includes("command_execution") && type.includes("started")) ||
      (semanticType.includes("tool") && type.includes("start"));
    if (started) {
      normalized.push(runtimeEvent("tool_call_started", completedAt, callId, "Tool call started.", {
        adapter_type: adapterType,
        tool_name: toolName,
      }));
    } else if (
      semanticType.includes("tool") || semanticType.includes("command_execution")
    ) {
      const failed = type.includes("error") ||
        type.includes("fail") ||
        item.status === "failed" ||
        item.status === "error" ||
        toolBlock?.is_error === true;
      normalized.push(runtimeEvent(
        failed ? "tool_call_failed" : "tool_call_completed",
        completedAt,
        callId,
        failed ? "Tool call failed." : "Tool call completed.",
        { adapter_type: adapterType, tool_name: toolName },
      ));
    } else if (type.includes("error")) {
      normalized.push(runtimeEvent("error", completedAt, null, "Runtime reported an error.", {
        adapter_type: adapterType,
        error_code: stringValue(event.code),
      }));
    }
  }
  return normalized;
}

function normalizeNativeProtocolEvent(
  adapterType: string,
  event: Record<string, unknown>,
  occurredAt: string,
): RuntimeSemanticEvent | null {
  if (adapterType === "codex_cli") {
    const method = stringValue(event.method);
    if (method === "thread/compacted") {
      return runtimeEvent("provider_compacted", occurredAt, null, "Provider compacted its session context.", {
        adapter_type: adapterType,
      });
    }
    if (method !== "item/started" && method !== "item/completed") return null;
    const item = recordValue(recordValue(event.params).item);
    const itemType = stringValue(item.type);
    if (method === "item/completed" && itemType?.toLowerCase().includes("compact")) {
      return runtimeEvent("provider_compacted", occurredAt, null, "Provider compacted its session context.", {
        adapter_type: adapterType,
      });
    }
    if (!itemType || !["commandExecution", "fileChange", "mcpToolCall"].includes(itemType)) {
      return null;
    }
    const failed = method === "item/completed" &&
      ["failed", "error", "declined"].includes(stringValue(item.status) ?? "");
    return runtimeEvent(
      method === "item/started"
        ? "tool_call_started"
        : failed
          ? "tool_call_failed"
          : "tool_call_completed",
      occurredAt,
      stringValue(item.id),
      method === "item/started"
        ? "Tool call started."
        : failed
          ? "Tool call failed."
          : "Tool call completed.",
      {
        adapter_type: adapterType,
        tool_name: redactToolName(stringValue(item.name ?? item.command ?? itemType)),
      },
    );
  }
  if (adapterType === "opencode" && event.method === "session/update") {
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
