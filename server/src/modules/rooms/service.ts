import type { ServerConfig } from "../../config";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool";
import { AgentGroupRunService, type AgentGroupMessageRecipientSegment } from "../agentGroups/service";
import { PgAgentGroupRepository } from "../agentGroups/repository";
import { HttpError, withDbTransaction } from "../routeUtils/common";
import { PgSessionRepository } from "../sessions/repository";
import {
  assertProjectReadable,
  assertProjectWriter,
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

export interface RoomIdentity {
  spaceId: string;
  userId: string;
}

export class RoomService {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
  ) {}

  static fromConfig(config: ServerConfig): RoomService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new RoomService(config, getDbPool(config.databaseUrl));
  }

  async createRoom(identity: RoomIdentity, input: {
    project_id: string;
    project_folder_id?: string | null;
    title: string;
    manager_agent_id: string;
    agent_ids: string[];
    user_ids: string[];
  }): Promise<{
    room: RoomRecord;
    user_members: RoomUserMemberRecord[];
    agent_members: RoomAgentMemberRecord[];
  }> {
    return withDbTransaction(this.pool, async (client) => {
      await assertProjectWriter(
        client,
        identity.spaceId,
        input.project_id,
        identity.userId,
      );
      await lockActiveProjectForMutation(client, identity.spaceId, input.project_id);
      if (input.project_folder_id) {
        const folder = await new PgProjectFolderRepository(client, this.config).get(
          identity,
          input.project_id,
          input.project_folder_id,
        );
        if (!folder || folder.status !== "active" || !folder.execution_enabled) {
          throw new HttpError(
            422,
            "project_folder_id must identify an active execution-enabled folder in this Project",
          );
        }
      }
      const userIds = uniqueIds([identity.userId, ...input.user_ids]);
      const agentIds = uniqueIds([input.manager_agent_id, ...input.agent_ids]);
      await assertActiveSpaceUsers(client, identity.spaceId, userIds);
      for (const userId of userIds) {
        await assertProjectReadable(client, identity.spaceId, input.project_id, userId);
      }
      await assertActiveAgents(client, identity, agentIds);
      const repository = new PgRoomRepository(client);
      const room = await repository.createRoom({
        space_id: identity.spaceId,
        project_id: input.project_id,
        project_folder_id: input.project_folder_id ?? null,
        created_by_user_id: identity.userId,
        title: requiredText(input.title, "title"),
      });
      for (const userId of userIds) {
        await repository.addUserMember({
          space_id: identity.spaceId,
          room_id: room.id,
          user_id: userId,
          role: userId === identity.userId ? "owner" : "member",
        });
      }
      for (const agentId of agentIds) {
        await repository.addAgentMember({
          space_id: identity.spaceId,
          room_id: room.id,
          agent_id: agentId,
          role: agentId === input.manager_agent_id ? "manager" : "member",
        });
      }
      return {
        room,
        user_members: await repository.listUserMembers(identity.spaceId, room.id),
        agent_members: await repository.listAgentMembers(identity.spaceId, room.id),
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
        title: optionalText(input.title),
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
    await requireConversation(roomRepository, identity, roomId, sessionId);
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
      limit: input.limit,
      offset: input.offset,
    };
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
      const content = requiredText(input.content, "content");
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
      const roomMessage = await sessions.addRoomUserMessage(
        identity.spaceId,
        identity.userId,
        roomId,
        sessionId,
        {
          content,
          metadata: { room_id: roomId },
        },
      );
      if (!roomMessage) throw new HttpError(404, "Room conversation not found");

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
      });
      const dispatched = await groups.sendRoomMessageInTransaction(client, identity, {
        space_id: identity.spaceId,
        group_id: created.group.id,
        content,
        routing_mode: input.routing_mode ?? "direct",
        recipient_segments: segments,
        metadata_json: {
          room_id: roomId,
          session_id: sessionId,
          room_message_id: roomMessage.id,
        },
        backends: input.backends ?? [],
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
      };
    });
  }
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

async function assertActiveSpaceUsers(db: PoolClient, spaceId: string, userIds: string[]) {
  const result = await db.query<{ user_id: string }>(
    `SELECT user_id
       FROM space_memberships
      WHERE space_id = $1 AND user_id = ANY($2::varchar[]) AND status = 'active'`,
    [spaceId, userIds],
  );
  const active = new Set(result.rows.map((row) => row.user_id));
  if (userIds.some((userId) => !active.has(userId))) {
    throw new HttpError(422, "Every Room user must be an active member of this space");
  }
}

async function assertActiveAgents(
  db: PoolClient,
  identity: RoomIdentity,
  agentIds: string[],
) {
  const rows = await new PgAgentGroupRepository(db).listAgentStatuses(
    identity.spaceId,
    identity.userId,
    agentIds,
  );
  const active = new Set(rows.filter((row) => row.status === "active").map((row) => row.id));
  if (agentIds.some((agentId) => !active.has(agentId))) {
    throw new HttpError(422, "Every Room agent must be active and visible in this space");
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

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
