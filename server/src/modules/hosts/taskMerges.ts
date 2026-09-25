import { createHash, randomUUID } from "node:crypto";
import type { HostTaskWorkspace } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { resolveServiceActorId } from "../../db/actorResolver.js";
import { JobDeferredError, type JobHandlerRegistry } from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { appendProjectWorkEvent } from "../projectWork/eventWriter.js";
import { withDbTransaction, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { PgRunRepository } from "../runs/repository.js";
import type { RunRecord } from "../runs/runRepositoryTypes.js";
import { redactEvidenceText } from "../runs/evidenceRedaction.js";
import { agentGitIdentity } from "../runs/agentGitIdentity.js";
import { PgVerificationEngine, type WorkspaceVerificationOutcome } from "../runs/verification/engine.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import type { VerificationTarget } from "../runs/verification/types.js";
import { recordConversationHeadMove } from "../sessions/conversationGitGate.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { executionRunSql, runInProgressSql } from "../tasks/executionRuns.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry, type TaskBranchReply } from "./connectionRegistry.js";
import { deferForHostAnswer, loadTaskLocation, LOCATION_BUSY, owedSettleSql, taskBranchRequestRetryable, taskLocationUsable, taskWorkspace, type TaskLocationRow } from "./taskBranchRequests.js";

/**
 * Merging a done Task's branch into a Location's main branch (ADR 0016 §11).
 *
 * Each `done` write — automatic acceptance, a person, the Agent's
 * `task.complete` — asks for one merge per Location its execution Runs worked
 * on, in its own transaction (`enqueueTaskMerges`). A `task_merge` job then
 * drives the row through the host's steps: squash and merge onto the main
 * branch in the Task worktree, a conflict to the Task's Agent and then
 * the person, the Task's declared verification again in the merged worktree,
 * and a fast-forward of the main branch. Rainver never pushes.
 *
 * A merge that has to wait says so: `waiting_local_changes` while the person's
 * uncommitted edits overlap the Task's change (the job keeps polling, and a
 * Location heartbeat whose git state changed brings it forward), and
 * `conflict` / `verification_failed` / `failed` for what a person has to look
 * at — each a `task.merge_blocked` event, an attention item, and a notice in
 * the conversation the Task came from. A blocked merge is tried again when the
 * checkout shows its main branch moved past what the merge was blocked on.
 */
export const TASK_MERGE_JOB = "task_merge";
/**
 * A merge that has not finished and has not stopped: it holds the Task's
 * worktree (a Run of the Task waits for it), and it lands the branch as it
 * is when it gets there.
 */
export const UNDER_WAY_MERGE_STATUSES = ["queued", "rebasing", "verifying", "resolving", "waiting_local_changes"] as const;
/** Stopped on something a person has to see; tried again when the main branch moves. */
const STOPPED_MERGE_STATUSES = ["conflict", "verification_failed", "failed"] as const;
const FINISHED = new Set(["merged", "no_changes", "superseded"]);
const BUSY_RETRY_MS = 30_000;
const WAITING_RETRY_MS = 5 * 60_000;
const RESOLVING_RETRY_MS = 60_000;
/**
 * How many times in a row the main branch may move between a rebase and its
 * fast-forward before the merge stops and says so: each move costs the Task's
 * checks again, and a main branch that never holds still is the person's to
 * quiet down.
 */
const MAX_MAIN_MOVES = 5;

export type TaskMergeStatus = (typeof UNDER_WAY_MERGE_STATUSES)[number] | (typeof STOPPED_MERGE_STATUSES)[number]
  | "merged" | "no_changes" | "superseded";

export interface TaskMergeRow {
  id: string;
  space_id: string;
  task_id: string;
  workspace_location_id: string;
  basis: string;
  status: TaskMergeStatus;
  /**
   * Whom the merge acts for: a paired host's owner — the host serves nobody
   * else (ADR 0016 §3), and the owner's Runs did the work there — otherwise
   * the person whose `done` write asked, or the Task's creator when nobody
   * did. The job runs as this user and a resolution Run is admitted for them.
   */
  requested_by_user_id: string;
  main_branch: string | null;
  onto_commit: string | null;
  task_commit: string | null;
  merged_commit: string | null;
  detail_json: Record<string, unknown>;
  /** The conflict-resolution Run the Task's Agent was given: one per merge, so set means the Agent had its try. */
  resolution_run_id: string | null;
}

/**
 * Hands a conflict to the Task's Agent: dispatches a resolution Run into
 * the conflicted worktree and returns its id, or null when no Agent can take
 * it — the conflict then goes to the person.
 */
export interface TaskMergeConflictResolver {
  dispatch(db: Queryable, merge: TaskMergeRow, conflictedFiles: string[]): Promise<string | null>;
}

export interface TaskMergeDeps {
  hosts: HostConnectionRegistry;
  /** The resolution Run and the merge's move to `resolving` commit together. */
  pool?: Pool;
  verify(input: { run: RunRecord; target: VerificationTarget; base_commit_sha: string }): Promise<WorkspaceVerificationOutcome>;
  resolver?: TaskMergeConflictResolver;
}

// ---------------------------------------------------------------------------
// Asking for merges
// ---------------------------------------------------------------------------

/**
 * One merge per Location this Task's execution Runs worked on in its
 * worktree, keyed by `basis` (the `done` write that asked), each driven by its
 * own job. On a Location where an earlier merge of the Task stopped — a
 * conflict, failed checks, a failure — this close replaces it: the new close
 * decides what lands. One under way there (or verified and waiting for the
 * checkout) is left to finish: it lands the branch as it is when it gets
 * there, this close's work included, so nothing new is asked for.
 */
export async function enqueueTaskMerges(
  db: Queryable,
  input: {
    spaceId: string;
    taskId: string;
    basis: string;
    requestedByUserId: string | null;
    /** Only this Location (a late Run's own); every Location the Task used when absent. */
    workspaceLocationId?: string;
  },
): Promise<void> {
  // Every Location an execution Run of the Task was dispatched to, settled or
  // not: a Run that closes its own Task (`task.complete`) does so before its
  // settle, and the merge waits for that settle anyway. A Location where the
  // Runs worked in place has no branch, and the host answers `no_changes`.
  const locations = await db.query<{ workspace_location_id: string; execution_host_id: string; host_owner_user_id: string | null }>(
    `SELECT DISTINCT r.workspace_location_id, wl.execution_host_id, h.owner_user_id AS host_owner_user_id
       FROM task_runs tr
       JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
       JOIN workspace_locations wl ON wl.id = r.workspace_location_id AND wl.space_id = r.space_id
       JOIN hosts h ON h.id = wl.execution_host_id
      WHERE tr.space_id = $1 AND tr.task_id = $2
        AND ${executionRunSql()}
        AND ($3::varchar IS NULL OR r.workspace_location_id = $3)`,
    [input.spaceId, input.taskId, input.workspaceLocationId ?? null],
  );
  if (locations.rows.length === 0) return;
  // As stored, so the supersede below never mistakes the row it inserts for
  // an older one.
  const basis = input.basis.slice(0, 256);
  const requester = input.requestedByUserId ?? (await db.query<{ created_by_user_id: string }>(
    `SELECT created_by_user_id FROM tasks WHERE id = $1 AND space_id = $2`,
    [input.taskId, input.spaceId],
  )).rows[0]?.created_by_user_id;
  if (!requester) return;
  const queue = new PgJobQueueRepository(db);
  for (const location of locations.rows) {
    // A stopped merge holds nothing on the host (it gave its rebase back when
    // it stopped) and any resolution Run it had has ended, so nothing is
    // cancelled here; a merge given up while under way is `giveBack`'s.
    await db.query(
      `UPDATE task_merges SET status = 'superseded', completed_at = now(), updated_at = now()
        WHERE space_id = $1 AND task_id = $2 AND workspace_location_id = $3 AND basis <> $4
          AND status = ANY($5::text[])`,
      [input.spaceId, input.taskId, location.workspace_location_id, basis, STOPPED_MERGE_STATUSES],
    );
    const actingFor = location.host_owner_user_id ?? requester;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO task_merges (id, space_id, task_id, workspace_location_id, basis, status,
                                requested_by_user_id, created_at, updated_at)
       SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, 'queued', $6::varchar, now(), now()
        WHERE NOT EXISTS (
          SELECT 1 FROM task_merges
           WHERE space_id = $2::varchar AND task_id = $3::varchar AND workspace_location_id = $4::varchar
             AND status = ANY($7::text[])
        )
       ON CONFLICT (task_id, workspace_location_id, basis) DO NOTHING
       RETURNING id`,
      [randomUUID(), input.spaceId, input.taskId, location.workspace_location_id, basis, actingFor, UNDER_WAY_MERGE_STATUSES],
    );
    const mergeId = inserted.rows[0]?.id;
    if (!mergeId) continue;
    await queue.enqueue({
      job_type: TASK_MERGE_JOB,
      space_id: input.spaceId,
      user_id: actingFor,
      payload: {
        merge_id: mergeId,
        task_id: input.taskId,
        workspace_location_id: location.workspace_location_id,
        host_id: location.execution_host_id,
      },
    });
  }
}

/**
 * The Task left `done` (reopened, cancelled, deleted): each merge not yet
 * finished runs once more, sees the Task is not done, and gives back what it
 * holds on the host — a conflict, a rebased branch — before it is superseded.
 * Without this a blocked merge would keep holding the Task's worktree against
 * its next Run.
 */
export async function withdrawTaskMerges(db: Queryable, input: { spaceId: string; taskId: string }): Promise<void> {
  const open = await db.query<{ id: string; workspace_location_id: string; requested_by_user_id: string; execution_host_id: string }>(
    `SELECT m.id, m.workspace_location_id, m.requested_by_user_id, wl.execution_host_id
       FROM task_merges m JOIN workspace_locations wl ON wl.id = m.workspace_location_id
      WHERE m.space_id = $1 AND m.task_id = $2 AND m.status NOT IN ('merged', 'no_changes', 'superseded')
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.job_type = '${TASK_MERGE_JOB}' AND j.status IN ('pending', 'claimed', 'running')
             AND j.payload_json->>'merge_id' = m.id
        )`,
    [input.spaceId, input.taskId],
  );
  const queue = new PgJobQueueRepository(db);
  for (const merge of open.rows) {
    await queue.enqueue({
      job_type: TASK_MERGE_JOB,
      space_id: input.spaceId,
      user_id: merge.requested_by_user_id,
      payload: { merge_id: merge.id, task_id: input.taskId, workspace_location_id: merge.workspace_location_id, host_id: merge.execution_host_id },
    });
  }
  // A merge already polling (waiting on the checkout, on a resolution Run)
  // notices now rather than at its next poll.
  await db.query(
    `UPDATE jobs SET scheduled_at = now(), updated_at = now()
      WHERE job_type = '${TASK_MERGE_JOB}' AND status = 'pending' AND payload_json->>'task_id' = $1 AND scheduled_at > now()`,
    [input.taskId],
  );
}

/**
 * A Location's git state changed (a heartbeat reported a new HEAD or dirty
 * state): merges waiting on it run now, and a blocked merge (conflict, failed
 * checks, failure) is tried again when the checkout now has its main branch
 * checked out at a commit other than the one it was blocked against — the
 * person may have fixed it there. A commit on another branch changes nothing
 * the merge depends on, so it does not run the Task's checks again. A merge
 * that stopped before it knew its main branch retries on any HEAD move.
 */
export async function wakeTaskMergesForLocations(
  db: Queryable,
  locationIds: string[],
  /** Of those, the Locations whose HEAD moved: only that can change a conflict or a check. */
  headMoved: string[] = locationIds,
): Promise<void> {
  if (locationIds.length === 0) return;
  await db.query(
    `UPDATE jobs SET scheduled_at = now(), updated_at = now()
      WHERE job_type = '${TASK_MERGE_JOB}' AND status = 'pending'
        AND payload_json->>'workspace_location_id' = ANY($1::varchar[])
        AND scheduled_at > now()`,
    [locationIds],
  );
  const blocked = await db.query<{ id: string; space_id: string; task_id: string; workspace_location_id: string; requested_by_user_id: string; execution_host_id: string }>(
    `SELECT m.id, m.space_id, m.task_id, m.workspace_location_id, m.requested_by_user_id, wl.execution_host_id
       FROM task_merges m
       JOIN workspace_locations wl ON wl.id = m.workspace_location_id
       JOIN tasks t ON t.id = m.task_id AND t.space_id = m.space_id
      WHERE m.workspace_location_id = ANY($1::varchar[])
        AND m.status = ANY($2::text[])
        AND t.status = 'done' AND t.deleted_at IS NULL
        AND (m.main_branch IS NULL
             OR (wl.branch = m.main_branch AND wl.git_head IS DISTINCT FROM m.onto_commit))
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.job_type = '${TASK_MERGE_JOB}' AND j.status IN ('pending', 'claimed', 'running')
             AND j.payload_json->>'merge_id' = m.id
        )`,
    [headMoved, STOPPED_MERGE_STATUSES],
  );
  const queue = new PgJobQueueRepository(db);
  for (const merge of blocked.rows) {
    await queue.enqueue({
      job_type: TASK_MERGE_JOB,
      space_id: merge.space_id,
      user_id: merge.requested_by_user_id,
      payload: {
        merge_id: merge.id,
        task_id: merge.task_id,
        workspace_location_id: merge.workspace_location_id,
        host_id: merge.execution_host_id,
      },
    });
  }
}

/**
 * A built-in host Location has no heartbeat reporting its git state, so the
 * server reads it itself — only for Locations with a merge waiting on the
 * checkout or stopped on something the person may fix — and wakes those
 * merges as a paired host's heartbeat would, on the same terms.
 */
export async function refreshBuiltinMergeLocations(db: Queryable, workspaceRoot: string): Promise<number> {
  const locations = await db.query<{ id: string; root_path: string | null; execution_host_kind: string }>(
    `SELECT DISTINCT wl.id, wl.root_path, wl.execution_host_kind
       FROM task_merges m
       JOIN workspace_locations wl ON wl.id = m.workspace_location_id
       JOIN tasks t ON t.id = m.task_id AND t.space_id = m.space_id
      WHERE wl.execution_host_kind = 'server' AND wl.status <> 'archived'
        AND m.status = ANY($1::text[])
        AND t.status = 'done' AND t.deleted_at IS NULL`,
    [["waiting_local_changes", ...STOPPED_MERGE_STATUSES]],
  );
  const repository = new PgWorkspaceLocationRepository(db);
  const changed: string[] = [];
  const headMoved: string[] = [];
  for (const location of locations.rows) {
    const status = await repository.refreshGitStatus(location, workspaceRoot);
    if (status.changed) changed.push(location.id);
    if (status.headMoved) headMoved.push(location.id);
  }
  await wakeTaskMergesForLocations(db, changed, headMoved);
  return changed.length;
}

/**
 * A Run of a Task that is already `done` settled a commit onto its branch —
 * it was queued before the Task closed, or resumed after — so that work is
 * merged too, as its own merge on its own Location. A merge under way there
 * takes the commit itself when it prepares, and `enqueueTaskMerges` asks for
 * nothing beside it; other Locations' merges are theirs and untouched.
 */
export async function enqueueLateTaskMerge(
  db: Queryable,
  input: { spaceId: string; taskId: string; runId: string; workspaceLocationId: string; requestedByUserId: string | null },
): Promise<void> {
  await withQueryableTransaction(db, async (tx) => {
    const task = await tx.query<{ status: string; deleted_at: unknown }>(
      `SELECT status, deleted_at FROM tasks WHERE id = $1 AND space_id = $2 FOR UPDATE`,
      [input.taskId, input.spaceId],
    );
    const row = task.rows[0];
    if (!row || row.status !== "done" || row.deleted_at != null) return;
    await enqueueTaskMerges(tx, {
      spaceId: input.spaceId,
      taskId: input.taskId,
      basis: `late:${input.runId}`,
      requestedByUserId: input.requestedByUserId,
      workspaceLocationId: input.workspaceLocationId,
    });
  });
}

/** A merge job of this host waiting on it: run it now. */
export async function wakeTaskMergesForHost(db: Queryable, hostId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET scheduled_at = now(), updated_at = now()
      WHERE job_type = '${TASK_MERGE_JOB}' AND status = 'pending'
        AND payload_json->>'host_id' = $1 AND scheduled_at > now()`,
    [hostId],
  );
}

// ---------------------------------------------------------------------------
// Driving one merge
// ---------------------------------------------------------------------------

export function registerTaskMergeHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
  deps: Partial<TaskMergeDeps> = {},
): void {
  if (!config.databaseUrl) return;
  const engine = deps.verify ? null : PgVerificationEngine.fromConfig(config);
  const resolved: TaskMergeDeps = {
    hosts: deps.hosts ?? sharedHostConnectionRegistry,
    pool: deps.pool ?? getDbPool(config.databaseUrl),
    verify: deps.verify ?? ((input) => engine!.verifyTaskWorkspace(input)),
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
  };
  registry.register(TASK_MERGE_JOB, async (job) => {
    const mergeId = typeof job.payload.merge_id === "string" ? job.payload.merge_id : null;
    if (!mergeId) throw new Error(`${TASK_MERGE_JOB} requires merge_id`);
    const db = getDbPool(config.databaseUrl!);
    try {
      return await advanceTaskMerge(db, config, resolved, mergeId, job.space_id);
    } catch (error) {
      if (error instanceof JobDeferredError) throw error;
      // The last attempt of a merge that keeps throwing stops it as `failed`
      // the way any other stop is made — the host gives the rebase back, the
      // person is told — so nobody finds a row stuck mid-way. The error
      // itself is the worker's to record, whatever stopping it runs into.
      if (job.attempts >= job.max_attempts) {
        await stopAfterExhaustedAttempts(db, config, resolved, mergeId, job.space_id, error instanceof Error ? error.message : String(error))
          .catch(() => undefined);
      }
      throw error;
    }
  });
}

interface MergeTaskRow {
  title: string;
  description: string | null;
  status: string;
  deleted_at: unknown;
  project_id: string | null;
  source_run_id: string | null;
  created_by_user_id: string;
}

/** The merge and the Task it is for: what every event and notice is about. */
interface MergeSubject {
  merge: TaskMergeRow;
  task: MergeTaskRow;
}

/** A merge with the host that holds its worktree: what every host step needs. */
interface MergeContext extends MergeSubject {
  hostId: string;
  workspace: HostTaskWorkspace;
}

/** A merge being stopped, whether or not it still has a host to give its rebase back to. */
type StoppingMerge = MergeSubject & Partial<Pick<MergeContext, "hostId" | "workspace">>;

interface LoadedMerge {
  merge: TaskMergeRow;
  task: MergeTaskRow | null;
  location: TaskLocationRow | null;
  workspace: HostTaskWorkspace | null;
}

async function loadMergeContext(db: Queryable, config: ServerConfig, mergeId: string, spaceId: string): Promise<LoadedMerge | null> {
  const merge = await loadMerge(db, mergeId, spaceId);
  if (!merge) return null;
  const task = (await db.query<MergeTaskRow>(
    `SELECT title, description, status, deleted_at, project_id, source_run_id, created_by_user_id
       FROM tasks WHERE id = $1 AND space_id = $2`,
    [merge.task_id, spaceId],
  )).rows[0] ?? null;
  const location = await loadTaskLocation(db, merge.workspace_location_id, spaceId);
  return {
    merge,
    task,
    location,
    workspace: location ? taskWorkspace(location, merge.task_id, config.workspaceRoot) : null,
  };
}

/** Whether the Location can still answer for this merge, and the host has a workspace to answer about. */
function locationUsable(loaded: LoadedMerge): loaded is LoadedMerge & { location: TaskLocationRow; workspace: HostTaskWorkspace } {
  return taskLocationUsable(loaded.location) && loaded.workspace !== null;
}

export async function advanceTaskMerge(
  db: Queryable,
  config: ServerConfig,
  deps: TaskMergeDeps,
  mergeId: string,
  spaceId: string,
): Promise<Record<string, unknown>> {
  const loaded = await loadMergeContext(db, config, mergeId, spaceId);
  if (!loaded || FINISHED.has(loaded.merge.status)) return { skipped: "finished" };
  const { task, location } = loaded;
  // Reopened or gone since it was asked for: the work is not done any more,
  // and a rebase this merge left on the host is given back.
  if (!task || task.status !== "done" || task.deleted_at != null) {
    return giveBack(db, deps, loaded.merge, location?.host_exists ? location.execution_host_id : null, loaded.workspace);
  }
  if (!locationUsable(loaded)) {
    await block(db, deps, { merge: loaded.merge, task }, "failed", { error: "location_unavailable" });
    return { status: "failed" };
  }
  const context: MergeContext = { merge: loaded.merge, task, hostId: loaded.location.execution_host_id, workspace: loaded.workspace };
  if (await taskBusyOnLocation(db, context.merge)) {
    throw new JobDeferredError("A Run of this Task, or its settle, has not finished on this Location", BUSY_RETRY_MS);
  }

  for (let step = 0; step < 8; step += 1) {
    const merge = context.merge;
    switch (merge.status) {
      case "queued":
      case "rebasing":
      case "conflict":
      case "verification_failed":
      case "failed": {
        if (!(await taskStillDone(db, merge))) return giveBack(db, deps, merge, context.hostId, context.workspace);
        if (merge.status !== "rebasing") context.merge = await transition(db, merge, "rebasing", {});
        const reply = await deps.hosts.requestTaskBranch(context.hostId, "task_merge_prepare", {
          workspace: context.workspace,
          merge_id: merge.id,
          ...(await taskCommitIdentity(db, context)),
        });
        const next = await onStep(db, deps, context, reply);
        if (next) return next;
        break;
      }
      case "resolving": {
        const run = merge.resolution_run_id
          ? await new PgRunRepository(db).getRun(spaceId, merge.resolution_run_id)
          : null;
        // A failed Run a supervisor holds for review has ended: the person
        // deciding on it must not keep the merge waiting.
        const heldForReview = run?.status === "waiting_for_review"
          && (run.error_json as Record<string, unknown> | null | undefined)?.supervisor_review === true;
        if (run && !TERMINAL_RUN.has(run.status) && !heldForReview) {
          throw new JobDeferredError("The conflict-resolution Run has not finished", RESOLVING_RETRY_MS);
        }
        // A Run that ended at all may have resolved the files — its own checks
        // failing on a half-merged tree says nothing — so the continue decides:
        // it refuses while anything is unmerged or still marked. A Run stopped
        // before it worked is the person's.
        if (!run || run.status === "cancelled" || run.status === "orphaned") {
          return handConflictToPerson(db, deps, context, stringArray(merge.detail_json.conflicted_files), "resolution_run_stopped");
        }
        const reply = await deps.hosts.requestTaskBranch(context.hostId, "task_merge_continue", {
          workspace: context.workspace,
          merge_id: merge.id,
        });
        const next = await onStep(db, deps, context, reply, { resolving: true });
        if (next) return next;
        break;
      }
      case "verifying": {
        const executionRun = await latestExecutionRun(db, merge);
        const outcome = executionRun
          ? await deps.verify({
            run: executionRun,
            target: { host_id: context.hostId, workspace_location_id: merge.workspace_location_id, workspace: context.workspace },
            base_commit_sha: merge.onto_commit!,
          })
          : { status: "not_required" as const, checks: [] };
        if (outcome.status === "failed") {
          // A check that could not be asked because the host went away is not
          // a check that failed.
          if (outcome.checks.some((check) => check.status === "error") && !deps.hosts.isOnline(context.hostId)) {
            throw deferForHostAnswer("host_offline");
          }
          await block(db, deps, context, "verification_failed", { checks: outcome.checks.slice(0, 50) });
          return { status: "verification_failed" };
        }
        const next = await finish(db, deps, context);
        if (next) return next;
        break;
      }
      case "waiting_local_changes": {
        // Verified on this same base already; only the checkout was in the way.
        const next = await finish(db, deps, context);
        if (next) return next;
        break;
      }
      default:
        return { status: merge.status };
    }
  }
  throw new JobDeferredError("The main branch kept moving; the merge will try again", BUSY_RETRY_MS);
}

const TERMINAL_RUN = new Set(["succeeded", "failed", "degraded", "cancelled", "orphaned"]);
const REBASE_AGAIN_ERRORS = new Set(["no_rebased_merge", "merge_mismatch", "task_commit_mismatch"]);

/** Handles a prepare or continue answer; returns the job result when the job is done for now. */
async function onStep(
  db: Queryable,
  deps: TaskMergeDeps,
  context: MergeContext,
  reply: TaskBranchReply<"task_merge_prepare">,
  options: { resolving?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const merge = context.merge;
  if (!reply.ok) {
    if (taskBranchRequestRetryable(reply.error)) throw deferForHostAnswer(reply.error);
    await block(db, deps, context, "failed", { error: reply.error ?? "task_merge_failed" });
    return { status: "failed" };
  }
  switch (reply.outcome) {
    case "no_changes":
      await transition(db, merge, "no_changes", { completed: true, main_branch: reply.main_branch });
      // Nothing the main branch lacks: the branch has no work left to keep.
      await deps.hosts.requestTaskBranch(context.hostId, "task_branch_delete", { workspace: context.workspace })
        .catch(() => undefined);
      return { status: "no_changes" };
    case "rebased":
      context.merge = await transition(db, merge, "verifying", {
        main_branch: reply.main_branch,
        onto_commit: reply.onto_commit,
        task_commit: reply.task_commit
      });
      return null;
    case "conflict":
    case "unresolved": {
      const files = reply.conflicted_files;
      // What the conflict was against: the Agent is told the branch by name,
      // and a later retry is woken only once the main branch moves past it.
      const against = {
        main_branch: reply.main_branch ?? merge.main_branch,
        onto_commit: reply.onto_commit ?? merge.onto_commit,
      };
      context.merge = { ...merge, ...against };
      // The Agent gets one try per merge; a conflict after it is the person's.
      if (!options.resolving && deps.resolver && merge.resolution_run_id === null) {
        const resolver = deps.resolver;
        // One transaction, so a merge moved by someone else meanwhile leaves
        // no resolution Run behind, and a crash between the two leaves neither.
        const moved = await withDbTransaction(deps.pool!, async (client) => {
          const runId = await resolver.dispatch(client, context.merge, files);
          return runId
            ? transition(client, merge, "resolving", {
              ...against,
              resolution_run_id: runId,
              detail: { conflicted_files: files.slice(0, 500) },
            })
            : null;
        });
        if (moved) {
          context.merge = moved;
          throw new JobDeferredError("The Task's Agent is resolving the conflict", RESOLVING_RETRY_MS);
        }
      }
      return handConflictToPerson(db, deps, context, files, options.resolving ? "resolution_incomplete" : "conflict");
    }
    default:
      await block(db, deps, context, "failed", { error: "task_merge_unexpected_answer" });
      return { status: "failed" };
  }
}

async function finish(db: Queryable, deps: TaskMergeDeps, context: MergeContext): Promise<Record<string, unknown> | null> {
  const merge = context.merge;
  // Reopened while this merge verified or waited: the main branch must not
  // move for work that is not done any more.
  if (!(await taskStillDone(db, merge))) return giveBack(db, deps, merge, context.hostId, context.workspace);
  const reply = await deps.hosts.requestTaskBranch(context.hostId, "task_merge_finish", {
    workspace: context.workspace,
    merge_id: merge.id,
    main_branch: merge.main_branch!,
    onto_commit: merge.onto_commit!,
    task_commit: merge.task_commit!,
  });
  if (!reply.ok) {
    if (taskBranchRequestRetryable(reply.error) || reply.error === LOCATION_BUSY) throw deferForHostAnswer(reply.error);
    // The host no longer holds this merge's rebase as recorded here (its
    // records were lost, or it changed under the merge): rebase again.
    if (reply.error && REBASE_AGAIN_ERRORS.has(reply.error)) {
      context.merge = await transition(db, merge, "rebasing", {});
      return null;
    }
    await block(db, deps, context, "failed", { error: reply.error ?? "task_merge_failed" });
    return { status: "failed" };
  }
  switch (reply.outcome) {
    case "merged": {
      // Recorded whatever happened to the row meanwhile: the main branch did
      // move, and a merge superseded while it finished still landed.
      const landed = await db.query<TaskMergeRow>(
        `UPDATE task_merges SET status = 'merged', merged_commit = $3, completed_at = now(), updated_at = now()
          WHERE id = $1 AND space_id = $2
          RETURNING ${MERGE_COLUMNS}`,
        [merge.id, merge.space_id, reply.merged_commit],
      );
      context.merge = landed.rows[0] ?? merge;
      await advanceOriginConversationGit(db, context, reply.merged_commit);
      await announce(db, context, "merged", {});
      return { status: "merged", commit: reply.merged_commit };
    }
    case "main_moved": {
      // Someone moved the main branch after the rebase: rebase and verify
      // again — so many times in a row, then the person is told.
      const moves = mainMovesOf(merge) + 1;
      if (moves >= MAX_MAIN_MOVES) {
        await block(db, deps, context, "failed", { error: "main_kept_moving" });
        return { status: "failed" };
      }
      context.merge = await transition(db, merge, "rebasing", { detail: { main_moved: moves } });
      return null;
    }
    case "waiting_local_changes": {
      const files = reply.overlapping_files.slice(0, 500);
      context.merge = await transition(db, merge, "waiting_local_changes", {
        detail: { overlapping_files: files },
      });
      // Once per set of overlapping files: the polls that follow say nothing new.
      await announce(db, context, "waiting_local_changes", { overlapping_files: files });
      throw new JobDeferredError("The person's uncommitted changes overlap the Task's", WAITING_RETRY_MS);
    }
    default:
      await block(db, deps, context, "failed", { error: "task_merge_unexpected_answer" });
      return { status: "failed" };
  }
}

/** How many times in a row the main branch moved under this merge; a stop or a wait starts the count over. */
function mainMovesOf(merge: TaskMergeRow): number {
  const moves = merge.detail_json.main_moved;
  return typeof moves === "number" && Number.isFinite(moves) ? moves : 0;
}

/**
 * A fast-forward in the checkout moves its HEAD, and the Room Git gate
 * refuses a Conversation whose Primary Location's HEAD moved under it. The
 * conversation the Task came from — the one told it merged — takes the move
 * as its own (`recordConversationHeadMove`): its last-Run HEAD becomes the
 * merged commit, exactly as a Conversation Run's own commit is recorded, so
 * its next send advances the baseline. Only when that conversation already
 * accepted the main branch at `onto_commit`: any other state there is
 * someone else's move, and still the person's to refresh. Other conversations
 * on the Location were not told and keep the gate.
 */
async function advanceOriginConversationGit(db: Queryable, context: MergeSubject, mergedCommit: string | null): Promise<void> {
  const { merge, task } = context;
  if (!task.source_run_id || !mergedCommit || !merge.main_branch || !merge.onto_commit) return;
  const sessionId = await originSessionId(db, context);
  if (!sessionId) return;
  await recordConversationHeadMove(db, {
    spaceId: merge.space_id,
    sessionId,
    locationId: merge.workspace_location_id,
    from: { branch: merge.main_branch, head: merge.onto_commit },
    to: { branch: merge.main_branch, head: mergedCommit },
  });
}

async function handConflictToPerson(
  db: Queryable,
  deps: TaskMergeDeps,
  context: MergeContext,
  files: string[],
  reason: string,
): Promise<Record<string, unknown>> {
  // The branch goes back to the Task's single squashed commit, so the person
  // can merge it by hand; the worktree is released from the merge.
  const aborted = await deps.hosts.requestTaskBranch(context.hostId, "task_merge_abort", {
    workspace: context.workspace,
    merge_id: context.merge.id,
  });
  if (!aborted.ok && taskBranchRequestRetryable(aborted.error)) throw deferForHostAnswer(aborted.error);
  // The host still holds the conflict: not the person's to merge by hand yet,
  // and the Task's next Run would be refused. A failure, given back again
  // when the Task leaves `done`.
  if (!aborted.ok && aborted.error !== "another_merge") {
    await block(db, deps, context, "failed", { error: aborted.error ?? "task_merge_abort_failed", conflicted_files: files.slice(0, 500) });
    return { status: "failed" };
  }
  await block(db, deps, context, "conflict", { conflicted_files: files.slice(0, 500), conflict_reason: reason }, {
    main_branch: context.merge.main_branch,
    onto_commit: context.merge.onto_commit,
  });
  return { status: "conflict" };
}

/**
 * The Task is not done any more: the host gives back what this merge holds,
 * and only then is the merge superseded — superseding first would leave the
 * worktree held against the Task's next Run.
 */
async function giveBack(
  db: Queryable,
  deps: TaskMergeDeps,
  merge: TaskMergeRow,
  hostId: string | null,
  workspace: HostTaskWorkspace | null,
): Promise<Record<string, unknown>> {
  await cancelUnstartedResolutionRun(db, merge);
  if (hostId && workspace) {
    const aborted = await deps.hosts.requestTaskBranch(hostId, "task_merge_abort", { workspace, merge_id: merge.id });
    if (!aborted.ok && taskBranchRequestRetryable(aborted.error)) throw deferForHostAnswer(aborted.error);
  }
  await db.query(
    `UPDATE task_merges SET status = 'superseded', completed_at = now(), updated_at = now()
      WHERE id = $1 AND space_id = $2 AND status NOT IN ('merged', 'no_changes', 'superseded')`,
    [merge.id, merge.space_id],
  );
  return { skipped: "task_not_done" };
}

/**
 * A resolution Run not started yet (queued, or held at the quota line) of a
 * merge that is being given up would only launch into a conflict that is no
 * longer there.
 */
async function cancelUnstartedResolutionRun(db: Queryable, merge: TaskMergeRow): Promise<void> {
  if (!merge.resolution_run_id) return;
  const runs = new PgRunRepository(db);
  const run = await runs.getRun(merge.space_id, merge.resolution_run_id);
  if (run?.status !== "queued" || run.started_at) return;
  await runs.markRunTerminal({
    run_id: run.id,
    space_id: merge.space_id,
    status: "cancelled",
    output_json: {},
    error_json: { error_code: "task_merge_withdrawn", error_text: "The Task left done before this merge's conflict was resolved." },
    exit_code: 1,
    completed_at: new Date().toISOString(),
  });
}

/** The job's last attempt threw: the merge stops as `failed` through the same door as any other stop. */
async function stopAfterExhaustedAttempts(
  db: Queryable,
  config: ServerConfig,
  deps: TaskMergeDeps,
  mergeId: string,
  spaceId: string,
  error: string,
): Promise<void> {
  const loaded = await loadMergeContext(db, config, mergeId, spaceId);
  if (!loaded || FINISHED.has(loaded.merge.status)) return;
  const detail = { error: error.slice(0, 2000) };
  if (!loaded.task) {
    // Nothing to tell and nobody to tell it to; the Task's deletion withdrew
    // the merge, and that is what the job was doing.
    await transition(db, loaded.merge, "failed", { detail });
    return;
  }
  await block(db, deps, {
    merge: loaded.merge,
    task: loaded.task,
    ...(locationUsable(loaded) ? { hostId: loaded.location.execution_host_id, workspace: loaded.workspace } : {}),
  }, "failed", detail);
}

async function taskStillDone(db: Queryable, merge: TaskMergeRow): Promise<boolean> {
  const task = await db.query<{ status: string; deleted_at: unknown }>(
    `SELECT status, deleted_at FROM tasks WHERE id = $1 AND space_id = $2`,
    [merge.task_id, merge.space_id],
  );
  const row = task.rows[0];
  return Boolean(row && row.status === "done" && row.deleted_at == null);
}

// ---------------------------------------------------------------------------
// State, events, notices
// ---------------------------------------------------------------------------

const MERGE_COLUMNS = `id, space_id, task_id, workspace_location_id, basis, status, requested_by_user_id,
  main_branch, onto_commit, task_commit, merged_commit, detail_json, resolution_run_id`;

async function loadMerge(db: Queryable, mergeId: string, spaceId: string): Promise<TaskMergeRow | null> {
  return (await db.query<TaskMergeRow>(
    `SELECT ${MERGE_COLUMNS} FROM task_merges WHERE id = $1 AND space_id = $2`,
    [mergeId, spaceId],
  )).rows[0] ?? null;
}

/**
 * Moves a merge from the state it was read in; a merge superseded or moved by
 * another writer meanwhile throws, and the job's next run reads it afresh.
 */
async function transition(
  db: Queryable,
  merge: TaskMergeRow,
  status: TaskMergeStatus,
  changes: {
    main_branch?: string | null;
    onto_commit?: string | null;
    task_commit?: string | null;
    merged_commit?: string | null;
    resolution_run_id?: string;
    detail?: Record<string, unknown>;
    completed?: boolean;
  },
): Promise<TaskMergeRow> {
  const updated = await db.query<TaskMergeRow>(
    `UPDATE task_merges
        SET status = $3,
            main_branch = COALESCE($4, main_branch),
            onto_commit = COALESCE($5, onto_commit),
            task_commit = COALESCE($6, task_commit),
            merged_commit = COALESCE($7, merged_commit),
            resolution_run_id = COALESCE($8, resolution_run_id),
            detail_json = COALESCE($9::jsonb, detail_json),
            completed_at = CASE WHEN $10::boolean THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1 AND space_id = $2 AND status = $11
      RETURNING ${MERGE_COLUMNS}`,
    [
      merge.id, merge.space_id, status,
      changes.main_branch?.slice(0, 256) ?? null,
      changes.onto_commit ?? null,
      changes.task_commit ?? null,
      changes.merged_commit ?? null,
      changes.resolution_run_id ?? null,
      changes.detail ? JSON.stringify(changes.detail) : null,
      changes.completed === true,
      merge.status,
    ],
  );
  const row = updated.rows[0];
  if (!row) throw new JobDeferredError("The merge changed under this step; reading it again", 1_000);
  return row;
}

/**
 * Stops a merge on something a person has to see. A merge that stops here
 * will not finish, so the host gives the worktree back — best effort; a host
 * that is away gets it when the Task leaves `done` (`withdrawTaskMerges`) —
 * except on a conflict, where the branch was already put back for the person
 * to merge by hand.
 */
async function block(
  db: Queryable,
  deps: TaskMergeDeps,
  context: StoppingMerge,
  status: (typeof STOPPED_MERGE_STATUSES)[number],
  detail: Record<string, unknown>,
  facts: { main_branch?: string | null; onto_commit?: string | null } = {},
): Promise<void> {
  context.merge = await transition(db, context.merge, status, { detail, ...facts });
  if (status !== "conflict" && context.hostId && context.workspace) {
    await deps.hosts.requestTaskBranch(context.hostId, "task_merge_abort", {
      workspace: context.workspace,
      merge_id: context.merge.id,
    }).catch(() => undefined);
  }
  await announce(db, context, status, detail);
}

/**
 * The event on the Task's timeline, and — when the Task came from a
 * conversation — a notice there. Once per merge and outcome, so a job that
 * runs twice, or a blocked merge tried again, says it once.
 */
async function announce(
  db: Queryable,
  context: MergeSubject,
  outcome: "merged" | "waiting_local_changes" | "conflict" | "verification_failed" | "failed",
  detail: Record<string, unknown>,
): Promise<void> {
  const { merge, task } = context;
  if (!task.project_id) return;
  const actorId = await resolveServiceActorId(db, merge.space_id, "task_merge");
  const written = await appendProjectWorkEvent(db, {
    spaceId: merge.space_id,
    projectId: task.project_id,
    eventKind: outcome === "merged" ? "task.merged" : "task.merge_blocked",
    subjectType: "task",
    subjectId: merge.task_id,
    actorId,
    idempotencyKey: outcome === "merged"
      ? `task.merged:${merge.id}`
      : `task.merge_blocked:${merge.id}:${blockedKey(outcome, detail)}`,
    data: {
      merge_id: merge.id,
      workspace_location_id: merge.workspace_location_id,
      main_branch: merge.main_branch,
      ...(outcome === "merged" ? { commit: merge.merged_commit } : { reason: outcome }),
      ...pickDetail(detail),
    },
  });
  if (!written.inserted) return;
  const sessionId = await originSessionId(db, context);
  if (!sessionId) return;
  await new PgSessionRepository(db).addRoomConversationNotice(merge.space_id, sessionId, {
    content: noticeText(task.title, outcome, merge.main_branch, detail),
    metadata: {
      execution_event: "task_merge",
      execution_event_key: `${merge.id}:${outcome === "merged" ? "merged" : blockedKey(outcome, detail)}`,
      execution_details: { task_id: merge.task_id, merge_id: merge.id, outcome },
    },
  });
}

/** The Room conversation the Task came from (`tasks.source_run_id`, recorded by `task.create`), if any. */
async function originSessionId(db: Queryable, { merge, task }: MergeSubject): Promise<string | null> {
  if (!task.source_run_id) return null;
  const origin = await db.query<{ session_id: string | null }>(
    `SELECT session_id FROM runs WHERE id = $1 AND space_id = $2`,
    [task.source_run_id, merge.space_id],
  );
  return origin.rows[0]?.session_id ?? null;
}

/**
 * What makes a blocked outcome new: its files, error or checks. The same
 * conflict — the same failing checks — is one event however often it is tried
 * again, the main branch moving underneath included: a person committing on
 * main while a Task's conflict waits for them is not told again each time.
 */
function blockedKey(outcome: string, detail: Record<string, unknown>): string {
  const facts = JSON.stringify([
    stringArray(detail.conflicted_files ?? detail.overlapping_files).slice().sort(),
    typeof detail.error === "string" ? detail.error : null,
    Array.isArray(detail.checks) ? (detail.checks as Array<{ key: string; status: string }>).map((check) => `${check.key}:${check.status}`) : null,
  ]);
  return `${outcome}:${createHash("sha256").update(facts).digest("hex").slice(0, 16)}`;
}

function pickDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["conflicted_files", "overlapping_files", "error", "conflict_reason"]) {
    if (detail[key] !== undefined) out[key] = Array.isArray(detail[key]) ? (detail[key] as unknown[]).slice(0, 50) : detail[key];
  }
  if (Array.isArray(detail.checks)) {
    out.failed_checks = (detail.checks as Array<{ key: string; status: string; summary: string }>)
      .filter((check) => check.status !== "passed")
      .slice(0, 20)
      .map((check) => ({ key: check.key, status: check.status, summary: check.summary }));
  }
  return out;
}

export function noticeText(
  title: string,
  outcome: "merged" | "waiting_local_changes" | "conflict" | "verification_failed" | "failed",
  mainBranch: string | null,
  detail: Record<string, unknown>,
): string {
  const branch = mainBranch ?? "the main branch";
  const files = (key: string) => {
    const list = stringArray(detail[key]);
    return list.length > 0 ? ` (${list.slice(0, 5).join(", ")}${list.length > 5 ? `, and ${list.length - 5} more` : ""})` : "";
  };
  switch (outcome) {
    case "merged": return `Task "${title}" is merged into ${branch}.`;
    case "waiting_local_changes":
      return stringArray(detail.overlapping_files).length > 0
        ? `Task "${title}" is ready to merge into ${branch}, but uncommitted changes in the checkout touch the same files${files("overlapping_files")}. It merges once they are committed or put away.`
        : `Task "${title}" is ready to merge into ${branch}, which someone is in the middle of changing (a rebase, merge or bisect). It merges once that is finished.`;
    case "conflict":
      return `Task "${title}" could not be merged into ${branch}: it conflicts with changes made there${files("conflicted_files")}. Its branch is kept for you to merge by hand.`;
    case "verification_failed":
      return `Task "${title}" was not merged into ${branch}: its checks failed on top of the latest ${branch}.`;
    case "failed":
      return `Task "${title}" could not be merged into ${branch}: ${mergeFailureText(typeof detail.error === "string" ? detail.error : null)}.`;
  }
}

/** A person-readable reason for a failed merge; the raw error stays in the record. */
export function mergeFailureText(error: string | null): string {
  switch (error) {
    case "location_unavailable": return "its Location is no longer available";
    case "main_checked_out_elsewhere": return "the main branch is checked out in another worktree";
    case "main_kept_moving": return `the main branch moved under it ${MAX_MAIN_MOVES} times in a row; it is tried again the next time the main branch moves`;
    case "no_main_branch": return "the checkout has no main branch to merge into";
    case "git_too_old": return "the host's git is too old to merge (2.38 or newer is needed)";
    case "task_merge_unexpected_answer": return "the host gave an answer the merge did not expect";
    default: return "the merge failed on the host";
  }
}

/**
 * The Task commit: authored by the Agent of the Task's latest execution Run,
 * saying which Task and who asked for it — the Task's creator, whoever closed
 * it and whoever the merge acts for.
 */
async function taskCommitIdentity(db: Queryable, context: MergeContext): Promise<{ author: { name: string; email: string }; message: string }> {
  const { merge, task } = context;
  const people = (await db.query<{ agent_id: string | null; agent_name: string | null; requester: string | null }>(
    `SELECT a.id AS agent_id, a.name AS agent_name,
            (SELECT display_name FROM users WHERE id = $3) AS requester
       FROM (SELECT r.agent_id
               FROM task_runs tr JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
              WHERE tr.space_id = $1 AND tr.task_id = $2 AND ${executionRunSql()}
              ORDER BY r.created_at DESC, r.id DESC LIMIT 1) latest
       LEFT JOIN agents a ON a.id = latest.agent_id`,
    [merge.space_id, merge.task_id, task.created_by_user_id],
  )).rows[0];
  const lines = [oneLine(task.title) || `Task ${merge.task_id}`];
  const body = (redactEvidenceText(task.description ?? "") ?? "").replace(/\r\n?/g, "\n").trim().split("\n").slice(0, 20).join("\n").trimEnd();
  if (body) lines.push("", body.slice(0, 2000));
  lines.push("", `Rainver-Task: ${merge.task_id}`);
  const requester = oneLine(people?.requester ?? "");
  if (requester) lines.push(`Requested-by: ${requester}`);
  return {
    author: agentGitIdentity(people?.agent_id ?? null, people?.agent_name ?? null),
    message: lines.join("\n").slice(0, 16_000),
  };
}

/** The Task's latest execution Run on this Location: its contract and Folder declare the checks. */
async function latestExecutionRun(db: Queryable, merge: TaskMergeRow): Promise<RunRecord | null> {
  const latest = await db.query<{ id: string }>(
    `SELECT r.id
       FROM task_runs tr JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
      WHERE tr.space_id = $1 AND tr.task_id = $2 AND r.workspace_location_id = $3
        AND ${executionRunSql()}
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [merge.space_id, merge.task_id, merge.workspace_location_id],
  );
  const id = latest.rows[0]?.id;
  return id ? new PgRunRepository(db).getRun(merge.space_id, id) : null;
}

/**
 * The worktree is someone else's for now: a Run of the Task that started and
 * has not ended — resuming to `queued` included — other than this merge's own
 * resolution Run, or a settle still owed to the host. A Run not yet started
 * does not hold the merge — it waits for the merge instead (`taskRunAhead`),
 * or the two would wait on each other.
 */
async function taskBusyOnLocation(db: Queryable, merge: TaskMergeRow): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM task_runs tr
       JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
      WHERE tr.space_id = $1 AND tr.task_id = $2 AND r.workspace_location_id = $3
        AND r.run_type = 'agent'
        AND r.id IS DISTINCT FROM $4
        AND (
          ${runInProgressSql("r")}
          -- Resuming from a delegated Agent or a review: started, not ended.
          OR (r.status = 'queued' AND r.started_at IS NOT NULL)
        )
     UNION ALL
     SELECT 1 WHERE ${owedSettleSql("$2", "$3")}
     LIMIT 1`,
    [merge.space_id, merge.task_id, merge.workspace_location_id, merge.resolution_run_id],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
