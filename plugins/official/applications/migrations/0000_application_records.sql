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