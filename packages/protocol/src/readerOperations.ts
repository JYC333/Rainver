import {z} from 'zod';
import {ReaderDocumentTypeSchema,ReaderAnnotationCreateSchema,ReaderAnnotationRangeUpdateSchema,ReaderPositionWriteSchema,ReaderAppearanceSchema,ReaderDocumentNoteCreateSchema} from './reader.js';
/** Retained Reader identities are opaque server ids (no format narrowing versus the legacy routes). */
const id=z.string().min(1).max(64),text=z.string().trim().min(1);
const doc={document_type:ReaderDocumentTypeSchema,document_id:id};
/** Identity/kind only. Bodies stay behind the authorized Reader GET readers, so a replay never returns older content. */
export const ReaderWriteReceiptSchema=z.object({id,space_id:id,document_type:ReaderDocumentTypeSchema.nullable(),document_id:id.nullable(),annotation_id:id.nullable(),kind:z.enum(['annotation','comment','thread','evidence','proposal','appearance','note','job']),job_id:id.optional(),note_space_id:id.optional()}).strict();
export type ReaderWriteReceipt=z.infer<typeof ReaderWriteReceiptSchema>;
/** One-attempt Job for the two writers that must read a file-backed body outside any transaction. */
export const READER_WRITE_JOB='reader_document_write';
/** The two operations whose body read runs in the Reader write Job. */
export const READER_JOB_OPERATIONS=['reader.position.write','reader.annotation.range.replace'] as const;
/** Identity/status only, released by the Reader write-request reader under current document access. */
export const ReaderWriteJobResultSchema=z.object({outcome:z.enum(['applied','not_accepted','conflict','invalid','unavailable']),annotation_id:id.nullable()}).strict();
export type ReaderWriteJobResult=z.infer<typeof ReaderWriteJobResultSchema>;
export const ReaderWriteRequestViewSchema=z.object({job_id:id,status:z.enum(['pending','running','completed','failed','cancelled']),result:ReaderWriteJobResultSchema.nullable()}).strict();
export type ReaderWriteRequestView=z.infer<typeof ReaderWriteRequestViewSchema>;
const output=ReaderWriteReceiptSchema;
const propose={annotation_id:id,title:text.optional(),rationale:z.string().optional()};
export const READER_OPERATION_SCHEMAS={
 'reader.annotation.create':{input:ReaderAnnotationCreateSchema.extend({document_id:id,visibility:z.enum(['private','selected_users','space_shared']).optional()}).strict(),output},
 'reader.annotation.update':{input:z.object({annotation_id:id,color:z.string().nullable().optional(),label:z.string().nullable().optional(),status:z.enum(['active','archived']).optional()}).strict(),output},
 'reader.annotation.archive':{input:z.object({annotation_id:id}).strict(),output},
 'reader.annotation.range.replace':{input:z.object({annotation_id:id,...ReaderAnnotationRangeUpdateSchema.innerType().shape}).strict().refine(v=>v.anchor_json.quote_text===v.quote_text&&v.anchor_json.content_hash===v.content_hash&&v.anchor_json.structure_hash===v.structure_hash&&v.anchor_json.text_range.end>=v.anchor_json.text_range.start),output},
 'reader.comment.create':{input:z.object({annotation_id:id,body:text}).strict(),output},
 'reader.comment.update':{input:z.object({comment_id:id,body:text.optional(),status:z.enum(['active','archived']).optional()}).strict(),output},
 'reader.thread.update':{input:z.object({thread_id:id,status:z.enum(['open','resolved','archived'])}).strict(),output},
 'reader.evidence.create':{input:z.object({annotation_id:id,title:text.optional()}).strict(),output},
 'reader.memory.propose':{input:z.object({...propose,proposal_type:z.literal('memory_create')}).strict(),output},
 'reader.knowledge.propose':{input:z.object({...propose,proposal_type:z.literal('knowledge_create')}).strict(),output},
 'reader.position.write':{input:ReaderPositionWriteSchema.extend(doc).strict(),output},
 'reader.appearance.set':{input:ReaderAppearanceSchema,output},
 'reader.document_note.create':{input:ReaderDocumentNoteCreateSchema.extend(doc).strict(),output},
} as const;
export type ReaderOperationId=keyof typeof READER_OPERATION_SCHEMAS;
export const READER_OPERATION_TITLES:Record<ReaderOperationId,string>={
 'reader.annotation.create':'Create a Reader annotation','reader.annotation.update':'Update a Reader annotation','reader.annotation.archive':'Remove a Reader annotation',
 'reader.annotation.range.replace':'Adjust an annotation quote','reader.comment.create':'Comment on an annotation','reader.comment.update':'Edit or remove a comment',
 'reader.thread.update':'Resolve, reopen or archive a comment thread','reader.evidence.create':'Create candidate Evidence from an annotation',
 'reader.memory.propose':'Propose a Memory from an annotation','reader.knowledge.propose':'Propose a Knowledge Item from an annotation',
 'reader.position.write':'Save a reading position','reader.appearance.set':'Save Reader appearance','reader.document_note.create':'Create a document note',
};
