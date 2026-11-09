import {z} from 'zod';
import {TaskPatchStructuredFieldsSchema,TASK_STATUSES} from './projectWork.js';

// A contract save that changes standalone placement remains one transaction.
// Status and deletion use their named lifecycle commands; a Project move uses
// its revision-bearing exact-column command.
const text=z.string().nullable().optional();
const json=z.record(z.unknown()).nullable().optional();
const amount=z.number().nullable().optional();
export const TaskSpacePlacementChangesSchema=z.object({
  board_id:text,column_id:text,project_id:z.null().optional(),
  title:text,description:text,project_folder_id:text,parent_task_id:text,
  task_type:text,priority:text,risk_level:text,
  assigned_user_id:text,assigned_agent_id:text,claimed_by_user_id:text,claimed_by_agent_id:text,
  completed_at:text,cancelled_at:text,blocked_reason:text,
  acceptance_criteria_json:json,definition_of_done:text,
  required_outputs_json:z.array(z.unknown()).nullable().optional(),
  due_at:text,start_after:text,estimated_effort:text,actual_effort:text,
  max_runs:amount,max_cost:amount,max_duration_seconds:amount,
  policy_json:json,metadata_json:json,tags:z.array(z.unknown()).nullable().optional(),
  ...TaskPatchStructuredFieldsSchema.shape,
}).strict().refine(value=>Object.prototype.hasOwnProperty.call(value,'board_id')||Object.prototype.hasOwnProperty.call(value,'column_id'),{
  message:'A placement change requires board_id or column_id',
});
export const TaskSpacePlacementInputSchema=z.object({task_id:z.string().min(1),changes:TaskSpacePlacementChangesSchema}).strict();
export const TaskSpacePlacementOutputSchema=z.object({task_id:z.string().min(1),board_id:z.string().nullable(),column_id:z.string().nullable(),status:z.enum(TASK_STATUSES)}).strict();
