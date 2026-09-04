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
  space_id: string | null;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: "location" | "managed";
  task_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  container_kind: "direct" | "conversation" | null;
  container_user_id: string | null;
  /** Read-model joins retained for navigation; not stored on the thread row. */
  project_folder_id: string | null;
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
  /** Non-null while this thread's managed workspace is awaiting archive. */
  pending_archive_at: string | null;
}

const COLUMNS = `id, space_id, execution_host_id, workspace_location_id, workspace_mode, task_id, session_id, agent_id, container_kind, container_user_id, adapter_type, runtime_installation, vendor_session_id,
  last_run_id, last_session_id, dispatch_lock_id, retired_vendor_session_ids, status, created_by_user_id, created_at, updated_at, pending_archive_at`;

function normalizeReturnedThread(row: HostThread): HostThread {
  const iso = (value: unknown): string | null => value instanceof Date
    ? value.toISOString()
    : typeof value === "string" ? value : null;
  return {
    ...row,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    pending_archive_at: iso(row.pending_archive_at),
  };
}

export class PgHostThreadRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    executionHostId?: string | null;
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
         id, execution_host_id, workspace_location_id, workspace_mode, task_id, adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'location', $4, $5, $6, 'active', $7, $8, $8)
       RETURNING ${COLUMNS}`,
      [id, input.executionHostId ?? null, input.workspaceLocationId, input.taskId ?? null, input.adapterType, input.runtimeInstallation ?? "own", input.createdByUserId, now],
    );
    return result.rows[0]!;
  }

  async createForConversationAgent(input: {
    executionHostId: string;
    workspaceMode: "location" | "managed";
    workspaceLocationId?: string | null;
    spaceId: string;
    sessionId: string;
    agentId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
  }): Promise<HostThread> {
    if (input.workspaceMode === "location" && !input.workspaceLocationId) {
      throw new Error("Location-mode conversation host threads require a workspace location");
    }
    if (input.workspaceMode === "managed" && input.workspaceLocationId) {
      throw new Error("Managed-mode conversation host threads cannot have a workspace location");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<HostThread>(
      `INSERT INTO host_threads (
         id, space_id, execution_host_id, workspace_location_id, workspace_mode, session_id, agent_id, container_kind,
         adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'conversation', $8, $9, 'active', $10, $11, $11)
       RETURNING ${COLUMNS}`,
      [id, input.spaceId, input.executionHostId, input.workspaceLocationId ?? null, input.workspaceMode, input.sessionId, input.agentId, input.adapterType, input.runtimeInstallation ?? "own", input.createdByUserId, now],
    );
    return result.rows[0]!;
  }

  /** The canonical live Conversation × Agent thread; uniqueness is enforced by the partial index. */
  async getOrCreateForConversationAgent(input: {
    executionHostId: string;
    workspaceMode: "location" | "managed";
    workspaceLocationId?: string | null;
    spaceId: string;
    sessionId: string;
    agentId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
  }): Promise<HostThread> {
    if (input.workspaceMode === "location" && !input.workspaceLocationId) {
      throw new Error("Location-mode conversation host threads require a workspace location");
    }
    if (input.workspaceMode === "managed" && input.workspaceLocationId) {
      throw new Error("Managed-mode conversation host threads cannot have a workspace location");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = await this.db.query<HostThread>(
      `INSERT INTO host_threads (
         id, space_id, execution_host_id, workspace_location_id, workspace_mode, session_id, agent_id, container_kind,
         adapter_type, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'conversation', $8, $9, 'active', $10, $11, $11)
       ON CONFLICT (session_id, agent_id) WHERE container_kind = 'conversation' AND status IN ('active', 'session_reset') AND session_id IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      [id, input.spaceId, input.executionHostId, input.workspaceLocationId ?? null, input.workspaceMode, input.sessionId, input.agentId, input.adapterType, input.runtimeInstallation ?? "own", input.createdByUserId, now],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.getForConversationAgent(input.spaceId, input.sessionId, input.agentId);
    if (!existing) throw new Error("Conversation Agent host thread disappeared after a conflicting insert");
    return existing;
  }

  async getForConversationAgent(spaceId: string, sessionId: string, agentId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads
        WHERE space_id = $1 AND session_id = $2 AND agent_id = $3 AND container_kind = 'conversation'
          AND status IN ('active', 'session_reset')
        LIMIT 1`,
      [spaceId, sessionId, agentId],
    );
    return result.rows[0] ?? null;
  }

  async getOrCreateForDirect(input: {
    executionHostId?: string | null;
    workspaceMode: "location" | "managed";
    workspaceLocationId?: string | null;
    userId: string;
    agentId: string;
    adapterType: string;
    runtimeInstallation?: string;
    createdByUserId: string;
  }): Promise<HostThread> {
    if (input.workspaceMode === "location" && !input.workspaceLocationId) {
      throw new Error("Location-mode direct host threads require a workspace location");
    }
    if (input.workspaceMode === "managed" && input.workspaceLocationId) {
      throw new Error("Managed-mode direct host threads cannot have a workspace location");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = await this.db.query<HostThread>(
      `INSERT INTO host_threads (
         id, execution_host_id, workspace_location_id, workspace_mode, agent_id, container_kind,
         container_user_id, adapter_type, runtime_installation, status,
         created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'direct', $6, $7, $8, 'active', $9, $10, $10)
       ON CONFLICT (agent_id, container_user_id) WHERE status IN ('active', 'session_reset') DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        id,
        input.executionHostId ?? null,
        input.workspaceLocationId ?? null,
        input.workspaceMode,
        input.agentId,
        input.userId,
        input.adapterType,
        input.runtimeInstallation ?? "own",
        input.createdByUserId,
        now,
      ],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.getForDirect(input.agentId, input.userId);
    if (!existing) throw new Error("Direct host thread disappeared after a conflicting insert");
    return existing;
  }

  /**
   * Scoped by both Location and Task so a caller cannot resume another Task's
   * vendor session by borrowing its thread id. The row lock is intentional:
   * Task admission checks the latest Run immediately after this read, and
   * those two observations must describe one serialized thread state.
   */
  async getForLocation(threadId: string, workspaceLocationId: string, taskId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads
        WHERE id = $1 AND workspace_location_id = $2
          AND task_id = $3
          AND task_id IS NOT NULL AND session_id IS NULL AND agent_id IS NULL
          AND status IN ('active', 'session_reset')
        LIMIT 1
        FOR UPDATE`,
      [threadId, workspaceLocationId, taskId],
    );
    return result.rows[0] ?? null;
  }

  async getForDirect(agentId: string, userId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `SELECT ${COLUMNS} FROM host_threads
        WHERE agent_id = $1 AND container_kind = 'direct'
          AND container_user_id = $2 AND status IN ('active', 'session_reset')
        LIMIT 1`,
      [agentId, userId],
    );
    return result.rows[0] ?? null;
  }

  async claimDirectDispatch(threadId: string, dispatchLockId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE host_threads
          SET dispatch_lock_id = $2, updated_at = now()
        WHERE id = $1 AND agent_id IS NOT NULL
          AND container_kind = 'direct'
          AND status IN ('active', 'session_reset')
          AND dispatch_lock_id IS NULL`,
      [threadId, dispatchLockId],
    );
    return result.rowCount === 1;
  }

  async claimConversationDispatch(threadId: string, dispatchLockId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE host_threads
          SET dispatch_lock_id = $2, updated_at = now()
        WHERE id = $1 AND session_id IS NOT NULL AND agent_id IS NOT NULL
          AND container_kind = 'conversation'
          AND status IN ('active', 'session_reset')
          AND dispatch_lock_id IS NULL`,
      [threadId, dispatchLockId],
    );
    return result.rowCount === 1;
  }

  async recordDirectDispatch(threadId: string, input: { lastRunId: string; sessionId: string; dispatchLockId: string }): Promise<void> {
    const result = await this.db.query(
      `UPDATE host_threads
          SET last_run_id = $2, last_session_id = $3, dispatch_lock_id = $2, updated_at = now()
        WHERE id = $1 AND agent_id IS NOT NULL
          AND container_kind = 'direct'
          AND status IN ('active', 'session_reset')
          AND dispatch_lock_id = $4`,
      [threadId, input.lastRunId, input.sessionId, input.dispatchLockId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Direct host thread ${threadId} lost its dispatch lock before Run creation completed`);
    }
  }

  async recordConversationDispatch(threadId: string, input: { lastRunId: string; sessionId: string; dispatchLockId: string }): Promise<void> {
    const result = await this.db.query(
      `UPDATE host_threads
          SET last_run_id = $2, last_session_id = $3, dispatch_lock_id = $2, updated_at = now()
        WHERE id = $1 AND session_id IS NOT NULL AND agent_id IS NOT NULL
          AND container_kind = 'conversation'
          AND status IN ('active', 'session_reset')
          AND dispatch_lock_id = $4`,
      [threadId, input.lastRunId, input.sessionId, input.dispatchLockId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Conversation host thread ${threadId} lost its dispatch lock before Run creation completed`);
    }
  }

  /** Close every Conversation × Agent thread for a Room member. A shared
   * Conversation cwd is archived only when no other Agent still has a live
   * thread for that Session. */
  async closeConversationAgentForRoom(spaceId: string, roomId: string, agentId: string): Promise<HostThread[]> {
    const result = await this.db.query<HostThread>(
      `UPDATE host_threads thread
          SET status = 'closed',
              retired_vendor_session_ids = CASE WHEN vendor_session_id IS NULL THEN retired_vendor_session_ids ELSE retired_vendor_session_ids || to_jsonb(vendor_session_id) END,
              vendor_session_id = NULL,
              pending_archive_at = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM host_threads other
                   WHERE other.id <> thread.id
                     AND other.session_id = thread.session_id
                     AND other.space_id = thread.space_id
                     AND other.container_kind = 'conversation'
                     AND other.status IN ('active', 'session_reset')
                ) THEN COALESCE(thread.pending_archive_at, now())
                ELSE NULL
              END,
              updated_at = now()
        FROM sessions conversation
       WHERE thread.session_id = conversation.id
         AND thread.space_id = conversation.space_id
         AND conversation.space_id = $1
         AND conversation.room_id = $2
         AND thread.agent_id = $3
         AND thread.container_kind = 'conversation'
         AND thread.status IN ('active', 'session_reset')
      RETURNING thread.*`,
      [spaceId, roomId, agentId],
    );
    return result.rows.map(normalizeReturnedThread);
  }

  async resetConversationAgent(threadId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `UPDATE host_threads
          SET status = 'session_reset',
              retired_vendor_session_ids = CASE WHEN vendor_session_id IS NULL THEN retired_vendor_session_ids ELSE retired_vendor_session_ids || to_jsonb(vendor_session_id) END,
              vendor_session_id = NULL,
              updated_at = now()
        WHERE id = $1 AND session_id IS NOT NULL AND agent_id IS NOT NULL
          AND container_kind = 'conversation'
          AND status IN ('active', 'session_reset')
        RETURNING ${COLUMNS}`,
      [threadId],
    );
    return result.rows[0] ?? null;
  }

  async resetDirectAgent(agentId: string, userId: string): Promise<HostThread | null> {
    const result = await this.db.query<HostThread>(
      `UPDATE host_threads
          SET status = 'session_reset',
              retired_vendor_session_ids = CASE WHEN vendor_session_id IS NULL THEN retired_vendor_session_ids ELSE retired_vendor_session_ids || to_jsonb(vendor_session_id) END,
              vendor_session_id = NULL, updated_at = now()
        WHERE agent_id = $1 AND container_kind = 'direct'
          AND container_user_id = $2 AND status IN ('active', 'session_reset')
        RETURNING ${COLUMNS}`,
      [agentId, userId],
    );
    return result.rows[0] ?? null;
  }

  async closeDirectAgent(agentId: string, userId: string, pendingArchive = false): Promise<void> {
    await this.db.query(
      `UPDATE host_threads
          SET status = 'closed',
              retired_vendor_session_ids = CASE WHEN vendor_session_id IS NULL THEN retired_vendor_session_ids ELSE retired_vendor_session_ids || to_jsonb(vendor_session_id) END,
              vendor_session_id = NULL,
              pending_archive_at = CASE WHEN $3::boolean THEN COALESCE(pending_archive_at, now()) ELSE pending_archive_at END,
              updated_at = now()
        WHERE agent_id = $1 AND container_kind = 'direct' AND container_user_id = $2
          AND status <> 'closed'`,
      [agentId, userId, pendingArchive],
    );
  }

  async listPendingManagedWorkspaceArchives(hostId: string): Promise<Array<{
    id: string;
    agent_id: string;
    container_kind: "direct" | "conversation";
    container_id: string;
  }>> {
    const result = await this.db.query<{
      id: string;
      agent_id: string;
      container_kind: "direct" | "conversation";
      container_id: string;
    }>(
      `SELECT id, agent_id, container_kind,
              CASE WHEN container_kind = 'direct' THEN container_user_id
                   ELSE session_id END AS container_id
         FROM host_threads
        WHERE execution_host_id = $1 AND workspace_mode = 'managed'
          AND pending_archive_at IS NOT NULL AND status = 'closed'
          AND agent_id IS NOT NULL AND container_kind IN ('direct', 'conversation')`,
      [hostId],
    );
    return result.rows.filter((row) => Boolean(row.container_id));
  }

  async acknowledgeManagedWorkspaceArchive(threadId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_threads SET pending_archive_at = NULL, updated_at = now()
        WHERE id = $1 AND workspace_mode = 'managed' AND status = 'closed'`,
      [threadId],
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
        WHERE (workspace_location_id = $1 OR workspace_location_id IS NULL)
          AND adapter_type = $2
          AND runtime_installation = $3
          AND vendor_session_id IS NOT NULL
       UNION
       SELECT retired.value AS vendor_session_id
         FROM host_threads
         CROSS JOIN LATERAL jsonb_array_elements_text(retired_vendor_session_ids) AS retired(value)
        WHERE (workspace_location_id = $1 OR workspace_location_id IS NULL)
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

}
