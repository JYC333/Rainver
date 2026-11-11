import {z} from 'zod';
import {AgentRuntimeProfileCreateBodySchema,AgentRuntimeProfileUpdateBodySchema,SpaceAgentRuntimeDefaultWriteSchema} from './agents.js';
import {ChatTurnAcceptedSchema,ChatTurnRequestSchema,ConversationRetryRequestSchema,ConversationRetryResponseSchema,ConversationSessionConfigSaveSchema} from './memorySessions.js';

const id=z.string().trim().min(1).max(36);
const agent={agent_id:id};
const text=z.string().nullable().optional();
const record=z.record(z.unknown()).nullable().optional();
/** Same Agent definition fields the retained REST bodies accept; domain helpers keep their trimming and value rules. */
const definition={
 description:text,system_prompt:text,
 context_policy_json:record,memory_policy_json:record,tool_policy_json:record,
 output_policy_json:record,schedule_config_json:record,output_schema_json:record,
 execution_constraints:z.unknown().optional(),
};
export const AgentReceiptSchema=z.object({id,space_id:id,agent_id:id}).strict();
export const AgentRuntimeProfileReceiptSchema=z.object({id,space_id:id,agent_id:id,profile_id:id}).strict();
const runCreate={
 mode:z.string().nullable().optional(),run_type:z.string().nullable().optional(),session_id:id.nullable().optional(),
 project_folder_id:id.nullable().optional(),project_id:id.nullable().optional(),prompt:z.string().nullable().optional(),
 instruction:z.string().nullable().optional(),scheduled_at:z.string().nullable().optional(),parent_run_id:id.nullable().optional(),
 runtime_profile_id:id.nullable().optional(),capability_id:z.string().nullable().optional(),capabilities_json:z.array(z.unknown()).nullable().optional(),
};
export const AGENT_OPERATION_SCHEMAS={
 'agent.create':{input:z.object({project_id:id.nullable().optional(),name:z.string(),role_instruction:text,capabilities_json:z.array(z.unknown()).nullable().optional(),tool_permissions_json:record,...definition}).strict(),output:AgentReceiptSchema},
 'agent.template.instantiate':{input:z.object({template_id:z.string().trim().min(1).max(128),template_version_id:z.string().nullable().optional(),project_id:id.nullable().optional(),name:z.string().nullable().optional(),...definition}).strict(),output:AgentReceiptSchema},
 'agent.update':{input:z.object({...agent,name:z.string().optional(),role_instruction:text,status:z.string().optional(),...definition}).strict(),output:AgentReceiptSchema},
 'agent.config.update':{input:z.object({...agent,name:z.string().nullable().optional(),...definition}).strict(),output:AgentReceiptSchema},
 'agent.version.restore':{input:z.object({...agent,version_id:id}).strict(),output:AgentReceiptSchema.extend({version_id:id}).strict()},
 'agent.runtime_default.set':{input:SpaceAgentRuntimeDefaultWriteSchema,output:z.object({id,space_id:id}).strict()},
 'agent.assistant_settings.update':{input:z.object({project_id:id.nullable().optional(),response_style:z.string().nullable().optional(),verbosity:z.string().nullable().optional(),default_context_toggles_json:z.record(z.unknown()).nullable().optional(),default_project_id:id.nullable().optional(),proposal_style:z.string().nullable().optional(),model_preferences_json:z.record(z.unknown()).nullable().optional()}).strict(),output:z.object({id,space_id:id,project_id:id.nullable()}).strict()},
 'agent.runtime_profile.create':{input:AgentRuntimeProfileCreateBodySchema.extend(agent).strict(),output:AgentRuntimeProfileReceiptSchema},
 'agent.runtime_profile.update':{input:AgentRuntimeProfileUpdateBodySchema.extend({...agent,profile_id:id}).strict(),output:AgentRuntimeProfileReceiptSchema},
 'agent.runtime_profile.ensure_host':{input:z.object({...agent,execution_host_id:id,workspace_location_id:id.nullable().optional(),workspace_mode:z.enum(['location','managed']),runtime_key:z.string().trim().min(1),runtime_installation:z.string().trim().min(1)}).strict(),output:AgentRuntimeProfileReceiptSchema},
 'conversation.session_config.save':{input:ConversationSessionConfigSaveSchema.extend(agent).strict(),output:z.object({id,space_id:id,agent_id:id,session_id:id}).strict()},
 'agent.run.create':{input:z.object({...agent,...runCreate}).strict(),output:z.object({id,space_id:id,agent_id:id,run_id:id}).strict()},
 'agent.chat.reset_context':{input:z.object(agent).strict(),output:z.object({id,space_id:id,agent_id:id,session_reset:z.literal(true),thread_id:id,workspace_mode:z.enum(['location','managed'])}).strict()},
} as const;
export const AGENT_OPERATION_TITLES:Record<keyof typeof AGENT_OPERATION_SCHEMAS,string>={
 'agent.create':'Create an Agent',
 'agent.template.instantiate':'Create an Agent from a template',
 'agent.update':'Edit an Agent',
 'agent.config.update':'Append an Agent configuration version',
 'agent.version.restore':'Restore an earlier Agent configuration version',
 'agent.runtime_default.set':'Set the Space default for future Agent Runtime Profiles',
 'agent.assistant_settings.update':'Change managed Assistant preferences',
 'agent.runtime_profile.create':'Create an Agent Runtime Profile',
 'agent.runtime_profile.update':'Change an Agent Runtime Profile',
 'agent.runtime_profile.ensure_host':'Bind an Agent to a Host installation',
 'conversation.session_config.save':'Save a conversation runtime session configuration',
 'agent.run.create':'Queue an Agent Run',
 'agent.chat.reset_context':'Reset a direct Agent conversation context',
};

/** Direct conversation turns: the existing request bodies; receipts are the existing acceptance views plus their Space. */
export const AGENT_CHAT_OPERATION_SCHEMAS={
 'agent.chat.send':{input:ChatTurnRequestSchema.innerType().extend(agent).strict().superRefine((value,ctx)=>{if(!value.message&&value.input_parts.length===0)ctx.addIssue({code:'custom',path:['message'],message:'message or an input part is required'});}),output:ChatTurnAcceptedSchema.extend({space_id:id}).strict()},
 'agent.chat.retry':{input:ConversationRetryRequestSchema.extend(agent).strict(),output:ConversationRetryResponseSchema.omit({reused:true}).extend({space_id:id}).strict()},
} as const;
export const AGENT_CHAT_OPERATION_TITLES:Record<keyof typeof AGENT_CHAT_OPERATION_SCHEMAS,string>={
 'agent.chat.send':'Send a direct Agent conversation turn',
 'agent.chat.retry':'Retry a failed direct Agent conversation turn',
};
