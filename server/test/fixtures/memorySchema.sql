-- Schema fixture for server memory-read integration tests
-- (testcontainers). SOURCE OF TRUTH: server/migrations.
-- Mirrors the columns the server memory
-- read model SELECTs and the constraints that affect parsing (jsonb,
-- timestamptz, float8, integer). Cross-table FOREIGN KEYs are stripped so it
-- loads into an empty DB. Regenerate when these columns change.

CREATE TABLE public.memory_entries (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    subject_user_id character varying(36),
    owner_user_id character varying(36),
    project_folder_id character varying(36),
    scope_type character varying(32) NOT NULL,
    namespace character varying(255),
    memory_type character varying(64) NOT NULL,
    title character varying(512),
    content text,
    status character varying(32) NOT NULL,
    visibility character varying(32) NOT NULL,
    access_level character varying(16) NOT NULL DEFAULT 'full',
    sensitivity_level character varying(32) NOT NULL DEFAULT 'normal',
    last_confirmed_at timestamp with time zone,
    confidence double precision NOT NULL DEFAULT 1,
    importance double precision NOT NULL DEFAULT 0.5,
    source_id character varying(36),
    created_by character varying(36),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    version integer NOT NULL DEFAULT 1,
    tags jsonb,
    memory_layer character varying(64),
    source_trust character varying(64),
    created_from_proposal_id character varying(36),
    root_memory_id character varying(36),
    supersedes_memory_id character varying(36),
    project_id character varying(36),
    access_count integer NOT NULL DEFAULT 0,
    last_accessed_at timestamp with time zone,
    last_retrieved_at timestamp with time zone,
    CONSTRAINT memory_entries_pkey PRIMARY KEY (id)
);

CREATE TABLE public.projects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    deleted_at timestamp with time zone,
    CONSTRAINT projects_pkey PRIMARY KEY (id)
);

-- Minimal spaces + project_members for the project-level memory access gate
-- (canAccessProject / accessibleProjectIds). SOURCE OF TRUTH: server/migrations.
CREATE TABLE public.spaces (
    id character varying(36) NOT NULL,
    type character varying(32) NOT NULL DEFAULT 'household',
    oversight_mode character varying(16) NOT NULL DEFAULT 'none',
    CONSTRAINT spaces_pkey PRIMARY KEY (id)
);

CREATE TABLE public.space_memberships (
    id character varying(64) NOT NULL,
    space_id character varying(36) NOT NULL,
    user_id character varying(64) NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT space_memberships_pkey PRIMARY KEY (id)
);

CREATE TABLE public.project_folders (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    CONSTRAINT project_folders_pkey PRIMARY KEY (id)
);

CREATE TABLE public.content_access_grants (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    resource_type character varying(64) NOT NULL,
    resource_id character varying(36) NOT NULL,
    grantee_user_id character varying(64) NOT NULL,
    access_level character varying(16) NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT content_access_grants_pkey PRIMARY KEY (id)
);

CREATE TABLE public.project_members (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT project_members_pkey PRIMARY KEY (id)
);

-- Read-access audit (slice 7a). SOURCE OF TRUTH: models.py MemoryReadTrace.
-- Cross-table FOREIGN KEYs are stripped so the fixture loads into an empty DB.
CREATE TABLE public.memory_access_logs (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    memory_id character varying(36) NOT NULL,
    user_id character varying(36),
    agent_id character varying(36),
    run_id character varying(36),
    access_type character varying(64) NOT NULL,
    reason text,
    accessed_at timestamp with time zone NOT NULL,
    CONSTRAINT memory_access_logs_pkey PRIMARY KEY (id)
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
    preview boolean NOT NULL DEFAULT false,
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
    visibility character varying(32) NOT NULL DEFAULT 'space_shared',
    access_level character varying(16) NOT NULL DEFAULT 'full',
    owner_user_id character varying(36),
    project_id character varying(36),
    CONSTRAINT proposals_pkey PRIMARY KEY (id),
    CONSTRAINT ck_proposals_risk_level CHECK (((risk_level)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT ck_proposals_urgency CHECK (((urgency)::text = ANY ((ARRAY['low'::character varying, 'normal'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);

CREATE TABLE public.source_items (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    connection_id character varying(36),
    deleted_at timestamp with time zone,
    CONSTRAINT source_items_pkey PRIMARY KEY (id)
);

CREATE TABLE public.source_snapshots (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    connection_id character varying(36),
    CONSTRAINT source_snapshots_pkey PRIMARY KEY (id)
);

CREATE TABLE public.extracted_evidence (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    source_item_id character varying(36),
    source_snapshot_id character varying(36),
    deleted_at timestamp with time zone,
    CONSTRAINT extracted_evidence_pkey PRIMARY KEY (id)
);

CREATE TABLE public.provenance_links (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    target_type character varying(64) NOT NULL,
    target_id character varying(36) NOT NULL,
    source_type character varying(64) NOT NULL,
    source_id character varying(36) NOT NULL,
    source_trust character varying(32),
    evidence_json jsonb,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT provenance_links_pkey PRIMARY KEY (id)
);

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
    CONSTRAINT retrieval_objects_pkey PRIMARY KEY (id)
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
    CONSTRAINT retrieval_aliases_pkey PRIMARY KEY (id)
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
    CONSTRAINT retrieval_edges_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_retrieval_aliases_unique ON public.retrieval_aliases USING btree (space_id, object_type, object_id, normalized_alias, alias_kind);
CREATE UNIQUE INDEX ix_retrieval_edges_unique ON public.retrieval_edges USING btree (space_id, from_object_type, from_object_id, to_object_type, to_object_id, relation_type, edge_origin);
