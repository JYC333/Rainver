CREATE TABLE "operation_idempotency" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"principal_kind" varchar(16) NOT NULL,
	"principal_id" varchar(128) NOT NULL,
	"on_behalf" varchar(256) NOT NULL,
	"authority_scope_id" varchar(256) NOT NULL,
	"operation_id" varchar(256) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"operation_version" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"state" varchar(32) NOT NULL,
	"proposal_id" varchar(36),
	"frozen_json" jsonb,
	"result_json" jsonb,
	"http_status" integer,
	"created_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_operation_request_scope" UNIQUE("space_id","principal_kind","principal_id","on_behalf","authority_scope_id","operation_id","idempotency_key"),
	CONSTRAINT "uq_operation_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "operation_request_state" CHECK ("operation_idempotency"."state" IN ('pending_approval','succeeded','failed','rejected','expired','superseded')),
	CONSTRAINT "operation_request_terminal" CHECK (("operation_idempotency"."state"='pending_approval' AND "operation_idempotency"."terminal_at" IS NULL AND "operation_idempotency"."proposal_id" IS NOT NULL) OR ("operation_idempotency"."state"<>'pending_approval' AND "operation_idempotency"."terminal_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operation_idempotency" ADD CONSTRAINT "operation_idempotency_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_idempotency" ADD CONSTRAINT "operation_idempotency_proposal_id_space_id_proposals_id_space_id_fk" FOREIGN KEY ("proposal_id","space_id") REFERENCES "public"."proposals"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_operation_retention" ON "operation_idempotency" USING btree ("state","terminal_at");