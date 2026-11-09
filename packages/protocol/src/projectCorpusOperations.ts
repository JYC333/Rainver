import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
const fields={role:z.enum(['candidate','reference','primary','related','background']).nullable().optional(),status:z.enum(['active','archived']).nullable().optional(),triage_status:z.enum(['new','relevant','maybe','excluded','included']).nullable().optional(),read_status:z.enum(['unread','skimmed','read','discussed']).nullable().optional(),relevance:z.enum(['relevant','maybe','not_relevant']).nullable().optional(),confidence:z.preprocess(value=>value===''?null:value,z.coerce.number().min(0).max(1).nullable()).optional(),reason:z.string().transform(value=>value.trim()||null).nullable().optional(),metadata_json:z.record(z.unknown()).nullable().optional()};
const output=z.object({id,project_id:id,space_id:id}).strict();
export const PROJECT_CORPUS_SCHEMAS={
 'project.corpus.upsert':{input:z.object({project_id:id,object_id:id.nullable().optional(),source_item_id:id.nullable().optional(),evidence_id:id.nullable().optional(),source_connection_id:id.nullable().optional(),source_decision_id:id.nullable().optional(),...fields}).strict().refine(v=>[v.object_id,v.source_item_id,v.evidence_id].filter(Boolean).length===1,'Supply exactly one Corpus reference'),output},
 'project.corpus.update':{input:z.object({project_id:id,corpus_item_id:id,...fields}).strict(),output},
} as const;
export const PROJECT_CORPUS_TITLES:Record<keyof typeof PROJECT_CORPUS_SCHEMAS,string>={
 'project.corpus.upsert':'Add or update a Project Corpus reference',
 'project.corpus.update':'Update Project Corpus triage and reading state',
};
