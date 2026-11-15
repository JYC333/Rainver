import {z} from 'zod';
/** Ordinary Source item / extracted-evidence object commands and human Note
 * links. Receipts carry identity only; content stays behind the canonical
 * authorized readers, so a replay never returns an older body. */
const id=z.string().trim().min(1).max(64);
const meta=z.record(z.unknown());
const url=z.string().trim().min(1).max(4000).refine(value=>{try{new URL(value);return true;}catch{return false;}},{message:'url must be a valid URL'});
const evidenceStatus=z.enum(['candidate','active','rejected','archived']);
/** Placement follows the connection when one is named; otherwise the access
 * owner places the item (Project when given, else the caller's Personal Space).
 * With a connection, project_id must name the connection's own Project, or,
 * for a connection without one, a Project the caller writes. */
export const SourceItemSaveUrlInputSchema=z.object({url,title:z.string().trim().min(1).max(2000).optional(),project_id:id.nullable().default(null),connection_id:id.nullable().default(null),queue_content:z.boolean().default(false)}).strict();
export const SourceItemUpdateInputSchema=z.object({source_item_id:id,connection_id:id.nullable()}).strict();
/** Retention-widening processing requests: they write an extraction Job intent only. */
export const SourceItemQueueInputSchema=z.object({source_item_id:id,action:z.enum(['queue_content','archive_snapshot'])}).strict();
/** The reader's own triage state, or one candidate excerpt Evidence row. */
export const SourceItemTriageInputSchema=z.object({source_item_id:id,action:z.enum(['mark_selected','mark_ignored','read_later','mark_discussed','extract_evidence'])}).strict();
/** Structured metadata of the consent refusal: the connection's retention
 * policy forbids the requested level. Carried in `error.metadata`. */
export const SOURCE_RETENTION_REFUSAL_CODE='source_retention_policy' as const;
export const SourceRetentionRefusalMetadataSchema=z.object({code:z.literal(SOURCE_RETENTION_REFUSAL_CODE),requested:z.enum(['metadata_only','summary_only','full_text','full_snapshot','archived'])}).strict();
export type SourceRetentionRefusalMetadata=z.infer<typeof SourceRetentionRefusalMetadataSchema>;
export const SourceItemReceiptSchema=z.object({id,space_id:id}).strict();
/** With a source item/artifact the source decides the Project; a project_id
 * may restate it but never differ from it. */
export const SourceEvidenceCreateInputSchema=z.object({
  title:z.string().trim().min(1).max(2000),
  source_item_id:id.nullable().default(null),
  artifact_id:id.nullable().default(null),
  project_id:id.nullable().default(null),
  source_object_type:z.string().trim().min(1).max(64).nullable().default(null),
  source_object_id:id.nullable().default(null),
  evidence_type:z.string().trim().min(1).max(64).default('excerpt'),
  content_excerpt:z.string().max(200000).nullable().default(null),
  source_uri:z.string().trim().max(4000).nullable().default(null),
  occurred_at:z.string().datetime({offset:true}).nullable().default(null),
  trust_level:z.string().trim().min(1).max(32).default('normal'),
  extraction_method:z.string().trim().min(1).max(64).default('manual'),
  confidence:z.number().finite().nullable().default(null),
  status:evidenceStatus.exclude(['active']).default('candidate'),
  metadata:meta.nullable().default(null),
}).strict();
export const SourceEvidenceUpdateInputSchema=z.object({evidence_id:id,status:evidenceStatus.optional(),confidence:z.number().finite().optional(),metadata:meta.nullable().optional()}).strict().refine(v=>Object.keys(v).length>1,{message:'No changes'});
export const SourceEvidenceReceiptSchema=z.object({id,space_id:id}).strict();
export const SourceEvidenceLinkInputSchema=z.object({
  evidence_id:id,
  target_type:z.enum(['space','project_folder','project','user','agent','run','proposal','artifact','knowledge','memory','task']),
  target_id:id.nullable().default(null),
  link_type:z.enum(['supports','contradicts','derived_from','mentions','context_candidate','used_in_context']).default('context_candidate'),
  status:z.enum(['active','candidate','rejected','archived']).default('active'),
  confidence:z.number().finite().nullable().default(null),
  reason:z.string().trim().max(4000).nullable().default(null),
}).strict();
export const SourceEvidenceLinkReceiptSchema=z.object({id,space_id:id,evidence_id:id}).strict();
const noteLinkType=z.enum(['related_to','references','depends_on','part_of','source_for','derived_from','about','supports','contradicts','supersedes','refines','same_as','explains','prerequisite_of','example_of','applies_to','summarizes','updates']);
export const NoteLinkCreateInputSchema=z.object({note_id:id,target_type:z.string().trim().min(1).max(64),target_id:id,link_type:noteLinkType.default('related_to'),confidence:z.number().min(0).max(1).nullable().default(null),direction:z.enum(['outgoing','incoming']).default('outgoing')}).strict();
export const NoteLinkDeleteInputSchema=z.object({note_id:id,link_id:id}).strict();
export const NoteLinkReceiptSchema=z.object({id,space_id:id,note_id:id}).strict();
/** Atomic Note + link capture: with a target, one team Note per target; without
 * one, the Project inbox Note. */
export const NoteJotInputSchema=z.object({text:z.string().trim().min(1).max(100000),target_id:id.nullable().default(null),note_id:id.nullable().default(null),project_id:id.nullable().default(null),collection_id:id.nullable().default(null),link_type:noteLinkType.default('references')}).strict().refine(v=>!!v.target_id||!!v.project_id,{message:'A jot without a target requires project_id'});
export const NoteJotReceiptSchema=z.object({id,space_id:id}).strict();
export const SOURCE_OBJECT_SCHEMAS={
  'source.item.save_url':{input:SourceItemSaveUrlInputSchema,output:SourceItemReceiptSchema},
  'source.item.update':{input:SourceItemUpdateInputSchema,output:SourceItemReceiptSchema},
  'source.item.queue':{input:SourceItemQueueInputSchema,output:SourceItemReceiptSchema},
  'source.item.triage':{input:SourceItemTriageInputSchema,output:SourceItemReceiptSchema},
  'source.evidence.create':{input:SourceEvidenceCreateInputSchema,output:SourceEvidenceReceiptSchema},
  'source.evidence.update':{input:SourceEvidenceUpdateInputSchema,output:SourceEvidenceReceiptSchema},
  'source.evidence.link':{input:SourceEvidenceLinkInputSchema,output:SourceEvidenceLinkReceiptSchema},
} as const;
export const NOTE_LINK_SCHEMAS={
  'knowledge.note.link.create':{input:NoteLinkCreateInputSchema,output:NoteLinkReceiptSchema},
  'knowledge.note.link.delete':{input:NoteLinkDeleteInputSchema,output:NoteLinkReceiptSchema},
  'knowledge.note.jot':{input:NoteJotInputSchema,output:NoteJotReceiptSchema},
} as const;
/** [title, owning module, application service, policy action, side effects]. */
export const SOURCE_OBJECT_DEFINITIONS:Record<keyof typeof SOURCE_OBJECT_SCHEMAS|keyof typeof NOTE_LINK_SCHEMAS,readonly [string,string,string,string,'durable']>={
  'source.item.save_url':['Save a URL as a Source item','sources','PgSourcesRepository.createManualUrl','source.item_create','durable'],
  'source.item.update':['Change a saved URL item\'s Source','sources','PgSourcesRepository.updateItem','source.item_update','durable'],
  'source.item.queue':['Queue Source item content or snapshot','sources','PgSourcesRepository.itemAction','source.item_create','durable'],
  'source.item.triage':['Triage a Source item','sources','PgSourcesRepository.itemAction','source.item_update','durable'],
  'source.evidence.create':['Create extracted evidence','sources','PgSourcesRepository.createEvidence','evidence.create','durable'],
  'source.evidence.update':['Review extracted evidence','sources','PgSourcesRepository.updateEvidence','evidence.update','durable'],
  'source.evidence.link':['Link extracted evidence','sources','PgSourcesRepository.createEvidenceLink','evidence.link','durable'],
  'knowledge.note.link.create':['Link a Note','knowledge','PgKnowledgeRepository.createNoteLink','note.link.create','durable'],
  'knowledge.note.link.delete':['Remove a Note link','knowledge','PgKnowledgeRepository.deleteNoteLink','note.link.create','durable'],
  'knowledge.note.jot':['Jot a Note','knowledge','PgKnowledgeRepository.jotNoteForObject','note.link.create','durable'],
};
