import { redactEvidenceText } from "../runs/evidenceRedaction.js";

/** Informational only: no login mutation, tool grant, retry or termination. */
export function createAcpRuntimeStatusProjector() {
  const previous = new Map<string, string>();
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  return (event: Record<string, unknown>): Array<{ status: string; text?: string }> => {
    const params = object(event.params), update = object(params.update);
    let key: string | null = null, status: string | null = null, text: string | undefined;
    if (event.method === "_auth/status_update") {
      const kind = object(params.authStatus).kind;
      if (["account", "api_key", "gateway", "external", "none"].includes(String(kind))) {
        key = "auth"; status = kind === "none" ? "runtime_auth_none" : "runtime_auth_available";
      }
    } else if (event.method === "session/update" && update.sessionUpdate === "compaction_update") {
      const code: Record<string, string> = { in_progress: "runtime_compacting", completed: "runtime_compacted", failed: "runtime_compaction_failed", cancelled: "runtime_compaction_cancelled" };
      status = code[String(update.status)] ?? null;
      key = `compaction:${typeof update.compactionId === "string" ? update.compactionId.slice(0, 128) : "session"}`;
    } else if (event.method === "session/update" && update.sessionUpdate === "subagent_update" && typeof update.sessionId === "string") {
      const state = object(update.state), code = state.state;
      if (["running", "requires_action", "idle"].includes(String(code))) {
        key = `child:${update.sessionId.slice(0, 256)}`;
        const activeBackground = Array.isArray(state.background) && state.background.length > 0;
        status = code === "requires_action" ? "runtime_subagent_waiting" : code === "idle" && !activeBackground ? "runtime_subagent_done" : "runtime_subagent_running";
        text = (redactEvidenceText(typeof update.title === "string" ? update.title : "") ?? "").slice(0, 160);
      }
    } else if (event.method === "session/update" && update.sessionUpdate === "session_info_update") {
      const retry = object(object(update._meta)["opencode/retry"]);
      if (typeof retry.nextRetryAt === "string" && Number.isFinite(Date.parse(retry.nextRetryAt))) {
        key = "retry"; status = "runtime_retry_waiting"; text = new Date(retry.nextRetryAt).toISOString();
      } else if (object(update._meta)["opencode/retry"] === null && previous.has("retry")) {
        key = "retry"; status = "runtime_retry_finished";
      }
    }
    if (!key || !status) return [];
    const fingerprint = `${status}:${text ?? ""}`;
    if (previous.get(key) === fingerprint) return [];
    if (previous.size >= 256 && !previous.has(key)) previous.delete(previous.keys().next().value!);
    previous.set(key, fingerprint);
    return [{ status, ...(text ? { text } : {}) }];
  };
}
