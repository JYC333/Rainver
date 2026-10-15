ALTER TABLE "run_attempts" ADD COLUMN "launch_id" varchar(36);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifacts_remote_diff_launch" ON "artifacts" USING btree ("run_id",(metadata_json->>'launch_id')) WHERE artifact_type = 'remote_diff' AND metadata_json->>'launch_id' IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifacts_remote_output_launch" ON "artifacts" USING btree ("run_id",(metadata_json->>'launch_id'),"title") WHERE artifact_type = 'remote_output' AND metadata_json->>'launch_id' IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_attempts_launch_id" ON "run_attempts" USING btree ("launch_id") WHERE launch_id IS NOT NULL;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "auth_reauth_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"method" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_for" varchar(64),
	CONSTRAINT "uq_auth_reauth_grants_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "ck_auth_reauth_grants_method" CHECK (method IN ('password', 'google')),
	CONSTRAINT "ck_auth_reauth_grants_consumed" CHECK ((consumed_at IS NULL) = (consumed_for IS NULL))
);
--> statement-breakpoint
ALTER TABLE "auth_reauth_grants" ADD CONSTRAINT "auth_reauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_reauth_grants" ADD CONSTRAINT "auth_reauth_grants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."user_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_auth_reauth_grants_session" ON "auth_reauth_grants" USING btree ("session_id","expires_at");
--> statement-breakpoint
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
--> statement-breakpoint
DROP INDEX "uq_source_items_active_canonical_uri_personal";--> statement-breakpoint
DROP INDEX "uq_source_items_active_source_uri_personal";--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD COLUMN "read_origin" varchar(32);--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD COLUMN "subscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_canonical_uri_personal" ON "source_items" USING btree ("space_id",COALESCE(owner_user_id, ''),"canonical_uri") WHERE canonical_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_source_uri_personal" ON "source_items" USING btree ("space_id",COALESCE(owner_user_id, ''),"source_uri") WHERE source_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL;--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD CONSTRAINT "ck_source_item_user_states_read_origin" CHECK (read_origin IS NULL OR read_origin IN ('library', 'serendipity'));--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD CONSTRAINT "ck_source_channel_user_subscriptions_window" CHECK ((status <> 'subscribed' OR unsubscribed_at IS NULL) AND (unsubscribed_at IS NULL OR subscribed_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "ck_settings_scope_type";--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "responsible_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "ck_settings_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('instance'::character varying)::text, ('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('space_user'::character varying)::text]));--> statement-breakpoint
-- Backfill: an execution's responsible person is the one its coordinator Run
-- was instructed by (`fireResponsibility` stamped it there), or, for an
-- execution whose coordinator was never created, its Automation's owner.
UPDATE "workflow_executions" e
   SET "responsible_user_id" = COALESCE(
         (SELECT r.instructed_by_user_id FROM runs r WHERE r.id = e.root_run_id AND r.space_id = e.space_id),
         (SELECT a.owner_user_id FROM automations a WHERE a.id = e.automation_id AND a.space_id = e.space_id))
 WHERE e."responsible_user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD COLUMN "execution_lease_run_id" varchar(36);--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD COLUMN "execution_lease_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD COLUMN "semantic_intent_json" jsonb;--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ADD COLUMN "embedding_blocked_generation" varchar(64);--> statement-breakpoint
ALTER TABLE "host_thread_events" ADD COLUMN "attempt_number" integer;
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "pending_operation_key" varchar(256);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposals_pending_operation" ON "proposals" USING btree ("space_id","proposal_type","pending_operation_key") WHERE status='pending' AND pending_operation_key IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD COLUMN "candidate_content_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD COLUMN "rolled_back_from_ref_id" varchar(36);--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD CONSTRAINT "prompt_deployment_refs_rolled_back_from_ref_id_fkey" FOREIGN KEY ("rolled_back_from_ref_id") REFERENCES "public"."prompt_deployment_refs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "ck_evolvable_asset_versions_system_scope_placement" CHECK ((((scope_type)::text = 'system'::text) AND (space_id IS NULL) AND (scope_id IS NULL)) OR (((scope_type)::text <> 'system'::text) AND (space_id IS NOT NULL) AND (scope_id IS NOT NULL))) NOT VALID;--> statement-breakpoint
ALTER TABLE "evolvable_assets" ADD CONSTRAINT "ck_evolvable_assets_system_owner_placement" CHECK (((owner_scope_type)::text = 'system'::text) = (space_id IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "space_object_profiles" DROP CONSTRAINT "ck_space_object_profiles_key_by_base_object_type";--> statement-breakpoint
ALTER TABLE "space_object_profiles" ADD CONSTRAINT "ck_space_object_profiles_key_by_base_object_type" CHECK (CASE (base_object_type)::text
    WHEN 'knowledge_item'::text THEN ((key)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('question'::character varying)::text, ('answer'::character varying)::text, ('summary'::character varying)::text]))
    WHEN 'note'::text THEN ((key)::text = 'note'::text)
    WHEN 'source'::text THEN ((key)::text = ANY (ARRAY[('activity_record'::character varying)::text, ('chat_capture'::character varying)::text, ('webpage'::character varying)::text, ('article'::character varying)::text, ('paper'::character varying)::text, ('pdf'::character varying)::text, ('file'::character varying)::text, ('email'::character varying)::text, ('manual_reference'::character varying)::text, ('external_note'::character varying)::text]))
    WHEN 'claim'::text THEN ((key)::text = ANY (ARRAY[('fact'::character varying)::text, ('hypothesis'::character varying)::text, ('belief'::character varying)::text, ('preference'::character varying)::text, ('commitment'::character varying)::text, ('question'::character varying)::text, ('interpretation'::character varying)::text, ('instruction'::character varying)::text, ('metric'::character varying)::text, ('relationship'::character varying)::text, ('event'::character varying)::text]))
    WHEN 'memory_entry'::text THEN ((key)::text = ANY (ARRAY[('preference'::character varying)::text, ('semantic'::character varying)::text, ('episodic'::character varying)::text, ('procedural'::character varying)::text, ('project'::character varying)::text]))
    WHEN 'project_public_summary'::text THEN ((key)::text = 'project_public_summary'::text)
    WHEN 'source_item'::text THEN ((key)::text = ANY (ARRAY[('external_url'::character varying)::text, ('feed_entry'::character varying)::text, ('activity_record'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('file'::character varying)::text, ('document'::character varying)::text, ('log'::character varying)::text]))
    WHEN 'extracted_evidence'::text THEN ((key)::text = ANY (ARRAY[('document'::character varying)::text, ('excerpt'::character varying)::text, ('event'::character varying)::text, ('log'::character varying)::text, ('artifact'::character varying)::text, ('claim'::character varying)::text, ('summary'::character varying)::text]))
    WHEN 'inquiry_thread'::text THEN ((key)::text = ANY (ARRAY[('question'::character varying)::text, ('hypothesis'::character varying)::text]))
    ELSE false
END);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "source_template_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "source_template_version_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_source_template_pair" CHECK ((source_template_id IS NULL) = (source_template_version_id IS NULL));
--> statement-breakpoint
CREATE TABLE "plan_node_action_attempts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"plan_node_id" varchar(36) NOT NULL,
	"attempt_number" integer NOT NULL,
	"action_key" varchar(256),
	"status" varchar(32) NOT NULL,
	"resolved_inputs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_text" text,
	"output_json" jsonb,
	"error_json" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "uq_plan_node_action_attempts_node_number" UNIQUE("plan_node_id","attempt_number"),
	CONSTRAINT "ck_plan_node_action_attempts_number" CHECK (attempt_number > 0),
	CONSTRAINT "ck_plan_node_action_attempts_status" CHECK ((status = 'running' AND ended_at IS NULL AND output_text IS NULL AND output_json IS NULL AND error_json IS NULL) OR (status = 'succeeded' AND ended_at IS NOT NULL AND output_text IS NOT NULL AND output_json IS NOT NULL AND error_json IS NULL) OR (status = 'failed' AND ended_at IS NOT NULL AND error_json IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "ck_runs_trigger_origin";--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD COLUMN "settlement_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD COLUMN "settlement_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- A finalization the previous release completed already passed its
-- completion gate; nothing records what it still owed, so none is owed now.
-- Only finalizations completed from this release on can be unsettled.
UPDATE "run_finalizations"
   SET "settled_at" = COALESCE(("metadata_json"->>'completion_gate_committed_at')::timestamptz, "finalized_at", "created_at")
 WHERE "status" = 'completed' AND "settled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cause_run_id" varchar(36);--> statement-breakpoint
ALTER TABLE "plan_node_action_attempts" ADD CONSTRAINT "plan_node_action_attempts_node_space_fkey" FOREIGN KEY ("plan_node_id","space_id") REFERENCES "public"."plan_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_action_attempts" ADD CONSTRAINT "plan_node_action_attempts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_plan_node_action_attempts_node_started" ON "plan_node_action_attempts" USING btree ("space_id","plan_node_id","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cause_run_space_fkey" FOREIGN KEY ("cause_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_unsettled" ON "run_finalizations" USING btree ("finalized_at") WHERE status = 'completed' AND settled_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_runs_cause_run_id" ON "runs" USING btree ("space_id","cause_run_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "ck_runs_cause_run_continuation" CHECK (cause_run_id IS NULL OR trigger_origin = 'continuation');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "ck_runs_trigger_origin" CHECK ((trigger_origin)::text = ANY (ARRAY[('manual'::character varying)::text, ('automation'::character varying)::text, ('autonomous'::character varying)::text, ('job'::character varying)::text, ('system'::character varying)::text, ('delegation'::character varying)::text, ('continuation'::character varying)::text]));
--> statement-breakpoint
CREATE TABLE "source_channel_subscription_windows" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"subscribed_at" timestamp with time zone NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "ck_source_channel_subscription_windows_order" CHECK (unsubscribed_at IS NULL OR unsubscribed_at >= subscribed_at)
);
--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" DROP CONSTRAINT "ck_source_channel_user_subscriptions_window";--> statement-breakpoint
ALTER TABLE "source_channel_subscription_windows" ADD CONSTRAINT "source_channel_subscription_windows_channel_id_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_subscription_windows" ADD CONSTRAINT "source_channel_subscription_windows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_source_channel_subscription_windows_reader" ON "source_channel_subscription_windows" USING btree ("space_id","user_id","source_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_channel_subscription_windows_open" ON "source_channel_subscription_windows" USING btree ("space_id","source_channel_id","user_id") WHERE unsubscribed_at IS NULL;--> statement-breakpoint
-- Every subscription that is live now has an open period, starting when the
-- subscription row was created (the moment it was first recorded); a period
-- the previous columns already closed keeps its bounds. A row that began as
-- a pending recommendation and was followed later cannot say when: its period
-- starts at the recommendation, so after leaving, its reader may still open
-- items of that space-shared channel first seen while it was only
-- recommended. Starting at `updated_at` instead would cut real history after
-- any later settings change, which is worse.
INSERT INTO "source_channel_subscription_windows" ("id", "space_id", "source_channel_id", "user_id", "subscribed_at", "unsubscribed_at")
SELECT gen_random_uuid()::varchar, "space_id", "source_channel_id", "user_id",
       COALESCE("subscribed_at", "created_at"),
       CASE WHEN "status" = 'subscribed' THEN NULL ELSE "unsubscribed_at" END
  FROM "source_channel_user_subscriptions"
 WHERE "status" = 'subscribed'
    OR ("subscribed_at" IS NOT NULL AND "unsubscribed_at" IS NOT NULL);
