-- rainver:maintenance
CREATE TABLE "gmail_connections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"google_subject" varchar(255) NOT NULL,
	"mailbox_email" varchar(320) NOT NULL,
	"credential_id" varchar(36),
	"status" varchar(32) NOT NULL,
	"generation" integer NOT NULL,
	"granted_scopes" jsonb NOT NULL,
	"last_error_class" varchar(32),
	"revocation_status" varchar(32) NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_connections_owner_subject" UNIQUE("space_id","owner_user_id","google_subject"),
	CONSTRAINT "uq_gmail_connections_credential" UNIQUE("credential_id"),
	CONSTRAINT "uq_gmail_connections_id_space_owner" UNIQUE("id","space_id","owner_user_id"),
	CONSTRAINT "ck_gmail_connections_status" CHECK (status IN ('active', 'reauth_required', 'disconnected')),
	CONSTRAINT "ck_gmail_connections_credential_status" CHECK ((status = 'active') = (credential_id IS NOT NULL)),
	CONSTRAINT "ck_gmail_connections_generation" CHECK (generation >= 1),
	CONSTRAINT "ck_gmail_connections_scopes" CHECK (jsonb_typeof(granted_scopes) = 'array'),
	CONSTRAINT "ck_gmail_connections_error_class" CHECK (last_error_class IS NULL OR last_error_class IN ('transient', 'invalid_grant', 'scope', 'uncertain')),
	CONSTRAINT "ck_gmail_connections_revocation" CHECK (revocation_status IN ('not_requested', 'pending', 'confirmed', 'failed', 'uncertain')),
	CONSTRAINT "ck_gmail_connections_subject" CHECK (google_subject ~ '^[!-~]{1,255}$')
);
--> statement-breakpoint
CREATE TABLE "gmail_oauth_attempts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"state_sha256" varchar(64) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"reconnect_connection_id" varchar(36),
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_oauth_attempts_state" UNIQUE("state_sha256"),
	CONSTRAINT "ck_gmail_oauth_attempts_state_sha256" CHECK (state_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_oauth_attempts" ADD CONSTRAINT "gmail_oauth_attempts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_oauth_attempts" ADD CONSTRAINT "gmail_oauth_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_oauth_attempts" ADD CONSTRAINT "gmail_oauth_attempts_reconnect_connection_id_fkey" FOREIGN KEY ("reconnect_connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_connections_owner_space" ON "gmail_connections" USING btree ("owner_user_id","space_id");--> statement-breakpoint
CREATE INDEX "ix_gmail_oauth_attempts_user_expires" ON "gmail_oauth_attempts" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_oauth_attempts_expires" ON "gmail_oauth_attempts" USING btree ("expires_at");

RESET search_path;

CREATE TABLE "gmail_revocation_obligations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"connection_id" varchar(36),
	"google_subject" varchar(255) NOT NULL,
	"generation" integer,
	"secret_ref" text,
	"state" varchar(16) NOT NULL,
	"attempts" integer NOT NULL,
	"outcome_uncertain" boolean NOT NULL,
	"lease_until" timestamp with time zone,
	"revoke_window_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_revocation_obligations_connection_generation" UNIQUE("connection_id","generation"),
	CONSTRAINT "ck_gmail_revocation_obligations_state" CHECK (state IN ('pending', 'in_flight', 'settled')),
	CONSTRAINT "ck_gmail_revocation_obligations_lease" CHECK ((state = 'in_flight') = (lease_until IS NOT NULL)),
	CONSTRAINT "ck_gmail_revocation_obligations_secret" CHECK ((state = 'settled') = (secret_ref IS NULL)),
	CONSTRAINT "ck_gmail_revocation_obligations_owed" CHECK (state = 'settled' OR (connection_id IS NOT NULL AND generation IS NOT NULL)),
	CONSTRAINT "ck_gmail_revocation_obligations_attempts" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "gmail_oauth_attempts" ADD COLUMN "reconnect_generation" integer;--> statement-breakpoint
ALTER TABLE "gmail_revocation_obligations" ADD CONSTRAINT "gmail_revocation_obligations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_revocation_obligations" ADD CONSTRAINT "gmail_revocation_obligations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_revocation_obligations_subject" ON "gmail_revocation_obligations" USING btree ("google_subject");--> statement-breakpoint
-- Attempts live 10 minutes; an unbound reconnect attempt from before this migration cannot satisfy the binding.
DELETE FROM "gmail_oauth_attempts" WHERE "reconnect_connection_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_oauth_attempts" ADD CONSTRAINT "ck_gmail_oauth_attempts_reconnect_generation" CHECK ((reconnect_connection_id IS NULL) = (reconnect_generation IS NULL));

RESET search_path;

ALTER TABLE "gmail_revocation_obligations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "gmail_revocation_obligations" CASCADE;--> statement-breakpoint
ALTER TABLE "gmail_connections" DROP CONSTRAINT "ck_gmail_connections_revocation";--> statement-breakpoint
ALTER TABLE "gmail_connections" DROP COLUMN "revocation_status";

RESET search_path;

CREATE TABLE "gmail_project_thread_selections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"gmail_connection_id" varchar(36) NOT NULL,
	"google_thread_id" varchar(64) NOT NULL,
	"read_after" timestamp with time zone,
	"read_before" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_thread_selections_connection_project_thread" UNIQUE("gmail_connection_id","project_id","google_thread_id"),
	CONSTRAINT "ck_gmail_thread_selections_thread_id" CHECK (google_thread_id ~ '^[0-9a-f]{1,64}$'),
	CONSTRAINT "ck_gmail_thread_selections_window" CHECK (read_after IS NULL OR read_before IS NULL OR read_after < read_before)
);
--> statement-breakpoint
CREATE TABLE "gmail_read_audit_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"actor_user_id" varchar(36) NOT NULL,
	"gmail_connection_id" varchar(36),
	"project_id" varchar(36),
	"selection_id" varchar(36),
	"operation" varchar(32) NOT NULL,
	"google_thread_id" varchar(64),
	"item_count" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"request_id" varchar(128) NOT NULL,
	"accessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_gmail_read_audit_actor_owner" CHECK (actor_user_id = owner_user_id),
	CONSTRAINT "ck_gmail_read_audit_operation" CHECK (operation IN ('thread_search', 'thread_read')),
	CONSTRAINT "ck_gmail_read_audit_item_count" CHECK (item_count >= 0),
	CONSTRAINT "ck_gmail_read_audit_thread_id" CHECK (google_thread_id IS NULL OR google_thread_id ~ '^[0-9a-f]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "gmail_project_thread_selections" ADD CONSTRAINT "gmail_thread_selections_connection_fkey" FOREIGN KEY ("gmail_connection_id","space_id","owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_project_thread_selections" ADD CONSTRAINT "gmail_thread_selections_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "gmail_read_audit_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "gmail_read_audit_events_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "gmail_read_audit_events_connection_id_fkey" FOREIGN KEY ("gmail_connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "gmail_read_audit_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "gmail_read_audit_events_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "public"."gmail_project_thread_selections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_thread_selections_owner_project" ON "gmail_project_thread_selections" USING btree ("owner_user_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_gmail_read_audit_owner_accessed" ON "gmail_read_audit_events" USING btree ("owner_user_id","space_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_read_audit_accessed" ON "gmail_read_audit_events" USING btree ("accessed_at");

RESET search_path;

-- rainver:maintenance
-- Work a person's Room turn authorized has no total handoff/turn limit; it is
-- counted and reminded (modules/rooms.md, "Task collaboration"). This one-time
-- conversion rewrites every stored task collaboration the earlier release
-- accepted (its strict finite / reminder union, commit 4c6e23c0) into the
-- single current shape: Task, participants, coordinator, offsets and reminder
-- progress are kept; the mode, finite cap, interim reminder request, stored
-- thresholds and conversion marker are removed. A legacy record without
-- `declared_at` gets its container's creation time, which is exactly the
-- whole-container cancellation rule it had. `collaboration_history` is audit
-- and stays verbatim.
-- Only a record that release accepted is converted: every key must belong to
-- one of its two shapes and hold a value it accepted (non-empty ids, distinct
-- non-empty participants, integer offsets >= 0, a cap of 1..128, its datetime
-- rule for `declared_at`, increasing positive thresholds, literal markers).
-- Anything else, e.g. `max_delegations: 0` or a reminder without thresholds,
-- is left as it is, so it still fails closed. Each check is guarded by CASE
-- on the JSON type, so a value of the wrong type is false, never a cast error.
-- Numbers are judged as that release read them: `JSON.parse` turns the stored
-- decimal into the nearest double (±Infinity from 2^1024 - 2^970 up, ±0 at
-- 2^-1075 and below), then zod checks that double. `j.ns` holds those doubles
-- (NULL for a non-number or an infinity): PostgreSQL's numeric -> float8 cast
-- rounds the same way and is only reached inside those bounds, where it cannot
-- raise out-of-range. So 0.99999999999999999999 is the integer 1, and
-- 9007199254740992 and 9007199254740993 are the same threshold.
-- The running earlier release cannot read the converted records (it would
-- refuse them as invalid), hence the maintenance marker.
WITH legacy AS (
  SELECT g.space_id, g.id, g.created_at, g.budget_json->'collaboration' AS c
    FROM agent_run_groups g
   WHERE jsonb_typeof(g.budget_json->'collaboration') = 'object'
), accepted AS (
  SELECT legacy.* FROM legacy
   WHERE CASE WHEN jsonb_typeof(c) <> 'object' THEN false ELSE
     NOT EXISTS (SELECT 1 FROM jsonb_each(c) f CROSS JOIN LATERAL (SELECT ARRAY(
         SELECT CASE WHEN jsonb_typeof(e.v) <> 'number' THEN NULL
                     WHEN abs(e.v::numeric) >= power(2::numeric, 1024) - power(2::numeric, 970) THEN NULL
                     WHEN abs(e.v::numeric) * power(2::numeric, 1075) <= 1 THEN 0::float8
                     ELSE e.v::numeric::float8 END
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE jsonb_build_array(f.value) END)
                WITH ORDINALITY e(v, i) ORDER BY e.i) AS ns) j
      WHERE NOT CASE
       WHEN f.key IN ('task_id', 'coordinator_agent_id') THEN
         CASE WHEN jsonb_typeof(f.value) = 'string' THEN f.value #>> '{}' <> '' ELSE false END
       WHEN f.key = 'participant_agent_ids' THEN
         CASE WHEN jsonb_typeof(f.value) <> 'array' THEN false
              WHEN jsonb_array_length(f.value) < 1 THEN false
              WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(f.value) p
                            WHERE CASE WHEN jsonb_typeof(p.value) = 'string' THEN p.value #>> '{}' = '' ELSE true END) THEN false
              ELSE (SELECT count(DISTINCT p.value #>> '{}' COLLATE "C") = count(*) FROM jsonb_array_elements(f.value) p) END
       WHEN f.key = 'declared_at' THEN
         -- zod 3 `z.string().datetime({ offset: true })`, ASCII digits.
         CASE WHEN jsonb_typeof(f.value) = 'string' THEN f.value #>> '{}' ~ ('^'
           || '(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29'
           || '|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))'
           || 'T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|([+-][0-9]{2}:?[0-9]{2}))$')
         ELSE false END
       -- `z.number().int()`: a finite whole double.
       WHEN f.key IN ('delegations_offset', 'turns_offset', 'reminder_notified_through') THEN
         CASE WHEN jsonb_typeof(f.value) = 'number' AND j.ns[1] IS NOT NULL
           THEN j.ns[1] = trunc(j.ns[1]) AND j.ns[1] >= 0 ELSE false END
       WHEN f.key IN ('max_delegations', 'converted_from_max_delegations') THEN
         CASE WHEN jsonb_typeof(f.value) = 'number' AND j.ns[1] IS NOT NULL
           THEN j.ns[1] = trunc(j.ns[1]) AND j.ns[1] BETWEEN 1 AND 128 ELSE false END
       WHEN f.key = 'reminder_requested' THEN f.value = 'true'::jsonb
       WHEN f.key = 'mode' THEN f.value = '"reminder"'::jsonb
       WHEN f.key = 'reminder_thresholds' THEN
         CASE WHEN jsonb_typeof(f.value) <> 'array' THEN false
              WHEN jsonb_array_length(f.value) NOT BETWEEN 1 AND 8 THEN false
              ELSE NOT EXISTS (SELECT 1 FROM generate_subscripts(j.ns, 1) k
                                WHERE CASE WHEN j.ns[k] IS NULL THEN true
                                           ELSE j.ns[k] <> trunc(j.ns[k]) OR j.ns[k] <= 0 OR (k > 1 AND j.ns[k] <= j.ns[k - 1]) END) END
       ELSE false END)
     AND c ? 'task_id' AND c ? 'participant_agent_ids' AND c ? 'coordinator_agent_id'
     -- finite: a cap and only finite keys; reminder: mode and thresholds and only reminder keys.
     AND ((c ? 'max_delegations'
           AND NOT c ?| ARRAY['mode', 'reminder_thresholds', 'reminder_notified_through', 'converted_from_max_delegations'])
       OR (c ? 'mode' AND c ? 'reminder_thresholds' AND NOT c ?| ARRAY['max_delegations', 'reminder_requested']))
   END
)
UPDATE agent_run_groups g
   SET budget_json = jsonb_set(g.budget_json, '{collaboration}', jsonb_build_object(
         'task_id', a.c->'task_id',
         'participant_agent_ids', a.c->'participant_agent_ids',
         'coordinator_agent_id', a.c->'coordinator_agent_id',
         'delegations_offset', COALESCE(a.c->'delegations_offset', '0'::jsonb),
         'turns_offset', COALESCE(a.c->'turns_offset', '0'::jsonb),
         'declared_at', COALESCE(a.c->'declared_at', to_jsonb(to_json(a.created_at)#>>'{}')),
         'reminder_notified_through', COALESCE(a.c->'reminder_notified_through', '0'::jsonb)))
  FROM accepted a
 WHERE g.space_id = a.space_id AND g.id = a.id;
--> statement-breakpoint
-- A container rooted in a person's own Room turn no longer has a soft budget
-- for its own temporary delegation: its one-time soft-notice flag is removed
-- (the posted notice stays). A discussion keeps its bounds and its notice, so
-- a container any discussion group charges keeps the flag
-- (rooms/delegationBudget.ts, `roomBudgetContainer`).
UPDATE agent_run_groups g
   SET budget_json = g.budget_json - 'soft_budget_notified'
 WHERE g.budget_json ? 'soft_budget_notified'
   AND EXISTS (SELECT 1 FROM runs r WHERE r.space_id = g.space_id AND r.id = g.root_run_id
     AND r.trigger_origin = 'manual' AND r.parent_run_id IS NULL)
   AND NOT EXISTS (SELECT 1 FROM agent_run_groups d WHERE d.space_id = g.space_id AND d.discussion_id IS NOT NULL
     AND COALESCE(d.budget_json->>'container_group_id', d.id) = g.id);


RESET search_path;

CREATE TABLE "agent_data_read_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"agent_id" varchar(36),
	"action_id" varchar(128) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_ids_json" jsonb NOT NULL,
	"data_class" varchar(16) NOT NULL,
	"grant_id" varchar(36),
	"accessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_agent_data_read_logs_class" CHECK (data_class IN ('non_sensitive', 'personal', 'sensitive')),
	CONSTRAINT "ck_agent_data_read_logs_ids" CHECK (jsonb_typeof(resource_ids_json) = 'array' AND jsonb_array_length(resource_ids_json) <= 100)
);
--> statement-breakpoint
CREATE TABLE "plugin_data_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"plugin_id" varchar(24) NOT NULL,
	"toolset" varchar(8) NOT NULL,
	"data_class" varchar(16) NOT NULL,
	"scope" varchar(16) NOT NULL,
	"data_owner_user_id" varchar(36),
	"granted_by_user_id" varchar(36) NOT NULL,
	"target_run_id" varchar(36),
	"plugin_version" varchar(32) NOT NULL,
	"authority_hash" varchar(64) NOT NULL,
	"expanded_json" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_plugin_data_grants_toolset" CHECK (toolset IN ('read', 'write')),
	CONSTRAINT "ck_plugin_data_grants_status" CHECK (status IN ('active', 'revoked', 'expired')),
	CONSTRAINT "ck_plugin_data_grants_shape" CHECK ((data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))),
	CONSTRAINT "ck_plugin_data_grants_revoked" CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "authorization_requests" DROP CONSTRAINT "ck_authorization_requests_decision";--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "request_kind" varchar(16) DEFAULT 'action_grant' NOT NULL;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "resulting_plugin_data_grant_id" varchar(36);--> statement-breakpoint
ALTER TABLE "agent_data_read_logs" ADD CONSTRAINT "agent_data_read_logs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_data_read_logs" ADD CONSTRAINT "agent_data_read_logs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_data_read_logs" ADD CONSTRAINT "agent_data_read_logs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_data_owner_user_id_fkey" FOREIGN KEY ("data_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_target_run_fkey" FOREIGN KEY ("target_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_agent_data_read_logs_owner" ON "agent_data_read_logs" USING btree ("space_id","owner_user_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_agent_data_read_logs_run" ON "agent_data_read_logs" USING btree ("space_id","run_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_plugin_data_grants_owner" ON "plugin_data_grants" USING btree ("space_id","data_owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_plugin_data_grants_run" ON "plugin_data_grants" USING btree ("space_id","target_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plugin_data_grants_active" ON "plugin_data_grants" USING btree ("space_id","plugin_id","toolset","data_class","scope",COALESCE("target_run_id", ''),COALESCE("data_owner_user_id", '')) WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_resulting_plugin_data_grant_fkey" FOREIGN KEY ("resulting_plugin_data_grant_id") REFERENCES "public"."plugin_data_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "ck_authorization_requests_kind" CHECK ("authorization_requests"."request_kind" IN ('action_grant', 'plugin_data'));--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "ck_authorization_requests_decision" CHECK (("authorization_requests"."status" = 'pending' AND "authorization_requests"."decided_by_user_id" IS NULL AND "authorization_requests"."decided_at" IS NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."status" = 'rejected' AND "authorization_requests"."decided_by_user_id" IS NOT NULL AND "authorization_requests"."decided_at" IS NOT NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."status" = 'approved' AND "authorization_requests"."decided_by_user_id" IS NOT NULL AND "authorization_requests"."decided_at" IS NOT NULL AND (("authorization_requests"."request_kind" = 'action_grant' AND "authorization_requests"."resulting_action_grant_id" IS NOT NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."request_kind" = 'plugin_data' AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NOT NULL))));

RESET search_path;

ALTER TABLE "run_attempts" ADD COLUMN "launch_isolation_json" jsonb;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "ck_run_attempts_launch_isolation" CHECK (launch_isolation_json IS NULL OR (launch_id IS NOT NULL AND launch_isolation_json->>'launch_id' = launch_id));

RESET search_path;

CREATE TABLE "gmail_mailbox_sync_states" (
	"gmail_connection_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"history_id" varchar(32),
	"state" varchar(16) NOT NULL,
	"recovery_after" timestamp with time zone,
	"recovery_partial" boolean NOT NULL,
	"lease_id" varchar(36),
	"lease_until" timestamp with time zone,
	"sync_requested_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"failure_count" integer NOT NULL,
	"last_error_code" varchar(64),
	"watch_expires_at" timestamp with time zone,
	"watch_checked_at" timestamp with time zone,
	"last_push_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_gmail_mailbox_sync_state" CHECK (state IN ('baseline', 'ok', 'recovering')),
	CONSTRAINT "ck_gmail_mailbox_sync_history_id" CHECK (history_id IS NULL OR history_id ~ '^[0-9]{1,20}$'),
	CONSTRAINT "ck_gmail_mailbox_sync_cursor" CHECK (state = 'baseline' OR history_id IS NOT NULL),
	CONSTRAINT "ck_gmail_mailbox_sync_recovery" CHECK ((state = 'recovering') = (recovery_after IS NOT NULL)),
	CONSTRAINT "ck_gmail_mailbox_sync_lease" CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
	CONSTRAINT "ck_gmail_mailbox_sync_failures" CHECK (failure_count >= 0),
	CONSTRAINT "ck_gmail_mailbox_sync_error_code" CHECK (last_error_code IS NULL OR last_error_code ~ '^gmail_[a-z_]{1,58}$')
);
--> statement-breakpoint
CREATE TABLE "gmail_monitor_matches" (
	"rule_id" varchar(36) NOT NULL,
	"google_message_id" varchar(64) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"matched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gmail_monitor_matches_pkey" PRIMARY KEY("rule_id","google_message_id"),
	CONSTRAINT "ck_gmail_monitor_matches_message_id" CHECK (google_message_id ~ '^[0-9a-f]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "gmail_monitor_rules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"gmail_connection_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"purpose" varchar(280) NOT NULL,
	"criteria" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"active_since" timestamp with time zone NOT NULL,
	"proposal_id" varchar(36),
	"match_count" integer NOT NULL,
	"last_matched_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_monitor_rules_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "ck_gmail_monitor_rules_status" CHECK (status IN ('active', 'paused')),
	CONSTRAINT "ck_gmail_monitor_rules_criteria" CHECK (jsonb_typeof(criteria) = 'object'),
	CONSTRAINT "ck_gmail_monitor_rules_match_count" CHECK (match_count >= 0),
	CONSTRAINT "ck_gmail_monitor_rules_purpose" CHECK (length(btrim(purpose)) > 0)
);
--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD CONSTRAINT "gmail_mailbox_sync_states_connection_fkey" FOREIGN KEY ("gmail_connection_id","space_id","owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_monitor_matches" ADD CONSTRAINT "gmail_monitor_matches_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."gmail_monitor_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_monitor_rules" ADD CONSTRAINT "gmail_monitor_rules_connection_fkey" FOREIGN KEY ("gmail_connection_id","space_id","owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_monitor_rules" ADD CONSTRAINT "gmail_monitor_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_mailbox_sync_due" ON "gmail_mailbox_sync_states" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_monitor_matches_owner_matched" ON "gmail_monitor_matches" USING btree ("owner_user_id","space_id","matched_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_monitor_matches_matched" ON "gmail_monitor_matches" USING btree ("matched_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_monitor_rules_owner_space" ON "gmail_monitor_rules" USING btree ("owner_user_id","space_id");--> statement-breakpoint
CREATE INDEX "ix_gmail_monitor_rules_connection_status" ON "gmail_monitor_rules" USING btree ("gmail_connection_id","status");

RESET search_path;

ALTER TABLE "gmail_mailbox_sync_states" ADD COLUMN "record_history_id" varchar(32);--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD COLUMN "record_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD COLUMN "retry_not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD COLUMN "watch_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD COLUMN "watch_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD COLUMN "watch_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD CONSTRAINT "ck_gmail_mailbox_sync_record" CHECK ((record_history_id IS NULL AND record_offset = 0) OR (record_history_id ~ '^[0-9]{1,20}$' AND record_offset > 0));--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD CONSTRAINT "ck_gmail_mailbox_sync_watch_error_code" CHECK (watch_error_code IS NULL OR watch_error_code ~ '^gmail_[a-z_]{1,58}$');--> statement-breakpoint
ALTER TABLE "gmail_mailbox_sync_states" ADD CONSTRAINT "ck_gmail_mailbox_sync_watch_failures" CHECK (watch_failure_count >= 0);

RESET search_path;

CREATE TABLE "official_plugin_project_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"plugin_id" varchar(128) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"status" varchar(16) NOT NULL,
	"bound_by_user_id" varchar(36),
	"bound_at" timestamp with time zone,
	"unbound_by_user_id" varchar(36),
	"unbound_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "official_plugin_project_bindings_status" CHECK ((status)::text = ANY (ARRAY['bound'::text, 'unbound'::text])),
	CONSTRAINT "official_plugin_project_bindings_plugin_id_non_empty" CHECK ((plugin_id)::text <> ''::text)
);
--> statement-breakpoint
ALTER TABLE "official_plugin_project_bindings" ADD CONSTRAINT "official_plugin_project_bindings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_plugin_project_bindings" ADD CONSTRAINT "official_plugin_project_bindings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "official_plugin_project_bindings_plugin_project" ON "official_plugin_project_bindings" USING btree ("plugin_id","project_id");--> statement-breakpoint
CREATE INDEX "official_plugin_project_bindings_space_project_idx" ON "official_plugin_project_bindings" USING btree ("space_id","project_id");

RESET search_path;

ALTER TABLE "proposals" ADD COLUMN "operation_request_linked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill the durable origin marker. A retained request row is direct evidence; a pruned one
-- leaves the payload that only `approval.create` for a plugin operation mapping writes
-- (exactly proposal_type/input/requester, matching the row's type). Legacy host appliers
-- (finance_ledger) never write a requester, so their receipts keep their original semantics.
UPDATE "proposals" p SET "operation_request_linked" = true
WHERE EXISTS (SELECT 1 FROM "operation_idempotency" r WHERE r."proposal_id" = p."id" AND r."space_id" = p."space_id")
   OR (jsonb_typeof(p."payload_json") = 'object'
       AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p."payload_json") k) = ARRAY['input','proposal_type','requester']
       AND p."payload_json"->>'proposal_type' = p."proposal_type"
       AND jsonb_typeof(p."payload_json"->'requester') = 'object');


RESET search_path;

ALTER TABLE "gmail_read_audit_events" DROP CONSTRAINT "ck_gmail_read_audit_operation";--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD COLUMN "agent_read_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD COLUMN "run_id" varchar(36);--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD COLUMN "agent_id" varchar(36);--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_agent_run" CHECK ((operation = 'agent_read') = (run_id IS NOT NULL) AND (run_id IS NULL) = (agent_id IS NULL));--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_operation" CHECK (operation IN ('thread_search', 'thread_read', 'agent_read'));

RESET search_path;

ALTER TABLE "host_threads" ADD COLUMN "vendor_session_launch_id" varchar(36);

RESET search_path;

ALTER TABLE "plugin_data_grants" DROP CONSTRAINT "ck_plugin_data_grants_shape";--> statement-breakpoint
DROP INDEX "uq_plugin_data_grants_active";--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "project_id" varchar(36);--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "connection_id" varchar(36);--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "connection_generation" integer;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD COLUMN "purpose" varchar(32);--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "plugin_data_grants_connection_fkey" FOREIGN KEY ("connection_id","space_id","data_owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_plugin_data_grants_connection" ON "plugin_data_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plugin_data_grants_active" ON "plugin_data_grants" USING btree ("space_id","plugin_id","toolset","data_class","scope",COALESCE("target_run_id", ''),COALESCE("data_owner_user_id", ''),COALESCE("project_id", ''),COALESCE("connection_id", ''),COALESCE("purpose", '')) WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_binding" CHECK (scope = 'project' OR (project_id IS NULL AND connection_id IS NULL AND connection_generation IS NULL AND purpose IS NULL));--> statement-breakpoint
-- ADR 0033: a core data tool keeps no per-Run consent. Still-active earlier per-Run Gmail consents end here (kept as history, never reactivated).
UPDATE "plugin_data_grants" SET "status" = 'expired', "updated_at" = now() WHERE "plugin_id" LIKE 'core:%' AND "scope" <> 'project' AND "status" = 'active';--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_core_scope" CHECK (status <> 'active' OR plugin_id NOT LIKE 'core:%' OR scope = 'project');--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_shape" CHECK ((data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))
		OR (data_class = 'sensitive' AND scope = 'project' AND data_owner_user_id = granted_by_user_id AND toolset = 'read' AND target_run_id IS NULL
			AND plugin_id LIKE 'core:%' AND project_id IS NOT NULL AND connection_id IS NOT NULL AND connection_generation >= 1 AND purpose = 'on_demand_read'));

RESET search_path;

-- ADR 0033: Gmail consent requests freeze owner/Project/connection/generation/purpose; the grant shape refuses NULL holes (a NULL comparison would let an OR branch pass as unknown).
ALTER TABLE "plugin_data_grants" DROP CONSTRAINT "ck_plugin_data_grants_shape";--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "consent_owner_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "consent_project_id" varchar(36);--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "consent_connection_id" varchar(36);--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "consent_connection_generation" integer;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD COLUMN "consent_purpose" varchar(32);--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "ck_authorization_requests_consent_binding" CHECK (("authorization_requests"."consent_owner_user_id" IS NULL AND "authorization_requests"."consent_project_id" IS NULL AND "authorization_requests"."consent_connection_id" IS NULL AND "authorization_requests"."consent_connection_generation" IS NULL AND "authorization_requests"."consent_purpose" IS NULL)
    OR ("authorization_requests"."request_kind" = 'plugin_data' AND "authorization_requests"."consent_owner_user_id" IS NOT NULL AND "authorization_requests"."consent_owner_user_id" = "authorization_requests"."instructed_by_user_id"
      AND "authorization_requests"."consent_project_id" IS NOT NULL AND "authorization_requests"."consent_connection_id" IS NOT NULL AND "authorization_requests"."consent_connection_generation" IS NOT NULL
      AND "authorization_requests"."consent_connection_generation" >= 1 AND "authorization_requests"."consent_purpose" IS NOT NULL AND "authorization_requests"."consent_purpose" = 'on_demand_read'));--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_shape" CHECK ((data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))
		OR (data_class = 'sensitive' AND scope = 'project' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND toolset = 'read'
			AND target_run_id IS NULL AND expires_at IS NULL AND plugin_id LIKE 'core:%' AND project_id IS NOT NULL AND connection_id IS NOT NULL
			AND connection_generation IS NOT NULL AND connection_generation >= 1 AND purpose IS NOT NULL AND purpose = 'on_demand_read'));

RESET search_path;

-- ADR 0033: a Project consent's connection is a snapshot (forgetting a connection keeps ended consents and approved requests as evidence; live checks join the current connection), and a pending core consent request can end (`expired`) when what it would allow goes away.
ALTER TABLE "authorization_requests" DROP CONSTRAINT "ck_authorization_requests_status";--> statement-breakpoint
ALTER TABLE "authorization_requests" DROP CONSTRAINT "ck_authorization_requests_decision";--> statement-breakpoint
ALTER TABLE "plugin_data_grants" DROP CONSTRAINT "plugin_data_grants_connection_fkey";
--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "ck_authorization_requests_status" CHECK ("authorization_requests"."status" IN ('pending', 'approved', 'rejected', 'expired'));--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "ck_authorization_requests_decision" CHECK (("authorization_requests"."status" = 'pending' AND "authorization_requests"."decided_by_user_id" IS NULL AND "authorization_requests"."decided_at" IS NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."status" = 'rejected' AND "authorization_requests"."decided_by_user_id" IS NOT NULL AND "authorization_requests"."decided_at" IS NOT NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."status" = 'expired' AND "authorization_requests"."decided_by_user_id" IS NULL AND "authorization_requests"."decided_at" IS NOT NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."status" = 'approved' AND "authorization_requests"."decided_by_user_id" IS NOT NULL AND "authorization_requests"."decided_at" IS NOT NULL AND (("authorization_requests"."request_kind" = 'action_grant' AND "authorization_requests"."resulting_action_grant_id" IS NOT NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NULL) OR ("authorization_requests"."request_kind" = 'plugin_data' AND "authorization_requests"."resulting_action_grant_id" IS NULL AND "authorization_requests"."resulting_plugin_data_grant_id" IS NOT NULL))));

RESET search_path;

-- ADR 0033 phase B: the owner's scheduled private Gmail digests (daily window, monitor matches), their delivery ledger and once-per-digest item dedupe; a digest consent is a `project` consent of `core:gmail_digest` with purpose `daily_digest`/`rule_digest`; digest reads are audited as `digest_read`.
CREATE TABLE "gmail_digest_deliveries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"digest_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"gap_before" boolean NOT NULL,
	"message_ids" jsonb,
	"run_id" varchar(36),
	"status" varchar(16) NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"read_complete" boolean DEFAULT false NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_gmail_digest_deliveries_status" CHECK (status IN ('running', 'delivered', 'failed')),
	CONSTRAINT "ck_gmail_digest_deliveries_window" CHECK (window_start <= window_end),
	CONSTRAINT "ck_gmail_digest_deliveries_ids" CHECK (message_ids IS NULL OR jsonb_typeof(message_ids) = 'array'),
	CONSTRAINT "ck_gmail_digest_deliveries_finished" CHECK ((status = 'running') = (finished_at IS NULL)),
	CONSTRAINT "ck_gmail_digest_deliveries_count" CHECK (message_count >= 0),
	CONSTRAINT "ck_gmail_digest_deliveries_error_code" CHECK (error_code IS NULL OR error_code ~ '^gmail_[a-z_]{1,58}$')
);
--> statement-breakpoint
CREATE TABLE "gmail_digest_items" (
	"digest_id" varchar(36) NOT NULL,
	"google_message_id" varchar(64) NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gmail_digest_items_pkey" PRIMARY KEY("digest_id","google_message_id"),
	CONSTRAINT "ck_gmail_digest_items_message_id" CHECK (google_message_id ~ '^[0-9a-f]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "gmail_digests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"gmail_connection_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"grant_id" varchar(36),
	"proposal_id" varchar(36) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"local_time" varchar(5) NOT NULL,
	"time_zone" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"covered_until" timestamp with time zone NOT NULL,
	"next_run_at" timestamp with time zone,
	"retry_not_before" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(64),
	"last_delivered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_gmail_digests_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "ck_gmail_digests_kind" CHECK (kind IN ('daily', 'rule')),
	CONSTRAINT "ck_gmail_digests_status" CHECK (status IN ('active', 'paused', 'ended')),
	CONSTRAINT "ck_gmail_digests_ended" CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
	CONSTRAINT "ck_gmail_digests_local_time" CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "ck_gmail_digests_failures" CHECK (failure_count >= 0),
	CONSTRAINT "ck_gmail_digests_error_code" CHECK (last_error_code IS NULL OR last_error_code ~ '^gmail_[a-z_]{1,58}$')
);
--> statement-breakpoint
ALTER TABLE "plugin_data_grants" DROP CONSTRAINT "ck_plugin_data_grants_shape";--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" DROP CONSTRAINT "ck_gmail_read_audit_operation";--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" DROP CONSTRAINT "ck_gmail_read_audit_agent_run";--> statement-breakpoint
ALTER TABLE "gmail_digest_deliveries" ADD CONSTRAINT "gmail_digest_deliveries_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "public"."gmail_digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digest_deliveries" ADD CONSTRAINT "gmail_digest_deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digest_items" ADD CONSTRAINT "gmail_digest_items_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "public"."gmail_digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "gmail_digests_connection_fkey" FOREIGN KEY ("gmail_connection_id","space_id","owner_user_id") REFERENCES "public"."gmail_connections"("id","space_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "gmail_digests_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "gmail_digests_session_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "gmail_digests_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_digest_deliveries_digest" ON "gmail_digest_deliveries" USING btree ("digest_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_digest_deliveries_run" ON "gmail_digest_deliveries" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gmail_digest_deliveries_running" ON "gmail_digest_deliveries" USING btree ("digest_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "ix_gmail_digest_items_delivered" ON "gmail_digest_items" USING btree ("delivered_at");--> statement-breakpoint
CREATE INDEX "ix_gmail_digests_owner_space" ON "gmail_digests" USING btree ("owner_user_id","space_id");--> statement-breakpoint
CREATE INDEX "ix_gmail_digests_due" ON "gmail_digests" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gmail_digests_live" ON "gmail_digests" USING btree ("gmail_connection_id","project_id","kind") WHERE status <> 'ended';--> statement-breakpoint
ALTER TABLE "plugin_data_grants" ADD CONSTRAINT "ck_plugin_data_grants_shape" CHECK ((data_class = 'personal' AND scope = 'space' AND data_owner_user_id IS NULL AND target_run_id IS NULL)
		OR (data_class = 'sensitive' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND expires_at IS NOT NULL
			AND ((scope = 'run' AND target_run_id IS NOT NULL) OR (scope = 'background' AND target_run_id IS NULL AND toolset = 'read')))
		OR (data_class = 'sensitive' AND scope = 'project' AND data_owner_user_id IS NOT NULL AND data_owner_user_id = granted_by_user_id AND toolset = 'read'
			AND target_run_id IS NULL AND expires_at IS NULL AND plugin_id LIKE 'core:%' AND project_id IS NOT NULL AND connection_id IS NOT NULL
			AND connection_generation IS NOT NULL AND connection_generation >= 1 AND purpose IS NOT NULL AND purpose IN ('on_demand_read', 'daily_digest', 'rule_digest')));--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_operation" CHECK (operation IN ('thread_search', 'thread_read', 'agent_read', 'digest_read'));--> statement-breakpoint
ALTER TABLE "gmail_read_audit_events" ADD CONSTRAINT "ck_gmail_read_audit_agent_run" CHECK ((operation IN ('agent_read', 'digest_read')) = (run_id IS NOT NULL) AND (run_id IS NULL) = (agent_id IS NULL));

RESET search_path;

ALTER TABLE "gmail_digests" DROP CONSTRAINT "ck_gmail_digests_local_time";--> statement-breakpoint
ALTER TABLE "gmail_digests" ALTER COLUMN "local_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_digests" ALTER COLUMN "time_zone" DROP NOT NULL;--> statement-breakpoint
-- A daily schedule does not authorize immediate delivery. Keep those decisions
-- as history and require fresh consent for the new trigger.
UPDATE "plugin_data_grants" g SET "status"='revoked', "revoked_at"=now(), "updated_at"=now()
 WHERE g."status"='active' AND EXISTS (SELECT 1 FROM "gmail_digests" d WHERE d."grant_id"=g."id" AND d."kind"='rule');--> statement-breakpoint
UPDATE "gmail_digest_deliveries" dl SET "status"='failed', "error_code"='gmail_digest_unavailable', "finished_at"=now()
 WHERE dl."status"='running' AND EXISTS (SELECT 1 FROM "gmail_digests" d WHERE d."id"=dl."digest_id" AND d."kind"='rule');--> statement-breakpoint
UPDATE "gmail_digests" SET "local_time"=NULL, "time_zone"=NULL, "next_run_at"=NULL, "status"='ended',
  "ended_at"=COALESCE("ended_at",now()), "updated_at"=now() WHERE "kind"='rule';--> statement-breakpoint
UPDATE "proposals" SET "expires_at"=LEAST("expires_at", now())
 WHERE "proposal_type"='gmail_digest_create' AND "status"='pending' AND "payload_json"->>'kind'='rule';--> statement-breakpoint
ALTER TABLE "gmail_digests" ADD CONSTRAINT "ck_gmail_digests_local_time" CHECK ((kind = 'daily' AND local_time IS NOT NULL AND time_zone IS NOT NULL AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') OR (kind = 'rule' AND local_time IS NULL AND time_zone IS NULL));

RESET search_path;

CREATE TABLE "gmail_private_checks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"gmail_connection_id" varchar(36) NOT NULL,
	"connection_generation" integer NOT NULL,
	"source_session_id" varchar(36) NOT NULL,
	"source_message_id" varchar(36) NOT NULL,
	"source_run_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"grant_id" varchar(36),
	"run_id" varchar(36),
	"status" varchar(24) NOT NULL,
	"result_text" text,
	"error_code" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_gmail_private_checks_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "uq_gmail_private_checks_source_run" UNIQUE("source_run_id"),
	CONSTRAINT "uq_gmail_private_checks_run" UNIQUE("run_id"),
	CONSTRAINT "ck_gmail_private_checks_status" CHECK (status IN ('awaiting_consent', 'running', 'delivered', 'failed', 'declined')),
	CONSTRAINT "ck_gmail_private_checks_result" CHECK ((status = 'delivered') = (result_text IS NOT NULL)),
	CONSTRAINT "ck_gmail_private_checks_started" CHECK (run_id IS NULL OR started_at IS NOT NULL),
	CONSTRAINT "ck_gmail_private_checks_finished" CHECK ((status IN ('delivered', 'failed', 'declined')) = (finished_at IS NOT NULL)),
	CONSTRAINT "ck_gmail_private_checks_generation" CHECK (connection_generation >= 1),
	CONSTRAINT "ck_gmail_private_checks_error_code" CHECK (error_code IS NULL OR error_code ~ '^gmail_[a-z_]{1,58}$')
);
--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_message_fkey" FOREIGN KEY ("source_message_id","space_id","source_session_id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_private_checks" ADD CONSTRAINT "gmail_private_checks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_gmail_private_checks_owner_space" ON "gmail_private_checks" USING btree ("owner_user_id","space_id");--> statement-breakpoint
CREATE INDEX "ix_gmail_private_checks_running" ON "gmail_private_checks" USING btree ("status") WHERE status = 'running';--> statement-breakpoint
-- ADR 0033 §6: withdrawn hand-off cards are history only. Any still pending is closed so no
-- decision entry (conversation card, Proposal list or detail, direct proposal API) offers it.
UPDATE "proposals" SET "status" = 'superseded', "updated_at" = now() WHERE "proposal_type" = 'gmail_private_read' AND "status" = 'pending';


RESET search_path;

-- ADR 0033 §6 (amended 2026-11-19): the in-place private Gmail check is withdrawn. Gmail is read in the
-- conversation itself, on its own runtime, under the owner's standing Project consent. Its owner-only cards
-- are history: any still pending is closed so no decision entry offers it, and every check not finished
-- ends failed with a fixed code and no text. Delivered checks and their audit rows are kept as they are; no
-- route reads them any more. A Run such a check started is refused before dispatch and at launch.
UPDATE "proposals" SET "status" = 'superseded', "updated_at" = now() WHERE "proposal_type" = 'gmail_private_check' AND "status" = 'pending';
--> statement-breakpoint
UPDATE "gmail_private_checks" SET "status" = 'failed', "error_code" = 'gmail_private_check_withdrawn', "result_text" = NULL, "finished_at" = now()
 WHERE "status" IN ('awaiting_consent', 'running');


RESET search_path;

-- ADR 0033 §6 (amended 2026-11-19) widened what a Gmail consent admits: every ordinary conversation of its
-- Project (a Room and the mainline as well as the owner's private conversation), on that conversation's own
-- CLI, Host and model instead of an isolated launch, and digests delivered into a Room or the mainline. A
-- consent the owner gave under the earlier private, isolated scope is not silently widened to that: this
-- cutover ends every consent and every pending card made before it, keeps their history, and keeps each
-- digest's schedule paused until the owner confirms it again under the new scope in its own conversation
-- (`gmail_digest_reconfirm_required`; the confirmation reactivates the same digest with its history).
-- Ordinary conversations, their messages and Runs are not touched.
--
-- 1. Standing on-demand and digest consents end as revoked history (decided by nobody).
UPDATE "plugin_data_grants" SET "status" = 'revoked', "revoked_at" = now(), "updated_at" = now()
 WHERE "plugin_id" IN ('core:gmail', 'core:gmail_digest') AND "status" = 'active';
--> statement-breakpoint
-- 2. A pending in-conversation Gmail consent card ends as `expired`, decided by nobody, and its waiting Run is
--    cancelled by the ordinary reconcile job, as every other writer that ends such a card does
--    (`endPendingCoreConsentRequests`). Nothing revives it; the next read asks again in place.
WITH ended AS (
  UPDATE "authorization_requests" SET "status" = 'expired', "decided_at" = now()
   WHERE "status" = 'pending' AND "request_kind" = 'plugin_data'
     AND "action_id" IN ('source.gmail.mail.read', 'source.gmail.digest.read')
  RETURNING "id", "space_id", "run_id", "agent_id", "instructed_by_user_id"
)
INSERT INTO "jobs" ("id", "space_id", "user_id", "project_folder_id", "agent_id", "job_type", "status", "priority",
  "payload_json", "attempts", "max_attempts", "scheduled_at", "created_at", "updated_at")
SELECT gen_random_uuid()::text, e."space_id", e."instructed_by_user_id", NULL, e."agent_id", 'authorization_request_reconcile', 'pending', 0,
  jsonb_build_object('authorization_request_id', e."id", 'run_id', e."run_id"), 0, 900, now(), now(), now()
  FROM ended e;
--> statement-breakpoint
-- 3. A pending digest confirmation card drafted under the earlier scope is closed; it is never decided.
UPDATE "proposals" SET "status" = 'superseded', "updated_at" = now()
 WHERE "proposal_type" = 'gmail_digest_create' AND "status" = 'pending';
--> statement-breakpoint
-- 4. An unfinished delivery stops with the consent it ran under.
UPDATE "gmail_digest_deliveries" SET "status" = 'failed', "error_code" = 'gmail_digest_unavailable', "finished_at" = now()
 WHERE "status" = 'running';
--> statement-breakpoint
-- 5. Each live digest keeps its mailbox, Project, conversation, Agent, kind, time and time zone and its delivery
--    history, but is paused until the owner confirms it again; nothing is scheduled meanwhile.
UPDATE "gmail_digests" SET "status" = 'paused', "next_run_at" = NULL, "retry_not_before" = NULL,
  "last_error_code" = 'gmail_digest_reconfirm_required', "updated_at" = now()
 WHERE "status" <> 'ended';


RESET search_path;
