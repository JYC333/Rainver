import type { Queryable } from "@agent-space/protocol";
import type {
  AccountVisibility,
  CommodityType,
  DirectiveStatus,
  DirectiveType,
  FinanceAccountRow,
  FinanceBookRow,
  FinanceCommodityRow,
  FinanceDirectiveRow,
  FinancePostingRow,
  FinanceTransactionRow,
  RootType,
} from "./directives.js";
import type { Booking } from "./booking.js";

export interface CreateBookRecord {
  spaceId: string;
  name: string;
  baseCurrency: string;
  operatingCurrency: string;
  createdByUserId: string;
  metadata?: Record<string, unknown>;
}

export interface CreateCommodityRecord {
  spaceId: string;
  bookId: string;
  symbol: string;
  commodityType: CommodityType;
  name?: string | null;
  precision?: number | null;
  displayPrecision?: number | null;
  metadata?: Record<string, unknown>;
}

export interface OpenAccountRecord {
  spaceId: string;
  bookId: string;
  name: string;
  displayName?: string | null;
  rootType: RootType;
  parentAccountId?: string | null;
  commodityConstraints?: string[] | null;
  openedAt: string;
  bookingMethod?: Booking | null;
  accountRole?: string | null;
  defaultCommodity?: string | null;
  ownerUserId?: string | null;
  visibility?: AccountVisibility;
  metadata?: Record<string, unknown>;
}

export interface InsertDirectiveRecord {
  spaceId: string;
  bookId: string;
  directiveType: DirectiveType;
  date: string;
  sequence: number;
  status: DirectiveStatus;
  createdByUserId: string;
  proposalId?: string | null;
  importSourceId?: string | null;
  sourceFilename?: string | null;
  sourceLineno?: number | null;
  sourceHash?: string | null;
  metadata?: Record<string, unknown>;
}

export interface InsertTransactionRecord {
  spaceId: string;
  bookId: string;
  directiveId: string;
  flag: string;
  payee?: string | null;
  narration?: string | null;
  externalId?: string | null;
  importHash?: string | null;
  tags?: string[];
  links?: string[];
  metadata?: Record<string, unknown>;
}

export interface InsertPostingRecord {
  spaceId: string;
  bookId: string;
  transactionDirectiveId: string;
  accountId: string;
  accountName: string;
  amountText?: string | null;
  amountScale?: number | null;
  commodityId?: string | null;
  commoditySymbol?: string | null;
  costNumberText?: string | null;
  costNumberScale?: number | null;
  costNumberTotalText?: string | null;
  costNumberTotalScale?: number | null;
  costCurrency?: string | null;
  costDate?: string | null;
  costLabel?: string | null;
  costMerge?: boolean | null;
  priceNumberText?: string | null;
  priceNumberScale?: number | null;
  priceCommodityId?: string | null;
  priceCommoditySymbol?: string | null;
  priceIsTotal?: boolean;
  flag?: string | null;
  sortOrder: number;
  metadata?: Record<string, unknown>;
}

export const financeLedgerRepository = {
  async createBook(db: Queryable, input: CreateBookRecord): Promise<FinanceBookRow> {
    const result = await db.query<FinanceBookRow>(
      `INSERT INTO finance_books
         (space_id, name, base_currency, operating_currency, created_by_user_id, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, space_id, name, base_currency, operating_currency, status,
                 created_by_user_id, metadata_json, created_at::text, updated_at::text`,
      [
        input.spaceId,
        input.name,
        input.baseCurrency,
        input.operatingCurrency,
        input.createdByUserId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async findBook(db: Queryable, spaceId: string, bookId: string): Promise<FinanceBookRow | null> {
    const result = await db.query<FinanceBookRow>(
      `SELECT id, space_id, name, base_currency, operating_currency, status,
              created_by_user_id, metadata_json, created_at::text, updated_at::text
         FROM finance_books
        WHERE space_id = $1 AND id = $2`,
      [spaceId, bookId],
    );
    return result.rows[0] ?? null;
  },

  async listBooks(db: Queryable, spaceId: string): Promise<FinanceBookRow[]> {
    const result = await db.query<FinanceBookRow>(
      `SELECT id, space_id, name, base_currency, operating_currency, status,
              created_by_user_id, metadata_json, created_at::text, updated_at::text
         FROM finance_books
        WHERE space_id = $1
        ORDER BY created_at DESC, name ASC`,
      [spaceId],
    );
    return result.rows;
  },

  async createLedgerOption(
    db: Queryable,
    input: {
      spaceId: string;
      bookId: string;
      name: string;
      value: Record<string, unknown>;
      source?: string;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance_ledger_options (space_id, book_id, name, value_json, source)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (book_id, name) DO UPDATE
         SET value_json = EXCLUDED.value_json,
             source = EXCLUDED.source,
             updated_at = now()`,
      [
        input.spaceId,
        input.bookId,
        input.name,
        JSON.stringify(input.value),
        input.source ?? "manual",
      ],
    );
  },

  async createCommodity(
    db: Queryable,
    input: CreateCommodityRecord,
  ): Promise<FinanceCommodityRow> {
    const result = await db.query<FinanceCommodityRow>(
      `INSERT INTO finance_commodities
         (space_id, book_id, symbol, commodity_type, name, precision, display_precision, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id, book_id, space_id, symbol, commodity_type, name, precision,
                 display_precision, metadata_json, created_at::text, updated_at::text`,
      [
        input.spaceId,
        input.bookId,
        input.symbol,
        input.commodityType,
        input.name ?? null,
        input.precision ?? null,
        input.displayPrecision ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async findCommodityBySymbol(
    db: Queryable,
    spaceId: string,
    bookId: string,
    symbol: string,
  ): Promise<FinanceCommodityRow | null> {
    const result = await db.query<FinanceCommodityRow>(
      `SELECT id, book_id, space_id, symbol, commodity_type, name, precision,
              display_precision, metadata_json, created_at::text, updated_at::text
         FROM finance_commodities
        WHERE space_id = $1 AND book_id = $2 AND symbol = $3`,
      [spaceId, bookId, symbol],
    );
    return result.rows[0] ?? null;
  },

  async listCommodities(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<FinanceCommodityRow[]> {
    const result = await db.query<FinanceCommodityRow>(
      `SELECT id, book_id, space_id, symbol, commodity_type, name, precision,
              display_precision, metadata_json, created_at::text, updated_at::text
         FROM finance_commodities
        WHERE space_id = $1 AND book_id = $2
        ORDER BY symbol ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },

  async openAccount(db: Queryable, input: OpenAccountRecord): Promise<FinanceAccountRow> {
    const result = await db.query<FinanceAccountRow>(
      `INSERT INTO finance_accounts
         (space_id, book_id, name, display_name, root_type, parent_account_id,
          commodity_constraints, opened_at, booking_method, account_role,
          default_commodity, owner_user_id, visibility, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14::jsonb)
       RETURNING id, book_id, space_id, name, display_name, root_type, parent_account_id,
                 commodity_constraints, opened_at::text, closed_at::text, booking_method,
                 account_role, default_commodity, owner_user_id, visibility, metadata_json, created_at::text, updated_at::text`,
      [
        input.spaceId,
        input.bookId,
        input.name,
        input.displayName ?? null,
        input.rootType,
        input.parentAccountId ?? null,
        input.commodityConstraints ?? null,
        input.openedAt,
        input.bookingMethod ?? null,
        input.accountRole ?? null,
        input.defaultCommodity ?? null,
        input.ownerUserId ?? null,
        input.visibility ?? "space",
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async findAccountByName(
    db: Queryable,
    spaceId: string,
    bookId: string,
    name: string,
  ): Promise<FinanceAccountRow | null> {
    const result = await db.query<FinanceAccountRow>(
      `SELECT id, book_id, space_id, name, display_name, root_type, parent_account_id,
              commodity_constraints, opened_at::text, closed_at::text, booking_method,
              account_role, default_commodity, owner_user_id, visibility, metadata_json, created_at::text, updated_at::text
         FROM finance_accounts
        WHERE space_id = $1 AND book_id = $2 AND name = $3`,
      [spaceId, bookId, name],
    );
    return result.rows[0] ?? null;
  },

  async findAccount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
  ): Promise<FinanceAccountRow | null> {
    const result = await db.query<FinanceAccountRow>(
      `SELECT id, book_id, space_id, name, display_name, root_type, parent_account_id,
              commodity_constraints, opened_at::text, closed_at::text, booking_method,
              account_role, default_commodity, owner_user_id, visibility, metadata_json, created_at::text, updated_at::text
         FROM finance_accounts
        WHERE space_id = $1 AND book_id = $2 AND id = $3`,
      [spaceId, bookId, accountId],
    );
    return result.rows[0] ?? null;
  },

  async listAccounts(
    db: Queryable,
    spaceId: string,
    bookId: string,
    viewerUserId?: string,
  ): Promise<FinanceAccountRow[]> {
    // Without a viewer this is the full internal view (engine/export paths).
    // With a viewer, other members' private accounts are hidden.
    const visibilityClause = viewerUserId
      ? " AND (visibility = 'space' OR owner_user_id = $3)"
      : "";
    const params: string[] = viewerUserId
      ? [spaceId, bookId, viewerUserId]
      : [spaceId, bookId];
    const result = await db.query<FinanceAccountRow>(
      `SELECT id, book_id, space_id, name, display_name, root_type, parent_account_id,
              commodity_constraints, opened_at::text, closed_at::text, booking_method,
              account_role, default_commodity, owner_user_id, visibility, metadata_json, created_at::text, updated_at::text
         FROM finance_accounts
        WHERE space_id = $1 AND book_id = $2${visibilityClause}
        ORDER BY name ASC`,
      params,
    );
    return result.rows;
  },

  async updateAccountVisibility(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
    visibility: AccountVisibility,
  ): Promise<FinanceAccountRow> {
    const result = await db.query<FinanceAccountRow>(
      `UPDATE finance_accounts
          SET visibility = $4,
              updated_at = now()
        WHERE space_id = $1 AND book_id = $2 AND id = $3
        RETURNING id, book_id, space_id, name, display_name, root_type, parent_account_id,
                  commodity_constraints, opened_at::text, closed_at::text, booking_method,
                  account_role, default_commodity, owner_user_id, visibility, metadata_json, created_at::text, updated_at::text`,
      [spaceId, bookId, accountId, visibility],
    );
    if (!result.rows[0]) throw new Error("Account not found");
    return result.rows[0];
  },

  async closeAccount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
    date: string,
  ): Promise<FinanceAccountRow> {
    const result = await db.query<FinanceAccountRow>(
      `UPDATE finance_accounts
          SET closed_at = $4::date,
              updated_at = now()
        WHERE space_id = $1 AND book_id = $2 AND id = $3
        RETURNING id, book_id, space_id, name, display_name, root_type, parent_account_id,
                  commodity_constraints, opened_at::text, closed_at::text, booking_method,
                  account_role, default_commodity, owner_user_id, visibility, metadata_json, created_at::text, updated_at::text`,
      [spaceId, bookId, accountId, date],
    );
    if (!result.rows[0]) throw new Error("Account not found");
    return result.rows[0];
  },

  async nextSequence(
    db: Queryable,
    spaceId: string,
    bookId: string,
    date: string,
  ): Promise<number> {
    const result = await db.query<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
         FROM finance_directives
        WHERE space_id = $1 AND book_id = $2 AND date = $3::date`,
      [spaceId, bookId, date],
    );
    return result.rows[0]?.sequence ?? 0;
  },

  async insertDirective(
    db: Queryable,
    input: InsertDirectiveRecord,
  ): Promise<FinanceDirectiveRow> {
    const result = await db.query<FinanceDirectiveRow>(
      `INSERT INTO finance_directives
         (space_id, book_id, directive_type, date, sequence, status, created_by_user_id,
          proposal_id, import_source_id, source_filename, source_lineno, source_hash, metadata_json)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING id, book_id, space_id, directive_type, date::text, sequence, status,
                 source_activity_id, proposal_id, import_source_id, source_filename,
                 source_lineno, source_hash, metadata_json, created_by_user_id,
                 created_at::text, updated_at::text`,
      [
        input.spaceId,
        input.bookId,
        input.directiveType,
        input.date,
        input.sequence,
        input.status,
        input.createdByUserId,
        input.proposalId ?? null,
        input.importSourceId ?? null,
        input.sourceFilename ?? null,
        input.sourceLineno ?? null,
        input.sourceHash ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async findDirective(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
  ): Promise<FinanceDirectiveRow | null> {
    const result = await db.query<FinanceDirectiveRow>(
      `SELECT id, book_id, space_id, directive_type, date::text, sequence, status,
              source_activity_id, proposal_id, import_source_id, source_filename,
              source_lineno, source_hash, metadata_json, created_by_user_id,
              created_at::text, updated_at::text
         FROM finance_directives
        WHERE space_id = $1 AND book_id = $2 AND id = $3`,
      [spaceId, bookId, directiveId],
    );
    return result.rows[0] ?? null;
  },

  async updateDirectiveStatus(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
    status: DirectiveStatus,
  ): Promise<FinanceDirectiveRow> {
    const result = await db.query<FinanceDirectiveRow>(
      `UPDATE finance_directives
          SET status = $4,
              updated_at = now()
        WHERE space_id = $1 AND book_id = $2 AND id = $3
        RETURNING id, book_id, space_id, directive_type, date::text, sequence, status,
                  source_activity_id, proposal_id, import_source_id, source_filename,
                  source_lineno, source_hash, metadata_json, created_by_user_id,
                  created_at::text, updated_at::text`,
      [spaceId, bookId, directiveId, status],
    );
    if (!result.rows[0]) throw new Error("Directive not found");
    return result.rows[0];
  },

  async insertTransaction(db: Queryable, input: InsertTransactionRecord): Promise<void> {
    await db.query(
      `INSERT INTO finance_transactions
         (space_id, book_id, directive_id, flag, payee, narration, external_id,
          import_hash, tags, links, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        input.spaceId,
        input.bookId,
        input.directiveId,
        input.flag,
        input.payee ?? null,
        input.narration ?? null,
        input.externalId ?? null,
        input.importHash ?? null,
        input.tags ?? [],
        input.links ?? [],
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  },

  async insertPosting(db: Queryable, input: InsertPostingRecord): Promise<FinancePostingRow> {
    const result = await db.query<FinancePostingRow>(
      `INSERT INTO finance_postings
         (space_id, book_id, transaction_directive_id, account_id, account_name,
          amount_numeric, amount_text, amount_scale, commodity_id, commodity_symbol,
          cost_number_numeric, cost_number_text, cost_number_scale,
          cost_number_total_numeric, cost_number_total_text, cost_number_total_scale,
          cost_currency, cost_date, cost_label, cost_merge,
          price_number_numeric, price_number_text, price_number_scale,
          price_commodity_id, price_commodity_symbol, price_is_total,
          flag, sort_order, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10,
               $11::numeric, $12, $13, $14::numeric, $15, $16, $17, $18::date, $19, $20,
               $21::numeric, $22, $23, $24, $25, $26, $27, $28, $29::jsonb)
       RETURNING id, transaction_directive_id, book_id, space_id, account_id, account_name,
                 amount_numeric::text, amount_text, amount_scale, commodity_id, commodity_symbol,
                 cost_number_numeric::text, cost_number_text, cost_number_scale,
                 cost_number_total_numeric::text, cost_number_total_text,
                 cost_number_total_scale, cost_currency, cost_date::text, cost_label,
                 cost_merge, price_number_numeric::text, price_number_text,
                 price_number_scale, price_commodity_id, price_commodity_symbol,
                 price_is_total, flag, sort_order, metadata_json`,
      [
        input.spaceId,
        input.bookId,
        input.transactionDirectiveId,
        input.accountId,
        input.accountName,
        input.amountText ?? null,
        input.amountText ?? null,
        input.amountScale ?? null,
        input.commodityId ?? null,
        input.commoditySymbol ?? null,
        input.costNumberText ?? null,
        input.costNumberText ?? null,
        input.costNumberScale ?? null,
        input.costNumberTotalText ?? null,
        input.costNumberTotalText ?? null,
        input.costNumberTotalScale ?? null,
        input.costCurrency ?? null,
        input.costDate ?? null,
        input.costLabel ?? null,
        input.costMerge ?? null,
        input.priceNumberText ?? null,
        input.priceNumberText ?? null,
        input.priceNumberScale ?? null,
        input.priceCommodityId ?? null,
        input.priceCommoditySymbol ?? null,
        input.priceIsTotal ?? false,
        input.flag ?? null,
        input.sortOrder,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0]!;
  },

  async listDirectives(
    db: Queryable,
    spaceId: string,
    bookId: string,
    filters?: { status?: DirectiveStatus; directiveType?: DirectiveType; importSourceId?: string },
  ): Promise<FinanceDirectiveRow[]> {
    const conditions = ["space_id = $1", "book_id = $2"];
    const params: unknown[] = [spaceId, bookId];
    if (filters?.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filters?.directiveType) {
      params.push(filters.directiveType);
      conditions.push(`directive_type = $${params.length}`);
    }
    if (filters?.importSourceId) {
      params.push(filters.importSourceId);
      conditions.push(`import_source_id = $${params.length}`);
    }
    const result = await db.query<FinanceDirectiveRow>(
      `SELECT id, book_id, space_id, directive_type, date::text, sequence, status,
              source_activity_id, proposal_id, import_source_id, source_filename,
              source_lineno, source_hash, metadata_json, created_by_user_id,
              created_at::text, updated_at::text
         FROM finance_directives
        WHERE ${conditions.join(" AND ")}
        ORDER BY date ASC, sequence ASC`,
      params,
    );
    return result.rows;
  },

  async postDirectivesByIds(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveIds: string[],
    proposalId?: string | null,
  ): Promise<number> {
    if (directiveIds.length === 0) return 0;
    const result = await db.query(
      `UPDATE finance_directives
          SET status = 'posted',
              proposal_id = COALESCE($4, proposal_id),
              updated_at = now()
        WHERE space_id = $1 AND book_id = $2 AND id = ANY($3)
          AND status IN ('draft', 'proposed')`,
      [spaceId, bookId, directiveIds, proposalId ?? null],
    );
    return result.rowCount ?? 0;
  },

  async listTransactions(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<Array<FinanceTransactionRow & { directive: FinanceDirectiveRow }>> {
    const result = await db.query<FinanceTransactionRow & FinanceDirectiveRow>(
      `SELECT t.directive_id, t.book_id, t.space_id, t.flag, t.payee, t.narration,
              t.external_id, t.import_hash, t.tags, t.links, t.metadata_json,
              d.id, d.directive_type, d.date::text, d.sequence, d.status,
              d.source_activity_id, d.proposal_id, d.import_source_id,
              d.source_filename, d.source_lineno, d.source_hash,
              d.created_by_user_id, d.created_at::text, d.updated_at::text
         FROM finance_transactions t
         JOIN finance_directives d ON d.id = t.directive_id
        WHERE t.space_id = $1 AND t.book_id = $2
        ORDER BY d.date DESC, d.sequence DESC`,
      [spaceId, bookId],
    );
    return result.rows.map((row) => ({
      directive_id: row.directive_id,
      book_id: row.book_id,
      space_id: row.space_id,
      flag: row.flag,
      payee: row.payee,
      narration: row.narration,
      external_id: row.external_id,
      import_hash: row.import_hash,
      tags: row.tags,
      links: row.links,
      metadata_json: row.metadata_json,
      directive: row,
    }));
  },

  async getTransactionPostings(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
  ): Promise<FinancePostingRow[]> {
    const result = await db.query<FinancePostingRow>(
      `${POSTING_SELECT}
        WHERE p.space_id = $1 AND p.book_id = $2 AND p.transaction_directive_id = $3
        ORDER BY p.sort_order ASC`,
      [spaceId, bookId, directiveId],
    );
    return result.rows;
  },

  async getAccountLedger(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
  ): Promise<FinancePostingRow[]> {
    const result = await db.query<FinancePostingRow>(
      `${POSTING_SELECT}
         JOIN finance_directives d ON d.id = p.transaction_directive_id
        WHERE p.space_id = $1
          AND p.book_id = $2
          AND p.account_id = $3
          AND d.status = 'posted'
        ORDER BY d.date ASC, d.sequence ASC, p.sort_order ASC`,
      [spaceId, bookId, accountId],
    );
    return result.rows;
  },

  async getPostedPostings(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<FinancePostingRow[]> {
    const result = await db.query<FinancePostingRow>(
      `${POSTING_SELECT}
         JOIN finance_directives d ON d.id = p.transaction_directive_id
        WHERE p.space_id = $1
          AND p.book_id = $2
          AND d.status = 'posted'
        ORDER BY d.date ASC, d.sequence ASC, p.sort_order ASC`,
      [spaceId, bookId],
    );
    return result.rows;
  },
};

const POSTING_SELECT = `
  SELECT p.id, p.transaction_directive_id, p.book_id, p.space_id, p.account_id,
         p.account_name, p.amount_numeric::text, p.amount_text, p.amount_scale,
         p.commodity_id, p.commodity_symbol, p.cost_number_numeric::text,
         p.cost_number_text, p.cost_number_scale, p.cost_number_total_numeric::text,
         p.cost_number_total_text, p.cost_number_total_scale, p.cost_currency,
         p.cost_date::text, p.cost_label, p.cost_merge, p.price_number_numeric::text,
         p.price_number_text, p.price_number_scale, p.price_commodity_id,
         p.price_commodity_symbol, p.price_is_total, p.flag, p.sort_order,
         p.metadata_json
    FROM finance_postings p`;
