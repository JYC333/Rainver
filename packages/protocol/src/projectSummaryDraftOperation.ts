import {z} from 'zod';
import {RetrievalBriefRequestSchema} from './knowledgeRetrieval.js';
const id=z.string().trim().min(1).max(36);
/** Admission only: the provider call runs in the bounded ProviderTask worker. */
export const PROJECT_SUMMARY_DRAFT_SCHEMAS={
 'project.public_summary.draft.generate':{
  input:z.object({project_id:id,model_provider_id:id.nullable().optional(),model:z.string().trim().min(1).max(200).nullable().optional()}).strict(),
  output:z.object({id,project_id:id,space_id:id,run_id:id,job_id:id}).strict(),
 },
 /** Admission only: the brief is built by its Job and read back by the requester. */
 'project.summary.brief.request':{
  input:RetrievalBriefRequestSchema.extend({object_types:z.array(z.literal('project_public_summary')).optional()}).strict(),
  output:z.object({id,space_id:id,job_id:id}).strict(),
 },
} as const;
export const PROJECT_SUMMARY_DRAFT_TITLES:Record<keyof typeof PROJECT_SUMMARY_DRAFT_SCHEMAS,string>={
 'project.public_summary.draft.generate':'Queue a public summary draft generation',
 'project.summary.brief.request':'Queue a public summary Context Brief',
};
