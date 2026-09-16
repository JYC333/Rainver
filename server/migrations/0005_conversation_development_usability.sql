-- This migration consolidates the branch-only migrations 0005 through 0011.
-- The branch has not been applied to a deployed database; keep this as one
-- post-baseline step so a fresh install reaches the same final schema without
-- carrying the intermediate correction migrations.
CREATE TABLE "conversation_file_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"workspace_location_id" varchar(36) NOT NULL,
	"relative_path" text NOT NULL,
	"display_name" varchar(512) NOT NULL,
	"media_type" varchar(256) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_conversation_file_snapshots_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_conversation_file_snapshots_size" CHECK (byte_size >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_input_media" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"filename" varchar(512) NOT NULL,
	"media_type" varchar(128) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_path" text NOT NULL,
	"lifecycle" varchar(16) DEFAULT 'pending' NOT NULL,
	"message_id" varchar(36),
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_conversation_input_media_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_conversation_input_media_size" CHECK (byte_size > 0),
	CONSTRAINT "ck_conversation_input_media_lifecycle" CHECK (lifecycle IN ('pending', 'claimed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "conversation_turn_idempotencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"session_id" varchar(36),
	"message_id" varchar(36),
	"run_id" varchar(36),
	"response_json" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_conversation_turn_idempotencies_scope_key" UNIQUE("space_id","user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "message_input_parts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"position" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"media_id" varchar(36),
	"file_snapshot_id" varchar(36),
	"project_folder_id" varchar(36),
	"workspace_location_id" varchar(36),
	"relative_path" text,
	"display_name" varchar(512) NOT NULL,
	"media_type" varchar(256) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	CONSTRAINT "uq_message_input_parts_message_position" UNIQUE("message_id","position"),
	CONSTRAINT "ck_message_input_parts_kind" CHECK (kind IN ('image', 'file_reference')),
	CONSTRAINT "ck_message_input_parts_position" CHECK (position >= 0),
	CONSTRAINT "ck_message_input_parts_size" CHECK (byte_size >= 0),
	CONSTRAINT "ck_message_input_parts_reference" CHECK (
    (kind = 'image'
      AND media_id IS NOT NULL
      AND file_snapshot_id IS NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
    OR (kind = 'file_reference'
      AND media_id IS NULL
      AND file_snapshot_id IS NOT NULL
      AND project_folder_id IS NOT NULL
      AND workspace_location_id IS NOT NULL
      AND relative_path IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "conversation_file_snapshots" ADD CONSTRAINT "conversation_file_snapshots_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file_snapshots" ADD CONSTRAINT "conversation_file_snapshots_message_scope_fkey" FOREIGN KEY ("message_id","space_id","session_id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file_snapshots" ADD CONSTRAINT "conversation_file_snapshots_folder_scope_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file_snapshots" ADD CONSTRAINT "conversation_file_snapshots_location_scope_fkey" FOREIGN KEY ("workspace_location_id","project_folder_id") REFERENCES "public"."workspace_locations"("id","project_folder_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_media" ADD CONSTRAINT "conversation_input_media_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_media" ADD CONSTRAINT "conversation_input_media_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_media" ADD CONSTRAINT "conversation_input_media_message_scope_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn_idempotencies" ADD CONSTRAINT "conversation_turn_idempotencies_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn_idempotencies" ADD CONSTRAINT "conversation_turn_idempotencies_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn_idempotencies" ADD CONSTRAINT "conversation_turn_idempotencies_session_scope_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn_idempotencies" ADD CONSTRAINT "conversation_turn_idempotencies_message_scope_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn_idempotencies" ADD CONSTRAINT "conversation_turn_idempotencies_run_scope_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "message_input_parts_message_scope_fkey" FOREIGN KEY ("message_id","space_id","session_id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "message_input_parts_media_scope_fkey" FOREIGN KEY ("media_id","space_id") REFERENCES "public"."conversation_input_media"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "message_input_parts_snapshot_scope_fkey" FOREIGN KEY ("file_snapshot_id","space_id") REFERENCES "public"."conversation_file_snapshots"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_conversation_file_snapshots_message" ON "conversation_file_snapshots" USING btree ("space_id","message_id","id");--> statement-breakpoint
CREATE INDEX "ix_conversation_input_media_owner" ON "conversation_input_media" USING btree ("space_id","owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_conversation_input_media_expiry" ON "conversation_input_media" USING btree ("lifecycle","expires_at");--> statement-breakpoint
CREATE INDEX "ix_conversation_turn_idempotencies_run" ON "conversation_turn_idempotencies" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_message_input_parts_message" ON "message_input_parts" USING btree ("space_id","message_id","position");
--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD COLUMN "git_branch" varchar(256);--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD COLUMN "git_head" varchar(128);--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD COLUMN "git_dirty" boolean;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD COLUMN "git_execution_ready" boolean;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD COLUMN "git_observed_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "project_file_revisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"workspace_location_id" varchar(36) NOT NULL,
	"path" varchar(2048) NOT NULL,
	"before_exists" boolean NOT NULL,
	"before_content" text,
	"after_exists" boolean NOT NULL,
	"after_sha256" varchar(64),
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'available' NOT NULL,
	"rolled_back_by_user_id" varchar(36),
	"rolled_back_at" timestamp with time zone,
	CONSTRAINT "ck_project_file_revisions_status" CHECK ((status)::text = ANY (ARRAY[('available'::character varying)::text, ('rolled_back'::character varying)::text, ('pruned'::character varying)::text])),
	CONSTRAINT "ck_project_file_revisions_before_content" CHECK (before_exists OR before_content IS NULL),
	CONSTRAINT "ck_project_file_revisions_after_hash" CHECK (after_exists OR after_sha256 IS NULL)
);
--> statement-breakpoint
CREATE INDEX "ix_project_file_revisions_folder_path" ON "project_file_revisions" USING btree ("project_folder_id","path");--> statement-breakpoint
CREATE INDEX "ix_project_file_revisions_expires_at" ON "project_file_revisions" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ALTER COLUMN "access_mode" SET DEFAULT 'write';
