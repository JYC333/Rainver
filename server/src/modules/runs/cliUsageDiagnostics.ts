import type { InvocationDelivery, RunAdapterResultEnvelope } from "@rainver/protocol";

/**
 * What the event's token buckets cover. `run_attempt_aggregate` is the whole
 * attempt under the current wrapper contract. Unverified identity is unknown;
 * occupancy samples are diagnostic and never supply missing spend.
 */
export type CliUsageScope = "run_attempt_aggregate" | "unknown";

export function cliUsageScope(runtimeKey: string | null | undefined, adapterVersion?: string | null): CliUsageScope {
  if (runtimeKey === "codex_cli") {
    const version = adapterVersion?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:$|\+)/);
    if (!version) return "unknown";
    const major = Number(version[1]), minor = Number(version[2]);
    if (major === 2 && minor >= 5) return "run_attempt_aggregate";
    return "unknown";
  }
  return "run_attempt_aggregate";
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
        usage_scope: cliUsageScope(result.runtime_key, typeof object(metadata.acp).version === "string" ? object(metadata.acp).version as string : null),
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
