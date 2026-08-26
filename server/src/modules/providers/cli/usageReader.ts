/**
 * CLI token-usage reader.
 *
 * Claude Code writes a JSONL transcript per session under the managed profile
 * dir (`<profile>/projects/<slug>/<uuid>.jsonl`, and/or `<profile>/sessions/`).
 * Because rainver symlinks each run's HOME/.claude to the credential
 * profile, those transcripts accumulate across runs in one place. Each assistant
 * line carries a `message.usage` payload — we sum it to report cumulative token
 * usage (and an estimated cost) without any network call.
 *
 * This is offline and read-only; it never touches OAuth/API credentials, so it
 * stays inside the CLI channel per ADR 0008. Note: Claude Code's JSONL logs are
 * known to undercount (thinking tokens are excluded), so totals are a floor, not
 * an exact bill.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export interface TokenUsage {
  available: boolean;
  source: "transcripts" | "codex_sessions" | "unsupported";
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  message_count: number;
  session_count: number;
}

export interface CliUsageImportEvent {
  runtime: "claude_code" | "codex_cli";
  occurred_at: string;
  model: string | null;
  external_session_id: string;
  session_path: string;
  session_name: string | null;
  usage_details: Record<string, number>;
  provider_usage: Record<string, unknown>;
  idempotency_key: string;
  dedupe_confidence: "high" | "medium" | "low";
  dimensions: Record<string, string | number | boolean>;
  metadata: Record<string, string | number | boolean>;
}

export interface CliUsageImportScan {
  runtime: "claude_code" | "codex_cli";
  source: "transcripts" | "codex_sessions";
  events: CliUsageImportEvent[];
  session_count: number;
  candidate_event_count: number;
  duplicate_count: number;
  unreadable_file_count: number;
  unsupported_file_count: number;
  date_range: { from: string; to: string } | null;
}

// Claude model list price, USD per 1M tokens: input / output / cache-write / cache-read.
// Cost is an estimate; unknown models contribute tokens but $0.
const CLAUDE_PRICING: ReadonlyArray<{
  match: RegExp;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}> = [
  { match: /opus/i, input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { match: /sonnet/i, input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { match: /haiku/i, input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
];

const PER_MILLION = 1_000_000;

export function unsupportedTokenUsage(): TokenUsage {
  return {
    available: false,
    source: "unsupported",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    message_count: 0,
    session_count: 0,
  };
}

function emptyTranscriptUsage(): TokenUsage {
  return { ...unsupportedTokenUsage(), source: "transcripts" };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageImportHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function usagePayloadHash(value: Record<string, unknown>): string {
  return usageImportHash(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function priceFor(model: string | undefined) {
  if (!model) return null;
  return CLAUDE_PRICING.find((p) => p.match.test(model)) ?? null;
}

/** Recursively collect `*.jsonl` files under `root` (bounded depth, cheap). */
async function collectJsonl(root: string, depth = 6): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) files.push(...(await collectJsonl(full, depth - 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Sum token usage from a single transcript line. Tolerant of layout drift: the
 * usage object may sit at `message.usage` (current) or top-level `usage`.
 * Returns the line's dedupe key so callers can skip messages replayed across
 * resumed sessions, plus the parsed usage and model.
 */
function parseLine(line: string): {
  key: string | null;
  model: string | undefined;
  usage: Record<string, unknown>;
  occurredAt: string | null;
} | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = (obj.message ?? {}) as Record<string, unknown>;
  const usage = (message.usage ?? obj.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const hasTokens =
    "input_tokens" in usage ||
    "output_tokens" in usage ||
    "cache_creation_input_tokens" in usage ||
    "cache_read_input_tokens" in usage;
  if (!hasTokens) return null;

  const messageId = typeof message.id === "string" ? message.id : null;
  const requestId = typeof obj.requestId === "string" ? obj.requestId : null;
  const key = messageId || requestId ? `${messageId ?? ""}:${requestId ?? ""}` : null;
  const model = typeof message.model === "string"
    ? message.model
    : typeof obj.model === "string"
      ? obj.model
      : undefined;
  const occurredAt = timestampValue(obj.timestamp ?? obj.created_at ?? message.created_at);
  return { key, model, usage, occurredAt };
}

/**
 * Read cumulative Claude token usage from the transcripts under a profile dir.
 * Returns an "unavailable" result (not an error) when nothing is found, so the
 * caller can render "no recorded usage yet" rather than failing.
 */
export async function readClaudeTokenUsage(profileDir: string): Promise<TokenUsage> {
  const roots = [join(profileDir, "projects"), join(profileDir, "sessions")];
  const files: string[] = [];
  for (const root of roots) files.push(...(await collectJsonl(root)));
  if (files.length === 0) return emptyTranscriptUsage();

  const total = emptyTranscriptUsage();
  const seen = new Set<string>();
  let contributingFiles = 0;

  for (const file of files) {
    let raw: string;
    try {
      // Skip implausibly huge files defensively; transcripts are normally small.
      const info = await stat(file);
      if (info.size > 64 * 1024 * 1024) continue;
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let contributed = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (parsed.key) {
        if (seen.has(parsed.key)) continue;
        seen.add(parsed.key);
      }
      const u = parsed.usage;
      const input = num(u.input_tokens);
      const output = num(u.output_tokens);
      const cacheWrite = num(u.cache_creation_input_tokens);
      const cacheRead = num(u.cache_read_input_tokens);
      total.input_tokens += input;
      total.output_tokens += output;
      total.cache_creation_input_tokens += cacheWrite;
      total.cache_read_input_tokens += cacheRead;
      total.message_count += 1;
      contributed = true;

      const price = priceFor(parsed.model);
      if (price) {
        total.cost_usd +=
          (input * price.input +
            output * price.output +
            cacheWrite * price.cacheWrite +
            cacheRead * price.cacheRead) /
          PER_MILLION;
      }
    }
    if (contributed) contributingFiles += 1;
  }

  total.session_count = contributingFiles;
  total.available = total.message_count > 0;
  total.cost_usd = Math.round(total.cost_usd * 1e6) / 1e6;
  return total;
}

export async function readClaudeUsageImportEvents(
  profileDir: string,
  sourceFingerprint: string,
): Promise<CliUsageImportScan> {
  const roots = [join(profileDir, "projects"), join(profileDir, "sessions")];
  const files: string[] = [];
  for (const root of roots) files.push(...(await collectJsonl(root)));

  const events: CliUsageImportEvent[] = [];
  const seen = new Set<string>();
  const sessions = new Set<string>();
  let duplicateCount = 0;
  let unreadableFileCount = 0;
  let unsupportedFileCount = 0;

  for (const file of files) {
    let raw: string;
    let fallbackOccurredAt = new Date().toISOString();
    try {
      const info = await stat(file);
      if (info.size > 64 * 1024 * 1024) {
        unsupportedFileCount += 1;
        continue;
      }
      fallbackOccurredAt = info.mtime.toISOString();
      raw = await readFile(file, "utf8");
    } catch {
      unreadableFileCount += 1;
      continue;
    }
    const sessionPath = relativeSessionPath(profileDir, file);
    const externalSessionId = `claude_code:${usageImportHash(`${sourceFingerprint}:${sessionPath}`).slice(0, 32)}`;
    let contributed = false;
    let lineNumber = 0;
    for (const line of raw.split("\n")) {
      lineNumber += 1;
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;
      const usageHash = usagePayloadHash(parsed.usage);
      const eventMarker = parsed.key ?? `${sessionPath}:${lineNumber}`;
      const seenKey = `${eventMarker}:${usageHash}`;
      if (seen.has(seenKey)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(seenKey);
      events.push({
        runtime: "claude_code",
        occurred_at: parsed.occurredAt ?? fallbackOccurredAt,
        model: parsed.model ?? null,
        external_session_id: externalSessionId,
        session_path: sessionPath,
        session_name: sessionName(sessionPath),
        usage_details: claudeUsageDetails(parsed.usage),
        provider_usage: parsed.usage,
        idempotency_key: `usage:cli:claude_code:${usageImportHash(`${sourceFingerprint}:${eventMarker}:${usageHash}`)}`,
        dedupe_confidence: parsed.key ? "high" : "medium",
        dimensions: { runtime: "claude_code", cli_history_source: "transcripts" },
        metadata: { source_line: lineNumber },
      });
      contributed = true;
    }
    if (contributed) sessions.add(sessionPath);
  }

  return {
    runtime: "claude_code",
    source: "transcripts",
    events,
    session_count: sessions.size,
    candidate_event_count: events.length,
    duplicate_count: duplicateCount,
    unreadable_file_count: unreadableFileCount,
    unsupported_file_count: unsupportedFileCount,
    date_range: dateRange(events),
  };
}

function claudeUsageDetails(usage: Record<string, unknown>): Record<string, number> {
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    input_cache_creation: num(usage.cache_creation_input_tokens),
    input_cache_read: num(usage.cache_read_input_tokens),
  };
}

export function relativeSessionPath(root: string, file: string): string {
  return relative(root, file).split(/[\\/]/).filter(Boolean).join("/");
}

export function sessionName(sessionPath: string): string | null {
  const name = basename(sessionPath).replace(/\.jsonl$/i, "");
  return name || null;
}

export function timestampValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function dateRange(events: Array<{ occurred_at: string }>): { from: string; to: string } | null {
  if (events.length === 0) return null;
  const values = events
    .map((event) => new Date(event.occurred_at).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  return {
    from: new Date(values[0]).toISOString(),
    to: new Date(values[values.length - 1]).toISOString(),
  };
}
