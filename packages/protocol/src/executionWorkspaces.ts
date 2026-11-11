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
  // A read-only delegated review of its coordinator's workspace: the Host mounts
  // that existing worktree read-only at exactly this commit (clean, no writer
  // beside it) instead of preparing a branch, and records no checkpoint.
  review_commit:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/).optional(),
}).strict();
export type ExecutionWorkspaceRef = z.infer<typeof ExecutionWorkspaceRefSchema>;
export const WorkspaceAgentVerificationSchema=z.object({
 commit:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
 checks:z.array(z.object({command:z.string().trim().min(1).max(4000),summary:z.string().trim().min(1).max(2000)}).strict()).max(50),
 note:z.string().trim().min(1).max(4000),
}).strict();
/** A short local branch name the Host re-validates with `git check-ref-format`.
 * Rainver-managed branches, `HEAD` and ref syntax tricks are refused here first. */
export const WorkspaceBranchNameSchema=z.string().min(1).max(200)
 .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/,'invalid branch name')
 .refine(b=>!b.includes('..')&&!b.includes('//')&&!b.endsWith('/')&&!b.endsWith('.')&&!b.endsWith('.lock')&&!b.split('/').some(s=>s.startsWith('.')||s.endsWith('.lock'))&&b!=='HEAD'&&!b.startsWith('rainver/')&&!b.startsWith('refs/'),'invalid branch name');
/** How an exact checked result reaches the target. `rebase` (default) replays
 * the batch's own commits onto the target and fast-forwards it; `squash` writes
 * one new commit and needs the person's explicit request; `fast_forward`
 * publishes the frozen linear commit chain itself; `merge` writes an ordinary
 * merge commit whose second parent is that chain. */
export const WorkspacePublicationStrategySchema=z.enum(['rebase','squash','fast_forward','merge']);
/** The person's own words asking for a squash, checked against the current turn's message. */
const SquashRequestQuoteSchema=z.string().trim().min(1).max(4000).describe('Required for squash from an Agent: quote the current person message that explicitly asks to squash. It is checked against that message, never inferred.');
export const WorkspacePublicationPlanInputSchema=z.object({
 strategy:WorkspacePublicationStrategySchema.default('rebase'),
 target_branch:WorkspaceBranchNameSchema.optional().describe('Explicit local target branch of this repository; omit for the workspace target. Only an existing non-Rainver branch is accepted.'),
 user_request_quote:SquashRequestQuoteSchema.optional(),
}).strict();
export type WorkspacePublicationPlanInput=z.infer<typeof WorkspacePublicationPlanInputSchema>;
export const WorkspaceChangeCompleteInputSchema = z.object({
  change_set_id: IdSchema, expected_revision: z.number().int().positive(), summary: z.string().trim().min(1).max(16000),
  publication:WorkspacePublicationPlanInputSchema.optional().describe('Only with action=prepare, frozen for the rest of this integration (a failed fast_forward/merge with no recorded chain may still switch): rebase (default; your own commits after the batch base are replayed onto the target here, one at a time, then fast-forwarded), squash (one new commit; only when the person explicitly asked, with user_request_quote), fast_forward (publish your own linear commits unchanged; requires a clean committed worktree whose base is target history) or merge (ordinary merge commit keeping your commits). Optional explicit target_branch.'),
  commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional().describe('Explicit existing single commit to publish instead of an empty workspace snapshot. Its parent must belong to target history. Resolve this ID from your own Git operations; never ask the person to copy a commit ID. Never submit a private snapshot or an entire branch.'),
  action:z.enum(['prepare','checkpoint','publish','reconcile']).optional().describe('During an active Agent turn: prepare integrates the target into this same worktree (rebase: a conflict stops at one commit; resolve its files here and prepare again to continue); checkpoint saves a private version without requesting publication when prepare has not been called; publish finishes after your checks. Read workspace.change.get for the actual result before replying.'),
  verification:WorkspaceAgentVerificationSchema.optional().describe('Your checks on the saved version in this same Agent environment; required for publish. Use an empty checks array with an honest note only when no applicable checks exist.'),
}).strict().refine(v=>!v.publication||(v.action??'prepare')==='prepare','publication is frozen at prepare');
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
  publication:z.object({strategy:z.enum(['rebase','squash']),user_request_quote:SquashRequestQuoteSchema.optional()}).strict().optional().describe('Switch a failed fast_forward/merge integration into the same target: rebase, or squash only on the person\'s explicit request. Accepted only while no chain was recorded for it (e.g. after native_publication_chain_base_not_target_history); a recorded chain keeps its plan.'),
}).strict().refine(input=>!(input.resolution&&input.repair_instruction),'Choose a human resolution or an Agent repair instruction, not both').refine(v=>!v.reconcile_only||!v.resolution&&!v.repair_instruction&&!v.publication,'Reconciliation cannot carry a repair instruction or a publication change');
export const WorkspaceChangeAbandonInputSchema = z.object({
  change_set_id: IdSchema, expected_revision: z.number().int().positive(), reason: z.string().trim().min(1).max(4000),
  reclaim:z.boolean().optional().describe("Explicitly discard the reviewed saved source and reclaim its managed branch and worktree. Requires review and current human deletion instruction; not adoption or publication. May also reclaim a previously abandoned batch."),
  review:z.object({
   source_commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
   user_request_quote:z.string().trim().min(1).max(4000),
   findings:z.string().trim().min(1).max(4000),
  }).strict().optional().describe('For an Agent closing a saved obsolete batch: review the exact source_commit from get, quote the current direct human instruction explicitly asking to close this work, and record concrete findings. A quote is checked against server-owned Run input, not accepted as a grant or adoption proof. Without reclaim=true this only abandons the record while retaining source data. Explicit reclaim=true requests guarded discard of this exact saved source; neither mode marks it merged.'),
}).strict();
export const WorkspaceChangeReceiptSchema = z.object({
  change_set_id: IdSchema, revision: z.number().int().positive(), state: z.string(), integration_id: IdSchema.nullable(),
  progress:WorkspaceNativeProgressSchema.nullable().optional(),
}).strict();
export const WorkspaceChangeStatusSchema=WorkspaceChangeReceiptSchema.extend({
 can_retry:z.boolean(),integration_status:z.string().nullable(),conversation_id:IdSchema.nullable(),room_id:IdSchema.nullable(),agent_id:IdSchema.nullable(),folder_name:z.string(),source_commit:z.string().nullable(),
});
// Ignore undeclared report metadata without discarding validated workspace capabilities.
// shared_review:1 = the Host mounts an existing workspace read-only at a frozen
// `review_commit` under a shared lease (no branch preparation or checkpoint).
export const ExecutionWorkspaceCapabilitySchema = z.object({version:z.union([z.literal(1),z.literal(2)]),reclaim:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5)]).optional(),shared_review:z.literal(1).optional()});

/** Visible retention of one workspace generation. Reasons are stable codes. */
export const WorkspaceRetentionSchema=z.object({
 state:z.enum(['active','grace','reclaimable','reclaiming','reclaimed','retained','held','blocked','missing']),
 reason:z.string().max(64),
 reclaim_after:z.string().nullable(),hold_until:z.string().nullable(),reclaimed_at:z.string().nullable(),assessed_at:z.string().nullable(),
 retained_refs:z.number().int().nonnegative(),unclaimed_refs:z.number().int().nonnegative(),
}).strict();
export type WorkspaceRetention=z.infer<typeof WorkspaceRetentionSchema>;
export const WorkspaceRetentionUpdateInputSchema=z.object({
 change_set_id:IdSchema,
 action:z.enum(['reclaim_now','hold','release_hold','retry','acknowledge_missing']).describe('reclaim_now skips only the short grace for a proven merged/unchanged source; hold postpones automatic reclamation; retry re-delivers blocked cleanup; acknowledge_missing closes unfinished records whose branch was removed outside Rainver without adoption proof (never marks them merged; audit kept).'),
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
export const AgentWorkspaceStateSchema=z.enum(['attention','missing','running','integrating','saved','unsaved','merged','adopted','in_target','adoption_unverified','no_changes','kept','discarded','missing_closed','idle']);
export type AgentWorkspaceState=z.infer<typeof AgentWorkspaceStateSchema>;
/** Opaque conversation × repository group of the overview (`c:<conversation>:<location>`),
 * or a lone workspace without a conversation (`w:<workspace>`). */
export const AgentWorkspaceGroupKeySchema=z.string().max(120).regex(/^(?:c:[0-9A-Za-z-]{1,36}:[0-9A-Za-z-]{1,36}|w:[0-9A-Za-z-]{1,36})$/);
export const AgentWorkspaceListQuerySchema=z.object({
 // `all` is the folded execution history of one group (requires `group`).
 view:z.enum(['current','history','all']).default('current'),
 group:AgentWorkspaceGroupKeySchema.optional(),
 cursor:z.string().max(512).optional(),
 limit:z.coerce.number().int().min(1).max(50).default(20),
}).strict().refine(v=>v.view!=='all'||v.group!==undefined,'view=all requires group');
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
 /** Delegated work: the workspace it was forked from (aggregated under it when both are shown). */
 parent_workspace_id:IdSchema.nullable(),
 batch_count:z.number().int().nonnegative(),
 retention:WorkspaceRetentionSchema.nullable(),
 created_at:z.string(),activity_at:z.string(),
}).strict();
export type AgentWorkspaceItem=z.infer<typeof AgentWorkspaceItemSchema>;
export const AgentWorkspacePageSchema=z.object({items:z.array(AgentWorkspaceItemSchema),next_cursor:z.string().nullable()}).strict();
export type AgentWorkspacePage=z.infer<typeof AgentWorkspacePageSchema>;
/** Server-aggregated overview of one conversation × repository: its current
 * state, latest result and open problems. Delegations, batches, older
 * generations and reclaims stay in the folded execution history (`view=all`). */
export const AgentWorkspaceGroupListQuerySchema=z.object({
 view:z.enum(['current','history']).default('current'),
 cursor:z.string().max(512).optional(),
 limit:z.coerce.number().int().min(1).max(50).default(20),
}).strict();
/** Saved work with no proof that it landed. Only an identical commit or a
 * recorded adoption proof folds it away; nothing is inferred from file counts. */
export const AgentWorkspaceUnconfirmedSchema=z.object({
 change_set_id:IdSchema,workspace_id:IdSchema,generation:z.number().int().positive(),
 owner_kind:z.enum(['conversation','task','delegation']),
 reason:z.enum(['saved_not_merged','kept_without_merging','adoption_unverified']),
 source_commit:z.string().nullable(),
 /** Other unconfirmed batches of this group saved at exactly the same commit. */
 same_commit_count:z.number().int().nonnegative(),
 agent:z.object({id:IdSchema,name:z.string()}).strict().nullable(),
 run:z.object({id:IdSchema,status:z.string()}).strict(),
 activity_at:z.string(),
}).strict();
export type AgentWorkspaceUnconfirmed=z.infer<typeof AgentWorkspaceUnconfirmedSchema>;
export const AgentWorkspaceGroupSchema=z.object({
 group_key:AgentWorkspaceGroupKeySchema,
 conversation:z.object({id:IdSchema,title:z.string().nullable(),room_id:IdSchema.nullable()}).strict().nullable(),
 task:z.object({id:IdSchema,title:z.string()}).strict().nullable(),
 folder:z.object({id:IdSchema,name:z.string()}).strict().nullable(),
 host:z.object({name:z.string(),online:z.boolean()}).strict(),
 /** The most urgent state among the group's visible generations. */
 work_state:AgentWorkspaceStateSchema,
 /** The newest visible generation (the one a follow-up continues in). */
 current:AgentWorkspaceItemSchema,
 /** The newest visible batch with an outcome or saved difference. */
 latest_result:z.object({
  change_set_id:IdSchema,workspace_id:IdSchema,
  state:z.enum(['open','ready','integrating','blocked','integrated','no_changes','abandoned']),
  landing:z.enum(['target','parent','parent_unverified']).nullable(),
  source_commit:z.string().nullable(),
  agent:z.object({id:IdSchema,name:z.string()}).strict().nullable(),
  run:z.object({id:IdSchema,status:z.string()}).strict(),
  activity_at:z.string(),
 }).strict().nullable(),
 issues:z.array(z.object({kind:z.enum(['attention','missing','cleanup_blocked','unconfirmed','host_offline']),count:z.number().int().positive()}).strict()),
 unconfirmed:z.array(AgentWorkspaceUnconfirmedSchema),
 unconfirmed_more:z.boolean(),
 /** Saved batches folded away because an identical commit landed or an adoption proof exists. */
 proven_duplicates:z.number().int().nonnegative(),
 workspace_count:z.number().int().positive(),
 delegation_count:z.number().int().nonnegative(),
 batch_count:z.number().int().nonnegative(),
 activity_at:z.string(),
}).strict();
export type AgentWorkspaceGroup=z.infer<typeof AgentWorkspaceGroupSchema>;
export const AgentWorkspaceGroupPageSchema=z.object({items:z.array(AgentWorkspaceGroupSchema),next_cursor:z.string().nullable()}).strict();
export type AgentWorkspaceGroupPage=z.infer<typeof AgentWorkspaceGroupPageSchema>;
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

/** Agent/user listing of visible change sets (Active management). The same
 * visibility as the Agent workspaces overview; cross-conversation rows carry
 * metadata only and can only be closed by the person. */
export const WorkspaceChangeListInputSchema=z.object({
 scope:z.enum(['conversation','project']).default('conversation').describe('conversation: this conversation and its delegated workspaces; project: every visible workspace of the Project (metadata only for other conversations).'),
 project_id:IdSchema.optional().describe('Required for a person; an Agent uses its Run Project.'),
 view:z.enum(['unfinished','all']).default('unfinished'),
 cursor:z.string().max(512).optional(),
 limit:z.number().int().min(1).max(50).default(20),
}).strict();
export const WorkspaceChangeListItemSchema=z.object({
 change_set_id:IdSchema,revision:z.number().int().positive(),state:z.string(),
 workspace_id:IdSchema,generation:z.number().int().positive(),owner_kind:z.string(),parent_workspace_id:IdSchema.nullable(),
 conversation_id:IdSchema.nullable(),same_conversation:z.boolean(),run_id:IdSchema,run_status:z.string(),
 summary:z.string().nullable(),saved_difference:z.boolean(),integration_id:IdSchema.nullable(),integration_status:z.string().nullable(),
 retention_state:z.string().nullable(),retention_reason:z.string().nullable(),
 /** Whether this caller may close it now with workspace.change.abandon, and why not. */
 closable:z.boolean(),close_blocker:z.string().nullable(),
}).strict();
export const WorkspaceChangeListSchema=z.object({items:z.array(WorkspaceChangeListItemSchema),next_cursor:z.string().nullable()}).strict();

/** Person-authorized alignment of one local branch of a Folder's repository to
 * another. Frozen expected tips; the Host refuses moved, checked-out-dirty,
 * leased or Rainver-managed branches and keeps a recovery ref of the old tip. */
export const WorkspaceBranchAlignInputSchema=z.object({
 project_id:IdSchema,folder_id:IdSchema,
 source_branch:WorkspaceBranchNameSchema,target_branch:WorkspaceBranchNameSchema,
 mode:z.enum(['fast_forward','reset']).describe('fast_forward only when the source is history of the target; reset moves the source to the target and keeps a recovery ref of the old tip.'),
 expected_source_commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
 expected_target_commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
 reason:z.string().trim().min(1).max(2000),
}).strict().refine(v=>v.source_branch!==v.target_branch,'source and target must differ');
export const WorkspaceBranchAlignReceiptSchema=z.object({intent_id:IdSchema,status:z.string(),job_id:IdSchema.nullable()}).strict();
