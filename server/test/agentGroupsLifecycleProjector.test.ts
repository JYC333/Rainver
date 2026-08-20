import { describe, expect, it } from "vitest";
import { AgentGroupRunLifecycleProjector } from "../src/modules/agentGroups";
import type { ServerConfig } from "../src/config";
import type { Pool, PoolClient } from "../src/db/pool";
import type { RunRecord } from "../src/modules/runs/repository";
import type {
  AgentRunGroupRecord,
  AgentRunMessageRecord,
  RunDelegationRecord,
} from "../src/modules/agentGroups/repository";
import type { JobRecord } from "../src/modules/jobs/repository";

function childRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-child",
    space_id: "space-1",
    agent_id: "agent-worker",
    agent_version_id: "agent-version-worker",
    status: "running",
    mode: "live",
    prompt: null,
    instruction: null,
    project_folder_id: "workspace-1",
    session_id: null,
    project_id: null,
    parent_run_id: "run-parent",
    root_run_id: "run-root",
    run_group_id: "group-1",
    delegation_id: "delegation-1",
    adapter_type: "model_api",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "delegation",
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

function delegation(overrides: Partial<RunDelegationRecord> = {}): RunDelegationRecord {
  return {
    id: "delegation-1",
    space_id: "space-1",
    group_id: "group-1",
    parent_run_id: "run-parent",
    child_run_id: "run-child",
    request_message_id: "message-request",
    requesting_agent_id: "agent-manager",
    target_agent_id: "agent-worker",
    requested_by_user_id: "user-1",
    policy_decision_record_id: "policy-1",
    status: "queued",
    instruction: "Summarize evidence.",
    reason: null,
    budget_json: {},
    context_policy_json: {},
    result_summary: null,
    tool_call_id: null,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function group(overrides: Partial<AgentRunGroupRecord> = {}): AgentRunGroupRecord {
  return {
    id: "group-1",
    space_id: "space-1",
    root_run_id: "run-root",
    manager_user_id: "user-1",
    manager_agent_id: "agent-manager",
    room_id: null,
    session_id: null,
    trigger_message_id: null,
    project_id: null,
    project_folder_id: null,
    title: "Review room",
    goal: "Coordinate review work.",
    status: "active",
    budget_json: {},
    policy_snapshot_json: { context_policy_json: {} },
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

function userMessage(overrides: Partial<AgentRunMessageRecord> = {}): AgentRunMessageRecord {
  return {
    id: "message-user",
    space_id: "space-1",
    group_id: "group-1",
    run_id: "run-parent",
    parent_message_id: null,
    sender_actor_ref_json: { actor_type: "user", user_id: "user-1" },
    sender_user_id: "user-1",
    sender_agent_id: null,
    message_type: "user_instruction",
    content: "Ask two reviewers to answer 1+1.",
    mentions_json: [{ agent_id: "agent-manager" }],
    metadata_json: { root_run_id: "run-root" },
    created_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

class FakePool {
  client: FakeClient;

  constructor(state: FakeState) {
    this.client = new FakeClient(state);
  }

  async connect(): Promise<PoolClient> {
    return this.client as unknown as PoolClient;
  }
}

interface FakeState {
  runs: Map<string, RunRecord>;
  delegations: Map<string, RunDelegationRecord>;
  group?: AgentRunGroupRecord;
  messages: AgentRunMessageRecord[];
  events: Array<{
    run_id: string;
    event_type: string;
    status: string;
    summary: string | null;
    metadata_json: Record<string, unknown>;
  }>;
  jobs?: JobRecord[];
}

class FakeClient {
  constructor(private readonly state: FakeState) {}

  release(): void {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE run_delegations") && sql.includes("status = 'running'")) {
      const row = this.state.delegations.get(String(params[1]));
      if (
        row &&
        row.space_id === params[0] &&
        row.child_run_id === params[2] &&
        row.status === "queued"
      ) {
        const updated = { ...row, status: "running", updated_at: String(params[3]) };
        this.state.delegations.set(updated.id, updated);
        return { rows: [updated as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE run_delegations") && sql.includes("completed_at = $6")) {
      const row = this.state.delegations.get(String(params[1]));
      if (
        row &&
        row.space_id === params[0] &&
        row.child_run_id === params[2] &&
        (row.status === "queued" || row.status === "running")
      ) {
        const updated = {
          ...row,
          status: String(params[3]),
          result_summary: String(params[4]),
          updated_at: String(params[5]),
          completed_at: String(params[5]),
        };
        this.state.delegations.set(updated.id, updated);
        return { rows: [updated as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM run_delegations") && sql.includes("child_run_id = $3")) {
      const row = [...this.state.delegations.values()].find(
        (item) =>
          item.space_id === params[0] &&
          item.id === params[1] &&
          item.child_run_id === params[2],
      );
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM run_delegations") && sql.includes("parent_run_id = $2")) {
      const rows = [...this.state.delegations.values()].filter(
        (item) => item.space_id === params[0] && item.parent_run_id === params[1],
      );
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("FROM runs r") && sql.includes("WHERE r.space_id = $1 AND r.id = $2")) {
      const row = this.state.runs.get(String(params[1]));
      return {
        rows: row && row.space_id === params[0] ? [row as Row] : [],
        rowCount: row && row.space_id === params[0] ? 1 : 0,
      };
    }
    if (sql.includes("WITH scoped_runs AS")) {
      return {
        rows: [{
          agent_run_count: 1,
          completed_agent_run_count: 0,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          estimated_cost_usd: null,
          model_names: [],
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_run_groups")) {
      const row = this.state.group;
      return {
        rows: row && row.space_id === params[0] && row.id === params[1] ? [row as Row] : [],
        rowCount: row && row.space_id === params[0] && row.id === params[1] ? 1 : 0,
      };
    }
    if (sql.includes("r.status = 'waiting_for_dependency'")) {
      const rows = [...this.state.runs.values()].filter((run) => {
        const waiting = run.output_json && typeof run.output_json === "object" && !Array.isArray(run.output_json)
          ? (run.output_json as Record<string, unknown>).waiting_for_results
          : null;
        const waitRecord = waiting && typeof waiting === "object" && !Array.isArray(waiting)
          ? waiting as Record<string, unknown>
          : {};
        return run.space_id === params[0] &&
          run.run_group_id === params[1] &&
          run.status === "waiting_for_dependency" &&
          Array.isArray(waitRecord.depends_on_run_ids) &&
          waitRecord.depends_on_run_ids.includes(params[2]);
      });
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("WITH user_message AS")) {
      const userMessage = this.state.messages.find(
        (message) =>
          message.space_id === params[0] &&
          message.group_id === params[1] &&
          message.run_id === params[2] &&
          message.message_type === "user_instruction",
      );
      const linkedMessage = this.state.messages.find(
        (message) =>
          message.space_id === params[0] &&
          message.group_id === params[1] &&
          message.run_id === params[2] &&
          message.parent_message_id,
      );
      const multiRecipientMessage = this.state.messages.find(
        (message) => {
          if (
            message.space_id !== params[0] ||
            message.group_id !== params[1] ||
            message.message_type !== "user_instruction"
          ) {
            return false;
          }
          const metadata = message.metadata_json ?? {};
          return metadata.recipient_run_id === params[2] ||
            (Array.isArray(metadata.recipient_run_ids) && metadata.recipient_run_ids.includes(params[2]));
        },
      );
      const anyMessage = this.state.messages.find(
        (message) =>
          message.space_id === params[0] &&
          message.group_id === params[1] &&
          message.run_id === params[2],
      );
      const parentMessageId = userMessage?.id ??
        linkedMessage?.parent_message_id ??
        multiRecipientMessage?.id ??
        anyMessage?.id ??
        null;
      return {
        rows: [{ parent_message_id: parentMessageId } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_run_messages") && sql.includes("message_type = 'agent_message'")) {
      const row = this.state.messages.find(
        (message) =>
          message.space_id === params[0] &&
          message.group_id === params[1] &&
          message.run_id === params[2] &&
          message.message_type === "agent_message",
      );
      return { rows: row ? [{ id: row.id } as Row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM agents")) {
      return {
        rows: [{ id: "agent-manager", status: "active", current_version_id: "version-manager" }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_versions")) {
      return { rows: [{ id: "version-manager" }] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM agent_runtime_profiles")) {
      return {
        rows: [{
          id: "profile-manager",
          space_id: "space-1",
          agent_id: "agent-manager",
          name: "Model API",
          adapter_type: "model_api",
          model_provider_id: "provider-1",
          model_name: "gpt-test",
          credential_profile_id: null,
          runtime_config_json: {},
          runtime_policy_json: {},
          enabled: true,
          is_default: true,
          created_at: "2026-07-05T00:00:00.000Z",
          updated_at: "2026-07-05T00:00:00.000Z",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM model_providers") || sql.includes("JOIN model_providers")) {
      return {
        rows: [{
          id: "provider-1",
          name: "Provider",
          provider_type: "openai",
          default_model: "gpt-test",
          enabled: true,
          credential_id: "credential-1",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO runs")) {
      const row = {
        ...childRun({
          id: String(params[0]),
          agent_id: String(params[2]),
          agent_version_id: String(params[3]),
          runtime_profile_id: params[4] ? String(params[4]) : null,
          project_folder_id: params[6] ? String(params[6]) : null,
          session_id: params[7] ? String(params[7]) : null,
          parent_run_id: params[8] ? String(params[8]) : null,
          root_run_id: params[9] ? String(params[9]) : null,
          run_group_id: params[10] ? String(params[10]) : null,
          delegation_id: params[11] ? String(params[11]) : null,
          prompt: params[17] ? String(params[17]) : null,
          instruction: params[18] ? String(params[18]) : null,
          project_id: params[28] ? String(params[28]) : null,
          trigger_origin: String(params[15]),
          status: "queued",
        }),
      };
      this.state.runs.set(row.id, row);
      return { rows: [row as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO jobs")) {
      const row: JobRecord = {
        id: String(params[0]),
        space_id: String(params[1]),
        user_id: params[2] ? String(params[2]) : null,
        project_folder_id: params[3] ? String(params[3]) : null,
        agent_id: params[4] ? String(params[4]) : null,
        job_type: String(params[5]),
        status: "pending",
        priority: Number(params[6]),
        payload_json: JSON.parse(String(params[7])) as Record<string, unknown>,
        result_json: null,
        error: null,
        attempts: 0,
        max_attempts: Number(params[8]),
        scheduled_at: String(params[9]),
        claimed_by: null,
        claimed_at: null,
        started_at: null,
        completed_at: null,
        heartbeat_at: null,
        created_at: String(params[10]),
        updated_at: String(params[10]),
      };
      this.state.jobs?.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }
    if (sql.includes("UPDATE runs") && sql.includes("status = 'queued'")) {
      const row = this.state.runs.get(String(params[1]));
      if (row && row.space_id === params[0] && row.status === "waiting_for_dependency") {
        const outputJson = {
          ...((row.output_json && typeof row.output_json === "object" && !Array.isArray(row.output_json))
            ? row.output_json as Record<string, unknown>
            : {}),
          ...JSON.parse(String(params[3])) as Record<string, unknown>,
        };
        const updated = {
          ...row,
          status: "queued",
          prompt: String(params[2]),
          output_json: outputJson,
          error_json: row.error_json ?? {},
          error_message: null,
          updated_at: String(params[4]),
        };
        this.state.runs.set(updated.id, updated);
        return { rows: [updated as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO agent_run_messages")) {
      const row: AgentRunMessageRecord = {
        id: String(params[0]),
        space_id: String(params[1]),
        group_id: String(params[2]),
        run_id: params[3] ? String(params[3]) : null,
        parent_message_id: params[4] ? String(params[4]) : null,
        sender_actor_ref_json: JSON.parse(String(params[5])) as Record<string, unknown>,
        sender_user_id: params[6] ? String(params[6]) : null,
        sender_agent_id: params[7] ? String(params[7]) : null,
        message_type: String(params[8]),
        content: String(params[9]),
        mentions_json: JSON.parse(String(params[10])) as unknown[],
        metadata_json: JSON.parse(String(params[11])) as Record<string, unknown>,
        created_at: String(params[12]),
      };
      this.state.messages.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO run_events")) {
      this.state.events.push({
        run_id: String(params[1]),
        event_type: String(params[5]),
        status: String(params[6]),
        summary: params[7] ? String(params[7]) : null,
        metadata_json: JSON.parse(String(params[15])) as Record<string, unknown>,
      });
      return {
        rows: [
          {
            id: String(params[2]),
            space_id: String(params[0]),
            run_id: String(params[1]),
            event_index: this.state.events.length - 1,
            event_type: String(params[5]),
            status: String(params[6]),
          } as Row,
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

function projectorFor(state: FakeState): AgentGroupRunLifecycleProjector {
  // Every fixture group in this file has room_id: null, so the Phase 3
  // Room-notification path (which needs a real ServerConfig only to
  // construct RoomService) always short-circuits before touching config.
  return new AgentGroupRunLifecycleProjector(new FakePool(state) as unknown as Pool, {} as ServerConfig);
}

describe("AgentGroupRunLifecycleProjector", () => {
  it("projects completed manager run output as a chat message once", async () => {
    const managerRun = childRun({
      id: "run-parent",
      agent_id: "agent-manager",
      agent_version_id: "agent-version-manager",
      parent_run_id: null,
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "Ask two reviewers to answer 1+1.",
      project_folder_id: null,
      status: "succeeded",
      output_json: canonicalOutput("I will ask both reviewers and report back."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const state: FakeState = {
      runs: new Map([["run-parent", managerRun]]),
      delegations: new Map(),
      messages: [userMessage()],
      events: [],
    };

    await projectorFor(state).markDelegatedRunTerminal(managerRun);
    await projectorFor(state).markDelegatedRunTerminal(managerRun);

    const agentMessages = state.messages.filter((message) => message.message_type === "agent_message");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toMatchObject({
      run_id: "run-parent",
      parent_message_id: "message-user",
      sender_agent_id: "agent-manager",
      content: "I will ask both reviewers and report back.",
      metadata_json: {
        projected_from_run_id: "run-parent",
        root_run_id: "run-root",
      },
    });
  });

  it("projects direct non-manager run output from the refreshed run record", async () => {
    const completeWorkerRun = childRun({
      id: "run-direct",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "@Coding Reviewer 354*568=?",
      status: "succeeded",
      output_json: canonicalOutput("354 * 568 = 201072."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const terminalCallbackRun = childRun({
      id: "run-direct",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "@Coding Reviewer 354*568=?",
      status: "succeeded",
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const state: FakeState = {
      runs: new Map([["run-direct", completeWorkerRun]]),
      delegations: new Map(),
      messages: [
        userMessage({
          run_id: "run-direct",
          content: "@Coding Reviewer 354*568=?",
          mentions_json: [{ agent_id: "agent-worker" }],
        }),
      ],
      events: [],
    };

    await projectorFor(state).markDelegatedRunTerminal(terminalCallbackRun);

    const agentMessage = state.messages.find((message) => message.message_type === "agent_message");
    expect(agentMessage).toMatchObject({
      run_id: "run-direct",
      parent_message_id: "message-user",
      sender_agent_id: "agent-worker",
      content: "354 * 568 = 201072.",
      metadata_json: {
        projected_from_run_id: "run-direct",
        parent_run_id: "run-root",
        root_run_id: "run-root",
      },
    });
  });

  it("links multi-recipient run output back to the shared user message", async () => {
    const reviewerRun = childRun({
      id: "run-reviewer",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "@Manager @Reviewer compare notes.",
      status: "succeeded",
      output_json: canonicalOutput("Reviewer result."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const state: FakeState = {
      runs: new Map([["run-reviewer", reviewerRun]]),
      delegations: new Map(),
      messages: [
        userMessage({
          id: "message-multi",
          run_id: "run-manager",
          content: "@Manager @Reviewer compare notes.",
          mentions_json: [{ agent_id: "agent-manager" }, { agent_id: "agent-worker" }],
          metadata_json: {
            recipient_agent_ids: ["agent-manager", "agent-worker"],
            recipient_run_ids: ["run-manager", "run-reviewer"],
          },
        }),
      ],
      events: [],
    };

    await projectorFor(state).markDelegatedRunTerminal({
      ...reviewerRun,
      output_json: undefined,
    });

    const agentMessage = state.messages.find((message) => message.message_type === "agent_message");
    expect(agentMessage).toMatchObject({
      run_id: "run-reviewer",
      parent_message_id: "message-multi",
      sender_agent_id: "agent-worker",
      content: "Reviewer result.",
    });
  });

  it("requeues a waiting room run after all dependency runs complete", async () => {
    const reviewerRun = childRun({
      id: "run-reviewer",
      agent_id: "agent-reviewer",
      agent_name: "Coding Reviewer",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "test",
      project_folder_id: null,
      status: "succeeded",
      output_json: canonicalOutput("Reviewer test result."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const reviewerOneRun = childRun({
      id: "run-reviewer-1",
      agent_id: "agent-reviewer-1",
      agent_name: "Coding Reviewer-1",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "1+1",
      project_folder_id: null,
      status: "running",
      output_json: null,
    });
    const waitingManagerRun = childRun({
      id: "run-manager",
      agent_id: "agent-manager",
      agent_name: "Manager",
      agent_version_id: "agent-version-manager",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "summarize their results",
      project_folder_id: null,
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          status: "waiting",
          scope: "current_turn",
          reason: "Need the other addressed agents before summarizing.",
          resume_instruction: "Summarize the reviewer results for the user.",
          depends_on_run_ids: ["run-reviewer", "run-reviewer-1"],
          pending_run_ids: ["run-reviewer-1"],
        },
      },
    });
    const state: FakeState = {
      group: group(),
      runs: new Map([
        ["run-root", childRun({
          id: "run-root",
          agent_id: "agent-manager",
          parent_run_id: null,
          root_run_id: "run-root",
          delegation_id: null,
          project_folder_id: null,
        })],
        ["run-reviewer", reviewerRun],
        ["run-reviewer-1", reviewerOneRun],
        ["run-manager", waitingManagerRun],
      ]),
      delegations: new Map(),
      messages: [
        userMessage({
          id: "message-direct",
          run_id: "run-reviewer",
          content: "@Coding Reviewer test @Coding Reviewer-1 1+1 @Manager summarize their results",
          mentions_json: [
            { agent_id: "agent-reviewer" },
            { agent_id: "agent-reviewer-1" },
            { agent_id: "agent-manager" },
          ],
          metadata_json: {
            root_run_id: "run-root",
            recipient_run_ids: ["run-reviewer", "run-reviewer-1", "run-manager"],
          },
        }),
      ],
      events: [],
      jobs: [],
    };

    await projectorFor(state).markDelegatedRunTerminal(reviewerRun);
    expect(state.jobs).toHaveLength(0);

    const completedReviewerOneRun = {
      ...reviewerOneRun,
      status: "succeeded",
      output_json: canonicalOutput("1 + 1 = 2."),
      ended_at: "2026-07-05T00:02:00.000Z",
    };
    state.runs.set("run-reviewer-1", completedReviewerOneRun);
    await projectorFor(state).markDelegatedRunTerminal(completedReviewerOneRun);
    await projectorFor(state).markDelegatedRunTerminal(completedReviewerOneRun);

    const resumeEvent = state.messages.find(
      (message) => message.metadata_json?.wait_for_results_run_id === "run-manager",
    );
    expect(resumeEvent).toMatchObject({
      message_type: "system_event",
      parent_message_id: "message-direct",
      content: "Agent run resumed after waited results completed.",
    });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs?.[0]).toMatchObject({
      job_type: "agent_run",
      agent_id: "agent-manager",
      payload_json: expect.objectContaining({
        run_id: "run-manager",
        run_group_id: "group-1",
        root_run_id: "run-root",
        parent_run_id: "run-root",
        resumed_waiting_for_results: true,
      }),
    });

    const resumedRun = state.runs.get("run-manager")!;
    expect(resumedRun.status).toBe("queued");
    expect(resumedRun.prompt).toContain("Continue the paused room agent run");
    expect(resumedRun.prompt).toContain("Reviewer test result.");
    expect(resumedRun.prompt).toContain("1 + 1 = 2.");

    const completedManagerRun = {
      ...resumedRun,
      status: "succeeded",
      output_json: canonicalOutput("Both reviewers completed. The second result is 2."),
      ended_at: "2026-07-05T00:03:00.000Z",
    };
    state.runs.set("run-manager", completedManagerRun);
    await projectorFor(state).markDelegatedRunTerminal(completedManagerRun);

    const managerReply = state.messages.find(
      (message) => message.message_type === "agent_message" && message.run_id === "run-manager",
    );
    expect(managerReply).toMatchObject({
      parent_message_id: "message-direct",
      sender_agent_id: "agent-manager",
      content: "Both reviewers completed. The second result is 2.",
    });
  });

  it("marks delegated child runs running and writes started trace events once", async () => {
    const state: FakeState = {
      runs: new Map([["run-child", childRun()]]),
      delegations: new Map([["delegation-1", delegation()]]),
      messages: [],
      events: [],
    };
    const projector = projectorFor(state);

    await projector.markDelegatedRunRunning(childRun());
    await projector.markDelegatedRunRunning(childRun());

    expect(state.delegations.get("delegation-1")).toMatchObject({ status: "running" });
    expect(state.messages).toEqual([]);
    expect(state.events).toEqual([
      expect.objectContaining({
        run_id: "run-child",
        event_type: "delegation_started",
        status: "running",
      }),
      expect.objectContaining({
        run_id: "run-root",
        event_type: "delegation_started",
        status: "running",
      }),
    ]);
  });

  it("marks delegated child runs terminal, writes result message, and writes completed trace events once", async () => {
    const terminalRun = childRun({
      status: "succeeded",
      output_json: canonicalOutput("Evidence summary is ready."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const state: FakeState = {
      runs: new Map([["run-child", terminalRun]]),
      delegations: new Map([["delegation-1", delegation({ status: "running" })]]),
      messages: [],
      events: [],
    };
    const projector = projectorFor(state);

    await projector.markDelegatedRunTerminal(terminalRun);
    await projector.markDelegatedRunTerminal(terminalRun);

    expect(state.delegations.get("delegation-1")).toMatchObject({
      status: "succeeded",
      result_summary: "Evidence summary is ready.",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      run_id: "run-child",
      sender_agent_id: "agent-worker",
      message_type: "delegation_result",
      content: "Evidence summary is ready.",
      metadata_json: {
        delegation_id: "delegation-1",
        child_run_id: "run-child",
        status: "succeeded",
      },
    });
    expect(state.events).toEqual([
      expect.objectContaining({
        run_id: "run-child",
        event_type: "delegation_completed",
        status: "succeeded",
      }),
      expect.objectContaining({
        run_id: "run-root",
        event_type: "delegation_completed",
        status: "succeeded",
      }),
    ]);
  });

  it("maps degraded delegated child runs to failed delegation status", async () => {
    const terminalRun = childRun({
      status: "degraded",
      error_json: { error_text: "Finalization failed." },
    });
    const state: FakeState = {
      runs: new Map([["run-child", terminalRun]]),
      delegations: new Map([["delegation-1", delegation({ status: "running" })]]),
      messages: [],
      events: [],
    };

    await projectorFor(state).markDelegatedRunTerminal(terminalRun);

    expect(state.delegations.get("delegation-1")).toMatchObject({
      status: "failed",
      result_summary: "Finalization failed.",
    });
    expect(state.events.map((event) => event.status)).toEqual(["failed", "failed"]);
  });

  it("requeues a waiting parent run after its delegated child completes", async () => {
    const parentRun = childRun({
      id: "run-parent",
      agent_id: "agent-manager",
      agent_version_id: "agent-version-manager",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "Ask two reviewers to answer 1+1.",
      project_folder_id: null,
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          status: "waiting",
          scope: "own_delegations",
          reason: "Need delegated reviewer result before replying.",
          resume_instruction: "Summarize the delegated result.",
          depends_on_run_ids: ["run-child"],
          pending_run_ids: ["run-child"],
        },
      },
    });
    const terminalRun = childRun({
      status: "succeeded",
      output_json: canonicalOutput("Reviewer A says 2."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const state: FakeState = {
      group: group(),
      runs: new Map([
        ["run-parent", parentRun],
        ["run-child", terminalRun],
      ]),
      delegations: new Map([["delegation-1", delegation({ status: "running" })]]),
      messages: [userMessage()],
      events: [],
      jobs: [],
    };

    await projectorFor(state).markDelegatedRunTerminal(terminalRun);
    await projectorFor(state).markDelegatedRunTerminal(terminalRun);

    const delegationResult = state.messages.find(
      (message) => message.message_type === "delegation_result" && message.run_id === "run-child",
    );
    expect(delegationResult).toMatchObject({
      content: "Reviewer A says 2.",
    });

    const resumeMessage = state.messages.find(
      (message) => message.metadata_json?.wait_for_results_run_id === "run-parent",
    );
    expect(resumeMessage).toMatchObject({
      message_type: "system_event",
      parent_message_id: "message-user",
      content: "Agent run resumed after waited results completed.",
    });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs?.[0]).toMatchObject({
      job_type: "agent_run",
      agent_id: "agent-manager",
      payload_json: expect.objectContaining({
        run_id: "run-parent",
        run_group_id: "group-1",
        root_run_id: "run-root",
        parent_run_id: "run-root",
        resumed_waiting_for_results: true,
      }),
    });

    const resumedParent = state.runs.get("run-parent")!;
    expect(resumedParent.status).toBe("queued");
    expect(resumedParent.prompt).toContain("Need delegated reviewer result");
    expect(resumedParent.prompt).toContain("Reviewer A says 2.");
  });
});
function canonicalOutput(summary: string): Record<string, unknown> {
  return {
    schema_version: "run_output.v1",
    status: "succeeded",
    summary,
    result: {},
    output_manifest: [],
  };
}
