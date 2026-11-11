import {z} from 'zod';
import {
 CreateRoomRequestSchema,RoomAgentAddRequestSchema,RoomAgentPresetRequestSchema,RoomAgentResetContextRequestSchema,
 RoomInvitationCreateRequestSchema,RoomInvitationDecisionRequestSchema,RoomOwnerTransferRequestSchema,
 SendRoomMessageRequestSchema,ContinueRoomAfterProposalRequestSchema,
} from './rooms.js';
import {OpenRoomDiscussionRequestSchema,ExtendRoomDiscussionRequestSchema} from './roomDiscussions.js';
import {AttachThreadReferencesRequestSchema} from './threadReferences.js';
import {ConversationRetryRequestSchema,ConversationRetryResponseSchema} from './memorySessions.js';

const id=z.string().trim().min(1).max(36);
const room={room_id:id};
const conversation={room_id:id,session_id:id};
/** Identities only; the person re-reads current Room state through its GET reads. */
export const RoomReceiptSchema=z.object({id,space_id:id,room_id:id}).strict();
const receipt=RoomReceiptSchema;
const conversationReceipt=receipt.extend({session_id:id}).strict();
const turnReceipt=conversationReceipt.extend({message_id:id,task_group_ids:z.array(id).min(1),run_ids:z.array(id).min(1)}).strict();

export const ROOM_OPERATION_SCHEMAS={
 'room.create':{input:CreateRoomRequestSchema,output:receipt.extend({project_id:id}).strict()},
 'room.agent.add':{input:RoomAgentAddRequestSchema.extend(room).strict(),output:receipt.extend({agent_id:id,restore_requested:z.boolean()}).strict()},
 'room.agent.add_preset':{input:RoomAgentPresetRequestSchema.extend(room).strict(),output:receipt},
 'room.agent.remove':{input:z.object({...room,agent_id:id}).strict(),output:receipt.extend({agent_id:id,revoked_grant_count:z.number().int().nonnegative()}).strict()},
 'room.agent.reset_context':{input:RoomAgentResetContextRequestSchema.extend({...room,agent_id:id}).strict(),output:receipt.extend({agent_id:id}).strict()},
 'room.agent.summarize_context':{input:z.object({...room,agent_id:id}).strict(),output:receipt.extend({agent_id:id}).strict()},
 'room.agent.restart_from_summary':{input:z.object({...room,agent_id:id}).strict(),output:receipt.extend({agent_id:id}).strict()},
 'room.invitation.create':{input:RoomInvitationCreateRequestSchema.extend(room).strict(),output:receipt.extend({invitation_id:id}).strict()},
 'room.invitation.decide':{input:RoomInvitationDecisionRequestSchema.extend({...room,invitation_id:id}).strict(),output:receipt.extend({invitation_id:id}).strict()},
 'room.member.remove':{input:z.object({...room,user_id:id}).strict(),output:receipt.extend({user_id:id}).strict()},
 'room.owner.transfer':{input:RoomOwnerTransferRequestSchema.extend(room).strict(),output:receipt},
 'room.owner.claim':{input:z.object(room).strict(),output:receipt},
 'room.conversation.create':{input:z.object(room).strict(),output:conversationReceipt},
 'room.conversation.attach_references':{input:AttachThreadReferencesRequestSchema.extend(conversation).strict(),output:conversationReceipt.extend({attached:z.number().int().nonnegative()}).strict()},
 'room.message.send':{input:SendRoomMessageRequestSchema.innerType().extend(conversation).strict().superRefine((value,ctx)=>{
   if(!value.content&&value.input_parts.length===0)ctx.addIssue({code:'custom',path:['content'],message:'content or an input part is required'});
   if(value.coordination_target_agent_ids?.length&&value.routing_mode!=='agent_coordination')ctx.addIssue({code:'custom',path:['coordination_target_agent_ids'],message:'coordination targets require routing_mode agent_coordination'});
  }),
  output:z.discriminatedUnion('status',[turnReceipt.extend({status:z.literal('sent')}).strict(),conversationReceipt.extend({status:z.literal('queued'),queued_id:id}).strict()])},
 'room.message.withdraw_queued':{input:z.object({...conversation,queued_id:id}).strict(),output:conversationReceipt.extend({queued_id:id}).strict()},
 'room.message.retry':{input:ConversationRetryRequestSchema.extend(conversation).strict(),output:ConversationRetryResponseSchema.omit({reused:true}).extend({space_id:id,room_id:id}).strict()},
 'room.message.continue_after_proposal':{input:ContinueRoomAfterProposalRequestSchema.extend(conversation).strict(),output:turnReceipt},
 'room.quota.continue':{input:z.object(conversation).strict(),output:conversationReceipt},
 'room.discussion.start':{input:OpenRoomDiscussionRequestSchema.extend(conversation).strict(),output:turnReceipt.extend({discussion_id:id}).strict()},
 'room.discussion.stop':{input:z.object({...conversation,discussion_id:id}).strict(),output:conversationReceipt.extend({discussion_id:id}).strict()},
 'room.discussion.extend':{input:ExtendRoomDiscussionRequestSchema.extend({...conversation,discussion_id:id}).strict(),output:conversationReceipt.extend({discussion_id:id}).strict()},
} as const;
export const ROOM_OPERATION_TITLES:Record<keyof typeof ROOM_OPERATION_SCHEMAS,string>={
 'room.create':'Open a Room in a Project',
 'room.agent.add':'Add an Agent to a Room',
 'room.agent.add_preset':'Add a preset Agent to a Room',
 'room.agent.remove':'Remove an Agent from a Room',
 'room.agent.reset_context':"Reset a Room Agent's Host session",
 'room.agent.summarize_context':'Ask a Room Agent to summarize its context',
 'room.agent.restart_from_summary':'Restart a Room Agent from its summary',
 'room.invitation.create':'Invite a person to a Room',
 'room.invitation.decide':'Decide a private-Agent share for a Room invitation',
 'room.member.remove':'Remove a person from a Room',
 'room.owner.transfer':'Transfer Room ownership',
 'room.owner.claim':'Claim an ownerless Room',
 'room.conversation.create':'Open a Room conversation draft',
 'room.conversation.attach_references':'Copy picked content into a Room conversation',
 'room.message.send':'Send or queue a Room message',
 'room.message.withdraw_queued':'Withdraw a queued Room message',
 'room.message.retry':'Retry a failed Room turn',
 'room.message.continue_after_proposal':'Continue a Room after a Proposal decision',
 'room.quota.continue':'Continue a Room conversation past its turn quota',
 'room.discussion.start':'Open a Room discussion',
 'room.discussion.stop':'Stop a Room discussion',
 'room.discussion.extend':'Extend a Room discussion',
};
