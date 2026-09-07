CREATE TABLE "deployment_job_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"job_id" varchar(36) NOT NULL,
	"event_id" varchar(64) NOT NULL,
	"seq" integer NOT NULL,
	"stage" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"log_tail" text,
	CONSTRAINT "uq_deployment_job_events_seq" UNIQUE("job_id","seq"),
	CONSTRAINT "uq_deployment_job_events_event_id" UNIQUE("job_id","event_id"),
	CONSTRAINT "ck_deployment_job_events_status" CHECK ((status)::text = ANY (ARRAY[('started'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "deployment_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"job_type" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"requested_by_user_id" varchar(36) NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"current_stage" varchar(32),
	"failure_stage" varchar(32),
	"error_text" text,
	"target_tag" varchar(128),
	"drain_timeout_seconds" integer DEFAULT 600 NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_progress_at" timestamp with time zone,
	"claimed_by" varchar(128),
	"active_lock" varchar(8),
	CONSTRAINT "uq_deployment_jobs_active" UNIQUE("active_lock"),
	CONSTRAINT "ck_deployment_jobs_job_type" CHECK ((job_type)::text = ANY (ARRAY[('update'::character varying)::text, ('check_update'::character varying)::text])),
	CONSTRAINT "ck_deployment_jobs_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text])),
	CONSTRAINT "ck_deployment_jobs_active_lock" CHECK ((active_lock IS NOT NULL) = ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text]))),
	CONSTRAINT "ck_deployment_jobs_active_lock_value" CHECK (active_lock IS NULL OR active_lock = 'active'::character varying),
	CONSTRAINT "ck_deployment_jobs_drain_timeout" CHECK (drain_timeout_seconds > 0)
);
--> statement-breakpoint
CREATE TABLE "deployment_observations" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"services_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remote_json" jsonb,
	"docker_version" varchar(128),
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_deployment_observations_singleton" CHECK ((id)::text = 'instance'::text),
	CONSTRAINT "ck_deployment_observations_services" CHECK (jsonb_typeof(services_json) = 'array'::text)
);
--> statement-breakpoint
ALTER TABLE "deployment_job_events" ADD CONSTRAINT "deployment_job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."deployment_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_deployment_job_events_job" ON "deployment_job_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "ix_deployment_jobs_requested_at" ON "deployment_jobs" USING btree ("requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_deployment_jobs_status" ON "deployment_jobs" USING btree ("status");