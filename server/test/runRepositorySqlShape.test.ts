import { describe, expect, it } from "vitest";
import {
  PgRunRepository,
  type Queryable,
  type QueryResult,
  type RunRecord,
} from "../src/modules/runs/repository";

class RunCreateSqlShapeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
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
          adapter_type: "codex_cli",
          model_provider_id: null,
          model_name: null,
          credential_profile_id: null,
          runtime_config_json: { adapter_type: "codex_cli" },
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
        adapter_type: "codex_cli",
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
        adapter_type: params[22] === null ? null : String(params[22]),
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
        adapter_type: "model_api",
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

describe("PgRunRepository SQL shape", () => {
  it("keeps queued run INSERT columns aligned with values", async () => {
    const db = new RunCreateSqlShapeDb();
    await new PgRunRepository(db).createQueuedRun({
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
    expect(runInsert!.params).toHaveLength(38);
    expect(runInsert!.params[34]).toBe("default");
    expect(runInsert!.params[35]).toBe('{"tool_grants":[]}');
    expect(columns.at(-1)).toBe("trust_mode");
    expect(columns.slice(15, 18)).toEqual(["run_type", "trigger_origin", "status"]);
    expect(values.slice(15, 18)).toEqual(["$16", "$17", "'queued'"]);
    expect(runInsert!.params.slice(15, 18)).toEqual(["agent", "manual", "live"]);
  });

  it("persists the scenario allowance with its derived tool grants", async () => {
    const db = new RunCreateSqlShapeDb();
    await new PgRunRepository(db).createQueuedRun({
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
    expect(run.adapter_type).toBeNull();
    expect(run.model_provider_id).toBeNull();
    expect(db.calls.some((call) => call.sql.includes("FROM agent_runtime_profiles"))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO run_attempts"))).toBe(false);
  });

  it("creates grouped agent runs with root and group lineage", async () => {
    const db = new RunCreateSqlShapeDb();
    const run = await new PgRunRepository(db).createGroupedAgentRun({
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
