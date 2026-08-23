import type {
  CanonicalModelUsage,
  CanonicalUsage,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface CliRuntimeMeasurement {
  external_session_id: string | null;
  usage: CanonicalUsage | null;
  model_usage: CanonicalModelUsage[];
  subscription_quota: {
    status: string;
    rate_limit_type: string;
    utilization: number;
    resets_at: number;
    is_using_overage: boolean;
  } | null;
}

export function usageFromAcp(value: Record<string, unknown>): CanonicalUsage | null {
  const usage = strictUsage({
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    total_tokens: value.totalTokens,
    cache_creation_input_tokens: value.cachedWriteTokens,
    cache_read_input_tokens: value.cachedReadTokens,
    reasoning_tokens: value.thoughtTokens,
  }, ["input_tokens", "output_tokens", "total_tokens"]);
  if (!usage) return null;
  const expectedTotal = (
    usage.input_tokens ?? 0
  ) + (
    usage.output_tokens ?? 0
  ) + (
    usage.cache_creation_input_tokens ?? 0
  ) + (
    usage.cache_read_input_tokens ?? 0
  ) + (
    usage.reasoning_tokens ?? 0
  );
  return usage.total_tokens === expectedTotal ? usage : null;
}

function strictUsage(
  values: Record<string, unknown>,
  required: string[],
): CanonicalUsage | null {
  if (Object.values(values).some(
    (value) => value !== undefined && nonNegativeInteger(value) === null,
  )) {
    return null;
  }
  const usage = canonicalUsage(values);
  if (!usage) return null;
  return required.every((key) => key in usage) ? usage : null;
}

function canonicalUsage(values: Record<string, unknown>): CanonicalUsage | null {
  const usage: CanonicalUsage = {};
  for (const [key, value] of Object.entries(values)) {
    const parsed = nonNegativeInteger(value);
    if (parsed !== null) {
      (usage as Record<string, number>)[key] = parsed;
    }
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
