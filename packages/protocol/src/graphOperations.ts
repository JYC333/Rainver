import { z } from 'zod';
import { IdSchema } from './common.js';
export const GRAPH_OPERATION_SCHEMAS = {
  'graph.view_state.save': {
    input: z.object({scope_key:z.string().trim().min(1).max(128),state_json:z.record(z.unknown()).default({})}).strict(),
    output: z.object({space_id:IdSchema,user_id:IdSchema,scope_key:z.string().min(1).max(128),state_json:z.record(z.unknown()),updated_at:z.string().datetime().nullable()}).strict(),
  },
} as const;
