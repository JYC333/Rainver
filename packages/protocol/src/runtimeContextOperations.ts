import {z} from 'zod';
import {IdSchema} from './common.js';
import {
 RuntimeContextPolicyScopeSchema,RuntimeContextPolicyWriteRequestSchema,SemanticCheckpointCorrectionRequestSchema,
 WorkContextSetupWriteRequestSchema,WorkRetrievalSwitchRequestSchema,
} from './runtimeContext.js';

/** Identity only. Policies, Setups, switches and corrections are reread through their authorized GET readers. */
export const RuntimeContextPolicyReceiptSchema=z.object({space_id:IdSchema,scope_type:RuntimeContextPolicyScopeSchema,scope_id:IdSchema,version_id:IdSchema}).strict();
export const WorkContextSetupReceiptSchema=z.object({space_id:IdSchema,work_context_scope_id:IdSchema,setup_id:IdSchema,version:z.number().int().positive()}).strict();
export const RoomConversationRetrievalReceiptSchema=z.object({space_id:IdSchema,session_id:IdSchema}).strict();
export const CheckpointCorrectionReceiptSchema=z.object({space_id:IdSchema,work_context_scope_id:IdSchema,correction_id:IdSchema}).strict();
export const RUNTIME_CONTEXT_OPERATION_SCHEMAS={
 /** The governing version chain keeps its stale-base, no-widening and preference-conflict rules. */
 'runtime_context.policy.write':{input:RuntimeContextPolicyWriteRequestSchema.extend({scope_type:RuntimeContextPolicyScopeSchema,scope_id:IdSchema}).strict(),output:RuntimeContextPolicyReceiptSchema},
 'runtime_context.work_context.create':{input:WorkContextSetupWriteRequestSchema,output:WorkContextSetupReceiptSchema},
 /** The next Setup version of a direct conversation's scope, carrying every other part over. */
 'runtime_context.work_context.retrieval.set':{input:WorkRetrievalSwitchRequestSchema.extend({work_context_scope_id:IdSchema}).strict(),output:WorkContextSetupReceiptSchema},
 /** One shared switch per Room Conversation, independent of recipients. */
 'runtime_context.room_conversation.retrieval.set':{input:WorkRetrievalSwitchRequestSchema.extend({session_id:IdSchema}).strict(),output:RoomConversationRetrievalReceiptSchema},
 'runtime_context.checkpoint.correct':{input:SemanticCheckpointCorrectionRequestSchema.extend({work_context_scope_id:IdSchema}).strict(),output:CheckpointCorrectionReceiptSchema},
} as const;
export type RuntimeContextOperationId=keyof typeof RUNTIME_CONTEXT_OPERATION_SCHEMAS;
export type RuntimeContextOperationInput<Id extends RuntimeContextOperationId>=z.output<(typeof RUNTIME_CONTEXT_OPERATION_SCHEMAS)[Id]['input']>;
export const RUNTIME_CONTEXT_OPERATION_TITLES:Record<RuntimeContextOperationId,string>={
 'runtime_context.policy.write':'Change a Runtime Context Policy',
 'runtime_context.work_context.create':'Save a Work Context Setup',
 'runtime_context.work_context.retrieval.set':'Turn conversation knowledge retrieval on or off',
 'runtime_context.room_conversation.retrieval.set':'Turn Room Conversation knowledge retrieval on or off',
 'runtime_context.checkpoint.correct':'Correct a semantic checkpoint',
};
