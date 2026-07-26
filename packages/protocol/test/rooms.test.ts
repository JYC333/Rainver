import { describe, expect, it } from "vitest";
import {
  CreateRoomRequestSchema,
  RoomDetailSchema,
  RoomMessageSchema,
  SendRoomMessageRequestSchema,
} from "../src/index";

const now = "2026-07-26T10:00:00.000Z";

describe("Room contracts", () => {
  it("parses project-bound rosters and per-recipient backend selections", () => {
    expect(CreateRoomRequestSchema.parse({
      project_id: "project-1",
      title: "Delivery Room",
      manager_agent_id: "agent-1",
      agent_ids: ["agent-2"],
      user_ids: ["user-2"],
    })).toMatchObject({
      agent_ids: ["agent-2"],
      user_ids: ["user-2"],
    });

    expect(RoomDetailSchema.parse({
      room: {
        id: "room-1",
        space_id: "space-1",
        project_id: "project-1",
        created_by_user_id: "user-1",
        title: "Delivery Room",
        status: "active",
        created_at: now,
        updated_at: now,
        archived_at: null,
      },
      user_members: [{
        id: "room-user-1",
        space_id: "space-1",
        room_id: "room-1",
        user_id: "user-1",
        role: "owner",
        status: "active",
        created_at: now,
        updated_at: now,
      }],
      agent_members: [{
        id: "room-agent-1",
        space_id: "space-1",
        room_id: "room-1",
        agent_id: "agent-1",
        role: "manager",
        status: "active",
        created_at: now,
        updated_at: now,
      }],
    }).room.project_id).toBe("project-1");

    expect(SendRoomMessageRequestSchema.parse({
      content: "@Manager review this",
      recipient_segments: [{
        recipient_agent_ids: ["agent-1"],
        content: "review this",
      }],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-2",
      }],
    }).backends[0]?.credential_profile_id).toBe("credential-user-2");
  });

  it("keeps human and agent message identity separate", () => {
    expect(RoomMessageSchema.parse({
      id: "message-user",
      space_id: "space-1",
      session_id: "session-1",
      user_id: "user-2",
      sender_agent_id: null,
      role: "user",
      content: "Please review.",
      metadata_json: null,
      created_at: now,
    })).toMatchObject({ user_id: "user-2", sender_agent_id: null });

    expect(RoomMessageSchema.parse({
      id: "message-agent",
      space_id: "space-1",
      session_id: "session-1",
      user_id: null,
      sender_agent_id: "agent-1",
      role: "assistant",
      content: "Reviewed.",
      metadata_json: { run_id: "run-1" },
      created_at: now,
    })).toMatchObject({ user_id: null, sender_agent_id: "agent-1" });
  });
});
