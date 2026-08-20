import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { Pool } from "../src/db/pool";
import {
  resolveAgentDelegationToolBinding,
  runAgentRoomToolCall,
  type AgentDelegationToolBinding,
} from "../src/modules/runs/managedAgentDelegationTools";
import type { RuntimeHostExecutor } from "../src/modules/runs/managedRetrievalTools";
import {
  executeManagedToolLoop,
  mergeManagedToolContributions,
} from "../src/modules/runs/managedToolLoop";
import { AgentToolGateway } from "../src/modules/systemActions/agentToolGateway";
import type { RunRecord } from "../src/modules/runs/repository";
import type {
  CanonicalToolCall,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ManagedToolDispatchResult } from "../src/modules/runs/managedAgentLoopPort";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-manager-turn",
    space_id: "space-1",
    agent_id: "agent-manager",
    agent_version_id: "version-manager",
    runtime_profile_id: "profile-manager",
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
    started_at: "2026-07-05T00:00:00.000Z",
    ended_at: null,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    visibility: "space_shared",
    ...overrides,
  };
}

function response(input: Partial<RuntimeHostExecuteResponse>): RuntimeHostExecuteResponse {
  return {
    success: true,
    stdout: input.output_text ?? "",
    stderr: "",
    output_text: "",
    output_json: {},
    exit_code: 0,
    error_text: null,
    error_code: null,
    started_at: "2026-07-05T00:00:00.000Z",
    completed_at: "2026-07-05T00:00:01.000Z",
    model: "gpt-test",
    usage: null,
    events: [],
    adapter_metadata: {},
    adapter_log_json: null,
    ...input,
  };
}

function request(): RuntimeHostExecuteRequest {
  return {
    run_input: {
      schema_version: "run_input.v1",
      run_id: "run-manager-turn",
      space_id: "space-1",
      instruction: "Coordinate review work.",
      task_goal: "Ask two reviewers.",
      messages: [],
      inputs: { direct: null, workflow: null, upstream: null },
      attachments: [],
      project_folder_access: null,
      output_contract: {
        schema_version: "run_output_contract.v1",
        structured_output: null,
        required_outputs: [],
      },
      tool_grants: [],
      execution: {
        shape: "conversational",
        risk_level: "low",
        required_sandbox_level: "none",
        policy_ref: "run_permission_snapshot:run-manager-turn",
        budget_ref: "run_contract:run-manager-turn",
      },
    },
    run_id: "run-manager-turn",
    space_id: "space-1",
    model_provider_id: "provider-1",
    model: "gpt-test",
    system_prompt: "You are the manager.",
    prompt: "Ask two code reviewers to answer 1+1 independently.",
    mode: "live",
    instruction: "Coordinate review work.",
    project_id: null,
    project_folder_id: null,
    capability_id: null,
    tool_mode: "disabled",
    tool_bindings: [],
  };
}

/**
 * A delegation-only run contributes delegation and nothing else. There is no
 * retrieval carrier: constructing one was the shape this loop ownership move
 * removed, and its absence is what makes these cases delegation tests rather
 * than retrieval tests wearing a delegation hat.
 */
function delegationOnlyToolSet(
  binding: AgentDelegationToolBinding,
  dispatch: (call: CanonicalToolCall) => Promise<ManagedToolDispatchResult>,
) {
  return mergeManagedToolContributions(
    [null, { definitions: binding.toolDefinitions, bindings: binding.toolBindings }, null],
    dispatch,
  );
}

describe("managed agent delegation tools", () => {
  it("turns model agent.delegate calls into auditable child-run requests", async () => {
    const spawnCalls: unknown[] = [];
    const managerRun = run();
    const binding = await resolveAgentDelegationToolBinding(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      managerRun,
      {
        targets: [
          {
            agent_id: "agent-reviewer-a",
            name: "Reviewer A",
            role: "worker",
            capabilities_json: { capabilities: ["code_review"], description: "Reviews code changes." },
          },
          {
            agent_id: "agent-reviewer-b",
            name: "Reviewer B",
            role: "worker",
            capabilities_json: { capabilities: ["test_review"], description: "Reviews test coverage." },
          },
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
      },
    );
    expect(binding).not.toBeNull();
    expect(binding?.toolDefinitions[0].input_schema).toMatchObject({
      properties: {
        target_agent_id: { enum: ["agent-reviewer-a", "agent-reviewer-b"] },
      },
    });

    const hostRequests: RuntimeHostExecuteRequest[] = [];
    const execute: RuntimeHostExecutor = async (_config, hostRequest) => {
      hostRequests.push(hostRequest);
      if (hostRequests.length === 1) {
        return response({
          output_json: {
            tool_calls: [
              {
                id: "tool-call-a",
                name: "agent.delegate",
                arguments_json: JSON.stringify({
                  target_agent_id: "agent-reviewer-a",
                  instruction: "Answer 1+1 independently.",
                }),
              },
              {
                id: "tool-call-b",
                name: "agent.delegate",
                arguments_json: JSON.stringify({
                  target_agent_id: "agent-reviewer-b",
                  instruction: "Answer 1+1 independently.",
                }),
              },
            ],
          },
        });
      }
      return response({
        output_text: "Delegated both reviewer checks and will wait for their results.",
        output_json: {},
      });
    };

    const result = await executeManagedToolLoop(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      request(),
      execute,
      delegationOnlyToolSet(binding!, (call) => runAgentRoomToolCall(call, binding!, managerRun, request())),
    );

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toMatchObject({
      identity: { spaceId: "space-1", userId: "user-1" },
      input: {
        parent_run_id: "run-manager-turn",
        root_run_id: "run-root",
        requesting_agent_id: "agent-manager",
        target_agent_id: "agent-reviewer-a",
      },
    });
    expect(hostRequests[0]).toMatchObject({
      tool_mode: "authorized_bindings",
      tools: expect.arrayContaining([expect.objectContaining({ name: "agent.delegate" })]),
    });
    expect(hostRequests[1].messages?.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(result.output_json).toMatchObject({
      managed_tool_calls: [
        expect.objectContaining({ ok: true, target_agent_id: "agent-reviewer-a", child_run_id: "run-child-a" }),
        expect.objectContaining({ ok: true, target_agent_id: "agent-reviewer-b", child_run_id: "run-child-b" }),
      ],
    });
  });

  it("pauses the current run when agent.wait_for_results finds unfinished dependencies", async () => {
    const managerRun = run();
    const dependencyRun = run({
      id: "run-reviewer",
      agent_id: "agent-reviewer-a",
      agent_name: "Reviewer A",
      status: "running",
      parent_run_id: "run-root",
      root_run_id: "run-root",
      run_group_id: "group-1",
      prompt: "Answer 1+1.",
    });
    const pool = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
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
    const binding = await resolveAgentDelegationToolBinding(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      managerRun,
      {
        pool,
        targets: [],
        service: {
          async spawnChildRun() {
            throw new Error("delegate should not be called");
          },
        },
      },
    );
    expect(binding).not.toBeNull();
    expect(binding?.toolDefinitions.map((tool) => tool.name)).toEqual(["agent.wait_for_results"]);

    const hostRequests: RuntimeHostExecuteRequest[] = [];
    const execute: RuntimeHostExecutor = async (_config, hostRequest) => {
      hostRequests.push(hostRequest);
      return response({
        output_json: {
          tool_calls: [{
            id: "wait-call-1",
            name: "agent.wait_for_results",
            arguments_json: JSON.stringify({
              scope: "run_ids",
              run_ids: ["run-reviewer"],
              reason: "Need reviewer result before summarizing.",
              resume_instruction: "Summarize the reviewer result.",
            }),
          }],
        },
      });
    };

    const result = await executeManagedToolLoop(
      loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" }),
      request(),
      execute,
      delegationOnlyToolSet(binding!, (call) => runAgentRoomToolCall(call, binding!, managerRun, request())),
    );

    expect(hostRequests).toHaveLength(1);
    expect(result.output_json).toMatchObject({
      waiting_for_results: {
        status: "waiting",
        scope: "run_ids",
        depends_on_run_ids: ["run-reviewer"],
        pending_run_ids: ["run-reviewer"],
      },
      managed_tool_calls: [
        expect.objectContaining({
          tool_name: "agent.wait_for_results",
          ok: true,
          status: "waiting",
        }),
      ],
    });
    expect(result.output_text).toBe("");
  });
  it("routes a delegation-only run through the general tool loop and offers it the delegation tools", async () => {
    // Gate 5. A run with delegation and no retrieval-domain tool reaches the
    // general loop as a delegation contribution — no carrier binding is
    // fabricated for it, and none exists to fabricate. Driving
    // `AgentToolGateway` rather than the loop directly is the point: it is the
    // gateway's assembly that must offer the tools.
    const managerRun = run({
      // The gateway offers only granted actions, so the grants are part of what
      // makes this case reachable at all.
      permission_snapshot_json: {
        tool_grants: [
          { action_id: "agent.delegate" },
          { action_id: "agent.wait_for_results" },
        ],
      },
    } as Partial<RunRecord>);
    const offered: string[][] = [];
    const systemPrompts: string[] = [];
    const gateway = new AgentToolGateway(
      // No database URL: a delegation-only run reads no space retrieval
      // settings, and the model turn below produces no tool call, so policy and
      // dispatch are never reached.
      loadConfig({}),
    );

    const result = await gateway.execute(
      managerRun,
      request(),
      async (_config, hostRequest) => {
        offered.push((hostRequest.tools ?? []).map((tool) => tool.name));
        systemPrompts.push(hostRequest.system_prompt ?? "");
        return response({ output_text: "Nothing to delegate.", output_json: {} });
      },
      {
        agentDelegationTools: {
          targets: [
            {
              agent_id: "agent-reviewer-a",
              name: "Reviewer A",
              role: "worker",
              capabilities_json: { capabilities: ["code_review"] },
            },
          ],
          service: {
            async spawnChildRun() {
              throw new Error("no delegation call is expected in this test");
            },
          },
        },
      },
    );

    expect(offered).toHaveLength(1);
    expect(offered[0]).toEqual(
      expect.arrayContaining(["agent.delegate", "agent.wait_for_results"]),
    );
    expect(systemPrompts[0]).toContain("Do not print raw action arguments, JSON schemas");
    expect(systemPrompts[0]).toContain("call the action instead of simulating it in prose");
    expect(result.success).toBe(true);
  });
});
