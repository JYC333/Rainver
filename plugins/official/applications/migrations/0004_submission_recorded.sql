ALTER TABLE "plugin_applications"."applications" ADD COLUMN "submission_recorded_at" timestamp with time zone;--> statement-breakpoint
-- Rows written before this column kept no history of an approved `submitted` decision. A row still at
-- `submitted` proves one; a row of a separate submission (never automatic) already past preparation may
-- have been submitted and then moved on by ordinary progress, so it is treated as submitted (fail closed:
-- it can no longer switch to automatic consideration; nothing else about it changes).
UPDATE "plugin_applications"."applications" SET "submission_recorded_at"="updated_at" WHERE "submission_recorded_at" IS NULL AND "submission" IS DISTINCT FROM 'automatic' AND "status" NOT IN ('planning','preparing','ready');--> statement-breakpoint
ALTER TABLE "plugin_applications"."applications" ADD CONSTRAINT "applications_submitted_not_automatic" CHECK ("plugin_applications"."applications"."submission_recorded_at" IS NULL OR "plugin_applications"."applications"."submission" IS DISTINCT FROM 'automatic');
