/**
 * Metadata sanitizer for the durable policy audit record — server port of
 * `app/policy/sanitizer.py`.
 *
 * Redacts known dangerous keys (case-insensitive substring match, recursive),
 * truncates strings, and bounds depth / total key count before any policy
 * decision metadata is persisted. Never throws — on internal failure it returns
 * a safe error marker.
 */

const DANGEROUS_KEYS: readonly string[] = [
  "password",
  "token",
  "api_key",
  // Substring-matched, so this one entry covers `x-goog-api-key` and any other
  // hyphenated spelling a vendor header uses. Deliberately *not* the bare
  // `authorization`: this list is substring-matched, and inside the policy
  // module — which is about authorization — it would redact
  // `authorization_request_id` and every other field that links an audit row
  // to its decision.
  "api-key",
  "cookie",
  "secret",
  "credential",
  "personal_context_block",
  "raw_memory",
  "memory_content",
  "prompt",
  "rendered_context",
  "stdout",
  "stderr",
  "patch",
  "diff",
  "file_content",
];

const MAX_DEPTH = 4;
const MAX_KEYS = 32; // max list items processed per array
const MAX_STR_LEN = 512;
const MAX_TOTAL_KEYS = 128;
const REDACTED = "[REDACTED]";

function isDangerousKey(key: string): boolean {
  const lower = key.toLowerCase();
  return DANGEROUS_KEYS.some((dk) => lower.includes(dk));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function sanitizeValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (budget.remaining <= 0) return REDACTED;

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      if (isDangerousKey(String(k))) {
        out[String(k)] = REDACTED;
      } else {
        out[String(k)] = sanitizeValue(v, depth + 1, budget);
      }
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_KEYS)
      .map((item) => sanitizeValue(item, depth + 1, budget));
  }

  if (typeof value === "string") {
    return value.length > MAX_STR_LEN ? value.slice(0, MAX_STR_LEN) : value;
  }

  return value;
}

export function sanitizePolicyMetadata(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  try {
    const budget = { remaining: MAX_TOTAL_KEYS };
    return sanitizeValue(data, 0, budget) as Record<string, unknown>;
  } catch {
    return { _sanitizer_error: true };
  }
}
