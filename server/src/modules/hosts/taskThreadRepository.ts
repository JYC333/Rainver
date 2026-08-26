import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * ADR 0016 D14: a task thread pins a run-file-lifecycle conversation to one
 * WorkspaceLocation (execution-topology-and-project-control-plane-plan.md
 * P1 — previously a (host, project_folder) pair directly). See
 * `server/src/db/schema/hostTaskThreads.ts` for the invariants this row
 * encodes.
 */
export interface HostTaskThread {
  id: string;
  workspace_location_id: string;
  /** Read-model joins retained for navigation; not stored on the thread row. */
  project_folder_id: string;
  host_id: string;
  adapter_type: string;
  runtime_installation: string;
  vendor_session_id: string | null;
  last_run_id: string | null;
  status: "active" | "session_reset";
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  /** control-center-phase2-plan.md P2 (C4): non-null while the message queue is paused. */
  queue_paused_at: string | null;
}

const COLUMNS = `id, workspace_location_id, adapter_type, runtime_installation, vendor_session_id,
  last_run_id, status, created_by_user_id, created_at, updated_at, queue_paused_at`;

export class PgHostTaskThreadRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    workspaceLocationId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
  }): Promise<HostTaskThread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<HostTaskThread>(
      `INSERT INTO host_task_threads (
         id, workspace_location_id, adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)
       RETURNING ${COLUMNS}`,
      [id, input.workspaceLocationId, input.adapterType, input.runtimeInstallation ?? "own", input.createdByUserId, now],
    );
    return result.rows[0]!;
  }

  /** Scoped by `workspace_location_id` so a thread cannot be resumed through a different Location than it was created for. */
  async getForLocation(threadId: string, workspaceLocationId: string): Promise<HostTaskThread | null> {
    const result = await this.db.query<HostTaskThread>(
      `SELECT ${COLUMNS} FROM host_task_threads WHERE id = $1 AND workspace_location_id = $2 LIMIT 1`,
      [threadId, workspaceLocationId],
    );
    return result.rows[0] ?? null;
  }

  /** Unscoped lookup for server-side callers that already have a trusted thread id (queue advancement, not request handling). */
  async getById(threadId: string): Promise<HostTaskThread | null> {
    const result = await this.db.query<HostTaskThread>(
      `SELECT ${COLUMNS} FROM host_task_threads WHERE id = $1 LIMIT 1`,
      [threadId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Every thread across every remote workspace in a Project — the read side
   * for the control center's work stream (grouped by thread, not bare run;
   * ADR 0016 §7). Joins through `workspace_locations` + `project_folders`
   * since a thread has no `project_id` of its own.
   */
  async listForProject(spaceId: string, projectId: string): Promise<HostTaskThread[]> {
    const result = await this.db.query<HostTaskThread>(
      `SELECT t.id, t.workspace_location_id, wl.project_folder_id, wl.execution_host_id AS host_id,
              t.adapter_type, t.runtime_installation, t.vendor_session_id,
              t.last_run_id, t.status, t.created_by_user_id, t.created_at, t.updated_at, t.queue_paused_at
         FROM host_task_threads t
         JOIN workspace_locations wl ON wl.id = t.workspace_location_id
         JOIN project_folders pf ON pf.id = wl.project_folder_id
        WHERE pf.space_id = $1 AND pf.project_id = $2
        ORDER BY t.updated_at DESC`,
      [spaceId, projectId],
    );
    return result.rows;
  }

  /**
   * P3 (C10): cross-project recent threads for the Command Center landing —
   * every thread in the space *the caller can actually read the owning
   * Project of*, most-recently-updated first, joined with the
   * host/folder/project summary the landing card needs. Unlike
   * `listForProject`, this has no `project_id` filter; the landing view
   * demotes Project from a gate to an optional filter applied client-side or
   * by the caller re-querying `listForProject` instead.
   *
   * The per-project readability rule is inlined here (mirroring
   * `canReadProject` in `projects/access.ts`) rather than calling that
   * function once per candidate row: this is a cross-project aggregate by
   * design, and space membership alone is *not* the same bar — a household/
   * team space's Projects each carry their own membership list, and a
   * caller who can see the space's hosts must not thereby see every
   * Project's thread activity in it.
   */
  async listRecentForSpace(
    spaceId: string,
    userId: string,
    limit: number,
  ): Promise<Array<HostTaskThread & { project_id: string; project_name: string; folder_name: string }>> {
    const result = await this.db.query<HostTaskThread & { project_id: string; project_name: string; folder_name: string }>(
      `SELECT t.id, t.workspace_location_id, wl.project_folder_id, wl.execution_host_id AS host_id,
              t.adapter_type, t.runtime_installation, t.vendor_session_id,
              t.last_run_id, t.status, t.created_by_user_id, t.created_at, t.updated_at, t.queue_paused_at,
              p.id AS project_id, p.name AS project_name, pf.name AS folder_name
         FROM host_task_threads t
         JOIN workspace_locations wl ON wl.id = t.workspace_location_id
         JOIN project_folders pf ON pf.id = wl.project_folder_id
         JOIN projects p ON p.id = pf.project_id
         JOIN spaces s ON s.id = pf.space_id
        WHERE pf.space_id = $1
          AND p.deleted_at IS NULL
          AND (
            s.type = 'personal'
            OR p.owner_user_id = $2
            OR EXISTS (
              SELECT 1 FROM project_members pm
               WHERE pm.space_id = pf.space_id AND pm.project_id = p.id AND pm.user_id = $2 AND pm.status = 'active'
            )
          )
        ORDER BY t.updated_at DESC
        LIMIT $3`,
      [spaceId, userId, limit],
    );
    return result.rows;
  }

  async recordRunOutcome(
    threadId: string,
    input: { lastRunId: string; vendorSessionId: string | null; sessionReset: boolean },
  ): Promise<void> {
    // A reset clears the stale vendor session id outright rather than
    // COALESCE-preserving it — otherwise every subsequent dispatch into this
    // thread keeps retrying the exact same broken `--resume <id>` forever
    // instead of degrading to a fresh session as `session_reset` promises.
    await this.db.query(
      `UPDATE host_task_threads
          SET last_run_id = $2,
              vendor_session_id = CASE WHEN $4 THEN NULL ELSE COALESCE($3, vendor_session_id) END,
              status = CASE WHEN $4 THEN 'session_reset' ELSE 'active' END,
              updated_at = now()
        WHERE id = $1`,
      [threadId, input.lastRunId, input.vendorSessionId, input.sessionReset],
    );
  }

  /**
   * control-center-phase2-plan.md P2 (C4): a dispatched Run's terminal
   * status was anything other than a clean success — hold the rest of the
   * queue rather than silently firing the next message on top of whatever
   * just went wrong. Idempotent: pausing an already-paused thread is a
   * no-op (`queue_paused_at` is not overwritten with a later timestamp).
   */
  async pauseQueue(threadId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_task_threads SET queue_paused_at = COALESCE(queue_paused_at, now()), updated_at = now() WHERE id = $1`,
      [threadId],
    );
  }

  /** Explicit user action — the only way a paused queue clears (never automatic). */
  async resumeQueue(threadId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_task_threads SET queue_paused_at = NULL, updated_at = now() WHERE id = $1`,
      [threadId],
    );
  }
}
