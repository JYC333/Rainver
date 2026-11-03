ALTER TABLE "source_goal_runs" ADD COLUMN "reading_date" date;--> statement-breakpoint
ALTER TABLE "source_goal_runs" ADD COLUMN "reading_timezone" varchar(100);--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD COLUMN "edition_date" date;--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD COLUMN "timezone" varchar(100);--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD COLUMN "day_revision" integer;--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD COLUMN "rounds_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_goal_runs_day" ON "source_goal_runs" USING btree ("space_id","reading_date","goal_id");--> statement-breakpoint
CREATE INDEX "ix_project_reading_day" ON "project_reading_compositions" USING btree ("space_id","project_id","edition_date");--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD CONSTRAINT "uq_project_reading_day_revision" UNIQUE("space_id","project_id","edition_date","day_revision");--> statement-breakpoint
ALTER TABLE "source_goal_runs" ADD CONSTRAINT "ck_source_goal_runs_reading_day" CHECK ((reading_date IS NULL AND reading_timezone IS NULL) OR (reading_date IS NOT NULL AND reading_timezone IS NOT NULL));--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD CONSTRAINT "ck_project_reading_day" CHECK ((edition_date IS NULL AND timezone IS NULL AND day_revision IS NULL) OR (edition_date IS NOT NULL AND timezone IS NOT NULL AND day_revision IS NOT NULL AND day_revision>0));