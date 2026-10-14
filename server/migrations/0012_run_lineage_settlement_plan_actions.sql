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
ALTER TABLE "runs" ADD COLUMN "cause_run_id" varchar(36);--> statement-breakpoint
ALTER TABLE "plan_node_action_attempts" ADD CONSTRAINT "plan_node_action_attempts_node_space_fkey" FOREIGN KEY ("plan_node_id","space_id") REFERENCES "public"."plan_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_action_attempts" ADD CONSTRAINT "plan_node_action_attempts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_plan_node_action_attempts_node_started" ON "plan_node_action_attempts" USING btree ("space_id","plan_node_id","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cause_run_space_fkey" FOREIGN KEY ("cause_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_unsettled" ON "run_finalizations" USING btree ("finalized_at") WHERE status = 'completed' AND settled_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_runs_cause_run_id" ON "runs" USING btree ("space_id","cause_run_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "ck_runs_cause_run_continuation" CHECK (cause_run_id IS NULL OR trigger_origin = 'continuation');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "ck_runs_trigger_origin" CHECK ((trigger_origin)::text = ANY (ARRAY[('manual'::character varying)::text, ('automation'::character varying)::text, ('autonomous'::character varying)::text, ('job'::character varying)::text, ('system'::character varying)::text, ('delegation'::character varying)::text, ('continuation'::character varying)::text]));