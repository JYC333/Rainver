ALTER TABLE "source_handler_versions" ADD COLUMN "handler_artifact_cleanup_json" jsonb;

RESET search_path;

CREATE TABLE "gmail_digest_mail_items" (
	"digest_id" varchar(36) NOT NULL,
	"google_message_id" varchar(64) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"status" varchar(16) NOT NULL,
	"reason" varchar(32),
	"candidate_application_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_delivery_id" varchar(36),
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gmail_digest_mail_items_pkey" PRIMARY KEY("digest_id","google_message_id"),
	CONSTRAINT "ck_gmail_digest_mail_items_message_id" CHECK (google_message_id ~ '^[0-9a-f]{1,64}$'),
	CONSTRAINT "ck_gmail_digest_mail_items_status" CHECK (status IN ('pending', 'done', 'review', 'failed')),
	CONSTRAINT "ck_gmail_digest_mail_items_reason" CHECK (reason IS NULL OR reason IN ('ambiguous_application', 'no_matching_application', 'unclear_fact', 'conflict', 'read_failed')),
	CONSTRAINT "ck_gmail_digest_mail_items_candidates" CHECK (jsonb_typeof(candidate_application_ids) = 'array' AND jsonb_array_length(candidate_application_ids) <= 5),
	CONSTRAINT "ck_gmail_digest_mail_items_attempts" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "plugin_data_grants" DROP CONSTRAINT "ck_plugin_data_grants_shape";--> statement-breakpoint
ALTER TABLE "gmail_digests" DROP CONSTRAINT "ck_gmail_digests_kind";--> statement-breakpoint
ALTER TABLE "gmail_digests" DROP CONSTRAINT "ck_gmail_digests_local_time";--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD COLUMN "effects" jsonb;--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD COLUMN "runtime_binding" jsonb;--> statement-breakpoint
ALTER TABLE "gmail_digest_mail_items" ADD CONSTRAINT "gmail_digest_mail_items_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "public"."gmail_digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_digest_mail_items_pending" ON "gmail_digest_mail_items" USING btree ("digest_id","status","received_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_digest_mail_items_updated" ON "gmail_digest_mail_items" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_shape" CHECK ((data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))
		OR (data_class = 'sensitive' AND scope = 'project' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND toolset = 'read'
			AND target_run_id IS NULL AND expires_at IS NULL AND plugin_id LIKE 'core:%' AND project_id IS NOT NULL AND connection_id IS NOT NULL
			AND connection_generation IS NOT NULL AND connection_generation >= 1 AND purpose IS NOT NULL AND purpose IN ('on_demand_read', 'daily_digest', 'rule_digest', 'application_update')));--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_application" CHECK ((kind = 'application') = (effects IS NOT NULL AND runtime_binding IS NOT NULL));--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_effects" CHECK (effects IS NULL OR (jsonb_typeof(effects) = 'array' AND jsonb_array_length(effects) BETWEEN 1 AND 7));--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_kind" CHECK (kind IN ('daily', 'rule', 'application'));--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_local_time" CHECK ((kind = 'daily' AND local_time IS NOT NULL AND time_zone IS NOT NULL AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') OR (kind IN ('rule', 'application') AND local_time IS NULL AND time_zone IS NULL));

RESET search_path;

ALTER TABLE "run_attempts" ADD COLUMN "model_proof_json" jsonb;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "ck_run_attempts_model_proof" CHECK (model_proof_json IS NULL OR (launch_id IS NOT NULL AND model_proof_json->>'launch_id' = launch_id AND jsonb_typeof(model_proof_json->'models') = 'array'));

RESET search_path;

ALTER TABLE "agent_data_read_logs" ADD COLUMN "launch_id" varchar(36);--> statement-breakpoint
ALTER TABLE "run_tool_identities" ADD COLUMN "launch_id" varchar(36);--> statement-breakpoint
-- A live token issued before tokens carried their launch is bound to its Run's current open launch, which is
-- what it resolved to until now; a token whose Run has no open launched attempt stays unbound and no longer resolves.
UPDATE "run_tool_identities" i SET "launch_id" = a."launch_id"
  FROM "run_attempts" a
 WHERE a."run_id" = i."run_id" AND a."space_id" = i."space_id" AND a."status" IN ('queued', 'running') AND a."launch_id" IS NOT NULL
   AND i."revoked_at" IS NULL
   AND a."attempt_number" = (SELECT max(c."attempt_number") FROM "run_attempts" c WHERE c."run_id" = i."run_id" AND c."space_id" = i."space_id");


RESET search_path;

ALTER TABLE "gmail_digest_mail_items" DROP CONSTRAINT "ck_gmail_digest_mail_items_reason";--> statement-breakpoint
ALTER TABLE "gmail_digest_mail_items" ADD CONSTRAINT "ck_gmail_digest_mail_items_reason" CHECK (reason IS NULL OR reason IN ('ambiguous_application', 'no_matching_application', 'unclear_fact', 'conflict', 'read_failed', 'not_eligible'));

RESET search_path;

-- Room conversation recycle bin. Deliberately no backfill: a session already
-- 'deleted' before this release has no recorded deletion time or prior list, so
-- it keeps the trash columns empty and is neither listed, restored nor purged by
-- the bin. Deciding what happens to those rows needs an explicit operator
-- action (.agent/modules/rooms.md, "Conversation recycle bin").
ALTER TABLE "sessions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "deleted_from_status" varchar(32);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "purge_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_sessions_trash_purge" ON "sessions" USING btree ("deleted_at","id") WHERE status = 'deleted' AND deleted_at IS NOT NULL AND purged_at IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_trash_state" CHECK (
		(deleted_at IS NULL AND deleted_from_status IS NULL AND purged_at IS NULL
			AND purge_attempts = 0 AND purge_retry_at IS NULL)
		OR (status = 'deleted' AND deleted_at IS NOT NULL
			AND deleted_from_status IS NOT NULL AND deleted_from_status IN ('active', 'archived'))
	);

RESET search_path;

CREATE TABLE "gmail_application_shared_results" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"digest_id" varchar(36) NOT NULL,
	"delivery_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"google_message_id" varchar(64) NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"application_label" varchar(600) NOT NULL,
	"effect" varchar(32) NOT NULL,
	"before_value" varchar(64),
	"after_value" varchar(64),
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_application_shared_results_fact" UNIQUE("delivery_id","google_message_id","application_id","effect"),
	CONSTRAINT "ck_gmail_application_shared_results_message_id" CHECK (google_message_id ~ '^[0-9a-f]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "gmail_read_delegations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"gmail_connection_id" varchar(36) NOT NULL,
	"connection_generation" integer NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"grantee_user_id" varchar(36) NOT NULL,
	"query_scope" varchar(200) NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"status" varchar(16) NOT NULL,
	"end_reason" varchar(64),
	"revoked_by_user_id" varchar(36),
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"read_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_read_delegations_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "ck_gmail_read_delegations_status" CHECK (status IN ('active', 'revoked')),
	CONSTRAINT "ck_gmail_read_delegations_revoked" CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
	CONSTRAINT "ck_gmail_read_delegations_grantee" CHECK (grantee_user_id <> owner_user_id),
	CONSTRAINT "ck_gmail_read_delegations_scope" CHECK (length(btrim(query_scope)) > 0),
	CONSTRAINT "ck_gmail_read_delegations_end_reason" CHECK (end_reason IS NULL OR end_reason ~ '^gmail_[a-z_]{1,58}$'),
	CONSTRAINT "ck_gmail_read_delegations_count" CHECK (read_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "gmail_digests" DROP CONSTRAINT "uq_gmail_digests_proposal";--> statement-breakpoint
ALTER TABLE "gmail_digests" DROP CONSTRAINT "ck_gmail_digests_application";--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" DROP CONSTRAINT "ck_gmail_read_audit_actor_owner";--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" DROP CONSTRAINT "ck_gmail_read_audit_operation";--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" DROP CONSTRAINT "ck_gmail_read_audit_agent_run";--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD COLUMN "notice_session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD COLUMN "delegation_id" varchar(36);--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD CONSTRAINT "gmail_application_shared_results_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "public"."gmail_digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD CONSTRAINT "gmail_application_shared_results_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."gmail_digest_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_delegations" ADD CONSTRAINT "gmail_read_delegations_connection_fkey" FOREIGN KEY ("gmail_connection_id","space_id","owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_delegations" ADD CONSTRAINT "gmail_read_delegations_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_delegations" ADD CONSTRAINT "gmail_read_delegations_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_application_shared_results_delivery" ON "gmail_application_shared_results" USING btree ("delivery_id","recorded_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_application_shared_results_recorded" ON "gmail_application_shared_results" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_read_delegations_grantee" ON "gmail_read_delegations" USING btree ("space_id","grantee_user_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_gmail_read_delegations_owner" ON "gmail_read_delegations" USING btree ("space_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gmail_read_delegations_live" ON "gmail_read_delegations" USING btree ("gmail_connection_id","project_id","grantee_user_id") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "gmail_digests_notice_session_id_fkey" FOREIGN KEY ("notice_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "uq_gmail_digests_proposal_kind" UNIQUE("proposal_id","kind");--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_application" CHECK ((kind = 'application') = (effects IS NOT NULL) AND (kind <> 'application' OR runtime_binding IS NOT NULL) AND (kind = 'application' OR notice_session_id IS NULL));--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_actor_owner" CHECK ((operation = 'delegated_read') = (actor_user_id <> owner_user_id) AND (operation = 'delegated_read') = (delegation_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_operation" CHECK (operation IN ('thread_search', 'thread_read', 'agent_read', 'digest_read', 'delegated_read'));--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_agent_run" CHECK ((operation IN ('agent_read', 'digest_read', 'delegated_read')) = (run_id IS NOT NULL) AND (run_id IS NULL) = (agent_id IS NULL));

RESET search_path;

ALTER TABLE "gmail_application_shared_results" DROP CONSTRAINT "uq_gmail_application_shared_results_fact";--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD COLUMN "posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD COLUMN "posted_delivery_id" varchar(36);--> statement-breakpoint
-- Results of a delivery that already succeeded were posted (or withheld) with it: never posted again.
UPDATE "gmail_application_shared_results" r SET "posted_at"=r."recorded_at","posted_delivery_id"=r."delivery_id"
  FROM "gmail_digest_deliveries" dl WHERE dl."id"=r."delivery_id" AND dl."status"='delivered';--> statement-breakpoint
-- One fact per automation: keep a posted copy, else the earliest.
DELETE FROM "gmail_application_shared_results" a USING "gmail_application_shared_results" b
  WHERE a."digest_id"=b."digest_id" AND a."google_message_id"=b."google_message_id" AND a."application_id"=b."application_id" AND a."effect"=b."effect" AND a."id"<>b."id"
    AND ((b."posted_at" IS NOT NULL AND a."posted_at" IS NULL)
      OR ((b."posted_at" IS NULL) = (a."posted_at" IS NULL) AND (b."recorded_at",b."id") < (a."recorded_at",a."id")));--> statement-breakpoint
CREATE INDEX "ix_gmail_application_shared_results_unposted" ON "gmail_application_shared_results" USING btree ("digest_id","recorded_at") WHERE posted_at IS NULL;--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD CONSTRAINT "uq_gmail_application_shared_results_fact" UNIQUE("digest_id","google_message_id","application_id","effect");--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD CONSTRAINT "ck_gmail_application_shared_results_posted" CHECK ((posted_at IS NULL) = (posted_delivery_id IS NULL));

RESET search_path;

ALTER TABLE "gmail_application_shared_results" ADD COLUMN "notice_session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD COLUMN "rule_version" varchar(36);--> statement-breakpoint
-- A result not yet posted is bound to the card its Run was started for and, when that card is still the one in force,
-- to the conversation it posts into now (a destination changes only with a new card).
UPDATE "gmail_application_shared_results" r SET "rule_version"=run."contract_snapshot_json" #>> '{workflow_input_json,gmail_digest,rule_version}',
    "notice_session_id"=CASE WHEN (run."contract_snapshot_json" #>> '{workflow_input_json,gmail_digest,rule_version}')=d."proposal_id" THEN d."notice_session_id" END
  FROM "gmail_digest_deliveries" dl, "runs" run, "gmail_digests" d
  WHERE r."posted_at" IS NULL AND dl."id"=r."delivery_id" AND run."id"=dl."run_id" AND d."id"=r."digest_id";--> statement-breakpoint
-- One whose card or destination cannot be shown is never posted.
DELETE FROM "gmail_application_shared_results" WHERE "posted_at" IS NULL AND ("notice_session_id" IS NULL OR "rule_version" IS NULL);--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD CONSTRAINT "ck_gmail_application_shared_results_bound" CHECK (posted_at IS NOT NULL OR (notice_session_id IS NOT NULL AND rule_version IS NOT NULL));


RESET search_path;

-- Historical rows retain their posting state. Their original fact ID and deadline kind were not stored.
-- Applications still identifies replays of those facts in its own ledger.
ALTER TABLE "gmail_application_shared_results" DROP CONSTRAINT "uq_gmail_application_shared_results_fact";--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD COLUMN "fact_id" varchar(36);--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD COLUMN "deadline_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "gmail_application_shared_results" ADD CONSTRAINT "uq_gmail_application_shared_results_fact" UNIQUE("digest_id","fact_id");


RESET search_path;

ALTER TABLE "gmail_digests" DROP CONSTRAINT "ck_gmail_digests_effects";--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_effects" CHECK (effects IS NULL OR (jsonb_typeof(effects) = 'array' AND jsonb_array_length(effects) BETWEEN 1 AND 8));

RESET search_path;
