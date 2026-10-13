CREATE TABLE "project_public_summary_publications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"summary_text" text NOT NULL,
	"topics_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"highlights_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"source_draft_version" integer NOT NULL,
	"published_by_user_id" varchar(36),
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_public_summary_publications_highlights_array" CHECK (jsonb_typeof(highlights_json) = 'array'::text),
	CONSTRAINT "ck_project_public_summary_publications_source_refs_array" CHECK (jsonb_typeof(source_refs_json) = 'array'::text),
	CONSTRAINT "ck_project_public_summary_publications_topics_array" CHECK (jsonb_typeof(topics_json) = 'array'::text),
	CONSTRAINT "ck_project_public_summary_publications_source_draft_version" CHECK (source_draft_version >= 1)
);
--> statement-breakpoint
DROP INDEX "ix_project_public_summaries_review_status";--> statement-breakpoint
ALTER TABLE "project_public_summaries" ALTER COLUMN "review_status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "project_public_summaries" ADD COLUMN "draft_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_public_summary_publications" ADD CONSTRAINT "project_public_summary_publications_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_public_summary_publications" ADD CONSTRAINT "project_public_summary_publications_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_public_summary_publications" ADD CONSTRAINT "project_public_summary_publications_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ix_project_public_summary_publications_project_unique" ON "project_public_summary_publications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_public_summary_publications_space_id" ON "project_public_summary_publications" USING btree ("space_id");--> statement-breakpoint
ALTER TABLE "project_public_summaries" ADD CONSTRAINT "ck_project_public_summaries_draft_version" CHECK (draft_version >= 1);