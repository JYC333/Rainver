-- Schema fixture for server Custom Source materializer integration tests
-- (testcontainers). SOURCE OF TRUTH: server/migrations/0001_baseline.sql.
-- Mirrors the tables CustomSourceMaterializationService touches. Cross-table
-- FOREIGN KEYs to tables outside this fixture are stripped so it loads into
-- an empty DB; CHECK / NOT NULL constraints are kept verbatim. Regenerate
-- when these tables' columns/constraints change.

CREATE TABLE public.source_connections (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    provider_connector_id character varying(36) DEFAULT 'mapping-test'::character varying NOT NULL,
    owner_user_id character varying(36),
    visibility character varying(32) DEFAULT 'space_shared' NOT NULL,
    access_level character varying(16) DEFAULT 'full' NOT NULL,
    last_handler_run_id character varying(36),
    CONSTRAINT source_connections_pkey PRIMARY KEY (id)
);

CREATE TABLE public.source_channels (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_connection_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL DEFAULT 'active',
    CONSTRAINT source_channels_pkey PRIMARY KEY (id)
);

CREATE TABLE public.source_channel_item_links (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_channel_id character varying(36) NOT NULL,
    source_item_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL DEFAULT 'active',
    CONSTRAINT source_channel_item_links_pkey PRIMARY KEY (id)
);

-- Minimal spaces table for the canonical content-access oversight branch
-- (contentAccessSql / contentAccessLevelSql reference spaces.oversight_mode).
-- SOURCE OF TRUTH: server/migrations/0001_baseline.sql.
CREATE TABLE public.spaces (
    id character varying(36) NOT NULL,
    oversight_mode character varying(16) DEFAULT 'none' NOT NULL,
    CONSTRAINT spaces_pkey PRIMARY KEY (id)
);

CREATE TABLE public.space_memberships (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    role character varying(32),
    status character varying(32) NOT NULL,
    CONSTRAINT space_memberships_pkey PRIMARY KEY (id)
);

CREATE TABLE public.content_access_grants (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    resource_type character varying(64) NOT NULL,
    resource_id character varying(36) NOT NULL,
    grantee_user_id character varying(36) NOT NULL,
    granted_by_user_id character varying(36) NOT NULL,
    access_level character varying(16) DEFAULT 'full' NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by_user_id character varying(36),
    CONSTRAINT content_access_grants_pkey PRIMARY KEY (id),
    CONSTRAINT uq_content_access_grants_resource_grantee UNIQUE (space_id, resource_type, resource_id, grantee_user_id)
);

CREATE TABLE public.source_handler_runs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_connection_id character varying(36) NOT NULL,
    handler_version_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    output_artifact_id character varying(36),
    validation_result_json jsonb,
    created_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT source_handler_runs_pkey PRIMARY KEY (id),
    CONSTRAINT ck_source_handler_runs_status CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'validation_failed'::character varying, 'blocked'::character varying])::text[])))
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
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT source_items_pkey PRIMARY KEY (id),
    CONSTRAINT ck_source_items_content_state CHECK (((content_state)::text = ANY ((ARRAY['metadata_only'::character varying, 'excerpt_saved'::character varying, 'content_queued'::character varying, 'content_saved'::character varying, 'snapshot_queued'::character varying, 'snapshot_saved'::character varying, 'extraction_failed'::character varying, 'content_unavailable'::character varying])::text[]))),
    CONSTRAINT ck_source_items_item_type CHECK (((item_type)::text = ANY ((ARRAY['external_url'::character varying, 'feed_entry'::character varying, 'activity_record'::character varying, 'artifact'::character varying, 'run_event'::character varying, 'file'::character varying, 'document'::character varying, 'log'::character varying])::text[]))),
    CONSTRAINT ck_source_items_retention_policy CHECK (((retention_policy)::text = ANY ((ARRAY['metadata_only'::character varying, 'summary_only'::character varying, 'full_text'::character varying, 'full_snapshot'::character varying, 'archived'::character varying])::text[])))
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
    CONSTRAINT source_snapshots_pkey PRIMARY KEY (id),
    CONSTRAINT ck_source_snapshots_capture_method CHECK (((capture_method)::text = ANY ((ARRAY['manual'::character varying, 'connection_scan'::character varying, 'full_text'::character varying, 'snapshot'::character varying, 'internal'::character varying, 'custom_source_handler'::character varying, 'source_recipe'::character varying])::text[]))),
    CONSTRAINT ck_source_snapshots_snapshot_type CHECK (((snapshot_type)::text = ANY ((ARRAY['metadata'::character varying, 'raw'::character varying, 'extracted'::character varying, 'summary'::character varying])::text[]))),
    CONSTRAINT ck_source_snapshots_trust_level CHECK (((trust_level)::text = ANY ((ARRAY['trusted'::character varying, 'normal'::character varying, 'untrusted'::character varying])::text[])))
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
    CONSTRAINT extracted_evidence_pkey PRIMARY KEY (id),
    CONSTRAINT ck_extracted_evidence_evidence_type CHECK (((evidence_type)::text = ANY ((ARRAY['document'::character varying, 'excerpt'::character varying, 'event'::character varying, 'log'::character varying, 'artifact'::character varying, 'claim'::character varying, 'summary'::character varying])::text[]))),
    CONSTRAINT ck_extracted_evidence_status CHECK (((status)::text = ANY ((ARRAY['candidate'::character varying, 'active'::character varying, 'rejected'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT ck_extracted_evidence_trust_level CHECK (((trust_level)::text = ANY ((ARRAY['trusted'::character varying, 'normal'::character varying, 'untrusted'::character varying])::text[])))
);

CREATE UNIQUE INDEX uq_extracted_evidence_source_content
    ON public.extracted_evidence USING btree (space_id, source_item_id, content_hash)
    WHERE source_item_id IS NOT NULL AND content_hash IS NOT NULL;

-- Evidence→project auto-link surface (evidenceProjectLinker) — the linker joins
-- source_items/extracted_evidence with active project bindings and inserts
-- idempotent context_candidate links.
ALTER TABLE public.source_items ADD COLUMN deleted_at timestamp with time zone;
ALTER TABLE public.extracted_evidence ADD COLUMN deleted_at timestamp with time zone;

CREATE TABLE public.projects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT projects_pkey PRIMARY KEY (id)
);

CREATE TABLE public.project_source_bindings (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    source_channel_id character varying(36),
    source_connection_id character varying(36) NOT NULL,
    binding_key character varying(128) DEFAULT 'default'::character varying NOT NULL,
    status character varying(32) NOT NULL,
    priority integer NOT NULL,
    delivery_scope character varying(32) DEFAULT 'project_members'::character varying NOT NULL,
    collection_notifications_enabled boolean DEFAULT true NOT NULL,
    filters_json jsonb NOT NULL,
    routing_policy_json jsonb NOT NULL,
    extraction_policy_json jsonb NOT NULL,
    created_by_user_id character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
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
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    matched_at timestamp with time zone NOT NULL,
    match_reason text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT project_source_item_links_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_project_source_item_links_binding_item
    ON public.project_source_item_links USING btree (space_id, project_id, project_source_binding_id, source_item_id);

CREATE TABLE public.activity_records (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36),
    activity_type character varying(64) NOT NULL,
    title character varying(512),
    content text,
    payload_json jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    status character varying(32) NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    source_kind character varying(64),
    source_trust character varying(32),
    visibility character varying(32),
    aggregate_key character varying(128),
    processed_at timestamp with time zone,
    discarded_at timestamp with time zone,
    CONSTRAINT activity_records_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_activity_records_space_aggregate_key
    ON public.activity_records USING btree (space_id, aggregate_key) WHERE (aggregate_key IS NOT NULL);

CREATE TABLE public.evidence_links (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    evidence_id character varying(36) NOT NULL,
    target_type character varying(64) NOT NULL,
    target_id character varying(36),
    link_type character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    confidence double precision,
    reason character varying(1024),
    created_by_user_id character varying(36),
    created_by_agent_id character varying(36),
    created_by_run_id character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT evidence_links_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_evidence_links_active_dedupe ON public.evidence_links USING btree (space_id, evidence_id, target_type, target_id, link_type) WHERE ((status)::text = 'active'::text);

CREATE TABLE public.space_objects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
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
    source_decision_id character varying(36),
    role character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    triage_status character varying(32) NOT NULL,
    triage_confirmed_by_user boolean DEFAULT false NOT NULL,
    read_status character varying(32) NOT NULL,
    relevance character varying(32),
    confidence double precision,
    reason text,
    added_by_user_id character varying(36),
    metadata_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_reviewed_at timestamp with time zone,
    last_read_at timestamp with time zone,
    CONSTRAINT project_corpus_items_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_project_corpus_items_object
    ON public.project_corpus_items (space_id, project_id, object_id)
    WHERE object_id IS NOT NULL;
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
