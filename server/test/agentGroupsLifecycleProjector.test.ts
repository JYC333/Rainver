import { describe, expect, it } from "vitest";
import { AgentGroupRunLifecycleProjector } from "../src/modules/agentGroups/lifecycleProjector.js";
import type { ServerConfig } from "../src/config.js";
import type { Pool, PoolClient } from "../src/db/pool.js";
import type { AgentRunRecord, RunRecord } from "../src/modules/runs/repository.js";
import type {
  AgentRunGroupRecord,
  AgentRunMessageRecord,
  RunDelegationRecord,
} from "../src/modules/agentGroups/repository.js";
import type { JobRecord } from "../src/modules/jobs/repository.js";
import type { QuotaSource } from "../src/modules/rooms/subscriptionLogins.js";

function childRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-child",
    space_id: "space-1",
    agent_id: "agent-worker",
    agent_version_id: "agent-version-worker",
    execution_kind: "agent",
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
    runtime_key: "opencode",
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
  /** Stored `remote_diff` Artifacts, newest last. */
  artifacts?: Array<{ id: string; run_id: string; content: string; truncated?: boolean }>;
  /** Tool-surface columns of a Run, for the change-link grant. */
  runTools?: Map<string, { capabilities_json: unknown; permission_snapshot_json: unknown; trigger_origin: string }>;
  /** The CLI login every Run here spends, when the quota gate should see one. */
  login?: { host_id: string; host_name: string; runtime_key: string; installation: string };
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
    // The subscription quota gate (`rooms/quotaGate.ts`).
    if (sql.includes("SELECT 1 FROM jobs")) {
      const rows = (this.state.jobs ?? []).filter((job) => job.payload_json.run_id === params[1]);
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("JOIN host_threads thread ON thread.id = run.host_task_thread_id") && sql.includes("provider_bound")) {
      const rows = this.state.login ? [{ ...this.state.login, provider_bound: false }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("AS override") || sql.includes("FROM settings")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("jsonb_build_object('waiting_for_quota'")) {
      const row = this.state.runs.get(String(params[1]));
      if (row?.status === "queued") {
        this.state.runs.set(row.id, {
          ...row,
          output_json: { ...(row.output_json as Record<string, unknown> ?? {}), waiting_for_quota: JSON.parse(String(params[2])) },
        });
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SELECT 1 FROM runs") && sql.includes("output_json ? 'waiting_for_quota'")) {
      const row = this.state.runs.get(String(params[1]));
      const held = Boolean(row && (row.output_json as Record<string, unknown> | null)?.waiting_for_quota);
      return { rows: held ? [{} as Row] : [], rowCount: held ? 1 : 0 };
    }
    // A held Run lets go of its host thread; here Runs have none.
    if (sql.includes("UPDATE host_threads thread") && sql.includes("SET dispatch_lock_id = NULL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT run.host_task_thread_id")) {
      return { rows: [{ host_task_thread_id: null, owner_id: null } as Row], rowCount: 1 };
    }
    // One Run of a group at a time (`groupHasRunnableRun`).
    if (sql.includes("AND run_group_id = $2 AND id <> $3")) {
      const busy = [...this.state.runs.values()].some((row) => row.run_group_id === params[1] && row.id !== params[2]
        && ["queued", "running", "cancelling", "waiting_for_review"].includes(row.status));
      return { rows: busy ? [{} as Row] : [], rowCount: busy ? 1 : 0 };
    }
    // Recipients parked for serialization (`queueSerializedRecipientsIfReady`).
    if (sql.includes("output_json->'waiting_for_results'->>'scope' = $3")) {
      const rows = [...this.state.runs.values()]
        .filter((row) => row.run_group_id === params[1] && row.status === "waiting_for_dependency"
          && (row.output_json as { waiting_for_results?: { scope?: string } } | null)?.waiting_for_results?.scope === params[2])
        .map((row) => ({ id: row.id }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    // No conversation here: the turn check (`enqueueWhenTurnFree`) has nothing to wait for.
    if (sql.includes("SELECT session_id, run_group_id FROM runs")) {
      const row = this.state.runs.get(String(params[1]));
      return { rows: row ? [{ session_id: null, run_group_id: row.run_group_id } as Row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SELECT session_id FROM runs")) {
      const row = this.state.runs.get(String(params[1]));
      return { rows: row ? [{ session_id: null } as Row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("output_json->'waiting_for_quota' AS marker, run_group_id")) {
      const row = this.state.runs.get(String(params[1]));
      const marker = (row?.output_json as Record<string, unknown> | null)?.waiting_for_quota;
      return row?.status === "queued" && marker
        ? { rows: [{ marker, run_group_id: row.run_group_id } as Row], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET output_json = output_json - 'waiting_for_quota'")) {
      const row = this.state.runs.get(String(params[1]));
      if (row) {
        const { waiting_for_quota: _marker, waiting_for_turn: _parked, ...rest } = (row.output_json as Record<string, unknown> | null) ?? {};
        this.state.runs.set(row.id, { ...row, output_json: rest });
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE room_discussions SET updated_at = now()")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM artifacts artifact") && sql.includes("'remote_diff'")) {
      const runIds = params[1] as string[];
      const latest = new Map<string, NonNullable<FakeState["artifacts"]>[number]>();
      for (const artifact of this.state.artifacts ?? []) {
        if (runIds.includes(artifact.run_id)) latest.set(artifact.run_id, artifact);
      }
      const rows = [...latest.values()].map((artifact) => ({
        id: artifact.id,
        run_id: artifact.run_id,
        content: artifact.content,
        truncated: artifact.truncated ?? false,
      }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes("SELECT capabilities_json, permission_snapshot_json, trigger_origin")) {
      const row = this.state.runTools?.get(String(params[1]));
      const run = this.state.runs.get(String(params[1]));
      return row && run?.status === "queued" ? { rows: [row as Row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE runs") && sql.includes("SET capabilities_json = $3::jsonb")) {
      const row = this.state.runTools?.get(String(params[1]));
      if (row) {
        const snapshot = (row.permission_snapshot_json ?? {}) as Record<string, unknown>;
        this.state.runTools!.set(String(params[1]), {
          ...row,
          capabilities_json: JSON.parse(String(params[2])),
          permission_snapshot_json: {
            ...snapshot,
            tool_grants: JSON.parse(String(params[3])),
            scenario_tool_allowance: JSON.parse(String(params[4])),
          },
        });
      }
      return { rows: [], rowCount: row ? 1 : 0 };
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
          runtime_key: "opencode",
          model_provider_id: "provider-1",
          model_name: "gpt-test",
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
      const ensuredAgentRun = sql.includes("WITH existing AS");
      const row: JobRecord = {
        id: String(params[ensuredAgentRun ? 2 : 0]),
        space_id: String(params[ensuredAgentRun ? 0 : 1]),
        user_id: params[ensuredAgentRun ? 3 : 2] ? String(params[ensuredAgentRun ? 3 : 2]) : null,
        project_folder_id: params[ensuredAgentRun ? 4 : 3] ? String(params[ensuredAgentRun ? 4 : 3]) : null,
        agent_id: params[ensuredAgentRun ? 5 : 4] ? String(params[ensuredAgentRun ? 5 : 4]) : null,
        job_type: ensuredAgentRun ? "agent_run" : String(params[5]),
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

function projectorFor(state: FakeState, quotaSource?: QuotaSource): AgentGroupRunLifecycleProjector {
  // Every fixture group in this file has room_id: null, so the Phase 3
  // Room-notification path (which needs a real ServerConfig only to
  // construct RoomService) always short-circuits before touching config.
  return new AgentGroupRunLifecycleProjector(new FakePool(state) as unknown as Pool, {} as ServerConfig, quotaSource);
}

function fixedQuota(utilization: number): QuotaSource {
  return {
    read: async () => ({
      window: { kind: "session", utilization, resets_at: "2099-01-01T00:00:00.000Z" },
      checked_at: new Date().toISOString(),
    }),
  };
}

describe("AgentGroupRunLifecycleProjector", () => {
  it("enqueues the first queued delegated child after its parent yields", async () => {
    const parent = childRun({
      id: "run-parent",
      agent_id: "agent-manager",
      parent_run_id: null,
      root_run_id: "run-parent",
      delegation_id: null,
      status: "waiting_for_dependency",
    });
    const queuedChild = childRun({ status: "queued" });
    const state: FakeState = {
      group: group(),
      runs: new Map([[parent.id, parent], [queuedChild.id, queuedChild]]),
      delegations: new Map([["delegation-1", delegation()]]),
      messages: [],
      events: [],
      jobs: [],
    };

    await projectorFor(state).queueDelegatedChildren(parent);

    expect(state.jobs).toHaveLength(1);
    expect(state.jobs?.[0]).toMatchObject({
      job_type: "agent_run",
      agent_id: "agent-worker",
      payload_json: expect.objectContaining({
        run_id: "run-child",
        parent_run_id: "run-parent",
        delegation_id: "delegation-1",
      }),
    });
  });

  it("holds a delegated child at the subscription reserve line, and admits it below", async () => {
    const parent = childRun({
      id: "run-parent",
      agent_id: "agent-manager",
      parent_run_id: null,
      root_run_id: "run-parent",
      delegation_id: null,
      status: "waiting_for_dependency",
    });
    const queuedChild = childRun({ status: "queued" });
    const state: FakeState = {
      group: group(),
      runs: new Map([[parent.id, parent], [queuedChild.id, queuedChild]]),
      delegations: new Map([["delegation-1", delegation()]]),
      messages: [],
      events: [],
      jobs: [],
      login: { host_id: "host-1", host_name: "Server", runtime_key: "claude_code", installation: "own" },
    };

    // A delegation is Agent-triggered: at 90 % of the window (reserve 85 %) it waits, with no job.
    await projectorFor(state, fixedQuota(90)).queueDelegatedChildren(parent);
    expect(state.jobs).toHaveLength(0);
    expect(state.runs.get("run-child")).toMatchObject({
      status: "queued",
      output_json: { waiting_for_quota: expect.objectContaining({ window: "session", utilization: 90, account_label: "Claude Code · Server" }) },
    });

    // The FIFO re-evaluates its head on the next terminal event; below the line it runs.
    await projectorFor(state, fixedQuota(40)).queueDelegatedChildren(parent);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs?.[0]?.payload_json).toMatchObject({ run_id: "run-child", trigger_origin: "delegation" });
    // Admitted, it no longer reads as waiting.
    expect((state.runs.get("run-child")?.output_json as Record<string, unknown> | null)?.waiting_for_quota).toBeUndefined();
  });

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

  it("admits a serialized recipient with the prompt it was dispatched with and the earlier replies appended", async () => {
    const originalPrompt = [
      "[Agent identity]\nYou are the Reviewer.",
      "[Conversation]\n[user:user-1] compare notes",
      "[Assigned task for this Room turn]\ncompare notes",
    ].join("\n\n");
    const firstRun = childRun({
      id: "run-first",
      agent_id: "agent-manager",
      agent_name: "Manager",
      parent_run_id: null,
      root_run_id: "run-first",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "manager prompt",
      project_folder_id: null,
      status: "succeeded",
      output_json: canonicalOutput("Manager says the plan is fine."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const parkedRun = childRun({
      id: "run-second",
      agent_id: "agent-reviewer",
      agent_name: "Reviewer",
      parent_run_id: "run-first",
      root_run_id: "run-first",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: originalPrompt,
      project_folder_id: null,
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          status: "waiting",
          scope: "conversation_serialization",
          reason: "Conversation Runs share one execution directory and run serially.",
          depends_on_run_ids: ["run-first"],
        },
      },
    });
    const state: FakeState = {
      group: group({ root_run_id: "run-first", session_id: "session-1" }),
      runs: new Map([[firstRun.id, firstRun], [parkedRun.id, parkedRun]]),
      delegations: new Map(),
      messages: [
        userMessage({
          id: "message-fanout",
          run_id: "run-first",
          content: "@Manager @Reviewer compare notes",
          mentions_json: [{ agent_id: "agent-manager" }, { agent_id: "agent-reviewer" }],
          metadata_json: { root_run_id: "run-first", recipient_run_ids: ["run-first", "run-second"] },
        }),
      ],
      events: [],
      jobs: [],
    };

    await projectorFor(state).markDelegatedRunTerminal(firstRun);

    const admitted = state.runs.get("run-second")!;
    expect(admitted.status).toBe("queued");
    // The Run never ran: its identity block, conversation window and task are
    // still what it needs, and the reply produced meanwhile is added to them.
    expect(admitted.prompt?.startsWith(originalPrompt)).toBe(true);
    expect(admitted.prompt).toContain("[Replies already given to this same message]");
    expect(admitted.prompt).toContain("Manager says the plan is fine.");
    expect(admitted.prompt).not.toContain("Continue the paused room agent run");
    expect(state.messages.find((message) => message.metadata_json?.wait_for_results_run_id === "run-second")).toMatchObject({
      message_type: "system_event",
      content: "Recipient run admitted after the preceding recipients of this turn completed.",
    });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs?.[0]).toMatchObject({
      job_type: "agent_run",
      agent_id: "agent-reviewer",
      payload_json: expect.objectContaining({ run_id: "run-second" }),
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

  it("hands a delegated child's change on as a [Changes] list and a link, never the patch", async () => {
    const parentRun = childRun({
      id: "run-parent",
      agent_id: "agent-manager",
      parent_run_id: "run-root",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "Fix the parser.",
      project_folder_id: null,
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          status: "waiting",
          scope: "own_delegations",
          reason: "Need the coder's change before replying.",
          depends_on_run_ids: ["run-child"],
        },
      },
    });
    const terminalRun = childRun({
      status: "succeeded",
      output_json: canonicalOutput("Parser fixed."),
      ended_at: "2026-07-05T00:01:00.000Z",
    });
    const patch = [
      "diff --git a/src/parser.ts b/src/parser.ts",
      "index 1111111..2222222 100644",
      "--- a/src/parser.ts",
      "+++ b/src/parser.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const secretPatchLine = 2;",
      "+const b = 2;",
      "+const c = 3;",
      " export { a };",
    ].join("\n");
    const state: FakeState = {
      // A Room turn: only a Room turn can follow a change link.
      group: group({ room_id: "room-1", session_id: "session-1" }),
      runs: new Map([["run-parent", parentRun], ["run-child", terminalRun]]),
      delegations: new Map([["delegation-1", delegation({ status: "running" })]]),
      messages: [userMessage()],
      events: [],
      jobs: [],
      artifacts: [{ id: "artifact-diff-1", run_id: "run-child", content: patch }],
      runTools: new Map([["run-parent", {
        capabilities_json: ["agent.delegate", "agent.wait_for_results"],
        permission_snapshot_json: {
          tool_grants: [],
          scenario_tool_allowance: ["agent.delegate", "agent.wait_for_results"],
        },
        trigger_origin: "manual",
      }]]),
    };

    await projectorFor(state).markDelegatedRunTerminal(terminalRun);

    const expectedBlock = [
      "[Changes] 1 file changed, +2 -1",
      "  src/parser.ts | +2 -1",
      "Full patch (not included): rainver://artifacts/artifact-diff-1 — read it only if you need the lines, with input_resource.read or input_resource.search (resource_id: artifact-diff-1).",
    ].join("\n");
    expect(state.delegations.get("delegation-1")?.result_summary).toBe(`Parser fixed.\n\n${expectedBlock}`);
    const resumed = state.runs.get("run-parent")!;
    expect(resumed.status).toBe("queued");
    expect(resumed.prompt).toContain(expectedBlock.split("\n").map((line) => `   ${line}`).join("\n"));
    expect(resumed.prompt).not.toContain("secretPatchLine");
    // The resumed Run can follow the link it was handed.
    const tools = state.runTools?.get("run-parent");
    expect(tools?.capabilities_json).toEqual(expect.arrayContaining(["input_resource.read", "input_resource.search"]));
    expect((tools?.permission_snapshot_json as { tool_grants: Array<{ action_id: string }> }).tool_grants
      .map((grant) => grant.action_id)).toEqual(expect.arrayContaining(["input_resource.read", "input_resource.search"]));
  });

  it("appends an earlier recipient's [Changes] block to the replies a serialized recipient is given", async () => {
    const firstRun = childRun({
      id: "run-first",
      agent_id: "agent-manager",
      agent_name: "Manager",
      parent_run_id: null,
      root_run_id: "run-first",
      delegation_id: null,
      trigger_origin: "manual",
      project_folder_id: null,
      status: "succeeded",
      output_json: canonicalOutput("Renamed the helper."),
    });
    const parkedRun = childRun({
      id: "run-second",
      agent_id: "agent-reviewer",
      parent_run_id: "run-first",
      root_run_id: "run-first",
      delegation_id: null,
      trigger_origin: "manual",
      prompt: "reviewer prompt",
      project_folder_id: null,
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          status: "waiting",
          scope: "conversation_serialization",
          depends_on_run_ids: ["run-first"],
        },
      },
    });
    const state: FakeState = {
      group: group({ root_run_id: "run-first", room_id: "room-1", session_id: "session-1" }),
      runs: new Map([[firstRun.id, firstRun], [parkedRun.id, parkedRun]]),
      delegations: new Map(),
      messages: [userMessage({ id: "message-fanout", run_id: "run-first", metadata_json: { recipient_run_ids: ["run-first", "run-second"] } })],
      events: [],
      jobs: [],
      artifacts: [
        { id: "artifact-old", run_id: "run-first", content: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" },
        {
          id: "artifact-latest",
          run_id: "run-first",
          content: "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-x\n+y",
          truncated: true,
        },
      ],
    };

    await projectorFor(state).markDelegatedRunTerminal(firstRun);

    const admitted = state.runs.get("run-second")!;
    expect(admitted.prompt).toContain("[Replies already given to this same message]");
    expect(admitted.prompt).toContain([
      "   result: Renamed the helper.",
      "   [Changes] at least 1 file changed, +1 -1 (the stored diff was truncated: counts cover only the stored part, and files after the cut are not listed)",
      "     old.ts => new.ts | +1 -1",
      "   Full patch (not included): rainver://artifacts/artifact-latest",
    ].join("\n"));
    expect(admitted.prompt).not.toContain("artifact-old");
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
