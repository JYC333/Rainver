import type {
  CanonicalModelUsage,
  CanonicalUsage,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { VendorCliAdapterType } from "./vendorCliAdapter";

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

export function parseCliRuntimeMeasurement(
  adapterType: VendorCliAdapterType,
  stdout: string,
): CliRuntimeMeasurement {
  const events = stdout
    .split(/\r?\n/)
    .map(parseJsonRecord)
    .filter((event): event is Record<string, unknown> => event !== null);
  if (adapterType === "claude_code") return parseClaude(events);
  if (adapterType === "codex_cli") return parseCodex(events);
  return parseOpenCode(events);
}

function parseClaude(events: Record<string, unknown>[]): CliRuntimeMeasurement {
  const terminal = [...events].reverse().find((event) => event.type === "result");
  const quotaEvent = [...events].reverse().find((event) => event.type === "rate_limit_event");
  const quota = record(quotaEvent?.rate_limit_info);
  const modelUsageEntries = Object.entries(record(terminal?.modelUsage));
  const parsedModelUsage = modelUsageEntries.map(([model, rawUsage]) => {
    const value = recordOrNull(rawUsage);
    const usage = model && value
      ? strictUsage({
          input_tokens: value.inputTokens,
          output_tokens: value.outputTokens,
          cache_creation_input_tokens: value.cacheCreationInputTokens,
          cache_read_input_tokens: value.cacheReadInputTokens,
        }, ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])
      : null;
    return usage ? { model, usage } : null;
  });
  const modelUsageIsValid = parsedModelUsage.every(
    (item): item is CanonicalModelUsage => item !== null,
  );
  const modelUsage = modelUsageIsValid ? parsedModelUsage : [];
  return {
    external_session_id: stringValue(terminal?.session_id)
      ?? events.map((event) => stringValue(event.session_id)).find(Boolean)
      ?? null,
    usage: modelUsageEntries.length > 0
      ? modelUsageIsValid
        ? sumUsage(modelUsage.map((item) => item.usage))
        : null
      : usageFromClaude(record(terminal?.usage)),
    model_usage: modelUsage,
    subscription_quota:
      stringValue(quota.status)
      && stringValue(quota.rateLimitType)
      && ratio(quota.utilization) !== null
      && epochSeconds(quota.resetsAt) !== null
      && typeof quota.isUsingOverage === "boolean"
        ? {
            status: stringValue(quota.status)!,
            rate_limit_type: stringValue(quota.rateLimitType)!,
            utilization: ratio(quota.utilization)!,
            resets_at: epochSeconds(quota.resetsAt)!,
            is_using_overage: quota.isUsingOverage,
          }
        : null,
  };
}

function parseCodex(events: Record<string, unknown>[]): CliRuntimeMeasurement {
  const started = events.find((event) => event.type === "thread.started");
  const completed = [...events].reverse().find((event) => event.type === "turn.completed");
  return {
    external_session_id: stringValue(started?.thread_id),
    usage: usageFromCodexSnakeCase(record(completed?.usage)),
    model_usage: [],
    subscription_quota: null,
  };
}

function parseOpenCode(events: Record<string, unknown>[]): CliRuntimeMeasurement {
  const completed = [...events].reverse().find((event) => event.type === "step_finish");
  const tokens = record(record(completed?.part).tokens);
  const cache = record(tokens.cache);
  return {
    external_session_id: stringValue(completed?.sessionID)
      ?? events.map((event) => stringValue(event.sessionID)).find(Boolean)
      ?? null,
    usage: strictUsage({
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      total_tokens: tokens.total,
      cache_creation_input_tokens: cache.write,
      cache_read_input_tokens: cache.read,
      reasoning_tokens: tokens.reasoning,
    }, [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "reasoning_tokens",
    ]),
    model_usage: [],
    subscription_quota: null,
  };
}

export function usageFromCodexCamelCase(value: Record<string, unknown>): CanonicalUsage | null {
  const raw = strictUsage({
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    total_tokens: value.totalTokens,
    cache_creation_input_tokens: value.cacheWriteInputTokens,
    cache_read_input_tokens: value.cachedInputTokens,
    reasoning_tokens: value.reasoningOutputTokens,
  }, [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
  ]);
  return raw ? exclusiveCodexUsage(raw as Required<CanonicalUsage>) : null;
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

function usageFromClaude(value: Record<string, unknown>): CanonicalUsage | null {
  return strictUsage({
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    cache_creation_input_tokens: value.cache_creation_input_tokens,
    cache_read_input_tokens: value.cache_read_input_tokens,
  }, [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]);
}

function usageFromCodexSnakeCase(value: Record<string, unknown>): CanonicalUsage | null {
  const raw = strictUsage({
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    total_tokens: value.total_tokens ?? sumIntegers(value.input_tokens, value.output_tokens),
    cache_creation_input_tokens: value.cache_write_input_tokens,
    cache_read_input_tokens: value.cached_input_tokens,
    reasoning_tokens: value.reasoning_output_tokens,
  }, [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
  ]);
  return raw ? exclusiveCodexUsage(raw as Required<CanonicalUsage>) : null;
}

function exclusiveCodexUsage(usage: Required<CanonicalUsage>): CanonicalUsage | null {
  const uncachedInput = usage.input_tokens
    - usage.cache_read_input_tokens
    - usage.cache_creation_input_tokens;
  const visibleOutput = usage.output_tokens - usage.reasoning_tokens;
  if (uncachedInput < 0 || visibleOutput < 0) return null;
  return {
    input_tokens: uncachedInput,
    output_tokens: visibleOutput,
    total_tokens: usage.total_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    reasoning_tokens: usage.reasoning_tokens,
  };
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

function sumUsage(items: CanonicalUsage[]): CanonicalUsage {
  const total: CanonicalUsage = {};
  for (const usage of items) {
    for (const [key, value] of Object.entries(usage)) {
      (total as Record<string, number>)[key] =
        ((total as Record<string, number>)[key] ?? 0) + value;
    }
  }
  total.total_tokens = (
    total.input_tokens ?? 0
  ) + (
    total.output_tokens ?? 0
  ) + (
    total.cache_creation_input_tokens ?? 0
  ) + (
    total.cache_read_input_tokens ?? 0
  ) + (
    total.reasoning_tokens ?? 0
  );
  return total;
}

function sumIntegers(left: unknown, right: unknown): number | null {
  const a = nonNegativeInteger(left);
  const b = nonNegativeInteger(right);
  return a === null || b === null ? null : a + b;
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

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return recordOrNull(JSON.parse(line));
  } catch {
    return null;
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ratio(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function epochSeconds(value: unknown): number | null {
  const parsed = nonNegativeInteger(value);
  if (parsed === null) return null;
  return Number.isNaN(new Date(parsed * 1000).getTime()) ? null : parsed;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
