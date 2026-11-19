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
