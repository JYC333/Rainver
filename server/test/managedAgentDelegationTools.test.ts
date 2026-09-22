import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Pool } from "../src/db/pool.js";
import {
  resolveAgentDelegationToolBinding,
  runAgentRoomToolCall,
} from "../src/modules/runs/managedAgentDelegationTools.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-manager-turn",
    space_id: "space-1",
    agent_id: "agent-manager",
    agent_version_id: "version-manager",
    runtime_profile_id: "profile-manager",
    execution_kind: "agent",
    run_type: "agent",
    status: "running",
    mode: "live",
    prompt: "Ask two reviewers.",
    instruction: "Coordinate review work.",
    project_folder_id: null,
    session_id: null,
    parent_run_id: "run-root",
    root_run_id: "run-root",
    run_group_id: "group-1",
    delegation_id: null,
    project_id: null,
    scheduled_at: null,
    runtime_key: "codex_cli",
    capability_id: null,
    capabilities_json: [],
    model_provider_id: null,
    model_override_json: null,
    runtime_profile_snapshot_json: { runtime_key: "codex_cli", backend_mode: "runtime_native" },
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    instructed_by_agent_id: null,
    error_message: null,
    error_json: null,
    output_json: null,
    started_at: "2026-07-05T00:00:00.000Z",
    ended_at: null,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    visibility: "space_shared",
    ...overrides,
  };
}

const config = loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" });

describe("ACP agent delegation tools", () => {
  it("dispatches auditable child-run requests as bounded tool calls", async () => {
    const spawnCalls: unknown[] = [];
    const managerRun = run();
    const binding = await resolveAgentDelegationToolBinding(config, managerRun, {
      targets: [
        { agent_id: "agent-reviewer-a", name: "Reviewer A", role: "worker", capabilities_json: { capabilities: ["code_review"] } },
        { agent_id: "agent-reviewer-b", name: "Reviewer B", role: "worker", capabilities_json: { capabilities: ["test_review"] } },
      ],
      service: {
        async spawnChildRun(identity, input) {
          spawnCalls.push({ identity, input });
          const suffix = input.target_agent_id.endsWith("a") ? "a" : "b";
          return {
            delegation: {
              id: `delegation-${suffix}`,
              space_id: input.space_id,
              group_id: input.group_id,
              parent_run_id: input.parent_run_id,
              child_run_id: `run-child-${suffix}`,
              request_message_id: null,
              requesting_agent_id: input.requesting_agent_id,
              target_agent_id: input.target_agent_id,
              requested_by_user_id: identity.userId,
              policy_decision_record_id: `policy-${suffix}`,
              status: "queued",
              instruction: input.instruction,
              reason: input.reason ?? null,
              budget_json: input.budget_json ?? null,
              context_policy_json: input.context_policy_json ?? null,
              result_summary: null,
              tool_call_id: null,
              created_at: "2026-07-05T00:00:00.000Z",
              updated_at: "2026-07-05T00:00:00.000Z",
              completed_at: null,
            },
            child_run_id: `run-child-${suffix}`,
            policy_decision_record_id: `policy-${suffix}`,
          };
        },
      },
    });

    expect(binding?.toolDefinitions[0]?.input_schema).toMatchObject({
      properties: { target_agent_id: { enum: ["agent-reviewer-a", "agent-reviewer-b"] } },
    });
    expect(binding?.toolDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "agent.delegate",
        description: expect.stringContaining("Do not simulate the target agent's result"),
      }),
      expect.objectContaining({
        name: "agent.wait_for_results",
        description: expect.stringContaining("Use scope=own_delegations"),
      }),
    ]));
    const results = await Promise.all(["a", "b"].map((suffix) => runAgentRoomToolCall({
      id: `tool-call-${suffix}`,
      name: "agent.delegate",
      arguments_json: JSON.stringify({
        target_agent_id: `agent-reviewer-${suffix}`,
        instruction: "Answer 1+1 independently.",
      }),
    }, binding!, managerRun)));

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toMatchObject({
      identity: { spaceId: "space-1", userId: "user-1" },
      input: { parent_run_id: "run-manager-turn", root_run_id: "run-root", target_agent_id: "agent-reviewer-a" },
    });
    expect(results.map((result) => result.modelResult)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, target_agent_id: "agent-reviewer-a", child_run_id: "run-child-a" }),
      expect.objectContaining({ ok: true, target_agent_id: "agent-reviewer-b", child_run_id: "run-child-b" }),
    ]));
  });

  it("returns pending dependency information in one bounded tool result", async () => {
    const managerRun = run();
    const dependencyRun = run({
      id: "run-reviewer",
      agent_id: "agent-reviewer-a",
      agent_name: "Reviewer A",
      status: "running",
      prompt: "Answer 1+1.",
    });
    const queriedRunIds: unknown[] = [];
    let parkedSqlSeen = false;
    const pool = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        if (sql.includes("SELECT id, status") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "run-reviewer", status: "running" }] as Row[], rowCount: 1 };
        }
        if (sql.includes("SELECT status, run_group_id")) {
          return { rows: [{ status: "running", run_group_id: "group-1" }] as Row[], rowCount: 1 };
        }
        if (sql.includes("FROM run_attempts") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "attempt-manager" }] as Row[], rowCount: 1 };
        }
        if (sql.includes("WITH parked AS")) {
          parkedSqlSeen = true;
          return { rows: [{ id: managerRun.id }] as Row[], rowCount: 1 };
        }
        if (sql.includes("FROM runs r") && sql.includes("WHERE r.space_id = $1 AND r.id = $2")) {
          queriedRunIds.push(params[1]);
          const row = params[1] === "run-reviewer" ? dependencyRun : null;
          return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
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
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    } as unknown as Pool;
    const binding = await resolveAgentDelegationToolBinding(config, managerRun, {
      pool,
      targets: [],
      service: { async spawnChildRun() { throw new Error("delegate should not be called"); } },
    });

    expect(binding?.toolDefinitions.map((tool) => tool.name)).toEqual(["agent.wait_for_results"]);
    const invalid = await runAgentRoomToolCall({
      id: "wait-call-invalid",
      name: "agent.wait_for_results",
      arguments_json: JSON.stringify({ scope: "run_ids", run_ids: ["   ", ""] }),
    }, binding!, managerRun);
    expect(invalid.summary).toMatchObject({ ok: false, error_code: "agent_wait_for_results_tool_call_failed" });
    expect(queriedRunIds).toEqual([]);

    const result = await runAgentRoomToolCall({
      id: "wait-call-1",
      name: "agent.wait_for_results",
      arguments_json: JSON.stringify({
        scope: "run_ids",
        run_ids: [" run-reviewer ", "run-reviewer", "   "],
        reason: "  Need reviewer result before summarizing.  ",
        resume_instruction: "  Summarize the reviewer result.  ",
      }),
    }, binding!, managerRun);
    expect(result.modelResult).toMatchObject({
      status: "waiting",
      scope: "run_ids",
      depends_on_run_ids: ["run-reviewer"],
      pending_run_ids: ["run-reviewer"],
      reason: "Need reviewer result before summarizing.",
      resume_instruction: "Summarize the reviewer result.",
    });
    expect(result.summary).toMatchObject({ tool_name: "agent.wait_for_results", ok: true, status: "waiting" });
    expect(queriedRunIds).toEqual(["run-reviewer"]);
    // `waiting` is a claim about a durable transition, not about this reply:
    // the park write is what the Run resumes from.
    expect(parkedSqlSeen).toBe(true);
  });

  it("reports a failed park as governed-tool degradation rather than an ordinary tool failure", async () => {
    const managerRun = run();
    const dependencyRun = run({
      id: "run-reviewer",
      agent_id: "agent-reviewer-a",
      agent_name: "Reviewer A",
      status: "running",
      prompt: "Answer 1+1.",
    });
    let parkedSqlSeen = false;
    const pool = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        if (sql.includes("SELECT id, status") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "run-reviewer", status: "running" }] as Row[], rowCount: 1 };
        }
        if (sql.includes("SELECT status, run_group_id")) {
          return { rows: [{ status: "running", run_group_id: "group-1" }] as Row[], rowCount: 1 };
        }
        if (sql.includes("FROM run_attempts") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: "attempt-manager" }] as Row[], rowCount: 1 };
        }
        if (sql.includes("WITH parked AS")) {
          parkedSqlSeen = true;
          throw new Error("deadlock detected");
        }
        if (sql.includes("FROM runs r") && sql.includes("WHERE r.space_id = $1 AND r.id = $2")) {
          const row = params[1] === "run-reviewer" ? dependencyRun : null;
          return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
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
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    } as unknown as Pool;
    const binding = await resolveAgentDelegationToolBinding(config, managerRun, {
      pool,
      targets: [],
      service: { async spawnChildRun() { throw new Error("delegate should not be called"); } },
    });

    const result = await runAgentRoomToolCall({
      id: "wait-call-park-failed",
      name: "agent.wait_for_results",
      arguments_json: JSON.stringify({ scope: "run_ids", run_ids: ["run-reviewer"] }),
    }, binding!, managerRun);

    expect(parkedSqlSeen).toBe(true);
    // The Run was never paused, so its dependencies are still unresolved. The
    // `ok: false` summary is what the dispatcher records as a failed
    // `action_completed` Run event, which settles the Run `degraded` instead of
    // letting it answer as though it had waited.
    expect(result.summary).toMatchObject({
      tool_name: "agent.wait_for_results",
      ok: false,
      error_code: "agent_wait_for_results_park_failed",
      depends_on_run_ids: ["run-reviewer"],
    });
    expect(result.modelResult).toMatchObject({ ok: false, status: "park_failed" });
  });
});
