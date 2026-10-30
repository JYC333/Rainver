CREATE TABLE "information_briefing_inputs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"briefing_id" varchar(36) NOT NULL,
	"ref_key" varchar(8),
	"ref_kind" varchar(16) NOT NULL,
	"source_item_id" varchar(36),
	"family_key" varchar(128),
	"content_revision" varchar(128),
	"status" varchar(24) NOT NULL,
	"delta_class" varchar(24),
	"analysis_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_information_briefing_inputs_kind" CHECK (ref_kind IN ('source_item','context')),
	CONSTRAINT "ck_information_briefing_inputs_item" CHECK ((ref_kind = 'source_item') = (source_item_id IS NOT NULL)),
	CONSTRAINT "ck_information_briefing_inputs_status" CHECK (status IN ('included','not_ready','truncated','egress_refused','not_shared')),
	CONSTRAINT "ck_information_briefing_inputs_delta" CHECK (delta_class IS NULL OR delta_class IN ('baseline','new_publication','newly_found','revised','evidenced_change','unknown_time','background'))
);
--> statement-breakpoint
CREATE TABLE "information_briefings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"project_id" varchar(36),
	"owner_user_id" varchar(36),
	"scope_key" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"version" integer NOT NULL,
	"period_date" varchar(10),
	"digest_id" varchar(36),
	"cutoff_at" timestamp with time zone NOT NULL,
	"since_at" timestamp with time zone,
	"comparison" varchar(16) NOT NULL,
	"previous_briefing_id" varchar(36),
	"protocol_version" varchar(64) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"context_hash" varchar(64) NOT NULL,
	"request_key" varchar(64) NOT NULL,
	"request_hash" varchar(64),
	"status" varchar(16) NOT NULL,
	"outcome" varchar(24),
	"attempt" integer DEFAULT 0 NOT NULL,
	"run_id" varchar(36),
	"requested_by_user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36),
	"runtime_profile_id" varchar(36),
	"context_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comparison_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_json" jsonb,
	"coverage_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb,
	"error_code" varchar(64),
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	CONSTRAINT "uq_information_briefings_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_information_briefings_scope" CHECK ((scope_type = 'project' AND project_id IS NOT NULL AND owner_user_id IS NULL) OR (scope_type = 'personal' AND owner_user_id IS NOT NULL AND project_id IS NULL)),
	CONSTRAINT "ck_information_briefings_kind" CHECK (kind IN ('manual','daily','backfill')),
	CONSTRAINT "ck_information_briefings_day" CHECK ((kind = 'manual') = (period_date IS NULL)),
	CONSTRAINT "ck_information_briefings_status" CHECK (status IN ('queued','ready','failed','blocked','cancelled')),
	CONSTRAINT "ck_information_briefings_outcome" CHECK (outcome IS NULL OR outcome IN ('briefing','no_new_material','no_material')),
	CONSTRAINT "ck_information_briefings_ready" CHECK ((status = 'ready') = (outcome IS NOT NULL)),
	CONSTRAINT "ck_information_briefings_comparison" CHECK (comparison IN ('baseline','delta')),
	CONSTRAINT "ck_information_briefings_version" CHECK (version > 0 AND attempt >= 0)
);
--> statement-breakpoint
ALTER TABLE "information_briefing_inputs" ADD CONSTRAINT "information_briefing_inputs_briefing_fkey" FOREIGN KEY ("briefing_id","space_id") REFERENCES "public"."information_briefings"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_briefing_inputs" ADD CONSTRAINT "information_briefing_inputs_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_briefings" ADD CONSTRAINT "information_briefings_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_briefings" ADD CONSTRAINT "information_briefings_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_briefings" ADD CONSTRAINT "information_briefings_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_briefings" ADD CONSTRAINT "information_briefings_requester_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_briefings" ADD CONSTRAINT "information_briefings_digest_fkey" FOREIGN KEY ("digest_id","space_id") REFERENCES "public"."information_digests"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_briefing_inputs_ref" ON "information_briefing_inputs" USING btree ("briefing_id","ref_key") WHERE ref_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_information_briefing_inputs_briefing" ON "information_briefing_inputs" USING btree ("briefing_id","ref_kind","status");--> statement-breakpoint
CREATE INDEX "ix_information_briefing_inputs_item" ON "information_briefing_inputs" USING btree ("space_id","source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_briefings_version" ON "information_briefings" USING btree ("space_id","scope_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_briefings_request" ON "information_briefings" USING btree ("space_id","scope_key","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_briefings_day" ON "information_briefings" USING btree ("space_id","scope_key","period_date") WHERE kind IN ('daily','backfill') AND status IN ('queued','ready','blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_briefings_in_flight" ON "information_briefings" USING btree ("space_id","scope_key") WHERE status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_briefings_run" ON "information_briefings" USING btree ("run_id") WHERE run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_information_briefings_scope_recent" ON "information_briefings" USING btree ("space_id","scope_key","cutoff_at");