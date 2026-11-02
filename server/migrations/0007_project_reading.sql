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

RESET search_path;

ALTER TABLE "source_goal_versions" ALTER COLUMN "created_by_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_goal_versions" ADD COLUMN "created_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "source_goal_versions" ADD CONSTRAINT "source_goal_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_versions" ADD CONSTRAINT "ck_source_goal_version_author" CHECK (("source_goal_versions"."created_by_run_id" IS NOT NULL) <> ("source_goal_versions"."created_by_user_id" IS NOT NULL));

RESET search_path;

ALTER TABLE "source_snapshots" ADD COLUMN "reading_role" varchar(32);--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD COLUMN "origin_run_id" varchar(36);--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD COLUMN "original_snapshot_id" varchar(36);--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_origin_run_fkey" FOREIGN KEY ("origin_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "uq_source_snapshots_identity_item" UNIQUE("id","space_id","source_item_id");--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_original_same_item_fkey" FOREIGN KEY ("original_snapshot_id","space_id","source_item_id") REFERENCES "public"."source_snapshots"("id","space_id","source_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_analysis_run_item" ON "source_snapshots" USING btree ("space_id","source_item_id","origin_run_id") WHERE reading_role = 'analysis' AND origin_run_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "ck_source_snapshots_reading_role" CHECK (reading_role IS NULL OR reading_role IN ('original','analysis'));--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "ck_source_snapshots_analysis_shape" CHECK (reading_role IS DISTINCT FROM 'analysis' OR (snapshot_type='summary' AND project_id IS NOT NULL AND source_item_id IS NOT NULL AND artifact_id IS NOT NULL AND owner_user_id IS NOT NULL AND visibility='private'));

RESET search_path;

CREATE TABLE "project_reading_rounds" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"sequence" integer NOT NULL,
	"slot_key" varchar(128) NOT NULL,
	"status" varchar(24) DEFAULT 'collecting' NOT NULL,
	"targets_json" jsonb NOT NULL,
	"coverage_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"execution_json" jsonb NOT NULL,
	"briefing_id" varchar(36),
	"error_code" varchar(64),
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_reading_round_slot" UNIQUE("space_id","goal_id","slot_key"),
	CONSTRAINT "uq_project_reading_round_sequence" UNIQUE("space_id","goal_id","sequence"),
	CONSTRAINT "ck_project_reading_round_sequence" CHECK (sequence>0),
	CONSTRAINT "ck_project_reading_round_status" CHECK (status IN ('collecting','generating','complete','blocked','superseded'))
);
--> statement-breakpoint
ALTER TABLE "project_reading_rounds" ADD CONSTRAINT "project_reading_rounds_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reading_rounds" ADD CONSTRAINT "project_reading_rounds_project_id_space_id_projects_id_space_id_fk" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reading_rounds" ADD CONSTRAINT "project_reading_rounds_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reading_rounds" ADD CONSTRAINT "project_reading_rounds_space_id_version_id_source_goal_versions_space_id_id_fk" FOREIGN KEY ("space_id","version_id") REFERENCES "public"."source_goal_versions"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reading_rounds" ADD CONSTRAINT "project_reading_rounds_briefing_id_space_id_information_briefings_id_space_id_fk" FOREIGN KEY ("briefing_id","space_id") REFERENCES "public"."information_briefings"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_project_reading_round_pending" ON "project_reading_rounds" USING btree ("status","deadline_at");

RESET search_path;

CREATE TABLE "project_reading_compositions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"revision" integer NOT NULL,
	"previous_id" varchar(36),
	"sections_json" jsonb NOT NULL,
	"reason" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_reading_composition_revision" UNIQUE("space_id","project_id","revision"),
	CONSTRAINT "ck_project_reading_composition_revision" CHECK (revision>0)
);
--> statement-breakpoint
ALTER TABLE "project_reading_compositions" ADD CONSTRAINT "project_reading_compositions_project_id_space_id_projects_id_space_id_fk" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;

RESET search_path;

ALTER TABLE "source_item_user_states" ADD COLUMN "favorite" boolean DEFAULT false NOT NULL;

RESET search_path;
