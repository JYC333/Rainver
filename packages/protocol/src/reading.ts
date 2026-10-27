import { z } from 'zod';
import { IdSchema, ISODateTimeSchema } from './common.js';

export const ReadingPreferenceSchema = z.object({ show_in_my_reading: z.boolean() }).strict();
export const ReadingQuerySchema = z.object({
  view: z.enum(['pending', 'read', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(4096).optional(),
  q: z.string().max(500).optional(),
}).strict();
export const ReadingStateRequestSchema = z.object({
  read_status: z.enum(['unread', 'skimmed', 'read', 'discussed']).optional(),
  dismissed: z.boolean().optional(),
}).strict().refine(v => v.read_status !== undefined || v.dismissed !== undefined, 'A state change is required');
export const ReadingContributionSchema = z.object({
  delivery_id: z.string(),
  source_item_id: IdSchema,
  kind: z.enum(['personal_digest', 'project_digest', 'project_initial']),
  project_id: IdSchema.nullable(),
  project_name: z.string().nullable(),
  digest_id: IdSchema.nullable(),
  digest_date: z.string().nullable(),
  timezone: z.string().nullable(),
  available_at: ISODateTimeSchema,
  position: z.number().int(),
  section: z.string().nullable(),
  summary: z.string().nullable(),
  rationale: z.string().nullable(),
});
export const ReadingItemSchema = z.object({
  key: z.string(),
  source_item_id: IdSchema,
  source_item_ids: z.array(IdSchema),
  title: z.string(),
  source_uri: z.string().nullable(),
  occurred_at: ISODateTimeSchema.nullable(),
  summary: z.string().nullable(),
  access_level: z.enum(['full', 'summary']),
  reader_origin: z.enum(['library', 'serendipity', 'project']),
  read_status: z.enum(['unread', 'skimmed', 'read', 'discussed']),
  dismissed: z.boolean(),
  available_at: ISODateTimeSchema,
  contributions: z.array(ReadingContributionSchema),
  material_links: z.array(z.object({
    kind: z.enum(['saved', 'source_link', 'corpus']), reference_id: IdSchema, source_item_id: IdSchema, project_id: IdSchema,
  })),
});
export const ReadingPageSchema = z.object({
  items: z.array(ReadingItemSchema), total: z.number().int().nonnegative(), next_cursor: z.string().nullable(),
});
export const ReadingStateResultSchema = z.object({ updated: z.number().int().nonnegative() });
export type ReadingQuery = z.infer<typeof ReadingQuerySchema>;
export type ReadingItem = z.infer<typeof ReadingItemSchema>;
export type ReadingContribution = z.infer<typeof ReadingContributionSchema>;
export type ReadingStateRequest = z.infer<typeof ReadingStateRequestSchema>;
export type ReadingPage = z.infer<typeof ReadingPageSchema>;
