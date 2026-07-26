-- Schema fixture for server sessions integration tests (testcontainers).
-- SOURCE OF TRUTH: server/migrations.
-- Mirrors the tables the server sessions repository touches. Cross-table FOREIGN
-- KEYs are stripped so it loads into an empty DB; CHECK / column-type / NOT NULL
-- constraints (the ones that catch real SQL bugs — e.g. the DB/default
-- columns id/status/created_at/updated_at that a raw INSERT must supply) are
-- kept verbatim. Regenerate when these tables' columns/constraints change.
--
-- projects/spaces/project_members are included because the repository's
-- project-scoped session queries inline projectReadAccessSql, an EXISTS
-- subquery over those three tables. Postgres resolves every relation a query
-- references at parse time, so this is required even for a session whose
-- project_id is NULL and even though no cross-table FOREIGN KEY is declared.

CREATE TABLE public.spaces (
    id character varying(36) NOT NULL,
    type character varying(32) NOT NULL,
    CONSTRAINT spaces_pkey PRIMARY KEY (id)
);

CREATE TABLE public.projects (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    owner_user_id character varying(36),
    status character varying(32) NOT NULL,
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

-- rooms/room_user_members back the Room-conversation lookup path
-- (getRoomConversation), which internal session derivation (condenseSession,
-- etc.) falls back to for a Room-backed session.

CREATE TABLE public.rooms (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    project_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    CONSTRAINT rooms_pkey PRIMARY KEY (id)
);

CREATE TABLE public.room_user_members (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    room_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    status character varying(32) NOT NULL,
    CONSTRAINT room_user_members_pkey PRIMARY KEY (id)
);

CREATE TABLE public.sessions (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    user_id character varying(36),
    agent_id character varying(36),
    project_folder_id character varying(36),
    project_id character varying(36),
    room_id character varying(36),
    title character varying(512),
    status character varying(32) NOT NULL,
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT sessions_pkey PRIMARY KEY (id),
    CONSTRAINT ck_sessions_conversation_owner CHECK (
        ((room_id IS NOT NULL) AND (project_id IS NOT NULL) AND (user_id IS NULL) AND (agent_id IS NULL))
        OR ((room_id IS NULL) AND (user_id IS NOT NULL))
    )
);

CREATE TABLE public.session_summaries (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    session_id character varying(36) NOT NULL,
    user_id character varying(36),
    version integer NOT NULL,
    status character varying(32) NOT NULL,
    summary_text text NOT NULL,
    source_message_count integer NOT NULL,
    source_first_message_id character varying(36),
    source_last_message_id character varying(36),
    summary_json jsonb,
    token_estimate_before integer,
    token_estimate_after integer,
    condenser_version character varying(64) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT session_summaries_pkey PRIMARY KEY (id),
    CONSTRAINT ck_session_summaries_status CHECK (
        ((status)::text = ANY ((ARRAY['active'::character varying, 'superseded'::character varying])::text[]))
    ),
    CONSTRAINT uq_session_summaries_session_version UNIQUE (session_id, version)
);

CREATE UNIQUE INDEX ix_session_summaries_one_active_per_session
    ON public.session_summaries USING btree (session_id)
    WHERE ((status)::text = 'active'::text);

CREATE TABLE public.messages (
    id character varying(36) NOT NULL,
    space_id character varying(36) NOT NULL,
    session_id character varying(36) NOT NULL,
    user_id character varying(36),
    sender_agent_id character varying(36),
    role character varying(32) NOT NULL,
    content text NOT NULL,
    metadata_json jsonb,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT messages_pkey PRIMARY KEY (id),
    CONSTRAINT ck_messages_role CHECK (
        ((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying, 'system'::character varying, 'tool'::character varying])::text[]))
    )
);

CREATE UNIQUE INDEX uq_messages_assistant_run
    ON public.messages USING btree (space_id, (metadata_json->>'run_id'))
    WHERE role = 'assistant' AND metadata_json->>'run_id' IS NOT NULL;
