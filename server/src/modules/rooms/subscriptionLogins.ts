import type { HostUsageQuota, SubscriptionQuotaWindow, SubscriptionUsageLine } from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import { hasSubscriptionQuota } from "../hosts/capabilities.js";
import { refreshHostUsage } from "../hosts/usageService.js";
import type { Queryable } from "../routeUtils/common.js";
import { SUBSCRIPTION_QUOTA_EXHAUSTED } from "../runs/retryPolicy.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

/**
 * Which subscription a Room Run spends, and what is known of its window
 * (`modules/rooms.md`, "Cost lines, by funding source" and "Subscription
 * quota gate").
 *
 * A subscription is a CLI login: one copy of a runtime on one host
 * (`host_runtime_usage`'s key). A Run spends it when it executes on that
 * copy's own login — not bound to a ModelProvider, which is priced instead —
 * and its host thread names the copy.
 */
export interface SubscriptionLogin {
  host_id: string;
  host_name: string;
  runtime_key: string;
  installation: string;
}

export interface QuotaReading {
  window: SubscriptionQuotaWindow | null;
  checked_at: string | null;
}

/** A reading younger than this is used as it is; an older one is probed first. */
export const QUOTA_READING_MAX_AGE_MS = 60_000;
/**
 * How long an admission waits for a probe. A probe can take the host's full
 * timeout (45 s), and an admission runs inside the transaction that commits
 * the turn: past this the cached reading decides, and the probe still lands
 * in the cache for the next one.
 */
const PROBE_DEADLINE_MS = 5_000;

export function loginKey(login: Pick<SubscriptionLogin, "host_id" | "runtime_key" | "installation">): string {
  return `${login.host_id}\u0000${login.runtime_key}\u0000${login.installation}`;
}

/** "Claude Code · Server", with the copy when it is not the machine's own. */
export function accountLabel(login: SubscriptionLogin): string {
  const runtime = getRuntimeAdapterSpec(login.runtime_key)?.display_name ?? login.runtime_key;
  return `${runtime} · ${login.host_name}${login.installation === "own" ? "" : ` (${login.installation})`}`;
}

/**
 * The login a Run spends, or null when it spends none: no host thread, a
 * runtime with no subscription window, or a binding to a ModelProvider.
 */
export async function subscriptionLoginOfRun(db: Queryable, spaceId: string, runId: string): Promise<SubscriptionLogin | null> {
  const row = (await db.query<SubscriptionLogin & { provider_bound: boolean }>(
    `SELECT thread.execution_host_id AS host_id, host.name AS host_name, thread.runtime_key,
            thread.runtime_installation AS installation,
            (NULLIF(run.model_override_json->'conversation_backend'->>'model_provider_id', '') IS NOT NULL
              OR run.model_provider_id IS NOT NULL) AS provider_bound
       FROM runs run
       JOIN host_threads thread ON thread.id = run.host_task_thread_id
       JOIN hosts host ON host.id = thread.execution_host_id
      WHERE run.space_id = $1 AND run.id = $2`,
    [spaceId, runId],
  )).rows[0];
  if (!row || row.provider_bound || !hasSubscriptionQuota(row.runtime_key)) return null;
  const { provider_bound: _bound, ...login } = row;
  return login;
}

/** "Resets 2026-09-24T19:40:00.000Z" → the ISO time; null for a reset the vendor gave as prose. */
export function resetsAtOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const parsed = Date.parse(text.replace(/^\s*resets\s+/i, "").trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The fuller of a login's windows — the one that decides. On a tie the
 * weekly one, whose reset is the later.
 */
export function fullerWindow(quota: HostUsageQuota | null | undefined): SubscriptionQuotaWindow | null {
  if (!quota?.available) return null;
  const session = quota.session_pct === null
    ? null
    : { kind: "session" as const, utilization: clampPct(quota.session_pct), resets_at: resetsAtOf(quota.session_resets) };
  const week = quota.week_pct === null
    ? null
    : { kind: "week" as const, utilization: clampPct(quota.week_pct), resets_at: resetsAtOf(quota.week_resets) };
  if (!session) return week;
  if (!week) return session;
  return week.utilization >= session.utilization ? week : session;
}

/** The latest cached reading of a login; nothing is asked of the host. */
export async function cachedQuotaReading(db: Queryable, login: SubscriptionLogin): Promise<QuotaReading> {
  const row = (await db.query<{ quota_json: HostUsageQuota; checked_at: unknown }>(
    `SELECT quota_json, checked_at FROM host_runtime_usage
      WHERE host_id = $1 AND runtime_key = $2 AND installation = $3`,
    [login.host_id, login.runtime_key, login.installation],
  )).rows[0];
  if (!row) return { window: null, checked_at: null };
  return { window: fullerWindow(row.quota_json), checked_at: iso(row.checked_at) };
}

/** A vendor's shorter window: how long a refusal is taken to last when no reading says when it resets. */
const SESSION_WINDOW_MS = 5 * 3600_000;

/**
 * When the CLI last refused a Run on this login for an exhausted
 * subscription, after `since` (the reading's time) and within a week.
 */
async function latestRefusalAt(db: Queryable, login: SubscriptionLogin, since: string | null): Promise<string | null> {
  const row = (await db.query<{ refused_at: unknown }>(
    `SELECT max(run.updated_at) AS refused_at
       FROM host_threads thread
       JOIN runs run ON run.host_task_thread_id = thread.id
      WHERE thread.execution_host_id = $1 AND thread.runtime_key = $2 AND thread.runtime_installation = $3
        AND run.status = 'failed' AND run.error_json->>'error_code' = $4
        AND ($5::timestamptz IS NULL OR run.updated_at > $5::timestamptz)
        AND run.updated_at > now() - interval '7 days'`,
    [login.host_id, login.runtime_key, login.installation, SUBSCRIPTION_QUOTA_EXHAUSTED, since],
  )).rows[0];
  return row?.refused_at ? iso(row.refused_at) : null;
}

/**
 * The window a CLI refusal at `refusedAt` says is full, and until when: the
 * reading's own reset when it comes after the refusal, otherwise one
 * session window from the refusal — so a login nothing could read again is
 * not held past the window it was refused in. Null when a reading taken
 * after the refusal shows the window no longer full, or the refusal's
 * window has since reset.
 */
export function refusedWindow(reading: QuotaReading, refusedAt: string, now: Date = new Date()): SubscriptionQuotaWindow | null {
  const refused = Date.parse(refusedAt);
  // Only a readable reading can say the window is no longer full: an
  // unreadable probe is recorded too, and says nothing.
  const readAfter = reading.window !== null && reading.checked_at !== null && Date.parse(reading.checked_at) > refused;
  if (readAfter && reading.window!.utilization < 100) return null;
  const readingResets = reading.window?.resets_at && Date.parse(reading.window.resets_at) > refused ? reading.window.resets_at : null;
  const resetsAt = readingResets ?? new Date(refused + SESSION_WINDOW_MS).toISOString();
  if (Date.parse(resetsAt) <= now.getTime()) return null;
  return { kind: readingResets ? reading.window!.kind : "session", utilization: 100, resets_at: resetsAt };
}

/** What is known of one login's window at an admission. */
export interface QuotaSource {
  read(db: Queryable, login: SubscriptionLogin): Promise<QuotaReading>;
}

/**
 * The cache, probed through the host (`usage_probe`) when the reading is
 * older than a minute, and overruled by a CLI refusal that came after it.
 * The probe writes through `pool`, never through the admission's own
 * transaction: it may outlive that transaction.
 */
export function liveQuotaSource(pool: Pool | null, options: { probeDeadlineMs?: number } = {}): QuotaSource {
  const deadline = options.probeDeadlineMs ?? PROBE_DEADLINE_MS;
  return {
    async read(db, login) {
      let reading = await cachedQuotaReading(db, login);
      const age = reading.checked_at ? Date.now() - Date.parse(reading.checked_at) : Number.POSITIVE_INFINITY;
      if (pool && age > QUOTA_READING_MAX_AGE_MS) {
        const probe = refreshHostUsage(pool, login.host_id, login.runtime_key, login.installation, undefined, {
          keepReadingWhenUnreadable: true,
        })
          .then((row) => ({ window: fullerWindow(row.quota), checked_at: row.checked_at }))
          .catch(() => null);
        const probed = await Promise.race([probe, sleep(deadline).then(() => null)]);
        // A host that could not answer says nothing about the window; the
        // cached number stays the best one there is.
        if (probed?.window) reading = probed;
      }
      // Refusals after a readable reading overrule it; with nothing readable, any within the week counts.
      const refusedAt = await latestRefusalAt(db, login, reading.window ? reading.checked_at : null);
      const refused = refusedAt ? refusedWindow(reading, refusedAt) : null;
      return refused ? { window: refused, checked_at: reading.checked_at } : reading;
    },
  };
}

/**
 * A discussion's cost lines by subscription: every login its Runs spent
 * (Runs bound to a ModelProvider are priced and counted in money instead),
 * the tokens spent there, and the account's latest window.
 */
export async function discussionSubscriptionUsage(db: Queryable, spaceId: string, discussionId: string): Promise<SubscriptionUsageLine[]> {
  const rows = (await db.query<SubscriptionLogin & { tokens: string }>(
    `SELECT thread.execution_host_id AS host_id, host.name AS host_name, thread.runtime_key,
            thread.runtime_installation AS installation,
            COALESCE(sum(event.input_tokens + event.output_tokens + event.cache_creation_input_tokens
              + event.cache_read_input_tokens + event.reasoning_tokens), 0)::text AS tokens
       FROM runs run
       JOIN agent_run_groups grp ON grp.space_id = run.space_id AND grp.id = run.run_group_id
       JOIN host_threads thread ON thread.id = run.host_task_thread_id
       JOIN hosts host ON host.id = thread.execution_host_id
       LEFT JOIN token_usage_events event
         ON event.space_id = run.space_id AND event.run_id = run.id AND event.provider_id IS NULL
      WHERE run.space_id = $1 AND grp.discussion_id = $2
        AND NULLIF(run.model_override_json->'conversation_backend'->>'model_provider_id', '') IS NULL
        AND run.model_provider_id IS NULL
      GROUP BY thread.execution_host_id, host.name, thread.runtime_key, thread.runtime_installation
      ORDER BY host.name, thread.runtime_key, thread.runtime_installation`,
    [spaceId, discussionId],
  )).rows;
  const lines: SubscriptionUsageLine[] = [];
  for (const row of rows) {
    if (!hasSubscriptionQuota(row.runtime_key)) continue;
    const { tokens, ...login } = row;
    lines.push({
      account_label: accountLabel(login),
      tokens: Number(tokens),
      window: (await cachedQuotaReading(db, login)).window,
    });
  }
  return lines;
}

/** Every login a conversation's Agents run on, from its host threads. */
export async function conversationSubscriptionLogins(db: Queryable, spaceId: string, sessionId: string): Promise<SubscriptionLogin[]> {
  const rows = (await db.query<SubscriptionLogin>(
    `SELECT DISTINCT thread.execution_host_id AS host_id, host.name AS host_name, thread.runtime_key,
            thread.runtime_installation AS installation
       FROM host_threads thread
       JOIN hosts host ON host.id = thread.execution_host_id
      WHERE thread.space_id = $1 AND thread.session_id = $2 AND thread.container_kind = 'conversation'
        AND thread.status IN ('active', 'session_reset')
      ORDER BY host.name, thread.runtime_key, thread.runtime_installation`,
    [spaceId, sessionId],
  )).rows;
  return rows.filter((row) => hasSubscriptionQuota(row.runtime_key));
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
