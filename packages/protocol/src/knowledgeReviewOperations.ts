import {z} from 'zod';
const id=z.string().trim().min(1).max(36),text=z.string().trim().min(1);
const target={project_id:id,candidate_id:id};
const draft={project_id:id,candidate_kind:z.enum(['concept','lesson','procedure','decision','summary']),proposed_title:text,proposed_content:text,supersedes_knowledge_item_id:id.nullable().default(null)};
const receipt=z.object({id,space_id:id,project_id:id.nullable(),item_id:id.nullable()}).strict();
export const KNOWLEDGE_REVIEW_SCHEMAS={
 'knowledge.evidence.add':{input:z.object({item_id:id,source_id:id,relation_type:z.string().trim().min(1).max(32).optional(),link_type:z.string().trim().min(1).max(32).optional(),locator:z.string().nullable().default(null),quote:z.string().nullable().default(null),note:z.string().nullable().default(null),confidence:z.number().min(0).max(1).nullable().default(null)}).strict(),output:receipt},
 'knowledge.evidence.remove':{input:z.object({item_id:id,link_id:id}).strict(),output:receipt},
 'knowledge.candidate.from_note':{input:z.object({...draft,note_id:id,block_anchors:z.array(z.number().int().nonnegative()).default([])}).strict(),output:receipt},
 'knowledge.candidate.from_thread':{input:z.object({...draft,thread_id:id}).strict(),output:receipt},
 'knowledge.candidate.from_interpretation':{input:z.object({...draft,interpretation_id:id}).strict(),output:receipt},
 'knowledge.candidate.decide':{input:z.object({...target,decision:z.enum(['promote','dismiss','defer']),proposed_title:z.string().optional(),proposed_content:z.string().optional()}).strict(),output:receipt},
 'knowledge.candidate.reopen':{input:z.object(target).strict(),output:receipt},
 'knowledge.candidate.packet.open':{input:z.object({project_id:id,limit:z.number().int().default(10)}).strict(),output:receipt},
 'knowledge.candidate.packet.close':{input:z.object({project_id:id,packet_id:id}).strict(),output:receipt},
} as const;

export const KNOWLEDGE_REVIEW_TITLES:Record<keyof typeof KNOWLEDGE_REVIEW_SCHEMAS,string>={
 'knowledge.evidence.add':'Add curated Source evidence',
 'knowledge.evidence.remove':'Remove curated Source evidence',
 'knowledge.candidate.from_note':'Draft a Candidate from a Note',
 'knowledge.candidate.from_thread':'Draft a Candidate from a Thread',
 'knowledge.candidate.from_interpretation':'Draft a Candidate from a converted Interpretation',
 'knowledge.candidate.decide':'Review a Knowledge Candidate',
 'knowledge.candidate.reopen':'Reopen a deferred Candidate',
 'knowledge.candidate.packet.open':'Open a Knowledge review packet',
 'knowledge.candidate.packet.close':'Close my Knowledge review packet',
};
