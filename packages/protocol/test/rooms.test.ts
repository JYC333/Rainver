import { agentMentionRoute, agentMentionSegments, parseAgentMentions } from "../src/roomDiscussions.js";
import { describe, expect, it } from "vitest";
import {
  ContinueRoomAfterProposalRequestSchema,
  CreateRoomRequestSchema,
  RoomAgentAddRequestSchema,
  RoomAgentMutationResponseSchema,
  RoomAgentPresetRequestSchema,
  RoomDetailSchema,
  RoomInvitationSchema,
  RoomMessageSchema,
  SendRoomMessageRequestSchema,
  SendRoomMessageResponseSchema,
} from "../src/index";

const now = "2026-07-26T10:00:00.000Z";

const roomDetail = {
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
};

describe("Room contracts", () => {
  it("carries the Host's restore and archive outcomes on a roster change", () => {
    // The Agent is added either way; a restore that failed has to reach the
    // client, which the strict contract would otherwise have no field for.
    const added = RoomAgentMutationResponseSchema.parse({
      ...roomDetail,
      managed_workspace_restore: { agent_id: "agent-2", ok: false, changed: false, error: "host_offline" },
    });
    expect(added.managed_workspace_restore).toEqual({ agent_id: "agent-2", ok: false, changed: false, error: "host_offline" });
    const removed = RoomAgentMutationResponseSchema.parse({
      ...roomDetail,
      revoked_grant_count: 1,
      managed_workspace_archive: [{ agent_id: "agent-2", ok: true, changed: true, error: null }],
    });
    expect(removed.managed_workspace_archive).toHaveLength(1);
  });

  it("parses project-bound rooms and per-recipient backend selections", () => {
    expect(CreateRoomRequestSchema.parse({
      project_id: "project-1",
      title: "Delivery Room",
    })).toEqual({ project_id: "project-1", title: "Delivery Room" });

    expect(RoomDetailSchema.parse(roomDetail).room.project_id).toBe("project-1");

    const messageRequest = SendRoomMessageRequestSchema.parse({
      content: "@Manager review this",
      discussion_id: "discussion-1",
      recipient_segments: [{
        recipient_agent_ids: ["agent-1"],
        content: "review this",
      }],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    expect(messageRequest.backends[0]?.runtime_profile_id).toBe("runtime-cli");
    expect(messageRequest.discussion_id).toBe("discussion-1");
    expect(ContinueRoomAfterProposalRequestSchema.parse({
      proposal_id: "proposal-1",
    })).toEqual({ proposal_id: "proposal-1", backends: [] });
    expect(SendRoomMessageRequestSchema.safeParse({
      content: "hidden instruction",
      message_kind: "system_continuation",
    }).success).toBe(false);
    expect(SendRoomMessageRequestSchema.parse({
      content: "你可以派 @Codex 去查",
      routing_mode: "agent_coordination",
      coordination_target_agent_ids: ["agent-codex"],
    }).coordination_target_agent_ids).toEqual(["agent-codex"]);
    // Targets are the manager's to arrange; a direct send has none.
    expect(SendRoomMessageRequestSchema.safeParse({
      content: "@Codex check",
      coordination_target_agent_ids: ["agent-codex"],
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
      metadata_json: null,
      run_id: "run-1",
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

  it("requires a coherent workspace target for an explicitly host-bound preset", () => {
    const base = {
      preset_id: "research-analyst",
      execution: {
        host_id: "host-1",
        workspace_location_id: "location-1",
        workspace_mode: "location" as const,
        runtime_key: "claude_code",
        installation: "managed:1.0.0",
      },
    };
    expect(RoomAgentPresetRequestSchema.safeParse(base).success).toBe(true);
    expect(RoomAgentPresetRequestSchema.safeParse({
      ...base,
      execution: { ...base.execution, workspace_location_id: null },
    }).success).toBe(false);
    expect(RoomAgentPresetRequestSchema.safeParse({
      ...base,
      execution: { ...base.execution, workspace_mode: "managed", workspace_location_id: "location-1" },
    }).success).toBe(false);
  });
});

describe("addressing Agents in an Agent's reply", () => {
  const roster = [
    { agent_id: "agent-research", label: "Research Specialist" },
    { agent_id: "agent-research-lead", label: "Research" },
    { agent_id: "agent-coder", label: "Coder" },
  ];

  it("matches the longest roster label, case-insensitively, only where a word starts", () => {
    const parsed = parseAgentMentions("@research specialist can you check this? cc @Coder", roster);
    expect(parsed.mentioned_agent_ids).toEqual(["agent-research", "agent-coder"]);
    // The opening mention addresses; `cc @Coder` only refers to Coder.
    expect(parsed.addressed_agent_ids).toEqual(["agent-research"]);
    expect(parsed.segments).toEqual([
      { recipient_agent_ids: ["agent-research"], content: "@Research Specialist can you check this? cc @Coder" },
    ]);
    expect(parseAgentMentions("email me at someone@Coder.example", roster).mentioned_agent_ids).toEqual([]);
    expect(parseAgentMentions("@Coders are busy", roster).mentioned_agent_ids).toEqual([]);
  });

  it("never reads code as mentioning anyone, and a mid-sentence mention addresses nobody", () => {
    const parsed = parseAgentMentions("Thoughts, @Research @Coder?\n```ts\n@Coder decorator\n```\nand `@Research`", roster);
    expect(parsed.mentioned_agent_ids).toEqual(["agent-research-lead", "agent-coder"]);
    expect(parsed.segments).toEqual([]);
    expect(parseAgentMentions("`@Coder` look at this", roster).mentioned_agent_ids).toEqual([]);
  });

  it("finds mentions written against CJK text, which has no spaces between words", () => {
    const cjkRoster = [...roster, { agent_id: "agent-researcher", label: "研究员" }];
    expect(parseAgentMentions("我同意，@研究员请补充一下数据来源。", cjkRoster).mentioned_agent_ids).toEqual(["agent-researcher"]);
    expect(parseAgentMentions("请@研究员 看看", cjkRoster).mentioned_agent_ids).toEqual(["agent-researcher"]);
    expect(parseAgentMentions("@Coder请检查", cjkRoster).mentioned_agent_ids).toEqual(["agent-coder"]);
    // Latin text keeps its word boundaries.
    expect(parseAgentMentions("someone@Coder and @Coders", cjkRoster).mentioned_agent_ids).toEqual([]);
    // Found, but inside the sentence: a reference.
    expect(parseAgentMentions("你可以派@Coder去查", cjkRoster)).toMatchObject({
      mentioned_agent_ids: ["agent-coder"], addressed_agent_ids: [], segments: [],
    });
    expect(parseAgentMentions("@Coder请检查", cjkRoster).addressed_agent_ids).toEqual(["agent-coder"]);
  });

  it("keeps positions when lowercasing changes a character's length", () => {
    const parsed = parseAgentMentions("İİ\n@Coder look", roster);
    expect(parsed.mentioned_agent_ids).toEqual(["agent-coder"]);
    expect(parsed.segments).toEqual([{ recipient_agent_ids: ["agent-coder"], content: "İİ\n@Coder look" }]);
  });
});

describe("routing a message by where its mentions stand", () => {
  const A = { type: "mention" as const, id: "a", label: "A" };
  const B = { type: "mention" as const, id: "b", label: "B" };
  const text = (value: string) => ({ type: "text" as const, text: value });

  it("sends a message with no mention to the manager", () => {
    expect(agentMentionRoute([text("hello")])).toMatchObject({ default_route: null, direct_segments: [], mentioned_agent_ids: [] });
  });

  it("addresses a mention that opens the message or a line, list markers included", () => {
    expect(agentMentionRoute([A, text(" do x")])).toMatchObject({
      default_route: "direct",
      addressed_agent_ids: ["a"],
      direct_segments: [{ recipient_agent_ids: ["a"], content: "@A do x" }],
    });
    expect(agentMentionRoute([text("  "), A, text(" do x")]).default_route).toBe("direct");
    expect(agentMentionRoute([text("Context first.\n"), A, text(" do x")])).toMatchObject({
      default_route: "direct",
      direct_segments: [{ recipient_agent_ids: ["a"], content: "Context first.\n@A do x" }],
    });
    for (const marker of ["- ", "* ", "1. ", "2) "]) {
      expect(agentMentionRoute([text(`Intro\n${marker}`), A, text(" do x")]).addressed_agent_ids).toEqual(["a"]);
    }
  });

  it("reads a mention on a quoted line as a reference", () => {
    for (const marker of ["> ", ">", "> - "]) {
      const route = agentMentionRoute([text(`引用原话：\n${marker}`), A, text(" 查一下")]);
      expect(route.default_route).toBe("agent_coordination");
      expect(route.addressed_agent_ids).toEqual([]);
    }
    // An Agent reply quoting someone summons nobody.
    const reply = parseAgentMentions("引用原话：\n> @Coder 查一下", [{ agent_id: "agent-coder", label: "Coder" }]);
    expect(reply.addressed_agent_ids).toEqual([]);
    expect(reply.segments).toEqual([]);
  });

  it("judges each line on its own, so a reference does not absorb the next line's address", () => {
    const route = agentMentionRoute([text("请参考 "), A, text("\n"), B, text(" 修复构建")]);
    expect(route.default_route).toBe("direct");
    expect(route.addressed_agent_ids).toEqual(["b"]);
    expect(route.mentioned_agent_ids).toEqual(["a", "b"]);
    expect(route.direct_segments).toEqual([{ recipient_agent_ids: ["b"], content: "请参考 @A\n@B 修复构建" }]);
    // Two line-opening addresses stay two segments, not one cluster.
    expect(agentMentionRoute([A, text("\n"), B, text(" do y")]).direct_segments).toEqual([
      { recipient_agent_ids: ["a"], content: "@A" },
      { recipient_agent_ids: ["b"], content: "@B do y" },
    ]);
  });

  it("segments several address clusters, each keeping its own mentions", () => {
    expect(agentMentionRoute([A, text(" do x\n"), B, text(" do y")]).direct_segments).toEqual([
      { recipient_agent_ids: ["a"], content: "@A do x" },
      { recipient_agent_ids: ["b"], content: "@B do y" },
    ]);
    expect(agentMentionRoute([A, text(" "), B, text(" both do x")]).direct_segments).toEqual([
      { recipient_agent_ids: ["a", "b"], content: "@A @B both do x" },
    ]);
  });

  it("hands a message of mid-sentence references to the manager with the references as targets", () => {
    const route = agentMentionRoute([text("提交吧，你可以派 "), A, text(" 去查")]);
    expect(route).toMatchObject({
      default_route: "agent_coordination",
      mentioned_agent_ids: ["a"],
      addressed_agent_ids: [],
      // What a person's explicit "send directly" delivers.
      direct_segments: [{ recipient_agent_ids: ["a"], content: "提交吧，你可以派 @A 去查" }],
    });
    expect(agentMentionRoute([text("先看下上下文"), A, text("修构建")]).default_route).toBe("agent_coordination");
    expect(agentMentionRoute([text("Hi -"), A]).default_route).toBe("agent_coordination");
  });

  it("routes an opening address directly and leaves later references in its text", () => {
    const route = agentMentionRoute([A, text(" please ask "), B, text(" about it")]);
    expect(route.default_route).toBe("direct");
    expect(route.mentioned_agent_ids).toEqual(["a", "b"]);
    expect(route.direct_segments).toEqual([{ recipient_agent_ids: ["a"], content: "@A please ask @B about it" }]);
  });

  it("keys the route by the mentions and their roles, not the surrounding text", () => {
    const key = agentMentionRoute([text("see "), A]).key;
    expect(agentMentionRoute([text("please see "), A, text(" now")]).key).toBe(key);
    expect(agentMentionRoute([A, text(" see")]).key).not.toBe(key);
  });

  it("segments every cluster only when asked to", () => {
    const tokens = [text("Intro "), A, text(" do x "), B, text(" do y")];
    expect(agentMentionSegments(tokens)).toEqual([]);
    expect(agentMentionSegments(tokens, { include: "all" })).toEqual([
      { recipient_agent_ids: ["a"], content: "Intro @A do x" },
      { recipient_agent_ids: ["b"], content: "@B do y" },
    ]);
  });
});
