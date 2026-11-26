import {publicRoom} from './repository.js';
import { lockProjectAudience } from "../projects/access.js";
import { PgConversationExecutionContextRepository } from "../sessions/executionContextRepository.js";
import { PgConversationBackendRepository } from "../sessions/conversationBackendRepository.js";
import { validateSessionConfig } from "../sessions/sessionConfig.js";
import { roomAgentGrantIssuerSql } from "./agentUsageSql.js";
import type { RoomAgentPresetRequest, RoomDetail } from "@rainver/protocol";
import { RoomMutationError } from "./roomMutationError.js";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import {
  assertProjectReadable,
  assertProjectWriter,
  canReadProject,
  canWriteProject,
} from "../projects/access.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
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
import { PgProjectAgentRepository } from "../projects/projectAgents.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { sendPendingManagedWorkspaceArchive } from "../hosts/managedWorkspaceOperations.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { latestSummaryArtifactId, loadHandoffText } from "../agentGroups/sessionHandoff.js";
import { roomAudience } from "./threadReferences.js";
import { freezeConversationAudiences, sharedConversationForInvitation } from "./conversationAudience.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RoomIdentity {
  spaceId: string;
  userId: string;
}

export class RoomRosterService {
  constructor(private readonly pool: Queryable) {}

  static fromConfig(config: ServerConfig): RoomRosterService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new RoomRosterService(getDbPool(config.databaseUrl));
  }

  async listAgentCandidates(identity: RoomIdentity, roomId: string, input: {
    limit: number;
    offset: number;
    q?: string | null;
    source_role_id?: string | null;
  }) {
    const room = await this.requireRoomMember(identity, roomId);
    const candidates = await new PgRoomRosterRepository(this.pool).listAgentCandidates({
      space_id: identity.spaceId,
      user_id: identity.userId,
      room_id: room.id,
      limit: input.limit,
      offset: input.offset,
      q: input.q ?? null,
      source_role_id: input.source_role_id ?? null,
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
      let restoreTarget: ManagedConversationRestoreTarget | null = null;
      const repository = new PgRoomRosterRepository(client);
      const agent = await repository.getAgentForAdd({
        space_id: identity.spaceId,
        user_id: identity.userId,
        room_id: room.id,
        agent_id: input.agent_id,
        lock: true,
      });
      if (!agent) throw new HttpError(404, "Agent not found in this Room's Project");
      // Sharing execution is an owner decision; the source Project ACL stays intact.
      const isolated = Boolean(agent.access_project_id && agent.access_project_id !== room.project_id);
      const requiresGrant = agent.visibility !== "space_shared" || isolated;
      if (isolated && agent.owner_user_id !== identity.userId) {
        throw new HttpError(404, "Agent not found in this Room's Project");
      }
      if (agent.agent_kind === "system_assistant") {
        throw new RoomMutationError(409, "The managed Room Assistant cannot be added as a specialist");
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
      // Re-adding an already active specialist leaves the roster as it is: no
      // roster_revision bump, so pending invitation snapshots stay valid. It
      // still completes the Project link, which a removal from the Project's
      // list (or a Room roster from before links existed) can have left
      // missing. An explicit restricted-Agent confirmation instead refreshes
      // the exact current Room audience below (including newly enrolled mainline members).
      // Linking follows the first add's rule — a private Agent only
      // by its owner — so a Room grant never becomes a Project link.
      if (member?.status === "active" && (!requiresGrant || input.confirm_room_share !== true)) {
        if (requiresGrant && agent.owner_user_id !== identity.userId) {
          throw new HttpError(404, "Agent not found in this Room's Project");
        }
        await new PgProjectAgentRepository(client).upsertActive({
          spaceId: identity.spaceId,
          projectId: room.project_id,
          agentId: agent.id,
          userId: identity.userId,
        });
        const restoreTarget = input.restore_workspace === true
          ? await findManagedWorkspaceRestoreTarget(client, identity.spaceId, agent.id, room.id, identity.userId)
          : null;
        return { detail: await this.roomDetail(client, identity, room.id), restoreTarget };
      }
      const activeUsers = await repository.activeMemberIds(identity.spaceId, room.id);
      const requestedGrantees = uniqueIds(input.share_private_with_member_ids ?? []);
      if (requiresGrant) {
        if (agent.owner_user_id !== identity.userId) {
          throw new HttpError(404, "Agent not found in this Room's Project");
        }
        const requiredGrantees = activeUsers.filter((userId) => userId !== identity.userId).sort();
        if (!sameIds(requestedGrantees, requiredGrantees)
          || ((requiredGrantees.length > 0 || isolated) && input.confirm_room_share !== true)) {
          throw new RoomMutationError(409, "Confirm Room-only sharing for the displayed private-Agent members", {
            code: "private_agent_share_confirmation_required",
            detail: "This private Agent stays private outside the Room. Confirm the exact Room members who will receive a Room-only grant.",
            agent_id: agent.id,
            member_ids: requiredGrantees,
            // The same people by name, read in this transaction: who the owner confirms.
            members: await granteeNames(client, requiredGrantees),
          });
        }
      }
      await repository.upsertSpecialistMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agent.id,
      });
      // A Room's Agents are the Project's Agents: adding one from the Room
      // completes the Project link in the same transaction. The link shares
      // nothing — a private Agent stays readable only by those its own ACL
      // (and this Room's explicit grants, inside this Room) admits.
      await new PgProjectAgentRepository(client).upsertActive({
        spaceId: identity.spaceId,
        projectId: room.project_id,
        agentId: agent.id,
        userId: identity.userId,
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
      if (requiresGrant) {
        for (const userId of uniqueIds([...requestedGrantees, ...(isolated ? [identity.userId] : [])])) {
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
    // The Host restore is not this transaction's: the caller commits it as a restore Job of this target.
    return transactionResult;
  }

  async addPresetAgent(identity: RoomIdentity, roomId: string, input: {
    preset_id: string;
    name?: string | null;
    confirm_room_share?: boolean;
    execution?: RoomAgentPresetRequest["execution"];
  }) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      const preset = roomAgentPresetById(input.preset_id);
      if (!preset) throw new HttpError(404, `Room Agent preset '${input.preset_id}' not found`);
      const roster = new PgRoomRosterRepository(client);
      const activeUsers = await roster.activeMemberIds(identity.spaceId, room.id);
      const sharedMemberIds = activeUsers.filter((userId) => userId !== identity.userId);
      if (sharedMemberIds.length > 0 && input.confirm_room_share !== true) {
        throw new RoomMutationError(409, "Confirm Room-only sharing for this preset Agent", {
          code: "private_agent_share_confirmation_required",
          detail: "This preset creates a private Agent owned by you and shares it with current Room members only.",
          member_ids: sharedMemberIds,
          members: await granteeNames(client, sharedMemberIds),
        });
      }
      const agentRepository = new PgAgentRepository(this.pool);
      const runtimeProfiles = input.execution
        ? []
        : await this.presetRuntimeProfiles(client, identity.spaceId, room.id);
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
        capabilitiesJson: [],
        toolPermissionsJson: {},
      };
      const agent = await agentRepository.createInTransaction(client, agentInput);
      // Each copy keeps the Host it runs on, admitted for the person adding
      // the preset; one they cannot run there is left out, and the new
      // Agent keeps its own Server Runtime default.
      for (const profile of runtimeProfiles) {
        try {
          await agentRepository.ensureRuntimeProfileInTransaction(client, identity.spaceId, agent.id, {
            name: profile.name,
            runtimeKey: profile.runtime_key,
            backendMode: profile.backend_mode,
            modelProviderId: profile.model_provider_id,
            modelName: profile.model_name,
            executionHostId: profile.execution_host_id,
            workspaceLocationId: profile.workspace_location_id,
            workspaceMode: profile.workspace_mode,
            runtimeInstallation: profile.runtime_installation,
            runtimeConfigJson: profile.runtime_config_json,
            runtimePolicyJson: profile.runtime_policy_json,
            isDefault: profile.is_default,
            actorUserId: identity.userId,
          });
        } catch (error) {
          if (!(error instanceof HttpError) || ![403, 404, 422].includes(error.statusCode)) throw error;
        }
      }
      if (input.execution) {
        await agentRepository.ensureRuntimeProfileInTransaction(client, identity.spaceId, agent.id, {
          name: `Room · ${input.execution.runtime_key}`,
          runtimeKey: input.execution.runtime_key,
          backendMode: "runtime_native",
          executionHostId: input.execution.host_id,
          workspaceLocationId: input.execution.workspace_location_id,
          workspaceMode: input.execution.workspace_mode,
          runtimeInstallation: input.execution.installation,
          actorUserId: identity.userId,
          isDefault: true,
        });
      }
      await roster.upsertSpecialistMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: agent.id,
      });
      await new PgProjectAgentRepository(client).upsertActive({
        spaceId: identity.spaceId,
        projectId: room.project_id,
        agentId: agent.id,
        userId: identity.userId,
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
      await client.query(`UPDATE session_conversation_backends b SET participating=false,updated_at=clock_timestamp()
        FROM sessions s WHERE b.space_id=$1 AND b.agent_id=$3 AND b.session_id=s.id AND s.space_id=$1 AND s.room_id=$2 AND b.participating`,[identity.spaceId,room.id,agentId]);
      const threadRepository = new PgHostThreadRepository(client);
      const closedThreads = await threadRepository.closeConversationAgentForRoom(identity.spaceId, room.id, agentId);
      // Every closed thread with a host, not only the managed-workspace ones:
      // the Agent's runtime profile is on that machine either way, and leaving
      // it behind is what would carry this Room's CLI memory into the next.
      const archiveTargets = closedThreads
        .filter((thread) => thread.pending_archive_at && thread.execution_host_id && thread.session_id)
        .map((thread) => ({
          threadId: thread.id,
          hostId: thread.execution_host_id!,
          agentId,
          conversationId: thread.session_id!,
          includeWorkspace: thread.include_workspace,
        }));
      if (member.status === "active") {
        await client.query(
          `UPDATE room_agent_members
              SET status = 'removed', updated_at = now()
            WHERE space_id = $1 AND room_id = $2 AND agent_id = $3`,
          [identity.spaceId, room.id, agentId],
        );
        await repository.incrementRosterRevision(identity.spaceId, room.id);
      }
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
        archiveTargets,
      };
    });
    // The durable `pending_archive_at` intent commits here; the Host archive is
    // attempted after commit and recovered on the Host's next connection or by the recovery pass.
    return transactionResult;
  }

  async resetAgentContext(identity: RoomIdentity, roomId: string, agentId: string, sessionId?: string) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      const thread = await client.query<{
        id: string;
        session_id: string;
        host_owner_user_id: string | null;
        agent_name: string;
        dispatch_lock_id: string | null;
      }>(
        `SELECT thread.id, thread.session_id, host.owner_user_id AS host_owner_user_id, agent.name AS agent_name,
                thread.dispatch_lock_id
           FROM host_threads thread
           JOIN sessions conversation ON conversation.id = thread.session_id AND conversation.space_id = thread.space_id
           JOIN hosts host ON host.id = thread.execution_host_id
           JOIN agents agent ON agent.id = thread.agent_id
          WHERE conversation.space_id = $3 AND conversation.room_id = $1 AND thread.agent_id = $2
            AND ($4::text IS NULL OR conversation.id = $4)
            AND thread.container_kind = 'conversation'
            AND thread.status IN ('active', 'session_reset')
          ORDER BY conversation.updated_at DESC, conversation.created_at DESC, conversation.id DESC
          LIMIT 1
          FOR UPDATE`,
        [room.id, agentId, identity.spaceId, sessionId ?? null],
      );
      const current = thread.rows[0];
      if (!current) throw new HttpError(404, "Host-bound Conversation Agent thread not found");
      if (current.host_owner_user_id !== identity.userId) {
        throw new HttpError(403, "Only the execution host owner can reset this Agent's context");
      }
      if (current.dispatch_lock_id) {
        throw new RoomMutationError(409, "The Host-bound Agent is still handling a Room turn; reset its context after it finishes");
      }
      const reset = await new PgHostThreadRepository(client).resetConversationAgent(current.id);
      if (!reset) throw new RoomMutationError(409, "Host Agent context changed before it could be reset");
      if (current.session_id) {
        await new PgSessionRepository(client).addRoomSystemNotice(
          identity.spaceId,
          identity.userId,
          room.id,
          current.session_id,
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

  /**
   * Prepare the next turn from the current session's summary, preserving the
   * source session until its replacement completes.
   */
  async restartFromSummary(identity: RoomIdentity, roomId: string, agentId: string) {
    return this.withRoomWriter(identity, roomId, async (client, room) => {
      const current = await lockConversationAgentThread(client, identity, room.id, agentId);
      if (current.host_owner_user_id !== identity.userId) {
        throw new HttpError(403, "Only the execution host owner can restart this Agent from its summary");
      }
      if (current.dispatch_lock_id) {
        throw new RoomMutationError(409, "The Host-bound Agent is still handling a Room turn; restart it after it finishes");
      }
      const summaryArtifactId = await latestSummaryArtifactId(client, {
        spaceId: identity.spaceId, threadId: current.id, vendorSessionId: current.vendor_session_id,
      });
      if (!summaryArtifactId || !current.vendor_session_id) {
        throw new RoomMutationError(409, "This Agent has no summary of its current session to restart from");
      }
      const audience = await roomAudience(client, identity.spaceId, room);
      if (!await loadHandoffText(client, identity.spaceId, summaryArtifactId, [identity.userId, ...audience])) {
        throw new RoomMutationError(409, "This summary is unavailable to the current Room audience");
      }
      const staged = await new PgHostThreadRepository(client).stageHandoff(current.id, summaryArtifactId, current.vendor_session_id);
      if (!staged) throw new RoomMutationError(409, "Host Agent context changed before the restart could be prepared");
      await new PgSessionRepository(client).addRoomSystemNotice(
        identity.spaceId,
        identity.userId,
        room.id,
        current.session_id,
        {
          content: `${current.agent_name}'s next turn starts from its summary`,
          metadata: {
            room_id: room.id,
            host_thread_id: current.id,
            host_thread_event: "session_reset",
            host_thread_reset_reason: "summary",
            execution_details: { artifact_id: summaryArtifactId },
          },
        },
      );
      return this.roomDetail(client, identity, room.id);
    });
  }

  async inviteUser(identity: RoomIdentity, roomId: string, input: {
    user_id: string;
    confirm_owned_private_agent_shares?: boolean;
    /**
     * Give the invitee the Room's existing conversations. Off by default:
     * activation then freezes them to their current audience and opens a new
     * conversation everyone can read (`freezeConversationAudiences`).
     */
    share_history?: boolean;
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
          throw new RoomMutationError(409, "User is already an active Room member");
        }
        const roster = new PgRoomRosterRepository(client);
        const prior = await client.query<RoomInvitationRecord>(
          `SELECT id, space_id, room_id, invitee_user_id, invited_by_user_id, status,
                  required_roster_revision::int AS required_roster_revision, share_history,
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
            && prior.rows[0].share_history === (input.share_history === true)
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
          throw new RoomMutationError(409, "Confirm Room-only sharing for private Agents you own", {
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
          share_history: input.share_history === true,
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

  async listInvitations(identity: RoomIdentity, roomId: string, input: { limit: number; offset: number; invitation_id?: string }) {
    const notFound = () => new HttpError(404, "Room not found in this space");
    const room = await new PgRoomRepository(this.pool).getRoomById(identity.spaceId, roomId);
    if (!room || room.status !== "active") throw notFound();
    return withQueryableTransaction(this.pool, async (client) => {
      await assertActiveSpaceUser(client, identity.spaceId, identity.userId);
      // Not getVisibleRoom: an invitee or a private Agent's approval owner reads
      // their own invitation before they are on the roster. Everyone else who
      // is not a member gets the same 404 as for a Room that does not exist
      // (ADR 0018 decision 3) — an empty page would say the Room is there.
      if (!(await canReadProject(client, identity.spaceId, room.project_id, identity.userId))) throw notFound();
      const repository = new PgRoomRosterRepository(client);
      const page = await repository.listInvitations({
        space_id: identity.spaceId,
        room_id: roomId,
        user_id: identity.userId,
        limit: input.limit,
        offset: input.offset,
        invitation_id: input.invitation_id,
      });
      if (
        page.total === 0
        && !(await new PgRoomRepository(client).getVisibleRoom(identity.spaceId, identity.userId, roomId, false))
      ) {
        throw notFound();
      }
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
                invitation.share_history, invitation.expires_at
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
            AND agent.status='active' AND (agent.visibility <> 'space_shared' OR agent.access_project_id<>room.project_id)
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
            AND agent.status='active' AND (agent.visibility <> 'space_shared' OR agent.access_project_id<>room.project_id)
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
      return await withQueryableTransaction(this.pool, async (client) => {
        // Account disable locks its user before revoking grants/invitations.
        // Pin all approval owners first, so it cannot interleave with activation.
        const issuers = await client.query<{ owner_user_id: string }>(
          `SELECT DISTINCT owner_user_id FROM room_invitation_agent_approvals
            WHERE space_id=$1 AND invitation_id=$2 ORDER BY owner_user_id`, [identity.spaceId, invitationId],
        );
        const lockedOwners = uniqueIds([identity.userId, ...issuers.rows.map(row => row.owner_user_id)]).sort();
        await client.query(`SELECT id FROM users WHERE id=ANY($1::varchar[]) ORDER BY id FOR SHARE`, [lockedOwners]);
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
        if (approvals.some(approval => !lockedOwners.includes(approval.owner_user_id))) {
          throw new HttpError(409, "Invitation ownership changed; read again");
        }
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
        throw new RoomMutationError(409, "Room members cannot remove themselves through the owner-managed removal endpoint");
      }
      // Mainline membership is Project membership. Removing someone here would
      // only last until they next open the Project; the honest place to remove
      // them is the Project itself.
      if (room.is_mainline) throw new RoomMutationError(409, "room_mainline_membership_follows_project", {
        code: "room_mainline_membership_follows_project",
        detail: "Every Project member belongs to the Project's mainline Room. Remove them from the Project instead.",
      });
      const roster = new PgRoomRosterRepository(client);
      const member = await roster.lockUserMember(identity.spaceId, room.id, userId);
      if (!member || member.status !== "active") throw new HttpError(404, "Room member not found");
      if (member.role === "owner") throw new RoomMutationError(409, "room_owner_transfer_required", {
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
      if (!target || target.status !== "active") throw new RoomMutationError(409, "Ownership target must be an active Room member");
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
    return withQueryableTransaction(this.pool, async (client) => {
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
        // A caller who cannot see the Room learns nothing from a 403 that a
        // 404 would not say about a Room that does not exist (ADR 0018
        // decision 3); only a member who can already see it is told why.
        if (!(await rooms.getVisibleRoom(identity.spaceId, identity.userId, roomId, false))) {
          throw new HttpError(404, "Room not found in this space");
        }
        throw new HttpError(403, "Only the Project owner or Space owner/admin may claim a suspended Room");
      }
      const currentOwnerId = await this.currentOwner(client, room.id);
      if (currentOwnerId && await canWriteProject(client, identity.spaceId, room.project_id, currentOwnerId)) {
        throw new RoomMutationError(409, "Room ownership is not suspended");
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
    client: Queryable,
    identity: RoomIdentity,
    invitation: RoomInvitationRecord,
    approvals: RoomInvitationApprovalRecord[],
  ): Promise<RoomInvitationRecord> {
    const rooms = new PgRoomRepository(client);
    const room = await rooms.getRoomById(identity.spaceId, invitation.room_id, true);
    if (!room || room.status !== "active") throw new HttpError(404, "Room invitation not found");
    if (Number(room.roster_revision) !== Number(invitation.required_roster_revision)) {
      throw new RoomMutationError(409, "The Room roster changed; recreate the invitation", {
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
    await client.query(`SELECT a.id FROM agents a JOIN room_agent_members m ON m.space_id=a.space_id AND m.agent_id=a.id
      WHERE m.space_id=$1 AND m.room_id=$2 AND m.status='active' ORDER BY a.id FOR SHARE OF a`, [identity.spaceId, room.id]);
    const currentPrivate = await roster.listPrivateRoster({ space_id: identity.spaceId, room_id: room.id });
    const currentIds = currentPrivate.map((agent) => agent.agent_id).sort();
    const approvedIds = approvals.map((approval) => approval.agent_id).sort();
    const currentOwners = new Map(currentPrivate.map((agent) => [agent.agent_id, agent.owner_user_id]));
    if (
      !sameIds(currentIds, approvedIds)
      || approvals.some((approval) => approval.status !== "approved")
      || approvals.some((approval) => currentOwners.get(approval.agent_id) !== approval.owner_user_id)
    ) {
      throw new RoomMutationError(409, "The private-Agent approval snapshot is stale", {
        code: "invitation_snapshot_stale",
        invitation_id: invitation.id,
        detail: "The active private specialist roster changed while this invitation was pending.",
      });
    }
    for (const agent of currentPrivate) {
      const valid = await client.query(
        `SELECT 1 FROM agents a JOIN rooms r ON r.space_id=a.space_id AND r.id=$4
          WHERE a.space_id=$1 AND a.id=$2 AND a.owner_user_id=$3 AND a.status='active'
            AND EXISTS (SELECT 1 FROM users u JOIN space_memberships sm ON sm.user_id=u.id
              WHERE u.id=a.owner_user_id AND u.status='active' AND sm.space_id=a.space_id AND sm.status='active')
            AND ${roomAgentGrantIssuerSql("a", "r")}`,
        [identity.spaceId, agent.agent_id, agent.owner_user_id, room.id],
      );
      if (!valid.rows.length) {
        throw new RoomMutationError(409, "The Agent owner can no longer authorize this invitation; recreate it", {
          code: "invitation_snapshot_stale", invitation_id: invitation.id,
        });
      }
    }
    // Before the invitee is a member, under the Room lock every conversation
    // writer takes: the frozen audience is exactly who could read each
    // conversation until now.
    if (!invitation.share_history) {
      await freezeConversationAudiences(client, { spaceId: identity.spaceId, room, invitationId: invitation.id });
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
    client: Queryable,
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
    // The conversation an activation without history opened, so the inviter
    // and invitee can go straight to where they now talk together.
    const sharedConversationId = current.status === "active" && !current.share_history
      ? await sharedConversationForInvitation(client, identity.spaceId, current.room_id, current.id)
      : null;
    return {
      ...current,
      shared_conversation_id: isPrimaryParty ? sharedConversationId : null,
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
      await withQueryableTransaction(this.pool, async (client) => {
        const roster = new PgRoomRosterRepository(client);
        // The same order as every other invitation mutation — Room, then
        // invitation, then its approvals — so a concurrent decision or
        // re-invitation holding the Room and invitation locks never waits on
        // an approval row this transaction holds while it waits on them.
        const located = await roster.getInvitation({ space_id: identity.spaceId, invitation_id: invitationId });
        if (!located) return;
        await new PgRoomRepository(client).getRoomById(identity.spaceId, located.room_id, true);
        const invitation = await roster.getInvitation({ space_id: identity.spaceId, invitation_id: invitationId, lock: true });
        // Decided or expired meanwhile: that outcome stands.
        if (invitation?.status !== "pending") return;
        await roster.invalidateApprovals(identity.spaceId, invitationId);
        await roster.updateInvitationStatus({
          space_id: identity.spaceId,
          invitation_id: invitationId,
          status: "invalidated",
          only_from: "pending",
        });
      });
    } catch {
      // Preserve the original stale-snapshot conflict. A failed cleanup is
      // safe to retry on the next decision and must not become a misleading
      // database error response to the caller.
    }
  }

  async saveConversationDefaults(identity: RoomIdentity, roomId: string, defaults: import("@rainver/protocol").RoomConversationDefault[], expectedRevision: number) {
    return withQueryableTransaction(this.pool,async tx=>{
      const visible=await new PgRoomRepository(tx).getVisibleRoom(identity.spaceId,identity.userId,roomId);
      if(!visible)throw new HttpError(404,"Room not found");
      await lockProjectAudience(tx,identity.spaceId,visible.project_id);
      return new RoomRosterService(tx).withRoomWriter(identity,roomId,async (db,room)=>{
      if(room.roster_revision!==Number(expectedRevision))throw new RoomMutationError(409,"Room defaults changed; refresh and retry");
      if(new Set(defaults.map(item=>item.agent_id)).size!==defaults.length) throw new RoomMutationError(422,"Each Agent may have only one Room default");
      const roster=await new PgRoomRepository(db).listAgentMembers(identity.spaceId,roomId,identity.userId);
      for(const item of defaults){
        const member=roster.find(member=>member.agent_id===item.agent_id);
        if(!member || member.role==='manager'&&!item.participating) throw new RoomMutationError(422,"Keep the Room manager and select active Room Agents");
        if(!await new PgConversationExecutionContextRepository(db).canAgentParticipate({id:'',space_id:identity.spaceId,room_id:roomId,project_id:room.project_id,project_folder_id:room.project_folder_id},item.agent_id,identity.userId)) throw new HttpError(403,"Agent use is not authorized in this Room");
        if(item.runtime_profile_id){
          const option=(await new PgConversationBackendRepository(db).listOptions(identity.spaceId,identity.userId,item.agent_id,room.project_id,"room-runtime")).find(option=>option.runtime_profile_id===item.runtime_profile_id);
          if(!option || option.usable===false) throw new RoomMutationError(409,"Room default runtime is unavailable to you");
          validateSessionConfig(item.session_config,option.session_config_options??[]);
        } else if(item.session_config.length) throw new RoomMutationError(422,"Choose a runtime before saving model defaults");
      }
      await db.query(`UPDATE rooms SET conversation_defaults_json=$3::jsonb,roster_revision=roster_revision+1,updated_at=now() WHERE space_id=$1 AND id=$2`,[identity.spaceId,roomId,JSON.stringify([...(room.conversation_defaults_json??[]).filter(item=>!defaults.some(patch=>patch.agent_id===item.agent_id)),...defaults])]);
      });
    });
  }

  private async withRoomWriter<T>(
    identity: RoomIdentity,
    roomId: string,
    work: (client: Queryable, room: RoomRecord) => Promise<T>,
  ): Promise<T> {
    return withQueryableTransaction(this.pool, async (client) => {
      const actor = await client.query(`SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE`, [identity.userId]);
      if (!actor.rows.length) throw new HttpError(404, "Room not found in this space");
      // The locked read takes the Room's Project key lock before the Room row
      // (`PgRoomRepository.lockRoomProjectKey`).
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

  private async currentOwner(client: Queryable, roomId: string): Promise<string | null> {
    const result = await client.query<{ user_id: string }>(
      `SELECT user_id FROM room_user_members
        WHERE room_id = $1 AND role = 'owner' AND status = 'active'
        LIMIT 1`,
      [roomId],
    );
    return result.rows[0]?.user_id ?? null;
  }

  private async presetRuntimeProfiles(client: Queryable, spaceId: string, roomId: string): Promise<PresetRuntimeProfile[]> {
    const result = await client.query<PresetRuntimeProfile>(
      `SELECT profile.name, profile.runtime_key, profile.backend_mode, profile.model_provider_id,
              profile.model_name, profile.execution_host_id, profile.workspace_location_id,
              profile.workspace_mode, profile.runtime_installation, profile.runtime_config_json,
              profile.runtime_policy_json, profile.is_default
         FROM room_agent_members member
         JOIN agent_runtime_profiles profile
           ON profile.space_id = member.space_id
          AND profile.agent_id = member.agent_id
          AND profile.enabled = true
          -- A profile without a Host runs nowhere; it is not worth copying.
          AND profile.execution_host_id IS NOT NULL
        WHERE member.space_id = $1
          AND member.room_id = $2
          AND member.role = 'manager'
          AND member.status = 'active'
        ORDER BY profile.is_default DESC, profile.created_at ASC, profile.id ASC`,
      [spaceId, roomId],
    );
    return result.rows
      .filter((profile) => getRuntimeAdapterSpec(profile.runtime_key)?.implementation_status === "implemented");
  }

  /**
   * Typed as `RoomDetail` on purpose. The schema is `.strict()` and every
   * field required, but nothing validates a response at runtime — so without
   * the annotation a missing field is invisible until a consumer reads
   * `undefined` and treats it as `false`, hiding every control.
   */
  private async roomDetail(
    client: Queryable,
    identity: RoomIdentity,
    roomId: string,
  ): Promise<RoomDetail> {
    const repository = new PgRoomRepository(client);
    const room = await repository.getVisibleRoom(identity.spaceId, identity.userId, roomId);
    if (!room) throw new HttpError(404, "Room not found in this space");
    return {
      room:publicRoom(room),
      user_members: await repository.listUserMembers(identity.spaceId, room.id),
      agent_members: await repository.listAgentMembers(identity.spaceId, room.id, identity.userId),
      viewer_can_write: await canWriteProject(client, identity.spaceId, room.project_id, identity.userId),
      ...(await repository.audienceForViewer(identity.spaceId, room.id, identity.userId)),
    };
  }
}

export interface ManagedConversationRestoreTarget {
  /** The exact closed thread whose archived state this restores; re-checked before the Host call. */
  threadId: string;
  hostId: string;
  agentId: string;
  conversationId: string;
  /**
   * Whether the shared Conversation cwd comes back with the Agent's profile.
   *
   * Two things were archived when the Agent left, and only one of them is
   * always there to restore. The Agent's runtime profile is archived whenever
   * it leaves; the cwd only when it was the last one out, and a Conversation
   * pinned to a registered Location never had a Rainver-managed cwd at all.
   * The heartbeat reports workspaces and not profiles, so this is what it can
   * answer — the daemon restores whichever archives exist and says what moved.
   */
  includeWorkspace: boolean;
}

/**
 * The closed thread a re-added Agent would pick its host state back up from.
 *
 * Not gated on an archived workspace. One Agent leaving a Conversation while
 * others stay archives only the Agent's profile. Requiring a workspace
 * archive would make every one of those unrestorable, then swept after 30 days.
 */
/** Host restore of a re-added Agent's archived conversation state; only the restore Job calls it, outside any transaction. */
/** Post-commit Host archive of closed conversation threads; unsettled intents stay for reconnect and recovery, which repeat the same operation. */
export async function archiveManagedConversationWorkspaces(pool: Queryable, targets: readonly { threadId: string; hostId: string; agentId: string; conversationId: string }[]) {
  const archived = [];
  for (const target of targets) {
    // The intent's own cwd scope, fixed when it committed, goes with every send of it.
    const response = await sendPendingManagedWorkspaceArchive(pool, target.threadId, {
      hostId: target.hostId, agentId: target.agentId, containerKind: "conversation", containerId: target.conversationId,
    }).catch((error: unknown) => ({ ok: false, changed: false, settled: false, error: error instanceof Error ? error.message : String(error) }));
    archived.push({ agent_id: target.agentId, ...response });
  }
  return archived;
}

export async function findManagedWorkspaceRestoreTarget(
  client: Queryable,
  spaceId: string,
  agentId: string,
  roomId: string,
  userId: string,
): Promise<ManagedConversationRestoreTarget | null> {
  const profile = await client.query<ManagedConversationRestoreTarget>(
    `SELECT thread.id AS "threadId", thread.execution_host_id AS "hostId", thread.agent_id AS "agentId",
            thread.session_id AS "conversationId",
            (thread.workspace_mode = 'managed' AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(host.managed_workspaces_json, '[]'::jsonb)) workspace
               WHERE workspace->>'container_kind' = 'conversation'
                 AND workspace->>'container_id' = thread.session_id
                 AND workspace->>'archived_available' = 'true'
            )) AS "includeWorkspace"
       FROM host_threads thread
       JOIN sessions conversation ON conversation.id = thread.session_id AND conversation.space_id = thread.space_id
       JOIN hosts host ON host.id = thread.execution_host_id
      WHERE thread.space_id = $1 AND thread.agent_id = $2
        AND conversation.room_id = $3
        AND thread.container_kind = 'conversation'
        AND thread.status = 'closed'
        AND host.owner_user_id = $4 AND host.status <> 'revoked'
      ORDER BY conversation.updated_at DESC, conversation.created_at DESC, conversation.id DESC
      LIMIT 1`,
    [spaceId, agentId, roomId, userId],
  );
  const selected = profile.rows[0];
  return selected
    ? {
      threadId: selected.threadId,
      hostId: selected.hostId,
      agentId: selected.agentId,
      conversationId: selected.conversationId,
      includeWorkspace: selected.includeWorkspace,
    }
    : null;
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}


function managedRoomAgentImmutable(): HttpError {
  return new RoomMutationError(409, "The managed Room Assistant cannot be removed or replaced", {
    code: "managed_room_agent_immutable",
    detail: "The managed Space Assistant is the permanent Room manager.",
  });
}

function isInvitationSnapshotStale(value: unknown): value is { code: "invitation_snapshot_stale"; invitation_id: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { code?: unknown; invitation_id?: unknown };
  return candidate.code === "invitation_snapshot_stale" && typeof candidate.invitation_id === "string";
}

/**
 * The two Room commands a person may give without being on the Room's roster,
 * exactly as their services decide them: a party to an invitation (inviter,
 * invitee, or a private Agent's approval owner) who can still read the Project
 * decides it; the Project owner or a Space owner/admin claims a Room whose
 * owner lost authority. Re-read on every admission and replay, never cached.
 */
export async function hasRoomCommandStanding(
  db: Queryable,
  identity: RoomIdentity,
  roomId: string,
  command: { kind: "invitation_decide"; invitationId: string } | { kind: "owner_claim" },
): Promise<boolean> {
  const room = await new PgRoomRepository(db).getRoomById(identity.spaceId, roomId);
  if (!room || room.status !== "active") return false;
  const member = await db.query<{ role: string }>(
    `SELECT role FROM space_memberships WHERE space_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [identity.spaceId, identity.userId],
  );
  if (!member.rows[0]) return false;
  if (command.kind === "owner_claim") {
    const project = await db.query<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM projects WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [identity.spaceId, room.project_id],
    );
    return Boolean(project.rows[0]
      && (project.rows[0].owner_user_id === identity.userId || isSpaceOwnerOrAdmin(member.rows[0].role)));
  }
  const party = await db.query(
    `SELECT 1 FROM room_user_invitations invitation
      WHERE invitation.space_id = $1 AND invitation.room_id = $2 AND invitation.id = $3
        AND (invitation.invited_by_user_id = $4 OR invitation.invitee_user_id = $4
          OR EXISTS (SELECT 1 FROM room_invitation_agent_approvals approval
                      WHERE approval.space_id = invitation.space_id AND approval.invitation_id = invitation.id
                        AND approval.owner_user_id = $4))`,
    [identity.spaceId, roomId, command.invitationId, identity.userId],
  );
  return Boolean(party.rows[0]) && await canReadProject(db, identity.spaceId, room.project_id, identity.userId);
}

async function assertActiveSpaceUser(db: Queryable, spaceId: string, userId: string): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1`,
    [spaceId, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "User is not an active member of this Space");
}

interface PresetRuntimeProfile {
  name: string;
  runtime_key: string;
  backend_mode: "runtime_native" | "model_provider";
  model_provider_id: string | null;
  model_name: string | null;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: "location" | "managed" | null;
  runtime_installation: string | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  is_default: boolean;
}

/**
 * The host-bound Conversation thread a Room roster action acts on: the
 * Agent's thread in the Room's most recently touched Conversation, locked.
 */
export async function lockConversationAgentThread(
  client: Queryable,
  identity: RoomIdentity,
  roomId: string,
  agentId: string,
): Promise<{
  id: string;
  session_id: string;
  host_owner_user_id: string | null;
  agent_name: string;
  dispatch_lock_id: string | null;
  vendor_session_id: string | null;
}> {
  const thread = await client.query<{
    id: string;
    session_id: string;
    host_owner_user_id: string | null;
    agent_name: string;
    dispatch_lock_id: string | null;
    vendor_session_id: string | null;
  }>(
    `SELECT thread.id, thread.session_id, host.owner_user_id AS host_owner_user_id, agent.name AS agent_name,
            thread.dispatch_lock_id, thread.vendor_session_id
       FROM host_threads thread
       JOIN sessions conversation ON conversation.id = thread.session_id AND conversation.space_id = thread.space_id
       JOIN hosts host ON host.id = thread.execution_host_id
       JOIN agents agent ON agent.id = thread.agent_id
      WHERE conversation.space_id = $3 AND conversation.room_id = $1 AND thread.agent_id = $2
        AND thread.container_kind = 'conversation'
        AND thread.status IN ('active', 'session_reset')
      ORDER BY conversation.updated_at DESC, conversation.created_at DESC, conversation.id DESC
      LIMIT 1
      FOR UPDATE OF thread`,
    [roomId, agentId, identity.spaceId],
  );
  const current = thread.rows[0];
  if (!current) throw new HttpError(404, "Host-bound Conversation Agent thread not found");
  return current;
}

/** The display names of the people a Room-only share would cover, in the given order. */
async function granteeNames(db: Queryable, userIds: readonly string[]): Promise<Array<{ user_id: string; display_name: string }>> {
  if (!userIds.length) return [];
  const rows = (await db.query<{ id: string; display_name: string | null; email: string | null }>(
    "SELECT id, display_name, email FROM users WHERE id = ANY($1::varchar[])", [userIds],
  )).rows;
  const byId = new Map(rows.map((row) => [row.id, row.display_name?.trim() || row.email || row.id]));
  return userIds.map((user_id) => ({ user_id, display_name: byId.get(user_id) ?? user_id }));
}
