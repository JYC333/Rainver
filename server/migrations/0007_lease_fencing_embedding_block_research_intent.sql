ALTER TABLE "runtime_context_cli_bindings" ADD COLUMN "execution_lease_run_id" varchar(36);--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD COLUMN "execution_lease_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD COLUMN "semantic_intent_json" jsonb;--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ADD COLUMN "embedding_blocked_generation" varchar(64);--> statement-breakpoint
ALTER TABLE "host_thread_events" ADD COLUMN "attempt_number" integer;