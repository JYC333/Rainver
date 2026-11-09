import {z} from 'zod';
const id=z.string().trim().min(1).max(36), text=z.string().trim().min(1), obj=z.record(z.unknown());
const sourceFields={title:z.string().optional(),summary:z.string().nullable().optional(),uri:z.string().nullable().optional(),content_ref:z.string().nullable().optional(),raw_text:z.string().nullable().optional(),metadata:obj.optional(),status:z.enum(['raw','processing','processed','archived','error']).optional()};
export const EvidenceSourceCreateSchema=z.object({...sourceFields,title:text,source_type:z.enum(['activity_record','chat_capture','webpage','article','paper','pdf','file','email','manual_reference','external_note']),visibility:z.enum(['private','space_shared','selected_users']).optional(),project_id:id.nullable().default(null),project_folder_id:id.nullable().default(null),source_activity_id:id.nullable().default(null)}).strict();
export const EvidenceSourceUpdateSchema=z.object({source_id:id,changes:z.object(sourceFields).strict()}).strict();
export const EvidenceSourceTargetSchema=z.object({source_id:id}).strict();
export const KnowledgeObjectReceiptSchema=z.object({id,space_id:id}).strict();
export const NotePromotionSchema=z.object({note_id:id,content:text,title:z.string().optional(),knowledge_kind:z.enum(['concept','lesson','procedure','decision','question','answer','summary']).default('concept'),content_format:z.enum(['markdown','plain','prosemirror_json']).default('markdown'),project_id:id.nullable().default(null),project_folder_id:id.nullable().default(null),visibility:z.enum(['private','space_shared','selected_users']).default('space_shared'),rationale:z.string().nullable().default(null),tags:z.array(z.string()).default([]),aliases:z.array(z.string()).optional(),slug:z.string().nullable().optional(),confidence:z.number().min(0).max(1).nullable().optional(),content_json:obj.nullable().optional(),content_schema_version:z.number().int().positive().optional(),verification_status:z.string().optional(),reflection_status:z.string().optional(),source_run_id:id.nullable().optional(),pinned_source_ref:obj.nullable().optional(),source_refs:z.array(obj).default([]),object_profile_fields:obj.optional(),object_profile_id:id.nullable().optional(),owner_user_id:id.nullable().optional(),subject_user_id:id.nullable().optional(),content_access_grants:z.array(obj).optional()}).strict();
export const KNOWLEDGE_OBJECT_SCHEMAS={
 'knowledge.source.create':{input:EvidenceSourceCreateSchema,output:KnowledgeObjectReceiptSchema},
 'knowledge.source.update':{input:EvidenceSourceUpdateSchema,output:KnowledgeObjectReceiptSchema},
 'knowledge.source.archive':{input:EvidenceSourceTargetSchema,output:KnowledgeObjectReceiptSchema},
 'note.promote_to_knowledge':{input:NotePromotionSchema,output:KnowledgeObjectReceiptSchema},
} as const;
