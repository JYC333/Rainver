-- Per-entry import state. An uploaded file is one import source; every entry
-- parsed from it is one row here with a stable identity, so a retry, a
-- mapping fix, or a re-upload of the same file finds the record it already
-- has instead of creating a second one.

ALTER TABLE public.finance_import_sources
    ADD COLUMN content_text text;

-- One batch per file content per book. The book lock serializes imports; the
-- index is what makes two concurrent uploads of one file unable to both win.
CREATE UNIQUE INDEX finance_import_sources_book_content_hash_unique
    ON public.finance_import_sources USING btree (book_id, content_hash)
    WHERE content_hash IS NOT NULL;

CREATE TABLE public.finance_import_entries (
    id                     character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    import_source_id       character varying(36)    NOT NULL,
    book_id                character varying(36)    NOT NULL,
    space_id               character varying(36)    NOT NULL,
    -- Stable identity inside the book: `external:<id>` for a transaction that
    -- carries a trusted external id, otherwise `content:<hash>:<occurrence>`.
    entry_key              text                     NOT NULL,
    identity_kind          character varying(32)    NOT NULL,
    external_id            text,
    content_hash           text                     NOT NULL,
    occurrence             integer                  NOT NULL DEFAULT 0,
    entry_type             character varying(32)    NOT NULL,
    entry_date             date,
    source_lineno          integer                  NOT NULL,
    raw_text               text                     NOT NULL,
    status                 character varying(32)    NOT NULL,
    status_reason          character varying(64),
    directive_id           character varying(36),
    duplicate_of_entry_id  character varying(36),
    missing_accounts       text[]                   NOT NULL DEFAULT ARRAY[]::text[],
    missing_commodities    text[]                   NOT NULL DEFAULT ARRAY[]::text[],
    account_mapping_json   jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    mapping_version        integer                  NOT NULL DEFAULT 0,
    errors_json            jsonb                    NOT NULL DEFAULT '[]'::jsonb,
    created_at             timestamp with time zone NOT NULL DEFAULT now(),
    updated_at             timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_import_entries_pkey PRIMARY KEY (id),
    CONSTRAINT finance_import_entries_source_fkey FOREIGN KEY (import_source_id)
        REFERENCES public.finance_import_sources(id) ON DELETE CASCADE,
    CONSTRAINT finance_import_entries_book_fkey FOREIGN KEY (book_id)
        REFERENCES public.finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_import_entries_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES public.finance_directives(id) ON DELETE SET NULL,
    CONSTRAINT finance_import_entries_duplicate_fkey FOREIGN KEY (duplicate_of_entry_id)
        REFERENCES public.finance_import_entries(id) ON DELETE SET NULL,
    CONSTRAINT finance_import_entries_space_id_nonempty CHECK (length(trim(space_id::text)) > 0),
    CONSTRAINT finance_import_entries_key_nonempty CHECK (length(trim(entry_key)) > 0),
    CONSTRAINT finance_import_entries_identity_kind_valid CHECK (identity_kind IN ('external_id', 'content_occurrence')),
    CONSTRAINT finance_import_entries_occurrence_valid CHECK (occurrence >= 0),
    CONSTRAINT finance_import_entries_lineno_valid CHECK (source_lineno > 0),
    CONSTRAINT finance_import_entries_status_valid CHECK (
        status IN ('imported', 'pending_mapping', 'needs_review', 'duplicate', 'error', 'excluded')
    ),
    CONSTRAINT finance_import_entries_imported_has_directive CHECK (
        status <> 'imported' OR directive_id IS NOT NULL
            OR entry_type IN ('include', 'plugin', 'pushtag', 'poptag', 'pushmeta', 'popmeta')
    ),
    CONSTRAINT finance_import_entries_mapping_is_object CHECK (jsonb_typeof(account_mapping_json) = 'object'),
    CONSTRAINT finance_import_entries_errors_is_array CHECK (jsonb_typeof(errors_json) = 'array'),
    CONSTRAINT finance_import_entries_source_key_unique UNIQUE (import_source_id, entry_key)
);

CREATE UNIQUE INDEX finance_import_entries_directive_unique
    ON public.finance_import_entries USING btree (directive_id)
    WHERE directive_id IS NOT NULL;
CREATE INDEX finance_import_entries_book_key_idx
    ON public.finance_import_entries USING btree (book_id, entry_key);
CREATE INDEX finance_import_entries_source_status_idx
    ON public.finance_import_entries USING btree (import_source_id, status);
