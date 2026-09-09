-- rainver:maintenance
-- Destructive and incompatible with the previous release: the running server
-- reads these tables and columns, so applying this while it is up breaks it.
-- `start.sh` and the UI update refuse a pending maintenance migration and send
-- the operator to `start.sh --maintenance`, which stops the applications,
-- takes a dump, and only then applies this (ADR 0016 §10).
ALTER TABLE "cli_credential_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cli_credential_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cli_credential_space_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runtime_tool_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "space_runtime_tool_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cli_usage_import_cursors" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "cli_credential_events" CASCADE;--> statement-breakpoint
DROP TABLE "cli_credential_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "cli_credential_space_grants" CASCADE;--> statement-breakpoint
DROP TABLE "runtime_tool_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "space_runtime_tool_policies" CASCADE;--> statement-breakpoint
DROP TABLE "cli_usage_import_cursors" CASCADE;--> statement-breakpoint
-- Already gone: the DROP TABLE ... CASCADE above removes every foreign key
-- that pointed at cli_credential_profiles. Stated anyway so the intent is on
-- the record, and guarded so it is not an error to say it twice.
ALTER TABLE "runtime_context_cli_bindings" DROP CONSTRAINT IF EXISTS "runtime_context_cli_bindings_credential_owner_fkey";
--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP CONSTRAINT IF EXISTS "session_conversation_backends_credential_owner_fkey";
--> statement-breakpoint
DROP INDEX IF EXISTS "ix_session_conversation_backends_credential_profile_id";--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" DROP COLUMN "credential_profile_id";--> statement-breakpoint
ALTER TABLE "session_conversation_backends" DROP COLUMN "credential_profile_id";--> statement-breakpoint
-- The retired C3 conformance verdict is no longer read by routing or runs.
-- It is folded into this maintenance migration because this dev-only chain has
-- not been applied to a production database.
DROP TABLE "runtime_conformance_results" CASCADE;
