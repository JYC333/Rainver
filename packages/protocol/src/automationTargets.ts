import { z } from "zod";

export const AUTOMATION_TARGET_KIND_VALUES = [
  "domain_execution",
  "maintenance",
  "control_plane",
] as const;
export const AutomationTargetKindSchema = z.enum(AUTOMATION_TARGET_KIND_VALUES);

export const AUTOMATION_TARGET_SPAWNS_RUNS_VALUES = ["none", "one", "many"] as const;
export const AutomationTargetSpawnsRunsSchema = z.enum(AUTOMATION_TARGET_SPAWNS_RUNS_VALUES);

export const AutomationTargetDefinitionSchema = z
  .object({
    target_type: z.string().min(1),
    kind: AutomationTargetKindSchema,
    user_selectable: z.boolean(),
    spawns_runs: AutomationTargetSpawnsRunsSchema,
    requires_project_binding: z.boolean(),
    credential_grant_required: z.boolean(),
    current_enforcement_point: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export type AutomationTargetDefinition = z.infer<typeof AutomationTargetDefinitionSchema>;

export const AUTOMATION_TARGET_REGISTRY = [
  {
    target_type: "agent_run",
    kind: "domain_execution",
    user_selectable: true,
    spawns_runs: "one",
    requires_project_binding: false,
    credential_grant_required: true,
    current_enforcement_point: "server/src/modules/automations/targetHandlers.ts",
    description: "Launch one configured Agent Run through the normal Automation admission path.",
  },
  {
    target_type: "workflow",
    kind: "domain_execution",
    user_selectable: true,
    spawns_runs: "many",
    requires_project_binding: false,
    credential_grant_required: true,
    current_enforcement_point: "server/src/modules/automations/targetHandlers.ts",
    description: "Launch one approved Workflow Execution and its bounded node Runs.",
  },
  {
    target_type: "knowledge_retrieval_maintenance",
    kind: "maintenance",
    user_selectable: true,
    spawns_runs: "one",
    requires_project_binding: false,
    credential_grant_required: false,
    current_enforcement_point: "server/src/modules/retrieval/automationTarget.ts",
    description: "Run the Knowledge retrieval maintenance scan and persist its private report.",
  },
  {
    target_type: "context_ops_review_cycle",
    kind: "maintenance",
    user_selectable: true,
    spawns_runs: "one",
    requires_project_binding: false,
    credential_grant_required: false,
    current_enforcement_point: "server/src/modules/contextOps/automationTarget.ts",
    description: "Run the aggregate Context Ops review cycle and persist review artifacts.",
  },
  {
    target_type: "information_digest",
    kind: "maintenance",
    user_selectable: false,
    spawns_runs: "one",
    requires_project_binding: false,
    credential_grant_required: false,
    current_enforcement_point: "server/src/modules/informationDigest/automationTarget.ts",
    description: "Build one deterministic personal or Project cross-source daily digest.",
  },
  {
    target_type: "autonomous_tick",
    kind: "control_plane",
    user_selectable: false,
    spawns_runs: "many",
    requires_project_binding: false,
    credential_grant_required: true,
    current_enforcement_point: "server/src/modules/autonomy/automationTarget.ts",
    description: "Survey durable facts and fan out admitted autonomous work candidates.",
  },
] as const satisfies readonly AutomationTargetDefinition[];

export type AutomationTargetType = (typeof AUTOMATION_TARGET_REGISTRY)[number]["target_type"];

export const AUTOMATION_TARGET_TYPES = AUTOMATION_TARGET_REGISTRY.map(
  (definition) => definition.target_type,
) as readonly AutomationTargetType[];

export function automationTargetDefinition(
  targetType: string,
): AutomationTargetDefinition | null {
  return AUTOMATION_TARGET_REGISTRY.find(
    (definition) => definition.target_type === targetType,
  ) ?? null;
}
