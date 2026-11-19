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