CREATE TABLE "project_folder_io_intents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"folder_id" varchar(36),
	"kind" varchar(24) NOT NULL,
	"scope_key" varchar(64) NOT NULL,
	"status" varchar(24) NOT NULL,
	"job_id" varchar(36),
	"frozen_json" jsonb NOT NULL,
	"effect_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error_code" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_folder_io_kind" CHECK (kind IN ('create','scan','save_draft','restore_revision')),
	CONSTRAINT "ck_project_folder_io_status" CHECK (status IN ('pending','prepared','applied','succeeded','failed','needs_attention'))
);
--> statement-breakpoint
ALTER TABLE "project_folder_io_intents" ADD CONSTRAINT "project_folder_io_intents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_io_intents" ADD CONSTRAINT "project_folder_io_intents_project_id_space_id_projects_id_space_id_fk" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_io_intents" ADD CONSTRAINT "project_folder_io_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_project_folder_io_owner" ON "project_folder_io_intents" USING btree ("space_id","user_id","project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_folder_io_active_scope" ON "project_folder_io_intents" USING btree ("space_id","project_id","scope_key") WHERE status IN ('pending','prepared','applied');