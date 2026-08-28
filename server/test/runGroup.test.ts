import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInputEnvelope } from "@rainver/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgAgentGroupRepository } from "../src/modules/agentGroups/repository.js";
import { contractRecord, createRunContractSnapshot } from "../src/modules/runs/contractSnapshot.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { isRetryableRunErrorCode } from "../src/modules/runs/retryPolicy.js";
import { type RunExchangeHandle, RunExchangeManager } from "../src/modules/runs/runExchange.js";
import { assembleRunInputEnvelope, logicalRunInput } from "../src/modules/runs/runInputEnvelope.js";
import { runToOut } from "../src/modules/runs/runReadModel.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("runContractSnapshot", () => {
  describe("Run contract snapshots", () => {
    it("resolves Space, Automation, Workflow, and Plan caps with a persisted source trace", () => {
      const snapshot = createRunContractSnapshot({
        source: { kind: "plan", id: "plan-1" },
        budget_sources: [
          { source: { kind: "space", id: "space-1" }, precedence: 10, max_cost: 25, max_runs: 20 },
          { source: { kind: "automation", id: "automation-1" }, precedence: 20, max_cost: 15, max_runs: 5 },
          { source: { kind: "workflow", id: "workflow-1" }, precedence: 20, max_cost: 10, max_runs: 8 },
          { source: { kind: "plan", id: "plan-1" }, max_cost: 1 },
        ],
      }, "2026-07-26T12:00:00.000Z");
      expect(snapshot.effective_budget).toMatchObject({ max_cost: 10, max_runs: 5 });
      expect(snapshot.budget_resolution.mode).toBe("explicit_precedence");
      expect(snapshot.budget_resolution.selected_source_by_dimension.max_cost).toEqual({
        kind: "workflow",
        id: "workflow-1",
      });
      expect(snapshot.budget_resolution.selected_source_by_dimension.max_runs).toEqual({
        kind: "automation",
        id: "automation-1",
      });
    });

    it("records explicit budget precedence and uses the strictest value on ties", () => {
      const snapshot = createRunContractSnapshot({
        source: { kind: "task", id: "task-1" },
        max_cost: 10,
        budget_precedence: 1,
        budget_sources: [
          { source: { kind: "workflow", id: "workflow-1" }, max_cost: 2, precedence: 2 },
          { source: { kind: "automation", id: "automation-1" }, max_cost: 3, precedence: 2 },
        ],
      }, "2026-07-11T00:00:00.000Z");

      expect(snapshot.max_cost).toBe(2);
      expect(snapshot.effective_budget.max_cost).toBe(2);
      expect(snapshot.budget_resolution.mode).toBe("explicit_precedence");
      expect(snapshot.budget_resolution.selected_source_by_dimension.max_cost).toEqual({
        kind: "workflow",
        id: "workflow-1",
      });
    });

    it("falls back to the strictest cap when no carrier declares precedence", () => {
      const snapshot = createRunContractSnapshot({
        source: { kind: "workflow", id: "workflow-1" },
        budget_sources: [
          { source: { kind: "task", id: "task-1" }, max_runs: 3, max_duration_seconds: 120 },
          { source: { kind: "automation", id: "automation-1" }, max_runs: 1, max_duration_seconds: 60 },
        ],
      }, "2026-07-11T00:00:00.000Z");

      expect(snapshot.max_runs).toBe(1);
      expect(snapshot.max_duration_seconds).toBe(60);
      expect(snapshot.budget_resolution.mode).toBe("strictest_of_all");
    });

    it("deep-copies source criteria so the persisted snapshot is immutable in memory", () => {
      const acceptance = { checks: [{ command: "npm test" }] };
      const snapshot = createRunContractSnapshot(
        {
          source: { kind: "task", id: "task-1" },
          project_id: "project-1",
          project_folder_id: "workspace-1",
          acceptance_criteria_json: acceptance,
          definition_of_done: "Tests pass",
          required_outputs_json: { artifact_types: ["report.v1"] },
          risk_level: "high",
          max_runs: 2,
          max_attempts: 3,
          max_cost: 1.5,
          max_duration_seconds: 90,
          route_hints_json: { preferred_runtime: "codex_cli" },
        },
        "2026-07-11T00:00:00.000Z",
      );

      acceptance.checks[0]!.command = "changed after creation";
      expect(snapshot).toMatchObject({
        contract_version: "run_contract.v1",
        source: { kind: "task", id: "task-1" },
        project_id: "project-1",
        risk_level: "high",
        max_runs: 2,
        max_attempts: 3,
        max_cost: 1.5,
        max_duration_seconds: 90,
      });
      expect(snapshot.acceptance_criteria_json).toEqual({ checks: [{ command: "npm test" }] });
    });

    it("exposes the contract through the run API mapper", () => {
      const run: RunRecord = {
        id: "run-1",
        space_id: "space-1",
        agent_id: "agent-1",
        agent_version_id: "version-1",
        status: "queued",
        mode: "live",
        prompt: "prompt",
        instruction: "private instruction",
        project_folder_id: null,
        session_id: null,
        project_id: "project-1",
        contract_snapshot_json: {
          contract_version: "run_contract.v1",
          source: { kind: "automation", id: "automation-1" },
          project_id: "project-1",
        },
        workflow_version_id: "workflow-version-1",
        adapter_type: "model_api",
        model_provider_id: null,
        required_sandbox_level: "none",
        trigger_origin: "automation",
        started_at: null,
        ended_at: null,
      };

      expect(runToOut(run).contract_snapshot_json).toEqual(run.contract_snapshot_json);
      expect(runToOut(run).workflow_version_id).toBe("workflow-version-1");
      expect(runToOut(run)).toMatchObject({ prompt: null, instruction: null });
      expect(contractRecord(run.contract_snapshot_json).source).toEqual({
        kind: "automation",
        id: "automation-1",
      });
    });
  });
});

describe("runDelegationIdempotencyDb", () => {
  // Real-Postgres coverage for the run_delegations idempotency guarantee added
  // for the Runtime I/O Convergence "Governed CLI tools" requirement: a
  // reconnect or retry of agent.delegate with the same tool_call_id must not
  // duplicate the durable delegation/child-run side effect. This exercises the
  // actual partial UNIQUE INDEX (uq_run_delegations_parent_tool_call), which a
  // FakeDb unit test cannot verify.


  const SPACE = "space-1";
  const USER = "user-1";
  const MANAGER_AGENT = "agent-manager";
  const TARGET_AGENT = "agent-target";
  const GROUP = "group-1";
  let parentRunId = "";

  const db = useTestDatabase(`${import.meta.filename}#runDelegationIdempotencyDb`, { max: 10 });

  beforeEach(async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await resetTables(
      db.pool,
      ["run_delegations", "agent_run_groups", "runs", "agent_versions", "agents", "space_memberships", "spaces", "users"],
      { cascade: true },
    );
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'User', 'active', $2, $2)`,
      [USER, now],
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, 'Space', 'team', $2, $3, $3)`,
      [SPACE, USER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, USER, now],
    );
    let managerVersionId = "";
    for (const agentId of [MANAGER_AGENT, TARGET_AGENT]) {
      await db.pool.query(
        `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
         VALUES ($1,$2,$3,'Agent','active',NULL,$4,$4,'space_shared')`,
        [agentId, SPACE, USER, now],
      );
      const versionId = randomUUID();
      await db.pool.query(
        `INSERT INTO agent_versions (
           id, agent_id, space_id, version_label, system_prompt, model_config_json,
           runtime_config_json, context_policy_json, memory_policy_json,
           capabilities_json, tool_permissions_json, runtime_policy_json, created_at
         ) VALUES ($1,$2,$3,'v1','You are a test agent.','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
           '{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
        [versionId, agentId, SPACE, now],
      );
      await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [agentId, versionId]);
      if (agentId === MANAGER_AGENT) managerVersionId = versionId;
    }
    parentRunId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, adapter_type, required_sandbox_level, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'agent','manual','running','live','model_api','none',$5,$5)`,
      [parentRunId, SPACE, MANAGER_AGENT, managerVersionId, now],
    );
    await db.pool.query(
      `INSERT INTO agent_run_groups (id, space_id, root_run_id, manager_user_id, title, goal, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Room','Coordinate',$5,$6,$6)`,
      [GROUP, SPACE, parentRunId, USER, "active", now],
    );
  });

  describe("run_delegations tool_call_id idempotency", () => {
    it("returns the existing delegation for a repeated tool_call_id instead of inserting a duplicate row", async (ctx) => {
      if (!db.available || !db.pool) return ctx.skip();
      const repo = new PgAgentGroupRepository(db.pool);
      const first = await repo.createDelegation({
        space_id: SPACE,
        group_id: GROUP,
        parent_run_id: parentRunId,
        requesting_agent_id: MANAGER_AGENT,
        target_agent_id: TARGET_AGENT,
        instruction: "Summarize the packet.",
        tool_call_id: "call-1",
      });

      const found = await repo.findDelegationByToolCallId(SPACE, parentRunId, "call-1");
      expect(found?.id).toBe(first.id);

      await expect(
        repo.createDelegation({
          space_id: SPACE,
          group_id: GROUP,
          parent_run_id: parentRunId,
          requesting_agent_id: MANAGER_AGENT,
          target_agent_id: TARGET_AGENT,
          instruction: "Summarize the packet.",
          tool_call_id: "call-1",
        }),
      ).rejects.toThrow();

      const rows = await db.pool.query(
        `SELECT id FROM run_delegations WHERE space_id = $1 AND parent_run_id = $2 AND tool_call_id = $3`,
        [SPACE, parentRunId, "call-1"],
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("allows multiple delegations with no tool_call_id (partial index only applies when it is set)", async (ctx) => {
      if (!db.available || !db.pool) return ctx.skip();
      const repo = new PgAgentGroupRepository(db.pool);
      const first = await repo.createDelegation({
        space_id: SPACE,
        group_id: GROUP,
        parent_run_id: parentRunId,
        requesting_agent_id: MANAGER_AGENT,
        target_agent_id: TARGET_AGENT,
        instruction: "First manual delegation.",
        tool_call_id: null,
      });
      const second = await repo.createDelegation({
        space_id: SPACE,
        group_id: GROUP,
        parent_run_id: parentRunId,
        requesting_agent_id: MANAGER_AGENT,
        target_agent_id: TARGET_AGENT,
        instruction: "Second manual delegation.",
        tool_call_id: null,
      });
      expect(first.id).not.toBe(second.id);
    });
  });
});

describe("runExchange", () => {
  const roots: string[] = [];
  const exchanges: Array<{ manager: RunExchangeManager; handle: RunExchangeHandle }> = [];

  afterEach(async () => {
    await Promise.all(exchanges.splice(0).map(({ manager, handle }) => manager.cleanup(handle).catch(() => {})));
    const { rm } = await import("node:fs/promises");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  function input(): RunInputEnvelope {
    return {
      schema_version: "run_input.v1",
      run_id: "run-1",
      space_id: "space-1",
      instruction: null,
      task_goal: "Produce outputs",
      messages: [],
      inputs: { direct: null, workflow: null, upstream: null },
      attachments: [],
      project_folder_access: null,
      output_contract: {
        schema_version: "run_output_contract.v1",
        structured_output: null,
        required_outputs: [
          {
            name: "report",
            path: "nested/report.json",
            required: true,
            max_bytes: 1024,
            json_schema: {
              type: "object",
              required: ["answer"],
              properties: { answer: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
      },
      tool_grants: [],
      execution: {
        shape: "agentic_files",
        risk_level: "low",
        required_sandbox_level: "worktree",
        policy_ref: "run_permission_snapshot:run-1",
        budget_ref: "run_contract:run-1",
      },
    };
  }

  async function fixture(): Promise<{ root: string; manager: RunExchangeManager; handle: RunExchangeHandle }> {
    const root = await mkdtemp(join(tmpdir(), "run-exchange-test-"));
    roots.push(root);
    const manager = new RunExchangeManager(root);
    const handle = await manager.prepare("space-1", "run-1", input());
    exchanges.push({ manager, handle });
    return { root, manager, handle };
  }

  describe("Run Exchange lifecycle", () => {
    it("keeps the Exchange outside working trees and collects declared and candidate outputs", async () => {
      const { root, manager, handle } = await fixture();
      expect(handle.root).toBe(join(root, "exchange", "space-1", "run-1"));
      expect(await readFile(handle.input_manifest_path, "utf8")).toContain('"schema_version": "run_input.v1"');

      await mkdir(join(handle.output_dir, "nested"), { recursive: true });
      await writeFile(join(handle.output_dir, "nested", "report.json"), JSON.stringify({ answer: "ok" }));
      await writeFile(join(handle.output_dir, "notes.md"), "# Candidate\n");
      const collection = await manager.collect(handle, input().output_contract.required_outputs);

      expect(collection.errors).toEqual([]);
      expect(collection.manifest).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "report", status: "valid" }),
        expect.objectContaining({ name: "notes.md", status: "undeclared" }),
      ]));
      expect(collection.artifact_paths).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "nested/report.json", declared: true }),
        expect.objectContaining({ path: "notes.md", declared: false }),
      ]));
    });

    it("fails required missing, invalid, oversized, and modified-input cases", async () => {
      const missing = await fixture();
      expect((await missing.manager.collect(
        missing.handle,
        input().output_contract.required_outputs,
      )).errors[0]).toMatch(/missing/);

      const invalid = await fixture();
      await mkdir(join(invalid.handle.output_dir, "nested"), { recursive: true });
      await writeFile(join(invalid.handle.output_dir, "nested", "report.json"), JSON.stringify({ wrong: true }));
      expect((await invalid.manager.collect(
        invalid.handle,
        input().output_contract.required_outputs,
      )).manifest[0]?.status).toBe("invalid");

      const oversized = await fixture();
      await mkdir(join(oversized.handle.output_dir, "nested"), { recursive: true });
      await writeFile(join(oversized.handle.output_dir, "nested", "report.json"), "x".repeat(1025));
      expect((await oversized.manager.collect(
        oversized.handle,
        input().output_contract.required_outputs,
      )).manifest[0]?.status).toBe("oversized");

      const modified = await fixture();
      await chmod(modified.handle.input_manifest_path, 0o600);
      await writeFile(modified.handle.input_manifest_path, "{}\n");
      expect((await modified.manager.collect(modified.handle, [])).errors[0]).toMatch(/modified/);
    });

    it("does not follow output symlinks and removes raw Exchange state", async () => {
      const { manager, handle } = await fixture();
      await mkdir(join(handle.output_dir, "nested"), { recursive: true });
      await symlink("/etc/passwd", join(handle.output_dir, "nested", "report.json"));
      const collection = await manager.collect(handle, input().output_contract.required_outputs);
      expect(collection.manifest[0]?.status).toBe("invalid");
      expect(collection.artifact_paths).toEqual([]);

      await manager.cleanup(handle);
      await expect(readFile(handle.input_manifest_path, "utf8")).rejects.toThrow();
    });

    it("collects an explicit semantic outcome from a validated Room capture", async () => {
      const { manager, handle } = await fixture();
      const declaration = {
        name: "conversation_capture",
        path: "conversation_capture.json",
        required: true,
        json_schema: {
          type: "object",
          required: ["status", "proposed_changes"],
          properties: {
            status: { type: "string", enum: ["succeeded", "rejected"] },
            proposed_changes: { type: "array", items: { type: "object" } },
            rejection_reason: { type: "string" },
          },
          additionalProperties: false,
        },
      };
      await writeFile(
        join(handle.output_dir, declaration.path),
        JSON.stringify({
          status: "rejected",
          proposed_changes: [],
          rejection_reason: "The requested evidence is unavailable.",
        }),
      );

      const collection = await manager.collect(handle, [declaration]);

      expect(collection.errors).toEqual([]);
      expect(collection.reported_status).toBe("rejected");
      expect(collection.manifest[0]).toMatchObject({
        name: "conversation_capture",
        status: "valid",
      });
    });
  });
});

describe("runInputEnvelope", () => {
  function run(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      id: "run-1",
      space_id: "space-1",
      agent_id: "agent-1",
      agent_version_id: "agent-version-1",
      status: "queued",
      mode: "live",
      prompt: "Produce the report",
      instruction: "Use the supplied evidence",
      project_folder_id: "folder-1",
      project_id: "project-1",
      session_id: null,
      adapter_type: "opencode",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      trigger_origin: "workflow",
      started_at: null,
      ended_at: null,
      contract_snapshot_json: {
        contract_version: "run_contract.v1",
        workflow_input_json: { question: "What changed?" },
        upstream_inputs_json: {
          evidence: [{ source_run_id: "run-0", value: { count: 2 } }],
        },
        attachment_manifest_json: [
          {
            kind: "artifact",
            ref_id: "artifact-1",
            purpose: "evidence",
            locator: "artifact:artifact-1",
          },
        ],
        required_outputs_json: [
          {
            name: "report",
            path: "report.json",
            required: true,
            max_bytes: 4096,
            schema: { type: "object" },
          },
        ],
        structured_output_json: {
          type: "json_schema",
          schema_id: "report.v1",
          schema: { type: "object" },
        },
        risk_level: "medium",
        route_hints_json: { execution_shape: "agentic_files" },
      },
      model_override_json: {
        messages: [{ role: "user", content: "Continue from the prior turn" }],
      },
      permission_snapshot_json: {
        tool_grants: [
          {
            action_id: "artifact.create",
            capability_id: "reporting",
            approval_behavior: "none",
            side_effecting: true,
          },
        ],
      },
      ...overrides,
    };
  }

  describe("run_input.v1 assembly", () => {
    it("projects immutable Run authorities without physical Folder paths", () => {
      const input = assembleRunInputEnvelope(run());

      expect(input).toMatchObject({
        schema_version: "run_input.v1",
        run_id: "run-1",
        messages: [{ role: "user", content: "Continue from the prior turn" }],
        project_folder_access: {
          project_folder_id: "folder-1",
          access: "read_write",
          mount_point: "working",
        },
        execution: {
          shape: "agentic_files",
          risk_level: "medium",
        },
      });
      expect(input.attachments).toHaveLength(1);
      expect(input.output_contract.required_outputs[0]?.path).toBe("report.json");
      expect(JSON.stringify(input)).not.toContain("/home/");
    });

    it("fails closed when a contract attempts to carry secret-shaped input", () => {
      expect(() =>
        assembleRunInputEnvelope(run({
          contract_snapshot_json: {
            workflow_input_json: { nested: { access_token: "secret" } },
          },
        })),
      ).toThrow(/forbids secret/i);
    });

    it("coerces null-content messages instead of silently dropping them, matching the Managed API adapter's own message parsing", () => {
      const input = assembleRunInputEnvelope(run({
        model_override_json: {
          messages: [
            { role: "user", content: "Continue from the prior turn" },
            { role: "assistant", content: null, tool_calls: [{ id: "call-1", name: "search" }] },
          ],
        },
      }));
      expect(input.messages).toEqual([
        { role: "user", content: "Continue from the prior turn" },
        { role: "assistant", content: "" },
      ]);
    });

    it("drops the whole message list when any entry has a non-string, non-null content shape", () => {
      const input = assembleRunInputEnvelope(run({
        model_override_json: { messages: [{ role: "user", content: { weird: true } }] },
      }));
      expect(input.messages).toEqual([]);
    });
  });

  describe("logicalRunInput", () => {
    it("strips the raw attachment locator from the Run Detail display projection without changing the rest of the envelope", () => {
      const input = assembleRunInputEnvelope(run());
      const logical = logicalRunInput(input);

      expect(logical.attachments).toHaveLength(1);
      expect(logical.attachments[0]).not.toHaveProperty("locator");
      expect(logical.attachments[0]).toMatchObject({ kind: "artifact", ref_id: "artifact-1", purpose: "evidence" });
      expect(logical.messages).toEqual(input.messages);
      expect(logical.instruction).toBe(input.instruction);
    });
  });
});

describe("runRetryPolicy", () => {
  describe("run retry policy", () => {
    it("keeps transient provider failures retryable without retrying permanent errors", () => {
      expect(isRetryableRunErrorCode("provider_network_error")).toBe(true);
      // A stream torn off after the provider answered 200 is transport, not a
      // verdict: the Supervisor's bounded retry has to be allowed to try again.
      expect(isRetryableRunErrorCode("provider_stream_terminated")).toBe(true);
      expect(isRetryableRunErrorCode("provider_rate_limit")).toBe(true);
      expect(isRetryableRunErrorCode("invalid_request")).toBe(false);
    });

    it("treats a remote run's timeout and stall the same as the server host's", () => {
      // These two are the remote path's twins of cli_adapter_timeout and
      // cli_stall_timeout. Only the local pair was listed, so an identical
      // failure was retried automatically on the server host and sent straight
      // to human review on a paired one.
      expect(isRetryableRunErrorCode("cli_adapter_timeout")).toBe(true);
      expect(isRetryableRunErrorCode("cli_stall_timeout")).toBe(true);
      expect(isRetryableRunErrorCode("runtime_timeout")).toBe(true);
      expect(isRetryableRunErrorCode("runtime_stall_timeout")).toBe(true);
      // A runtime that ran and exited non-zero reached a verdict; retrying it
      // repeats the same work for the same answer.
      expect(isRetryableRunErrorCode("runtime_nonzero_exit")).toBe(false);
    });
  });
});
