import {z} from 'zod';
const id=z.string().uuid(), text=z.string().trim().min(1), nullable=z.string().nullable().optional();
const provenance=z.enum(['manual','import','source_sync','agent']).default('manual');
const date=z.string().refine(value=>Number.isFinite(Date.parse(value)),'Invalid date');
const confidence=z.number().min(0).max(1).nullable().optional();
const person={title:text,summary:nullable,pronouns:nullable,headline:nullable};
const receipt=z.object({id,space_id:id,object_id:id.nullable(),kind:z.enum(['person','organization','identity','note','source_link','proposal'])}).strict();
export const RELATION_OPERATION_SCHEMAS={
 'relation.person.create':{input:z.object({...person,project_id:id.nullable().default(null)}).strict(),output:receipt},
 'relation.person.update':{input:z.object({object_id:id,title:text.optional(),summary:nullable,pronouns:nullable,headline:nullable}).strict(),output:receipt},
 'relation.person.archive':{input:z.object({object_id:id}).strict(),output:receipt},
 'relation.organization.create':{input:z.object({title:text,summary:nullable,project_id:id.nullable().default(null),org_type:z.enum(['company','university','lab','research_group','nonprofit','government','community','family','other']).default('other'),homepage_url:nullable,parent_organization_object_id:id.nullable().optional()}).strict(),output:receipt},
 'relation.identity.create':{input:z.object({object_id:id,id_type:z.enum(['email','url','phone','orcid','github','twitter','linkedin','other']),id_value:text,is_primary:z.boolean().default(false),confidence,source:provenance}).strict(),output:receipt},
 'relation.identity.delete':{input:z.object({identity_id:id}).strict(),output:receipt},
 'relation.affiliation.propose':{input:z.object({person_object_id:id,organization_object_id:id,role:nullable,title:nullable,start_date:date.nullable().optional(),end_date:date.nullable().optional(),confidence,source:provenance}).strict(),output:receipt},
 'relation.affiliation.end.propose':{input:z.object({affiliation_id:id,end_date:date.nullable().optional()}).strict(),output:receipt},
 'relation.note.create':{input:z.object({object_id:id,body:text}).strict(),output:receipt},
 'relation.source_link.create':{input:z.object({object_id:id,link_type:z.enum(['activity','source_item','evidence','external']),activity_id:id.nullable().optional(),source_item_id:id.nullable().optional(),evidence_id:id.nullable().optional(),external_ref:nullable,note:nullable}).strict().superRefine((v,c)=>{const fields={activity:v.activity_id,source_item:v.source_item_id,evidence:v.evidence_id,external:v.external_ref};if(!fields[v.link_type]||Object.values(fields).filter(Boolean).length!==1)c.addIssue({code:'custom',message:'Exactly one matching source target required'});}),output:receipt},
} as const;
