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