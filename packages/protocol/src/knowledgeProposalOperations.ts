import {z} from 'zod';
import {NotePromotionSchema,KnowledgeObjectReceiptSchema} from './knowledgeObjectOperations.js';
import {ClaimCreateProposalPayloadSchema,ClaimUpdateProposalPayloadSchema,ObjectRelationCreateProposalPayloadSchema} from './knowledge.js';
const id=z.string().uuid();
// Transport inputs name business fields, never Proposal/system attribution.
const profile={object_profile_id:id.nullable().optional(),object_profile_fields:z.record(z.unknown()).optional()};
const claimFields={subject_object_id:true,subject_text:true,claim_kind:true,claim_text:true,title:true,normalized_claim_hash:true,holder_object_id:true,holder_type:true,holder_id:true,confidence:true,confidence_method:true,status:true,resolution_state:true,valid_from:true,valid_until:true,observed_at:true,metadata:true,sources:true} as const;
const claimCreate=ClaimCreateProposalPayloadSchema.innerType().pick(claimFields).extend({...profile,claim_kind:ClaimCreateProposalPayloadSchema.innerType().shape.claim_kind.default('fact'),project_id:id.nullable().default(null),project_folder_id:id.nullable().default(null),visibility:z.enum(['private','space_shared','selected_users']).optional(),rationale:z.string().optional()}).strict().superRefine((v,c)=>{if(!v.subject_object_id&&!v.subject_text)c.addIssue({code:'custom',message:'Claim subject required'});});
const claimUpdate=ClaimUpdateProposalPayloadSchema.pick({...claimFields,superseded_by_claim_id:true}).extend({...profile,claim_id:id,rationale:z.string().optional()}).strict();
const sourceRef=z.object({source_type:z.string().min(1).optional(),source_id:z.string().min(1).optional(),type:z.string().min(1).optional(),id:z.string().min(1).optional(),source_trust:z.string().optional(),evidence_json:z.record(z.unknown()).optional()}).strict().superRefine((v,c)=>{if(!(v.source_type??v.type)||!(v.source_id??v.id)||v.source_type&&v.type&&v.source_type!==v.type||v.source_id&&v.id&&v.source_id!==v.id)c.addIssue({code:'custom',message:'One unambiguous provenance source required'});});
const item=NotePromotionSchema.omit({note_id:true}).extend({title:z.string().trim().min(1),source_refs:z.array(sourceRef).default([])});
const itemUpdate=item.omit({project_id:true,project_folder_id:true,visibility:true,owner_user_id:true,subject_user_id:true,content_access_grants:true,knowledge_kind:true}).extend({item_id:id,content_format:NotePromotionSchema.shape.content_format.removeDefault().optional()});
const relation=ObjectRelationCreateProposalPayloadSchema.pick({from_object_id:true,to_object_id:true,link_type:true,status:true,confidence:true,evidence_summary:true,source_claim_id:true,source_object_id:true,metadata:true}).extend({rationale:z.string().nullish(),confidence:z.number().min(0).max(1).nullish(),evidence_summary:z.string().nullish()}).strict();
export const KNOWLEDGE_PROPOSAL_SCHEMAS={
 'knowledge.item.propose_create':{input:item,output:KnowledgeObjectReceiptSchema},
 'knowledge.item.propose_update':{input:itemUpdate,output:KnowledgeObjectReceiptSchema},
 'knowledge.item.propose_archive':{input:z.object({item_id:id}).strict(),output:KnowledgeObjectReceiptSchema},
 'knowledge.claim.propose_create':{input:claimCreate,output:KnowledgeObjectReceiptSchema},
 'knowledge.claim.propose_update':{input:claimUpdate,output:KnowledgeObjectReceiptSchema},
 'knowledge.claim.propose_archive':{input:z.object({claim_id:id}).strict(),output:KnowledgeObjectReceiptSchema},
 'knowledge.relation.propose_create':{input:relation,output:KnowledgeObjectReceiptSchema},
 'knowledge.relation.propose_archive':{input:z.object({relation_id:id}).strict(),output:KnowledgeObjectReceiptSchema},
} as const;
export const KNOWLEDGE_PROPOSAL_TYPES={
 'knowledge.item.propose_create':'knowledge_create','knowledge.item.propose_update':'knowledge_update','knowledge.item.propose_archive':'knowledge_archive',
 'knowledge.claim.propose_create':'claim_create','knowledge.claim.propose_update':'claim_update','knowledge.claim.propose_archive':'claim_archive',
 'knowledge.relation.propose_create':'object_relation_create','knowledge.relation.propose_archive':'object_relation_delete',
} as const;
