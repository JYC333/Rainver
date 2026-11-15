import {z} from 'zod';
import {RetrievalFeedbackRequestSchema} from './knowledgeRetrieval.js';
const id=z.string().uuid();
// Knowledge retrieval maintenance and private feedback as core commands.
export const KNOWLEDGE_RETRIEVAL_OPERATION_SCHEMAS={
 'knowledge.retrieval.feedback':{input:RetrievalFeedbackRequestSchema.strict(),output:z.object({id:z.string().min(1),space_id:id}).strict()},
 'knowledge.retrieval.reindex':{input:z.object({}).strict(),output:z.object({id,space_id:id,reindexed:z.record(z.number().int().nonnegative()),embedding_backfill_job_id:id.nullable()}).strict()},
} as const;
export const KNOWLEDGE_RETRIEVAL_OPERATION_TITLES={
 'knowledge.retrieval.feedback':'Record Knowledge search feedback',
 'knowledge.retrieval.reindex':'Rebuild the Knowledge retrieval projection',
} as const;

export const MEMORY_RETRIEVAL_OPERATION_SCHEMAS={
 'memory.retrieval.feedback':KNOWLEDGE_RETRIEVAL_OPERATION_SCHEMAS['knowledge.retrieval.feedback'],
 'memory.retrieval.reindex':KNOWLEDGE_RETRIEVAL_OPERATION_SCHEMAS['knowledge.retrieval.reindex'],
} as const;
export const MEMORY_RETRIEVAL_OPERATION_TITLES={
 'memory.retrieval.feedback':'Record Memory search feedback',
 'memory.retrieval.reindex':'Rebuild the Memory retrieval projection',
} as const;
