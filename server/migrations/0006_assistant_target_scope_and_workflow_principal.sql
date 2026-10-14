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
