import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { PolicyActionId } from "./policy.js";
import {
  AgentWaitForResultsInputSchema,
  RuntimeDelegationOutputItemSchema,
} from "./agentGroupRuns.js";

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

export const SYSTEM_ACTION_AGENT_TOOL_SURFACE_VALUES = [
  "generic",
  "retrieval",
  "delegation",
  "research",
] as const;
export type SystemActionAgentToolSurface = (typeof SYSTEM_ACTION_AGENT_TOOL_SURFACE_VALUES)[number];

export const SYSTEM_ACTION_POLICY_ADAPTER_VALUES = [
  "declared_resource",
  "retrieval",
  "agent_delegate",
] as const;
export type SystemActionPolicyAdapter = (typeof SYSTEM_ACTION_POLICY_ADAPTER_VALUES)[number];

export const SystemActionVisibilitySchema = z.enum(SYSTEM_ACTION_VISIBILITY_VALUES);
export const SystemActionActorTypeSchema = z.enum(SYSTEM_ACTION_ACTOR_VALUES);
export const SystemActionSideEffectsSchema = z.enum(SYSTEM_ACTION_SIDE_EFFECT_VALUES);
export const SystemActionAgentToolSurfaceSchema = z.enum(SYSTEM_ACTION_AGENT_TOOL_SURFACE_VALUES);
export const SystemActionPolicyAdapterSchema = z.enum(SYSTEM_ACTION_POLICY_ADAPTER_VALUES);
const ZodSchemaValue = z.custom<z.ZodType>(
  (value) => typeof (value as { safeParse?: unknown } | null)?.safeParse === "function",
  "Expected a Zod schema",
);

/**
 * Declarative resource resolution for the generic policy adapter (action
 * authority consolidation plan, D4). An action carrying this needs no
 * hand-written `if (definition.id === ...)` branch in
 * `enforcePolicyForAction`: the generic adapter reads `resource_type` (or
 * falls back to the action's own `owning_module`), reads `resource_id` from
 * the named input field when present (or falls back per
 * `resource_id_fallback`), and consults `ActionApprovalGrantService` only
 * when `check_action_approval_grant` is true.
 *
 * `agent.delegate` and the retrieval actions have no `policy_resource` —
 * their enforcement genuinely differs (group budget/lineage; domain
 * enablement) and they keep an explicit custom adapter instead.
 */
export const SystemActionPolicyResourceSchema = z.object({
  resource_type: z.string().min(1).optional(),
  resource_id_input_field: z.string().min(1).optional(),
  resource_id_fallback: z.enum(["run", "project_or_run"]),
  check_action_approval_grant: z.boolean(),
}).strict();

export interface SystemActionPolicyResource {
  /** Static resource_type. Omitted means "use the action's own owning_module". */
  readonly resource_type?: string;
  /** Input field supplying resource_id when the call's payload carries it. */
  readonly resource_id_input_field?: string;
  /** What resource_id falls back to with no input-derived value. */
  readonly resource_id_fallback: "run" | "project_or_run";
  /** Whether to consult ActionApprovalGrantService before enforcing policy. */
  readonly check_action_approval_grant: boolean;
}

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
  /**
   * Ontology object types this action operates on, when it operates on one.
   * Foundry's Action Types are always object-bound; a good half of this
   * registry is not — connection creation, backfill start,
   * `authorization.request` — so this is optional rather than required, and
   * its absence is meaningful rather than an omission.
   */
  applies_to: z.array(z.string().min(1)).optional(),
  policy_resource: SystemActionPolicyResourceSchema.optional(),
  agent_tool_surface: SystemActionAgentToolSurfaceSchema.optional(),
  policy_adapter: SystemActionPolicyAdapterSchema.optional(),
}).strict().superRefine((definition, context) => {
  if (!definition.visibility.has("agent_tool")) return;
  if (!definition.agent_tool_surface) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_tool_surface"], message: "Agent-visible actions must declare an agent tool surface." });
  }
  if (!definition.policy_adapter) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policy_adapter"], message: "Agent-visible actions must declare a policy adapter." });
  }
  if (definition.policy_adapter === "declared_resource" && !definition.policy_resource) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policy_resource"], message: "Declared-resource actions must declare policy_resource metadata." });
  }
  if (definition.policy_adapter && definition.policy_adapter !== "declared_resource" && definition.policy_resource) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policy_resource"], message: "Custom-adapter actions must not declare policy_resource metadata — the custom adapter would silently ignore it." });
  }
});

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
  /** Ontology object types this action operates on, when it operates on one. */
  readonly applies_to?: readonly string[];
  /** Declarative resource resolution for the generic policy adapter (D4). */
  readonly policy_resource?: SystemActionPolicyResource;
  /** Which managed Agent tool family contributes this action, if any. */
  readonly agent_tool_surface?: SystemActionAgentToolSurface;
  /** Which policy adapter enforces the action, if it is Agent-callable. */
  readonly policy_adapter?: SystemActionPolicyAdapter;
}

const objectInput = z.record(z.string(), z.unknown());
const objectOutput = z.record(z.string(), z.unknown());
const proposalOutput = z.object({ modelResult: z.record(z.string(), z.unknown()), summary: z.record(z.string(), z.unknown()) }).passthrough();
const proposalInputs:Record<string,z.ZodType>={
  "authorization.request": z.object({
    policy_decision_record_id: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
  }).passthrough(),
  "task.plan.propose": z.object({
    task_id: z.string().min(1),
    plan_id: z.string().min(1).nullable().optional(),
    definition_json: z.record(z.string(), z.unknown()),
    reference_workflow_version_id: z.string().min(1).nullable().optional(),
    budget_cap: z.number().finite().nonnegative().nullable().optional(),
    budget_sources: z.array(z.record(z.string(), z.unknown())).optional(),
    planner_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  }).passthrough(),
  // `SourceChannelService.proposeActivation` begins with `this.create(identity,
  // { ...body, status: "paused" })` — the body is Source Channel *creation*
  // parameters, not a reference to an already-existing channel. Only
  // `provider_key` is required (`requiredString`); `name`, `query`, and
  // `endpoint_url` all have service-side defaults.
  "source.channel.propose_activation": z.object({
    provider_key: z.string().min(1),
    name: z.string().min(1).optional(),
    query: z.record(z.string(), z.unknown()).nullable().optional(),
    endpoint_url: z.string().min(1).optional(),
  }).passthrough(),
  "project.source.propose_bind":z.object({source_channel_id:z.string().min(1)}).passthrough(),
  "source.backfill.propose_start":z.object({source_channel_id:z.string().min(1),source_backfill_plan_id:z.string().min(1)}).passthrough(),
  "project.propose_definition": z.object({
    goal: z.string().trim().min(1),
    scope_included: z.string().trim().min(1).optional(),
    scope_excluded: z.string().trim().min(1).optional(),
    success_definition: z.string().trim().min(1).optional(),
    constraints: z.string().trim().min(1).optional(),
    assumptions: z.string().trim().min(1).optional(),
  }).passthrough(),
  "inquiry.propose_thread": z.object({
    kind: z.enum(["question", "hypothesis"]).default("question"),
    statement: z.string().trim().min(1),
    answerability: z.string().trim().min(1).optional(),
    resolution_criteria: z.string().trim().min(1).optional(),
    proposed_claim: z.string().trim().min(1).optional(),
    predictions: z.string().trim().min(1).optional(),
    falsification_criteria: z.string().trim().min(1).optional(),
  }).passthrough(),
  "inquiry.record_conclusion": z.object({
    thread_id: z.string().min(1),
    change_summary: z.string().min(1),
    reasoning_summary: z.string().min(1).optional(),
    // Question-kind cognitive fields.
    answer_state: z.enum(["open", "partial", "answered", "unanswerable"]).optional(),
    current_answer_summary: z.string().optional(),
    known_gaps: z.string().optional(),
    answerability: z.string().optional(),
    // Hypothesis-kind cognitive fields.
    evaluation_state: z.enum(["untested", "supported", "challenged", "contradicted", "inconclusive"]).optional(),
    confidence: z.number().min(0).max(100).optional(),
    confidence_method: z.string().optional(),
    // Shared.
    unresolved_gaps: z.string().optional(),
    confirmed_next_focus: z.string().optional(),
    next_focus_note: z.string().optional(),
  }).passthrough(),
  "inquiry.promote_knowledge": z.object({
    thread_id: z.string().min(1),
    candidate_kind: z.enum(["concept", "lesson", "procedure", "decision", "summary"]),
    proposed_title: z.string().min(1),
    proposed_content: z.string().min(1),
    supersedes_knowledge_item_id: z.string().min(1).optional(),
  }).passthrough(),
  "research.start_acquisition": z.object({
    thread_id: z.string().min(1),
    intent_note: z.string().trim().min(1).max(2000).optional(),
  }).strict(),
};
const visibility = (...values: SystemActionVisibility[]) => new Set(values);

export const SYSTEM_ACTION_REGISTRY = [
  agentAction("authorization.request", "Request authorization for a denied action", "policy", "AuthorizationRequestService.createFromDeniedDecision", "authorization.request.create", "durable", { resource_type: "authorization_request", resource_id_fallback: "run", check_action_approval_grant: false }),
  action("retrieval.search", "Search knowledge", "retrieval", "RetrievalToolService.search", "retrieval.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("retrieval.brief", "Build knowledge brief", "retrieval", "RetrievalToolService.brief", "retrieval.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("memory.retrieval.search", "Search memory", "memory", "RetrievalToolService.search", "memory.retrieval.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("memory.retrieval.brief", "Build memory brief", "memory", "RetrievalToolService.brief", "memory.retrieval.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("project.summary.search", "Search project summaries", "projects", "RetrievalToolService.search", "project.summary.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("project.summary.brief", "Build project summary brief", "projects", "RetrievalToolService.brief", "project.summary.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("source.retrieval.search", "Search source material", "sources", "RetrievalToolService.search", "source.retrieval.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("source.retrieval.brief", "Build source brief", "sources", "RetrievalToolService.brief", "source.retrieval.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  // D8: the tool-call entry and the runtime-delegation-output entry (Path A
  // and Path B, agentGroupRuns.ts/runtimeDelegationMaterializer.ts) draft the
  // same thing — "this Agent decided another Agent should do work" — so they
  // validate against the exact same strict schema rather than Path A
  // accepting anything (`objectInput`) while Path B alone was strict.
  action("agent.delegate", "Delegate to an agent", "agent_groups", "AgentGroupRunService.spawnChildRun", "run.spawn_child", "durable", { agentToolSurface: "delegation", policyAdapter: "agent_delegate", inputSchema: RuntimeDelegationOutputItemSchema }),
  action("agent.wait_for_results", "Wait for agent results", "agent_groups", "AgentGroupRunService.waitForResults", "runtime.execute", "none", { policyResource: { resource_type: "run", resource_id_fallback: "run", check_action_approval_grant: false }, agentToolSurface: "delegation", policyAdapter: "declared_resource", inputSchema: AgentWaitForResultsInputSchema }),
  httpAction("source.recipe.plan", "Plan a Source recipe", "sources", "SourceRecipeService.planSource", "source.recipe.create", "none"),
  httpAction("source.recipe.create", "Create a Source recipe draft", "sources", "SourceRecipeService.createSource", "source.recipe.create", "draft"),
  httpAction("source.recipe.dry_run", "Dry-run a Source recipe", "sources", "SourceRecipeService.dryRunRecipeVersion", "source.recipe.dry_run", "none"),
  httpAction("source.recipe.activate", "Activate a Source recipe", "sources", "SourceRecipeService.activateRecipe", "source.recipe.activate", "durable"),
  httpAction("project.source.bind", "Bind a Source to a Project", "projects", "ProjectSourceBindingService.createBinding", "project.source.bind", "durable"),
  httpAction("policy.action_grant.create", "Create an action approval grant", "policy", "ActionApprovalGrantService.create", "policy.action_grant.create", "durable"),
  httpAction("policy.action_grant.revoke", "Revoke an action approval grant", "policy", "ActionApprovalGrantService.revoke", "policy.action_grant.revoke", "durable"),
  proposalAction("source.channel.propose_activation", "Propose Source Channel activation", "sources", "SourceChannelService.proposeActivation", "source.connection.manage", "source_channel_activation"),
  proposalAction("project.source.propose_bind", "Propose binding a Source to a Project", "projects", "ProjectSourceBindingService.proposeBind", "project.source.bind", "project_source_bind"),
  proposalAction("project.propose_definition", "Propose the Project goal or core problem", "projects", "ProjectDefinitionProposalService.proposeDefinition", "project.brief.propose", "project_brief_publish"),
  httpAction("project.operation.read", "Read Project operation progress", "projects", "ProjectOperationService.get", "project.operation.manage", "none"),
  httpAction("project.operation.create", "Create a Project operation", "projects", "ProjectOperationService.create", "project.operation.manage", "durable"),
  httpAction("project.operation.cancel", "Cancel a Project operation", "projects", "ProjectOperationService.cancel", "project.operation.manage", "durable"),
  httpAction("source.backfill.preview", "Preview Source history import", "sources", "SourceBackfillPlanningService.preview", "source.backfill.plan", "none"),
  httpAction("source.backfill.create_plan", "Create Source history import plan", "sources", "SourceBackfillPlanningService.create", "source.backfill.plan", "draft"),
  proposalAction("source.backfill.propose_start", "Propose Source history import", "sources", "SourceBackfillPlanningService.proposeStart", "source.backfill.plan", "source_backfill_start", { resource_type: "source_backfill_plan", resource_id_input_field: "source_backfill_plan_id", resource_id_fallback: "run" }),
  agentAction("task.plan.propose", "Propose an Agent-generated Task plan", "plans", "PgPlanRepository.createPlanFromAgent", "task.plan.propose", "durable", { resource_type: "plan", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: true }),
  internalAction("source.backfill.start", "Start approved Source history import", "sources", "SourceBackfillExecutionService.start", "source.backfill.start"),
  httpAction("source.backfill.pause", "Pause Source history import", "sources", "SourceBackfillPlanningService.setPaused", "source.backfill.manage", "durable"),
  httpAction("source.backfill.resume", "Resume Source history import", "sources", "SourceBackfillPlanningService.setPaused", "source.backfill.manage", "durable"),
  // Object-bound user actions are presentation metadata as well as the typed
  // invocation inventory. None is `agent_tool` visible, so adding an advice
  // affordance does not widen an agent's callable surface.
  objectAction("note.promote_to_knowledge", "Promote a passage to a Knowledge Item", "knowledge", "PgKnowledgeRepository.promoteNoteToKnowledge", "knowledge.create", "proposal", ["note"]),
  objectAction("note.raise_as_question", "Raise a passage as a Question", "inquiry", "InquiryThreadService.createThread", "inquiry.thread.create", "durable", ["note"]),
  objectAction("note.link_to_evidence", "Link a passage to evidence", "knowledge", "PgKnowledgeRepository.createNoteLink", "note.link.create", "durable", ["note"]),
  objectAction("source.raise_as_question", "Explore as a Question", "inquiry", "InquiryThreadService.createThread", "inquiry.thread.create", "durable", ["source"]),
  proposalAction("inquiry.propose_thread", "Propose creating an Inquiry Thread", "inquiry", "InquiryThreadProposalService.proposeThread", "inquiry.thread.propose", "inquiry_thread_create"),
  proposalAction("inquiry.record_conclusion", "Propose recording an Inquiry Thread conclusion", "inquiry", "InquiryConclusionProposalService.proposeConclusion", "inquiry.iteration.propose", "inquiry_conclusion"),
  // Runtime `proposal_type` is `knowledge_create` or `knowledge_update`
  // (revalidation branch) depending on `supersedes_knowledge_item_id`;
  // `knowledge_create` here is descriptive metadata only — nothing currently
  // compares it for equality (see `acceptAgentProposalIfGranted`), and this
  // action is not wired into that auto-apply path in this phase.
  proposalAction("inquiry.promote_knowledge", "Propose promoting a concluded Inquiry round to Knowledge", "inquiry", "KnowledgePromotionCandidateService.proposeFromThreadForAgent", "inquiry.knowledge.promote", "knowledge_create"),
  // Direct execution, no proposal gate (room-advancement-reliability-plan
  // Phase 4) — the Thread was already human-accepted at creation; starting
  // acquisition on it is execution, not an agent-drafted structure/content
  // write. The human confirmation gate is replaced by hard idempotency
  // guards in the acquisition service.
  agentAction("research.start_acquisition", "Start tracked research acquisition", "projectResearch", "ResearchAcquisitionService.startAcquisition", "research.acquisition.start", "durable", { resource_type: "inquiry_thread", resource_id_input_field: "thread_id", resource_id_fallback: "run", check_action_approval_grant: false }, "research"),
] as const satisfies readonly SystemActionDefinition[];

export type SystemActionId = (typeof SYSTEM_ACTION_REGISTRY)[number]["id"];

function action<const Id extends string>(
  id: Id,
  title: string,
  owningModule: string,
  applicationService: string,
  policyAction: PolicyActionId,
  sideEffects: SystemActionSideEffects = "none",
  options: {
    policyResource?: SystemActionPolicyResource;
    inputSchema?: z.ZodType;
    agentToolSurface?: SystemActionAgentToolSurface;
    policyAdapter?: SystemActionPolicyAdapter;
  } = {},
): SystemActionDefinition & { readonly id: Id } {
  return {
    id,
    version: 1,
    title,
    description: title,
    visibility: visibility("agent_tool"),
    allowed_actor_types: ["agent"],
    input_schema: options.inputSchema ?? objectInput,
    output_schema: objectOutput,
    owning_module: owningModule,
    application_service: applicationService,
    policy_action: policyAction,
    side_effects: sideEffects,
    idempotency_required: sideEffects !== "none",
    proposal_type: sideEffects === "proposal" ? "agent_delegation" : null,
    grantable: sideEffects === "proposal",
    agent_tool_surface: options.agentToolSurface ?? "generic",
    policy_adapter: options.policyAdapter ?? "declared_resource",
    ...(options.policyResource ? { policy_resource: options.policyResource } : {}),
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

/**
 * An action that operates on one ontology object (ADR 0012 decision 8).
 *
 * User-invoked only: `applies_to` exists so a surface showing an object can
 * ask which actions apply to it, which is a UI affordance, not an agent
 * capability. Making these agent-callable is a separate product decision and
 * would mean adding `agent_tool` visibility here deliberately.
 */
function objectAction<const Id extends string>(
  id: Id,
  title: string,
  owningModule: string,
  applicationService: string,
  policyAction: PolicyActionId,
  sideEffects: SystemActionSideEffects,
  appliesTo: readonly string[],
): SystemActionDefinition & { readonly id: Id } {
  return {
    id,
    version: 1,
    title,
    description: title,
    visibility: visibility("public_api"),
    allowed_actor_types: ["user"],
    input_schema: objectInput,
    output_schema: objectOutput,
    owning_module: owningModule,
    application_service: applicationService,
    policy_action: policyAction,
    side_effects: sideEffects,
    idempotency_required: sideEffects !== "none",
    proposal_type: sideEffects === "proposal" ? "knowledge_create" : null,
    grantable: false,
    applies_to: appliesTo,
  };
}

/**
 * Every `proposalAction` wants `ActionApprovalGrantService` consulted and,
 * absent an override, resolves its resource against the Run's Project (or
 * the Run itself outside a Project) — that is true for every current
 * `proposalAction` call site but one (`source.backfill.propose_start`,
 * which overrides both fields), so it is the builder's default rather than
 * a per-call declaration repeated seven times.
 */
function proposalAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, proposalType: string, policyResource: Partial<Pick<SystemActionPolicyResource, "resource_type" | "resource_id_input_field" | "resource_id_fallback">> = {}): SystemActionDefinition & { readonly id: Id } {
  return { id, version: 1, title, description: title, visibility: visibility("agent_tool", "public_api"),
    allowed_actor_types: ["user", "agent"], input_schema: proposalInputs[id]??objectInput, output_schema: proposalOutput,
    owning_module: owningModule, application_service: applicationService, policy_action: policyAction,
    side_effects: "proposal", idempotency_required: true, proposal_type: proposalType, grantable: true,
    agent_tool_surface: "generic", policy_adapter: "declared_resource",
    policy_resource: { resource_id_fallback: "project_or_run", check_action_approval_grant: true, ...policyResource } };
}

function agentAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, sideEffects: SystemActionSideEffects, policyResource: SystemActionPolicyResource, agentToolSurface: SystemActionAgentToolSurface = "generic"): SystemActionDefinition & { readonly id: Id } {
  return { id, version: 1, title, description: title, visibility: visibility("agent_tool"), allowed_actor_types: ["agent"],
    input_schema: proposalInputs[id] ?? objectInput, output_schema: proposalOutput, owning_module: owningModule,
    application_service: applicationService, policy_action: policyAction, side_effects: sideEffects,
    idempotency_required: true, proposal_type: null, grantable: false, policy_resource: policyResource,
    agent_tool_surface: agentToolSurface, policy_adapter: "declared_resource" };
}

function internalAction<const Id extends string>(id:Id,title:string,owningModule:string,applicationService:string,policyAction:PolicyActionId):SystemActionDefinition&{readonly id:Id}{
  return{id,version:1,title,description:title,visibility:visibility("internal_only","system_job"),allowed_actor_types:["user","system"],input_schema:objectInput,output_schema:objectOutput,owning_module:owningModule,application_service:applicationService,policy_action:policyAction,side_effects:"durable",idempotency_required:true,proposal_type:null,grantable:false};
}

/**
 * The actions that apply to an ontology object type (ADR 0012 decision 8).
 *
 * This is the mechanism `applies_to` was added for: a surface rendering an
 * object — or a selection inside one — asks the registry what it can offer
 * rather than hard-coding a menu. An action with no `applies_to` is not
 * object-bound and never appears here.
 */
export function systemActionsForObjectType(objectType: string): readonly SystemActionDefinition[] {
  return SYSTEM_ACTION_REGISTRY.filter((definition) => definition.applies_to?.includes(objectType));
}

/**
 * The Note actions, as a type, so a surface can key a label map on them and
 * fail to compile when the registry gains one.
 *
 * Derived from the id prefix because `applies_to` is a runtime array and TypeScript
 * cannot filter on it. `server/test/noteObjectActions.test.ts` asserts the two
 * agree, so the prefix is a shorthand for the declaration rather than a second
 * source of truth.
 */
export type NoteSystemActionId = Extract<SystemActionId, `note.${string}`>;
export type SourceSystemActionId = Extract<SystemActionId, `source.${string}`>;

/**
 * The model-facing JSON Schema for an action's `input_schema`, derived from
 * the same Zod that validates it. One source: MCP `tools/list`, the managed
 * loop's tool assembly, and any future thin CLI all read this rather than a
 * hand-maintained literal that can drift from what actually validates.
 *
 * `$schema` is stripped — a meta-schema pointer is Draft-7 tooling noise on a
 * tool-call payload, and the hand-written schemas it replaces never carried
 * one either.
 */
export function systemActionInputJsonSchema(
  definition: Pick<SystemActionDefinition, "input_schema">,
): Record<string, unknown> {
  const schema = zodToJsonSchema(definition.input_schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}
