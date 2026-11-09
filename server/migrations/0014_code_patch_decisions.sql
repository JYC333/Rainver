CREATE TABLE "code_patch_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"job_id" varchar(36),
	"frozen_json" jsonb NOT NULL,
	"effect_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_code_patch_decision_phase" CHECK (phase IN ('apply','rollback')),
	CONSTRAINT "ck_code_patch_decision_status" CHECK (status IN ('pending','applying','succeeded','failed','compensating','compensation_failed'))
);
--> statement-breakpoint
ALTER TABLE "code_patch_decisions" ADD CONSTRAINT "code_patch_decisions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_patch_decisions" ADD CONSTRAINT "code_patch_decisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_patch_decisions" ADD CONSTRAINT "code_patch_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_code_patch_decision_input" ON "code_patch_decisions" USING btree ("space_id","proposal_id","phase","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_code_patch_decision_active" ON "code_patch_decisions" USING btree ("space_id","proposal_id") WHERE status IN ('pending','applying','compensating','compensation_failed');