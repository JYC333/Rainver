import { z } from 'zod';
import { IdSchema } from './common.js';

/** Logical identity only; the Host owns every physical path. */
export const ExecutionWorkspaceRefSchema = z.object({
  id: z.string().uuid(),
  generation: z.number().int().positive(),
  base_commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/).optional(),
  target_ref: z.string().min(1).max(256).optional(),
  integration_id: z.string().uuid().optional(),
  cwd_subpath:z.string().max(4096).refine(p=>!p.startsWith("/")&&!p.includes("\\")&&p.split("/").every(s=>s!==".."&&s!=="."),"invalid workspace subpath").optional(),
  baseline_mode:z.enum(["committed","snapshot"]).optional(),
  sync_to_target:z.boolean().optional(),
  // A reclaimed source keeps its logical identity. The epoch fences cleanup of an
  // older materialization; the floor keeps launch sequences monotonic after the
  // Host's sequence receipt was reclaimed with it.
  materialization_epoch:z.number().int().nonnegative().optional(),
  launch_sequence_floor:z.number().int().nonnegative().max(2147483646).optional(),
}).strict();
export type ExecutionWorkspaceRef = z.infer<typeof ExecutionWorkspaceRefSchema>;
export const WorkspaceAgentVerificationSchema=z.object({
 commit:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
 checks:z.array(z.object({command:z.string().trim().min(1).max(4000),summary:z.string().trim().min(1).max(2000)}).strict()).max(50),
 note:z.string().trim().min(1).max(4000),
}).strict();
export const WorkspaceChangeCompleteInputSchema = z.object({
  change_set_id: IdSchema, expected_revision: z.number().int().positive(), summary: z.string().trim().min(1).max(16000),
  commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional().describe('Explicit existing single commit to publish instead of an empty workspace snapshot. Its parent must belong to target history. Resolve this ID from your own Git operations; never ask the person to copy a commit ID. Never submit a private snapshot or an entire branch.'),
  action:z.enum(['prepare','checkpoint','publish','reconcile']).optional().describe('During an active Agent turn: prepare integrates the target into this same worktree; checkpoint saves a private version without requesting publication when prepare has not been called; publish finishes after your checks. Read workspace.change.get for the actual result before replying.'),
  verification:WorkspaceAgentVerificationSchema.optional().describe('Your checks on the saved version in this same Agent environment; required for publish. Use an empty checks array with an honest note only when no applicable checks exist.'),
}).strict();
export const WorkspaceChangeGetInputSchema=z.object({change_set_id:IdSchema}).strict();
export const WorkspaceNativeProgressSchema=z.object({
 request_id:IdSchema,action:z.enum(['prepare','checkpoint','publish','reconcile']),
 status:z.enum(['pending','prepared','conflict','checkpointed','merged','no_changes','target_moved','failed']),
 commit:z.string().nullable(),onto_commit:z.string().nullable(),conflicted_files:z.array(z.string()),error:z.string().nullable(),
}).strict();
export const WorkspaceIntegrationRetryInputSchema = z.object({
  integration_id: IdSchema, expected_revision: z.number().int().positive(),
  resolution: z.string().trim().min(1).max(4000).optional().describe('Content-resolution instruction supplied by the original requesting human through the conflict dialog. Agent callers must omit this field.'),
  reconcile_only:z.boolean().optional().describe('Only check whether the target already contains the frozen change and close it if proven; do not start a new repair or publication.'),
  repair_instruction: z.string().trim().min(1).max(4000).optional().describe('Agent guidance for resolving the saved conflict in the current native session and worktree. No additional Agent Run is created on native-integration Hosts. Explain the intended resolution from the user request; do not claim a human approval. Candidate verification and publication checks still apply. Omit resolution when using this field.'),
}).strict().refine(input=>!(input.resolution&&input.repair_instruction),'Choose a human resolution or an Agent repair instruction, not both').refine(v=>!v.reconcile_only||!v.resolution&&!v.repair_instruction,'Reconciliation cannot carry a repair instruction');
export const WorkspaceChangeAbandonInputSchema = z.object({
  change_set_id: IdSchema, expected_revision: z.number().int().positive(), reason: z.string().trim().min(1).max(4000),
}).strict();
export const WorkspaceChangeReceiptSchema = z.object({
  change_set_id: IdSchema, revision: z.number().int().positive(), state: z.string(), integration_id: IdSchema.nullable(),
  progress:WorkspaceNativeProgressSchema.nullable().optional(),
}).strict();
export const WorkspaceChangeStatusSchema=WorkspaceChangeReceiptSchema.extend({
 can_retry:z.boolean(),integration_status:z.string().nullable(),conversation_id:IdSchema.nullable(),room_id:IdSchema.nullable(),agent_id:IdSchema.nullable(),folder_name:z.string(),source_commit:z.string().nullable(),
});
export const ExecutionWorkspaceCapabilitySchema = z.object({version:z.union([z.literal(1),z.literal(2)]),reclaim:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4)]).optional()}).strict();

/** Visible retention of one workspace generation. Reasons are stable codes. */
export const WorkspaceRetentionSchema=z.object({
 state:z.enum(['active','grace','reclaimable','reclaiming','reclaimed','retained','held','blocked']),
 reason:z.string().max(64),
 reclaim_after:z.string().nullable(),hold_until:z.string().nullable(),reclaimed_at:z.string().nullable(),assessed_at:z.string().nullable(),
 retained_refs:z.number().int().nonnegative(),unclaimed_refs:z.number().int().nonnegative(),
}).strict();
export type WorkspaceRetention=z.infer<typeof WorkspaceRetentionSchema>;
export const WorkspaceRetentionUpdateInputSchema=z.object({
 change_set_id:IdSchema,
 action:z.enum(['reclaim_now','hold','release_hold','retry']).describe('reclaim_now skips only the short grace for a proven merged/unchanged source; hold postpones automatic reclamation; retry re-delivers blocked cleanup.'),
 hold_days:z.number().int().min(1).max(90).optional(),
}).strict().refine(v=>v.action==='hold'?v.hold_days!==undefined:v.hold_days===undefined,'hold_days is required for hold only');
export const WorkspaceRetentionReceiptSchema=z.object({workspace_id:IdSchema,retention:WorkspaceRetentionSchema}).strict();

export const WorkspaceChangeViewSchema=z.object({
 change_set_id:IdSchema,workspace_id:IdSchema,generation:z.number().int().positive(),revision:z.number().int().positive(),
 workspace_location_id:IdSchema,parent_workspace_id:IdSchema.nullable(),target_ref:z.string().nullable(),
 state:z.enum(['open','ready','integrating','blocked','integrated','no_changes','abandoned']),summary:z.string().nullable(),
 base_commit:z.string().nullable(),source_commit:z.string().nullable(),workspace_state:z.string(),baseline_mode:z.string().nullable(),
 cleanup_state:z.enum(['pending','running','retry_wait','blocked','cleaned']),cleanup_errors:z.array(z.string()),retention:WorkspaceRetentionSchema.optional(),native_integration:z.boolean().optional(),inventory:z.record(z.unknown()).optional(),can_manage:z.boolean(),
 integration_id:IdSchema.nullable(),integration_revision:z.number().int().positive().nullable(),integration_status:z.string().nullable(),attempt_id:IdSchema.nullable(),
 resolution_run_id:IdSchema.nullable().optional(),
 onto_commit:z.string().nullable(),candidate_commit:z.string().nullable(),merged_commit:z.string().nullable(),integration_detail:z.record(z.unknown()).nullable(),
 /** Server-proven landing of an integrated batch: the shared target for a root
  * workspace; a delegated child is `parent` only when an adopting parent batch
  * records it, otherwise `parent_unverified`. Null until integrated. */
 landing:z.enum(['target','parent','parent_unverified']).nullable().optional(),
});
export type WorkspaceChangeView=z.infer<typeof WorkspaceChangeViewSchema>;

/** One batch together with its visible originating Run, for surfaces that are
 * not already reading through that Run (conversation pending work, overview). */
export const WorkspaceChangeEntrySchema=z.object({
 change:WorkspaceChangeViewSchema,
 run:z.object({id:IdSchema,status:z.string(),agent_id:IdSchema.nullable()}).strict(),
}).strict();
export type WorkspaceChangeEntry=z.infer<typeof WorkspaceChangeEntrySchema>;
/** One page; `next_cursor` continues it. Hidden rows never use up a page. */
export const ConversationWorkspaceChangesSchema=z.object({items:z.array(WorkspaceChangeEntrySchema),next_cursor:z.string().nullable()}).strict();
export const WorkspaceChangePageQuerySchema=z.object({
 cursor:z.string().max(512).optional(),
 limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ConversationWorkspaceChanges=z.infer<typeof ConversationWorkspaceChangesSchema>;

/** Overall work state of one workspace generation, derived on the server from
 * its Runs and batches. Ordered roughly by how much it needs a person. */
export const AgentWorkspaceStateSchema=z.enum(['attention','running','integrating','saved','unsaved','merged','adopted','adoption_unverified','no_changes','kept','idle']);
export type AgentWorkspaceState=z.infer<typeof AgentWorkspaceStateSchema>;
export const AgentWorkspaceListQuerySchema=z.object({
 view:z.enum(['current','history']).default('current'),
 cursor:z.string().max(512).optional(),
 limit:z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export const AgentWorkspaceItemSchema=z.object({
 workspace_id:IdSchema,generation:z.number().int().positive(),
 owner_kind:z.enum(['conversation','task','delegation']),
 work_state:AgentWorkspaceStateSchema,
 folder:z.object({id:IdSchema,name:z.string()}).strict().nullable(),
 host:z.object({name:z.string(),online:z.boolean()}).strict(),
 conversation:z.object({id:IdSchema,title:z.string().nullable(),room_id:IdSchema.nullable()}).strict().nullable(),
 task:z.object({id:IdSchema,title:z.string()}).strict().nullable(),
 agent:z.object({id:IdSchema,name:z.string()}).strict().nullable(),
 run:z.object({id:IdSchema,status:z.string()}).strict(),
 batch_count:z.number().int().nonnegative(),
 retention:WorkspaceRetentionSchema.nullable(),
 created_at:z.string(),activity_at:z.string(),
}).strict();
export type AgentWorkspaceItem=z.infer<typeof AgentWorkspaceItemSchema>;
export const AgentWorkspacePageSchema=z.object({items:z.array(AgentWorkspaceItemSchema),next_cursor:z.string().nullable()}).strict();
export type AgentWorkspacePage=z.infer<typeof AgentWorkspacePageSchema>;
export const AgentWorkspaceDetailSchema=z.object({workspace_id:IdSchema,items:z.array(WorkspaceChangeEntrySchema),next_cursor:z.string().nullable()}).strict();
export type AgentWorkspaceDetail=z.infer<typeof AgentWorkspaceDetailSchema>;

/** Safe progress facts only: no repair instructions, logs or Host paths. */
export const WorkspaceIntegrationNoticeSchema=z.object({
 schema_version:z.literal('workspace_integration_notice.v1'),
 run_id:IdSchema,integration_id:IdSchema,attempt_id:IdSchema,change_set_id:IdSchema,
 target_ref:z.string().min(1).max(256),
 outcome:z.enum(['repair_started','integrated','no_changes','conflict','verification_failed','failed']),
 reason:z.string().max(128).nullable(),
 repair_status:z.enum(['not_needed','queued','running','succeeded','failed','waiting_for_review','unknown']),
 verification_status:z.enum(['not_run','passed','failed','unconfigured']),
 verification_level:z.enum(['project','basic']).optional(),
 checks_passed:z.number().int().nonnegative(),checks_failed:z.number().int().nonnegative(),
 candidate_ready:z.boolean(),preserved:z.boolean(),
}).strict();
export type WorkspaceIntegrationNotice=z.infer<typeof WorkspaceIntegrationNoticeSchema>;

// Scoped to the integration's actual source Folder, including attachment repositories.
export const WorkspaceVerificationGetInputSchema=z.object({integration_id:IdSchema}).strict();
const verificationCommands=z.array(z.string().trim().min(1).max(4000).refine(s=>!/[\r\n\0]/.test(s),'Use one command per entry')).max(50);
export const WorkspaceVerificationConfigureInputSchema=WorkspaceVerificationGetInputSchema.extend({
 expected_config_version:z.string().length(32).nullable(),
 test_commands:verificationCommands,build_commands:verificationCommands,
 no_project_checks:z.boolean().optional().describe("Only the assigned verification Agent: repository inspection found no applicable project checks. Supply a reason; the system still runs exact-candidate basic checks."),
 note:z.string().trim().min(1).max(2000).optional(),
}).strict().refine(v=>v.no_project_checks===true?v.test_commands.length+v.build_commands.length===0&&Boolean(v.note):v.test_commands.length+v.build_commands.length>0,'Provide project commands or an inspected no-project-checks reason');
export const WorkspaceVerificationViewSchema=z.object({
 integration_id:IdSchema,change_set_id:IdSchema,project_id:IdSchema,folder_id:IdSchema,folder_name:z.string(),
 config_version:z.string().length(32).nullable(),test_commands:z.array(z.string()),build_commands:z.array(z.string()),
 validation_recipe_id:IdSchema.nullable(),integration_revision:z.number().int().nonnegative(),
 can_retry:z.boolean(),integration_status:z.string().optional(),
 conversation_id:IdSchema.nullable().optional(),room_id:IdSchema.nullable().optional(),agent_id:IdSchema.nullable().optional(),source_commit:z.string().nullable().optional(),
}).strict();
export type WorkspaceVerificationView=z.infer<typeof WorkspaceVerificationViewSchema>;
