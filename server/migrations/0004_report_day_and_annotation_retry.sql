ALTER TABLE "information_digests" ADD COLUMN "timezone" varchar(64) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "information_digests" ADD COLUMN "period_start_utc" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "information_digests" ADD COLUMN "period_end_utc" timestamp with time zone;--> statement-breakpoint
-- Existing digests covered `digest_date` as a UTC day, which is what the
-- new `timezone` default ('UTC') says; their period is that day.
UPDATE "information_digests"
   SET "period_start_utc" = ("digest_date"::date)::timestamp AT TIME ZONE 'UTC',
       "period_end_utc" = (("digest_date"::date) + 1)::timestamp AT TIME ZONE 'UTC'
 WHERE "period_start_utc" IS NULL;--> statement-breakpoint
ALTER TABLE "information_digests" ALTER COLUMN "period_start_utc" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "information_digests" ALTER COLUMN "period_end_utc" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "information_digests" ADD COLUMN "generation_kind" varchar(16) DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "information_digests" ADD COLUMN "generated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD COLUMN "wait_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD COLUMN "episode_id" varchar(36);--> statement-breakpoint
CREATE INDEX "ix_source_item_annotations_retry" ON "source_item_annotations" USING btree ("space_id","status","next_retry_at");--> statement-breakpoint
CREATE INDEX "ix_source_item_annotations_episode" ON "source_item_annotations" USING btree ("space_id","episode_id");--> statement-breakpoint
ALTER TABLE "information_digests" ADD CONSTRAINT "ck_information_digests_generation_kind" CHECK (generation_kind IN ('scheduled','backfill'));--> statement-breakpoint
ALTER TABLE "information_digests" ADD CONSTRAINT "ck_information_digests_period" CHECK (period_start_utc < period_end_utc);--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "ck_source_item_annotations_wait_reason" CHECK (wait_reason IS NULL OR wait_reason IN ('retry_scheduled','provider_unavailable','egress_denied','consent_missing','budget_exhausted'));--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "ck_source_item_annotations_wait_shape" CHECK ((wait_reason = 'retry_scheduled') = (next_retry_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "ck_source_item_annotations_wait_status" CHECK (wait_reason IS NULL OR (wait_reason = 'budget_exhausted' AND status = 'failed') OR (wait_reason <> 'budget_exhausted' AND status = 'pending'));