-- rainver:maintenance
CREATE TABLE "execution_workspace_runs" (
	"run_id" varchar(36) NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"change_set_id" varchar(36) NOT NULL,
	"access_mode" varchar(8) DEFAULT 'write' NOT NULL,
	"launch_sequence" integer DEFAULT 0 NOT NULL,
	"launch_reference_json" jsonb,
	"start_commit" varchar(64),
	"checkpoint_commit" varchar(64),
	"checkpoint_state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workspace_run_binding" UNIQUE("run_id","workspace_id"),
	CONSTRAINT "ck_workspace_run_access" CHECK (access_mode IN ('read','write')),
	CONSTRAINT "ck_workspace_run_checkpoint" CHECK (checkpoint_state IN ('pending','saved','blocked'))
);
--> statement-breakpoint
CREATE TABLE "execution_workspaces" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"workspace_location_id" varchar(36) NOT NULL,
	"execution_host_id" varchar(36) NOT NULL,
	"owner_kind" varchar(20) NOT NULL,
	"session_id" varchar(36),
	"task_id" varchar(36),
	"delegation_id" varchar(36),
	"parent_workspace_id" varchar(36),
	"generation" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"head_sequence" integer DEFAULT 0 NOT NULL,
	"baseline_mode" varchar(16),
	"snapshot_head" varchar(64),
	"state" varchar(24) DEFAULT 'requested' NOT NULL,
	"base_commit" varchar(64),
	"base_tree" varchar(64),
	"head_commit" varchar(64),
	"target_ref" varchar(256),
	"inventory_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cleanup_state" varchar(24) DEFAULT 'pending' NOT NULL,
	"cleanup_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_execution_workspaces_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_execution_workspace_owner" CHECK ((owner_kind='conversation' AND session_id IS NOT NULL AND task_id IS NULL AND delegation_id IS NULL) OR (owner_kind='task' AND task_id IS NOT NULL AND session_id IS NULL AND delegation_id IS NULL) OR (owner_kind='delegation' AND delegation_id IS NOT NULL AND session_id IS NULL AND task_id IS NULL)),
	CONSTRAINT "ck_execution_workspace_versions" CHECK (generation>0 AND revision>0),
	CONSTRAINT "ck_execution_workspace_state" CHECK (state IN ('requested','preparing','ready','blocked','retiring','retired')),
	CONSTRAINT "ck_execution_workspace_cleanup" CHECK (cleanup_state IN ('pending','running','retry_wait','blocked','cleaned'))
);
--> statement-breakpoint
CREATE TABLE "workspace_change_sets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"generation" integer NOT NULL,
	"sequence" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" varchar(24) DEFAULT 'open' NOT NULL,
	"originating_run_id" varchar(36) NOT NULL,
	"root_run_id" varchar(36) NOT NULL,
	"base_commit" varchar(64),
	"source_commit" varchar(64),
	"completion_basis" varchar(256),
	"summary" varchar(16000),
	"source_sequence" integer DEFAULT 0 NOT NULL,
	"verification_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workspace_change_sequence" UNIQUE("workspace_id","generation","sequence"),
	CONSTRAINT "uq_workspace_changes_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_workspace_changes_state" CHECK (state IN ('open','ready','integrating','blocked','integrated','no_changes','abandoned')),
	CONSTRAINT "ck_workspace_changes_version" CHECK (generation>0 AND sequence>0 AND revision>0)
);
--> statement-breakpoint
DROP INDEX "uq_host_threads_conversation_agent_active";--> statement-breakpoint
ALTER TABLE "task_merges" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "workspace_id" varchar(36);--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "change_set_id" varchar(36);--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "attempt_id" varchar(36);--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "generation" integer;--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "source_commit" varchar(64);--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "base_commit" varchar(64);--> statement-breakpoint
ALTER TABLE "task_merges" ADD COLUMN "target_ref" varchar(256);--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD COLUMN "workspace_baseline" varchar(16);--> statement-breakpoint
ALTER TABLE "host_threads" ADD COLUMN "execution_workspace_json" jsonb;--> statement-breakpoint
ALTER TABLE "host_threads" ADD COLUMN "delegation_id" varchar(36);--> statement-breakpoint
ALTER TABLE "execution_workspace_runs" ADD CONSTRAINT "execution_workspace_runs_run_id_space_id_runs_id_space_id_fk" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_runs" ADD CONSTRAINT "execution_workspace_runs_workspace_id_space_id_execution_workspaces_id_space_id_fk" FOREIGN KEY ("workspace_id","space_id") REFERENCES "public"."execution_workspaces"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspace_runs" ADD CONSTRAINT "execution_workspace_runs_change_set_id_space_id_workspace_change_sets_id_space_id_fk" FOREIGN KEY ("change_set_id","space_id") REFERENCES "public"."workspace_change_sets"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_space_id_projects_id_space_id_fk" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_workspace_location_id_execution_host_id_workspace_locations_id_execution_host_id_fk" FOREIGN KEY ("workspace_location_id","execution_host_id") REFERENCES "public"."workspace_locations"("id","execution_host_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_session_id_space_id_sessions_id_space_id_fk" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_task_id_space_id_tasks_id_space_id_fk" FOREIGN KEY ("task_id","space_id") REFERENCES "public"."tasks"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_delegation_id_space_id_run_delegations_id_space_id_fk" FOREIGN KEY ("delegation_id","space_id") REFERENCES "public"."run_delegations"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_change_sets" ADD CONSTRAINT "workspace_change_sets_workspace_id_space_id_execution_workspaces_id_space_id_fk" FOREIGN KEY ("workspace_id","space_id") REFERENCES "public"."execution_workspaces"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_execution_workspaces_session" ON "execution_workspaces" USING btree ("session_id","workspace_location_id","generation") WHERE owner_kind='conversation';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_execution_workspaces_task" ON "execution_workspaces" USING btree ("task_id","workspace_location_id","generation") WHERE owner_kind='task';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_execution_workspaces_delegation" ON "execution_workspaces" USING btree ("delegation_id","workspace_location_id","generation") WHERE owner_kind='delegation';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_change_open" ON "workspace_change_sets" USING btree ("workspace_id") WHERE state='open';--> statement-breakpoint
CREATE INDEX "ix_workspace_changes_run" ON "workspace_change_sets" USING btree ("space_id","originating_run_id");--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "task_merges_workspace_id_space_id_execution_workspaces_id_space_id_fk" FOREIGN KEY ("workspace_id","space_id") REFERENCES "public"."execution_workspaces"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "task_merges_change_set_id_space_id_workspace_change_sets_id_space_id_fk" FOREIGN KEY ("change_set_id","space_id") REFERENCES "public"."workspace_change_sets"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_delegation_id_space_id_run_delegations_id_space_id_fk" FOREIGN KEY ("delegation_id","space_id") REFERENCES "public"."run_delegations"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_host_threads_delegation_active" ON "host_threads" USING btree ("delegation_id") WHERE delegation_id IS NOT NULL AND status IN ('active', 'session_reset');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_host_threads_conversation_agent_active" ON "host_threads" USING btree ("session_id","agent_id") WHERE container_kind = 'conversation' AND status IN ('active', 'session_reset') AND session_id IS NOT NULL AND delegation_id IS NULL;--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "uq_task_merges_change_set" UNIQUE("change_set_id");--> statement-breakpoint
ALTER TABLE "task_merges" ADD CONSTRAINT "ck_task_merges_owner" CHECK ((task_id IS NOT NULL AND workspace_id IS NULL AND change_set_id IS NULL) OR (task_id IS NULL AND workspace_id IS NOT NULL AND change_set_id IS NOT NULL AND generation>0 AND source_commit IS NOT NULL AND base_commit IS NOT NULL AND target_ref IS NOT NULL));--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "ck_conversation_workspace_baseline" CHECK (workspace_baseline IS NULL OR workspace_baseline IN ('committed','snapshot'));--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "ck_host_threads_delegation" CHECK (delegation_id IS NULL OR (container_kind='conversation' AND workspace_mode='location'));

RESET search_path;

ALTER TABLE "execution_workspaces" DROP CONSTRAINT "ck_execution_workspace_versions";--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "materialization_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "retention_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "ck_execution_workspace_versions" CHECK (generation>0 AND revision>0 AND materialization_epoch>=0);

RESET search_path;

CREATE TABLE "workspace_source_releases" (
	"host_id" varchar(36) NOT NULL,
	"commit" varchar(64) NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"generation" integer NOT NULL,
	"operation_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_source_releases_host_id_commit_pk" PRIMARY KEY("host_id","commit")
);
--> statement-breakpoint
CREATE INDEX "ix_workspace_source_releases_operation" ON "workspace_source_releases" USING btree ("operation_id");--> statement-breakpoint
-- Already claimed (possibly executed, unconfirmed) shared-source deletions keep
-- their fence: one intent per (Host, commit) from every inflight batch.
INSERT INTO "workspace_source_releases"("host_id","commit","workspace_id","generation","operation_id")
SELECT DISTINCT ON (w.execution_host_id,s.commit) w.execution_host_id,s.commit,w.id,COALESCE((res.value->'workspace'->>'generation')::int,w.generation),res.value->'inflight'->>'operation_id'
FROM execution_workspaces w CROSS JOIN LATERAL jsonb_each(w.cleanup_json) res
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(res.value->'inflight'->'sources')='array' THEN res.value->'inflight'->'sources' ELSE '[]'::jsonb END) AS s(commit)
WHERE res.value->'inflight'->>'operation_id' IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The canonical registration gate for every writer of a shared-source
-- dependent (the same rows `freeSourceCommits` counts): a new or changed
-- dependent of a commit whose shared ref has a deletion intent on that Host is
-- refused until that deletion is confirmed. The per-(Host, commit) advisory
-- lock orders it against the claim, which takes the same lock before proving
-- the commit free. Read committed only: a fixed older snapshot could miss a
-- committed intent.
CREATE FUNCTION workspace_source_release_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 fence_host varchar;
 fence_commit text;
 fence_commits text[];
 fence_deadline timestamptz;
 fence_blocked boolean;
 fence_locked boolean:=false;
BEGIN
 IF TG_TABLE_NAME='task_merges' THEN
  IF NEW.status IN ('merged','no_changes') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.workspace_location_id IS NOT DISTINCT FROM OLD.workspace_location_id
   AND NEW.source_commit IS NOT DISTINCT FROM OLD.source_commit AND NEW.task_commit IS NOT DISTINCT FROM OLD.task_commit AND NEW.merged_commit IS NOT DISTINCT FROM OLD.merged_commit THEN RETURN NEW; END IF;
  SELECT l.execution_host_id INTO fence_host FROM workspace_locations l WHERE l.id=NEW.workspace_location_id;
  fence_commits:=ARRAY[NEW.source_commit,NEW.task_commit,NEW.merged_commit];
 ELSE
  IF NEW.state IN ('integrated','no_changes') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
   AND NEW.source_commit IS NOT DISTINCT FROM OLD.source_commit AND NEW.base_commit IS NOT DISTINCT FROM OLD.base_commit
   AND (NEW.verification_json->'submitted_commit'->>'source_commit') IS NOT DISTINCT FROM (OLD.verification_json->'submitted_commit'->>'source_commit') THEN RETURN NEW; END IF;
  SELECT w.execution_host_id INTO fence_host FROM execution_workspaces w WHERE w.id=NEW.workspace_id;
  fence_commits:=ARRAY[NEW.source_commit,NEW.base_commit,NEW.verification_json->'submitted_commit'->>'source_commit'];
 END IF;
 IF fence_host IS NULL THEN RETURN NEW; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'workspace_source_release_fence_requires_read_committed' USING ERRCODE='0A000';
 END IF;
 FOR fence_commit IN SELECT DISTINCT x FROM unnest(fence_commits) x WHERE x IS NOT NULL ORDER BY x LOOP
  -- A deletion usually ends within one Host round trip: wait briefly (no lock
  -- held while waiting), then take the lock and re-check before admitting.
  fence_deadline:=clock_timestamp()+make_interval(secs=>COALESCE(NULLIF(current_setting('rainver.source_release_wait_ms',true),'')::numeric,10000)/1000);
  LOOP
   IF TG_TABLE_NAME='task_merges' THEN
    fence_blocked:=EXISTS(SELECT 1 FROM workspace_source_releases r WHERE r.host_id=fence_host AND r.commit=fence_commit
     AND (r.workspace_id IS DISTINCT FROM NEW.workspace_id OR r.generation IS DISTINCT FROM NEW.generation));
   ELSE
    fence_blocked:=EXISTS(SELECT 1 FROM workspace_source_releases r WHERE r.host_id=fence_host AND r.commit=fence_commit
     AND (r.workspace_id<>NEW.workspace_id OR NEW.state<>'abandoned'));
   END IF;
   IF NOT fence_blocked AND NOT fence_locked THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('workspace-source-release:'||fence_host||':'||fence_commit,0));
    fence_locked:=true;
    CONTINUE;
   END IF;
   EXIT WHEN NOT fence_blocked;
   IF clock_timestamp()>=fence_deadline THEN
    RAISE EXCEPTION 'workspace_source_release_pending' USING ERRCODE='55P03';
   END IF;
   PERFORM pg_sleep(0.2);
  END LOOP;
  fence_locked:=false;
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workspace_source_release_fence BEFORE INSERT OR UPDATE ON task_merges
FOR EACH ROW EXECUTE FUNCTION workspace_source_release_fence();
--> statement-breakpoint
CREATE TRIGGER workspace_source_release_fence BEFORE INSERT OR UPDATE ON workspace_change_sets
FOR EACH ROW EXECUTE FUNCTION workspace_source_release_fence();


RESET search_path;

-- rainver:maintenance
-- Offline only: it replaces the (host_id, commit) key that the previous release's
-- claim names in ON CONFLICT (host_id, commit), so that release fails every shared
-- source claim once this runs; and the backfill below is a complete snapshot of the
-- unconfirmed claims only while no older server can claim or confirm meanwhile.
ALTER TABLE "workspace_source_releases" DROP CONSTRAINT "workspace_source_releases_host_id_commit_pk";--> statement-breakpoint
ALTER TABLE "workspace_source_releases" ADD CONSTRAINT "workspace_source_releases_host_id_commit_operation_id_pk" PRIMARY KEY("host_id","commit","operation_id");--> statement-breakpoint
-- One intent per unended operation (0019 kept one per commit and dropped the
-- others of a commit claimed by several pre-fence operations). Every claim
-- still unconfirmed in a cleanup resource gets its own row back, so the fence
-- lasts until each of them ended.
INSERT INTO "workspace_source_releases"("host_id","commit","workspace_id","generation","operation_id")
SELECT DISTINCT w.execution_host_id,s.commit,w.id,COALESCE((res.value->'workspace'->>'generation')::int,w.generation),res.value->'inflight'->>'operation_id'
FROM execution_workspaces w CROSS JOIN LATERAL jsonb_each(w.cleanup_json) res
CROSS JOIN LATERAL (
 SELECT x AS commit FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(res.value->'inflight'->'sources')='array' THEN res.value->'inflight'->'sources' ELSE '[]'::jsonb END) x
 UNION SELECT substring(r->>'ref' FROM 22) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(res.value->'inflight'->'refs')='array' THEN res.value->'inflight'->'refs' ELSE '[]'::jsonb END) r
  WHERE r->>'ref' LIKE 'refs/rainver/sources/%'
) s
WHERE jsonb_typeof(res.value)='object' AND res.value->'inflight'->>'operation_id' IS NOT NULL AND s.commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The one definition of which commits a row depends on: the fence trigger
-- below and the server's dependency checks (freeSourceCommits, the ref
-- inventory) all read these, so a registration is counted wherever it is fenced.
CREATE FUNCTION workspace_source_dependent_commits(source_commit text,base_commit text,verification jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY[source_commit,base_commit,verification->'submitted_commit'->>'source_commit',verification->'native_request'->>'submitted_commit']
$$;
--> statement-breakpoint
CREATE FUNCTION workspace_merge_dependent_commits(source_commit text,task_commit text,merged_commit text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY[source_commit,task_commit,merged_commit]
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workspace_source_release_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 fence_host varchar;
 fence_commit text;
 fence_commits text[];
 fence_deadline timestamptz;
 fence_blocked boolean;
 fence_locked boolean:=false;
BEGIN
 IF TG_TABLE_NAME='task_merges' THEN
  IF NEW.status IN ('merged','no_changes') THEN RETURN NEW; END IF;
  fence_commits:=workspace_merge_dependent_commits(NEW.source_commit,NEW.task_commit,NEW.merged_commit);
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.workspace_location_id IS NOT DISTINCT FROM OLD.workspace_location_id
   AND fence_commits IS NOT DISTINCT FROM workspace_merge_dependent_commits(OLD.source_commit,OLD.task_commit,OLD.merged_commit) THEN RETURN NEW; END IF;
  SELECT l.execution_host_id INTO fence_host FROM workspace_locations l WHERE l.id=NEW.workspace_location_id;
 ELSE
  IF NEW.state IN ('integrated','no_changes') THEN RETURN NEW; END IF;
  fence_commits:=workspace_source_dependent_commits(NEW.source_commit,NEW.base_commit,NEW.verification_json);
  IF TG_OP='UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
   AND fence_commits IS NOT DISTINCT FROM workspace_source_dependent_commits(OLD.source_commit,OLD.base_commit,OLD.verification_json) THEN RETURN NEW; END IF;
  SELECT w.execution_host_id INTO fence_host FROM execution_workspaces w WHERE w.id=NEW.workspace_id;
 END IF;
 IF fence_host IS NULL THEN RETURN NEW; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'workspace_source_release_fence_requires_read_committed' USING ERRCODE='0A000';
 END IF;
 FOR fence_commit IN SELECT DISTINCT x FROM unnest(fence_commits) x WHERE x IS NOT NULL ORDER BY x LOOP
  -- A deletion usually ends within one Host round trip: wait briefly (no lock
  -- held while waiting), then take the lock and re-check before admitting.
  -- Callers holding a lock the confirmation needs set the wait to 0 and retry
  -- outside their transaction.
  fence_deadline:=clock_timestamp()+make_interval(secs=>COALESCE(NULLIF(current_setting('rainver.source_release_wait_ms',true),'')::numeric,10000)/1000);
  LOOP
   IF TG_TABLE_NAME='task_merges' THEN
    fence_blocked:=EXISTS(SELECT 1 FROM workspace_source_releases r WHERE r.host_id=fence_host AND r.commit=fence_commit
     AND (r.workspace_id IS DISTINCT FROM NEW.workspace_id OR r.generation IS DISTINCT FROM NEW.generation));
   ELSE
    fence_blocked:=EXISTS(SELECT 1 FROM workspace_source_releases r WHERE r.host_id=fence_host AND r.commit=fence_commit
     AND (r.workspace_id<>NEW.workspace_id OR NEW.state<>'abandoned'));
   END IF;
   IF NOT fence_blocked AND NOT fence_locked THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('workspace-source-release:'||fence_host||':'||fence_commit,0));
    fence_locked:=true;
    CONTINUE;
   END IF;
   EXIT WHEN NOT fence_blocked;
   IF clock_timestamp()>=fence_deadline THEN
    RAISE EXCEPTION 'workspace_source_release_pending' USING ERRCODE='55P03';
   END IF;
   PERFORM pg_sleep(0.2);
  END LOOP;
  fence_locked:=false;
 END LOOP;
 RETURN NEW;
END $$;


RESET search_path;
