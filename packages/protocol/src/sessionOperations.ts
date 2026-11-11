import {z} from 'zod';
import {MessageCreateRequestSchema} from './memorySessions.js';
import {ConversationExecutionInitializeRequestSchema,ConversationExecutionPreflightRequestSchema,ConversationExecutionPreflightResponseSchema,ConversationAttachmentMutationSchema} from './conversationExecution.js';
const id=z.string().trim().min(1).max(36);
const session={session_id:id};
const receipt=z.object({id,space_id:id,session_id:id}).strict();
const [attach,setAccess,revoke]=ConversationAttachmentMutationSchema.options;
/** Direct conversation sessions and their execution context. Receipts carry identities; current state is re-read. */
export const SESSION_OPERATION_SCHEMAS={
 'session.create':{input:z.object({project_id:id.nullable().optional(),project_folder_id:id.nullable().optional(),title:z.string().nullable().optional(),metadata:z.record(z.unknown()).nullable().optional()}).strict(),output:receipt},
 'session.delete':{input:z.object(session).strict(),output:receipt},
 'session.message.add':{input:MessageCreateRequestSchema.innerType().extend(session).strict().superRefine((value,ctx)=>{if(!value.content&&value.input_parts.length===0)ctx.addIssue({code:'custom',path:['content'],message:'content or an input part is required'});}),output:receipt.extend({message_id:id}).strict()},
 'session.reflect':{input:z.object(session).strict(),output:receipt.extend({proposals_created:z.number().int().nonnegative()}).strict()},
 'conversation.execution.initialize':{input:ConversationExecutionInitializeRequestSchema.extend(session).strict(),output:receipt},
 'conversation.execution.attachment.mutate':{input:z.discriminatedUnion('action',[attach.extend(session).strict(),setAccess.extend(session).strict(),revoke.extend(session).strict()]),output:receipt.extend({attachment_id:id,effective_after_run_id:id.nullable()}).strict()},
} as const;
/** A read of the person's current choices for a conversation's execution context; it changes nothing. */
export const SESSION_QUERY_SCHEMAS={
 'conversation.execution.preflight':{input:ConversationExecutionPreflightRequestSchema.extend(session).strict(),output:ConversationExecutionPreflightResponseSchema},
} as const;
export const SESSION_OPERATION_TITLES:Record<keyof typeof SESSION_OPERATION_SCHEMAS|keyof typeof SESSION_QUERY_SCHEMAS,string>={
 'session.create':'Open a direct conversation session',
 'session.delete':'Delete a direct conversation session',
 'session.message.add':'Add a message to a direct conversation',
 'session.reflect':'Propose a private Memory from a conversation',
 'conversation.execution.initialize':'Initialize a conversation execution context',
 'conversation.execution.attachment.mutate':'Change a conversation Folder attachment',
 'conversation.execution.preflight':'Preview a conversation execution selection',
};
