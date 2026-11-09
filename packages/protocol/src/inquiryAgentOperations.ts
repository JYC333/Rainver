import {z} from 'zod';
import {ProblemWorkFieldsSchema,ProblemCloseRoundRequestSchema,validateProblemWorkSelection} from './problemEngine.js';
import {ProblemTaskLinkFieldsSchema} from './taskCreateInput.js';
import {INQUIRY_OPERATION_SCHEMAS} from './inquiryOperations.js';
const id=z.string().trim().min(1).max(36),thread={thread_id:id};
const receipt=z.object({id,thread_id:id,project_id:id,space_id:id}).strict();
export const INQUIRY_AGENT_OPERATION_SCHEMAS={
 'inquiry.record_work':{input:ProblemWorkFieldsSchema.extend(thread).strict().superRefine(validateProblemWorkSelection),output:receipt},
 'inquiry.close_round':{input:ProblemCloseRoundRequestSchema.extend(thread).strict(),output:INQUIRY_OPERATION_SCHEMAS['inquiry.problem.close_round'].output},
 'inquiry.record_conclusion':{input:INQUIRY_OPERATION_SCHEMAS['inquiry.iteration.record'].input.omit({project_id:true}).extend({confidence:z.number().int().min(0).max(100).nullable().optional(),confidence_method:z.string().max(32).nullable().optional()}).strict(),output:z.object({...thread,project_id:id,space_id:id,iteration_id:id.nullable(),closeout_id:id.nullable()}).strict()},
 'inquiry.link_task':{input:ProblemTaskLinkFieldsSchema.omit({idempotency_key:true}).extend(thread).strict().refine(v=>Boolean(v.task_id)!==Boolean(v.task),'Supply exactly one Task'),output:INQUIRY_OPERATION_SCHEMAS['inquiry.task.link'].output},
 'inquiry.reference_task_result':{input:ProblemWorkFieldsSchema.omit({idempotency_key:true}).extend({...thread,task_id:id}).strict().superRefine(validateProblemWorkSelection).refine(v=>v.work_kind==='reference_result'),output:receipt},
} as const;
