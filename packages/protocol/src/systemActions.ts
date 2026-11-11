import {RESEARCH_EXECUTION_SCHEMAS,RESEARCH_EXECUTION_TITLES} from './researchExecutionOperations.js';
import {ResearchAdhocInputSchema,ResearchAdhocReceiptSchema} from './researchAdhocOperation.js';
import {PROJECT_SOURCE_PROPOSAL_SCHEMAS,PROJECT_SOURCE_PROPOSAL_TITLES} from './projectSourceProposalOperations.js';
import {PROJECT_CORPUS_SCHEMAS,PROJECT_CORPUS_TITLES} from './projectCorpusOperations.js';
import {INQUIRY_AGENT_OPERATION_SCHEMAS} from './inquiryAgentOperations.js';
import {RESEARCH_AGENT_OPERATION_SCHEMAS} from './researchAgentOperations.js';
import {ROOM_OPERATION_SCHEMAS,ROOM_OPERATION_TITLES} from './roomOperations.js';
import {AGENT_GROUP_OPERATION_SCHEMAS,AGENT_GROUP_OPERATION_TITLES} from './agentGroupOperations.js';
import {RUN_OPERATION_SCHEMAS,RUN_OPERATION_TITLES} from './runOperations.js';
import {SESSION_OPERATION_SCHEMAS,SESSION_QUERY_SCHEMAS,SESSION_OPERATION_TITLES} from './sessionOperations.js';
import {AGENT_CHAT_OPERATION_SCHEMAS,AGENT_CHAT_OPERATION_TITLES,AGENT_OPERATION_SCHEMAS,AGENT_OPERATION_TITLES} from './agentOperations.js';
import {HOST_COMMAND_OPERATION_SCHEMAS,HOST_DIRECT_OPERATION_SCHEMAS,HOST_OPERATION_TITLES} from './hostOperations.js';
import {SETTINGS_COMMAND_OPERATION_SCHEMAS,SETTINGS_DIRECT_OPERATION_SCHEMAS,SETTINGS_OPERATION_TITLES} from './settingsOperations.js';
import {PROJECT_FOLDER_SCHEMAS,PROJECT_FOLDER_TITLES} from './projectFolderOperations.js';
import {PROJECT_FOLDER_IO_SCHEMAS,PROJECT_FOLDER_IO_TITLES} from './projectFolderIoOperations.js';
import {PROJECT_INGRESS_SCHEMAS,PROJECT_INGRESS_TITLES,PROJECT_INGRESS_POLICY,PROJECT_INGRESS_PROPOSALS} from './projectIngressOperations.js';
import {PROJECT_EXECUTION_SCHEMAS,PROJECT_EXECUTION_TITLES} from './projectExecutionOperations.js';
import {PROJECT_MANAGEMENT_SCHEMAS,PROJECT_MANAGEMENT_TITLES} from './projectManagementOperations.js';
import {INQUIRY_OPERATION_SCHEMAS,INQUIRY_OPERATION_TITLES} from './inquiryOperations.js';
import {TaskCreateInputSchema} from './taskCreateInput.js';
export {TaskCreateInputSchema,ProblemTaskLinkRequestSchema} from './taskCreateInput.js';
import {RESEARCH_WORKSPACE_SCHEMAS,RESEARCH_WORKSPACE_TITLES} from './researchWorkspaceOperations.js';
import {RESEARCH_CONTROL_SCHEMAS,RESEARCH_CONTROL_TITLES,RESEARCH_CONTROL_POLICY} from './researchControlOperations.js';
import {PROJECT_SUMMARY_DRAFT_SCHEMAS,PROJECT_SUMMARY_DRAFT_TITLES} from './projectSummaryDraftOperation.js';
import {IMPORTED_HISTORY_EXTRACTION_SCHEMAS,IMPORTED_HISTORY_EXTRACTION_TITLES} from './importedHistoryExtractionOperation.js';
import {KnowledgeExtractionInputSchema,KnowledgeExtractionReceiptSchema} from './knowledgeExtractionOperation.js';
import {WorkspaceVerificationGetInputSchema,WorkspaceVerificationConfigureInputSchema,WorkspaceVerificationViewSchema,WorkspaceChangeStatusSchema,WorkspaceChangeGetInputSchema,WorkspaceChangeCompleteInputSchema,WorkspaceChangeReceiptSchema,WorkspaceIntegrationRetryInputSchema,WorkspaceChangeAbandonInputSchema,WorkspaceRetentionUpdateInputSchema,WorkspaceRetentionReceiptSchema,WorkspaceChangeListInputSchema,WorkspaceChangeListSchema,WorkspaceBranchAlignInputSchema,WorkspaceBranchAlignReceiptSchema} from "./executionWorkspaces.js";
import {KNOWLEDGE_REVIEW_SCHEMAS,KNOWLEDGE_REVIEW_TITLES} from './knowledgeReviewOperations.js';
import {KNOWLEDGE_OBJECT_SCHEMAS} from './knowledgeObjectOperations.js';
import {NOTE_OBJECT_SCHEMAS,NOTE_OBJECT_TITLES} from './noteObjectOperations.js';
import {SourceProcessingCreateSchema,SourceProcessingUpdateSchema,SourceProcessingDispatchSchema,SourceExtractionDispatchSchema,SourceProcessingRuleSchema,SourceDispatchReceiptSchema} from './sourceProcessingOperations.js';
import {SourceChannelCreateInputSchema,SourceChannelCreateOutputSchema} from './sourceChannelCreateOperation.js';
import {NoteControlTargetSchema,NoteRollbackInputSchema,NoteControlReceiptSchema} from './noteControlOperations.js';
import {SourceMonitorTargetSchema,SourceMonitorUpdateSchema,SourceMonitorOutputSchema,SourceMonitorScanOutputSchema} from './sourceMonitorOperations.js';
import {SourceRecipeCreateInputSchema,SourceRecipeCreateOutputSchema} from './sourceRecipeOperations.js';
import {SourceSubscriptionInputSchema,SourceRecommendationInputSchema,SourceSubscriptionOutputSchema} from './sourceSubscriptionOperations.js';
import {ProjectSourceBindInputSchema,ProjectSourceTargetSchema,ProjectSourceUpdateInputSchema,ProjectSourceBackfillOutputSchema,ProjectSourceBindingOutputSchema,ProjectSourceUnbindOutputSchema} from './projectSourceOperations.js';
import {InquiryThreadCreateInputSchema,InquiryThreadCreateReceiptSchema,NoteQuestionInputSchema,NoteQuestionReceiptSchema} from './inquiryCreationOperations.js';
import {TaskReportInputSchema,TaskCompleteInputSchema,TaskReviewInputSchema,TaskHandoffInputSchema,TaskStatusInputSchema,TaskDeleteInputSchema,TaskStatusOutputSchema,TaskReportOutputSchema,TaskCompleteOutputSchema,TaskHandoffOutputSchema,TaskDeleteOutputSchema} from './taskLifecycle.js';
import {BoardConfigureOperationInputSchema,BoardConfigureOperationOutputSchema,TaskMoveOperationInputSchema,TaskMoveOperationOutputSchema} from './operations.js';
import {ProjectOperationCreateInputSchema, ProjectOperationCancelInputSchema, ProjectOperationCommandOutputSchema} from './operations.js';
import {CollaborationParticipantsInputSchema,CollaborationParticipantsOutputSchema,ActionCatalogInputSchema,ActionCatalogOutputSchema,ActionGrantCreateInputSchema,ActionGrantRevokeInputSchema,ActionGrantOutputSchema} from "./operations.js";
import { PROJECT_READING_RECORD_LIMITS } from './reader.js';
import {SourceMaterialSubmissionSchema,SourceMaterialInvestigationSchema} from './sourceMaterials.js';
import {SourceGoalVersionWriteSchema,SourceGoalRepairSchema} from './sourceGoals.js';
import { ProposeProjectMonitoringSchema } from "./projectInformationMonitoring.js";
import { z } from "zod";
import {TaskSpacePlacementInputSchema,TaskSpacePlacementOutputSchema} from './taskSpacePlacement.js';
import {SourceBackfillPreviewInputSchema,SourceBackfillCreateInputSchema,SourceBackfillControlInputSchema,SourceBackfillPreviewOutputSchema,SourceBackfillReceiptSchema} from './sourceBackfillOperations.js';
import { zodToJsonSchema } from "zod-to-json-schema";
import type { PolicyActionId } from "./policy.js";
import {
  AgentWaitForResultsInputSchema,
  AgentListRunsInputSchema,
  AgentCancelRunInputSchema,
  RuntimeDelegationOutputItemSchema,
} from "./agentGroupRuns.js";
import {
  InputResourceReadInputSchema,
  InputResourceSearchInputSchema,
} from "./conversationInputResources.js";

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

/**
 * `conditional_proposal`: the action writes directly while it stays inside the
 * bounds it declares, and files a proposal of `proposal_type` — gated by
 * `gate_class` — when it does not (`task.plan.propose`: a Plan within its
 * budget and risk is approved as written; one past them waits for a person's
 * `plan_review`, a direction gate). Registered as such rather than as
 * `durable`, so the registry never claims a write is ungated when it is not.
 */
export const SYSTEM_ACTION_SIDE_EFFECT_VALUES = ["none", "draft", "proposal", "conditional_proposal", "durable"] as const;

/**
 * Why a write is gated behind per-instance human approval
 * ([ADR 0017](../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md) §1).
 *
 * The list is exhaustive and an action that registers as a proposal must name
 * one. Authorship is not a gate class. Do not gate a write because an Agent
 * wrote it: under an Agent that advances work that becomes a rubber stamp on
 * the writes that matter. What is gated is what cannot be
 * taken back, costs money, changes who can see something, or changes the
 * Agent itself.
 */
export const SYSTEM_ACTION_GATE_CLASSES = [
  "self_modification",
  "belief_reach",
  "real_checkout",
  "exposure",
  "money",
  "credential_or_deployment",
  "direction",
] as const;
export type SystemActionGateClass = (typeof SYSTEM_ACTION_GATE_CLASSES)[number];
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
export const SystemActionGateClassSchema = z.enum(SYSTEM_ACTION_GATE_CLASSES);
export const SystemActionAgentToolSurfaceSchema = z.enum(SYSTEM_ACTION_AGENT_TOOL_SURFACE_VALUES);
export const SystemActionPolicyAdapterSchema = z.enum(SYSTEM_ACTION_POLICY_ADAPTER_VALUES);
const ZodSchemaValue = z.custom<z.ZodType>(
  (value) => typeof (value as { safeParse?: unknown } | null)?.safeParse === "function",
  "Expected a Zod schema",
);

/**
 * Declarative resource resolution for the generic policy adapter. An action carrying this needs no
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
  execution: z.object({kind:z.enum(["command","query"]),tx:z.literal("core_owned")}).strict().optional(),
  id: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
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
  gate_class: SystemActionGateClassSchema.nullable(),
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
  readonly execution?: {readonly kind:"command"|"query";readonly tx:"core_owned"};
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
  /** Which ADR 0017 §1 class gates this action, or null when nothing does. */
  readonly gate_class: SystemActionGateClass | null;
  readonly grantable: boolean;
  /** Ontology object types this action operates on, when it operates on one. */
  readonly applies_to?: readonly string[];
  /** Declarative resource resolution for the generic policy adapter. */
  readonly policy_resource?: SystemActionPolicyResource;
  /** Which managed Agent tool family contributes this action, if any. */
  readonly agent_tool_surface?: SystemActionAgentToolSurface;
  /** Which policy adapter enforces the action, if it is Agent-callable. */
  readonly policy_adapter?: SystemActionPolicyAdapter;
}

/** Dynamic runtime definition; the original core interface and literal vocabularies remain compatible. */
export type RegisteredSystemActionDefinition=Omit<SystemActionDefinition,"policy_action"> & {readonly policy_action:PolicyActionId | import("./pluginOperations.js").PluginOperationId};

const objectInput = z.record(z.string(), z.unknown());
const objectOutput = z.record(z.string(), z.unknown());
const proposalOutput = z.object({ modelResult: z.record(z.string(), z.unknown()), summary: z.record(z.string(), z.unknown()) }).passthrough();
export const TASK_CREATE_BATCH_MAX_ITEMS = 100;
const proposalInputs:Record<string,z.ZodType>={
  /**
   * A person deciding, in words, a proposal this conversation produced.
   *
   * The Agent is the transport for the decision, never its author: the action
   * is refused on any origin but a person's own turn, and only for a proposal
   * created by a Run of this same conversation. "Accept it" said to the
   * Assistant is the same approval as the button beside the proposal.
   */
  "proposal.list_pending": z.object({}).strict(),
  "proposal.decide": z.object({
    proposal_id: z.string().min(1).describe("The Proposal id exactly as returned by proposal.list_pending. Never invent, abbreviate, or derive one — ids are copied from a tool result, never composed."),
    decision: z.enum(["accept", "reject"]),
  }).strict(),
  "authorization.request": z.object({
    policy_decision_record_id: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
  }).passthrough(),
  // The dispatcher's call identity is the receipt key; a model-supplied key
  // would be ignored, so these agent inputs do not ask for one.
  "inquiry.list_tasks": z.object({thread_id:z.string().min(1),after_task_id:z.string().optional()}).strict(),
  "task.create": TaskCreateInputSchema,
  "task.create_batch": z.object({
    request_summary: z.string().trim().min(1).max(2000).describe("The person's explicit request to create this bounded list. Never use this action for unsolicited task suggestions."),
    tasks: z.array(TaskCreateInputSchema).min(1).max(TASK_CREATE_BATCH_MAX_ITEMS).describe("Only the requested Tasks. Split larger authorized lists into batches of at most 100 and continue without asking for another confirmation."),
  }).strict(),
  "task.list": z.object({
    status: z.enum(["inbox", "ready", "in_progress", "waiting_for_review", "blocked", "done", "cancelled"]).optional(),
  }).strict(),
  "task.report": TaskReportInputSchema,
  // Settlement matches `artifact_type` against the Task's declared
  // `required_outputs_json`, so this is the field that decides whether a
  // finished Run closes its Task or parks it for review.
  "artifact.submit": z.object({
    task_id: z.string().min(1).describe("The Task id exactly as returned by task.list. Never invent, abbreviate, or derive one — ids are copied from a tool result, never composed."),
    path: z.string().trim().min(1).max(1000).describe("Path to the file relative to $RAINVER_OUTPUT_DIR — write the deliverable there, then declare it. A file anywhere else is not collected as a deliverable. The file is read from disk after the run, so declaring it does not upload it and it must be left in place."),
    artifact_type: z.string().trim().min(1).max(64).describe("What this file is, matched case-insensitively against the Task's required outputs. Use exactly the name the Task declares when it declares one."),
    role: z.enum(["output", "evidence", "draft"]).default("output")
      .describe("output is a deliverable the Task asked for; evidence supports a conclusion; draft is working material kept for the record."),
    note: z.string().trim().max(2000).optional(),
  }).strict(),
  "task.handoff": TaskHandoffInputSchema,
  "board.read": z.object({}).strict(),
  "board.configure": BoardConfigureOperationInputSchema,
  "task.move_to_column": TaskMoveOperationInputSchema,
  "task.place_in_space_board": TaskSpacePlacementInputSchema,
  "task.delete": TaskDeleteInputSchema,
  "task.set_status": TaskStatusInputSchema,
  "workspace.change.get":WorkspaceChangeGetInputSchema,
  "workspace.change.complete": WorkspaceChangeCompleteInputSchema,
  "workspace.integration.verification.get":WorkspaceVerificationGetInputSchema,
  "workspace.integration.verification.configure":WorkspaceVerificationConfigureInputSchema,
  "workspace.integration.retry":WorkspaceIntegrationRetryInputSchema,
  "workspace.change.abandon":WorkspaceChangeAbandonInputSchema,
  "workspace.retention.update":WorkspaceRetentionUpdateInputSchema,
  "workspace.change.list":WorkspaceChangeListInputSchema,
  "workspace.branch.align":WorkspaceBranchAlignInputSchema,
  "task.complete": TaskCompleteInputSchema,
  "task.request_review": TaskReviewInputSchema,
  "task.plan.propose": z.object({
    task_id: z.string().min(1).describe("The Task id exactly as returned by task.list. Never invent, abbreviate, or derive one — ids are copied from a tool result, never composed."),
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
  "source.goal.read":z.object({goal_id:z.string().min(1)}).strict(),
  "source.goal.sources":z.object({goal_id:z.string().min(1)}).strict(),
  "source.goal.inspect":z.object({goal_id:z.string().min(1),source_connection_id:z.string().min(1),source_channel_id:z.string().min(1)}).strict(),
  "source.goal.write_version":SourceGoalVersionWriteSchema,
  "source.material.submit":SourceMaterialSubmissionSchema,
  "source.material.investigate":SourceMaterialInvestigationSchema,
  "source.goal.repair_candidate":SourceGoalRepairSchema.extend({goal_id:z.string().min(1)}),
  "source.channel.propose_activation": z.object({
    provider_key: z.string().min(1),
    name: z.string().min(1).optional(),
    query: z.record(z.string(), z.unknown()).nullable().optional(),
    endpoint_url: z.string().min(1).optional(),
  }).passthrough(),
  "project.monitoring.propose": ProposeProjectMonitoringSchema,
  "project.monitoring.propose_details": ProposeProjectMonitoringSchema,
  "project.monitoring.read": z.object({}).strict(),
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
  "inquiry.create_thread": z.object({
    kind: z.enum(["question", "hypothesis"]).default("question"),
    statement: z.string().trim().min(1),
    answerability: z.string().trim().min(1).optional(),
    resolution_criteria: z.string().trim().min(1).optional(),
    proposed_claim: z.string().trim().min(1).optional(),
    predictions: z.string().trim().min(1).optional(),
    falsification_criteria: z.string().trim().min(1).optional(),
    // Strict, like every other direct action: the executor supplies the
    // idempotency key itself, and a field the model is never shown is not a
    // field it may pass.
  }).strict(),
  // ADR 0003 §2. `visibility` and `sensitivity_level` are askable and are the
  // fields that change reach: asking for either is not refused, it is routed
  // — the write becomes a proposal for the person. What is deliberately
  // absent is a subject: an Agent cannot write into someone else's memory
  // here at all, by any route.
  //
  // `memory_type` also decides *whose* memory this is (ADR 0003 §4), rather
  // than a second field the model would have to keep consistent with it: the
  // first three are about the person in the turn, the last four are the
  // Agent's own.
  "memory.remember": z.object({
    content: z.string().trim().min(1).max(4000),
    rationale: z.string().trim().min(1).max(1000)
      .describe("Why this is worth keeping across sessions. Recorded with the entry; a write without one is refused."),
    memory_type: z.enum(["semantic", "episodic", "procedural", "note", "decision", "lesson", "persona"]).optional()
      .describe(
        "What kind of memory this is, and whose. `semantic` (the default), `episodic` and `procedural` are about the person you are talking to. "
        + "`note`, `decision` and `lesson` are your own, kept for this Room and delivered back to you only where everyone present could already have seen the conversation it came from. "
        + "`persona` is what you have learned about yourself: one per Agent, delivered everywhere, so keep it free of anything specific to a Project or a Room — and if a person in this turn asked for it, it goes to your owner to decide rather than being stored.",
      ),
    title: z.string().trim().min(1).max(200).optional(),
    visibility: z.enum(["private", "space_shared", "selected_users"]).optional()
      .describe("Defaults to private, which writes immediately. Anything wider is a change in reach: it becomes a proposal for the person to decide, and no entry exists until they accept."),
    sensitivity_level: z.enum(["normal", "sensitive", "restricted"]).optional()
      .describe("Above normal follows the same route as a wider visibility: a proposal, not an entry."),
  }).strict(),
  "memory.revise": z.object({
    memory_id: z.string().min(1).describe("The memory entry id exactly as a memory retrieval returned it. Never invent one."),
    content: z.string().trim().min(1).max(4000),
    rationale: z.string().trim().min(1).max(1000),
  }).strict(),

  "inquiry.list_threads": z.object({
    limit:z.number().int().min(1).max(100).optional(),
    after_thread_id:z.string().optional(),
    kind: z.enum(["question", "hypothesis"]).optional(),
  }).strict(),
  "inquiry.read_problem": z.object({thread_id:z.string().min(1),limit:z.number().int().min(1).max(100).optional(),before_step:z.number().int().positive().optional(),before_closeout:z.number().int().positive().optional()}).strict(),
  "inquiry.promote_knowledge": z.object({
    thread_id: z.string().min(1).describe("The Inquiry Thread id exactly as returned by inquiry.list_threads. Never invent, abbreviate, or derive one from the statement."),
    candidate_kind: z.enum(["concept", "lesson", "procedure", "decision", "summary"]),
    proposed_title: z.string().min(1),
    proposed_content: z.string().min(1),
    supersedes_knowledge_item_id: z.string().min(1).optional(),
  }).passthrough(),
  "project.reading.list": z.object({q:z.string().max(500).optional(),cursor:z.string().max(4096).optional(),limit:z.number().int().min(1).max(10).optional()}).strict(),
  "project.reading.records": z.object({item_id:z.string().min(1).max(64),offset:z.number().int().min(0).max(PROJECT_READING_RECORD_LIMITS.maxOffset).optional()}).strict(),
  "project.reading.read": z.object({item_id:z.string().min(1).max(64),snapshot_id:z.string().min(1).max(64),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(12000).optional()}).strict(),
  "research.read_result": z.object({operation_id:z.string().min(1)}).strict(),
  "research.adopt_result": RESEARCH_AGENT_OPERATION_SCHEMAS["research.adopt_result"].input,
  "research.start_acquisition": RESEARCH_AGENT_OPERATION_SCHEMAS["research.start_acquisition"].input,
  "research.list_operations": z.object({
    include_terminal: z.boolean().optional(),
  }).strict(),
  "research.cancel_acquisition": z.object({
    project_id: z.string().min(1).optional(),
    operation_id: z.string().min(1).describe("The research Operation id exactly as returned by research.list_operations. Never invent, abbreviate, or derive one — ids are copied from a tool result, never composed."),
    reason: z.string().trim().min(1).max(2000).optional(),
  }).strict(),
  "input_resource.read": InputResourceReadInputSchema,
  "input_resource.search": InputResourceSearchInputSchema,
  // The conversation's own record, read on demand: the vendor session holds
  // the working memory, Rainver holds every message and Agent event. A
  // summary points here for what it left out.
  "conversation.search": z.object({
    query: z.string().trim().min(1).max(200).describe("Words to look for in this conversation's messages and in what the Agents did (tool calls, replies). Case-insensitive."),
    since: z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "since must be an ISO date").optional()
      .describe("ISO date; only history on or after it."),
    until: z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "until must be an ISO date").optional()
      .describe("ISO date; only history on or before it."),
    max_results: z.number().int().min(1).max(50).default(20),
  }).strict(),
  "conversation.read": z.object({
    message_ids: z.array(z.string().min(1)).min(1).max(20).optional()
      .describe("Message ids exactly as conversation.search returned them. Never invent one."),
    since: z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "since must be an ISO date").optional()
      .describe("With until: read the messages in this window instead of by id."),
    until: z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "until must be an ISO date").optional(),
    max_messages: z.number().int().min(1).max(50).default(20),
  }).strict(),
  // The sections of an Agent's handoff to its own next session. Each is what
  // a fresh session cannot recover from the Room summary alone.
  "handoff.write": z.object({
    goal: z.string().trim().min(1).max(4000).describe("The goal of this conversation as you understand it."),
    decisions: z.string().trim().min(1).max(8000).describe("Decisions already taken, and by whom."),
    files: z.string().trim().max(8000).optional().describe("Files you changed and their current state. Omit when you changed none."),
    next_step: z.string().trim().min(1).max(4000).describe("What you were doing and the next step."),
    open_questions: z.string().trim().max(4000).optional().describe("Questions still open for the person."),
  }).strict(),
};
const visibility = (...values: SystemActionVisibility[]) => new Set(values);

export const SYSTEM_ACTION_REGISTRY = [
  { ...httpAction("system.actions.list", "List available operation entries", "systemActions", "OperationCatalog.list", "system.actions.list", "none"), input_schema:ActionCatalogInputSchema, output_schema:ActionCatalogOutputSchema, execution:{kind:"query",tx:"core_owned"} },
  { ...httpAction("room.collaboration.update_participants", "Change task collaboration participants", "agentGroups", "collaborationParticipantsOperation", "room.collaboration.manage", "durable"), input_schema: CollaborationParticipantsInputSchema, output_schema: CollaborationParticipantsOutputSchema, execution: {kind:"command",tx:"core_owned"} },
  agentAction("authorization.request", "Request authorization for a denied action", "policy", "AuthorizationRequestService.createFromDeniedDecision", "authorization.request.create", "durable", { resource_type: "authorization_request", resource_id_fallback: "run", check_action_approval_grant: false }),
  agentAction("input_resource.read", "Read lines from an attached conversation resource", "conversationInput", "ConversationInputResourceService.read", "input_resource.read", "none", { resource_type: "conversation_input_resource", resource_id_input_field: "resource_id", resource_id_fallback: "run", check_action_approval_grant: false }),
  agentAction("input_resource.search", "Search an attached conversation resource", "conversationInput", "ConversationInputResourceService.search", "input_resource.search", "none", { resource_type: "conversation_input_resource", resource_id_input_field: "resource_id", resource_id_fallback: "run", check_action_approval_grant: false }),
  agentAction("conversation.search", "Search this conversation's recorded history", "sessions", "ConversationHistoryService.search", "conversation.history.read", "none", { resource_type: "session", resource_id_fallback: "run", check_action_approval_grant: false }),
  agentAction("conversation.read", "Read messages from this conversation's recorded history", "sessions", "ConversationHistoryService.read", "conversation.history.read", "none", { resource_type: "session", resource_id_fallback: "run", check_action_approval_grant: false }),
  action("retrieval.search", "Search knowledge", "retrieval", "RetrievalToolService.search", "retrieval.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("retrieval.brief", "Build knowledge brief", "retrieval", "RetrievalToolService.brief", "retrieval.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("memory.retrieval.search", "Search memory", "memory", "RetrievalToolService.search", "memory.retrieval.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("memory.retrieval.brief", "Build memory brief", "memory", "RetrievalToolService.brief", "memory.retrieval.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("project.summary.search", "Search project summaries", "projects", "RetrievalToolService.search", "project.summary.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("project.summary.brief", "Build project summary brief", "projects", "RetrievalToolService.brief", "project.summary.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("source.retrieval.search", "Search source material", "sources", "RetrievalToolService.search", "source.retrieval.search", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  action("source.retrieval.brief", "Build source brief", "sources", "RetrievalToolService.brief", "source.retrieval.brief", "none", { agentToolSurface: "retrieval", policyAdapter: "retrieval" }),
  // The tool-call entry and the runtime-delegation-output entry (Path A
  // and Path B, agentGroupRuns.ts/runtimeDelegationMaterializer.ts) draft the
  // same thing — "this Agent decided another Agent should do work". They
  // validate against the same strict schema. Do not let Path A accept
  // anything while Path B is strict.
  action("agent.delegate", "Delegate to an agent", "agent_groups", "AgentGroupRunService.spawnChildRun", "run.spawn_child", "durable", { agentToolSurface: "delegation", policyAdapter: "agent_delegate", inputSchema: RuntimeDelegationOutputItemSchema }),
  action("agent.wait_for_results", "Wait for agent results", "agent_groups", "AgentGroupRunService.waitForResults", "runtime.execute", "none", { policyResource: { resource_type: "run", resource_id_fallback: "run", check_action_approval_grant: false }, agentToolSurface: "delegation", policyAdapter: "declared_resource", inputSchema: AgentWaitForResultsInputSchema }),
  action("agent.list_runs", "List Room runs", "agent_groups", "RoomRunControl.dispatch", "runtime.execute", "none", { policyResource: { resource_type: "run", resource_id_fallback: "run", check_action_approval_grant: false }, agentToolSurface: "delegation", policyAdapter: "declared_resource", inputSchema: AgentListRunsInputSchema }),
  action("agent.cancel_run", "Cancel a Room run", "agent_groups", "RoomRunControl.dispatch", "runtime.execute", "durable", { policyResource: { resource_type: "run", resource_id_fallback: "run", check_action_approval_grant: false }, agentToolSurface: "delegation", policyAdapter: "declared_resource", inputSchema: AgentCancelRunInputSchema }),
  {...httpAction("source.processing.rule.create","Create Source processing rule","sources","SourceProcessingCommands","source.connection.manage","durable"),input_schema:SourceProcessingCreateSchema,output_schema:SourceProcessingRuleSchema,execution:{kind:"command",tx:"core_owned"}},
  {...httpAction("source.processing.rule.update","Update Source processing rule","sources","SourceProcessingCommands","source.connection.manage","durable"),input_schema:SourceProcessingUpdateSchema,output_schema:SourceProcessingRuleSchema,execution:{kind:"command",tx:"core_owned"}},
  {...httpAction("source.processing.rule.dispatch","Queue Source processing","sources","SourceProcessingCommands","source.connection.manage","durable"),input_schema:SourceProcessingDispatchSchema,output_schema:SourceDispatchReceiptSchema,execution:{kind:"command",tx:"core_owned"}},
  {...httpAction("source.extraction.dispatch","Queue extraction Job","sources","SourceProcessingCommands","source.item_create","durable"),input_schema:SourceExtractionDispatchSchema,output_schema:SourceDispatchReceiptSchema,execution:{kind:"command",tx:"core_owned"}},
  {...httpAction("source.channel.create", "Create a Source Monitor", "sources", "SourceChannelService.create", "source.connection.manage", "durable"),input_schema:SourceChannelCreateInputSchema,output_schema:SourceChannelCreateOutputSchema,execution:{kind:"command",tx:"core_owned"}},
  {...httpAction("source.channel.update", "Update a Source Monitor", "sources", "SourceChannelService.update", "source.connection.manage", "durable"),input_schema:SourceMonitorUpdateSchema,output_schema:SourceMonitorOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("source.channel.scan", "Queue a Source Monitor scan", "sources", "SourceChannelService.scan", "source.connection.manage", "durable"),input_schema:SourceMonitorTargetSchema,output_schema:SourceMonitorScanOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("source.channel.set_subscription", "Change my Source subscription", "sources", "SourceChannelService.setSubscription", "source.subscription.manage", "durable"),input_schema:SourceSubscriptionInputSchema,output_schema:SourceSubscriptionOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("source.recommendation.decide", "Decide my Source recommendation", "sources", "SourceChannelService.decideRecommendation", "source.subscription.manage", "durable"),input_schema:SourceRecommendationInputSchema,output_schema:SourceSubscriptionOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  httpAction("source.recipe.plan", "Plan a Source recipe", "sources", "SourceRecipeService.planSource", "source.recipe.create", "none"),
  {...httpAction("source.recipe.create", "Create a Source recipe draft", "sources", "SourceRecipeService.createSource", "source.recipe.create", "draft"),input_schema:SourceRecipeCreateInputSchema,output_schema:SourceRecipeCreateOutputSchema,execution:{kind:"command",tx:"core_owned"}},
  httpAction("source.recipe.dry_run", "Dry-run a Source recipe", "sources", "SourceRecipeService.dryRunRecipeVersion", "source.recipe.dry_run", "none"),
  httpAction("source.recipe.activate", "Activate a Source recipe", "sources", "SourceRecipeService.activateRecipe", "source.recipe.activate", "durable"),
  {...httpAction("project.source.bind", "Bind a Source to a Project", "projects", "ProjectSourceBindingService.createBinding", "project.source.bind", "durable"),input_schema:ProjectSourceBindInputSchema,output_schema:ProjectSourceBindingOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("project.source.update", "Update Project Source consumption", "projects", "ProjectSourceBindingService.updateBinding", "project.source.bind", "durable"),input_schema:ProjectSourceUpdateInputSchema,output_schema:ProjectSourceBindingOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("project.source.unbind", "Unbind a Source from a Project", "projects", "ProjectSourceBindingService.deleteBinding", "project.source.bind", "durable"),input_schema:ProjectSourceTargetSchema,output_schema:ProjectSourceUnbindOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("project.source.backfill", "Route retained Source material to a Project", "projects", "ProjectSourceBindingService.backfillBinding", "project.source.bind", "durable"),input_schema:ProjectSourceTargetSchema,output_schema:ProjectSourceBackfillOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  { ...httpAction("policy.action_grant.create", "Create an action approval grant", "policy", "ActionApprovalGrantService.createInTransaction", "policy.action_grant.create", "durable"), input_schema:ActionGrantCreateInputSchema, output_schema:ActionGrantOutputSchema, execution:{kind:"command",tx:"core_owned"} },
  { ...httpAction("policy.action_grant.revoke", "Revoke an action approval grant", "policy", "ActionApprovalGrantService.revokeInTransaction", "policy.action_grant.revoke", "durable"), input_schema:ActionGrantRevokeInputSchema, output_schema:ActionGrantOutputSchema, execution:{kind:"command",tx:"core_owned"} },
  agentAction("source.goal.read", "Read collection goal", "sources", "SourceGoalService.read", "source.goal.manage", "none", {resource_type:"source_goal",resource_id_input_field:"goal_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  agentAction("source.goal.sources", "List authorized collection sources", "sources", "SourceGoalActions.sources", "source.goal.manage", "none", {resource_type:"source_goal",resource_id_input_field:"goal_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  agentAction("source.goal.inspect", "Inspect untrusted source documentation", "sources", "SourceGoalActions.inspect", "source.goal.manage", "durable", {resource_type:"source_goal",resource_id_input_field:"goal_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  agentAction("source.material.investigate", "Search retained Source materials, read authorized history, or check an investigation draft before submitting. Only for the bound saved-item reading Run; this is coverage feedback, not a semantic quality verdict.", "sources", "SourceMaterialInvestigation.execute", "source.item_update", "durable", {resource_type:"source_item",resource_id_input_field:"item_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  agentAction("source.material.submit", "Submit Agent-provided search results (not independently verified)", "sources", "SourceMaterialSubmission.submit", "source.goal.manage", "durable", {resource_type:"source_goal",resource_id_input_field:"goal_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  agentAction("source.goal.write_version", "Write immutable collection plan candidate", "sources", "SourceGoalService.writeVersion", "source.goal.manage", "draft", {resource_type:"source_goal",resource_id_input_field:"goal_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  agentAction("source.goal.repair_candidate", "Validate bounded source repair candidate", "sources", "SourceGoalRepairService.candidate", "source.goal.manage", "durable", {resource_type:"source_goal",resource_id_input_field:"goal_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  gatedProposalAction("source.channel.propose_activation", "Propose Source Channel activation", "sources", "SourceChannelService.proposeActivation", "source.connection.manage", "source_channel_activation", "money"),
  { ...gatedProposalAction("project.monitoring.propose", "Propose bounded Project monitoring", "projects", "ProjectMonitoringService.propose", "project.monitoring.configure", "project_information_monitoring_activation", "money"), grantable:false, policy_resource:{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false} },
  { ...gatedProposalAction("project.monitoring.propose_details", "Propose Project monitoring details within approved scope", "projects", "ProjectMonitoringService.propose", "project.monitoring.configure", "project_information_monitoring_details", "direction"), grantable:false, policy_resource:{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false} },
  agentAction("project.monitoring.read", "Read content-free Project monitoring status", "projects", "ProjectMonitoringService.agentStatus", "project.operation.manage", "none", {resource_id_fallback:"project_or_run",check_action_approval_grant:false}),
  gatedProposalAction("project.source.propose_bind", "Propose binding a Source to a Project", "projects", "ProjectSourceBindingService.proposeBind", "project.source.bind", "project_source_bind", "money"),
  gatedProposalAction("project.propose_definition", "Propose the Project goal or core problem", "projects", "ProjectDefinitionProposalService.proposeDefinition", "project.brief.propose", "project_brief_publish", "direction"),
  httpAction("project.operation.read", "Read Project operation progress", "projects", "ProjectOperationService.get", "project.operation.manage", "none"),
  { ...httpAction("project.operation.create", "Create a Project operation", "projects", "ProjectOperationService.create", "project.operation.manage", "durable"), input_schema:ProjectOperationCreateInputSchema, output_schema:ProjectOperationCommandOutputSchema, execution:{kind:"command",tx:"core_owned"} },
  { ...httpAction("project.operation.cancel", "Cancel a Project operation", "projects", "ProjectOperationService.cancel", "project.operation.manage", "durable"), input_schema:ProjectOperationCancelInputSchema, output_schema:ProjectOperationCommandOutputSchema, execution:{kind:"command",tx:"core_owned"} },
  {...httpAction("source.backfill.preview", "Preview Source history import", "sources", "SourceBackfillPlanningService.preview", "source.backfill.plan", "none"),input_schema:SourceBackfillPreviewInputSchema,output_schema:SourceBackfillPreviewOutputSchema,execution:{kind:'query',tx:'core_owned'}},
  {...httpAction("source.backfill.create_plan", "Create Source history import plan", "sources", "SourceBackfillPlanningService.create", "source.backfill.plan", "draft"),input_schema:SourceBackfillCreateInputSchema,output_schema:SourceBackfillReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  gatedProposalAction("source.backfill.propose_start", "Propose Source history import", "sources", "SourceBackfillPlanningService.proposeStart", "source.backfill.plan", "source_backfill_start", "money", { resource_type: "source_backfill_plan", resource_id_input_field: "source_backfill_plan_id", resource_id_fallback: "run" }),
  // The Project write surface. `task.create` and `task.set_status` are
  // gated by trigger origin in `decisionCore.ts`: a person asking for something
  // in the turn is the authorization for it, while the same call from an
  // autonomous wake-up is a commitment made on the Project's behalf and needs
  // to be seen. The other three are append-only or self-limiting — a report
  // only records, a handoff can only give work away, and a review request can
  // only stop work — so they need no origin gate.
  // Every id-taking action below is fed by a read that returns those ids, so
  // the model copies one instead of composing it from a title. Nothing in a
  // conversation's rendered history carries ids: a turn that must address an
  // existing object calls the matching list first.
  action("task.list", "List this Project's Tasks with their ids", "tasks", "PgTaskRepository.listTasks", "task.list", "none", { policyResource: { resource_type: "project", resource_id_fallback: "project_or_run", check_action_approval_grant: false }, inputSchema: proposalInputs["task.list"] }),
  {...agentAction("inquiry.link_task","Create or link a Task to an Inquiry Thread","inquiry","InquiryTaskAssociationService.link","inquiry.work.record","durable",{resource_type:"inquiry_thread",resource_id_input_field:"thread_id",resource_id_fallback:"run",check_action_approval_grant:false}),input_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.link_task"].input,output_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.link_task"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  agentAction("inquiry.list_tasks","Read linked Tasks and their actual Board status","inquiry","InquiryTaskAssociationService.tasks","inquiry.problem.read","none",{resource_type:"inquiry_thread",resource_id_input_field:"thread_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  {...agentAction("inquiry.reference_task_result","Reference a linked Task result in problem work","inquiry","InquiryTaskAssociationService.referenceResult","inquiry.work.record","durable",{resource_type:"inquiry_thread",resource_id_input_field:"thread_id",resource_id_fallback:"run",check_action_approval_grant:false}),input_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.reference_task_result"].input,output_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.reference_task_result"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  agentAction("task.create", "Create a Project Task", "tasks", "PgTaskRepository.createTask", "task.create", "durable", { resource_type: "project", resource_id_input_field: "project_id", resource_id_fallback: "project_or_run", check_action_approval_grant: false }),
  agentAction("task.create_batch", "Create an explicitly requested batch of Project Tasks", "tasks", "PgTaskRepository.createTask", "task.create", "durable", { resource_type: "project", resource_id_fallback: "project_or_run", check_action_approval_grant: false }),
  { ...agentAction("task.report", "Report on a Task", "projectWork", "ProjectWorkTaskActions.report", "task.report", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:TaskReportInputSchema,output_schema:TaskReportOutputSchema,execution:{kind:"command",tx:"core_owned"} },
  { ...agentAction("task.handoff", "Hand off responsibility for a Task", "projectWork", "ProjectWorkTaskActions.handoff", "task.handoff", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:TaskHandoffInputSchema,output_schema:TaskHandoffOutputSchema,execution:{kind:"command",tx:"core_owned"} },
  agentAction("board.read", "Read this Project's columns, status meanings and revision", "projectWork", "getProjectBoard", "board.read", "none", {resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),
  { ...agentAction("board.configure", "Create, rename, delete, reorder, remap or set WIP limits for Board columns; read board.read first", "projectWork", "configureProjectBoard", "board.configure", "durable", {resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}), input_schema:BoardConfigureOperationInputSchema,output_schema:BoardConfigureOperationOutputSchema,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"} },
  { ...agentAction("task.move_to_column", "Move a Task to an exact column from board.read", "projectWork", "moveTaskToColumn", "task.column.move", "durable", {resource_type:"task",resource_id_input_field:"task_id",resource_id_fallback:"run",check_action_approval_grant:false}), input_schema:TaskMoveOperationInputSchema,output_schema:TaskMoveOperationOutputSchema,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"} },
  {...httpAction('task.place_in_space_board','Place a standalone Task on a Space Board','projectWork','placeTaskInSpaceBoard','task.column.move','durable'),input_schema:TaskSpacePlacementInputSchema,output_schema:TaskSpacePlacementOutputSchema,execution:{kind:'command',tx:'core_owned'}},
  { ...agentAction("task.delete", "Delete a Task", "projectWork", "deleteTask", "task.delete", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:TaskDeleteInputSchema,output_schema:TaskDeleteOutputSchema, visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"} },
  { ...agentAction("task.set_status", "Move a Task to its board status", "projectWork", "ProjectWorkTaskActions.setStatus", "task.status.set", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:TaskStatusInputSchema,output_schema:TaskStatusOutputSchema, visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"} },
  // Closing is a commitment, so it is origin-gated like `task.create` and
  // `task.set_status` rather than ungated like the append-only three: a
  // person asking in the turn authorizes it, an autonomous wake-up must be
  // seen. It cannot skip the completion contract the manual close enforces,
  // and unlike a person it cannot override one.
  {...agentAction("workspace.integration.verification.get","Read this integration's Folder verification commands and current retry revision","projectFolders","workspaceVerification.get","workspace.integration.verification.get","none",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceVerificationGetInputSchema,output_schema:WorkspaceVerificationViewSchema,idempotency_required:false,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"query",tx:"core_owned"}},
  {...agentAction("workspace.integration.verification.configure","Advanced legacy verification configuration. Native-session integration uses the Agent’s existing tools and does not require configuring these commands. Save real Folder test/build commands selected and run by the Agent for this legacy integration. Commands execute on its Host, directly without a shell. Read current config first and preserve meaningful checks. The assigned candidate setup Run may report no_project_checks with an explanation after repository inspection; finish that Run so the worker captures, verifies and publishes. Never ask the user to type commands.","projectFolders","workspaceVerification.configure","workspace.integration.verification.configure","durable",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceVerificationConfigureInputSchema,output_schema:WorkspaceVerificationViewSchema,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"}},
  {...agentAction("workspace.integration.retry","Recover a saved integration in the current Agent session; read workspace.change.get and finish prepare/checkpoint/publish before replying. reconcile_only proves prior adoption without publishing.","projectFolders","workspace.integration.retry","workspace.integration.retry","durable",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceIntegrationRetryInputSchema,output_schema:WorkspaceChangeReceiptSchema,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"}},
  {...agentAction("workspace.change.abandon","Abandon the isolated change without publishing","projectFolders","workspace.change.abandon","workspace.change.abandon","durable",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceChangeAbandonInputSchema,output_schema:WorkspaceChangeReceiptSchema,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"}},
  // People manage source retention; Agents never reclaim or hold Git metadata.
  {...agentAction("workspace.retention.update","Reclaim a proven merged/unchanged isolated workspace now, hold it, or retry its cleanup","projectFolders","workspace.retention.update","workspace.retention.update","durable",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceRetentionUpdateInputSchema,output_schema:WorkspaceRetentionReceiptSchema,visibility:visibility("public_api"),allowed_actor_types:["user"],execution:{kind:"command",tx:"core_owned"}},
  {...agentAction("workspace.change.list","List this conversation's (or, as metadata, the Project's) visible workspace change sets with ids, revisions, adoption and whether you may close each; page with next_cursor","projectFolders","workspaceChangeList","workspace.change.list","none",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceChangeListInputSchema,output_schema:WorkspaceChangeListSchema,idempotency_required:false,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"query",tx:"core_owned"}},
  {...agentAction("workspace.branch.align","Align a local branch of a Folder repository to another branch with frozen expected tips and a recovery ref (person only)","projectFolders","workspaceBranchAlign","workspace.branch.align","durable",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceBranchAlignInputSchema,output_schema:WorkspaceBranchAlignReceiptSchema,visibility:visibility("public_api"),allowed_actor_types:["user"],execution:{kind:"command",tx:"core_owned"}},
  {...agentAction("workspace.change.get","Read the actual state of this workspace integration. Wait for pending operations; resolve conflicts and run checks in your current worktree. Only merged/no_changes means publication completed.","projectFolders","workspaceChangeGet","workspace.change.get","none",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceChangeGetInputSchema,output_schema:WorkspaceChangeStatusSchema,idempotency_required:false,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"query",tx:"core_owned"}},
  {...agentAction("workspace.change.complete","Save privately with checkpoint alone, or integrate in this active Agent session: prepare, fix conflicts and check the saved version in your current worktree, then publish with your verification. Read workspace.change.get for each actual result; finish before answering. No verification configuration or separate Agent is needed.","projectFolders","workspaceChangeComplete","workspace.change.complete","durable",{resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false}),input_schema:WorkspaceChangeCompleteInputSchema,output_schema:WorkspaceChangeReceiptSchema,visibility:visibility("agent_tool","public_api"),allowed_actor_types:["user","agent"],execution:{kind:"command",tx:"core_owned"}},
  { ...agentAction("task.complete", "Say a Task's work is finished", "projectWork", "ProjectWorkTaskActions.complete", "task.complete", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:TaskCompleteInputSchema,output_schema:TaskCompleteOutputSchema,execution:{kind:"command",tx:"core_owned"} },
  { ...agentAction("task.request_review", "Ask a person to decide", "projectWork", "ProjectWorkTaskActions.requestReview", "task.request_review", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:TaskReviewInputSchema,output_schema:TaskStatusOutputSchema,execution:{kind:"command",tx:"core_owned"} },
  // Append-only like `task.report`, and ungated at any origin for the same
  // reason: it says what a file is, and a Task closes on the file existing
  // with the declared type — never on the declaration alone.
  agentAction("artifact.submit", "Declare a file this Run produced as a Task's output", "projectWork", "ProjectWorkArtifactDeclarations.submit", "artifact.declare", "durable", { resource_type: "task", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: false }),
  // Granted to one kind of Run only: the handoff turn Rainver dispatches
  // before rotating a Conversation × Agent vendor session.
  agentAction("handoff.write", "Write the handoff your next session starts from", "agentGroups", "AgentHandoffService.write", "handoff.write", "durable", { resource_type: "host_thread", resource_id_fallback: "run", check_action_approval_grant: false }),
  action("proposal.list_pending", "List this conversation's pending Proposals with their ids", "proposals", "PgProposalRepository.listVisible", "proposal.list", "none", { policyResource: { resource_type: "project", resource_id_fallback: "project_or_run", check_action_approval_grant: false }, inputSchema: proposalInputs["proposal.list_pending"] }),
  agentAction("proposal.decide", "Decide a proposal this conversation produced, on the person's instruction", "proposals", "ProposalDecisionExecutor.decide", "proposal.decide", "durable", { resource_type: "proposal", resource_id_input_field: "proposal_id", resource_id_fallback: "run", check_action_approval_grant: false }),
  conditionallyGatedAgentAction("task.plan.propose", "Propose an Agent-generated Task plan", "plans", "PgPlanRepository.createPlanFromAgent", "task.plan.propose", "plan_review", "direction", { resource_type: "plan", resource_id_input_field: "task_id", resource_id_fallback: "run", check_action_approval_grant: true }),
  internalAction("source.backfill.start", "Start approved Source history import", "sources", "SourceBackfillExecutionService.start", "source.backfill.start"),
  {...httpAction("source.backfill.pause", "Pause Source history import", "sources", "SourceBackfillPlanningService.setPaused", "source.backfill.manage", "durable"),input_schema:SourceBackfillControlInputSchema,output_schema:SourceBackfillReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("source.backfill.resume", "Resume Source history import", "sources", "SourceBackfillPlanningService.setPaused", "source.backfill.manage", "durable"),input_schema:SourceBackfillControlInputSchema,output_schema:SourceBackfillReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  // Object-bound user actions are presentation metadata as well as the typed
  // invocation inventory. None is `agent_tool` visible, so adding an advice
  // affordance does not widen an agent's callable surface.
  ...Object.entries(NOTE_OBJECT_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof NOTE_OBJECT_SCHEMAS,NOTE_OBJECT_TITLES[id as keyof typeof NOTE_OBJECT_SCHEMAS],'knowledge','PgKnowledgeRepository / NoteWriteScope','note.edit',id==='knowledge.note.create'?'draft':'durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  {...httpAction("knowledge.note.rollback", "Restore a Note revision", "knowledge", "PgKnowledgeRepository.rollbackNote", "note.edit", "durable"),input_schema:NoteRollbackInputSchema,output_schema:NoteControlReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  {...httpAction("knowledge.note.delete", "Move a Note to trash", "knowledge", "PgKnowledgeRepository.deleteNote", "note.edit", "durable"),input_schema:NoteControlTargetSchema,output_schema:NoteControlReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  ...Object.entries(INQUIRY_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof INQUIRY_OPERATION_SCHEMAS,INQUIRY_OPERATION_TITLES[id as keyof typeof INQUIRY_OPERATION_SCHEMAS],'inquiry','Inquiry domain services','inquiry.workspace.update','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_MANAGEMENT_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_MANAGEMENT_SCHEMAS,PROJECT_MANAGEMENT_TITLES[id as keyof typeof PROJECT_MANAGEMENT_SCHEMAS],'projects','Project workspace services','project.management.write','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries({...SETTINGS_COMMAND_OPERATION_SCHEMAS,...SETTINGS_DIRECT_OPERATION_SCHEMAS}).map(([id,schemas])=>({...httpAction(id as keyof typeof SETTINGS_OPERATION_TITLES,SETTINGS_OPERATION_TITLES[id as keyof typeof SETTINGS_OPERATION_TITLES],settingsOwningModule(id),'System command intents and owning settings/tool configuration services',settingsPolicyAction(id),'durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries({...HOST_COMMAND_OPERATION_SCHEMAS,...HOST_DIRECT_OPERATION_SCHEMAS}).map(([id,schemas])=>({...httpAction(id as keyof typeof HOST_OPERATION_TITLES,HOST_OPERATION_TITLES[id as keyof typeof HOST_OPERATION_TITLES],id.startsWith('host.location.')||id.startsWith('imported_session.')?'importedSessions':'hosts','Host command intents and owning Host/Location services',hostPolicyAction(id),'durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(AGENT_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof AGENT_OPERATION_SCHEMAS,AGENT_OPERATION_TITLES[id as keyof typeof AGENT_OPERATION_SCHEMAS],'agents','Agent definition and conversation services',id==='agent.run.create'?'agent.run.start':id==='agent.chat.reset_context'||id==='conversation.session_config.save'?'agent.conversation.write':'agent.definition.manage','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(AGENT_CHAT_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof AGENT_CHAT_OPERATION_SCHEMAS,AGENT_CHAT_OPERATION_TITLES[id as keyof typeof AGENT_CHAT_OPERATION_SCHEMAS],'agents','Direct Agent conversation turns','agent.run.start','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(ROOM_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof ROOM_OPERATION_SCHEMAS,ROOM_OPERATION_TITLES[id as keyof typeof ROOM_OPERATION_SCHEMAS],'rooms','Room roster, conversation and turn services',/^room\.(create|agent\.|invitation\.|member\.|owner\.)/.test(id)?'room.roster.manage':'room.conversation.write','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(AGENT_GROUP_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof AGENT_GROUP_OPERATION_SCHEMAS,AGENT_GROUP_OPERATION_TITLES[id as keyof typeof AGENT_GROUP_OPERATION_SCHEMAS],'agentGroups','Agent group run services','agent_group.manage','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(RUN_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof RUN_OPERATION_SCHEMAS,RUN_OPERATION_TITLES[id as keyof typeof RUN_OPERATION_SCHEMAS],'runs','Run command services','run.control','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(SESSION_OPERATION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof SESSION_OPERATION_SCHEMAS,SESSION_OPERATION_TITLES[id as keyof typeof SESSION_OPERATION_SCHEMAS],'sessions','Conversation session services',id==='session.reflect'?'proposal.create':'session.write',id==='session.reflect'?'proposal':'durable'),...(id==='session.reflect'?{proposal_type:'memory_create',gate_class:'belief_reach' as const}:{}),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(SESSION_QUERY_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof SESSION_QUERY_SCHEMAS,SESSION_OPERATION_TITLES[id as keyof typeof SESSION_QUERY_SCHEMAS],'sessions','ConversationExecutionContextService.preflight','session.write','none'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'query' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_EXECUTION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_EXECUTION_SCHEMAS,PROJECT_EXECUTION_TITLES[id as keyof typeof PROJECT_EXECUTION_SCHEMAS],'experiments','ExperimentDefinitionService / ExperimentRunService / ExperimentInterpretationService','experiment.command','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_INGRESS_SCHEMAS).map(([id,schemas])=>{const key=id as keyof typeof PROJECT_INGRESS_SCHEMAS;return {...httpAction(key,PROJECT_INGRESS_TITLES[key],'projects',key.startsWith('project.monitoring.')?'ProjectMonitoringService':key==='project.summary.feedback'?'RetrievalFeedbackService.record':'ProjectSourceProposalService',PROJECT_INGRESS_POLICY[key],key in PROJECT_INGRESS_PROPOSALS?'proposal':'durable'),...(key in PROJECT_INGRESS_PROPOSALS?{proposal_type:PROJECT_INGRESS_PROPOSALS[key as keyof typeof PROJECT_INGRESS_PROPOSALS],gate_class:'money' as const}:{}),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}};}),
  ...Object.entries(PROJECT_FOLDER_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_FOLDER_SCHEMAS,PROJECT_FOLDER_TITLES[id as keyof typeof PROJECT_FOLDER_SCHEMAS],'projectFolders','PgProjectFolderRepository / ProjectFolderExecutionConfigRepository','project.folder.command','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_FOLDER_IO_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_FOLDER_IO_SCHEMAS,PROJECT_FOLDER_IO_TITLES[id as keyof typeof PROJECT_FOLDER_IO_SCHEMAS],'projectFolders','Project Folder IO intent and Job owner',id==='project.folder.draft.save'?'project_folder.apply_patch':'project.folder.command','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_CORPUS_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_CORPUS_SCHEMAS,PROJECT_CORPUS_TITLES[id as keyof typeof PROJECT_CORPUS_SCHEMAS],'projects','ProjectCorpusRepository','project.corpus.update','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_SOURCE_PROPOSAL_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_SOURCE_PROPOSAL_SCHEMAS,PROJECT_SOURCE_PROPOSAL_TITLES[id as keyof typeof PROJECT_SOURCE_PROPOSAL_SCHEMAS],'projects','ProjectSourceProposalService.proposeBackfill','source.backfill.plan','proposal'),proposal_type:'source_backfill_start',gate_class:'money' as const,input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  {...httpAction('research.ask_ai','Queue a bounded Research notebook analysis','projectResearch','ProjectResearchAreaService.askAi','research.workspace.update','durable'),input_schema:ResearchAdhocInputSchema,output_schema:ResearchAdhocReceiptSchema,execution:{kind:'command' as const,tx:'core_owned' as const}},
  ...Object.entries(RESEARCH_EXECUTION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof RESEARCH_EXECUTION_SCHEMAS,RESEARCH_EXECUTION_TITLES[id as keyof typeof RESEARCH_EXECUTION_SCHEMAS],'projectResearch','ProjectResearchOrchestrator','research.workspace.update','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(IMPORTED_HISTORY_EXTRACTION_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof IMPORTED_HISTORY_EXTRACTION_SCHEMAS,IMPORTED_HISTORY_EXTRACTION_TITLES[id as keyof typeof IMPORTED_HISTORY_EXTRACTION_SCHEMAS],'importedSessions','ImportedHistoryExtractionService.claim','project.management.write','proposal'),proposal_type:'project_brief_publish',gate_class:'direction' as const,input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(PROJECT_SUMMARY_DRAFT_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof PROJECT_SUMMARY_DRAFT_SCHEMAS,PROJECT_SUMMARY_DRAFT_TITLES[id as keyof typeof PROJECT_SUMMARY_DRAFT_SCHEMAS],'projects',id==='project.summary.brief.request'?'RetrievalSearchService.buildBrief':'ProjectPublicSummaryGenerator.prepareDraft',id==='project.summary.brief.request'?'project.summary.brief.request':'project.management.write','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(RESEARCH_CONTROL_SCHEMAS).map(([id,schemas])=>{const key=id as keyof typeof RESEARCH_CONTROL_SCHEMAS;return {...httpAction(key,RESEARCH_CONTROL_TITLES[key],key==='project.corpus.backfill_sources'?'projects':'projectResearch',key==='project.corpus.backfill_sources'?'ProjectCorpusRepository.backfillFromSources':'ProjectResearchOrchestrator / owning Research services',RESEARCH_CONTROL_POLICY[key],'durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}};}),
  ...Object.entries(RESEARCH_WORKSPACE_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof RESEARCH_WORKSPACE_SCHEMAS,RESEARCH_WORKSPACE_TITLES[id as keyof typeof RESEARCH_WORKSPACE_SCHEMAS],'projectResearch','ProjectResearchRepository / ProjectResearchAreaService','research.workspace.update','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  {...httpAction('knowledge.candidate.extract','Queue Knowledge Candidate extraction','knowledgePromotion','KnowledgeExtractionService.queue','inquiry.knowledge.promote','durable'),input_schema:KnowledgeExtractionInputSchema,output_schema:KnowledgeExtractionReceiptSchema,execution:{kind:'command' as const,tx:'core_owned' as const}},
  ...Object.entries(KNOWLEDGE_REVIEW_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof KNOWLEDGE_REVIEW_SCHEMAS,KNOWLEDGE_REVIEW_TITLES[id as keyof typeof KNOWLEDGE_REVIEW_SCHEMAS],'knowledgePromotion','KnowledgePromotionCandidateService / PgKnowledgeRepository',id==='knowledge.candidate.decide'?'proposal.create':id.startsWith('knowledge.evidence.')?'source.item_update':'inquiry.knowledge.promote','durable'),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  ...Object.entries(KNOWLEDGE_OBJECT_SCHEMAS).map(([id,schemas])=>({...httpAction(id as keyof typeof KNOWLEDGE_OBJECT_SCHEMAS,({'note.promote_to_knowledge':'Promote a passage to a Knowledge Item','knowledge.source.create':'Create an evidence Source','knowledge.source.update':'Edit an evidence Source','knowledge.source.archive':'Archive an evidence Source'} as Record<string,string>)[id]!,'knowledge','PgKnowledgeRepository',id==='note.promote_to_knowledge'?'proposal.create':id==='knowledge.source.create'?'source.item_create':'source.item_update',id==='note.promote_to_knowledge'?'proposal':id==='knowledge.source.create'?'draft':'durable'),...(id==='note.promote_to_knowledge'?{applies_to:['note'],proposal_type:'knowledge_create',gate_class:'exposure' as const}:{}),input_schema:schemas.input,output_schema:schemas.output,execution:{kind:'command' as const,tx:'core_owned' as const}})),
  {...httpAction("inquiry.thread.create", "Create an Inquiry Thread", "inquiry", "InquiryThreadService.createThread", "inquiry.thread.create", "durable"),input_schema:InquiryThreadCreateInputSchema,output_schema:InquiryThreadCreateReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  {...objectAction("note.raise_as_question", "Raise a passage as a Question", "inquiry", "InquiryThreadService.createThread", "inquiry.thread.create", "durable", ["note"]),input_schema:NoteQuestionInputSchema,output_schema:NoteQuestionReceiptSchema,execution:{kind:'command',tx:'core_owned'}},
  objectAction("note.link_to_evidence", "Link a passage to evidence", "knowledge", "PgKnowledgeRepository.createNoteLink", "note.link.create", "durable", ["note"]),
  objectAction("source.raise_as_question", "Explore as a Question", "inquiry", "InquiryThreadService.createThread", "inquiry.thread.create", "durable", ["source"]),
  // The deterministic way for an Agent to learn a Thread's id: a read that
  // returns the Project's active Threads with their ids, so the id a later
  // thread-bound action carries is copied from a tool result, never composed
  // by the model from the statement. A made-up slug fails
  // `research.start_acquisition` as an opaque 404. Copy the id from this
  // tool result.
  action("inquiry.list_threads", "List this Project's active Inquiry Threads with their ids", "inquiry", "InquiryThreadService.listThreads", "inquiry.thread.list", "none", { policyResource: { resource_type: "project", resource_id_fallback: "project_or_run", check_action_approval_grant: false }, inputSchema: proposalInputs["inquiry.list_threads"] }),
  // The Agent's own memory, bounded rather than pre-approved (ADR 0003).
  // These two actions are how an Agent writes memory from a conversation.
  // Do not leave only the retrieval actions. Nothing would write.
  agentAction("memory.remember", "Remember something across sessions", "memory", "PgMemoryApplyRepository.applyDirect", "memory.write", "durable", { resource_type: "memory_entry", resource_id_fallback: "run", check_action_approval_grant: false }),
  agentAction("memory.revise", "Revise a memory this Agent wrote", "memory", "PgMemoryApplyRepository.applyDirect", "memory.write", "durable", { resource_type: "memory_entry", resource_id_input_field: "memory_id", resource_id_fallback: "run", check_action_approval_grant: false }),
  // Direct, origin-gated and bounded (ADR 0017 §2). Do not draft the split as
  // N proposals. Splitting a question is one judgement a person made when they
  // asked; approving each draft would take that judgement N times. What holds
  // the bound is the trigger origin — an unattended run still waits — the
  // per-turn fan-out bound, and Updates, where every Thread an Agent opens can
  // be archived in one click.
  agentAction("inquiry.create_thread", "Open an Inquiry Thread", "inquiry", "InquiryThreadService.createThread", "inquiry.thread.create", "durable", { resource_type: "project", resource_id_fallback: "project_or_run", check_action_approval_grant: false }),
  // A conclusion is the Thread's own state and every Iteration keeps the
  // position it replaced, so it is recorded and revertible rather than
  // pre-approved.
  agentAction("inquiry.read_problem","Read bounded problem history","inquiry","InquiryProblemEngineService.projection","inquiry.problem.read","none",{resource_type:"inquiry_thread",resource_id_input_field:"thread_id",resource_id_fallback:"run",check_action_approval_grant:false}),
  {...agentAction("inquiry.record_work", "Record problem work or select a method", "inquiry", "InquiryProblemEngineService.recordWork", "inquiry.work.record", "durable", {resource_type:"inquiry_thread",resource_id_input_field:"thread_id",resource_id_fallback:"run",check_action_approval_grant:false}),input_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.record_work"].input,output_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.record_work"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  {...agentAction("inquiry.close_round", "Close a problem round without changing judgment", "inquiry", "InquiryProblemEngineService.closeRound", "inquiry.round.close", "durable", {resource_type:"inquiry_thread",resource_id_input_field:"thread_id",resource_id_fallback:"run",check_action_approval_grant:false}),input_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.close_round"].input,output_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.close_round"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  {...agentAction("inquiry.record_conclusion", "Record an Inquiry Thread conclusion", "inquiry", "InquiryIterationService.recordIteration", "inquiry.iteration.record", "durable", { resource_type: "inquiry_thread", resource_id_input_field: "thread_id", resource_id_fallback: "run", check_action_approval_grant: false }),input_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.record_conclusion"].input,output_schema:INQUIRY_AGENT_OPERATION_SCHEMAS["inquiry.record_conclusion"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  // Runtime `proposal_type` is `knowledge_create` or `knowledge_update`
  // (revalidation branch) depending on `supersedes_knowledge_item_id`;
  // `knowledge_create` here is descriptive metadata only — nothing currently
  // compares it for equality (see `acceptAgentProposalIfGranted`). This
  // action is not on that auto-apply path.
  gatedProposalAction("inquiry.promote_knowledge", "Propose promoting a concluded Inquiry round to Knowledge", "inquiry", "KnowledgePromotionCandidateService.proposeFromThreadForAgent", "inquiry.knowledge.promote", "knowledge_create", "exposure"),
  ...(["list", "records", "read"] as const).map(operation => agentAction(`project.reading.${operation}`, {list:"Find this Project's Reading materials by title",records:"List retained originals and existing analyses for a Reading material",read:"Read a retained Reading original or analysis; copy IDs from project.reading.records"}[operation], "sources", "ProjectReadingTools", "project.reading.read", "none", {resource_type:"project",resource_id_fallback:"project_or_run",check_action_approval_grant:false})),
  agentAction("research.read_result","Read bound research result","projectResearch","ResearchProblemResultService.read","research.result.read","none",{resource_type:"project_operation",resource_id_input_field:"operation_id",resource_id_fallback:"run",check_action_approval_grant:false},"research"),
  {...agentAction("research.adopt_result","Assess research result in Inquiry Verify","projectResearch","ResearchProblemResultService.adopt","research.result.adopt","durable",{resource_type:"project_operation",resource_id_input_field:"operation_id",resource_id_fallback:"run",check_action_approval_grant:false},"research"),output_schema:RESEARCH_AGENT_OPERATION_SCHEMAS["research.adopt_result"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  // Direct execution, no proposal gate. The Thread was already
  // human-accepted at creation, so starting acquisition on it is execution,
  // not an agent-drafted structure/content write. Idempotency guards in the
  // acquisition service are the confirmation.
  {...agentAction("research.start_acquisition", "Start tracked research acquisition", "projectResearch", "ResearchAcquisitionService.startAcquisition", "research.acquisition.start", "durable", { resource_type: "inquiry_thread", resource_id_input_field: "thread_id", resource_id_fallback: "run", check_action_approval_grant: false }, "research"),output_schema:RESEARCH_AGENT_OPERATION_SCHEMAS["research.start_acquisition"].output,execution:{kind:"command" as const,tx:"core_owned" as const}},
  // The symmetric stop for the action above. Direct execution for the same
  // reason: a stop that waits on a proposal review is not a stop.
  action("research.list_operations", "List this Project's research Operations with their ids", "projectResearch", "ProjectOperationService.list", "research.operation.list", "none", { policyResource: { resource_type: "project", resource_id_fallback: "project_or_run", check_action_approval_grant: false }, agentToolSurface: "research", inputSchema: proposalInputs["research.list_operations"] }),
  { ...agentAction("research.cancel_acquisition", "Cancel a running research acquisition", "projectResearch", "ResearchOperationCancelService.cancelOperation", "research.acquisition.cancel", "durable", { resource_type: "project_operation", resource_id_input_field: "operation_id", resource_id_fallback: "run", check_action_approval_grant: false }, "research"), visibility: visibility("agent_tool", "public_api"), allowed_actor_types: ["user", "agent"], execution: {kind:"command",tx:"core_owned"}, output_schema:z.object({operation_id:z.string(),status:z.literal("cancelled"),already_terminal:z.boolean()}).strict() },
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
    gate_class: null,
    grantable: sideEffects === "proposal",
    agent_tool_surface: options.agentToolSurface ?? "generic",
    policy_adapter: options.policyAdapter ?? "declared_resource",
    ...(options.policyResource ? { policy_resource: options.policyResource } : {}),
  };
}

/** The owning module of a system settings / tool configuration operation. */
function settingsOwningModule(id:string):string{
  if(id.startsWith('provider.'))return 'providers';
  if(id.startsWith('network_profile.'))return 'networkProfiles';
  if(id.startsWith('acp_agent.'))return 'acpAgents';
  if(id.startsWith('official_plugin.'))return 'plugins';
  if(id==='system.backup.create')return 'backups';
  if(id.startsWith('source_catalog.'))return 'sources';
  if(id.startsWith('deployment.'))return 'deployment';
  if(id.startsWith('notification.'))return 'notifications';
  return 'system';
}
/** The policy action a settings block operation is enforced under. */
function settingsPolicyAction(id:string):PolicyActionId{
  if(id==='provider.task_policy.set'||id==='provider.task_policy.delete'||id==='provider.subscription_quota_policy.set')return 'provider.space_policy.manage';
  if(id.startsWith('provider.'))return 'provider.manage';
  if(id.startsWith('network_profile.'))return 'network_profile.manage';
  if(id.startsWith('official_plugin.'))return 'official_plugin.manage';
  if(id.startsWith('deployment.'))return 'deployment.job.manage';
  if(id==='notification.webhook.dispatch')return 'notification.webhook.dispatch';
  return 'instance.settings.manage';
}

/** The policy action a Host block operation is enforced under. */
function hostPolicyAction(id:string):PolicyActionId{
  if(id==='host.workspace.register')return 'host.workspace.register';
  if(id==='host.ordinary_tool.account.logout')return 'host.account.manage';
  if(id==='agent.host_state.reset')return 'agent.host_state.reset';
  if(id.startsWith('host.location.')||id.startsWith('imported_session.'))return 'host.import.manage';
  return 'host.manage';
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
    gate_class: null,
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
    // An object action that drafts a Knowledge Item leaves the Project for
    // Space-level Knowledge, which is a change in who can see it.
    gate_class: sideEffects === "proposal" ? "exposure" : null,
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
/**
 * An action whose write waits for a person, and says why
 * ([ADR 0017](../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md) §1/§5).
 *
 * The gate class is a required argument. Do not default it. An action that
 * cannot name its class is not a proposal action; it is a direct write
 * governed by trigger origin and bounds.
 */
function gatedProposalAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, proposalType: string, gateClass: SystemActionGateClass, policyResource: Partial<Pick<SystemActionPolicyResource, "resource_type" | "resource_id_input_field" | "resource_id_fallback">> = {}): SystemActionDefinition & { readonly id: Id } {
  return { id, version: 1, title, description: title, visibility: visibility("agent_tool", "public_api"),
    allowed_actor_types: ["user", "agent"], input_schema: proposalInputs[id]??objectInput, output_schema: proposalOutput,
    owning_module: owningModule, application_service: applicationService, policy_action: policyAction,
    side_effects: "proposal", idempotency_required: true, proposal_type: proposalType, gate_class: gateClass, grantable: true,
    agent_tool_surface: "generic", policy_adapter: "declared_resource",
    policy_resource: { resource_id_fallback: "project_or_run", check_action_approval_grant: true, ...policyResource } };
}

function agentAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, sideEffects: SystemActionSideEffects, policyResource: SystemActionPolicyResource, agentToolSurface: SystemActionAgentToolSurface = "generic"): SystemActionDefinition & { readonly id: Id } {
  return { id, version: 1, title, description: title, visibility: visibility("agent_tool"), allowed_actor_types: ["agent"],
    input_schema: proposalInputs[id] ?? objectInput, output_schema: proposalOutput, owning_module: owningModule,
    application_service: applicationService, policy_action: policyAction, side_effects: sideEffects,
    idempotency_required: true, proposal_type: null, gate_class: null, grantable: false, policy_resource: policyResource,
    agent_tool_surface: agentToolSurface, policy_adapter: "declared_resource" };
}

/**
 * An Agent action that writes directly inside its declared bounds and files a
 * `proposalType` proposal, gated by `gateClass`, past them. The class is a
 * required argument for the same reason `gatedProposalAction`'s is.
 */
function conditionallyGatedAgentAction<const Id extends string>(id: Id, title: string, owningModule: string, applicationService: string, policyAction: PolicyActionId, proposalType: string, gateClass: SystemActionGateClass, policyResource: SystemActionPolicyResource): SystemActionDefinition & { readonly id: Id } {
  return { ...agentAction(id, title, owningModule, applicationService, policyAction, "conditional_proposal", policyResource),
    proposal_type: proposalType, gate_class: gateClass };
}

function internalAction<const Id extends string>(id:Id,title:string,owningModule:string,applicationService:string,policyAction:PolicyActionId):SystemActionDefinition&{readonly id:Id}{
  return{id,version:1,title,description:title,visibility:visibility("internal_only","system_job"),allowed_actor_types:["user","system"],input_schema:objectInput,output_schema:objectOutput,owning_module:owningModule,application_service:applicationService,policy_action:policyAction,side_effects:"durable",idempotency_required:true,proposal_type:null,gate_class:null,grantable:false};
}

/**
 * The actions that apply to an ontology object type (ADR 0012 decision 8).
 *
 * `applies_to` is how a surface rendering an object — or a selection inside
 * one — asks the registry what it can offer. Do not hard-code that menu. An
 * action with no `applies_to` is not object-bound and never appears here.
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
 * canonical Zod, with bounded Agent-only Board field projection below.
 * One source: the Run-scoped tool surface's
 * `list`/`describe` and the managed loop's tool assembly both read this rather
 * than a hand-maintained literal that can drift from what actually validates.
 *
 * `$schema` is stripped — a meta-schema pointer is Draft-7 tooling noise on a
 * tool-call payload. Do not send it.
 */
export function systemActionInputJsonSchema(
  definition: Pick<SystemActionDefinition, "input_schema"> & {id?:string},
): Record<string, unknown> {
  // Bounded Agent-tool projection; canonical operation schemas retain human fields.
  const reason=BoardConfigureOperationInputSchema.shape.reason.removeDefault().unwrap();
  const input=definition.id==='board.configure'
    ? BoardConfigureOperationInputSchema.extend({reason})
    : definition.id==='task.move_to_column'
      ? TaskMoveOperationInputSchema.omit({override_completion:true}).extend({reason})
      : definition.id==='task.set_status'
        ? TaskStatusInputSchema.omit({override_completion:true,blocked_reason:true}).extend({reason:TaskStatusInputSchema.shape.reason.removeDefault().unwrap()})
        : definition.id==='task.delete'
          ? TaskDeleteInputSchema.extend({reason:TaskDeleteInputSchema.shape.reason.removeDefault().unwrap()})
          : definition.input_schema;
  const schema = zodToJsonSchema(input, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}
