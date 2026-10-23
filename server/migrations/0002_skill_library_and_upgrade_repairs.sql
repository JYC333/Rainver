CREATE TABLE "skill_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"skill_package_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"agent_id" varchar(36),
	"user_id" varchar(36),
	"enabled" boolean NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_skill_bindings_single_scope" CHECK (num_nonnulls(project_id, agent_id, user_id) <= 1)
);
--> statement-breakpoint
ALTER TABLE "message_input_parts" DROP CONSTRAINT "ck_message_input_parts_kind";--> statement-breakpoint
ALTER TABLE "message_input_parts" DROP CONSTRAINT "ck_message_input_parts_reference";--> statement-breakpoint
ALTER TABLE "skill_package_files" ADD COLUMN "content_base64" text;--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD COLUMN "skill_package_id" varchar(36);--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "uq_skill_packages_id_space" UNIQUE("id","space_id");--> statement-breakpoint
ALTER TABLE "skill_bindings" ADD CONSTRAINT "skill_bindings_skill_package_id_space_id_skill_packages_id_space_id_fk" FOREIGN KEY ("skill_package_id","space_id") REFERENCES "public"."skill_packages"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_bindings" ADD CONSTRAINT "skill_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_bindings" ADD CONSTRAINT "skill_bindings_project_id_space_id_projects_id_space_id_fk" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_bindings" ADD CONSTRAINT "skill_bindings_agent_id_space_id_agents_id_space_id_fk" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_bindings" ADD CONSTRAINT "skill_bindings_space_id_user_id_space_memberships_space_id_user_id_fk" FOREIGN KEY ("space_id","user_id") REFERENCES "public"."space_memberships"("space_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_bindings" ADD CONSTRAINT "skill_bindings_proposal_id_space_id_proposals_id_space_id_fk" FOREIGN KEY ("proposal_id","space_id") REFERENCES "public"."proposals"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_bindings_scope" ON "skill_bindings" USING btree ("space_id","skill_package_id",COALESCE(project_id, ''),COALESCE(agent_id, ''),COALESCE(user_id, ''));--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "message_input_parts_skill_scope_fkey" FOREIGN KEY ("skill_package_id","space_id") REFERENCES "public"."skill_packages"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "ck_message_input_parts_skill" CHECK ((kind = 'skill') = (skill_package_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "ck_message_input_parts_kind" CHECK (kind IN ('image', 'file_reference', 'input_resource', 'skill'));--> statement-breakpoint
ALTER TABLE "message_input_parts" ADD CONSTRAINT "ck_message_input_parts_reference" CHECK (
    (kind = 'skill' AND media_id IS NULL AND file_snapshot_id IS NULL AND resource_id IS NULL
      AND project_folder_id IS NULL AND workspace_location_id IS NULL AND relative_path IS NULL)
    OR
    (kind = 'image'
      AND media_id IS NOT NULL
      AND file_snapshot_id IS NULL
      AND resource_id IS NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
    OR (kind = 'file_reference'
      AND media_id IS NULL
      AND file_snapshot_id IS NOT NULL
      AND resource_id IS NULL
      AND project_folder_id IS NOT NULL
      AND workspace_location_id IS NOT NULL
      AND relative_path IS NOT NULL)
    OR (kind = 'input_resource'
      AND media_id IS NULL
      AND file_snapshot_id IS NULL
      AND resource_id IS NOT NULL
      AND project_folder_id IS NULL
      AND workspace_location_id IS NULL
      AND relative_path IS NULL)
  );

RESET search_path;

-- Data repair for databases that reach 0001_agent_workbench by normal `up`.
-- That file was regenerated as a schema-only diff before publication (ADR 0025
-- addendum, 2026-10-22). The development migrations it replaced also moved
-- existing rows into the new shape: CLI continuity bindings onto their Host
-- thread, and each Room recipient's ledger, Setups and bindings into the
-- per-Conversation scopes. This file restores those transitions.
--
-- Every step selects only rows still in the pre-0001 shape and leaves a scope
-- alone once anything already lives in it, so a database that ran the original
-- development migrations, or a server that already wrote new-shape rows, is
-- not changed twice.

-- 1. An active binding still keyed to no Host thread follows the one open Host
--    thread of the same Space and Agent whose live ACP session it names, so the
--    upgrade does not rebuild that session. Skipped when the thread already
--    has its own active binding in the scope.
UPDATE runtime_context_cli_bindings binding
   SET host_thread_id = candidate.thread_id
  FROM (
    SELECT b.id, min(thread.id) AS thread_id
      FROM runtime_context_cli_bindings b
      JOIN host_threads thread
        ON thread.vendor_session_id = b.vendor_session_id
       AND thread.space_id = b.space_id
       AND thread.agent_id = b.agent_id
       AND thread.status <> 'closed'
     WHERE b.status = 'active'
       AND b.host_thread_id IS NULL
       AND b.vendor_session_id IS NOT NULL
     GROUP BY b.id
    HAVING count(*) = 1
  ) candidate
 WHERE binding.id = candidate.id
   AND NOT EXISTS (
     SELECT 1 FROM runtime_context_cli_bindings other
      WHERE other.status = 'active'
        AND other.space_id = binding.space_id
        AND other.work_context_scope_id = binding.work_context_scope_id
        AND other.user_id = binding.user_id
        AND other.agent_id = binding.agent_id
        AND other.host_thread_id = candidate.thread_id);--> statement-breakpoint

-- 2. Split each Room recipient's ledger per Conversation. Every event whose
--    canonical source names a Conversation of that recipient's Room moves, in
--    order, to that Conversation's scope; anything else stays where it was.
--    A Conversation scope that already holds events is not merged into.
--    Checkpoints are not split: the new scopes reconstruct from their own tail
--    until their next checkpoint.
--    Execution control snapshots are audit records and keep naming the
--    recipient scope; continuity treats a Run of a Conversation whose snapshot
--    names the recipient that Conversation scope was split from as part of
--    that scope (`controlInScope` in runtimeContext/continuity/service.ts).
--    An open capture gap means the recipient's ledger is known to be missing
--    something, so it must not disappear in the split. A gap whose invocation
--    is a Run of one split Conversation moves with that Conversation, replay
--    payload included, so the Run's buffered event can still be replayed
--    there. A gap of a Run in another Conversation of the Room stays where it
--    is. Any other gap (a reconciliation mismatch, or no attributable Run) is
--    copied into every Conversation split from that recipient, since none of
--    them can claim to be complete; copies keep invocation, code, detail and
--    time but no replay payload, and the original stays on the recipient
--    scope. Cursors are mapped onto the new sequence. A new scope holding an
--    open gap is `partial`; one holding a recovered event is `recovered`.
CREATE TEMPORARY TABLE room_scope_split ON COMMIT DROP AS
SELECT event.id AS event_id, event.space_id, event.work_context_scope_id AS member_id,
       event.scope_sequence AS old_sequence, conversation.id AS session_id
  FROM context_events event
  JOIN room_agent_members member
    ON member.id = event.work_context_scope_id AND member.space_id = event.space_id
  LEFT JOIN messages message
    ON event.canonical_ref_json->>'type' = 'message' AND message.id = event.canonical_ref_json->>'id'
  LEFT JOIN run_events run_event
    ON event.canonical_ref_json->>'type' = 'run_event' AND run_event.id = event.canonical_ref_json->>'id'
  LEFT JOIN runs run
    ON run.id = COALESCE(
         run_event.run_id,
         CASE WHEN event.canonical_ref_json->>'type' IN ('run', 'run_request') THEN event.canonical_ref_json->>'id' END,
         event.invocation_id)
  JOIN sessions conversation
    ON conversation.id = COALESCE(message.session_id, run.session_id)
   AND conversation.room_id = member.room_id
   AND conversation.space_id = member.space_id;--> statement-breakpoint
DELETE FROM room_scope_split split
 USING room_conversation_recipients scope
 WHERE scope.session_id = split.session_id
   AND scope.room_agent_member_id = split.member_id
   AND EXISTS (
     SELECT 1 FROM context_events event
      WHERE event.space_id = scope.space_id AND event.work_context_scope_id = scope.id);--> statement-breakpoint
CREATE TEMPORARY TABLE room_scope_split_gaps ON COMMIT DROP AS
SELECT gap.id AS gap_id, target.session_id, target.member_id, conversation.id IS NOT NULL AS moves
  FROM context_capture_gaps gap
  JOIN room_agent_members member
    ON member.id = gap.work_context_scope_id AND member.space_id = gap.space_id
  LEFT JOIN runs run
    ON run.id = gap.invocation_id AND run.space_id = gap.space_id
  LEFT JOIN sessions conversation
    ON conversation.id = run.session_id
   AND conversation.room_id = member.room_id
   AND conversation.space_id = member.space_id
  JOIN (SELECT DISTINCT session_id, member_id FROM room_scope_split) target
    ON target.member_id = member.id
   AND (conversation.id IS NULL OR target.session_id = conversation.id)
 WHERE gap.status = 'open';--> statement-breakpoint
INSERT INTO room_conversation_recipients (id, space_id, session_id, room_agent_member_id, created_at)
SELECT gen_random_uuid()::varchar, split.space_id, split.session_id, split.member_id, now()
  FROM (SELECT DISTINCT space_id, session_id, member_id FROM room_scope_split) split
ON CONFLICT (session_id, room_agent_member_id) DO NOTHING;--> statement-breakpoint
UPDATE context_events event
   SET work_context_scope_id = moved.scope_id, scope_sequence = moved.sequence
  FROM (
    SELECT split.event_id, scope.id AS scope_id,
           row_number() OVER (PARTITION BY scope.id ORDER BY split.old_sequence)::integer AS sequence
      FROM room_scope_split split
      JOIN room_conversation_recipients scope
        ON scope.session_id = split.session_id AND scope.room_agent_member_id = split.member_id
  ) moved
 WHERE event.id = moved.event_id;--> statement-breakpoint
INSERT INTO context_capture_gaps (id, space_id, work_context_scope_id, invocation_id, code, after_cursor,
  before_cursor, detail, replay_event_json, status, created_at)
SELECT gen_random_uuid()::varchar, gap.space_id, scope.id, gap.invocation_id, gap.code,
       (SELECT count(*) FROM room_scope_split split
         WHERE split.session_id = target.session_id AND split.member_id = target.member_id
           AND split.old_sequence <= gap.after_cursor)::integer,
       CASE WHEN gap.before_cursor IS NOT NULL THEN 1 + (
         SELECT count(*) FROM room_scope_split split
          WHERE split.session_id = target.session_id AND split.member_id = target.member_id
            AND split.old_sequence < gap.before_cursor)::integer END,
       gap.detail, NULL, 'open', gap.created_at
  FROM room_scope_split_gaps target
  JOIN context_capture_gaps gap ON gap.id = target.gap_id
  JOIN room_conversation_recipients scope
    ON scope.session_id = target.session_id AND scope.room_agent_member_id = target.member_id
 WHERE NOT target.moves;--> statement-breakpoint
UPDATE context_capture_gaps gap
   SET work_context_scope_id = scope.id,
       after_cursor = (SELECT count(*) FROM room_scope_split split
                        WHERE split.session_id = target.session_id AND split.member_id = target.member_id
                          AND split.old_sequence <= gap.after_cursor)::integer,
       before_cursor = CASE WHEN gap.before_cursor IS NOT NULL THEN 1 + (
                         SELECT count(*) FROM room_scope_split split
                          WHERE split.session_id = target.session_id AND split.member_id = target.member_id
                            AND split.old_sequence < gap.before_cursor)::integer END
  FROM room_scope_split_gaps target
  JOIN room_conversation_recipients scope
    ON scope.session_id = target.session_id AND scope.room_agent_member_id = target.member_id
 WHERE target.moves AND gap.id = target.gap_id;--> statement-breakpoint
INSERT INTO context_event_scopes (space_id, work_context_scope_id, event_head_cursor, checkpoint_cursor, capture_status, updated_at)
SELECT scope.space_id, scope.id, COALESCE(max(event.scope_sequence), 0), 0,
       CASE WHEN EXISTS (
              SELECT 1 FROM context_capture_gaps gap
               WHERE gap.space_id = scope.space_id AND gap.work_context_scope_id = scope.id
                 AND gap.status = 'open') THEN 'partial'
            WHEN bool_or(event.capture_status = 'recovered') THEN 'recovered'
            ELSE 'complete' END,
       now()
  FROM room_conversation_recipients scope
  JOIN (SELECT DISTINCT session_id, member_id FROM room_scope_split) split
    ON split.session_id = scope.session_id AND split.member_id = scope.room_agent_member_id
  LEFT JOIN context_events event
    ON event.space_id = scope.space_id AND event.work_context_scope_id = scope.id
 GROUP BY scope.space_id, scope.id
ON CONFLICT (space_id, work_context_scope_id) DO UPDATE
   SET event_head_cursor = GREATEST(context_event_scopes.event_head_cursor, EXCLUDED.event_head_cursor),
       capture_status = CASE
         WHEN 'partial' IN (context_event_scopes.capture_status, EXCLUDED.capture_status) THEN 'partial'
         WHEN 'recovered' IN (context_event_scopes.capture_status, EXCLUDED.capture_status) THEN 'recovered'
         ELSE 'complete' END,
       updated_at = now();--> statement-breakpoint

-- 3. Each person's latest Setup for the recipient carries over to every
--    Conversation scope the split produced, so a switch someone turned on stays
--    on where they were already talking. A Setup naming another Project or
--    Folder than the Conversation does is left behind; the next turn
--    bootstraps a fresh one.
INSERT INTO work_context_setups (
  id, space_id, work_context_scope_id, scope_kind, version, user_id, project_id, project_folder_id,
  agent_id, runtime_ref_json, pinned_refs_json, excluded_refs_json, retrieval_preferences_json,
  continuity_preferences_json, project_brief_version_id, project_instruction_version_id,
  project_instruction_enabled, governing_policy_refs_json, setup_fingerprint, base_version,
  typed_diff_json, reason, policy_decision_record_id, created_by_user_id, created_at
)
SELECT gen_random_uuid()::varchar, setup.space_id, scope.id, setup.scope_kind, 1, setup.user_id,
       setup.project_id, setup.project_folder_id, setup.agent_id, setup.runtime_ref_json,
       setup.pinned_refs_json, setup.excluded_refs_json, setup.retrieval_preferences_json,
       setup.continuity_preferences_json, setup.project_brief_version_id,
       setup.project_instruction_version_id, setup.project_instruction_enabled,
       setup.governing_policy_refs_json, setup.setup_fingerprint, NULL, '{}'::jsonb,
       'Split from the Room recipient scope per Conversation', setup.policy_decision_record_id,
       setup.created_by_user_id, now()
  FROM room_conversation_recipients scope
  JOIN (SELECT DISTINCT session_id, member_id FROM room_scope_split) split
    ON split.session_id = scope.session_id AND split.member_id = scope.room_agent_member_id
  JOIN sessions conversation ON conversation.id = scope.session_id
  JOIN rooms room ON room.id = conversation.room_id
  JOIN LATERAL (
    SELECT DISTINCT ON (latest.user_id) latest.*
      FROM work_context_setups latest
     WHERE latest.space_id = scope.space_id
       AND latest.work_context_scope_id = scope.room_agent_member_id
       AND latest.scope_kind = 'room_recipient'
     ORDER BY latest.user_id, latest.version DESC
  ) setup ON TRUE
 WHERE (COALESCE(conversation.project_id, room.project_id) IS NULL
        OR setup.project_id IS NOT DISTINCT FROM COALESCE(conversation.project_id, room.project_id))
   AND (COALESCE(conversation.project_folder_id, room.project_folder_id) IS NULL
        OR setup.project_folder_id IS NOT DISTINCT FROM COALESCE(conversation.project_folder_id, room.project_folder_id))
   AND NOT EXISTS (
     SELECT 1 FROM work_context_setups existing
      WHERE existing.space_id = scope.space_id AND existing.work_context_scope_id = scope.id
        AND existing.user_id = setup.user_id);--> statement-breakpoint

-- 4. An active Room binding that follows a Conversation's Host thread moves
--    with that Conversation, its cursor mapped onto the new sequence, so the
--    vendor session keeps resuming instead of being rebuilt. Only into a scope
--    the split produced or one that is still empty, and never next to an
--    active binding for the same thread.
UPDATE runtime_context_cli_bindings binding
   SET work_context_scope_id = scope.id,
       cli_known_cursor = COALESCE((
         SELECT max(event.scope_sequence)
           FROM room_scope_split split
           JOIN context_events event ON event.id = split.event_id
          WHERE event.work_context_scope_id = scope.id
            AND split.old_sequence <= binding.cli_known_cursor), 0),
       updated_at = now()
  FROM host_threads thread, room_conversation_recipients scope
 WHERE binding.status = 'active'
   AND binding.scope_kind = 'room_recipient'
   AND thread.id = binding.host_thread_id
   AND scope.session_id = thread.session_id
   AND scope.room_agent_member_id = binding.work_context_scope_id
   AND scope.space_id = binding.space_id
   AND (EXISTS (
          SELECT 1 FROM room_scope_split split
           WHERE split.session_id = scope.session_id AND split.member_id = scope.room_agent_member_id)
        OR NOT EXISTS (
          SELECT 1 FROM context_events event
           WHERE event.space_id = scope.space_id AND event.work_context_scope_id = scope.id))
   AND NOT EXISTS (
     SELECT 1 FROM runtime_context_cli_bindings other
      WHERE other.status = 'active'
        AND other.space_id = binding.space_id
        AND other.work_context_scope_id = scope.id
        AND other.user_id = binding.user_id
        AND other.agent_id = binding.agent_id
        AND other.host_thread_id IS NOT DISTINCT FROM binding.host_thread_id);--> statement-breakpoint

-- 5. No dispatch can reach what is left, so it must not stay active:
--    a Room binding still on the whole-Room recipient scope (every Room turn
--    now resolves a Conversation scope), and a thread-less binding whose vendor
--    session belongs to a Host thread (Host dispatches look a binding up by
--    thread). The next turn starts a fresh binding.
UPDATE runtime_context_cli_bindings binding
   SET status = 'rotated', rotation_reason = 'new_scope', updated_at = now()
 WHERE binding.status = 'active'
   AND binding.scope_kind = 'room_recipient'
   AND EXISTS (
     SELECT 1 FROM room_agent_members member
      WHERE member.id = binding.work_context_scope_id AND member.space_id = binding.space_id);--> statement-breakpoint
UPDATE runtime_context_cli_bindings binding
   SET status = 'rotated', rotation_reason = 'vendor_session_mismatch', updated_at = now()
 WHERE binding.status = 'active'
   AND binding.host_thread_id IS NULL
   AND binding.vendor_session_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM host_threads thread
      WHERE thread.space_id = binding.space_id
        AND thread.agent_id = binding.agent_id
        AND (thread.vendor_session_id = binding.vendor_session_id
             OR thread.retired_vendor_session_ids ? binding.vendor_session_id));--> statement-breakpoint

-- 6. A checkpoint job queued for a whole-Room recipient scope before this
--    upgrade would reconcile a ledger that no turn writes any more and whose
--    remaining events were left with sequence holes by the split, so it could
--    only fail and retry. Every Room turn now checkpoints its Conversation
--    scope; the recipient scope's unfinished checkpoint jobs are cancelled.
UPDATE jobs job
   SET status = 'cancelled',
       heartbeat_at = NULL,
       error = 'Room recipient scope was split per Conversation; its checkpoint is no longer needed',
       completed_at = now(),
       updated_at = now()
 WHERE job.job_type = 'runtime_context_checkpoint'
   AND job.status IN ('pending', 'claimed', 'running')
   AND EXISTS (
     SELECT 1 FROM room_agent_members member
      WHERE member.id = job.payload_json->>'work_context_scope_id' AND member.space_id = job.space_id);


RESET search_path;
