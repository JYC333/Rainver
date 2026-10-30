CREATE TABLE "source_goal_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"source_connection_id" varchar(36) NOT NULL,
	"binding_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"first_goal_run_id" varchar(36) NOT NULL,
	"last_goal_run_id" varchar(36) NOT NULL,
	"agent_run_id" varchar(36),
	"selection_status" varchar(24) DEFAULT 'unjudged' NOT NULL,
	"selection_reason" text,
	"selection_source" varchar(24) DEFAULT 'collection' NOT NULL,
	"associated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_goal_items_goal_item" UNIQUE("goal_id","source_item_id"),
	CONSTRAINT "ck_source_goal_items_selection" CHECK ("source_goal_items"."selection_status" IN ('unjudged','important','not_selected','judgment_failed')),
	CONSTRAINT "ck_source_goal_items_selection_source" CHECK ("source_goal_items"."selection_source" IN ('collection','topic_judgment','owner_feedback'))
);
--> statement-breakpoint
ALTER TABLE "source_goals" ADD COLUMN "follow_json" jsonb;--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD CONSTRAINT "source_goal_items_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD CONSTRAINT "source_goal_items_source_item_id_space_id_source_items_id_space_id_fk" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_source_goal_items_item" ON "source_goal_items" USING btree ("space_id","source_item_id");--> statement-breakpoint
CREATE INDEX "ix_source_goal_items_goal_run" ON "source_goal_items" USING btree ("goal_id","first_goal_run_id");--> statement-breakpoint
-- Backfill only provable memberships: the same canonical proof Reading used
-- before this table existed (a succeeded goal collection audit, its binding's
-- own connection and the goal's matching scope: same Project, or for a
-- personal goal an item owned by the goal owner). No importance is inferred.
INSERT INTO "source_goal_items" ("id","space_id","goal_id","source_item_id","source_connection_id","binding_id","version_id","first_goal_run_id","last_goal_run_id","agent_run_id","associated_at","updated_at")
SELECT DISTINCT ON (g."id", i."id") gen_random_uuid()::text, i."space_id", g."id", i."id", i."connection_id", b."id", r."version_id", r."id", r."id", r."result_json"->>'native_run_id', i."first_seen_at", now()
FROM "source_items" i
JOIN "source_goal_runs" r ON r."id" = i."metadata_json"->>'goal_run_id' AND r."space_id" = i."space_id" AND r."status" = 'succeeded'
JOIN "source_goals" g ON g."id" = r."goal_id" AND g."space_id" = r."space_id" AND g."id" = i."metadata_json"->>'goal_id' AND g."project_id" IS NOT DISTINCT FROM i."project_id"
  AND (g."project_id" IS NOT NULL OR i."owner_user_id" IS NOT DISTINCT FROM g."owner_user_id")
JOIN "source_goal_bindings" b ON b."id" = r."binding_id" AND b."goal_id" = g."id" AND b."space_id" = g."space_id" AND b."source_connection_id" = i."connection_id"
WHERE i."deleted_at" IS NULL
ORDER BY g."id", i."id", r."started_at"
ON CONFLICT ("goal_id","source_item_id") DO NOTHING;


RESET search_path;

ALTER TABLE "source_goal_items" ADD COLUMN "judged_by" varchar(24);--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD COLUMN "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD COLUMN "change_evidence_url" text;--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD COLUMN "delivery_kind" varchar(24) DEFAULT 'unknown_freshness' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD CONSTRAINT "ck_source_goal_items_judged_by" CHECK ("source_goal_items"."judged_by" IS NULL OR "source_goal_items"."judged_by" IN ('topic_rules','collection_agent','owner'));--> statement-breakpoint
ALTER TABLE "source_goal_items" ADD CONSTRAINT "ck_source_goal_items_delivery" CHECK ("source_goal_items"."delivery_kind" IN ('baseline','new_publication','evidenced_change','unknown_freshness'));

RESET search_path;

CREATE TABLE "source_goal_item_changes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"goal_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"change_kind" varchar(24) NOT NULL,
	"evidence_url" text NOT NULL,
	"delivery_kind" varchar(24) NOT NULL,
	"goal_run_id" varchar(36) NOT NULL,
	"agent_run_id" varchar(36),
	"binding_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"selection_status" varchar(24) DEFAULT 'unjudged' NOT NULL,
	"selection_reason" text,
	"judged_by" varchar(24),
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_goal_item_changes_evidence" UNIQUE("goal_id","source_item_id","evidence_url"),
	CONSTRAINT "ck_source_goal_item_changes_kind" CHECK ("source_goal_item_changes"."change_kind" IN ('release','update')),
	CONSTRAINT "ck_source_goal_item_changes_delivery" CHECK ("source_goal_item_changes"."delivery_kind" IN ('baseline','evidenced_change')),
	CONSTRAINT "ck_source_goal_item_changes_selection" CHECK ("source_goal_item_changes"."selection_status" IN ('unjudged','important','not_selected','judgment_failed')),
	CONSTRAINT "ck_source_goal_item_changes_judged_by" CHECK ("source_goal_item_changes"."judged_by" IS NULL OR "source_goal_item_changes"."judged_by" IN ('topic_rules','collection_agent','owner'))
);
--> statement-breakpoint
ALTER TABLE "source_goal_item_changes" ADD CONSTRAINT "source_goal_item_changes_goal_id_source_item_id_source_goal_items_goal_id_source_item_id_fk" FOREIGN KEY ("goal_id","source_item_id") REFERENCES "public"."source_goal_items"("goal_id","source_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_item_changes" ADD CONSTRAINT "source_goal_item_changes_space_id_goal_id_source_goals_space_id_id_fk" FOREIGN KEY ("space_id","goal_id") REFERENCES "public"."source_goals"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_source_goal_item_changes_goal" ON "source_goal_item_changes" USING btree ("goal_id","detected_at");

RESET search_path;

CREATE TABLE "source_goal_change_user_states" (
	"space_id" varchar(36) NOT NULL,
	"change_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"read_status" varchar(24) DEFAULT 'unread' NOT NULL,
	"dismissed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_source_goal_change_user" UNIQUE("change_id","user_id"),
	CONSTRAINT "ck_source_goal_change_read" CHECK ("source_goal_change_user_states"."read_status" IN ('unread','skimmed','read','discussed')),
	CONSTRAINT "ck_source_goal_change_dismissed" CHECK ("source_goal_change_user_states"."dismissed" IN (0,1))
);
--> statement-breakpoint
ALTER TABLE "source_goal_item_changes" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_goal_change_user_states" ADD CONSTRAINT "source_goal_change_user_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_goal_item_changes" ADD CONSTRAINT "uq_source_goal_item_changes_space_id" UNIQUE("space_id","id");
--> statement-breakpoint
ALTER TABLE "source_goal_change_user_states" ADD CONSTRAINT "source_goal_change_user_states_space_id_change_id_source_goal_item_changes_space_id_id_fk" FOREIGN KEY ("space_id","change_id") REFERENCES "public"."source_goal_item_changes"("space_id","id") ON DELETE no action ON UPDATE no action;

RESET search_path;

CREATE TABLE "reader_positions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"document_type" varchar(32) NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"content_hash" varchar(128) NOT NULL,
	"structure_hash" varchar(128) NOT NULL,
	"current_json" jsonb NOT NULL,
	"current_progress" double precision NOT NULL,
	"current_client_at" timestamp with time zone NOT NULL,
	"furthest_json" jsonb,
	"furthest_progress" double precision DEFAULT 0 NOT NULL,
	"reset_client_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_reader_positions_document_type" CHECK (document_type IN ('source_item', 'source_snapshot', 'research_report', 'research_notebook')),
	CONSTRAINT "ck_reader_positions_current_json" CHECK (jsonb_typeof(current_json) = 'object'::text),
	CONSTRAINT "ck_reader_positions_progress" CHECK (current_progress >= 0 AND current_progress <= 1 AND furthest_progress >= 0 AND furthest_progress <= 1)
);
--> statement-breakpoint
ALTER TABLE "reader_positions" ADD CONSTRAINT "reader_positions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_positions" ADD CONSTRAINT "reader_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reader_positions_user_document" ON "reader_positions" USING btree ("space_id","user_id","document_type","document_id");

RESET search_path;

CREATE TABLE "reader_document_notes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"document_type" varchar(64) NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"note_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reader_document_notes_document_type" CHECK ("reader_document_notes"."document_type" in ('source_item','source_snapshot','research_report','research_notebook'))
);
--> statement-breakpoint
ALTER TABLE "reader_document_notes" ADD CONSTRAINT "reader_document_notes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_document_notes" ADD CONSTRAINT "reader_document_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_document_notes" ADD CONSTRAINT "reader_document_notes_note_space_fk" FOREIGN KEY ("note_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ix_reader_document_notes_person_document" ON "reader_document_notes" USING btree ("space_id","user_id","document_type","document_id");

RESET search_path;

ALTER TABLE "reader_document_notes" DROP CONSTRAINT "reader_document_notes_note_space_fk";
--> statement-breakpoint
ALTER TABLE "reader_document_notes" ADD COLUMN "note_space_id" varchar(36);--> statement-breakpoint
-- Older bindings pointed to a note in the document Space. Preserve those
-- associations; new creations resolve the canonical Personal Space instead.
UPDATE "reader_document_notes" SET "note_space_id" = "space_id" WHERE "note_space_id" IS NULL;--> statement-breakpoint
ALTER TABLE "reader_document_notes" ALTER COLUMN "note_space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reader_document_notes" ADD CONSTRAINT "reader_document_notes_note_space_fk" FOREIGN KEY ("note_id","note_space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;

RESET search_path;
