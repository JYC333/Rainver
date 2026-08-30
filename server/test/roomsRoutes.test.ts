import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HttpError } from "../src/modules/routeUtils/common.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { __setRoomServiceFactoryForTests } from "../src/modules/rooms/routes.js";
import { roomsModule } from "../src/modules/rooms/index.js";

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
    listConversations: async () => { throw new Error("not used"); },
    listMessages: async () => { throw new Error("not used"); },
    getConversationSummary: async () => { throw new Error("not used"); },
    sendMessage: async () => { throw new Error("not used"); },
    continueAfterProposal: async () => { throw new Error("not used"); },
    ...overrides,
  } as never;
}

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
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
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      payload: {
        project_id: "project-1",
        title: "Delivery Room",
      },
      headers: { "idempotency-key": "room-route-test-1" },
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
        idempotency_key: "room-route-test-1",
      },
    });
  });

  it("speaks in a Room that has no conversation yet, and returns the one that made", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seen: unknown;
    __setRoomServiceFactoryForTests(() => service({
      sendMessage: async (
        identity: unknown,
        roomId: string,
        sessionId: string | null,
        input: unknown,
      ) => {
        seen = { identity, roomId, sessionId, input };
        return {
          message: {
            id: "message-1",
            space_id: "space-1",
            session_id: "session-new",
            user_id: "user-1",
            sender_agent_id: null,
            role: "user",
            content: "Start here",
            metadata_json: { task_group_id: "group-1", run_ids: ["run-1"] },
            created_at: "2026-07-26T00:00:00.000Z",
          },
          conversation: {
            id: "session-new",
            space_id: "space-1",
            room_id: "room-1",
            project_id: "project-1",
            project_folder_id: null,
            title: "Start here",
            status: "active",
            created_at: "2026-07-26T00:00:00.000Z",
            updated_at: "2026-07-26T00:00:00.000Z",
          },
          task_group_ids: ["group-1"],
          run_ids: ["run-1"],
        };
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/messages",
      payload: { content: "Start here" },
    });

    expect(response.statusCode).toBe(201);
    // The conversation this message created comes back on the response, so
    // the caller never has to create one first (ADR 0018 decision 5).
    expect(response.json()).toMatchObject({ conversation: { id: "session-new" } });
    // The absent session id reaches the service as null, not as the string
    // "messages" from a mis-parsed path.
    expect(seen).toMatchObject({ roomId: "room-1", sessionId: null });
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
          conversation: {
            id: "session-1",
            space_id: "space-1",
            room_id: "room-1",
            project_id: "project-1",
            project_folder_id: null,
            title: "Review this",
            status: "active",
            created_at: "2026-07-26T00:00:00.000Z",
            updated_at: "2026-07-26T00:00:00.000Z",
          },
          task_group_ids: ["group-1"],
          run_ids: ["run-1"],
        };
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

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
      conversation: { id: "session-1", title: "Review this" },
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

  it("continues only through the server-owned Proposal continuation boundary", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-2" });
    let seen: unknown;
    __setRoomServiceFactoryForTests(() => service({
      continueAfterProposal: async (
        identity: unknown,
        roomId: string,
        sessionId: string,
        input: unknown,
      ) => {
        seen = { identity, roomId, sessionId, input };
        return {
          message: { id: "internal-1", role: "system" },
          conversation: { id: "session-1" },
          task_group_ids: ["group-1"],
          run_ids: ["run-1"],
        };
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/conversations/session-1/proposal-continuations",
      payload: {
        proposal_id: "proposal-1",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-2",
        }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(seen).toEqual({
      identity: { spaceId: "space-1", userId: "user-2" },
      roomId: "room-1",
      sessionId: "session-1",
      input: {
        proposal_id: "proposal-1",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-2",
        }],
      },
    });
  });

  it("returns member-visible summary freshness without exposing owner usage metadata", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-2" });
    let seen: unknown;
    __setRoomServiceFactoryForTests(() => service({
      getConversationSummary: async (...args: unknown[]) => {
        seen = args;
        return {
          state: {
            room_id: "room-1",
            session_id: "session-1",
            status: "idle",
            active_summary_id: "summary-1",
            requested_through_message_id: "message-4",
            requested_through_created_at: "2026-07-26T00:00:04.000Z",
            retry_count: 0,
            next_attempt_at: null,
            last_error: null,
            updated_at: "2026-07-26T00:00:05.000Z",
            owner_user_id: null,
            room_title: "Delivery Room",
          },
          summary: {
            id: "summary-1",
            version: 1,
            summary_text: "Earlier decisions.",
            covered_through_message_id: "message-2",
            covered_through_created_at: "2026-07-26T00:00:02.000Z",
            covered_message_count: 2,
            source_token_estimate: 400,
            summary_token_estimate: 120,
            project_id: "project-1",
            created_at: "2026-07-26T00:00:05.000Z",
            provider_id: null,
            model: null,
            usage: null,
            audit: null,
          },
        };
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rooms/room-1/conversations/session-1/summary",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ summary: { id: "summary-1", provider_id: null, usage: null } });
    expect(seen).toEqual([{ spaceId: "space-1", userId: "user-2" }, "room-1", "session-1"]);
  });

  it("exposes roster mutations through strict request contracts", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    const seen: Array<{ method: string; args: unknown[] }> = [];
    __setRoomServiceFactoryForTests(() => service({
      listAgentCandidates: async (...args: unknown[]) => {
        seen.push({ method: "listAgentCandidates", args });
        return { agents: [], presets: [], total: 0, limit: 50, offset: 0 };
      },
      addAgent: async (...args: unknown[]) => {
        seen.push({ method: "addAgent", args });
        return { room: {}, user_members: [], agent_members: [] };
      },
      addAgentPreset: async (...args: unknown[]) => {
        seen.push({ method: "addAgentPreset", args });
        return { room: {}, user_members: [], agent_members: [] };
      },
      transferOwner: async (...args: unknown[]) => {
        seen.push({ method: "transferOwner", args });
        return { room: {}, user_members: [], agent_members: [] };
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const candidates = await app.inject({
      method: "GET",
      url: "/api/v1/rooms/room-1/agent-candidates?limit=10&offset=2",
    });
    expect(candidates.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({
      method: "listAgentCandidates",
      args: [{ spaceId: "space-1", userId: "user-1" }, "room-1", { limit: 10, offset: 2 }],
    });

    const add = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/agents",
      payload: { agent_id: "agent-2" },
    });
    expect(add.statusCode).toBe(201);
    expect(seen[1]).toMatchObject({
      method: "addAgent",
      args: [{ spaceId: "space-1", userId: "user-1" }, "room-1", {
        agent_id: "agent-2",
        share_private_with_member_ids: [],
        confirm_room_share: false,
      }],
    });

    const preset = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/agent-presets",
      payload: { preset_id: "research-analyst" },
      headers: { "idempotency-key": "preset-route-test-1" },
    });
    expect(preset.statusCode).toBe(201);
    expect(seen[2]).toMatchObject({
      method: "addAgentPreset",
      args: [{ spaceId: "space-1", userId: "user-1" }, "room-1", {
        preset_id: "research-analyst",
        confirm_room_share: false,
        idempotency_key: "preset-route-test-1",
      }],
    });

    const transfer = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/owner-transfer",
      payload: { user_id: "user-2" },
    });
    expect(transfer.statusCode).toBe(200);
    expect(seen[3]).toMatchObject({
      method: "transferOwner",
      args: [{ spaceId: "space-1", userId: "user-1" }, "room-1", "user-2"],
    });
  });

  it("copies picked content into an existing conversation through the public boundary", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seen: unknown;
    __setRoomServiceFactoryForTests(() => service({
      attachConversationReferences: async (identity: unknown, roomId: unknown, sessionId: unknown, input: unknown) => {
        seen = { identity, roomId, sessionId, input };
        return { items: [], task_group_ids: [], conversation: null, limit: 50, offset: 0 };
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/conversations/session-1/references",
      payload: {
        references: [{ kind: "messages", id: "session-0", item_ids: ["m-1"] }],
        confirm_disclosure: ["user-2"],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ items: [], limit: 50, offset: 0 });
    // The contract reaches the service intact: the picks, and the ids the
    // person confirmed — never a bare `true` the client did not send.
    expect(seen).toEqual({
      identity: { spaceId: "space-1", userId: "user-1" },
      roomId: "room-1",
      sessionId: "session-1",
      input: {
        references: [{ kind: "messages", id: "session-0", item_ids: ["m-1"] }],
        confirm_disclosure: ["user-2"],
      },
    });
  });

  it("refuses an attach that names nothing before it reaches the service", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let reached = false;
    __setRoomServiceFactoryForTests(() => service({
      attachConversationReferences: async () => { reached = true; return {}; },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/conversations/session-1/references",
      payload: { references: [] },
    });
    expect(response.statusCode).toBe(422);
    expect(reached).toBe(false);
  });

  it("carries a disclosure refusal's code to the client, so the dialog can act on it", async () => {
    // The 409 is only useful if the client can tell it from any other 409:
    // it has to name who gains access, and it has to be recognisable by code
    // rather than by prose.
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setRoomServiceFactoryForTests(() => service({
      attachConversationReferences: async () => {
        throw new HttpError(409, "Confirm the disclosure", {
          code: "reference_disclosure_confirmation_required",
          detail: "user-2 could not read this before.",
          gains_access_user_ids: ["user-2"],
        });
      },
    }));
    app = buildModuleServer(config(), [roomsModule]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/room-1/conversations/session-1/references",
      payload: { references: [{ kind: "thread", id: "session-0" }] },
    });
    expect(response.statusCode).toBe(409);
    // `HttpError`'s payload is the response body, whole: the code and the
    // named people reach the client as the schema declares them.
    expect(response.json()).toMatchObject({
      code: "reference_disclosure_confirmation_required",
      gains_access_user_ids: ["user-2"],
    });
  });
});
