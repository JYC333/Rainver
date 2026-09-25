import type { RoomConversationQuota, SubscriptionQuotaHold, SubscriptionQuotaWindow } from "@rainver/protocol";
import type { Pool, PoolClient } from "../../db/pool.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { readSubscriptionQuotaPolicy } from "../providers/subscriptionQuotaPolicy.js";
import { withDbTransaction, type Queryable } from "../routeUtils/common.js";
import { conversationTurnTaken, PgConversationRuntimeSessionRepository } from "../sessions/conversationRuntimeSessionRepository.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";
import { PgRoomDiscussionRepository } from "./discussionRepository.js";
import { lockRoomConversationQueue } from "./messageQueue.js";
import {
  accountLabel,
  cachedQuotaReading,
  conversationSubscriptionLogins,
  liveQuotaSource,
  loginKey,
  subscriptionLoginOfRun,
  type QuotaReading,
  type QuotaSource,
  type SubscriptionLogin,
} from "./subscriptionLogins.js";

/**
 * The subscription quota gate (`modules/rooms.md`, "Subscription quota gate").
 *
 * A subscription's window is shared by everything its login runs, and a
 * person cannot see Agents spending it. So an **Agent-triggered** turn — a
 * discussion wave or closing turn, a delegated child, any domain-event
 * continuation, and the serialized recipients inside those — is admitted only
 * while the login it runs on is below the Space's reserve line
 * (`subscription_quota.reserve_pct`, 85 % by default). Past it the Run stays
 * `queued` with `output_json.waiting_for_quota` and no job; a notice says so
 * once per window; a person may continue anyway (Project writer), which for a
 * discussion is recorded on it (`quota_override_by_user_id`) and holds for
 * the rest of it; and the minute scheduler admits held Runs when the window
 * has reset. A **person's** turn is never held: it runs until the CLI itself
 * refuses, and that refusal is itself a reading (`subscriptionLogins.ts`).
 *
 * The gate replaces the admission's own job enqueue, so a held Run has no
 * job to run and nothing else to undo. A held Run does not hold the
 * conversation's turn (`conversationTurnTaken`): a person may speak while
 * Agents wait, and a held Run is admitted only once the turn is free again.
 */

/** What is enqueued for a Run when it is admitted: the `agent_run` job as its admission built it. */
export interface AgentRunJob {
  user_id: string | null;
  agent_id: string | null;
  project_folder_id: string | null;
  payload: Record<string, unknown>;
}

/** The marker a held Run carries. `window`/`resets_at` are what a reader shows; the rest re-admits it. */
interface WaitingForQuota {
  window: SubscriptionQuotaWindow["kind"];
  resets_at: string | null;
  utilization: number;
  account_label: string;
  login: Pick<SubscriptionLogin, "host_id" | "runtime_key" | "installation">;
  held_at: string;
  job: AgentRunJob;
  /** A person continued anyway while another turn held the conversation: admitted once it is free. */
  continued_by_user_id?: string;
}

export type QuotaVerdict = { hold: false } | { hold: true; window: SubscriptionQuotaWindow };

/**
 * Whether a turn on a login with this window waits. Nothing known, below the
 * reserve line, a window whose reset time has passed, or a person's
 * "continue anyway" admit it.
 */
export function quotaVerdict(input: {
  window: SubscriptionQuotaWindow | null;
  reservePct: number;
  override: boolean;
  now?: Date;
}): QuotaVerdict {
  const window = input.window;
  if (input.override || !window || window.utilization < input.reservePct) return { hold: false };
  const resets = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
  if (Number.isFinite(resets) && resets <= (input.now ?? new Date()).getTime()) return { hold: false };
  return { hold: true, window };
}

/**
 * Admit an Agent-triggered Run — enqueue its job — or hold it at the reserve
 * line. Called where the admission would have enqueued the job, inside the
 * admission's transaction.
 */
export async function admitAgentOriginRun(
  client: PoolClient,
  input: { spaceId: string; runId: string; job: AgentRunJob; source: QuotaSource; now?: Date },
): Promise<"admitted" | "held"> {
  // Already admitted (a FIFO re-evaluating its head): nothing to decide.
  const pending = await client.query(
    `SELECT 1 FROM jobs
      WHERE space_id = $1 AND job_type = 'agent_run' AND payload_json->>'run_id' = $2
        AND status IN ('pending', 'claimed', 'running')
      LIMIT 1`,
    [input.spaceId, input.runId],
  );
  if ((pending.rowCount ?? 0) > 0) {
    await client.query(
      `UPDATE runs SET output_json = output_json - 'waiting_for_quota', updated_at = now()
        WHERE space_id = $1 AND id = $2 AND output_json ? 'waiting_for_quota'`,
      [input.spaceId, input.runId],
    );
    return "admitted";
  }
  const admit = async (): Promise<"admitted" | "held"> => {
    // A Run held before (a FIFO re-evaluating its head) is admitted as any
    // held Run is: its marker cleared, once the conversation's turn is free.
    if (await isHeld(client, input.spaceId, input.runId)) {
      return await admitHeldRun(client, input.spaceId, input.runId) ? "admitted" : "held";
    }
    return enqueueWhenTurnFree(client, { spaceId: input.spaceId, runId: input.runId, job: input.job });
  };
  const login = await subscriptionLoginOfRun(client, input.spaceId, input.runId);
  if (!login) return admit();
  const context = await runContext(client, input.spaceId, input.runId);
  const policy = await readSubscriptionQuotaPolicy(client, input.spaceId);
  const reading = await input.source.read(client, login);
  const verdict = quotaVerdict({
    window: reading.window,
    reservePct: policy.reserve_pct,
    override: await continuedOnLogin(client, input.spaceId, context?.override_user_id ?? null, login.host_id),
    now: input.now,
  });
  if (!verdict.hold) return admit();
  const marker: WaitingForQuota = {
    window: verdict.window.kind,
    resets_at: verdict.window.resets_at,
    utilization: verdict.window.utilization,
    account_label: accountLabel(login),
    login: { host_id: login.host_id, runtime_key: login.runtime_key, installation: login.installation },
    held_at: (input.now ?? new Date()).toISOString(),
    job: input.job,
  };
  await client.query(
    `UPDATE runs
        SET output_json = COALESCE(output_json, '{}'::jsonb) || jsonb_build_object('waiting_for_quota', $3::jsonb),
            updated_at = now()
      WHERE space_id = $1 AND id = $2 AND status = 'queued'`,
    [input.spaceId, input.runId, JSON.stringify(marker)],
  );
  await releaseDispatchLock(client, input.spaceId, input.runId);
  if (context) {
    await postHoldNotice(client, input.spaceId, context, marker);
    await touchDiscussionOfGroup(client, input.spaceId, context.group_id);
  }
  return "held";
}

/**
 * Enqueue an admitted Run's job — unless another group's turn holds the
 * conversation. That happens only when this group gave the turn up for a Run
 * held at the reserve line and that Run has gone since (cancelled): the Run
 * is parked (`output_json.waiting_for_turn`, carrying its job), does not hold
 * the turn, and is admitted once that turn is over (`admitTurnParkedRuns`).
 */
export async function enqueueWhenTurnFree(
  client: PoolClient,
  input: { spaceId: string; runId: string; job: AgentRunJob },
): Promise<"admitted" | "held"> {
  const row = (await client.query<{ session_id: string | null; run_group_id: string | null }>(
    `SELECT session_id, run_group_id FROM runs WHERE space_id = $1 AND id = $2`,
    [input.spaceId, input.runId],
  )).rows[0];
  if (row?.session_id) {
    await new PgConversationRuntimeSessionRepository(client).lockConversation(input.spaceId, row.session_id);
    if (
      await conversationTurnTaken(client, input.spaceId, row.session_id, { admitting: { runId: input.runId, groupId: row.run_group_id } })
      || !await reclaimDispatchLock(client, input.spaceId, input.runId)
    ) {
      await client.query(
        `UPDATE runs
            SET output_json = COALESCE(output_json, '{}'::jsonb) || jsonb_build_object('waiting_for_turn', $3::jsonb),
                updated_at = now()
          WHERE space_id = $1 AND id = $2 AND status = 'queued'`,
        [input.spaceId, input.runId, JSON.stringify({ job: input.job, held_at: new Date().toISOString() })],
      );
      await releaseDispatchLock(client, input.spaceId, input.runId);
      return "held";
    }
  }
  await enqueueRunJob(client, input.spaceId, input.job);
  return "admitted";
}

/**
 * Admit the Runs parked for the conversation's turn (`enqueueWhenTurnFree`)
 * whose conversation is free now: on a turn's completion for its
 * conversation, and on the minute pass for all.
 */
export async function admitTurnParkedRuns(
  pool: Pool,
  scope: { spaceId: string; sessionId: string } | null = null,
  onError?: (runId: string, error: unknown) => void,
): Promise<number> {
  const parked = (await pool.query<{ id: string; space_id: string; session_id: string | null }>(
    `SELECT id, space_id, session_id FROM runs
      WHERE status = 'queued' AND output_json ? 'waiting_for_turn'
        AND ($1::varchar IS NULL OR (space_id = $1 AND session_id = $2))
      ORDER BY created_at, id
      LIMIT 500`,
    [scope?.spaceId ?? null, scope?.sessionId ?? null],
  )).rows;
  let admitted = 0;
  for (const run of parked) {
    const done = await withDbTransaction(pool, async (client) => {
      if (run.session_id) {
        await lockRoomConversationQueue(client, run.space_id, run.session_id);
        await new PgConversationRuntimeSessionRepository(client).lockConversation(run.space_id, run.session_id);
      }
      const row = (await client.query<{ job: AgentRunJob; run_group_id: string | null }>(
        `SELECT output_json->'waiting_for_turn'->'job' AS job, run_group_id FROM runs
          WHERE space_id = $1 AND id = $2 AND status = 'queued' AND output_json ? 'waiting_for_turn'
          FOR UPDATE`,
        [run.space_id, run.id],
      )).rows[0];
      if (!row) return false;
      if (run.session_id && await conversationTurnTaken(client, run.space_id, run.session_id, { admitting: { runId: run.id, groupId: row.run_group_id } })) return false;
      if (!await reclaimDispatchLock(client, run.space_id, run.id)) return false;
      await client.query(
        `UPDATE runs SET output_json = output_json - 'waiting_for_turn', updated_at = now() WHERE space_id = $1 AND id = $2`,
        [run.space_id, run.id],
      );
      await enqueueRunJob(client, run.space_id, row.job);
      return true;
    }).catch((error: unknown) => {
      onError?.(run.id, error);
      return false;
    });
    if (done) admitted += 1;
  }
  return admitted;
}

/**
 * Whether a task group's turns are Agent-triggered: its trigger message is a
 * domain-event continuation (a discussion wave, a closing turn, a delegation
 * result, a research result), not a person's message or their decision on a
 * proposal.
 */
export async function isAgentOriginGroup(db: Queryable, spaceId: string, groupId: string | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  const row = (await db.query<{ agent_origin: boolean }>(
    `SELECT COALESCE(message.metadata_json ? 'continuation_event_kind', false) AS agent_origin
       FROM agent_run_groups grp
       LEFT JOIN messages message ON message.space_id = grp.space_id AND message.id = grp.trigger_message_id
      WHERE grp.space_id = $1 AND grp.id = $2`,
    [spaceId, groupId],
  )).rows[0];
  return row?.agent_origin === true;
}

/**
 * Every held Run whose window has reset (or that a person has since
 * continued) is admitted once the conversation's turn is free. The minute
 * scheduler's pass, over every held Run a page at a time: each login is read
 * once, probed when its reading is older than a minute. A Run still held
 * carries the window that holds it now, and a new reset time is said again.
 */
export async function releaseHeldRuns(
  pool: Pool,
  options: { source?: QuotaSource; now?: Date; pageSize?: number; onError?: (runId: string, error: unknown) => void } = {},
): Promise<number> {
  const source = options.source ?? liveQuotaSource(pool, { probeDeadlineMs: 30_000 });
  const pageSize = options.pageSize ?? 200;
  const readings = new Map<string, QuotaReading>();
  let released = 0;
  let after: { created_at: unknown; id: string } | null = null;
  for (;;) {
    const held: Array<{ id: string; space_id: string; created_at: unknown }> = (await pool.query<{ id: string; space_id: string; created_at: unknown }>(
      `SELECT id, space_id, created_at
         FROM runs
        WHERE status = 'queued' AND output_json ? 'waiting_for_quota'
          AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::varchar))
        ORDER BY created_at, id
        LIMIT $3`,
      [after?.created_at ?? null, after?.id ?? null, pageSize],
    )).rows;
    for (const run of held) {
      // One Run that cannot be decided never keeps the rest of the pass from theirs.
      const readWindow = async (): Promise<SubscriptionQuotaWindow | null> => {
        const login = await subscriptionLoginOfRun(pool, run.space_id, run.id);
        if (!login) return null;
        const key = loginKey(login);
        if (!readings.has(key)) readings.set(key, await source.read(pool, login));
        return readings.get(key)!.window;
      };
      const admitted = await readWindow().then((window) => withDbTransaction(pool, async (client) => {
        // The marker as it is now, under the locks an admission takes: a
        // person may have continued anyway since the page was read.
        const sessionId = (await client.query<{ session_id: string | null }>(
          `SELECT session_id FROM runs WHERE space_id = $1 AND id = $2`,
          [run.space_id, run.id],
        )).rows[0]?.session_id ?? null;
        // The locks in the order an advance takes them — the conversation's
        // queue-and-discussion lock, then the turn's — or the two deadlock.
        if (sessionId) {
          await lockRoomConversationQueue(client, run.space_id, sessionId);
          await new PgConversationRuntimeSessionRepository(client).lockConversation(run.space_id, sessionId);
        }
        const marker = (await client.query<{ marker: WaitingForQuota }>(
          `SELECT output_json->'waiting_for_quota' AS marker FROM runs
            WHERE space_id = $1 AND id = $2 AND status = 'queued' AND output_json ? 'waiting_for_quota'
            FOR UPDATE`,
          [run.space_id, run.id],
        )).rows[0]?.marker;
        if (!marker) return false;
        const context = await runContext(client, run.space_id, run.id);
        const policy = await readSubscriptionQuotaPolicy(client, run.space_id);
        const verdict = quotaVerdict({
          window,
          reservePct: policy.reserve_pct,
          override: Boolean(marker.continued_by_user_id)
            || await continuedOnLogin(client, run.space_id, context?.override_user_id ?? null, marker.login.host_id),
          now: options.now,
        });
        if (verdict.hold) {
          await refreshHold(client, run.space_id, run.id, context, marker, verdict.window);
          return false;
        }
        return admitHeldRun(client, run.space_id, run.id);
      })).catch((error: unknown) => {
        options.onError?.(run.id, error);
        return false;
      });
      if (admitted) released += 1;
    }
    if (held.length < pageSize) return released;
    after = held[held.length - 1]!;
  }
}

/** A Run still held on a different window, or one resetting at a different time: its marker and notice follow. */
async function refreshHold(
  client: PoolClient,
  spaceId: string,
  runId: string,
  context: RunContext | null,
  marker: WaitingForQuota,
  window: SubscriptionQuotaWindow,
): Promise<void> {
  if (marker.window === window.kind && marker.resets_at === window.resets_at) return;
  const refreshed: WaitingForQuota = { ...marker, window: window.kind, resets_at: window.resets_at, utilization: window.utilization };
  const updated = await client.query(
    `UPDATE runs SET output_json = jsonb_set(output_json, '{waiting_for_quota}', $3::jsonb), updated_at = now()
      WHERE space_id = $1 AND id = $2 AND status = 'queued' AND output_json ? 'waiting_for_quota'`,
    [spaceId, runId, JSON.stringify(refreshed)],
  );
  if ((updated.rowCount ?? 0) > 0 && context) {
    await postHoldNotice(client, spaceId, context, refreshed);
    await touchDiscussionOfGroup(client, spaceId, context.group_id);
  }
}

/**
 * "Continue anyway": a Project writer admits the Runs of the conversation held
 * at the reserve line on the logins they may spend (`mayContinueLogin`) —
 * now, or once the turn another holds is free. A Run on someone else's login
 * stays held: whose subscription it is decides whether its reserve is spent.
 * On a discussion that had such a Run held it is recorded — who, and when —
 * and its later Agent-triggered turns on that person's logins are not held
 * again.
 */
export async function continueHeldRuns(client: PoolClient, input: { spaceId: string; sessionId: string; userId: string }): Promise<number> {
  await lockRoomConversationQueue(client, input.spaceId, input.sessionId);
  await new PgConversationRuntimeSessionRepository(client).lockConversation(input.spaceId, input.sessionId);
  const candidates = (await client.query<{ id: string; discussion_id: string | null; marker: WaitingForQuota }>(
    `SELECT run.id, grp.discussion_id, run.output_json->'waiting_for_quota' AS marker
       FROM runs run
       LEFT JOIN agent_run_groups grp ON grp.space_id = run.space_id AND grp.id = run.run_group_id
      WHERE run.space_id = $1 AND run.session_id = $2
        AND run.status = 'queued' AND run.output_json ? 'waiting_for_quota'
      ORDER BY run.created_at, run.id
      FOR UPDATE OF run`,
    [input.spaceId, input.sessionId],
  )).rows;
  const held = [];
  for (const run of candidates) {
    if (await mayContinueLogin(client, input.spaceId, input.userId, run.marker.login.host_id)) held.push(run);
  }
  for (const discussionId of new Set(held.flatMap((row) => row.discussion_id ? [row.discussion_id] : []))) {
    await client.query(
      `UPDATE room_discussions
          SET quota_override_by_user_id = $3, quota_override_at = now(), updated_at = GREATEST(updated_at, now())
        WHERE space_id = $1 AND id = $2 AND status IN ('active', 'cap_reached', 'stopped')`,
      [input.spaceId, discussionId, input.userId],
    );
  }
  let admitted = 0;
  for (const run of held) {
    if (await admitHeldRun(client, input.spaceId, run.id)) {
      admitted += 1;
      continue;
    }
    await client.query(
      `UPDATE runs
          SET output_json = jsonb_set(output_json, '{waiting_for_quota,continued_by_user_id}', to_jsonb($3::text)), updated_at = now()
        WHERE space_id = $1 AND id = $2 AND output_json ? 'waiting_for_quota'`,
      [input.spaceId, run.id, input.userId],
    );
  }
  return admitted;
}

/**
 * Whether `userId` may spend past the reserve line on the login of `hostId`.
 * A login is its host owner's to spend; the built-in host's (a host with no
 * owner) belongs to the instance, and so to the Space's owners and admins.
 */
export async function mayContinueLogin(db: Queryable, spaceId: string, userId: string, hostId: string): Promise<boolean> {
  const row = (await db.query<{ owner_user_id: string | null; role: string | null }>(
    `SELECT host.owner_user_id, membership.role
       FROM hosts host
       LEFT JOIN space_memberships membership
         ON membership.space_id = $1 AND membership.user_id = $2 AND membership.status = 'active'
      WHERE host.id = $3`,
    [spaceId, userId, hostId],
  )).rows[0];
  if (!row) return false;
  return row.owner_user_id ? row.owner_user_id === userId : isSpaceOwnerOrAdmin(row.role);
}

/** A discussion continued anyway spares a login from the gate only when the person who continued it may spend that login. */
async function continuedOnLogin(db: Queryable, spaceId: string, overrideUserId: string | null, hostId: string): Promise<boolean> {
  return overrideUserId !== null && await mayContinueLogin(db, spaceId, overrideUserId, hostId);
}

/** The Runs of one discussion held at the reserve line, as one hold. */
export async function discussionQuotaHold(db: Queryable, spaceId: string, discussionId: string, viewerUserId: string): Promise<SubscriptionQuotaHold | null> {
  const rows = (await db.query<{ id: string; marker: WaitingForQuota }>(
    `SELECT run.id, run.output_json->'waiting_for_quota' AS marker
       FROM runs run
       JOIN agent_run_groups grp ON grp.space_id = run.space_id AND grp.id = run.run_group_id
      WHERE run.space_id = $1 AND grp.discussion_id = $2
        AND run.status = 'queued' AND run.output_json ? 'waiting_for_quota'
      ORDER BY run.created_at, run.id`,
    [spaceId, discussionId],
  )).rows;
  return (await holdsOf(db, spaceId, viewerUserId, rows))[0] ?? null;
}

/**
 * The conversation's quota as its composer reads it: the Space's lines, the
 * cached window of every login its Agents run on (no probe — this is read on
 * every refresh), and what is held — each hold saying whether the viewer may
 * continue it.
 */
export async function conversationQuota(db: Queryable, spaceId: string, sessionId: string, viewerUserId: string): Promise<RoomConversationQuota> {
  const policy = await readSubscriptionQuotaPolicy(db, spaceId);
  const logins = [];
  for (const login of await conversationSubscriptionLogins(db, spaceId, sessionId)) {
    const reading = await cachedQuotaReading(db, login);
    logins.push({ account_label: accountLabel(login), window: reading.window, checked_at: reading.checked_at });
  }
  const held = (await db.query<{ id: string; marker: WaitingForQuota }>(
    `SELECT id, output_json->'waiting_for_quota' AS marker
       FROM runs
      WHERE space_id = $1 AND session_id = $2 AND status = 'queued' AND output_json ? 'waiting_for_quota'
      ORDER BY created_at, id`,
    [spaceId, sessionId],
  )).rows;
  return { warn_pct: policy.warn_pct, reserve_pct: policy.reserve_pct, logins, holds: await holdsOf(db, spaceId, viewerUserId, held) };
}

async function holdsOf(
  db: Queryable,
  spaceId: string,
  viewerUserId: string,
  rows: Array<{ id: string; marker: WaitingForQuota }>,
): Promise<SubscriptionQuotaHold[]> {
  const holds = new Map<string, SubscriptionQuotaHold>();
  for (const row of rows) {
    const key = `${row.marker.login.host_id}\u0000${row.marker.account_label}\u0000${row.marker.window}`;
    const hold = holds.get(key) ?? {
      account_label: row.marker.account_label,
      window: row.marker.window,
      resets_at: row.marker.resets_at ?? null,
      run_ids: [],
      can_continue: await mayContinueLogin(db, spaceId, viewerUserId, row.marker.login.host_id),
    };
    hold.run_ids.push(row.id);
    holds.set(key, hold);
  }
  return [...holds.values()];
}

/**
 * Clear a held Run's marker and enqueue the job its admission built. False
 * when it was not held, or another turn holds the conversation now (a
 * person spoke while it waited): it stays held until that turn is over.
 */
async function admitHeldRun(client: PoolClient, spaceId: string, runId: string): Promise<boolean> {
  // The conversation's lock first, as a turn claim takes it.
  const sessionId = (await client.query<{ session_id: string | null }>(
    `SELECT session_id FROM runs WHERE space_id = $1 AND id = $2`,
    [spaceId, runId],
  )).rows[0]?.session_id ?? null;
  if (sessionId) await new PgConversationRuntimeSessionRepository(client).lockConversation(spaceId, sessionId);
  const row = (await client.query<{ marker: WaitingForQuota; run_group_id: string | null }>(
    `SELECT output_json->'waiting_for_quota' AS marker, run_group_id
       FROM runs
      WHERE space_id = $1 AND id = $2 AND status = 'queued' AND output_json ? 'waiting_for_quota'
      FOR UPDATE`,
    [spaceId, runId],
  )).rows[0];
  if (!row) return false;
  if (sessionId && await conversationTurnTaken(client, spaceId, sessionId, { admitting: { runId, groupId: row.run_group_id } })) return false;
  if (!await reclaimDispatchLock(client, spaceId, runId)) return false;
  await client.query(
    `UPDATE runs SET output_json = output_json - 'waiting_for_quota', updated_at = now() WHERE space_id = $1 AND id = $2`,
    [spaceId, runId],
  );
  await enqueueRunJob(client, spaceId, row.marker.job);
  await touchDiscussionOfGroup(client, spaceId, row.run_group_id);
  return true;
}

/**
 * A held or parked Run lets go of its Agent's host thread, which it claimed
 * when it was created — and so does every Run of its group that cannot run
 * before it (parked on a dependency, or queued with no job): a person's turn
 * to any of those Agents must not wait behind Agents waiting for a window.
 * Admission claims each back (`reclaimDispatchLock`).
 */
export async function releaseDispatchLock(db: Queryable, spaceId: string, runId: string): Promise<void> {
  await db.query(
    `UPDATE host_threads thread
        SET dispatch_lock_id = NULL, updated_at = now()
       FROM runs run
      WHERE run.space_id = $1
        AND (run.id = $2 OR (
          run.run_group_id = (SELECT run_group_id FROM runs WHERE space_id = $1 AND id = $2)
          AND (run.status = 'waiting_for_dependency' OR (run.status = 'queued' AND NOT EXISTS (
            SELECT 1 FROM jobs job
             WHERE job.space_id = run.space_id AND job.job_type = 'agent_run'
               AND job.payload_json->>'run_id' = run.id
               AND job.status IN ('pending', 'claimed', 'running')
          )))
        ))
        AND thread.id = run.host_task_thread_id
        AND thread.dispatch_lock_id = run.id`,
    [spaceId, runId],
  );
}

/**
 * Claim the Run's host thread back at admission; false while another turn has
 * it. The lock is held in the name of the Run it was claimed for: a handoff
 * turn runs under the lock of the recipient it prepares (the one whose
 * `handoff_rotation` names it), so it claims in that recipient's name. A Run
 * with no host thread has nothing to claim.
 */
async function reclaimDispatchLock(db: Queryable, spaceId: string, runId: string): Promise<boolean> {
  const row = (await db.query<{ host_task_thread_id: string | null; owner_id: string | null }>(
    `SELECT run.host_task_thread_id,
            (SELECT recipient.id FROM runs recipient
              WHERE recipient.space_id = run.space_id
                -- A handoff turn is created in its recipient's group: the group's index finds it.
                AND recipient.run_group_id = run.run_group_id
                AND recipient.model_override_json->'handoff_rotation'->>'handoff_run_id' = run.id
              LIMIT 1) AS owner_id
       FROM runs run
      WHERE run.space_id = $1 AND run.id = $2`,
    [spaceId, runId],
  )).rows[0];
  if (!row?.host_task_thread_id) return true;
  const owner = row.owner_id ?? runId;
  const claimed = await db.query(
    `UPDATE host_threads SET dispatch_lock_id = $2, updated_at = now()
      WHERE id = $1 AND (dispatch_lock_id IS NULL OR dispatch_lock_id = $2)
      RETURNING id`,
    [row.host_task_thread_id, owner],
  );
  return (claimed.rowCount ?? 0) > 0;
}

async function isHeld(db: Queryable, spaceId: string, runId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM runs WHERE space_id = $1 AND id = $2 AND output_json ? 'waiting_for_quota'`,
    [spaceId, runId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A discussion's header reads its hold from the discussion's detail, which a
 * reader re-reads when the record changed: a hold starting or lifting bumps it.
 */
async function touchDiscussionOfGroup(client: Queryable, spaceId: string, groupId: string | null): Promise<void> {
  if (!groupId) return;
  await client.query(
    `UPDATE room_discussions SET updated_at = GREATEST(updated_at, now())
      WHERE space_id = $1 AND id = (SELECT discussion_id FROM agent_run_groups WHERE space_id = $1 AND id = $2)`,
    [spaceId, groupId],
  );
}

async function enqueueRunJob(client: Queryable, spaceId: string, job: AgentRunJob): Promise<void> {
  // A Run with its job is about to run: it waits for nothing any longer, and
  // must not read as waiting (which would free the conversation's turn).
  if (typeof job.payload.run_id === "string") {
    await client.query(
      `UPDATE runs SET output_json = output_json - 'waiting_for_quota' - 'waiting_for_turn', updated_at = now()
        WHERE space_id = $1 AND id = $2 AND (output_json ? 'waiting_for_quota' OR output_json ? 'waiting_for_turn')`,
      [spaceId, job.payload.run_id],
    );
  }
  await new PgJobQueueRepository(client).ensureAgentRunJob({
    job_type: "agent_run",
    space_id: spaceId,
    user_id: job.user_id,
    agent_id: job.agent_id,
    project_folder_id: job.project_folder_id,
    payload: job.payload,
  });
}

interface RunContext {
  session_id: string;
  group_id: string | null;
  discussion_id: string | null;
  /** Who continued this Run's discussion anyway — for their own logins only (`mayContinueLogin`). */
  override_user_id: string | null;
  wave: number;
  agent_id: string | null;
}

async function runContext(db: Queryable, spaceId: string, runId: string): Promise<RunContext | null> {
  const row = (await db.query<{
    session_id: string | null;
    group_id: string | null;
    discussion_id: string | null;
    override_user_id: string | null;
    wave: string | null;
    agent_id: string | null;
  }>(
    `SELECT run.session_id, run.run_group_id AS group_id, grp.discussion_id, discussion.quota_override_by_user_id AS override_user_id,
            message.metadata_json->>'wave' AS wave, run.agent_id
       FROM runs run
       LEFT JOIN agent_run_groups grp ON grp.space_id = run.space_id AND grp.id = run.run_group_id
       LEFT JOIN room_discussions discussion ON discussion.space_id = grp.space_id AND discussion.id = grp.discussion_id
       LEFT JOIN messages message ON message.space_id = grp.space_id AND message.id = grp.trigger_message_id
      WHERE run.space_id = $1 AND run.id = $2`,
    [spaceId, runId],
  )).rows[0];
  if (!row?.session_id) return null;
  return {
    session_id: row.session_id,
    group_id: row.group_id,
    discussion_id: row.discussion_id,
    override_user_id: row.override_user_id,
    wave: Number(row.wave ?? 0) || 0,
    agent_id: row.agent_id,
  };
}

/**
 * Say so once per window: in the discussion (a card with the reset time and
 * "continue anyway" on its header), or as a line in the conversation.
 */
async function postHoldNotice(client: PoolClient, spaceId: string, context: RunContext, marker: WaitingForQuota): Promise<void> {
  const text = holdNoticeText(marker);
  if (context.discussion_id) {
    const posted = await client.query(
      `SELECT 1 FROM messages
        WHERE space_id = $1 AND discussion_id = $2
          AND metadata_json->'discussion_notice'->>'kind' = 'quota_hold'
          AND COALESCE(metadata_json->'discussion_notice'->>'resets_at', '') = COALESCE($3::text, '')
        LIMIT 1`,
      [spaceId, context.discussion_id, marker.resets_at],
    );
    if ((posted.rowCount ?? 0) > 0) return;
    const message = await new PgSessionRepository(client).addRoomConversationNotice(spaceId, context.session_id, {
      content: text,
      metadata: {
        discussion_notice: {
          discussion_id: context.discussion_id,
          kind: "quota_hold",
          reason: text,
          agent_ids: context.agent_id ? [context.agent_id] : [],
          resets_at: marker.resets_at,
        },
      },
    });
    if (message) {
      await new PgRoomDiscussionRepository(client).stampMessages({
        spaceId, sessionId: context.session_id, discussionId: context.discussion_id, wave: context.wave, messageIds: [message.id],
      });
      // The record is no older than the notice naming it, or a reader re-reads it forever.
      await client.query(
        `UPDATE room_discussions SET updated_at = GREATEST(updated_at, $3::timestamptz) WHERE space_id = $1 AND id = $2`,
        [spaceId, context.discussion_id, message.created_at],
      );
    }
    return;
  }
  const key = `${context.session_id}:${marker.login.host_id}:${marker.login.runtime_key}:${marker.login.installation}:${marker.resets_at ?? ""}`;
  const posted = await client.query(
    `SELECT 1 FROM messages
      WHERE space_id = $1 AND session_id = $2
        AND metadata_json->>'execution_event' = 'subscription_quota_hold'
        AND metadata_json->>'execution_event_key' = $3
      LIMIT 1`,
    [spaceId, context.session_id, key],
  );
  if ((posted.rowCount ?? 0) > 0) return;
  await new PgSessionRepository(client).addRoomConversationNotice(spaceId, context.session_id, {
    content: text,
    metadata: {
      execution_event: "subscription_quota_hold",
      execution_event_key: key,
      execution_details: { account_label: marker.account_label, window: marker.window, resets_at: marker.resets_at },
    },
  });
}

function holdNoticeText(marker: WaitingForQuota): string {
  const window = marker.window === "week" ? "weekly window" : "5-hour window";
  const resets = marker.resets_at ? ` (resets ${marker.resets_at.slice(11, 16)} UTC${marker.window === "week" ? ` on ${marker.resets_at.slice(0, 10)}` : ""})` : "";
  return `${marker.account_label} is at ${Math.round(marker.utilization)} % of its ${window}${resets}. Agent-triggered turns wait for the window to reset; a person can continue anyway.`;
}
