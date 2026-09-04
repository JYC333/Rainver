CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
CREATE TYPE "public"."retrieval_object_type" AS ENUM('knowledge_item', 'note', 'source', 'claim', 'memory_entry', 'project_public_summary', 'source_item', 'extracted_evidence', 'inquiry_thread');--> statement-breakpoint
CREATE TABLE "academic_papers" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"doi" varchar(256),
	"arxiv_id" varchar(64),
	"pmid" varchar(32),
	"openalex_id" varchar(64),
	"semantic_scholar_id" varchar(64),
	"publication_date" timestamp with time zone,
	"venue" varchar(512),
	"paper_type" varchar(32) DEFAULT 'article' NOT NULL,
	"cited_by_count" integer,
	"reference_count" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "academic_papers_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_academic_papers_paper_type" CHECK ((paper_type)::text = ANY (ARRAY[('article'::character varying)::text, ('preprint'::character varying)::text, ('conference_paper'::character varying)::text, ('book_chapter'::character varying)::text, ('thesis'::character varying)::text, ('report'::character varying)::text, ('other'::character varying)::text])),
	CONSTRAINT "ck_academic_papers_canonical_identity" CHECK ((doi IS NULL OR (doi <> '' AND doi = lower(btrim(doi)))) AND (arxiv_id IS NULL OR (arxiv_id <> '' AND arxiv_id = lower(btrim(arxiv_id)))) AND (pmid IS NULL OR (pmid <> '' AND pmid = lower(btrim(pmid)))) AND (openalex_id IS NULL OR (openalex_id <> '' AND openalex_id = lower(btrim(openalex_id)))) AND (semantic_scholar_id IS NULL OR (semantic_scholar_id <> '' AND semantic_scholar_id = lower(btrim(semantic_scholar_id)))))
);
--> statement-breakpoint
CREATE TABLE "activity_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_run_id" varchar(36),
	"session_id" varchar(36),
	"user_id" varchar(36),
	"project_folder_id" varchar(36),
	"agent_id" varchar(36),
	"source_task_id" varchar(36),
	"source_url" text,
	"activity_type" varchar(64) NOT NULL,
	"title" varchar(512),
	"content" text,
	"payload_json" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'raw' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"source_kind" varchar(64),
	"source_trust" varchar(32),
	"source_integrity_json" jsonb,
	"entity_refs_json" jsonb,
	"subject_user_id" varchar(36),
	"processed_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"owner_user_id" varchar(36),
	"project_id" varchar(36),
	"aggregate_key" varchar(128),
	CONSTRAINT "ck_activity_records_source_kind" CHECK ((source_kind IS NULL) OR ((source_kind)::text = ANY (ARRAY[('user_capture'::character varying)::text, ('chat_message'::character varying)::text, ('external_chat'::character varying)::text, ('file_import'::character varying)::text, ('web_capture'::character varying)::text, ('run_event'::character varying)::text, ('project_folder_event'::character varying)::text, ('system_event'::character varying)::text, ('external_source'::character varying)::text, ('source'::character varying)::text]))),
	CONSTRAINT "ck_activity_records_source_trust" CHECK ((source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('user_confirmed'::character varying)::text, ('internal_system'::character varying)::text, ('trusted_external'::character varying)::text, ('untrusted_external'::character varying)::text, ('agent_inferred'::character varying)::text]))),
	CONSTRAINT "ck_activity_records_status" CHECK ((status)::text = ANY (ARRAY[('raw'::character varying)::text, ('processed'::character varying)::text, ('proposals_generated'::character varying)::text, ('failed'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_activity_records_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_activity_records_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_activity_records_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "action_approval_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"action_id" varchar(128) NOT NULL,
	"target_run_id" varchar(36),
	"project_id" varchar(36),
	"resource_kind" varchar(64),
	"resource_id" varchar(256),
	"granted_by_user_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "uq_action_approval_grants_request_binding" UNIQUE("id","space_id","agent_id","action_id","target_run_id"),
	CONSTRAINT "ck_action_approval_grants_status" CHECK (status IN ('active', 'revoked', 'expired')),
	CONSTRAINT "ck_action_approval_grants_use_count" CHECK (use_count >= 0 AND (max_uses IS NULL OR (max_uses > 0 AND use_count <= max_uses)))
);
--> statement-breakpoint
CREATE TABLE "agent_run_group_members" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"group_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"role" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"capabilities_json" jsonb,
	"context_policy_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_agent_run_group_members_group_agent" UNIQUE("agent_id","group_id"),
	CONSTRAINT "ck_agent_run_group_members_role" CHECK ((role)::text = ANY (ARRAY[('manager'::character varying)::text, ('planner'::character varying)::text, ('worker'::character varying)::text, ('reviewer'::character varying)::text, ('curator'::character varying)::text, ('observer'::character varying)::text])),
	CONSTRAINT "ck_agent_run_group_members_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "agent_run_groups" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"root_run_id" varchar(36),
	"manager_user_id" varchar(36) NOT NULL,
	"manager_agent_id" varchar(36),
	"room_id" varchar(36),
	"session_id" varchar(36),
	"trigger_message_id" varchar(36),
	"project_id" varchar(36),
	"project_folder_id" varchar(36),
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"budget_json" jsonb,
	"policy_snapshot_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "uq_agent_run_groups_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_agent_run_groups_run_scope" UNIQUE("id","space_id","session_id","project_id"),
	CONSTRAINT "ck_agent_run_groups_room_links" CHECK (
		(
			room_id IS NULL
			AND session_id IS NULL
			AND trigger_message_id IS NULL
			AND project_id IS NULL
			AND project_folder_id IS NULL
		)
		OR (
			room_id IS NOT NULL
			AND session_id IS NOT NULL
			AND trigger_message_id IS NOT NULL
			AND project_id IS NOT NULL
		)
	),
	CONSTRAINT "ck_agent_run_groups_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "agent_run_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"group_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"parent_message_id" varchar(36),
	"sender_actor_ref_json" jsonb NOT NULL,
	"sender_user_id" varchar(36),
	"sender_agent_id" varchar(36),
	"message_type" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"mentions_json" jsonb,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_agent_run_messages_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_agent_run_messages_message_type" CHECK ((message_type)::text = ANY (ARRAY[('user_instruction'::character varying)::text, ('agent_message'::character varying)::text, ('delegation_request'::character varying)::text, ('delegation_result'::character varying)::text, ('system_event'::character varying)::text, ('review_note'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "run_delegations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"group_id" varchar(36) NOT NULL,
	"parent_run_id" varchar(36) NOT NULL,
	"child_run_id" varchar(36),
	"request_message_id" varchar(36),
	"requesting_agent_id" varchar(36) NOT NULL,
	"target_agent_id" varchar(36) NOT NULL,
	"requested_by_user_id" varchar(36),
	"policy_decision_record_id" varchar(36),
	"status" varchar(32) NOT NULL,
	"instruction" text NOT NULL,
	"reason" text,
	"budget_json" jsonb,
	"context_policy_json" jsonb,
	"result_summary" text,
	"tool_call_id" varchar(128),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uq_run_delegations_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_run_delegations_status" CHECK ((status)::text = ANY (ARRAY[('requested'::character varying)::text, ('policy_denied'::character varying)::text, ('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"actor_type" varchar(32) NOT NULL,
	"user_id" varchar(36),
	"agent_id" varchar(36),
	"service_name" varchar(128),
	"display_name" varchar(256),
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_actors_actor_type" CHECK ((actor_type)::text = ANY (ARRAY[('user'::character varying)::text, ('agent'::character varying)::text, ('system'::character varying)::text, ('automation'::character varying)::text, ('connector'::character varying)::text, ('integration'::character varying)::text, ('service'::character varying)::text, ('job'::character varying)::text])),
	CONSTRAINT "ck_actors_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_profiles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"execution_host_id" varchar(36),
	"workspace_location_id" varchar(36),
	"workspace_mode" varchar(16),
	"runtime_installation" varchar(64),
	"name" varchar(128) NOT NULL,
	"adapter_type" varchar(64) NOT NULL,
	"model_provider_id" varchar(36),
	"model_name" varchar(256),
	"runtime_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_agent_runtime_profiles_id_space_agent" UNIQUE("id","space_id","agent_id"),
	CONSTRAINT "uq_agent_runtime_profiles_agent_name" UNIQUE("agent_id","name"),
	CONSTRAINT "ck_agent_runtime_profiles_workspace_mode" CHECK (workspace_mode IS NULL OR workspace_mode IN ('location', 'managed')),
	CONSTRAINT "ck_agent_runtime_profiles_host_binding" CHECK (
		(execution_host_id IS NULL) = (runtime_installation IS NULL)
		AND (execution_host_id IS NULL) = (workspace_mode IS NULL)
		AND (workspace_mode <> 'location' OR workspace_location_id IS NOT NULL)
		AND (workspace_mode <> 'managed' OR workspace_location_id IS NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"version_label" varchar(64) NOT NULL,
	"model_provider_id" varchar(36),
	"model_name" varchar(256),
	"system_prompt" text,
	"prompt_provenance_json" jsonb,
	"model_config_json" jsonb NOT NULL,
	"runtime_config_json" jsonb NOT NULL,
	"context_policy_json" jsonb NOT NULL,
	"memory_policy_json" jsonb NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"tool_permissions_json" jsonb NOT NULL,
	"runtime_policy_json" jsonb NOT NULL,
	"tool_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_proposal_id" varchar(36),
	"source_activity_id" varchar(36),
	"follows_seed_key" varchar(128),
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "uq_agent_versions_id_agent_space" UNIQUE("id","agent_id","space_id"),
	CONSTRAINT "uq_agent_versions_agent_label" UNIQUE("agent_id","version_label")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"owner_user_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"description" text,
	"role_instruction" text,
	"status" varchar(32) NOT NULL,
	"agent_kind" varchar(32) DEFAULT 'standard' NOT NULL,
	"current_version_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"visibility" varchar(32) NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	CONSTRAINT "uq_agents_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_agents_agent_kind" CHECK ((agent_kind)::text = ANY (ARRAY[('standard'::character varying)::text, ('system_assistant'::character varying)::text, ('system_source_post_processor'::character varying)::text, ('system_source_annotator'::character varying)::text, ('system_research'::character varying)::text])),
	CONSTRAINT "ck_agents_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text, ('archived'::character varying)::text, ('disabled'::character varying)::text])),
	CONSTRAINT "ck_agents_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_agents_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_agents_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "cli_credential_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"runtime_adapter_type" varchar(64),
	"credential_profile_id" varchar(128),
	"credential_source" varchar(32) NOT NULL,
	"trigger_origin" varchar(64),
	"fallback_used" boolean NOT NULL,
	"fallback_reason" varchar(128),
	"broker_error" boolean NOT NULL,
	"cleanup_status" varchar(32) NOT NULL,
	"action" varchar(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_cli_credential_events_credential_source" CHECK ((credential_source)::text = ANY (ARRAY[('profile'::character varying)::text, ('container_default'::character varying)::text, ('none'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "cli_credential_profiles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"runtime" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"source_path" text NOT NULL,
	"target_path" text NOT NULL,
	"readonly" boolean NOT NULL,
	"notes" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_cli_credential_profiles_id_owner" UNIQUE("id","owner_user_id"),
	CONSTRAINT "uq_cli_credential_profiles_owner_runtime_name" UNIQUE("name","owner_user_id","runtime")
);
--> statement-breakpoint
CREATE TABLE "cli_credential_space_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"profile_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"granted_by_user_id" varchar(36),
	"enabled" boolean NOT NULL,
	"is_default" boolean NOT NULL,
	"network_profile_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_cli_credential_space_grants_profile_space" UNIQUE("profile_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"proposal_id" varchar(36),
	"artifact_type" varchar(64) NOT NULL,
	"surface_role" varchar(32) DEFAULT 'user_output' NOT NULL,
	"title" varchar(512) NOT NULL,
	"content" text,
	"storage_ref" varchar(1024),
	"storage_path" varchar(1024),
	"mime_type" varchar(256),
	"exportable" boolean DEFAULT true NOT NULL,
	"export_formats_json" jsonb NOT NULL,
	"canonical_format" varchar(64),
	"preview" boolean DEFAULT false NOT NULL,
	"relevant_period_start" timestamp with time zone,
	"relevant_period_end" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"metadata_json" jsonb,
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"owner_user_id" varchar(36),
	"trust_level" varchar(32),
	"project_id" varchar(36),
	"project_folder_id" varchar(36),
	CONSTRAINT "artifacts_id_space_id_key" UNIQUE("id","space_id"),
	CONSTRAINT "ck_artifacts_storage_path_relative" CHECK ((storage_path IS NULL) OR ((storage_path)::text !~~ '/%'::text)),
	CONSTRAINT "ck_artifacts_trust_level" CHECK ((trust_level IS NULL) OR ((trust_level)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_artifacts_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_artifacts_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_artifacts_surface_role" CHECK (surface_role IN ('user_output', 'operational', 'system_archive')),
	CONSTRAINT "ck_artifacts_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_user_id" varchar(256) NOT NULL,
	"email" varchar(256) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_auth_accounts_provider_user" UNIQUE("provider","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "user_sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email" varchar(256),
	"display_name" varchar(256) NOT NULL,
	"avatar_url" text,
	"status" varchar(32) NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_users_status" CHECK (status IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "authorization_requests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"instructed_by_user_id" varchar(36) NOT NULL,
	"policy_decision_record_id" varchar(36) NOT NULL,
	"action_id" varchar(128) NOT NULL,
	"policy_action" varchar(128) NOT NULL,
	"project_id" varchar(36),
	"resource_kind" varchar(64),
	"resource_id" varchar(256),
	"reason" varchar(1000) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"resulting_action_grant_id" varchar(36),
	"decided_by_user_id" varchar(36),
	"requested_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "uq_authorization_requests_decision" UNIQUE("space_id","policy_decision_record_id"),
	CONSTRAINT "ck_authorization_requests_status" CHECK ("authorization_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "ck_authorization_requests_decision" CHECK (("authorization_requests"."status" = 'pending' AND "authorization_requests"."decided_by_user_id" IS NULL AND "authorization_requests"."decided_at" IS NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL) OR ("authorization_requests"."status" = 'rejected' AND "authorization_requests"."decided_by_user_id" IS NOT NULL AND "authorization_requests"."decided_at" IS NOT NULL AND "authorization_requests"."resulting_action_grant_id" IS NULL) OR ("authorization_requests"."status" = 'approved' AND "authorization_requests"."decided_by_user_id" IS NOT NULL AND "authorization_requests"."decided_at" IS NOT NULL AND "authorization_requests"."resulting_action_grant_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "automation_credential_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"automation_id" varchar(36) NOT NULL,
	"granted_by_user_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36),
	CONSTRAINT "ck_automation_credential_grants_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('revoked'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"automation_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"workflow_execution_id" varchar(36),
	"triggered_by_user_id" varchar(36),
	"trigger_type" varchar(64) DEFAULT 'manual' NOT NULL,
	"preflight_snapshot_json" jsonb,
	"trigger_context_json" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"project_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"description" text,
	"trigger_type" varchar(64) DEFAULT 'manual' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"preflight_snapshot_json" jsonb,
	"config_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_automations_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_automations_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_automations_trigger_type" CHECK ((trigger_type)::text = ANY (ARRAY[('manual'::character varying)::text, ('schedule'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_dependencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"execution_id" varchar(36) NOT NULL,
	"node_id" varchar(36) NOT NULL,
	"depends_on_node_id" varchar(36) NOT NULL,
	"dependency_type" varchar(32) DEFAULT 'requires' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_workflow_execution_dependencies_edge" UNIQUE("node_id","depends_on_node_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_node_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"node_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"role" varchar(32) DEFAULT 'primary' NOT NULL,
	"resolved_inputs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_workflow_execution_node_runs_node_run" UNIQUE("node_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_nodes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"execution_id" varchar(36) NOT NULL,
	"node_key" varchar(128) NOT NULL,
	"node_kind" varchar(32) NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"status" varchar(64) DEFAULT 'inbox' NOT NULL,
	"assigned_agent_id" varchar(36),
	"runtime_profile_id" varchar(36),
	"capability_id" varchar(128),
	"prompt_asset_key" varchar(256),
	"risk_level" varchar(32) DEFAULT 'low' NOT NULL,
	"contract_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_bindings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blocked_reason" text,
	"approval_proposal_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_workflow_execution_nodes_key" UNIQUE("execution_id","node_key"),
	CONSTRAINT "uq_workflow_execution_nodes_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_workflow_execution_nodes_status" CHECK (status IN ('inbox', 'ready', 'in_progress', 'blocked', 'waiting_for_review', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"automation_id" varchar(36) NOT NULL,
	"workflow_version_id" varchar(36) NOT NULL,
	"root_run_id" varchar(36),
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"trigger_type" varchar(64) NOT NULL,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"definition_json" jsonb NOT NULL,
	"resolution_trace_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contract_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"research_operation_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_workflow_executions_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_workflow_executions_id_automation_id" UNIQUE("id","automation_id")
);
--> statement-breakpoint
CREATE TABLE "autonomy_candidate_evolution_signals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"candidate_id" varchar(36) NOT NULL,
	"signal_id" varchar(36) NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "uq_autonomy_candidate_evolution_signals" UNIQUE("candidate_id","signal_id")
);
--> statement-breakpoint
CREATE TABLE "autonomy_candidates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"candidate_kind" varchar(64) NOT NULL,
	"candidate_key" varchar(256) NOT NULL,
	"status" varchar(32) NOT NULL,
	"durable_fact_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovery_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ranking_score" double precision,
	"ranking_evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision_reason" varchar(128),
	"admission_decision_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_tick_id" varchar(36) NOT NULL,
	"last_seen_tick_id" varchar(36) NOT NULL,
	"launch_tick_id" varchar(36),
	"run_id" varchar(36),
	"artifact_id" varchar(36),
	"discovered_at" timestamp with time zone NOT NULL,
	"ranked_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"launched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_autonomy_candidates_logical" UNIQUE("space_id","owner_user_id","candidate_kind","candidate_key"),
	CONSTRAINT "uq_autonomy_candidates_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_autonomy_candidates_status" CHECK (status IN ('discovered', 'ranked', 'observed', 'refused', 'admitted', 'launched', 'completed', 'failed', 'superseded')),
	CONSTRAINT "ck_autonomy_candidates_fact_refs_array" CHECK (jsonb_typeof(durable_fact_refs_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "autonomy_review_cursors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"candidate_kind" varchar(64) NOT NULL,
	"candidate_id" varchar(36) NOT NULL,
	"last_fact_created_at" timestamp with time zone NOT NULL,
	"last_fact_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_autonomy_review_cursors_owner_kind" UNIQUE("space_id","owner_user_id","candidate_kind"),
	CONSTRAINT "ck_autonomy_review_cursors_kind" CHECK (candidate_kind = 'evolution_review')
);
--> statement-breakpoint
CREATE TABLE "autonomy_tick_candidates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"tick_id" varchar(36) NOT NULL,
	"candidate_id" varchar(36) NOT NULL,
	"rank" integer NOT NULL,
	"ranking_score" double precision NOT NULL,
	"decision" varchar(32) NOT NULL,
	"decision_reason" varchar(128) NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_autonomy_tick_candidates_tick_candidate" UNIQUE("tick_id","candidate_id"),
	CONSTRAINT "ck_autonomy_tick_candidates_rank" CHECK (rank > 0),
	CONSTRAINT "ck_autonomy_tick_candidates_decision" CHECK (decision IN ('observed', 'refused', 'admitted', 'launched'))
);
--> statement-breakpoint
CREATE TABLE "autonomy_ticks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"automation_id" varchar(36) NOT NULL,
	"coordinator_run_id" varchar(36),
	"automation_run_id" varchar(36),
	"owner_user_id" varchar(36) NOT NULL,
	"mode" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"candidates_seen" integer DEFAULT 0 NOT NULL,
	"candidates_ranked" integer DEFAULT 0 NOT NULL,
	"candidates_admitted" integer DEFAULT 0 NOT NULL,
	"candidates_launched" integer DEFAULT 0 NOT NULL,
	"config_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_autonomy_ticks_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_autonomy_ticks_mode" CHECK (mode IN ('observe_only', 'launch')),
	CONSTRAINT "ck_autonomy_ticks_status" CHECK (status IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "ck_autonomy_ticks_counts" CHECK (candidates_seen >= 0 AND candidates_ranked >= 0 AND candidates_admitted >= 0 AND candidates_launched >= 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_conformance_results" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"runtime_adapter_type" varchar(64) NOT NULL,
	"runtime_version" varchar(128) NOT NULL,
	"suite_version" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"trust_level" varchar(16) NOT NULL,
	"passed_checks" integer NOT NULL,
	"failed_checks" integer NOT NULL,
	"checks_json" jsonb NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_runtime_conformance_runtime_version" UNIQUE("runtime_adapter_type","runtime_version"),
	CONSTRAINT "ck_runtime_conformance_status" CHECK ((status)::text = ANY (ARRAY['passed'::text, 'failed'::text, 'partial'::text])),
	CONSTRAINT "ck_runtime_conformance_trust_level" CHECK ((trust_level)::text = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])),
	CONSTRAINT "ck_runtime_conformance_counts" CHECK (passed_checks >= 0 AND failed_checks >= 0),
	CONSTRAINT "ck_runtime_conformance_checks_object" CHECK (jsonb_typeof(checks_json) = 'object'::text),
	CONSTRAINT "ck_runtime_conformance_evidence_object" CHECK (jsonb_typeof(evidence_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "context_capture_gaps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"invocation_id" varchar(36),
	"code" varchar(64) NOT NULL,
	"after_cursor" integer NOT NULL,
	"before_cursor" integer,
	"detail" varchar(2000),
	"replay_event_json" jsonb,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ck_context_capture_gaps_cursors" CHECK (after_cursor >= 0 AND (before_cursor IS NULL OR before_cursor > after_cursor)),
	CONSTRAINT "ck_context_capture_gaps_status" CHECK (status IN ('open','recovered')),
	CONSTRAINT "ck_context_capture_gaps_replay_event" CHECK (replay_event_json IS NULL OR jsonb_typeof(replay_event_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_checkpoint_corrections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"semantic_checkpoint_id" varchar(36) NOT NULL,
	"canonical_ref_json" jsonb NOT NULL,
	"correction_json" jsonb NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_context_checkpoint_corrections_json" CHECK (jsonb_typeof(canonical_ref_json) = 'object' AND jsonb_typeof(correction_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_event_scopes" (
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"event_head_cursor" integer DEFAULT 0 NOT NULL,
	"checkpoint_cursor" integer DEFAULT 0 NOT NULL,
	"cli_known_cursor" integer,
	"capture_status" varchar(16) DEFAULT 'complete' NOT NULL,
	"active_micro_checkpoint_id" varchar(36),
	"active_semantic_checkpoint_id" varchar(36),
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "context_event_scopes_pkey" PRIMARY KEY("space_id","work_context_scope_id"),
	CONSTRAINT "ck_context_event_scopes_cursors" CHECK (event_head_cursor >= 0 AND checkpoint_cursor >= 0 AND checkpoint_cursor <= event_head_cursor AND (cli_known_cursor IS NULL OR (cli_known_cursor >= 0 AND cli_known_cursor <= event_head_cursor))),
	CONSTRAINT "ck_context_event_scopes_capture_status" CHECK (capture_status IN ('complete','recovered','partial'))
);
--> statement-breakpoint
CREATE TABLE "context_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"scope_sequence" integer NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"canonical_ref_json" jsonb NOT NULL,
	"canonical_ref_key" varchar(512) NOT NULL,
	"actor_user_id" varchar(36),
	"agent_id" varchar(36),
	"invocation_id" varchar(36),
	"semantic_role" varchar(32),
	"trust" varchar(32) NOT NULL,
	"sensitivity" varchar(32) NOT NULL,
	"token_estimate" integer NOT NULL,
	"confirmation_state" varchar(16) NOT NULL,
	"source_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capture_status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_context_events_scope_sequence" UNIQUE("space_id","work_context_scope_id","scope_sequence"),
	CONSTRAINT "uq_context_events_scope_canonical_event" UNIQUE("space_id","work_context_scope_id","event_type","canonical_ref_key"),
	CONSTRAINT "ck_context_events_sequence_positive" CHECK (scope_sequence >= 1),
	CONSTRAINT "ck_context_events_token_estimate" CHECK (token_estimate >= 0),
	CONSTRAINT "ck_context_events_semantic_role" CHECK (semantic_role IS NULL OR semantic_role IN ('delegated_instruction','user_input','reference_data')),
	CONSTRAINT "ck_context_events_capture_status" CHECK (capture_status IN ('complete','recovered','partial')),
	CONSTRAINT "ck_context_events_confirmation_state" CHECK (confirmation_state IN ('observed','candidate','confirmed','corrected')),
	CONSTRAINT "ck_context_events_ref_object" CHECK (jsonb_typeof(canonical_ref_json) = 'object' AND jsonb_typeof(source_refs_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "context_micro_checkpoints" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"checkpoint_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_context_micro_checkpoints_scope_version" UNIQUE("space_id","work_context_scope_id","version"),
	CONSTRAINT "ck_context_micro_checkpoints_version" CHECK (version >= 1 AND jsonb_typeof(checkpoint_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_semantic_checkpoints" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"covered_cursor" integer NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"checkpoint_json" jsonb NOT NULL,
	"extractor_ref_json" jsonb NOT NULL,
	"supersedes_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_context_semantic_checkpoints_scope_version" UNIQUE("space_id","work_context_scope_id","version"),
	CONSTRAINT "ck_context_semantic_checkpoints_status" CHECK (status IN ('active','superseded')),
	CONSTRAINT "ck_context_semantic_checkpoints_json" CHECK (covered_cursor >= 0 AND jsonb_typeof(checkpoint_json) = 'object' AND jsonb_typeof(extractor_ref_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_window_reconciliations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invocation_id" varchar(36) NOT NULL,
	"delivery_id" varchar(36),
	"model" varchar(256) NOT NULL,
	"model_catalog_version" varchar(64) NOT NULL,
	"tokenizer_version" varchar(64) NOT NULL,
	"planned_prompt_tokens" integer NOT NULL,
	"plan_hash" varchar(64) NOT NULL,
	"plan_json" jsonb NOT NULL,
	"actual_prompt_tokens" integer,
	"delta_tokens" integer,
	"status" varchar(16) DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_context_window_reconciliations_delivery" UNIQUE("delivery_id"),
	CONSTRAINT "ck_context_window_reconciliations_tokens" CHECK (planned_prompt_tokens >= 0 AND (actual_prompt_tokens IS NULL OR actual_prompt_tokens >= 0)),
	CONSTRAINT "ck_context_window_reconciliations_plan_object" CHECK (jsonb_typeof(plan_json) = 'object'),
	CONSTRAINT "ck_context_window_reconciliations_status" CHECK (status IN ('planned', 'matched', 'under', 'over'))
);
--> statement-breakpoint
CREATE TABLE "execution_control_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_execution_control_snapshots_json_object" CHECK (jsonb_typeof(snapshot_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "invocation_deliveries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invocation_id" varchar(36) NOT NULL,
	"attempt" integer NOT NULL,
	"execution_control_snapshot_id" varchar(36) NOT NULL,
	"adapter_type" varchar(64) NOT NULL,
	"provider_id" varchar(36),
	"renderer_version" varchar(64) NOT NULL,
	"delivery_metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_invocation_deliveries_invocation_attempt" UNIQUE("space_id","invocation_id","attempt"),
	CONSTRAINT "ck_invocation_deliveries_attempt_positive" CHECK (attempt >= 1),
	CONSTRAINT "ck_invocation_deliveries_metadata_object" CHECK (jsonb_typeof(delivery_metadata_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "invocation_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invocation_id" varchar(36) NOT NULL,
	"delivery_id" varchar(36) NOT NULL,
	"attempt" integer NOT NULL,
	"safe_snapshot_json" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"acknowledgement_fingerprint" varchar(64),
	"finalization_fingerprint" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_invocation_snapshots_delivery" UNIQUE("delivery_id"),
	CONSTRAINT "uq_invocation_snapshots_invocation_attempt" UNIQUE("space_id","invocation_id","attempt"),
	CONSTRAINT "ck_invocation_snapshots_attempt_positive" CHECK (attempt >= 1),
	CONSTRAINT "ck_invocation_snapshots_json_object" CHECK (jsonb_typeof(safe_snapshot_json) = 'object'),
	CONSTRAINT "ck_invocation_snapshots_status" CHECK (status IN ('draft', 'accepted', 'rejected', 'failed', 'finalized'))
);
--> statement-breakpoint
CREATE TABLE "provider_task_controls" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task" varchar(128) NOT NULL,
	"owner_domain" varchar(128) NOT NULL,
	"control_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_provider_task_controls_json_object" CHECK (jsonb_typeof(control_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "provider_task_deliveries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invocation_id" varchar(36) NOT NULL,
	"attempt" integer NOT NULL,
	"control_id" varchar(36) NOT NULL,
	"provider_id" varchar(36) NOT NULL,
	"model" varchar(255),
	"input_fingerprint" varchar(64) NOT NULL,
	"usage_source_id" varchar(255) NOT NULL,
	"delivery_metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_provider_task_deliveries_invocation_attempt" UNIQUE("space_id","invocation_id","attempt"),
	CONSTRAINT "uq_provider_task_deliveries_usage_source" UNIQUE("usage_source_id"),
	CONSTRAINT "ck_provider_task_deliveries_attempt_positive" CHECK (attempt >= 1),
	CONSTRAINT "ck_provider_task_deliveries_metadata_object" CHECK (jsonb_typeof(delivery_metadata_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "provider_task_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"delivery_id" varchar(36) NOT NULL,
	"safe_snapshot_json" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"error_code" varchar(128),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_provider_task_snapshots_delivery" UNIQUE("delivery_id"),
	CONSTRAINT "ck_provider_task_snapshots_json_object" CHECK (jsonb_typeof(safe_snapshot_json) = 'object'),
	CONSTRAINT "ck_provider_task_snapshots_status" CHECK (status IN ('draft','accepted','failed'))
);
--> statement-breakpoint
CREATE TABLE "runtime_context_cli_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"scope_kind" varchar(32) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"runtime_profile_id" varchar(36) NOT NULL,
	"credential_profile_id" varchar(36),
	"adapter_type" varchar(64) NOT NULL,
	"provider_id" varchar(36),
	"model" varchar(256),
	"runtime_state_key" varchar(36) NOT NULL,
	"vendor_session_id" varchar(512),
	"authority_fingerprint" varchar(64) NOT NULL,
	"runtime_fingerprint" varchar(64) NOT NULL,
	"fingerprint_json" jsonb NOT NULL,
	"cli_known_cursor" integer DEFAULT 0 NOT NULL,
	"acknowledged_item_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"rotation_reason" varchar(64),
	"execution_lease_id" varchar(36),
	"execution_lease_expires_at" timestamp with time zone,
	"last_acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_runtime_context_cli_bindings_scope_kind" CHECK (scope_kind IN ('direct_session','room_recipient','root_task','workflow_execution')),
	CONSTRAINT "ck_runtime_context_cli_bindings_status" CHECK (status IN ('active','rotated')),
	CONSTRAINT "ck_runtime_context_cli_bindings_cursor_generation" CHECK (cli_known_cursor >= 0 AND generation >= 1),
	CONSTRAINT "ck_runtime_context_cli_bindings_json" CHECK (jsonb_typeof(fingerprint_json) = 'object' AND jsonb_typeof(acknowledged_item_ids_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "runtime_context_policy_audits" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" varchar(36) NOT NULL,
	"actor_user_id" varchar(36) NOT NULL,
	"base_version_id" varchar(36),
	"new_version_id" varchar(36) NOT NULL,
	"policy_decision_record_id" varchar(36),
	"typed_diff_json" jsonb NOT NULL,
	"reason" varchar(2000) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_runtime_context_policy_audits_diff_object" CHECK (jsonb_typeof(typed_diff_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "runtime_context_policy_bindings" (
	"space_id" varchar(36) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" varchar(36) NOT NULL,
	"active_version_id" varchar(36) NOT NULL,
	"updated_by_user_id" varchar(36) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtime_context_policy_bindings_pkey" PRIMARY KEY("space_id","scope_type","scope_id"),
	CONSTRAINT "uq_runtime_context_policy_bindings_active_version" UNIQUE("active_version_id"),
	CONSTRAINT "ck_runtime_context_policy_bindings_scope_type" CHECK (scope_type IN ('space', 'project', 'project_folder', 'agent', 'user'))
);
--> statement-breakpoint
CREATE TABLE "runtime_context_policy_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"policy_json" jsonb NOT NULL,
	"base_version_id" varchar(36),
	"typed_diff_json" jsonb NOT NULL,
	"reason" varchar(2000) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_runtime_context_policy_versions_scope_version" UNIQUE("space_id","scope_type","scope_id","version"),
	CONSTRAINT "ck_runtime_context_policy_versions_scope_type" CHECK (scope_type IN ('space', 'project', 'project_folder', 'agent', 'user')),
	CONSTRAINT "ck_runtime_context_policy_versions_version_positive" CHECK (version >= 1),
	CONSTRAINT "ck_runtime_context_policy_versions_policy_object" CHECK (jsonb_typeof(policy_json) = 'object'),
	CONSTRAINT "ck_runtime_context_policy_versions_diff_object" CHECK (jsonb_typeof(typed_diff_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "sealed_invocation_payload_access_audits" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"sealed_payload_id" varchar(36) NOT NULL,
	"viewer_user_id" varchar(36) NOT NULL,
	"reason" varchar(512) NOT NULL,
	"accessed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sealed_invocation_payloads" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invocation_snapshot_id" varchar(36) NOT NULL,
	"encrypted_payload" text,
	"payload_hash" varchar(64) NOT NULL,
	"retention_deadline" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_sealed_invocation_payloads_snapshot" UNIQUE("invocation_snapshot_id"),
	CONSTRAINT "ck_sealed_invocation_payloads_deleted" CHECK ((deleted_at IS NULL AND encrypted_payload IS NOT NULL) OR (deleted_at IS NOT NULL AND encrypted_payload IS NULL))
);
--> statement-breakpoint
CREATE TABLE "work_context_setups" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"work_context_scope_id" varchar(36) NOT NULL,
	"scope_kind" varchar(32) NOT NULL,
	"version" integer NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"project_folder_id" varchar(36),
	"agent_id" varchar(36),
	"runtime_ref_json" jsonb,
	"pinned_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retrieval_preferences_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"continuity_preferences_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_brief_version_id" varchar(36),
	"project_instruction_version_id" varchar(36),
	"project_instruction_enabled" boolean NOT NULL,
	"governing_policy_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_fingerprint" varchar(64) NOT NULL,
	"base_version" integer,
	"typed_diff_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" varchar(512) NOT NULL,
	"policy_decision_record_id" varchar(36) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_work_context_setups_scope_user_version" UNIQUE("space_id","work_context_scope_id","user_id","version"),
	CONSTRAINT "ck_work_context_setups_scope_kind" CHECK (scope_kind IN ('direct_session', 'room_recipient', 'root_task', 'workflow_execution')),
	CONSTRAINT "ck_work_context_setups_version_positive" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "capability_enablements" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"agent_id" varchar(36),
	"user_id" varchar(36),
	"capability_key" varchar(128) NOT NULL,
	"capability_version_id" varchar(36),
	"enabled" boolean NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_capability_enablements_config_object" CHECK (jsonb_typeof(config_json) = 'object'::text),
	CONSTRAINT "ck_capability_enablements_single_scope" CHECK (((((project_id IS NOT NULL))::integer + ((agent_id IS NOT NULL))::integer) + ((user_id IS NOT NULL))::integer) <= 1)
);
--> statement-breakpoint
CREATE TABLE "capability_runtime_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"capability_key" varchar(128) NOT NULL,
	"capability_version_id" varchar(36),
	"runtime_adapter_type" varchar(64) NOT NULL,
	"render_mode" varchar(32) NOT NULL,
	"binding_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_capability_runtime_bindings_version_space" CHECK (capability_version_id IS NULL OR space_id IS NOT NULL),
	CONSTRAINT "ck_capability_runtime_bindings_binding_object" CHECK (jsonb_typeof(binding_json) = 'object'::text),
	CONSTRAINT "ck_capability_runtime_bindings_render_mode" CHECK ((render_mode)::text = ANY (ARRAY[('render_skill'::character varying)::text, ('inline_prompt'::character varying)::text, ('native_executor'::character varying)::text, ('mcp_tool'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "capability_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"capability_key" varchar(128) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"parent_version_id" varchar(36),
	"version" varchar(64) NOT NULL,
	"source" varchar(32) NOT NULL,
	"artifact_uri" varchar(1024),
	"content_ref" varchar(1024),
	"content_hash" varchar(128),
	"status" varchar(32) NOT NULL,
	"proposal_id" varchar(36),
	"metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_capability_versions_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_capability_versions_status" CHECK (status IN ('draft', 'proposed', 'testing', 'available', 'disabled', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "skill_local_overlays" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"skill_package_id" varchar(36) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" varchar(128),
	"overlay_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_skill_local_overlays_overlay_object" CHECK (jsonb_typeof(overlay_json) = 'object'::text),
	CONSTRAINT "ck_skill_local_overlays_scope_id" CHECK ((((scope_type)::text = 'space'::text) AND (scope_id IS NULL)) OR (((scope_type)::text <> 'space'::text) AND (scope_id IS NOT NULL))),
	CONSTRAINT "ck_skill_local_overlays_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('space'::character varying)::text, ('project'::character varying)::text, ('project_folder'::character varying)::text, ('agent'::character varying)::text, ('user'::character varying)::text])),
	CONSTRAINT "ck_skill_local_overlays_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "skill_package_files" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"skill_package_id" varchar(36) NOT NULL,
	"path" text NOT NULL,
	"kind" varchar(64) NOT NULL,
	"content_hash" varchar(128),
	"content_type" varchar(256),
	"byte_length" integer,
	"storage_ref" text,
	"included" boolean DEFAULT true NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"risk_flags_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_skill_package_files_byte_length" CHECK ((byte_length IS NULL) OR (byte_length >= 0)),
	CONSTRAINT "ck_skill_package_files_path_nonempty" CHECK (length(path) > 0),
	CONSTRAINT "ck_skill_package_files_risk_flags_object" CHECK (jsonb_typeof(risk_flags_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "skill_packages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"source_id" varchar(36) NOT NULL,
	"package_name" varchar(256) NOT NULL,
	"version" varchar(64),
	"license" varchar(128),
	"raw_storage_ref" text,
	"manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"normalized_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_level" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_skill_packages_manifest_object" CHECK (jsonb_typeof(manifest_json) = 'object'::text),
	CONSTRAINT "ck_skill_packages_normalized_object" CHECK (jsonb_typeof(normalized_json) = 'object'::text),
	CONSTRAINT "ck_skill_packages_risk_level" CHECK ((risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])),
	CONSTRAINT "ck_skill_packages_status" CHECK ((status)::text = ANY (ARRAY[('imported'::character varying)::text, ('reviewed'::character varying)::text, ('rejected'::character varying)::text, ('converted'::character varying)::text, ('archived'::character varying)::text, ('superseded'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "skill_sources" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"source_type" varchar(32) NOT NULL,
	"url" text,
	"repo" varchar(512),
	"path" text,
	"ref" varchar(256),
	"commit_sha" varchar(128),
	"content_hash" varchar(128) NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_by_user_id" varchar(36),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_skill_sources_content_hash_nonempty" CHECK (length((content_hash)::text) > 0),
	CONSTRAINT "ck_skill_sources_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_skill_sources_source_type" CHECK ((source_type)::text = ANY (ARRAY[('github'::character varying)::text, ('registry'::character varying)::text, ('local_workspace'::character varying)::text, ('upload'::character varying)::text, ('builtin'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "card_review_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"card_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"due_at" timestamp with time zone,
	"stability" double precision,
	"difficulty" double precision,
	"elapsed_days" double precision,
	"scheduled_days" double precision,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"state" varchar(32),
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_card_review_states_card_user" UNIQUE("card_id","user_id"),
	CONSTRAINT "ck_card_review_states_state" CHECK ((state IS NULL) OR ((state)::text = ANY (ARRAY[('new'::character varying)::text, ('learning'::character varying)::text, ('review'::character varying)::text, ('relearning'::character varying)::text])))
);
--> statement-breakpoint
CREATE TABLE "card_reviews" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"card_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"rating" varchar(16) NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"review_state_snapshot_json" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_card_reviews_rating" CHECK ((rating)::text = ANY (ARRAY[('again'::character varying)::text, ('hard'::character varying)::text, ('good'::character varying)::text, ('easy'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"card_type" varchar(32) NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"source_type" varchar(32),
	"source_id" varchar(36),
	"status" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"metadata_json" jsonb,
	CONSTRAINT "ck_cards_card_type" CHECK ((card_type)::text = ANY (ARRAY[('basic'::character varying)::text, ('cloze'::character varying)::text])),
	CONSTRAINT "ck_cards_source_type_format" CHECK ((source_type IS NULL) OR ((source_type)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
	CONSTRAINT "ck_cards_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('suspended'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "content_access_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(36) NOT NULL,
	"grantee_user_id" varchar(36) NOT NULL,
	"granted_by_user_id" varchar(36) NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36),
	CONSTRAINT "uq_content_access_grants_resource_grantee" UNIQUE("space_id","resource_type","resource_id","grantee_user_id"),
	CONSTRAINT "ck_content_access_grants_access_level" CHECK (access_level IN ('full', 'summary'))
);
--> statement-breakpoint
CREATE TABLE "content_access_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"viewer_user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36),
	"run_id" varchar(36),
	"access_type" varchar(64) NOT NULL,
	"reason" varchar(512),
	"accessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_content_access_logs_cross_person" CHECK (viewer_user_id <> owner_user_id),
	CONSTRAINT "ck_content_access_logs_resource_type" CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "content_demotion_disclosures" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"target_visibility" varchar(32) NOT NULL,
	"exposure_snapshot_json" jsonb NOT NULL,
	"disclosed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "ck_content_demotion_disclosures_target_visibility" CHECK (target_visibility IN ('private', 'selected_users')),
	CONSTRAINT "ck_content_demotion_disclosures_resource_type" CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "space_object_project_shares" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"shared_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36),
	CONSTRAINT "uq_space_object_project_shares_object_project" UNIQUE("space_id","object_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "content_egress_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"source_space_id" varchar(36) NOT NULL,
	"actor_user_id" varchar(36) NOT NULL,
	"target_personal_space_id" varchar(36) NOT NULL,
	"target_artifact_id" varchar(36) NOT NULL,
	"disclosure_id" varchar(36) NOT NULL,
	"source_pointers_json" jsonb NOT NULL,
	"notification_enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_space_egress_disclosures" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"personal_space_id" varchar(36) NOT NULL,
	"pointer_ids_json" jsonb NOT NULL,
	"settings_snapshot_json" jsonb NOT NULL,
	"disclosed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cross_space_retrieval_pointers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"resource_space_id" varchar(36) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_cross_space_retrieval_pointer_session_resource" UNIQUE("session_id","resource_space_id","resource_type","resource_id"),
	CONSTRAINT "ck_cross_space_retrieval_pointers_resource_type" CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "cross_space_retrieval_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"personal_space_id" varchar(36) NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_cross_space_retrieval_sessions_id_user" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "space_member_notifications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"recipient_user_id" varchar(36) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"pointer_metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "ck_space_member_notifications_event_type" CHECK (event_type IN ('egress_notification_setting_changed', 'content_egress'))
);
--> statement-breakpoint
CREATE TABLE "decision_cases" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"framing" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"decided_option_id" varchar(36),
	"decided_at" timestamp with time zone,
	"decided_by_user_id" varchar(36),
	CONSTRAINT "uq_decision_cases_id_space_id" UNIQUE("object_id","space_id"),
	CONSTRAINT "uq_decision_cases_id_project_space" UNIQUE("object_id","project_id","space_id"),
	CONSTRAINT "ck_decision_cases_status" CHECK ((status)::text = ANY (ARRAY[('open'::character varying)::text, ('decided'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_decision_cases_decided_pairing" CHECK ((status)::text <> 'decided'::text OR (decided_option_id IS NOT NULL AND decided_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "decision_commitments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"decision_case_id" varchar(36) NOT NULL,
	"statement" text NOT NULL,
	"committed_by_user_id" varchar(36),
	"committed_at" timestamp with time zone NOT NULL,
	"created_delivery_task_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_criteria" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"decision_case_id" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"weight" integer DEFAULT 3 NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_decision_criteria_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_decision_criteria_id_case_space" UNIQUE("id","decision_case_id","space_id"),
	CONSTRAINT "ck_decision_criteria_weight" CHECK (weight BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "decision_option_scores" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"decision_case_id" varchar(36) NOT NULL,
	"option_id" varchar(36) NOT NULL,
	"criterion_id" varchar(36) NOT NULL,
	"score" integer NOT NULL,
	"rationale" text,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_decision_option_scores_option_criterion" UNIQUE("option_id","criterion_id"),
	CONSTRAINT "ck_decision_option_scores_score" CHECK (score BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "decision_options" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"decision_case_id" varchar(36) NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_decision_options_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_decision_options_id_case_space" UNIQUE("id","decision_case_id","space_id"),
	CONSTRAINT "ck_decision_options_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('withdrawn'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "domain_change_outbox" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_id" varchar(36) NOT NULL,
	"source_ref_json" jsonb NOT NULL,
	"change_kind" varchar(48) NOT NULL,
	"change_significance" varchar(16),
	"occurred_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" varchar(36),
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "uq_domain_change_outbox_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_domain_change_outbox_source_kind" CHECK ((source_kind)::text = ANY (ARRAY[('note'::character varying)::text, ('inquiry_thread'::character varying)::text, ('experiment_interpretation'::character varying)::text])),
	CONSTRAINT "ck_domain_change_outbox_significance" CHECK (change_significance IS NULL OR (change_significance)::text = ANY (ARRAY[('trivial'::character varying)::text, ('material'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "evolution_bundle_members" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"bundle_id" varchar(36) NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"position" integer NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"decision_note" text,
	"decided_by_user_id" varchar(36),
	"decided_at" timestamp with time zone,
	"before_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolution_bundle_members_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('released'::character varying)::text, ('rolled_back'::character varying)::text, ('rollback_failed'::character varying)::text])),
	CONSTRAINT "ck_evolution_bundle_members_position" CHECK (position > 0),
	CONSTRAINT "ck_evolution_bundle_members_before_snapshot_object" CHECK (jsonb_typeof(before_snapshot_json) = 'object'::text),
	CONSTRAINT "ck_evolution_bundle_members_after_snapshot_object" CHECK (jsonb_typeof(after_snapshot_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "evolution_bundles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"title" varchar(256) NOT NULL,
	"description" text,
	"status" varchar(32) DEFAULT 'pending_review' NOT NULL,
	"risk_level" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"rollback_error" text,
	CONSTRAINT "ck_evolution_bundles_status" CHECK ((status)::text = ANY (ARRAY[('pending_review'::character varying)::text, ('partially_approved'::character varying)::text, ('applied'::character varying)::text, ('rejected'::character varying)::text, ('rolled_back'::character varying)::text, ('rollback_failed'::character varying)::text])),
	CONSTRAINT "ck_evolution_bundles_risk_level" CHECK ((risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "evolution_experiences" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"strategy_asset_id" varchar(36),
	"target_id" varchar(36),
	"source_run_id" varchar(36),
	"source_proposal_id" varchar(36),
	"experience_key" varchar(160) NOT NULL,
	"summary" text NOT NULL,
	"trigger_signals_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome_status" varchar(32) NOT NULL,
	"confidence_score" double precision DEFAULT 0.5 NOT NULL,
	"blast_radius_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_trace_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"execution_trace_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lessons_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"anti_patterns_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment_fingerprint_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance_type" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolution_experiences_confidence_score" CHECK ((confidence_score >= (0)::double precision) AND (confidence_score <= (1)::double precision)),
	CONSTRAINT "ck_evolution_experiences_outcome_status" CHECK ((outcome_status)::text = ANY (ARRAY[('success'::character varying)::text, ('failed'::character varying)::text, ('partial'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_evolution_experiences_provenance_type" CHECK ((provenance_type)::text = ANY (ARRAY[('run_observed'::character varying)::text, ('proposal_accepted'::character varying)::text, ('imported'::character varying)::text, ('user_authored'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "evolution_selector_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"target_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"selected_strategy_asset_id" varchar(36),
	"candidate_strategy_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_signal_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision_reason" text,
	"score_trace_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rejected_reasons_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evolution_signals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"target_id" varchar(36) NOT NULL,
	"signal_type" varchar(128) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_id" varchar(128),
	"severity" varchar(32) NOT NULL,
	"summary" text,
	"payload_json" jsonb NOT NULL,
	"triage_status" varchar(32) DEFAULT 'new' NOT NULL,
	"triaged_at" timestamp with time zone,
	"triaged_by_user_id" varchar(36),
	"triage_note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolution_signals_triage_status" CHECK ((triage_status)::text = ANY (ARRAY[('new'::character varying)::text, ('acknowledged'::character varying)::text, ('dismissed'::character varying)::text, ('actioned'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "evolution_strategy_assets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"strategy_key" varchar(128) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"category" varchar(32) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"risk_level" varchar(32) NOT NULL,
	"signals_match_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preconditions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strategy_steps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"routing_hint_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance_type" varchar(32) NOT NULL,
	"source_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"confidence_score" double precision DEFAULT 0.5 NOT NULL,
	"last_selected_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolution_strategy_assets_category" CHECK ((category)::text = ANY (ARRAY[('repair'::character varying)::text, ('optimize'::character varying)::text, ('innovate'::character varying)::text, ('maintain'::character varying)::text, ('harden'::character varying)::text, ('review'::character varying)::text])),
	CONSTRAINT "ck_evolution_strategy_assets_confidence_score" CHECK ((confidence_score >= (0)::double precision) AND (confidence_score <= (1)::double precision)),
	CONSTRAINT "ck_evolution_strategy_assets_counts" CHECK ((success_count >= 0) AND (failure_count >= 0)),
	CONSTRAINT "ck_evolution_strategy_assets_provenance_type" CHECK ((provenance_type)::text = ANY (ARRAY[('built_in'::character varying)::text, ('user_authored'::character varying)::text, ('imported'::character varying)::text, ('evolved'::character varying)::text, ('distilled'::character varying)::text])),
	CONSTRAINT "ck_evolution_strategy_assets_risk_level" CHECK ((risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])),
	CONSTRAINT "ck_evolution_strategy_assets_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('disabled'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_evolution_strategy_assets_target_type" CHECK ((target_type)::text = ANY (ARRAY[('agent_version'::character varying)::text, ('capability'::character varying)::text, ('runtime_skill_binding'::character varying)::text, ('memory'::character varying)::text, ('knowledge'::character varying)::text, ('workflow'::character varying)::text, ('project_folder'::character varying)::text, ('system'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "evolution_targets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"target_type" varchar(64) NOT NULL,
	"target_ref_type" varchar(64),
	"target_ref_id" varchar(128),
	"capability_key" varchar(128),
	"current_version_id" varchar(36),
	"risk_level" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"engine_policy_json" jsonb NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolution_targets_current_version_space" CHECK (current_version_id IS NULL OR space_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "run_reflections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"source" varchar(32) DEFAULT 'native' NOT NULL,
	"what_changed" text,
	"what_worked" text,
	"what_failed" text,
	"reusable_rules_json" jsonb,
	"reusable_commands_json" jsonb,
	"project_folder_facts_json" jsonb,
	"memory_candidates_json" jsonb,
	"capability_candidates_json" jsonb,
	"policy_candidates_json" jsonb,
	"validation_candidates_json" jsonb,
	"follow_up_tasks_json" jsonb,
	"confidence" double precision,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_run_reflections_source" CHECK ((source)::text = ANY (ARRAY[('native'::character varying)::text, ('external_import'::character varying)::text, ('manual'::character varying)::text, ('evaluator'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "focus_areas" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "uq_focus_areas_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_focus_areas_name_nonempty" CHECK (length(trim(name)) > 0)
);
--> statement-breakpoint
CREATE TABLE "evaluation_cases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"asset_id" varchar(36) NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expectation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verification_recipe_json" jsonb NOT NULL,
	"baseline_output_json" jsonb NOT NULL,
	"baseline_version_id" varchar(36) NOT NULL,
	"source_run_id" varchar(36),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evaluation_cases_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_evaluation_cases_input_object" CHECK (jsonb_typeof(input_json) = 'object'::text),
	CONSTRAINT "ck_evaluation_cases_expectation_object" CHECK (jsonb_typeof(expectation_json) = 'object'::text),
	CONSTRAINT "ck_evaluation_cases_recipe_object" CHECK (jsonb_typeof(verification_recipe_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "evolvable_asset_evaluation_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"asset_id" varchar(36) NOT NULL,
	"candidate_version_id" varchar(36) NOT NULL,
	"baseline_version_id" varchar(36),
	"evolution_target_id" varchar(36),
	"run_id" varchar(36),
	"eval_suite_ref_json" jsonb NOT NULL,
	"evaluator_version" varchar(64) NOT NULL,
	"model_provider_ref_json" jsonb,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"metrics_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blockers_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_artifact_id" varchar(36),
	"report_artifact_id" varchar(36),
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolvable_asset_evaluation_runs_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('passed'::character varying)::text, ('failed'::character varying)::text, ('blocked'::character varying)::text, ('cancelled'::character varying)::text])),
	CONSTRAINT "ck_evolvable_asset_evaluation_runs_metrics_object" CHECK (jsonb_typeof(metrics_json) = 'object'::text),
	CONSTRAINT "ck_evolvable_asset_evaluation_runs_blockers_array" CHECK (jsonb_typeof(blockers_json) = 'array'::text)
);
--> statement-breakpoint
CREATE TABLE "evolvable_asset_pins" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"asset_id" varchar(36) NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"pinned_by_user_id" varchar(36),
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolvable_asset_pins_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text])),
	CONSTRAINT "ck_evolvable_asset_pins_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "evolvable_asset_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"asset_id" varchar(36) NOT NULL,
	"space_id" varchar(36),
	"scope_type" varchar(16) NOT NULL,
	"scope_id" varchar(36),
	"parent_version_id" varchar(36),
	"version" integer NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"source" varchar(16) NOT NULL,
	"content_ref" varchar(1024),
	"content_hash" varchar(128),
	"content_json" jsonb,
	"eval_summary_json" jsonb,
	"promotion_proposal_id" varchar(36),
	"created_by_user_id" varchar(36),
	"approved_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolvable_asset_versions_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('system'::character varying)::text, ('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text])),
	CONSTRAINT "ck_evolvable_asset_versions_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('candidate'::character varying)::text, ('testing'::character varying)::text, ('approved'::character varying)::text, ('deprecated'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_evolvable_asset_versions_source" CHECK ((source)::text = ANY (ARRAY[('built_in'::character varying)::text, ('user_authored'::character varying)::text, ('evolved'::character varying)::text, ('imported'::character varying)::text, ('generated'::character varying)::text])),
	CONSTRAINT "ck_evolvable_asset_versions_version_positive" CHECK (version > 0)
);
--> statement-breakpoint
CREATE TABLE "evolvable_assets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"asset_type" varchar(32) NOT NULL,
	"asset_key" varchar(160) NOT NULL,
	"display_name" varchar(256) NOT NULL,
	"description" text,
	"owner_scope_type" varchar(16) NOT NULL,
	"owner_scope_id" varchar(36),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"current_system_version_id" varchar(36),
	"default_eval_suite_ref_json" jsonb,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evolvable_assets_asset_type" CHECK ((asset_type)::text = ANY (ARRAY[('prompt_template'::character varying)::text, ('workflow_template'::character varying)::text, ('agent_config'::character varying)::text, ('runtime_skill_binding'::character varying)::text, ('source_post_processing_rule'::character varying)::text])),
	CONSTRAINT "ck_evolvable_assets_owner_scope_type" CHECK ((owner_scope_type)::text = ANY (ARRAY[('system'::character varying)::text, ('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text])),
	CONSTRAINT "ck_evolvable_assets_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_evolvable_assets_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "experiment_definitions" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"objective" text,
	"primary_hypothesis_thread_id" varchar(36),
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"baseline_run_id" varchar(36),
	"best_run_id" varchar(36),
	CONSTRAINT "uq_experiment_definitions_id_space_id" UNIQUE("object_id","space_id"),
	CONSTRAINT "uq_experiment_definitions_id_project_space" UNIQUE("object_id","project_id","space_id"),
	CONSTRAINT "ck_experiment_definitions_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('paused'::character varying)::text, ('completed'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "experiment_interpretations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"definition_id" varchar(36) NOT NULL,
	"run_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" varchar(16) NOT NULL,
	"conclusion" text,
	"negative_results" text,
	"limitations" text,
	"repro_lock_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"resulting_signal_id" varchar(36),
	"reviewed_by_user_id" varchar(36),
	"reviewed_at" timestamp with time zone,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_experiment_interpretations_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_experiment_interpretations_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_experiment_interpretations_verdict" CHECK ((verdict)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('inconclusive'::character varying)::text])),
	CONSTRAINT "ck_experiment_interpretations_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('reviewed'::character varying)::text, ('converted'::character varying)::text])),
	CONSTRAINT "ck_experiment_interpretations_run_ids_array" CHECK (jsonb_typeof(run_ids_json) = 'array'::text),
	CONSTRAINT "ck_experiment_interpretations_converted_has_signal" CHECK ((status)::text <> 'converted'::text OR resulting_signal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "experiment_observations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"metric_name" varchar(128) NOT NULL,
	"value_number" double precision,
	"value_text" text,
	"value_json" jsonb,
	"is_primary" boolean DEFAULT false NOT NULL,
	"source" varchar(16) DEFAULT 'manual' NOT NULL,
	"recorded_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_experiment_observations_source" CHECK ((source)::text = ANY (ARRAY[('manual'::character varying)::text, ('parsed'::character varying)::text, ('agent'::character varying)::text])),
	CONSTRAINT "ck_experiment_observations_value_present" CHECK (value_number IS NOT NULL OR value_text IS NOT NULL OR value_json IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "experiment_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"is_baseline" boolean DEFAULT false NOT NULL,
	"hypothesis" text,
	"patch_summary" text,
	"commit_ref" varchar(128),
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"config_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"artifact_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_experiment_runs_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_experiment_runs_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text])),
	CONSTRAINT "ck_experiment_runs_artifact_ids_array" CHECK (jsonb_typeof(artifact_ids_json) = 'array'::text)
);
--> statement-breakpoint
CREATE TABLE "experiment_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"definition_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"executor_type" varchar(32) NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"planned_summary" text,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_experiment_versions_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_experiment_versions_executor_type" CHECK ((executor_type)::text = ANY (ARRAY[('manual'::character varying)::text, ('managed_code_comparison'::character varying)::text])),
	CONSTRAINT "ck_experiment_versions_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('approved'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_experiment_versions_config_object" CHECK (jsonb_typeof(config_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "graph_view_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"scope_key" varchar(128) NOT NULL,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_graph_view_states_scope" UNIQUE("scope_key","space_id","user_id"),
	CONSTRAINT "ck_graph_view_states_state_object" CHECK (jsonb_typeof(state_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "imported_session_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"imported_session_id" varchar(36) NOT NULL,
	"record_key" varchar(256) NOT NULL,
	"content_hash" varchar(128) NOT NULL,
	"conflict_hash" varchar(128),
	"kind" varchar(32) NOT NULL,
	"sequence" integer NOT NULL,
	"occurred_at" timestamp with time zone,
	"text" text,
	"tool_name" varchar(256),
	"tool_status" varchar(64),
	"tool_input" text,
	"tool_output" text,
	"raw_json" jsonb,
	"truncated" boolean DEFAULT false NOT NULL,
	"parser_version" varchar(64) NOT NULL,
	"extracted_in" varchar(48),
	"extracted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_imported_session_records_key" UNIQUE("imported_session_id","record_key"),
	CONSTRAINT "ck_imported_session_records_kind" CHECK ((kind)::text = ANY (ARRAY[('user_message'::character varying)::text, ('agent_message'::character varying)::text, ('tool_call'::character varying)::text, ('plan'::character varying)::text, ('unknown'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "imported_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"workspace_location_id" varchar(36),
	"execution_host_id" varchar(36),
	"owner_user_id" varchar(36) NOT NULL,
	"adapter_type" varchar(64) NOT NULL,
	"installation" varchar(64) NOT NULL,
	"vendor_session_id" varchar(256) NOT NULL,
	"cwd" varchar(1024),
	"title" varchar(512),
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"source_state" varchar(16) DEFAULT 'present' NOT NULL,
	"load_state" varchar(16) DEFAULT 'complete' NOT NULL,
	"last_error" text,
	"record_count" integer DEFAULT 0 NOT NULL,
	"first_record_at" timestamp with time zone,
	"last_record_at" timestamp with time zone,
	"vendor_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_seen_on_host_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_imported_sessions_source" UNIQUE("workspace_location_id","adapter_type","installation","vendor_session_id"),
	CONSTRAINT "ck_imported_sessions_visibility" CHECK ((visibility)::text = ANY (ARRAY[('private'::character varying)::text, ('space_shared'::character varying)::text, ('selected_users'::character varying)::text])),
	CONSTRAINT "ck_imported_sessions_access_level" CHECK ((access_level)::text = ANY (ARRAY[('full'::character varying)::text, ('summary'::character varying)::text])),
	CONSTRAINT "ck_imported_sessions_source_state" CHECK ((source_state)::text = ANY (ARRAY[('present'::character varying)::text, ('gone'::character varying)::text])),
	CONSTRAINT "ck_imported_sessions_load_state" CHECK ((load_state)::text = ANY (ARRAY[('complete'::character varying)::text, ('partial'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "imported_history_summaries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"imported_session_id" varchar(36) NOT NULL,
	"summary_text" text NOT NULL,
	"covered_through_record_at" timestamp with time zone,
	"covered_record_count" integer NOT NULL,
	"source_truncated" boolean DEFAULT false NOT NULL,
	"source_token_estimate" integer NOT NULL,
	"summary_token_estimate" integer NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"provider_id" varchar(36),
	"model" varchar(128),
	"usage_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_imported_history_summaries_session" UNIQUE("imported_session_id")
);
--> statement-breakpoint
CREATE TABLE "inquiry_hypothesis_states" (
	"thread_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"proposed_claim" text,
	"predictions" text,
	"falsification_criteria" text,
	"evaluation_state" varchar(16) DEFAULT 'untested' NOT NULL,
	"confidence" integer,
	"confidence_method" varchar(32),
	CONSTRAINT "ck_inquiry_hypothesis_states_evaluation_state" CHECK ((evaluation_state)::text = ANY (ARRAY[('untested'::character varying)::text, ('supported'::character varying)::text, ('challenged'::character varying)::text, ('contradicted'::character varying)::text, ('inconclusive'::character varying)::text])),
	CONSTRAINT "ck_inquiry_hypothesis_states_confidence" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100))
);
--> statement-breakpoint
CREATE TABLE "inquiry_iterations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"trigger_kind" varchar(32) DEFAULT 'user_edit' NOT NULL,
	"trigger_ref" varchar(128),
	"input_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_position_json" jsonb NOT NULL,
	"new_position_json" jsonb NOT NULL,
	"confidence_delta" integer,
	"change_summary" text NOT NULL,
	"reasoning_summary" text,
	"unresolved_gaps" text,
	"confirmed_next_focus" varchar(32),
	"created_by_user_id" varchar(36),
	"created_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_inquiry_iterations_id_project_space" UNIQUE("id","project_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "inquiry_project_settings" (
	"project_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"shared_focus_wip_limit" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_inquiry_project_settings_wip_limit" CHECK (shared_focus_wip_limit >= 1)
);
--> statement-breakpoint
CREATE TABLE "inquiry_question_states" (
	"thread_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"current_answer_summary" text,
	"answer_state" varchar(16) DEFAULT 'open' NOT NULL,
	"known_gaps" text,
	"answerability" text,
	"resolution_criteria" text,
	CONSTRAINT "ck_inquiry_question_states_answer_state" CHECK ((answer_state)::text = ANY (ARRAY[('open'::character varying)::text, ('partial'::character varying)::text, ('answered'::character varying)::text, ('unanswerable'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_lifecycle_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"from_status" varchar(24) NOT NULL,
	"to_status" varchar(24) NOT NULL,
	"reason" text,
	"actor_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_personal_focus" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_revisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"statement" text NOT NULL,
	"answer_state" varchar(16),
	"evaluation_state" varchar(16),
	"confidence" integer,
	"state_snapshot_json" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"change_significance" varchar(16) NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_inquiry_thread_revisions_kind" CHECK ((kind)::text = ANY (ARRAY[('question'::character varying)::text, ('hypothesis'::character varying)::text])),
	CONSTRAINT "ck_inquiry_thread_revisions_significance" CHECK ((change_significance)::text = ANY (ARRAY[('trivial'::character varying)::text, ('material'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_statement_revisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"revision_kind" varchar(16) NOT NULL,
	"previous_statement" text NOT NULL,
	"new_statement" text NOT NULL,
	"structure_action" varchar(16),
	"impact_note" text,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_inquiry_thread_statement_revisions_kind" CHECK ((revision_kind)::text = ANY (ARRAY[('wording_only'::character varying)::text, ('semantic_change'::character varying)::text])),
	CONSTRAINT "ck_inquiry_thread_statement_revisions_structure_action" CHECK (structure_action IS NULL OR (structure_action)::text = ANY (ARRAY[('narrow'::character varying)::text, ('child'::character varying)::text, ('supersede'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_steps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'in_progress' NOT NULL,
	"slot" varchar(16) DEFAULT 'primary' NOT NULL,
	"note" text,
	"target_ref_kind" varchar(32),
	"target_ref_id" varchar(36),
	"iteration_id" varchar(36),
	"origin" varchar(16) DEFAULT 'user' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_inquiry_thread_steps_kind" CHECK ((kind)::text = ANY (ARRAY[('clarify_or_decompose'::character varying)::text, ('search_acquisition'::character varying)::text, ('design_run_experiment'::character varying)::text, ('read_evidence'::character varying)::text, ('synthesize'::character varying)::text, ('promote_knowledge'::character varying)::text, ('create_decision_case'::character varying)::text, ('create_delivery_task'::character varying)::text])),
	CONSTRAINT "ck_inquiry_thread_steps_status" CHECK ((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('done'::character varying)::text, ('abandoned'::character varying)::text])),
	CONSTRAINT "ck_inquiry_thread_steps_slot" CHECK ((slot)::text = ANY (ARRAY[('primary'::character varying)::text, ('background'::character varying)::text])),
	CONSTRAINT "ck_inquiry_thread_steps_origin" CHECK ((origin)::text = ANY (ARRAY[('user'::character varying)::text, ('advice'::character varying)::text, ('system'::character varying)::text])),
	CONSTRAINT "ck_inquiry_thread_steps_completed_at" CHECK ((status = 'in_progress') = (completed_at IS NULL)),
	CONSTRAINT "ck_inquiry_thread_steps_target_ref" CHECK ((target_ref_kind IS NULL) = (target_ref_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_structure_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"action_kind" varchar(32) NOT NULL,
	"from_value_json" jsonb,
	"to_value_json" jsonb,
	"actor_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_inquiry_thread_structure_events_action" CHECK ((action_kind)::text = ANY (ARRAY[('relation_added'::character varying)::text, ('relation_removed'::character varying)::text, ('primary_parent_changed'::character varying)::text, ('definition_child_created'::character varying)::text, ('definition_superseded'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_work_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"action_kind" varchar(32) NOT NULL,
	"from_value" text,
	"to_value" text,
	"actor_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiry_threads" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"statement" text NOT NULL,
	"lifecycle_status" varchar(24) DEFAULT 'active' NOT NULL,
	"attention_state" varchar(16) DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"primary_parent_id" varchar(36),
	"next_focus_kind" varchar(32),
	"next_focus_note" text,
	"blocked_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_from" varchar(32) DEFAULT 'user' NOT NULL,
	"producer_idempotency_key" varchar(128),
	CONSTRAINT "uq_inquiry_threads_space_id_id" UNIQUE("object_id","space_id"),
	CONSTRAINT "uq_inquiry_threads_id_project_space" UNIQUE("object_id","project_id","space_id"),
	CONSTRAINT "ck_inquiry_threads_kind" CHECK ((kind)::text = ANY (ARRAY[('question'::character varying)::text, ('hypothesis'::character varying)::text])),
	CONSTRAINT "ck_inquiry_threads_lifecycle_status" CHECK ((lifecycle_status)::text = ANY (ARRAY[('active'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text, ('superseded'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_inquiry_threads_attention_state" CHECK ((attention_state)::text = ANY (ARRAY[('focused'::character varying)::text, ('monitoring'::character varying)::text, ('backlog'::character varying)::text, ('blocked'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_inquiry_threads_created_from" CHECK ((created_from)::text = ANY (ARRAY[('user'::character varying)::text, ('ai_candidate'::character varying)::text, ('decomposition'::character varying)::text])),
	CONSTRAINT "ck_inquiry_threads_focused_next_focus" CHECK (next_focus_kind IS NULL OR blocked_reason IS NULL),
	CONSTRAINT "ck_inquiry_threads_lifecycle_attention" CHECK (
		(lifecycle_status = 'active' AND attention_state IN ('focused', 'monitoring', 'backlog', 'blocked'))
		OR (lifecycle_status = 'resolved' AND attention_state = 'resolved')
		OR (lifecycle_status = 'rejected' AND attention_state = 'rejected')
		OR (lifecycle_status IN ('superseded', 'archived') AND attention_state = 'archived')
	)
);
--> statement-breakpoint
CREATE TABLE "inquiry_thread_advice" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"recommended_focus_kind" varchar(32) NOT NULL,
	"rationale" text NOT NULL,
	"cited_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_version" integer NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"trigger_kind" varchar(32) NOT NULL,
	"model_version" varchar(64),
	"generated_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_inquiry_thread_advice_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_inquiry_thread_advice_status" CHECK (status IN ('open', 'adopted', 'dismissed')),
	CONSTRAINT "ck_inquiry_thread_advice_refs_array" CHECK (jsonb_typeof(cited_refs_json) = 'array'),
	CONSTRAINT "ck_inquiry_thread_advice_rationale" CHECK (char_length(rationale) BETWEEN 1 AND 4000),
	CONSTRAINT "ck_inquiry_thread_advice_version" CHECK (thread_version >= 1)
);
--> statement-breakpoint
CREATE TABLE "inquiry_delta_briefs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"coverage_start" timestamp with time zone,
	"coverage_end" timestamp with time zone NOT NULL,
	"content_json" jsonb NOT NULL,
	"generated_by_user_id" varchar(36),
	"generated_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiry_evidence_signals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"corpus_item_id" varchar(36),
	"experiment_interpretation_id" varchar(36),
	"classification" varchar(16) NOT NULL,
	"is_material" boolean DEFAULT false NOT NULL,
	"confidence" double precision,
	"model_version" varchar(64),
	"source_provenance_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" varchar(64) NOT NULL,
	"producer_idempotency_key" varchar(128),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"candidate_id" varchar(36),
	"created_by_user_id" varchar(36),
	"created_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_inquiry_evidence_signals_classification" CHECK ((classification)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('adds_context'::character varying)::text, ('adds_method'::character varying)::text, ('fills_gap'::character varying)::text, ('raises_gap'::character varying)::text, ('unrelated'::character varying)::text])),
	CONSTRAINT "ck_inquiry_evidence_signals_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('auto_attached'::character varying)::text, ('consolidated'::character varying)::text, ('dismissed'::character varying)::text])),
	CONSTRAINT "ck_inquiry_evidence_signals_confidence" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	CONSTRAINT "ck_inquiry_evidence_signals_one_source" CHECK ((corpus_item_id IS NOT NULL) <> (experiment_interpretation_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "inquiry_review_packets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"opened_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "uq_inquiry_review_packets_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_inquiry_review_packets_status" CHECK ((status)::text = ANY (ARRAY[('open'::character varying)::text, ('closed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "inquiry_signal_candidates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"candidate_kind" varchar(32) NOT NULL,
	"semantic_key" varchar(128) NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"proposed_change_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"review_packet_id" varchar(36),
	"resulting_iteration_id" varchar(36),
	"resulting_thread_id" varchar(36),
	"merged_into_candidate_id" varchar(36),
	"decision_reason" text,
	"defer_until" timestamp with time zone,
	"decided_by_user_id" varchar(36),
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_inquiry_signal_candidates_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_inquiry_signal_candidates_kind" CHECK ((candidate_kind)::text = ANY (ARRAY[('new_thread'::character varying)::text, ('contradiction'::character varying)::text, ('confidence_tier_crossing'::character varying)::text, ('state_change'::character varying)::text, ('next_focus_replacement'::character varying)::text, ('scope_change'::character varying)::text, ('knowledge_promotion_ready'::character varying)::text])),
	CONSTRAINT "ck_inquiry_signal_candidates_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('merged'::character varying)::text, ('deferred'::character varying)::text, ('dismissed'::character varying)::text, ('gap'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "interest_profiles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_interest_profiles_space_user" UNIQUE("space_id","user_id"),
	CONSTRAINT "uq_interest_profiles_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_interest_profiles_settings" CHECK (jsonb_typeof(settings_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "interest_topic_candidates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"profile_id" varchar(36) NOT NULL,
	"phrase_key" varchar(128) NOT NULL,
	"display_phrase" varchar(128) NOT NULL,
	"domain_key" varchar(64),
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'accumulating' NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_interest_topic_candidates_profile_phrase" UNIQUE("profile_id","phrase_key"),
	CONSTRAINT "ck_interest_topic_candidates_status" CHECK (status IN ('accumulating','ready','dismissed')),
	CONSTRAINT "ck_interest_topic_candidates_counts" CHECK (occurrence_count >= 0 AND read_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "interest_topic_observations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"profile_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"counted_as_read" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_interest_topic_observations_profile_item" UNIQUE("profile_id","source_item_id")
);
--> statement-breakpoint
CREATE TABLE "interest_topics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"profile_id" varchar(36) NOT NULL,
	"topic_key" varchar(128) NOT NULL,
	"label" varchar(128) NOT NULL,
	"domain_key" varchar(64) NOT NULL,
	"aliases_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weight" double precision DEFAULT 1 NOT NULL,
	"origin" varchar(16) DEFAULT 'user' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_interest_topics_profile_key" UNIQUE("profile_id","topic_key"),
	CONSTRAINT "uq_interest_topics_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_interest_topics_origin" CHECK (origin IN ('user','agent')),
	CONSTRAINT "ck_interest_topics_status" CHECK (status IN ('active','archived')),
	CONSTRAINT "ck_interest_topics_weight" CHECK (weight >= 0),
	CONSTRAINT "ck_interest_topics_aliases" CHECK (jsonb_typeof(aliases_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "information_digest_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"digest_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"section" varchar(24) DEFAULT 'interest' NOT NULL,
	"position" integer NOT NULL,
	"quota_slot" varchar(64) NOT NULL,
	"matched_topic_id" varchar(36),
	"serendipity_pool_item_id" varchar(36),
	"score" double precision NOT NULL,
	"component_scores_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_information_digest_items_position" UNIQUE("digest_id","position"),
	CONSTRAINT "uq_information_digest_items_source" UNIQUE("digest_id","source_item_id"),
	CONSTRAINT "ck_information_digest_items_section" CHECK (section IN ('interest','serendipity')),
	CONSTRAINT "ck_information_digest_items_serendipity_origin" CHECK ((section = 'interest' AND serendipity_pool_item_id IS NULL) OR (section = 'serendipity' AND serendipity_pool_item_id IS NOT NULL)),
	CONSTRAINT "ck_information_digest_items_position" CHECK (position >= 0),
	CONSTRAINT "ck_information_digest_items_scores" CHECK (jsonb_typeof(component_scores_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "information_digest_probe_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"period_start" varchar(10) NOT NULL,
	"status" varchar(16) NOT NULL,
	"domain_keys_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"error_json" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uq_information_digest_probe_runs_period" UNIQUE("space_id","user_id","period_start"),
	CONSTRAINT "ck_information_digest_probe_runs_period" CHECK (period_start ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "ck_information_digest_probe_runs_status" CHECK (status IN ('running','succeeded','degraded','failed','skipped')),
	CONSTRAINT "ck_information_digest_probe_runs_domains" CHECK (jsonb_typeof(domain_keys_json) = 'array'),
	CONSTRAINT "ck_information_digest_probe_runs_counts" CHECK (request_count BETWEEN 0 AND 3 AND result_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "information_digest_serendipity_domain_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"domain_key" varchar(64) NOT NULL,
	"last_feedback" varchar(16) NOT NULL,
	"cooldown_until" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_information_digest_serendipity_domain_state" UNIQUE("space_id","user_id","domain_key"),
	CONSTRAINT "ck_information_digest_serendipity_domain_state_feedback" CHECK (last_feedback IN ('interesting','neutral','never')),
	CONSTRAINT "ck_information_digest_serendipity_domain_state_block" CHECK ((last_feedback = 'never' AND blocked_at IS NOT NULL AND cooldown_until IS NULL) OR (last_feedback <> 'never' AND blocked_at IS NULL AND cooldown_until IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "information_digest_serendipity_feedback" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"digest_item_id" varchar(36) NOT NULL,
	"domain_key" varchar(64) NOT NULL,
	"feedback" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_information_digest_serendipity_feedback_item" UNIQUE("digest_item_id"),
	CONSTRAINT "ck_information_digest_serendipity_feedback_value" CHECK (feedback IN ('interesting','neutral','never'))
);
--> statement-breakpoint
CREATE TABLE "information_digest_serendipity_pool" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36),
	"target_domain_key" varchar(64) NOT NULL,
	"discovery_origin" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'standby' NOT NULL,
	"probe_period" varchar(10),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"available_until" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "uq_information_digest_serendipity_pool_user_item" UNIQUE("space_id","user_id","source_item_id"),
	CONSTRAINT "uq_information_digest_serendipity_pool_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_information_digest_serendipity_pool_origin" CHECK (discovery_origin IN ('weekly_probe','source_recommendation')),
	CONSTRAINT "ck_information_digest_serendipity_pool_status" CHECK (status IN ('standby','consumed','expired')),
	CONSTRAINT "ck_information_digest_serendipity_pool_period" CHECK (probe_period IS NULL OR probe_period ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "ck_information_digest_serendipity_pool_metadata" CHECK (jsonb_typeof(metadata_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "information_digests" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"digest_type" varchar(16) NOT NULL,
	"owner_user_id" varchar(36),
	"project_id" varchar(36),
	"digest_date" varchar(10) NOT NULL,
	"profile_maturity" varchar(16),
	"status" varchar(16) DEFAULT 'ready' NOT NULL,
	"generated_by_run_id" varchar(36),
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_information_digests_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_information_digests_scope" CHECK ((digest_type = 'personal' AND owner_user_id IS NOT NULL AND project_id IS NULL) OR (digest_type = 'project' AND owner_user_id IS NULL AND project_id IS NOT NULL)),
	CONSTRAINT "ck_information_digests_date" CHECK (digest_date ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "ck_information_digests_maturity" CHECK (profile_maturity IS NULL OR profile_maturity IN ('cold','warming','warm')),
	CONSTRAINT "ck_information_digests_status" CHECK (status IN ('ready','empty','failed')),
	CONSTRAINT "ck_information_digests_settings" CHECK (jsonb_typeof(settings_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"job_id" varchar(36) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"job_type" varchar(128) NOT NULL,
	"status" varchar(32) NOT NULL,
	"priority" integer NOT NULL,
	"payload_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error" text,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" varchar(64),
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"user_id" varchar(36),
	"project_folder_id" varchar(36),
	"agent_id" varchar(36),
	CONSTRAINT "ck_jobs_attempts_nonneg" CHECK (attempts >= 0),
	CONSTRAINT "ck_jobs_max_attempts_positive" CHECK (max_attempts > 0),
	CONSTRAINT "ck_jobs_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('claimed'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "claim_sources" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"claim_id" varchar(36) NOT NULL,
	"source_object_id" varchar(36),
	"source_ref_type" varchar(64),
	"source_ref_id" varchar(36),
	"source_connection_id" varchar(36),
	"source_policy_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locator" varchar(1024),
	"quote_excerpt" text,
	"evidence_role" varchar(32) NOT NULL,
	"source_trust" varchar(32),
	"confidence" double precision,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_claim_sources_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_claim_sources_evidence_role" CHECK ((evidence_role)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('mentions'::character varying)::text, ('derived_from'::character varying)::text, ('cites'::character varying)::text, ('summarizes'::character varying)::text])),
	CONSTRAINT "ck_claim_sources_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_claim_sources_policy_snapshot_object" CHECK (jsonb_typeof(source_policy_snapshot_json) = 'object'::text),
	CONSTRAINT "ck_claim_sources_has_source" CHECK ((source_object_id IS NOT NULL) OR ((source_ref_type IS NOT NULL) AND (source_ref_id IS NOT NULL)) OR (source_connection_id IS NOT NULL)),
	CONSTRAINT "ck_claim_sources_source_ref" CHECK (((source_ref_type IS NULL) AND (source_ref_id IS NULL)) OR ((source_ref_type IS NOT NULL) AND (source_ref_id IS NOT NULL))),
	CONSTRAINT "ck_claim_sources_source_ref_connection" CHECK ((source_ref_type IS NULL) OR (source_connection_id IS NOT NULL)),
	CONSTRAINT "ck_claim_sources_source_ref_type" CHECK ((source_ref_type IS NULL) OR ((source_ref_type)::text = ANY (ARRAY[('activity'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('extracted_evidence'::character varying)::text, ('source_snapshot'::character varying)::text, ('external_pointer'::character varying)::text, ('source_item'::character varying)::text]))),
	CONSTRAINT "ck_claim_sources_source_trust" CHECK ((source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text, ('unknown'::character varying)::text])))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"subject_object_id" varchar(36),
	"subject_text" text,
	"claim_kind" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"claim_text" text NOT NULL,
	"normalized_claim_hash" varchar(128) NOT NULL,
	"holder_object_id" varchar(36),
	"holder_type" varchar(64),
	"holder_id" varchar(128),
	"confidence" double precision,
	"confidence_method" varchar(32) NOT NULL,
	"resolution_state" varchar(32) NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_from_proposal_id" varchar(36),
	"approved_by_user_id" varchar(36),
	CONSTRAINT "claims_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_claims_claim_kind" CHECK ((claim_kind)::text = ANY (ARRAY[('fact'::character varying)::text, ('hypothesis'::character varying)::text, ('belief'::character varying)::text, ('preference'::character varying)::text, ('commitment'::character varying)::text, ('question'::character varying)::text, ('interpretation'::character varying)::text, ('instruction'::character varying)::text, ('metric'::character varying)::text, ('relationship'::character varying)::text, ('event'::character varying)::text])),
	CONSTRAINT "ck_claims_claim_text" CHECK (btrim(claim_text) <> ''::text),
	CONSTRAINT "ck_claims_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_claims_confidence_method" CHECK ((confidence_method)::text = ANY (ARRAY[('human_confirmed'::character varying)::text, ('source_extracted'::character varying)::text, ('llm_extracted'::character varying)::text, ('inferred'::character varying)::text, ('imported'::character varying)::text])),
	CONSTRAINT "ck_claims_holder_ref" CHECK (((holder_object_id IS NOT NULL) AND (holder_type IS NULL) AND (holder_id IS NULL)) OR ((holder_object_id IS NULL) AND (((holder_type IS NULL) AND (holder_id IS NULL)) OR ((holder_type IS NOT NULL) AND (holder_id IS NOT NULL))))),
	CONSTRAINT "ck_claims_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_claims_resolution_state" CHECK ((resolution_state)::text = ANY (ARRAY[('unreviewed'::character varying)::text, ('confirmed'::character varying)::text, ('contradicted'::character varying)::text, ('stale'::character varying)::text, ('needs_source'::character varying)::text])),
	CONSTRAINT "ck_claims_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disputed'::character varying)::text, ('superseded'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_claims_subject" CHECK ((subject_object_id IS NOT NULL) OR ((subject_text IS NOT NULL) AND (btrim(subject_text) <> ''::text))),
	CONSTRAINT "ck_claims_valid_range" CHECK ((valid_from IS NULL) OR (valid_until IS NULL) OR (valid_from <= valid_until))
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"evidence_id" varchar(36) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(36),
	"link_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"confidence" double precision,
	"reason" varchar(1024),
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_evidence_links_link_type" CHECK ((link_type)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('derived_from'::character varying)::text, ('mentions'::character varying)::text, ('context_candidate'::character varying)::text, ('used_in_context'::character varying)::text])),
	CONSTRAINT "ck_evidence_links_status" CHECK ((status)::text = ANY (ARRAY[('candidate'::character varying)::text, ('active'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_evidence_links_target_type" CHECK ((target_type)::text = ANY (ARRAY[('space'::character varying)::text, ('project_folder'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text, ('run'::character varying)::text, ('proposal'::character varying)::text, ('artifact'::character varying)::text, ('knowledge'::character varying)::text, ('memory'::character varying)::text, ('task'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "extracted_evidence" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"owner_user_id" varchar(36),
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"source_item_id" varchar(36),
	"origin_source_item_id" varchar(36),
	"extraction_job_id" varchar(36),
	"source_snapshot_id" varchar(36),
	"source_object_type" varchar(64),
	"source_object_id" varchar(36),
	"evidence_type" varchar(64) NOT NULL,
	"title" varchar(1024) NOT NULL,
	"content_excerpt" varchar(4096),
	"content_hash" varchar(128),
	"artifact_id" varchar(36),
	"source_uri" text,
	"source_title" varchar(1024),
	"source_author" varchar(512),
	"occurred_at" timestamp with time zone,
	"trust_level" varchar(32) NOT NULL,
	"extraction_method" varchar(64) NOT NULL,
	"confidence" double precision,
	"status" varchar(32) NOT NULL,
	"metadata_json" jsonb,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_extracted_evidence_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_extracted_evidence_evidence_type" CHECK ((evidence_type)::text = ANY (ARRAY[('document'::character varying)::text, ('excerpt'::character varying)::text, ('event'::character varying)::text, ('log'::character varying)::text, ('artifact'::character varying)::text, ('claim'::character varying)::text, ('summary'::character varying)::text])),
	CONSTRAINT "ck_extracted_evidence_status" CHECK ((status)::text = ANY (ARRAY[('candidate'::character varying)::text, ('active'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_extracted_evidence_trust_level" CHECK ((trust_level)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text])),
	CONSTRAINT "ck_extracted_evidence_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_extracted_evidence_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_extracted_evidence_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "knowledge_item_sources" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"knowledge_item_id" varchar(36) NOT NULL,
	"source_id" varchar(36) NOT NULL,
	"relation_type" varchar(32) NOT NULL,
	"locator" varchar(1024),
	"quote" text,
	"note" text,
	"confidence" double precision,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_knowledge_item_sources_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_knowledge_item_sources_relation_type" CHECK ((relation_type)::text = ANY (ARRAY[('derived_from'::character varying)::text, ('supported_by'::character varying)::text, ('cites'::character varying)::text, ('summarizes'::character varying)::text, ('mentions'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"root_item_id" varchar(36),
	"supersedes_item_id" varchar(36),
	"knowledge_kind" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"slug" varchar(512),
	"aliases_json" jsonb,
	"content" text NOT NULL,
	"content_json" jsonb,
	"content_format" varchar(32) NOT NULL,
	"content_schema_version" integer NOT NULL,
	"plain_text" text,
	"verification_status" varchar(32) NOT NULL,
	"reflection_status" varchar(32) NOT NULL,
	"tags_json" jsonb NOT NULL,
	"confidence" double precision,
	"created_from_proposal_id" varchar(36),
	"approved_by_user_id" varchar(36),
	"redirect_to_item_id" varchar(36),
	"version" integer NOT NULL,
	"deprecated_at" timestamp with time zone,
	"pinned_source_ref_json" jsonb,
	CONSTRAINT "knowledge_items_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_knowledge_items_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_knowledge_items_content_format" CHECK ((content_format)::text = ANY (ARRAY[('markdown'::character varying)::text, ('plain'::character varying)::text, ('prosemirror_json'::character varying)::text])),
	CONSTRAINT "ck_knowledge_items_knowledge_kind" CHECK ((knowledge_kind)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('question'::character varying)::text, ('answer'::character varying)::text, ('summary'::character varying)::text])),
	CONSTRAINT "ck_knowledge_items_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text])),
	CONSTRAINT "ck_knowledge_items_reflection_status" CHECK ((reflection_status)::text = ANY (ARRAY[('unreviewed'::character varying)::text, ('reviewed'::character varying)::text, ('distilled'::character varying)::text])),
	CONSTRAINT "ck_knowledge_items_verification_status" CHECK ((verification_status)::text = ANY (ARRAY[('unverified'::character varying)::text, ('needs_review'::character varying)::text, ('verified'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "note_collection_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"collection_id" varchar(36) NOT NULL,
	"note_id" varchar(36) NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_note_collection_items_collection_note" UNIQUE("collection_id","note_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "note_collections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"parent_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"system_role" varchar(32) NOT NULL,
	"sort_order" integer NOT NULL,
	"is_system" boolean NOT NULL,
	"is_hidden" boolean NOT NULL,
	"project_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "note_collections_id_space_id_key" UNIQUE("id","space_id"),
	CONSTRAINT "ck_note_collections_not_self_parent" CHECK ((parent_id IS NULL) OR ((parent_id)::text <> (id)::text)),
	CONSTRAINT "ck_note_collections_system_role" CHECK ((system_role)::text = ANY (ARRAY[('normal'::character varying)::text, ('inbox'::character varying)::text, ('archive'::character varying)::text, ('project'::character varying)::text, ('projects_root'::character varying)::text])),
	CONSTRAINT "ck_note_collections_project_role" CHECK ((project_id IS NULL) OR (system_role = 'project'))
);
--> statement-breakpoint
CREATE TABLE "note_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"from_object_id" varchar(36) NOT NULL,
	"from_object_type" "retrieval_object_type" NOT NULL,
	"to_object_id" varchar(36) NOT NULL,
	"to_object_type" "retrieval_object_type" NOT NULL,
	"link_type" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"confidence" double precision,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_note_links_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_note_links_has_note_endpoint" CHECK (((from_object_type)::text = 'note'::text) OR ((to_object_type)::text = 'note'::text)),
	CONSTRAINT "ck_note_links_link_type" CHECK ((link_type)::text = ANY (ARRAY[('related_to'::character varying)::text, ('references'::character varying)::text, ('depends_on'::character varying)::text, ('part_of'::character varying)::text, ('source_for'::character varying)::text, ('derived_from'::character varying)::text, ('about'::character varying)::text, ('supports'::character varying)::text, ('contradicts'::character varying)::text, ('supersedes'::character varying)::text, ('refines'::character varying)::text, ('same_as'::character varying)::text, ('explains'::character varying)::text, ('prerequisite_of'::character varying)::text, ('example_of'::character varying)::text, ('applies_to'::character varying)::text, ('summarizes'::character varying)::text, ('updates'::character varying)::text])),
	CONSTRAINT "ck_note_links_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_note_links_no_self" CHECK ((from_object_id)::text <> (to_object_id)::text),
	CONSTRAINT "ck_note_links_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "note_revisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"note_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"content_json" jsonb NOT NULL,
	"normalized_text" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" varchar(24) NOT NULL,
	"diff_json" jsonb,
	"created_by_user_id" varchar(36),
	"created_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_note_revisions_version" UNIQUE("note_id","version"),
	CONSTRAINT "ck_note_revisions_version" CHECK (version >= 1),
	CONSTRAINT "ck_note_revisions_source" CHECK (source IN ('user_edit','ai_monitoring','ai_adhoc','seed','rollback')),
	CONSTRAINT "ck_note_revisions_refs_array" CHECK (jsonb_typeof(refs_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"content_json" jsonb,
	"content_format" varchar(32) NOT NULL,
	"content_schema_version" integer NOT NULL,
	"plain_text" text,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_from_activity_id" varchar(36),
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" varchar(64),
	"updated_by_user_id" varchar(36),
	"updated_by_run_id" varchar(36),
	"role_project_id" varchar(36),
	"project_role" varchar(64),
	"marginalia_project_id" varchar(36),
	"marginalia_owner_user_id" varchar(36),
	"marginalia_target_object_id" varchar(36),
	CONSTRAINT "notes_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_notes_content_format" CHECK ((content_format)::text = ANY (ARRAY[('markdown'::character varying)::text, ('plain'::character varying)::text, ('prosemirror_json'::character varying)::text])),
	CONSTRAINT "ck_notes_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text])),
	CONSTRAINT "ck_notes_marginalia_binding" CHECK (((marginalia_project_id IS NULL) = (marginalia_owner_user_id IS NULL)) AND ((marginalia_target_object_id IS NULL) OR (marginalia_owner_user_id IS NOT NULL))),
	CONSTRAINT "ck_notes_version" CHECK (version >= 1),
	CONSTRAINT "ck_notes_project_role_format" CHECK ((project_role IS NULL) OR ((project_role)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
	CONSTRAINT "ck_notes_project_role_pairing" CHECK ((project_role IS NULL) = (role_project_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "object_relations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"from_object_id" varchar(36) NOT NULL,
	"to_object_id" varchar(36) NOT NULL,
	"link_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"confidence" double precision,
	"evidence_summary" text,
	"source_claim_id" varchar(36),
	"source_object_id" varchar(36),
	"source_proposal_id" varchar(36),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_object_relations_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_object_relations_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_object_relations_no_self" CHECK ((from_object_id)::text <> (to_object_id)::text),
	CONSTRAINT "ck_object_relations_link_type_format" CHECK ((link_type)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text),
	CONSTRAINT "ck_object_relations_status" CHECK ((status)::text = ANY (ARRAY[('candidate'::character varying)::text, ('active'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "source_item_references" (
	"source_item_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"reference_object_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'raw' NOT NULL,
	"uri" text,
	"content_ref" varchar(1024),
	"raw_text" text,
	"summary" text,
	"metadata_json" jsonb NOT NULL,
	"source_activity_id" varchar(36),
	CONSTRAINT "sources_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_sources_source_type" CHECK ((source_type)::text = ANY (ARRAY[('activity_record'::character varying)::text, ('chat_capture'::character varying)::text, ('webpage'::character varying)::text, ('article'::character varying)::text, ('paper'::character varying)::text, ('pdf'::character varying)::text, ('file'::character varying)::text, ('email'::character varying)::text, ('manual_reference'::character varying)::text, ('external_note'::character varying)::text])),
	CONSTRAINT "ck_sources_status" CHECK ((status)::text = ANY (ARRAY[('raw'::character varying)::text, ('processing'::character varying)::text, ('processed'::character varying)::text, ('archived'::character varying)::text, ('error'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "space_object_profile_relation_hints" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_profile_id" varchar(36) NOT NULL,
	"endpoint_object_type" "retrieval_object_type" NOT NULL,
	"endpoint_object_profile_id" varchar(36),
	"link_type" varchar(64) NOT NULL,
	"direction" varchar(16) DEFAULT 'from' NOT NULL,
	"confidence_default" double precision DEFAULT 0.55 NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_space_object_profile_relation_hints_confidence" CHECK ((confidence_default >= (0)::double precision) AND (confidence_default <= (1)::double precision)),
	CONSTRAINT "ck_space_object_profile_relation_hints_direction" CHECK ((direction)::text = ANY (ARRAY[('from'::character varying)::text, ('to'::character varying)::text, ('either'::character varying)::text])),
	CONSTRAINT "ck_space_object_profile_relation_hints_link_type_format" CHECK ((link_type)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text)
);
--> statement-breakpoint
CREATE TABLE "space_object_profiles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"key" varchar(64) NOT NULL,
	"label" varchar(160) NOT NULL,
	"description" text,
	"base_object_type" "retrieval_object_type" NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field_schema_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extraction_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retrieval_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ui_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_from_proposal_id" varchar(36),
	"updated_from_proposal_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_object_profiles_space_base_key_key" UNIQUE("base_object_type","key","space_id"),
	CONSTRAINT "ck_space_object_profiles_extraction_policy_object" CHECK (jsonb_typeof(extraction_policy_json) = 'object'::text),
	CONSTRAINT "ck_space_object_profiles_field_schema_object" CHECK (jsonb_typeof(field_schema_json) = 'object'::text),
	CONSTRAINT "ck_space_object_profiles_key" CHECK ((key)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text),
	CONSTRAINT "ck_space_object_profiles_key_by_base_object_type" CHECK (CASE (base_object_type)::text
    WHEN 'knowledge_item'::text THEN ((key)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('question'::character varying)::text, ('answer'::character varying)::text, ('summary'::character varying)::text]))
    WHEN 'note'::text THEN ((key)::text = 'note'::text)
    WHEN 'source'::text THEN ((key)::text = ANY (ARRAY[('activity_record'::character varying)::text, ('chat_capture'::character varying)::text, ('webpage'::character varying)::text, ('article'::character varying)::text, ('paper'::character varying)::text, ('pdf'::character varying)::text, ('file'::character varying)::text, ('email'::character varying)::text, ('manual_reference'::character varying)::text, ('external_note'::character varying)::text]))
    WHEN 'claim'::text THEN ((key)::text = ANY (ARRAY[('fact'::character varying)::text, ('hypothesis'::character varying)::text, ('belief'::character varying)::text, ('preference'::character varying)::text, ('commitment'::character varying)::text, ('question'::character varying)::text, ('interpretation'::character varying)::text, ('instruction'::character varying)::text, ('metric'::character varying)::text, ('relationship'::character varying)::text, ('event'::character varying)::text]))
    WHEN 'memory_entry'::text THEN ((key)::text = ANY (ARRAY[('preference'::character varying)::text, ('semantic'::character varying)::text, ('episodic'::character varying)::text, ('procedural'::character varying)::text, ('project'::character varying)::text]))
    WHEN 'project_public_summary'::text THEN ((key)::text = 'project_public_summary'::text)
    WHEN 'source_item'::text THEN ((key)::text = ANY (ARRAY[('external_url'::character varying)::text, ('feed_entry'::character varying)::text, ('activity_record'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('file'::character varying)::text, ('document'::character varying)::text, ('log'::character varying)::text]))
    WHEN 'extracted_evidence'::text THEN ((key)::text = ANY (ARRAY[('document'::character varying)::text, ('excerpt'::character varying)::text, ('event'::character varying)::text, ('log'::character varying)::text, ('artifact'::character varying)::text, ('claim'::character varying)::text, ('summary'::character varying)::text]))
    ELSE false
END),
	CONSTRAINT "ck_space_object_profiles_retrieval_policy_object" CHECK (jsonb_typeof(retrieval_policy_json) = 'object'::text),
	CONSTRAINT "ck_space_object_profiles_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('deprecated'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_space_object_profiles_ui_config_object" CHECK (jsonb_typeof(ui_config_json) = 'object'::text),
	CONSTRAINT "ck_space_object_profiles_version_positive" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "space_objects" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_type" varchar(32) NOT NULL,
	"title" varchar(512) NOT NULL,
	"summary" text,
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"owner_user_id" varchar(36),
	"primary_project_id" varchar(36),
	"focus_area_id" varchar(36),
	"project_folder_id" varchar(36),
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "space_objects_id_space_id_key" UNIQUE("id","space_id"),
	CONSTRAINT "ck_space_objects_object_type_format" CHECK ((object_type)::text ~ '^[a-z][a-z0-9_]{0,31}$'::text),
	CONSTRAINT "ck_space_objects_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_space_objects_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_space_objects_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "knowledge_promotion_candidates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"trigger" varchar(16) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_id" varchar(36) NOT NULL,
	"source_ref_json" jsonb NOT NULL,
	"candidate_kind" varchar(32) NOT NULL,
	"proposed_title" varchar(512) NOT NULL,
	"proposed_content" text NOT NULL,
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"owner_user_id" varchar(36),
	"supersedes_knowledge_item_id" varchar(36),
	"review_packet_id" varchar(36),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_proposal_id" varchar(36),
	"created_by_user_id" varchar(36),
	"decided_by_user_id" varchar(36),
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_knowledge_promotion_candidates_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_knowledge_promotion_candidates_trigger" CHECK ((trigger)::text = ANY (ARRAY[('promotion'::character varying)::text, ('revalidation'::character varying)::text])),
	CONSTRAINT "ck_knowledge_promotion_candidates_source_kind" CHECK ((source_kind)::text = ANY (ARRAY[('note'::character varying)::text, ('inquiry_thread'::character varying)::text, ('experiment_interpretation'::character varying)::text])),
	CONSTRAINT "ck_knowledge_promotion_candidates_kind" CHECK ((candidate_kind)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('summary'::character varying)::text])),
	CONSTRAINT "ck_knowledge_promotion_candidates_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('deferred'::character varying)::text, ('promoted'::character varying)::text, ('dismissed'::character varying)::text])),
	CONSTRAINT "ck_knowledge_promotion_candidates_revalidation_target" CHECK ((trigger)::text <> 'revalidation'::text OR supersedes_knowledge_item_id IS NOT NULL),
	CONSTRAINT "ck_knowledge_promotion_candidates_visibility" CHECK (visibility IN ('private', 'space_shared')),
	CONSTRAINT "ck_knowledge_promotion_candidates_private_owner" CHECK (visibility='space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "knowledge_promotion_review_packets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"opened_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "uq_knowledge_promotion_review_packets_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_knowledge_promotion_review_packets_status" CHECK (status IN ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_revalidation_outcomes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"knowledge_item_id" varchar(36) NOT NULL,
	"event_id" varchar(36) NOT NULL,
	"outcome" varchar(24) NOT NULL,
	"resulting_candidate_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_knowledge_revalidation_outcomes_outcome" CHECK ((outcome)::text = ANY (ARRAY[('no_impact'::character varying)::text, ('candidate_created'::character varying)::text, ('already_superseded'::character varying)::text])),
	CONSTRAINT "ck_knowledge_revalidation_outcomes_candidate_pairing" CHECK ((outcome)::text <> 'candidate_created'::text OR resulting_candidate_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "learning_item_mastery" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"learning_item_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"mastery_state" varchar(16) DEFAULT 'new' NOT NULL,
	"correct_streak" integer DEFAULT 0 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_learning_item_mastery_state" CHECK ((mastery_state)::text = ANY (ARRAY[('new'::character varying)::text, ('learning'::character varying)::text, ('mastered'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "learning_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"objective_id" varchar(36),
	"knowledge_item_id" varchar(36) NOT NULL,
	"knowledge_item_version" integer NOT NULL,
	"item_kind" varchar(16) DEFAULT 'card' NOT NULL,
	"prompt" text NOT NULL,
	"answer" text NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_learning_items_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_learning_items_kind" CHECK ((item_kind)::text = ANY (ARRAY[('card'::character varying)::text, ('exercise'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "learning_objectives" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"title" varchar(512) NOT NULL,
	"description" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_learning_objectives_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_learning_objectives_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"memory_type" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"subject_user_id" varchar(36),
	"owner_user_id" varchar(36),
	"sensitivity_level" varchar(32) DEFAULT 'normal' NOT NULL,
	"last_confirmed_at" timestamp with time zone,
	"agent_id" varchar(36),
	"namespace" varchar(255),
	"title" varchar(512),
	"visibility" varchar(32) NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"confidence" double precision NOT NULL,
	"importance" double precision NOT NULL,
	"source_id" varchar(36),
	"created_by" varchar(64),
	"approved_by" varchar(64),
	"deleted_at" timestamp with time zone,
	"version" integer NOT NULL,
	"access_count" integer NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"tags" jsonb,
	"memory_layer" varchar(32),
	"event_time" timestamp with time zone,
	"event_type" varchar(64),
	"last_retrieved_at" timestamp with time zone,
	"root_memory_id" varchar(36),
	"supersedes_memory_id" varchar(36),
	"source_trust" varchar(32),
	"created_from_proposal_id" varchar(36),
	"project_id" varchar(36),
	CONSTRAINT "ck_memory_entries_memory_layer" CHECK ((memory_layer IS NULL) OR ((memory_layer)::text = ANY (ARRAY[('episodic'::character varying)::text, ('semantic'::character varying)::text]))),
	CONSTRAINT "ck_memory_entries_scope_type" CHECK (scope_type IN ('user', 'project')),
	CONSTRAINT "ck_memory_entries_scope_placement" CHECK ((scope_type = 'user' AND project_id IS NULL) OR (scope_type = 'project' AND project_id IS NOT NULL)),
	CONSTRAINT "ck_memory_entries_sensitivity_level" CHECK ((sensitivity_level)::text = ANY (ARRAY[('normal'::character varying)::text, ('sensitive'::character varying)::text, ('restricted'::character varying)::text, ('highly_restricted'::character varying)::text])),
	CONSTRAINT "ck_memory_entries_source_trust" CHECK ((source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('user_confirmed'::character varying)::text, ('internal_system'::character varying)::text, ('trusted_external'::character varying)::text, ('untrusted_external'::character varying)::text, ('agent_inferred'::character varying)::text]))),
	CONSTRAINT "ck_memory_entries_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_memory_entries_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_memory_entries_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL),
	CONSTRAINT "ck_memory_entries_highly_restricted_private" CHECK (sensitivity_level <> 'highly_restricted' OR visibility = 'private')
);
--> statement-breakpoint
CREATE TABLE "memory_maintenance_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"review_scope" varchar(32) DEFAULT 'private' NOT NULL,
	"scan_options_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" varchar(256),
	"total_scanned" integer DEFAULT 0 NOT NULL,
	"total_findings" integer DEFAULT 0 NOT NULL,
	"last_report_artifact_id" varchar(36),
	"last_packet_proposal_id" varchar(36),
	"error_message" text,
	"run_after" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ck_memory_maintenance_jobs_total_scanned" CHECK (total_scanned >= 0),
	CONSTRAINT "ck_memory_maintenance_jobs_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])),
	CONSTRAINT "ck_memory_maintenance_jobs_review_scope" CHECK ((review_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('space_ops'::character varying)::text])),
	CONSTRAINT "ck_memory_maintenance_jobs_total_findings" CHECK (total_findings >= 0)
);
--> statement-breakpoint
CREATE TABLE "memory_relations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_id" varchar(36) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(36) NOT NULL,
	"relation_type" varchar(64) NOT NULL,
	"confidence" double precision,
	"evidence_json" jsonb,
	"created_from_proposal_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_memory_relations_relation_type" CHECK ((relation_type)::text = ANY (ARRAY[('derived_from'::character varying)::text, ('supersedes'::character varying)::text, ('contradicts'::character varying)::text, ('related_to'::character varying)::text, ('caused_by'::character varying)::text, ('supports'::character varying)::text, ('applies_to'::character varying)::text, ('mentions'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "provenance_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(36) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_id" varchar(36) NOT NULL,
	"source_trust" varchar(32),
	"evidence_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_provenance_links_source_trust" CHECK ((source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('user_confirmed'::character varying)::text, ('internal_system'::character varying)::text, ('trusted_external'::character varying)::text, ('untrusted_external'::character varying)::text, ('agent_inferred'::character varying)::text]))),
	CONSTRAINT "ck_provenance_links_source_type_format" CHECK ((source_type)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text)
);
--> statement-breakpoint
CREATE TABLE "participation_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"personal_space_id" varchar(36) NOT NULL,
	"source_space_id" varchar(36) NOT NULL,
	"source_object_type" varchar(64) NOT NULL,
	"source_object_id" varchar(36) NOT NULL,
	"role" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_memory_grant_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"grant_id" varchar(36) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"actor_user_id" varchar(36),
	"run_id" varchar(36),
	"proposal_id" varchar(36),
	"source_space_id" varchar(36),
	"target_space_id" varchar(36),
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_personal_memory_grant_events_event_type" CHECK ((event_type)::text = ANY (ARRAY[('created'::character varying)::text, ('previewed'::character varying)::text, ('consuming'::character varying)::text, ('used'::character varying)::text, ('revoked'::character varying)::text, ('expired'::character varying)::text, ('failed'::character varying)::text, ('denied'::character varying)::text, ('egress_proposal_created'::character varying)::text, ('egress_approved'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "personal_memory_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"granting_user_id" varchar(36) NOT NULL,
	"personal_space_id" varchar(36) NOT NULL,
	"target_space_id" varchar(36) NOT NULL,
	"target_run_id" varchar(36) NOT NULL,
	"target_agent_id" varchar(36),
	"grant_scope" varchar(32) NOT NULL,
	"access_mode" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"memory_filter_json" jsonb,
	"read_expires_at" timestamp with time zone NOT NULL,
	"egress_review_expires_at" timestamp with time zone,
	"consume_started_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_stage" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_personal_memory_grants_access_mode" CHECK ((access_mode)::text = 'summary_only'::text),
	CONSTRAINT "ck_personal_memory_grants_grant_scope" CHECK ((grant_scope)::text = 'run'::text),
	CONSTRAINT "ck_personal_memory_grants_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('consuming'::character varying)::text, ('used'::character varying)::text, ('revoked'::character varying)::text, ('expired'::character varying)::text, ('failed'::character varying)::text])),
	CONSTRAINT "ck_personal_memory_grants_target_agent_id_null" CHECK (target_agent_id IS NULL)
);
--> statement-breakpoint
CREATE TABLE "code_patch_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"files_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'available' NOT NULL,
	"rolled_back_by_user_id" varchar(36),
	"rolled_back_at" timestamp with time zone,
	CONSTRAINT "ck_code_patch_snapshots_status" CHECK ((status)::text = ANY (ARRAY[('available'::character varying)::text, ('rolled_back'::character varying)::text, ('pruned'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "official_plugin_enablements" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"user_id" varchar(36),
	"plugin_id" varchar(128) NOT NULL,
	"enabled" boolean NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by_user_id" varchar(36),
	"disabled_at" timestamp with time zone,
	"disabled_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "official_plugin_enablements_settings_is_object" CHECK (jsonb_typeof(settings_json) = 'object'::text),
	CONSTRAINT "official_plugin_enablements_plugin_id_non_empty" CHECK ((plugin_id)::text <> ''::text),
	CONSTRAINT "official_plugin_enablements_scope_check" CHECK (((space_id IS NOT NULL) AND (user_id IS NULL)) OR ((space_id IS NULL) AND (user_id IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "official_plugin_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"plugin_id" varchar(128) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"actor_user_id" varchar(36),
	"target_user_id" varchar(36),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "official_plugin_events_event_type_non_empty" CHECK ((event_type)::text <> ''::text),
	CONSTRAINT "official_plugin_events_metadata_is_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "official_plugin_events_plugin_id_non_empty" CHECK ((plugin_id)::text <> ''::text)
);
--> statement-breakpoint
CREATE TABLE "plugin_installs" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" varchar(64) NOT NULL,
	"installed_version" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"source" varchar(16) DEFAULT 'official' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by_user_id" varchar(36),
	"package_hash" text,
	"manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "plugin_installs_plugin_id_unique" UNIQUE("plugin_id"),
	CONSTRAINT "plugin_installs_plugin_id_nonempty" CHECK (length(TRIM(BOTH FROM (plugin_id)::text)) > 0),
	CONSTRAINT "plugin_installs_source_valid" CHECK ((source)::text = ANY ((ARRAY['built_in'::character varying, 'official'::character varying, 'local'::character varying])::text[])),
	CONSTRAINT "plugin_installs_status_valid" CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'removed'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "plugin_migrations" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" varchar(64) NOT NULL,
	"plugin_version" varchar(32) NOT NULL,
	"migration_id" varchar(128) NOT NULL,
	"checksum" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'applied' NOT NULL,
	"error_message" text,
	CONSTRAINT "plugin_migrations_unique" UNIQUE("migration_id","plugin_id"),
	CONSTRAINT "plugin_migrations_status_valid" CHECK ((status)::text = ANY ((ARRAY['applied'::character varying, 'failed'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "plan_node_dependencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"plan_version_id" varchar(36) NOT NULL,
	"node_id" varchar(36) NOT NULL,
	"depends_on_node_id" varchar(36) NOT NULL,
	"dependency_type" varchar(32) DEFAULT 'requires' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_plan_node_dependencies_edge" UNIQUE("node_id","depends_on_node_id")
);
--> statement-breakpoint
CREATE TABLE "plan_node_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"plan_node_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"role" varchar(32) DEFAULT 'primary' NOT NULL,
	"resolved_inputs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_plan_node_runs_node_run" UNIQUE("plan_node_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "plan_nodes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"plan_version_id" varchar(36) NOT NULL,
	"node_key" varchar(128) NOT NULL,
	"node_kind" varchar(32) NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"status" varchar(64) DEFAULT 'inbox' NOT NULL,
	"assigned_agent_id" varchar(36),
	"runtime_profile_id" varchar(36),
	"capability_id" varchar(128),
	"prompt_asset_key" varchar(256),
	"risk_level" varchar(32) DEFAULT 'low' NOT NULL,
	"acceptance_criteria_json" jsonb,
	"definition_of_done" text,
	"required_outputs_json" jsonb,
	"input_bindings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_runs" integer,
	"max_cost" double precision,
	"max_duration_seconds" integer,
	"policy_json" jsonb,
	"verification_recipe_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_sources_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blocked_reason" text,
	"content_hash" varchar(128) NOT NULL,
	"approval_proposal_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_plan_nodes_version_key" UNIQUE("plan_version_id","node_key"),
	CONSTRAINT "uq_plan_nodes_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_plan_nodes_status" CHECK (status IN ('inbox', 'ready', 'in_progress', 'blocked', 'waiting_for_review', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"reference_workflow_version_id" varchar(36),
	"planner_mode" varchar(32) DEFAULT 'agent' NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"approval_proposal_id" varchar(36),
	"planning_run_id" varchar(36),
	"planning_tool_call_id" varchar(256),
	"node_count" integer NOT NULL,
	"depth" integer NOT NULL,
	"budget_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"definition_json" jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_plan_versions_plan_version" UNIQUE("plan_id","version"),
	CONSTRAINT "uq_plan_versions_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_plan_versions_planning_call" UNIQUE("planning_run_id","planning_tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"project_id" varchar(36),
	"source_task_id" varchar(36) NOT NULL,
	"root_run_id" varchar(36),
	"current_plan_version_id" varchar(36),
	"name" varchar(512) NOT NULL,
	"description" text,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_plans_source_task_id" UNIQUE("source_task_id"),
	CONSTRAINT "uq_plans_id_space_id" UNIQUE("id","space_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"domain" varchar(64) NOT NULL,
	"policy_json" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"policy_key" varchar(256),
	"policy_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"enforcement_mode" varchar(32),
	"priority" integer DEFAULT 0 NOT NULL,
	"rule_json" jsonb,
	"applies_to_json" jsonb,
	"supersedes_policy_id" varchar(36),
	"created_from_proposal_id" varchar(36),
	CONSTRAINT "ck_policies_enforcement_mode" CHECK ((enforcement_mode IS NULL) OR ((enforcement_mode)::text = ANY (ARRAY[('allow'::character varying)::text, ('deny'::character varying)::text, ('require_approval'::character varying)::text, ('allow_with_log'::character varying)::text]))),
	CONSTRAINT "ck_policies_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "policy_decision_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"actor_type" varchar(64),
	"actor_id" varchar(36),
	"actor_ref_json" jsonb,
	"action" varchar(128) NOT NULL,
	"resource_type" varchar(64),
	"resource_id" varchar(256),
	"decision" varchar(32) NOT NULL,
	"risk_level" varchar(32) NOT NULL,
	"required_approver_role" varchar(32),
	"approval_capability" varchar(128),
	"policy_rule_id" varchar(128),
	"policy_source" varchar(64),
	"policy_id" varchar(36),
	"audit_code" varchar(128),
	"run_id" varchar(36),
	"proposal_id" varchar(36),
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_policy_decision_records_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_policy_decision_records_decision" CHECK ((decision)::text = ANY (ARRAY[('allow'::character varying)::text, ('deny'::character varying)::text, ('require_approval'::character varying)::text])),
	CONSTRAINT "ck_policy_decision_records_risk_level" CHECK ((risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "prompt_deployment_refs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"asset_id" varchar(36) NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" varchar(36),
	"label" varchar(64) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"promoted_by_user_id" varchar(36),
	"promoted_from_proposal_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_prompt_deployment_refs_label" CHECK ((label)::text ~ '^[a-z][a-z0-9_.-]{0,63}$'::text),
	CONSTRAINT "ck_prompt_deployment_refs_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('system'::character varying)::text, ('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text])),
	CONSTRAINT "ck_prompt_deployment_refs_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_prompt_deployment_refs_scope_id" CHECK ((((scope_type)::text = 'system'::text) AND (scope_id IS NULL)) OR (((scope_type)::text <> 'system'::text) AND (scope_id IS NOT NULL))),
	CONSTRAINT "ck_prompt_deployment_refs_space_id" CHECK ((((scope_type)::text = 'system'::text) AND (space_id IS NULL)) OR (((scope_type)::text <> 'system'::text) AND (space_id IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "project_corpus_item_sources" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"corpus_item_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_corpus_item_sources_item_source" UNIQUE("corpus_item_id","source_item_id")
);
--> statement-breakpoint
CREATE TABLE "project_corpus_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"object_id" varchar(36),
	"source_item_id" varchar(36),
	"evidence_id" varchar(36),
	"source_connection_id" varchar(36),
	"source_decision_id" varchar(36),
	"role" varchar(32) DEFAULT 'candidate' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"triage_status" varchar(32) DEFAULT 'new' NOT NULL,
	"triage_confirmed_by_user" boolean DEFAULT false NOT NULL,
	"read_status" varchar(32) DEFAULT 'unread' NOT NULL,
	"relevance" varchar(32),
	"confidence" double precision,
	"reason" text,
	"added_by_user_id" varchar(36),
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	CONSTRAINT "uq_project_corpus_items_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_project_corpus_items_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_project_corpus_items_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_project_corpus_items_exactly_one_target" CHECK (num_nonnulls(object_id, source_item_id, evidence_id) = 1),
	CONSTRAINT "ck_project_corpus_items_metadata_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_project_corpus_items_read_status" CHECK ((read_status)::text = ANY (ARRAY[('unread'::character varying)::text, ('skimmed'::character varying)::text, ('read'::character varying)::text, ('discussed'::character varying)::text])),
	CONSTRAINT "ck_project_corpus_items_relevance" CHECK ((relevance IS NULL) OR ((relevance)::text = ANY (ARRAY[('relevant'::character varying)::text, ('maybe'::character varying)::text, ('not_relevant'::character varying)::text]))),
	CONSTRAINT "ck_project_corpus_items_role" CHECK ((role)::text = ANY (ARRAY[('candidate'::character varying)::text, ('reference'::character varying)::text, ('primary'::character varying)::text, ('related'::character varying)::text, ('background'::character varying)::text])),
	CONSTRAINT "ck_project_corpus_items_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_project_corpus_items_triage_status" CHECK ((triage_status)::text = ANY (ARRAY[('new'::character varying)::text, ('relevant'::character varying)::text, ('maybe'::character varying)::text, ('excluded'::character varying)::text, ('included'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "project_research_checkpoints" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"workflow_id" varchar(36) NOT NULL,
	"stage_key" varchar(64) NOT NULL,
	"checkpoint_type" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"machine_result_json" jsonb,
	"user_decision" varchar(16),
	"decision_reason" text,
	"decided_by_user_id" varchar(36),
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_research_checkpoints_checkpoint_type" CHECK ((checkpoint_type)::text = ANY (ARRAY[('screening_gate'::character varying)::text, ('idea_review'::character varying)::text, ('integrity_gate'::character varying)::text, ('manuscript_gate'::character varying)::text, ('review_gate'::character varying)::text, ('other'::character varying)::text])),
	CONSTRAINT "ck_project_research_checkpoints_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('waived'::character varying)::text])),
	CONSTRAINT "ck_project_research_checkpoints_user_decision" CHECK ((user_decision IS NULL) OR ((user_decision)::text = ANY (ARRAY[('approved'::character varying)::text, ('rejected'::character varying)::text, ('waived'::character varying)::text])))
);
--> statement-breakpoint
CREATE TABLE "project_research_claim_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"workflow_id" varchar(36),
	"claim_id" varchar(36) NOT NULL,
	"support_status" varchar(32) DEFAULT 'unsupported' NOT NULL,
	"planned_experiment_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citation_anchors_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unresolved_gap" boolean DEFAULT false NOT NULL,
	"gap_reason" text,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_research_claim_links_support_status" CHECK ((support_status)::text = ANY (ARRAY[('unsupported'::character varying)::text, ('supported'::character varying)::text, ('partial'::character varying)::text, ('gap_declared'::character varying)::text])),
	CONSTRAINT "ck_project_research_claim_links_planned_experiment_ids_array" CHECK (jsonb_typeof(planned_experiment_ids_json) = 'array'::text),
	CONSTRAINT "ck_project_research_claim_links_citation_anchors_array" CHECK (jsonb_typeof(citation_anchors_json) = 'array'::text)
);
--> statement-breakpoint
CREATE TABLE "project_research_question_assessment_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"turn_index" integer NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"status" varchar(16) DEFAULT 'complete' NOT NULL,
	"structured_output_json" jsonb,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_research_question_assessment_messages_turn" CHECK (turn_index >= 1),
	CONSTRAINT "ck_project_research_question_assessment_messages_role" CHECK (role IN ('user', 'assistant')),
	CONSTRAINT "ck_project_research_question_assessment_messages_status" CHECK (status IN ('pending', 'complete', 'failed')),
	CONSTRAINT "ck_project_research_question_assessment_messages_content" CHECK (char_length(content) BETWEEN 1 AND 20000),
	CONSTRAINT "ck_project_research_question_assessment_messages_structured_object" CHECK (structured_output_json IS NULL OR jsonb_typeof(structured_output_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "project_research_question_assessment_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"recommended_question" text,
	"latest_refinement_json" jsonb,
	"assessment_baseline_json" jsonb,
	"research_context_version_id" varchar(36),
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_research_question_assessment_sessions_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_project_research_question_assessment_sessions_refinement_object" CHECK (latest_refinement_json IS NULL OR jsonb_typeof(latest_refinement_json) = 'object'::text),
	CONSTRAINT "ck_project_research_question_assessment_sessions_baseline_object" CHECK (assessment_baseline_json IS NULL OR jsonb_typeof(assessment_baseline_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "project_research_reports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"workflow_id" varchar(36) NOT NULL,
	"operation_id" varchar(36) NOT NULL,
	"synthesis_run_id" varchar(36) NOT NULL,
	"run_kind" varchar(32) NOT NULL,
	"research_question" text NOT NULL,
	"research_question_version" integer NOT NULL,
	"status" varchar(32) DEFAULT 'awaiting_review' NOT NULL,
	"content_json" jsonb NOT NULL,
	"reader_document_json" jsonb NOT NULL,
	"normalized_text" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"archive_artifact_id" varchar(36) NOT NULL,
	"evidence_matrix_artifact_id" varchar(36),
	"integrity_artifact_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_research_reports_run_kind" CHECK (run_kind IN ('baseline', 'historical_backfill', 'incremental', 'question_rescreen', 'synthesis_only')),
	CONSTRAINT "ck_project_research_reports_status" CHECK (status IN ('awaiting_review', 'complete', 'rejected')),
	CONSTRAINT "ck_project_research_reports_question_version" CHECK (research_question_version >= 1),
	CONSTRAINT "ck_project_research_reports_content_object" CHECK (jsonb_typeof(content_json) = 'object'::text),
	CONSTRAINT "ck_project_research_reports_reader_object" CHECK (jsonb_typeof(reader_document_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "project_research_screening_criteria" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"include_keywords_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclude_keywords_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"domain_criteria_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"date_range_start" timestamp with time zone,
	"date_range_end" timestamp with time zone,
	"source_restrictions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_evidence_fields_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_research_screening_criteria_include_keywords_array" CHECK (jsonb_typeof(include_keywords_json) = 'array'::text),
	CONSTRAINT "ck_project_research_screening_criteria_exclude_keywords_array" CHECK (jsonb_typeof(exclude_keywords_json) = 'array'::text),
	CONSTRAINT "ck_project_research_screening_criteria_domain_criteria_object" CHECK (jsonb_typeof(domain_criteria_json) = 'object'::text),
	CONSTRAINT "ck_project_research_screening_criteria_source_restrictions_array" CHECK (jsonb_typeof(source_restrictions_json) = 'array'::text),
	CONSTRAINT "ck_project_research_screening_criteria_evidence_fields_array" CHECK (jsonb_typeof(required_evidence_fields_json) = 'array'::text),
	CONSTRAINT "ck_project_research_screening_criteria_date_range" CHECK ((date_range_start IS NULL) OR (date_range_end IS NULL) OR (date_range_start <= date_range_end))
);
--> statement-breakpoint
CREATE TABLE "project_research_standing_advice" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"batch_id" varchar(36) NOT NULL,
	"detail" text NOT NULL,
	"affected_sections_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"action_id" varchar(128) NOT NULL,
	"action_input_json" jsonb NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_by_run_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_research_standing_advice_project_source" UNIQUE("space_id","project_id","source_item_id"),
	CONSTRAINT "uq_project_research_standing_advice_idempotency" UNIQUE("space_id","idempotency_key"),
	CONSTRAINT "ck_project_research_standing_advice_status" CHECK (status IN ('open','actioned','dismissed')),
	CONSTRAINT "ck_project_research_standing_advice_sections_array" CHECK (jsonb_typeof(affected_sections_json) = 'array'),
	CONSTRAINT "ck_project_research_standing_advice_action_input_object" CHECK (jsonb_typeof(action_input_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "project_research_standing_batches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"source_item_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"run_id" varchar(36),
	"missing_baseline_role" varchar(32),
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uq_project_research_standing_batches_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_project_research_standing_batches_status" CHECK (status IN ('pending','running','completed','blocked_baseline','budget_exhausted','failed')),
	CONSTRAINT "ck_project_research_standing_batches_items_array" CHECK (jsonb_typeof(source_item_ids_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "project_research_workflows" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"current_stage" varchar(64),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_by_user_id" varchar(36),
	"started_run_id" varchar(36),
	CONSTRAINT "uq_project_research_workflows_id_space_id" UNIQUE("object_id","space_id"),
	CONSTRAINT "uq_project_research_workflows_id_project_space" UNIQUE("object_id","project_id","space_id"),
	CONSTRAINT "ck_project_research_workflows_status" CHECK ((status)::text = ANY (ARRAY[('not_started'::character varying)::text, ('active'::character varying)::text, ('paused'::character varying)::text, ('completed'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_project_research_workflows_state_object" CHECK (jsonb_typeof(state_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "research_scan_summaries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"workflow_id" varchar(36),
	"operation_id" varchar(36),
	"scan_key" varchar(256) NOT NULL,
	"scan_window_start" timestamp with time zone,
	"scan_window_end" timestamp with time zone,
	"scanned_at" timestamp with time zone NOT NULL,
	"new_item_count" integer DEFAULT 0 NOT NULL,
	"relevant_count" integer DEFAULT 0 NOT NULL,
	"maybe_count" integer DEFAULT 0 NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"supports_count" integer DEFAULT 0 NOT NULL,
	"contradicts_count" integer DEFAULT 0 NOT NULL,
	"new_direction_count" integer DEFAULT 0 NOT NULL,
	"comparisons_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"integrity_alerts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_research_scan_summaries_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_research_scan_summaries_nonnegative_counts" CHECK (new_item_count >= 0 AND relevant_count >= 0 AND maybe_count >= 0 AND excluded_count >= 0 AND supports_count >= 0 AND contradicts_count >= 0 AND new_direction_count >= 0),
	CONSTRAINT "ck_research_scan_summaries_comparisons_array" CHECK (jsonb_typeof(comparisons_json) = 'array'),
	CONSTRAINT "ck_research_scan_summaries_integrity_alerts_array" CHECK (jsonb_typeof(integrity_alerts_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "project_research_context_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"objective" text NOT NULL,
	"context_json" jsonb NOT NULL,
	"assessment_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_research_context_versions_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "uq_project_research_context_versions_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_project_research_context_versions_version" CHECK (version >= 1),
	CONSTRAINT "ck_project_research_context_versions_objective" CHECK (char_length(objective) BETWEEN 1 AND 2000),
	CONSTRAINT "ck_project_research_context_versions_json" CHECK (jsonb_typeof(context_json)='object' AND jsonb_typeof(assessment_json)='object' AND jsonb_typeof(provenance_json)='object')
);
--> statement-breakpoint
CREATE TABLE "research_query_attempts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"provider_plan_id" varchar(36) NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"sequence" integer NOT NULL,
	"direction" varchar(16) NOT NULL,
	"semantic_query_json" jsonb NOT NULL,
	"compiled_query_json" jsonb NOT NULL,
	"query_fingerprint" varchar(128) NOT NULL,
	"provider_hit_count" integer,
	"accessible_hit_count" integer,
	"sample_summary_json" jsonb,
	"relevance_metrics_json" jsonb,
	"score" double precision,
	"decision" varchar(16),
	"decision_reason" text,
	"error_class" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uq_research_query_attempts_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "uq_research_query_attempts_id_plan_space" UNIQUE("id","provider_plan_id","space_id"),
	CONSTRAINT "ck_research_query_attempts_round" CHECK (round >= 0),
	CONSTRAINT "ck_research_query_attempts_sequence" CHECK (sequence BETWEEN 1 AND 4),
	CONSTRAINT "ck_research_query_attempts_direction" CHECK (direction IN ('initial','broaden','narrow')),
	CONSTRAINT "ck_research_query_attempts_decision" CHECK (decision IS NULL OR decision IN ('accept','broaden','narrow','stop')),
	CONSTRAINT "ck_research_query_attempts_counts" CHECK ((provider_hit_count IS NULL OR provider_hit_count >= 0) AND (accessible_hit_count IS NULL OR accessible_hit_count >= 0)),
	CONSTRAINT "ck_research_query_attempts_json" CHECK (jsonb_typeof(semantic_query_json)='object' AND jsonb_typeof(compiled_query_json)='object' AND (sample_summary_json IS NULL OR jsonb_typeof(sample_summary_json)='object') AND (relevance_metrics_json IS NULL OR jsonb_typeof(relevance_metrics_json)='object'))
);
--> statement-breakpoint
CREATE TABLE "research_query_performance_observations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"strategy_id" varchar(36) NOT NULL,
	"scan_summary_id" varchar(36) NOT NULL,
	"new_candidate_count" integer NOT NULL,
	"screened_count" integer NOT NULL,
	"accepted_count" integer NOT NULL,
	"duplicate_rate" double precision NOT NULL,
	"queue_latency_ms" integer,
	"core_concept_coverage" double precision,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_research_query_performance_counts" CHECK (new_candidate_count >= 0 AND screened_count >= 0 AND accepted_count >= 0 AND accepted_count <= screened_count),
	CONSTRAINT "ck_research_query_performance_rates" CHECK (duplicate_rate BETWEEN 0 AND 1 AND (core_concept_coverage IS NULL OR core_concept_coverage BETWEEN 0 AND 1)),
	CONSTRAINT "ck_research_query_performance_latency" CHECK (queue_latency_ms IS NULL OR queue_latency_ms >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_query_provider_plans" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"strategy_id" varchar(36) NOT NULL,
	"provider_key" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"terminal_decision" varchar(16),
	"decision_reason" text,
	"coverage_warning" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_research_query_provider_plans_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_research_query_provider_plans_provider" CHECK (provider_key IN ('arxiv','openalex','semantic_scholar','web_search')),
	CONSTRAINT "ck_research_query_provider_plans_status" CHECK (status IN ('pending','evaluating','selected','unavailable','failed')),
	CONSTRAINT "ck_research_query_provider_plans_decision" CHECK (terminal_decision IS NULL OR terminal_decision IN ('accept','broaden','narrow','stop'))
);
--> statement-breakpoint
CREATE TABLE "research_query_provider_selections" (
	"provider_plan_id" varchar(36) PRIMARY KEY NOT NULL,
	"attempt_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"selected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_research_query_provider_selections_attempt" UNIQUE("attempt_id")
);
--> statement-breakpoint
CREATE TABLE "research_query_strategies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"operation_id" varchar(36),
	"research_context_version_id" varchar(36) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"question_snapshot" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"execution_budget_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer NOT NULL,
	"parent_strategy_id" varchar(36),
	"adaptation_direction" varchar(16),
	"created_at" timestamp with time zone NOT NULL,
	"selected_at" timestamp with time zone,
	"materialized_at" timestamp with time zone,
	CONSTRAINT "uq_research_query_strategies_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_research_query_strategies_status" CHECK (status IN ('planning','evaluating','selected','materialized','failed')),
	CONSTRAINT "ck_research_query_strategies_question" CHECK (char_length(question_snapshot) BETWEEN 1 AND 2000),
	CONSTRAINT "ck_research_query_strategies_json" CHECK (jsonb_typeof(policy_json)='object' AND jsonb_typeof(execution_budget_json)='object'),
	CONSTRAINT "ck_research_query_strategies_version" CHECK (version >= 1),
	CONSTRAINT "ck_research_query_strategies_adaptation" CHECK (adaptation_direction IS NULL OR adaptation_direction IN ('broaden','narrow','rollback'))
);
--> statement-breakpoint
CREATE TABLE "research_query_strategy_activations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"research_context_version_id" varchar(36) NOT NULL,
	"strategy_id" varchar(36) NOT NULL,
	"previous_strategy_id" varchar(36),
	"sequence" integer NOT NULL,
	"reason" varchar(32) NOT NULL,
	"proposal_id" varchar(36),
	"activated_by_user_id" varchar(36) NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "ck_research_query_activation_sequence" CHECK (sequence >= 1),
	CONSTRAINT "ck_research_query_activation_reason" CHECK (reason IN ('initial','monitoring_feedback','rollback','manual'))
);
--> statement-breakpoint
CREATE TABLE "research_checklist_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"text" text NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"sort_order" integer NOT NULL,
	"origin" varchar(16) NOT NULL,
	"origin_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_research_checklist_items_status" CHECK (status IN ('open','done','dismissed')),
	CONSTRAINT "ck_research_checklist_items_origin" CHECK (origin IN ('user','agent')),
	CONSTRAINT "ck_research_checklist_items_sort" CHECK (sort_order >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_evidence_cards" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"object_id" varchar(36),
	"why_md" text DEFAULT '' NOT NULL,
	"how_md" text DEFAULT '' NOT NULL,
	"what_md" text DEFAULT '' NOT NULL,
	"provenance_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"stance" varchar(24),
	"comparison_detail" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_research_evidence_cards_project_source" UNIQUE("space_id","project_id","source_item_id"),
	CONSTRAINT "ck_research_evidence_cards_stance" CHECK (stance IS NULL OR stance IN ('supports','contradicts','new_direction'))
);
--> statement-breakpoint
CREATE TABLE "research_integrity_alerts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36),
	"doi" varchar(512) NOT NULL,
	"event_key" varchar(64) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"source" varchar(64) NOT NULL,
	"notice_doi" varchar(512),
	"detail_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_research_integrity_alerts_event" UNIQUE("space_id","project_id","event_key"),
	CONSTRAINT "ck_research_integrity_alerts_event_type" CHECK (event_type IN ('retraction','correction','expression_of_concern','reinstatement')),
	CONSTRAINT "ck_research_integrity_alerts_detail_object" CHECK (jsonb_typeof(detail_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "project_source_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"binding_key" varchar(128) DEFAULT 'default' NOT NULL,
	"status" varchar(32) NOT NULL,
	"priority" integer NOT NULL,
	"delivery_scope" varchar(32) DEFAULT 'project_members' NOT NULL,
	"collection_notifications_enabled" boolean DEFAULT true NOT NULL,
	"standing_comparison_enabled" boolean DEFAULT false NOT NULL,
	"filters_json" jsonb NOT NULL,
	"routing_policy_json" jsonb NOT NULL,
	"extraction_policy_json" jsonb NOT NULL,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_source_bindings_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_project_source_bindings_project_channel" UNIQUE("binding_key","project_id","source_channel_id","space_id"),
	CONSTRAINT "ck_project_source_bindings_delivery_scope" CHECK ((delivery_scope)::text = ANY (ARRAY[('project_members'::character varying)::text, ('source_subscribers'::character varying)::text])),
	CONSTRAINT "ck_project_source_bindings_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_project_source_bindings_extraction_policy_object" CHECK (jsonb_typeof(extraction_policy_json) = 'object'::text),
	CONSTRAINT "ck_project_source_bindings_profile_key_format" CHECK (NOT (extraction_policy_json ? 'profile_key') OR (jsonb_typeof(extraction_policy_json->'profile_key') = 'string'::text AND char_length(extraction_policy_json->>'profile_key') BETWEEN 1 AND 128 AND (extraction_policy_json->>'profile_key') ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'))
);
--> statement-breakpoint
CREATE TABLE "project_source_item_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"project_source_binding_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36),
	"source_connection_id" varchar(36),
	"source_item_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"matched_at" timestamp with time zone NOT NULL,
	"match_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_source_item_links_binding_item" UNIQUE("project_source_binding_id","project_id","source_item_id","space_id"),
	CONSTRAINT "ck_project_source_item_links_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "project_operation_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"operation_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(256) NOT NULL,
	"role" varchar(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_operation_links_target" UNIQUE("operation_id","target_type","target_id"),
	CONSTRAINT "ck_project_operation_links_target_type" CHECK (target_type IN ('run','job','proposal','artifact','source_backfill_plan','project_source_binding','corpus_sync','research_workflow'))
);
--> statement-breakpoint
CREATE TABLE "project_operation_steps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"operation_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"seq" integer NOT NULL,
	"title" varchar(256) NOT NULL,
	"status" varchar(16) NOT NULL,
	"detail_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "uq_project_operation_steps_seq" UNIQUE("operation_id","seq"),
	CONSTRAINT "ck_project_operation_steps_status" CHECK (status IN ('pending','active','blocked','done','skipped'))
);
--> statement-breakpoint
CREATE TABLE "project_operations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"title" varchar(256) NOT NULL,
	"intent_text" text,
	"status" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36),
	"initiating_run_id" varchar(36),
	"plan_artifact_id" varchar(36),
	"progress_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"current_execution_id" varchar(36),
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_operations_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "uq_project_operations_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_project_operations_kind" CHECK (kind IN ('source_setup','source_backfill','research','custom')),
	CONSTRAINT "ck_project_operations_status" CHECK (status IN ('draft','active','waiting_review','completed','failed','cancelled')),
	CONSTRAINT "ck_project_operations_version" CHECK (version >= 1),
	CONSTRAINT "ck_project_operations_generation" CHECK (generation >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_attention_user_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_id" varchar(36) NOT NULL,
	"seen_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_brief_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"version" varchar(16) NOT NULL,
	"goal" text,
	"scope_included" text,
	"scope_excluded" text,
	"success_definition" text,
	"constraints" text,
	"assumptions" text,
	"project_status" varchar(32) NOT NULL,
	"current_focus" text,
	"confirmed_decisions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_identity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_boundary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"reviewed_by_user_id" varchar(36),
	"reviewed_at" timestamp with time zone,
	"published_by_user_id" varchar(36),
	"published_at" timestamp with time zone,
	"created_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_brief_versions_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_project_brief_versions_status" CHECK (status IN ('draft', 'in_review', 'published', 'archived')),
	CONSTRAINT "ck_project_brief_versions_project_status" CHECK (project_status IN ('active', 'archived', 'deleted')),
	CONSTRAINT "ck_project_brief_versions_confirmed_decisions_array" CHECK (jsonb_typeof(confirmed_decisions_json) = 'array'),
	CONSTRAINT "ck_project_brief_versions_workspace_identity_object" CHECK (jsonb_typeof(workspace_identity_json) = 'object'),
	CONSTRAINT "ck_project_brief_versions_workspace_boundary_object" CHECK (jsonb_typeof(workspace_boundary_json) = 'object'),
	CONSTRAINT "ck_project_brief_versions_source_refs_array" CHECK (jsonb_typeof(source_refs_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE "project_instruction_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"version" varchar(16) NOT NULL,
	"title" varchar(256) NOT NULL,
	"instruction_text" text NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"reviewed_by_user_id" varchar(36),
	"reviewed_at" timestamp with time zone,
	"published_by_user_id" varchar(36),
	"published_at" timestamp with time zone,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_instruction_versions_id_project_space" UNIQUE("id","project_id","space_id"),
	CONSTRAINT "ck_project_instruction_versions_status" CHECK (status IN ('draft', 'in_review', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_members_role" CHECK ((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('member'::character varying)::text, ('viewer'::character varying)::text])),
	CONSTRAINT "ck_project_members_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('invited'::character varying)::text, ('revoked'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "project_public_summaries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"summary_text" text NOT NULL,
	"topics_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"highlights_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"review_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"updated_by_user_id" varchar(36),
	"generated_by_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_public_summaries_highlights_array" CHECK (jsonb_typeof(highlights_json) = 'array'::text),
	CONSTRAINT "ck_project_public_summaries_review_status" CHECK ((review_status)::text = ANY (ARRAY[('draft'::character varying)::text, ('approved'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_project_public_summaries_source_refs_array" CHECK (jsonb_typeof(source_refs_json) = 'array'::text),
	CONSTRAINT "ck_project_public_summaries_topics_array" CHECK (jsonb_typeof(topics_json) = 'array'::text)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"description" text,
	"status" varchar(32) NOT NULL,
	"current_focus" text,
	"settings_json" jsonb,
	"focus_area_id" varchar(36),
	"active_brief_version_id" varchar(36),
	"active_instruction_version_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_projects_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_projects_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "project_work_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"event_kind" varchar(64) NOT NULL,
	"subject_type" varchar(32) NOT NULL,
	"subject_id" varchar(36) NOT NULL,
	"actor_id" varchar(36) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" varchar(64),
	"causation_id" varchar(64),
	"idempotency_key" varchar(256),
	"data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_project_work_events_kind_format" CHECK (event_kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "ck_project_work_events_data_object" CHECK (jsonb_typeof(data_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "task_loop_states" (
	"task_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"loop_instance_id" varchar(36) NOT NULL,
	"current_stage_key" varchar(32) NOT NULL,
	"stage_entered_at" timestamp with time zone NOT NULL,
	"last_event_id" varchar(36),
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_loop_states_task_space" UNIQUE("task_id","space_id"),
	CONSTRAINT "ck_task_loop_states_stage" CHECK (current_stage_key IN ('frame', 'plan', 'act', 'verify', 'conclude')),
	CONSTRAINT "ck_task_loop_states_revision" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "proposal_approvals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"approval_type" varchar(64) NOT NULL,
	"approver_user_id" varchar(36) NOT NULL,
	"grant_id" varchar(36),
	"action_grant_id" varchar(36),
	"target_space_id" varchar(36),
	"status" varchar(32) NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ck_proposal_approvals_approval_type" CHECK ((approval_type)::text = ANY (ARRAY['egress_granting_user'::text, 'action_grant'::text])),
	CONSTRAINT "ck_proposal_approvals_status" CHECK ((status)::text = ANY (ARRAY[('approved'::character varying)::text, ('revoked'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"created_by_run_id" varchar(36),
	"action_idempotency_key" varchar(256),
	"proposal_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"risk_level" varchar(32) NOT NULL,
	"urgency" varchar(32) NOT NULL,
	"preview" boolean DEFAULT false NOT NULL,
	"title" varchar(512) NOT NULL,
	"summary" text,
	"payload_json" jsonb NOT NULL,
	"review_deadline" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" varchar(36),
	"project_folder_id" varchar(36),
	"rationale" text,
	"created_by_agent_id" varchar(36),
	"created_by_user_id" varchar(36),
	"owner_user_id" varchar(36),
	"required_approver_role" varchar(64),
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"project_id" varchar(36),
	CONSTRAINT "uq_proposals_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_proposals_risk_level" CHECK ((risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])),
	CONSTRAINT "ck_proposals_urgency" CHECK ((urgency)::text = ANY (ARRAY[('low'::character varying)::text, ('normal'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])),
	CONSTRAINT "ck_proposals_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_proposals_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_proposals_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"credential_type" varchar(64) NOT NULL,
	"secret_ref" text NOT NULL,
	"scopes_json" jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_credentials" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"provider_id" varchar(36) NOT NULL,
	"credential_id" varchar(36) NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"healthy" boolean NOT NULL,
	"cooldown_until" timestamp with time zone,
	"last_failure_class" varchar(32),
	"request_count" bigint NOT NULL,
	"failure_count" bigint NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_model_provider_credentials_provider_credential" UNIQUE("credential_id","provider_id"),
	CONSTRAINT "ck_model_provider_credentials_failure_class" CHECK (((last_failure_class)::text = ANY (ARRAY[('rate_limit'::character varying)::text, ('payment_required'::character varying)::text, ('unauthorized'::character varying)::text, ('quota_exhausted'::character varying)::text, ('transient'::character varying)::text, ('permanent'::character varying)::text])) OR (last_failure_class IS NULL))
);
--> statement-breakpoint
CREATE TABLE "model_provider_space_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36),
	"granted_by_user_id" varchar(36),
	"enabled" boolean NOT NULL,
	"is_default" boolean NOT NULL,
	"network_profile_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_model_provider_space_grants_provider_space" UNIQUE("provider_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36),
	"name" varchar(128) NOT NULL,
	"provider_type" varchar(64) NOT NULL,
	"base_url" varchar(512),
	"network_profile_id" varchar(36),
	"default_model" varchar(256),
	"enabled" boolean NOT NULL,
	"credential_id" varchar(36),
	"capabilities_json" jsonb NOT NULL,
	"config_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_profiles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"name" varchar(128) NOT NULL,
	"mode" varchar(32) NOT NULL,
	"proxy_url" varchar(512),
	"no_proxy" text,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_network_profiles_mode" CHECK ((mode)::text = ANY (ARRAY[('direct'::character varying)::text, ('http_proxy'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "provider_task_policies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task" varchar(64) NOT NULL,
	"chain_json" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_provider_task_policies_space_task" UNIQUE("space_id","task")
);
--> statement-breakpoint
CREATE TABLE "relation_identities" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"id_type" varchar(32) NOT NULL,
	"id_value" varchar(512) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"confidence" double precision,
	"source" varchar(32) DEFAULT 'manual' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_relation_identities_id_type" CHECK ((id_type)::text = ANY (ARRAY[('email'::character varying)::text, ('url'::character varying)::text, ('phone'::character varying)::text, ('orcid'::character varying)::text, ('github'::character varying)::text, ('twitter'::character varying)::text, ('linkedin'::character varying)::text, ('other'::character varying)::text])),
	CONSTRAINT "ck_relation_identities_source" CHECK ((source)::text = ANY (ARRAY[('manual'::character varying)::text, ('import'::character varying)::text, ('source_sync'::character varying)::text, ('agent'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "relation_notes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_organizations" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"org_type" varchar(32) DEFAULT 'other' NOT NULL,
	"homepage_url" text,
	"parent_organization_object_id" varchar(36),
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "relation_organizations_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_relation_organizations_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text])),
	CONSTRAINT "ck_relation_organizations_org_type" CHECK ((org_type)::text = ANY (ARRAY[('company'::character varying)::text, ('university'::character varying)::text, ('lab'::character varying)::text, ('research_group'::character varying)::text, ('nonprofit'::character varying)::text, ('government'::character varying)::text, ('community'::character varying)::text, ('family'::character varying)::text, ('other'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "relation_people" (
	"object_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"pronouns" varchar(32),
	"headline" varchar(256),
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "relation_people_object_id_space_id_key" UNIQUE("object_id","space_id"),
	CONSTRAINT "ck_relation_people_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "relation_source_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"link_type" varchar(32) NOT NULL,
	"activity_id" varchar(36),
	"source_item_id" varchar(36),
	"evidence_id" varchar(36),
	"external_ref" text,
	"note" text,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_relation_source_links_link_type" CHECK ((link_type)::text = ANY (ARRAY[('activity'::character varying)::text, ('source_item'::character varying)::text, ('evidence'::character varying)::text, ('external'::character varying)::text])),
	CONSTRAINT "ck_relation_source_links_exactly_one_target" CHECK (num_nonnulls(activity_id, source_item_id, evidence_id, external_ref) = 1),
	CONSTRAINT "ck_relation_source_links_target_matches_type" CHECK ((link_type = 'activity' AND activity_id IS NOT NULL) OR (link_type = 'source_item' AND source_item_id IS NOT NULL) OR (link_type = 'evidence' AND evidence_id IS NOT NULL) OR (link_type = 'external' AND external_ref IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "route_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" varchar(32) NOT NULL,
	"selected_runtime_profile_id" varchar(36),
	"selected_adapter_type" varchar(64),
	"selected_model_provider_id" varchar(36),
	"reason" varchar(1024) NOT NULL,
	"hints_json" jsonb NOT NULL,
	"candidates_json" jsonb NOT NULL,
	"rejected_json" jsonb NOT NULL,
	"fallback_chain_json" jsonb NOT NULL,
	"score_trace_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_route_decisions_run_attempt" UNIQUE("space_id","run_id","attempt_number")
);
--> statement-breakpoint
CREATE TABLE "room_agent_access_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"grantee_user_id" varchar(36) NOT NULL,
	"granted_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "room_agent_members" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"role" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"trigger_policy" varchar(24) DEFAULT 'owner_only' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_agent_members_room_agent" UNIQUE("room_id","agent_id"),
	CONSTRAINT "ck_room_agent_members_role" CHECK (role IN ('manager', 'member')),
	CONSTRAINT "ck_room_agent_members_status" CHECK (status IN ('active', 'removed')),
	CONSTRAINT "ck_room_agent_members_trigger_policy" CHECK (trigger_policy IN ('owner_only'))
);
--> statement-breakpoint
CREATE TABLE "room_agent_preset_idempotencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_fingerprint" varchar(128) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_agent_preset_idempotencies_caller_key" UNIQUE("space_id","user_id","room_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "room_invitation_agent_approvals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invitation_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"status" varchar(32) NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_invitation_agent_approvals_invitation_agent" UNIQUE("invitation_id","agent_id"),
	CONSTRAINT "ck_room_invitation_agent_approvals_status" CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated'))
);
--> statement-breakpoint
CREATE TABLE "room_user_invitations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"invitee_user_id" varchar(36) NOT NULL,
	"invited_by_user_id" varchar(36) NOT NULL,
	"status" varchar(32) NOT NULL,
	"required_roster_revision" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "uq_room_user_invitations_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_room_user_invitations_status" CHECK (status IN ('pending', 'active', 'rejected', 'expired', 'cancelled', 'invalidated'))
);
--> statement-breakpoint
CREATE TABLE "room_user_members" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_user_members_room_user" UNIQUE("room_id","user_id"),
	CONSTRAINT "ck_room_user_members_role" CHECK (role IN ('owner', 'member')),
	CONSTRAINT "ck_room_user_members_status" CHECK (status IN ('active', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"created_by_user_id" varchar(36) NOT NULL,
	"title" varchar(256) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"roster_revision" bigint DEFAULT 0 NOT NULL,
	"is_mainline" boolean DEFAULT false NOT NULL,
	"personal_for_user_id" varchar(36),
	CONSTRAINT "uq_rooms_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "uq_rooms_id_space_project" UNIQUE("id","space_id","project_id"),
	CONSTRAINT "ck_rooms_status" CHECK (status IN ('active', 'archived')),
	CONSTRAINT "ck_rooms_personal_not_mainline" CHECK (personal_for_user_id IS NULL OR NOT is_mainline)
);
--> statement-breakpoint
CREATE TABLE "room_conversation_summary_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"status" varchar(24) NOT NULL,
	"active_summary_id" varchar(36),
	"requested_through_message_id" varchar(36),
	"requested_through_created_at" timestamp with time zone,
	"lease_token" varchar(36),
	"lease_expires_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" varchar(2000),
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_conversation_summary_states_session" UNIQUE("session_id"),
	CONSTRAINT "ck_room_conversation_summary_states_status" CHECK (status IN ('idle','queued','running','waiting_provider','retry_wait','failed')),
	CONSTRAINT "ck_room_conversation_summary_states_retry" CHECK (retry_count >= 0),
	CONSTRAINT "ck_room_conversation_summary_states_lease" CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "room_conversation_summary_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"summary_text" text NOT NULL,
	"covered_through_message_id" varchar(36) NOT NULL,
	"covered_through_created_at" timestamp with time zone NOT NULL,
	"covered_message_count" integer NOT NULL,
	"source_token_estimate" integer NOT NULL,
	"summary_token_estimate" integer NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"provider_id" varchar(36),
	"model" varchar(256),
	"usage_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"system_prompt_version" varchar(128) NOT NULL,
	"schema_version" varchar(128) NOT NULL,
	"supersedes_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_conversation_summary_versions_session_version" UNIQUE("session_id","version"),
	CONSTRAINT "uq_room_conversation_summary_versions_scope" UNIQUE("id","session_id","room_id","space_id"),
	CONSTRAINT "ck_room_conversation_summary_versions_status" CHECK (status IN ('active','superseded')),
	CONSTRAINT "ck_room_conversation_summary_versions_coverage" CHECK (version >= 1 AND covered_message_count >= 1 AND source_token_estimate >= 0 AND summary_token_estimate >= 0 AND char_length(summary_text) >= 1),
	CONSTRAINT "ck_room_conversation_summary_versions_json" CHECK (jsonb_typeof(usage_json) = 'object' AND jsonb_typeof(audit_json) = 'object')
);
--> statement-breakpoint
CREATE TABLE "room_creation_idempotencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_room_creation_idempotency_scope" UNIQUE("space_id","user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "retrieval_aliases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"retrieval_object_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_type" "retrieval_object_type" NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"alias_kind" varchar(32) NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_retrieval_aliases_confidence" CHECK ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"retrieval_object_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_type" "retrieval_object_type" NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"chunk_index" integer NOT NULL,
	"plain_text" text NOT NULL,
	"tsv" "tsvector",
	"content_hash" varchar(64) NOT NULL,
	"embedding" vector,
	"embedding_model" varchar(128),
	"embedding_dimensions" integer,
	"embedding_generated_at" timestamp with time zone,
	"embedding_claim_id" varchar(64),
	"embedding_claimed_at" timestamp with time zone,
	"embedding_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_retrieval_chunks_embedding_dimensions" CHECK (((embedding IS NULL) AND (embedding_dimensions IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_dimensions = vector_dims(embedding)) AND (embedding_dimensions >= 1) AND (embedding_dimensions <= 4096)))
);
--> statement-breakpoint
CREATE TABLE "retrieval_edges" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"from_object_type" "retrieval_object_type" NOT NULL,
	"from_object_id" varchar(36) NOT NULL,
	"to_object_type" "retrieval_object_type" NOT NULL,
	"to_object_id" varchar(36) NOT NULL,
	"link_type" varchar(64) NOT NULL,
	"edge_origin" varchar(64) NOT NULL,
	"edge_status" varchar(32) NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_retrieval_edges_confidence" CHECK ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)),
	CONSTRAINT "ck_retrieval_edges_status" CHECK ((edge_status)::text = ANY (ARRAY[('derived'::character varying)::text, ('suggested'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "retrieval_feedback_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"actor_user_id" varchar(36) NOT NULL,
	"surface" varchar(64) NOT NULL,
	"query_hash" varchar(64) NOT NULL,
	"object_type" "retrieval_object_type" NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"signal_type" varchar(32) NOT NULL,
	"dwell_ms" integer,
	"metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_retrieval_feedback_events_dwell_ms" CHECK ((dwell_ms IS NULL) OR (dwell_ms >= 0)),
	CONSTRAINT "ck_retrieval_feedback_events_signal_type" CHECK ((signal_type)::text = ANY (ARRAY[('opened'::character varying)::text, ('dwell'::character varying)::text, ('used'::character varying)::text, ('explicit_relevant'::character varying)::text, ('accepted'::character varying)::text, ('pinned'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "retrieval_objects" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"object_type" "retrieval_object_type" NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"owner_user_id" varchar(36),
	"visibility" varchar(32),
	"access_level" varchar(16),
	"status" varchar(32) NOT NULL,
	"title" varchar(512) NOT NULL,
	"slug" varchar(512),
	"object_profile" varchar(64),
	"content_hash" varchar(64) NOT NULL,
	"source_connection_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	CONSTRAINT "ck_retrieval_objects_source_connections_array" CHECK (jsonb_typeof(source_connection_ids_json) = 'array'::text),
	CONSTRAINT "ck_retrieval_objects_visibility" CHECK (visibility IS NULL OR visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_retrieval_objects_access_level" CHECK (access_level IS NULL OR access_level IN ('full', 'summary'))
);
--> statement-breakpoint
CREATE TABLE "external_run_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"vendor" varchar(64) NOT NULL,
	"vendor_run_id" varchar(256),
	"runtime_adapter_type" varchar(64),
	"external_url" text,
	"observability_level" varchar(64) DEFAULT 'black_box' NOT NULL,
	"data_exposure_level" varchar(64) DEFAULT 'unknown' NOT NULL,
	"trace_available" boolean DEFAULT false NOT NULL,
	"raw_summary" text,
	"raw_output_uri" varchar(1024),
	"imported_diff_uri" varchar(1024),
	"imported_artifacts_json" jsonb,
	"imported_logs_uri" varchar(1024),
	"status" varchar(32) DEFAULT 'imported' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_external_run_records_data_exposure_level" CHECK ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_external_run_records_observability_level" CHECK ((observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text])),
	CONSTRAINT "ck_external_run_records_vendor" CHECK ((vendor)::text = ANY (ARRAY[('openai'::character varying)::text, ('anthropic'::character varying)::text, ('cursor'::character varying)::text, ('opencode'::character varying)::text, ('manual'::character varying)::text, ('other'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "run_attempts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"cancel_confirmed_at" timestamp with time zone,
	"exit_code" integer,
	"error_code" varchar(128),
	"error_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_attempts_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "uq_run_attempts_space_run_number" UNIQUE("space_id","run_id","attempt_number"),
	CONSTRAINT "ck_run_attempts_attempt_number" CHECK (attempt_number > 0),
	CONSTRAINT "ck_run_attempts_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('cancelling'::character varying)::text, ('succeeded'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('orphaned'::character varying)::text, ('waiting_for_review'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "run_evaluations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"evaluator_type" varchar(64) DEFAULT 'deterministic_harness' NOT NULL,
	"evaluator_version" varchar(64) DEFAULT 'harness_eval.v1' NOT NULL,
	"outcome_status" varchar(32) NOT NULL,
	"failure_layer" varchar(32),
	"failure_reason_code" varchar(128),
	"trajectory_status" varchar(32) NOT NULL,
	"evidence_json" jsonb,
	"rule_trace_json" jsonb,
	"notes" text,
	"evaluated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_run_evaluations_failure_layer" CHECK ((failure_layer IS NULL) OR ((failure_layer)::text = ANY (ARRAY[('context'::character varying)::text, ('sandbox'::character varying)::text, ('runtime'::character varying)::text, ('tool'::character varying)::text, ('validation'::character varying)::text, ('policy'::character varying)::text, ('task_spec'::character varying)::text, ('orchestration'::character varying)::text, ('evaluator'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_run_evaluations_outcome_status" CHECK ((outcome_status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text, ('partial'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_run_evaluations_trajectory_status" CHECK ((trajectory_status)::text = ANY (ARRAY[('acceptable'::character varying)::text, ('incomplete'::character varying)::text, ('unsafe'::character varying)::text, ('insufficient_evidence'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_number" integer,
	"step_id" varchar(36),
	"actor_id" varchar(36),
	"event_index" integer NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"summary" text,
	"error_code" varchar(128),
	"error_message" text,
	"project_folder_id" varchar(36),
	"artifact_id" varchar(36),
	"proposal_id" varchar(36),
	"data_exposure_level" varchar(64),
	"trust_level" varchar(32),
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_events_space_run_event_index" UNIQUE("event_index","run_id","space_id"),
	CONSTRAINT "ck_run_events_data_exposure_level" CHECK ((data_exposure_level IS NULL) OR ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_run_events_event_type" CHECK ((event_type)::text = ANY (ARRAY[('context_compiled'::character varying)::text, ('runtime_selected'::character varying)::text, ('credential_granted'::character varying)::text, ('sandbox_created'::character varying)::text, ('policy_checked'::character varying)::text, ('adapter_invoked'::character varying)::text, ('adapter_completed'::character varying)::text, ('artifact_ingested'::character varying)::text, ('patch_collected'::character varying)::text, ('validation_started'::character varying)::text, ('validation_completed'::character varying)::text, ('proposal_created'::character varying)::text, ('evaluation_created'::character varying)::text, ('run_finalized'::character varying)::text, ('chat_completed'::character varying)::text, ('delegation_requested'::character varying)::text, ('delegation_policy_denied'::character varying)::text, ('delegation_queued'::character varying)::text, ('delegation_started'::character varying)::text, ('delegation_completed'::character varying)::text, ('action_invoked'::character varying)::text, ('action_completed'::character varying)::text, ('assistant_message_completed'::character varying)::text, ('tool_call_started'::character varying)::text, ('tool_call_completed'::character varying)::text, ('tool_call_failed'::character varying)::text, ('approval_requested'::character varying)::text, ('approval_resolved'::character varying)::text, ('artifact_produced'::character varying)::text, ('output_validation_completed'::character varying)::text, ('provider_compacted'::character varying)::text, ('warning'::character varying)::text, ('error'::character varying)::text, ('state_transition'::character varying)::text])),
	CONSTRAINT "ck_run_events_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('warning'::character varying)::text, ('cancelled'::character varying)::text])),
	CONSTRAINT "ck_run_events_trust_level" CHECK ((trust_level IS NULL) OR ((trust_level)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text, ('unknown'::character varying)::text])))
);
--> statement-breakpoint
CREATE TABLE "run_execution_locks" (
	"run_id" varchar(36) PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone NOT NULL,
	"worker_id" varchar(64) NOT NULL,
	"job_id" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "run_finalizations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_number" integer NOT NULL,
	"finalizer_version" varchar(64) DEFAULT 'post_run_finalization.v1' NOT NULL,
	"status" varchar(32) NOT NULL,
	"run_evaluation_id" varchar(36),
	"task_evaluation_id" varchar(36),
	"outcome_status" varchar(32),
	"failure_layer" varchar(32),
	"failure_reason_code" varchar(128),
	"trajectory_status" varchar(32),
	"skipped_reasons_json" jsonb,
	"error_json" jsonb,
	"metadata_json" jsonb,
	"finalized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_finalizations_run_attempt_version" UNIQUE("space_id","run_id","attempt_number","finalizer_version"),
	CONSTRAINT "ck_run_finalizations_attempt_number" CHECK (attempt_number > 0),
	CONSTRAINT "ck_run_finalizations_failure_layer" CHECK ((failure_layer IS NULL) OR ((failure_layer)::text = ANY (ARRAY[('context'::character varying)::text, ('sandbox'::character varying)::text, ('runtime'::character varying)::text, ('tool'::character varying)::text, ('validation'::character varying)::text, ('policy'::character varying)::text, ('task_spec'::character varying)::text, ('orchestration'::character varying)::text, ('evaluator'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_run_finalizations_outcome_status" CHECK ((outcome_status IS NULL) OR ((outcome_status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text, ('partial'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_run_finalizations_status" CHECK ((status)::text = ANY (ARRAY[('completed'::character varying)::text, ('failed'::character varying)::text])),
	CONSTRAINT "ck_run_finalizations_trajectory_status" CHECK ((trajectory_status IS NULL) OR ((trajectory_status)::text = ANY (ARRAY[('acceptable'::character varying)::text, ('incomplete'::character varying)::text, ('unsafe'::character varying)::text, ('insufficient_evidence'::character varying)::text])))
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_number" integer,
	"parent_step_id" varchar(36),
	"actor_id" varchar(36) NOT NULL,
	"step_index" integer NOT NULL,
	"step_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"title" varchar(512),
	"project_folder_id" varchar(36),
	"session_id" varchar(36),
	"task_id" varchar(36),
	"artifact_id" varchar(36),
	"proposal_id" varchar(36),
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"input_summary" text,
	"output_summary" text,
	"error_type" varchar(128),
	"error_message" text,
	"metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_steps_run_step_index" UNIQUE("run_id","step_index"),
	CONSTRAINT "ck_run_steps_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('cancelled'::character varying)::text])),
	CONSTRAINT "ck_run_steps_step_type" CHECK ((step_type)::text = ANY (ARRAY[('run_created'::character varying)::text, ('queued'::character varying)::text, ('runtime_selected'::character varying)::text, ('adapter_started'::character varying)::text, ('adapter_completed'::character varying)::text, ('artifact_created'::character varying)::text, ('proposal_created'::character varying)::text, ('failed'::character varying)::text, ('completed'::character varying)::text, ('validation_started'::character varying)::text, ('validation_completed'::character varying)::text, ('cancelled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "run_supervisor_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_id" varchar(36) NOT NULL,
	"decision" varchar(32) NOT NULL,
	"reason_code" varchar(128) NOT NULL,
	"next_attempt_number" integer,
	"total_estimated_cost_usd" double precision,
	"max_cost_usd" double precision,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_supervisor_decisions_attempt" UNIQUE("space_id","attempt_id"),
	CONSTRAINT "ck_run_supervisor_decisions_decision" CHECK ((decision)::text = ANY (ARRAY[('retry_same_route'::character varying)::text, ('retry_fallback_route'::character varying)::text, ('human_review'::character varying)::text, ('budget_exceeded'::character varying)::text, ('cancelled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"agent_version_id" varchar(36) NOT NULL,
	"run_role" varchar(32) DEFAULT 'execution' NOT NULL,
	"requested_runtime_profile_id" varchar(36),
	"runtime_profile_id" varchar(36),
	"runtime_profile_selection_source" varchar(16),
	"project_folder_id" varchar(36),
	"workspace_location_id" varchar(36),
	"trust_mode" varchar(16),
	"host_task_thread_id" varchar(36),
	"session_id" varchar(36),
	"parent_run_id" varchar(36),
	"root_run_id" varchar(36),
	"run_group_id" varchar(36),
	"delegation_id" varchar(36),
	"instructed_by" varchar(128),
	"instructed_by_user_id" varchar(36),
	"instructed_by_agent_id" varchar(36),
	"run_type" varchar(32) NOT NULL,
	"trigger_origin" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"mode" varchar(32) NOT NULL,
	"prompt" text,
	"instruction" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"model_provider_id" varchar(36),
	"error_message" text,
	"error_json" jsonb,
	"output_json" jsonb,
	"adapter_type" varchar(64),
	"capability_id" varchar(128),
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_selection_mode" varchar(32) DEFAULT 'cli_default' NOT NULL,
	"model_override_json" jsonb,
	"runtime_profile_snapshot_json" jsonb,
	"permission_snapshot_json" jsonb,
	"required_sandbox_level" varchar(32) DEFAULT 'none' NOT NULL,
	"sandbox_path" text,
	"runtime_seconds" double precision,
	"exit_code" integer,
	"owner_user_id" varchar(36),
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"has_context_taint" boolean DEFAULT false NOT NULL,
	"context_taint_json" jsonb,
	"source" varchar(32),
	"observability_level" varchar(64),
	"data_exposure_level" varchar(64),
	"trust_level" varchar(32),
	"externality_level" varchar(32),
	"project_id" varchar(36),
	"contract_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_version_id" varchar(36),
	"route_decision_id" varchar(36),
	CONSTRAINT "uq_runs_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_runs_data_exposure_level" CHECK ((data_exposure_level IS NULL) OR ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_runs_externality_level" CHECK ((externality_level IS NULL) OR ((externality_level)::text = ANY (ARRAY[('native'::character varying)::text, ('local_external'::character varying)::text, ('remote_external'::character varying)::text, ('hybrid'::character varying)::text, ('manual'::character varying)::text]))),
	CONSTRAINT "ck_runs_mode" CHECK ((mode)::text = ANY (ARRAY[('live'::character varying)::text, ('dry_run'::character varying)::text])),
	CONSTRAINT "ck_runs_run_role" CHECK ((run_role)::text = ANY (ARRAY[('execution'::character varying)::text, ('coordinator'::character varying)::text])),
	CONSTRAINT "ck_runs_observability_level" CHECK ((observability_level IS NULL) OR ((observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text]))),
	CONSTRAINT "ck_runs_required_sandbox_level" CHECK ((required_sandbox_level)::text = ANY (ARRAY[('none'::character varying)::text, ('dry_run'::character varying)::text, ('ephemeral'::character varying)::text, ('read_only'::character varying)::text, ('worktree'::character varying)::text, ('one_shot_docker'::character varying)::text])),
	CONSTRAINT "ck_runs_run_type" CHECK ((run_type)::text = ANY (ARRAY[('agent'::character varying)::text, ('planning'::character varying)::text, ('system'::character varying)::text, ('workflow'::character varying)::text, ('validation'::character varying)::text, ('reflection'::character varying)::text, ('export'::character varying)::text, ('evolution'::character varying)::text])),
	CONSTRAINT "ck_runs_source" CHECK ((source IS NULL) OR ((source)::text = ANY (ARRAY[('managed'::character varying)::text, ('ide_assist'::character varying)::text, ('manual_import'::character varying)::text, ('remote_import'::character varying)::text, ('scheduled'::character varying)::text, ('webhook'::character varying)::text]))),
	CONSTRAINT "ck_runs_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('cancelling'::character varying)::text, ('succeeded'::character varying)::text, ('degraded'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('orphaned'::character varying)::text, ('waiting_for_review'::character varying)::text, ('waiting_for_dependency'::character varying)::text])),
	CONSTRAINT "ck_runs_trigger_origin" CHECK ((trigger_origin)::text = ANY (ARRAY[('manual'::character varying)::text, ('automation'::character varying)::text, ('autonomous'::character varying)::text, ('job'::character varying)::text, ('system'::character varying)::text, ('delegation'::character varying)::text])),
	CONSTRAINT "ck_runs_trust_level" CHECK ((trust_level IS NULL) OR ((trust_level)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text, ('unknown'::character varying)::text]))),
	CONSTRAINT "ck_runs_trust_mode" CHECK (trust_mode IS NULL OR trust_mode IN ('sandboxed', 'trusted_host')),
	CONSTRAINT "ck_runs_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_runs_runtime_profile_selection_source" CHECK (runtime_profile_selection_source IS NULL OR runtime_profile_selection_source IN ('explicit', 'default')),
	CONSTRAINT "ck_runs_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_runs_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "task_evaluations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"run_evaluation_id" varchar(36),
	"evaluator_type" varchar(32) NOT NULL,
	"evaluator_user_id" varchar(36),
	"evaluator_agent_id" varchar(36),
	"score" double precision,
	"confidence" double precision,
	"summary" text,
	"checklist_json" jsonb,
	"known_issues_json" jsonb,
	"evidence_artifact_ids" jsonb,
	"recommendation" varchar(64),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"role" varchar(32) DEFAULT 'primary' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_runs_task_run" UNIQUE("run_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "verification_results" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"verifier_type" varchar(64) NOT NULL,
	"verifier_version" varchar(64) DEFAULT 'verification_engine.v1' NOT NULL,
	"status" varchar(32) NOT NULL,
	"summary" text,
	"evidence_refs_json" jsonb,
	"details_json" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_verification_results_run_verifier" UNIQUE("run_id","attempt_number","verifier_type","verifier_version"),
	CONSTRAINT "ck_verification_results_attempt_number" CHECK (attempt_number > 0),
	CONSTRAINT "ck_verification_results_status" CHECK ((status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('error'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "run_artifact_declarations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"path" varchar(1024) NOT NULL,
	"artifact_type" varchar(64) NOT NULL,
	"role" varchar(32) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_artifact_declarations_run_path" UNIQUE("run_id","path"),
	CONSTRAINT "ck_run_artifact_declarations_role" CHECK (role IN ('output', 'evidence', 'draft'))
);
--> statement-breakpoint
CREATE TABLE "run_tool_identities" (
	"run_id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"skill_content_hash" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_run_tool_identities_token_digest" UNIQUE("token_digest")
);
--> statement-breakpoint
CREATE TABLE "runtime_tool_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"agent_id" varchar(36),
	"capability_id" varchar(128),
	"runtime_adapter_type" varchar(64) NOT NULL,
	"external_type" varchar(64) NOT NULL,
	"external_ref" varchar(512) NOT NULL,
	"display_name" varchar(256) NOT NULL,
	"required_scopes_json" jsonb,
	"credential_ref" varchar(256),
	"data_exposure_level" varchar(64) DEFAULT 'unknown' NOT NULL,
	"observability_level" varchar(64) DEFAULT 'black_box' NOT NULL,
	"side_effect_level" varchar(32) DEFAULT 'none' NOT NULL,
	"approval_required" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_runtime_tool_bindings_data_exposure_level" CHECK ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_runtime_tool_bindings_external_type" CHECK ((external_type)::text = ANY (ARRAY[('codex_plugin'::character varying)::text, ('claude_skill'::character varying)::text, ('claude_hook'::character varying)::text, ('mcp_server'::character varying)::text, ('app_integration'::character varying)::text, ('cli_tool'::character varying)::text])),
	CONSTRAINT "ck_runtime_tool_bindings_observability_level" CHECK ((observability_level)::text = ANY (ARRAY[('full_trace'::character varying)::text, ('structured_events'::character varying)::text, ('artifacts_only'::character varying)::text, ('final_output_only'::character varying)::text, ('black_box'::character varying)::text])),
	CONSTRAINT "ck_runtime_tool_bindings_side_effect_level" CHECK ((side_effect_level)::text = ANY (ARRAY[('none'::character varying)::text, ('local_files'::character varying)::text, ('external_read'::character varying)::text, ('external_write'::character varying)::text, ('sensitive'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "space_runtime_tool_policies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"runtime" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_version" varchar(128),
	"allowed_versions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_space_runtime_tool_policies_space_runtime" UNIQUE("runtime","space_id")
);
--> statement-breakpoint
CREATE TABLE "scheduler_tasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"task_type" varchar(128) NOT NULL,
	"task_key" varchar(256) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" varchar(128) NOT NULL,
	"space_id" varchar(36),
	"user_id" varchar(36),
	"status" varchar(32) NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_scheduler_tasks_type_key" UNIQUE("task_key","task_type"),
	CONSTRAINT "ck_scheduler_tasks_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('instance'::character varying)::text, ('space'::character varying)::text, ('user'::character varying)::text, ('space_user'::character varying)::text])),
	CONSTRAINT "ck_scheduler_tasks_state_json_object" CHECK (jsonb_typeof(state_json) = 'object'::text),
	CONSTRAINT "ck_scheduler_tasks_metadata_json_object" CHECK (jsonb_typeof(metadata_json) = 'object'::text),
	CONSTRAINT "ck_scheduler_tasks_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"user_id" varchar(36),
	"sender_agent_id" varchar(36),
	"role" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"metadata_json" jsonb,
	"parent_message_id" varchar(36),
	"path_depth" integer NOT NULL,
	"branch_path" text NOT NULL,
	"run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_messages_id_space_session" UNIQUE("id","space_id","session_id"),
	CONSTRAINT "ck_messages_role" CHECK ((role)::text = ANY (ARRAY[('user'::character varying)::text, ('assistant'::character varying)::text, ('system'::character varying)::text, ('tool'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "session_conversation_backends" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"bound_by_user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"runtime_profile_id" varchar(36) NOT NULL,
	"credential_profile_id" varchar(36),
	"model_name_snapshot" varchar(255),
	"model_provider_id_snapshot" varchar(36),
	"runtime_config_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_policy_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_state_key" varchar(36) NOT NULL,
	"runtime_session_id" varchar(512),
	"runtime_context_fingerprint" varchar(64),
	"runtime_message_cursor_id" varchar(36),
	"runtime_session_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_session_conversation_backends_session_agent" UNIQUE("session_id","agent_id"),
	CONSTRAINT "uq_session_conversation_backends_runtime_state_key" UNIQUE("runtime_state_key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36),
	"agent_id" varchar(36),
	"project_folder_id" varchar(36),
	"project_id" varchar(36),
	"room_id" varchar(36),
	"title" varchar(512),
	"status" varchar(32) NOT NULL,
	"metadata_json" jsonb,
	"head_message_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_sessions_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "uq_sessions_id_space_room_project" UNIQUE("id","space_id","room_id","project_id"),
	CONSTRAINT "uq_sessions_id_space_user_agent" UNIQUE("id","space_id","user_id","agent_id"),
	CONSTRAINT "ck_sessions_conversation_owner" CHECK (
		(room_id IS NOT NULL AND project_id IS NOT NULL AND user_id IS NULL AND agent_id IS NULL)
		OR (room_id IS NULL AND user_id IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "conversation_execution_contexts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"execution_host_id" varchar(36),
	"primary_workspace_mode" varchar(16),
	"primary_project_folder_id" varchar(36),
	"primary_workspace_location_id" varchar(36),
	"state" varchar(16) DEFAULT 'draft' NOT NULL,
	"initialized_at" timestamp with time zone,
	"initialized_by_user_id" varchar(36),
	"dispatch_lock_id" varchar(36),
	"queue_paused_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_conversation_execution_contexts_session_space" UNIQUE("session_id","space_id"),
	CONSTRAINT "ck_conversation_execution_contexts_state" CHECK (state IN ('draft', 'initialized')),
	CONSTRAINT "ck_conversation_execution_contexts_primary_mode" CHECK (
		primary_workspace_mode IS NULL
		OR primary_workspace_mode IN ('managed', 'location')
	),
	CONSTRAINT "ck_conversation_execution_contexts_primary_shape" CHECK (
		(primary_workspace_mode IS NULL AND primary_project_folder_id IS NULL AND primary_workspace_location_id IS NULL)
		OR (primary_workspace_mode = 'managed' AND primary_project_folder_id IS NULL AND primary_workspace_location_id IS NULL)
		OR (primary_workspace_mode = 'location' AND primary_project_folder_id IS NOT NULL AND primary_workspace_location_id IS NOT NULL)
	),
	CONSTRAINT "ck_conversation_execution_contexts_initialization" CHECK (
		(state = 'draft' AND initialized_at IS NULL)
		OR (
			state = 'initialized'
			AND initialized_at IS NOT NULL
			AND execution_host_id IS NOT NULL
			AND primary_workspace_mode IS NOT NULL
		)
	)
);
--> statement-breakpoint
CREATE TABLE "conversation_folder_access_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"workspace_location_id" varchar(36) NOT NULL,
	"access_mode" varchar(16) DEFAULT 'read' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"granted_by_user_id" varchar(36) NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36),
	CONSTRAINT "ck_conversation_folder_access_grants_mode" CHECK (access_mode IN ('read', 'write')),
	CONSTRAINT "ck_conversation_folder_access_grants_status" CHECK (status IN ('active', 'revoked')),
	CONSTRAINT "ck_conversation_folder_access_grants_revocation" CHECK (
		(status = 'active' AND revoked_at IS NULL)
		OR (status = 'revoked' AND revoked_at IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" varchar(128) NOT NULL,
	"settings_key" varchar(128) NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_settings_scope_key" UNIQUE("scope_id","scope_type","settings_key"),
	CONSTRAINT "ck_settings_json_object" CHECK (jsonb_typeof(settings_json) = 'object'::text),
	CONSTRAINT "ck_settings_scope_type" CHECK ((scope_type)::text = ANY (ARRAY[('instance'::character varying)::text, ('space'::character varying)::text, ('user'::character varying)::text, ('space_user'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "content_publication_imports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"publication_id" varchar(36) NOT NULL,
	"target_space_id" varchar(36) NOT NULL,
	"publication_version" integer NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"imported_resource_type" varchar(64) NOT NULL,
	"imported_resource_id" varchar(36) NOT NULL,
	"imported_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_content_publication_imports_publication_space" UNIQUE("publication_id","target_space_id"),
	CONSTRAINT "ck_content_publication_imports_version" CHECK (publication_version > 0)
);
--> statement-breakpoint
CREATE TABLE "content_publication_targets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"publication_id" varchar(36) NOT NULL,
	"target_space_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_content_publication_targets_publication_space" UNIQUE("publication_id","target_space_id")
);
--> statement-breakpoint
CREATE TABLE "content_publications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"source_space_id" varchar(36) NOT NULL,
	"source_resource_type" varchar(64) NOT NULL,
	"source_resource_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"published_by_user_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar(36),
	CONSTRAINT "uq_content_publications_source_version" UNIQUE("source_space_id","source_resource_type","source_resource_id","version"),
	CONSTRAINT "ck_content_publications_status" CHECK (status IN ('active', 'revoked')),
	CONSTRAINT "ck_content_publications_snapshot_object" CHECK (jsonb_typeof(snapshot_json) = 'object'),
	CONSTRAINT "ck_content_publications_version" CHECK (version > 0)
);
--> statement-breakpoint
CREATE TABLE "extraction_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"connection_id" varchar(36),
	"source_item_id" varchar(36),
	"source_snapshot_id" varchar(36),
	"source_object_type" varchar(64),
	"source_object_id" varchar(36),
	"job_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"items_seen" integer,
	"items_created" integer,
	"items_updated" integer,
	"error_code" varchar(64),
	"error_message" varchar(512),
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_extraction_jobs_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_extraction_jobs_job_type" CHECK ((job_type)::text = ANY (ARRAY[('connection_scan'::character varying)::text, ('manual_url'::character varying)::text, ('extract_text'::character varying)::text, ('snapshot'::character varying)::text, ('normalize_activity'::character varying)::text, ('normalize_artifact'::character varying)::text, ('normalize_run_event'::character varying)::text])),
	CONSTRAINT "ck_extraction_jobs_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "reader_annotations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"document_type" varchar(32) NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"annotation_type" varchar(32) NOT NULL,
	"quote_text" text NOT NULL,
	"anchor_json" jsonb NOT NULL,
	"color" varchar(32),
	"label" varchar(128),
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"anchor_state" varchar(32) DEFAULT 'unverified' NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_reader_annotations_annotation_type" CHECK ((annotation_type)::text = ANY (ARRAY[('highlight'::character varying)::text, ('comment'::character varying)::text, ('excerpt'::character varying)::text, ('bookmark'::character varying)::text])),
	CONSTRAINT "ck_reader_annotations_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_reader_annotations_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_reader_annotations_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_reader_annotations_anchor_state" CHECK ((anchor_state)::text = ANY (ARRAY[('verified'::character varying)::text, ('unverified'::character varying)::text])),
	CONSTRAINT "ck_reader_annotations_document_type" CHECK (document_type IN ('source_item', 'source_snapshot', 'research_report', 'research_notebook')),
	CONSTRAINT "ck_reader_annotations_anchor_json" CHECK (jsonb_typeof(anchor_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "reader_comment_threads" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"annotation_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_reader_comment_threads_status" CHECK ((status)::text = ANY (ARRAY[('open'::character varying)::text, ('resolved'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "reader_comments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"body" text NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_reader_comments_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"provider_connector_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"credential_id" varchar(36),
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"name" varchar(512) NOT NULL,
	"status" varchar(32) NOT NULL,
	"capture_policy" varchar(64) NOT NULL,
	"trust_level" varchar(32) NOT NULL,
	"topic_hints_json" jsonb,
	"consent_json" jsonb NOT NULL,
	"policy_json" jsonb NOT NULL,
	"config_json" jsonb NOT NULL,
	"handler_kind" varchar(32) DEFAULT 'built_in' NOT NULL,
	"active_handler_version_id" varchar(36),
	"active_recipe_version_id" varchar(36),
	"repair_status" varchar(32) DEFAULT 'ok' NOT NULL,
	"last_handler_run_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_source_connections_id_provider_connector_space" UNIQUE("id","provider_connector_id","space_id"),
	CONSTRAINT "source_connections_id_space_id_key" UNIQUE("id","space_id"),
	CONSTRAINT "ck_source_connections_capture_policy" CHECK ((capture_policy)::text = ANY (ARRAY[('reference_only'::character varying)::text, ('extract_text'::character varying)::text, ('archive_original'::character varying)::text])),
	CONSTRAINT "ck_source_connections_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_source_connections_trust_level" CHECK ((trust_level)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text])),
	CONSTRAINT "ck_source_connections_handler_kind" CHECK ((handler_kind)::text = ANY (ARRAY[('built_in'::character varying)::text, ('generated_custom'::character varying)::text, ('recipe'::character varying)::text])),
	CONSTRAINT "ck_source_connections_repair_status" CHECK ((repair_status)::text = ANY (ARRAY[('ok'::character varying)::text, ('repair_required'::character varying)::text, ('repair_pending'::character varying)::text, ('disabled'::character varying)::text])),
	CONSTRAINT "ck_source_connections_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_source_connections_access_level" CHECK (access_level IN ('full', 'summary'))
);
--> statement-breakpoint
CREATE TABLE "source_handler_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_connection_id" varchar(36) NOT NULL,
	"handler_version_id" varchar(36) NOT NULL,
	"extraction_job_id" varchar(36),
	"status" varchar(32) NOT NULL,
	"input_artifact_id" varchar(36),
	"output_artifact_id" varchar(36),
	"logs_artifact_id" varchar(36),
	"failure_class" varchar(64),
	"failure_detail_json" jsonb,
	"validation_result_json" jsonb,
	"resource_usage_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ck_source_handler_runs_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('validation_failed'::character varying)::text, ('blocked'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "source_handler_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_connection_id" varchar(36) NOT NULL,
	"version_number" integer NOT NULL,
	"language" varchar(32) NOT NULL,
	"entrypoint" varchar(512) NOT NULL,
	"handler_artifact_id" varchar(36),
	"manifest_json" jsonb NOT NULL,
	"input_schema_json" jsonb,
	"output_schema_json" jsonb,
	"policy_envelope_json" jsonb NOT NULL,
	"requested_capabilities_json" jsonb,
	"checksum" varchar(128) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_run_id" varchar(36),
	"proposal_id" varchar(36),
	"test_result_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "uq_source_handler_versions_connection_version" UNIQUE("source_connection_id","version_number"),
	CONSTRAINT "ck_source_handler_versions_language" CHECK ((language)::text = ANY (ARRAY[('typescript_node'::character varying)::text, ('declarative_pipeline_v1'::character varying)::text])),
	CONSTRAINT "ck_source_handler_versions_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('test_failed'::character varying)::text, ('pending_approval'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text])),
	CONSTRAINT "ck_source_handler_versions_version_number" CHECK (version_number > 0)
);
--> statement-breakpoint
CREATE TABLE "source_item_user_states" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"library_status" varchar(32) DEFAULT 'new' NOT NULL,
	"read_status" varchar(32) DEFAULT 'unread' NOT NULL,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"progress_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_source_item_user_states_library_status" CHECK ((library_status)::text = ANY (ARRAY[('new'::character varying)::text, ('triaged'::character varying)::text, ('selected'::character varying)::text, ('ignored'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_source_item_user_states_read_status" CHECK ((read_status)::text = ANY (ARRAY[('unread'::character varying)::text, ('skimmed'::character varying)::text, ('read'::character varying)::text, ('discussed'::character varying)::text])),
	CONSTRAINT "ck_source_item_user_states_progress_json" CHECK (jsonb_typeof(progress_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"owner_user_id" varchar(36),
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"connection_id" varchar(36),
	"item_type" varchar(64) NOT NULL,
	"source_object_type" varchar(64),
	"source_object_id" varchar(36),
	"created_by_user_id" varchar(36),
	"title" varchar(1024) NOT NULL,
	"source_uri" text,
	"canonical_uri" text,
	"source_domain" varchar(256),
	"source_external_id" varchar(512),
	"author" varchar(512),
	"occurred_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"content_hash" varchar(128),
	"excerpt" varchar(2048),
	"content_state" varchar(64) NOT NULL,
	"retention_policy" varchar(32) NOT NULL,
	"relevance_score" double precision,
	"novelty_score" double precision,
	"raw_artifact_id" varchar(36),
	"extracted_artifact_id" varchar(36),
	"summary_artifact_id" varchar(36),
	"search_index_ref" varchar(1024),
	"embedding_index_ref" varchar(1024),
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_source_items_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_source_items_content_state" CHECK ((content_state)::text = ANY (ARRAY[('metadata_only'::character varying)::text, ('excerpt_saved'::character varying)::text, ('content_queued'::character varying)::text, ('content_saved'::character varying)::text, ('snapshot_queued'::character varying)::text, ('snapshot_saved'::character varying)::text, ('extraction_failed'::character varying)::text, ('content_unavailable'::character varying)::text])),
	CONSTRAINT "ck_source_items_item_type" CHECK ((item_type)::text = ANY (ARRAY[('external_url'::character varying)::text, ('feed_entry'::character varying)::text, ('activity_record'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('file'::character varying)::text, ('document'::character varying)::text, ('log'::character varying)::text])),
	CONSTRAINT "ck_source_items_retention_policy" CHECK ((retention_policy)::text = ANY (ARRAY[('metadata_only'::character varying)::text, ('summary_only'::character varying)::text, ('full_text'::character varying)::text, ('full_snapshot'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_source_items_origin_pair" CHECK ((source_object_type IS NULL) = (source_object_id IS NULL)),
	CONSTRAINT "ck_source_items_origin_type" CHECK (source_object_type IS NULL OR source_object_type IN ('activity_record', 'artifact', 'run_event')),
	CONSTRAINT "ck_source_items_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_source_items_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_source_items_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "source_post_processing_item_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"rule_id" varchar(36),
	"run_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"source_item_id" varchar(36) NOT NULL,
	"research_question_version" integer DEFAULT 1 NOT NULL,
	"relevance" varchar(32) NOT NULL,
	"confidence" double precision,
	"reason" text,
	"matched_context_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"action_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_post_processing_item_decisions_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_source_post_processing_item_decisions_action_object" CHECK (jsonb_typeof(action_json) = 'object'::text),
	CONSTRAINT "ck_source_post_processing_item_decisions_confidence" CHECK ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
	CONSTRAINT "ck_source_post_processing_item_decisions_question_version" CHECK (research_question_version >= 1),
	CONSTRAINT "ck_source_post_processing_item_decisions_refs_array" CHECK (jsonb_typeof(matched_context_refs_json) = 'array'::text),
	CONSTRAINT "ck_source_post_processing_item_decisions_relevance" CHECK ((relevance)::text = ANY (ARRAY[('relevant'::character varying)::text, ('maybe'::character varying)::text, ('not_relevant'::character varying)::text])),
	CONSTRAINT "ck_source_post_processing_item_decisions_review_status" CHECK ((review_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('ignored'::character varying)::text, ('queued'::character varying)::text, ('proposed'::character varying)::text, ('rerun'::character varying)::text, ('dismissed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "source_post_processing_rules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"trigger_type" varchar(32) DEFAULT 'items_materialized' NOT NULL,
	"trigger_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions_json" jsonb DEFAULT '{"batch_digest":true}'::jsonb NOT NULL,
	"cursor_json" jsonb,
	"last_fired_at" timestamp with time zone,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_source_post_processing_rules_status" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])),
	CONSTRAINT "ck_source_post_processing_rules_trigger_type" CHECK ((trigger_type)::text = ANY (ARRAY[('items_materialized'::character varying)::text, ('schedule'::character varying)::text, ('manual'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "source_post_processing_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"rule_id" varchar(36),
	"source_channel_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"agent_run_id" varchar(36),
	"triggered_by_user_id" varchar(36),
	"trigger_type" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"input_item_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_evidence_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_artifact_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_proposal_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_job_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor_before_json" jsonb,
	"cursor_after_json" jsonb,
	"retrieval_context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"item_decisions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"error_json" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"research_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_source_post_processing_runs_status" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text])),
	CONSTRAINT "ck_source_post_processing_runs_trigger_type" CHECK ((trigger_type)::text = ANY (ARRAY[('items_materialized'::character varying)::text, ('schedule'::character varying)::text, ('manual'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "source_recipe_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_connection_id" varchar(36) NOT NULL,
	"version_number" integer NOT NULL,
	"recipe_json" jsonb NOT NULL,
	"policy_envelope_json" jsonb NOT NULL,
	"primitive_versions_json" jsonb,
	"status" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36),
	"proposal_id" varchar(36),
	"test_result_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "uq_source_recipe_versions_connection_version" UNIQUE("source_connection_id","version_number"),
	CONSTRAINT "ck_source_recipe_versions_status" CHECK ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('test_failed'::character varying)::text, ('pending_approval'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text])),
	CONSTRAINT "ck_source_recipe_versions_version_number" CHECK (version_number > 0)
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"owner_user_id" varchar(36),
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	"source_item_id" varchar(36),
	"connection_id" varchar(36),
	"snapshot_type" varchar(32) NOT NULL,
	"artifact_id" varchar(36),
	"content_hash" varchar(128),
	"source_uri" text,
	"capture_method" varchar(64) NOT NULL,
	"trust_level" varchar(32) NOT NULL,
	"metadata_json" jsonb,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_source_snapshots_capture_method" CHECK ((capture_method)::text = ANY (ARRAY[('manual'::character varying)::text, ('connection_scan'::character varying)::text, ('full_text'::character varying)::text, ('snapshot'::character varying)::text, ('internal'::character varying)::text, ('custom_source_handler'::character varying)::text, ('source_recipe'::character varying)::text])),
	CONSTRAINT "ck_source_snapshots_snapshot_type" CHECK ((snapshot_type)::text = ANY (ARRAY[('metadata'::character varying)::text, ('raw'::character varying)::text, ('extracted'::character varying)::text, ('summary'::character varying)::text])),
	CONSTRAINT "ck_source_snapshots_trust_level" CHECK ((trust_level)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text])),
	CONSTRAINT "ck_source_snapshots_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_source_snapshots_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_source_snapshots_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "source_connectors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"connector_key" varchar(128) NOT NULL,
	"display_name" varchar(256) NOT NULL,
	"connector_type" varchar(64) NOT NULL,
	"ingestion_mode" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"config_schema_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_connectors_connector_key_key" UNIQUE("connector_key"),
	CONSTRAINT "ck_source_connectors_connector_type" CHECK (connector_type IN ('external_feed','external_url','internal_activity','internal_artifact','internal_run','file','document')),
	CONSTRAINT "ck_source_connectors_ingestion_mode" CHECK (ingestion_mode IN ('pull','manual','internal')),
	CONSTRAINT "ck_source_connectors_status" CHECK (status IN ('active','disabled')),
	CONSTRAINT "ck_source_connectors_capabilities_object" CHECK (jsonb_typeof(capabilities_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "source_provider_connectors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider_id" varchar(36) NOT NULL,
	"connector_id" varchar(36) NOT NULL,
	"status" varchar(32) NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"config_schema_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_provider_connectors_provider_connector" UNIQUE("provider_id","connector_id"),
	CONSTRAINT "uq_source_provider_connectors_id_provider" UNIQUE("id","provider_id"),
	CONSTRAINT "ck_source_provider_connectors_status" CHECK (status IN ('active','disabled')),
	CONSTRAINT "ck_source_provider_connectors_priority" CHECK (priority >= 0),
	CONSTRAINT "ck_source_provider_connectors_capabilities_object" CHECK (jsonb_typeof(capabilities_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "source_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider_key" varchar(128) NOT NULL,
	"display_name" varchar(256) NOT NULL,
	"provider_kind" varchar(32) NOT NULL,
	"category" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"config_schema_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_providers_provider_key_key" UNIQUE("provider_key"),
	CONSTRAINT "ck_source_providers_kind" CHECK (provider_kind IN ('named','generic')),
	CONSTRAINT "ck_source_providers_status" CHECK (status IN ('active','disabled')),
	CONSTRAINT "ck_source_providers_capabilities_object" CHECK (jsonb_typeof(capabilities_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "source_channel_item_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"matched_at" timestamp with time zone NOT NULL,
	"match_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_channel_item_links_channel_item" UNIQUE("source_channel_id","source_item_id"),
	CONSTRAINT "ck_source_channel_item_links_status" CHECK (status IN ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "source_channel_user_subscriptions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"status" varchar(32) NOT NULL,
	"library_enabled" boolean DEFAULT true NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"recommended_by_user_id" varchar(36),
	"recommendation_message" text,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_source_channel_user_subscriptions_status" CHECK (status IN ('subscribed','pending','dismissed','muted'))
);
--> statement-breakpoint
CREATE TABLE "source_channels" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_connection_id" varchar(36) NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"name" varchar(512) NOT NULL,
	"channel_type" varchar(32) NOT NULL,
	"endpoint_url" text,
	"query_json" jsonb,
	"provider_query_json" jsonb,
	"query_fingerprint" varchar(128),
	"status" varchar(32) NOT NULL,
	"fetch_frequency" varchar(32) NOT NULL,
	"schedule_rule_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_channels_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_source_channels_type" CHECK (channel_type IN ('search','feed','web_page','custom_source')),
	CONSTRAINT "ck_source_channels_status" CHECK (status IN ('active','paused','archived')),
	CONSTRAINT "ck_source_channels_fetch_frequency" CHECK (fetch_frequency IN ('manual','hourly','daily','weekly')),
	CONSTRAINT "ck_source_channels_query_object" CHECK (jsonb_typeof(query_json) = 'object'::text),
	CONSTRAINT "ck_source_channels_provider_query_object" CHECK (jsonb_typeof(provider_query_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "source_search_specs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"provider_key" varchar(32) NOT NULL,
	"research_query_attempt_id" varchar(36),
	"compiled_provider_query_json" jsonb NOT NULL,
	"query_fingerprint" varchar(128) NOT NULL,
	"active_version" integer DEFAULT 1 NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_source_search_specs_provider" CHECK (provider_key IN ('arxiv','openalex','semantic_scholar','web_search')),
	CONSTRAINT "ck_source_search_specs_version" CHECK (active_version >= 1),
	CONSTRAINT "ck_source_search_specs_compiled_query" CHECK (jsonb_typeof(compiled_provider_query_json) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "source_item_annotations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_item_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"domain_key" varchar(64),
	"depth" varchar(24),
	"genre" varchar(24),
	"summary" text,
	"stance_target" varchar(256),
	"stance_target_key" varchar(256),
	"stance_polarity" varchar(16),
	"stance_confidence" integer,
	"topic_candidates_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"annotation_run_id" varchar(36),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_json" jsonb,
	"annotated_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_item_annotations_space_item" UNIQUE("space_id","source_item_id"),
	CONSTRAINT "uq_source_item_annotations_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "ck_source_item_annotations_status" CHECK (status IN ('pending','succeeded','failed','skipped')),
	CONSTRAINT "ck_source_item_annotations_topic_candidates" CHECK (jsonb_typeof(topic_candidates_json) = 'array'),
	CONSTRAINT "ck_source_item_annotations_stance_polarity" CHECK (stance_polarity IS NULL OR stance_polarity IN ('supports','opposes','mixed','neutral')),
	CONSTRAINT "ck_source_item_annotations_stance_confidence" CHECK (stance_confidence IS NULL OR stance_confidence BETWEEN 0 AND 100),
	CONSTRAINT "ck_source_item_annotations_stance_shape" CHECK (stance_polarity IS NULL OR ((stance_polarity IN ('supports','opposes') AND stance_target IS NOT NULL AND stance_target_key IS NOT NULL) OR (stance_polarity IN ('mixed','neutral') AND stance_target_key IS NULL))),
	CONSTRAINT "ck_source_item_annotations_succeeded_complete" CHECK (status <> 'succeeded' OR (domain_key IS NOT NULL AND depth IS NOT NULL AND genre IS NOT NULL AND stance_polarity IS NOT NULL AND stance_confidence IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "source_backfill_plans" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"project_source_binding_id" varchar(36),
	"project_operation_id" varchar(36),
	"requested_by_user_id" varchar(36),
	"origin" varchar(24) NOT NULL,
	"proposal_id" varchar(36),
	"strategy_json" jsonb NOT NULL,
	"quota_policy_json" jsonb NOT NULL,
	"status" varchar(24) NOT NULL,
	"next_eligible_at" timestamp with time zone,
	"segments_total" integer DEFAULT 0 NOT NULL,
	"segments_completed" integer DEFAULT 0 NOT NULL,
	"segments_failed" integer DEFAULT 0 NOT NULL,
	"items_ingested" integer DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"error_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_backfill_plans_idempotency" UNIQUE("space_id","idempotency_key"),
	CONSTRAINT "uq_source_backfill_plans_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_source_backfill_plans_origin" CHECK (origin IN ('user','agent_proposal','system')),
	CONSTRAINT "ck_source_backfill_plans_status" CHECK (status IN ('draft','proposed','approved','running','paused','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "source_backfill_segments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"seq" integer NOT NULL,
	"window_json" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"extraction_job_id" varchar(36),
	"items_ingested" integer DEFAULT 0 NOT NULL,
	"next_eligible_at" timestamp with time zone,
	"error_json" jsonb,
	CONSTRAINT "uq_source_backfill_segments_seq" UNIQUE("plan_id","seq"),
	CONSTRAINT "ck_source_backfill_segments_status" CHECK (status IN ('pending','running','succeeded','failed','skipped')),
	CONSTRAINT "ck_source_backfill_segments_attempt" CHECK (attempt_count>=0)
);
--> statement-breakpoint
CREATE TABLE "source_quota_buckets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"scope_kind" varchar(24) NOT NULL,
	"scope_key" varchar(256) NOT NULL,
	"window" varchar(16) NOT NULL,
	"limit_count" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_source_quota_buckets_scope" UNIQUE("space_id","scope_kind","scope_key","window"),
	CONSTRAINT "ck_source_quota_buckets_scope" CHECK (scope_kind IN ('provider','connector','source_connection','source_channel')),
	CONSTRAINT "ck_source_quota_buckets_window" CHECK ("window" IN ('minute','hour','day')),
	CONSTRAINT "ck_source_quota_buckets_counts" CHECK (limit_count>0 AND used_count>=0)
);
--> statement-breakpoint
CREATE TABLE "space_invitations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"invited_email" varchar(256) NOT NULL,
	"role" varchar(32) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"status" varchar(32) NOT NULL,
	"invited_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "ck_space_invitations_role" CHECK ((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('reviewer'::character varying)::text, ('member'::character varying)::text, ('guest'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "space_memberships" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_space_memberships_space_user" UNIQUE("space_id","user_id"),
	CONSTRAINT "ck_space_memberships_role" CHECK ((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('reviewer'::character varying)::text, ('member'::character varying)::text, ('guest'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"type" varchar(32) NOT NULL,
	"created_by_user_id" varchar(36),
	"snapshot_retention_days_default" integer,
	"snapshot_max_count_default" integer,
	"oversight_mode" varchar(16) DEFAULT 'none' NOT NULL,
	"egress_notifications_enabled" boolean DEFAULT false NOT NULL,
	"member_copy_out_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_spaces_type" CHECK ((type)::text = ANY (ARRAY[('personal'::character varying)::text, ('household'::character varying)::text, ('team'::character varying)::text])),
	CONSTRAINT "ck_spaces_oversight_mode" CHECK ((oversight_mode)::text = ANY (ARRAY[('none'::character varying)::text, ('summary'::character varying)::text, ('content'::character varying)::text, ('full'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"board_id" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"status_key" varchar(64) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"wip_limit" integer,
	"is_done_column" boolean DEFAULT false NOT NULL,
	"is_default_column" boolean DEFAULT false NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_board_columns_id_board_space" UNIQUE("id","board_id","space_id"),
	CONSTRAINT "ck_board_columns_status_key" CHECK (status_key IN ('inbox', 'ready', 'in_progress', 'waiting_for_review', 'blocked', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"project_id" varchar(36),
	"name" varchar(512) NOT NULL,
	"description" text,
	"board_type" varchar(64) DEFAULT 'project_folder' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"default_view" varchar(64),
	"sort_order" integer,
	"metadata_json" jsonb,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_boards_id_space" UNIQUE("id","space_id")
);
--> statement-breakpoint
CREATE TABLE "task_artifacts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"artifact_id" varchar(36) NOT NULL,
	"run_id" varchar(36),
	"role" varchar(32) DEFAULT 'output' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_artifacts_task_artifact" UNIQUE("artifact_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"depends_on_task_id" varchar(36) NOT NULL,
	"dependency_type" varchar(32) DEFAULT 'requires' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_dependencies_task_depends" UNIQUE("depends_on_task_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "task_entity_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" varchar(36) NOT NULL,
	"role" varchar(32) NOT NULL,
	"created_by_actor_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_entity_links_edge" UNIQUE("space_id","task_id","entity_type","entity_id","role"),
	CONSTRAINT "ck_task_entity_links_role" CHECK (role IN ('executes', 'investigates', 'prepares', 'references')),
	CONSTRAINT "ck_task_entity_links_entity_type_format" CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,31}$')
);
--> statement-breakpoint
CREATE TABLE "task_proposals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"proposal_id" varchar(36) NOT NULL,
	"role" varchar(32) DEFAULT 'main_change' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_task_proposals_task_proposal" UNIQUE("proposal_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"project_id" varchar(36),
	"board_id" varchar(36),
	"column_id" varchar(36),
	"parent_task_id" varchar(36),
	"task_role" varchar(32) DEFAULT 'source' NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"task_type" varchar(64) DEFAULT 'general' NOT NULL,
	"status" varchar(64) DEFAULT 'inbox' NOT NULL,
	"priority" varchar(32) DEFAULT 'normal' NOT NULL,
	"risk_level" varchar(32) DEFAULT 'low' NOT NULL,
	"created_by_user_id" varchar(36),
	"created_by_agent_id" varchar(36),
	"assigned_user_id" varchar(36),
	"assigned_agent_id" varchar(36),
	"claimed_by_user_id" varchar(36),
	"claimed_by_agent_id" varchar(36),
	"source_activity_id" varchar(36),
	"source_run_id" varchar(36),
	"source_proposal_id" varchar(36),
	"source_artifact_id" varchar(36),
	"acceptance_criteria_json" jsonb,
	"definition_of_done" text,
	"required_outputs_json" jsonb,
	"due_at" timestamp with time zone,
	"start_after" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"blocked_reason" text,
	"estimated_effort" varchar(64),
	"actual_effort" varchar(64),
	"max_runs" integer,
	"max_cost" double precision,
	"max_duration_seconds" integer,
	"policy_json" jsonb,
	"metadata_json" jsonb,
	"tags" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"owner_user_id" varchar(36),
	"visibility" varchar(32) DEFAULT 'space_shared' NOT NULL,
	"access_level" varchar(16) DEFAULT 'full' NOT NULL,
	CONSTRAINT "uq_tasks_id_space_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_tasks_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_tasks_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_tasks_private_owner" CHECK (visibility = 'space_shared' OR owner_user_id IS NOT NULL),
	CONSTRAINT "ck_tasks_role" CHECK (task_role IN ('source', 'subtask')),
	CONSTRAINT "ck_tasks_status" CHECK (status IN ('inbox', 'ready', 'in_progress', 'waiting_for_review', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "ck_tasks_column_requires_board" CHECK (column_id IS NULL OR board_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "validation_recipes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36),
	"name" varchar(256) NOT NULL,
	"task_type" varchar(64),
	"risk_level" varchar(32) DEFAULT 'low' NOT NULL,
	"commands_json" jsonb NOT NULL,
	"required_checks_json" jsonb NOT NULL,
	"artifact_expectations_json" jsonb,
	"timeout_seconds" integer,
	"requires_clean_git_state" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_validation_recipes_risk_level" CHECK ((risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "cli_usage_import_cursors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"instance_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"user_id" varchar(36),
	"runtime" varchar(64) NOT NULL,
	"credential_profile_id" varchar(36),
	"source_fingerprint" varchar(256) NOT NULL,
	"cursor_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_scanned_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_identity" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"instance_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_instance_identity_instance_id" UNIQUE("instance_id"),
	CONSTRAINT "ck_instance_identity_singleton" CHECK ((id)::text = 'local'::text)
);
--> statement-breakpoint
CREATE TABLE "token_usage_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"instance_id" varchar(36) NOT NULL,
	"reporting_instance_id" varchar(36) NOT NULL,
	"origin_instance_id" varchar(36) NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36),
	"visibility" varchar(32) NOT NULL,
	"access_level" varchar(16) NOT NULL,
	"origin_space_id" varchar(128),
	"event_type" varchar(64) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_resource_type" varchar(64),
	"source_resource_id" varchar(36),
	"execution_channel" varchar(64) NOT NULL,
	"meter_subject_type" varchar(64) NOT NULL,
	"meter_subject_id" varchar(128) NOT NULL,
	"subject_user_id" varchar(36),
	"subject_team_id" varchar(36),
	"adapter_type" varchar(64),
	"runtime_tool_version" varchar(128),
	"provider_id" varchar(36),
	"provider_type" varchar(64),
	"provider_name_snapshot" varchar(256),
	"vendor" varchar(64),
	"model" varchar(256),
	"task" varchar(128),
	"run_id" varchar(36),
	"root_run_id" varchar(36),
	"parent_run_id" varchar(36),
	"run_group_id" varchar(36),
	"session_id" varchar(36),
	"external_session_id" varchar(256),
	"session_path" text,
	"session_name" varchar(256),
	"agent_id" varchar(36),
	"project_id" varchar(36),
	"project_folder_id" varchar(36),
	"trigger_origin" varchar(64),
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_1h_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"estimated_cost_usd" numeric(18, 8),
	"cost_accuracy" varchar(32) DEFAULT 'unknown' NOT NULL,
	"usage_schema" varchar(64) NOT NULL,
	"usage_details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_usage_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_normalization_version" integer DEFAULT 1 NOT NULL,
	"total_tokens_source" varchar(32) NOT NULL,
	"dimensions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_accuracy" varchar(32) NOT NULL,
	"dedupe_confidence" varchar(32) NOT NULL,
	"import_batch_id" varchar(36),
	"idempotency_key" varchar(256) NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_token_usage_events_space_idempotency" UNIQUE("space_id","idempotency_key"),
	CONSTRAINT "ck_token_usage_events_source_type" CHECK ((source_type)::text = ANY (ARRAY[('local_run'::character varying)::text, ('provider_proxy'::character varying)::text, ('cli_history_import'::character varying)::text, ('ambient_host_history'::character varying)::text, ('cross_instance_import'::character varying)::text, ('manual_import'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_event_type" CHECK ((event_type)::text = ANY (ARRAY[('llm.generation'::character varying)::text, ('llm.embedding'::character varying)::text, ('llm.rerank'::character varying)::text, ('cli.history_usage'::character varying)::text, ('usage.adjustment'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_execution_channel" CHECK ((execution_channel)::text = ANY (ARRAY[('managed_api'::character varying)::text, ('provider_proxy'::character varying)::text, ('local_cli'::character varying)::text, ('local_cli_transcript'::character varying)::text, ('manual_import'::character varying)::text, ('cross_instance_import'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_total_tokens_source" CHECK ((total_tokens_source)::text = ANY (ARRAY[('provider_total'::character varying)::text, ('sum_of_buckets'::character varying)::text, ('estimated'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_usage_accuracy" CHECK ((usage_accuracy)::text = ANY (ARRAY[('provider_reported'::character varying)::text, ('proxy_observed'::character varying)::text, ('transcript_lower_bound'::character varying)::text, ('estimated'::character varying)::text, ('quota_snapshot'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_cost_accuracy" CHECK ((cost_accuracy)::text = ANY (ARRAY[('catalog'::character varying)::text, ('unknown'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_cost_provenance" CHECK ((cost_accuracy = 'catalog' AND estimated_cost_usd IS NOT NULL AND estimated_cost_usd >= 0) OR (cost_accuracy = 'unknown' AND estimated_cost_usd IS NULL)),
	CONSTRAINT "ck_token_usage_events_dedupe_confidence" CHECK ((dedupe_confidence)::text = ANY (ARRAY[('high'::character varying)::text, ('medium'::character varying)::text, ('low'::character varying)::text])),
	CONSTRAINT "ck_token_usage_events_visibility" CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
	CONSTRAINT "ck_token_usage_events_access_level" CHECK (access_level IN ('full', 'summary')),
	CONSTRAINT "ck_token_usage_events_source_resource" CHECK ((source_resource_type IS NULL) = (source_resource_id IS NULL)),
	CONSTRAINT "ck_token_usage_events_private_owner" CHECK (visibility <> 'private' OR owner_user_id IS NOT NULL),
	CONSTRAINT "ck_token_usage_events_nonnegative_counts" CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_creation_input_tokens >= 0 AND cache_creation_1h_input_tokens >= 0 AND cache_creation_1h_input_tokens <= cache_creation_input_tokens AND cache_read_input_tokens >= 0 AND reasoning_tokens >= 0 AND request_count >= 0 AND (total_tokens IS NULL OR total_tokens >= 0))
);
--> statement-breakpoint
CREATE TABLE "usage_import_batches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"instance_id" varchar(36) NOT NULL,
	"target_space_id" varchar(36) NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_kind" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"source_fingerprint" varchar(256),
	"preview_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"import_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_usage_import_batches_source_type" CHECK ((source_type)::text = ANY (ARRAY[('claude_code_history'::character varying)::text, ('codex_cli_history'::character varying)::text, ('cross_instance_bundle'::character varying)::text, ('manual_usage_csv'::character varying)::text])),
	CONSTRAINT "ck_usage_import_batches_source_kind" CHECK ((source_kind)::text = ANY (ARRAY[('managed_profile'::character varying)::text, ('uploaded_archive'::character varying)::text, ('server_path'::character varying)::text, ('scanner_manifest'::character varying)::text, ('remote_bundle'::character varying)::text])),
	CONSTRAINT "ck_usage_import_batches_status" CHECK ((status)::text = ANY (ARRAY[('previewed'::character varying)::text, ('importing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" varchar(36),
	"display_name" varchar(120) NOT NULL,
	"device_kind" varchar(32),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" varchar(36),
	"machine_id" varchar(36) NOT NULL,
	"environment_kind" varchar(24) NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(24) NOT NULL,
	"token_hash" varchar(128),
	"pairing_code_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"platform" varchar(64),
	"arch" varchar(32),
	"daemon_version" varchar(32),
	"default_adapter_type" varchar(64),
	"daemon_server_url" varchar(512),
	"provider_proxy_base_url" varchar(512),
	"capabilities_json" jsonb,
	"managed_workspaces_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_hosts_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "uq_hosts_id_kind" UNIQUE("id","kind"),
	CONSTRAINT "ck_hosts_kind" CHECK (kind IN ('server', 'remote')),
	CONSTRAINT "ck_hosts_status" CHECK (status IN ('pending_pairing', 'online', 'offline', 'revoked')),
	CONSTRAINT "ck_hosts_environment_kind" CHECK (environment_kind IN ('windows_native', 'wsl', 'linux_native', 'macos_native', 'vm', 'container', 'server')),
	CONSTRAINT "ck_hosts_server_no_owner" CHECK (kind <> 'server' OR owner_user_id IS NULL),
	CONSTRAINT "ck_hosts_remote_has_owner" CHECK (kind <> 'remote' OR owner_user_id IS NOT NULL),
	CONSTRAINT "ck_hosts_server_environment" CHECK (kind <> 'server' OR environment_kind = 'server')
);
--> statement-breakpoint
CREATE TABLE "host_threads" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36),
	"execution_host_id" varchar(36),
	"workspace_location_id" varchar(36),
	"workspace_mode" varchar(16) DEFAULT 'location' NOT NULL,
	"task_id" varchar(36),
	"session_id" varchar(36),
	"agent_id" varchar(36),
	"container_kind" varchar(16),
	"container_user_id" varchar(36),
	"adapter_type" varchar(64) NOT NULL,
	"runtime_installation" varchar(64) DEFAULT 'own' NOT NULL,
	"vendor_session_id" varchar(256),
	"last_run_id" varchar(36),
	"last_session_id" varchar(36),
	"dispatch_lock_id" varchar(36),
	"retired_vendor_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"pending_archive_at" timestamp with time zone,
	CONSTRAINT "ck_host_threads_workspace_mode" CHECK (workspace_mode IN ('location', 'managed') AND (workspace_mode <> 'location' OR workspace_location_id IS NOT NULL) AND (workspace_mode <> 'managed' OR workspace_location_id IS NULL)),
	CONSTRAINT "ck_host_threads_owner" CHECK (
		(workspace_location_id IS NOT NULL AND session_id IS NULL AND agent_id IS NULL AND container_kind IS NULL AND container_user_id IS NULL)
		OR (task_id IS NULL AND session_id IS NULL AND agent_id IS NOT NULL AND container_kind = 'direct' AND container_user_id IS NOT NULL)
		OR (task_id IS NULL AND session_id IS NOT NULL AND space_id IS NOT NULL AND execution_host_id IS NOT NULL AND agent_id IS NOT NULL AND container_kind = 'conversation' AND container_user_id IS NULL)
	),
	CONSTRAINT "ck_host_threads_container_kind" CHECK (container_kind IS NULL OR container_kind IN ('direct', 'conversation')),
	CONSTRAINT "ck_host_threads_status" CHECK (status IN ('active', 'session_reset', 'closed')),
	CONSTRAINT "ck_host_threads_retired_sessions_array" CHECK (jsonb_typeof(retired_vendor_session_ids) = 'array')
);
--> statement-breakpoint
CREATE TABLE "host_thread_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"host_task_thread_id" varchar(36) NOT NULL,
	"project_id" varchar(36),
	"run_id" varchar(36) NOT NULL,
	"event_index" integer NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"text" text,
	"tool_call_id" varchar(128),
	"tool_name" varchar(128),
	"tool_input_summary" text,
	"tool_kind" varchar(32),
	"tool_result_summary" text,
	"status" varchar(32),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_host_thread_events_thread_event_index" UNIQUE("host_task_thread_id","event_index"),
	CONSTRAINT "ck_host_thread_events_event_type" CHECK ((event_type)::text = ANY (ARRAY[('assistant_text'::character varying)::text, ('assistant_thought'::character varying)::text, ('tool_activity_started'::character varying)::text, ('tool_activity_finished'::character varying)::text, ('status'::character varying)::text, ('diagnostic'::character varying)::text, ('plan_updated'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "host_runtime_provider_bindings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"host_id" varchar(36) NOT NULL,
	"adapter_type" varchar(64) NOT NULL,
	"model_provider_id" varchar(36) NOT NULL,
	"model" varchar(256),
	"created_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_host_runtime_provider_bindings_host_adapter" UNIQUE("host_id","adapter_type")
);
--> statement-breakpoint
CREATE TABLE "project_folder_execution_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"repo_type" varchar(64),
	"tech_stack_json" jsonb,
	"important_paths_json" jsonb,
	"forbidden_paths_json" jsonb,
	"test_commands_json" jsonb,
	"build_commands_json" jsonb,
	"architecture_boundaries_json" jsonb,
	"validation_recipe_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_project_folder_execution_configs_project_folder" UNIQUE("project_folder_id")
);
--> statement-breakpoint
CREATE TABLE "project_folders" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"repo_url" text,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by_user_id" varchar(36),
	"slug" varchar(256),
	"kind" varchar(16) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"default_branch" varchar(256),
	"protected" boolean NOT NULL,
	"system_managed" boolean NOT NULL,
	"registered_from" varchar(32),
	"metadata_json" jsonb,
	"allow_external_root" boolean DEFAULT false NOT NULL,
	"snapshot_retention_days" integer,
	"snapshot_max_count" integer,
	CONSTRAINT "uq_project_folders_space_id_id" UNIQUE("id","space_id"),
	CONSTRAINT "ck_project_folders_kind" CHECK (kind IN ('code', 'data', 'docs')),
	CONSTRAINT "ck_project_folders_status" CHECK ((status)::text = ANY (ARRAY['active'::text, 'archived'::text, 'stale'::text]))
);
--> statement-breakpoint
CREATE TABLE "workspace_locations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_folder_id" varchar(36) NOT NULL,
	"execution_host_id" varchar(36) NOT NULL,
	"execution_host_kind" varchar(16) NOT NULL,
	"display_path" varchar(1024),
	"root_path" varchar(1024),
	"branch" varchar(256),
	"git_head" varchar(64),
	"dirty" boolean,
	"execution_ready" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"ambient_import_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ambient_session_counts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_workspace_locations_id_folder" UNIQUE("id","project_folder_id"),
	CONSTRAINT "uq_workspace_locations_id_host" UNIQUE("id","execution_host_id"),
	CONSTRAINT "ck_workspace_locations_status" CHECK (status IN ('active', 'archived', 'stale')),
	CONSTRAINT "ck_workspace_locations_execution_host_kind" CHECK (execution_host_kind IN ('server', 'remote')),
	CONSTRAINT "ck_workspace_locations_remote_no_root_path" CHECK (execution_host_kind <> 'remote' OR root_path IS NULL)
);
--> statement-breakpoint
ALTER TABLE "academic_papers" ADD CONSTRAINT "academic_papers_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_papers" ADD CONSTRAINT "academic_papers_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."sources"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "fk_activity_records_project_id_projects" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "fk_activity_records_source_task_id_tasks" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_records" ADD CONSTRAINT "fk_activity_records_subject_user_id_users" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approval_grants" ADD CONSTRAINT "action_approval_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approval_grants" ADD CONSTRAINT "action_approval_grants_agent_id_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approval_grants" ADD CONSTRAINT "action_approval_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approval_grants" ADD CONSTRAINT "action_approval_grants_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approval_grants" ADD CONSTRAINT "action_approval_grants_target_run_id_fkey" FOREIGN KEY ("target_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_group_members" ADD CONSTRAINT "agent_run_group_members_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_group_members" ADD CONSTRAINT "agent_run_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."agent_run_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_group_members" ADD CONSTRAINT "agent_run_group_members_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_group_members" ADD CONSTRAINT "fk_agent_run_group_members_agent_same_space" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_group_members" ADD CONSTRAINT "fk_agent_run_group_members_group_same_space" FOREIGN KEY ("group_id","space_id") REFERENCES "public"."agent_run_groups"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_manager_agent_id_fkey" FOREIGN KEY ("manager_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_manager_user_id_fkey" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_root_run_id_fkey" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_project_folder_scope_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "fk_agent_run_groups_manager_agent_same_space" FOREIGN KEY ("manager_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_room_scope_fkey" FOREIGN KEY ("room_id","space_id","project_id") REFERENCES "public"."rooms"("id","space_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_room_session_scope_fkey" FOREIGN KEY ("session_id","space_id","room_id","project_id") REFERENCES "public"."sessions"("id","space_id","room_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "agent_run_groups_trigger_message_scope_fkey" FOREIGN KEY ("trigger_message_id","space_id","session_id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_groups" ADD CONSTRAINT "fk_agent_run_groups_root_run_same_space" FOREIGN KEY ("root_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."agent_run_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "public"."agent_run_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_sender_agent_id_fkey" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "fk_agent_run_messages_group_same_space" FOREIGN KEY ("group_id","space_id") REFERENCES "public"."agent_run_groups"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "fk_agent_run_messages_parent_same_space" FOREIGN KEY ("parent_message_id","space_id") REFERENCES "public"."agent_run_messages"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "fk_agent_run_messages_run_same_space" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "fk_agent_run_messages_sender_agent_same_space" FOREIGN KEY ("sender_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_child_run_id_fkey" FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."agent_run_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_policy_decision_record_id_fkey" FOREIGN KEY ("policy_decision_record_id") REFERENCES "public"."policy_decision_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_request_message_id_fkey" FOREIGN KEY ("request_message_id") REFERENCES "public"."agent_run_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_requesting_agent_id_fkey" FOREIGN KEY ("requesting_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "run_delegations_target_agent_id_fkey" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_child_run_same_space" FOREIGN KEY ("child_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_group_same_space" FOREIGN KEY ("group_id","space_id") REFERENCES "public"."agent_run_groups"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_parent_run_same_space" FOREIGN KEY ("parent_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_policy_decision_same_space" FOREIGN KEY ("policy_decision_record_id","space_id") REFERENCES "public"."policy_decision_records"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_request_message_same_space" FOREIGN KEY ("request_message_id","space_id") REFERENCES "public"."agent_run_messages"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_requesting_agent_same_space" FOREIGN KEY ("requesting_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_delegations" ADD CONSTRAINT "fk_run_delegations_target_agent_same_space" FOREIGN KEY ("target_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_model_provider_id_fkey" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_execution_host_id_fkey" FOREIGN KEY ("execution_host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_workspace_location_id_fkey" FOREIGN KEY ("workspace_location_id") REFERENCES "public"."workspace_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_model_provider_id_fkey" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "fk_agent_versions_source_activity_id_activity_records" FOREIGN KEY ("source_activity_id") REFERENCES "public"."activity_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "fk_agent_versions_source_proposal_id_proposals" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "fk_agents_project_id_projects" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "fk_agents_current_version_id_agent_versions" FOREIGN KEY ("current_version_id","id","space_id") REFERENCES "public"."agent_versions"("id","agent_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_events" ADD CONSTRAINT "cli_credential_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_events" ADD CONSTRAINT "cli_credential_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_profiles" ADD CONSTRAINT "cli_credential_profiles_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_space_grants" ADD CONSTRAINT "cli_credential_space_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_space_grants" ADD CONSTRAINT "cli_credential_space_grants_network_profile_id_fkey" FOREIGN KEY ("network_profile_id") REFERENCES "public"."network_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_space_grants" ADD CONSTRAINT "cli_credential_space_grants_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_space_grants" ADD CONSTRAINT "cli_credential_space_grants_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."cli_credential_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_credential_space_grants" ADD CONSTRAINT "cli_credential_space_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "fk_artifacts_project_id_projects" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_run_id_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_agent_id_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_policy_decision_record_id_fkey" FOREIGN KEY ("policy_decision_record_id","space_id") REFERENCES "public"."policy_decision_records"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_instructed_by_user_id_fkey" FOREIGN KEY ("instructed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_resulting_action_grant_binding_fkey" FOREIGN KEY ("resulting_action_grant_id","space_id","agent_id","action_id","run_id") REFERENCES "public"."action_approval_grants"("id","space_id","agent_id","action_id","target_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_credential_grants" ADD CONSTRAINT "automation_credential_grants_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_credential_grants" ADD CONSTRAINT "automation_credential_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_credential_grants" ADD CONSTRAINT "automation_credential_grants_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_credential_grants" ADD CONSTRAINT "automation_credential_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workflow_execution_automation_fkey" FOREIGN KEY ("workflow_execution_id","automation_id") REFERENCES "public"."workflow_executions"("id","automation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_dependencies" ADD CONSTRAINT "workflow_execution_dependencies_execution_space_fkey" FOREIGN KEY ("execution_id","space_id") REFERENCES "public"."workflow_executions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_dependencies" ADD CONSTRAINT "workflow_execution_dependencies_node_space_fkey" FOREIGN KEY ("node_id","space_id") REFERENCES "public"."workflow_execution_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_dependencies" ADD CONSTRAINT "workflow_execution_dependencies_depends_on_space_fkey" FOREIGN KEY ("depends_on_node_id","space_id") REFERENCES "public"."workflow_execution_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_dependencies" ADD CONSTRAINT "workflow_execution_dependencies_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_node_runs" ADD CONSTRAINT "workflow_execution_node_runs_node_space_fkey" FOREIGN KEY ("node_id","space_id") REFERENCES "public"."workflow_execution_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_node_runs" ADD CONSTRAINT "workflow_execution_node_runs_run_space_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_node_runs" ADD CONSTRAINT "workflow_execution_node_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_nodes" ADD CONSTRAINT "workflow_execution_nodes_execution_space_fkey" FOREIGN KEY ("execution_id","space_id") REFERENCES "public"."workflow_executions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_nodes" ADD CONSTRAINT "workflow_execution_nodes_agent_delete_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_nodes" ADD CONSTRAINT "workflow_execution_nodes_agent_space_fkey" FOREIGN KEY ("assigned_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_nodes" ADD CONSTRAINT "workflow_execution_nodes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_automation_space_fkey" FOREIGN KEY ("automation_id","space_id") REFERENCES "public"."automations"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_root_run_delete_fkey" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_root_run_space_fkey" FOREIGN KEY ("root_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_version_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidate_evolution_signals" ADD CONSTRAINT "autonomy_candidate_evolution_signals_candidate_space_fkey" FOREIGN KEY ("candidate_id","space_id") REFERENCES "public"."autonomy_candidates"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidate_evolution_signals" ADD CONSTRAINT "autonomy_candidate_evolution_signals_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "public"."evolution_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidate_evolution_signals" ADD CONSTRAINT "autonomy_candidate_evolution_signals_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_project_space_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_first_tick_space_fkey" FOREIGN KEY ("first_seen_tick_id","space_id") REFERENCES "public"."autonomy_ticks"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_last_tick_space_fkey" FOREIGN KEY ("last_seen_tick_id","space_id") REFERENCES "public"."autonomy_ticks"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_launch_tick_space_fkey" FOREIGN KEY ("launch_tick_id","space_id") REFERENCES "public"."autonomy_ticks"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_run_id_delete_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_run_space_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_candidates" ADD CONSTRAINT "autonomy_candidates_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_review_cursors" ADD CONSTRAINT "autonomy_review_cursors_candidate_space_fkey" FOREIGN KEY ("candidate_id","space_id") REFERENCES "public"."autonomy_candidates"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_review_cursors" ADD CONSTRAINT "autonomy_review_cursors_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_review_cursors" ADD CONSTRAINT "autonomy_review_cursors_last_fact_id_fkey" FOREIGN KEY ("last_fact_id") REFERENCES "public"."evolution_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_review_cursors" ADD CONSTRAINT "autonomy_review_cursors_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_tick_candidates" ADD CONSTRAINT "autonomy_tick_candidates_tick_space_fkey" FOREIGN KEY ("tick_id","space_id") REFERENCES "public"."autonomy_ticks"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_tick_candidates" ADD CONSTRAINT "autonomy_tick_candidates_candidate_space_fkey" FOREIGN KEY ("candidate_id","space_id") REFERENCES "public"."autonomy_candidates"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_tick_candidates" ADD CONSTRAINT "autonomy_tick_candidates_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_ticks" ADD CONSTRAINT "autonomy_ticks_automation_space_fkey" FOREIGN KEY ("automation_id","space_id") REFERENCES "public"."automations"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_ticks" ADD CONSTRAINT "autonomy_ticks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_ticks" ADD CONSTRAINT "autonomy_ticks_automation_run_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_ticks" ADD CONSTRAINT "autonomy_ticks_coordinator_run_space_fkey" FOREIGN KEY ("coordinator_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_ticks" ADD CONSTRAINT "autonomy_ticks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_capture_gaps" ADD CONSTRAINT "context_capture_gaps_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_checkpoint_corrections" ADD CONSTRAINT "context_checkpoint_corrections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_checkpoint_corrections" ADD CONSTRAINT "context_checkpoint_corrections_checkpoint_id_fkey" FOREIGN KEY ("semantic_checkpoint_id") REFERENCES "public"."context_semantic_checkpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_checkpoint_corrections" ADD CONSTRAINT "context_checkpoint_corrections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_event_scopes" ADD CONSTRAINT "context_event_scopes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_events" ADD CONSTRAINT "context_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_events" ADD CONSTRAINT "context_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_events" ADD CONSTRAINT "context_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_micro_checkpoints" ADD CONSTRAINT "context_micro_checkpoints_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_semantic_checkpoints" ADD CONSTRAINT "context_semantic_checkpoints_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_semantic_checkpoints" ADD CONSTRAINT "context_semantic_checkpoints_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "public"."context_semantic_checkpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_window_reconciliations" ADD CONSTRAINT "context_window_reconciliations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_control_snapshots" ADD CONSTRAINT "execution_control_snapshots_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_control_snapshots" ADD CONSTRAINT "execution_control_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocation_deliveries" ADD CONSTRAINT "invocation_deliveries_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocation_deliveries" ADD CONSTRAINT "invocation_deliveries_control_id_fkey" FOREIGN KEY ("execution_control_snapshot_id") REFERENCES "public"."execution_control_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocation_snapshots" ADD CONSTRAINT "invocation_snapshots_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocation_snapshots" ADD CONSTRAINT "invocation_snapshots_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."invocation_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_task_controls" ADD CONSTRAINT "provider_task_controls_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_task_deliveries" ADD CONSTRAINT "provider_task_deliveries_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_task_deliveries" ADD CONSTRAINT "provider_task_deliveries_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "public"."provider_task_controls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_task_snapshots" ADD CONSTRAINT "provider_task_snapshots_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_task_snapshots" ADD CONSTRAINT "provider_task_snapshots_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."provider_task_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_runtime_scope_fkey" FOREIGN KEY ("runtime_profile_id","space_id","agent_id") REFERENCES "public"."agent_runtime_profiles"("id","space_id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_credential_owner_fkey" FOREIGN KEY ("credential_profile_id","user_id") REFERENCES "public"."cli_credential_profiles"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_cli_bindings" ADD CONSTRAINT "runtime_context_cli_bindings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_audits" ADD CONSTRAINT "runtime_context_policy_audits_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_audits" ADD CONSTRAINT "runtime_context_policy_audits_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_audits" ADD CONSTRAINT "runtime_context_policy_audits_base_version_id_fkey" FOREIGN KEY ("base_version_id") REFERENCES "public"."runtime_context_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_audits" ADD CONSTRAINT "runtime_context_policy_audits_new_version_id_fkey" FOREIGN KEY ("new_version_id") REFERENCES "public"."runtime_context_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_audits" ADD CONSTRAINT "runtime_context_policy_audits_policy_decision_record_id_fkey" FOREIGN KEY ("policy_decision_record_id","space_id") REFERENCES "public"."policy_decision_records"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_bindings" ADD CONSTRAINT "runtime_context_policy_bindings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_bindings" ADD CONSTRAINT "runtime_context_policy_bindings_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "public"."runtime_context_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_bindings" ADD CONSTRAINT "runtime_context_policy_bindings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_versions" ADD CONSTRAINT "runtime_context_policy_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_versions" ADD CONSTRAINT "runtime_context_policy_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_context_policy_versions" ADD CONSTRAINT "runtime_context_policy_versions_base_version_id_fkey" FOREIGN KEY ("base_version_id") REFERENCES "public"."runtime_context_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_invocation_payload_access_audits" ADD CONSTRAINT "sealed_payload_access_audits_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_invocation_payload_access_audits" ADD CONSTRAINT "sealed_payload_access_audits_payload_id_fkey" FOREIGN KEY ("sealed_payload_id") REFERENCES "public"."sealed_invocation_payloads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_invocation_payload_access_audits" ADD CONSTRAINT "sealed_payload_access_audits_viewer_user_id_fkey" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_invocation_payloads" ADD CONSTRAINT "sealed_invocation_payloads_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_invocation_payloads" ADD CONSTRAINT "sealed_invocation_payloads_snapshot_id_fkey" FOREIGN KEY ("invocation_snapshot_id") REFERENCES "public"."invocation_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_project_brief_version_id_fkey" FOREIGN KEY ("project_brief_version_id") REFERENCES "public"."project_brief_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_project_instruction_version_id_fkey" FOREIGN KEY ("project_instruction_version_id") REFERENCES "public"."project_instruction_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_context_setups" ADD CONSTRAINT "work_context_setups_policy_decision_record_id_fkey" FOREIGN KEY ("policy_decision_record_id") REFERENCES "public"."policy_decision_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_enablements" ADD CONSTRAINT "capability_enablements_capability_version_fkey" FOREIGN KEY ("capability_version_id","space_id") REFERENCES "public"."capability_versions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_enablements" ADD CONSTRAINT "capability_enablements_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_enablements" ADD CONSTRAINT "capability_enablements_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_enablements" ADD CONSTRAINT "capability_enablements_agent_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_enablements" ADD CONSTRAINT "capability_enablements_user_membership_fkey" FOREIGN KEY ("space_id","user_id") REFERENCES "public"."space_memberships"("space_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_runtime_bindings" ADD CONSTRAINT "capability_runtime_bindings_capability_version_id_fkey" FOREIGN KEY ("capability_version_id") REFERENCES "public"."capability_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_runtime_bindings" ADD CONSTRAINT "capability_runtime_bindings_capability_version_space_fkey" FOREIGN KEY ("capability_version_id","space_id") REFERENCES "public"."capability_versions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_runtime_bindings" ADD CONSTRAINT "capability_runtime_bindings_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_versions" ADD CONSTRAINT "capability_versions_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_versions" ADD CONSTRAINT "capability_versions_proposal_fkey" FOREIGN KEY ("proposal_id","space_id") REFERENCES "public"."proposals"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_versions" ADD CONSTRAINT "capability_versions_parent_version_fkey" FOREIGN KEY ("parent_version_id","space_id") REFERENCES "public"."capability_versions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_local_overlays" ADD CONSTRAINT "skill_local_overlays_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_local_overlays" ADD CONSTRAINT "skill_local_overlays_skill_package_id_fkey" FOREIGN KEY ("skill_package_id") REFERENCES "public"."skill_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_local_overlays" ADD CONSTRAINT "skill_local_overlays_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_package_files" ADD CONSTRAINT "skill_package_files_skill_package_id_fkey" FOREIGN KEY ("skill_package_id") REFERENCES "public"."skill_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."skill_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_review_states" ADD CONSTRAINT "card_review_states_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_review_states" ADD CONSTRAINT "card_review_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_grants" ADD CONSTRAINT "content_access_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_grants" ADD CONSTRAINT "content_access_grants_grantee_membership_fkey" FOREIGN KEY ("space_id","grantee_user_id") REFERENCES "public"."space_memberships"("space_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_grants" ADD CONSTRAINT "content_access_grants_grantor_membership_fkey" FOREIGN KEY ("space_id","granted_by_user_id") REFERENCES "public"."space_memberships"("space_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_grants" ADD CONSTRAINT "content_access_grants_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_logs" ADD CONSTRAINT "content_access_logs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_logs" ADD CONSTRAINT "content_access_logs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_logs" ADD CONSTRAINT "content_access_logs_viewer_user_id_fkey" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_logs" ADD CONSTRAINT "content_access_logs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_logs" ADD CONSTRAINT "content_access_logs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_demotion_disclosures" ADD CONSTRAINT "content_demotion_disclosures_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_demotion_disclosures" ADD CONSTRAINT "content_demotion_disclosures_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_project_shares" ADD CONSTRAINT "space_object_project_shares_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_project_shares" ADD CONSTRAINT "space_object_project_shares_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_project_shares" ADD CONSTRAINT "space_object_project_shares_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_project_shares" ADD CONSTRAINT "space_object_project_shares_sharer_membership_fkey" FOREIGN KEY ("space_id","shared_by_user_id") REFERENCES "public"."space_memberships"("space_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_project_shares" ADD CONSTRAINT "space_object_project_shares_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_egress_records" ADD CONSTRAINT "content_egress_records_source_space_id_fkey" FOREIGN KEY ("source_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_egress_records" ADD CONSTRAINT "content_egress_records_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_egress_records" ADD CONSTRAINT "content_egress_records_target_personal_space_id_fkey" FOREIGN KEY ("target_personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_egress_records" ADD CONSTRAINT "content_egress_records_target_artifact_space_fkey" FOREIGN KEY ("target_artifact_id","target_personal_space_id") REFERENCES "public"."artifacts"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_egress_records" ADD CONSTRAINT "content_egress_records_disclosure_id_fkey" FOREIGN KEY ("disclosure_id") REFERENCES "public"."cross_space_egress_disclosures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_space_egress_disclosures" ADD CONSTRAINT "cross_space_egress_disclosures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_space_egress_disclosures" ADD CONSTRAINT "cross_space_egress_disclosures_personal_space_id_fkey" FOREIGN KEY ("personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_space_retrieval_pointers" ADD CONSTRAINT "cross_space_retrieval_pointers_session_user_fkey" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."cross_space_retrieval_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_space_retrieval_pointers" ADD CONSTRAINT "cross_space_retrieval_pointers_resource_space_id_fkey" FOREIGN KEY ("resource_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_space_retrieval_sessions" ADD CONSTRAINT "cross_space_retrieval_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_space_retrieval_sessions" ADD CONSTRAINT "cross_space_retrieval_sessions_personal_space_id_fkey" FOREIGN KEY ("personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_notifications" ADD CONSTRAINT "space_member_notifications_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_notifications" ADD CONSTRAINT "space_member_notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_cases" ADD CONSTRAINT "decision_cases_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_commitments" ADD CONSTRAINT "decision_commitments_case_fkey" FOREIGN KEY ("decision_case_id","space_id") REFERENCES "public"."decision_cases"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_commitments" ADD CONSTRAINT "decision_commitments_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_commitments" ADD CONSTRAINT "decision_commitments_committed_by_user_id_fkey" FOREIGN KEY ("committed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD CONSTRAINT "decision_criteria_case_fkey" FOREIGN KEY ("decision_case_id","space_id") REFERENCES "public"."decision_cases"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD CONSTRAINT "decision_criteria_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_criteria" ADD CONSTRAINT "decision_criteria_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_option_scores" ADD CONSTRAINT "decision_option_scores_option_fkey" FOREIGN KEY ("option_id","decision_case_id","space_id") REFERENCES "public"."decision_options"("id","decision_case_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_option_scores" ADD CONSTRAINT "decision_option_scores_criterion_fkey" FOREIGN KEY ("criterion_id","decision_case_id","space_id") REFERENCES "public"."decision_criteria"("id","decision_case_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_option_scores" ADD CONSTRAINT "decision_option_scores_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_option_scores" ADD CONSTRAINT "decision_option_scores_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_case_fkey" FOREIGN KEY ("decision_case_id","space_id") REFERENCES "public"."decision_cases"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_change_outbox" ADD CONSTRAINT "domain_change_outbox_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundle_members" ADD CONSTRAINT "evolution_bundle_members_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."evolution_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundle_members" ADD CONSTRAINT "evolution_bundle_members_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundle_members" ADD CONSTRAINT "evolution_bundle_members_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundles" ADD CONSTRAINT "evolution_bundles_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_bundles" ADD CONSTRAINT "evolution_bundles_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_experiences" ADD CONSTRAINT "evolution_experiences_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_experiences" ADD CONSTRAINT "evolution_experiences_strategy_asset_id_fkey" FOREIGN KEY ("strategy_asset_id") REFERENCES "public"."evolution_strategy_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_experiences" ADD CONSTRAINT "evolution_experiences_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."evolution_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_experiences" ADD CONSTRAINT "evolution_experiences_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_experiences" ADD CONSTRAINT "evolution_experiences_source_proposal_id_fkey" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_selector_decisions" ADD CONSTRAINT "evolution_selector_decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_selector_decisions" ADD CONSTRAINT "evolution_selector_decisions_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."evolution_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_selector_decisions" ADD CONSTRAINT "evolution_selector_decisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_selector_decisions" ADD CONSTRAINT "evolution_selector_decisions_selected_strategy_asset_id_fkey" FOREIGN KEY ("selected_strategy_asset_id") REFERENCES "public"."evolution_strategy_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_signals" ADD CONSTRAINT "evolution_signals_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_signals" ADD CONSTRAINT "evolution_signals_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."evolution_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_strategy_assets" ADD CONSTRAINT "evolution_strategy_assets_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_targets" ADD CONSTRAINT "evolution_targets_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolution_targets" ADD CONSTRAINT "evolution_targets_current_version_fkey" FOREIGN KEY ("current_version_id","space_id") REFERENCES "public"."capability_versions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reflections" ADD CONSTRAINT "run_reflections_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reflections" ADD CONSTRAINT "run_reflections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_areas" ADD CONSTRAINT "focus_areas_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_areas" ADD CONSTRAINT "focus_areas_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."evolvable_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_baseline_version_id_fkey" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."evolvable_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_candidate_version_id_fkey" FOREIGN KEY ("candidate_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_baseline_version_id_fkey" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_evolution_target_id_fkey" FOREIGN KEY ("evolution_target_id") REFERENCES "public"."evolution_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_output_artifact_id_fkey" FOREIGN KEY ("output_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_report_artifact_id_fkey" FOREIGN KEY ("report_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_evaluation_runs" ADD CONSTRAINT "evolvable_asset_evaluation_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_pins" ADD CONSTRAINT "evolvable_asset_pins_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."evolvable_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_pins" ADD CONSTRAINT "evolvable_asset_pins_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_pins" ADD CONSTRAINT "evolvable_asset_pins_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_pins" ADD CONSTRAINT "evolvable_asset_pins_pinned_by_user_id_fkey" FOREIGN KEY ("pinned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "evolvable_asset_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."evolvable_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "evolvable_asset_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "evolvable_asset_versions_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "evolvable_asset_versions_promotion_proposal_id_fkey" FOREIGN KEY ("promotion_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "evolvable_asset_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_asset_versions" ADD CONSTRAINT "evolvable_asset_versions_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_assets" ADD CONSTRAINT "evolvable_assets_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolvable_assets" ADD CONSTRAINT "evolvable_assets_current_system_version_id_fkey" FOREIGN KEY ("current_system_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_thread_fkey" FOREIGN KEY ("primary_hypothesis_thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_baseline_run_delete_fkey" FOREIGN KEY ("baseline_run_id") REFERENCES "public"."experiment_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_baseline_run_id_fkey" FOREIGN KEY ("baseline_run_id","space_id") REFERENCES "public"."experiment_runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_best_run_delete_fkey" FOREIGN KEY ("best_run_id") REFERENCES "public"."experiment_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_definitions" ADD CONSTRAINT "experiment_definitions_best_run_id_fkey" FOREIGN KEY ("best_run_id","space_id") REFERENCES "public"."experiment_runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_interpretations" ADD CONSTRAINT "experiment_interpretations_definition_fkey" FOREIGN KEY ("definition_id","space_id") REFERENCES "public"."experiment_definitions"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_interpretations" ADD CONSTRAINT "experiment_interpretations_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_interpretations" ADD CONSTRAINT "experiment_interpretations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_interpretations" ADD CONSTRAINT "experiment_interpretations_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_interpretations" ADD CONSTRAINT "experiment_interpretations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_observations" ADD CONSTRAINT "experiment_observations_run_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."experiment_runs"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_observations" ADD CONSTRAINT "experiment_observations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_observations" ADD CONSTRAINT "experiment_observations_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_version_fkey" FOREIGN KEY ("version_id","space_id") REFERENCES "public"."experiment_versions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_run_delete_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_run_id_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_versions" ADD CONSTRAINT "experiment_versions_definition_fkey" FOREIGN KEY ("definition_id","space_id") REFERENCES "public"."experiment_definitions"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_versions" ADD CONSTRAINT "experiment_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_versions" ADD CONSTRAINT "experiment_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_view_states" ADD CONSTRAINT "graph_view_states_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_view_states" ADD CONSTRAINT "graph_view_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_session_records" ADD CONSTRAINT "imported_session_records_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_session_records" ADD CONSTRAINT "imported_session_records_imported_session_id_fkey" FOREIGN KEY ("imported_session_id") REFERENCES "public"."imported_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sessions" ADD CONSTRAINT "imported_sessions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sessions" ADD CONSTRAINT "imported_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sessions" ADD CONSTRAINT "imported_sessions_project_folder_id_fkey" FOREIGN KEY ("project_folder_id") REFERENCES "public"."project_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sessions" ADD CONSTRAINT "imported_sessions_workspace_location_id_fkey" FOREIGN KEY ("workspace_location_id") REFERENCES "public"."workspace_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sessions" ADD CONSTRAINT "imported_sessions_execution_host_id_fkey" FOREIGN KEY ("execution_host_id") REFERENCES "public"."hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_sessions" ADD CONSTRAINT "imported_sessions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_history_summaries" ADD CONSTRAINT "imported_history_summaries_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_history_summaries" ADD CONSTRAINT "imported_history_summaries_session_fkey" FOREIGN KEY ("imported_session_id") REFERENCES "public"."imported_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_history_summaries" ADD CONSTRAINT "imported_history_summaries_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_hypothesis_states" ADD CONSTRAINT "inquiry_hypothesis_states_thread_fkey" FOREIGN KEY ("thread_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_iterations" ADD CONSTRAINT "inquiry_iterations_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_iterations" ADD CONSTRAINT "inquiry_iterations_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_iterations" ADD CONSTRAINT "inquiry_iterations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_iterations" ADD CONSTRAINT "inquiry_iterations_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_project_settings" ADD CONSTRAINT "inquiry_project_settings_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_project_settings" ADD CONSTRAINT "inquiry_project_settings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_question_states" ADD CONSTRAINT "inquiry_question_states_thread_fkey" FOREIGN KEY ("thread_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_lifecycle_events" ADD CONSTRAINT "inquiry_thread_lifecycle_events_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_lifecycle_events" ADD CONSTRAINT "inquiry_thread_lifecycle_events_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_personal_focus" ADD CONSTRAINT "inquiry_thread_personal_focus_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_personal_focus" ADD CONSTRAINT "inquiry_thread_personal_focus_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_personal_focus" ADD CONSTRAINT "inquiry_thread_personal_focus_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_personal_focus" ADD CONSTRAINT "inquiry_thread_personal_focus_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_revisions" ADD CONSTRAINT "inquiry_thread_revisions_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_revisions" ADD CONSTRAINT "inquiry_thread_revisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_statement_revisions" ADD CONSTRAINT "inquiry_thread_statement_revisions_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_statement_revisions" ADD CONSTRAINT "inquiry_thread_statement_revisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "inquiry_thread_steps_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "inquiry_thread_steps_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "inquiry_thread_steps_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "inquiry_thread_steps_iteration_delete_fkey" FOREIGN KEY ("iteration_id") REFERENCES "public"."inquiry_iterations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_steps" ADD CONSTRAINT "inquiry_thread_steps_iteration_fkey" FOREIGN KEY ("iteration_id","project_id","space_id") REFERENCES "public"."inquiry_iterations"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_structure_events" ADD CONSTRAINT "inquiry_thread_structure_events_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_structure_events" ADD CONSTRAINT "inquiry_thread_structure_events_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_work_events" ADD CONSTRAINT "inquiry_thread_work_events_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_work_events" ADD CONSTRAINT "inquiry_thread_work_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_threads" ADD CONSTRAINT "inquiry_threads_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_threads" ADD CONSTRAINT "inquiry_threads_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_threads" ADD CONSTRAINT "inquiry_threads_primary_parent_fkey" FOREIGN KEY ("primary_parent_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_threads" ADD CONSTRAINT "inquiry_threads_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD CONSTRAINT "inquiry_thread_advice_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD CONSTRAINT "inquiry_thread_advice_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD CONSTRAINT "inquiry_thread_advice_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_thread_advice" ADD CONSTRAINT "inquiry_thread_advice_generated_by_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_delta_briefs" ADD CONSTRAINT "inquiry_delta_briefs_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_delta_briefs" ADD CONSTRAINT "inquiry_delta_briefs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_delta_briefs" ADD CONSTRAINT "inquiry_delta_briefs_generated_by_run_id_fkey" FOREIGN KEY ("generated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_corpus_item_fkey" FOREIGN KEY ("corpus_item_id","project_id","space_id") REFERENCES "public"."project_corpus_items"("id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_experiment_interpretation_fkey" FOREIGN KEY ("experiment_interpretation_id","project_id","space_id") REFERENCES "public"."experiment_interpretations"("id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_evidence_signals" ADD CONSTRAINT "inquiry_evidence_signals_candidate_fkey" FOREIGN KEY ("candidate_id","project_id","space_id") REFERENCES "public"."inquiry_signal_candidates"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_review_packets" ADD CONSTRAINT "inquiry_review_packets_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_review_packets" ADD CONSTRAINT "inquiry_review_packets_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_review_packet_fkey" FOREIGN KEY ("review_packet_id","project_id","space_id") REFERENCES "public"."inquiry_review_packets"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_iteration_fkey" FOREIGN KEY ("resulting_iteration_id","project_id","space_id") REFERENCES "public"."inquiry_iterations"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_result_thread_fkey" FOREIGN KEY ("resulting_thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_signal_candidates" ADD CONSTRAINT "inquiry_signal_candidates_merge_target_fkey" FOREIGN KEY ("merged_into_candidate_id","project_id","space_id") REFERENCES "public"."inquiry_signal_candidates"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_profiles" ADD CONSTRAINT "interest_profiles_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_profiles" ADD CONSTRAINT "interest_profiles_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topic_candidates" ADD CONSTRAINT "interest_topic_candidates_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topic_candidates" ADD CONSTRAINT "interest_topic_candidates_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topic_candidates" ADD CONSTRAINT "interest_topic_candidates_profile_fkey" FOREIGN KEY ("profile_id","space_id") REFERENCES "public"."interest_profiles"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topic_observations" ADD CONSTRAINT "interest_topic_observations_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topic_observations" ADD CONSTRAINT "interest_topic_observations_profile_fkey" FOREIGN KEY ("profile_id","space_id") REFERENCES "public"."interest_profiles"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topics" ADD CONSTRAINT "interest_topics_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topics" ADD CONSTRAINT "interest_topics_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_topics" ADD CONSTRAINT "interest_topics_profile_fkey" FOREIGN KEY ("profile_id","space_id") REFERENCES "public"."interest_profiles"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_items" ADD CONSTRAINT "information_digest_items_digest_fkey" FOREIGN KEY ("digest_id","space_id") REFERENCES "public"."information_digests"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_items" ADD CONSTRAINT "information_digest_items_source_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_items" ADD CONSTRAINT "information_digest_items_topic_fkey" FOREIGN KEY ("matched_topic_id") REFERENCES "public"."interest_topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_items" ADD CONSTRAINT "information_digest_items_serendipity_pool_fkey" FOREIGN KEY ("serendipity_pool_item_id") REFERENCES "public"."information_digest_serendipity_pool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_probe_runs" ADD CONSTRAINT "information_digest_probe_runs_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_probe_runs" ADD CONSTRAINT "information_digest_probe_runs_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_domain_states" ADD CONSTRAINT "information_digest_serendipity_domain_state_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_domain_states" ADD CONSTRAINT "information_digest_serendipity_domain_state_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_feedback" ADD CONSTRAINT "information_digest_serendipity_feedback_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_feedback" ADD CONSTRAINT "information_digest_serendipity_feedback_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_feedback" ADD CONSTRAINT "information_digest_serendipity_feedback_item_fkey" FOREIGN KEY ("digest_item_id") REFERENCES "public"."information_digest_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_pool" ADD CONSTRAINT "information_digest_serendipity_pool_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_pool" ADD CONSTRAINT "information_digest_serendipity_pool_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_pool" ADD CONSTRAINT "information_digest_serendipity_pool_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digest_serendipity_pool" ADD CONSTRAINT "information_digest_serendipity_pool_channel_fkey" FOREIGN KEY ("source_channel_id") REFERENCES "public"."source_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digests" ADD CONSTRAINT "information_digests_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digests" ADD CONSTRAINT "information_digests_owner_user_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digests" ADD CONSTRAINT "information_digests_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "information_digests" ADD CONSTRAINT "information_digests_run_fkey" FOREIGN KEY ("generated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_claim_id_fkey" FOREIGN KEY ("claim_id","space_id") REFERENCES "public"."claims"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_source_connection_id_fkey" FOREIGN KEY ("source_connection_id","space_id") REFERENCES "public"."source_connections"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_source_object_id_fkey" FOREIGN KEY ("source_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_created_from_proposal_id_fkey" FOREIGN KEY ("created_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_holder_object_id_fkey" FOREIGN KEY ("holder_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_subject_object_id_fkey" FOREIGN KEY ("subject_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."extracted_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_extraction_job_id_fkey" FOREIGN KEY ("extraction_job_id") REFERENCES "public"."extraction_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_origin_source_item_space_fkey" FOREIGN KEY ("origin_source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_evidence" ADD CONSTRAINT "extracted_evidence_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_item_sources" ADD CONSTRAINT "knowledge_item_sources_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_item_sources" ADD CONSTRAINT "knowledge_item_sources_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_item_sources" ADD CONSTRAINT "knowledge_item_sources_source_id_fkey" FOREIGN KEY ("source_id","space_id") REFERENCES "public"."sources"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_item_sources" ADD CONSTRAINT "knowledge_item_sources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_redirect_delete_fkey" FOREIGN KEY ("redirect_to_item_id") REFERENCES "public"."knowledge_items"("object_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "fk_knowledge_items_redirect_to_item_id_knowledge_items" FOREIGN KEY ("redirect_to_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_root_delete_fkey" FOREIGN KEY ("root_item_id") REFERENCES "public"."knowledge_items"("object_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "fk_knowledge_items_root_item_id_knowledge_items" FOREIGN KEY ("root_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_supersedes_delete_fkey" FOREIGN KEY ("supersedes_item_id") REFERENCES "public"."knowledge_items"("object_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "fk_knowledge_items_supersedes_item_id_knowledge_items" FOREIGN KEY ("supersedes_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_created_from_proposal_id_fkey" FOREIGN KEY ("created_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collection_items" ADD CONSTRAINT "note_collection_items_collection_id_space_id_fkey" FOREIGN KEY ("collection_id","space_id") REFERENCES "public"."note_collections"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collection_items" ADD CONSTRAINT "note_collection_items_note_id_space_id_fkey" FOREIGN KEY ("note_id","space_id") REFERENCES "public"."notes"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collection_items" ADD CONSTRAINT "note_collection_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collections" ADD CONSTRAINT "note_collections_parent_delete_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."note_collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collections" ADD CONSTRAINT "note_collections_parent_id_space_id_fkey" FOREIGN KEY ("parent_id","space_id") REFERENCES "public"."note_collections"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collections" ADD CONSTRAINT "note_collections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collections" ADD CONSTRAINT "note_collections_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_from_object_id_fkey" FOREIGN KEY ("from_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_to_object_id_fkey" FOREIGN KEY ("to_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_fkey" FOREIGN KEY ("note_id","space_id") REFERENCES "public"."notes"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_user_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_run_delete_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_run_fkey" FOREIGN KEY ("created_by_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_from_activity_id_fkey" FOREIGN KEY ("created_from_activity_id") REFERENCES "public"."activity_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_run_id_delete_fkey" FOREIGN KEY ("updated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_run_id_fkey" FOREIGN KEY ("updated_by_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_role_project_id_fkey" FOREIGN KEY ("role_project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_marginalia_project_id_fkey" FOREIGN KEY ("marginalia_project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_marginalia_owner_user_id_fkey" FOREIGN KEY ("marginalia_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_from_object_id_fkey" FOREIGN KEY ("from_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_source_claim_id_fkey" FOREIGN KEY ("source_claim_id","space_id") REFERENCES "public"."claims"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_source_object_id_fkey" FOREIGN KEY ("source_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_source_proposal_id_fkey" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_relations" ADD CONSTRAINT "object_relations_to_object_id_fkey" FOREIGN KEY ("to_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_references" ADD CONSTRAINT "source_item_references_source_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_references" ADD CONSTRAINT "source_item_references_reference_fkey" FOREIGN KEY ("reference_object_id","space_id") REFERENCES "public"."sources"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_source_activity_id_fkey" FOREIGN KEY ("source_activity_id") REFERENCES "public"."activity_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profile_relation_hints" ADD CONSTRAINT "space_object_profile_relation_hints_endpoint_kind_fkey" FOREIGN KEY ("endpoint_object_profile_id") REFERENCES "public"."space_object_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profile_relation_hints" ADD CONSTRAINT "space_object_profile_relation_hints_object_profile_fkey" FOREIGN KEY ("object_profile_id") REFERENCES "public"."space_object_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profile_relation_hints" ADD CONSTRAINT "space_object_profile_relation_hints_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profiles" ADD CONSTRAINT "space_object_profiles_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profiles" ADD CONSTRAINT "space_object_profiles_created_from_proposal_id_fkey" FOREIGN KEY ("created_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profiles" ADD CONSTRAINT "space_object_profiles_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_object_profiles" ADD CONSTRAINT "space_object_profiles_updated_from_proposal_id_fkey" FOREIGN KEY ("updated_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_primary_project_id_fkey" FOREIGN KEY ("primary_project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_focus_area_id_fkey" FOREIGN KEY ("focus_area_id","space_id") REFERENCES "public"."focus_areas"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_objects" ADD CONSTRAINT "space_objects_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_supersedes_fkey" FOREIGN KEY ("supersedes_knowledge_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_review_packet_fkey" FOREIGN KEY ("review_packet_id","space_id") REFERENCES "public"."knowledge_promotion_review_packets"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_candidates" ADD CONSTRAINT "knowledge_promotion_candidates_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_review_packets" ADD CONSTRAINT "knowledge_promotion_review_packets_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_review_packets" ADD CONSTRAINT "knowledge_promotion_review_packets_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_promotion_review_packets" ADD CONSTRAINT "knowledge_promotion_review_packets_opened_by_fkey" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revalidation_outcomes" ADD CONSTRAINT "knowledge_revalidation_outcomes_item_fkey" FOREIGN KEY ("knowledge_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revalidation_outcomes" ADD CONSTRAINT "knowledge_revalidation_outcomes_event_fkey" FOREIGN KEY ("event_id","space_id") REFERENCES "public"."domain_change_outbox"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revalidation_outcomes" ADD CONSTRAINT "knowledge_revalidation_outcomes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revalidation_outcomes" ADD CONSTRAINT "knowledge_revalidation_outcomes_candidate_fkey" FOREIGN KEY ("resulting_candidate_id","space_id") REFERENCES "public"."knowledge_promotion_candidates"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_item_mastery" ADD CONSTRAINT "learning_item_mastery_item_fkey" FOREIGN KEY ("learning_item_id","space_id") REFERENCES "public"."learning_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_item_mastery" ADD CONSTRAINT "learning_item_mastery_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_item_mastery" ADD CONSTRAINT "learning_item_mastery_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_objective_fkey" FOREIGN KEY ("objective_id","space_id") REFERENCES "public"."learning_objectives"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_knowledge_item_fkey" FOREIGN KEY ("knowledge_item_id","space_id") REFERENCES "public"."knowledge_items"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "fk_memory_entries_project_id_projects" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "fk_memory_entries_root_memory_id_memory_entries" FOREIGN KEY ("root_memory_id") REFERENCES "public"."memory_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "fk_memory_entries_supersedes_memory_id_memory_entries" FOREIGN KEY ("supersedes_memory_id") REFERENCES "public"."memory_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_created_from_proposal_id_fkey" FOREIGN KEY ("created_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_maintenance_jobs" ADD CONSTRAINT "memory_maintenance_jobs_last_packet_proposal_id_fkey" FOREIGN KEY ("last_packet_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_maintenance_jobs" ADD CONSTRAINT "memory_maintenance_jobs_last_report_artifact_id_fkey" FOREIGN KEY ("last_report_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_maintenance_jobs" ADD CONSTRAINT "memory_maintenance_jobs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_maintenance_jobs" ADD CONSTRAINT "memory_maintenance_jobs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_created_from_proposal_id_fkey" FOREIGN KEY ("created_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_links" ADD CONSTRAINT "provenance_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_records" ADD CONSTRAINT "participation_records_personal_space_id_fkey" FOREIGN KEY ("personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_records" ADD CONSTRAINT "participation_records_source_space_id_fkey" FOREIGN KEY ("source_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_records" ADD CONSTRAINT "participation_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grant_events" ADD CONSTRAINT "personal_memory_grant_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grant_events" ADD CONSTRAINT "personal_memory_grant_events_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "public"."personal_memory_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grant_events" ADD CONSTRAINT "personal_memory_grant_events_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grant_events" ADD CONSTRAINT "personal_memory_grant_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grant_events" ADD CONSTRAINT "personal_memory_grant_events_source_space_id_fkey" FOREIGN KEY ("source_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grant_events" ADD CONSTRAINT "personal_memory_grant_events_target_space_id_fkey" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grants" ADD CONSTRAINT "personal_memory_grants_granting_user_id_fkey" FOREIGN KEY ("granting_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grants" ADD CONSTRAINT "personal_memory_grants_personal_space_id_fkey" FOREIGN KEY ("personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grants" ADD CONSTRAINT "personal_memory_grants_target_agent_id_fkey" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grants" ADD CONSTRAINT "personal_memory_grants_target_run_id_fkey" FOREIGN KEY ("target_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_grants" ADD CONSTRAINT "personal_memory_grants_target_space_id_fkey" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_dependencies" ADD CONSTRAINT "plan_node_dependencies_version_space_fkey" FOREIGN KEY ("plan_version_id","space_id") REFERENCES "public"."plan_versions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_dependencies" ADD CONSTRAINT "plan_node_dependencies_node_space_fkey" FOREIGN KEY ("node_id","space_id") REFERENCES "public"."plan_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_dependencies" ADD CONSTRAINT "plan_node_dependencies_depends_on_space_fkey" FOREIGN KEY ("depends_on_node_id","space_id") REFERENCES "public"."plan_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_dependencies" ADD CONSTRAINT "plan_node_dependencies_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_runs" ADD CONSTRAINT "plan_node_runs_node_space_fkey" FOREIGN KEY ("plan_node_id","space_id") REFERENCES "public"."plan_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_runs" ADD CONSTRAINT "plan_node_runs_run_space_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_runs" ADD CONSTRAINT "plan_node_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_version_space_fkey" FOREIGN KEY ("plan_version_id","space_id") REFERENCES "public"."plan_versions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_assigned_agent_delete_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_assigned_agent_space_fkey" FOREIGN KEY ("assigned_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_space_fkey" FOREIGN KEY ("plan_id","space_id") REFERENCES "public"."plans"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_planning_run_space_fkey" FOREIGN KEY ("planning_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_reference_workflow_version_fkey" FOREIGN KEY ("reference_workflow_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_source_task_space_fkey" FOREIGN KEY ("source_task_id","space_id") REFERENCES "public"."tasks"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "fk_policies_created_from_proposal_id_proposals" FOREIGN KEY ("created_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "fk_policies_supersedes_policy_id_policies" FOREIGN KEY ("supersedes_policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD CONSTRAINT "prompt_deployment_refs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD CONSTRAINT "prompt_deployment_refs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."evolvable_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD CONSTRAINT "prompt_deployment_refs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD CONSTRAINT "prompt_deployment_refs_promoted_by_user_id_fkey" FOREIGN KEY ("promoted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_deployment_refs" ADD CONSTRAINT "prompt_deployment_refs_promoted_from_proposal_id_fkey" FOREIGN KEY ("promoted_from_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_item_sources" ADD CONSTRAINT "project_corpus_item_sources_corpus_item_fkey" FOREIGN KEY ("corpus_item_id","project_id","space_id") REFERENCES "public"."project_corpus_items"("id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_item_sources" ADD CONSTRAINT "project_corpus_item_sources_source_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_evidence_id_fkey" FOREIGN KEY ("evidence_id","space_id") REFERENCES "public"."extracted_evidence"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_source_connection_id_fkey" FOREIGN KEY ("source_connection_id","space_id") REFERENCES "public"."source_connections"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_source_decision_id_fkey" FOREIGN KEY ("source_decision_id","space_id") REFERENCES "public"."source_post_processing_item_decisions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_source_item_id_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_corpus_items" ADD CONSTRAINT "project_corpus_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_checkpoints" ADD CONSTRAINT "project_research_checkpoints_workflow_id_fkey" FOREIGN KEY ("workflow_id","space_id") REFERENCES "public"."project_research_workflows"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_checkpoints" ADD CONSTRAINT "project_research_checkpoints_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_checkpoints" ADD CONSTRAINT "project_research_checkpoints_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_checkpoints" ADD CONSTRAINT "project_research_checkpoints_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_claim_links" ADD CONSTRAINT "project_research_claim_links_claim_id_fkey" FOREIGN KEY ("claim_id","space_id") REFERENCES "public"."claims"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_claim_links" ADD CONSTRAINT "project_research_claim_links_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_claim_links" ADD CONSTRAINT "project_research_claim_links_workflow_delete_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_research_workflows"("object_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_claim_links" ADD CONSTRAINT "project_research_claim_links_workflow_id_fkey" FOREIGN KEY ("workflow_id","space_id") REFERENCES "public"."project_research_workflows"("object_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_claim_links" ADD CONSTRAINT "project_research_claim_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_claim_links" ADD CONSTRAINT "project_research_claim_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_question_assessment_messages" ADD CONSTRAINT "project_research_question_assessment_messages_session_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."project_research_question_assessment_sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_question_assessment_messages" ADD CONSTRAINT "project_research_question_assessment_messages_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_question_assessment_sessions" ADD CONSTRAINT "project_research_question_assessment_sessions_thread_fkey" FOREIGN KEY ("thread_id","project_id","space_id") REFERENCES "public"."inquiry_threads"("object_id","project_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_question_assessment_sessions" ADD CONSTRAINT "project_research_question_assessment_sessions_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_question_assessment_sessions" ADD CONSTRAINT "project_research_question_assessment_sessions_context_fkey" FOREIGN KEY ("research_context_version_id","project_id","space_id") REFERENCES "public"."project_research_context_versions"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_question_assessment_sessions" ADD CONSTRAINT "project_research_question_assessment_sessions_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_workflow_id_fkey" FOREIGN KEY ("workflow_id","space_id") REFERENCES "public"."project_research_workflows"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_operation_id_fkey" FOREIGN KEY ("operation_id","space_id") REFERENCES "public"."project_operations"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_synthesis_run_id_fkey" FOREIGN KEY ("synthesis_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_archive_artifact_id_fkey" FOREIGN KEY ("archive_artifact_id","space_id") REFERENCES "public"."artifacts"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_matrix_artifact_id_fkey" FOREIGN KEY ("evidence_matrix_artifact_id","space_id") REFERENCES "public"."artifacts"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_reports" ADD CONSTRAINT "project_research_reports_integrity_artifact_id_fkey" FOREIGN KEY ("integrity_artifact_id","space_id") REFERENCES "public"."artifacts"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_screening_criteria" ADD CONSTRAINT "project_research_screening_criteria_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_screening_criteria" ADD CONSTRAINT "project_research_screening_criteria_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_standing_advice" ADD CONSTRAINT "project_research_standing_advice_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_standing_advice" ADD CONSTRAINT "project_research_standing_advice_batch_fkey" FOREIGN KEY ("batch_id","space_id") REFERENCES "public"."project_research_standing_batches"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_standing_advice" ADD CONSTRAINT "project_research_standing_advice_source_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_standing_advice" ADD CONSTRAINT "project_research_standing_advice_run_fkey" FOREIGN KEY ("created_by_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_standing_batches" ADD CONSTRAINT "project_research_standing_batches_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_standing_batches" ADD CONSTRAINT "project_research_standing_batches_run_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_workflows" ADD CONSTRAINT "project_research_workflows_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_workflows" ADD CONSTRAINT "project_research_workflows_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_workflows" ADD CONSTRAINT "project_research_workflows_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_workflows" ADD CONSTRAINT "project_research_workflows_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_workflows" ADD CONSTRAINT "project_research_workflows_started_run_delete_fkey" FOREIGN KEY ("started_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_workflows" ADD CONSTRAINT "project_research_workflows_started_run_id_fkey" FOREIGN KEY ("started_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_scan_summaries" ADD CONSTRAINT "research_scan_summaries_workflow_id_fkey" FOREIGN KEY ("workflow_id","space_id") REFERENCES "public"."project_research_workflows"("object_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_scan_summaries" ADD CONSTRAINT "research_scan_summaries_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_scan_summaries" ADD CONSTRAINT "research_scan_summaries_operation_id_fkey" FOREIGN KEY ("operation_id","space_id") REFERENCES "public"."project_operations"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_scan_summaries" ADD CONSTRAINT "research_scan_summaries_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_context_versions" ADD CONSTRAINT "project_research_context_versions_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_context_versions" ADD CONSTRAINT "project_research_context_versions_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_context_versions" ADD CONSTRAINT "project_research_context_versions_user_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_attempts" ADD CONSTRAINT "research_query_attempts_plan_fkey" FOREIGN KEY ("provider_plan_id","space_id") REFERENCES "public"."research_query_provider_plans"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_performance_observations" ADD CONSTRAINT "research_query_performance_strategy_fkey" FOREIGN KEY ("strategy_id","space_id") REFERENCES "public"."research_query_strategies"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_performance_observations" ADD CONSTRAINT "research_query_performance_scan_fkey" FOREIGN KEY ("scan_summary_id","space_id") REFERENCES "public"."research_scan_summaries"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_provider_plans" ADD CONSTRAINT "research_query_provider_plans_strategy_fkey" FOREIGN KEY ("strategy_id","space_id") REFERENCES "public"."research_query_strategies"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_provider_selections" ADD CONSTRAINT "research_query_provider_selections_plan_fkey" FOREIGN KEY ("provider_plan_id","space_id") REFERENCES "public"."research_query_provider_plans"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_provider_selections" ADD CONSTRAINT "research_query_provider_selections_attempt_fkey" FOREIGN KEY ("attempt_id","provider_plan_id","space_id") REFERENCES "public"."research_query_attempts"("id","provider_plan_id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD CONSTRAINT "research_query_strategies_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD CONSTRAINT "research_query_strategies_context_fkey" FOREIGN KEY ("research_context_version_id","project_id","space_id") REFERENCES "public"."project_research_context_versions"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD CONSTRAINT "research_query_strategies_operation_delete_fkey" FOREIGN KEY ("operation_id") REFERENCES "public"."project_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD CONSTRAINT "research_query_strategies_operation_fkey" FOREIGN KEY ("operation_id","project_id","space_id") REFERENCES "public"."project_operations"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD CONSTRAINT "research_query_strategies_user_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategies" ADD CONSTRAINT "research_query_strategies_parent_fkey" FOREIGN KEY ("parent_strategy_id","space_id") REFERENCES "public"."research_query_strategies"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategy_activations" ADD CONSTRAINT "research_query_activation_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategy_activations" ADD CONSTRAINT "research_query_activation_context_fkey" FOREIGN KEY ("research_context_version_id","project_id","space_id") REFERENCES "public"."project_research_context_versions"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategy_activations" ADD CONSTRAINT "research_query_activation_strategy_fkey" FOREIGN KEY ("strategy_id","space_id") REFERENCES "public"."research_query_strategies"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategy_activations" ADD CONSTRAINT "research_query_activation_previous_fkey" FOREIGN KEY ("previous_strategy_id","space_id") REFERENCES "public"."research_query_strategies"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategy_activations" ADD CONSTRAINT "research_query_activation_proposal_fkey" FOREIGN KEY ("proposal_id","space_id") REFERENCES "public"."proposals"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_query_strategy_activations" ADD CONSTRAINT "research_query_activation_user_fkey" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_checklist_items" ADD CONSTRAINT "research_checklist_items_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_checklist_items" ADD CONSTRAINT "research_checklist_items_run_delete_fkey" FOREIGN KEY ("origin_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_checklist_items" ADD CONSTRAINT "research_checklist_items_run_fkey" FOREIGN KEY ("origin_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence_cards" ADD CONSTRAINT "research_evidence_cards_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence_cards" ADD CONSTRAINT "research_evidence_cards_source_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence_cards" ADD CONSTRAINT "research_evidence_cards_object_delete_fkey" FOREIGN KEY ("object_id") REFERENCES "public"."space_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence_cards" ADD CONSTRAINT "research_evidence_cards_object_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_integrity_alerts" ADD CONSTRAINT "research_integrity_alerts_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_integrity_alerts" ADD CONSTRAINT "research_integrity_alerts_source_item_delete_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_integrity_alerts" ADD CONSTRAINT "research_integrity_alerts_source_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_bindings" ADD CONSTRAINT "project_source_bindings_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_bindings" ADD CONSTRAINT "project_source_bindings_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_bindings" ADD CONSTRAINT "project_source_bindings_source_channel_id_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_bindings" ADD CONSTRAINT "project_source_bindings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_item_links" ADD CONSTRAINT "project_source_item_links_binding_id_fkey" FOREIGN KEY ("project_source_binding_id") REFERENCES "public"."project_source_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_item_links" ADD CONSTRAINT "project_source_item_links_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_item_links" ADD CONSTRAINT "project_source_item_links_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_item_links" ADD CONSTRAINT "project_source_item_links_source_channel_id_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_item_links" ADD CONSTRAINT "project_source_item_links_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_item_links" ADD CONSTRAINT "project_source_item_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operation_links" ADD CONSTRAINT "project_operation_links_operation_fkey" FOREIGN KEY ("operation_id","space_id") REFERENCES "public"."project_operations"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operation_steps" ADD CONSTRAINT "project_operation_steps_operation_fkey" FOREIGN KEY ("operation_id","space_id") REFERENCES "public"."project_operations"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_user_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_run_fkey" FOREIGN KEY ("initiating_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_artifact_fkey" FOREIGN KEY ("plan_artifact_id","space_id") REFERENCES "public"."artifacts"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_operations" ADD CONSTRAINT "project_operations_current_execution_fkey" FOREIGN KEY ("current_execution_id","space_id") REFERENCES "public"."workflow_executions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attention_user_states" ADD CONSTRAINT "project_attention_user_states_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attention_user_states" ADD CONSTRAINT "project_attention_user_states_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_attention_user_states" ADD CONSTRAINT "project_attention_user_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_versions" ADD CONSTRAINT "project_brief_versions_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_versions" ADD CONSTRAINT "project_brief_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_versions" ADD CONSTRAINT "project_brief_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_versions" ADD CONSTRAINT "project_brief_versions_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_versions" ADD CONSTRAINT "project_brief_versions_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instruction_versions" ADD CONSTRAINT "project_instruction_versions_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_space_membership_fkey" FOREIGN KEY ("space_id","user_id") REFERENCES "public"."space_memberships"("space_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_public_summaries" ADD CONSTRAINT "project_public_summaries_generated_by_run_id_fkey" FOREIGN KEY ("generated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_public_summaries" ADD CONSTRAINT "project_public_summaries_space_project_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_public_summaries" ADD CONSTRAINT "project_public_summaries_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_public_summaries" ADD CONSTRAINT "project_public_summaries_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_active_instruction_version_fkey" FOREIGN KEY ("active_instruction_version_id","id","space_id") REFERENCES "public"."project_instruction_versions"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_focus_area_id_fkey" FOREIGN KEY ("focus_area_id","space_id") REFERENCES "public"."focus_areas"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_active_brief_version_fkey" FOREIGN KEY ("active_brief_version_id","id","space_id") REFERENCES "public"."project_brief_versions"("id","project_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_events" ADD CONSTRAINT "project_work_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_events" ADD CONSTRAINT "project_work_events_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_events" ADD CONSTRAINT "project_work_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_loop_states" ADD CONSTRAINT "task_loop_states_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_loop_states" ADD CONSTRAINT "task_loop_states_task_id_fkey" FOREIGN KEY ("task_id","space_id") REFERENCES "public"."tasks"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_loop_states" ADD CONSTRAINT "task_loop_states_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_loop_states" ADD CONSTRAINT "task_loop_states_last_event_id_fkey" FOREIGN KEY ("last_event_id") REFERENCES "public"."project_work_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_approvals" ADD CONSTRAINT "proposal_approvals_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_approvals" ADD CONSTRAINT "proposal_approvals_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "public"."personal_memory_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_approvals" ADD CONSTRAINT "proposal_approvals_action_grant_id_fkey" FOREIGN KEY ("action_grant_id") REFERENCES "public"."action_approval_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_approvals" ADD CONSTRAINT "proposal_approvals_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_approvals" ADD CONSTRAINT "proposal_approvals_target_space_id_fkey" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "fk_proposals_project_id_projects" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_space_grants" ADD CONSTRAINT "model_provider_space_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_space_grants" ADD CONSTRAINT "model_provider_space_grants_network_profile_id_fkey" FOREIGN KEY ("network_profile_id") REFERENCES "public"."network_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_space_grants" ADD CONSTRAINT "model_provider_space_grants_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_space_grants" ADD CONSTRAINT "model_provider_space_grants_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_space_grants" ADD CONSTRAINT "model_provider_space_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_network_profile_id_fkey" FOREIGN KEY ("network_profile_id") REFERENCES "public"."network_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_profiles" ADD CONSTRAINT "network_profiles_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_task_policies" ADD CONSTRAINT "provider_task_policies_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_identities" ADD CONSTRAINT "relation_identities_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_identities" ADD CONSTRAINT "relation_identities_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_identities" ADD CONSTRAINT "relation_identities_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_identities" ADD CONSTRAINT "relation_identities_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_notes" ADD CONSTRAINT "relation_notes_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_notes" ADD CONSTRAINT "relation_notes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_notes" ADD CONSTRAINT "relation_notes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_notes" ADD CONSTRAINT "relation_notes_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_organizations" ADD CONSTRAINT "relation_organizations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_organizations" ADD CONSTRAINT "relation_organizations_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_organizations" ADD CONSTRAINT "relation_organizations_parent_object_id_fkey" FOREIGN KEY ("parent_organization_object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_people" ADD CONSTRAINT "relation_people_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_people" ADD CONSTRAINT "relation_people_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_object_id_fkey" FOREIGN KEY ("object_id","space_id") REFERENCES "public"."space_objects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "public"."activity_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_source_links" ADD CONSTRAINT "relation_source_links_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."extracted_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_access_grants" ADD CONSTRAINT "room_agent_access_grants_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_access_grants" ADD CONSTRAINT "room_agent_access_grants_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_access_grants" ADD CONSTRAINT "room_agent_access_grants_grantee_user_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_access_grants" ADD CONSTRAINT "room_agent_access_grants_granted_by_user_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_access_grants" ADD CONSTRAINT "room_agent_access_grants_revoked_by_user_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_members" ADD CONSTRAINT "room_agent_members_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_members" ADD CONSTRAINT "room_agent_members_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_preset_idempotencies" ADD CONSTRAINT "room_agent_preset_idempotencies_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_preset_idempotencies" ADD CONSTRAINT "room_agent_preset_idempotencies_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_preset_idempotencies" ADD CONSTRAINT "room_agent_preset_idempotencies_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invitation_agent_approvals" ADD CONSTRAINT "room_invitation_agent_approvals_invitation_scope_fkey" FOREIGN KEY ("invitation_id","space_id") REFERENCES "public"."room_user_invitations"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invitation_agent_approvals" ADD CONSTRAINT "room_invitation_agent_approvals_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invitation_agent_approvals" ADD CONSTRAINT "room_invitation_agent_approvals_owner_user_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_user_invitations" ADD CONSTRAINT "room_user_invitations_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_user_invitations" ADD CONSTRAINT "room_user_invitations_invitee_user_fkey" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_user_invitations" ADD CONSTRAINT "room_user_invitations_invited_by_user_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_user_members" ADD CONSTRAINT "room_user_members_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_user_members" ADD CONSTRAINT "room_user_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_project_folder_scope_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_project_scope_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_personal_for_user_id_fkey" FOREIGN KEY ("personal_for_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_states" ADD CONSTRAINT "room_conversation_summary_states_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_states" ADD CONSTRAINT "room_conversation_summary_states_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_states" ADD CONSTRAINT "room_conversation_summary_states_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_states" ADD CONSTRAINT "room_conversation_summary_states_active_summary_fkey" FOREIGN KEY ("active_summary_id","session_id","room_id","space_id") REFERENCES "public"."room_conversation_summary_versions"("id","session_id","room_id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_versions" ADD CONSTRAINT "room_conversation_summary_versions_room_scope_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_versions" ADD CONSTRAINT "room_conversation_summary_versions_project_scope_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_versions" ADD CONSTRAINT "room_conversation_summary_versions_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_versions" ADD CONSTRAINT "room_conversation_summary_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_versions" ADD CONSTRAINT "room_conversation_summary_versions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_conversation_summary_versions" ADD CONSTRAINT "room_conversation_summary_versions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "public"."room_conversation_summary_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_creation_idempotencies" ADD CONSTRAINT "room_creation_idempotencies_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_creation_idempotencies" ADD CONSTRAINT "room_creation_idempotencies_user_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_creation_idempotencies" ADD CONSTRAINT "room_creation_idempotencies_room_fkey" FOREIGN KEY ("room_id","space_id") REFERENCES "public"."rooms"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_aliases" ADD CONSTRAINT "retrieval_aliases_retrieval_object_id_fkey" FOREIGN KEY ("retrieval_object_id") REFERENCES "public"."retrieval_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_aliases" ADD CONSTRAINT "retrieval_aliases_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_retrieval_object_id_fkey" FOREIGN KEY ("retrieval_object_id") REFERENCES "public"."retrieval_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_edges" ADD CONSTRAINT "retrieval_edges_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_feedback_events" ADD CONSTRAINT "retrieval_feedback_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_feedback_events" ADD CONSTRAINT "retrieval_feedback_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_objects" ADD CONSTRAINT "retrieval_objects_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_run_records" ADD CONSTRAINT "external_run_records_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_run_records" ADD CONSTRAINT "external_run_records_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_run_space_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_locks" ADD CONSTRAINT "fk_run_execution_locks_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_locks" ADD CONSTRAINT "run_execution_locks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD CONSTRAINT "run_finalizations_run_evaluation_id_fkey" FOREIGN KEY ("run_evaluation_id") REFERENCES "public"."run_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD CONSTRAINT "run_finalizations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD CONSTRAINT "run_finalizations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_finalizations" ADD CONSTRAINT "run_finalizations_task_evaluation_id_fkey" FOREIGN KEY ("task_evaluation_id") REFERENCES "public"."task_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "fk_run_steps_task_id_tasks" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."run_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_supervisor_decisions" ADD CONSTRAINT "run_supervisor_decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_supervisor_decisions" ADD CONSTRAINT "run_supervisor_decisions_run_space_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_supervisor_decisions" ADD CONSTRAINT "run_supervisor_decisions_attempt_space_fkey" FOREIGN KEY ("attempt_id","space_id") REFERENCES "public"."run_attempts"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_version_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."evolvable_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "fk_runs_project_id_projects" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id","agent_id","space_id") REFERENCES "public"."agent_versions"("id","agent_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "public"."run_delegations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_host_task_thread_id_fkey" FOREIGN KEY ("host_task_thread_id") REFERENCES "public"."host_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_instructed_by_agent_id_fkey" FOREIGN KEY ("instructed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_instructed_by_user_id_fkey" FOREIGN KEY ("instructed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_provider_id_fkey" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_selected_runtime_profile_id_fkey" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."agent_runtime_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_runtime_profile_id_fkey" FOREIGN KEY ("requested_runtime_profile_id") REFERENCES "public"."agent_runtime_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_root_run_id_fkey" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_run_group_id_fkey" FOREIGN KEY ("run_group_id") REFERENCES "public"."agent_run_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_location_id_fkey" FOREIGN KEY ("workspace_location_id","project_folder_id") REFERENCES "public"."workspace_locations"("id","project_folder_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "fk_runs_delegation_same_space" FOREIGN KEY ("delegation_id","space_id") REFERENCES "public"."run_delegations"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "fk_runs_instructed_by_agent_same_space" FOREIGN KEY ("instructed_by_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "fk_runs_parent_run_same_space" FOREIGN KEY ("parent_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "fk_runs_root_run_same_space" FOREIGN KEY ("root_run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_run_group_scope_fkey" FOREIGN KEY ("run_group_id","space_id","session_id","project_id") REFERENCES "public"."agent_run_groups"("id","space_id","session_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_evaluations" ADD CONSTRAINT "task_evaluations_evaluator_agent_id_fkey" FOREIGN KEY ("evaluator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_evaluations" ADD CONSTRAINT "task_evaluations_evaluator_user_id_fkey" FOREIGN KEY ("evaluator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_evaluations" ADD CONSTRAINT "task_evaluations_run_evaluation_id_fkey" FOREIGN KEY ("run_evaluation_id") REFERENCES "public"."run_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_evaluations" ADD CONSTRAINT "task_evaluations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_evaluations" ADD CONSTRAINT "task_evaluations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_evaluations" ADD CONSTRAINT "task_evaluations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact_declarations" ADD CONSTRAINT "run_artifact_declarations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact_declarations" ADD CONSTRAINT "run_artifact_declarations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifact_declarations" ADD CONSTRAINT "run_artifact_declarations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_identities" ADD CONSTRAINT "run_tool_identities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_identities" ADD CONSTRAINT "run_tool_identities_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_tool_bindings" ADD CONSTRAINT "runtime_tool_bindings_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_tool_bindings" ADD CONSTRAINT "runtime_tool_bindings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_tool_bindings" ADD CONSTRAINT "runtime_tool_bindings_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_runtime_tool_policies" ADD CONSTRAINT "space_runtime_tool_policies_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_runtime_tool_policies" ADD CONSTRAINT "space_runtime_tool_policies_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_tasks" ADD CONSTRAINT "scheduler_tasks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_tasks" ADD CONSTRAINT "scheduler_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_fkey" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_scope_fkey" FOREIGN KEY ("sender_agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_scope_fkey" FOREIGN KEY ("parent_message_id","space_id","session_id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_scope_fkey" FOREIGN KEY ("run_id","space_id") REFERENCES "public"."runs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD CONSTRAINT "session_conversation_backends_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD CONSTRAINT "session_conversation_backends_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD CONSTRAINT "session_conversation_backends_bound_by_user_id_fkey" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD CONSTRAINT "session_conversation_backends_runtime_scope_fkey" FOREIGN KEY ("runtime_profile_id","space_id","agent_id") REFERENCES "public"."agent_runtime_profiles"("id","space_id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD CONSTRAINT "session_conversation_backends_credential_owner_fkey" FOREIGN KEY ("credential_profile_id","bound_by_user_id") REFERENCES "public"."cli_credential_profiles"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_room_scope_fkey" FOREIGN KEY ("room_id","space_id","project_id") REFERENCES "public"."rooms"("id","space_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_head_message_scope_fkey" FOREIGN KEY ("head_message_id","space_id","id") REFERENCES "public"."messages"("id","space_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_execution_host_id_fkey" FOREIGN KEY ("execution_host_id") REFERENCES "public"."hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_primary_folder_scope_fkey" FOREIGN KEY ("primary_project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_primary_location_folder_fkey" FOREIGN KEY ("primary_workspace_location_id","primary_project_folder_id") REFERENCES "public"."workspace_locations"("id","project_folder_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_primary_location_host_fkey" FOREIGN KEY ("primary_workspace_location_id","execution_host_id") REFERENCES "public"."workspace_locations"("id","execution_host_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_contexts" ADD CONSTRAINT "conversation_execution_contexts_initialized_by_user_id_fkey" FOREIGN KEY ("initialized_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ADD CONSTRAINT "conversation_folder_access_grants_session_scope_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ADD CONSTRAINT "conversation_folder_access_grants_project_folder_scope_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ADD CONSTRAINT "conversation_folder_access_grants_location_folder_fkey" FOREIGN KEY ("workspace_location_id","project_folder_id") REFERENCES "public"."workspace_locations"("id","project_folder_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ADD CONSTRAINT "conversation_folder_access_grants_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ADD CONSTRAINT "conversation_folder_access_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder_access_grants" ADD CONSTRAINT "conversation_folder_access_grants_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication_imports" ADD CONSTRAINT "content_publication_imports_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "public"."content_publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication_imports" ADD CONSTRAINT "content_publication_imports_target_fkey" FOREIGN KEY ("publication_id","target_space_id") REFERENCES "public"."content_publication_targets"("publication_id","target_space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication_imports" ADD CONSTRAINT "content_publication_imports_target_space_id_fkey" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication_imports" ADD CONSTRAINT "content_publication_imports_imported_by_user_id_fkey" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication_targets" ADD CONSTRAINT "content_publication_targets_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "public"."content_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication_targets" ADD CONSTRAINT "content_publication_targets_target_space_id_fkey" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publications" ADD CONSTRAINT "content_publications_source_space_id_fkey" FOREIGN KEY ("source_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publications" ADD CONSTRAINT "content_publications_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publications" ADD CONSTRAINT "content_publications_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."source_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_annotations" ADD CONSTRAINT "reader_annotations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_annotations" ADD CONSTRAINT "reader_annotations_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_annotations" ADD CONSTRAINT "reader_annotations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_annotations" ADD CONSTRAINT "reader_annotations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_comment_threads" ADD CONSTRAINT "reader_comment_threads_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_comment_threads" ADD CONSTRAINT "reader_comment_threads_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "public"."reader_annotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_comment_threads" ADD CONSTRAINT "reader_comment_threads_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_comments" ADD CONSTRAINT "reader_comments_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_comments" ADD CONSTRAINT "reader_comments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."reader_comment_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_comments" ADD CONSTRAINT "reader_comments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_provider_connector_id_fkey" FOREIGN KEY ("provider_connector_id") REFERENCES "public"."source_provider_connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_active_handler_version_id_fkey" FOREIGN KEY ("active_handler_version_id") REFERENCES "public"."source_handler_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_last_handler_run_id_fkey" FOREIGN KEY ("last_handler_run_id") REFERENCES "public"."source_handler_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_active_recipe_version_id_fkey" FOREIGN KEY ("active_recipe_version_id") REFERENCES "public"."source_recipe_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_handler_version_id_fkey" FOREIGN KEY ("handler_version_id") REFERENCES "public"."source_handler_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_extraction_job_id_fkey" FOREIGN KEY ("extraction_job_id") REFERENCES "public"."extraction_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_input_artifact_id_fkey" FOREIGN KEY ("input_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_output_artifact_id_fkey" FOREIGN KEY ("output_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_runs" ADD CONSTRAINT "source_handler_runs_logs_artifact_id_fkey" FOREIGN KEY ("logs_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_versions" ADD CONSTRAINT "source_handler_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_versions" ADD CONSTRAINT "source_handler_versions_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_versions" ADD CONSTRAINT "source_handler_versions_handler_artifact_id_fkey" FOREIGN KEY ("handler_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_versions" ADD CONSTRAINT "source_handler_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_versions" ADD CONSTRAINT "source_handler_versions_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_handler_versions" ADD CONSTRAINT "source_handler_versions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD CONSTRAINT "source_item_user_states_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD CONSTRAINT "source_item_user_states_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD CONSTRAINT "source_item_user_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "fk_source_items_extracted_artifact_id_artifacts" FOREIGN KEY ("extracted_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "fk_source_items_raw_artifact_id_artifacts" FOREIGN KEY ("raw_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "fk_source_items_summary_artifact_id_artifacts" FOREIGN KEY ("summary_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."source_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_item_decisions" ADD CONSTRAINT "source_post_processing_item_decisions_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_item_decisions" ADD CONSTRAINT "source_post_processing_item_decisions_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_item_decisions" ADD CONSTRAINT "source_post_processing_item_decisions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."source_post_processing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_item_decisions" ADD CONSTRAINT "source_post_processing_item_decisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."source_post_processing_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_item_decisions" ADD CONSTRAINT "source_post_processing_item_decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_rules" ADD CONSTRAINT "source_post_processing_rules_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_rules" ADD CONSTRAINT "source_post_processing_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_rules" ADD CONSTRAINT "source_post_processing_rules_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_rules" ADD CONSTRAINT "source_post_processing_rules_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_runs" ADD CONSTRAINT "source_post_processing_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_runs" ADD CONSTRAINT "source_post_processing_runs_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_runs" ADD CONSTRAINT "source_post_processing_runs_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_runs" ADD CONSTRAINT "source_post_processing_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."source_post_processing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_runs" ADD CONSTRAINT "source_post_processing_runs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_post_processing_runs" ADD CONSTRAINT "source_post_processing_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_recipe_versions" ADD CONSTRAINT "source_recipe_versions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_recipe_versions" ADD CONSTRAINT "source_recipe_versions_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_recipe_versions" ADD CONSTRAINT "source_recipe_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_recipe_versions" ADD CONSTRAINT "source_recipe_versions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."source_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_provider_connectors" ADD CONSTRAINT "source_provider_connectors_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."source_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_provider_connectors" ADD CONSTRAINT "source_provider_connectors_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."source_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_item_links" ADD CONSTRAINT "source_channel_item_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_item_links" ADD CONSTRAINT "source_channel_item_links_channel_id_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_item_links" ADD CONSTRAINT "source_channel_item_links_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD CONSTRAINT "source_channel_user_subscriptions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD CONSTRAINT "source_channel_user_subscriptions_channel_id_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD CONSTRAINT "source_channel_user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD CONSTRAINT "source_channel_user_subscriptions_recommended_by_user_id_fkey" FOREIGN KEY ("recommended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channels" ADD CONSTRAINT "source_channels_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channels" ADD CONSTRAINT "source_channels_connection_id_fkey" FOREIGN KEY ("source_connection_id","space_id") REFERENCES "public"."source_connections"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channels" ADD CONSTRAINT "source_channels_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_search_specs" ADD CONSTRAINT "source_search_specs_channel_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_search_specs" ADD CONSTRAINT "source_search_specs_attempt_delete_fkey" FOREIGN KEY ("research_query_attempt_id") REFERENCES "public"."research_query_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_search_specs" ADD CONSTRAINT "source_search_specs_attempt_fkey" FOREIGN KEY ("research_query_attempt_id","space_id") REFERENCES "public"."research_query_attempts"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "source_item_annotations_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "source_item_annotations_item_fkey" FOREIGN KEY ("source_item_id","space_id") REFERENCES "public"."source_items"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "source_item_annotations_channel_fkey" FOREIGN KEY ("source_channel_id") REFERENCES "public"."source_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_annotations" ADD CONSTRAINT "source_item_annotations_run_fkey" FOREIGN KEY ("annotation_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_plans" ADD CONSTRAINT "source_backfill_plans_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_plans" ADD CONSTRAINT "source_backfill_plans_channel_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_plans" ADD CONSTRAINT "source_backfill_plans_binding_fkey" FOREIGN KEY ("project_source_binding_id","space_id") REFERENCES "public"."project_source_bindings"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_plans" ADD CONSTRAINT "source_backfill_plans_operation_fkey" FOREIGN KEY ("project_operation_id","space_id") REFERENCES "public"."project_operations"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_plans" ADD CONSTRAINT "source_backfill_plans_user_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_plans" ADD CONSTRAINT "source_backfill_plans_proposal_fkey" FOREIGN KEY ("proposal_id","space_id") REFERENCES "public"."proposals"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_segments" ADD CONSTRAINT "source_backfill_segments_plan_fkey" FOREIGN KEY ("plan_id","space_id") REFERENCES "public"."source_backfill_plans"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_backfill_segments" ADD CONSTRAINT "source_backfill_segments_job_fkey" FOREIGN KEY ("extraction_job_id","space_id") REFERENCES "public"."extraction_jobs"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_quota_buckets" ADD CONSTRAINT "source_quota_buckets_space_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "fk_space_invitations_invited_by_user_id_users" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "fk_spaces_created_by_user_id_users" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_fkey" FOREIGN KEY ("board_id","space_id") REFERENCES "public"."boards"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_fkey" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_entity_links" ADD CONSTRAINT "task_entity_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_entity_links" ADD CONSTRAINT "task_entity_links_task_id_fkey" FOREIGN KEY ("task_id","space_id") REFERENCES "public"."tasks"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_entity_links" ADD CONSTRAINT "task_entity_links_created_by_actor_id_fkey" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_board_id_fkey" FOREIGN KEY ("board_id","space_id") REFERENCES "public"."boards"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claimed_by_agent_id_fkey" FOREIGN KEY ("claimed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claimed_by_user_id_fkey" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_fkey" FOREIGN KEY ("column_id","board_id","space_id") REFERENCES "public"."board_columns"("id","board_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agent_id_fkey" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_activity_id_fkey" FOREIGN KEY ("source_activity_id") REFERENCES "public"."activity_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_proposal_id_fkey" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_delete_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_recipes" ADD CONSTRAINT "validation_recipes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_recipes" ADD CONSTRAINT "validation_recipes_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_usage_import_cursors" ADD CONSTRAINT "cli_usage_import_cursors_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_usage_import_cursors" ADD CONSTRAINT "cli_usage_import_cursors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_usage_import_cursors" ADD CONSTRAINT "cli_usage_import_cursors_credential_profile_id_fkey" FOREIGN KEY ("credential_profile_id") REFERENCES "public"."cli_credential_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_root_run_id_fkey" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_project_folder_id_fkey" FOREIGN KEY ("project_folder_id") REFERENCES "public"."project_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage_events" ADD CONSTRAINT "token_usage_events_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."usage_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_import_batches" ADD CONSTRAINT "usage_import_batches_target_space_id_fkey" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_import_batches" ADD CONSTRAINT "usage_import_batches_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_execution_host_id_fkey" FOREIGN KEY ("execution_host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_workspace_location_id_fkey" FOREIGN KEY ("workspace_location_id") REFERENCES "public"."workspace_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_workspace_location_host_fkey" FOREIGN KEY ("workspace_location_id","execution_host_id") REFERENCES "public"."workspace_locations"("id","execution_host_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_session_space_fkey" FOREIGN KEY ("session_id","space_id") REFERENCES "public"."sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_agent_space_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_threads" ADD CONSTRAINT "host_threads_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_thread_events" ADD CONSTRAINT "host_thread_events_thread_id_fkey" FOREIGN KEY ("host_task_thread_id") REFERENCES "public"."host_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_thread_events" ADD CONSTRAINT "host_thread_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_thread_events" ADD CONSTRAINT "host_thread_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_runtime_provider_bindings" ADD CONSTRAINT "host_runtime_provider_bindings_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_runtime_provider_bindings" ADD CONSTRAINT "host_runtime_provider_bindings_model_provider_id_fkey" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_runtime_provider_bindings" ADD CONSTRAINT "host_runtime_provider_bindings_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_execution_configs" ADD CONSTRAINT "project_folder_execution_configs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_execution_configs" ADD CONSTRAINT "project_folder_execution_configs_validation_recipe_id_fkey" FOREIGN KEY ("validation_recipe_id") REFERENCES "public"."validation_recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_execution_configs" ADD CONSTRAINT "project_folder_execution_configs_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_project_id_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locations" ADD CONSTRAINT "workspace_locations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locations" ADD CONSTRAINT "workspace_locations_project_folder_id_fkey" FOREIGN KEY ("project_folder_id","space_id") REFERENCES "public"."project_folders"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locations" ADD CONSTRAINT "workspace_locations_execution_host_id_fkey" FOREIGN KEY ("execution_host_id","execution_host_kind") REFERENCES "public"."hosts"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_academic_papers_space_id" ON "academic_papers" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_academic_papers_space_doi" ON "academic_papers" USING btree ("space_id","doi") WHERE (doi IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_academic_papers_space_arxiv_id" ON "academic_papers" USING btree ("space_id","arxiv_id") WHERE (arxiv_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_academic_papers_space_openalex_id" ON "academic_papers" USING btree ("space_id","openalex_id") WHERE (openalex_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_academic_papers_space_semantic_scholar_id" ON "academic_papers" USING btree ("space_id","semantic_scholar_id") WHERE (semantic_scholar_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_activity_records_activity_type" ON "activity_records" USING btree ("activity_type");--> statement-breakpoint
CREATE INDEX "ix_activity_records_agent_id" ON "activity_records" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_owner_user_id" ON "activity_records" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_project_id" ON "activity_records" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_session_id" ON "activity_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_source_kind" ON "activity_records" USING btree ("source_kind");--> statement-breakpoint
CREATE INDEX "ix_activity_records_source_run_id" ON "activity_records" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_source_task_id" ON "activity_records" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_source_trust" ON "activity_records" USING btree ("source_trust");--> statement-breakpoint
CREATE INDEX "ix_activity_records_space_id" ON "activity_records" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_status" ON "activity_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_activity_records_subject_user_id" ON "activity_records" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_user_id" ON "activity_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_activity_records_project_folder_id" ON "activity_records" USING btree ("project_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_activity_records_space_aggregate_key" ON "activity_records" USING btree ("space_id","aggregate_key") WHERE (aggregate_key IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_action_approval_grants_space_agent_action" ON "action_approval_grants" USING btree ("space_id","agent_id","action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_action_approval_grants_active_scope" ON "action_approval_grants" USING btree ("space_id","agent_id","action_id",coalesce("target_run_id", ''),coalesce("project_id", ''),coalesce("resource_kind", ''),coalesce("resource_id", '')) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ix_agent_run_group_members_agent" ON "agent_run_group_members" USING btree ("space_id","agent_id");--> statement-breakpoint
CREATE INDEX "ix_agent_run_group_members_group" ON "agent_run_group_members" USING btree ("space_id","group_id");--> statement-breakpoint
CREATE INDEX "ix_agent_run_groups_manager_user_updated" ON "agent_run_groups" USING btree ("space_id","manager_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ix_agent_run_groups_root_run" ON "agent_run_groups" USING btree ("space_id","root_run_id");--> statement-breakpoint
CREATE INDEX "ix_agent_run_groups_room_session" ON "agent_run_groups" USING btree ("space_id","room_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_agent_run_groups_status_updated" ON "agent_run_groups" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "ix_agent_run_messages_group_created" ON "agent_run_messages" USING btree ("space_id","group_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_agent_run_messages_run_created" ON "agent_run_messages" USING btree ("space_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_agent_run_messages_sender_agent_created" ON "agent_run_messages" USING btree ("space_id","sender_agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_delegations_parent_tool_call" ON "run_delegations" USING btree ("space_id","parent_run_id","tool_call_id") WHERE (tool_call_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_run_delegations_child_run" ON "run_delegations" USING btree ("space_id","child_run_id");--> statement-breakpoint
CREATE INDEX "ix_run_delegations_group_created" ON "run_delegations" USING btree ("space_id","group_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_run_delegations_parent_run" ON "run_delegations" USING btree ("space_id","parent_run_id");--> statement-breakpoint
CREATE INDEX "ix_run_delegations_requesting_agent_created" ON "run_delegations" USING btree ("space_id","requesting_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_run_delegations_status_updated" ON "run_delegations" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "ix_run_delegations_target_agent_created" ON "run_delegations" USING btree ("space_id","target_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_actors_actor_type" ON "actors" USING btree ("actor_type");--> statement-breakpoint
CREATE INDEX "ix_actors_agent_id" ON "actors" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_actors_service_name" ON "actors" USING btree ("service_name");--> statement-breakpoint
CREATE INDEX "ix_actors_space_id" ON "actors" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_actors_status" ON "actors" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_actors_user_id" ON "actors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_actors_user_per_space" ON "actors" USING btree ("space_id","user_id") WHERE actor_type = 'user' AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_actors_service_per_space" ON "actors" USING btree ("space_id","actor_type","service_name") WHERE service_name IS NOT NULL AND status = 'active';--> statement-breakpoint
CREATE INDEX "ix_agent_runtime_profiles_agent_id" ON "agent_runtime_profiles" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_agent_runtime_profiles_model_provider_id" ON "agent_runtime_profiles" USING btree ("model_provider_id");--> statement-breakpoint
CREATE INDEX "ix_agent_runtime_profiles_space_id" ON "agent_runtime_profiles" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_runtime_profiles_default_per_agent" ON "agent_runtime_profiles" USING btree ("agent_id") WHERE (is_default = true);--> statement-breakpoint
CREATE INDEX "ix_agent_versions_agent_id" ON "agent_versions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_agent_versions_model_provider_id" ON "agent_versions" USING btree ("model_provider_id");--> statement-breakpoint
CREATE INDEX "ix_agent_versions_source_activity_id" ON "agent_versions" USING btree ("source_activity_id");--> statement-breakpoint
CREATE INDEX "ix_agent_versions_source_proposal_id" ON "agent_versions" USING btree ("source_proposal_id");--> statement-breakpoint
CREATE INDEX "ix_agent_versions_space_id" ON "agent_versions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_agents_agent_kind" ON "agents" USING btree ("agent_kind");--> statement-breakpoint
CREATE INDEX "ix_agents_current_version_id" ON "agents" USING btree ("current_version_id");--> statement-breakpoint
CREATE INDEX "ix_agents_owner_user_id" ON "agents" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_agents_project_id" ON "agents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_agents_space_id" ON "agents" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_agents_status" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_system_assistant_per_space" ON "agents" USING btree ("space_id") WHERE (((agent_kind)::text = 'system_assistant'::text) AND ((status)::text = 'active'::text) AND (project_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_system_assistant_per_project" ON "agents" USING btree ("space_id","project_id") WHERE (((agent_kind)::text = 'system_assistant'::text) AND ((status)::text = 'active'::text) AND (project_id IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_system_source_post_processor_per_space" ON "agents" USING btree ("space_id") WHERE (((agent_kind)::text = 'system_source_post_processor'::text) AND ((status)::text = 'active'::text));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_system_source_annotator_per_space" ON "agents" USING btree ("space_id") WHERE (((agent_kind)::text = 'system_source_annotator'::text) AND ((status)::text = 'active'::text));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_system_research_per_space" ON "agents" USING btree ("space_id") WHERE (((agent_kind)::text = 'system_research'::text) AND ((status)::text = 'active'::text));--> statement-breakpoint
CREATE INDEX "ix_cli_credential_events_run_id" ON "cli_credential_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_cli_credential_events_space_id" ON "cli_credential_events" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_cli_credential_profiles_owner_user_id" ON "cli_credential_profiles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_cli_credential_profiles_runtime" ON "cli_credential_profiles" USING btree ("runtime");--> statement-breakpoint
CREATE INDEX "ix_cli_credential_space_grants_network_profile_id" ON "cli_credential_space_grants" USING btree ("network_profile_id");--> statement-breakpoint
CREATE INDEX "ix_cli_credential_space_grants_owner_user_id" ON "cli_credential_space_grants" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_cli_credential_space_grants_space_id" ON "cli_credential_space_grants" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_artifact_type" ON "artifacts" USING btree ("artifact_type");--> statement-breakpoint
CREATE INDEX "ix_artifacts_space_surface_role" ON "artifacts" USING btree ("space_id","surface_role");--> statement-breakpoint
CREATE INDEX "ix_artifacts_owner_user_id" ON "artifacts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_project_id" ON "artifacts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_proposal_id" ON "artifacts" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_run_id" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_space_id" ON "artifacts" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_project_folder_id" ON "artifacts" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_auth_accounts_user_id" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "ix_users_status" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_authorization_requests_run" ON "authorization_requests" USING btree ("space_id","run_id","requested_at");--> statement-breakpoint
CREATE INDEX "ix_authorization_requests_reviewer" ON "authorization_requests" USING btree ("space_id","status","instructed_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_automation_credential_grants_automation_id" ON "automation_credential_grants" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "ix_automation_credential_grants_granted_by_user_id" ON "automation_credential_grants" USING btree ("granted_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_automation_credential_grants_lookup" ON "automation_credential_grants" USING btree ("space_id","automation_id","status");--> statement-breakpoint
CREATE INDEX "ix_automation_credential_grants_space_id" ON "automation_credential_grants" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_automation_credential_grants_status" ON "automation_credential_grants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_automation_runs_automation_created" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_automation_runs_automation_id" ON "automation_runs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "ix_automation_runs_run_id" ON "automation_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_automation_runs_workflow_execution_id" ON "automation_runs" USING btree ("workflow_execution_id");--> statement-breakpoint
CREATE INDEX "ix_automation_runs_triggered_by_user_id" ON "automation_runs" USING btree ("triggered_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_automations_agent_id" ON "automations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_automations_owner_user_id" ON "automations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_automations_space_id" ON "automations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_automations_space_project" ON "automations" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_automations_status" ON "automations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_automations_project_folder_id" ON "automations" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_workflow_execution_dependencies_node" ON "workflow_execution_dependencies" USING btree ("space_id","node_id");--> statement-breakpoint
CREATE INDEX "ix_workflow_execution_dependencies_depends_on" ON "workflow_execution_dependencies" USING btree ("space_id","depends_on_node_id");--> statement-breakpoint
CREATE INDEX "ix_workflow_execution_node_runs_node" ON "workflow_execution_node_runs" USING btree ("space_id","node_id");--> statement-breakpoint
CREATE INDEX "ix_workflow_execution_node_runs_run" ON "workflow_execution_node_runs" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_workflow_execution_nodes_execution_status" ON "workflow_execution_nodes" USING btree ("space_id","execution_id","status");--> statement-breakpoint
CREATE INDEX "ix_workflow_execution_nodes_capability" ON "workflow_execution_nodes" USING btree ("space_id","capability_id");--> statement-breakpoint
CREATE INDEX "ix_workflow_executions_automation_created" ON "workflow_executions" USING btree ("space_id","automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_workflow_executions_status" ON "workflow_executions" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_workflow_executions_root_run" ON "workflow_executions" USING btree ("space_id","root_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_executions_active_research_operation" ON "workflow_executions" USING btree ("research_operation_id") WHERE research_operation_id IS NOT NULL AND status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "ix_autonomy_candidate_evolution_signals_candidate" ON "autonomy_candidate_evolution_signals" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "ix_autonomy_candidates_space_owner_status" ON "autonomy_candidates" USING btree ("space_id","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_autonomy_candidates_project" ON "autonomy_candidates" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_autonomy_candidates_run" ON "autonomy_candidates" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_autonomy_tick_candidates_tick_rank" ON "autonomy_tick_candidates" USING btree ("tick_id","rank");--> statement-breakpoint
CREATE INDEX "ix_autonomy_ticks_automation_created" ON "autonomy_ticks" USING btree ("automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_autonomy_ticks_space_owner_created" ON "autonomy_ticks" USING btree ("space_id","owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_runtime_conformance_adapter_status" ON "runtime_conformance_results" USING btree ("runtime_adapter_type","status");--> statement-breakpoint
CREATE INDEX "ix_runtime_conformance_updated_at" ON "runtime_conformance_results" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_context_capture_gaps_scope_status" ON "context_capture_gaps" USING btree ("space_id","work_context_scope_id","status");--> statement-breakpoint
CREATE INDEX "ix_context_checkpoint_corrections_checkpoint" ON "context_checkpoint_corrections" USING btree ("semantic_checkpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_context_events_invocation" ON "context_events" USING btree ("space_id","invocation_id");--> statement-breakpoint
CREATE INDEX "ix_context_semantic_checkpoints_scope_status" ON "context_semantic_checkpoints" USING btree ("space_id","work_context_scope_id","status");--> statement-breakpoint
CREATE INDEX "ix_execution_control_snapshots_run_created" ON "execution_control_snapshots" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_invocation_deliveries_control" ON "invocation_deliveries" USING btree ("execution_control_snapshot_id");--> statement-breakpoint
CREATE INDEX "ix_invocation_snapshots_invocation" ON "invocation_snapshots" USING btree ("space_id","invocation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_context_cli_bindings_active_scope" ON "runtime_context_cli_bindings" USING btree ("space_id","work_context_scope_id","user_id","agent_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ix_runtime_context_cli_bindings_scope" ON "runtime_context_cli_bindings" USING btree ("space_id","work_context_scope_id");--> statement-breakpoint
CREATE INDEX "ix_runtime_context_cli_bindings_runtime_profile" ON "runtime_context_cli_bindings" USING btree ("runtime_profile_id");--> statement-breakpoint
CREATE INDEX "ix_runtime_context_policy_audits_scope_created" ON "runtime_context_policy_audits" USING btree ("space_id","scope_type","scope_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_runtime_context_policy_versions_scope" ON "runtime_context_policy_versions" USING btree ("space_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "ix_sealed_payload_access_audits_payload" ON "sealed_invocation_payload_access_audits" USING btree ("sealed_payload_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_sealed_payload_access_audits_viewer" ON "sealed_invocation_payload_access_audits" USING btree ("viewer_user_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_sealed_invocation_payloads_retention" ON "sealed_invocation_payloads" USING btree ("retention_deadline");--> statement-breakpoint
CREATE INDEX "ix_work_context_setups_scope" ON "work_context_setups" USING btree ("space_id","work_context_scope_id");--> statement-breakpoint
CREATE INDEX "ix_capability_enablements_agent_id" ON "capability_enablements" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_capability_enablements_capability_key" ON "capability_enablements" USING btree ("capability_key");--> statement-breakpoint
CREATE INDEX "ix_capability_enablements_project_id" ON "capability_enablements" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_capability_enablements_space_id" ON "capability_enablements" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_capability_enablements_user_id" ON "capability_enablements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_enablements_agent" ON "capability_enablements" USING btree ("space_id","agent_id","capability_key") WHERE ((agent_id IS NOT NULL) AND (project_id IS NULL) AND (user_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_enablements_project" ON "capability_enablements" USING btree ("space_id","project_id","capability_key") WHERE ((project_id IS NOT NULL) AND (agent_id IS NULL) AND (user_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_enablements_space" ON "capability_enablements" USING btree ("space_id","capability_key") WHERE ((project_id IS NULL) AND (agent_id IS NULL) AND (user_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_enablements_user" ON "capability_enablements" USING btree ("space_id","user_id","capability_key") WHERE ((user_id IS NOT NULL) AND (project_id IS NULL) AND (agent_id IS NULL));--> statement-breakpoint
CREATE INDEX "ix_capability_runtime_bindings_capability_key" ON "capability_runtime_bindings" USING btree ("capability_key");--> statement-breakpoint
CREATE INDEX "ix_capability_runtime_bindings_space_id" ON "capability_runtime_bindings" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_capability_runtime_bindings_version_id" ON "capability_runtime_bindings" USING btree ("capability_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_runtime_bindings_scope_runtime" ON "capability_runtime_bindings" USING btree (COALESCE(space_id, '__global__'::character varying),capability_key,COALESCE(capability_version_id, '__none__'::character varying),runtime_adapter_type,render_mode);--> statement-breakpoint
CREATE INDEX "ix_capability_versions_capability_key" ON "capability_versions" USING btree ("capability_key");--> statement-breakpoint
CREATE INDEX "ix_capability_versions_key_space_status" ON "capability_versions" USING btree ("capability_key","space_id","status");--> statement-breakpoint
CREATE INDEX "ix_capability_versions_parent_version_id" ON "capability_versions" USING btree ("parent_version_id");--> statement-breakpoint
CREATE INDEX "ix_capability_versions_proposal_id" ON "capability_versions" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_capability_versions_space_id" ON "capability_versions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_capability_versions_source" ON "capability_versions" USING btree ("source");--> statement-breakpoint
CREATE INDEX "ix_capability_versions_status" ON "capability_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_skill_local_overlays_package_scope" ON "skill_local_overlays" USING btree ("space_id","skill_package_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "ix_skill_local_overlays_scope" ON "skill_local_overlays" USING btree ("space_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "ix_skill_local_overlays_status" ON "skill_local_overlays" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_local_overlays_active_scope" ON "skill_local_overlays" USING btree (space_id,skill_package_id,scope_type,COALESCE(scope_id, ''::character varying)) WHERE ((status)::text = 'active'::text);--> statement-breakpoint
CREATE INDEX "ix_skill_package_files_kind" ON "skill_package_files" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "ix_skill_package_files_package_id" ON "skill_package_files" USING btree ("skill_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_skill_package_files_package_path" ON "skill_package_files" USING btree ("skill_package_id","path");--> statement-breakpoint
CREATE INDEX "ix_skill_packages_risk_level" ON "skill_packages" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX "ix_skill_packages_source_id" ON "skill_packages" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_skill_packages_space_id" ON "skill_packages" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_skill_packages_status" ON "skill_packages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_skill_sources_content_hash" ON "skill_sources" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "ix_skill_sources_source_type" ON "skill_sources" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "ix_skill_sources_space_id" ON "skill_sources" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_card_review_states_card_id" ON "card_review_states" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "ix_card_review_states_user_due" ON "card_review_states" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "ix_card_reviews_card_id" ON "card_reviews" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "ix_card_reviews_rating" ON "card_reviews" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "ix_card_reviews_user_reviewed_at" ON "card_reviews" USING btree ("user_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "ix_cards_card_type" ON "cards" USING btree ("card_type");--> statement-breakpoint
CREATE INDEX "ix_cards_created_at" ON "cards" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_cards_source" ON "cards" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "ix_cards_source_id" ON "cards" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_cards_source_type" ON "cards" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "ix_cards_space_id" ON "cards" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_cards_status" ON "cards" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_content_access_grants_grantee" ON "content_access_grants" USING btree ("space_id","grantee_user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "ix_content_access_grants_resource" ON "content_access_grants" USING btree ("space_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "ix_content_access_logs_accessed_at" ON "content_access_logs" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "ix_content_access_logs_owner" ON "content_access_logs" USING btree ("owner_user_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_content_access_logs_viewer" ON "content_access_logs" USING btree ("viewer_user_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_content_access_logs_resource" ON "content_access_logs" USING btree ("space_id","resource_type","resource_id","accessed_at");--> statement-breakpoint
CREATE INDEX "ix_content_access_logs_run_id" ON "content_access_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_content_demotion_disclosures_owner" ON "content_demotion_disclosures" USING btree ("owner_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "ix_space_object_project_shares_object" ON "space_object_project_shares" USING btree ("space_id","object_id","revoked_at");--> statement-breakpoint
CREATE INDEX "ix_space_object_project_shares_project" ON "space_object_project_shares" USING btree ("space_id","project_id","revoked_at");--> statement-breakpoint
CREATE INDEX "ix_content_egress_records_source_space" ON "content_egress_records" USING btree ("source_space_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_cross_space_egress_disclosures_user" ON "cross_space_egress_disclosures" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "ix_cross_space_retrieval_pointers_user" ON "cross_space_retrieval_pointers" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "ix_cross_space_retrieval_sessions_user" ON "cross_space_retrieval_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_space_member_notifications_recipient" ON "space_member_notifications" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_decision_cases_project_status" ON "decision_cases" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ix_decision_cases_decided_option_id" ON "decision_cases" USING btree ("decided_option_id");--> statement-breakpoint
CREATE INDEX "ix_decision_commitments_case" ON "decision_commitments" USING btree ("decision_case_id");--> statement-breakpoint
CREATE INDEX "ix_decision_criteria_case" ON "decision_criteria" USING btree ("decision_case_id");--> statement-breakpoint
CREATE INDEX "ix_decision_option_scores_case" ON "decision_option_scores" USING btree ("decision_case_id");--> statement-breakpoint
CREATE INDEX "ix_decision_options_case" ON "decision_options" USING btree ("decision_case_id");--> statement-breakpoint
CREATE INDEX "ix_domain_change_outbox_pending" ON "domain_change_outbox" USING btree ("space_id","claim_expires_at","occurred_at") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_domain_change_outbox_source" ON "domain_change_outbox" USING btree ("space_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_bundle_members_bundle_position" ON "evolution_bundle_members" USING btree ("bundle_id","position");--> statement-breakpoint
CREATE INDEX "ix_evolution_bundle_members_proposal_id" ON "evolution_bundle_members" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolution_bundle_members_proposal" ON "evolution_bundle_members" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_bundles_space_status_updated" ON "evolution_bundles" USING btree ("space_id","status","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_evolution_bundles_created_by_user" ON "evolution_bundles" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_experiences_space_source_run" ON "evolution_experiences" USING btree ("space_id","source_run_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_experiences_space_strategy_created" ON "evolution_experiences" USING btree ("space_id","strategy_asset_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolution_experiences_space_key" ON "evolution_experiences" USING btree ("space_id","experience_key");--> statement-breakpoint
CREATE INDEX "ix_evolution_selector_decisions_space_run" ON "evolution_selector_decisions" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_selector_decisions_space_target_created" ON "evolution_selector_decisions" USING btree ("space_id","target_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_severity" ON "evolution_signals" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_signal_type" ON "evolution_signals" USING btree ("signal_type");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_source_id" ON "evolution_signals" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_source_type" ON "evolution_signals" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_space_id" ON "evolution_signals" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_space_target_type_created" ON "evolution_signals" USING btree ("space_id","target_id","signal_type","created_at");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_space_triage_created" ON "evolution_signals" USING btree ("space_id","triage_status","created_at");--> statement-breakpoint
CREATE INDEX "ix_evolution_signals_target_id" ON "evolution_signals" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_strategy_assets_space_status_category_target" ON "evolution_strategy_assets" USING btree ("space_id","status","category","target_type");--> statement-breakpoint
CREATE INDEX "ix_evolution_strategy_assets_strategy_key" ON "evolution_strategy_assets" USING btree ("strategy_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolution_strategy_assets_space_key" ON "evolution_strategy_assets" USING btree ("space_id","strategy_key") WHERE (space_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolution_strategy_assets_system_key" ON "evolution_strategy_assets" USING btree ("strategy_key") WHERE (space_id IS NULL);--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_capability_key" ON "evolution_targets" USING btree ("capability_key");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_current_version_id" ON "evolution_targets" USING btree ("current_version_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_risk_level" ON "evolution_targets" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_space_id" ON "evolution_targets" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_space_type_ref_status" ON "evolution_targets" USING btree ("space_id","target_type","target_ref_id","status");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_status" ON "evolution_targets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_target_ref_id" ON "evolution_targets" USING btree ("target_ref_id");--> statement-breakpoint
CREATE INDEX "ix_evolution_targets_target_type" ON "evolution_targets" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX "ix_run_reflections_run_id" ON "run_reflections" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_run_reflections_space_id" ON "run_reflections" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_focus_areas_space" ON "focus_areas" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_focus_areas_space_name" ON "focus_areas" USING btree ("space_id","name") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_evaluation_cases_space_id" ON "evaluation_cases" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evaluation_cases_asset_id" ON "evaluation_cases" USING btree ("asset_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_evaluation_cases_source_run_id" ON "evaluation_cases" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_evaluation_runs_space_id" ON "evolvable_asset_evaluation_runs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_evaluation_runs_asset_id" ON "evolvable_asset_evaluation_runs" USING btree ("asset_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_evaluation_runs_candidate_version_id" ON "evolvable_asset_evaluation_runs" USING btree ("candidate_version_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_pins_space_id" ON "evolvable_asset_pins" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_pins_asset_id" ON "evolvable_asset_pins" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolvable_asset_pins_active_scope" ON "evolvable_asset_pins" USING btree ("space_id","asset_id","scope_type","scope_id") WHERE (status)::text = 'active'::text;--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_versions_asset_id" ON "evolvable_asset_versions" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_versions_space_id" ON "evolvable_asset_versions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_versions_scope" ON "evolvable_asset_versions" USING btree ("asset_id","scope_type","scope_id","status");--> statement-breakpoint
CREATE INDEX "ix_evolvable_asset_versions_parent_version_id" ON "evolvable_asset_versions" USING btree ("parent_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolvable_asset_versions_asset_version" ON "evolvable_asset_versions" USING btree ("asset_id","version");--> statement-breakpoint
CREATE INDEX "ix_evolvable_assets_space_id" ON "evolvable_assets" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evolvable_assets_asset_type" ON "evolvable_assets" USING btree ("asset_type");--> statement-breakpoint
CREATE INDEX "ix_evolvable_assets_current_system_version_id" ON "evolvable_assets" USING btree ("current_system_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolvable_assets_space_key" ON "evolvable_assets" USING btree ("space_id","asset_key") WHERE (space_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evolvable_assets_system_key" ON "evolvable_assets" USING btree ("asset_key") WHERE (space_id IS NULL);--> statement-breakpoint
CREATE INDEX "ix_experiment_definitions_project_id" ON "experiment_definitions" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_experiment_definitions_thread_id" ON "experiment_definitions" USING btree ("primary_hypothesis_thread_id");--> statement-breakpoint
CREATE INDEX "ix_experiment_interpretations_definition_id" ON "experiment_interpretations" USING btree ("space_id","definition_id");--> statement-breakpoint
CREATE INDEX "ix_experiment_interpretations_project_id" ON "experiment_interpretations" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_experiment_observations_run_id" ON "experiment_observations" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_experiment_runs_version_id" ON "experiment_runs" USING btree ("space_id","version_id");--> statement-breakpoint
CREATE INDEX "ix_experiment_versions_definition_id" ON "experiment_versions" USING btree ("space_id","definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_experiment_versions_definition_version" ON "experiment_versions" USING btree ("definition_id","version");--> statement-breakpoint
CREATE INDEX "ix_graph_view_states_scope_key" ON "graph_view_states" USING btree ("scope_key");--> statement-breakpoint
CREATE INDEX "ix_graph_view_states_space_user" ON "graph_view_states" USING btree ("space_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_imported_session_records_session_sequence" ON "imported_session_records" USING btree ("imported_session_id","sequence");--> statement-breakpoint
CREATE INDEX "ix_imported_session_records_unextracted" ON "imported_session_records" USING btree ("space_id","imported_session_id") WHERE extracted_in IS NULL;--> statement-breakpoint
CREATE INDEX "ix_imported_sessions_project_id" ON "imported_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_imported_sessions_location_id" ON "imported_sessions" USING btree ("workspace_location_id");--> statement-breakpoint
CREATE INDEX "ix_imported_sessions_owner_user_id" ON "imported_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_imported_sessions_space_last_record" ON "imported_sessions" USING btree ("space_id","last_record_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_iterations_thread_id" ON "inquiry_iterations" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_iterations_project_id" ON "inquiry_iterations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_lifecycle_events_thread_id" ON "inquiry_thread_lifecycle_events" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_thread_personal_focus_scope" ON "inquiry_thread_personal_focus" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_personal_focus_project_id" ON "inquiry_thread_personal_focus" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_revisions_thread_id" ON "inquiry_thread_revisions" USING btree ("thread_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_thread_revisions_thread_version" ON "inquiry_thread_revisions" USING btree ("thread_id","version");--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_statement_revisions_thread_id" ON "inquiry_thread_statement_revisions" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_steps_thread_id" ON "inquiry_thread_steps" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_steps_project_id" ON "inquiry_thread_steps" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_thread_steps_primary_open" ON "inquiry_thread_steps" USING btree ("thread_id") WHERE slot = 'primary' AND status = 'in_progress';--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_structure_events_thread_id" ON "inquiry_thread_structure_events" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_work_events_thread_id" ON "inquiry_thread_work_events" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_threads_project_id" ON "inquiry_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_threads_space_id" ON "inquiry_threads" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_threads_primary_parent_id" ON "inquiry_threads" USING btree ("primary_parent_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_threads_attention_state" ON "inquiry_threads" USING btree ("project_id","attention_state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_threads_project_idempotency" ON "inquiry_threads" USING btree ("space_id","project_id","producer_idempotency_key") WHERE producer_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_inquiry_thread_advice_project_id" ON "inquiry_thread_advice" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_thread_advice_thread" ON "inquiry_thread_advice" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_delta_briefs_project_id" ON "inquiry_delta_briefs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_evidence_signals_thread_id" ON "inquiry_evidence_signals" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inquiry_evidence_signals_project_id" ON "inquiry_evidence_signals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_evidence_signals_candidate_id" ON "inquiry_evidence_signals" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_evidence_signals_corpus_item_id" ON "inquiry_evidence_signals" USING btree ("corpus_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_evidence_signals_dedupe" ON "inquiry_evidence_signals" USING btree ("project_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_evidence_signals_producer_key" ON "inquiry_evidence_signals" USING btree ("project_id","producer_idempotency_key") WHERE producer_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_inquiry_review_packets_project_status" ON "inquiry_review_packets" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ix_inquiry_signal_candidates_project_status" ON "inquiry_signal_candidates" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ix_inquiry_signal_candidates_thread_id" ON "inquiry_signal_candidates" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "ix_inquiry_signal_candidates_review_packet_id" ON "inquiry_signal_candidates" USING btree ("review_packet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inquiry_signal_candidates_open_semantic" ON "inquiry_signal_candidates" USING btree ("thread_id","candidate_kind","semantic_key") WHERE (status)::text = 'pending'::text;--> statement-breakpoint
CREATE INDEX "ix_interest_topic_candidates_ready" ON "interest_topic_candidates" USING btree ("profile_id","status","occurrence_count");--> statement-breakpoint
CREATE INDEX "ix_interest_topic_observations_profile" ON "interest_topic_observations" USING btree ("profile_id","observed_at");--> statement-breakpoint
CREATE INDEX "ix_interest_topic_observations_unread" ON "interest_topic_observations" USING btree ("profile_id","counted_as_read");--> statement-breakpoint
CREATE INDEX "ix_interest_topics_profile_status" ON "interest_topics" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "ix_interest_topics_domain" ON "interest_topics" USING btree ("space_id","user_id","domain_key");--> statement-breakpoint
CREATE INDEX "ix_information_digest_items_digest_section" ON "information_digest_items" USING btree ("digest_id","section","position");--> statement-breakpoint
CREATE INDEX "ix_information_digest_probe_runs_recent" ON "information_digest_probe_runs" USING btree ("space_id","user_id","period_start");--> statement-breakpoint
CREATE INDEX "ix_information_digest_serendipity_domain_state_active" ON "information_digest_serendipity_domain_states" USING btree ("space_id","user_id","blocked_at","cooldown_until");--> statement-breakpoint
CREATE INDEX "ix_information_digest_serendipity_feedback_owner" ON "information_digest_serendipity_feedback" USING btree ("space_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_information_digest_serendipity_pool_ready" ON "information_digest_serendipity_pool" USING btree ("space_id","user_id","status","available_until");--> statement-breakpoint
CREATE INDEX "ix_information_digest_serendipity_pool_domain" ON "information_digest_serendipity_pool" USING btree ("space_id","user_id","target_domain_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_digests_personal_day" ON "information_digests" USING btree ("space_id","owner_user_id","digest_date") WHERE digest_type = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_information_digests_project_day" ON "information_digests" USING btree ("space_id","project_id","digest_date") WHERE digest_type = 'project';--> statement-breakpoint
CREATE INDEX "ix_information_digests_personal_recent" ON "information_digests" USING btree ("space_id","owner_user_id","digest_date");--> statement-breakpoint
CREATE INDEX "ix_information_digests_project_recent" ON "information_digests" USING btree ("space_id","project_id","digest_date");--> statement-breakpoint
CREATE INDEX "ix_job_events_job_id" ON "job_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ix_jobs_agent_id" ON "jobs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_jobs_claim_pending" ON "jobs" USING btree ("priority" DESC NULLS FIRST,"scheduled_at") WHERE ((status)::text = 'pending'::text);--> statement-breakpoint
CREATE INDEX "ix_jobs_job_type" ON "jobs" USING btree ("job_type");--> statement-breakpoint
CREATE INDEX "ix_jobs_space_id" ON "jobs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_jobs_type_claim_pending" ON "jobs" USING btree ("job_type","priority" DESC NULLS FIRST,"scheduled_at") WHERE ((status)::text = 'pending'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_runtime_context_checkpoint_cursor" ON "jobs" USING btree ("space_id",(payload_json->>'work_context_scope_id'),(payload_json->>'target_cursor')) WHERE job_type = 'runtime_context_checkpoint' AND status IN ('pending','claimed','running','completed');--> statement-breakpoint
CREATE INDEX "ix_jobs_user_id" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_jobs_project_folder_id" ON "jobs" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_claim_sources_claim_id" ON "claim_sources" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "ix_claim_sources_source_connection_id" ON "claim_sources" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "ix_claim_sources_source_object_id" ON "claim_sources" USING btree ("source_object_id");--> statement-breakpoint
CREATE INDEX "ix_claim_sources_space_id" ON "claim_sources" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_claims_claim_kind" ON "claims" USING btree ("claim_kind");--> statement-breakpoint
CREATE INDEX "ix_claims_status" ON "claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_claims_created_from_proposal_id" ON "claims" USING btree ("created_from_proposal_id");--> statement-breakpoint
CREATE INDEX "ix_claims_holder_object_id" ON "claims" USING btree ("holder_object_id");--> statement-breakpoint
CREATE INDEX "ix_claims_normalized_claim_hash" ON "claims" USING btree ("normalized_claim_hash");--> statement-breakpoint
CREATE INDEX "ix_claims_space_id" ON "claims" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_claims_subject_object_id" ON "claims" USING btree ("subject_object_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_created_by_agent_id" ON "evidence_links" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_created_by_run_id" ON "evidence_links" USING btree ("created_by_run_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_created_by_user_id" ON "evidence_links" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_evidence_id" ON "evidence_links" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_evidence_target" ON "evidence_links" USING btree ("evidence_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_link_type" ON "evidence_links" USING btree ("link_type");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_space_id" ON "evidence_links" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_status" ON "evidence_links" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_target" ON "evidence_links" USING btree ("space_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_target_id" ON "evidence_links" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_links_target_type" ON "evidence_links" USING btree ("target_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_links_active_dedupe" ON "evidence_links" USING btree ("space_id","evidence_id","target_type","target_id","link_type") WHERE ((status)::text = 'active'::text);--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_artifact_id" ON "extracted_evidence" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_content_hash" ON "extracted_evidence" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_created_by_agent_id" ON "extracted_evidence" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_created_by_run_id" ON "extracted_evidence" USING btree ("created_by_run_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_created_by_user_id" ON "extracted_evidence" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_deleted_at" ON "extracted_evidence" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_evidence_type" ON "extracted_evidence" USING btree ("evidence_type");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_extraction_job_id" ON "extracted_evidence" USING btree ("extraction_job_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_occurred_at" ON "extracted_evidence" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_owner_user_id" ON "extracted_evidence" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_project_id" ON "extracted_evidence" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_origin_source_item_id" ON "extracted_evidence" USING btree ("origin_source_item_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_source_item_id" ON "extracted_evidence" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_source_object" ON "extracted_evidence" USING btree ("space_id","source_object_type","source_object_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_source_object_id" ON "extracted_evidence" USING btree ("source_object_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_source_object_type" ON "extracted_evidence" USING btree ("source_object_type");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_source_snapshot_id" ON "extracted_evidence" USING btree ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_space_id" ON "extracted_evidence" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_space_status" ON "extracted_evidence" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_status" ON "extracted_evidence" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_trust_level" ON "extracted_evidence" USING btree ("trust_level");--> statement-breakpoint
CREATE INDEX "ix_extracted_evidence_visibility" ON "extracted_evidence" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_extracted_evidence_source_content" ON "extracted_evidence" USING btree ("space_id","source_item_id","content_hash") WHERE source_item_id IS NOT NULL AND content_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_knowledge_item_sources_knowledge_item_id" ON "knowledge_item_sources" USING btree ("knowledge_item_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_item_sources_relation_type" ON "knowledge_item_sources" USING btree ("relation_type");--> statement-breakpoint
CREATE INDEX "ix_knowledge_item_sources_source_id" ON "knowledge_item_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_item_sources_space_id" ON "knowledge_item_sources" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_knowledge_item_sources_unique" ON "knowledge_item_sources" USING btree ("knowledge_item_id","source_id","relation_type");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_created_from_proposal_id" ON "knowledge_items" USING btree ("created_from_proposal_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_knowledge_kind" ON "knowledge_items" USING btree ("knowledge_kind");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_status" ON "knowledge_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_redirect_to_item_id" ON "knowledge_items" USING btree ("redirect_to_item_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_root_item_id" ON "knowledge_items" USING btree ("root_item_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_slug" ON "knowledge_items" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_space_id" ON "knowledge_items" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_space_slug" ON "knowledge_items" USING btree ("space_id","slug");--> statement-breakpoint
CREATE INDEX "ix_knowledge_items_supersedes_item_id" ON "knowledge_items" USING btree ("supersedes_item_id");--> statement-breakpoint
CREATE INDEX "ix_note_collection_items_collection_id" ON "note_collection_items" USING btree ("space_id","collection_id");--> statement-breakpoint
CREATE INDEX "ix_note_collection_items_note_id" ON "note_collection_items" USING btree ("space_id","note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_note_collections_one_archive_per_space" ON "note_collections" USING btree ("space_id") WHERE ((system_role)::text = 'archive'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_note_collections_one_inbox_per_space" ON "note_collections" USING btree ("space_id") WHERE ((system_role)::text = 'inbox'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_note_collections_one_projects_root_per_space" ON "note_collections" USING btree ("space_id") WHERE ((system_role)::text = 'projects_root'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_note_collections_one_per_project" ON "note_collections" USING btree ("space_id","project_id") WHERE (project_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_note_collections_parent_id" ON "note_collections" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "ix_note_collections_parent_sort" ON "note_collections" USING btree ("space_id","parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "ix_note_collections_space_id" ON "note_collections" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_note_collections_system_role" ON "note_collections" USING btree ("system_role");--> statement-breakpoint
CREATE INDEX "ix_note_links_from_object" ON "note_links" USING btree ("space_id","from_object_id");--> statement-breakpoint
CREATE INDEX "ix_note_links_link_type" ON "note_links" USING btree ("link_type");--> statement-breakpoint
CREATE INDEX "ix_note_links_space_id" ON "note_links" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_note_links_status" ON "note_links" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_note_links_to_object" ON "note_links" USING btree ("space_id","to_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_note_links_unique_active" ON "note_links" USING btree ("space_id","from_object_id","to_object_id","link_type") WHERE ((status)::text = 'active'::text);--> statement-breakpoint
CREATE INDEX "ix_note_revisions_note" ON "note_revisions" USING btree ("space_id","note_id","version");--> statement-breakpoint
CREATE INDEX "ix_notes_created_from_activity_id" ON "notes" USING btree ("created_from_activity_id");--> statement-breakpoint
CREATE INDEX "ix_notes_status" ON "notes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_notes_space_id" ON "notes" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_notes_one_note_per_project_role" ON "notes" USING btree ("space_id","role_project_id","project_role") WHERE (project_role IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_notes_one_marginalia_note_per_owner" ON "notes" USING btree ("space_id","marginalia_project_id","marginalia_owner_user_id",COALESCE(marginalia_target_object_id, '')) WHERE (marginalia_owner_user_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_object_relations_from_object_id" ON "object_relations" USING btree ("from_object_id");--> statement-breakpoint
CREATE INDEX "ix_object_relations_link_type" ON "object_relations" USING btree ("link_type");--> statement-breakpoint
CREATE INDEX "ix_object_relations_source_claim_id" ON "object_relations" USING btree ("source_claim_id");--> statement-breakpoint
CREATE INDEX "ix_object_relations_source_object_id" ON "object_relations" USING btree ("source_object_id");--> statement-breakpoint
CREATE INDEX "ix_object_relations_space_id" ON "object_relations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_object_relations_status" ON "object_relations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_object_relations_to_object_id" ON "object_relations" USING btree ("to_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_object_relations_unique_active" ON "object_relations" USING btree ("space_id","from_object_id","to_object_id","link_type") WHERE ((status)::text = 'active'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_object_relations_primary_thread_from" ON "object_relations" USING btree ("space_id","from_object_id","link_type") WHERE status = 'active' AND link_type = 'about' AND metadata_json->>'relation_role' = 'primary_inquiry_thread';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_object_relations_primary_thread_to" ON "object_relations" USING btree ("space_id","to_object_id","link_type") WHERE status = 'active' AND link_type = 'about' AND metadata_json->>'relation_role' = 'primary_inquiry_thread';--> statement-breakpoint
CREATE INDEX "ix_source_item_references_reference" ON "source_item_references" USING btree ("space_id","reference_object_id");--> statement-breakpoint
CREATE INDEX "ix_sources_source_activity_id" ON "sources" USING btree ("source_activity_id");--> statement-breakpoint
CREATE INDEX "ix_sources_source_type" ON "sources" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "ix_sources_status" ON "sources" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_sources_space_id" ON "sources" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_space_object_profile_relation_hints_endpoint_kind" ON "space_object_profile_relation_hints" USING btree ("endpoint_object_profile_id");--> statement-breakpoint
CREATE INDEX "ix_space_object_profile_relation_hints_object_profile" ON "space_object_profile_relation_hints" USING btree ("object_profile_id");--> statement-breakpoint
CREATE INDEX "ix_space_object_profile_relation_hints_required" ON "space_object_profile_relation_hints" USING btree ("space_id","required");--> statement-breakpoint
CREATE INDEX "ix_space_object_profiles_base_object_type" ON "space_object_profiles" USING btree ("base_object_type");--> statement-breakpoint
CREATE INDEX "ix_space_object_profiles_created_by_user_id" ON "space_object_profiles" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_space_object_profiles_space_id" ON "space_object_profiles" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_space_object_profiles_status" ON "space_object_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_space_objects_created_by_user_id" ON "space_objects" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_space_objects_deleted_at" ON "space_objects" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "ix_space_objects_owner_user_id" ON "space_objects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_space_objects_primary_project_id" ON "space_objects" USING btree ("primary_project_id");--> statement-breakpoint
CREATE INDEX "ix_space_objects_focus_area_id" ON "space_objects" USING btree ("focus_area_id") WHERE focus_area_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_space_objects_space_type" ON "space_objects" USING btree ("space_id","object_type");--> statement-breakpoint
CREATE INDEX "ix_space_objects_visibility" ON "space_objects" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "ix_space_objects_project_folder_id" ON "space_objects" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_promotion_candidates_space_status" ON "knowledge_promotion_candidates" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_knowledge_promotion_candidates_supersedes" ON "knowledge_promotion_candidates" USING btree ("supersedes_knowledge_item_id");--> statement-breakpoint
CREATE INDEX "ix_knowledge_promotion_review_packets_project_status" ON "knowledge_promotion_review_packets" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ix_knowledge_revalidation_outcomes_item" ON "knowledge_revalidation_outcomes" USING btree ("space_id","knowledge_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_knowledge_revalidation_outcomes_item_event" ON "knowledge_revalidation_outcomes" USING btree ("knowledge_item_id","event_id");--> statement-breakpoint
CREATE INDEX "ix_learning_item_mastery_user_next_review" ON "learning_item_mastery" USING btree ("user_id","next_review_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_learning_item_mastery_item_user" ON "learning_item_mastery" USING btree ("learning_item_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_learning_items_space_project" ON "learning_items" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_learning_items_objective_id" ON "learning_items" USING btree ("objective_id");--> statement-breakpoint
CREATE INDEX "ix_learning_objectives_space_project" ON "learning_objectives" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_agent_id" ON "memory_entries" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_created_from_proposal_id" ON "memory_entries" USING btree ("created_from_proposal_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_memory_layer" ON "memory_entries" USING btree ("memory_layer");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_memory_type" ON "memory_entries" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_namespace" ON "memory_entries" USING btree ("namespace");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_owner_user_id" ON "memory_entries" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_project_id" ON "memory_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_root_memory_id" ON "memory_entries" USING btree ("root_memory_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_scope_type" ON "memory_entries" USING btree ("scope_type");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_sensitivity_level" ON "memory_entries" USING btree ("sensitivity_level");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_space_id" ON "memory_entries" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_status" ON "memory_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_subject_user_id" ON "memory_entries" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_supersedes_memory_id" ON "memory_entries" USING btree ("supersedes_memory_id");--> statement-breakpoint
CREATE INDEX "ix_memory_entries_visibility" ON "memory_entries" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "ix_memory_maintenance_jobs_due" ON "memory_maintenance_jobs" USING btree ("status","run_after","updated_at");--> statement-breakpoint
CREATE INDEX "ix_memory_maintenance_jobs_owner" ON "memory_maintenance_jobs" USING btree ("space_id","owner_user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "ix_memory_relations_created_from_proposal_id" ON "memory_relations" USING btree ("created_from_proposal_id");--> statement-breakpoint
CREATE INDEX "ix_memory_relations_relation_type" ON "memory_relations" USING btree ("relation_type");--> statement-breakpoint
CREATE INDEX "ix_memory_relations_source" ON "memory_relations" USING btree ("space_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "ix_memory_relations_space_id" ON "memory_relations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_memory_relations_target" ON "memory_relations" USING btree ("space_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "ix_provenance_links_source" ON "provenance_links" USING btree ("space_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "ix_provenance_links_source_type" ON "provenance_links" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "ix_provenance_links_space_id" ON "provenance_links" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_provenance_links_target" ON "provenance_links" USING btree ("space_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "ix_participation_records_personal_space_id" ON "participation_records" USING btree ("personal_space_id");--> statement-breakpoint
CREATE INDEX "ix_participation_records_source" ON "participation_records" USING btree ("source_space_id","source_object_type","source_object_id");--> statement-breakpoint
CREATE INDEX "ix_participation_records_user_id" ON "participation_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grant_events_actor_user_id" ON "personal_memory_grant_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grant_events_created_at" ON "personal_memory_grant_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grant_events_grant_id" ON "personal_memory_grant_events" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grant_events_run_id" ON "personal_memory_grant_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grants_granting_user_id" ON "personal_memory_grants" USING btree ("granting_user_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grants_personal_space_id" ON "personal_memory_grants" USING btree ("personal_space_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grants_read_expires_at" ON "personal_memory_grants" USING btree ("read_expires_at");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grants_status" ON "personal_memory_grants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grants_target_run_id" ON "personal_memory_grants" USING btree ("target_run_id");--> statement-breakpoint
CREATE INDEX "ix_personal_memory_grants_target_space_id" ON "personal_memory_grants" USING btree ("target_space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_personal_memory_grants_unique_active_consuming" ON "personal_memory_grants" USING btree ("granting_user_id","target_run_id") WHERE ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('consuming'::character varying)::text]));--> statement-breakpoint
CREATE INDEX "ix_code_patch_snapshots_expires_at" ON "code_patch_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_code_patch_snapshots_proposal_id" ON "code_patch_snapshots" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_code_patch_snapshots_project_folder_id" ON "code_patch_snapshots" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "official_plugin_enablements_plugin_space_idx" ON "official_plugin_enablements" USING btree ("plugin_id","space_id") WHERE (space_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "official_plugin_enablements_space_idx" ON "official_plugin_enablements" USING btree ("space_id") WHERE (space_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "official_plugin_enablements_space_unique" ON "official_plugin_enablements" USING btree ("plugin_id","space_id") WHERE ((space_id IS NOT NULL) AND (user_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "official_plugin_enablements_user_unique" ON "official_plugin_enablements" USING btree ("plugin_id","user_id") WHERE ((space_id IS NULL) AND (user_id IS NOT NULL));--> statement-breakpoint
CREATE INDEX "official_plugin_events_plugin_space_idx" ON "official_plugin_events" USING btree ("plugin_id","space_id","created_at" DESC NULLS FIRST) WHERE (space_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "official_plugin_events_space_idx" ON "official_plugin_events" USING btree ("space_id","created_at" DESC NULLS FIRST) WHERE (space_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "plugin_installs_status_idx" ON "plugin_installs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_migrations_plugin_id_idx" ON "plugin_migrations" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "ix_plan_node_dependencies_node" ON "plan_node_dependencies" USING btree ("space_id","node_id");--> statement-breakpoint
CREATE INDEX "ix_plan_node_dependencies_depends_on" ON "plan_node_dependencies" USING btree ("space_id","depends_on_node_id");--> statement-breakpoint
CREATE INDEX "ix_plan_node_runs_node" ON "plan_node_runs" USING btree ("space_id","plan_node_id");--> statement-breakpoint
CREATE INDEX "ix_plan_node_runs_run" ON "plan_node_runs" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_plan_nodes_space_version_status" ON "plan_nodes" USING btree ("space_id","plan_version_id","status");--> statement-breakpoint
CREATE INDEX "ix_plan_nodes_assigned_agent" ON "plan_nodes" USING btree ("space_id","assigned_agent_id");--> statement-breakpoint
CREATE INDEX "ix_plan_nodes_capability" ON "plan_nodes" USING btree ("space_id","capability_id");--> statement-breakpoint
CREATE INDEX "ix_plan_versions_space_status" ON "plan_versions" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_plan_versions_plan_id" ON "plan_versions" USING btree ("plan_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_plans_space_status_updated" ON "plans" USING btree ("space_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_plans_source_task_id" ON "plans" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX "ix_plans_root_run_id" ON "plans" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "ix_policies_created_from_proposal_id" ON "policies" USING btree ("created_from_proposal_id");--> statement-breakpoint
CREATE INDEX "ix_policies_domain" ON "policies" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "ix_policies_policy_key" ON "policies" USING btree ("policy_key");--> statement-breakpoint
CREATE INDEX "ix_policies_space_id" ON "policies" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_policies_status" ON "policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_policies_supersedes_policy_id" ON "policies" USING btree ("supersedes_policy_id");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_action" ON "policy_decision_records" USING btree ("action");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_actor_id" ON "policy_decision_records" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_audit_code" ON "policy_decision_records" USING btree ("audit_code");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_audit_created" ON "policy_decision_records" USING btree ("audit_code","created_at");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_created_at" ON "policy_decision_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_decision" ON "policy_decision_records" USING btree ("decision");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_proposal_created" ON "policy_decision_records" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_proposal_id" ON "policy_decision_records" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_resource_id" ON "policy_decision_records" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_resource_type" ON "policy_decision_records" USING btree ("resource_type");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_risk_level" ON "policy_decision_records" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_run_created" ON "policy_decision_records" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_run_id" ON "policy_decision_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_space_action_created" ON "policy_decision_records" USING btree ("space_id","action","created_at");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_space_created" ON "policy_decision_records" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_policy_decision_records_space_id" ON "policy_decision_records" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_prompt_deployment_refs_asset_label" ON "prompt_deployment_refs" USING btree ("asset_id","label");--> statement-breakpoint
CREATE INDEX "ix_prompt_deployment_refs_space_id" ON "prompt_deployment_refs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_prompt_deployment_refs_version_id" ON "prompt_deployment_refs" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompt_deployment_refs_active_scope_label" ON "prompt_deployment_refs" USING btree (COALESCE("space_id", ''),"asset_id","scope_type",COALESCE("scope_id", ''),"label") WHERE (status)::text = 'active'::text;--> statement-breakpoint
CREATE INDEX "ix_project_corpus_item_sources_source" ON "project_corpus_item_sources" USING btree ("space_id","project_id","source_item_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_added_by_user_id" ON "project_corpus_items" USING btree ("added_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_evidence_id" ON "project_corpus_items" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_object_id" ON "project_corpus_items" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_project_id" ON "project_corpus_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_project_role" ON "project_corpus_items" USING btree ("space_id","project_id","role");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_project_triage" ON "project_corpus_items" USING btree ("space_id","project_id","triage_status");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_source_connection_id" ON "project_corpus_items" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_source_decision_id" ON "project_corpus_items" USING btree ("source_decision_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_source_item_id" ON "project_corpus_items" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_space_id" ON "project_corpus_items" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_corpus_items_status" ON "project_corpus_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_corpus_items_project_evidence" ON "project_corpus_items" USING btree ("space_id","project_id","evidence_id") WHERE evidence_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_corpus_items_project_object" ON "project_corpus_items" USING btree ("space_id","project_id","object_id") WHERE object_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_corpus_items_project_source_item" ON "project_corpus_items" USING btree ("space_id","project_id","source_item_id") WHERE source_item_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_project_research_checkpoints_space_id" ON "project_research_checkpoints" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_checkpoints_project_id" ON "project_research_checkpoints" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_checkpoints_workflow_stage" ON "project_research_checkpoints" USING btree ("space_id","workflow_id","stage_key");--> statement-breakpoint
CREATE INDEX "ix_project_research_checkpoints_status" ON "project_research_checkpoints" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_project_research_claim_links_space_id" ON "project_research_claim_links" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_claim_links_project_id" ON "project_research_claim_links" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_claim_links_workflow_id" ON "project_research_claim_links" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_claim_links_project_claim" ON "project_research_claim_links" USING btree ("space_id","project_id","claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_question_assessment_messages_turn_role" ON "project_research_question_assessment_messages" USING btree ("session_id","turn_index","role");--> statement-breakpoint
CREATE INDEX "ix_project_research_question_assessment_messages_session" ON "project_research_question_assessment_messages" USING btree ("space_id","session_id","turn_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_question_assessment_sessions_thread" ON "project_research_question_assessment_sessions" USING btree ("space_id","thread_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_question_assessment_sessions_project" ON "project_research_question_assessment_sessions" USING btree ("space_id","project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_reports_synthesis_run" ON "project_research_reports" USING btree ("space_id","synthesis_run_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_reports_project_created" ON "project_research_reports" USING btree ("space_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_project_research_reports_workflow" ON "project_research_reports" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_screening_criteria_space_id" ON "project_research_screening_criteria" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_screening_criteria_project" ON "project_research_screening_criteria" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_standing_advice_project_status" ON "project_research_standing_advice" USING btree ("space_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_standing_batches_open_project" ON "project_research_standing_batches" USING btree ("space_id","project_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "ix_project_research_standing_batches_project_ready" ON "project_research_standing_batches" USING btree ("space_id","project_id","ready_at");--> statement-breakpoint
CREATE INDEX "ix_project_research_workflows_space_id" ON "project_research_workflows" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_research_workflows_project_status" ON "project_research_workflows" USING btree ("space_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_scan_summaries_workflow_scan" ON "research_scan_summaries" USING btree ("space_id","workflow_id","scan_key") WHERE workflow_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_scan_summaries_standing_scan" ON "research_scan_summaries" USING btree ("space_id","project_id","scan_key") WHERE workflow_id IS NULL;--> statement-breakpoint
CREATE INDEX "ix_research_scan_summaries_project_scanned_at" ON "research_scan_summaries" USING btree ("space_id","project_id","scanned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_project_research_context_versions_project_created" ON "project_research_context_versions" USING btree ("space_id","project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_research_context_versions_project_version" ON "project_research_context_versions" USING btree ("space_id","project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_query_attempts_plan_round_sequence" ON "research_query_attempts" USING btree ("provider_plan_id","round","sequence");--> statement-breakpoint
CREATE INDEX "ix_research_query_attempts_fingerprint" ON "research_query_attempts" USING btree ("space_id","query_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_query_performance_scan_strategy" ON "research_query_performance_observations" USING btree ("scan_summary_id","strategy_id");--> statement-breakpoint
CREATE INDEX "ix_research_query_performance_strategy_observed" ON "research_query_performance_observations" USING btree ("space_id","strategy_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_query_provider_plans_strategy_provider" ON "research_query_provider_plans" USING btree ("strategy_id","provider_key");--> statement-breakpoint
CREATE INDEX "ix_research_query_strategies_project_created" ON "research_query_strategies" USING btree ("space_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_research_query_strategies_operation" ON "research_query_strategies" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_query_strategies_context_version" ON "research_query_strategies" USING btree ("space_id","project_id","research_context_version_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_query_activation_sequence" ON "research_query_strategy_activations" USING btree ("space_id","project_id","research_context_version_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_query_activation_active" ON "research_query_strategy_activations" USING btree ("space_id","project_id","research_context_version_id") WHERE deactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_research_query_activation_strategy" ON "research_query_strategy_activations" USING btree ("space_id","strategy_id");--> statement-breakpoint
CREATE INDEX "ix_research_checklist_items_project_order" ON "research_checklist_items" USING btree ("space_id","project_id","sort_order");--> statement-breakpoint
CREATE INDEX "ix_research_evidence_cards_project" ON "research_evidence_cards" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_research_integrity_alerts_project_detected" ON "research_integrity_alerts" USING btree ("space_id","project_id","detected_at");--> statement-breakpoint
CREATE INDEX "ix_project_source_bindings_created_by_user_id" ON "project_source_bindings" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_bindings_project_id" ON "project_source_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_bindings_source_channel_id" ON "project_source_bindings" USING btree ("source_channel_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_bindings_space_id" ON "project_source_bindings" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_bindings_status" ON "project_source_bindings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_binding_id" ON "project_source_item_links" USING btree ("project_source_binding_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_matched_at" ON "project_source_item_links" USING btree ("matched_at");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_project_id" ON "project_source_item_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_source_channel_id" ON "project_source_item_links" USING btree ("source_channel_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_source_connection_id" ON "project_source_item_links" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_source_item_id" ON "project_source_item_links" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_project_source_item_links_status" ON "project_source_item_links" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_project_operation_links_target" ON "project_operation_links" USING btree ("space_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "ix_project_operations_project_status" ON "project_operations" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_operations_active_research_workflow" ON "project_operations" USING btree ("space_id",(progress_json->>'workflow_id')) WHERE kind = 'research' AND status IN ('active', 'waiting_review') AND progress_json->>'workflow_id' IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_attention_user_states_scope" ON "project_attention_user_states" USING btree ("user_id","project_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "ix_project_attention_user_states_project_id" ON "project_attention_user_states" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_brief_versions_project_id" ON "project_brief_versions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_brief_versions_space_id" ON "project_brief_versions" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_brief_versions_project_version" ON "project_brief_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "ix_project_instruction_versions_project_id" ON "project_instruction_versions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_instruction_versions_project_version" ON "project_instruction_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_project_members_project_user_unique" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_project_members_space_id" ON "project_members" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_members_user_id" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_project_public_summaries_project_unique" ON "project_public_summaries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_public_summaries_review_status" ON "project_public_summaries" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "ix_project_public_summaries_space_id" ON "project_public_summaries" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_projects_owner_user_id" ON "projects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_projects_space_id" ON "projects" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_projects_status" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_projects_focus_area_id" ON "projects" USING btree ("focus_area_id") WHERE focus_area_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_projects_space_name_active" ON "projects" USING btree ("space_id","name") WHERE ((status)::text = 'active'::text);--> statement-breakpoint
CREATE INDEX "ix_project_work_events_project_occurred" ON "project_work_events" USING btree ("space_id","project_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_project_work_events_subject" ON "project_work_events" USING btree ("space_id","subject_type","subject_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_project_work_events_kind" ON "project_work_events" USING btree ("space_id","event_kind","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_project_work_events_correlation" ON "project_work_events" USING btree ("correlation_id") WHERE correlation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_project_work_events_undo_of" ON "project_work_events" USING btree ("space_id",(data_json->>'undo_of_event_id')) WHERE (data_json->>'undo_of_event_id') IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_work_events_idempotency" ON "project_work_events" USING btree ("space_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_task_loop_states_project" ON "task_loop_states" USING btree ("space_id","project_id");--> statement-breakpoint
CREATE INDEX "ix_task_loop_states_stage" ON "task_loop_states" USING btree ("space_id","project_id","current_stage_key");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_approval_type" ON "proposal_approvals" USING btree ("approval_type");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_approver_user_id" ON "proposal_approvals" USING btree ("approver_user_id");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_created_at" ON "proposal_approvals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_grant_id" ON "proposal_approvals" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_action_grant_id" ON "proposal_approvals" USING btree ("action_grant_id");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_proposal_id" ON "proposal_approvals" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_proposal_approvals_target_space_id" ON "proposal_approvals" USING btree ("target_space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_proposal_approvals_unique_active" ON "proposal_approvals" USING btree ("proposal_id","approval_type","approver_user_id","grant_id") WHERE ((status)::text = 'approved'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposal_approvals_taint_owner" ON "proposal_approvals" USING btree ("proposal_id","approval_type","approver_user_id") WHERE status = 'approved' AND grant_id IS NULL AND approval_type = 'egress_granting_user';--> statement-breakpoint
CREATE UNIQUE INDEX "ix_proposal_approvals_unique_action_grant" ON "proposal_approvals" USING btree ("proposal_id","action_grant_id") WHERE status = 'approved' AND action_grant_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_proposals_created_by_run_id" ON "proposals" USING btree ("created_by_run_id");--> statement-breakpoint
CREATE INDEX "ix_proposals_owner_user_id" ON "proposals" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_proposals_project_id" ON "proposals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_proposals_proposal_type" ON "proposals" USING btree ("proposal_type");--> statement-breakpoint
CREATE INDEX "ix_proposals_risk_level" ON "proposals" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX "ix_proposals_space_id" ON "proposals" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_proposals_status" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_proposals_urgency" ON "proposals" USING btree ("urgency");--> statement-breakpoint
CREATE INDEX "ix_proposals_project_folder_id" ON "proposals" USING btree ("project_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposals_run_action_idempotency" ON "proposals" USING btree ("created_by_run_id","proposal_type","action_idempotency_key") WHERE action_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proposals_pending_research_query_strategy" ON "proposals" USING btree ("space_id","project_id","proposal_type") WHERE status='pending' AND proposal_type='research_query_strategy_activation';--> statement-breakpoint
CREATE INDEX "ix_credentials_owner_user_id" ON "credentials" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_credentials_space_id" ON "credentials" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_model_provider_credentials_provider_id" ON "model_provider_credentials" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "ix_model_provider_credentials_space_id" ON "model_provider_credentials" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_model_provider_space_grants_network_profile_id" ON "model_provider_space_grants" USING btree ("network_profile_id");--> statement-breakpoint
CREATE INDEX "ix_model_provider_space_grants_owner_user_id" ON "model_provider_space_grants" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_model_provider_space_grants_space_id" ON "model_provider_space_grants" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_model_providers_credential_id" ON "model_providers" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "ix_model_providers_network_profile_id" ON "model_providers" USING btree ("network_profile_id");--> statement-breakpoint
CREATE INDEX "ix_model_providers_owner_user_id" ON "model_providers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_model_providers_space_id" ON "model_providers" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_network_profiles_space_id" ON "network_profiles" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_provider_task_policies_space_id" ON "provider_task_policies" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_relation_identities_object_id" ON "relation_identities" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "ix_relation_identities_space_id" ON "relation_identities" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_relation_identities_id_type" ON "relation_identities" USING btree ("id_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_relation_identities_object_type_value" ON "relation_identities" USING btree ("space_id","object_id","id_type","id_value");--> statement-breakpoint
CREATE INDEX "ix_relation_notes_object_id" ON "relation_notes" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "ix_relation_notes_space_id" ON "relation_notes" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_relation_organizations_space_id" ON "relation_organizations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_relation_organizations_status" ON "relation_organizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_relation_organizations_parent" ON "relation_organizations" USING btree ("parent_organization_object_id");--> statement-breakpoint
CREATE INDEX "ix_relation_people_space_id" ON "relation_people" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_relation_people_status" ON "relation_people" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_relation_source_links_object_id" ON "relation_source_links" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "ix_relation_source_links_space_id" ON "relation_source_links" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_relation_source_links_activity_id" ON "relation_source_links" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "ix_relation_source_links_source_item_id" ON "relation_source_links" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_relation_source_links_evidence_id" ON "relation_source_links" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "ix_route_decisions_space_created" ON "route_decisions" USING btree ("space_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_route_decisions_selected_profile" ON "route_decisions" USING btree ("selected_runtime_profile_id");--> statement-breakpoint
CREATE INDEX "ix_room_agent_access_grants_grantee" ON "room_agent_access_grants" USING btree ("space_id","grantee_user_id","room_id");--> statement-breakpoint
CREATE INDEX "ix_room_agent_access_grants_agent" ON "room_agent_access_grants" USING btree ("space_id","agent_id","room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_agent_access_grants_active" ON "room_agent_access_grants" USING btree ("room_id","agent_id","grantee_user_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_room_agent_members_agent" ON "room_agent_members" USING btree ("space_id","agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_agent_members_manager" ON "room_agent_members" USING btree ("room_id") WHERE role = 'manager' AND status = 'active';--> statement-breakpoint
CREATE INDEX "ix_room_invitation_agent_approvals_owner" ON "room_invitation_agent_approvals" USING btree ("space_id","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_room_user_invitations_invitee" ON "room_user_invitations" USING btree ("space_id","invitee_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_room_user_invitations_room" ON "room_user_invitations" USING btree ("space_id","room_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_user_invitations_pending" ON "room_user_invitations" USING btree ("room_id","invitee_user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "ix_room_user_members_user" ON "room_user_members" USING btree ("space_id","user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_user_members_owner" ON "room_user_members" USING btree ("room_id") WHERE role = 'owner' AND status = 'active';--> statement-breakpoint
CREATE INDEX "ix_rooms_project_updated" ON "rooms" USING btree ("space_id","project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rooms_mainline_per_project" ON "rooms" USING btree ("space_id","project_id") WHERE is_mainline AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rooms_personal_per_project" ON "rooms" USING btree ("space_id","project_id","personal_for_user_id") WHERE personal_for_user_id IS NOT NULL AND status = 'active';--> statement-breakpoint
CREATE INDEX "ix_rooms_space_updated" ON "rooms" USING btree ("space_id","updated_at");--> statement-breakpoint
CREATE INDEX "ix_room_conversation_summary_states_due" ON "room_conversation_summary_states" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_conversation_summary_versions_active" ON "room_conversation_summary_versions" USING btree ("session_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ix_room_conversation_summary_versions_room_created" ON "room_conversation_summary_versions" USING btree ("space_id","room_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_room_creation_idempotency_room" ON "room_creation_idempotencies" USING btree ("space_id","room_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_aliases_normalized_alias" ON "retrieval_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "ix_retrieval_aliases_object" ON "retrieval_aliases" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_aliases_space_id" ON "retrieval_aliases" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_retrieval_aliases_unique" ON "retrieval_aliases" USING btree ("space_id","object_type","object_id","normalized_alias","alias_kind");--> statement-breakpoint
CREATE INDEX "ix_retrieval_chunks_embedding_filter" ON "retrieval_chunks" USING btree ("space_id","object_type","embedding_dimensions") WHERE (embedding IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_retrieval_chunks_embedding_hnsw_2560" ON "retrieval_chunks" USING hnsw ((embedding::halfvec(2560)) halfvec_cosine_ops) WHERE ((embedding IS NOT NULL) AND (embedding_dimensions = 2560));--> statement-breakpoint
CREATE INDEX "ix_retrieval_chunks_embedding_pending" ON "retrieval_chunks" USING btree ("space_id","embedding_claimed_at","created_at","id") WHERE (embedding IS NULL);--> statement-breakpoint
CREATE INDEX "ix_retrieval_chunks_object" ON "retrieval_chunks" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_retrieval_chunks_object_chunk_unique" ON "retrieval_chunks" USING btree ("retrieval_object_id","chunk_index");--> statement-breakpoint
CREATE INDEX "ix_retrieval_chunks_space_id" ON "retrieval_chunks" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_chunks_tsv" ON "retrieval_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "ix_retrieval_edges_from" ON "retrieval_edges" USING btree ("from_object_type","from_object_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_edges_space_id" ON "retrieval_edges" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_edges_to" ON "retrieval_edges" USING btree ("to_object_type","to_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_retrieval_edges_unique" ON "retrieval_edges" USING btree ("space_id","from_object_type","from_object_id","to_object_type","to_object_id","link_type","edge_origin");--> statement-breakpoint
CREATE INDEX "ix_retrieval_feedback_events_lookup" ON "retrieval_feedback_events" USING btree ("space_id","actor_user_id","surface","query_hash","object_type","object_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_retrieval_feedback_events_object" ON "retrieval_feedback_events" USING btree ("space_id","object_type","object_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_retrieval_feedback_events_space_created" ON "retrieval_feedback_events" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_retrieval_objects_object" ON "retrieval_objects" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_objects_source_connections" ON "retrieval_objects" USING gin ("source_connection_ids_json");--> statement-breakpoint
CREATE INDEX "ix_retrieval_objects_space_id" ON "retrieval_objects" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_retrieval_objects_space_object_unique" ON "retrieval_objects" USING btree ("space_id","object_type","object_id");--> statement-breakpoint
CREATE INDEX "ix_retrieval_objects_status" ON "retrieval_objects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_external_run_records_run_id" ON "external_run_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_external_run_records_runtime_adapter_type" ON "external_run_records" USING btree ("runtime_adapter_type");--> statement-breakpoint
CREATE INDEX "ix_external_run_records_space_id" ON "external_run_records" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_run_attempts_run_status" ON "run_attempts" USING btree ("space_id","run_id","status");--> statement-breakpoint
CREATE INDEX "ix_run_attempts_activity" ON "run_attempts" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE INDEX "ix_run_evaluations_evaluated_at" ON "run_evaluations" USING btree ("evaluated_at");--> statement-breakpoint
CREATE INDEX "ix_run_evaluations_evaluator_version" ON "run_evaluations" USING btree ("evaluator_version");--> statement-breakpoint
CREATE INDEX "ix_run_evaluations_run_id" ON "run_evaluations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_run_evaluations_run_id_evaluated_at" ON "run_evaluations" USING btree ("run_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "ix_run_evaluations_space_id" ON "run_evaluations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_actor_id" ON "run_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_artifact_id" ON "run_events" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_created_at" ON "run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_run_events_error_code" ON "run_events" USING btree ("error_code");--> statement-breakpoint
CREATE INDEX "ix_run_events_event_type" ON "run_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "ix_run_events_proposal_id" ON "run_events" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_run_id" ON "run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_space_id" ON "run_events" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_status" ON "run_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_run_events_step_id" ON "run_events" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "ix_run_events_project_folder_id" ON "run_events" USING btree ("project_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_events_chat_completed" ON "run_events" USING btree ("space_id","run_id") WHERE event_type = 'chat_completed';--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_finalized_at" ON "run_finalizations" USING btree ("finalized_at");--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_run_evaluation_id" ON "run_finalizations" USING btree ("run_evaluation_id");--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_run_id" ON "run_finalizations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_space_id" ON "run_finalizations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_run_finalizations_task_evaluation_id" ON "run_finalizations" USING btree ("task_evaluation_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_actor_id" ON "run_steps" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_artifact_id" ON "run_steps" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_parent_step_id" ON "run_steps" USING btree ("parent_step_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_proposal_id" ON "run_steps" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_run_id" ON "run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_session_id" ON "run_steps" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_space_id" ON "run_steps" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_space_run_index" ON "run_steps" USING btree ("space_id","run_id","step_index");--> statement-breakpoint
CREATE INDEX "ix_run_steps_status" ON "run_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_run_steps_step_type" ON "run_steps" USING btree ("step_type");--> statement-breakpoint
CREATE INDEX "ix_run_steps_task_id" ON "run_steps" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_run_steps_project_folder_id" ON "run_steps" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_run_supervisor_decisions_run" ON "run_supervisor_decisions" USING btree ("space_id","run_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_runs_agent_id" ON "runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_runs_agent_version_id" ON "runs" USING btree ("agent_version_id");--> statement-breakpoint
CREATE INDEX "ix_runs_delegation_id" ON "runs" USING btree ("space_id","delegation_id");--> statement-breakpoint
CREATE INDEX "ix_runs_group_id" ON "runs" USING btree ("space_id","run_group_id");--> statement-breakpoint
CREATE INDEX "ix_runs_instructed_by_agent_id" ON "runs" USING btree ("space_id","instructed_by_agent_id");--> statement-breakpoint
CREATE INDEX "ix_runs_instructed_by_user_id" ON "runs" USING btree ("instructed_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_runs_mode" ON "runs" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "ix_runs_model_provider_id" ON "runs" USING btree ("model_provider_id");--> statement-breakpoint
CREATE INDEX "ix_runs_owner_user_id" ON "runs" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_runs_parent_run_id" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "ix_runs_parent_run_space" ON "runs" USING btree ("space_id","parent_run_id");--> statement-breakpoint
CREATE INDEX "ix_runs_project_id" ON "runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_runs_root_run_id" ON "runs" USING btree ("space_id","root_run_id");--> statement-breakpoint
CREATE INDEX "ix_runs_run_type" ON "runs" USING btree ("run_type");--> statement-breakpoint
CREATE INDEX "ix_runs_requested_runtime_profile_id" ON "runs" USING btree ("requested_runtime_profile_id");--> statement-breakpoint
CREATE INDEX "ix_runs_runtime_profile_id" ON "runs" USING btree ("runtime_profile_id");--> statement-breakpoint
CREATE INDEX "ix_runs_route_decision_id" ON "runs" USING btree ("route_decision_id");--> statement-breakpoint
CREATE INDEX "ix_runs_session_id" ON "runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_runs_space_id" ON "runs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_runs_trigger_origin" ON "runs" USING btree ("trigger_origin");--> statement-breakpoint
CREATE INDEX "ix_runs_project_folder_id" ON "runs" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_runs_workspace_location_id" ON "runs" USING btree ("workspace_location_id");--> statement-breakpoint
CREATE INDEX "ix_runs_host_task_thread_id" ON "runs" USING btree ("host_task_thread_id");--> statement-breakpoint
CREATE INDEX "ix_task_evaluations_run_evaluation_id" ON "task_evaluations" USING btree ("run_evaluation_id");--> statement-breakpoint
CREATE INDEX "ix_task_evaluations_run_id" ON "task_evaluations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_task_evaluations_space_id" ON "task_evaluations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_task_evaluations_task_id" ON "task_evaluations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_task_runs_run_id" ON "task_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_task_runs_space_id" ON "task_runs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_task_runs_task_id" ON "task_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_verification_results_run_id" ON "verification_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_verification_results_space_id" ON "verification_results" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_verification_results_status" ON "verification_results" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_verification_results_run_status" ON "verification_results" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "ix_run_artifact_declarations_run_id" ON "run_artifact_declarations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_run_artifact_declarations_task_id" ON "run_artifact_declarations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_run_artifact_declarations_space_id" ON "run_artifact_declarations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_run_tool_identities_space_id" ON "run_tool_identities" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_runtime_tool_bindings_agent_id" ON "runtime_tool_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_runtime_tool_bindings_capability_id" ON "runtime_tool_bindings" USING btree ("capability_id");--> statement-breakpoint
CREATE INDEX "ix_runtime_tool_bindings_enabled" ON "runtime_tool_bindings" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "ix_runtime_tool_bindings_runtime_adapter_type" ON "runtime_tool_bindings" USING btree ("runtime_adapter_type");--> statement-breakpoint
CREATE INDEX "ix_runtime_tool_bindings_space_id" ON "runtime_tool_bindings" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_runtime_tool_bindings_project_folder_id" ON "runtime_tool_bindings" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_space_runtime_tool_policies_runtime" ON "space_runtime_tool_policies" USING btree ("runtime");--> statement-breakpoint
CREATE INDEX "ix_space_runtime_tool_policies_space_id" ON "space_runtime_tool_policies" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_space_runtime_tool_policies_updated_by_user_id" ON "space_runtime_tool_policies" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_scheduler_tasks_due" ON "scheduler_tasks" USING btree ("task_type","status","next_run_at");--> statement-breakpoint
CREATE INDEX "ix_scheduler_tasks_space_id" ON "scheduler_tasks" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_scheduler_tasks_user_id" ON "scheduler_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_messages_session_id" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_messages_space_session_created" ON "messages" USING btree ("space_id","session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ix_messages_space_id" ON "messages" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_messages_user_id" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_messages_sender_agent_id" ON "messages" USING btree ("sender_agent_id");--> statement-breakpoint
CREATE INDEX "ix_messages_external_reference" ON "messages" USING btree ("space_id","session_id") WHERE metadata_json->'reference'->>'trust' = 'external_untrusted';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_assistant_run" ON "messages" USING btree ("space_id","run_id") WHERE role = 'assistant' AND run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_messages_parent_message_id" ON "messages" USING btree ("space_id","parent_message_id");--> statement-breakpoint
CREATE INDEX "ix_messages_session_path" ON "messages" USING btree ("space_id","session_id","path_depth","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_branch_position" ON "messages" USING btree ("space_id","session_id","branch_path","path_depth");--> statement-breakpoint
CREATE INDEX "ix_messages_run_id" ON "messages" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_session_conversation_backends_space_id" ON "session_conversation_backends" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_session_conversation_backends_runtime_profile_id" ON "session_conversation_backends" USING btree ("runtime_profile_id");--> statement-breakpoint
CREATE INDEX "ix_session_conversation_backends_credential_profile_id" ON "session_conversation_backends" USING btree ("credential_profile_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_agent_id" ON "sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_space_id" ON "sessions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_status" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_project_folder_id" ON "sessions" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_project_id" ON "sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_room_id" ON "sessions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_head_message_id" ON "sessions" USING btree ("space_id","head_message_id");--> statement-breakpoint
CREATE INDEX "ix_conversation_execution_contexts_space_id" ON "conversation_execution_contexts" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_conversation_execution_contexts_host_id" ON "conversation_execution_contexts" USING btree ("execution_host_id");--> statement-breakpoint
CREATE INDEX "ix_conversation_folder_access_grants_session" ON "conversation_folder_access_grants" USING btree ("space_id","session_id","status");--> statement-breakpoint
CREATE INDEX "ix_conversation_folder_access_grants_folder" ON "conversation_folder_access_grants" USING btree ("space_id","project_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_folder_access_grants_active" ON "conversation_folder_access_grants" USING btree ("session_id","project_folder_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ix_settings_key" ON "settings" USING btree ("settings_key");--> statement-breakpoint
CREATE INDEX "ix_settings_scope" ON "settings" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "ix_content_publication_imports_resource" ON "content_publication_imports" USING btree ("target_space_id","imported_resource_type","imported_resource_id");--> statement-breakpoint
CREATE INDEX "ix_content_publication_targets_space" ON "content_publication_targets" USING btree ("target_space_id");--> statement-breakpoint
CREATE INDEX "ix_content_publications_source" ON "content_publications" USING btree ("source_space_id","source_resource_type","source_resource_id");--> statement-breakpoint
CREATE INDEX "ix_content_publications_status" ON "content_publications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_connection_id" ON "extraction_jobs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_source_item_id" ON "extraction_jobs" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_source_object" ON "extraction_jobs" USING btree ("space_id","source_object_type","source_object_id");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_source_object_id" ON "extraction_jobs" USING btree ("source_object_id");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_source_object_type" ON "extraction_jobs" USING btree ("source_object_type");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_source_snapshot_id" ON "extraction_jobs" USING btree ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_space_created" ON "extraction_jobs" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_space_id" ON "extraction_jobs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_space_status" ON "extraction_jobs" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_extraction_jobs_status" ON "extraction_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_reader_annotations_space_document" ON "reader_annotations" USING btree ("space_id","document_type","document_id","status");--> statement-breakpoint
CREATE INDEX "ix_reader_annotations_space_user" ON "reader_annotations" USING btree ("space_id","created_by_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_reader_annotations_owner_user_id" ON "reader_annotations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_reader_annotations_project_id" ON "reader_annotations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_reader_annotations_space_visibility" ON "reader_annotations" USING btree ("space_id","visibility","status");--> statement-breakpoint
CREATE INDEX "ix_reader_comment_threads_space_annotation" ON "reader_comment_threads" USING btree ("space_id","annotation_id","status");--> statement-breakpoint
CREATE INDEX "ix_reader_comment_threads_space_user" ON "reader_comment_threads" USING btree ("space_id","created_by_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_reader_comments_space_thread" ON "reader_comments" USING btree ("space_id","thread_id","status");--> statement-breakpoint
CREATE INDEX "ix_reader_comments_space_user" ON "reader_comments" USING btree ("space_id","created_by_user_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_connections_active_handler_version_id" ON "source_connections" USING btree ("active_handler_version_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_active_recipe_version_id" ON "source_connections" USING btree ("active_recipe_version_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_provider_connector_id" ON "source_connections" USING btree ("provider_connector_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_credential_id" ON "source_connections" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_deleted_at" ON "source_connections" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "ix_source_connections_owner_user_id" ON "source_connections" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_project_id" ON "source_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_space_id" ON "source_connections" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_source_connections_space_status" ON "source_connections" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_connections_status" ON "source_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_source_connections_visibility" ON "source_connections" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_connections_active_owner_mapping_personal" ON "source_connections" USING btree ("space_id","owner_user_id","provider_connector_id","name") WHERE deleted_at IS NULL AND status <> 'archived' AND project_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_connections_active_owner_mapping_project" ON "source_connections" USING btree ("space_id","project_id","owner_user_id","provider_connector_id","name") WHERE deleted_at IS NULL AND status <> 'archived' AND project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_handler_runs_handler_version_id" ON "source_handler_runs" USING btree ("handler_version_id");--> statement-breakpoint
CREATE INDEX "ix_source_handler_runs_source_connection_id" ON "source_handler_runs" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "ix_source_handler_runs_space_id" ON "source_handler_runs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_source_handler_runs_status" ON "source_handler_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_source_handler_versions_source_connection_id" ON "source_handler_versions" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "ix_source_handler_versions_space_id" ON "source_handler_versions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_source_handler_versions_status" ON "source_handler_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_source_item_user_states_item_user" ON "source_item_user_states" USING btree ("source_item_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_source_item_user_states_user_status" ON "source_item_user_states" USING btree ("space_id","user_id","library_status","read_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_item_user_states_space_item_user" ON "source_item_user_states" USING btree ("space_id","source_item_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_canonical_uri" ON "source_items" USING btree ("space_id","canonical_uri");--> statement-breakpoint
CREATE INDEX "ix_source_items_connection_id" ON "source_items" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_content_hash" ON "source_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "ix_source_items_created_by_user_id" ON "source_items" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_deleted_at" ON "source_items" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "ix_source_items_extracted_artifact_id" ON "source_items" USING btree ("extracted_artifact_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_item_type" ON "source_items" USING btree ("item_type");--> statement-breakpoint
CREATE INDEX "ix_source_items_occurred_at" ON "source_items" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ix_source_items_owner_user_id" ON "source_items" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_project_id" ON "source_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_raw_artifact_id" ON "source_items" USING btree ("raw_artifact_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_source_domain" ON "source_items" USING btree ("source_domain");--> statement-breakpoint
CREATE INDEX "ix_source_items_source_external_id" ON "source_items" USING btree ("source_external_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_source_object" ON "source_items" USING btree ("space_id","source_object_type","source_object_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_source_object_id" ON "source_items" USING btree ("source_object_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_source_object_type" ON "source_items" USING btree ("source_object_type");--> statement-breakpoint
CREATE INDEX "ix_source_items_space_connection" ON "source_items" USING btree ("space_id","connection_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_space_created_by_user_id" ON "source_items" USING btree ("space_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_space_domain" ON "source_items" USING btree ("space_id","source_domain");--> statement-breakpoint
CREATE INDEX "ix_source_items_space_id" ON "source_items" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_summary_artifact_id" ON "source_items" USING btree ("summary_artifact_id");--> statement-breakpoint
CREATE INDEX "ix_source_items_visibility" ON "source_items" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_canonical_uri_personal" ON "source_items" USING btree ("space_id","canonical_uri") WHERE canonical_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_canonical_uri_project" ON "source_items" USING btree ("space_id","project_id","canonical_uri") WHERE canonical_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_source_uri_personal" ON "source_items" USING btree ("space_id","source_uri") WHERE source_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_source_uri_project" ON "source_items" USING btree ("space_id","project_id","source_uri") WHERE source_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_item_decisions_connection_review" ON "source_post_processing_item_decisions" USING btree ("space_id","source_channel_id","review_status","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_item_decisions_item" ON "source_post_processing_item_decisions" USING btree ("space_id","source_item_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_item_decisions_question_version" ON "source_post_processing_item_decisions" USING btree ("space_id","project_id","research_question_version" DESC NULLS FIRST,"source_item_id");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_item_decisions_project_review" ON "source_post_processing_item_decisions" USING btree ("space_id","project_id","review_status","relevance","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_item_decisions_rule_run" ON "source_post_processing_item_decisions" USING btree ("space_id","rule_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_post_processing_item_decisions_run_item" ON "source_post_processing_item_decisions" USING btree ("space_id","run_id","source_item_id");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_rules_agent_id" ON "source_post_processing_rules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_rules_project_id" ON "source_post_processing_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_rules_source_status" ON "source_post_processing_rules" USING btree ("space_id","source_channel_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_rules_trigger_status" ON "source_post_processing_rules" USING btree ("space_id","trigger_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_post_processing_rules_active_name" ON "source_post_processing_rules" USING btree ("space_id","source_channel_id","project_id","name") WHERE ((status)::text <> 'archived'::text);--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_runs_agent_run_id" ON "source_post_processing_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_runs_rule_created" ON "source_post_processing_runs" USING btree ("space_id","rule_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_runs_source_created" ON "source_post_processing_runs" USING btree ("space_id","source_channel_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_runs_status" ON "source_post_processing_runs" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_post_processing_runs_research_reconciliation" ON "source_post_processing_runs" USING btree ("space_id","status","research_reconciled_at","created_at");--> statement-breakpoint
CREATE INDEX "ix_source_recipe_versions_connection" ON "source_recipe_versions" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "ix_source_recipe_versions_space_id" ON "source_recipe_versions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_artifact_id" ON "source_snapshots" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_connection_id" ON "source_snapshots" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_content_hash" ON "source_snapshots" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_owner_user_id" ON "source_snapshots" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_project_id" ON "source_snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_snapshot_type" ON "source_snapshots" USING btree ("snapshot_type");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_source_item_id" ON "source_snapshots" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_space_id" ON "source_snapshots" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_space_item" ON "source_snapshots" USING btree ("space_id","source_item_id");--> statement-breakpoint
CREATE INDEX "ix_source_snapshots_visibility" ON "source_snapshots" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_source_connectors_connector_key" ON "source_connectors" USING btree ("connector_key");--> statement-breakpoint
CREATE INDEX "ix_source_connectors_connector_type" ON "source_connectors" USING btree ("connector_type");--> statement-breakpoint
CREATE INDEX "ix_source_connectors_status" ON "source_connectors" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_source_provider_connectors_provider_status" ON "source_provider_connectors" USING btree ("provider_id","status","priority");--> statement-breakpoint
CREATE INDEX "ix_source_provider_connectors_connector_status" ON "source_provider_connectors" USING btree ("connector_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_source_providers_provider_key" ON "source_providers" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX "ix_source_providers_status" ON "source_providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_source_providers_category" ON "source_providers" USING btree ("category");--> statement-breakpoint
CREATE INDEX "ix_source_channel_item_links_channel" ON "source_channel_item_links" USING btree ("source_channel_id");--> statement-breakpoint
CREATE INDEX "ix_source_channel_item_links_item" ON "source_channel_item_links" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ix_source_channel_item_links_status" ON "source_channel_item_links" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_channel_user_subscriptions_channel_status" ON "source_channel_user_subscriptions" USING btree ("space_id","source_channel_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_channel_user_subscriptions_user_status" ON "source_channel_user_subscriptions" USING btree ("space_id","user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_channel_user_subscriptions_space_channel_user" ON "source_channel_user_subscriptions" USING btree ("space_id","source_channel_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_source_channels_space_status" ON "source_channels" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_channels_connection_status" ON "source_channels" USING btree ("source_connection_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_channels_fingerprint" ON "source_channels" USING btree ("space_id","query_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_channels_active_fingerprint" ON "source_channels" USING btree ("space_id","source_connection_id","query_fingerprint") WHERE status <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_search_specs_channel" ON "source_search_specs" USING btree ("source_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_search_specs_attempt" ON "source_search_specs" USING btree ("research_query_attempt_id") WHERE research_query_attempt_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_item_annotations_pending" ON "source_item_annotations" USING btree ("space_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_source_item_annotations_domain" ON "source_item_annotations" USING btree ("space_id","domain_key");--> statement-breakpoint
CREATE INDEX "ix_source_item_annotations_stance" ON "source_item_annotations" USING btree ("space_id","stance_target_key","stance_polarity");--> statement-breakpoint
CREATE INDEX "ix_source_backfill_plans_channel_status" ON "source_backfill_plans" USING btree ("source_channel_id","status");--> statement-breakpoint
CREATE INDEX "ix_source_backfill_segments_ready" ON "source_backfill_segments" USING btree ("space_id","status","next_eligible_at");--> statement-breakpoint
CREATE INDEX "ix_space_invitations_space_id" ON "space_invitations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_space_invitations_status" ON "space_invitations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_space_memberships_space_id" ON "space_memberships" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_space_memberships_user_id" ON "space_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_board_columns_board_id" ON "board_columns" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "ix_board_columns_space_id" ON "board_columns" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_boards_project_id" ON "boards" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_boards_space_id" ON "boards" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_boards_project_folder_id" ON "boards" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_task_artifacts_artifact_id" ON "task_artifacts" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "ix_task_artifacts_run_id" ON "task_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_task_artifacts_space_id" ON "task_artifacts" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_task_artifacts_task_id" ON "task_artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_task_dependencies_depends_on_task_id" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "ix_task_dependencies_space_id" ON "task_dependencies" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_task_dependencies_task_id" ON "task_dependencies" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_task_entity_links_task" ON "task_entity_links" USING btree ("space_id","task_id");--> statement-breakpoint
CREATE INDEX "ix_task_entity_links_entity" ON "task_entity_links" USING btree ("space_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ix_task_proposals_proposal_id" ON "task_proposals" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "ix_task_proposals_space_id" ON "task_proposals" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_task_proposals_task_id" ON "task_proposals" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_board_id" ON "tasks" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_column_id" ON "tasks" USING btree ("column_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_parent_task_id" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_role" ON "tasks" USING btree ("space_id","task_role");--> statement-breakpoint
CREATE INDEX "ix_tasks_owner_user_id" ON "tasks" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_project_id" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_space_id" ON "tasks" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_project_folder_id" ON "tasks" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_validation_recipes_enabled" ON "validation_recipes" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "ix_validation_recipes_space_id" ON "validation_recipes" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_validation_recipes_task_type" ON "validation_recipes" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX "ix_validation_recipes_project_folder_id" ON "validation_recipes" USING btree ("project_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cli_usage_import_cursors_scope" ON "cli_usage_import_cursors" USING btree ("instance_id","space_id",COALESCE(user_id, '__none__'::character varying),"runtime",COALESCE(credential_profile_id, '__none__'::character varying),"source_fingerprint");--> statement-breakpoint
CREATE INDEX "ix_cli_usage_import_cursors_space_runtime" ON "cli_usage_import_cursors" USING btree ("space_id","runtime");--> statement-breakpoint
CREATE INDEX "ix_cli_usage_import_cursors_credential_profile" ON "cli_usage_import_cursors" USING btree ("credential_profile_id");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_space_occurred" ON "token_usage_events" USING btree ("space_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_instance_occurred" ON "token_usage_events" USING btree ("instance_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_provider_model" ON "token_usage_events" USING btree ("space_id","provider_id","model","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_channel_adapter" ON "token_usage_events" USING btree ("space_id","execution_channel","adapter_type","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_session" ON "token_usage_events" USING btree ("space_id","session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_external_session" ON "token_usage_events" USING btree ("space_id","external_session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_run_id" ON "token_usage_events" USING btree ("space_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_owner_occurred" ON "token_usage_events" USING btree ("space_id","owner_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_visibility_occurred" ON "token_usage_events" USING btree ("space_id","visibility","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_source_resource" ON "token_usage_events" USING btree ("space_id","source_resource_type","source_resource_id");--> statement-breakpoint
CREATE INDEX "ix_token_usage_events_import_batch_id" ON "token_usage_events" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "ix_usage_import_batches_instance_id" ON "usage_import_batches" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "ix_usage_import_batches_target_space_id" ON "usage_import_batches" USING btree ("target_space_id");--> statement-breakpoint
CREATE INDEX "ix_usage_import_batches_owner_user_id" ON "usage_import_batches" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_machines_owner_user_id" ON "machines" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_hosts_owner_user_id" ON "hosts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ix_hosts_status" ON "hosts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_hosts_machine_id" ON "hosts" USING btree ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hosts_single_server" ON "hosts" USING btree ("kind") WHERE kind = 'server';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hosts_owner_name" ON "hosts" USING btree ("owner_user_id","name") WHERE owner_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_host_threads_workspace_location_id" ON "host_threads" USING btree ("workspace_location_id");--> statement-breakpoint
CREATE INDEX "ix_host_threads_workspace_mode" ON "host_threads" USING btree ("workspace_mode");--> statement-breakpoint
CREATE INDEX "ix_host_threads_session_id" ON "host_threads" USING btree ("space_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_host_threads_conversation_agent_active" ON "host_threads" USING btree ("session_id","agent_id") WHERE container_kind = 'conversation' AND status IN ('active', 'session_reset') AND session_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_host_threads_direct_agent_user_active" ON "host_threads" USING btree ("agent_id","container_user_id") WHERE status IN ('active', 'session_reset');--> statement-breakpoint
CREATE INDEX "ix_host_thread_events_thread_id" ON "host_thread_events" USING btree ("host_task_thread_id");--> statement-breakpoint
CREATE INDEX "ix_host_thread_events_run_id" ON "host_thread_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_host_thread_events_project_id" ON "host_thread_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_host_runtime_provider_bindings_provider" ON "host_runtime_provider_bindings" USING btree ("model_provider_id");--> statement-breakpoint
CREATE INDEX "ix_project_folder_execution_configs_space_id" ON "project_folder_execution_configs" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_folder_execution_configs_project_folder_id" ON "project_folder_execution_configs" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_project_folders_slug" ON "project_folders" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ix_project_folders_project_id" ON "project_folders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_project_folders_space_id" ON "project_folders" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "ix_project_folders_status" ON "project_folders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_folders_one_primary_per_project" ON "project_folders" USING btree ("project_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "ix_workspace_locations_project_folder_id" ON "workspace_locations" USING btree ("project_folder_id");--> statement-breakpoint
CREATE INDEX "ix_workspace_locations_execution_host_id" ON "workspace_locations" USING btree ("execution_host_id");--> statement-breakpoint
CREATE INDEX "ix_workspace_locations_status" ON "workspace_locations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_locations_one_active_per_folder" ON "workspace_locations" USING btree ("project_folder_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_locations_space_root_path" ON "workspace_locations" USING btree ("space_id","root_path") WHERE root_path IS NOT NULL;