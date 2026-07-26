import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildServer } from "../src/server";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { __setRoomServiceFactoryForTests } from "../src/modules/rooms";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setRoomServiceFactoryForTests(null);
  await app?.close();
  app = undefined;
});

function service(overrides: Record<string, unknown>) {
  return {
    createRoom: async () => { throw new Error("not used"); },
    listRooms: async () => { throw new Error("not used"); },
    getRoom: async () => { throw new Error("not used"); },
    createConversation: async () => { throw new Error("not used"); },
    listConversations: async () => { throw new Error("not used"); },
    listMessages: async () => { throw new Error("not used"); },
    sendMessage: async () => { throw new Error("not used"); },
    ...overrides,
  } as never;
}

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

describe("Room routes", () => {
  it("creates a project-bound Room through the public boundary", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seen: unknown;
    __setRoomServiceFactoryForTests(() => service({
      createRoom: async (identity: unknown, input: unknown) => {
        seen = { identity, input };
        return {
          room: {
            id: "room-1",
            space_id: "space-1",
            project_id: "project-1",
            created_by_user_id: "user-1",
            title: "Delivery Room",
            status: "active",
            created_at: "2026-07-26T00:00:00.000Z",
            updated_at: "2026-07-26T00:00:00.000Z",
            archived_at: null,
          },
          user_members: [],
          agent_members: [],
        };
      },
    }));
    app = buildServer(config(), { logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      payload: {
        project_id: "project-1",
        title: "Delivery Room",
        manager_agent_id: "agent-1",
        agent_ids: ["agent-2"],
        user_ids: ["user-2"],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      room: { id: "room-1", project_id: "project-1" },
    });
    expect(seen).toEqual({
      identity: { spaceId: "space-1", userId: "user-1" },
      input: {
        project_id: "project-1",
        title: "Delivery Room",
        manager_agent_id: "agent-1",
        agent_ids: ["agent-2"],
        user_ids: ["user-2"],
      },
    });
  });

  it("dispatches a Room message with the signed-in user's backend selection", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-2" });
    let seen: unknown;
    __setRoomServiceFactoryForTests(() => service({
      sendMessage: async (
        identity: unknown,
        roomId: string,
        sessionId: string,
        input: unknown,
      ) => {
        seen = { identity, roomId, sessionId, input };
        return {
          message: {
            id: "message-1",
            space_id: "space-1",
            session_id: "session-1",
            user_id: "user-2",
            sender_agent_id: null,
            role: "user",
            content: "Review this",
            metadata_json: {
              task_group_id: "group-1",
              run_ids: ["run-1"],
            },
            created_at: "2026-07-26T00:00:00.000Z",
          },
          task_group_ids: ["group-1"],
          run_ids: ["run-1"],
        };
      },
    }));
    app = buildServer(config(), { logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/conversations/session-1/messages",
      payload: {
        content: "Review this",
        routing_mode: "direct",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-2",
        }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      task_group_ids: ["group-1"],
      run_ids: ["run-1"],
    });
    expect(seen).toMatchObject({
      identity: { spaceId: "space-1", userId: "user-2" },
      roomId: "room-1",
      sessionId: "session-1",
      input: {
        content: "Review this",
        backends: [{
          credential_profile_id: "credential-user-2",
        }],
      },
    });
  });
});
