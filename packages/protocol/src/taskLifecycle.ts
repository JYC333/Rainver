import {z} from 'zod';
import {TASK_STATUSES,TaskCompletionOverrideSchema} from './projectWork.js';

const taskId=z.string().min(1).max(36).describe('The Task id exactly as returned by task.list. Never invent or derive an id.');
const reason=z.string().trim().min(1).max(2000);
export const TaskReportInputSchema=z.object({
  task_id:taskId,summary:z.string().trim().min(1).max(8000),
  outcome:z.enum(['progress','done','stuck','handoff']).default('progress'),
  refs:z.array(z.object({type:z.string().trim().min(1).max(32),id:z.string().min(1)}).strict()).max(20).default([]),
}).strict();
export const TaskCompleteInputSchema=z.object({task_id:taskId,summary:z.string().trim().min(1).max(2000)}).strict();
export const TaskReviewInputSchema=z.object({task_id:taskId,reason,options:z.array(z.string().trim().min(1).max(500)).max(6).default([])}).strict();
export const TaskHandoffInputSchema=z.object({
  task_id:taskId,to:z.object({kind:z.enum(['user','agent']),id:z.string().min(1)}).strict().nullable(),
  note:z.string().trim().max(2000).nullable().default(null),
}).strict();
export const TaskStatusInputSchema=z.object({
  task_id:taskId,status:z.enum(TASK_STATUSES),reason:reason.max(500).nullable().default(null),
  blocked_reason:z.string().nullable().optional(),
  override_completion:TaskCompletionOverrideSchema.nullable().default(null),
}).strict();
export const TaskDeleteInputSchema=z.object({task_id:taskId,reason:reason.nullable().default(null)}).strict();
export const TaskStatusOutputSchema=z.object({task_id:taskId,status:z.enum(TASK_STATUSES)}).strict();
export const TaskReportOutputSchema=z.object({task_id:taskId,event_id:z.string().min(1)}).strict();
export const TaskCompleteOutputSchema=TaskStatusOutputSchema.extend({event_id:z.string().min(1)}).strict();
export const TaskHandoffOutputSchema=z.object({task_id:taskId,released:z.boolean()}).strict();
export const TaskDeleteOutputSchema=z.object({task_id:taskId,deleted:z.literal(true)}).strict();
