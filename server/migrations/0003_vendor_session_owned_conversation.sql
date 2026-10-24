ALTER TABLE "runtime_context_cli_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "runtime_context_cli_bindings" CASCADE;--> statement-breakpoint
ALTER TABLE "context_event_scopes" DROP CONSTRAINT "ck_context_event_scopes_cursors";--> statement-breakpoint
ALTER TABLE "context_event_scopes" DROP COLUMN "cli_known_cursor";--> statement-breakpoint
ALTER TABLE "context_event_scopes" ADD CONSTRAINT "ck_context_event_scopes_cursors" CHECK (event_head_cursor >= 0 AND checkpoint_cursor >= 0 AND checkpoint_cursor <= event_head_cursor);

RESET search_path;

ALTER TABLE "session_conversation_backends" DROP CONSTRAINT "uq_session_conversation_backends_runtime_state_key";--> statement-breakpoint
DROP INDEX "uq_jobs_runtime_context_checkpoint_cursor";--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP COLUMN "runtime_state_key";--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP COLUMN "runtime_session_id";--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP COLUMN "runtime_context_fingerprint";--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP COLUMN "runtime_message_cursor_id";--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP COLUMN "runtime_session_updated_at";--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" DROP COLUMN "last_run_git_branch";--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" DROP COLUMN "last_run_git_head";

RESET search_path;

DROP TABLE "room_conversation_summary_states" CASCADE;--> statement-breakpoint
DROP TABLE "room_conversation_summary_versions" CASCADE;

RESET search_path;

ALTER TABLE "host_threads" ADD COLUMN "standing_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "host_threads" ADD COLUMN "standing_digest_run_id" varchar(36);

RESET search_path;
