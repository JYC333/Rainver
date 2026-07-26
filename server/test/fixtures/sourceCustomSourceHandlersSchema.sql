-- Schema fixture for server Custom Source handler repository integration
-- tests (testcontainers). SOURCE OF TRUTH: server/migrations/0001_baseline.sql.
-- Mirrors the tables PgCustomSourceHandlerRepository touches. Cross-table
-- FOREIGN KEYs to tables outside this fixture (spaces, users, artifacts,
-- runs, proposals, extraction_jobs) are stripped so it loads into an empty
-- DB; CHECK / NOT NULL / UNIQUE constraints are kept verbatim. Regenerate
-- when these tables' columns/constraints change.

CREATE TABLE public.space_memberships (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT space_memberships_pkey PRIMARY KEY (id),
    CONSTRAINT ck_space_memberships_role CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'reviewer'::character varying, 'member'::character varying, 'guest'::character varying])::text[])))
);

CREATE TABLE public.source_connections (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    provider_connector_id character varying(36) NOT NULL,
    owner_user_id character varying(36) NOT NULL,
    credential_id character varying(36),
    name character varying(512) NOT NULL,
    status character varying(32) NOT NULL,
    capture_policy character varying(64) NOT NULL,
    trust_level character varying(32) NOT NULL,
    topic_hints_json jsonb,
    consent_json jsonb NOT NULL,
    policy_json jsonb NOT NULL,
    config_json jsonb NOT NULL,
    handler_kind character varying(32) NOT NULL DEFAULT 'built_in',
    active_handler_version_id character varying(36),
    repair_status character varying(32) NOT NULL DEFAULT 'ok',
    last_handler_run_id character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT source_connections_pkey PRIMARY KEY (id),
    CONSTRAINT ck_source_connections_handler_kind CHECK (((handler_kind)::text = ANY ((ARRAY['built_in'::character varying, 'generated_custom'::character varying])::text[]))),
    CONSTRAINT ck_source_connections_repair_status CHECK (((repair_status)::text = ANY ((ARRAY['ok'::character varying, 'repair_required'::character varying, 'repair_pending'::character varying, 'disabled'::character varying])::text[])))
);

CREATE UNIQUE INDEX uq_source_connections_active_owner_mapping
  ON public.source_connections (space_id, owner_user_id, provider_connector_id, name)
  WHERE deleted_at IS NULL AND status <> 'archived';

CREATE TABLE public.source_channels (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_connection_id character varying(36) NOT NULL,
    created_by_user_id character varying(36) NOT NULL,
    name character varying(512) NOT NULL,
    channel_type character varying(32) NOT NULL,
    endpoint_url text,
    query_json jsonb NOT NULL,
    provider_query_json jsonb NOT NULL,
    query_fingerprint character varying(128) NOT NULL,
    status character varying(32) NOT NULL,
    fetch_frequency character varying(32) NOT NULL,
    schedule_rule_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_channels_pkey PRIMARY KEY (id)
);

CREATE TABLE public.source_search_specs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_channel_id character varying(36) NOT NULL,
    provider_key character varying(32) NOT NULL,
    research_query_attempt_id character varying(36),
    compiled_provider_query_json jsonb NOT NULL,
    query_fingerprint character varying(128) NOT NULL,
    active_version integer DEFAULT 1 NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_search_specs_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_search_specs_channel UNIQUE (source_channel_id)
);

CREATE TABLE public.scheduler_tasks (
    id character varying(36) NOT NULL,
    task_type character varying(128) NOT NULL,
    task_key character varying(256) NOT NULL,
    scope_type character varying(32) NOT NULL,
    scope_id character varying(128) NOT NULL,
    space_id character varying(36),
    user_id character varying(36),
    status character varying(32) NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    state_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT scheduler_tasks_pkey PRIMARY KEY (id),
    CONSTRAINT uq_scheduler_tasks_type_key UNIQUE (task_type, task_key),
    CONSTRAINT ck_scheduler_tasks_scope_type CHECK (((scope_type)::text = ANY ((ARRAY['instance'::character varying, 'space'::character varying, 'user'::character varying, 'space_user'::character varying])::text[]))),
    CONSTRAINT ck_scheduler_tasks_state_json_object CHECK ((jsonb_typeof(state_json) = 'object'::text)),
    CONSTRAINT ck_scheduler_tasks_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'archived'::character varying])::text[])))
);

CREATE TABLE public.source_handler_versions (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_connection_id character varying(36) NOT NULL,
    version_number integer NOT NULL,
    language character varying(32) NOT NULL,
    entrypoint character varying(512) NOT NULL,
    handler_artifact_id character varying(36),
    manifest_json jsonb NOT NULL,
    input_schema_json jsonb,
    output_schema_json jsonb,
    policy_envelope_json jsonb NOT NULL,
    requested_capabilities_json jsonb,
    checksum character varying(128) NOT NULL,
    status character varying(32) NOT NULL,
    created_by_user_id character varying(36),
    created_by_run_id character varying(36),
    proposal_id character varying(36),
    test_result_json jsonb,
    created_at timestamp with time zone NOT NULL,
    activated_at timestamp with time zone,
    superseded_at timestamp with time zone,
    CONSTRAINT source_handler_versions_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_handler_versions_connection_version UNIQUE (source_connection_id, version_number),
    CONSTRAINT ck_source_handler_versions_language CHECK (((language)::text = ANY ((ARRAY['typescript_node'::character varying, 'declarative_pipeline_v1'::character varying])::text[]))),
    CONSTRAINT ck_source_handler_versions_status CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'test_failed'::character varying, 'pending_approval'::character varying, 'active'::character varying, 'superseded'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT ck_source_handler_versions_version_number CHECK ((version_number > 0)),
    CONSTRAINT source_handler_versions_source_connection_id_fkey FOREIGN KEY (source_connection_id) REFERENCES public.source_connections(id) ON DELETE CASCADE
);

CREATE TABLE public.source_handler_runs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_connection_id character varying(36) NOT NULL,
    handler_version_id character varying(36) NOT NULL,
    extraction_job_id character varying(36),
    status character varying(32) NOT NULL,
    input_artifact_id character varying(36),
    output_artifact_id character varying(36),
    logs_artifact_id character varying(36),
    failure_class character varying(64),
    failure_detail_json jsonb,
    validation_result_json jsonb,
    resource_usage_json jsonb,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT source_handler_runs_pkey PRIMARY KEY (id),
    CONSTRAINT ck_source_handler_runs_status CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'validation_failed'::character varying, 'blocked'::character varying])::text[]))),
    CONSTRAINT source_handler_runs_source_connection_id_fkey FOREIGN KEY (source_connection_id) REFERENCES public.source_connections(id) ON DELETE CASCADE,
    CONSTRAINT source_handler_runs_handler_version_id_fkey FOREIGN KEY (handler_version_id) REFERENCES public.source_handler_versions(id) ON DELETE CASCADE
);

ALTER TABLE public.source_connections
    ADD CONSTRAINT source_connections_active_handler_version_id_fkey FOREIGN KEY (active_handler_version_id) REFERENCES public.source_handler_versions(id) ON DELETE SET NULL;

-- Phase 12: getHandlerSummary's pending_proposals join needs this table.
CREATE TABLE public.proposals (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    created_by_run_id character varying(36),
    action_idempotency_key character varying(256),
    proposal_type character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    risk_level character varying(32) NOT NULL,
    urgency character varying(32) NOT NULL,
    preview boolean DEFAULT false NOT NULL,
    title character varying(512) NOT NULL,
    summary text,
    payload_json jsonb NOT NULL,
    review_deadline timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by character varying(36),
    project_folder_id character varying(36),
    rationale text,
    created_by_agent_id character varying(36),
    created_by_user_id character varying(36),
    required_approver_role character varying(64),
    visibility character varying(32) DEFAULT 'space_shared'::character varying NOT NULL,
    project_id character varying(36),
    CONSTRAINT proposals_pkey PRIMARY KEY (id),
    CONSTRAINT ck_proposals_risk_level CHECK (((risk_level)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT ck_proposals_urgency CHECK (((urgency)::text = ANY ((ARRAY['low'::character varying, 'normal'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);

CREATE TABLE public.settings (
    id character varying(36) NOT NULL,
    scope_type character varying(32) NOT NULL,
    scope_id character varying(128) NOT NULL,
    settings_key character varying(128) NOT NULL,
    settings_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by_user_id character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT settings_pkey PRIMARY KEY (id),
    CONSTRAINT ck_settings_json_object CHECK ((jsonb_typeof(settings_json) = 'object'::text)),
    CONSTRAINT ck_settings_scope_type CHECK (((scope_type)::text = ANY ((ARRAY['instance'::character varying, 'space'::character varying, 'user'::character varying, 'space_user'::character varying])::text[]))),
    CONSTRAINT uq_settings_scope_key UNIQUE (scope_type, scope_id, settings_key)
);
