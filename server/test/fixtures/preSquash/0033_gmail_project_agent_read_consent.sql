ALTER TABLE "plugin_data_grants" DROP CONSTRAINT "ck_plugin_data_grants_shape";--> statement-breakpoint
DROP INDEX "uq_plugin_data_grants_active";--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "project_id" varchar(36);--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "connection_id" varchar(36);--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "connection_generation" integer;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "purpose" varchar(32);--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_connection_fkey" FOREIGN KEY ("connection_id","space_id","data_owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_plugin_data_grants_connection" ON "plugin_data_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plugin_data_grants_active" ON "plugin_data_grants" USING btree ("space_id","plugin_id","toolset","data_class","scope",COALESCE("target_run_id", ''),COALESCE("data_owner_user_id", ''),COALESCE("project_id", ''),COALESCE("connection_id", ''),COALESCE("purpose", '')) WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_binding" CHECK (scope = 'project' OR (project_id IS NULL AND connection_id IS NULL AND connection_generation IS NULL AND purpose IS NULL));--> statement-breakpoint
-- ADR 0033: a core data tool keeps no per-Run consent. Still-active earlier per-Run Gmail consents end here (kept as history, never reactivated).
UPDATE "plugin_data_grants" SET "status" = 'expired', "updated_at" = now() WHERE "plugin_id" LIKE 'core:%' AND "scope" <> 'project' AND "status" = 'active';--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_core_scope" CHECK (status <> 'active' OR plugin_id NOT LIKE 'core:%' OR scope = 'project');--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_shape" CHECK ((data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))
		OR (data_class = 'sensitive' AND scope = 'project' AND data_owner_user_id = granted_by_user_id AND toolset = 'read' AND target_run_id IS NULL
			AND plugin_id LIKE 'core:%' AND project_id IS NOT NULL AND connection_id IS NOT NULL AND connection_generation >= 1 AND purpose = 'on_demand_read'));