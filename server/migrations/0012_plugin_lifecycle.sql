ALTER TABLE "plugin_installs" ADD COLUMN "lifecycle_state" varchar(32) DEFAULT 'installed' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_installs" ADD COLUMN "lifecycle_error" text;