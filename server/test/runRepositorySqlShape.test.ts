import { describe, expect, it } from "vitest";
import { ROOM_CONVERSATION_TOOL_ALLOWANCE, conversationToolGrantInput } from "../src/modules/systemActions/scenarioToolAllowance.js";
import {
  PgRunRepository,
  type Queryable,
  type QueryResult,
  type RunRecord,
} from "../src/modules/runs/repository.js";

class RunCreateSqlShapeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    // A parent Run must be visible to the creator: the Room probe and the
    // Run's content decision. Both read `runs`, so they answer first.
    if (sql.includes("AS allowed")) {
      return { rows: [{ allowed: true }] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM runs content_resource")) {
      return { rows: [{ effective_access_level: "full" }] as Row[], rowCount: 1 };
    }
    if (sql.includes("FROM agents")) {
      return {
        rows: [{
          id: "agent-1",
          status: "active",
          current_version_id: "version-1",
          visibility: "space_shared",
          access_level: "full",
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_versions")) {
      return {
        rows: [{ id: "version-1", tool_permissions_json: {} }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM agent_runtime_profiles")) {
      return {
        rows: [{
          id: "profile-1",
          space_id: "space-1",
          agent_id: "agent-1",
          name: "CLI",
          runtime_key: "codex_cli",
          model_provider_id: null,
          model_name: null,
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
    if (sql.includes("FROM runs")) {
      const row: Partial<RunRecord> = {
        id: String(params[1] ?? "run-root"),
        space_id: "space-1",
        agent_id: "agent-1",
        agent_version_id: "version-1",
        runtime_profile_id: "profile-1",
        status: "succeeded",
        mode: "live",
        prompt: "root",
        instruction: null,
        project_folder_id: "workspace-1",
        session_id: "session-1",
        parent_run_id: null,
        root_run_id: "run-root",
        run_group_id: "group-1",
        delegation_id: null,
        project_id: "project-1",
        runtime_key: "codex_cli",
        model_provider_id: null,
        required_sandbox_level: "ephemeral",
        trigger_origin: "manual",
        started_at: null,
        ended_at: null,
      };
      return { rows: [row as RunRecord as Row], rowCount: 1 };
    }
    if (
      sql.includes("FROM project_folders") ||
      sql.includes("FROM sessions") ||
      sql.includes("FROM projects")
    ) {
      return { rows: [{ id: params[1] }] as Row[], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO runs")) {
      const row: Partial<RunRecord> = {
        id: String(params[0]),
        space_id: "space-1",
        agent_id: "agent-1",
        agent_version_id: "version-1",
        runtime_profile_id: params[6] === null ? null : String(params[6]),
        run_role: String(params[4]) as "execution" | "coordinator",
        requested_runtime_profile_id: params[5] === null ? null : String(params[5]),
        run_type: "agent",
        status: "queued",
        mode: String(params[17]),
        prompt: params[18] === null ? null : String(params[18]),
        instruction: params[19] === null ? null : String(params[19]),
        project_folder_id: params[7] === null ? null : String(params[7]),
        session_id: params[8] === null ? null : String(params[8]),
        parent_run_id: params[9] === null ? null : String(params[9]),
        root_run_id: params[10] === null ? null : String(params[10]),
        run_group_id: params[11] === null ? null : String(params[11]),
        delegation_id: params[12] === null ? null : String(params[12]),
        project_id: params[31] === null ? null : String(params[31]),
        scheduled_at: null,
        runtime_key: params[22] === null ? null : String(params[22]),
        capability_id: null,
        capabilities_json: [],
        model_provider_id: params[25] === null ? null : String(params[25]),
        model_override_json: null,
        runtime_profile_snapshot_json: {},
        required_sandbox_level: String(params[28]),
        trigger_origin: String(params[16]),
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
      };
      return { rows: [row as RunRecord as Row], rowCount: 1 };
    }
    if (sql.includes("UPDATE runs") && sql.includes("status = 'running'")) {
      const row: Partial<RunRecord> = {
        id: String(params[1]),
        space_id: "space-1",
        agent_id: "agent-1",
        agent_name: "Coding Reviewer",
        agent_version_id: "version-1",
        runtime_profile_id: "profile-1",
        system_prompt: "You are Coding Reviewer.",
        status: "running",
        mode: "live",
        prompt: "hello",
        instruction: null,
        project_folder_id: null,
        session_id: null,
        parent_run_id: null,
        root_run_id: null,
        run_group_id: "group-1",
        delegation_id: null,
        project_id: null,
        runtime_key: "opencode",
        model_provider_id: "provider-1",
        model_override_json: { messages: [{ role: "user", content: "hello" }] },
        runtime_profile_snapshot_json: {},
        runtime_config_json: {},
        required_sandbox_level: "none",
        trigger_origin: "manual",
        instructed_by_user_id: "user-1",
        instructed_by_agent_id: null,
        error_message: null,
        started_at: String(params[2]),
        ended_at: null,
      };
      return { rows: [row as RunRecord as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO run_attempts")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class RunAuthorityProjectionDb implements Queryable {
  readonly calls: string[] = [];

  async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
    this.calls.push(sql);
    if (sql.includes("r.execution_kind, r.runtime_key")) {
      return {
        rows: [{
          id: "provider-run-1",
          space_id: "space-1",
          agent_id: null,
          agent_version_id: null,
          execution_kind: "provider_task",
          runtime_key: null,
          status: "succeeded",
          mode: "live",
          prompt: null,
          instruction: null,
          project_folder_id: null,
          session_id: null,
          project_id: null,
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("execution_kind, runtime_key,")) {
      return {
        rows: [{
          id: "provider-run-1",
          space_id: "space-1",
          agent_id: null,
          agent_version_id: null,
          execution_kind: "provider_task",
          runtime_key: null,
          status: "succeeded",
          mode: "live",
          prompt: null,
          instruction: null,
          project_folder_id: null,
          session_id: null,
          project_id: null,
          effective_access_level: "full",
        }] as Row[],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

class ProviderTaskRunSqlShapeDb implements Queryable {
  call: { sql: string; params: readonly unknown[] } | null = null;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.call = { sql, params };
    return {
      rows: [{ id: String(params[0]), space_id: String(params[1]), execution_kind: "provider_task", status: "running" }] as Row[],
      rowCount: 1,
    };
  }
}

describe("PgRunRepository SQL shape", () => {
  it("projects Run execution authority on detail and list reads", async () => {
    const db = new RunAuthorityProjectionDb();
    const repository = new PgRunRepository(db);

    const detail = await repository.getRun("space-1", "provider-run-1");
    const list = await repository.listRuns({
      space_id: "space-1",
      user_id: "user-1",
      limit: 20,
      offset: 0,
    });

    expect(detail).toMatchObject({ execution_kind: "provider_task", runtime_key: null });
    expect(list[0]).toMatchObject({ execution_kind: "provider_task", runtime_key: null });
    expect(db.calls.some((sql) => sql.includes("r.execution_kind, r.runtime_key"))).toBe(true);
    expect(db.calls.some((sql) => sql.includes("execution_kind, runtime_key,"))).toBe(true);
  });

  it("keeps queued run INSERT columns aligned with values", async () => {
    const db = new RunCreateSqlShapeDb();
    await new PgRunRepository(db).createQueuedRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "hello",
    });

    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert).toBeTruthy();
    const { columns, values } = insertColumnsAndValues(runInsert!.sql);
    expect(values).toHaveLength(columns.length);
    expect(runInsert!.params).toHaveLength(40);
    expect(runInsert!.params[34]).toBe("default");
    expect(runInsert!.params[35]).toBe('{"tool_grants":[]}');
    expect(columns.slice(-2)).toEqual(["host_task_thread_id", "execution_kind"]);
    expect(new Set(columns).size).toBe(columns.length);
    expect(columns.slice(15, 18)).toEqual(["run_type", "trigger_origin", "status"]);
    expect(values.slice(15, 18)).toEqual(["$16", "$17", "'queued'"]);
    expect(runInsert!.params.slice(15, 18)).toEqual(["agent", "manual", "live"]);
  });

  it("persists the scenario allowance with its derived tool grants", async () => {
    const db = new RunCreateSqlShapeDb();
    await new PgRunRepository(db).createQueuedRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "advance this Room",
      capabilities_json: ["inquiry.record_conclusion", "inquiry.promote_knowledge"],
      scenario_tool_allowance: ["inquiry.record_conclusion", "inquiry.promote_knowledge"],
    });

    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    const snapshot = JSON.parse(String(runInsert!.params[35])) as {
      tool_grants: Array<{ action_id: string }>;
      scenario_tool_allowance: string[];
    };
    expect(snapshot.scenario_tool_allowance).toEqual([
      "inquiry.record_conclusion",
      "inquiry.promote_knowledge",
    ]);
    expect(snapshot.tool_grants.map((grant) => grant.action_id)).toEqual(
      expect.arrayContaining([
        "inquiry.record_conclusion",
        "inquiry.promote_knowledge",
      ]),
    );
  });

  it("persists an explicitly requested runtime profile without preselecting it", async () => {
    const db = new RunCreateSqlShapeDb();
    await new PgRunRepository(db).createQueuedRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: "profile-1",
      prompt: "hello",
    });

    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert?.params[5]).toBe("profile-1");
    expect(runInsert?.params[6]).toBeNull();
    expect(runInsert?.params[22]).toBeNull();
    expect(runInsert?.params[34]).toBe("explicit");
  });

  it("creates coordinator runs without physical attempts", async () => {
    const db = new RunCreateSqlShapeDb();
    const run = await new PgRunRepository(db).createCoordinatorRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "workflow",
      trigger_origin: "manual",
      prompt: "coordinate",
    });
    expect(run.run_role).toBe("coordinator");
    expect(run.runtime_profile_id).toBeNull();
    expect(run.runtime_key).toBeNull();
    expect(run.model_provider_id).toBeNull();
    expect(db.calls.some((call) => call.sql.includes("FROM agent_runtime_profiles"))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO run_attempts"))).toBe(false);
  });

  it("creates a ProviderTask Run with no Agent/runtime authority and exact ledger references", async () => {
    const db = new ProviderTaskRunSqlShapeDb();
    const run = await new PgRunRepository(db).createProviderTaskRun({
      execution_kind: "provider_task",
      space_id: "space-1",
      user_id: "user-1",
      trigger_origin: "manual",
      run_type: "reflection",
      task: "daily_report",
      prompt: "Generate report for 2026-09-10.",
      provider_id: "provider-1",
      model: "gpt-4o-mini",
      control_id: "control-1",
      delivery_id: "delivery-1",
      invocation_snapshot_id: "snapshot-1",
      contract_snapshot: {
        source: { kind: "direct", id: "setting-1" },
        git_snapshot: null,
      },
    });

    expect(run).toEqual({ id: expect.any(String), space_id: "space-1", execution_kind: "provider_task", status: "running" });
    expect(db.call?.sql).toContain("agent_id, agent_version_id, execution_kind");
    expect(db.call?.params[2]).toBe("provider_task");
    expect(db.call?.sql).toContain("provider_task_control_id, provider_task_delivery_id, provider_task_snapshot_id");
    expect(db.call?.params.slice(3, 6)).toEqual(["control-1", "delivery-1", "snapshot-1"]);
    expect(db.call?.sql).not.toContain("INSERT INTO run_attempts");
  });

  it("queues a ProviderTask Run with no provider or ledger references yet", async () => {
    const db = new ProviderTaskRunSqlShapeDb();
    const run = await new PgRunRepository(db).createQueuedProviderTaskRun({
      space_id: "space-1",
      user_id: "user-1",
      trigger_origin: "manual",
      run_type: "agent",
      task: "project_research_adhoc_analyze",
      prompt: "Summarize the selected material.",
      instruction: "…rendered instruction…",
      project_id: null,
      capability_id: "research.adhoc_analyze",
      contract_snapshot: { source: { kind: "direct", id: "note-1" } },
    });

    expect(run).toMatchObject({ space_id: "space-1", execution_kind: "provider_task" });
    // The queued arm of `ck_runs_execution_shape`: the bounded task has not
    // picked a provider or opened its ledger records yet, so the INSERT must
    // not name those columns at all.
    expect(db.call?.sql).toContain("'queued'");
    expect(db.call?.sql).not.toContain("provider_task_control_id");
    expect(db.call?.sql).not.toContain("model_provider_id");
    expect(db.call?.sql).not.toContain("started_at");
    // A ProviderTask Run has no physical Run attempts; its attempts are the
    // ProviderTask ledger's.
    expect(db.call?.sql).not.toContain("INSERT INTO run_attempts");
  });

  it("binds a queued ProviderTask Run to the attempt that starts it, once", async () => {
    const db = new ProviderTaskRunSqlShapeDb();
    const started = await new PgRunRepository(db).startQueuedProviderTaskRun({
      run_id: "run-1",
      space_id: "space-1",
      provider_id: "provider-1",
      control_id: "control-1",
      delivery_id: "delivery-1",
      invocation_snapshot_id: "snapshot-1",
    });

    expect(started).toBe(true);
    expect(db.call?.sql).toContain("SET status = 'running'");
    expect(db.call?.sql).toContain("started_at = $3::timestamptz");
    expect(db.call?.sql).toContain("provider_task_control_id = $5");
    // The guard: a second attempt, or a job retry that found the Run already
    // running, must not re-stamp it, and a Run cancelled while queued must
    // not be started at all.
    expect(db.call?.sql).toContain("AND status = 'queued'");
    expect(db.call?.sql).toContain("AND execution_kind = 'provider_task'");
    expect(db.call?.params.slice(3, 7)).toEqual([
      "provider-1", "control-1", "delivery-1", "snapshot-1",
    ]);
  });

  it("creates grouped agent runs with root and group lineage", async () => {
    const db = new RunCreateSqlShapeDb();
    const run = await new PgRunRepository(db).createGroupedAgentRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      parent_run_id: "run-root",
      root_run_id: "run-root",
      run_group_id: "group-1",
      project_folder_id: "workspace-1",
      session_id: "session-1",
      project_id: "project-1",
      prompt: "Continue the room",
      instruction: "Room goal",
      budget_json: { max_fanout: 4 },
      context_policy_json: { room: true },
    });

    expect(run).toMatchObject({
      parent_run_id: "run-root",
      root_run_id: "run-root",
      run_group_id: "group-1",
      prompt: "Continue the room",
      instruction: "Room goal",
      trigger_origin: "manual",
    });
    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert?.params.slice(9, 12)).toEqual(["run-root", "run-root", "group-1"]);
  });

  it("snapshots tool grants through the delegated child creation path", async () => {
    const db = new RunCreateSqlShapeDb();
    const run = await new PgRunRepository(db).createDelegatedChildRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      parent_run_id: "run-root",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
      instructed_by_agent_id: "manager-agent",
      prompt: "Review the result",
      capabilities_json: ["agent.delegate"],
    });

    expect(run).toMatchObject({
      parent_run_id: "run-root",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
      trigger_origin: "delegation",
    });
    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    expect(runInsert?.params[35]).toBe('{"tool_grants":[]}');
  });

  it("carries the conversation's allowance onto a delegated child, like its parent", async () => {
    // A Room's delegate acts in the same conversation it was spoken to in.
    // Declaring nothing here (the case above) is how a delegated specialist
    // ended up able to call no action at all, while its parent held the
    // whole Project write surface.
    const db = new RunCreateSqlShapeDb();
    await new PgRunRepository(db).createDelegatedChildRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      parent_run_id: "run-root",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
      instructed_by_agent_id: "manager-agent",
      prompt: "Investigate",
      ...conversationToolGrantInput({ room_id: "room-1" }),
    });
    const runInsert = db.calls.find((call) => call.sql.includes("INSERT INTO runs"));
    const snapshot = JSON.parse(String(runInsert?.params[35])) as { tool_grants: Array<{ action_id: string }>; scenario_tool_allowance: string[] };
    expect(snapshot.scenario_tool_allowance).toEqual([...ROOM_CONVERSATION_TOOL_ALLOWANCE]);
    expect(snapshot.tool_grants.map((grant) => grant.action_id)).toContain("project.propose_definition");
  });

  it("keeps agent identity fields on the running run returned for execution", async () => {
    const db = new RunCreateSqlShapeDb();
    const run = await new PgRunRepository(db).markRunRunning({
      run_id: "run-1",
      space_id: "space-1",
      started_at: "2026-07-05T00:00:00.000Z",
    });

    const runUpdate = db.calls.find((call) => call.sql.includes("UPDATE runs") && call.sql.includes("status = 'running'"));
    expect(runUpdate?.sql).toContain("a.name AS agent_name");
    expect(runUpdate?.sql).toContain("av.system_prompt AS system_prompt");
    expect(runUpdate?.sql).toContain("model_override_json");
    expect(runUpdate?.sql).toContain("permission_snapshot_json");
    expect(run).toMatchObject({
      agent_id: "agent-1",
      agent_name: "Coding Reviewer",
      system_prompt: "You are Coding Reviewer.",
      model_override_json: { messages: [{ role: "user", content: "hello" }] },
    });
  });
});

function insertColumnsAndValues(sql: string): { columns: string[]; values: string[] } {
  const match = /INSERT INTO runs\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*RETURNING/.exec(sql);
  if (!match) throw new Error("Could not parse runs INSERT");
  return {
    columns: commaList(match[1]),
    values: commaList(match[2]),
  };
}

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
