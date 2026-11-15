import {z} from 'zod';
import {SpaceOversightModeSchema} from './common.js';
import {SpaceRetrievalSettingsUpdateSchema} from './knowledgeRetrieval.js';

/** Retained Space and content identities are opaque server ids (no format narrowing versus the legacy routes). */
const id=z.string().min(1).max(128);
const space={space_id:id};
const role=z.enum(['owner','admin','reviewer','member','guest']);
/**
 * The caller generates the invitation secret and keeps it to build the claim
 * link; the server stores only its hash and the request fingerprint keys it.
 * A receipt therefore never carries the secret, so a replay cannot disclose it.
 * 256 bits of base64url at minimum.
 */
export const SpaceInvitationTokenSchema=z.string().regex(/^[A-Za-z0-9_-]{43,256}$/);
const visibility=z.enum(['private','selected_users','space_shared']);
const accessLevel=z.enum(['full','summary']);
const resource={resource_type:z.string().min(1).max(64),resource_id:id};
const accessUpdate={
 visibility,access_level:accessLevel,project_id:id.nullable(),
 grants:z.array(z.object({user_id:id,access_level:accessLevel.default('full')}).strict()).max(500),
};
/** Identity only. Space rows, settings and policies are reread through their authorized GET readers. */
export const SpaceReceiptSchema=z.object({space_id:id}).strict();
export const SpaceInvitationReceiptSchema=z.object({invitation_id:id,space_id:id,invited_email:z.string(),role,status:z.string(),expires_at:z.string()}).strict();
export const SpaceInvitationAcceptReceiptSchema=z.object({space_id:id.nullable()}).strict();
export const ContentAccessReceiptSchema=z.object({space_id:id,resource_type:z.string(),resource_id:id}).strict();
export const ContentDemotionDisclosureReceiptSchema=z.object({space_id:id,resource_type:z.string(),resource_id:id,confirmation_id:id,target_visibility:z.enum(['private','selected_users']),expires_at:z.string()}).strict();
export const ContentPublicationReceiptSchema=z.object({space_id:id,proposal_id:id,required_approver_user_ids:z.array(id)}).strict();
export const SPACE_OPERATION_SCHEMAS={
 'space.create':{input:z.object({name:z.string().trim().min(1).max(200),type:z.enum(['household','team']).default('team'),oversight_mode:SpaceOversightModeSchema.default('none')}).strict(),output:SpaceReceiptSchema},
 'space.invitation.create':{input:z.object({...space,email:z.string().trim().min(3).max(320).email(),role:role.default('member'),token:SpaceInvitationTokenSchema}).strict(),output:SpaceInvitationReceiptSchema},
 'space.invitation.accept':{input:z.object({token:z.string().min(1).max(512)}).strict(),output:SpaceInvitationAcceptReceiptSchema},
 'space.snapshot_defaults.update':{input:z.object({...space,snapshot_retention_days_default:z.number().int().positive().nullable().default(null),snapshot_max_count_default:z.number().int().positive().nullable().default(null)}).strict(),output:SpaceReceiptSchema},
 'space.content_egress.update':{input:z.object({...space,member_copy_out_enabled:z.boolean()}).strict(),output:SpaceReceiptSchema},
 'space.retrieval_settings.update':{input:SpaceRetrievalSettingsUpdateSchema.extend(space).strict(),output:SpaceReceiptSchema},
 'content.access.update':{input:z.object({...resource,...accessUpdate,demotion_confirmation_id:id.optional()}).strict(),output:ContentAccessReceiptSchema},
 'content.demotion.disclose':{input:z.object({...resource,target_visibility:z.enum(['private','selected_users'])}).strict(),output:ContentDemotionDisclosureReceiptSchema},
 'content.publication.request':{input:z.object({...resource,...accessUpdate,visibility:z.literal('space_shared')}).strict(),output:ContentPublicationReceiptSchema},
} as const;
export type SpaceOperationId=keyof typeof SPACE_OPERATION_SCHEMAS;
export const SPACE_OPERATION_TITLES:Record<SpaceOperationId,string>={
 'space.create':'Create a Space','space.invitation.create':'Invite a person to a Space','space.invitation.accept':'Accept a Space invitation',
 'space.snapshot_defaults.update':'Set Space snapshot defaults','space.content_egress.update':'Allow or stop member copy-out from a Space',
 'space.retrieval_settings.update':'Update Space retrieval settings','content.access.update':'Change who may read content',
 'content.demotion.disclose':'Disclose current exposure before narrowing content','content.publication.request':'Request owner review to publish tainted content',
};
