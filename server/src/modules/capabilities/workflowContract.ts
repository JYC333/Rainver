import type { RunContractSnapshotInput } from "../runs/contractSnapshot";
import type { WorkflowTemplate } from "./types";

export function workflowContractInput(input: {
  template: WorkflowTemplate;
  workflowVersionId?: string | null;
  config: Record<string, unknown>;
  projectId: string | null;
  projectFolderId: string | null;
}): RunContractSnapshotInput {
  const { template, config, projectId, projectFolderId } = input;
  return {
    source: { kind: "workflow", id: input.workflowVersionId ?? null },
    project_id: projectId,
    project_folder_id: projectFolderId,
    acceptance_criteria_json: config.acceptance_criteria_json ?? null,
    definition_of_done: typeof config.definition_of_done === "string" ? config.definition_of_done : null,
    required_outputs_json: config.required_outputs_json ?? {
      artifact_types: template.output_artifact_types,
    },
    risk_level: typeof config.risk_level === "string" ? config.risk_level : "low",
    max_runs: positiveIntegerOrNull(config.max_runs),
    max_attempts: positiveIntegerOrNull(config.max_attempts),
    max_cost: nonNegativeNumberOrNull(config.max_cost),
    max_duration_seconds: positiveIntegerOrNull(config.max_duration_seconds),
    budget_precedence: nonNegativeNumberOrNull(config.budget_precedence),
    route_hints_json: {
      recommended_runtime_adapters: template.recommended_runtime_adapters,
      execution_shape: template.execution_shape ?? "structured_generation",
      required_capabilities: template.required_capabilities ?? [],
      required_tools: template.required_tools ?? [],
    },
  };
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
