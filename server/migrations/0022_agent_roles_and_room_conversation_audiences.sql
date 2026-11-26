-- rainver:maintenance
-- rainver:maintenance
ALTER TABLE "agents" RENAME COLUMN "source_template_id" TO "source_role_id";--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "source_template_version_id" TO "source_role_version_id";--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "ck_agents_source_template_pair" TO "ck_agents_source_role_pair";--> statement-breakpoint

-- Keep the asset identity, versions, and deployments when the catalog key changes.
UPDATE "evolvable_assets"
SET "asset_key" = 'agent_role.' || substr("asset_key", length('agent_template.') + 1),
    "display_name" = CASE WHEN "space_id" IS NULL
        THEN regexp_replace("display_name", ' Template System Prompt$', ' Role System Prompt')
        ELSE "display_name" END,
    "description" = CASE WHEN "space_id" IS NULL
        THEN regexp_replace("description", ' agent template[.]$', ' agent role.')
        ELSE "description" END
WHERE "asset_type" = 'prompt_template' AND starts_with("asset_key", 'agent_template.');--> statement-breakpoint
UPDATE "workflow_execution_nodes"
SET "prompt_asset_key" = 'agent_role.' || substr("prompt_asset_key", length('agent_template.') + 1)
WHERE starts_with("prompt_asset_key", 'agent_template.');--> statement-breakpoint
UPDATE "plan_nodes"
SET "prompt_asset_key" = 'agent_role.' || substr("prompt_asset_key", length('agent_template.') + 1)
WHERE starts_with("prompt_asset_key", 'agent_template.');


RESET search_path;

CREATE TABLE "room_conversation_audience_members" (
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_conversation_audience_members_pkey" PRIMARY KEY("session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_conversation_audiences" (
	"session_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"frozen_by_invitation_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "origin_session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "room_user_invitations" ADD COLUMN "share_history" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "room_conversation_audience_members" ADD CONSTRAINT "room_conversation_audience_members_audience_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."room_conversation_audiences"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_audience_members" ADD CONSTRAINT "room_conversation_audience_members_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_audiences" ADD CONSTRAINT "room_conversation_audiences_session_scope_fkey" FOREIGN KEY ("session_id","space_id","room_id","project_id") REFERENCES "public"."sessions"("id","space_id","room_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_audiences" ADD CONSTRAINT "room_conversation_audiences_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_room_conversation_audience_members_user" ON "room_conversation_audience_members" USING btree ("space_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_room_conversation_audiences_room" ON "room_conversation_audiences" USING btree ("space_id","room_id");

RESET search_path;
