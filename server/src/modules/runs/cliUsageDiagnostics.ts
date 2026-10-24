import type { InvocationDelivery, RunAdapterResultEnvelope } from "@rainver/protocol";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/index.js";

/**
 * What the event's token buckets cover. `run_attempt_aggregate` is the whole
 * attempt; `last_model_request` is the attempt's last model request alone,
 * for a runtime whose ACP prompt result reports no more than that
 * (`RuntimeAdapterSpec.usage.acp_prompt_usage`). The buckets are then a lower
 * bound; `usage_updates_used_total` carries the turn's context volume.
 */
export type CliUsageScope = "run_attempt_aggregate" | "last_model_request";

export function cliUsageScope(runtimeKey: string | null | undefined): CliUsageScope {
  return getRuntimeAdapterSpec(runtimeKey)?.usage.acp_prompt_usage === "last_request"
    ? "last_model_request"
    : "run_attempt_aggregate";
}

/** Numbers and bounded classifications only; never copy prompt or transcript bodies. */
export function withCliUsageDiagnostics(
  result: RunAdapterResultEnvelope,
  delivery: InvocationDelivery | null,
): RunAdapterResultEnvelope {
  if (result.adapter_kind !== "local_cli") return result;
  const metadata = object(result.metadata_json);
  const observed = object(metadata.cli_usage);
  const numeric: Record<string, number | null> = {};
  for (const key of ["acp_turns", "occupancy_used", "occupancy_size", "usage_updates", "usage_updates_used_total"]) {
    const value = observed[key];
    numeric[key] = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const allocations = delivery?.context_estimate;
  return {
    ...result,
    metadata_json: {
      ...metadata,
      cli_usage: {
        ...numeric,
        usage_scope: cliUsageScope(result.runtime_key),
        estimated_total: delivery?.expected_prompt_tokens ?? null,
        ...(allocations ? Object.fromEntries(Object.entries(allocations).map(([key, value]) => [`estimate_${key}`, value])) : {}),
        ...(typeof observed.resumed_session === "boolean" ? { resumed_session: observed.resumed_session } : {}),
      },
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
