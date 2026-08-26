import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentGroupRunService } from "../src/modules/agentGroups/service.js";
import type { QueryResult } from "../src/modules/routeUtils/common.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

class AgentGroupServiceDb {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  private readonly members = new Set<string>(["agent-manager", "agent-reviewer"]);
  private readonly insertedRuns = new Map<string, RunRecord>();

  constructor(
    private rootRunId: string | null = "run-root",
    private readonly groupGoal = "Coordinate the work",
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("INSERT INTO agent_run_groups")) {
      return {
        rows: [{
          id: params[0],
          space_id: params[1],
          root_run_id: null,
          manager_user_id: params[2],
          manager_agent_id: params[3],
          room_id: params[4],
          session_id: params[5],
          trigger_message_id: params[6],
          project_id: params[7],
          project_folder_id: params[8],
          title: params[9],
          goal: params[10],
          status: "active",
          budget_json: JSON.parse(String(params[11])),
          policy_snapshot_json: JSON.parse(String(params[12])),
          created_at: params[13],
          updated_at: params[13],
          ended_at: null,
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("SET title =")) {
      return {
        rows: [groupRecord({
          title: params[2] ?? "Room",
          goal: params[3] ?? "Coordinate the work",
          updated_at: String(params[4]),
          root_run_id: this.rootRunId,
        }) as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE agent_run_groups")) {
      this.rootRunId = String(params[2]);
      return {
        rows: [groupRecord({ root_run_id: this.rootRunId, updated_at: String(params[3]) }) as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_run_groups")) {
      return {
        rows: [groupRecord({ root_run_id: this.rootRunId, goal: this.groupGoal }) as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT id") && sql.includes("r.run_group_id = $2")) {
      return {
        rows: this.rootRunId ? [{ id: this.rootRunId } as Row] : [],
        rowCount: this.rootRunId ? 1 : 0,
      };
    }
    if (sql.includes("FROM runs r")) {
      const runId = String(params[1] ?? this.rootRunId ?? "run-root");
      const run = this.insertedRuns.get(runId) ?? runRecord(runId);
      return { rows: [run as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO agent_run_group_members")) {
      this.members.add(String(params[3]));
      return {
        rows: [memberRecord(String(params[3]), {
          id: String(params[0]),
          role: String(params[4]),
          capabilities_json: JSON.parse(String(params[5])),
          context_policy_json: JSON.parse(String(params[6])),
          created_at: String(params[7]),
          updated_at: String(params[7]),
        }) as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_run_group_members m")) {
      const agentId = String(params[2]);
      if (!this.members.has(agentId)) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [memberRecord(agentId, { agent_status: "active" }) as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_run_group_members")) {
      return {
        rows: [...this.members].map(agentId => memberRecord(agentId)) as Row[],
        rowCount: this.members.size,
      };
    }
    if (sql.includes("FROM agent_run_messages")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM run_delegations")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("AS effective_access_level")) {
      return {
        rows: [{ effective_access_level: "full" } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM runs")) {
      return {
        rows: this.rootRunId ? [{ id: this.rootRunId } as Row] : [],
        rowCount: this.rootRunId ? 1 : 0,
      };
    }
    if (sql.includes("COALESCE(av.capabilities_json")) {
      const ids = Array.isArray(params[2]) ? params[2] : [];
      return {
        rows: ids.map(agentId => ({
          id: String(agentId),
          name: String(agentId).replace("agent-", ""),
          description: `${String(agentId)} description`,
          role_instruction: `${String(agentId)} role`,
          capabilities_json: [`${String(agentId)}.capability`],
        })) as Row[],
        rowCount: ids.length,
      };
    }
    if (sql.includes("FROM agents")) {
      if (sql.includes("id = ANY")) {
        const ids = Array.isArray(params[2]) ? params[2] : [];
        return {
          rows: ids.map(agentId => ({ id: String(agentId), status: "active" })) as Row[],
          rowCount: ids.length,
        };
      }
      if (sql.includes(" id IN ")) {
        return {
          rows: params.slice(1).map(agentId => ({ id: String(agentId), status: "active" })) as Row[],
          rowCount: params.length - 1,
        };
      }
      const agentId = String(params[1] ?? "agent-manager");
      return {
        rows: [{
          id: agentId,
          status: "active",
          current_version_id: `version-${agentId}`,
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_versions")) {
      return { rows: [{ id: "version-manager" }] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM agent_runtime_profiles")) {
      const agentId = String(params[1] ?? "agent-manager");
      return {
        rows: [{
          id: `profile-${agentId}`,
          space_id: "space-1",
          agent_id: agentId,
          name: "Model API",
          adapter_type: "model_api",
          model_provider_id: "provider-1",
          model_name: "gpt-4o-mini",
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
    if (sql.includes("JOIN model_providers") || sql.includes("FROM model_providers")) {
      return {
        rows: [{
          id: "provider-1",
          name: "Provider",
          provider_type: "openai",
          default_model: "gpt-4o-mini",
          enabled: true,
          credential_id: "credential-1",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO runs")) {
      const row = runRecord(String(params[0]), {
        agent_id: String(params[2]),
        agent_version_id: String(params[3]),
        runtime_profile_id: params[6] === null ? null : String(params[6]),
        parent_run_id: params[9] === null ? null : String(params[9]),
        root_run_id: params[10] === null ? null : String(params[10]),
        run_group_id: params[11] === null ? null : String(params[11]),
        prompt: params[18] === null ? null : String(params[18]),
        instruction: params[19] === null ? null : String(params[19]),
      });
      this.insertedRuns.set(row.id, row);
      return {
        rows: [row as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE runs")) {
      const runId = String(params[1]);
      const existing = this.insertedRuns.get(runId) ?? runRecord(runId);
      const row = {
        ...existing,
        root_run_id: runId,
        run_group_id: String(params[2]),
        updated_at: String(params[3]),
      };
      this.insertedRuns.set(runId, row);
      return { rows: [row as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO agent_run_messages")) {
      return {
        rows: [{
          id: "message-1",
          space_id: "space-1",
          group_id: "group-1",
          run_id: params[3],
          parent_message_id: null,
          sender_actor_ref_json: JSON.parse(String(params[5])),
          sender_user_id: params[6],
          sender_agent_id: params[7],
          message_type: params[8],
          content: params[9],
          mentions_json: JSON.parse(String(params[10])),
          metadata_json: JSON.parse(String(params[11])),
          created_at: "2026-07-05T00:00:00.000Z",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO jobs")) {
      return {
        rows: [{
          id: "job-1",
          space_id: params[1],
          user_id: params[2],
          project_folder_id: params[3],
          agent_id: params[4],
          job_type: params[5],
          status: "pending",
          priority: params[6],
          payload_json: JSON.parse(String(params[7])),
          result_json: null,
          error: null,
          attempts: 0,
          max_attempts: params[8],
          scheduled_at: params[9],
          claimed_by: null,
          claimed_at: null,
          started_at: null,
          completed_at: null,
          heartbeat_at: null,
          created_at: params[10],
          updated_at: params[10],
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO run_attempts")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM artifacts a") || sql.includes("FROM proposals p")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class FakePool {
  constructor(readonly db: AgentGroupServiceDb) {}
  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.db.query<Row>(sql, params);
  }
  async connect() {
    return {
      query: this.db.query.bind(this.db),
      release() {},
    };
  }
}

function runRecord(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    space_id: "space-1",
    agent_id: "agent-manager",
    agent_version_id: "version-manager",
    runtime_profile_id: "profile-manager",
    run_type: "agent",
    status: "queued",
    mode: "live",
    prompt: "Root prompt",
    instruction: "Coordinate the work",
    project_folder_id: null,
    session_id: null,
    parent_run_id: null,
    root_run_id: "run-root",
    run_group_id: "group-1",
    delegation_id: null,
    project_id: null,
    scheduled_at: null,
    adapter_type: "model_api",
    capability_id: null,
    capabilities_json: [],
    model_provider_id: "provider-1",
    model_override_json: null,
    runtime_profile_snapshot_json: {},
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    instructed_by_agent_id: null,
    error_message: null,
    error_json: null,
    output_json: null,
    started_at: null,
    ended_at: null,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    visibility: "space_shared",
    ...overrides,
  };
}

function groupRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "group-1",
    space_id: "space-1",
    root_run_id: "run-root",
    manager_user_id: "user-1",
    manager_agent_id: "agent-manager",
    title: "Room",
    goal: "Coordinate the work",
    status: "active",
    budget_json: {},
    policy_snapshot_json: { context_policy_json: {} },
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

function memberRecord(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `member-${agentId}`,
    space_id: "space-1",
    group_id: "group-1",
    agent_id: agentId,
    role: agentId === "agent-manager" ? "manager" : "worker",
    status: "active",
    capabilities_json: {},
    context_policy_json: {},
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("AgentGroupRunService", () => {
  it("creates rooms without creating an initial run, job, or message", async () => {
    const db = new AgentGroupServiceDb(null);
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.createGroup(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        title: "Room",
        manager_agent_id: "agent-manager",
        member_agent_ids: ["agent-manager"],
      },
    );

    expect(result.group.root_run_id).toBeNull();
    expect(result.group.goal).toBe("");
    expect(result.members.length).toBeGreaterThan(0);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO runs"))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO jobs"))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO agent_run_messages"))).toBe(false);
  });

  it("snapshots member capabilities when creating a room", async () => {
    const db = new AgentGroupServiceDb(null);
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    await service.createGroup(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        title: "Room",
        manager_agent_id: "agent-manager",
        member_agent_ids: ["agent-manager", "agent-reviewer"],
      },
    );

    const memberInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO agent_run_group_members"));
    expect(memberInserts).toHaveLength(2);
    expect(JSON.parse(String(memberInserts[1]?.params[5]))).toMatchObject({
      agent_id: "agent-reviewer",
      name: "reviewer",
      description: "agent-reviewer description",
      role_instruction: "agent-reviewer role",
      capabilities: ["agent-reviewer.capability"],
    });
  });

  it("returns an empty trace for rooms before the first message", async () => {
    const db = new AgentGroupServiceDb(null);
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.getTrace(
      { spaceId: "space-1", userId: "user-1" },
      "group-1",
    );

    expect(result.root_run_id).toBeNull();
    expect(result.child_run_ids).toEqual([]);
    expect(result.artifact_ids).toEqual([]);
    expect(result.proposal_ids).toEqual([]);
    expect(result.policy_decision_record_ids).toEqual([]);
    expect(result.timeline.messages).toEqual([]);
    expect(result.timeline.delegations).toEqual([]);
  });

  it("updates room title and goal after creation", async () => {
    const db = new AgentGroupServiceDb(null);
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.updateGroup(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        title: "Updated room",
        goal: "",
      },
    );

    expect(result.group.title).toBe("Updated room");
    expect(result.group.goal).toBe("");
    const update = db.calls.find((call) => call.sql.includes("SET title ="));
    expect(update?.params.slice(2, 4)).toEqual(["Updated room", ""]);
  });

  it("creates the root run from the first user room message", async () => {
    const db = new AgentGroupServiceDb(null);
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "Start the room",
      },
    );

    expect(result.message.run_id).toBeTruthy();
    expect(result.message.metadata_json).toMatchObject({
      root_run_id: result.message.run_id,
      recipient_agent_id: "agent-manager",
      recipient_run_id: result.message.run_id,
    });
    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert?.params[2]).toBe("agent-manager");
    expect(runInsert?.params.slice(8, 11)).toEqual([null, null, null]);
    // prompt (params[18]) carries the raw task wrapped in standing Room
    // execution-rules guidance, applied to every group-dispatched run
    // regardless of Room scoping; instruction (params[19]) stays raw.
    expect(String(runInsert?.params[18])).toContain("Start the room");
    expect(runInsert?.params[19]).toBe("Coordinate the work");

    expect(db.calls.some((call) => call.sql.includes("UPDATE runs"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("UPDATE agent_run_groups"))).toBe(true);

    const jobInsert = db.calls.find((call) => call.sql.includes("INSERT INTO jobs"));
    expect(jobInsert?.params[4]).toBe("agent-manager");
    expect(JSON.parse(String(jobInsert?.params[7]))).toMatchObject({
      run_id: result.message.run_id,
      run_group_id: "group-1",
      root_run_id: result.message.run_id,
      trigger_origin: "manual",
    });
    expect(JSON.parse(String(jobInsert?.params[7]))).not.toHaveProperty("parent_run_id");
  });

  it("does not set a run instruction when the room has no goal", async () => {
    const db = new AgentGroupServiceDb(null, "");
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "Start without goal",
      },
    );

    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(String(runInsert?.params[18])).toContain("Start without goal");
    expect(runInsert?.params[19]).toBeNull();
  });

  it("creates and enqueues a default manager run for user room messages", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "Continue the room",
      },
    );

    expect(result.message.run_id).toBeTruthy();
    expect(result.message.run_id).not.toBe("run-root");
    expect(result.message.metadata_json).toMatchObject({
      root_run_id: "run-root",
      recipient_agent_id: "agent-manager",
      recipient_run_id: result.message.run_id,
    });
    expect(result.message.mentions_json).toEqual([{ agent_id: "agent-manager" }]);
    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert?.params[2]).toBe("agent-manager");
    expect(runInsert?.params.slice(9, 12)).toEqual(["run-root", "run-root", "group-1"]);
    expect(String(runInsert?.params[18])).toContain("Continue the room");
    expect(runInsert?.params[19]).toBe("Coordinate the work");

    const jobInsert = db.calls.find((call) => call.sql.includes("INSERT INTO jobs"));
    expect(jobInsert?.params[4]).toBe("agent-manager");
    expect(JSON.parse(String(jobInsert?.params[7]))).toMatchObject({
      run_id: result.message.run_id,
      run_group_id: "group-1",
      root_run_id: "run-root",
      parent_run_id: "run-root",
      trigger_origin: "manual",
    });
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO run_delegations"))).toBe(false);
  });

  it("routes a user room message to an explicit recipient agent", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "@Reviewer inspect this draft",
        routing_mode: "direct",
        recipient_segments: [{
          recipient_agent_ids: ["agent-reviewer"],
          content: "inspect this draft",
        }],
      },
    );

    expect(result.message.metadata_json).toMatchObject({
      routing_mode: "direct",
      root_run_id: "run-root",
      recipient_agent_id: "agent-reviewer",
      recipient_run_id: result.message.run_id,
    });
    expect(result.message.mentions_json).toEqual([{ agent_id: "agent-reviewer" }]);

    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert?.params[2]).toBe("agent-reviewer");
    expect(String(runInsert?.params[18])).toContain("inspect this draft");

    const jobInsert = db.calls.find((call) => call.sql.includes("INSERT INTO jobs"));
    expect(jobInsert?.params[4]).toBe("agent-reviewer");
    expect(JSON.parse(String(jobInsert?.params[7]))).toMatchObject({
      run_id: result.message.run_id,
      run_group_id: "group-1",
      root_run_id: "run-root",
      parent_run_id: "run-root",
      trigger_origin: "manual",
    });
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO run_delegations"))).toBe(false);
  });

  it("routes one user room message to multiple explicit recipient agents", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "@Manager @Reviewer compare notes",
        routing_mode: "direct",
        recipient_segments: [{
          recipient_agent_ids: ["agent-manager", "agent-reviewer"],
          content: "compare notes",
        }],
      },
    );

    const runInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO runs"));
    const jobInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO jobs"));
    expect(runInserts).toHaveLength(2);
    expect(jobInserts).toHaveLength(2);
    expect(runInserts.map((call) => call.params[2])).toEqual(["agent-manager", "agent-reviewer"]);
    expect(jobInserts.map((call) => call.params[4])).toEqual(["agent-manager", "agent-reviewer"]);
    for (const call of runInserts) {
      expect(String(call.params[18])).toContain("compare notes");
    }
    expect(result.message.mentions_json).toEqual([
      { agent_id: "agent-manager" },
      { agent_id: "agent-reviewer" },
    ]);
    expect(result.message.metadata_json).toMatchObject({
      routing_mode: "direct",
      root_run_id: "run-root",
      recipient_agent_id: "agent-manager",
      recipient_agent_ids: ["agent-manager", "agent-reviewer"],
    });
    expect(result.message.metadata_json?.recipient_run_id).toBe(result.message.run_id);
    expect((result.message.metadata_json?.recipient_run_ids as string[] | undefined)).toHaveLength(2);
  });

  it("routes segmented user instructions with separate prompts per recipient segment", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "@Manager check logic @Reviewer check style",
        routing_mode: "direct",
        recipient_segments: [
          { recipient_agent_ids: ["agent-manager"], content: "check logic" },
          { recipient_agent_ids: ["agent-reviewer"], content: "check style" },
        ],
      },
    );

    const runInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInserts.map((call) => call.params[2])).toEqual(["agent-manager", "agent-reviewer"]);
    expect(String(runInserts[0]?.params[18])).toContain("check logic");
    expect(String(runInserts[1]?.params[18])).toContain("check style");
    expect(result.message.metadata_json).toMatchObject({
      routing_mode: "direct",
      routing_segments: [
        { recipient_agent_ids: ["agent-manager"], content: "check logic" },
        { recipient_agent_ids: ["agent-reviewer"], content: "check style" },
      ],
    });
  });

  it("routes a trailing manager segment as a normal direct recipient run", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "@Reviewer answer 1+1 @Manager summarize the result",
        routing_mode: "direct",
        recipient_segments: [
          { recipient_agent_ids: ["agent-reviewer"], content: "answer 1+1" },
          { recipient_agent_ids: ["agent-manager"], content: "summarize the result" },
        ],
      },
    );

    const runInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO runs"));
    const jobInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO jobs"));
    expect(runInserts).toHaveLength(2);
    expect(jobInserts).toHaveLength(2);
    expect(runInserts[0]?.params[2]).toBe("agent-reviewer");
    expect(String(runInserts[0]?.params[18])).toContain("answer 1+1");
    expect(runInserts[1]?.params[2]).toBe("agent-manager");
    expect(String(runInserts[1]?.params[18])).toContain("summarize the result");
    const reviewerOverride = JSON.parse(String(runInserts[0]?.params[26]));
    const managerOverride = JSON.parse(String(runInserts[1]?.params[26]));
    expect(reviewerOverride).not.toHaveProperty("chat_context_preamble");
    expect(managerOverride).not.toHaveProperty("chat_context_preamble");
    expect(reviewerOverride.room_turn_routing).toMatchObject({
      schema_version: "room_turn_routing.v1",
      current_recipient_agent_id: "agent-reviewer",
      current_segment_index: 0,
      recipient_segments: [
        { recipient_agent_ids: ["agent-reviewer"], recipient_labels: ["reviewer"], task: "answer 1+1" },
        { recipient_agent_ids: ["agent-manager"], recipient_labels: ["manager"], task: "summarize the result" },
      ],
    });
    expect(managerOverride.room_turn_routing).toMatchObject({
      schema_version: "room_turn_routing.v1",
      current_recipient_agent_id: "agent-manager",
      current_segment_index: 1,
    });
    expect(jobInserts[0]?.params[4]).toBe("agent-reviewer");
    expect(jobInserts[1]?.params[4]).toBe("agent-manager");
    expect(result.message.mentions_json).toEqual([
      { agent_id: "agent-reviewer" },
      { agent_id: "agent-manager" },
    ]);
    expect(result.message.metadata_json).toMatchObject({
      routing_mode: "direct",
      recipient_agent_ids: ["agent-reviewer", "agent-manager"],
      routing_segments: [
        { recipient_agent_ids: ["agent-reviewer"], content: "answer 1+1" },
        { recipient_agent_ids: ["agent-manager"], content: "summarize the result" },
      ],
    });
    expect((result.message.metadata_json?.recipient_run_ids as string[] | undefined)).toHaveLength(2);
  });

  it("routes agent coordination mode only to the manager", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    const result = await service.sendUserMessage(
      { spaceId: "space-1", userId: "user-1" },
      {
        space_id: "space-1",
        group_id: "group-1",
        content: "@Reviewer inspect this draft and coordinate any follow-up",
        routing_mode: "agent_coordination",
        recipient_segments: [{
          recipient_agent_ids: ["agent-reviewer"],
          content: "inspect this draft",
        }],
      },
    );

    const runInserts = db.calls.filter((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInserts).toHaveLength(1);
    expect(runInserts[0]?.params[2]).toBe("agent-manager");
    expect(String(runInserts[0]?.params[18])).toContain("@Reviewer inspect this draft and coordinate any follow-up");
    expect(result.message.mentions_json).toEqual([{ agent_id: "agent-manager" }]);
    expect(result.message.metadata_json).toMatchObject({
      routing_mode: "agent_coordination",
      recipient_agent_id: "agent-manager",
      recipient_agent_ids: ["agent-manager"],
    });
  });

  it("rejects explicit recipients outside the room", async () => {
    const db = new AgentGroupServiceDb();
    const service = new AgentGroupRunService(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      new FakePool(db) as never,
    );

    await expect(
      service.sendUserMessage(
        { spaceId: "space-1", userId: "user-1" },
        {
          space_id: "space-1",
          group_id: "group-1",
          content: "@External inspect this draft",
          routing_mode: "direct",
          recipient_segments: [{
            recipient_agent_ids: ["agent-external"],
            content: "inspect this draft",
          }],
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "recipient_segments.recipient_agent_ids must be a member of this agent group",
    });
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO runs"))).toBe(false);
  });
});
