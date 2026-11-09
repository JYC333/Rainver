import type {
  RuntimeSemanticEvent,
} from "@rainver/protocol";
import { isAcpRuntimeAdapter } from "../runtimeAdapters/specs.js";
import { createAcpToolCallLifecycle } from "../runtimeAdapters/acpToolCallLifecycle.js";
import { normalizeToolName } from "../runtimeAdapters/toolName.js";

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
  const startedCalls = new Set<string>();
  const terminalStates = new Map<string, string>();
  const compacted = new Set<string>();

  function startEvents(at: string, callId: string, toolName: string | null): RuntimeSemanticEvent[] {
    if (startedCalls.has(callId) || terminalStates.has(callId)) return [];
    startedCalls.add(callId);
    return [toolStartedEvent(runtimeKey, at, callId, toolName)];
  }

  function terminalEvents(at: string, callId: string, toolName: string | null, status: "completed" | "failed"): RuntimeSemanticEvent[] {
    if (terminalStates.get(callId) === status) return [];
    terminalStates.set(callId, status);
    return [toolTerminalEvent(runtimeKey, at, callId, toolName, status)];
  }

  const push = (event: Record<string, unknown>, occurredAt: string): RuntimeSemanticEvent[] => {
    // All conversation runtimes speak the same
    // session/update vocabulary. This branch is protocol-shaped, not
    // vendor-specific.
    if (!isAcpRuntimeAdapter(runtimeKey) || event.method !== "session/update") return [];

    const update = recordValue(recordValue(event.params).update);
    const updateType = stringValue(update.sessionUpdate);
    const suppliedCallId = stringValue(update.toolCallId ?? update.tool_call_id);
    const toolName = normalizeToolName(stringValue(update.title ?? update.name));
    if (updateType === "compaction_update" && update.status === "completed") {
      const params = recordValue(event.params);
      if (params._rainverChildSession === true) return [];
      const compactionId = stringValue(update.compactionId);
      const key = `${stringValue(params.sessionId) ?? ""}:${compactionId ?? ""}`;
      if (compactionId && compacted.has(key)) return [];
      if (compactionId && compacted.size < 256) compacted.add(key);
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
        ...startEvents(occurredAt, lifecycle.callId, toolName),
        ...((status === "completed" || status === "failed")
          ? terminalEvents(occurredAt, lifecycle.callId, toolName, status)
          : []),
      ];
    }
    if (updateType === "tool_call_update") {
      const status = stringValue(update.status);
      const lifecycle = toolCalls.updated({ callId: suppliedCallId, name: toolName, status });
      const inferredStart = lifecycle.missingStart
        ? startEvents(occurredAt, lifecycle.callId, toolName)
        : [];
      if (status !== "completed" && status !== "failed") return inferredStart;
      return [...inferredStart, ...terminalEvents(occurredAt, lifecycle.callId, toolName, status)];
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

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
