import { z } from 'zod';
import { IdSchema, ISODateTimeSchema } from './common.js';

export const ReadingPreferenceSchema = z.object({ show_in_my_reading: z.boolean() }).strict();
export const ReadingQuerySchema = z.object({
  view: z.enum(['pending', 'read', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(4096).optional(),
  q: z.string().max(500).optional(),
  /** Restrict to materials recorded for one visible followed goal (topic). */
  topic: IdSchema.optional(),
  /** Within a topic: `important` = selected by topic judgment; `all` = every
   * collected matching material (only what was actually collected). */
  topic_selection: z.enum(['important', 'all']).default('all'),
  /** `newest`: most recently arrived in the queue first; `oldest`: longest waiting first. */
  sort: z.enum(['newest', 'oldest']).default('newest'),
}).strict().refine(v => v.topic !== undefined || v.topic_selection === 'all', 'topic_selection requires topic');
export const ReadingTopicSelectionSchema = z.enum(['unjudged', 'important', 'not_selected', 'judgment_failed']);
/** A goal the viewer may see that recorded this material; reason is the
 * topic judgment's stated reason, never a claim that the content is verified. */
export const ReadingTopicDeliverySchema = z.enum(['baseline', 'new_publication', 'evidenced_change', 'unknown_freshness']);
export const ReadingTopicLinkSchema = z.object({
  goal_id: IdSchema,
  /** The topic's own scope (null = personal), for routing to it. */
  project_id: IdSchema.nullable().default(null),
  /** The topic as the owner described it (bounded), for labelling only. */
  title: z.string().max(200).default(''),
  selection_status: ReadingTopicSelectionSchema, selection_reason: z.string().nullable(),
  /** Who judged: deterministic topic rules, the collecting Agent, or the owner. */
  judged_by: z.enum(['topic_rules', 'collection_agent', 'owner']).nullable().default(null),
  /** Whether this was first-collection background, a newer publication, an evidenced change, or of unknown freshness. */
  delivery_kind: ReadingTopicDeliverySchema.default('unknown_freshness'),
  /** First joined in this Source's latest finished collection; not publication freshness or last-visit state. */
  new_in_latest_collection: z.boolean().optional(),
  /** Cited evidence of the latest recorded change (release/update), if any. */
  change_evidence_url: z.string().nullable().default(null),
}).strict();
export const ReadingStateRequestSchema = z.object({
  read_status: z.enum(['unread', 'skimmed', 'read', 'discussed']).optional(),
  dismissed: z.boolean().optional(),
  /** Acknowledge only this immutable topic-change delivery, never the material's global state. */
  topic_change_id: IdSchema.optional(),
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
  material_project_id: IdSchema.nullable().optional(),
  source_item_id: IdSchema,
  source_item_ids: z.array(IdSchema),
  topic_change: z.object({id:IdSchema,goal_id:IdSchema,kind:z.enum(['release','update']),evidence_url:z.string().url()}).strict().optional(),
  result_provenance:z.literal('agent_provided_unverified').nullable().optional(),
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
  topics: z.array(ReadingTopicLinkSchema).default([]),
  /** The viewer's own reading progress in this material (0–1), from their private Reader position; null if none. */
  reading_progress: z.object({ current: z.number().min(0).max(1), furthest: z.number().min(0).max(1) }).strict().nullable().optional(),
  material_links: z.array(z.object({
    kind: z.enum(['saved', 'source_link', 'corpus']), reference_id: IdSchema, source_item_id: IdSchema, project_id: IdSchema,
  })),
});
export const ReadingPageSchema = z.object({
  items: z.array(ReadingItemSchema), total: z.number().int().nonnegative(), next_cursor: z.string().nullable(),
});
export const ReadingStateResultSchema = z.object({ updated: z.number().int().nonnegative() });
export type ReadingQuery = z.input<typeof ReadingQuerySchema>;
export type ReadingItem = z.infer<typeof ReadingItemSchema>;
export type ReadingTopicLink = z.infer<typeof ReadingTopicLinkSchema>;
export type ReadingContribution = z.infer<typeof ReadingContributionSchema>;
export type ReadingStateRequest = z.infer<typeof ReadingStateRequestSchema>;
export type ReadingPage = z.infer<typeof ReadingPageSchema>;
