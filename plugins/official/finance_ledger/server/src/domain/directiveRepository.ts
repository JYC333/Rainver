import type { Queryable } from "@rainver/protocol";
import type { DirectiveStatus } from "./directives.js";

export interface FinanceImportSourceRow {
  id: string;
  book_id: string;
  space_id: string;
  source_type: string;
  source_name: string | null;
  content_hash: string | null;
  imported_by_user_id: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface FinanceExportRow {
  id: string;
  book_id: string;
  space_id: string;
  export_format: string;
  status: string;
  content_hash: string | null;
  artifact_id: string | null;
  validation_summary_json: Record<string, unknown>;
  created_by_user_id: string;
  created_at: string;
}

export interface FinanceLedgerOptionRow {
  name: string;
  value_json: Record<string, unknown>;
  source: string;
}

interface DirectiveJoinRow {
  directive_id: string;
  date: string;
  sequence: number;
  status: DirectiveStatus;
  source_lineno: number | null;
  metadata_json: Record<string, unknown>;
}

export interface BalanceAssertionJoinRow extends DirectiveJoinRow {
  account_name: string;
  amount_text: string;
  commodity_symbol: string;
  tolerance_text: string | null;
}

export interface PadJoinRow extends DirectiveJoinRow {
  account_name: string;
  source_account_name: string;
}

export interface PriceJoinRow extends DirectiveJoinRow {
  commodity_symbol: string;
  amount_text: string;
  price_commodity_symbol: string;
}

export interface NoteJoinRow extends DirectiveJoinRow {
  account_name: string;
  comment: string;
  tags: string[];
  links: string[];
}

export interface EventJoinRow extends DirectiveJoinRow {
  event_type: string;
  description: string;
}

export interface QueryJoinRow extends DirectiveJoinRow {
  name: string;
  query_string: string;
}

export interface DocumentJoinRow extends DirectiveJoinRow {
  account_name: string;
  filename: string;
  tags: string[];
  links: string[];
}

export interface CustomJoinRow extends DirectiveJoinRow {
  custom_type: string;
  values: string[];
}

export interface IncludeRow {
  path: string;
  sort_order: number;
}

export interface PluginDirectiveRow {
  module: string;
  config: string | null;
  sort_order: number;
}

export interface TagStackEventRow {
  event_type: "push" | "pop";
  tag: string;
  sort_order: number;
}

export interface MetaStackEventRow {
  event_type: "push" | "pop";
  key: string;
  value_json: Record<string, unknown> | null;
  sort_order: number;
}

const DIRECTIVE_JOIN = `
    JOIN finance_directives d ON d.id = x.directive_id`;

function directiveColumns(): string {
  return `x.directive_id, d.date::text, d.sequence, d.status, d.source_lineno, d.metadata_json`;
}

function statusCondition(params: unknown[], status?: DirectiveStatus): string {
  if (!status) return "";
  params.push(status);
  return ` AND d.status = $${params.length}`;
}

export const financeDirectiveRepository = {
  // ── Import sources and exports ────────────────────────────────────────────

  async insertImportSource(
    db: Queryable,
    input: {
      spaceId: string;
      bookId: string;
      sourceType: string;
      sourceName?: string | null;
      contentHash?: string | null;
      importedByUserId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<FinanceImportSourceRow> {
    const result = await db.query<FinanceImportSourceRow>(
      `INSERT INTO finance_import_sources
         (space_id, book_id, source_type, source_name, content_hash, imported_by_user_id, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, book_id, space_id, source_type, source_name, content_hash,
                 imported_by_user_id, metadata_json, created_at::text`,
      [
        input.spaceId,
        input.bookId,
        input.sourceType,
        input.sourceName ?? null,
        input.contentHash ?? null,
        input.importedByUserId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async findImportSourceByHash(
    db: Queryable,
    spaceId: string,
    bookId: string,
    contentHash: string,
  ): Promise<FinanceImportSourceRow | null> {
    const result = await db.query<FinanceImportSourceRow>(
      `SELECT id, book_id, space_id, source_type, source_name, content_hash,
              imported_by_user_id, metadata_json, created_at::text
         FROM finance_import_sources
        WHERE space_id = $1 AND book_id = $2 AND content_hash = $3
        ORDER BY created_at ASC
        LIMIT 1`,
      [spaceId, bookId, contentHash],
    );
    return result.rows[0] ?? null;
  },

  async insertExport(
    db: Queryable,
    input: {
      spaceId: string;
      bookId: string;
      exportFormat: "beancount";
      status: "created" | "failed";
      contentHash?: string | null;
      validationSummary?: Record<string, unknown>;
      createdByUserId: string;
    },
  ): Promise<FinanceExportRow> {
    const result = await db.query<FinanceExportRow>(
      `INSERT INTO finance_exports
         (space_id, book_id, export_format, status, content_hash, validation_summary_json, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, book_id, space_id, export_format, status, content_hash, artifact_id,
                 validation_summary_json, created_by_user_id, created_at::text`,
      [
        input.spaceId,
        input.bookId,
        input.exportFormat,
        input.status,
        input.contentHash ?? null,
        JSON.stringify(input.validationSummary ?? {}),
        input.createdByUserId,
      ],
    );
    return result.rows[0]!;
  },

  // ── Ledger options ────────────────────────────────────────────────────────

  async listLedgerOptions(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<FinanceLedgerOptionRow[]> {
    const result = await db.query<FinanceLedgerOptionRow>(
      `SELECT name, value_json, source
         FROM finance_ledger_options
        WHERE space_id = $1 AND book_id = $2
        ORDER BY name ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },

  // ── Directive child tables: inserts ───────────────────────────────────────

  async insertBalanceAssertion(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      accountId: string;
      accountName: string;
      amountText: string;
      amountScale: number;
      commodityId: string;
      commoditySymbol: string;
      toleranceText?: string | null;
      toleranceScale?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_balance_assertions
         (directive_id, book_id, space_id, account_id, account_name, amount_numeric,
          amount_text, amount_scale, commodity_id, commodity_symbol, tolerance_numeric,
          tolerance_text, tolerance_scale)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $6, $7, $8, $9, $10::numeric, $10, $11)`,
      [
        input.directiveId,
        input.bookId,
        input.spaceId,
        input.accountId,
        input.accountName,
        input.amountText,
        input.amountScale,
        input.commodityId,
        input.commoditySymbol,
        input.toleranceText ?? null,
        input.toleranceScale ?? null,
      ],
    );
  },

  async insertPad(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      accountId: string;
      accountName: string;
      sourceAccountId: string;
      sourceAccountName: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_pad_directives
         (directive_id, book_id, space_id, account_id, account_name, source_account_id, source_account_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.directiveId,
        input.bookId,
        input.spaceId,
        input.accountId,
        input.accountName,
        input.sourceAccountId,
        input.sourceAccountName,
      ],
    );
  },

  async insertPrice(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      commodityId: string;
      commoditySymbol: string;
      amountText: string;
      amountScale: number;
      priceCommodityId: string;
      priceCommoditySymbol: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_prices
         (directive_id, book_id, space_id, commodity_id, commodity_symbol,
          amount_numeric, amount_text, amount_scale, price_commodity_id, price_commodity_symbol)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $6, $7, $8, $9)`,
      [
        input.directiveId,
        input.bookId,
        input.spaceId,
        input.commodityId,
        input.commoditySymbol,
        input.amountText,
        input.amountScale,
        input.priceCommodityId,
        input.priceCommoditySymbol,
      ],
    );
  },

  async insertNote(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      accountId: string;
      accountName: string;
      comment: string;
      tags?: string[];
      links?: string[];
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_notes
         (directive_id, book_id, space_id, account_id, account_name, comment, tags, links)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.directiveId,
        input.bookId,
        input.spaceId,
        input.accountId,
        input.accountName,
        input.comment,
        input.tags ?? [],
        input.links ?? [],
      ],
    );
  },

  async insertEvent(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      eventType: string;
      description: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_events (directive_id, book_id, space_id, event_type, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.directiveId, input.bookId, input.spaceId, input.eventType, input.description],
    );
  },

  async insertQuery(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      name: string;
      queryString: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_queries (directive_id, book_id, space_id, name, query_string)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.directiveId, input.bookId, input.spaceId, input.name, input.queryString],
    );
  },

  async insertDocument(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      accountId: string;
      accountName: string;
      filename: string;
      tags?: string[];
      links?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_documents
         (directive_id, book_id, space_id, account_id, account_name, filename, tags, links, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        input.directiveId,
        input.bookId,
        input.spaceId,
        input.accountId,
        input.accountName,
        input.filename,
        input.tags ?? [],
        input.links ?? [],
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  },

  async insertCustom(
    db: Queryable,
    input: {
      directiveId: string;
      spaceId: string;
      bookId: string;
      customType: string;
      values: string[];
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_custom_directives (directive_id, book_id, space_id, custom_type)
       VALUES ($1, $2, $3, $4)`,
      [input.directiveId, input.bookId, input.spaceId, input.customType],
    );
    for (let index = 0; index < input.values.length; index += 1) {
      await db.query(
        `INSERT INTO finance_custom_directive_values
           (directive_id, book_id, space_id, value_type, value_json, sort_order)
         VALUES ($1, $2, $3, 'string', $4::jsonb, $5)`,
        [
          input.directiveId,
          input.bookId,
          input.spaceId,
          JSON.stringify({ value: input.values[index] }),
          index,
        ],
      );
    }
  },

  // ── Book-level config directives ──────────────────────────────────────────

  async insertInclude(
    db: Queryable,
    input: { spaceId: string; bookId: string; path: string; sortOrder: number },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_includes (book_id, space_id, path, sort_order)
       VALUES ($1, $2, $3, $4)`,
      [input.bookId, input.spaceId, input.path, input.sortOrder],
    );
  },

  async insertPluginDirective(
    db: Queryable,
    input: { spaceId: string; bookId: string; module: string; config?: string | null; sortOrder: number },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_plugin_directives (book_id, space_id, module, config, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.bookId, input.spaceId, input.module, input.config ?? null, input.sortOrder],
    );
  },

  async insertTagStackEvent(
    db: Queryable,
    input: {
      spaceId: string;
      bookId: string;
      eventType: "push" | "pop";
      tag: string;
      sortOrder: number;
      sourceLineno?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_tag_stack_events (book_id, space_id, event_type, tag, sort_order, source_lineno)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.bookId, input.spaceId, input.eventType, input.tag, input.sortOrder, input.sourceLineno ?? null],
    );
  },

  async insertMetaStackEvent(
    db: Queryable,
    input: {
      spaceId: string;
      bookId: string;
      eventType: "push" | "pop";
      key: string;
      value?: string | null;
      sortOrder: number;
      sourceLineno?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_meta_stack_events (book_id, space_id, event_type, key, value_json, sort_order, source_lineno)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        input.bookId,
        input.spaceId,
        input.eventType,
        input.key,
        input.value == null ? null : JSON.stringify({ value: input.value }),
        input.sortOrder,
        input.sourceLineno ?? null,
      ],
    );
  },

  // ── Directive child tables: reads for export ──────────────────────────────

  async listBalanceAssertions(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<BalanceAssertionJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<BalanceAssertionJoinRow>(
      `SELECT ${directiveColumns()}, x.account_name, x.amount_text, x.commodity_symbol, x.tolerance_text
         FROM finance_balance_assertions x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listPads(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<PadJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<PadJoinRow>(
      `SELECT ${directiveColumns()}, x.account_name, x.source_account_name
         FROM finance_pad_directives x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listPrices(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<PriceJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<PriceJoinRow>(
      `SELECT ${directiveColumns()}, x.commodity_symbol, x.amount_text, x.price_commodity_symbol
         FROM finance_prices x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listNotes(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<NoteJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<NoteJoinRow>(
      `SELECT ${directiveColumns()}, x.account_name, x.comment, x.tags, x.links
         FROM finance_notes x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listEvents(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<EventJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<EventJoinRow>(
      `SELECT ${directiveColumns()}, x.event_type, x.description
         FROM finance_events x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listQueries(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<QueryJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<QueryJoinRow>(
      `SELECT ${directiveColumns()}, x.name, x.query_string
         FROM finance_queries x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listDocuments(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<DocumentJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<DocumentJoinRow>(
      `SELECT ${directiveColumns()}, x.account_name, x.filename, x.tags, x.links
         FROM finance_documents x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listCustoms(
    db: Queryable,
    spaceId: string,
    bookId: string,
    status?: DirectiveStatus,
  ): Promise<CustomJoinRow[]> {
    const params: unknown[] = [spaceId, bookId];
    const result = await db.query<CustomJoinRow>(
      `SELECT ${directiveColumns()}, x.custom_type,
              COALESCE(
                (SELECT array_agg(v.value_json->>'value' ORDER BY v.sort_order)
                   FROM finance_custom_directive_values v
                  WHERE v.directive_id = x.directive_id),
                ARRAY[]::text[]
              ) AS "values"
         FROM finance_custom_directives x${DIRECTIVE_JOIN}
        WHERE x.space_id = $1 AND x.book_id = $2${statusCondition(params, status)}
        ORDER BY d.date ASC, d.sequence ASC`,
      params,
    );
    return result.rows;
  },

  async listIncludes(db: Queryable, spaceId: string, bookId: string): Promise<IncludeRow[]> {
    const result = await db.query<IncludeRow>(
      `SELECT path, sort_order
         FROM finance_includes
        WHERE space_id = $1 AND book_id = $2
        ORDER BY sort_order ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },

  async listPluginDirectives(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<PluginDirectiveRow[]> {
    const result = await db.query<PluginDirectiveRow>(
      `SELECT module, config, sort_order
         FROM finance_plugin_directives
        WHERE space_id = $1 AND book_id = $2
        ORDER BY sort_order ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },

  async listTagStackEvents(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<TagStackEventRow[]> {
    const result = await db.query<TagStackEventRow>(
      `SELECT event_type, tag, sort_order
         FROM finance_tag_stack_events
        WHERE space_id = $1 AND book_id = $2
        ORDER BY sort_order ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },

  async listMetaStackEvents(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<MetaStackEventRow[]> {
    const result = await db.query<MetaStackEventRow>(
      `SELECT event_type, key, value_json, sort_order
         FROM finance_meta_stack_events
        WHERE space_id = $1 AND book_id = $2
        ORDER BY sort_order ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },
};
