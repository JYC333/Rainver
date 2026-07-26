import { describe, expect, it } from "vitest";
import { AgentGroupRuntimeDelegationMaterializer } from "../src/modules/agentGroups";
import type { RunRecord } from "../src/modules/runs/repository";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-parent",
    space_id: "space-1",
    agent_id: "agent-manager",
    agent_version_id: "agent-version-1",
    status: "running",
    mode: "live",
    prompt: null,
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    adapter_type: "model_api",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    started_at: null,
    ended_at: null,
    run_group_id: "group-1",
    root_run_id: "run-root",
    ...overrides,
  };
}

describe("AgentGroupRuntimeDelegationMaterializer", () => {
  it("uses a stable runtime-output idempotency key across physical retries", async () => {
    const keys: Array<string | null | undefined> = [];
    const materializer = new AgentGroupRuntimeDelegationMaterializer({
      async spawnChildRun(_identity, input) {
        keys.push(input.tool_call_id);
        return {
          delegation: {
            id: "delegation-1",
            child_run_id: "run-child",
            status: "queued",
          } as never,
          child_run_id: "run-child",
          policy_decision_record_id: "policy-1",
        };
      },
    });
    const output = {
      delegations: [{
        target_agent_id: "agent-reader",
        instruction: "Summarize the evidence.",
        budget: { max_cost: 2, max_steps: 4 },
      }],
    };

    await materializer.materialize({ run: run(), output_json: output });
    await materializer.materialize({
      run: run(),
      output_json: {
        delegations: [{
          ...output.delegations[0],
          budget: { max_steps: 4, max_cost: 2 },
        }],
      },
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^runtime_output:[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("spawns child runs from structured runtime delegation output", async () => {
    const calls: unknown[] = [];
    const materializer = new AgentGroupRuntimeDelegationMaterializer({
      async spawnChildRun(identity, input) {
        calls.push({ identity, input });
        return {
          delegation: {
            id: "delegation-1",
            space_id: input.space_id,
            group_id: input.group_id,
            parent_run_id: input.parent_run_id,
            child_run_id: "run-child",
            request_message_id: null,
            requesting_agent_id: input.requesting_agent_id,
            target_agent_id: input.target_agent_id,
            requested_by_user_id: identity.userId,
            policy_decision_record_id: "policy-1",
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
          child_run_id: "run-child",
          policy_decision_record_id: "policy-1",
        };
      },
    });

    const result = await materializer.materialize({
      run: run(),
      output_json: {
        delegations: [
          {
            target_agent_id: "agent-reader",
            instruction: "Summarize the evidence.",
            reason: "Specialist review",
            budget: { max_steps: 4 },
            context: { artifact_ids: ["artifact-1"] },
          },
        ],
      },
    });

    expect(calls).toEqual([
      {
        identity: { spaceId: "space-1", userId: "user-1" },
        input: expect.objectContaining({
          parent_run_id: "run-parent",
          requesting_agent_id: "agent-manager",
          target_agent_id: "agent-reader",
          instruction: "Summarize the evidence.",
          budget_json: { max_steps: 4 },
          context_policy_json: { artifact_ids: ["artifact-1"] },
        }),
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({
      kind: "delegation",
      status: "succeeded",
      metadata_json: {
        operation: "run.spawn_child",
        delegation_id: "delegation-1",
        child_run_id: "run-child",
        delegation_status: "queued",
      },
    });
  });

  it("rejects unsafe delegation output before spawning", async () => {
    const materializer = new AgentGroupRuntimeDelegationMaterializer({
      async spawnChildRun() {
        throw new Error("spawn should not be called");
      },
    });

    const result = await materializer.materialize({
      run: run(),
      output_json: {
        delegations: [
          {
            target_agent_id: "agent-reader",
            instruction: "Use raw context.",
            context: { rendered_context: "raw prompt" },
          },
        ],
      },
    });

    expect(result.items[0]).toMatchObject({
      kind: "delegation",
      status: "failed",
      error_code: "invalid_runtime_delegations",
    });
    expect(result.errors[0]).toContain("invalid_runtime_delegations");
  });

  it("reports policy-denied delegations as warnings with service-written evidence", async () => {
    const materializer = new AgentGroupRuntimeDelegationMaterializer({
      async spawnChildRun(identity, input) {
        return {
          delegation: {
            id: "delegation-denied",
            space_id: input.space_id,
            group_id: input.group_id,
            parent_run_id: input.parent_run_id,
            child_run_id: null,
            request_message_id: null,
            requesting_agent_id: input.requesting_agent_id,
            target_agent_id: input.target_agent_id,
            requested_by_user_id: identity.userId,
            policy_decision_record_id: "policy-denied",
            status: "policy_denied",
            instruction: input.instruction,
            reason: input.reason ?? null,
            budget_json: input.budget_json ?? null,
            context_policy_json: input.context_policy_json ?? null,
            result_summary: null,
            tool_call_id: null,
            created_at: "2026-07-05T00:00:00.000Z",
            updated_at: "2026-07-05T00:00:00.000Z",
            completed_at: "2026-07-05T00:00:00.000Z",
          },
          child_run_id: null,
          policy_decision_record_id: "policy-denied",
        };
      },
    });

    const result = await materializer.materialize({
      run: run(),
      output_json: {
        delegations: [
          {
            target_agent_id: "agent-reader",
            instruction: "Summarize the evidence.",
          },
        ],
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({
      kind: "delegation",
      status: "warning",
      error_code: "delegation_policy_denied",
      metadata_json: {
        delegation_id: "delegation-denied",
        policy_decision_record_id: "policy-denied",
        service_event_written: true,
      },
    });
  });
});
