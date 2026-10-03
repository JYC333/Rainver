import { describe, expect, it } from "vitest";
import {
  AgentRunGroupSchema,
  AgentRunGroupTimelineSchema,
  AgentRunMessageSchema,
  CreateAgentRunGroupRequestSchema,
  RunDelegationSchema,
  SendAgentRunGroupMessageRequestSchema,
  RuntimeDelegationsOutputSchema,
  SpawnChildRunRequestSchema,
  UpdateAgentRunGroupRequestSchema,
} from "../src/index";

const now = "2026-07-05T10:00:00.000Z";

describe("agent group run contracts", () => {
  it("parses create requests and timeline objects", () => {
    const request = CreateAgentRunGroupRequestSchema.parse({
      space_id: "space-1",
      title: "Review applicant packet",
      goal: "Coordinate specialist reviews and produce proposals.",
      manager_agent_id: "agent-manager",
      member_agent_ids: ["agent-manager", "agent-reader"],
      budget_json: { max_depth: 2, max_fanout: 4 },
      context_policy_json: { artifact_ids: ["artifact-1"] },
    });
    expect(request.manager_agent_id).toBe("agent-manager");

    const emptyGoalRequest = CreateAgentRunGroupRequestSchema.parse({
      space_id: "space-1",
      title: "Open room",
      manager_agent_id: "agent-manager",
      member_agent_ids: ["agent-manager"],
    });
    expect(emptyGoalRequest.goal).toBe("");

    const update = UpdateAgentRunGroupRequestSchema.parse({
      space_id: "space-1",
      goal: "",
    });
    expect(update.goal).toBe("");

    const multiRecipientMessage = SendAgentRunGroupMessageRequestSchema.parse({
      space_id: "space-1",
      group_id: "group-1",
      content: "@Planner @Reviewer compare approaches.",
      routing_mode: "direct",
      recipient_segments: [{
        recipient_agent_ids: ["agent-planner", "agent-reviewer"],
        content: "compare approaches.",
      }],
    });
    expect(multiRecipientMessage.routing_mode).toBe("direct");
    expect(multiRecipientMessage.recipient_segments?.[0]?.recipient_agent_ids).toEqual([
      "agent-planner",
      "agent-reviewer",
    ]);

    const group = AgentRunGroupSchema.parse({
      id: "group-1",
      space_id: "space-1",
      root_run_id: "run-root",
      manager_user_id: "user-1",
      manager_agent_id: "agent-manager",
      discussion_id: "discussion-1",
      title: request.title,
      goal: request.goal,
      status: "active",
      budget_json: request.budget_json,
      policy_snapshot_json: { action: "run.spawn_child" },
      created_at: now,
      updated_at: now,
    });

    const message = AgentRunMessageSchema.parse({
      id: "message-1",
      space_id: "space-1",
      group_id: group.id,
      run_id: "run-root",
      sender_actor_ref_json: { kind: "agent", id: "agent-manager" },
      sender_agent_id: "agent-manager",
      message_type: "delegation_request",
      content: "@reader summarize the packet.",
      mentions_json: [{ agent_id: "agent-reader", handle: "reader" }],
      created_at: now,
    });

    const delegation = RunDelegationSchema.parse({
      id: "delegation-1",
      space_id: "space-1",
      group_id: group.id,
      parent_run_id: "run-root",
      child_run_id: "run-child",
      request_message_id: message.id,
      requesting_agent_id: "agent-manager",
      target_agent_id: "agent-reader",
      requested_by_user_id: "user-1",
      policy_decision_record_id: "policy-1",
      status: "queued",
      instruction: "Summarize the packet.",
      tool_call_id: "call-1",
      created_at: now,
      updated_at: now,
    });

    const timeline = AgentRunGroupTimelineSchema.parse({
      group,
      members: [],
      messages: [message],
      delegations: [delegation],
    });
    expect(timeline.delegations[0]?.child_run_id).toBe("run-child");
  });

  it("rejects invalid roles, statuses, message types, and unsafe metadata", () => {
    expect(
      AgentRunGroupSchema.safeParse({
        id: "group-1",
        space_id: "space-1",
        manager_user_id: "user-1",
        title: "Task",
        goal: "Do work",
        status: "unknown",
        created_at: now,
        updated_at: now,
      }).success,
    ).toBe(false);

    expect(
      AgentRunMessageSchema.safeParse({
        id: "message-1",
        space_id: "space-1",
        group_id: "group-1",
        sender_actor_ref_json: { kind: "agent", id: "agent-1" },
        message_type: "chat",
        content: "hello",
        created_at: now,
      }).success,
    ).toBe(false);

    expect(
      RunDelegationSchema.safeParse({
        id: "delegation-1",
        space_id: "space-1",
        group_id: "group-1",
        parent_run_id: "run-root",
        requesting_agent_id: "agent-manager",
        target_agent_id: "agent-reader",
        status: "done",
        instruction: "Do it",
        created_at: now,
        updated_at: now,
      }).success,
    ).toBe(false);

    expect(
      AgentRunMessageSchema.safeParse({
        id: "message-1",
        space_id: "space-1",
        group_id: "group-1",
        sender_actor_ref_json: { kind: "agent", id: "agent-1" },
        message_type: "agent_message",
        content: "hello",
        metadata_json: { rendered_context: "raw prompt" },
        created_at: now,
      }).success,
    ).toBe(false);
  });

  it("models server-internal spawn child requests without secrets", () => {
    const request = SpawnChildRunRequestSchema.parse({
      space_id: "space-1",
      group_id: "group-1",
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      requesting_agent_id: "agent-manager",
      target_agent_id: "agent-reader",
      manager_user_id: "user-1",
      request_message_id: "message-1",
      instruction: "Read the evidence and return a summary.",
      budget_json: { max_steps: 4 },
      context_policy_json: { artifact_ids: ["artifact-1"] },
    });
    expect(request.root_run_id).toBe("run-root");

    expect(
      SpawnChildRunRequestSchema.safeParse({
        ...request,
        context_policy_json: { api_key: "sk-secret" },
      }).success,
    ).toBe(false);
  });

  it("models structured runtime delegation output without free-text parsing", () => {
    const output = RuntimeDelegationsOutputSchema.parse({
      delegations: [
        {
          target_agent_id: "agent-reader",
          instruction: "Read the evidence and return a summary.",
          reason: "Specialist review needed.",
          budget: { max_steps: 4 },
          context: { artifact_ids: ["artifact-1"] },
        },
      ],
    });
    expect(output.delegations[0]?.target_agent_id).toBe("agent-reader");

    expect(
      RuntimeDelegationsOutputSchema.safeParse({
        delegations: [
          {
            target_agent_id: "agent-reader",
            instruction: "Read raw context.",
            context: { rendered_context: "raw prompt" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
