import {z} from 'zod';
import {IdSchema} from './common.js';
const input=z.object({request_id:IdSchema}).strict();
const output=z.object({request_id:IdSchema,space_id:IdSchema,run_id:IdSchema,status:z.enum(['approved','rejected']),resulting_action_grant_id:IdSchema.nullable(),resulting_plugin_data_grant_id:IdSchema.nullable()}).strict();
export const AUTHORIZATION_REQUEST_OPERATION_SCHEMAS={
 'policy.authorization_request.approve':{input,output},
 'policy.authorization_request.reject':{input,output},
} as const;
