import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  CliAgentToolTransport,
  CliRunToolIdentityRegistry,
} from "../src/modules/runs/cliToolTransport";
import type { RunRecord } from "../src/modules/runs/repository";
import type { RetrievalToolService } from "../src/modules/retrieval/tool/service";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-cli-1",
    space_id: "space-1",
    agent_id: "agent-cli",
    agent_version_id: "version-cli",
    runtime_profile_id: "profile-cli",
    run_type: "agent",
    status: "running",
    mode: "live",
    prompt: "Ask a reviewer.",
    instruction: "Coordinate review work.",
    project_folder_id: null,
    session_id: null,
    parent_run_id: "run-root",
    root_run_id: "run-root",
    run_group_id: "group-1",
    delegation_id: null,
    project_id: null,
    scheduled_at: null,
    adapter_type: "codex_cli",
    capability_id: null,
    capabilities_json: [],
    model_provider_id: "provider-1",
    model_override_json: null,
    runtime_profile_snapshot_json: {},
    required_sandbox_level: "worktree",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    instructed_by_agent_id: null,
    error_message: null,
    error_json: null,
    output_json: null,
    started_at: "2026-08-23T00:00:00.000Z",
    ended_at: null,
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    visibility: "space_shared",
    ...overrides,
  } as RunRecord;
}

describe("CLI Run tool identity", () => {
  it("is short-lived, Run-scoped, cross-space opaque, and revocable", () => {
    const registry = new CliRunToolIdentityRegistry();
    const token = registry.issue({ id: "run-1", space_id: "space-1" }, 60_000);
    expect(registry.resolve(token, "run-1")).toMatchObject({
      run_id: "run-1",
      space_id: "space-1",
    });
    expect(registry.resolve(token, "run-2")).toBeNull();
    expect(registry.resolve(token, "run-1")).toMatchObject({ run_id: "run-1" });

    const revoked = registry.issue({ id: "run-1", space_id: "space-1" }, 60_000);
    registry.revoke(revoked);
    expect(registry.resolve(revoked, "run-1")).toBeNull();
  });

  it("rejects expired identities", () => {
    const registry = new CliRunToolIdentityRegistry();
    const token = registry.issue({ id: "run-1", space_id: "space-1" }, 1);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(registry.resolve(token, "run-1")).toBeNull();
        resolve();
      }, 5);
    });
  });
});

describe("CliAgentToolTransport", () => {
  // No database URL: with no SERVER_DATABASE_URL configured,
  // resolveRetrievalToolBinding skips the space-settings read instead of
  // attempting a real connection, and no generic proposal executor gets
  // registered (none of this run's grants are generic registry-surface
  // actions) — so dispatch never touches Postgres.
  const config = loadConfig({});

  function delegationDeps(spawnCalls: unknown[]) {
    return {
      agentDelegationTools: {
        targets: [
          { agent_id: "agent-reviewer", name: "Reviewer", role: "worker", capabilities_json: { capabilities: ["code_review"] } },
        ],
        service: {
          async preflightSpawnChildRunPolicy() {
            return { status: "allow" as const, policy_decision_record_id: "policy-delegate-1" };
          },
          async spawnChildRun(identity: unknown, input: { target_agent_id: string }) {
            spawnCalls.push({ identity, input });
            return {
              delegation: {
                id: "delegation-1",
                space_id: "space-1",
                group_id: "group-1",
                parent_run_id: "run-cli-1",
                child_run_id: "run-child-1",
                request_message_id: null,
                requesting_agent_id: "agent-cli",
                target_agent_id: input.target_agent_id,
                requested_by_user_id: "user-1",
                policy_decision_record_id: "policy-delegate-1",
                status: "queued",
                instruction: "Answer 1+1 independently.",
                reason: null,
                budget_json: null,
                context_policy_json: null,
                result_summary: null,
                tool_call_id: null,
                created_at: "2026-08-23T00:00:00.000Z",
                updated_at: "2026-08-23T00:00:00.000Z",
                completed_at: null,
              },
              child_run_id: "run-child-1",
              policy_decision_record_id: "policy-delegate-1",
            };
          },
        },
      },
    };
  }

  it("dispatches a granted call to the same domain handler the managed loop reaches", async () => {
    const spawnCalls: unknown[] = [];
    const cliRun = run({
      permission_snapshot_json: { tool_grants: [{ action_id: "agent.delegate" }] },
    } as Partial<RunRecord>);
    const transport = new CliAgentToolTransport(config, delegationDeps(spawnCalls));

    const result = await transport.call(cliRun, {
      id: "tool-call-1",
      name: "agent.delegate",
      arguments: { target_agent_id: "agent-reviewer", instruction: "Answer 1+1 independently." },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      identity: { spaceId: "space-1", userId: "user-1" },
      input: { target_agent_id: "agent-reviewer", parent_run_id: "run-cli-1", root_run_id: "run-root" },
    });
    expect(result).toMatchObject({ ok: true, target_agent_id: "agent-reviewer", child_run_id: "run-child-1" });
  });

  it("refuses an ungranted call with the same code the managed path uses", async () => {
    const spawnCalls: unknown[] = [];
    const cliRun = run({
      permission_snapshot_json: { tool_grants: [] },
    } as Partial<RunRecord>);
    const transport = new CliAgentToolTransport(config, delegationDeps(spawnCalls));

    const result = await transport.call(cliRun, {
      id: "tool-call-1",
      name: "agent.delegate",
      arguments: { target_agent_id: "agent-reviewer", instruction: "Answer 1+1 independently." },
    });

    expect(spawnCalls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, tool: "agent.delegate", error_code: "system_action_not_granted" });
  });

  it("lists only granted, permitted definitions", async () => {
    const cliRun = run({
      permission_snapshot_json: { tool_grants: [{ action_id: "agent.delegate" }] },
    } as Partial<RunRecord>);
    const transport = new CliAgentToolTransport(config, delegationDeps([]));

    const definitions = await transport.list(cliRun);

    expect(definitions.map((tool) => tool.name)).toEqual(["agent.delegate"]);
  });

  it("excludes retrieval definitions from tools/list in a preflight retrieval mode, matching the managed loop", async () => {
    // In `preflight_search`/`preflight_brief` the system performs one governed
    // retrieval step itself instead of offering the tool for direct call
    // (`retrievalToolContribution`, managedRetrievalTools.ts). The managed loop
    // never puts the tool in `request.tools`; CLI's `tools/list` must agree.
    const retrievalToolService = {
      async toolBrief() {
        throw new Error("retrieval must not be invoked while listing tools");
      },
    } as unknown as RetrievalToolService;
    const cliRun = run({
      permission_snapshot_json: {
        tool_grants: [{ action_id: "retrieval.brief" }, { action_id: "agent.delegate" }],
      },
      runtime_config_json: { retrieval_tool_mode: "preflight_brief" },
    } as Partial<RunRecord>);
    const transport = new CliAgentToolTransport(config, {
      retrievalToolService,
      ...delegationDeps([]),
    });

    const definitions = await transport.list(cliRun);

    expect(definitions.map((tool) => tool.name)).toEqual(["agent.delegate"]);
  });
});
