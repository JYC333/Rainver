import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HostTaskWorkspace } from "@rainver/protocol";
import { JobDeferredError } from "../jobs/handlerRegistry.js";
import type { Queryable } from "../routeUtils/common.js";

/**
 * What every request about a Task's branch on a host shares (ADR 0016 §11):
 * the durable jobs' names, how a host's "not now" is told from its "no", the
 * Task's workspace as the host resolves it, and whether a Location can still
 * answer. `taskBranchJobs.ts` (settle and delete jobs) and `taskMerges.ts`
 * (the merge) both build on this and on nothing of each other's.
 */
export const TASK_BRANCH_DELETE_JOB = "task_branch_delete";
export const TASK_RUN_SETTLE_JOB = "task_run_settle";
/** The daemon's answer while a launch, command, settle or sweep holds the Task. */
export const TASK_BUSY = "task_busy";
/** The daemon's answer while a Run holds the Location's checkout that a merge needs. */
export const LOCATION_BUSY = "location_busy";
/** Answers that say "not now", not "no": the request is retried. */
const HOST_UNAVAILABLE = new Set(["host_offline", "host_timeout"]);
const BUSY_RETRY_MS = 30_000;
const OFFLINE_RETRY_MS = 15 * 60_000;

export function taskBranchRequestRetryable(error: string | null): boolean {
  return error !== null && (HOST_UNAVAILABLE.has(error) || error === TASK_BUSY);
}

/**
 * The job's deferral for a host's "not now": soon for a Task or Location
 * that is busy, later for a host that is away — whose `hello` brings the
 * job forward anyway.
 */
export function deferForHostAnswer(error: string | null): JobDeferredError {
  return error === TASK_BUSY || error === LOCATION_BUSY
    ? new JobDeferredError(`The Location is busy (${error})`, BUSY_RETRY_MS)
    : new JobDeferredError(`The Location's host is unavailable (${error})`, OFFLINE_RETRY_MS);
}

export interface TaskLocationRow {
  id: string;
  root_path: string | null;
  execution_host_id: string;
  execution_host_kind: string;
  status: string;
  host_exists: boolean;
}

/** The Location a Task's branch lives in, with whether its host still exists (a revoked host will never answer). */
export async function loadTaskLocation(db: Queryable, locationId: string, spaceId: string): Promise<TaskLocationRow | null> {
  const result = await db.query<TaskLocationRow>(
    `SELECT wl.id, wl.root_path, wl.execution_host_id, wl.execution_host_kind, wl.status,
            EXISTS (SELECT 1 FROM hosts h WHERE h.id = wl.execution_host_id AND h.status <> 'revoked') AS host_exists
       FROM workspace_locations wl WHERE wl.id = $1 AND wl.space_id = $2`,
    [locationId, spaceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Whether a Location can still answer a request about a Task's branch: not
 * archived or missing, and its host not revoked. An unusable one will never
 * answer, so nothing waits for it.
 */
export function taskLocationUsable(location: TaskLocationRow | null): location is TaskLocationRow {
  return location !== null && ["active", "stale"].includes(location.status) && location.host_exists;
}

/**
 * The Task's workspace as the host resolves it: a paired host by Location id
 * alone, the built-in host by the Location's place under the shared workspace
 * root — the same answer a Run's dispatch gives
 * (`builtinLocationRelativePath` in `runs/orchestrationService.ts`).
 */
export function taskWorkspace(
  location: Pick<TaskLocationRow, "id" | "root_path" | "execution_host_kind">,
  taskId: string,
  workspaceRoot: string,
): HostTaskWorkspace | null {
  const base = { kind: "location" as const, workspace_location_id: location.id, worktree: { task_id: taskId } };
  if (location.execution_host_kind !== "server" || !location.root_path) return base;
  const path = relative(resolve(workspaceRoot), resolve(workspaceRoot, location.root_path));
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return null;
  return { ...base, workspace_relative_path: path };
}

/**
 * SQL: a `task_run_settle` job still owed to the host for the Task on the
 * Location — the branch is not settled until it runs. `taskExpr` and
 * `locationExpr` are the caller's placeholders or columns.
 */
export function owedSettleSql(taskExpr: string, locationExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM jobs settle
     WHERE settle.job_type = '${TASK_RUN_SETTLE_JOB}' AND settle.status IN ('pending', 'claimed', 'running')
       AND settle.payload_json->>'task_id' = ${taskExpr}
       AND settle.payload_json->>'workspace_location_id' = ${locationExpr})`;
}
