CREATE TABLE "conversation_input_resource_blobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"owner_user_id" varchar(36),
	"sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"line_count" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_conversation_input_resource_blobs_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_conversation_input_resource_blobs_scope" CHECK (
    (project_id IS NOT NULL AND owner_user_id IS NULL)
    OR (project_id IS NULL AND owner_user_id IS NOT NULL)
  ),
	CONSTRAINT "ck_conversation_input_resource_blobs_hash" CHECK (sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ck_conversation_input_resource_blobs_size" CHECK (
    byte_size >= 0 AND byte_size <= 524288 AND octet_length(content) = byte_size
  ),
	CONSTRAINT "ck_conversation_input_resource_blobs_line_count" CHECK (line_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_input_resources" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"blob_id" varchar(36) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_state" varchar(16) NOT NULL,
	"project_id" varchar(36),
	"project_folder_id" varchar(36),
	"workspace_location_id" varchar(36),
	"relative_path" text,
	"display_name" varchar(512) NOT NULL,
	"media_type" varchar(256) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"draft_id" varchar(36),
	"draft_version" integer,
	"base_sha256" varchar(64),
	"capture_actor_user_id" varchar(36),
	"captured_at" timestamp with time zone NOT NULL,
	"selection_start_line" integer,
	"selection_start_column" integer,
	"selection_end_line" integer,
	"selection_end_column" integer,
	CONSTRAINT "uq_conversation_input_resources_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_conversation_input_resources_state" CHECK (source_state IN ('saved', 'draft')),
	CONSTRAINT "ck_conversation_input_resources_size" CHECK (byte_size >= 0 AND byte_size <= 524288),
	CONSTRAINT "ck_conversation_input_resources_hash" CHECK (sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ck_conversation_input_resources_draft" CHECK (
    (source_state = 'draft' AND draft_id IS NOT NULL AND draft_version IS NOT NULL AND draft_version > 0)
    OR (source_state = 'saved' AND draft_version IS NULL AND draft_id IS NULL)
  ),
	CONSTRAINT "ck_conversation_input_resources_base_hash" CHECK (base_sha256 IS NULL OR base_sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ck_conversation_input_resources_selection" CHECK (
    (selection_start_line IS NULL AND selection_start_column IS NULL
      AND selection_end_line IS NULL AND selection_end_column IS NULL)
    OR (selection_start_line >= 1 AND selection_start_column >= 1
      AND selection_end_line >= selection_start_line
      AND (selection_end_line > selection_start_line
        OR selection_end_column >= selection_start_column)
      AND selection_end_column >= 1)
  )
);
--> statement-breakpoint
CREATE TABLE "project_file_drafts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"workspace_location_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"target_kind" varchar(16) NOT NULL,
	"relative_path" text NOT NULL,
	"base_exists" boolean NOT NULL,
	"base_sha256" varchar(64),
	"content" text NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_encoding" varchar(16) DEFAULT 'utf8' NOT NULL,
	"preserve_bom" boolean DEFAULT false NOT NULL,
	"line_ending_mode" varchar(8) DEFAULT 'lf' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_file_drafts_target_kind" CHECK (target_kind IN ('existing', 'new')),
	CONSTRAINT "ck_project_file_drafts_base_exists" CHECK (base_exists IN (true, false)),
	CONSTRAINT "ck_project_file_drafts_base_sha" CHECK (
    (base_exists = true AND base_sha256 ~ '^[a-f0-9]{64}$')
    OR (base_exists = false AND base_sha256 IS NULL)
  ),
	CONSTRAINT "ck_project_file_drafts_size" CHECK (
    byte_size >= 0 AND byte_size <= 1048576 AND octet_length(content) = byte_size
  ),
	CONSTRAINT "ck_project_file_drafts_content_sha" CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ck_project_file_drafts_version" CHECK (version > 0),
	CONSTRAINT "ck_project_file_drafts_encoding" CHECK (source_encoding IN ('utf8', 'utf16le', 'utf16be')),
	CONSTRAINT "ck_project_file_drafts_bom" CHECK (preserve_bom IN (true, false)),
	CONSTRAINT "ck_project_file_drafts_line_endings" CHECK (line_ending_mode IN ('lf', 'crlf', 'mixed', 'none'))
);
--> statement-breakpoint
ALTER TABLE "message_input_parts" DROP CONSTRAINT "ck_message_input_parts_kind";--> statement-breakpoint
ALTER TABLE "message_input_parts" DROP CONSTRAINT "ck_message_input_parts_reference";--> statement-breakpoint
ALTER TABLE "conversation_file_snapshots" DROP CONSTRAINT "conversation_file_snapshots_folder_scope_fkey";
--> statement-breakpoint
ALTER TABLE "conversation_file_snapshots" DROP CONSTRAINT "conversation_file_snapshots_location_scope_fkey";
--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD COLUMN "resource_id" varchar(36);--> statement-breakpoint
ALTER TABLE "conversation_input_resource_blobs" ADD CONSTRAINT "conversation_input_resource_blobs_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_resources" ADD CONSTRAINT "conversation_input_resources_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_resources" ADD CONSTRAINT "conversation_input_resources_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_resources" ADD CONSTRAINT "conversation_input_resources_message_scope_fkey" FOREIGN KEY ("message_id","space_id","session_id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_resources" ADD CONSTRAINT "conversation_input_resources_blob_scope_fkey" FOREIGN KEY ("blob_id","space_id") REFERENCES "public"."conversation_input_resource_blobs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_input_resources" ADD CONSTRAINT "conversation_input_resources_capture_actor_fkey" FOREIGN KEY ("capture_actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_drafts" ADD CONSTRAINT "project_file_drafts_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_drafts" ADD CONSTRAINT "project_file_drafts_project_scope_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_drafts" ADD CONSTRAINT "project_file_drafts_folder_scope_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_drafts" ADD CONSTRAINT "project_file_drafts_location_scope_fkey" FOREIGN KEY ("workspace_location_id","project_folder_id") REFERENCES "public"."workspace_locations"("id","project_folder_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_drafts" ADD CONSTRAINT "project_file_drafts_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_conversation_input_resource_blobs_space_created" ON "conversation_input_resource_blobs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_input_resource_blobs_project_hash" ON "conversation_input_resource_blobs" USING btree ("space_id","project_id","sha256") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_input_resource_blobs_owner_hash" ON "conversation_input_resource_blobs" USING btree ("space_id","owner_user_id","sha256") WHERE owner_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_conversation_input_resources_message" ON "conversation_input_resources" USING btree ("space_id","message_id","id");--> statement-breakpoint
CREATE INDEX "ix_conversation_input_resources_blob" ON "conversation_input_resources" USING btree ("space_id","blob_id");--> statement-breakpoint
CREATE INDEX "ix_project_file_drafts_owner_updated" ON "project_file_drafts" USING btree ("space_id","owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ix_project_file_drafts_expiry" ON "project_file_drafts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_file_drafts_existing_path" ON "project_file_drafts" USING btree ("space_id","owner_user_id","workspace_location_id","relative_path") WHERE target_kind = 'existing';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_file_drafts_new_file" ON "project_file_drafts" USING btree ("space_id","owner_user_id","workspace_location_id") WHERE target_kind = 'new';--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "message_input_parts_resource_scope_fkey" FOREIGN KEY ("resource_id","space_id") REFERENCES "public"."conversation_input_resources"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "ck_message_input_parts_kind" CHECK (kind IN ('image', 'file_reference', 'input_resource'));--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "ck_message_input_parts_reference" CHECK (
    (kind = 'image'
      AND media_id IS NOT NULL
      AND file_snapshot_id IS NULL
      AND resource_id IS NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
    OR (kind = 'file_reference'
      AND media_id IS NULL
      AND file_snapshot_id IS NOT NULL
      AND resource_id IS NULL
      AND project_folder_id IS NOT NULL
      AND workspace_location_id IS NOT NULL
      AND relative_path IS NOT NULL)
    OR (kind = 'input_resource'
      AND media_id IS NULL
      AND file_snapshot_id IS NULL
      AND resource_id IS NOT NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
  );