import { RuntimeSessionConfigDroppedSelectionSchema, type RunModelSelection } from "@rainver/protocol";

export function runModelSelection(value: unknown, status: string): RunModelSelection {
  const override = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const selections = Array.isArray(override.acp_session_config) ? override.acp_session_config : [];
  const selection = selections.find(item => item && typeof item === "object" && item.category === "model");
  const requested = typeof selection?.value === "string" ? selection.value
    : typeof override.model === "string" ? override.model : null;
  const reported = status !== "queued" && typeof override.runtime_reported_model === "string" && override.runtime_reported_model !== "default"
    ? override.runtime_reported_model : null;
  // Saved or inherited options the server left at the runtime's default
  // (`sessions/sessionConfig.ts`). A malformed entry is not shown.
  const dropped = (Array.isArray(override.acp_session_config_dropped) ? override.acp_session_config_dropped : [])
    .flatMap((entry) => {
      const parsed = RuntimeSessionConfigDroppedSelectionSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 32);
  return {
    requested,
    reported,
    ...(dropped.length ? { dropped } : {}),
    status: status === "queued" ? "pending" : reported ? "reported" : ["queued", "running", "waiting_for_dependency", "waiting_for_review"].includes(status)
      && !Object.hasOwn(override, "runtime_reported_model") ? "pending" : "unknown",
  };
}
