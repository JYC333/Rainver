CREATE TABLE "plugin_finance_ledger".finance_books (
    id                  character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    space_id            character varying(36)    NOT NULL,
    name                text                     NOT NULL,
    base_currency       character varying(64)    NOT NULL,
    operating_currency  character varying(64)    NOT NULL,
    status              character varying(32)    NOT NULL DEFAULT 'active',
    created_by_user_id  character varying(36)    NOT NULL,
    metadata_json       jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),
    updated_at          timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_books_pkey PRIMARY KEY (id),
    CONSTRAINT finance_books_space_id_nonempty CHECK (length(trim(space_id::text)) > 0),
    CONSTRAINT finance_books_name_nonempty CHECK (length(trim(name)) > 0),
    CONSTRAINT finance_books_status_valid CHECK (status IN ('active', 'archived')),
    CONSTRAINT finance_books_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_account_groups (
    id            character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    name          text                  NOT NULL,
    root_type     character varying(32) NOT NULL,
    sort_order    integer               NOT NULL DEFAULT 0,
    metadata_json jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT finance_account_groups_pkey PRIMARY KEY (id),
    CONSTRAINT finance_account_groups_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_account_groups_root_type_valid CHECK (root_type IN ('assets', 'liabilities', 'equity', 'income', 'expenses')),
    CONSTRAINT finance_account_groups_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_ledger_options (
    id            character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    book_id       character varying(36)    NOT NULL,
    space_id      character varying(36)    NOT NULL,
    name          text                     NOT NULL,
    value_json    jsonb                    NOT NULL,
    source        character varying(32)    NOT NULL DEFAULT 'manual',
    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    updated_at    timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_ledger_options_pkey PRIMARY KEY (id),
    CONSTRAINT finance_ledger_options_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_ledger_options_name_nonempty CHECK (length(trim(name)) > 0),
    CONSTRAINT finance_ledger_options_value_is_object CHECK (jsonb_typeof(value_json) = 'object'),
    CONSTRAINT finance_ledger_options_unique UNIQUE (book_id, name)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_commodities (
    id                  character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    book_id             character varying(36)    NOT NULL,
    space_id            character varying(36)    NOT NULL,
    symbol              character varying(64)    NOT NULL,
    commodity_type      character varying(32)    NOT NULL DEFAULT 'custom',
    name                text,
    precision           integer,
    display_precision   integer,
    metadata_json       jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),
    updated_at          timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_commodities_pkey PRIMARY KEY (id),
    CONSTRAINT finance_commodities_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_commodities_symbol_valid CHECK (symbol ~ '^[A-Z][A-Z0-9_-]*$'),
    CONSTRAINT finance_commodities_type_valid CHECK (commodity_type IN ('currency', 'security', 'crypto', 'custom')),
    CONSTRAINT finance_commodities_precision_valid CHECK (precision IS NULL OR precision >= 0),
    CONSTRAINT finance_commodities_display_precision_valid CHECK (display_precision IS NULL OR display_precision >= 0),
    CONSTRAINT finance_commodities_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object'),
    CONSTRAINT finance_commodities_book_symbol_unique UNIQUE (book_id, symbol)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_import_sources (
    id              character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    book_id         character varying(36)    NOT NULL,
    space_id        character varying(36)    NOT NULL,
    source_type     character varying(32)    NOT NULL,
    source_name     text,
    content_hash    text,
    imported_by_user_id character varying(36),
    metadata_json   jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_import_sources_pkey PRIMARY KEY (id),
    CONSTRAINT finance_import_sources_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_import_sources_type_nonempty CHECK (length(trim(source_type)) > 0),
    CONSTRAINT finance_import_sources_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_accounts (
    id                      character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    book_id                 character varying(36)    NOT NULL,
    space_id                character varying(36)    NOT NULL,
    name                    text                     NOT NULL,
    display_name            text,
    root_type               character varying(32)    NOT NULL,
    parent_account_id       character varying(36),
    commodity_constraints   text[],
    opened_at               date                     NOT NULL,
    closed_at               date,
    booking_method          character varying(32),
    account_role            character varying(64),
    default_commodity       character varying(64),
    owner_user_id           character varying(36),
    visibility              character varying(16)    NOT NULL DEFAULT 'space',
    metadata_json           jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamp with time zone NOT NULL DEFAULT now(),
    updated_at              timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_accounts_pkey PRIMARY KEY (id),
    CONSTRAINT finance_accounts_visibility_valid CHECK (visibility IN ('space', 'private')),
    CONSTRAINT finance_accounts_private_requires_owner CHECK (visibility = 'space' OR owner_user_id IS NOT NULL),
    CONSTRAINT finance_accounts_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_accounts_parent_fkey FOREIGN KEY (parent_account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE SET NULL,
    CONSTRAINT finance_accounts_name_nonempty CHECK (length(trim(name)) > 0),
    CONSTRAINT finance_accounts_root_type_valid CHECK (root_type IN ('assets', 'liabilities', 'equity', 'income', 'expenses')),
    CONSTRAINT finance_accounts_booking_method_valid CHECK (
        booking_method IS NULL OR booking_method IN ('STRICT', 'STRICT_WITH_SIZE', 'NONE', 'AVERAGE', 'FIFO', 'LIFO', 'HIFO')
    ),
    CONSTRAINT finance_accounts_closed_after_open CHECK (closed_at IS NULL OR closed_at >= opened_at),
    CONSTRAINT finance_accounts_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object'),
    CONSTRAINT finance_accounts_book_name_unique UNIQUE (book_id, name)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_directives (
    id                  character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    book_id             character varying(36)    NOT NULL,
    space_id            character varying(36)    NOT NULL,
    directive_type      character varying(32)    NOT NULL,
    date                date                     NOT NULL,
    sequence            integer                  NOT NULL DEFAULT 0,
    status              character varying(32)    NOT NULL DEFAULT 'draft',
    source_activity_id  character varying(36),
    proposal_id         character varying(36),
    import_source_id    character varying(36),
    source_filename     text,
    source_lineno       integer,
    source_hash         text,
    metadata_json       jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id  character varying(36)    NOT NULL,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),
    updated_at          timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_directives_pkey PRIMARY KEY (id),
    CONSTRAINT finance_directives_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_directives_import_source_fkey FOREIGN KEY (import_source_id)
        REFERENCES "plugin_finance_ledger".finance_import_sources(id) ON DELETE SET NULL,
    CONSTRAINT finance_directives_type_valid CHECK (directive_type IN ('open', 'close', 'commodity', 'pad', 'balance', 'transaction', 'note', 'event', 'query', 'price', 'document', 'custom')),
    CONSTRAINT finance_directives_status_valid CHECK (status IN ('draft', 'proposed', 'posted', 'voided')),
    CONSTRAINT finance_directives_source_lineno_valid CHECK (source_lineno IS NULL OR source_lineno > 0),
    CONSTRAINT finance_directives_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object'),
    CONSTRAINT finance_directives_book_date_sequence_unique UNIQUE (book_id, date, sequence)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_directive_metadata (
    id             character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    directive_id   character varying(36) NOT NULL,
    book_id        character varying(36) NOT NULL,
    space_id       character varying(36) NOT NULL,
    key            text                  NOT NULL,
    value_type     character varying(32) NOT NULL,
    value_json     jsonb                 NOT NULL,
    sort_order     integer               NOT NULL DEFAULT 0,
    CONSTRAINT finance_directive_metadata_pkey PRIMARY KEY (id),
    CONSTRAINT finance_directive_metadata_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_directive_metadata_key_nonempty CHECK (length(trim(key)) > 0),
    CONSTRAINT finance_directive_metadata_value_is_object CHECK (jsonb_typeof(value_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_transactions (
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    flag          character varying(16) NOT NULL DEFAULT '*',
    payee         text,
    narration     text,
    external_id   text,
    import_hash   text,
    tags          text[]                NOT NULL DEFAULT ARRAY[]::text[],
    links         text[]                NOT NULL DEFAULT ARRAY[]::text[],
    metadata_json jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT finance_transactions_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_transactions_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_transactions_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_postings (
    id                         character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    transaction_directive_id   character varying(36) NOT NULL,
    book_id                    character varying(36) NOT NULL,
    space_id                   character varying(36) NOT NULL,
    account_id                 character varying(36) NOT NULL,
    account_name               text                  NOT NULL,
    amount_numeric             numeric,
    amount_text                text,
    amount_scale               integer,
    commodity_id               character varying(36),
    commodity_symbol           character varying(64),
    cost_number_numeric        numeric,
    cost_number_text           text,
    cost_number_scale          integer,
    cost_number_total_numeric  numeric,
    cost_number_total_text     text,
    cost_number_total_scale    integer,
    cost_currency              character varying(64),
    cost_date                  date,
    cost_label                 text,
    cost_merge                 boolean,
    price_number_numeric       numeric,
    price_number_text          text,
    price_number_scale         integer,
    price_commodity_id         character varying(36),
    price_commodity_symbol     character varying(64),
    price_is_total             boolean               NOT NULL DEFAULT false,
    flag                       character varying(16),
    sort_order                 integer               NOT NULL DEFAULT 0,
    metadata_json              jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT finance_postings_pkey PRIMARY KEY (id),
    CONSTRAINT finance_postings_transaction_fkey FOREIGN KEY (transaction_directive_id)
        REFERENCES "plugin_finance_ledger".finance_transactions(directive_id) ON DELETE CASCADE,
    CONSTRAINT finance_postings_account_fkey FOREIGN KEY (account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT finance_postings_commodity_fkey FOREIGN KEY (commodity_id)
        REFERENCES "plugin_finance_ledger".finance_commodities(id) ON DELETE RESTRICT,
    CONSTRAINT finance_postings_price_commodity_fkey FOREIGN KEY (price_commodity_id)
        REFERENCES "plugin_finance_ledger".finance_commodities(id) ON DELETE RESTRICT,
    CONSTRAINT finance_postings_amount_scale_valid CHECK (amount_scale IS NULL OR amount_scale >= 0),
    CONSTRAINT finance_postings_cost_scale_valid CHECK (cost_number_scale IS NULL OR cost_number_scale >= 0),
    CONSTRAINT finance_postings_cost_total_scale_valid CHECK (cost_number_total_scale IS NULL OR cost_number_total_scale >= 0),
    CONSTRAINT finance_postings_price_scale_valid CHECK (price_number_scale IS NULL OR price_number_scale >= 0),
    CONSTRAINT finance_postings_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_posting_metadata (
    id          character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    posting_id  character varying(36) NOT NULL,
    book_id     character varying(36) NOT NULL,
    space_id    character varying(36) NOT NULL,
    key         text                  NOT NULL,
    value_type  character varying(32) NOT NULL,
    value_json  jsonb                 NOT NULL,
    sort_order  integer               NOT NULL DEFAULT 0,
    CONSTRAINT finance_posting_metadata_pkey PRIMARY KEY (id),
    CONSTRAINT finance_posting_metadata_posting_fkey FOREIGN KEY (posting_id)
        REFERENCES "plugin_finance_ledger".finance_postings(id) ON DELETE CASCADE,
    CONSTRAINT finance_posting_metadata_key_nonempty CHECK (length(trim(key)) > 0),
    CONSTRAINT finance_posting_metadata_value_is_object CHECK (jsonb_typeof(value_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_balance_assertions (
    directive_id      character varying(36) NOT NULL,
    book_id           character varying(36) NOT NULL,
    space_id          character varying(36) NOT NULL,
    account_id        character varying(36) NOT NULL,
    account_name      text                  NOT NULL,
    amount_numeric    numeric               NOT NULL,
    amount_text       text                  NOT NULL,
    amount_scale      integer               NOT NULL DEFAULT 0,
    commodity_id      character varying(36) NOT NULL,
    commodity_symbol  character varying(64) NOT NULL,
    tolerance_numeric numeric,
    tolerance_text    text,
    tolerance_scale   integer,
    CONSTRAINT finance_balance_assertions_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_balance_assertions_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_balance_assertions_account_fkey FOREIGN KEY (account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT finance_balance_assertions_commodity_fkey FOREIGN KEY (commodity_id)
        REFERENCES "plugin_finance_ledger".finance_commodities(id) ON DELETE RESTRICT,
    CONSTRAINT finance_balance_assertions_scale_valid CHECK (amount_scale >= 0),
    CONSTRAINT finance_balance_assertions_tolerance_scale_valid CHECK (tolerance_scale IS NULL OR tolerance_scale >= 0)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_prices (
    directive_id            character varying(36) NOT NULL,
    book_id                 character varying(36) NOT NULL,
    space_id                character varying(36) NOT NULL,
    commodity_id            character varying(36) NOT NULL,
    commodity_symbol        character varying(64) NOT NULL,
    amount_numeric          numeric               NOT NULL,
    amount_text             text                  NOT NULL,
    amount_scale            integer               NOT NULL DEFAULT 0,
    price_commodity_id      character varying(36) NOT NULL,
    price_commodity_symbol  character varying(64) NOT NULL,
    CONSTRAINT finance_prices_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_prices_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_prices_commodity_fkey FOREIGN KEY (commodity_id)
        REFERENCES "plugin_finance_ledger".finance_commodities(id) ON DELETE RESTRICT,
    CONSTRAINT finance_prices_price_commodity_fkey FOREIGN KEY (price_commodity_id)
        REFERENCES "plugin_finance_ledger".finance_commodities(id) ON DELETE RESTRICT,
    CONSTRAINT finance_prices_amount_scale_valid CHECK (amount_scale >= 0)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_pad_directives (
    directive_id       character varying(36) NOT NULL,
    book_id            character varying(36) NOT NULL,
    space_id           character varying(36) NOT NULL,
    account_id         character varying(36) NOT NULL,
    account_name       text                  NOT NULL,
    source_account_id  character varying(36) NOT NULL,
    source_account_name text                 NOT NULL,
    CONSTRAINT finance_pad_directives_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_pad_directives_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_pad_directives_account_fkey FOREIGN KEY (account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT finance_pad_directives_source_account_fkey FOREIGN KEY (source_account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE RESTRICT
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_notes (
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    account_id    character varying(36) NOT NULL,
    account_name  text                  NOT NULL,
    comment       text                  NOT NULL,
    tags          text[]                NOT NULL DEFAULT ARRAY[]::text[],
    links         text[]                NOT NULL DEFAULT ARRAY[]::text[],
    CONSTRAINT finance_notes_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_notes_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_notes_account_fkey FOREIGN KEY (account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE RESTRICT
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_events (
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    event_type    text                  NOT NULL,
    description   text                  NOT NULL,
    CONSTRAINT finance_events_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_events_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_events_type_nonempty CHECK (length(trim(event_type)) > 0)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_queries (
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    name          text                  NOT NULL,
    query_string  text                  NOT NULL,
    CONSTRAINT finance_queries_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_queries_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_queries_name_nonempty CHECK (length(trim(name)) > 0)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_documents (
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    account_id    character varying(36) NOT NULL,
    account_name  text                  NOT NULL,
    filename      text                  NOT NULL,
    artifact_id   character varying(36),
    tags          text[]                NOT NULL DEFAULT ARRAY[]::text[],
    links         text[]                NOT NULL DEFAULT ARRAY[]::text[],
    metadata_json jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT finance_documents_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_documents_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_documents_account_fkey FOREIGN KEY (account_id)
        REFERENCES "plugin_finance_ledger".finance_accounts(id) ON DELETE RESTRICT,
    CONSTRAINT finance_documents_filename_nonempty CHECK (length(trim(filename)) > 0),
    CONSTRAINT finance_documents_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_custom_directives (
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    custom_type   text                  NOT NULL,
    CONSTRAINT finance_custom_directives_pkey PRIMARY KEY (directive_id),
    CONSTRAINT finance_custom_directives_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE CASCADE,
    CONSTRAINT finance_custom_directives_type_nonempty CHECK (length(trim(custom_type)) > 0)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_custom_directive_values (
    id            character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    directive_id  character varying(36) NOT NULL,
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    value_type    character varying(32) NOT NULL,
    value_json    jsonb                 NOT NULL,
    sort_order    integer               NOT NULL DEFAULT 0,
    CONSTRAINT finance_custom_directive_values_pkey PRIMARY KEY (id),
    CONSTRAINT finance_custom_directive_values_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_custom_directives(directive_id) ON DELETE CASCADE,
    CONSTRAINT finance_custom_directive_values_value_is_object CHECK (jsonb_typeof(value_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_includes (
    id            character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    path          text                  NOT NULL,
    sort_order    integer               NOT NULL DEFAULT 0,
    metadata_json jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT finance_includes_pkey PRIMARY KEY (id),
    CONSTRAINT finance_includes_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_includes_path_nonempty CHECK (length(trim(path)) > 0),
    CONSTRAINT finance_includes_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_plugin_directives (
    id            character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    book_id       character varying(36) NOT NULL,
    space_id      character varying(36) NOT NULL,
    module        text                  NOT NULL,
    config        text,
    sort_order    integer               NOT NULL DEFAULT 0,
    metadata_json jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT finance_plugin_directives_pkey PRIMARY KEY (id),
    CONSTRAINT finance_plugin_directives_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_plugin_directives_module_nonempty CHECK (length(trim(module)) > 0),
    CONSTRAINT finance_plugin_directives_metadata_is_object CHECK (jsonb_typeof(metadata_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_tag_stack_events (
    id          character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    book_id     character varying(36) NOT NULL,
    space_id    character varying(36) NOT NULL,
    event_type  character varying(16) NOT NULL,
    tag         text                  NOT NULL,
    sort_order  integer               NOT NULL DEFAULT 0,
    source_filename text,
    source_lineno integer,
    CONSTRAINT finance_tag_stack_events_pkey PRIMARY KEY (id),
    CONSTRAINT finance_tag_stack_events_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_tag_stack_events_type_valid CHECK (event_type IN ('push', 'pop')),
    CONSTRAINT finance_tag_stack_events_tag_nonempty CHECK (length(trim(tag)) > 0)
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_meta_stack_events (
    id          character varying(36) NOT NULL DEFAULT gen_random_uuid(),
    book_id     character varying(36) NOT NULL,
    space_id    character varying(36) NOT NULL,
    event_type  character varying(16) NOT NULL,
    key         text                  NOT NULL,
    value_json  jsonb,
    sort_order  integer               NOT NULL DEFAULT 0,
    source_filename text,
    source_lineno integer,
    CONSTRAINT finance_meta_stack_events_pkey PRIMARY KEY (id),
    CONSTRAINT finance_meta_stack_events_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_meta_stack_events_type_valid CHECK (event_type IN ('push', 'pop')),
    CONSTRAINT finance_meta_stack_events_key_nonempty CHECK (length(trim(key)) > 0),
    CONSTRAINT finance_meta_stack_events_value_is_object CHECK (value_json IS NULL OR jsonb_typeof(value_json) = 'object')
)
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_exports (
    id                      character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    book_id                 character varying(36)    NOT NULL,
    space_id                character varying(36)    NOT NULL,
    export_format           character varying(32)    NOT NULL,
    status                  character varying(32)    NOT NULL DEFAULT 'created',
    content_hash            text,
    artifact_id             character varying(36),
    validation_summary_json jsonb                    NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id      character varying(36)    NOT NULL,
    created_at              timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT finance_exports_pkey PRIMARY KEY (id),
    CONSTRAINT finance_exports_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_exports_format_valid CHECK (export_format IN ('beancount')),
    CONSTRAINT finance_exports_status_valid CHECK (status IN ('created', 'failed')),
    CONSTRAINT finance_exports_validation_is_object CHECK (jsonb_typeof(validation_summary_json) = 'object')
)
--> statement-breakpoint
CREATE INDEX finance_books_space_idx ON "plugin_finance_ledger".finance_books USING btree (space_id)
--> statement-breakpoint
CREATE INDEX finance_account_groups_book_idx ON "plugin_finance_ledger".finance_account_groups USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_ledger_options_book_idx ON "plugin_finance_ledger".finance_ledger_options USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_commodities_book_idx ON "plugin_finance_ledger".finance_commodities USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_import_sources_book_idx ON "plugin_finance_ledger".finance_import_sources USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_accounts_book_idx ON "plugin_finance_ledger".finance_accounts USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_accounts_parent_idx ON "plugin_finance_ledger".finance_accounts USING btree (parent_account_id)
--> statement-breakpoint
CREATE INDEX finance_accounts_owner_idx ON "plugin_finance_ledger".finance_accounts USING btree (book_id, owner_user_id)
--> statement-breakpoint
CREATE INDEX finance_directives_book_date_idx ON "plugin_finance_ledger".finance_directives USING btree (book_id, date, sequence)
--> statement-breakpoint
CREATE INDEX finance_directives_status_idx ON "plugin_finance_ledger".finance_directives USING btree (book_id, status)
--> statement-breakpoint
CREATE INDEX finance_transactions_external_idx ON "plugin_finance_ledger".finance_transactions USING btree (book_id, external_id) WHERE external_id IS NOT NULL
--> statement-breakpoint
CREATE INDEX finance_transactions_tags_idx ON "plugin_finance_ledger".finance_transactions USING gin (tags)
--> statement-breakpoint
CREATE INDEX finance_transactions_links_idx ON "plugin_finance_ledger".finance_transactions USING gin (links)
--> statement-breakpoint
CREATE INDEX finance_transactions_payee_idx ON "plugin_finance_ledger".finance_transactions USING btree (book_id, payee) WHERE payee IS NOT NULL
--> statement-breakpoint
CREATE INDEX finance_directives_import_source_idx ON "plugin_finance_ledger".finance_directives USING btree (import_source_id) WHERE import_source_id IS NOT NULL
--> statement-breakpoint
CREATE INDEX finance_postings_transaction_idx ON "plugin_finance_ledger".finance_postings USING btree (transaction_directive_id, sort_order)
--> statement-breakpoint
CREATE INDEX finance_postings_account_idx ON "plugin_finance_ledger".finance_postings USING btree (account_id)
--> statement-breakpoint
CREATE INDEX finance_balance_assertions_account_idx ON "plugin_finance_ledger".finance_balance_assertions USING btree (account_id)
--> statement-breakpoint
CREATE INDEX finance_prices_pair_idx ON "plugin_finance_ledger".finance_prices USING btree (book_id, commodity_symbol, price_commodity_symbol)
--> statement-breakpoint
CREATE INDEX finance_includes_book_idx ON "plugin_finance_ledger".finance_includes USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_plugin_directives_book_idx ON "plugin_finance_ledger".finance_plugin_directives USING btree (book_id)
--> statement-breakpoint
CREATE INDEX finance_tag_stack_events_book_idx ON "plugin_finance_ledger".finance_tag_stack_events USING btree (book_id, sort_order)
--> statement-breakpoint
CREATE INDEX finance_meta_stack_events_book_idx ON "plugin_finance_ledger".finance_meta_stack_events USING btree (book_id, sort_order)
--> statement-breakpoint
CREATE INDEX finance_exports_book_idx ON "plugin_finance_ledger".finance_exports USING btree (book_id, created_at DESC)
--> statement-breakpoint
ALTER TABLE "plugin_finance_ledger".finance_import_sources
    ADD COLUMN content_text text
--> statement-breakpoint
CREATE UNIQUE INDEX finance_import_sources_book_content_hash_unique
    ON "plugin_finance_ledger".finance_import_sources USING btree (book_id, content_hash)
    WHERE content_hash IS NOT NULL
--> statement-breakpoint
CREATE TABLE "plugin_finance_ledger".finance_import_entries (
    id                     character varying(36)    NOT NULL DEFAULT gen_random_uuid(),
    import_source_id       character varying(36)    NOT NULL,
    book_id                character varying(36)    NOT NULL,
    space_id               character varying(36)    NOT NULL,
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
        REFERENCES "plugin_finance_ledger".finance_import_sources(id) ON DELETE CASCADE,
    CONSTRAINT finance_import_entries_book_fkey FOREIGN KEY (book_id)
        REFERENCES "plugin_finance_ledger".finance_books(id) ON DELETE CASCADE,
    CONSTRAINT finance_import_entries_directive_fkey FOREIGN KEY (directive_id)
        REFERENCES "plugin_finance_ledger".finance_directives(id) ON DELETE SET NULL,
    CONSTRAINT finance_import_entries_duplicate_fkey FOREIGN KEY (duplicate_of_entry_id)
        REFERENCES "plugin_finance_ledger".finance_import_entries(id) ON DELETE SET NULL,
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
)
--> statement-breakpoint
CREATE UNIQUE INDEX finance_import_entries_directive_unique
    ON "plugin_finance_ledger".finance_import_entries USING btree (directive_id)
    WHERE directive_id IS NOT NULL
--> statement-breakpoint
CREATE INDEX finance_import_entries_book_key_idx
    ON "plugin_finance_ledger".finance_import_entries USING btree (book_id, entry_key)
--> statement-breakpoint
CREATE INDEX finance_import_entries_source_status_idx
    ON "plugin_finance_ledger".finance_import_entries USING btree (import_source_id, status)
