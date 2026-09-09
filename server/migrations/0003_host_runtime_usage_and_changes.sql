CREATE TABLE "host_runtime_changes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"host_id" varchar(36) NOT NULL,
	"adapter_type" varchar(64) NOT NULL,
	"action" varchar(16) NOT NULL,
	"from_version" varchar(64),
	"to_version" varchar(64),
	"actor_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_runtime_usage" (
	"host_id" varchar(36) NOT NULL,
	"adapter_type" varchar(64) NOT NULL,
	"installation" varchar(64) NOT NULL,
	"quota_json" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "host_runtime_usage_pkey" PRIMARY KEY("host_id","adapter_type","installation")
);
--> statement-breakpoint
ALTER TABLE "host_runtime_changes" ADD CONSTRAINT "host_runtime_changes_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_runtime_changes" ADD CONSTRAINT "host_runtime_changes_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_runtime_usage" ADD CONSTRAINT "host_runtime_usage_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_host_runtime_changes_created_at" ON "host_runtime_changes" USING btree ("created_at" DESC NULLS LAST);
--> statement-breakpoint
-- The host egress proxy emits this event when it refuses a request. Keep the
-- constraint in the same migration as the host runtime tables for this
-- not-yet-applied dev chain.
ALTER TABLE "run_events" DROP CONSTRAINT "ck_run_events_event_type";--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "ck_run_events_event_type" CHECK ((event_type)::text = ANY (ARRAY[('context_compiled'::character varying)::text, ('runtime_selected'::character varying)::text, ('credential_granted'::character varying)::text, ('sandbox_created'::character varying)::text, ('policy_checked'::character varying)::text, ('adapter_invoked'::character varying)::text, ('adapter_completed'::character varying)::text, ('artifact_ingested'::character varying)::text, ('patch_collected'::character varying)::text, ('validation_started'::character varying)::text, ('validation_completed'::character varying)::text, ('proposal_created'::character varying)::text, ('evaluation_created'::character varying)::text, ('run_finalized'::character varying)::text, ('chat_completed'::character varying)::text, ('delegation_requested'::character varying)::text, ('delegation_policy_denied'::character varying)::text, ('delegation_queued'::character varying)::text, ('delegation_started'::character varying)::text, ('delegation_completed'::character varying)::text, ('action_invoked'::character varying)::text, ('action_completed'::character varying)::text, ('assistant_message_completed'::character varying)::text, ('tool_call_started'::character varying)::text, ('tool_call_completed'::character varying)::text, ('tool_call_failed'::character varying)::text, ('approval_requested'::character varying)::text, ('approval_resolved'::character varying)::text, ('artifact_produced'::character varying)::text, ('output_validation_completed'::character varying)::text, ('provider_compacted'::character varying)::text, ('warning'::character varying)::text, ('error'::character varying)::text, ('state_transition'::character varying)::text, ('egress_refused'::character varying)::text]));
