import { describe, expect, it } from "vitest";
import {
  contractRecord,
  createRunContractSnapshot,
} from "../src/modules/runs/contractSnapshot";
import { workflowContractInput } from "../src/modules/capabilities/workflowContract";
import { workflowDefinitionFromTemplate } from "../src/modules/capabilities/workflowAssets";
import { getBuiltInWorkflowTemplate } from "../src/modules/capabilities/workflowRegistry";
import { loadProtocol } from "../src/modules/providers/protocolRuntime";
import { runToOut } from "../src/modules/runs/runReadModel";
import type { RunRecord } from "../src/modules/runs/repository";

describe("Run contract snapshots", () => {
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

  it("builds a workflow contract from the server-owned template", () => {
    const template = getBuiltInWorkflowTemplate("research.technical_survey");
    expect(template).not.toBeNull();
    const contract = workflowContractInput({
      template: template!,
      workflowVersionId: "workflow-version-1",
      config: { max_duration_seconds: 120, max_runs: 4, max_attempts: 2 },
      projectId: "project-1",
      projectFolderId: "workspace-1",
    });

    expect(contract).toMatchObject({
      source: { kind: "workflow", id: "workflow-version-1" },
      project_id: "project-1",
      project_folder_id: "workspace-1",
      required_outputs_json: {
        artifact_types: ["research_report.archive.v1"],
      },
      max_duration_seconds: 120,
      max_runs: 4,
      max_attempts: 2,
    });
    expect(contract.route_hints_json).toEqual({
      recommended_runtime_adapters: ["model_api", "claude_code", "codex_cli"],
      execution_shape: "structured_generation",
      required_capabilities: [],
      required_tools: [],
    });
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
      instruction: null,
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
    expect(contractRecord(run.contract_snapshot_json).source).toEqual({
      kind: "automation",
      id: "automation-1",
    });
  });

  it("produces a validated versioned definition with a dependency chain", async () => {
    const template = getBuiltInWorkflowTemplate("research.technical_survey");
    const definition = await workflowDefinitionFromTemplate(template!);
    const protocol = await loadProtocol();
    expect(protocol.WorkflowDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(definition.schema_version).toBe("workflow_definition.v1");
    expect(definition.nodes[0]!.depends_on).toEqual([]);
    expect(definition.nodes[1]!.depends_on).toEqual([definition.nodes[0]!.id]);
    expect(definition.nodes.at(-1)?.approval_checkpoint.required).toBe(true);
  });
});
