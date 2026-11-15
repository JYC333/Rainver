import {z} from 'zod';
import {IdSchema} from './common.js';
const project={project_id:IdSchema.nullable().optional()};
const text=z.string().trim().min(1);
const objective=z.object({id:IdSchema,project_id:IdSchema.nullable(),title:z.string(),description:z.string().nullable(),status:z.string(),created_by_user_id:IdSchema.nullable(),created_at:z.string(),updated_at:z.string()}).strict();
const item=z.object({id:IdSchema,project_id:IdSchema.nullable(),objective_id:IdSchema.nullable(),knowledge_item_id:IdSchema,knowledge_item_version:z.number().int(),item_kind:z.enum(['card','exercise']),prompt:z.string(),answer:z.string(),created_by_user_id:IdSchema.nullable(),created_at:z.string()}).strict();
const mastery=z.object({id:IdSchema,learning_item_id:IdSchema,user_id:IdSchema,mastery_state:z.string(),correct_streak:z.number().int(),last_reviewed_at:z.string().nullable(),next_review_at:z.string().nullable(),created_at:z.string(),updated_at:z.string()}).strict();
export const LEARNING_OPERATION_SCHEMAS={
 'learning.objective.create':{input:z.object({...project,title:text,description:z.string().nullable().optional()}).strict(),output:z.object({space_id:IdSchema,objective}).strict()},
 'learning.item.create':{input:z.object({...project,objective_id:IdSchema.nullable().optional(),knowledge_item_id:IdSchema,item_kind:z.enum(['card','exercise']).default('card'),prompt:text,answer:text}).strict(),output:z.object({space_id:IdSchema,item}).strict()},
 'learning.item.review':{input:z.object({item_id:IdSchema,outcome:z.enum(['correct','incorrect'])}).strict(),output:z.object({space_id:IdSchema,mastery}).strict()},
} as const;
