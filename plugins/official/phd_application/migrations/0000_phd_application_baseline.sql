CREATE TABLE "plugin_phd_application"."applications" (
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
	"submission" text,
	"submission_recorded_at" timestamp with time zone,
	"result_note" text,
	"notes" text,
	"source_label" text,
	"source_url" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"project_shared" boolean DEFAULT false NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id"),
	CONSTRAINT "applications_project_id_key" UNIQUE("space_id","project_id","id"),
	CONSTRAINT "applications_submitted_not_automatic" CHECK ("plugin_phd_application"."applications"."submission_recorded_at" IS NULL OR "plugin_phd_application"."applications"."submission" IS DISTINCT FROM 'automatic')
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_contact_events" (
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
CREATE TABLE "plugin_phd_application"."application_contact_links" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contact_links_space_id_user_id_project_id_contact_id_application_id_pk" PRIMARY KEY("space_id","user_id","project_id","contact_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_contacts" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"affiliation" text,
	"note" text,
	"project_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contacts_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_deadlines" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"due_on" date NOT NULL,
	"task_id" text,
	"date_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_deadlines_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_funding_links" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"funding_id" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_funding_links_space_id_user_id_project_id_funding_id_application_id_pk" PRIMARY KEY("space_id","user_id","project_id","funding_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_library_items" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"note_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"project_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_library_items_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id"),
	CONSTRAINT "application_library_items_note_key" UNIQUE("space_id","user_id","project_id","note_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_mail_facts" (
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
	CONSTRAINT "application_mail_facts_outcome" CHECK ("plugin_phd_application"."application_mail_facts"."outcome" IN ('recorded', 'unchanged', 'conflict')),
	CONSTRAINT "application_mail_facts_message_id" CHECK ("plugin_phd_application"."application_mail_facts"."source_message_id" ~ '^[0-9a-f]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "plugin_phd_application"."application_material_generations" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"material_id" text NOT NULL,
	"run_id" text NOT NULL,
	"requested_by_user_id" text,
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
CREATE TABLE "plugin_phd_application"."application_material_reviews" (
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
CREATE TABLE "plugin_phd_application"."application_material_sources" (
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
CREATE TABLE "plugin_phd_application"."application_materials" (
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
	"note_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_materials_space_id_user_id_project_id_id_pk" PRIMARY KEY("space_id","user_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_contact_events" ADD CONSTRAINT "application_contact_events_contact_fk" FOREIGN KEY ("space_id","user_id","project_id","contact_id") REFERENCES "plugin_phd_application"."application_contacts"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_contact_links" ADD CONSTRAINT "application_contact_links_contact_fk" FOREIGN KEY ("space_id","user_id","project_id","contact_id") REFERENCES "plugin_phd_application"."application_contacts"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_contact_links" ADD CONSTRAINT "application_contact_links_program_fk" FOREIGN KEY ("space_id","project_id","application_id") REFERENCES "plugin_phd_application"."applications"("space_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_deadlines" ADD CONSTRAINT "application_deadlines_application_fk" FOREIGN KEY ("space_id","user_id","project_id","application_id") REFERENCES "plugin_phd_application"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_funding_links" ADD CONSTRAINT "application_funding_links_funding_fk" FOREIGN KEY ("space_id","user_id","project_id","funding_id") REFERENCES "plugin_phd_application"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_funding_links" ADD CONSTRAINT "application_funding_links_program_fk" FOREIGN KEY ("space_id","project_id","application_id") REFERENCES "plugin_phd_application"."applications"("space_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_mail_facts" ADD CONSTRAINT "application_mail_facts_application_fk" FOREIGN KEY ("space_id","project_id","application_id") REFERENCES "plugin_phd_application"."applications"("space_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_material_generations" ADD CONSTRAINT "application_material_generations_material_fk" FOREIGN KEY ("space_id","user_id","project_id","material_id") REFERENCES "plugin_phd_application"."application_materials"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_material_reviews" ADD CONSTRAINT "application_material_reviews_material_fk" FOREIGN KEY ("space_id","user_id","project_id","material_id") REFERENCES "plugin_phd_application"."application_materials"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_material_sources" ADD CONSTRAINT "application_material_sources_material_fk" FOREIGN KEY ("space_id","user_id","project_id","material_id") REFERENCES "plugin_phd_application"."application_materials"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_phd_application"."application_materials" ADD CONSTRAINT "application_materials_application_fk" FOREIGN KEY ("space_id","user_id","project_id","application_id") REFERENCES "plugin_phd_application"."applications"("space_id","user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_contact_events_contact_idx" ON "plugin_phd_application"."application_contact_events" USING btree ("space_id","user_id","project_id","contact_id");--> statement-breakpoint
CREATE INDEX "application_contact_links_project_application_idx" ON "plugin_phd_application"."application_contact_links" USING btree ("space_id","project_id","application_id");--> statement-breakpoint
CREATE INDEX "application_contacts_owner_idx" ON "plugin_phd_application"."application_contacts" USING btree ("space_id","user_id","project_id");--> statement-breakpoint
CREATE INDEX "application_deadlines_application_idx" ON "plugin_phd_application"."application_deadlines" USING btree ("space_id","user_id","project_id","application_id");--> statement-breakpoint
CREATE INDEX "application_funding_links_program_idx" ON "plugin_phd_application"."application_funding_links" USING btree ("space_id","project_id","application_id");--> statement-breakpoint
CREATE INDEX "application_mail_facts_recent_idx" ON "plugin_phd_application"."application_mail_facts" USING btree ("space_id","user_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "application_material_generations_material_idx" ON "plugin_phd_application"."application_material_generations" USING btree ("space_id","user_id","project_id","material_id");--> statement-breakpoint
CREATE INDEX "application_material_reviews_material_idx" ON "plugin_phd_application"."application_material_reviews" USING btree ("space_id","user_id","project_id","material_id");--> statement-breakpoint
CREATE INDEX "application_materials_application_idx" ON "plugin_phd_application"."application_materials" USING btree ("space_id","user_id","project_id","application_id");