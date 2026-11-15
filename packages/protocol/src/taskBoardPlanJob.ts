import {z} from 'zod';
import {TaskCreateInputSchema} from './taskCreateInput.js';
import {TASK_STATUSES,TaskEntityLinkInputSchema} from './projectWork.js';

// Group 2 operations: Task creation/editing/evaluation/execution, Board
// create/update, Plan execute/reconcile and generic Job cancellation.
// Provenance (source_*), visibility, Task role of Runs and Run parentage are
// server-owned and never accepted here.
const id=z.string().min(1).max(36);
const text=(max:number)=>z.string().trim().max(max);
const nullableText=(max:number)=>text(max).nullable().optional();
const json=z.record(z.string(),z.unknown());
const limit=z.number().finite().min(0);
const when=z.string().trim().min(1).max(64);

/** Fields only a person's create supplies; an Agent create is refused when it carries any. */
export const TASK_CREATE_HUMAN_FIELDS=['task_type','status','board_id','column_id','assigned_user_id','assigned_agent_id','max_runs','max_cost','max_duration_seconds','tags','parent_task_id','task_role','project_folder_id','policy_json','metadata_json'] as const;
export const TaskCreateOperationInputSchema=TaskCreateInputSchema.extend({
  task_type:text(64).min(1).optional(),
  // A new Task is never created already finished: Done and Cancelled have their own gates.
  status:z.enum(TASK_STATUSES).refine(s=>s!=='done'&&s!=='cancelled',{message:'Create the Task before completing or cancelling it'}).optional(),
  board_id:id.nullable().optional(),
  column_id:id.nullable().optional(),
  assigned_user_id:id.nullable().optional(),
  assigned_agent_id:id.nullable().optional(),
  max_runs:z.number().int().min(1).max(10_000).nullable().optional(),
  max_cost:limit.nullable().optional(),
  max_duration_seconds:z.number().int().min(1).nullable().optional(),
  tags:z.array(text(128).min(1)).max(50).nullable().optional(),
  parent_task_id:id.nullable().optional(),
  task_role:z.enum(['source','subtask']).optional(),
  project_folder_id:id.nullable().optional(),
  policy_json:json.nullable().optional(),
  metadata_json:json.nullable().optional(),
}).strict();
export const TaskCreateOperationOutputSchema=z.object({
  task_id:id,space_id:id,project_id:id.nullable(),title:z.string(),status:z.enum(TASK_STATUSES),column_id:z.string().nullable(),
}).strict();

/**
 * The one `task.update` contract (PATCH /tasks/:id and the Agent tool). Status,
 * placement, deletion, completion timestamps and block reason have named commands.
 * Omitted fields stay unchanged; a nullable field set to null clears it.
 */
const TaskUpdateFieldsSchema=z.object({
  task_id:id.describe('The Task id exactly as returned by task.list. Never invent or derive an id.'),
  title:text(512).min(1).optional().describe('New title; omit to keep the current title.'),
  description:nullableText(20_000).describe('New description; null clears it, omission keeps it unchanged.'),
  task_type:text(64).min(1).optional(),
  priority:z.enum(['low','normal','high','urgent']).optional(),
  risk_level:z.enum(['low','medium','high','critical']).optional(),
  project_id:id.nullable().optional(),
  project_folder_id:id.nullable().optional(),
  parent_task_id:id.nullable().optional(),
  assigned_user_id:id.nullable().optional(),
  assigned_agent_id:id.nullable().optional(),
  claimed_by_user_id:id.nullable().optional(),
  claimed_by_agent_id:id.nullable().optional(),
  acceptance_criteria_json:json.nullable().optional(),
  definition_of_done:nullableText(4_000),
  required_outputs_json:z.array(text(64).min(1)).max(20).nullable().optional(),
  due_at:when.nullable().optional(),
  start_after:when.nullable().optional(),
  estimated_effort:nullableText(256),
  actual_effort:nullableText(256),
  max_runs:z.number().int().min(1).max(10_000).nullable().optional(),
  max_cost:limit.nullable().optional(),
  max_duration_seconds:z.number().int().min(1).nullable().optional(),
  policy_json:json.nullable().optional(),
  metadata_json:json.nullable().optional(),
  tags:z.array(text(128).min(1)).max(50).nullable().optional(),
  links:z.array(TaskEntityLinkInputSchema).max(32).optional(),
}).strict();
const someEdit=(input:Record<string,unknown>)=>Object.keys(input).some(key=>key!=='task_id'&&input[key]!==undefined);
export const TaskUpdateInputSchema=TaskUpdateFieldsSchema.refine(someEdit,{message:'Provide at least one field to edit'});
/** An Agent edits only a Task's text; every other contract field is a person's edit. */
export const TASK_UPDATE_AGENT_FIELDS=['title','description'] as const;
export const TaskUpdateAgentInputSchema=TaskUpdateFieldsSchema.pick({task_id:true,title:true,description:true}).strict().refine(someEdit,{message:'Provide title or description'});
export const TaskUpdateOutputSchema=z.object({task_id:id,project_id:id.nullable(),status:z.enum(TASK_STATUSES),title:z.string(),description:z.string().nullable()}).strict();

export const TASK_EVALUATION_RECOMMENDATIONS=['accept','review','retry','needs_evidence'] as const;
export const TaskEvaluationRecordInputSchema=z.object({
  task_id:id,
  evaluator_type:text(64).min(1),
  run_id:id.nullable().optional(),
  score:z.number().min(0).max(1).nullable().optional(),
  confidence:z.number().min(0).max(1).nullable().optional(),
  summary:nullableText(8_000),
  checklist_json:json.nullable().optional(),
  known_issues_json:z.array(z.unknown()).max(100).nullable().optional(),
  evidence_artifact_ids:z.array(id).max(50).nullable().optional(),
  recommendation:z.enum(TASK_EVALUATION_RECOMMENDATIONS).nullable().optional(),
}).strict();
export const TaskEvaluationRecordOutputSchema=z.object({evaluation_id:id,task_id:id,run_id:id.nullable(),recommendation:z.enum(TASK_EVALUATION_RECOMMENDATIONS).nullable()}).strict();

export const TaskPlanRequestInputSchema=z.object({
  task_id:id,
  agent_id:id.nullable().optional(),
  runtime_profile_id:id.nullable().optional(),
  prompt:nullableText(20_000),
  instruction:nullableText(20_000),
  reference_workflow_version_id:id.nullable().optional(),
}).strict();
export const TaskRunCreateInputSchema=z.object({
  task_id:id,
  agent_id:id.nullable().optional(),
  runtime_profile_id:id.nullable().optional(),
  mode:z.enum(['live','dry_run']).optional(),
  workspace_location_id:id.nullable().optional(),
  session_id:id.nullable().optional(),
  thread_id:id.nullable().optional(),
  prompt:nullableText(20_000),
  instruction:nullableText(20_000),
  scheduled_at:when.nullable().optional(),
  max_attempts:z.number().int().min(1).max(100).nullable().optional(),
  set_task_in_progress:z.boolean().optional(),
}).strict();
export const TaskRunReceiptSchema=z.object({run_id:id,task_id:id,status:z.string().min(1)}).strict();

const boardFields={
  name:text(256).min(1),
  description:nullableText(4_000),
  project_folder_id:id.nullable().optional(),
  board_type:text(64).min(1).optional(),
  status:z.enum(['active','archived']).optional(),
  default_view:nullableText(64),
  sort_order:z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  metadata_json:json.nullable().optional(),
};
export const BoardCreateInputSchema=z.object({
  ...boardFields,
  project_id:id.nullable().optional(),
  create_default_columns:z.boolean().optional(),
}).strict();
export const BoardUpdateInputSchema=z.object({
  board_id:id,
  ...boardFields,
  name:boardFields.name.optional(),
  project_id:id.nullable().optional(),
  deleted:z.literal(true).optional(),
  /** Required when the change can select a different active Project Board (status, order, Project, deletion):
   * the revision of the Project the Board is in, or of its destination when it is in the Space. */
  columns_revision:z.string().min(1).max(128).optional(),
  /** Moving a Board from one Project to another also needs the destination Project's current revision. */
  target_columns_revision:z.string().min(1).max(128).optional(),
}).strict();
export const BoardReceiptSchema=z.object({board_id:id,space_id:id,project_id:id.nullable(),status:z.string().min(1)}).strict();

export const PlanExecuteInputSchema=z.object({
  plan_id:id,
  agent_id:id.nullable().optional(),
  runtime_profile_id:id.nullable().optional(),
  prompt:nullableText(20_000),
  instruction:nullableText(20_000),
  workflow_input_json:json.nullable().optional(),
}).strict();
export const PlanExecuteOutputSchema=z.object({
  plan_id:id,root_run_id:id,scheduled_node_ids:z.array(id),idempotent:z.boolean(),root_status:z.string().nullable(),
}).strict();
export const PlanReconcileInputSchema=z.object({plan_id:id}).strict();
export const PlanReconcileOutputSchema=z.object({plan_id:id,status:z.string().min(1),scheduled_node_ids:z.array(id)}).strict();

export const JobCancelInputSchema=z.object({job_id:id}).strict();
export const JobCancelOutputSchema=z.object({job_id:id,status:z.literal('cancelled')}).strict();
