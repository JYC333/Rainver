CREATE TABLE "room_conversation_recipients" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"room_agent_member_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_conversation_recipients_session_member" UNIQUE("session_id","room_agent_member_id")
);
--> statement-breakpoint
CREATE TABLE "agent_attention_baselines" (
	"user_id" varchar(36) PRIMARY KEY NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_attention_read_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_kind" varchar(32) NOT NULL,
	"work_source_id" varchar(36) NOT NULL,
	"read_subject_kind" varchar(32) NOT NULL,
	"read_subject_id" varchar(36) NOT NULL,
	"last_read_revision_json" jsonb,
	"read_at" timestamp with time zone,
	"manual_unread" boolean DEFAULT false NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_attention_work_kind" CHECK (work_kind IN ('task','session','agent_group','run')),
	CONSTRAINT "ck_agent_attention_subject_kind" CHECK (read_subject_kind IN ('message','run_result','authorization','run_decision','proposal','task','task_merge')),
	CONSTRAINT "ck_agent_attention_state_version" CHECK (state_version >= 0),
	CONSTRAINT "ck_agent_attention_revision" CHECK (last_read_revision_json IS NULL OR (jsonb_typeof(last_read_revision_json) = 'object' AND last_read_revision_json->>'schema_version' = '1' AND octet_length(last_read_revision_json::text) <= 2048))
);
--> statement-breakpoint
DROP INDEX "uq_runtime_context_cli_bindings_active_scope";--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD COLUMN "host_thread_id" varchar(36);--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD COLUMN "session_config_json" jsonb;--> statement-breakpoint
ALTER TABLE "room_conversation_recipients" ADD CONSTRAINT "room_conversation_recipients_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_recipients" ADD CONSTRAINT "room_conversation_recipients_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_recipients" ADD CONSTRAINT "room_conversation_recipients_member_id_fkey" FOREIGN KEY ("room_agent_member_id") REFERENCES "public"."room_agent_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_attention_baselines" ADD CONSTRAINT "agent_attention_baselines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_attention_read_states" ADD CONSTRAINT "agent_attention_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_attention_read_states" ADD CONSTRAINT "agent_attention_read_states_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_room_conversation_recipients_member" ON "room_conversation_recipients" USING btree ("room_agent_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_attention_read_subject" ON "agent_attention_read_states" USING btree ("user_id","space_id","work_kind","work_source_id","read_subject_kind","read_subject_id");--> statement-breakpoint
CREATE INDEX "ix_agent_attention_read_user_space" ON "agent_attention_read_states" USING btree ("user_id","space_id");--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_host_thread_id_fkey" FOREIGN KEY ("host_thread_id") REFERENCES "public"."host_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_runs_space_session_id" ON "runs" USING btree ("space_id","session_id");--> statement-breakpoint
CREATE INDEX "ix_runs_space_retry_predecessor" ON "runs" USING btree ("space_id",("model_override_json"->'chat_turn'->>'retry_of_run_id'));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_context_cli_bindings_active_scope" ON "runtime_context_cli_bindings" USING btree (space_id,work_context_scope_id,user_id,agent_id,COALESCE(host_thread_id, ''::character varying)) WHERE status = 'active';