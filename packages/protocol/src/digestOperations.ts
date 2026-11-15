import {InformationDigestBackfillRequestSchema} from './informationDigests.js';
import {RunStatusSchema} from './runOrchestration.js';
import { z } from 'zod';
import { BriefingSettingsRequestSchema, BriefingGenerateRequestSchema, BriefingGenerateResponseSchema, BriefingStatusSchema, BriefingFollowUpPreviewSchema, BriefingAdoptionPreviewSchema, BriefingAdoptionResultSchema } from './informationBriefings.js';
import { IdSchema } from './common.js';

const settingOutput = z.object({space_id:IdSchema,user_id:IdSchema,project_id:IdSchema.optional(),daily_enabled:z.boolean()}).strict();

const cancelInput = z.object({space_id:IdSchema,briefing_id:IdSchema}).strict();
const cancelOutput = cancelInput.extend({user_id:IdSchema,project_id:IdSchema.optional(),attempt:z.number().int().nonnegative(),run_id:IdSchema.nullable(),status:z.union([RunStatusSchema,BriefingStatusSchema])}).strict();
const backfill=InformationDigestBackfillRequestSchema.extend({space_id:IdSchema}).strict();
const backfillOutput=backfill.extend({user_id:IdSchema,job_id:IdSchema,status:z.enum(['queued','claimed','running','completed']).optional(),result:z.record(z.string(),z.unknown()).nullable().optional()}).strict();
const highlight=z.object({space_id:IdSchema,briefing_id:IdSchema,index:z.union([z.number(),z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(0).max(32))}).strict();
const adoption=highlight.extend({preview_hash:z.string().length(64)}).strict();
export const DIGEST_OPERATION_SCHEMAS = {
  'briefing.personal.follow_up':{input:highlight,output:BriefingFollowUpPreviewSchema},
  'briefing.project.follow_up':{input:highlight.extend({project_id:IdSchema}).strict(),output:BriefingFollowUpPreviewSchema},
  'briefing.personal.adoption.preview':{input:highlight,output:BriefingAdoptionPreviewSchema},
  'briefing.project.adoption.preview':{input:highlight.extend({project_id:IdSchema}).strict(),output:BriefingAdoptionPreviewSchema},
  'briefing.personal.adoption.confirm':{input:adoption,output:BriefingAdoptionResultSchema},
  'briefing.project.adoption.confirm':{input:adoption.extend({project_id:IdSchema}).strict(),output:BriefingAdoptionResultSchema},
  'digest.personal.backfill':{input:backfill,output:backfillOutput},
  'digest.project.backfill':{input:backfill.extend({project_id:IdSchema}).strict(),output:backfillOutput.extend({project_id:IdSchema}).strict()},
  'briefing.personal.request': {input:BriefingGenerateRequestSchema.extend({space_id:IdSchema}).strict(),output:BriefingGenerateResponseSchema},
  'briefing.project.request': {input:BriefingGenerateRequestSchema.extend({space_id:IdSchema,project_id:IdSchema}).strict(),output:BriefingGenerateResponseSchema},
  'briefing.personal.cancel': {input:cancelInput,output:cancelOutput.omit({project_id:true}).strict()},
  'briefing.project.cancel': {input:cancelInput.extend({project_id:IdSchema}).strict(),output:cancelOutput.extend({project_id:IdSchema}).strict()},
  'briefing.personal.settings.set': {input:BriefingSettingsRequestSchema.extend({space_id:IdSchema}).strict(),output:settingOutput},
  'briefing.project.settings.set': {input:BriefingSettingsRequestSchema.extend({space_id:IdSchema,project_id:IdSchema}).strict(),output:settingOutput},
  'digest.serendipity.feedback': {
    input: z.object({space_id:IdSchema,item_id:IdSchema,feedback:z.enum(['interesting','neutral','never'])}).strict(),
    output: z.object({space_id:IdSchema,user_id:IdSchema,digest_item_id:IdSchema,domain_key:z.string().min(1),feedback:z.enum(['interesting','neutral','never']),cooldown_until:z.string().datetime().nullable(),blocked:z.boolean(),created_at:z.string().datetime()}).strict(),
  },
} as const;
