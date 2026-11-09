import {z} from 'zod';
import {SourceBackfillStrategySchema,SourceBackfillQuotaSchema} from './sourceBackfillOperations.js';
const id=z.string().trim().min(1).max(36);
export const PROJECT_SOURCE_PROPOSAL_SCHEMAS={
 'project.source.propose_backfill':{
  input:z.object({project_id:id,binding_id:id,idempotency_key:z.string().trim().min(1).max(256),title:z.string().trim().nullable().optional(),strategy:SourceBackfillStrategySchema.default({}),quota_policy:SourceBackfillQuotaSchema.default({})}).strict(),
  output:z.object({project_id:id,space_id:id,binding_id:id,source_channel_id:id,operation_id:id,plan_id:id,proposal_id:id}).strict(),
 },
} as const;
export const PROJECT_SOURCE_PROPOSAL_TITLES:Record<keyof typeof PROJECT_SOURCE_PROPOSAL_SCHEMAS,string>={
 'project.source.propose_backfill':'Propose a reviewed Project Source history import',
};
