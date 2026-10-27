CREATE TABLE "project_information_monitoring_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"config_json" jsonb NOT NULL,
	"config_hash" varchar(64) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"backfill_plan_id" varchar(36),
	"rule_id" varchar(36),
	"proposal_id" varchar(36),
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_monitoring_version" UNIQUE("space_id","project_id","version"),
	CONSTRAINT "uq_project_monitoring_id_project_space" UNIQUE("id","project_id","space_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "active_information_monitoring_version_id" varchar(36);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "information_monitoring_paused" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_information_monitoring_versions" ADD CONSTRAINT "project_information_monitoring_versions_project_id_space_id_projects_id_space_id_fk" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_information_monitoring_versions" ADD CONSTRAINT "project_information_monitoring_versions_source_channel_id_space_id_source_channels_id_space_id_fk" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_information_monitoring_versions" ADD CONSTRAINT "project_information_monitoring_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_project_monitoring_channel" ON "project_information_monitoring_versions" USING btree ("space_id","source_channel_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_monitoring_version_fkey" FOREIGN KEY ("active_information_monitoring_version_id","id","space_id") REFERENCES "public"."project_information_monitoring_versions"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;

RESET search_path;

ALTER TABLE "project_information_monitoring_versions" ADD COLUMN "query_fingerprint" varchar(128) DEFAULT '' NOT NULL;

RESET search_path;

ALTER TABLE "information_digest_items" ADD COLUMN "provenance_json" jsonb DEFAULT '{}'::jsonb NOT NULL;

RESET search_path;

CREATE UNIQUE INDEX "uq_project_operations_monitoring_day" ON "project_operations" USING btree ("space_id","project_id",(progress_json->>'local_date')) WHERE kind='custom' AND progress_json->>'purpose'='information_monitoring' AND progress_json->>'run_kind'='daily';--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "ck_project_operations_monitoring_day" CHECK (NOT (kind='custom' AND progress_json->>'purpose'='information_monitoring' AND progress_json->>'run_kind'='daily') OR (progress_json->>'local_date' IS NOT NULL AND progress_json->>'local_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'));

RESET search_path;

ALTER TABLE "source_item_user_states" ADD COLUMN "read_content_hash" varchar(128);
--> statement-breakpoint
-- Preserve existing reading state at its currently retained revision.
UPDATE source_item_user_states state SET read_content_hash=item.content_hash
FROM source_items item WHERE item.space_id=state.space_id AND item.id=state.source_item_id;


RESET search_path;

ALTER TABLE "source_item_user_states" DROP CONSTRAINT "ck_source_item_user_states_read_origin";--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD CONSTRAINT "ck_source_item_user_states_read_origin" CHECK (read_origin IS NULL OR read_origin IN ('library', 'serendipity', 'project'));

RESET search_path;

ALTER TABLE "source_item_user_states" ADD COLUMN "read_body_revision" integer;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "reading_initial_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "reading_body_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "reading_body_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "reading_body_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_source_items_reading_family" ON "source_items" USING btree ("space_id","canonical_uri","reading_initial_hash") WHERE deleted_at IS NULL;

RESET search_path;

-- Sources owns the meaning of a retained Reader body. Operational content_hash
-- may contain feed metadata, raw bytes or extracted text; it is not a version.
-- These triggers also cover an older application during a rolling upgrade.
CREATE FUNCTION source_reading_body_hash(p_space varchar, p_artifact varchar)
RETURNS varchar LANGUAGE plpgsql STABLE AS $$
DECLARE body text; payload text; format text; mime text;
BEGIN
  SELECT a.content, a.canonical_format, a.mime_type INTO payload, format, mime
    FROM artifacts a WHERE a.space_id=p_space AND a.id=p_artifact;
  IF payload IS NULL THEN RETURN NULL; END IF;
  IF format='reader_document_json' AND pg_input_is_valid(payload,'jsonb') THEN
    IF jsonb_typeof(payload::jsonb->'plain_text')='string' THEN body=payload::jsonb->>'plain_text'; END IF;
  ELSIF format IN ('txt','text','plain_text') AND mime LIKE 'text/%' THEN body=payload;
  END IF;
  IF body IS NULL THEN RETURN NULL; END IF;
  body=btrim(regexp_replace(normalize(body,NFC),'[[:space:]]+',' ','g'));
  IF body='' THEN RETURN NULL; END IF;
  RETURN encode(sha256(convert_to(body,'UTF8')),'hex');
END $$;
--> statement-breakpoint
-- Retained pre-upgrade material becomes the baseline, not a fabricated change.
WITH metadata_seed AS (
  SELECT space_id,source_item_id,(array_agg(content_hash ORDER BY captured_at,created_at,id))[1] AS hash
  FROM source_snapshots WHERE snapshot_type='metadata' AND content_hash IS NOT NULL
  GROUP BY space_id,source_item_id
), bodies AS (
  SELECT i.space_id,i.id,source_reading_body_hash(i.space_id,COALESCE(i.extracted_artifact_id,
    (SELECT s.artifact_id FROM source_snapshots s WHERE s.space_id=i.space_id AND s.source_item_id=i.id
      AND s.snapshot_type='extracted' AND s.artifact_id IS NOT NULL ORDER BY s.captured_at DESC,s.created_at DESC,s.id DESC LIMIT 1))) AS hash
  FROM source_items i
)
UPDATE source_items i SET reading_initial_hash=COALESCE(seed.hash,CASE WHEN body.hash IS NOT NULL THEN 'body:'||body.hash END,i.content_hash),
  reading_body_hash=body.hash
FROM bodies body LEFT JOIN metadata_seed seed ON seed.space_id=body.space_id AND seed.source_item_id=body.id
WHERE i.space_id=body.space_id AND i.id=body.id;
--> statement-breakpoint
UPDATE source_item_user_states SET read_body_revision=0;
--> statement-breakpoint
CREATE FUNCTION source_reading_item_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body_hash varchar;
BEGIN
  IF TG_OP='INSERT' THEN NEW.reading_initial_hash=COALESCE(NEW.reading_initial_hash,NEW.content_hash); END IF;
  IF NEW.extracted_artifact_id IS NOT NULL AND
    (TG_OP='INSERT' OR NEW.extracted_artifact_id IS DISTINCT FROM OLD.extracted_artifact_id) THEN
    body_hash=source_reading_body_hash(NEW.space_id,NEW.extracted_artifact_id);
    IF body_hash IS NOT NULL THEN
      IF NEW.reading_body_hash IS NOT NULL AND NEW.reading_body_hash<>body_hash THEN
        NEW.reading_body_revision=NEW.reading_body_revision+1;
        NEW.reading_body_changed_at=clock_timestamp();
      END IF;
      NEW.reading_body_hash=body_hash;
      NEW.reading_initial_hash=COALESCE(NEW.reading_initial_hash,'body:'||body_hash);
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_reading_item_version BEFORE INSERT OR UPDATE ON source_items
FOR EACH ROW EXECUTE FUNCTION source_reading_item_version();
--> statement-breakpoint
-- Reader falls back to the latest extracted snapshot only without a pointer.
CREATE FUNCTION source_reading_snapshot_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body_hash varchar;
BEGIN
  IF NEW.snapshot_type='extracted' AND NEW.artifact_id IS NOT NULL THEN
    body_hash=source_reading_body_hash(NEW.space_id,NEW.artifact_id);
    IF body_hash IS NOT NULL THEN
      UPDATE source_items SET reading_body_revision=reading_body_revision+
          CASE WHEN reading_body_hash IS NOT NULL AND reading_body_hash<>body_hash THEN 1 ELSE 0 END,
        reading_body_changed_at=CASE WHEN reading_body_hash IS NOT NULL AND reading_body_hash<>body_hash THEN clock_timestamp() ELSE reading_body_changed_at END,
        reading_body_hash=body_hash,reading_initial_hash=COALESCE(reading_initial_hash,'body:'||body_hash)
      WHERE space_id=NEW.space_id AND id=NEW.source_item_id AND extracted_artifact_id IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_reading_snapshot_version AFTER INSERT ON source_snapshots
FOR EACH ROW EXECUTE FUNCTION source_reading_snapshot_version();


RESET search_path;

-- Bind state written by the previous release without making its non-reading
-- updates renew an old completion. New application writes already carry a
-- body revision. No origin is inferred by this rolling-upgrade guard.
CREATE FUNCTION source_reading_legacy_state_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision integer; changed_at timestamptz; old_revision integer;
BEGIN
  SELECT reading_body_revision,reading_body_changed_at INTO current_revision,changed_at
    FROM source_items WHERE space_id=NEW.space_id AND id=NEW.source_item_id;
  IF TG_OP='INSERT' THEN
    NEW.read_body_revision=COALESCE(NEW.read_body_revision,current_revision);
  ELSE
    old_revision=COALESCE(OLD.read_body_revision,
      CASE WHEN changed_at IS NOT NULL AND OLD.updated_at<changed_at THEN current_revision-1 ELSE current_revision END);
    IF NEW.read_body_revision IS DISTINCT FROM OLD.read_body_revision THEN RETURN NEW; END IF;
    IF NEW.read_status IS DISTINCT FROM OLD.read_status THEN
      NEW.read_body_revision=current_revision;
      IF NEW.read_status<>'skimmed' AND NEW.progress_json->>'reading_state_at' IS NOT DISTINCT FROM OLD.progress_json->>'reading_state_at' THEN
        NEW.progress_json=NEW.progress_json||jsonb_build_object('reading_state_at',clock_timestamp());
      END IF;
    ELSIF NEW.last_opened_at IS DISTINCT FROM OLD.last_opened_at THEN
      IF old_revision<>current_revision THEN NEW.read_status='skimmed'; END IF;
      NEW.read_body_revision=current_revision;
    ELSE
      NEW.read_body_revision=COALESCE(NEW.read_body_revision,old_revision);
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_reading_legacy_state_binding BEFORE INSERT OR UPDATE ON source_item_user_states
FOR EACH ROW EXECUTE FUNCTION source_reading_legacy_state_binding();


RESET search_path;

-- Keep late historical imports from becoming the current retained body.
CREATE OR REPLACE FUNCTION source_reading_snapshot_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body_hash varchar;
BEGIN
  IF NEW.snapshot_type='extracted' AND NEW.artifact_id IS NOT NULL THEN
    -- An old import must not roll back Reader's latest-snapshot fallback.
    IF EXISTS(SELECT 1 FROM source_snapshots later WHERE later.space_id=NEW.space_id
      AND later.source_item_id=NEW.source_item_id AND later.snapshot_type='extracted' AND later.artifact_id IS NOT NULL
      AND (later.captured_at,later.created_at,later.id)>(NEW.captured_at,NEW.created_at,NEW.id)) THEN RETURN NEW; END IF;
    body_hash=source_reading_body_hash(NEW.space_id,NEW.artifact_id);
    IF body_hash IS NOT NULL THEN
      UPDATE source_items SET reading_body_revision=reading_body_revision+
          CASE WHEN reading_body_hash IS NOT NULL AND reading_body_hash<>body_hash THEN 1 ELSE 0 END,
        reading_body_changed_at=CASE WHEN reading_body_hash IS NOT NULL AND reading_body_hash<>body_hash THEN clock_timestamp() ELSE reading_body_changed_at END,
        reading_body_hash=body_hash,reading_initial_hash=COALESCE(reading_initial_hash,'body:'||body_hash)
      WHERE space_id=NEW.space_id AND id=NEW.source_item_id AND extracted_artifact_id IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;


RESET search_path;

ALTER TABLE "source_item_user_states" DROP COLUMN "read_content_hash";

RESET search_path;

CREATE TABLE "source_request_quota_state" (
	"group_key" varchar(64) PRIMARY KEY NOT NULL,
	"windows_json" jsonb NOT NULL,
	"cooldown_until" timestamp with time zone
);


RESET search_path;

CREATE TABLE "source_goal_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"source_connection_id" varchar(36) NOT NULL,
	"spec_json" jsonb NOT NULL,
	"previous_spec_json" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"cursor_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gaps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixture_json" jsonb,
	"failures" integer DEFAULT 0 NOT NULL,
	"repair_attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"lease_token" varchar(36),
	"lease_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_goal_bindings_source" UNIQUE("goal_id","source_connection_id"),
	CONSTRAINT "uq_source_goal_bindings_space_id" UNIQUE("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "source_goal_previews" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"status" varchar(24) NOT NULL,
	"result_json" jsonb NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_goal_repairs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"binding_id" varchar(36) NOT NULL,
	"base_revision" integer NOT NULL,
	"candidate_json" jsonb NOT NULL,
	"validation_json" jsonb,
	"status" varchar(24) DEFAULT 'candidate' NOT NULL,
	"created_by_run_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_goal_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"binding_id" varchar(36),
	"version_id" varchar(36) NOT NULL,
	"status" varchar(24) NOT NULL,
	"result_json" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_goal_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"revision" integer NOT NULL,
	"plan_json" jsonb NOT NULL,
	"created_by_run_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_goal_versions_revision" UNIQUE("goal_id","revision"),
	CONSTRAINT "uq_source_goal_versions_space_id" UNIQUE("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "source_goals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"agent_id" varchar(36) NOT NULL,
	"runtime_profile_id" varchar(36) NOT NULL,
	"intent_json" jsonb NOT NULL,
	"budget_json" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"current_version_id" varchar(36),
	"active_version_id" varchar(36),
	"start_key" varchar(128),
	"agent_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_goals_space_id" UNIQUE("space_id","id"),
	CONSTRAINT "ck_source_goal_revision" CHECK ("source_goals"."revision">=0)
);
--> statement-breakpoint
ALTER TABLE "source_goal_bindings" ADD CONSTRAINT "source_goal_bindings_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_bindings" ADD CONSTRAINT "source_goal_bindings_source_connection_id_space_id_source_connections_id_space_id_fk" FOREIGN KEY ("source_connection_id","space_id") REFERENCES "public"."source_connections"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_previews" ADD CONSTRAINT "source_goal_previews_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_previews" ADD CONSTRAINT "source_goal_previews_space_id_version_id_source_goal_versions_space_id_id_fk" FOREIGN KEY ("space_id","version_id") REFERENCES "public"."source_goal_versions"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_repairs" ADD CONSTRAINT "source_goal_repairs_space_id_binding_id_source_goal_bindings_space_id_id_fk" FOREIGN KEY ("space_id","binding_id") REFERENCES "public"."source_goal_bindings"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_runs" ADD CONSTRAINT "source_goal_runs_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_versions" ADD CONSTRAINT "source_goal_versions_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goals" ADD CONSTRAINT "source_goals_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goals" ADD CONSTRAINT "source_goals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goals" ADD CONSTRAINT "source_goals_space_id_project_id_projects_space_id_id_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "public"."projects"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_source_goal_runs_goal" ON "source_goal_runs" USING btree ("goal_id","started_at");

RESET search_path;

ALTER TABLE "source_goal_repairs" ADD CONSTRAINT "uq_source_goal_repair_run_revision" UNIQUE("binding_id","created_by_run_id","base_revision");

RESET search_path;

ALTER TABLE "source_goals" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_goals" ALTER COLUMN "runtime_profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_goals" ADD COLUMN "session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "source_goals" ADD COLUMN "legacy_channel_id" varchar(36);--> statement-breakpoint
ALTER TABLE "source_goals" ADD COLUMN "compatibility_json" jsonb;--> statement-breakpoint
ALTER TABLE "source_goals" ADD CONSTRAINT "uq_source_goals_legacy_channel" UNIQUE("space_id","legacy_channel_id");

RESET search_path;

-- Guard all legacy job writers, including a scheduler that selected its due
-- row before a goal's takeover. The channel row is the shared serialization key.
CREATE FUNCTION source_goal_legacy_scan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.job_type = 'connection_scan' AND NEW.metadata_json->>'source_channel_id' IS NOT NULL THEN
  PERFORM 1 FROM source_channels WHERE id=NEW.metadata_json->>'source_channel_id' AND space_id=NEW.space_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM source_goal_bindings b JOIN source_goals g ON g.id=b.goal_id AND g.space_id=b.space_id WHERE g.space_id=NEW.space_id AND b.spec_json->>'source_channel_id'=NEW.metadata_json->>'source_channel_id' AND g.active_version_id IS NOT NULL AND g.status<>'deleted') THEN
   RAISE EXCEPTION 'Collection goal owns this source schedule' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER source_goal_legacy_scan_guard BEFORE INSERT ON extraction_jobs FOR EACH ROW EXECUTE FUNCTION source_goal_legacy_scan_guard();


RESET search_path;

ALTER TABLE "source_goals" ADD COLUMN "creation_key" varchar(128);--> statement-breakpoint
ALTER TABLE "source_goals" ADD CONSTRAINT "uq_source_goal_creation" UNIQUE("space_id","owner_user_id","creation_key");

RESET search_path;

ALTER TABLE "source_goal_versions" ADD COLUMN "adjustment_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_goals" ADD COLUMN "adjustment_cycle" integer DEFAULT 0 NOT NULL;

RESET search_path;
