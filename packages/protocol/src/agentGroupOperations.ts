import {z} from 'zod';
import {CreateAgentRunGroupRequestSchema,SendAgentRunGroupMessageRequestSchema,UpdateAgentRunGroupRequestSchema} from './agentGroupRuns.js';
const id=z.string().trim().min(1).max(36);
const receipt=z.object({id,space_id:id,group_id:id}).strict();
/** The existing group request bodies; receipts carry identities only. */
export const AGENT_GROUP_OPERATION_SCHEMAS={
 'agent_group.create':{input:CreateAgentRunGroupRequestSchema,output:receipt},
 'agent_group.update':{input:UpdateAgentRunGroupRequestSchema.extend({group_id:id}).strict(),output:receipt},
 'agent_group.message.send':{input:SendAgentRunGroupMessageRequestSchema,output:receipt.extend({message_id:id}).strict()},
 'agent_group.status.set':{input:z.object({group_id:id,status:z.enum(['active','paused','cancelled'])}).strict(),output:receipt.extend({status:z.enum(['active','paused','cancelled'])}).strict()},
} as const;
export const AGENT_GROUP_OPERATION_TITLES:Record<keyof typeof AGENT_GROUP_OPERATION_SCHEMAS,string>={
 'agent_group.create':'Create an Agent group run',
 'agent_group.update':'Rename or re-goal an Agent group run',
 'agent_group.message.send':'Send a message into an Agent group run',
 'agent_group.status.set':'Pause, resume or cancel an Agent group run',
};
