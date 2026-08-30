import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * ADR 0016 D14: a host thread pins a run-file-lifecycle conversation to one
 * WorkspaceLocation (execution-topology-and-project-control-plane-plan.md
 * P1 — previously a (host, project_folder) pair directly). See
 * `server/src/db/schema/hostThreads.ts` for the invariants this row
 * encodes.
 */
export interface HostThread {
  id: string;
  workspace_location_id: string;
  task_id: string | null;
  room_id: string | null;
  agent_id: string | null;
  /** Read-model joins retained for navigation; not stored on the thread row. */
  project_folder_id: string;
  host_id: string;
  adapter_type: string;
  runtime_installation: string;
  vendor_session_id: string | null;
  last_run_id: string | null;
  last_session_id: string | null;
  dispatch_lock_id: string | null;
  retired_vendor_session_ids: string[];
  status: "active" | "session_reset" | "closed";
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  /** control-center-phase2-plan.md P2 (C4): non-null while the message queue is paused. */
  queue_paused_at: string | null;
}

const COLUMNS = `id, workspace_location_id, task_id, room_id, agent_id, adapter_type, runtime_installation, vendor_session_id,
  last_run_id, last_session_id, dispatch_lock_id, retired_vendor_session_ids, status, created_by_user_id, created_at, updated_at, queue_paused_at`;

export class PgHostThreadRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    workspaceLocationId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
    taskId?: string | null;
  }): Promise<HostThread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<HostThread>(
      `INSERT INTO host_threads (
         id, workspace_location_id, task_id, adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)
       RETURNING ${COLUMNS}`,
      [id, input.workspaceLocationId, input.taskId ?? null, input.adapterType, input.runtimeInstallation ?? "own", input.createdByUserId, now],
    );
    return result.rows[0]!;
  }

  async createForRoomAgent(input: {
    workspaceLocationId: string;
    roomId: string;
    agentId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
    dispatchLockId?: string | null;
  }): Promise<HostThread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<HostThread>(
      `INSERT INTO host_threads (
         id, workspace_location_id, room_id, agent_id, adapter_type, runtime_installation, dispatch_lock_id, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $9)
       RETURNING ${COLUMNS}`,
      [id, input.workspaceLocationId, input.roomId, input.agentId, input.adapterType, input.runtimeInstallation ?? "own", input.dispatchLockId ?? null, input.createdByUserId, now],
    );
    return result.rows[0]!;
  }

  /**
   * Inserts the canonical live Room × Agent row if it does not exist yet.
   * The partial unique index is the concurrency boundary; ON CONFLICT waits
   * for a competing insert and then returns the already-persisted row.
   */
  async getOrCreateForRoomAgent(input: {
    workspaceLocationId: string;
    roomId: string;
    agentId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
  }): Promise<HostThread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = await this.db.query<HostThread>(
      `INSERT INTO host_threads (
         id, workspace_location_id, room_id, agent_id, adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8)
       ON CONFLICT (room_id, agent_id) WHERE status IN ('active', 'session_reset') DO NOTHING
       RETURNING ${COLUMNS}`,
      [id, input.workspaceLocationId, input.roomId, input.agentId, input.adapterType, input.runtimeInstallation ?? "own", input.createdByUserId, now],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.getForRoomAgent(input.roomId, input.agentId);
    if (!existing) throw new Error("Room Agent host thread disappeared after a conflicting insert");
    return existing;
  }

  /** Scoped by `workspace_location_id` so a thread cannot be resumed through a different Location than it was created for. */
  async getForLocation(threadId: string, workspaceLocationId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads
        WHERE id = $1 AND workspace_location_id = $2
          AND room_id IS NULL AND agent_id IS NULL
          AND status IN ('active', 'session_reset')
        LIMIT 1`,
      [threadId, workspaceLocationId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Task queue consumers must not accept a Room-owned or closed thread just
   * because they hold its opaque id. Room dispatch has its own direct path;
   * this lookup preserves the old Task-only queue authority.
   */
  async getTaskById(threadId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads
        WHERE id = $1 AND room_id IS NULL AND agent_id IS NULL
          AND status IN ('active', 'session_reset')
        LIMIT 1`,
      [threadId],
    );
    return result.rows[0] ?? null;
  }

  async getForRoomAgent(roomId: string, agentId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads
        WHERE room_id = $1 AND agent_id = $2 AND status IN ('active', 'session_reset')
        LIMIT 1`,
      [roomId, agentId],
    );
    return result.rows[0] ?? null;
  }

  /** Claim the shared Room thread before creating its Run. */
  async claimRoomDispatch(threadId: string, dispatchLockId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE host_threads
          SET dispatch_lock_id = $2, updated_at = now()
        WHERE id = $1 AND room_id IS NOT NULL AND agent_id IS NOT NULL
          AND status IN ('active', 'session_reset')
          AND dispatch_lock_id IS NULL`,
      [threadId, dispatchLockId],
    );
    return result.rowCount === 1;
  }

  async recordDispatch(threadId: string, input: { lastRunId: string; sessionId: string; dispatchLockId: string }): Promise<void> {
    const result = await this.db.query(
      `UPDATE host_threads
          SET last_run_id = $2, last_session_id = $3, dispatch_lock_id = $2, updated_at = now()
        WHERE id = $1 AND room_id IS NOT NULL AND agent_id IS NOT NULL
          AND status IN ('active', 'session_reset')
          AND dispatch_lock_id = $4`,
      [threadId, input.lastRunId, input.sessionId, input.dispatchLockId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Room host thread ${threadId} lost its dispatch lock before Run creation completed`);
    }
  }

  async resetRoomAgent(roomId: string, agentId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `UPDATE host_threads
          SET status = 'session_reset',
              retired_vendor_session_ids = CASE WHEN vendor_session_id IS NULL THEN retired_vendor_session_ids ELSE retired_vendor_session_ids || to_jsonb(vendor_session_id) END,
              vendor_session_id = NULL, updated_at = now()
        WHERE room_id = $1 AND agent_id = $2
          AND status IN ('active', 'session_reset')
        RETURNING ${COLUMNS}`,
      [roomId, agentId],
    );
    return result.rows[0] ?? null;
  }

  async closeRoomAgent(roomId: string, agentId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_threads
          SET status = 'closed',
              retired_vendor_session_ids = CASE WHEN vendor_session_id IS NULL THEN retired_vendor_session_ids ELSE retired_vendor_session_ids || to_jsonb(vendor_session_id) END,
              vendor_session_id = NULL, updated_at = now()
        WHERE room_id = $1 AND agent_id = $2 AND status <> 'closed'`,
      [roomId, agentId],
    );
  }

  async listVendorSessionIds(input: {
    workspaceLocationId: string;
    adapterType: string;
    runtimeInstallation: string;
  }): Promise<Set<string>> {
    const result = await this.db.query<{ vendor_session_id: string }>(
      `SELECT vendor_session_id
         FROM host_threads
        WHERE workspace_location_id = $1
          AND adapter_type = $2
          AND runtime_installation = $3
          AND vendor_session_id IS NOT NULL
       UNION
       SELECT retired.value AS vendor_session_id
         FROM host_threads
         CROSS JOIN LATERAL jsonb_array_elements_text(retired_vendor_session_ids) AS retired(value)
        WHERE workspace_location_id = $1
          AND adapter_type = $2
          AND runtime_installation = $3`,
      [input.workspaceLocationId, input.adapterType, input.runtimeInstallation],
    );
    return new Set(result.rows.map((row) => row.vendor_session_id));
  }

  /** Unscoped lookup for server-side callers that already have a trusted thread id (queue advancement, not request handling). */
  async getById(threadId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads WHERE id = $1 LIMIT 1`,
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
  async listForProject(spaceId: string, projectId: string): Promise<HostThread[]> {
    const result = await this.db.query<HostThread>(
      `SELECT t.id, t.workspace_location_id, t.task_id, t.room_id, t.agent_id,
              wl.project_folder_id, wl.execution_host_id AS host_id,
              t.adapter_type, t.runtime_installation, t.vendor_session_id,
              t.last_run_id, t.last_session_id, t.dispatch_lock_id, t.status, t.created_by_user_id, t.created_at, t.updated_at, t.queue_paused_at
         FROM host_threads t
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
  ): Promise<Array<HostThread & { project_id: string; project_name: string; folder_name: string }>> {
    const result = await this.db.query<HostThread & { project_id: string; project_name: string; folder_name: string }>(
      `SELECT t.id, t.workspace_location_id, t.task_id, t.room_id, t.agent_id,
              wl.project_folder_id, wl.execution_host_id AS host_id,
              t.adapter_type, t.runtime_installation, t.vendor_session_id,
              t.last_run_id, t.last_session_id, t.dispatch_lock_id, t.status, t.created_by_user_id, t.created_at, t.updated_at, t.queue_paused_at,
              p.id AS project_id, p.name AS project_name, pf.name AS folder_name
         FROM host_threads t
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
      `UPDATE host_threads
          SET last_run_id = $2::varchar,
              retired_vendor_session_ids = CASE
                WHEN $4::boolean AND vendor_session_id IS NOT NULL THEN retired_vendor_session_ids || to_jsonb(vendor_session_id)
                WHEN NOT $4::boolean AND $3::varchar IS NOT NULL AND vendor_session_id IS NOT NULL AND vendor_session_id <> $3::varchar
                  THEN retired_vendor_session_ids || to_jsonb(vendor_session_id)
                ELSE retired_vendor_session_ids END,
              vendor_session_id = CASE WHEN $4::boolean THEN NULL ELSE COALESCE($3::varchar, vendor_session_id) END,
              status = CASE WHEN $4::boolean THEN 'session_reset' ELSE 'active' END,
              dispatch_lock_id = CASE WHEN dispatch_lock_id = $2::varchar THEN NULL ELSE dispatch_lock_id END,
              updated_at = now()
        WHERE id = $1 AND status <> 'closed'`,
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
      `UPDATE host_threads SET queue_paused_at = COALESCE(queue_paused_at, now()), updated_at = now() WHERE id = $1 AND status <> 'closed'`,
      [threadId],
    );
  }

  /** Explicit user action — the only way a paused queue clears (never automatic). */
  async resumeQueue(threadId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_threads SET queue_paused_at = NULL, updated_at = now() WHERE id = $1`,
      [threadId],
    );
  }
}
