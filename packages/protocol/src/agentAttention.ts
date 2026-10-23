import { z } from "zod";
import { ContentAccessLevelSchema, IdSchema, ISODateTimeSchema, RunTriggerOriginSchema } from "./common.js";
import { RunContractSourceKindSchema, RunStatusSchema } from "./runOrchestration.js";
import { RunResourceWaitCodeSchema, RunTurnSchema } from "./turnParts.js";
import { ResponsibleActorSchema, TASK_STATUSES, TaskMergeBlockedOutcomeSchema, TaskWorkViewResponseSchema, WorkLoopStageKeySchema } from "./projectWork.js";
import { AgentRunGroupMemberRoleSchema } from "./agentGroupRuns.js";
import { RunDTOSchema } from "./schemas.js";

/** Read identities, never execution authority. Room conversations use their Session id. */
export const AgentWorkIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task"),
    source_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("session"),
    source_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("agent_group"),
    source_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("run"),
    source_id: IdSchema,
  }).strict(),
]);
export type AgentWorkIdentity = z.infer<typeof AgentWorkIdentitySchema>;
export const AgentAttentionScopeSchema = z.enum(["mine", "all_visible"]);
export const AgentAttentionGroupSchema = z.enum(["needs_you", "recently_finished", "working", "waiting", "idle"]);

/** Reasons reference owning resources; no prompt/output text classification. */
export const AgentAttentionReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("awaiting_answer"),
    message_id: IdSchema,
    session_id: IdSchema,
    agent_id: IdSchema,
    responsible: ResponsibleActorSchema,
  }).strict(),
  z.object({
    kind: z.literal("authorization"),
    run_id: IdSchema,
    authorization_request_id: IdSchema.nullable(),
    responsible: ResponsibleActorSchema,
  }).strict(),
  z.object({
    kind: z.literal("run_decision"),
    run_id: IdSchema,
    responsible: ResponsibleActorSchema,
  }).strict(),
  z.object({
    kind: z.literal("task"),
    task_id: IdSchema,
    status: z.enum(TASK_STATUSES),
    responsible: ResponsibleActorSchema,
  }).strict(),
  z.object({
    kind: z.literal("task_merge"),
    task_id: IdSchema,
    merge_id: IdSchema,
    /** Owning Task merge outcome, never its outcome:hash event deduplication key. */
    code: TaskMergeBlockedOutcomeSchema,
    responsible: ResponsibleActorSchema,
  }).strict(),
  z.object({
    kind: z.literal("proposal"),
    proposal_id: IdSchema,
    responsible: ResponsibleActorSchema,
  }).strict(),
  // Resource codes use RunResourceWaitCodeSchema; Task merge codes use its owning outcome schema.
  z.object({
    kind: z.literal("resource"),
    run_id: IdSchema,
    code: RunResourceWaitCodeSchema,
    dependency_run_ids: z.array(IdSchema).max(100),
  }).strict(),
]);
export type AgentAttentionReason = z.infer<typeof AgentAttentionReasonSchema>;

export const AgentAttentionRevisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    schema_version: z.literal(1),
    message_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("run_result"),
    schema_version: z.literal(1),
    run_id: IdSchema,
    attempt_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("authorization"),
    schema_version: z.literal(1),
    authorization_request_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("run_decision"),
    schema_version: z.literal(1),
    run_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("proposal"),
    schema_version: z.literal(1),
    proposal_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("task"),
    schema_version: z.literal(1),
    task_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("task_merge"),
    schema_version: z.literal(1),
    merge_id: IdSchema,
    revision: z.string().min(1).max(256),
  }).strict(),
]);
export const AgentAttentionReadStateSchema = z.object({
  /** Exactly the displayed source revision; never a parent-wide acknowledgement. */
  subject: AgentAttentionRevisionSchema,
  unread: z.boolean(),
  manual_unread: z.boolean(),
  read_at: ISODateTimeSchema.nullable(),
  state_version: z.number().int().nonnegative(),
}).strict();

export const AgentAttentionRunSchema = z.object({
  run_id: IdSchema,
  agent_id: IdSchema,
  /** Bounded display metadata from the authorized Run; no Agent configuration. */
  agent_name: z.string().max(500).nullable().optional(),
  runtime_key: z.string().max(64).nullable().optional(),
  started_at: ISODateTimeSchema.nullable().optional(),
  status: RunStatusSchema,
  /** Copied from the owning Turn reader; not derived from status here. */
  turn_state: RunTurnSchema.shape.state.nullable(),
  blocked_on: RunTurnSchema.shape.blocked_on,
  trigger_origin: RunTriggerOriginSchema,
  parent_run_id: IdSchema.nullable(),
  root_run_id: IdSchema.nullable(),
  cause_run_id: IdSchema.nullable(),
  run_group_id: IdSchema.nullable(),
  delegation_id: IdSchema.nullable(),
  session_id: IdSchema.nullable(),
  room_id: IdSchema.nullable(),
  /** Collaboration group member role; not the Task execution link's role. */
  task_role: AgentRunGroupMemberRoleSchema.nullable(),
  /** task_runs.role remains an owning-domain string (primary/planning/review/merge). */
  task_run_role: TaskWorkViewResponseSchema.shape.runs.element.shape.role.nullable(),
  /** Executable Run versus orchestration coordinator. */
  run_role: RunDTOSchema.shape.run_role,
  plan_id: IdSchema.nullable(),
  plan_node_id: IdSchema.nullable(),
  workflow_execution_id: IdSchema.nullable(),
  /** Immutable contract provenance, which can have no source object id. */
  contract_source: z.object({
    kind: RunContractSourceKindSchema,
    id: IdSchema.nullable(),
  }).strict().nullable(),
  automation_id: IdSchema.nullable(),
  autonomy_tick_id: IdSchema.nullable(),
  autonomy_candidate_id: IdSchema.nullable(),
  owner_user_id: IdSchema.nullable(),
  instructed_by_user_id: IdSchema.nullable(),
  ended_at: ISODateTimeSchema.nullable(),
  retry_of_run_id: IdSchema.nullable(),
  retry_superseded: z.boolean(),
}).strict();
export type AgentAttentionRun = z.infer<typeof AgentAttentionRunSchema>;

/** Known commands map to existing clients; descriptors never grant permission. */
export const AgentAttentionOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open_session"),
    space_id: IdSchema,
    session_id: IdSchema,
    room_id: IdSchema.nullable(),
    agent_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("open_task"),
    space_id: IdSchema,
    task_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("stop_run"),
    space_id: IdSchema,
    run_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("resume_run"),
    space_id: IdSchema,
    run_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("authorization"),
    space_id: IdSchema,
    authorization_request_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("run_decision"),
    space_id: IdSchema,
    run_id: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal("proposal"),
    space_id: IdSchema,
    proposal_id: IdSchema,
  }).strict(),
]);
export const AgentWorkItemSchema = z.object({
  identity: AgentWorkIdentitySchema,
  /** Opaque locator issued by the server, never permission to execute. */
  work_key: z.string().min(1).max(512),
  space_id: IdSchema,
  project_id: IdSchema.nullable(),
  title: z.string().max(500),
  /** Provenance only; never merges Task execution into its originating conversation. */
  source_run_id: IdSchema.nullable(),
  access_level: ContentAccessLevelSchema,
  group: AgentAttentionGroupSchema,
  /** Personal association after access checks; all_visible grants no extra actions. */
  mine: z.boolean(),
  responsible: ResponsibleActorSchema,
  task_status: z.enum(TASK_STATUSES).nullable(),
  loop_stage: WorkLoopStageKeySchema.nullable(),
  /** Task acceptance remains separate from Run/Turn completion. */
  task_completed_at: ISODateTimeSchema.nullable(),
  runs: z.array(AgentAttentionRunSchema).max(100),
  reasons: z.array(AgentAttentionReasonSchema).max(100),
  read_states: z.array(AgentAttentionReadStateSchema).max(100),
  unread: z.boolean(),
  /** Business activity time; reading cannot extend the retention window. */
  last_activity_at: ISODateTimeSchema,
  /** All visible members before child pagination; never counts hidden members. */
  visible_run_count: z.number().int().nonnegative(),
  runs_next_cursor: z.string().max(2048).nullable(),
  operations: z.array(AgentAttentionOperationSchema).max(100),
}).strict();
export type AgentWorkItem = z.infer<typeof AgentWorkItemSchema>;

export const AgentAttentionQuerySchema = z.object({
  scope: AgentAttentionScopeSchema.default("mine"),
  space_id: IdSchema.optional(),
  project_id: IdSchema.optional(),
  group: AgentAttentionGroupSchema.optional(),
  /** History uses the same sources/access gates, with optional time bounds. */
  view: z.enum(["current", "history"]).default("current"),
  since: z.string().datetime({
    offset: true,
  }).optional(),
  until: z.string().datetime({
    offset: true,
  }).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  /** Bounds transport only, never the complete eligible candidate set. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().superRefine((query, ctx) => {
  if (query.since && query.until && Date.parse(query.since) >= Date.parse(query.until)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["until"],
      message: "until must follow since",
    });
  }
  if (query.view === "current" && (query.since || query.until)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["view"],
      message: "Time windows require history",
    });
  }
});
export type AgentAttentionQuery = z.infer<typeof AgentAttentionQuerySchema>;
export type AgentAttentionQueryInput = z.input<typeof AgentAttentionQuerySchema>;
export const AgentAttentionPageSchema = z.object({
  items: z.array(AgentWorkItemSchema).max(100),
  next_cursor: z.string().max(2048).nullable(),
  /** Complete eligible visible counts before pagination/group filter. */
  counts: z.object({
    needs_you: z.number().int().nonnegative(),
    recently_finished: z.number().int().nonnegative(),
    working: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    idle: z.number().int().nonnegative(),
  }).strict(),
  as_of: ISODateTimeSchema,
}).strict();
export const AgentAttentionReadRequestSchema = z.object({
  identity: AgentWorkIdentitySchema,
  space_id: IdSchema,
  subject: AgentAttentionRevisionSchema,
  state_version: z.number().int().nonnegative(),
  action: z.enum(["read", "unread"]),
}).strict();
/** A conversation surface saying which messages it displayed; the server decides what that reads. */
export const AgentAttentionViewRequestSchema = z.object({
  space_id: IdSchema,
  session_id: IdSchema,
  message_ids: z.array(IdSchema).min(1).max(200),
}).strict();
export const AgentAttentionViewResultSchema = z.object({
  read_count: z.number().int().nonnegative(),
  /** Only the exact revisions/versions this report successfully wrote. */
  read_states: z.array(AgentAttentionReadStateSchema).max(200),
}).strict();
export type AgentAttentionPage = z.infer<typeof AgentAttentionPageSchema>;
export type AgentAttentionReadRequest = z.infer<typeof AgentAttentionReadRequestSchema>;
export type AgentAttentionViewRequest = z.infer<typeof AgentAttentionViewRequestSchema>;
export type AgentAttentionViewResult = z.infer<typeof AgentAttentionViewResultSchema>;
export type AgentAttentionReadState = z.infer<typeof AgentAttentionReadStateSchema>;
export type AgentAttentionRevision = z.infer<typeof AgentAttentionRevisionSchema>;
export type AgentAttentionOperation = z.infer<typeof AgentAttentionOperationSchema>;

/** Delivery identity is an exact source revision, never a personal read decision. */
export const AgentAttentionNoticeSchema = z.object({
  key: z.string().min(1).max(256),
  work_key: z.string().min(1).max(512),
  kind: z.enum(["answer", "decision", "finished", "failed"]),
}).strict();
export type AgentAttentionNotice = z.infer<typeof AgentAttentionNoticeSchema>;
export const AgentAttentionStreamFrameSchema = z.object({
  type: z.enum(["attention.snapshot", "attention.invalidation", "attention.resync", "attention.heartbeat", "attention.denied"]),
  /** Starts at one per connection; not a global business cursor. */
  seq: z.number().int().positive(),
  version: z.string().max(256),
  page: AgentAttentionPageSchema.nullable(),
  /** Complete group counts even when the unchanged display window is omitted. */
  counts: AgentAttentionPageSchema.shape.counts.optional(),
  unread_count: z.number().int().nonnegative(),
  notices: z.array(AgentAttentionNoticeSchema).max(100),
}).strict();
export type AgentAttentionStreamFrame = z.infer<typeof AgentAttentionStreamFrameSchema>;
