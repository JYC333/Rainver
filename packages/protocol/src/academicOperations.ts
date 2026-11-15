import {z} from 'zod';
const id=z.string().uuid(),text=z.string().trim().min(1),nullable=z.string().nullable().optional();
const receipt=z.object({id,space_id:id,object_id:id,kind:z.enum(['paper','proposal'])}).strict();
export const ACADEMIC_OPERATION_SCHEMAS={
 'academic.paper.create':{input:z.object({title:text,summary:nullable,project_id:id.nullable().default(null),doi:nullable,arxiv_id:nullable,pmid:nullable,openalex_id:nullable,publication_date:z.string().refine(v=>Number.isFinite(Date.parse(v))).nullable().optional(),venue:nullable,paper_type:z.enum(['article','preprint','conference_paper','book_chapter','thesis','report','other']).default('article'),source_uri:nullable}).strict(),output:receipt},
 'academic.paper.update':{input:z.object({object_id:id,title:text.optional(),summary:nullable,venue:nullable,cited_by_count:z.number().int().nonnegative().nullable().optional(),reference_count:z.number().int().nonnegative().nullable().optional()}).strict(),output:receipt},
 'academic.paper.author.propose':{input:z.object({object_id:id,person_object_id:id,author_position:z.number().int().positive().nullable().optional(),is_corresponding:z.boolean().default(false)}).strict(),output:receipt},
 'academic.paper.citation.propose':{input:z.object({object_id:id,cited_paper_object_id:id}).strict(),output:receipt},
} as const;
