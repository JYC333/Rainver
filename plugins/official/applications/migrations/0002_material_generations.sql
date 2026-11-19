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