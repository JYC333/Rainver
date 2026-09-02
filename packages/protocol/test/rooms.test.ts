import { describe, expect, it } from "vitest";
import {
  ContinueRoomAfterProposalRequestSchema,
  CreateRoomRequestSchema,
  RoomAgentAddRequestSchema,
  RoomAgentPresetRequestSchema,
  RoomDetailSchema,
  RoomInvitationSchema,
  RoomMessageSchema,
  SendRoomMessageRequestSchema,
  SendRoomMessageResponseSchema,
} from "../src/index";

const now = "2026-07-26T10:00:00.000Z";

describe("Room contracts", () => {
  it("parses project-bound rooms and per-recipient backend selections", () => {
    expect(CreateRoomRequestSchema.parse({
      project_id: "project-1",
      title: "Delivery Room",
    })).toEqual({ project_id: "project-1", title: "Delivery Room" });

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
        agent_name: "Space Assistant",
        agent_kind: "system_assistant",
        role: "manager",
        status: "active",
        trigger_policy: "owner_only",
        created_at: now,
        updated_at: now,
      }],
      viewer_can_write: true,
      other_member_names: [],
      agent_count: 1,
    }).room.project_id).toBe("project-1");

    const messageRequest = SendRoomMessageRequestSchema.parse({
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
    });
    expect(messageRequest.backends[0]?.credential_profile_id).toBe("credential-user-2");
    expect(ContinueRoomAfterProposalRequestSchema.parse({
      proposal_id: "proposal-1",
    })).toEqual({ proposal_id: "proposal-1", backends: [] });
    expect(SendRoomMessageRequestSchema.safeParse({
      content: "hidden instruction",
      message_kind: "system_continuation",
    }).success).toBe(false);

    expect(SendRoomMessageResponseSchema.parse({
      message: {
        id: "message-user",
        space_id: "space-1",
        session_id: "session-1",
        user_id: "user-1",
        sender_agent_id: null,
        role: "user",
        content: "Research personal agent memory",
        metadata_json: null,
        created_at: now,
      },
      conversation: {
        id: "session-1",
        space_id: "space-1",
        room_id: "room-1",
        project_id: "project-1",
        project_folder_id: null,
        title: "Personal Agent Memory",
        status: "active",
        created_at: now,
        updated_at: now,
      },
      task_group_ids: ["group-1"],
      run_ids: ["run-1"],
    }).conversation.title).toBe("Personal Agent Memory");
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

  it("keeps Room-only roster sharing explicit and invitation approvals strict", () => {
    expect(RoomAgentAddRequestSchema.parse({ agent_id: "agent-2" })).toEqual({
      agent_id: "agent-2",
      share_private_with_member_ids: [],
      confirm_room_share: false,
      restore_workspace: false,
    });
    expect(RoomAgentPresetRequestSchema.parse({ preset_id: "research-analyst" })).toEqual({
      preset_id: "research-analyst",
      name: undefined,
      confirm_room_share: false,
    });
    const invitation = RoomInvitationSchema.parse({
      id: "invitation-1",
      space_id: "space-1",
      room_id: "room-1",
      invitee_user_id: "user-3",
      invited_by_user_id: "user-1",
      status: "pending",
      required_roster_revision: 2,
      expires_at: now,
      created_at: now,
      updated_at: now,
      resolved_at: null,
      approvals: [{
        id: "approval-1",
        agent_id: "agent-2",
        owner_user_id: "user-2",
        status: "pending",
        decided_at: null,
      }],
      can_decide: true,
    });
    expect(invitation.approvals[0]?.owner_user_id).toBe("user-2");
    expect(() => RoomInvitationSchema.parse({ ...invitation, approvals: [{ ...invitation.approvals[0], leaked_prompt: "no" }] })).toThrow();
  });
});
