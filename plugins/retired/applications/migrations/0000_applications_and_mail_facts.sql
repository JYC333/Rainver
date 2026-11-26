-- rainver:plugin-squash [["0000_applications_baseline",17095],["0001_gmail_mail_facts",2384]]
-- rainver:plugin-squash [["0000_application_records",4825],["0001_material_notes",2119],["0002_material_generations",1351],["0003_funding_library_contact_links",4128],["0004_submission_recorded",1050],["0005_narrow_submission_history",1066],["0006_project_collaboration",2271]]
CREATE TABLE "plugin_applications"."applications" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"track" text NOT NULL,
	"institution" text NOT NULL,
	"program" text NOT NULL,
	"department" text,
	"intake" text,
	"status" text NOT NULL,
	"result_note" text,
	"notes" text,
	"source_label" text,
	"source_url" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_contact_events" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"contact_id" text NOT NULL,
	"occurred_on" date NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"summary" text NOT NULL,
	"response" text NOT NULL,
	"next_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contact_events_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_contacts" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"application_id" text,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"affiliation" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contacts_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_deadlines" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"due_on" date NOT NULL,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_deadlines_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_materials" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"required" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	"position" integer NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_materials_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_contact_events" ADD CONSTRAINT "application_contact_events_contact_fk" FOREIGN KEY ("space_id","user_id","project_id","contact_id") REFERENCES "plugin_applications"."application_contacts"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_deadlines" ADD CONSTRAINT "application_deadlines_application_fk" FOREIGN KEY ("space_id","user_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_materials" ADD CONSTRAINT "application_materials_application_fk" FOREIGN KEY ("space_id","user_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_contact_events_contact_idx" ON "plugin_applications"."application_contact_events" USING btree ("space_id","user_id","project_id","contact_id");--> statement-breakpoint
CREATE INDEX "application_contacts_owner_idx" ON "plugin_applications"."application_contacts" USING btree ("space_id","user_id","project_id");--> statement-breakpoint
CREATE INDEX "application_deadlines_application_idx" ON "plugin_applications"."application_deadlines" USING btree ("space_id","user_id","project_id","application_id");--> statement-breakpoint
CREATE INDEX "application_materials_application_idx" ON "plugin_applications"."application_materials" USING btree ("space_id","user_id","project_id","application_id");
CREATE TABLE "plugin_applications"."application_material_reviews" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"material_id" text NOT NULL,
	"note_id" text NOT NULL,
	"note_version" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_material_reviews_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_material_sources" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"material_id" text NOT NULL,
	"note_id" text NOT NULL,
	"note_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_material_sources_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id"),
	CONSTRAINT "application_material_sources_note_key" UNIQUE("space_id","user_id","project_id","material_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_materials" ADD COLUMN "note_id" text;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_material_reviews" ADD CONSTRAINT "application_material_reviews_material_fk" FOREIGN KEY ("space_id","user_id","project_id","material_id") REFERENCES "plugin_applications"."application_materials"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_material_sources" ADD CONSTRAINT "application_material_sources_material_fk" FOREIGN KEY ("space_id","user_id","project_id","material_id") REFERENCES "plugin_applications"."application_materials"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_material_reviews_material_idx" ON "plugin_applications"."application_material_reviews" USING btree ("space_id","user_id","project_id","material_id");
CREATE TABLE "plugin_applications"."application_material_generations" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"material_id" text NOT NULL,
	"run_id" text NOT NULL,
	"requirements" text NOT NULL,
	"length_words" integer,
	"emphasis" text,
	"base_note_id" text,
	"base_version" integer,
	"applied_note_id" text,
	"applied_version" integer,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_material_generations_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id"),
	CONSTRAINT "application_material_generations_run_key" UNIQUE("space_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_material_generations" ADD CONSTRAINT "application_material_generations_material_fk" FOREIGN KEY ("space_id","user_id","project_id","material_id") REFERENCES "plugin_applications"."application_materials"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_material_generations_material_idx" ON "plugin_applications"."application_material_generations" USING btree ("space_id","user_id","project_id","material_id");
CREATE TABLE "plugin_applications"."application_contact_links" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contact_links_space_id_user_id_project_id_contact_id_application_id_pk" PRIMARY KEY("space_id","user_id","project_id","contact_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_funding_links" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"funding_id" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_funding_links_space_id_user_id_project_id_funding_id_application_id_pk" PRIMARY KEY("space_id","user_id","project_id","funding_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_applications"."application_library_items" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"note_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_library_items_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id"),
	CONSTRAINT "application_library_items_note_key" UNIQUE("space_id","user_id","project_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_applications"."applications" ADD COLUMN "submission" text;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_contact_links" ADD CONSTRAINT "application_contact_links_contact_fk" FOREIGN KEY ("space_id","user_id","project_id","contact_id") REFERENCES "plugin_applications"."application_contacts"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_contact_links" ADD CONSTRAINT "application_contact_links_application_fk" FOREIGN KEY ("space_id","user_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_funding_links" ADD CONSTRAINT "application_funding_links_funding_fk" FOREIGN KEY ("space_id","user_id","project_id","funding_id") REFERENCES "plugin_applications"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_funding_links" ADD CONSTRAINT "application_funding_links_application_fk" FOREIGN KEY ("space_id","user_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_contact_links_application_idx" ON "plugin_applications"."application_contact_links" USING btree ("space_id","user_id","project_id","application_id");--> statement-breakpoint
CREATE INDEX "application_funding_links_application_idx" ON "plugin_applications"."application_funding_links" USING btree ("space_id","user_id","project_id","application_id");--> statement-breakpoint
-- Keep every existing contact binding: each contact bound to an application becomes one link row (Project-level contacts get none).
INSERT INTO "plugin_applications"."application_contact_links" ("space_id","user_id","project_id","contact_id","application_id","created_at")
SELECT c."space_id",c."user_id",c."project_id",c."id",c."application_id",c."created_at" FROM "plugin_applications"."application_contacts" c
JOIN "plugin_applications"."applications" a ON a."space_id"=c."space_id" AND a."user_id"=c."user_id" AND a."project_id"=c."project_id" AND a."id"=c."application_id"
WHERE c."application_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_contacts" DROP COLUMN "application_id";
ALTER TABLE "plugin_applications"."applications" ADD COLUMN "submission_recorded_at" timestamp with time zone;--> statement-breakpoint
-- Rows written before this column kept no history of an approved `submitted` decision. A row still at
-- `submitted` proves one; a row of a separate submission (never automatic) already past preparation may
-- have been submitted and then moved on by ordinary progress, so it is treated as submitted (fail closed:
-- it can no longer switch to automatic consideration; nothing else about it changes).
UPDATE "plugin_applications"."applications" SET "submission_recorded_at"="updated_at" WHERE "submission_recorded_at" IS NULL AND "submission" IS DISTINCT FROM 'automatic' AND "status" NOT IN ('planning','preparing','ready');--> statement-breakpoint
ALTER TABLE "plugin_applications"."applications" ADD CONSTRAINT "applications_submitted_not_automatic" CHECK ("plugin_applications"."applications"."submission_recorded_at" IS NULL OR "plugin_applications"."applications"."submission" IS DISTINCT FROM 'automatic');

-- Every supported writer creates at planning/revision 1, and each status write
-- increments the revision. A different status at revision <= 2 rules out a
-- submission followed by another status write, even if 0004 marked the row.
UPDATE "plugin_applications"."applications"
SET "submission_recorded_at" = NULL
WHERE "submission_recorded_at" IS NOT NULL AND "revision" <= 2 AND "status" <> 'submitted';
--> statement-breakpoint
-- An old funding record with at least two writes could have been submitted and
-- then moved to any other status. Its row cannot distinguish that from ordinary
-- edits. Bound new inferences to records from before the history bit existed.
-- The installer supplies the preceding migration's timestamp for this package.
UPDATE "plugin_applications"."applications"
SET "submission_recorded_at" = "updated_at"
WHERE "track" = 'funding'
  AND "submission" IS DISTINCT FROM 'automatic'
  AND "submission_recorded_at" IS NULL
  AND "revision" >= 3
  AND "created_at" <= current_setting('rainver.previous_migration_applied_at')::timestamptz;

-- rainver:plugin-squash [["0006_project_shared_applications",108],["0007_project_collaboration",2058]]
ALTER TABLE "plugin_applications"."applications" ADD COLUMN "project_shared" boolean DEFAULT false NOT NULL;
ALTER TABLE "plugin_applications"."application_contact_links" DROP CONSTRAINT "application_contact_links_application_fk";
--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_funding_links" DROP CONSTRAINT "application_funding_links_application_fk";
--> statement-breakpoint
DROP INDEX "plugin_applications"."application_contact_links_application_idx";--> statement-breakpoint
DROP INDEX "plugin_applications"."application_funding_links_application_idx";--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_contacts" ADD COLUMN "project_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_library_items" ADD COLUMN "project_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_material_generations" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "plugin_applications"."applications" ADD CONSTRAINT "applications_project_id_key" UNIQUE("space_id","project_id","id");--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_contact_links" ADD CONSTRAINT "application_contact_links_program_fk" FOREIGN KEY ("space_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_funding_links" ADD CONSTRAINT "application_funding_links_program_fk" FOREIGN KEY ("space_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_contact_links_project_application_idx" ON "plugin_applications"."application_contact_links" USING btree ("space_id","project_id","application_id");--> statement-breakpoint
CREATE INDEX "application_funding_links_program_idx" ON "plugin_applications"."application_funding_links" USING btree ("space_id","project_id","application_id");

CREATE TABLE "plugin_applications"."application_mail_facts" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"application_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"source_received_at" timestamp with time zone NOT NULL,
	"effect_key" text NOT NULL,
	"effect" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"before_value" text,
	"after_value" text,
	"deadline_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_mail_facts_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id"),
	CONSTRAINT "application_mail_facts_source_key" UNIQUE("space_id","user_id","project_id","source_message_id","effect_key","application_id"),
	CONSTRAINT "application_mail_facts_outcome" CHECK ("plugin_applications"."application_mail_facts"."outcome" IN ('recorded', 'unchanged', 'conflict')),
	CONSTRAINT "application_mail_facts_message_id" CHECK ("plugin_applications"."application_mail_facts"."source_message_id" ~ '^[0-9a-f]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "plugin_applications"."applications" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_deadlines" ADD COLUMN "date_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_applications"."application_mail_facts" ADD CONSTRAINT "application_mail_facts_application_fk" FOREIGN KEY ("space_id","project_id","application_id") REFERENCES "plugin_applications"."applications"("space_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_mail_facts_recent_idx" ON "plugin_applications"."application_mail_facts" USING btree ("space_id","user_id","project_id","created_at");--> statement-breakpoint
-- Otherwise existing statuses and dates were last set no later than their row's last update.
-- A record still at its initial status never observed one: no instant, as a new record (to_timestamp(0)).
UPDATE "plugin_applications"."applications" SET "status_changed_at"=CASE WHEN "status"='planning' AND "revision"=1 THEN to_timestamp(0) ELSE "updated_at" END;--> statement-breakpoint
UPDATE "plugin_applications"."application_deadlines" SET "date_changed_at"="updated_at";
