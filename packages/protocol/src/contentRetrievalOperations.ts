import {CONTEXT_REPORT_OPERATION_SCHEMAS} from './contextReportOperations.js';
import {z} from 'zod';
import {RetrievalSearchRequestSchema,RetrievalBriefRequestSchema,RetrievalExplainRequestSchema,RetrievalCreateSafetyRequestSchema} from './knowledgeRetrieval.js';
import {MemorySearchRequestSchema} from './memorySessions.js';
import {AskSpaceRequestSchema,AskSpaceAcceptedJobSchema} from './askSpace.js';
const receipt=z.object({id:z.string().uuid(),space_id:z.string().uuid(),job_id:z.string().uuid(),status:z.literal('pending')}).strict();
export const CONTENT_RETRIEVAL_JOB='content_retrieval_request';
export const CONTENT_RETRIEVAL_OPERATION_SCHEMAS={
 ...CONTEXT_REPORT_OPERATION_SCHEMAS,
 'ask_space.think':{input:AskSpaceRequestSchema,output:AskSpaceAcceptedJobSchema},
 'knowledge.retrieval.search.request':{input:RetrievalSearchRequestSchema.strict(),output:receipt},
 'knowledge.retrieval.brief.request':{input:RetrievalBriefRequestSchema.strict(),output:receipt},
 'knowledge.retrieval.explain.request':{input:RetrievalExplainRequestSchema.strict(),output:receipt},
 'knowledge.create_safety.request':{input:RetrievalCreateSafetyRequestSchema.strict(),output:receipt},
 'memory.search.request':{input:MemorySearchRequestSchema.strict(),output:receipt},
 'memory.retrieval.search.request':{input:RetrievalSearchRequestSchema.strict(),output:receipt},
 'memory.retrieval.brief.request':{input:RetrievalBriefRequestSchema.strict(),output:receipt},
 'memory.create_safety.request':{input:RetrievalCreateSafetyRequestSchema.strict(),output:receipt},
} as const;
