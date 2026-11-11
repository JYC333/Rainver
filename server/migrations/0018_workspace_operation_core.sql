ALTER TABLE "project_folder_io_intents" DROP CONSTRAINT "ck_project_folder_io_kind";--> statement-breakpoint
ALTER TABLE "project_folder_io_intents" ADD CONSTRAINT "ck_project_folder_io_kind" CHECK (kind IN ('create','scan','save_draft','restore_revision','branch_align'));

RESET search_path;

-- Content-free invalidation, delivered by PostgreSQL only after commit.
-- Read only routing keys, never serialize content, prompts or large JSON rows.
CREATE FUNCTION rainver_project_live_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_project text; new_project text;
  old_space text; new_space text;
  project_key text; space_key text;
  previous_payload text; payload text;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'runs' AND TG_OP = 'UPDATE' THEN
    IF (OLD.status,OLD.project_id) IS NOT DISTINCT FROM (NEW.status,NEW.project_id) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN old_space := OLD.space_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_space := NEW.space_id; END IF;
  IF TG_TABLE_NAME='projects' THEN
    IF TG_OP <> 'INSERT' THEN old_project := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN new_project := NEW.id; END IF;
  ELSIF TG_TABLE_NAME IN ('workspace_change_sets','task_merges') THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT project_id INTO old_project FROM execution_workspaces WHERE id=OLD.workspace_id AND space_id=old_space;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT project_id INTO new_project FROM execution_workspaces WHERE id=NEW.workspace_id AND space_id=new_space;
    END IF;
    IF TG_TABLE_NAME='task_merges' THEN
      IF old_project IS NULL AND TG_OP <> 'INSERT' THEN SELECT project_id INTO old_project FROM tasks WHERE id=OLD.task_id AND space_id=old_space; END IF;
      IF new_project IS NULL AND TG_OP <> 'DELETE' THEN SELECT project_id INTO new_project FROM tasks WHERE id=NEW.task_id AND space_id=new_space; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='decision_option_scores' THEN
    IF TG_OP <> 'INSERT' THEN SELECT project_id INTO old_project FROM decision_cases WHERE object_id=OLD.decision_case_id AND space_id=old_space; END IF;
    IF TG_OP <> 'DELETE' THEN SELECT project_id INTO new_project FROM decision_cases WHERE object_id=NEW.decision_case_id AND space_id=new_space; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN old_project := OLD.project_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_project := NEW.project_id; END IF;
  END IF;
  FOR n IN 1..2 LOOP
    project_key := CASE WHEN n=1 THEN old_project ELSE new_project END;
    space_key := CASE WHEN n=1 THEN old_space ELSE new_space END;
    IF space_key IS NOT NULL AND project_key IS NOT NULL THEN
      payload := json_build_object('space_id',space_key,'project_id',project_key)::text;
      IF payload IS DISTINCT FROM previous_payload THEN
        PERFORM pg_notify('rainver_project_live',payload); previous_payload := payload;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_live_tasks AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_workspaces AFTER INSERT OR UPDATE OR DELETE ON execution_workspaces FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_batches AFTER INSERT OR UPDATE OR DELETE ON workspace_change_sets FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_merges AFTER INSERT OR UPDATE OR DELETE ON task_merges FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_runs AFTER INSERT OR UPDATE OR DELETE ON runs FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_work AFTER INSERT OR UPDATE OR DELETE ON project_work_events FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_projects AFTER INSERT OR UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_members AFTER INSERT OR UPDATE OR DELETE ON project_members FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();

--> statement-breakpoint
CREATE TRIGGER project_live_operations AFTER INSERT OR UPDATE OR DELETE ON project_operations FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_proposals AFTER INSERT OR UPDATE OR DELETE ON proposals FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_inquiry AFTER INSERT OR UPDATE OR DELETE ON inquiry_signal_candidates FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_decisions AFTER INSERT OR UPDATE OR DELETE ON decision_cases FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_options AFTER INSERT OR UPDATE OR DELETE ON decision_options FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_criteria AFTER INSERT OR UPDATE OR DELETE ON decision_criteria FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_scores AFTER INSERT OR UPDATE OR DELETE ON decision_option_scores FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_activity AFTER INSERT OR UPDATE OR DELETE ON activity_records FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_memory AFTER INSERT OR UPDATE OR DELETE ON memory_entries FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();
--> statement-breakpoint
CREATE TRIGGER project_live_folders AFTER INSERT OR UPDATE OR DELETE ON project_folders FOR EACH ROW EXECUTE FUNCTION rainver_project_live_changed();


RESET search_path;

CREATE TABLE "execution_workspace_reviews" (
	"run_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"generation" integer NOT NULL,
	"workspace_location_id" varchar(36) NOT NULL,
	"expected_commit" varchar(64) NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"observed_commit" varchar(64),
	"observed_tree" varchar(64),
	"refusal" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_at" timestamp with time zone,
	CONSTRAINT "ck_workspace_review_state" CHECK (state IN ('pending','verified','refused'))
);
--> statement-breakpoint
ALTER TABLE "execution_workspace_reviews" ADD CONSTRAINT "execution_workspace_reviews_run_id_space_id_runs_id_space_id_fk" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_reviews" ADD CONSTRAINT "execution_workspace_reviews_workspace_id_space_id_execution_workspaces_id_space_id_fk" FOREIGN KEY ("workspace_id","space_id") REFERENCES "public"."execution_workspaces"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_workspace_reviews_workspace" ON "execution_workspace_reviews" USING btree ("space_id","workspace_id");

RESET search_path;

CREATE SEQUENCE "public"."managed_workspace_generation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "host_threads" ADD COLUMN "archive_generation" bigint;--> statement-breakpoint
-- Archive intents committed before this migration take their generation now, before any restore can be ordered after them.
UPDATE "host_threads" SET "archive_generation" = nextval('managed_workspace_generation_seq') WHERE "pending_archive_at" IS NOT NULL;


RESET search_path;

ALTER TABLE "host_threads" ADD COLUMN "archive_include_workspace" boolean;--> statement-breakpoint
-- Archive intents committed before this migration fix their cwd scope now, by the rule their commit used.
UPDATE "host_threads" thread SET "archive_include_workspace" = (
  thread."workspace_mode" = 'managed' AND (
    thread."container_kind" = 'direct' OR NOT EXISTS (
      SELECT 1 FROM "host_threads" other
       WHERE other."id" <> thread."id" AND other."session_id" = thread."session_id" AND other."space_id" = thread."space_id"
         AND other."container_kind" = 'conversation' AND other."status" IN ('active', 'session_reset'))))
 WHERE thread."pending_archive_at" IS NOT NULL;


RESET search_path;

-- Every archive intent already pending is unconfirmed: 0021 inferred its cwd scope from membership at migration
-- time, while earlier sends of the same operation chose theirs per send. Its Host receipt, not that value, is what
-- the operation already is (managedWorkspaceOperations.ts reconciles against it). Intents this release commits set it true.
ALTER TABLE "host_threads" ADD COLUMN "archive_scope_confirmed" boolean DEFAULT false NOT NULL;


RESET search_path;

ALTER TABLE "host_threads" ADD COLUMN "archive_unfenced_at" timestamp with time zone;--> statement-breakpoint
-- Every archive intent already committed may have been sent without a fence:
-- isolated-workspace profile archives were never journaled on any Host, and a
-- managed archive was legacy on a Host without the journal. Its copy may still
-- be in flight, so its launch barrier stays closed until the Host proves it can
-- fence (an upgraded process); a fencing Host clears it on the next launch.
UPDATE "host_threads" thread SET "archive_unfenced_at" = now()
 WHERE thread."status" = 'closed' AND thread."archive_generation" IS NOT NULL AND thread."execution_host_id" IS NOT NULL
   AND (thread."execution_workspace_json" IS NOT NULL OR NOT EXISTS (
     SELECT 1 FROM "hosts" host WHERE host."id" = thread."execution_host_id"
        AND host."capabilities_json"->>'managed_workspace_operations' = '1'));
--> statement-breakpoint
-- A workspace cleanup's profile archive already attempted was sent without an identity.
UPDATE "execution_workspaces" w SET "cleanup_json" = (
  SELECT jsonb_object_agg(r.key, CASE WHEN (r.value->>'kind' = 'legacy_profiles' OR r.value ? 'profile_agents')
                                       AND COALESCE((r.value->>'attempts')::int, 0) > 0
                                     THEN r.value || '{"sent_unfenced":true}'::jsonb ELSE r.value END)
    FROM jsonb_each(w."cleanup_json") r)
 WHERE jsonb_typeof(w."cleanup_json") = 'object' AND EXISTS (
   SELECT 1 FROM jsonb_each(w."cleanup_json") r
    WHERE (r.value->>'kind' = 'legacy_profiles' OR r.value ? 'profile_agents') AND COALESCE((r.value->>'attempts')::int, 0) > 0);


RESET search_path;

CREATE TABLE "host_command_intents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"host_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36),
	"kind" varchar(32) NOT NULL,
	"scope_key" varchar(64) NOT NULL,
	"status" varchar(24) NOT NULL,
	"job_id" varchar(36),
	"frozen_json" jsonb NOT NULL,
	"effect_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error_code" varchar(120),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_host_command_kind" CHECK (kind IN ('workspace_register','runtime_install','runtime_uninstall','runtime_own_update','runtime_managed_update','runtime_rollback','runtime_usage_refresh','ordinary_tool_install','ordinary_tool_register','ordinary_tool_remove','ordinary_account_logout','agent_host_state_reset','ambient_sync')),
	CONSTRAINT "ck_host_command_status" CHECK (status IN ('pending','dispatched','succeeded','failed','needs_attention'))
);
--> statement-breakpoint
ALTER TABLE "host_command_intents" ADD CONSTRAINT "host_command_intents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_command_intents" ADD CONSTRAINT "host_command_intents_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_command_intents" ADD CONSTRAINT "host_command_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_host_command_owner" ON "host_command_intents" USING btree ("space_id","user_id","host_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_host_command_active_scope" ON "host_command_intents" USING btree ("host_id","scope_key") WHERE status IN ('pending','dispatched');--> statement-breakpoint
CREATE INDEX "ix_host_command_agent_fence" ON "host_command_intents" USING btree ("host_id","agent_id") WHERE kind = 'agent_host_state_reset' AND status IN ('pending','dispatched');

RESET search_path;

CREATE TABLE "system_command_intents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"kind" varchar(48) NOT NULL,
	"scope_key" varchar(64) NOT NULL,
	"status" varchar(24) NOT NULL,
	"job_id" varchar(36),
	"frozen_json" jsonb NOT NULL,
	"effect_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error_code" varchar(120),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_system_command_kind" CHECK (kind IN ('provider_test','provider_plan_usage_refresh','provider_subscription_quota_refresh','plugin_install','backup_manual','webhook_dispatch')),
	CONSTRAINT "ck_system_command_status" CHECK (status IN ('pending','dispatched','succeeded','failed','needs_attention'))
);
--> statement-breakpoint
ALTER TABLE "system_command_intents" ADD CONSTRAINT "system_command_intents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_command_intents" ADD CONSTRAINT "system_command_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_system_command_owner" ON "system_command_intents" USING btree ("space_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_system_command_active_scope" ON "system_command_intents" USING btree ("scope_key") WHERE status IN ('pending','dispatched');

RESET search_path;

CREATE TABLE "official_plugin_scope_holds" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"plugin_id" varchar(128) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"owner_instance" varchar(36) NOT NULL,
	"state" varchar(16) NOT NULL,
	"release_plugin_id" varchar(128),
	"release_round" varchar(36),
	"attempts" integer DEFAULT 0 NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"last_outcome" varchar(24),
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"owner_lost_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "official_plugin_scope_holds_state" CHECK ((state)::text = ANY (ARRAY['active'::text, 'releasing'::text, 'released'::text, 'owner_gone'::text])),
	CONSTRAINT "official_plugin_scope_holds_round" CHECK (((state)::text <> 'releasing'::text) OR ((release_round IS NOT NULL) AND (release_plugin_id IS NOT NULL) AND (next_attempt_at IS NOT NULL))),
	CONSTRAINT "official_plugin_scope_holds_attempts" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "official_plugin_scope_holds_active_owner" ON "official_plugin_scope_holds" USING btree ("plugin_id","space_id","user_id","owner_instance") WHERE ((state)::text = 'active'::text);--> statement-breakpoint
CREATE INDEX "official_plugin_scope_holds_releasing_owner_idx" ON "official_plugin_scope_holds" USING btree ("owner_instance") WHERE ((state)::text = 'releasing'::text);--> statement-breakpoint
CREATE INDEX "official_plugin_scope_holds_round_idx" ON "official_plugin_scope_holds" USING btree ("release_round") WHERE ((state)::text = 'releasing'::text);--> statement-breakpoint
CREATE INDEX "official_plugin_scope_holds_scope_idx" ON "official_plugin_scope_holds" USING btree ("plugin_id","space_id","user_id");

RESET search_path;
