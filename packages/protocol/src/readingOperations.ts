import {RunStatusSchema} from './runOrchestration.js';
import { z } from 'zod';
import { SourceAnnotationRetryRequestSchema } from './informationDigests.js';
import { ProjectDeepReadRequestSchema } from './projectDeepReading.js';
import { IdSchema } from './common.js';
import { ReadingStateRequestSchema, ReadingPreferenceSchema } from './reading.js';

const target = { space_id: IdSchema, item_id: IdSchema };
const state = ReadingStateRequestSchema.innerType();
const changed = (v: {read_status?: string; dismissed?: boolean}) => v.read_status !== undefined || v.dismissed !== undefined;
const result = z.object({ ...target, project_id: IdSchema.optional(), user_id: IdSchema, updated: z.number().int().nonnegative(), topic_change_id: IdSchema.optional() }).strict();
const deepRequest = ProjectDeepReadRequestSchema.innerType().innerType();
export const READING_OPERATION_SCHEMAS = {
  'reading.composition.retry': {input:z.object({space_id:IdSchema,project_id:IdSchema}).strict(),output:z.object({space_id:IdSchema,project_id:IdSchema,user_id:IdSchema,status:z.literal('queued'),round_ids:z.array(IdSchema).max(100)}).strict()},
  'reading.annotation.retry': { input: SourceAnnotationRetryRequestSchema.extend({space_id:IdSchema}).strict(), output:z.object({space_id:IdSchema,user_id:IdSchema,reopened:z.number().int().nonnegative(),item_ids:z.array(IdSchema),episode_id:IdSchema.optional(),connection_id:IdSchema.optional()}).strict() },
  'reading.deep_read.start': {
    input: deepRequest.extend({ ...target, project_id: IdSchema }).strict().refine(v => !!v.agent_id === !!v.runtime_profile_id, 'Select Agent and Profile together').refine(v => !(v.rerun_of && v.retry_of), 'Choose rerun or retry'),
    output: z.object({ ...target, project_id: IdSchema, user_id: IdSchema, status: z.string().min(1), processing_id: IdSchema.optional(), run_id: IdSchema.optional(), source_id: IdSchema.optional(), source_name: z.string().optional(), can_request_consent: z.boolean().optional() }).strict(),
  },
  'reading.deep_read.cancel': {
    input: z.object({ space_id: IdSchema, project_id: IdSchema, operation_id: IdSchema }).strict(),
    output: z.object({ space_id: IdSchema, project_id: IdSchema, operation_id: IdSchema, user_id: IdSchema, id: IdSchema, run_id: IdSchema, status: RunStatusSchema }).strict(),
  },
  'reading.favorite.set': { input: z.object({ ...target, project_id: IdSchema, favorite: z.boolean() }).strict(), output: z.object({ ...target, project_id: IdSchema, user_id: IdSchema, favorite: z.boolean() }).strict() },
  'reading.project_state.set': { input: state.extend({ ...target, project_id: IdSchema }).strict().refine(changed, 'A state change is required'), output: result },
  'reading.personal_state.set': { input: state.extend(target).strict().refine(changed, 'A state change is required'), output: result },
  'reading.preference.set': {
    input: ReadingPreferenceSchema.extend({ space_id: IdSchema, project_id: IdSchema }).strict(),
    output: z.object({ space_id: IdSchema, project_id: IdSchema, user_id: IdSchema, show_in_my_reading: z.boolean() }).strict(),
  },
} as const;
