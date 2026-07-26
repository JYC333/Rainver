-- Schema fixture for server Custom Source create-flow integration tests
-- (testcontainers). SOURCE OF TRUTH: server/migrations/0001_baseline.sql.
-- Superset of sourceCustomSourceHandlersSchema.sql /
-- sourceCustomSourceMaterializerSchema.sql plus source catalog,
-- extraction_jobs, source_channel_user_subscriptions (Source Channel creation
-- auto-subscribes the creator), and
-- source_item_user_states (every item read LEFT JOINs per-user library/read
-- state), since CustomSourceCreateFlowService exercises
-- SourceChannelService (provider mapping lookup) and the scan-job
-- orchestration (extraction_jobs pairing). CHECK / NOT NULL / UNIQUE
-- constraints are kept verbatim; unrelated FKs (spaces, users, runs,
-- proposals) are stripped except the proposals table needed for Phase 6's
-- Custom Source approval flow. Regenerate when these tables'
-- columns/constraints change.

CREATE TABLE public.source_providers (
    id character varying(36) NOT NULL,
    provider_key character varying(128) NOT NULL,
    display_name character varying(256) NOT NULL,
    provider_kind character varying(32) NOT NULL,
    category character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    capabilities_json jsonb NOT NULL,
    config_schema_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_providers_pkey PRIMARY KEY (id),
    CONSTRAINT source_providers_provider_key_key UNIQUE (provider_key)
);

CREATE TABLE public.source_connectors (
    id character varying(36) NOT NULL,
    connector_key character varying(128) NOT NULL,
    display_name character varying(256) NOT NULL,
    connector_type character varying(64) NOT NULL,
    ingestion_mode character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    capabilities_json jsonb NOT NULL,
    config_schema_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_connectors_pkey PRIMARY KEY (id),
    CONSTRAINT source_connectors_connector_key_key UNIQUE (connector_key)
);

CREATE TABLE public.source_provider_connectors (
    id character varying(36) NOT NULL,
    provider_id character varying(36) NOT NULL,
    connector_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    capabilities_json jsonb NOT NULL,
    config_schema_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_provider_connectors_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_provider_connectors_provider_connector UNIQUE (provider_id, connector_id)
);

INSERT INTO public.source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
VALUES
  ('provider-arxiv', 'arxiv', 'arXiv', 'named', 'academic', 'active', '{}'::jsonb, now(), now()),
  ('provider-rss', 'generic_rss', 'RSS', 'generic', 'feed', 'active', '{}'::jsonb, now(), now()),
  ('provider-custom-source', 'custom_source', 'Custom Source', 'generic', 'custom', 'active', '{}'::jsonb, now(), now());

INSERT INTO public.source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
VALUES
  ('mapping-arxiv', 'provider-arxiv', 'connector-arxiv', 'active', 0, '{}'::jsonb, now(), now()),
  ('mapping-rss', 'provider-rss', 'connector-rss', 'active', 0, '{}'::jsonb, now(), now()),
  ('mapping-custom-source', 'provider-custom-source', 'connector-custom-source', 'active', 0, '{}'::jsonb, now(), now());

CREATE TABLE public.credentials (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    name character varying(256) NOT NULL,
    credential_type character varying(64) NOT NULL,
    secret_ref text NOT NULL,
    scopes_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT credentials_pkey PRIMARY KEY (id)
);

CREATE TABLE public.source_connections (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    provider_connector_id character varying(36) NOT NULL,
    owner_user_id character varying(36) NOT NULL,
    credential_id character varying(36),
    visibility character varying(32) DEFAULT 'private'::character varying NOT NULL,
    access_level character varying(16) DEFAULT 'full'::character varying NOT NULL,
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
    active_recipe_version_id character varying(36),
    repair_status character varying(32) NOT NULL DEFAULT 'ok',
    last_handler_run_id character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT source_connections_pkey PRIMARY KEY (id),
    CONSTRAINT ck_source_connections_capture_policy CHECK (((capture_policy)::text = ANY ((ARRAY['reference_only'::character varying, 'extract_text'::character varying, 'archive_original'::character varying])::text[]))),
    CONSTRAINT ck_source_connections_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT ck_source_connections_trust_level CHECK (((trust_level)::text = ANY ((ARRAY['trusted'::character varying, 'normal'::character varying, 'untrusted'::character varying])::text[]))),
    CONSTRAINT ck_source_connections_handler_kind CHECK (((handler_kind)::text = ANY ((ARRAY['built_in'::character varying, 'generated_custom'::character varying, 'recipe'::character varying])::text[]))),
    CONSTRAINT ck_source_connections_repair_status CHECK (((repair_status)::text = ANY ((ARRAY['ok'::character varying, 'repair_required'::character varying, 'repair_pending'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT ck_source_connections_visibility CHECK (visibility IN ('private', 'space_shared', 'selected_users')),
    CONSTRAINT ck_source_connections_access_level CHECK (access_level IN ('full', 'summary')),
    CONSTRAINT source_connections_provider_connector_id_fkey FOREIGN KEY (provider_connector_id) REFERENCES public.source_provider_connectors(id)
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
    CONSTRAINT source_channels_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_channels_id_space UNIQUE (id, space_id)
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

-- Source Channel creation auto-subscribes the creator, and channel-scoped
-- reads may LEFT JOIN this table, so it must exist even though these tests
-- don't exercise
-- multi-user subscription fan-out directly.
CREATE TABLE public.source_channel_user_subscriptions (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_channel_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    library_enabled boolean DEFAULT true NOT NULL,
    digest_enabled boolean DEFAULT true NOT NULL,
    recommended_by_user_id character varying(36),
    recommendation_message text,
    last_notified_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_channel_user_subscriptions_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_channel_user_subscriptions_space_channel_user UNIQUE (space_id, source_channel_id, user_id),
    CONSTRAINT ck_source_channel_user_subscriptions_status CHECK (((status)::text = ANY ((ARRAY['subscribed'::character varying, 'pending'::character varying, 'dismissed'::character varying, 'muted'::character varying])::text[])))
);

CREATE TABLE public.source_channel_item_links (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_channel_id character varying(36) NOT NULL,
    source_item_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL DEFAULT 'active',
    matched_at timestamp with time zone NOT NULL,
    match_reason text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_channel_item_links_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_channel_item_links_channel_item UNIQUE (source_channel_id, source_item_id)
);

-- Mirrors the Level 2 recipe portion of server/migrations/0001_baseline.sql.
CREATE TABLE public.source_recipe_versions (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_connection_id character varying(36) NOT NULL,
    version_number integer NOT NULL,
    recipe_json jsonb NOT NULL,
    policy_envelope_json jsonb NOT NULL,
    primitive_versions_json jsonb,
    status character varying(32) NOT NULL,
    created_by_user_id character varying(36),
    proposal_id character varying(36),
    test_result_json jsonb,
    created_at timestamp with time zone NOT NULL,
    activated_at timestamp with time zone,
    superseded_at timestamp with time zone,
    CONSTRAINT source_recipe_versions_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_recipe_versions_connection_version UNIQUE (source_connection_id, version_number),
    CONSTRAINT ck_source_recipe_versions_status CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'test_failed'::character varying, 'pending_approval'::character varying, 'active'::character varying, 'superseded'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT ck_source_recipe_versions_version_number CHECK ((version_number > 0)),
    CONSTRAINT source_recipe_versions_source_connection_id_fkey FOREIGN KEY (source_connection_id) REFERENCES public.source_connections(id) ON DELETE CASCADE
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
    access_level character varying(16) DEFAULT 'full'::character varying NOT NULL,
    owner_user_id character varying(36),
    project_id character varying(36),
    CONSTRAINT proposals_pkey PRIMARY KEY (id),
    CONSTRAINT ck_proposals_risk_level CHECK (((risk_level)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT ck_proposals_urgency CHECK (((urgency)::text = ANY ((ARRAY['low'::character varying, 'normal'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);

CREATE TABLE public.proposal_approvals (
    id character varying(36) NOT NULL,
    proposal_id character varying(36) NOT NULL,
    approval_type character varying(64) NOT NULL,
    approver_user_id character varying(36) NOT NULL,
    grant_id character varying(36),
    target_space_id character varying(36),
    status character varying(32) NOT NULL,
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT proposal_approvals_pkey PRIMARY KEY (id)
);

CREATE TABLE public.runs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    instructed_by_user_id character varying(36),
    CONSTRAINT runs_pkey PRIMARY KEY (id)
);

-- Minimal spaces table for the canonical content-access oversight branch
-- (contentAccessSql / contentAccessLevelSql reference spaces.oversight_mode).
-- SOURCE OF TRUTH: server/migrations/0001_baseline.sql.
CREATE TABLE public.spaces (
    id character varying(36) NOT NULL,
    type character varying(32) NOT NULL DEFAULT 'household',
    oversight_mode character varying(16) DEFAULT 'none' NOT NULL,
    CONSTRAINT spaces_pkey PRIMARY KEY (id)
);

-- Minimal projects + project_members for the canonical content-access
-- project-scope gate (contentScopeSql / projectReadAccessSql), needed by any
-- proposal read through PgProposalApplyService.accept/reject.
-- SOURCE OF TRUTH: server/migrations/0001_baseline.sql.
CREATE TABLE public.projects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT projects_pkey PRIMARY KEY (id)
);

CREATE TABLE public.project_members (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    CONSTRAINT project_members_pkey PRIMARY KEY (id)
);

-- Minimal project_folders for the canonical content-access Folder-scope gate
-- (contentScopeSql / projectFolderReadAccessSql). A Folder belongs to exactly
-- one Project via a direct, non-null FK — there is no join table.
CREATE TABLE public.project_folders (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    CONSTRAINT project_folders_pkey PRIMARY KEY (id)
);

CREATE TABLE public.space_memberships (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT space_memberships_pkey PRIMARY KEY (id),
    CONSTRAINT uq_space_memberships_space_user UNIQUE (space_id, user_id)
);

CREATE TABLE public.content_access_grants (
    id character varying(36) NOT NULL,
    resource_type character varying(64) NOT NULL,
    resource_id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    grantee_user_id character varying(36) NOT NULL,
    granted_by_user_id character varying(36) NOT NULL,
    access_level character varying(16) DEFAULT 'full'::character varying NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by_user_id character varying(36),
    CONSTRAINT content_access_grants_pkey PRIMARY KEY (id),
    CONSTRAINT uq_content_access_grants_resource_grantee UNIQUE (space_id, resource_type, resource_id, grantee_user_id)
);

CREATE TABLE public.policy_decision_records (
    id character varying(36) NOT NULL,
    space_id character varying(36),
    actor_type character varying(64),
    actor_id character varying(36),
    actor_ref_json jsonb,
    action character varying(128) NOT NULL,
    resource_type character varying(64),
    resource_id character varying(256),
    decision character varying(32) NOT NULL,
    risk_level character varying(32) NOT NULL,
    required_approver_role character varying(32),
    approval_capability character varying(128),
    policy_rule_id character varying(128),
    policy_source character varying(64),
    policy_id character varying(36),
    audit_code character varying(128),
    run_id character varying(36),
    proposal_id character varying(36),
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT policy_decision_records_pkey PRIMARY KEY (id)
);

CREATE TABLE public.artifacts (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    artifact_type character varying(64) NOT NULL,
    title character varying(512) NOT NULL,
    content text,
    storage_path character varying(1024),
    mime_type character varying(256),
    exportable boolean DEFAULT true NOT NULL,
    export_formats_json jsonb NOT NULL,
    canonical_format character varying(64),
    preview boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    visibility character varying(32) DEFAULT 'space_shared'::character varying NOT NULL,
    access_level character varying(16) DEFAULT 'full'::character varying NOT NULL,
    owner_user_id character varying(36),
    trust_level character varying(32),
    CONSTRAINT artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT ck_artifacts_storage_path_relative CHECK (((storage_path IS NULL) OR ((storage_path)::text !~~ '/%'::text))),
    CONSTRAINT ck_artifacts_trust_level CHECK (((trust_level IS NULL) OR ((trust_level)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying, 'unknown'::character varying])::text[]))))
);

-- Phase 12: pruneSupersededCustomSourceHandlerArtifacts must clear this FK
-- before deleting the referenced artifacts row (no ON DELETE clause here,
-- matching the real baseline) — this constraint is what makes that ordering
-- bug reproducible in a test instead of only against a live database.
ALTER TABLE public.source_handler_versions
    ADD CONSTRAINT source_handler_versions_handler_artifact_id_fkey FOREIGN KEY (handler_artifact_id) REFERENCES public.artifacts(id);

CREATE TABLE public.extraction_jobs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    connection_id character varying(36),
    source_item_id character varying(36),
    source_snapshot_id character varying(36),
    source_object_type character varying(64),
    source_object_id character varying(36),
    job_type character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    items_seen integer,
    items_created integer,
    items_updated integer,
    error_code character varying(64),
    error_message character varying(512),
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT extraction_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT ck_extraction_jobs_job_type CHECK (((job_type)::text = ANY ((ARRAY['connection_scan'::character varying, 'manual_url'::character varying, 'extract_text'::character varying, 'snapshot'::character varying, 'normalize_activity'::character varying, 'normalize_artifact'::character varying, 'normalize_run_event'::character varying])::text[]))),
    CONSTRAINT ck_extraction_jobs_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);

CREATE TABLE public.source_items (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    visibility character varying(32) DEFAULT 'space_shared' NOT NULL,
    access_level character varying(16) DEFAULT 'full' NOT NULL,
    connection_id character varying(36),
    item_type character varying(64) NOT NULL,
    source_object_type character varying(64),
    source_object_id character varying(36),
    title character varying(1024) NOT NULL,
    source_uri text,
    canonical_uri text,
    source_domain character varying(256),
    source_external_id character varying(512),
    author character varying(512),
    occurred_at timestamp with time zone,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    content_hash character varying(128),
    excerpt character varying(2048),
    created_by_user_id character varying(36),
    content_state character varying(64) NOT NULL,
    retention_policy character varying(32) NOT NULL,
    relevance_score double precision,
    novelty_score double precision,
    raw_artifact_id character varying(36),
    extracted_artifact_id character varying(36),
    summary_artifact_id character varying(36),
    search_index_ref character varying(1024),
    embedding_index_ref character varying(1024),
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT source_items_pkey PRIMARY KEY (id)
);

-- getItemRow (used by createEvidence and reads generally) selects each
-- item's per-user library/read state via a LEFT JOIN.
CREATE TABLE public.source_item_user_states (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_item_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    library_status character varying(32) DEFAULT 'new'::character varying NOT NULL,
    read_status character varying(32) DEFAULT 'unread'::character varying NOT NULL,
    first_opened_at timestamp with time zone,
    last_opened_at timestamp with time zone,
    progress_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_item_user_states_pkey PRIMARY KEY (id),
    CONSTRAINT uq_source_item_user_states_space_item_user UNIQUE (space_id, source_item_id, user_id),
    CONSTRAINT ck_source_item_user_states_library_status CHECK (((library_status)::text = ANY ((ARRAY['new'::character varying, 'triaged'::character varying, 'selected'::character varying, 'ignored'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT ck_source_item_user_states_read_status CHECK (((read_status)::text = ANY ((ARRAY['unread'::character varying, 'skimmed'::character varying, 'read'::character varying, 'discussed'::character varying])::text[]))),
    CONSTRAINT ck_source_item_user_states_progress_json CHECK ((jsonb_typeof(progress_json) = 'object'::text))
);

CREATE TABLE public.source_snapshots (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    visibility character varying(32) DEFAULT 'space_shared' NOT NULL,
    access_level character varying(16) DEFAULT 'full' NOT NULL,
    source_item_id character varying(36),
    connection_id character varying(36),
    snapshot_type character varying(32) NOT NULL,
    artifact_id character varying(36),
    content_hash character varying(128),
    source_uri text,
    capture_method character varying(64) NOT NULL,
    trust_level character varying(32) NOT NULL,
    metadata_json jsonb,
    captured_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_snapshots_pkey PRIMARY KEY (id)
);

CREATE TABLE public.extracted_evidence (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    visibility character varying(32) DEFAULT 'space_shared' NOT NULL,
    access_level character varying(16) DEFAULT 'full' NOT NULL,
    source_item_id character varying(36),
    origin_source_item_id character varying(36),
    extraction_job_id character varying(36),
    source_snapshot_id character varying(36),
    source_object_type character varying(64),
    source_object_id character varying(36),
    evidence_type character varying(64) NOT NULL,
    title character varying(1024) NOT NULL,
    content_excerpt character varying(4096),
    content_hash character varying(128),
    artifact_id character varying(36),
    source_uri text,
    source_title character varying(1024),
    source_author character varying(512),
    occurred_at timestamp with time zone,
    trust_level character varying(32) NOT NULL,
    extraction_method character varying(64) NOT NULL,
    confidence double precision,
    status character varying(32) NOT NULL,
    metadata_json jsonb,
    created_by_user_id character varying(36),
    created_by_agent_id character varying(36),
    created_by_run_id character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT extracted_evidence_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_extracted_evidence_source_content
    ON public.extracted_evidence USING btree (space_id, source_item_id, content_hash)
    WHERE source_item_id IS NOT NULL AND content_hash IS NOT NULL;

CREATE TABLE public.project_source_bindings (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    source_channel_id character varying(36),
    source_connection_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    priority integer NOT NULL,
    collection_notifications_enabled boolean DEFAULT true NOT NULL,
    filters_json jsonb NOT NULL,
    extraction_policy_json jsonb NOT NULL,
    CONSTRAINT project_source_bindings_pkey PRIMARY KEY (id)
);

CREATE TABLE public.project_source_item_links (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    project_source_binding_id character varying(36) NOT NULL,
    source_channel_id character varying(36),
    source_connection_id character varying(36),
    source_item_id character varying(36) NOT NULL,
    status character varying(32) DEFAULT 'active' NOT NULL,
    matched_at timestamp with time zone NOT NULL,
    match_reason text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT project_source_item_links_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_project_source_item_links_binding_item
    ON public.project_source_item_links (space_id, project_id, project_source_binding_id, source_item_id);

CREATE TABLE public.evidence_links (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    evidence_id character varying(36) NOT NULL,
    target_type character varying(64) NOT NULL,
    target_id character varying(36),
    link_type character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    reason character varying(1024),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT evidence_links_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_evidence_links_active_dedupe
    ON public.evidence_links (space_id, evidence_id, target_type, target_id, link_type)
    WHERE status = 'active';

CREATE TABLE public.space_objects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    object_type character varying(32) DEFAULT 'source' NOT NULL,
    title character varying(512) DEFAULT '' NOT NULL,
    status character varying(32) DEFAULT 'raw' NOT NULL,
    visibility character varying(32) DEFAULT 'space_shared' NOT NULL,
    access_level character varying(16) DEFAULT 'full' NOT NULL,
    owner_user_id character varying(36),
    primary_project_id character varying(36),
    project_folder_id character varying(36),
    deleted_at timestamp with time zone,
    CONSTRAINT space_objects_pkey PRIMARY KEY (id)
);

CREATE TABLE public.project_corpus_items (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    object_id character varying(36),
    source_item_id character varying(36),
    evidence_id character varying(36),
    source_connection_id character varying(36),
    role character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    triage_status character varying(32) NOT NULL,
    read_status character varying(32) NOT NULL,
    confidence double precision,
    reason text,
    metadata_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT project_corpus_items_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_project_corpus_items_object
    ON public.project_corpus_items (space_id, project_id, object_id) WHERE object_id IS NOT NULL;
CREATE UNIQUE INDEX uq_project_corpus_items_source_item
    ON public.project_corpus_items (space_id, project_id, source_item_id)
    WHERE source_item_id IS NOT NULL AND object_id IS NULL AND evidence_id IS NULL;
CREATE UNIQUE INDEX uq_project_corpus_items_evidence
    ON public.project_corpus_items (space_id, project_id, evidence_id)
    WHERE evidence_id IS NOT NULL AND object_id IS NULL;

CREATE TABLE public.retrieval_objects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    object_type character varying(64) NOT NULL,
    object_id character varying(36) NOT NULL,
    project_folder_id character varying(36),
    owner_user_id character varying(36),
    visibility character varying(32),
    status character varying(32) NOT NULL,
    title character varying(512) NOT NULL,
    slug character varying(512),
    object_kind character varying(64),
    content_hash character varying(64) NOT NULL,
    source_connection_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    indexed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    source_updated_at timestamp with time zone,
    CONSTRAINT retrieval_objects_pkey PRIMARY KEY (id),
    CONSTRAINT ck_retrieval_objects_source_connections_array CHECK ((jsonb_typeof(source_connection_ids_json) = 'array'::text))
);

CREATE TABLE public.retrieval_aliases (
    id character varying(36) NOT NULL,
    retrieval_object_id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    object_type character varying(64) NOT NULL,
    object_id character varying(36) NOT NULL,
    alias text NOT NULL,
    normalized_alias text NOT NULL,
    alias_kind character varying(32) NOT NULL,
    confidence double precision NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT retrieval_aliases_pkey PRIMARY KEY (id),
    CONSTRAINT ck_retrieval_aliases_confidence CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
);

CREATE TABLE public.retrieval_chunks (
    id character varying(36) NOT NULL,
    retrieval_object_id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    object_type character varying(64) NOT NULL,
    object_id character varying(36) NOT NULL,
    chunk_index integer NOT NULL,
    plain_text text NOT NULL,
    tsv tsvector,
    content_hash character varying(64) NOT NULL,
    embedding text,
    embedding_model character varying(128),
    embedding_dimensions integer,
    embedding_generated_at timestamp with time zone,
    embedding_claim_id character varying(64),
    embedding_claimed_at timestamp with time zone,
    embedding_attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT retrieval_chunks_pkey PRIMARY KEY (id)
);

CREATE TABLE public.retrieval_edges (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    from_object_type character varying(64) NOT NULL,
    from_object_id character varying(36) NOT NULL,
    to_object_type character varying(64) NOT NULL,
    to_object_id character varying(36) NOT NULL,
    relation_type character varying(64) NOT NULL,
    edge_origin character varying(64) NOT NULL,
    edge_status character varying(32) NOT NULL,
    confidence double precision NOT NULL,
    evidence_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT retrieval_edges_pkey PRIMARY KEY (id),
    CONSTRAINT ck_retrieval_edges_confidence CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT ck_retrieval_edges_status CHECK (((edge_status)::text = ANY ((ARRAY['derived'::character varying, 'suggested'::character varying])::text[])))
);

CREATE UNIQUE INDEX ix_retrieval_objects_space_object_unique ON public.retrieval_objects USING btree (space_id, object_type, object_id);
CREATE UNIQUE INDEX ix_retrieval_aliases_unique ON public.retrieval_aliases USING btree (space_id, object_type, object_id, normalized_alias, alias_kind);
CREATE UNIQUE INDEX ix_retrieval_chunks_object_chunk_unique ON public.retrieval_chunks USING btree (retrieval_object_id, chunk_index);
CREATE UNIQUE INDEX ix_retrieval_edges_unique ON public.retrieval_edges USING btree (space_id, from_object_type, from_object_id, to_object_type, to_object_id, relation_type, edge_origin);

CREATE TABLE public.jobs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    job_type character varying(128) NOT NULL,
    status character varying(32) NOT NULL,
    priority integer NOT NULL,
    payload_json jsonb NOT NULL,
    result_json jsonb,
    error text,
    attempts integer NOT NULL,
    max_attempts integer NOT NULL,
    scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by character varying(64),
    claimed_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    heartbeat_at timestamp with time zone,
    user_id character varying(36),
    project_folder_id character varying(36),
    agent_id character varying(36),
    CONSTRAINT jobs_pkey PRIMARY KEY (id),
    CONSTRAINT ck_jobs_attempts_nonneg CHECK ((attempts >= 0)),
    CONSTRAINT ck_jobs_max_attempts_positive CHECK ((max_attempts > 0)),
    CONSTRAINT ck_jobs_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'claimed'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);

CREATE INDEX ix_jobs_space_id ON public.jobs USING btree (space_id);
CREATE INDEX ix_jobs_status ON public.jobs USING btree (status);
CREATE INDEX ix_jobs_job_type ON public.jobs USING btree (job_type);

-- Proposal apply checks whether an ordinary proposal belongs to an active
-- Evolution bundle. These tables are not exercised as a feature in the
-- Source tests, but the canonical proposal boundary reads them on every
-- accept/reject. Keep the fixture aligned with the production baseline so
-- unrelated proposal flows do not fail with a missing-relation error.
CREATE TABLE public.evolution_bundles (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    title character varying(256) NOT NULL,
    description text,
    status character varying(32) DEFAULT 'pending_review' NOT NULL,
    risk_level character varying(32) NOT NULL,
    created_by_user_id character varying(36) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone,
    rolled_back_at timestamp with time zone,
    rollback_error text,
    CONSTRAINT evolution_bundles_pkey PRIMARY KEY (id),
    CONSTRAINT ck_evolution_bundles_status CHECK (((status)::text = ANY ((ARRAY['pending_review'::character varying, 'partially_approved'::character varying, 'applied'::character varying, 'rejected'::character varying, 'rolled_back'::character varying, 'rollback_failed'::character varying])::text[]))),
    CONSTRAINT ck_evolution_bundles_risk_level CHECK (((risk_level)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);

CREATE TABLE public.evolution_bundle_members (
    id character varying(36) NOT NULL,
    bundle_id character varying(36) NOT NULL,
    proposal_id character varying(36) NOT NULL,
    position integer NOT NULL,
    status character varying(32) DEFAULT 'pending' NOT NULL,
    decision_note text,
    decided_by_user_id character varying(36),
    decided_at timestamp with time zone,
    before_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT evolution_bundle_members_pkey PRIMARY KEY (id),
    CONSTRAINT ck_evolution_bundle_members_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'released'::character varying, 'rolled_back'::character varying, 'rollback_failed'::character varying])::text[]))),
    CONSTRAINT ck_evolution_bundle_members_position CHECK (position > 0),
    CONSTRAINT ck_evolution_bundle_members_before_snapshot_object CHECK (jsonb_typeof(before_snapshot_json) = 'object'::text),
    CONSTRAINT ck_evolution_bundle_members_after_snapshot_object CHECK (jsonb_typeof(after_snapshot_json) = 'object'::text)
);

CREATE INDEX ix_evolution_bundles_space_status_updated
    ON public.evolution_bundles (space_id, status, updated_at DESC);
CREATE INDEX ix_evolution_bundles_created_by_user
    ON public.evolution_bundles (created_by_user_id);
CREATE INDEX ix_evolution_bundle_members_bundle_position
    ON public.evolution_bundle_members (bundle_id, position);
CREATE INDEX ix_evolution_bundle_members_proposal_id
    ON public.evolution_bundle_members (proposal_id);
CREATE UNIQUE INDEX uq_evolution_bundle_members_proposal
    ON public.evolution_bundle_members (proposal_id);
