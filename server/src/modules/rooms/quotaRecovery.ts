import { QuotaRecoverySchema, type QuotaRecovery } from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { canWriteProject } from "../projects/access.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import type { RunRecord } from "../runs/repository.js";
import { contractRecord } from "../runs/contractSnapshot.js";
import { runtimeQuotaResetAt } from "../runtimeAdapters/quotaReset.js";
import { accountLabel, cachedQuotaReading, subscriptionLoginOfRun, type QuotaReading } from "./subscriptionLogins.js";
import type { WaitingForQuota } from "./quotaGate.js";

const RECHECK_MS = 15 * 60_000;
const MAX_WAIT_MS = 7 * 86400_000;

/** A task contract or an explicit task-scoped collaboration supplies sustained-work intent. */
async function recoveryTaskId(db: Queryable, run: RunRecord): Promise<string | null> {
  const source = contractRecord(run.contract_snapshot_json).source as { kind?: string; id?: string } | undefined;
  if (source?.kind === "task" && typeof source.id === "string") return source.id;
  if (!run.run_group_id) return null;
  const row = (await db.query<{ task_id: string | null }>(
    `SELECT COALESCE(parent.budget_json, grp.budget_json)->'collaboration'->>'task_id' AS task_id
       FROM agent_run_groups grp
       LEFT JOIN agent_run_groups parent ON parent.space_id = grp.space_id
         AND parent.id = grp.budget_json->>'container_group_id'
      WHERE grp.space_id = $1 AND grp.id = $2`, [run.space_id, run.run_group_id],
  )).rows[0];
  return row?.task_id ?? null;
}

export async function prepareQuotaRecovery(db: Queryable, run: RunRecord, nextAttempt: number, now = new Date()): Promise<WaitingForQuota | null> {
  const login = await subscriptionLoginOfRun(db, run.space_id, run.id);
  const user = run.instructed_by_user_id ?? run.owner_user_id;
  if (!login || !user || run.execution_kind !== "agent") return null;
  const reading = await cachedQuotaReading(db, login);
  const reset = runtimeQuotaResetAt(run.runtime_key, run.error_message ?? null, now)
    ?? (reading.window?.resets_at && Date.parse(reading.window.resets_at) > now.getTime() ? reading.window.resets_at : null);
  const auto = Boolean(await recoveryTaskId(db, run));
  return {
    window: reading.window?.kind ?? "session", resets_at: reset, utilization: 100,
    account_label: accountLabel(login), login, held_at: now.toISOString(),
    job: { user_id: user, agent_id: run.agent_id, project_folder_id: run.project_folder_id,
      payload: { run_id: run.id, supervisor_attempt: nextAttempt } },
    recovery: {
      auto_continue: auto, refused_at: now.toISOString(), intent_at: now.toISOString(),
      next_check_at: reset ?? new Date(now.getTime() + RECHECK_MS).toISOString(),
      expires_at: new Date(now.getTime() + MAX_WAIT_MS).toISOString(),
      pause_reason: auto ? null : "user",
    },
  };
}

/** No stale low reading or unknown clock can prove an interrupted account is ready. */
export function quotaRecoveryReady(marker: WaitingForQuota, reading: QuotaReading, now: Date, reservePct = 100): boolean {
  const recovery = marker.recovery;
  if (!recovery?.auto_continue || Date.parse(recovery.next_check_at) > now.getTime()) return false;
  const fresh = reading.checked_at !== null && Date.parse(reading.checked_at) > Date.parse(recovery.refused_at);
  if (fresh && reading.window) {
    if (reading.window.utilization < reservePct) return true;
    // A newer, still-full window with a future/unknown reset takes precedence.
    if (!reading.window.resets_at || Date.parse(reading.window.resets_at) > now.getTime()) return false;
  }
  // A vendor-reported reset permits one bounded physical attempt even if its
  // account probe is unavailable. Subsequent refusal still consumes the attempt cap.
  return marker.resets_at !== null && Date.parse(marker.resets_at) <= now.getTime();
}

export function nextQuotaRecoveryCheck(reading: QuotaReading, now: Date): string {
  return new Date(Math.max(now.getTime() + RECHECK_MS, Date.parse(reading.window?.resets_at ?? "") || 0)).toISOString();
}

/** Serialize waking work per shared login; manual work already in flight has priority. */
export async function quotaRecoveryAccountFree(db: Queryable, marker: WaitingForQuota, runId: string): Promise<boolean> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`quota-recovery:${marker.login.host_id}:${marker.login.runtime_key}:${marker.login.installation}`]);
  const busy = await db.query(
    `SELECT 1 FROM runs run JOIN host_threads thread ON thread.id = run.host_task_thread_id
      WHERE thread.execution_host_id = $1 AND thread.runtime_key = $2 AND thread.runtime_installation = $3
        AND run.id <> $4 AND run.model_provider_id IS NULL
        AND NULLIF(run.model_override_json->'conversation_backend'->>'model_provider_id', '') IS NULL
        AND (run.status IN ('running', 'cancelling') OR (run.status = 'queued'
          AND NOT (COALESCE(run.output_json, '{}'::jsonb) ? 'waiting_for_quota')
          AND EXISTS (SELECT 1 FROM jobs job WHERE job.payload_json->>'run_id' = run.id
            AND job.job_type = 'agent_run' AND job.status IN ('pending', 'claimed', 'running')))) LIMIT 1`,
    [marker.login.host_id, marker.login.runtime_key, marker.login.installation, runId],
  );
  return busy.rows.length === 0;
}

/** Reauthorize the task and reject stale conversation intent before taking the turn back. */
export async function quotaRecoveryPauseReason(db: Queryable, run: RunRecord, recovery: QuotaRecovery, now: Date): Promise<QuotaRecovery["pause_reason"]> {
  if (Date.parse(recovery.expires_at) <= now.getTime()) return "expired";
  const user = run.instructed_by_user_id ?? run.owner_user_id;
  if (!user) return "authority_changed";
  const membership = await db.query(
    `SELECT 1 FROM space_memberships WHERE space_id = $1 AND user_id = $2 AND status = 'active'`, [run.space_id, user],
  );
  if (!membership.rows.length || (run.project_id && !await canWriteProject(db, run.space_id, run.project_id, user))) return "authority_changed";
  if (run.run_group_id) {
    const group = await db.query(
      `SELECT 1 FROM agent_run_groups grp LEFT JOIN agent_run_groups parent
         ON parent.space_id = grp.space_id AND parent.id = grp.budget_json->>'container_group_id'
        WHERE grp.space_id = $1 AND grp.id = $2
          AND grp.status NOT IN ('paused', 'cancelled', 'failed')
          AND (parent.id IS NULL OR parent.status NOT IN ('paused', 'cancelled', 'failed'))`, [run.space_id, run.run_group_id],
    );
    if (!group.rows.length) return "authority_changed";
  }
  const taskId = await recoveryTaskId(db, run);
  if (taskId) {
    const task = await db.query(
      `SELECT t.id FROM tasks t WHERE t.space_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
        AND t.status NOT IN ('done', 'cancelled', 'blocked', 'waiting_for_review')
        AND t.updated_at <= $4::timestamptz
        AND ${contentReadSql("task", "t", "$3")}`, [run.space_id, taskId, user, recovery.intent_at],
    );
    if (!task.rows.length) return "authority_changed";
  }
  if (run.session_id) {
    const changed = await db.query(
      `SELECT 1 FROM messages WHERE space_id = $1 AND session_id = $2 AND role = 'user' AND created_at > $3::timestamptz LIMIT 1`,
      [run.space_id, run.session_id, recovery.intent_at],
    );
    if (changed.rows.length) return "conversation_changed";
  }
  return null;
}

/** Must run in the command's transaction; the row lock serializes with scheduler admission. */
export async function updateQuotaRecovery(db: Queryable, spaceId: string, runId: string, automatic: boolean, now = new Date()): Promise<QuotaRecovery> {
  const row = (await db.query<{ status: string; marker: WaitingForQuota | null }>(
    `SELECT status, output_json->'waiting_for_quota' AS marker FROM runs WHERE space_id = $1 AND id = $2 FOR UPDATE`, [spaceId, runId],
  )).rows[0];
  const parsed = QuotaRecoverySchema.safeParse(row?.marker?.recovery);
  if (row?.status !== "queued" || !row.marker || !parsed.success) {
    throw new HttpError(409, "The Run is no longer waiting for quota recovery. Refresh its status; stop it if it has already resumed.");
  }
  const recovery: QuotaRecovery = {
    ...parsed.data, auto_continue: automatic, pause_reason: automatic ? null : "user",
    ...(automatic ? { intent_at: now.toISOString(), expires_at: new Date(now.getTime() + MAX_WAIT_MS).toISOString() } : {}),
  };
  // A known reset remains the earliest scheduled retry. Unknown resets are
  // checked for fresh account telemetry, without inventing a physical retry.
  if (automatic) recovery.next_check_at = row.marker.resets_at && Date.parse(row.marker.resets_at) > now.getTime()
    ? row.marker.resets_at : now.toISOString();
  await db.query(
    `UPDATE runs SET output_json = jsonb_set(output_json, '{waiting_for_quota,recovery}', $3::jsonb), updated_at = now()
      WHERE space_id = $1 AND id = $2`, [spaceId, runId, JSON.stringify(recovery)],
  );
  return recovery;
}
