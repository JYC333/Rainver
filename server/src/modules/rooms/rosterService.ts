import type { RoomDetail } from "@rainver/protocol";
import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool.js";
import { HttpError, withDbTransaction } from "../routeUtils/common.js";
import {
  assertProjectReadable,
  assertProjectWriter,
  canWriteProject,
} from "../projects/access.js";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";
import { projectReadAccessSql } from "../access/contentAccessSql.js";
import { PgAgentRepository, type AgentCreateInput } from "../agents/repository.js";
import {
  PgRoomRepository,
  type RoomRecord,
} from "./repository.js";
import {
  PgRoomRosterRepository,
  type RoomInvitationApprovalRecord,
  type RoomInvitationRecord,
} from "./rosterRepository.js";
import { listRoomAgentPresets, roomAgentPresetById } from "./presets.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";
import { PgSessionRepository } from "../sessions/repository.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RoomIdentity {
  spaceId: string;
  userId: string;
}

export class RoomRosterService {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
  ) {}

  static fromConfig(config: ServerConfig): RoomRosterService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new RoomRosterService(config, getDbPool(config.databaseUrl));
  }

  async listAgentCandidates(identity: RoomIdentity, roomId: string, input: {
    limit: number;
    offset: number;
  }) {
    const room = await this.requireRoomMember(identity, roomId);
    const candidates = await new PgRoomRosterRepository(this.pool).listAgentCandidates({
      space_id: identity.spaceId,
      user_id: identity.userId,
      room_id: room.id,
      limit: input.limit,
      offset: input.offset,
    });
    return {
      agents: candidates.items,
      presets: listRoomAgentPresets().map(({ preset_id, name, description }) => ({ preset_id, name, description })),
      total: candidates.total,
      limit: input.limit,
      offset: input.offset,
    };
  }

  async addExistingAgent(identity: RoomIdentity, roomId: string, input: {
    agent_id: string;
    share_private_with_member_ids?: string[];
    confirm_room_share?: boolean;
    restore_workspace?: boolean;
  }) {
    const transactionResult = await this.withRoomWriter(identity, roomId, async (client, room) => {
      let restoreTarget: { hostId: string; agentId: string; roomId: string } | null = null;
      const repository = new PgRoomRosterRepository(client);
      const agent = await repository.getAgentForAdd({
        space_id: identity.spaceId,
        user_id: identity.userId,
        room_id: room.id,
        agent_id: input.agent_id,
        lock: true,
      });
      if (!agent) throw new HttpError(404, "Agent not found in this Room's Project");
      if (agent.agent_kind === "system_assistant") {
        throw new HttpError(409, "The managed Room Assistant cannot be added as a specialist");
      }
      const member = await repository.getAgentMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agent.id,
        lock: true,
      });
      if (member?.role === "manager") {
        throw managedRoomAgentImmutable();
      }
      // Re-adding an already active specialist is a state-idempotent no-op.
      // In particular, it must not invalidate pending invitation snapshots.
      if (member?.status === "active") {
        const restoreTarget = input.restore_workspace === true
          ? await findManagedWorkspaceRestoreTarget(client, identity.spaceId, agent.id, room.id, identity.userId)
          : null;
        return { detail: await this.roomDetail(client, identity, room.id), restoreTarget };
      }
      const activeUsers = await repository.activeMemberIds(identity.spaceId, room.id);
      const requestedGrantees = uniqueIds(input.share_private_with_member_ids ?? []);
      if (agent.visibility !== "space_shared") {
        if (agent.owner_user_id !== identity.userId) {
          throw new HttpError(404, "Agent not found in this Room's Project");
        }
        const requiredGrantees = activeUsers.filter((userId) => userId !== identity.userId).sort();
        if (!sameIds(requestedGrantees, requiredGrantees)
          || (requiredGrantees.length > 0 && input.confirm_room_share !== true)) {
          throw new HttpError(409, "Confirm Room-only sharing for the displayed private-Agent members", {
            code: "private_agent_share_confirmation_required",
            detail: "This private Agent stays private outside the Room. Confirm the exact Room members who will receive a Room-only grant.",
            agent_id: agent.id,
            member_ids: requiredGrantees,
          });
        }
      }
      await repository.upsertSpecialistMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agent.id,
      });
      if (input.restore_workspace === true) {
        restoreTarget = await findManagedWorkspaceRestoreTarget(
          client,
          identity.spaceId,
          agent.id,
          room.id,
          identity.userId,
        );
      }
      if (agent.visibility !== "space_shared") {
        for (const userId of requestedGrantees) {
          await repository.grantPrivateAgent({
            space_id: identity.spaceId,
            room_id: room.id,
            agent_id: agent.id,
            grantee_user_id: userId,
            granted_by_user_id: identity.userId,
          });
        }
      }
      await repository.incrementRosterRevision(identity.spaceId, room.id);
      return {
        detail: await this.roomDetail(client, identity, room.id),
        restoreTarget,
      };
    });
    const { detail: result, restoreTarget } = transactionResult;
    if (!restoreTarget) return result;
    const restored = await sharedHostConnectionRegistry.requestManagedWorkspaceAction(
      restoreTarget.hostId,
      "managed_workspace_restore",
      {
        agent_id: restoreTarget.agentId,
        container_kind: "room",
        container_id: restoreTarget.roomId,
      },
    );
    return { ...result, managed_workspace_restore: restored };
  }

  async addPresetAgent(identity: RoomIdentity, roomId: string, input: {
    preset_id: string;
    name?: string | null;
    idempotency_key?: string | null;
    confirm_room_share?: boolean;
    execution?: {
      host_id: string;
      workspace_location_id: string;
      adapter_type: string;
      installation: string;
    } | null;
  }) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      const preset = roomAgentPresetById(input.preset_id);
      if (!preset) throw new HttpError(404, `Room Agent preset '${input.preset_id}' not found`);
      const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key);
      const fingerprint = idempotencyKey
        ? createHash("sha256").update(JSON.stringify({
          preset_id: input.preset_id,
          name: input.name?.trim() ?? null,
          execution: input.execution ?? null,
        })).digest("hex")
        : null;
      if (idempotencyKey && fingerprint) {
        const prior = await client.query<{ request_fingerprint: string; agent_id: string }>(
          `SELECT request_fingerprint, agent_id
             FROM room_agent_preset_idempotencies
            WHERE space_id = $1 AND user_id = $2 AND room_id = $3 AND idempotency_key = $4
            FOR UPDATE`,
          [identity.spaceId, identity.userId, room.id, idempotencyKey],
        );
        const existing = prior.rows[0];
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) {
            throw new HttpError(409, "Idempotency-Key was already used with different preset parameters");
          }
          return this.roomDetail(client, identity, room.id);
        }
      }
      const roster = new PgRoomRosterRepository(client);
      const activeUsers = await roster.activeMemberIds(identity.spaceId, room.id);
      const sharedMemberIds = activeUsers.filter((userId) => userId !== identity.userId);
      if (sharedMemberIds.length > 0 && input.confirm_room_share !== true) {
        throw new HttpError(409, "Confirm Room-only sharing for this preset Agent", {
          code: "private_agent_share_confirmation_required",
          detail: "This preset creates a private Agent owned by you and shares it with current Room members only.",
          member_ids: sharedMemberIds,
        });
      }
      const agentRepository = new PgAgentRepository(this.pool, this.config);
      const runtimeProfiles = input.execution
        ? []
        : await this.presetRuntimeProfiles(client, identity.spaceId, room.id);
      const primaryProfile = runtimeProfiles[0];
      if (!primaryProfile && !input.execution) {
        throw new HttpError(409, "Room has no executable backend for preset Agents", {
          code: "conversation_backend_required",
          detail: "Configure an eligible API or CLI backend before adding a preset specialist.",
          setup_targets: ["model_providers", "cli_credentials"],
        });
      }
      const agentInput: AgentCreateInput = {
        spaceId: identity.spaceId,
        projectId: input.execution ? room.project_id : null,
        userId: identity.userId,
        ownerUserId: identity.userId,
        name: input.name?.trim() || preset.name,
        description: preset.description,
        visibility: "private",
        roleInstruction: preset.role_instruction,
        systemPrompt: preset.system_prompt,
        adapterType: input.execution?.adapter_type ?? primaryProfile!.adapter_type,
        defaultModelProviderId: input.execution ? null : primaryProfile!.model_provider_id,
        defaultModel: input.execution ? null : primaryProfile!.model_name,
        runtimeToolVersion: input.execution ? null : primaryProfile!.runtime_tool_version,
        runtimeConfigJson: input.execution ? {} : primaryProfile!.runtime_config_json,
        runtimePolicyJson: input.execution
          ? { default_adapter_type: input.execution.adapter_type }
          : primaryProfile!.runtime_policy_json,
        capabilitiesJson: [],
        toolPermissionsJson: {},
        executionHostId: input.execution?.host_id ?? null,
        workspaceLocationId: input.execution?.workspace_location_id ?? null,
        runtimeInstallation: input.execution?.installation ?? null,
      };
      const agent = await agentRepository.createInTransaction(client, agentInput);
      for (const profile of runtimeProfiles) {
        await agentRepository.ensureRuntimeProfileInTransaction(client, identity.spaceId, agent.id, {
          name: profile.name,
          adapterType: profile.adapter_type,
          modelProviderId: profile.model_provider_id,
          modelName: profile.model_name,
          runtimeConfigJson: profile.runtime_config_json,
          runtimePolicyJson: profile.runtime_policy_json,
          isDefault: profile.is_default,
          runtimeToolVersion: profile.runtime_tool_version,
        });
      }
      await roster.upsertSpecialistMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agent.id,
      });
      for (const userId of activeUsers.filter((userId) => userId !== identity.userId)) {
        await roster.grantPrivateAgent({
          space_id: identity.spaceId,
          room_id: room.id,
          agent_id: agent.id,
          grantee_user_id: userId,
          granted_by_user_id: identity.userId,
        });
      }
      await roster.incrementRosterRevision(identity.spaceId, room.id);
      if (idempotencyKey && fingerprint) {
        await client.query(
          `INSERT INTO room_agent_preset_idempotencies (
             id, space_id, user_id, room_id, idempotency_key,
             request_fingerprint, agent_id, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
          [randomUUID(), identity.spaceId, identity.userId, room.id, idempotencyKey, fingerprint, agent.id],
        );
      }
      return this.roomDetail(client, identity, room.id);
    });
  }

  async removeAgent(identity: RoomIdentity, roomId: string, agentId: string) {
    const transactionResult = await this.withRoomWriter(identity, roomId, async (client, room) => {
      const repository = new PgRoomRosterRepository(client);
      const member = await repository.getAgentMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agentId,
        lock: true,
      });
      if (!member) throw new HttpError(404, "Room Agent member not found");
      if (member.role === "manager") throw managedRoomAgentImmutable();
      const threadRepository = new PgHostThreadRepository(client);
      const thread = await threadRepository.getForRoomAgent(room.id, agentId);
      const archiveTarget = thread?.workspace_mode === "managed" && thread.execution_host_id
        ? { threadId: thread.id, hostId: thread.execution_host_id, agentId, roomId: room.id }
        : null;
      if (member.status === "active") {
        await client.query(
          `UPDATE room_agent_members
              SET status = 'removed', updated_at = now()
            WHERE space_id = $1 AND room_id = $2 AND agent_id = $3`,
          [identity.spaceId, room.id, agentId],
        );
        await repository.incrementRosterRevision(identity.spaceId, room.id);
      }
      await threadRepository.closeRoomAgent(room.id, agentId, Boolean(archiveTarget));
      const revokedGrantCount = await repository.revokeAgentGrants({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agentId,
        revoked_by_user_id: identity.userId,
      });
      return {
        detail: {
          ...(await this.roomDetail(client, identity, room.id)),
          revoked_grant_count: revokedGrantCount,
        },
        archiveTarget,
      };
    });
    const { detail: result, archiveTarget } = transactionResult;
    if (!archiveTarget) return result;
    const archived = await sharedHostConnectionRegistry.requestManagedWorkspaceAction(
      archiveTarget.hostId,
      "managed_workspace_archive",
      {
        agent_id: archiveTarget.agentId,
        container_kind: "room",
        container_id: archiveTarget.roomId,
      },
    );
    if (archived.ok) {
      await new PgHostThreadRepository(this.pool)
        .acknowledgeManagedWorkspaceArchive(archiveTarget.threadId)
        .catch(() => undefined);
    }
    return { ...result, managed_workspace_archive: archived };
  }

  async resetAgentContext(identity: RoomIdentity, roomId: string, agentId: string) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      const thread = await client.query<{
        id: string;
        host_owner_user_id: string | null;
        agent_name: string;
        dispatch_lock_id: string | null;
      }>(
        `SELECT thread.id, host.owner_user_id AS host_owner_user_id, agent.name AS agent_name,
                thread.dispatch_lock_id
           FROM host_threads thread
           JOIN workspace_locations location ON location.id = thread.workspace_location_id
           JOIN hosts host ON host.id = location.execution_host_id
           JOIN agents agent ON agent.id = thread.agent_id
          WHERE thread.room_id = $1 AND thread.agent_id = $2
            AND thread.status IN ('active', 'session_reset')
          LIMIT 1
          FOR UPDATE`,
        [room.id, agentId],
      );
      const current = thread.rows[0];
      if (!current) throw new HttpError(404, "Host-bound Room Agent thread not found");
      if (current.host_owner_user_id !== identity.userId) {
        throw new HttpError(403, "Only the execution host owner can reset this Agent's context");
      }
      if (current.dispatch_lock_id) {
        throw new HttpError(409, "The Host-bound Agent is still handling a Room turn; reset its context after it finishes");
      }
      const reset = await new PgHostThreadRepository(client).resetRoomAgent(room.id, agentId);
      if (!reset) throw new HttpError(409, "Host Agent context changed before it could be reset");
      const session = await client.query<{ id: string }>(
        `SELECT id
           FROM sessions
          WHERE space_id = $1 AND room_id = $2 AND status = 'active'
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT 1`,
        [identity.spaceId, room.id],
      );
      if (session.rows[0]) {
        await new PgSessionRepository(client).addRoomSystemNotice(
          identity.spaceId,
          identity.userId,
          room.id,
          session.rows[0].id,
          {
            content: `${current.agent_name}'s context was reset`,
            metadata: {
              room_id: room.id,
              host_thread_id: reset.id,
              host_thread_event: "session_reset",
              host_thread_reset_reason: "explicit",
            },
          },
        );
      }
      return this.roomDetail(client, identity, room.id);
    });
  }

  async inviteUser(identity: RoomIdentity, roomId: string, input: {
    user_id: string;
    confirm_owned_private_agent_shares?: boolean;
  }) {
    try {
      return await this.withRoomWriter(identity, roomId, async (client, room) => {
        await assertActiveSpaceUser(client, identity.spaceId, input.user_id);
        await assertProjectReadable(client, identity.spaceId, room.project_id, input.user_id);
        const existingMember = await client.query<{ status: string }>(
          `SELECT status FROM room_user_members
            WHERE space_id = $1 AND room_id = $2 AND user_id = $3
            FOR UPDATE`,
          [identity.spaceId, room.id, input.user_id],
        );
        if (existingMember.rows[0]?.status === "active") {
          throw new HttpError(409, "User is already an active Room member");
        }
        const roster = new PgRoomRosterRepository(client);
        const prior = await client.query<RoomInvitationRecord>(
          `SELECT id, space_id, room_id, invitee_user_id, invited_by_user_id, status,
                  required_roster_revision::int AS required_roster_revision,
                  expires_at, created_at, updated_at, resolved_at
             FROM room_user_invitations
            WHERE space_id = $1 AND room_id = $2 AND invitee_user_id = $3 AND status = 'pending'
            FOR UPDATE`,
          [identity.spaceId, room.id, input.user_id],
        );
        if (prior.rows[0]) {
          if (
            new Date(prior.rows[0].expires_at).getTime() > Date.now()
            && Number(prior.rows[0].required_roster_revision) === Number(room.roster_revision)
          ) {
            return this.invitationResponse(client, identity, prior.rows[0]);
          }
          if (new Date(prior.rows[0].expires_at).getTime() > Date.now()) {
            await roster.invalidateApprovals(identity.spaceId, prior.rows[0].id);
          }
          await roster.updateInvitationStatus({
            space_id: identity.spaceId,
            invitation_id: prior.rows[0].id,
            status: new Date(prior.rows[0].expires_at).getTime() > Date.now() ? "invalidated" : "expired",
          });
        }
        const privateAgents = await roster.listPrivateRoster({ space_id: identity.spaceId, room_id: room.id });
        const inviterOwned = privateAgents.filter((agent) => agent.owner_user_id === identity.userId);
        if (inviterOwned.length > 0 && input.confirm_owned_private_agent_shares !== true) {
          throw new HttpError(409, "Confirm Room-only sharing for private Agents you own", {
            code: "private_agent_share_confirmation_required",
            detail: "Inviting this user will share your private specialists inside this Room only.",
            agent_ids: inviterOwned.map((agent) => agent.agent_id).sort(),
            member_ids: [input.user_id],
          });
        }
        const invitation = await roster.createInvitation({
          space_id: identity.spaceId,
          room_id: room.id,
          invitee_user_id: input.user_id,
          invited_by_user_id: identity.userId,
          required_roster_revision: room.roster_revision,
          expires_at: new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
        });
        for (const privateAgent of privateAgents) {
          await roster.createApproval({
            space_id: identity.spaceId,
            invitation_id: invitation.id,
            agent_id: privateAgent.agent_id,
            owner_user_id: privateAgent.owner_user_id,
          });
          if (privateAgent.owner_user_id === identity.userId) {
            await client.query(
              `UPDATE room_invitation_agent_approvals
                  SET status = 'approved', decided_at = now(), updated_at = now()
                WHERE space_id = $1 AND invitation_id = $2 AND agent_id = $3`,
              [identity.spaceId, invitation.id, privateAgent.agent_id],
            );
          }
        }
        const approvals = await roster.listApprovals(identity.spaceId, invitation.id, true);
        const activated = approvals.every((approval) => approval.status === "approved");
        const result = activated
          ? await this.activateInvitation(client, identity, invitation, approvals)
          : invitation;
        return this.invitationResponse(client, identity, result);
      });
    } catch (error) {
      await this.persistInvitationInvalidation(identity, error);
      throw error;
    }
  }

  async listInvitations(identity: RoomIdentity, roomId: string, input: { limit: number; offset: number }) {
    const room = await new PgRoomRepository(this.pool).getRoomById(identity.spaceId, roomId);
    if (!room || room.status !== "active") throw new HttpError(404, "Room not found in this space");
    return withDbTransaction(this.pool, async (client) => {
      await assertActiveSpaceUser(client, identity.spaceId, identity.userId);
      await assertProjectReadable(client, identity.spaceId, room.project_id, identity.userId);
      const repository = new PgRoomRosterRepository(client);
      const page = await repository.listInvitations({
        space_id: identity.spaceId,
        room_id: roomId,
        user_id: identity.userId,
        limit: input.limit,
        offset: input.offset,
      });
      const items = [];
      for (const invitation of page.items) {
        items.push(await this.invitationResponse(client, identity, invitation));
      }
      return { items, total: page.total, limit: input.limit, offset: input.offset };
    });
  }

  async listPendingApprovals(identity: RoomIdentity, input: { limit: number; offset: number }) {
    const activeSpaceUser = await this.pool.query(
      `SELECT 1 FROM space_memberships
        WHERE space_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
      [identity.spaceId, identity.userId],
    );
    if (!activeSpaceUser.rows[0]) throw new HttpError(404, "User is not an active member of this Space");
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    const offset = Math.max(0, Math.floor(input.offset));
    const [items, total] = await Promise.all([
      this.pool.query(
        `SELECT invitation.id AS invitation_id, room.id AS room_id, room.title AS room_title,
                project.id AS project_id, project.name AS project_name,
                invitation.invitee_user_id, invitee.display_name AS invitee_display_name,
                invitee.email AS invitee_email, agent.id AS agent_id, agent.name AS agent_name,
                invitation.expires_at
           FROM room_invitation_agent_approvals approval
           JOIN room_user_invitations invitation
             ON invitation.id=approval.invitation_id AND invitation.space_id=approval.space_id
           JOIN rooms room
             ON room.id=invitation.room_id AND room.space_id=invitation.space_id
           JOIN projects project
             ON project.id=room.project_id AND project.space_id=room.space_id
            AND project.deleted_at IS NULL
           JOIN users invitee ON invitee.id=invitation.invitee_user_id
           JOIN agents agent ON agent.id=approval.agent_id AND agent.space_id=approval.space_id
          WHERE approval.space_id=$1 AND approval.owner_user_id=$2
            AND approval.status='pending' AND invitation.status='pending'
            AND invitation.expires_at > now()
            AND room.status='active'
            AND agent.status='active' AND agent.visibility <> 'space_shared'
            AND ${projectReadAccessSql("project.space_id", "project.id", "$2")}
          ORDER BY invitation.expires_at ASC, invitation.created_at ASC, approval.agent_id ASC
          LIMIT $3 OFFSET $4`,
        [identity.spaceId, identity.userId, limit, offset],
      ),
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM room_invitation_agent_approvals approval
           JOIN room_user_invitations invitation
             ON invitation.id=approval.invitation_id AND invitation.space_id=approval.space_id
           JOIN rooms room ON room.id=invitation.room_id AND room.space_id=invitation.space_id
           JOIN projects project ON project.id=room.project_id AND project.space_id=room.space_id
            AND project.deleted_at IS NULL
           JOIN agents agent ON agent.id=approval.agent_id AND agent.space_id=approval.space_id
          WHERE approval.space_id=$1 AND approval.owner_user_id=$2
            AND approval.status='pending' AND invitation.status='pending'
            AND invitation.expires_at > now() AND room.status='active'
            AND agent.status='active' AND agent.visibility <> 'space_shared'
            AND ${projectReadAccessSql("project.space_id", "project.id", "$2")}`,
        [identity.spaceId, identity.userId],
      ),
    ]);
    return { items: items.rows, total: Number(total.rows[0]?.count ?? 0), limit, offset };
  }

  async decideInvitation(identity: RoomIdentity, roomId: string, invitationId: string, input: {
    agent_id: string;
    decision: "approved" | "rejected";
  }) {
    try {
      return await withDbTransaction(this.pool, async (client) => {
        // Every invitation mutation takes the Room lock before the invitation
        // lock. This matches inviteUser and prevents Room↔invitation deadlocks
        // under concurrent approvals and invitations.
        const room = await new PgRoomRepository(client).getRoomById(identity.spaceId, roomId, true);
        if (!room || room.status !== "active") throw new HttpError(404, "Room invitation not found");
        const roster = new PgRoomRosterRepository(client);
        const invitation = await roster.getInvitation({
          space_id: identity.spaceId,
          invitation_id: invitationId,
          lock: true,
        });
        if (!invitation || invitation.room_id !== roomId) throw new HttpError(404, "Room invitation not found");
        const approvals = await roster.listApprovals(identity.spaceId, invitation.id, true);
        await assertActiveSpaceUser(client, identity.spaceId, identity.userId);
        await assertProjectReadable(client, identity.spaceId, room.project_id, identity.userId);
        const isAuthorized = invitation.invited_by_user_id === identity.userId
          || invitation.invitee_user_id === identity.userId
          || approvals.some((approval) => approval.owner_user_id === identity.userId);
        if (!isAuthorized) throw new HttpError(404, "Room invitation not found");
        if (invitation.status !== "pending") return this.invitationResponse(client, identity, invitation);
        if (new Date(invitation.expires_at).getTime() <= Date.now()) {
          const expired = await roster.updateInvitationStatus({
            space_id: identity.spaceId,
            invitation_id: invitation.id,
            status: "expired",
          });
          return this.invitationResponse(client, identity, expired ?? invitation);
        }
        const visibleRoom = await new PgRoomRepository(client).getVisibleRoom(identity.spaceId, identity.userId, roomId, true);
        const approval = approvals
          .find((candidate) => candidate.agent_id === input.agent_id && candidate.owner_user_id === identity.userId);
        if (!approval) {
          if (!visibleRoom) throw new HttpError(404, "Room invitation not found");
          throw new HttpError(403, "Only the owner of the private Agent may decide this approval");
        }
        if (approval.status !== "pending") return this.invitationResponse(client, identity, invitation);
        const updatedApproval = await roster.updateApproval({
          space_id: identity.spaceId,
          invitation_id: invitation.id,
          agent_id: input.agent_id,
          owner_user_id: identity.userId,
          status: input.decision,
        });
        if (!updatedApproval) return this.invitationResponse(client, identity, invitation);
        if (input.decision === "rejected") {
          const rejected = await roster.updateInvitationStatus({
            space_id: identity.spaceId,
            invitation_id: invitation.id,
            status: "rejected",
          });
          return this.invitationResponse(client, identity, rejected ?? invitation);
        }
        const updatedApprovals = await roster.listApprovals(identity.spaceId, invitation.id, true);
        const current = await roster.getInvitation({ space_id: identity.spaceId, invitation_id: invitation.id, lock: true });
        if (!current) throw new HttpError(404, "Room invitation not found");
        if (updatedApprovals.some((candidate) => candidate.status === "rejected")) {
          const rejected = await roster.updateInvitationStatus({ space_id: identity.spaceId, invitation_id: invitation.id, status: "rejected" });
          return this.invitationResponse(client, identity, rejected ?? current);
        }
        if (updatedApprovals.every((candidate) => candidate.status === "approved")) {
          const activated = await this.activateInvitation(client, identity, current, updatedApprovals);
          return this.invitationResponse(client, identity, activated);
        }
        return this.invitationResponse(client, identity, current);
      });
    } catch (error) {
      await this.persistInvitationInvalidation(identity, error);
      throw error;
    }
  }

  async removeUser(identity: RoomIdentity, roomId: string, userId: string) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      if (userId === identity.userId) {
        throw new HttpError(409, "Room members cannot remove themselves through the owner-managed removal endpoint");
      }
      // Mainline membership is Project membership. Removing someone here would
      // only last until they next open the Project; the honest place to remove
      // them is the Project itself.
      if (room.is_mainline) throw new HttpError(409, "room_mainline_membership_follows_project", {
        code: "room_mainline_membership_follows_project",
        detail: "Every Project member belongs to the Project's mainline Room. Remove them from the Project instead.",
      });
      const roster = new PgRoomRosterRepository(client);
      const member = await roster.lockUserMember(identity.spaceId, room.id, userId);
      if (!member || member.status !== "active") throw new HttpError(404, "Room member not found");
      if (member.role === "owner") throw new HttpError(409, "room_owner_transfer_required", {
        code: "room_owner_transfer_required",
        detail: "Transfer Room ownership before removing the current owner.",
      });
      await client.query(
        `UPDATE room_user_members
            SET status = 'removed', updated_at = now()
          WHERE space_id = $1 AND room_id = $2 AND user_id = $3`,
        [identity.spaceId, room.id, userId],
      );
      const revokedGrantCount = await roster.revokeUserGrants({
        space_id: identity.spaceId,
        room_id: room.id,
        user_id: userId,
        revoked_by_user_id: identity.userId,
      });
      await roster.incrementRosterRevision(identity.spaceId, room.id);
      return { ...(await this.roomDetail(client, identity, room.id)), revoked_grant_count: revokedGrantCount };
    });
  }

  async transferOwner(identity: RoomIdentity, roomId: string, targetUserId: string) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      const currentOwner = await this.currentOwner(client, room.id);
      if (currentOwner === targetUserId) return this.roomDetail(client, identity, room.id);
      if (currentOwner !== identity.userId) throw new HttpError(403, "Only the current Room owner may transfer ownership");
      await assertProjectWriter(client, identity.spaceId, room.project_id, targetUserId);
      const rows = await client.query<{ user_id: string; role: string; status: string }>(
        `SELECT user_id, role, status FROM room_user_members
          WHERE space_id = $1 AND room_id = $2 AND user_id = ANY($3::varchar[])
          ORDER BY user_id ASC FOR UPDATE`,
        [identity.spaceId, room.id, [identity.userId, targetUserId]],
      );
      const target = rows.rows.find((candidate) => candidate.user_id === targetUserId);
      if (!target || target.status !== "active") throw new HttpError(409, "Ownership target must be an active Room member");
      if (targetUserId === identity.userId) return this.roomDetail(client, identity, room.id);
      await client.query(
        `UPDATE room_user_members
            SET role = 'member', updated_at = now()
          WHERE space_id = $1 AND room_id = $2 AND user_id = $3 AND role = 'owner' AND status = 'active'`,
        [identity.spaceId, room.id, identity.userId],
      );
      await client.query(
        `UPDATE room_user_members
            SET role = 'owner', updated_at = now()
          WHERE space_id = $1 AND room_id = $2 AND user_id = $3 AND status = 'active'`,
        [identity.spaceId, room.id, targetUserId],
      );
      await new PgRoomRosterRepository(client).incrementRosterRevision(identity.spaceId, room.id);
      return this.roomDetail(client, identity, room.id);
    });
  }

  async claimOwner(identity: RoomIdentity, roomId: string) {
    return withDbTransaction(this.pool, async (client) => {
      const rooms = new PgRoomRepository(client);
      const room = await rooms.getRoomById(identity.spaceId, roomId, true);
      if (!room || room.status !== "active") throw new HttpError(404, "Room not found in this space");
      await assertActiveSpaceUser(client, identity.spaceId, identity.userId);
      const projectAuthority = await client.query<{ owner_user_id: string | null; role: string | null }>(
        `SELECT project.owner_user_id, membership.role
           FROM projects project
           LEFT JOIN space_memberships membership
             ON membership.space_id = project.space_id
            AND membership.user_id = $3
            AND membership.status = 'active'
          WHERE project.space_id = $1 AND project.id = $2 AND project.deleted_at IS NULL`,
        [identity.spaceId, room.project_id, identity.userId],
      );
      const authority = projectAuthority.rows[0];
      const canClaim = Boolean(
        authority
        && (authority.owner_user_id === identity.userId || isSpaceOwnerOrAdmin(authority.role)),
      );
      if (!authority || !canClaim) {
        throw new HttpError(403, "Only the Project owner or Space owner/admin may claim a suspended Room");
      }
      const currentOwnerId = await this.currentOwner(client, room.id);
      if (currentOwnerId && await canWriteProject(client, identity.spaceId, room.project_id, currentOwnerId)) {
        throw new HttpError(409, "Room ownership is not suspended");
      }
      const roster = new PgRoomRosterRepository(client);
      await roster.lockUserMember(identity.spaceId, room.id, currentOwnerId ?? identity.userId);
      if (currentOwnerId && currentOwnerId !== identity.userId) {
        // Clear the partial unique owner index before promoting the claimant.
        await client.query(
          `UPDATE room_user_members
              SET role = 'member', updated_at = now()
            WHERE space_id = $1 AND room_id = $2 AND user_id = $3 AND role = 'owner' AND status = 'active'`,
          [identity.spaceId, room.id, currentOwnerId],
        );
      }
      await client.query(
        `INSERT INTO room_user_members (
           id, space_id, room_id, user_id, role, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'owner', 'active', now(), now())
         ON CONFLICT (room_id, user_id)
         DO UPDATE SET role = 'owner', status = 'active', updated_at = now()`,
        [randomUUID(), identity.spaceId, room.id, identity.userId],
      );
      // Same reason as on invitation: a claimant is a second person.
      await new PgRoomRepository(client).clearPersonalMarker(identity.spaceId, room.id);
      await roster.incrementRosterRevision(identity.spaceId, room.id);
      return this.roomDetail(client, identity, room.id);
    });
  }

  private async activateInvitation(
    client: PoolClient,
    identity: RoomIdentity,
    invitation: RoomInvitationRecord,
    approvals: RoomInvitationApprovalRecord[],
  ): Promise<RoomInvitationRecord> {
    const rooms = new PgRoomRepository(client);
    const room = await rooms.getRoomById(identity.spaceId, invitation.room_id, true);
    if (!room || room.status !== "active") throw new HttpError(404, "Room invitation not found");
    if (Number(room.roster_revision) !== Number(invitation.required_roster_revision)) {
      throw new HttpError(409, "The Room roster changed; recreate the invitation", {
        code: "invitation_snapshot_stale",
        invitation_id: invitation.id,
        detail: "The invitation's private-Agent approvals were based on an older Room roster.",
      });
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      return (await new PgRoomRosterRepository(client).updateInvitationStatus({
        space_id: identity.spaceId,
        invitation_id: invitation.id,
        status: "expired",
      })) ?? invitation;
    }
    await assertActiveSpaceUser(client, identity.spaceId, invitation.invitee_user_id);
    await assertProjectReadable(client, identity.spaceId, room.project_id, invitation.invitee_user_id);
    const roster = new PgRoomRosterRepository(client);
    const currentPrivate = await roster.listPrivateRoster({ space_id: identity.spaceId, room_id: room.id });
    const currentIds = currentPrivate.map((agent) => agent.agent_id).sort();
    const approvedIds = approvals.map((approval) => approval.agent_id).sort();
    const currentOwners = new Map(currentPrivate.map((agent) => [agent.agent_id, agent.owner_user_id]));
    if (
      !sameIds(currentIds, approvedIds)
      || approvals.some((approval) => approval.status !== "approved")
      || approvals.some((approval) => currentOwners.get(approval.agent_id) !== approval.owner_user_id)
    ) {
      throw new HttpError(409, "The private-Agent approval snapshot is stale", {
        code: "invitation_snapshot_stale",
        invitation_id: invitation.id,
        detail: "The active private specialist roster changed while this invitation was pending.",
      });
    }
    await client.query(
      `INSERT INTO room_user_members (
         id, space_id, room_id, user_id, role, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())
       ON CONFLICT (room_id, user_id)
       DO UPDATE SET role = 'member', status = 'active', updated_at = now()`,
      [randomUUID(), identity.spaceId, room.id, invitation.invitee_user_id],
    );
    // A Room whose audience is now two people is not personal to either, so it
    // stops being the one private continuation reuses. Clearing the marker is
    // cheaper than refusing the invitation and costs only a fresh Room next
    // time.
    await rooms.clearPersonalMarker(identity.spaceId, room.id);
    for (const agent of currentPrivate) {
      await roster.grantPrivateAgent({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agent.agent_id,
        grantee_user_id: invitation.invitee_user_id,
        granted_by_user_id: agent.owner_user_id,
      });
    }
    await roster.incrementRosterRevision(identity.spaceId, room.id);
    return (await roster.updateInvitationStatus({
      space_id: identity.spaceId,
      invitation_id: invitation.id,
      status: "active",
    })) ?? invitation;
  }

  private async invitationResponse(
    client: PoolClient,
    identity: RoomIdentity,
    invitation: RoomInvitationRecord,
  ) {
    const roster = new PgRoomRosterRepository(client);
    let current = invitation;
    if (current.status === "pending" && new Date(current.expires_at).getTime() <= Date.now()) {
      current = (await roster.updateInvitationStatus({
        space_id: identity.spaceId,
        invitation_id: current.id,
        status: "expired",
      })) ?? current;
    }
    const approvals = await roster.listApprovals(identity.spaceId, current.id);
    const publicApprovals = approvals.map((approval) => ({
      id: approval.id,
      agent_id: approval.agent_id,
      owner_user_id: approval.owner_user_id,
      status: approval.status,
      decided_at: approval.decided_at,
    }));
    const isPrimaryParty = current.invited_by_user_id === identity.userId
      || current.invitee_user_id === identity.userId;
    return {
      ...current,
      // A pending owner-only approver gets a narrow view of their own Agent
      // approval; the inviter/invitee can see the complete decision state.
      approvals: isPrimaryParty
        ? publicApprovals
        : publicApprovals.filter((approval) => approval.owner_user_id === identity.userId),
      can_decide: approvals.some((approval) => approval.owner_user_id === identity.userId && approval.status === "pending"),
    };
  }

  private async persistInvitationInvalidation(identity: RoomIdentity, error: unknown): Promise<void> {
    if (!(error instanceof HttpError) || !isInvitationSnapshotStale(error.responseBody)) return;
    const invitationId = error.responseBody.invitation_id;
    try {
      await withDbTransaction(this.pool, async (client) => {
        const roster = new PgRoomRosterRepository(client);
        await roster.invalidateApprovals(identity.spaceId, invitationId);
        await roster.updateInvitationStatus({
          space_id: identity.spaceId,
          invitation_id: invitationId,
          status: "invalidated",
        });
      });
    } catch {
      // Preserve the original stale-snapshot conflict. A failed cleanup is
      // safe to retry on the next decision and must not become a misleading
      // database error response to the caller.
    }
  }

  private async withRoomWriter<T>(
    identity: RoomIdentity,
    roomId: string,
    work: (client: PoolClient, room: RoomRecord) => Promise<T>,
  ): Promise<T> {
    return withDbTransaction(this.pool, async (client) => {
      const room = await new PgRoomRepository(client).getVisibleRoom(identity.spaceId, identity.userId, roomId, true);
      if (!room) throw new HttpError(404, "Room not found in this space");
      try {
        await assertProjectWriter(client, identity.spaceId, room.project_id, identity.userId);
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 403) {
          throw new HttpError(403, "Room mutation requires Project writer authority", {
            code: "project_write_required",
            detail: "Only a Project writer, Project owner, or Space owner/admin may mutate this Room.",
          });
        }
        throw error;
      }
      const member = await new PgRoomRosterRepository(client).lockUserMember(identity.spaceId, room.id, identity.userId);
      if (!member || member.status !== "active") throw new HttpError(403, "room_membership_required", {
        code: "room_membership_required",
        detail: "An active Room membership is required for this mutation.",
      });
      return work(client, room);
    });
  }

  private async requireRoomMember(identity: RoomIdentity, roomId: string): Promise<RoomRecord> {
    const room = await new PgRoomRepository(this.pool).getVisibleRoom(identity.spaceId, identity.userId, roomId);
    if (!room) throw new HttpError(404, "Room not found in this space");
    return room;
  }

  private async currentOwner(client: PoolClient, roomId: string): Promise<string | null> {
    const result = await client.query<{ user_id: string }>(
      `SELECT user_id FROM room_user_members
        WHERE room_id = $1 AND role = 'owner' AND status = 'active'
        LIMIT 1`,
      [roomId],
    );
    return result.rows[0]?.user_id ?? null;
  }

  private async presetRuntimeProfiles(client: PoolClient, spaceId: string, roomId: string): Promise<Array<{
    name: string;
    adapter_type: string;
    model_provider_id: string | null;
    model_name: string | null;
    runtime_config_json: Record<string, unknown>;
    runtime_policy_json: Record<string, unknown>;
    is_default: boolean;
    runtime_tool_version: string | null;
  }>> {
    const result = await client.query<{
      name: string;
      adapter_type: string;
      model_provider_id: string | null;
      model_name: string | null;
      runtime_config_json: Record<string, unknown>;
      runtime_policy_json: Record<string, unknown>;
      is_default: boolean;
    }>(
      `SELECT profile.name, profile.adapter_type, profile.model_provider_id,
              profile.model_name, profile.runtime_config_json,
              profile.runtime_policy_json, profile.is_default
         FROM room_agent_members member
         JOIN agent_runtime_profiles profile
           ON profile.space_id = member.space_id
          AND profile.agent_id = member.agent_id
          AND profile.enabled = true
        WHERE member.space_id = $1
          AND member.room_id = $2
          AND member.role = 'manager'
          AND member.status = 'active'
        ORDER BY CASE WHEN profile.adapter_type = 'model_api' THEN 0 ELSE 1 END,
                 profile.is_default DESC, profile.created_at ASC, profile.id ASC`,
      [spaceId, roomId],
    );
    return result.rows
      .filter((profile) => getRuntimeAdapterSpec(profile.adapter_type)?.implementation_status === "implemented")
      .map((profile) => ({
        ...profile,
        runtime_tool_version: isLocalCliRuntimeAdapter(profile.adapter_type)
          && typeof profile.runtime_config_json.runtime_tool_version === "string"
          ? profile.runtime_config_json.runtime_tool_version
          : null,
      }));
  }

  /**
   * Typed as `RoomDetail` on purpose. The schema is `.strict()` and every
   * field required, but nothing validates a response at runtime — so without
   * the annotation a missing field is invisible until a consumer reads
   * `undefined` and treats it as `false`, hiding every control.
   */
  private async roomDetail(
    client: PoolClient,
    identity: RoomIdentity,
    roomId: string,
  ): Promise<RoomDetail> {
    const repository = new PgRoomRepository(client);
    const room = await repository.getVisibleRoom(identity.spaceId, identity.userId, roomId);
    if (!room) throw new HttpError(404, "Room not found in this space");
    return {
      room,
      user_members: await repository.listUserMembers(identity.spaceId, room.id),
      agent_members: await repository.listAgentMembers(identity.spaceId, room.id, identity.userId),
      viewer_can_write: await canWriteProject(client, identity.spaceId, room.project_id, identity.userId),
      ...(await repository.audienceForViewer(identity.spaceId, room.id, identity.userId)),
    };
  }
}

async function findManagedWorkspaceRestoreTarget(
  client: PoolClient,
  spaceId: string,
  agentId: string,
  roomId: string,
  userId: string,
): Promise<{ hostId: string; agentId: string; roomId: string } | null> {
  const profile = await client.query<{
    host_id: string;
    managed_workspaces_json: unknown;
  }>(
    `SELECT profile.execution_host_id AS host_id, host.managed_workspaces_json
       FROM agent_runtime_profiles profile
       JOIN hosts host ON host.id = profile.execution_host_id
      WHERE profile.space_id = $1 AND profile.agent_id = $2
        AND profile.enabled = true AND profile.workspace_mode = 'managed'
        AND host.owner_user_id = $3 AND host.status <> 'revoked'
      ORDER BY profile.is_default DESC, profile.created_at ASC, profile.id ASC
      LIMIT 1`,
    [spaceId, agentId, userId],
  );
  const selected = profile.rows[0];
  const archived = Array.isArray(selected?.managed_workspaces_json)
    && selected.managed_workspaces_json.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return record.agent_id === agentId
        && record.container_kind === "room"
        && record.container_id === roomId
        && record.archived_available === true;
    });
  return selected && archived ? { hostId: selected.host_id, agentId, roomId } : null;
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 128) throw new HttpError(422, "Idempotency-Key must be at most 128 characters");
  return normalized;
}

function managedRoomAgentImmutable(): HttpError {
  return new HttpError(409, "The managed Room Assistant cannot be removed or replaced", {
    code: "managed_room_agent_immutable",
    detail: "The managed Space Assistant is the permanent Room manager.",
  });
}

function isInvitationSnapshotStale(value: unknown): value is { code: "invitation_snapshot_stale"; invitation_id: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { code?: unknown; invitation_id?: unknown };
  return candidate.code === "invitation_snapshot_stale" && typeof candidate.invitation_id === "string";
}

async function assertActiveSpaceUser(db: PoolClient, spaceId: string, userId: string): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1`,
    [spaceId, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "User is not an active member of this Space");
}
