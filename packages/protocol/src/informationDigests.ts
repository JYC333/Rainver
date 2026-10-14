import { z } from "zod";
import { ISODateTimeSchema, IdSchema } from "./common.js";

/**
 * Information digest days, history reads, backfill, and Source annotation
 * failure episodes.
 *
 * A digest covers one complete calendar day of its scope's configured
 * timezone, as the half-open UTC interval `[period_start_utc,
 * period_end_utc)`. A history read never generates: a day without a snapshot
 * answers `missing`. A backfill is an explicit request for a complete day and
 * never rewrites an existing snapshot.
 */

export const DigestLocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DigestGenerationKindSchema = z.enum(["scheduled", "backfill"]);
export type DigestGenerationKind = z.infer<typeof DigestGenerationKindSchema>;

/** The day fields every persisted snapshot carries. */
export const InformationDigestDayFieldsSchema = z.object({
  digest_date: DigestLocalDateSchema,
  timezone: z.string().min(1),
  period_start_utc: ISODateTimeSchema,
  period_end_utc: ISODateTimeSchema,
  generation_kind: DigestGenerationKindSchema,
  generated_at: ISODateTimeSchema,
});
export type InformationDigestDayFields = z.infer<typeof InformationDigestDayFieldsSchema>;

/** A history read of a day that has no snapshot. */
export const InformationDigestMissingSchema = z.object({
  status: z.literal("missing"),
  digest_date: DigestLocalDateSchema,
  timezone: z.string().min(1),
  period_start_utc: ISODateTimeSchema,
  period_end_utc: ISODateTimeSchema,
  /** Why the day has no snapshot: it has not ended yet, or nothing was generated for it. */
  reason: z.enum(["day_not_complete", "not_generated"]),
  /** Whether this viewer may request a backfill now: the day is over and they may write to the scope. */
  backfill_available: z.boolean(),
});
export type InformationDigestMissing = z.infer<typeof InformationDigestMissingSchema>;

/** `POST …/information-digests/personal/backfill` and the Project counterpart. */
export const InformationDigestBackfillRequestSchema = z.object({ date: DigestLocalDateSchema }).strict();
export type InformationDigestBackfillRequest = z.infer<typeof InformationDigestBackfillRequestSchema>;

export const SourceAnnotationWaitReasonSchema = z.enum([
  "retry_scheduled",
  "provider_unavailable",
  "egress_denied",
  "consent_missing",
  "budget_exhausted",
]);
export type SourceAnnotationWaitReason = z.infer<typeof SourceAnnotationWaitReasonSchema>;

/**
 * One failure episode as the caller sees it: only the items they are
 * responsible for. `next_retry_at` is set only while an automatic retry is
 * scheduled; a condition wait has none, and neither does a paused episode.
 */
export const SourceAnnotationEpisodeSchema = z.object({
  episode_id: IdSchema,
  wait_reason: SourceAnnotationWaitReasonSchema,
  affected_count: z.number().int().nonnegative(),
  next_retry_at: ISODateTimeSchema.nullable(),
  connection_ids: z.array(IdSchema),
});
export type SourceAnnotationEpisode = z.infer<typeof SourceAnnotationEpisodeSchema>;

export const SourceAnnotationEpisodeListSchema = z.object({ episodes: z.array(SourceAnnotationEpisodeSchema) });

export const SourceAnnotationRetryRequestSchema = z.object({
  episode_id: IdSchema.optional(),
  connection_id: IdSchema.optional(),
}).strict();
export type SourceAnnotationRetryRequest = z.infer<typeof SourceAnnotationRetryRequestSchema>;

export const SourceAnnotationRetryResultSchema = z.object({ reopened: z.number().int().nonnegative() });
export type SourceAnnotationRetryResult = z.infer<typeof SourceAnnotationRetryResultSchema>;
