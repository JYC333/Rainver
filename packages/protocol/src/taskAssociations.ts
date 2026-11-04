import {z} from 'zod';
export const TaskAssociationRoleSchema=z.enum(['executes','investigates','prepares','references']);
export const ProblemTaskLinkResultSchema=z.object({task_id:z.string(),thread_id:z.string(),role:TaskAssociationRoleSchema,created:z.boolean(),linked:z.boolean()}).strict();
export const ProblemLinkedTasksPageSchema=z.object({items:z.array(z.object({id:z.string(),title:z.string(),status:z.string(),roles:z.array(TaskAssociationRoleSchema)}).strict()).max(50),next_cursor:z.string().nullable()}).strict();
// SQL `left(statement,500)` counts code points; `.max()` would count UTF-16 units
// and reject a valid excerpt containing astral characters.
export const TaskInquiryThreadsPageSchema=z.object({items:z.array(z.object({id:z.string(),statement:z.string().refine(v=>[...v].length<=500,'statement is at most 500 characters'),lifecycle_status:z.string(),roles:z.array(TaskAssociationRoleSchema)}).strict()).max(50),next_cursor:z.string().nullable()}).strict();
export const ProblemTaskResultSchema=z.object({task_id:z.string(),status:z.string(),task_work_path:z.string(),artifacts:z.array(z.object({id:z.string(),role:z.string()}).strict()).max(50),artifacts_truncated:z.boolean()}).strict();
export const TaskWorkHistoryPageSchema=z.object({items:z.array(z.object({id:z.string(),seq:z.string().regex(/^[1-9][0-9]*$/),event_kind:z.string(),actor_id:z.string(),occurred_at:z.string(),data_json:z.record(z.string(),z.unknown())}).strict()).max(50),next_cursor:z.string().nullable()}).strict();
export type ProblemTaskLinkResult=z.infer<typeof ProblemTaskLinkResultSchema>;
export type ProblemLinkedTasksPage=z.infer<typeof ProblemLinkedTasksPageSchema>;
export type TaskInquiryThreadsPage=z.infer<typeof TaskInquiryThreadsPageSchema>;
export type ProblemTaskResult=z.infer<typeof ProblemTaskResultSchema>;
export type TaskWorkHistoryPage=z.infer<typeof TaskWorkHistoryPageSchema>;
