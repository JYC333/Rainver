import { randomUUID } from "node:crypto";
import type {
  ConversationAttachmentAccessMode,
  ConversationAttachmentSummary,
  ConversationExecutionHostSummary,
  ConversationPrimarySummary,
} from "@rainver/protocol";
import { projectReadAccessSql } from "../access/contentAccessSql.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { isStale } from "../hosts/repository.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";

export interface ExecutionSessionRow {
  id: string;
  space_id: string;
  project_id: string | null;
  room_id: string | null;
  project_folder_id: string | null;
}

export interface ExecutionContextRow {
  id: string;
  space_id: string;
  session_id: string;
  execution_host_id: string | null;
  primary_workspace_mode: "managed" | "location" | null;
  primary_project_folder_id: string | null;
  primary_workspace_location_id: string | null;
  state: "draft" | "initialized";
  initialized_at: string | null;
  initialized_by_user_id: string | null;
  dispatch_lock_id: string | null;
  queue_paused_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionAttachmentRow {
  id: string;
  space_id: string;
  session_id: string;
  project_folder_id: string;
  workspace_location_id: string;
  folder_name: string;
  display_path: string | null;
  access_mode: ConversationAttachmentAccessMode;
  status: "active" | "revoked";
  granted_by_user_id: string;
  granted_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
}

export interface ExecutionHostRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  owner_user_id: string | null;
  last_heartbeat_at: string | null;
  managed_workspaces_json: unknown;
  capabilities_json: unknown;
}

export interface ExecutionLocationRow {
  id: string;
  project_folder_id: string;
  folder_name: string;
  execution_host_id: string;
  display_path: string | null;
  execution_ready: boolean;
  status: "active" | "stale" | "archived";
  host_name: string;
  host_kind: string;
  host_status: string;
  host_owner_user_id: string | null;
  last_heartbeat_at: string | null;
}

export interface RuntimeProfileRow {
  id: string;
  agent_id: string;
  agent_name: string;
  adapter_type: string;
  runtime_installation: string | null;
  execution_host_id: string | null;
  workspace_mode: "location" | "managed" | null;
  workspace_location_id: string | null;
  enabled: boolean;
  is_default: boolean;
}

export interface ConversationRuntimeThreadRow {
  agent_id: string;
  execution_host_id: string;
  workspace_mode: "managed" | "location";
  workspace_location_id: string | null;
  adapter_type: string;
  runtime_installation: string;
  status: "active" | "session_reset" | "closed";
}

const CONTEXT_COLUMNS = `id, space_id, session_id, execution_host_id,
  primary_workspace_mode, primary_project_folder_id, primary_workspace_location_id,
  state, initialized_at, initialized_by_user_id, dispatch_lock_id, queue_paused_at,
  created_at, updated_at`;

const ATTACHMENT_COLUMNS = `grant_row.id, grant_row.space_id, grant_row.session_id,
  grant_row.project_folder_id, grant_row.workspace_location_id,
  folder.name AS folder_name, location.display_path,
  grant_row.access_mode, grant_row.status, grant_row.granted_by_user_id,
  grant_row.granted_at, grant_row.updated_at, grant_row.revoked_at,
  grant_row.revoked_by_user_id`;

export class PgConversationExecutionContextRepository {
  constructor(private readonly db: Queryable) {}

  async getVisibleSession(
    identity: SpaceUserIdentity,
    sessionId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<ExecutionSessionRow | null> {
    const result = await this.db.query<ExecutionSessionRow>(
      `SELECT s.id, s.space_id, s.project_id, s.room_id, s.project_folder_id
         FROM sessions s
        WHERE s.id = $1
          AND s.space_id = $2
          AND s.status = 'active'
          AND (
            (s.room_id IS NULL AND s.user_id = $3)
            OR (s.room_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM room_user_members member
               WHERE member.space_id = s.space_id
                 AND member.room_id = s.room_id
                 AND member.user_id = $3
                 AND member.status = 'active'
            ))
          )
          AND (
            s.project_id IS NULL
            OR ${projectReadAccessSql("s.space_id", "s.project_id", "$3")}
          )
        LIMIT 1${options.forUpdate ? " FOR UPDATE" : ""}`,
      [sessionId, identity.spaceId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  async ensureDraft(session: ExecutionSessionRow): Promise<ExecutionContextRow> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO conversation_execution_contexts
         (id, space_id, session_id, state, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', $4, $4)
       ON CONFLICT (session_id, space_id) DO NOTHING`,
      [id, session.space_id, session.id, now],
    );
    const context = await this.getContext(session.space_id, session.id);
    if (!context) throw new Error("conversation execution context was not persisted");
    return context;
  }

  async lockDraft(session: ExecutionSessionRow): Promise<ExecutionContextRow> {
    await this.ensureDraft(session);
    const result = await this.db.query<ExecutionContextRow>(
      `SELECT ${CONTEXT_COLUMNS}
         FROM conversation_execution_contexts
        WHERE space_id = $1 AND session_id = $2
        FOR UPDATE`,
      [session.space_id, session.id],
    );
    const context = result.rows[0];
    if (!context) throw new Error("conversation execution context disappeared while locking");
    return context;
  }

  async getContext(spaceId: string, sessionId: string): Promise<ExecutionContextRow | null> {
    const result = await this.db.query<ExecutionContextRow>(
      `SELECT ${CONTEXT_COLUMNS}
         FROM conversation_execution_contexts
        WHERE space_id = $1 AND session_id = $2
        LIMIT 1`,
      [spaceId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  async initialize(input: {
    spaceId: string;
    sessionId: string;
    hostId: string;
    primaryMode: "managed" | "location";
    projectFolderId: string | null;
    locationId: string | null;
    userId: string;
  }): Promise<ExecutionContextRow> {
    const result = await this.db.query<ExecutionContextRow>(
      `UPDATE conversation_execution_contexts
          SET execution_host_id = $3,
              primary_workspace_mode = $4,
              primary_project_folder_id = $5,
              primary_workspace_location_id = $6,
              state = 'initialized',
              initialized_at = now(),
              initialized_by_user_id = $7,
              updated_at = now()
        WHERE space_id = $1 AND session_id = $2 AND state = 'draft'
        RETURNING ${CONTEXT_COLUMNS}`,
      [input.spaceId, input.sessionId, input.hostId, input.primaryMode, input.projectFolderId, input.locationId, input.userId],
    );
    const context = result.rows[0];
    if (!context) {
      const existing = await this.getContext(input.spaceId, input.sessionId);
      if (!existing) throw new Error("conversation execution context was not found after initialization");
      return existing;
    }
    return context;
  }

  async listHosts(userId: string): Promise<ExecutionHostRow[]> {
    const result = await this.db.query<ExecutionHostRow>(
      `SELECT id, name, kind, status, owner_user_id, last_heartbeat_at, managed_workspaces_json, capabilities_json
         FROM hosts
        WHERE kind = 'server' OR (owner_user_id = $1 AND status <> 'revoked')
        ORDER BY (kind = 'server') DESC, created_at ASC, id ASC`,
      [userId],
    );
    return result.rows;
  }

  async listProjectLocations(spaceId: string, projectId: string | null): Promise<ExecutionLocationRow[]> {
    if (!projectId) return [];
    const result = await this.db.query<ExecutionLocationRow>(
      `SELECT location.id, location.project_folder_id, folder.name AS folder_name,
              location.execution_host_id, location.display_path, location.execution_ready, location.status,
              host.name AS host_name, host.kind AS host_kind, host.status AS host_status,
              host.owner_user_id AS host_owner_user_id, host.last_heartbeat_at
         FROM workspace_locations location
         JOIN project_folders folder
           ON folder.id = location.project_folder_id
          AND folder.space_id = location.space_id
          AND folder.project_id = $2
          AND folder.status = 'active'
         JOIN hosts host ON host.id = location.execution_host_id
        WHERE location.space_id = $1
          AND location.status <> 'archived'
        ORDER BY folder.is_primary DESC, folder.name ASC, location.id ASC`,
      [spaceId, projectId],
    );
    return result.rows;
  }

  async getLocation(spaceId: string, projectFolderId: string, locationId: string): Promise<ExecutionLocationRow | null> {
    const result = await this.db.query<ExecutionLocationRow>(
      `SELECT location.id, location.project_folder_id, folder.name AS folder_name,
              location.execution_host_id, location.display_path, location.execution_ready, location.status,
              host.name AS host_name, host.kind AS host_kind, host.status AS host_status,
              host.owner_user_id AS host_owner_user_id, host.last_heartbeat_at
         FROM workspace_locations location
         JOIN project_folders folder
           ON folder.id = location.project_folder_id
          AND folder.space_id = location.space_id
          AND folder.status = 'active'
         JOIN hosts host ON host.id = location.execution_host_id
        WHERE location.id = $1 AND location.project_folder_id = $2 AND location.space_id = $3
          AND location.status <> 'archived'
        LIMIT 1`,
      [locationId, projectFolderId, spaceId],
    );
    return result.rows[0] ?? null;
  }

  async getRuntimeProfile(spaceId: string, agentId: string, profileId: string): Promise<RuntimeProfileRow | null> {
    const result = await this.db.query<RuntimeProfileRow>(
      `SELECT profile.id, profile.agent_id, agent.name AS agent_name,
              profile.adapter_type, profile.runtime_installation,
              profile.execution_host_id, profile.workspace_mode,
              profile.workspace_location_id, profile.enabled, profile.is_default
         FROM agent_runtime_profiles profile
         JOIN agents agent ON agent.id = profile.agent_id AND agent.space_id = profile.space_id
        WHERE profile.space_id = $1 AND profile.agent_id = $2 AND profile.id = $3
        LIMIT 1`,
      [spaceId, agentId, profileId],
    );
    return result.rows[0] ?? null;
  }

  async canAgentParticipate(session: ExecutionSessionRow, agentId: string, userId: string): Promise<boolean> {
    const result = await this.db.query<{ one: number }>(
      `SELECT 1 AS one
         FROM agents agent
        WHERE agent.id = $1 AND agent.space_id = $2 AND agent.status = 'active'
          AND (
            ( $3::varchar IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM room_agent_members member
                 WHERE member.space_id = agent.space_id
                   AND member.room_id = $3
                   AND member.agent_id = agent.id
                   AND member.status = 'active'
              )
              AND EXISTS (
                SELECT 1 FROM room_user_members room_member
                 WHERE room_member.space_id = agent.space_id
                   AND room_member.room_id = $3
                   AND room_member.user_id = $4
                   AND room_member.status = 'active'
              )
              AND (
                ${contentReadSql("agent", "agent", "$4")}
                OR EXISTS (
                  SELECT 1 FROM room_agent_access_grants room_grant
                   WHERE room_grant.space_id = agent.space_id
                     AND room_grant.room_id = $3
                     AND room_grant.agent_id = agent.id
                     AND room_grant.grantee_user_id = $4
                     AND room_grant.revoked_at IS NULL
                )
              )
            )
            OR ($3::varchar IS NULL AND ${contentReadSql("agent", "agent", "$4")})
          )
        LIMIT 1`,
      [agentId, session.space_id, session.room_id, userId],
    );
    return Boolean(result.rows[0]);
  }

  async listConversationParticipantAgentIds(session: ExecutionSessionRow): Promise<string[]> {
    return (await this.listConversationParticipantAgents(session)).map((agent) => agent.agent_id);
  }

  async listConversationParticipantAgents(session: ExecutionSessionRow): Promise<Array<{ agent_id: string; agent_name: string }>> {
    if (!session.room_id) {
      const agentId = await this.resolveConversationAgent(session.space_id, session.id, session.project_id);
      if (!agentId) return [];
      const agent = await this.db.query<{ agent_id: string; agent_name: string }>(
        `SELECT id AS agent_id, name AS agent_name
           FROM agents WHERE space_id = $1 AND id = $2 AND status = 'active' LIMIT 1`,
        [session.space_id, agentId],
      );
      return agent.rows;
    }
    const result = await this.db.query<{ agent_id: string; agent_name: string }>(
      `SELECT member.agent_id, agent.name AS agent_name
         FROM room_agent_members member
         JOIN agents agent ON agent.id = member.agent_id AND agent.space_id = member.space_id
        WHERE member.space_id = $1 AND member.room_id = $2 AND member.status = 'active'
          AND agent.status = 'active'
        ORDER BY member.created_at ASC, member.agent_id ASC`,
      [session.space_id, session.room_id],
    );
    return result.rows;
  }

  async listRuntimeProfiles(spaceId: string, agentId: string): Promise<RuntimeProfileRow[]> {
    const result = await this.db.query<RuntimeProfileRow>(
      `SELECT profile.id, profile.agent_id, agent.name AS agent_name,
              profile.adapter_type, profile.runtime_installation,
              profile.execution_host_id, profile.workspace_mode,
              profile.workspace_location_id, profile.enabled, profile.is_default
         FROM agent_runtime_profiles profile
         JOIN agents agent ON agent.id = profile.agent_id AND agent.space_id = profile.space_id
        WHERE profile.space_id = $1 AND profile.agent_id = $2 AND profile.enabled = true
        ORDER BY profile.is_default DESC, profile.created_at ASC, profile.id ASC`,
      [spaceId, agentId],
    );
    return result.rows;
  }

  async resolveConversationAgent(spaceId: string, sessionId: string, projectId: string | null): Promise<string | null> {
    const existing = await this.db.query<{ agent_id: string }>(
      `SELECT agent_id FROM host_threads
        WHERE space_id = $1 AND session_id = $2 AND container_kind = 'conversation'
          AND agent_id IS NOT NULL AND status IN ('active', 'session_reset')
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [spaceId, sessionId],
    );
    if (existing.rows[0]) return existing.rows[0].agent_id;
    if (!projectId) return null;
    const assistant = await this.db.query<{ id: string }>(
      `SELECT id FROM agents
        WHERE space_id = $1 AND project_id = $2 AND agent_kind = 'system_assistant' AND status = 'active'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [spaceId, projectId],
    );
    return assistant.rows[0]?.id ?? null;
  }

  async getBinding(spaceId: string, sessionId: string, agentId: string): Promise<{
    runtime_profile_id: string;
    credential_profile_id: string | null;
  } | null> {
    const result = await this.db.query<{
      runtime_profile_id: string;
      credential_profile_id: string | null;
    }>(
      `SELECT runtime_profile_id, credential_profile_id
         FROM session_conversation_backends
        WHERE space_id = $1 AND session_id = $2 AND agent_id = $3
        LIMIT 1`,
      [spaceId, sessionId, agentId],
    );
    return result.rows[0] ?? null;
  }

  async listBindings(spaceId: string, sessionId: string): Promise<Array<{
    agent_id: string;
    runtime_profile_id: string;
    credential_profile_id: string | null;
  }>> {
    const result = await this.db.query<{
      agent_id: string;
      runtime_profile_id: string;
      credential_profile_id: string | null;
    }>(
      `SELECT agent_id, runtime_profile_id, credential_profile_id
         FROM session_conversation_backends
        WHERE space_id = $1 AND session_id = $2
        ORDER BY created_at ASC, agent_id ASC`,
      [spaceId, sessionId],
    );
    return result.rows;
  }

  async getConversationThread(spaceId: string, sessionId: string, agentId: string): Promise<ConversationRuntimeThreadRow | null> {
    const result = await this.db.query<ConversationRuntimeThreadRow>(
      `SELECT agent_id, execution_host_id, workspace_mode, workspace_location_id,
              adapter_type, runtime_installation, status
         FROM host_threads
        WHERE space_id = $1 AND session_id = $2 AND agent_id = $3
          AND container_kind = 'conversation' AND status IN ('active', 'session_reset')
        LIMIT 1`,
      [spaceId, sessionId, agentId],
    );
    return result.rows[0] ?? null;
  }

  async bindRuntime(input: {
    spaceId: string;
    sessionId: string;
    userId: string;
    agentId: string;
    profileId: string;
    credentialProfileId: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO session_conversation_backends (
         id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
         credential_profile_id, model_name_snapshot, model_provider_id_snapshot,
         runtime_config_snapshot_json, runtime_policy_snapshot_json,
         runtime_state_key, created_at, updated_at
       ) SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar,
                profile.id, $7::varchar, profile.model_name, profile.model_provider_id,
                profile.runtime_config_json, profile.runtime_policy_json,
                $8::varchar, $9::timestamptz, $9::timestamptz
           FROM agent_runtime_profiles profile
          WHERE profile.id = $6 AND profile.space_id = $2 AND profile.agent_id = $5
       ON CONFLICT ON CONSTRAINT uq_session_conversation_backends_session_agent
       DO UPDATE SET
         runtime_profile_id = EXCLUDED.runtime_profile_id,
         credential_profile_id = EXCLUDED.credential_profile_id,
         model_name_snapshot = EXCLUDED.model_name_snapshot,
         model_provider_id_snapshot = EXCLUDED.model_provider_id_snapshot,
         runtime_config_snapshot_json = EXCLUDED.runtime_config_snapshot_json,
         runtime_policy_snapshot_json = EXCLUDED.runtime_policy_snapshot_json,
         runtime_state_key = EXCLUDED.runtime_state_key,
         runtime_session_id = NULL,
         runtime_context_fingerprint = NULL,
         runtime_message_cursor_id = NULL,
         runtime_session_updated_at = NULL,
         updated_at = EXCLUDED.updated_at`,
      [randomUUID(), input.spaceId, input.sessionId, input.userId, input.agentId,
        input.profileId, input.credentialProfileId, randomUUID(), now],
    );
  }

  async listAttachments(spaceId: string, sessionId: string): Promise<ExecutionAttachmentRow[]> {
    const result = await this.db.query<ExecutionAttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM conversation_folder_access_grants grant_row
         JOIN project_folders folder
           ON folder.id = grant_row.project_folder_id
          AND folder.space_id = grant_row.space_id
         JOIN workspace_locations location
           ON location.id = grant_row.workspace_location_id
          AND location.project_folder_id = grant_row.project_folder_id
        WHERE grant_row.space_id = $1 AND grant_row.session_id = $2
        ORDER BY grant_row.granted_at ASC, grant_row.id ASC`,
      [spaceId, sessionId],
    );
    return result.rows;
  }

  async getAttachment(spaceId: string, sessionId: string, attachmentId: string): Promise<ExecutionAttachmentRow | null> {
    const result = await this.db.query<ExecutionAttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM conversation_folder_access_grants grant_row
         JOIN project_folders folder
           ON folder.id = grant_row.project_folder_id
          AND folder.space_id = grant_row.space_id
         JOIN workspace_locations location
           ON location.id = grant_row.workspace_location_id
          AND location.project_folder_id = grant_row.project_folder_id
        WHERE grant_row.id = $1 AND grant_row.space_id = $2 AND grant_row.session_id = $3
        LIMIT 1`,
      [attachmentId, spaceId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  async insertAttachment(input: {
    spaceId: string;
    sessionId: string;
    projectFolderId: string;
    locationId: string;
    accessMode: ConversationAttachmentAccessMode;
    userId: string;
  }): Promise<ExecutionAttachmentRow> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO conversation_folder_access_grants (
         id, space_id, session_id, project_folder_id, workspace_location_id,
         access_mode, status, granted_by_user_id, granted_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, now(), now())
       RETURNING id`,
      [id, input.spaceId, input.sessionId, input.projectFolderId, input.locationId, input.accessMode, input.userId],
    );
    return (await this.getAttachment(input.spaceId, input.sessionId, id))!;
  }

  async setAttachmentAccess(spaceId: string, sessionId: string, attachmentId: string, accessMode: ConversationAttachmentAccessMode): Promise<ExecutionAttachmentRow | null> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE conversation_folder_access_grants
          SET access_mode = $4, updated_at = now()
        WHERE id = $1 AND space_id = $2 AND session_id = $3 AND status = 'active'
        RETURNING id`,
      [attachmentId, spaceId, sessionId, accessMode],
    );
    return result.rows[0] ? this.getAttachment(spaceId, sessionId, attachmentId) : null;
  }

  async revokeAttachment(spaceId: string, sessionId: string, attachmentId: string, userId: string): Promise<ExecutionAttachmentRow | null> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE conversation_folder_access_grants
          SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $4, updated_at = now()
        WHERE id = $1 AND space_id = $2 AND session_id = $3 AND status = 'active'
        RETURNING id`,
      [attachmentId, spaceId, sessionId, userId],
    );
    return result.rows[0] ? this.getAttachment(spaceId, sessionId, attachmentId) : null;
  }

  async latestRunId(spaceId: string, sessionId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM runs WHERE space_id = $1 AND session_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [spaceId, sessionId],
    );
    return result.rows[0]?.id ?? null;
  }
}

export function hostIsOnline(host: Pick<ExecutionHostRow, "kind" | "status" | "last_heartbeat_at">): boolean {
  return host.kind === "server" || (host.status === "online" && !isStale(host.last_heartbeat_at));
}

export function hostSummary(host: ExecutionHostRow, sessionId: string): ConversationExecutionHostSummary {
  return {
    host_id: host.id,
    host_name: host.name,
    host_kind: host.kind,
    online: hostIsOnline(host),
    managed_workspace_available: hostIsOnline(host) || hasConversationWorkspace(host.managed_workspaces_json, sessionId),
    daemon_last_heartbeat_at: host.last_heartbeat_at ? dateIso(host.last_heartbeat_at) : null,
  };
}

export function hasConversationWorkspace(value: unknown, sessionId: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => item && typeof item === "object"
    && (item as Record<string, unknown>).container_kind === "conversation"
    && (item as Record<string, unknown>).container_id === sessionId);
}

export function attachmentSummary(row: ExecutionAttachmentRow): ConversationAttachmentSummary {
  return {
    id: row.id,
    project_folder_id: row.project_folder_id,
    workspace_location_id: row.workspace_location_id,
    folder_name: row.folder_name,
    display_path: row.display_path,
    access_mode: row.access_mode,
    status: row.status,
    granted_by_user_id: row.granted_by_user_id,
    granted_at: dateIso(row.granted_at),
    updated_at: dateIso(row.updated_at),
    revoked_at: row.revoked_at ? dateIso(row.revoked_at) : null,
  };
}

export function primarySummary(
  context: Pick<ExecutionContextRow, "primary_workspace_mode" | "primary_project_folder_id" | "primary_workspace_location_id">,
  location: ExecutionLocationRow | null,
  sessionId: string,
): ConversationPrimarySummary | null {
  if (context.primary_workspace_mode === "managed") {
    return { kind: "managed", managed_workspace_id: sessionId, display_path: null };
  }
  if (context.primary_workspace_mode === "location" && context.primary_project_folder_id && context.primary_workspace_location_id) {
    return {
      kind: "location",
      project_folder_id: context.primary_project_folder_id,
      workspace_location_id: context.primary_workspace_location_id,
      display_path: location?.display_path ?? null,
    };
  }
  return null;
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}
