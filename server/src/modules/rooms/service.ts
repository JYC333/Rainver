import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool";
import { AgentGroupRunService, type AgentGroupMessageRecipientSegment } from "../agentGroups/service";
import { HttpError, withDbTransaction } from "../routeUtils/common";
import { PgSessionRepository } from "../sessions/repository";
import {
  assertProjectWriter,
  assertProjectReadableLocked,
  lockActiveProjectForMutation,
} from "../projects/access";
import { PgProjectFolderRepository } from "../projectFolders/repository";
import {
  ConversationTurnInProgressError,
  PgConversationRuntimeSessionRepository,
} from "../sessions/conversationRuntimeSessionRepository";
import {
  PgRoomRepository,
  type RoomAgentMemberRecord,
  type RoomRecord,
  type RoomUserMemberRecord,
} from "./repository";
import { ProjectOverviewService } from "../projects/overviewService";
import { SpaceAssistantService } from "../agents/spaceAssistantService";
import { RoomRosterService } from "./rosterService";
import { RoomConversationSummaryService } from "./conversationSummaryService";
import { requestRoomConversationTitle } from "./conversationTitleService";
import { PgProposalRepository } from "../proposals/repository";
import { createDefaultConversationContinuationRegistry } from "../proposals/continuationRegistry";
import { PLAIN_STATUS_RESPONSE_POLICY } from "../systemActions/conversationPolicy";

export interface RoomIdentity {
  spaceId: string;
  userId: string;
}

// Domain registration is static, so one process-lifetime registry is shared
// across requests — mirrors how the system action registry is loaded once.
const continuationRegistry = createDefaultConversationContinuationRegistry();

export class RoomService {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
  ) {}

  static fromConfig(config: ServerConfig): RoomService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new RoomService(config, getDbPool(config.databaseUrl));
  }

  private rosterService(): RoomRosterService {
    return new RoomRosterService(this.config, this.pool);
  }

  async createRoom(identity: RoomIdentity, input: {
    project_id: string;
    project_folder_id?: string | null;
    title: string;
    idempotency_key?: string | null;
  }): Promise<{
    room: RoomRecord;
    user_members: RoomUserMemberRecord[];
    agent_members: RoomAgentMemberRecord[];
    conversation: Awaited<ReturnType<PgSessionRepository["createRoomConversation"]>>;
  }> {
    await assertProjectWriter(
      this.pool,
      identity.spaceId,
      input.project_id,
      identity.userId,
    );
    const assistantPreparation = await SpaceAssistantService.prepareForRoomCreator(
      this.pool,
      this.config,
      identity,
    );
    return withDbTransaction(this.pool, async (client) => {
      await lockActiveProjectForMutation(client, identity.spaceId, input.project_id);
      await client.query("SELECT id FROM spaces WHERE id = $1 FOR UPDATE", [identity.spaceId]);
      await assertProjectWriter(
        client,
        identity.spaceId,
        input.project_id,
        identity.userId,
      );
      await assertProjectReadableLocked(
        client,
        identity.spaceId,
        input.project_id,
        identity.userId,
      );
      const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key);
      const fingerprint = idempotencyKey
        ? createRoomFingerprint(input)
        : null;
      if (idempotencyKey && fingerprint) {
        const prior = await client.query<{
          request_fingerprint: string;
          room_id: string;
          conversation_id: string;
        }>(
          `SELECT request_fingerprint, room_id, conversation_id
             FROM room_creation_idempotencies
            WHERE space_id = $1 AND user_id = $2 AND idempotency_key = $3
            FOR UPDATE`,
          [identity.spaceId, identity.userId, idempotencyKey],
        );
        const existing = prior.rows[0];
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) {
            throw new HttpError(409, "Idempotency-Key was already used with different Room parameters");
          }
          const existingRoom = await new PgRoomRepository(client).getVisibleRoom(
            identity.spaceId,
            identity.userId,
            existing.room_id,
            true,
          );
          const existingConversation = existingRoom
            ? await new PgRoomRepository(client).getConversation(
                identity.spaceId,
                existing.room_id,
                existing.conversation_id,
              )
            : null;
          if (!existingRoom || !existingConversation) {
            throw new HttpError(409, "The idempotent Room result is no longer available");
          }
          const existingRepository = new PgRoomRepository(client);
          return {
            room: existingRoom,
            user_members: await existingRepository.listUserMembers(identity.spaceId, existingRoom.id),
            agent_members: await existingRepository.listAgentMembers(identity.spaceId, existingRoom.id),
            conversation: existingConversation,
          };
        }
      }
      if (input.project_folder_id) {
        const folder = await new PgProjectFolderRepository(client, this.config).get(
          identity,
          input.project_id,
          input.project_folder_id,
        );
        if (!folder || folder.status !== "active") {
          throw new HttpError(
            422,
            "project_folder_id must identify an active folder in this Project",
          );
        }
      }
      const assistant = await new SpaceAssistantService(client, this.pool)
        .ensureForRoomCreator(identity, assistantPreparation);
      const repository = new PgRoomRepository(client);
      const room = await repository.createRoom({
        space_id: identity.spaceId,
        project_id: input.project_id,
        project_folder_id: input.project_folder_id ?? null,
        created_by_user_id: identity.userId,
        title: requiredText(input.title, "title"),
      });
      await repository.addUserMember({
        space_id: identity.spaceId,
        room_id: room.id,
        user_id: identity.userId,
        role: "owner",
      });
      await repository.addAgentMember({
        space_id: identity.spaceId,
        room_id: room.id,
        agent_id: assistant.id,
        role: "manager",
      });
      const conversation = await new PgSessionRepository(client).createRoomConversation({
        space_id: identity.spaceId,
        room_id: room.id,
        project_id: room.project_id,
        project_folder_id: room.project_folder_id,
        title: "New conversation",
        metadata: { conversation_kind: "room" },
      });
      if (idempotencyKey && fingerprint) {
        await client.query(
          `INSERT INTO room_creation_idempotencies (
             id, space_id, user_id, idempotency_key, request_fingerprint,
             room_id, conversation_id, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
          [
            cryptoRandomId(),
            identity.spaceId,
            identity.userId,
            idempotencyKey,
            fingerprint,
            room.id,
            conversation.id,
          ],
        );
      }
      return {
        room,
        user_members: await repository.listUserMembers(identity.spaceId, room.id),
        agent_members: await repository.listAgentMembers(identity.spaceId, room.id),
        conversation,
      };
    });
  }

  async listRooms(identity: RoomIdentity, input: {
    project_id?: string | null;
    limit: number;
    offset: number;
  }) {
    const result = await new PgRoomRepository(this.pool).listVisibleRooms({
      space_id: identity.spaceId,
      user_id: identity.userId,
      project_id: input.project_id ?? null,
      limit: input.limit,
      offset: input.offset,
    });
    return { ...result, limit: input.limit, offset: input.offset };
  }

  listAgentCandidates(identity: RoomIdentity, roomId: string, input: { limit: number; offset: number }) {
    return this.rosterService().listAgentCandidates(identity, roomId, input);
  }

  addAgent(identity: RoomIdentity, roomId: string, input: {
    agent_id: string;
    share_private_with_member_ids?: string[];
    confirm_room_share?: boolean;
  }) {
    return this.rosterService().addExistingAgent(identity, roomId, input);
  }

  addAgentPreset(identity: RoomIdentity, roomId: string, input: {
    preset_id: string;
    name?: string | null;
    idempotency_key?: string | null;
    confirm_room_share?: boolean;
  }) {
    return this.rosterService().addPresetAgent(identity, roomId, input);
  }

  removeAgent(identity: RoomIdentity, roomId: string, agentId: string) {
    return this.rosterService().removeAgent(identity, roomId, agentId);
  }

  inviteUser(identity: RoomIdentity, roomId: string, input: {
    user_id: string;
    confirm_owned_private_agent_shares?: boolean;
  }) {
    return this.rosterService().inviteUser(identity, roomId, input);
  }

  listInvitations(identity: RoomIdentity, roomId: string, input: { limit: number; offset: number }) {
    return this.rosterService().listInvitations(identity, roomId, input);
  }

  listPendingApprovals(identity: RoomIdentity, input: { limit: number; offset: number }) {
    return this.rosterService().listPendingApprovals(identity, input);
  }

  decideInvitation(identity: RoomIdentity, roomId: string, invitationId: string, input: {
    agent_id: string;
    decision: "approved" | "rejected";
  }) {
    return this.rosterService().decideInvitation(identity, roomId, invitationId, input);
  }

  removeUser(identity: RoomIdentity, roomId: string, userId: string) {
    return this.rosterService().removeUser(identity, roomId, userId);
  }

  transferOwner(identity: RoomIdentity, roomId: string, userId: string) {
    return this.rosterService().transferOwner(identity, roomId, userId);
  }

  claimOwner(identity: RoomIdentity, roomId: string) {
    return this.rosterService().claimOwner(identity, roomId);
  }

  async getRoom(identity: RoomIdentity, roomId: string) {
    const repository = new PgRoomRepository(this.pool);
    const room = await requireRoom(repository, identity, roomId);
    return {
      room,
      user_members: await repository.listUserMembers(identity.spaceId, room.id),
      agent_members: await repository.listAgentMembers(identity.spaceId, room.id),
    };
  }

  async createConversation(
    identity: RoomIdentity,
    roomId: string,
    input: { title?: string | null },
  ) {
    return withDbTransaction(this.pool, async (client) => {
      const room = await requireRoom(new PgRoomRepository(client), identity, roomId, true);
      return new PgSessionRepository(client).createRoomConversation({
        space_id: identity.spaceId,
        room_id: room.id,
        project_id: room.project_id,
        project_folder_id: room.project_folder_id,
        title: optionalText(input.title) ?? "New conversation",
        metadata: { conversation_kind: "room" },
      });
    });
  }

  async listConversations(identity: RoomIdentity, roomId: string, input: {
    limit: number;
    offset: number;
  }) {
    const repository = new PgRoomRepository(this.pool);
    await requireRoom(repository, identity, roomId);
    const result = await repository.listConversations({
      space_id: identity.spaceId,
      room_id: roomId,
      limit: input.limit,
      offset: input.offset,
    });
    return { ...result, limit: input.limit, offset: input.offset };
  }

  async listMessages(
    identity: RoomIdentity,
    roomId: string,
    sessionId: string,
    input: { limit: number; offset: number },
  ) {
    const roomRepository = new PgRoomRepository(this.pool);
    await requireRoom(roomRepository, identity, roomId);
    const conversation = await requireConversation(roomRepository, identity, roomId, sessionId);
    const messages = await new PgSessionRepository(this.pool).listRoomMessages(
      identity.spaceId,
      identity.userId,
      roomId,
      sessionId,
      input.limit,
      input.offset,
    );
    return {
      items: messages ?? [],
      task_group_ids: await roomRepository.listConversationTaskGroupIds(
        identity.spaceId,
        roomId,
        sessionId,
      ),
      conversation,
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getConversationSummary(identity: RoomIdentity, roomId: string, sessionId: string) {
    await requireRoom(new PgRoomRepository(this.pool), identity, roomId);
    return new RoomConversationSummaryService(this.config, this.pool).getVisibleSummary({
      spaceId: identity.spaceId,
      roomId,
      sessionId,
      userId: identity.userId,
    });
  }

  async sendMessage(identity: RoomIdentity, roomId: string, sessionId: string, input: {
    content: string;
    routing_mode?: "direct" | "agent_coordination";
    recipient_segments?: AgentGroupMessageRecipientSegment[] | null;
    backends?: Array<{
      agent_id: string;
      runtime_profile_id: string;
      credential_profile_id?: string | null;
    }>;
  }) {
    return withDbTransaction(this.pool, async (client) => {
      const rooms = new PgRoomRepository(client);
      const room = await requireRoom(rooms, identity, roomId, true);
      await requireConversation(rooms, identity, roomId, sessionId);
      return this.dispatchRoomMessage(client, rooms, room, identity, sessionId, {
        content: requiredText(input.content, "content"),
        routing_mode: input.routing_mode ?? "direct",
        recipient_segments: input.recipient_segments ?? null,
        backends: input.backends ?? [],
        kind: "user",
      });
    });
  }

  async continueAfterProposal(identity: RoomIdentity, roomId: string, sessionId: string, input: {
    proposal_id: string;
    backends?: Array<{
      agent_id: string;
      runtime_profile_id: string;
      credential_profile_id?: string | null;
    }>;
  }) {
    return withDbTransaction(this.pool, async (client) => {
      const rooms = new PgRoomRepository(client);
      const room = await requireRoom(rooms, identity, roomId, true);
      const conversation = await requireConversation(rooms, identity, roomId, sessionId);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`room-proposal-continuation:${identity.spaceId}:${sessionId}:${input.proposal_id}`],
      );
      const proposal = await new PgProposalRepository(client).getVisible(
        identity.spaceId,
        identity.userId,
        input.proposal_id,
      );
      if (!proposal || proposal.project_id !== room.project_id) {
        throw new HttpError(404, "Proposal not found for this Room's Project");
      }
      if (proposal.status !== "accepted" && proposal.status !== "rejected") {
        throw new HttpError(409, "Proposal must be accepted or rejected before continuing");
      }
      if (!proposal.created_by_run_id) {
        throw new HttpError(409, "Proposal is not attached to this Room conversation");
      }
      const sourceRun = await client.query<{ present: boolean }>(
        `SELECT true AS present FROM runs
          WHERE id = $1 AND space_id = $2 AND session_id = $3`,
        [proposal.created_by_run_id, identity.spaceId, sessionId],
      );
      if (!sourceRun.rows[0]?.present) {
        throw new HttpError(409, "Proposal belongs to a different conversation");
      }

      const sessions = new PgSessionRepository(client);
      const prior = await sessions.findRoomProposalContinuation(
        identity.spaceId,
        identity.userId,
        roomId,
        sessionId,
        proposal.id,
      );
      if (prior) {
        const priorMetadata = record(prior.metadata_json);
        const priorRunIds = stringArray(priorMetadata.run_ids);
        const priorGroupId = typeof priorMetadata.task_group_id === "string"
          ? priorMetadata.task_group_id
          : null;
        if (!priorGroupId || priorRunIds.length === 0) {
          throw new HttpError(409, "The existing Proposal continuation is incomplete");
        }
        const priorRuns = await client.query<{ id: string; status: string }>(
          `SELECT id,status FROM runs WHERE space_id=$1 AND id=ANY($2::varchar[])`,
          [identity.spaceId, priorRunIds],
        );
        const retryable = priorRuns.rows.length === priorRunIds.length
          && priorRuns.rows.every(run => run.status === "failed" || run.status === "cancelled");
        if (!retryable) {
          return {
            message: prior,
            conversation,
            task_group_ids: [priorGroupId],
            run_ids: priorRunIds,
          };
        }
      }

      const continuation = await continuationRegistry.resolve(client, {
        id: proposal.id,
        space_id: identity.spaceId,
        project_id: proposal.project_id,
        proposal_type: proposal.proposal_type,
        status: proposal.status,
        proposed_title: proposal.proposed_title,
        payload_json: proposal.payload_json,
        created_by_run_id: proposal.created_by_run_id,
      });

      return this.dispatchRoomMessage(client, rooms, room, identity, sessionId, {
        content: continuation.instruction,
        routing_mode: "direct",
        recipient_segments: null,
        backends: input.backends ?? [],
        kind: "proposal_continuation",
        proposal: {
          id: proposal.id,
          status: proposal.status,
          type: proposal.proposal_type,
        },
        continuation: { directive: continuation.directive, context: continuation.context },
        existing_internal_message: prior ?? undefined,
      });
    });
  }

  /**
   * The domain-completion-event sibling of `continueAfterProposal` (plan
   * Phase 3, second continuation-registry trigger source). Takes an
   * already-open transaction `client` rather than opening its own: the
   * caller is always a domain reconciler (e.g.
   * `AgentGroupRunLifecycleProjector`) already inside a transaction that
   * commits the completion this continuation is reporting on, and this must
   * share that transaction rather than risk a second, independently
   * committed one going out of sync with it. Callers that want this
   * non-fatal to their own transaction (most should) wrap the call in a
   * `SAVEPOINT`.
   */
  async continueAfterDomainEventInTransaction(
    client: PoolClient,
    identity: RoomIdentity,
    roomId: string,
    sessionId: string,
    event: { kind: string; key: string; payload?: Record<string, unknown> },
  ) {
    const rooms = new PgRoomRepository(client);
    const room = await requireRoom(rooms, identity, roomId, true);
    await requireConversation(rooms, identity, roomId, sessionId);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`room-event-continuation:${identity.spaceId}:${sessionId}:${event.kind}:${event.key}`],
    );
    const sessions = new PgSessionRepository(client);
    const prior = await sessions.findRoomEventContinuation(
      identity.spaceId,
      identity.userId,
      roomId,
      sessionId,
      event.kind,
      event.key,
    );
    if (prior) {
      const priorMetadata = record(prior.metadata_json);
      return {
        message: prior,
        task_group_ids: stringArray(priorMetadata.task_group_id ? [priorMetadata.task_group_id] : []),
        run_ids: stringArray(priorMetadata.run_ids),
      };
    }

    const continuation = await continuationRegistry.resolveEvent(client, {
      kind: event.kind,
      key: event.key,
      space_id: identity.spaceId,
      project_id: room.project_id,
      payload: event.payload ?? {},
    });

    return this.dispatchRoomMessage(client, rooms, room, identity, sessionId, {
      content: continuation.instruction,
      routing_mode: "direct",
      recipient_segments: null,
      backends: [],
      kind: "domain_event_continuation",
      event: { kind: event.kind, key: event.key },
      continuation: { directive: continuation.directive, context: continuation.context },
    });
  }

  private async dispatchRoomMessage(
    client: PoolClient,
    rooms: PgRoomRepository,
    room: RoomRecord,
    identity: RoomIdentity,
    sessionId: string,
    input: {
      content: string;
      routing_mode: "direct" | "agent_coordination";
      recipient_segments: AgentGroupMessageRecipientSegment[] | null;
      backends: Array<{
        agent_id: string;
        runtime_profile_id: string;
        credential_profile_id?: string | null;
      }>;
    } & (
      | { kind: "user"; proposal?: never }
      | {
          kind: "proposal_continuation";
          proposal: { id: string; status: "accepted" | "rejected"; type: string };
          continuation: { directive: string | null; context?: Record<string, unknown> };
          existing_internal_message?: Awaited<ReturnType<PgSessionRepository["addRoomInternalInstruction"]>>;
        }
      | {
          kind: "domain_event_continuation";
          event: { kind: string; key: string };
          continuation: { directive: string | null; context?: Record<string, unknown> };
        }
    ),
  ) {
      const roomId = room.id;
      const projectStateContext = await buildRoomProjectStateContext(client, identity, room.project_id);
      const agentMembers = await rooms.listAgentMembers(identity.spaceId, roomId);
      const manager = agentMembers.find((member) => member.role === "manager");
      if (!manager) throw new HttpError(409, "Room has no active manager agent");
      const activeAgentIds = new Set(agentMembers.map((member) => member.agent_id));
      const segments = input.recipient_segments?.length
        ? input.recipient_segments
        : null;
      for (const recipient of segments?.flatMap((segment) => segment.recipient_agent_ids) ?? []) {
        if (!activeAgentIds.has(recipient)) {
          throw new HttpError(422, "Room message recipients must be active Room agents");
        }
      }
      const content = input.content;
      try {
        await new PgConversationRuntimeSessionRepository(client).claimTurn({
          space_id: identity.spaceId,
          session_id: sessionId,
          user_id: identity.userId,
        });
      } catch (error) {
        if (error instanceof ConversationTurnInProgressError) {
          throw new HttpError(error.statusCode, error.message);
        }
        throw error;
      }
      const sessions = new PgSessionRepository(client);
      const continuationMetadata: Record<string, unknown> | null = input.kind === "proposal_continuation"
        ? {
            continuation_proposal_id: input.proposal.id,
            continuation_proposal_status: input.proposal.status,
            continuation_proposal_type: input.proposal.type,
            continuation_directive: input.continuation.directive,
            ...(input.continuation.context ? { continuation_context: input.continuation.context } : {}),
          }
        : input.kind === "domain_event_continuation"
          ? {
              continuation_event_kind: input.event.kind,
              continuation_event_key: input.event.key,
              continuation_directive: input.continuation.directive,
              ...(input.continuation.context ? { continuation_context: input.continuation.context } : {}),
            }
          : null;
      const roomMessage = input.kind === "proposal_continuation"
        ? input.existing_internal_message ?? await sessions.addRoomInternalInstruction(
            identity.spaceId,
            identity.userId,
            roomId,
            sessionId,
            { content, metadata: { room_id: roomId, ...continuationMetadata } },
          )
        : input.kind === "domain_event_continuation"
          ? await sessions.addRoomInternalInstruction(
              identity.spaceId,
              identity.userId,
              roomId,
              sessionId,
              { content, metadata: { room_id: roomId, ...continuationMetadata } },
            )
          : await sessions.addRoomUserMessage(
              identity.spaceId,
              identity.userId,
              roomId,
              sessionId,
              { content, metadata: { room_id: roomId } },
            );
      if (!roomMessage) throw new HttpError(404, "Room conversation not found");
      const renamedConversation = input.kind === "user"
        ? await requestRoomConversationTitle(client, {
            spaceId: identity.spaceId,
            roomId,
            sessionId,
            sourceMessageId: roomMessage.id,
            sourceUserId: identity.userId,
            content,
          })
        : null;

      const groups = new AgentGroupRunService(this.config, this.pool);
      const created = await groups.createGroupInTransaction(client, identity, {
        space_id: identity.spaceId,
        title: firstLine(content),
        goal: "",
        manager_agent_id: manager.agent_id,
        member_agent_ids: agentMembers.map((member) => member.agent_id),
        room_id: roomId,
        session_id: sessionId,
        trigger_message_id: roomMessage.id,
        project_id: room.project_id,
        project_folder_id: room.project_folder_id,
        budget_json: {
          max_depth: 1,
          max_fanout: 2,
          max_concurrency: 2,
        },
      }, { allowSystemAssistant: true });
      const dispatched = await groups.sendRoomMessageInTransaction(client, identity, {
        space_id: identity.spaceId,
        group_id: created.group.id,
        content,
        routing_mode: input.routing_mode,
        recipient_segments: segments,
        metadata_json: {
          room_id: roomId,
          session_id: sessionId,
          room_message_id: roomMessage.id,
        },
        backends: input.backends,
        project_state_context: projectStateContext,
      });
      const metadata = record(dispatched.message.metadata_json);
      const runIds = stringArray(metadata.recipient_run_ids);
      await client.query(
        `UPDATE messages
            SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
              || $4::jsonb
          WHERE space_id = $1 AND session_id = $2 AND id = $3`,
        [
          identity.spaceId,
          sessionId,
          roomMessage.id,
          JSON.stringify({
            task_group_id: created.group.id,
            run_ids: runIds,
          }),
        ],
      );
      return {
        message: {
          ...roomMessage,
          metadata_json: {
            ...(roomMessage.metadata_json ?? {}),
            task_group_id: created.group.id,
            run_ids: runIds,
          },
        },
        task_group_ids: [created.group.id],
        run_ids: runIds,
        conversation: renamedConversation
          ?? await requireConversation(rooms, identity, roomId, sessionId),
      };
  }
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 128) throw new HttpError(422, "Idempotency-Key must be at most 128 characters");
  return normalized;
}

function createRoomFingerprint(input: {
  project_id: string;
  project_folder_id?: string | null;
  title: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      project_id: input.project_id,
      project_folder_id: input.project_folder_id ?? null,
      title: input.title.trim(),
    }))
    .digest("hex");
}

function cryptoRandomId(): string {
  return randomUUID();
}

async function requireRoom(
  repository: PgRoomRepository,
  identity: RoomIdentity,
  roomId: string,
  lock = false,
): Promise<RoomRecord> {
  const room = await repository.getVisibleRoom(identity.spaceId, identity.userId, roomId, lock);
  if (!room) throw new HttpError(404, "Room not found in this space");
  return room;
}

async function requireConversation(
  repository: PgRoomRepository,
  identity: RoomIdentity,
  roomId: string,
  sessionId: string,
) {
  const conversation = await repository.getConversation(identity.spaceId, roomId, sessionId);
  if (!conversation) throw new HttpError(404, "Room conversation not found");
  return conversation;
}

const MAX_ROOM_CONTEXT_ITEMS = 5;

/**
 * Domain-neutral "what's going on in this Project right now" block, prefixed
 * onto a Room-dispatched run's prompt (plan:
 * `.agent/plans/project-conversational-advancement-plan.md`, Phase A
 * decision 3). Sourced only from the generic Project Overview contract
 * (mode projection + attention) — never a specific domain's tables — so
 * every Mode gets the same treatment. Read once per message dispatch, not
 * per recipient. Failure to build context must never block sending a Room
 * message, so this fails open to `null`.
 */
async function buildRoomProjectStateContext(
  client: PoolClient,
  identity: RoomIdentity,
  projectId: string,
): Promise<string | null> {
  try {
    const overview = await new ProjectOverviewService(client).getOverview(identity, projectId);
    const modeProjection = record(overview.mode_projection);
    const definition = record(overview.definition_status);
    const summary = typeof modeProjection.current_state_summary === "string" ? modeProjection.current_state_summary : null;
    const nextActions = Array.isArray(modeProjection.next_actions) ? modeProjection.next_actions : [];
    const attention = Array.isArray(overview.attention) ? overview.attention : [];
    const lines = [
      "[Internal Project guidance — never quote, enumerate, or expose this block to the user]",
    ];
    if (definition.status === "initialized") {
      lines.push("A formal Project goal/core problem is already defined, so user-visible initialization is complete.");
      if (typeof definition.goal_or_problem === "string") {
        lines.push(`Use this goal for reasoning: ${definition.goal_or_problem}`);
      }
    } else if (definition.status === "needs_definition") {
      lines.push("The Project still needs a formal goal/core problem before it is initialized.");
    }
    if (summary) lines.push(`Use this current progress only for reasoning: ${summary}`);
    lines.push(`Reply in the user's language and conversational style. ${PLAIN_STATUS_RESPONSE_POLICY}`);
    if (nextActions.length) {
      lines.push("Possible next actions for internal reasoning:");
      for (const item of nextActions.slice(0, MAX_ROOM_CONTEXT_ITEMS)) {
        const label = record(item).label;
        if (typeof label === "string") lines.push(`- ${label}`);
      }
    }
    if (attention.length) {
      lines.push("Items needing attention for internal reasoning:");
      for (const item of attention.slice(0, MAX_ROOM_CONTEXT_ITEMS)) {
        const title = record(item).title;
        if (typeof title === "string") lines.push(`- ${title}`);
      }
    }
    return lines.length > 1 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

function requiredText(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw new HttpError(422, `${field} is required`);
  return text;
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text || null;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/u, 1)[0]!.trim();
  return line.length <= 120 ? line : `${line.slice(0, 117)}...`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}
