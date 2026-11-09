CREATE TABLE "evolution_bundle_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"bundle_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"job_id" varchar(36),
	"frozen_json" jsonb NOT NULL,
	"effects_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolution_bundle_decision_status" CHECK (status IN ('pending','applying','succeeded','failed','compensating','compensation_failed'))
);
--> statement-breakpoint
ALTER TABLE "evolution_bundle_decisions" ADD CONSTRAINT "evolution_bundle_decisions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundle_decisions" ADD CONSTRAINT "evolution_bundle_decisions_bundle_id_evolution_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."evolution_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundle_decisions" ADD CONSTRAINT "evolution_bundle_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolution_bundle_decision_input" ON "evolution_bundle_decisions" USING btree ("space_id","bundle_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolution_bundle_decision_active" ON "evolution_bundle_decisions" USING btree ("space_id","bundle_id") WHERE status IN ('pending','applying','compensating','compensation_failed');