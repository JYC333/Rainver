import {z} from 'zod';
import {IdSchema} from './common.js';
const area=z.object({id:IdSchema,space_id:IdSchema,owner_user_id:IdSchema.nullable(),name:z.string(),description:z.string().nullable(),created_at:z.string(),updated_at:z.string(),archived_at:z.string().nullable()}).strict();
const name=z.string().trim().min(1),description=z.string().nullable().optional();
export const FOCUS_OPERATION_SCHEMAS={
 'focus_area.create':{input:z.object({name,description}).strict(),output:area},
 'focus_area.update':{input:z.object({focus_area_id:IdSchema,name:name.optional(),description}).strict().refine(i=>i.name!==undefined||i.description!==undefined,'A change is required'),output:area},
 'focus_area.object.set':{input:z.object({object_id:IdSchema,focus_area_id:IdSchema.nullable()}).strict(),output:z.object({space_id:IdSchema,object_id:IdSchema,focus_area_id:IdSchema.nullable()}).strict()},
} as const;
