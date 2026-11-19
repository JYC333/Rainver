-- Every supported writer creates at planning/revision 1, and each status write
-- increments the revision. A different status at revision <= 2 rules out a
-- submission followed by another status write, even if 0004 marked the row.
UPDATE "plugin_applications"."applications"
SET "submission_recorded_at" = NULL
WHERE "submission_recorded_at" IS NOT NULL AND "revision" <= 2 AND "status" <> 'submitted';
--> statement-breakpoint
-- An old funding record with at least two writes could have been submitted and
-- then moved to any other status. Its row cannot distinguish that from ordinary
-- edits. Bound new inferences to records from before the history bit existed.
-- The installer supplies the preceding migration's timestamp for this package.
UPDATE "plugin_applications"."applications"
SET "submission_recorded_at" = "updated_at"
WHERE "track" = 'funding'
  AND "submission" IS DISTINCT FROM 'automatic'
  AND "submission_recorded_at" IS NULL
  AND "revision" >= 3
  AND "created_at" <= current_setting('rainver.previous_migration_applied_at')::timestamptz;
