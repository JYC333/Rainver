import type { InvocationDelivery, RunAdapterResultEnvelope } from "@rainver/protocol";

/** Numbers and bounded classifications only; never copy prompt or transcript bodies. */
export function withCliUsageDiagnostics(
  result: RunAdapterResultEnvelope,
  delivery: InvocationDelivery | null,
): RunAdapterResultEnvelope {
  if (result.adapter_kind !== "local_cli") return result;
  const metadata = object(result.metadata_json);
  const observed = object(metadata.cli_usage);
  const numeric: Record<string, number | null> = {};
  for (const key of ["acp_turns", "occupancy_used", "occupancy_size"]) {
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
        usage_scope: "run_attempt_aggregate",
        estimated_total: delivery?.expected_prompt_tokens ?? null,
        ...(allocations ? Object.fromEntries(Object.entries(allocations).map(([key, value]) => [`estimate_${key}`, value])) : {}),
        delivery_mode: delivery?.mode ?? null,
        rotation_reason: delivery?.mode === "full" ? delivery.cli_session?.rotation_reason ?? null : null,
      },
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
