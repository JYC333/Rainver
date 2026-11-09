import type {
  CanonicalModelUsage,
  CanonicalUsage,
} from "@rainver/protocol";

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

/** The wrappers' turn-scoped quota extension, already differenced by the wrapper.
 * Claude rows can include child models, so they need not sum to main-loop usage.
 */
export function modelUsageFromAcpQuota(meta: unknown, runtimeKey: string): CanonicalModelUsage[] {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const rows = object(object(meta).quota).model_usage;
  if (!Array.isArray(rows) || rows.length > 64) return [];
  const result: CanonicalModelUsage[] = [];
  for (const row of rows) {
    const item = object(row), count = object(item.token_count);
    if (typeof item.model !== "string" || item.model === "default" || !/^[\w./:[\]-]{1,256}$/.test(item.model)) return [];
    const usage = usageFromAcp({
      inputTokens: count.inputTokens, outputTokens: count.outputTokens, totalTokens: count.totalTokens,
      cachedReadTokens: count.cachedInputTokens,
      cachedWriteTokens: runtimeKey === "codex_cli" ? count.cacheWriteInputTokens : count.cachedWriteTokens,
      thoughtTokens: count.reasoningOutputTokens,
    }); // Both wrappers have already removed cached input from inputTokens.
    if (!usage) return [];
    const existing = result.find(value => value.model === item.model);
    if (existing) return []; // Ambiguous duplicate identities are not independently billable rows.
    result.push({ model: item.model, usage });
  }
  return result;
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
  const buckets = (
    usage.input_tokens ?? 0
  ) + (
    usage.output_tokens ?? 0
  ) + (
    usage.cache_creation_input_tokens ?? 0
  ) + (
    usage.cache_read_input_tokens ?? 0
  );
  // Two self-consistent conventions exist for where reasoning tokens are
  // counted, and ACP does not say which a runtime uses. Claude and OpenCode
  // report them as a bucket of their own; an OpenAI-shaped runtime (Codex)
  // reports a total that already includes them inside `output`, so adding the
  // bucket again overcounts by exactly that many. A real Codex turn:
  // input 24620 (112428 raw − 87808 cached), cached 87808, output 1312,
  // reasoning 946, total 113740 — buckets sum to 113740. Do not expect
  // 114686. That would fail every Codex run that produces reasoning tokens.
  const reasoning = usage.reasoning_tokens ?? 0;
  return usage.total_tokens === buckets + reasoning || usage.total_tokens === buckets
    ? usage
    : null;
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
