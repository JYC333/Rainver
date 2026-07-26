import { z } from "zod";
import type { PolicyActionId } from "./policy.js";

export const SYSTEM_ACTION_VISIBILITY_VALUES = [
  "internal_only",
  "agent_tool",
  "public_api",
  "external_mcp",
  "system_job",
] as const;
export type SystemActionVisibility = (typeof SYSTEM_ACTION_VISIBILITY_VALUES)[number];

export const SYSTEM_ACTION_ACTOR_VALUES = ["user", "agent", "system", "automation"] as const;
export type SystemActionActorType = (typeof SYSTEM_ACTION_ACTOR_VALUES)[number];

export const SYSTEM_ACTION_SIDE_EFFECT_VALUES = ["none", "draft", "proposal", "durable"] as const;
export type SystemActionSideEffects = (typeof SYSTEM_ACTION_SIDE_EFFECT_VALUES)[number];

export const SystemActionVisibilitySchema = z.enum(SYSTEM_ACTION_VISIBILITY_VALUES);
export const SystemActionActorTypeSchema = z.enum(SYSTEM_ACTION_ACTOR_VALUES);
export const SystemActionSideEffectsSchema = z.enum(SYSTEM_ACTION_SIDE_EFFECT_VALUES);
const ZodSchemaValue = z.custom<z.ZodType>(
  (value) => typeof (value as { safeParse?: unknown } | null)?.safeParse === "function",
  "Expected a Zod schema",
);

export const SystemActionDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/),
  version: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  visibility: z.set(SystemActionVisibilitySchema).min(1),
  allowed_actor_types: z.array(SystemActionActorTypeSchema).min(1),
  input_schema: ZodSchemaValue,
  output_schema: ZodSchemaValue,
  owning_module: z.string().min(1),
  application_service: z.string().min(1),
  policy_action: z.string().min(1),
  side_effects: SystemActionSideEffectsSchema,
  idempotency_required: z.boolean(),
  proposal_type: z.string().min(1).nullable(),
  grantable: z.boolean(),
}).strict();

export interface SystemActionDefinition {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly visibility: ReadonlySet<SystemActionVisibility>;
  readonly allowed_actor_types: readonly SystemActionActorType[];
  readonly input_schema: z.ZodType;
  readonly output_schema: z.ZodType;
  readonly owning_module: string;
  readonly application_service: string;
  readonly policy_action: PolicyActionId;
  readonly side_effects: SystemActionSideEffects;
  readonly idempotency_required: boolean;
  readonly proposal_type: string | null;
  readonly grantable: boolean;
}

const objectInput = z.record(z.string(), z.unknown());
const objectOutput = z.record(z.string(), z.unknown());
const proposalOutput = z.object({ modelResult: z.record(z.string(), z.unknown()), summary: z.record(z.string(), z.unknown()) }).passthrough();
const proposalInputs:Record<string,z.ZodType>={
  "authorization.request": z.object({
    policy_decision_record_id: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
  }).strict(),
  "task.plan.propose": z.object({
    task_id: z.string().min(1),
    plan_id: z.string().min(1).nullable().optional(),
    definition_json: z.record(z.string(), z.unknown()),
    reference_workflow_version_id: z.string().min(1).nullable().optional(),
    budget_cap: z.number().finite().nonnegative().nullable().optional(),
    budget_sources: z.array(z.record(z.string(), z.unknown())).optional(),
    planner_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  }).strict(),
  "source.channel.propose_activation":z.object({source_channel_id:z.string().min(1)}).passthrough(),
  "project.source.propose_bind":z.object({source_channel_id:z.string().min(1)}).passthrough(),
  "source.backfill.propose_start":z.object({source_channel_id:z.string().min(1),source_backfill_plan_id:z.string().min(1)}).passthrough(),
};
const visibility = (...values: SystemActionVisibility[]) => new Set(values);

export const SYSTEM_ACTION_REGISTRY = [
  agentAction("authorization.request", "Request authorization for a denied action", "policy", "AuthorizationRequestService.createFromDeniedDecision", "authorization.request.create", "durable"),
  action("retrieval.search", "Search knowledge", "retrieval", "RetrievalToolService.search", "retrieval.search"),
  action("retrieval.brief", "Build knowledge brief", "retrieval", "RetrievalToolService.brief", "retrieval.brief"),
  action("memory.retrieval.search", "Search memory", "memory", "RetrievalToolService.search", "memory.retrieval.search"),
  action("memory.retrieval.brief", "Build memory brief", "memory", "RetrievalToolService.brief", "memory.retrieval.brief"),
  action("project.summary.search", "Search project summaries", "projects", "RetrievalToolService.search", "project.summary.search"),
  action("project.summary.brief", "Build project summary brief", "projects", "RetrievalToolService.brief", "project.summary.brief"),
  action("source.retrieval.search", "Search source material", "sources", "RetrievalToolService.search", "source.retrieval.search"),
  action("source.retrieval.brief", "Build source brief", "sources", "RetrievalToolService.brief", "source.retrieval.brief"),
  action("agent.delegate", "Delegate to an agent", "agent_groups", "AgentGroupRunService.spawnChildRun", "run.spawn_child", "durable"),
  action("agent.wait_for_results", "Wait for agent results", "agent_groups", "AgentGroupRunService.waitForResults", "runtime.execute"),
  httpAction("source.recipe.plan", "Plan a Source recipe", "sources", "SourceRecipeService.planSource", "source.recipe.create", "none"),
  httpAction("source.recipe.create", "Create a Source recipe draft", "sources", "SourceRecipeService.createSource", "source.recipe.create", "draft"),
  httpAction("source.recipe.dry_run", "Dry-run a Source recipe", "sources", "SourceRecipeService.dryRunRecipeVersion", "source.recipe.dry_run", "none"),
  httpAction("source.recipe.activate", "Activate a Source recipe", "sources", "SourceRecipeService.activateRecipe", "source.recipe.activate", "durable"),
  httpAction("project.source.bind", "Bind a Source to a Project", "projects", "ProjectSourceBindingService.createBinding", "project.source.bind", "durable"),
  httpAction("policy.action_grant.create", "Create an action approval grant", "policy", "ActionApprovalGrantService.create", "policy.action_grant.create", "durable"),
  httpAction("policy.action_grant.revoke", "Revoke an action approval grant", "policy", "ActionApprovalGrantService.revoke", "policy.action_grant.revoke", "durable"),
  proposalAction("source.channel.propose_activation", "Propose Source Channel activation", "sources", "SourceChannelService.proposeActivation", "source.connection.manage", "source_channel_activation"),
  proposalAction("project.source.propose_bind", "Propose binding a Source to a Project", "projects", "ProjectSourceBindingService.proposeBind", "project.source.bind", "project_source_bind"),
  httpAction("project.operation.read", "Read Project operation progress", "projects", "ProjectOperationService.get", "project.operation.manage", "none"),
  httpAction("project.operation.create", "Create a Project operation", "projects", "ProjectOperationService.create", "project.operation.manage", "durable"),
  httpAction("project.operation.cancel", "Cancel a Project operation", "projects", "ProjectOperationService.cancel", "project.operation.manage", "durable"),
  httpAction("source.backfill.preview", "Preview Source history import", "sources", "SourceBackfillPlanningService.preview", "source.backfill.plan", "none"),
  httpAction("source.backfill.create_plan", "Create Source history import plan", "sources", "SourceBackfillPlanningService.create", "source.backfill.plan", "draft"),
  proposalAction("source.backfill.propose_start", "Propose Source history import", "sources", "SourceBackfillPlanningService.proposeStart", "source.backfill.plan", "source_backfill_start"),
  agentAction("task.plan.propose", "Propose an Agent-generated Task plan", "plans", "PgPlanRepository.createPlanFromAgent", "task.plan.propose", "durable"),
  internalAction("source.backfill.start", "Start approved Source history import", "sources", "SourceBackfillExecutionService.start", "source.backfill.start"),
  httpAction("source.backfill.pause", "Pause Source history import", "sources", "SourceBackfillPlanningService.setPaused", "source.backfill.manage", "durable"),
  httpAction("source.backfill.resume", "Resume Source history import", "sources", "SourceBackfillPlanningService.setPaused", "source.backfill.manage", "durable"),
] as const satisfies readonly SystemActionDefinition[];

export type SystemActionId = (typeof SYSTEM_ACTION_REGISTRY)[number]["id"];

function action<const Id extends string>(
  id: Id,
  title: string,
  owningModule: string,
  applicationService: string,
  policyAction: PolicyActionId,
  sideEffects: SystemActionSideEffects = "none",
): SystemActionDefinition & { readonly id: Id } {
  return {
    id,
    version: 1,
    title,
    description: title,
    visibility: visibility("agent_tool"),
    allowed_actor_types: ["agent"],
    input_schema: objectInput,
    output_schema: objectOutput,
    owning_module: owningModule,
    application_service: applicationService,
    policy_action: policyAction,
    side_effects: sideEffects,
    idempotency_required: sideEffects !== "none",
    proposal_type: sideEffects === "proposal" ? "agent_delegation" : null,
    grantable: sideEffects === "proposal",
  };
}

function httpAction<const Id extends string>(
  id: Id,
  title: string,
  owningModule: string,
  applicationService: string,
  policyAction: PolicyActionId,
  sideEffects: SystemActionSideEffects,
  agentVisible = false,
): SystemActionDefinition & { readonly id: Id } {
  return {
    id,
    version: 1,
    title,
    description: title,
    visibility: visibility("public_api", ...(agentVisible ? ["agent_tool" as const] : [])),
    allowed_actor_types: agentVisible ? ["user", "agent"] : ["user"],
    input_schema: objectInput,
    output_schema: objectOutput,
    owning_module: owningModule,
    application_service: applicationService,
    policy_action: policyAction,
    side_effects: sideEffects,
    idempotency_required: sideEffects !== "none",
    proposal_type: null,
    grantable: false,
  };
}

function proposalAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, proposalType: string): SystemActionDefinition & { readonly id: Id } {
  return { id, version: 1, title, description: title, visibility: visibility("agent_tool", "public_api"),
    allowed_actor_types: ["user", "agent"], input_schema: proposalInputs[id]??objectInput, output_schema: proposalOutput,
    owning_module: owningModule, application_service: applicationService, policy_action: policyAction,
    side_effects: "proposal", idempotency_required: true, proposal_type: proposalType, grantable: true };
}

function agentAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, sideEffects: SystemActionSideEffects): SystemActionDefinition & { readonly id: Id } {
  return { id, version: 1, title, description: title, visibility: visibility("agent_tool"), allowed_actor_types: ["agent"],
    input_schema: proposalInputs[id] ?? objectInput, output_schema: proposalOutput, owning_module: owningModule,
    application_service: applicationService, policy_action: policyAction, side_effects: sideEffects,
    idempotency_required: true, proposal_type: null, grantable: false };
}

function internalAction<const Id extends string>(id:Id,title:string,owningModule:string,applicationService:string,policyAction:PolicyActionId):SystemActionDefinition&{readonly id:Id}{
  return{id,version:1,title,description:title,visibility:visibility("internal_only","system_job"),allowed_actor_types:["user","system"],input_schema:objectInput,output_schema:objectOutput,owning_module:owningModule,application_service:applicationService,policy_action:policyAction,side_effects:"durable",idempotency_required:true,proposal_type:null,grantable:false};
}
