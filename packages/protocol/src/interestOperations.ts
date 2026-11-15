import { z } from 'zod';
import { IdSchema } from './common.js';

export const InterestSettingsSchema = z.object({
  coverage_half_life_days: z.number().int().min(1).max(3650),
  new_topic_occurrence_threshold: z.number().int().min(1).max(100),
  new_topic_read_threshold: z.number().int().min(1).max(100),
  warming_min_read_items: z.number().int().min(1).max(10000),
  warm_min_read_items: z.number().int().min(1).max(10000),
  warm_min_covered_domains: z.number().int().min(1).max(60),
  interest_slots: z.number().int().min(1).max(20),
  serendipity_slots: z.number().int().min(0).max(10),
  interesting_cooldown_days: z.number().int().min(1).max(365),
  neutral_cooldown_days: z.number().int().min(1).max(365),
  probe_domain_budget: z.number().int().min(1).max(3),
}).strict();
const key = z.string().min(1).max(128);
const label = z.string().trim().min(1).max(128);
const domain = z.string().min(1).max(64);
const weight = z.number().int().min(0).max(10);
const owner = {space_id: IdSchema, user_id: IdSchema};
const target = {space_id: IdSchema};
const topic = z.object({id:IdSchema,topic_key:key,label,domain_key:domain,aliases:z.array(key),weight,origin:z.enum(['user','agent']),status:z.enum(['active','archived'])}).strict();
const topicResult = z.object({...owner, topic}).strict();
const refs=z.array(z.object({item_id:IdSchema,channel_id:IdSchema,connection_id:IdSchema}).strict()).max(500);
export const INTEREST_OPERATION_SCHEMAS = {
  'interest.starter_pack.apply': {input:z.object({...target,key:z.enum(['technology','science','world'])}).strict(),output:z.object({...owner,topics:z.number().int().nonnegative(),source_recommendations:z.number().int().nonnegative(),source_refs:refs}).strict()},
  'interest.history.backfill': {input:z.object({...target,limit:z.number().int().min(1).max(500).default(500)}).strict(),output:z.object({...owner,queued:z.number().int().nonnegative(),limit:z.number().int().min(1).max(500),source_refs:refs}).strict()},
  'interest.candidate.accept': {input:z.object({...target,phrase_key:key,label:label.optional(),domain_key:domain.optional()}).strict(),output:topicResult},
  'interest.candidate.dismiss': {input:z.object({...target,phrase_key:key}).strict(),output:z.object({...owner,dismissed:z.literal(true)}).strict()},
  'interest.settings.update': {input:InterestSettingsSchema.partial().extend(target).strict().refine(v=>Object.keys(v).length>1,'A setting is required'),output:z.object({...owner,settings:InterestSettingsSchema}).strict()},
  'interest.topic.create': {input:z.object({...target,label,domain_key:domain,weight:weight.optional()}).strict(),output:topicResult},
  'interest.topic.update': {input:z.object({...target,topic_key:key,label,domain_key:domain,weight}).strict(),output:topicResult},
  'interest.topic.archive': {input:z.object({...target,topic_key:key}).strict(),output:z.object({...owner,archived:z.literal(true)}).strict()},
} as const;
