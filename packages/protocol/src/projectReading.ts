import {z} from 'zod';
import {RuntimeSessionConfigSelectionSchema} from './hosts.js';
import {DigestLocalDateSchema} from './informationDigests.js';
import {IdSchema} from './common.js';
/** New analysis consent is exact-purpose-version and separate from collection consent. */
export const ProjectThemeAnalysisSelectionSchema=z.object({enabled:z.boolean(),agent_id:IdSchema.optional(),runtime_profile_id:IdSchema.optional(),session_config:z.array(RuntimeSessionConfigSelectionSchema).max(32).optional()}).strict();
export const ProjectThemeAnalysisConsentSchema=ProjectThemeAnalysisSelectionSchema.extend({expected_version_id:IdSchema}).refine(v=>!v.enabled||!!v.agent_id&&!!v.runtime_profile_id,{message:'Explicit Agent and enabled Profile required for analysis consent'});
export const PROJECT_THEME_LIMITS={originalCharacters:6000,originalPreparations:20,maxRequestCharacters:48000,runSeconds:900,attemptsPerVersion:3,runsPerDay:6,collectionDeadlineSeconds:900,history:20} as const;
export const ProjectThemeRetrySchema=z.object({round_id:IdSchema}).strict();

import {BriefingSchema,BriefingModelOutputSchema} from './informationBriefings.js';
export const ProjectThemeRoundSchema=z.object({
 id:IdSchema,sequence:z.number().int().positive(),version_id:IdSchema,
 status:z.enum(['collecting','generating','complete','blocked','superseded','awaiting_analysis']),
 coverage:z.object({failure_reasons:z.record(z.string(),z.number().int().positive()).optional(),target_sources:z.number().int().nonnegative(),completed_sources:z.number().int().nonnegative(),failed_sources:z.number().int().nonnegative(),pending_sources:z.number().int().nonnegative(),pending_originals:z.number().int().nonnegative(),complete:z.boolean()}).partial().strict(),
 error_code:z.string().max(64).nullable(),briefing:BriefingSchema.nullable(),topic:BriefingModelOutputSchema.shape.topic.unwrap().nullable(),
}).strict();
export const ProjectThemeRoundsResponseSchema=z.object({
 analysis:ProjectThemeAnalysisSelectionSchema.extend({version_id:IdSchema,confirmed_by:IdSchema,confirmed_at:z.string().datetime(),limits:z.record(z.string(),z.number())}).strict().nullable(),
 analysis_admission:z.object({status:z.literal('blocked'),version_id:IdSchema,code:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),checked_at:z.string().datetime()}).strict().nullable().optional(),
 latest:BriefingSchema.nullable(),rounds:z.array(ProjectThemeRoundSchema).max(PROJECT_THEME_LIMITS.history),
}).strict();

/** Stage two stores references, never duplicated raw originals or private reading state. */
export const ProjectReadingSectionSchema=z.object({
 goal_id:IdSchema,purpose_version_id:IdSchema,round_id:IdSchema,sequence:z.number().int().positive(),briefing_id:IdSchema,published_at:z.string().datetime(),
 purpose_text:z.string().max(16000).nullable().optional(),visibility:z.enum(['visible','withheld']),briefing:BriefingSchema.nullable(),
}).strict();
export const ProjectReadingCompositionSchema=z.object({id:IdSchema,revision:z.number().int().positive(),previous_id:IdSchema.nullable(),created_at:z.string().datetime(),reason:z.literal('theme_terminal'),edition_date:DigestLocalDateSchema,timezone:z.string().max(100),day_revision:z.number().int().positive(),sections:z.array(ProjectReadingSectionSchema).max(100)}).strict();
export const ProjectReadingResponseSchema=z.object({date:DigestLocalDateSchema,timezone:z.string().max(100),today:DigestLocalDateSchema,latest:ProjectReadingCompositionSchema.nullable(),history:z.array(ProjectReadingCompositionSchema.omit({sections:true})).max(20),rounds:z.array(z.object({id:IdSchema,goal_id:IdSchema,status:ProjectThemeRoundSchema.shape.status,error_code:z.string().max(64).nullable(),coverage:z.record(z.string(),z.unknown())}).strict()).max(100),composition_status:z.enum(['idle','waiting_for_analysis','queued','running','complete','failed']).optional(),cross_theme_status:z.literal('not_generated')}).strict();
export type ProjectReadingResponse=z.infer<typeof ProjectReadingResponseSchema>;
export type ProjectThemeRoundsResponse=z.infer<typeof ProjectThemeRoundsResponseSchema>;
export type ProjectThemeAnalysisSelection=z.infer<typeof ProjectThemeAnalysisSelectionSchema>;

export const ProjectReadingHistoryQuerySchema=z.object({date:DigestLocalDateSchema.optional(),cursor:z.string().max(500).optional()}).strict();
export const ProjectReadingHistorySchema=z.object({items:z.array(z.object({id:IdSchema,kind:z.enum(['edition','theme_analysis']),date:DigestLocalDateSchema.nullable(),created_at:z.string().datetime(),revision:z.number().int().positive().nullable()}).strict()).max(20),next_cursor:z.string().max(500).nullable()}).strict();
export type ProjectReadingHistory=z.infer<typeof ProjectReadingHistorySchema>;
