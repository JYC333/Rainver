-- rainver:maintenance
-- rainver:maintenance
CREATE TABLE "inquiry_problem_commands" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_json" jsonb NOT NULL,
	"result_json" jsonb NOT NULL,
	CONSTRAINT "uq_inquiry_problem_command_key" UNIQUE("space_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "inquiry_round_closeouts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"round_number" integer NOT NULL,
	"method_version" varchar(32) NOT NULL,
	"summary" text NOT NULL,
	"input_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_focus" jsonb,
	"iteration_id" varchar(36),
	"previous_primary" jsonb,
	"closed_revision" integer NOT NULL,
	"legacy_order_ambiguous" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_inquiry_closeout_round" UNIQUE("thread_id","space_id","round_number"),
	CONSTRAINT "uq_inquiry_closeout_iteration" UNIQUE("iteration_id","space_id"),
	CONSTRAINT "ck_inquiry_closeout_round" CHECK (round_number > 0)
);
--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" DROP CONSTRAINT "ck_inquiry_thread_steps_kind";--> statement-breakpoint
ALTER TABLE "inquiry_iterations" ADD COLUMN "round_number" integer;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "method_version" varchar(32) DEFAULT 'inquiry_research.v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "method_stage" varchar(16);--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "work_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "round_number" integer;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "selection_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "skipped_stages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "context_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry_threads" ADD COLUMN "problem_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry_problem_commands" ADD CONSTRAINT "inquiry_problem_command_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_round_closeouts" ADD CONSTRAINT "inquiry_closeout_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_round_closeouts" ADD CONSTRAINT "inquiry_closeout_iteration_fkey" FOREIGN KEY ("iteration_id","project_id","space_id") REFERENCES "public"."inquiry_iterations"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "ck_inquiry_thread_steps_selection" CHECK (selection_kind IS NULL OR selection_kind IN ('select','skip','return'));--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "ck_inquiry_thread_steps_kind" CHECK ((method_version = 'inquiry_research.v1' AND kind IN ('clarify_or_decompose','search_acquisition','design_run_experiment','read_evidence','synthesize','promote_knowledge','create_decision_case','create_delivery_task')) OR (method_version = 'problem_solving.v1' AND kind = work_kind AND work_kind IN ('select_method','record_work','invoke_research','link_task','reference_result','assess_result','close_round') AND method_stage IN ('frame','plan','act','verify','conclude') AND round_number > 0));
--> statement-breakpoint
-- Preserve each legacy Iteration as one boundary. Tied timestamps are marked,
-- not presented as a trustworthy cognitive order (id only stabilizes replay).
WITH old AS (
 SELECT i.*,row_number() OVER(PARTITION BY thread_id,space_id ORDER BY created_at,id)::integer AS n,
 (count(*) OVER(PARTITION BY thread_id,space_id,created_at)>1)::integer AS ambiguous
 FROM inquiry_iterations i
)
INSERT INTO inquiry_round_closeouts(id,space_id,project_id,thread_id,round_number,method_version,summary,input_refs,next_focus,iteration_id,closed_revision,legacy_order_ambiguous,created_by_user_id,created_at)
SELECT id,space_id,project_id,thread_id,n,'inquiry_research.v1',change_summary,input_refs_json,to_jsonb(confirmed_next_focus),id,0,ambiguous,created_by_user_id,created_at FROM old
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE inquiry_iterations i SET round_number=c.round_number FROM inquiry_round_closeouts c WHERE c.iteration_id=i.id AND c.space_id=i.space_id;
--> statement-breakpoint
UPDATE inquiry_thread_steps s SET round_number=c.round_number FROM inquiry_round_closeouts c WHERE s.iteration_id=c.iteration_id AND s.space_id=c.space_id;
--> statement-breakpoint
-- Open legacy work starts in the migration's current window. Unassigned old
-- terminal Steps remain unclassified history rather than ticking a new round.
UPDATE inquiry_thread_steps s SET round_number=1+(SELECT COALESCE(max(c.round_number),0) FROM inquiry_round_closeouts c WHERE c.thread_id=s.thread_id AND c.space_id=s.space_id) WHERE s.status='in_progress' AND s.round_number IS NULL;


RESET search_path;

ALTER TABLE "inquiry_thread_steps" DROP CONSTRAINT "ck_inquiry_thread_steps_kind";--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD COLUMN "method_version" varchar(32) DEFAULT 'inquiry_research.v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "ck_inquiry_thread_steps_kind" CHECK ((method_version = 'inquiry_research.v1' AND kind IN ('clarify_or_decompose','search_acquisition','design_run_experiment','read_evidence','synthesize','promote_knowledge','create_decision_case','create_delivery_task')) OR (method_version = 'problem_solving.v1' AND work_kind IS NOT NULL AND method_stage IS NOT NULL AND round_number IS NOT NULL AND kind = work_kind AND work_kind IN ('select_method','record_work','invoke_research','link_task','reference_result','assess_result','close_round') AND method_stage IN ('frame','plan','act','verify','conclude') AND round_number > 0));--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD CONSTRAINT "ck_inquiry_thread_advice_method" CHECK (method_version = 'inquiry_research.v1');

RESET search_path;

ALTER TABLE "inquiry_thread_steps" ADD COLUMN "fact_order" bigserial NOT NULL;

RESET search_path;

ALTER TABLE "inquiry_thread_steps" ADD COLUMN "fact_order_trusted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD COLUMN "ended_reason" varchar(24);--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD COLUMN "problem_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 0011 assigned old rows by a database scan, not a trustworthy historical order.
UPDATE inquiry_thread_steps SET fact_order_trusted=false;


RESET search_path;

ALTER TABLE "project_operations" ADD COLUMN "research_call_json" jsonb;--> statement-breakpoint
ALTER TABLE "project_operations" ADD COLUMN "research_step_id" varchar(36);--> statement-breakpoint
ALTER TABLE "project_operations" ADD COLUMN "research_call_key" varchar(256);--> statement-breakpoint
ALTER TABLE "project_operations" ADD COLUMN "research_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_operations" ADD COLUMN "research_reconcile_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "research_problem_step_fkey" FOREIGN KEY ("research_step_id") REFERENCES "public"."inquiry_thread_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_problem_step" ON "project_operations" USING btree ("research_step_id") WHERE research_step_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_problem_call_key" ON "project_operations" USING btree ("space_id","project_id","research_call_key") WHERE research_call_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "ck_research_problem_call" CHECK ((research_call_json IS NULL AND research_step_id IS NULL AND research_call_key IS NULL) OR (kind='research' AND research_call_json->>'schema_version'='research_call.v1' AND research_call_json->>'operation_id'=id AND research_call_json->>'step_id'=research_step_id AND research_call_key IS NOT NULL));--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "ck_research_problem_attempt" CHECK (research_attempt>0);

RESET search_path;

ALTER TABLE "project_operations" DROP CONSTRAINT "ck_research_problem_call";--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "ck_research_problem_call" CHECK ((research_call_json IS NULL AND research_step_id IS NULL AND research_call_key IS NULL) OR (research_call_json IS NOT NULL AND research_step_id IS NOT NULL AND kind='research' AND research_call_json->>'schema_version'='research_call.v1' AND research_call_json->>'operation_id'=id AND research_call_json->>'step_id'=research_step_id AND research_call_key IS NOT NULL) IS TRUE);

RESET search_path;

ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "uq_inquiry_steps_id_project_space" UNIQUE("id","project_id","space_id");--> statement-breakpoint
ALTER TABLE "project_operations" DROP CONSTRAINT "research_problem_step_fkey";--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "research_problem_step_scope_fkey" FOREIGN KEY ("research_step_id","project_id","space_id") REFERENCES "public"."inquiry_thread_steps"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;


RESET search_path;

ALTER TABLE "inquiry_threads" ADD COLUMN "scope_boundary" text;

RESET search_path;

-- rainver:maintenance
CREATE TABLE "maintenance_model_archives" (
	"source_table" varchar(64) NOT NULL,
	"source_id" varchar(128) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "maintenance_model_archives_source_table_source_id_pk" PRIMARY KEY("source_table","source_id")
);
--> statement-breakpoint
-- Offline, lossless archival. No application domain reads these records.
INSERT INTO maintenance_model_archives SELECT 'task_loop_states',task_id,space_id,to_jsonb(t) FROM task_loop_states t;
--> statement-breakpoint
INSERT INTO maintenance_model_archives SELECT 'inquiry_thread_advice',id,space_id,to_jsonb(t) FROM inquiry_thread_advice t;
--> statement-breakpoint
INSERT INTO maintenance_model_archives SELECT 'inquiry_threads_next_focus',object_id,space_id,to_jsonb(t) FROM inquiry_threads t WHERE next_focus_kind IS NOT NULL OR next_focus_note IS NOT NULL;
--> statement-breakpoint
INSERT INTO maintenance_model_archives SELECT 'project_work_events',id,space_id,to_jsonb(e) FROM project_work_events e WHERE event_kind='task.stage_changed';
--> statement-breakpoint
UPDATE project_work_events SET event_kind='task.history_imported',data_json=jsonb_build_object('summary','Imported pre-cutover task history','original_event_kind',event_kind,'original_data',data_json) WHERE event_kind='task.stage_changed';
--> statement-breakpoint
-- This cutover has no license to invent stages/call bindings for unknown history.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM inquiry_thread_steps WHERE method_version<>'problem_solving.v1') THEN
  RAISE EXCEPTION 'Legacy Step facts require explicit offline conversion before new-model-only cutover';
 END IF;
END $$;
--> statement-breakpoint
INSERT INTO maintenance_model_archives SELECT 'inquiry_round_closeouts',id,space_id,to_jsonb(t) FROM inquiry_round_closeouts t WHERE method_version<>'problem_solving.v1';
--> statement-breakpoint
UPDATE inquiry_round_closeouts SET method_version='problem_solving.v1',next_focus=NULL WHERE method_version<>'problem_solving.v1';
--> statement-breakpoint
UPDATE inquiry_threads SET next_focus_kind=NULL,next_focus_note=NULL;
--> statement-breakpoint

ALTER TABLE "inquiry_thread_advice" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_loop_states" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "inquiry_thread_advice" CASCADE;--> statement-breakpoint
DROP TABLE "task_loop_states" CASCADE;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" DROP CONSTRAINT "ck_inquiry_thread_steps_kind";--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ALTER COLUMN "method_version" SET DEFAULT 'problem_solving.v1';--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "ck_inquiry_thread_steps_kind" CHECK ((method_version = 'problem_solving.v1' AND work_kind IS NOT NULL AND method_stage IS NOT NULL AND round_number IS NOT NULL AND kind = work_kind AND work_kind IN ('select_method','record_work','invoke_research','link_task','reference_result','assess_result','close_round') AND method_stage IN ('frame','plan','act','verify','conclude') AND round_number > 0));

RESET search_path;

-- rainver:maintenance
ALTER TABLE "inquiry_threads" DROP CONSTRAINT "ck_inquiry_threads_focused_next_focus";--> statement-breakpoint
ALTER TABLE "inquiry_threads" DROP COLUMN "next_focus_kind";--> statement-breakpoint
ALTER TABLE "inquiry_threads" DROP COLUMN "next_focus_note";

RESET search_path;

-- rainver:maintenance
-- Keep the original cognitive history before removing its obsolete intent field.
INSERT INTO maintenance_model_archives SELECT 'inquiry_iterations',id,space_id,to_jsonb(i) FROM inquiry_iterations i;
--> statement-breakpoint
ALTER TABLE "inquiry_iterations" DROP COLUMN "confirmed_next_focus";

RESET search_path;

-- rainver:maintenance
-- 0017 wrapped event data, but canonical readers authorize top-level run_id
-- and reference_refs. Restore original top-level facts without replacing any
-- current valid values, identity, actor, timestamps or archived payload.
-- Also retain all other original provenance (e.g. undo_of_event_id), not just
-- the currently known ACL keys. No relationship is inferred from correlation.
WITH sources AS (
 SELECT e.id,e.space_id,e.data_json,
 COALESCE(
  CASE WHEN jsonb_typeof(a.record->'data_json')='object' THEN a.record->'data_json' END,
  CASE WHEN jsonb_typeof(e.data_json->'original_data')='object' THEN e.data_json->'original_data' END,
  '{}'::jsonb
 ) AS original
 FROM project_work_events e
 LEFT JOIN maintenance_model_archives a
 ON a.source_table='project_work_events' AND a.source_id=e.id AND a.space_id=e.space_id
 AND a.record->>'id'=e.id AND a.record->>'project_id'=e.project_id
 AND a.record->>'subject_id'=e.subject_id AND a.record->>'subject_type'=e.subject_type
 AND a.record->>'actor_id'=e.actor_id
 WHERE e.event_kind='task.history_imported'
), repaired AS (
 SELECT id,space_id,
 (original || data_json)
 || CASE WHEN (jsonb_typeof(data_json->'run_id') IS DISTINCT FROM 'string' OR data_json->>'run_id'='')
           AND jsonb_typeof(original->'run_id')='string' AND original->>'run_id'<>''
         THEN jsonb_build_object('run_id',original->'run_id') ELSE '{}'::jsonb END
 || CASE WHEN jsonb_typeof(data_json->'reference_refs') IS DISTINCT FROM 'array'
           AND jsonb_typeof(original->'reference_refs')='array'
         THEN jsonb_build_object('reference_refs',original->'reference_refs') ELSE '{}'::jsonb END AS data_json
 FROM sources
)
UPDATE project_work_events e SET data_json=r.data_json FROM repaired r
WHERE e.id=r.id AND e.space_id=r.space_id AND e.data_json IS DISTINCT FROM r.data_json;


RESET search_path;

-- rainver:maintenance
-- The running release still selects these pre-cutover ordering markers.
ALTER TABLE "inquiry_round_closeouts" DROP COLUMN "legacy_order_ambiguous";--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" DROP COLUMN "fact_order_trusted";

RESET search_path;


RESET search_path;

-- rainver:maintenance
-- Authorized offline retirement: retain a verified private external export and
-- database backup before applying to an existing instance. Never relabel these
-- legacy facts as new Task reports or method work.
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM project_work_events e
  WHERE e.event_kind<>'task.history_imported'
   AND (e.causation_id IN (SELECT id FROM project_work_events WHERE event_kind='task.history_imported')
    OR e.data_json->>'undo_of_event_id' IN (SELECT id FROM project_work_events WHERE event_kind='task.history_imported'))
 ) THEN
  RAISE EXCEPTION 'Normal work references retired events; preserve and review dependencies before removal';
 END IF;
END $$;
--> statement-breakpoint
DELETE FROM project_work_events WHERE event_kind='task.history_imported';
--> statement-breakpoint
DROP TABLE "maintenance_model_archives";


RESET search_path;
