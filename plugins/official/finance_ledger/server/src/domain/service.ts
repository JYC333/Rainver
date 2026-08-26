import type { Queryable } from "@rainver/protocol";
import type { LedgerLoadResult } from "../beancount/entries.js";
import { financeLedgerEngine, postingEntryFromRow } from "../beancount/engine.js";
import { transactionBalanceErrors } from "../beancount/validation.js";
import { rootTypeForAccountName } from "./accountName.js";
import { Amount, assertCommoditySymbol } from "./amount.js";
import { parseBooking } from "./booking.js";
import { parseDecimal } from "./decimal.js";
import { financeDirectiveRepository } from "./directiveRepository.js";
import {
  exportBeancountFromDb,
  importBeancountToDb,
  type ExportBeancountResult,
  type ImportBeancountInput,
  type ImportBeancountResult,
} from "./importExportService.js";
import type {
  AccountVisibility,
  BalanceScope,
  CommodityType,
  DirectiveStatus,
  DirectiveType,
  FinanceAccountRow,
  FinanceBalancePosition,
  FinanceBookRow,
  FinanceCommodityRow,
  FinanceDirectiveRow,
  FinancePostingRow,
  FinanceValidationError,
} from "./directives.js";
import {
  financeLedgerRepository,
  type CreateCommodityRecord,
  type InsertPostingRecord,
} from "./repository.js";
import { Inventory } from "./inventory.js";
import { Position } from "./position.js";

export interface CreateFinanceBookInput {
  name: string;
  baseCurrency: string;
  operatingCurrency?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenAccountInput {
  name: string;
  /** Human-facing label (any language); `name` stays the Beancount identifier. */
  displayName?: string | null;
  openedAt: string;
  parentAccountId?: string | null;
  commodityConstraints?: string[] | null;
  bookingMethod?: string | null;
  accountRole?: string | null;
  /** Preselected posting commodity for this account; falls back to the book operating currency. */
  defaultCommodity?: string | null;
  /** Null/absent = jointly owned by the space. */
  ownerUserId?: string | null;
  /** Only personal accounts may be private. */
  visibility?: AccountVisibility;
  metadata?: Record<string, unknown>;
}

export interface CreateCommodityInput {
  symbol: string;
  commodityType?: CommodityType;
  name?: string | null;
  precision?: number | null;
  displayPrecision?: number | null;
  metadata?: Record<string, unknown>;
}

export interface CreateDirectiveDraftInput {
  directiveType: DirectiveType;
  date: string;
  sequence?: number;
  status?: DirectiveStatus;
  metadata?: Record<string, unknown>;
}

export interface TransactionPostingInput {
  accountId: string;
  amount?: {
    number: string;
    commoditySymbol: string;
  } | null;
  flag?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateTransactionDraftInput {
  date: string;
  sequence?: number;
  flag?: string;
  payee?: string | null;
  narration?: string | null;
  externalId?: string | null;
  importHash?: string | null;
  tags?: string[];
  links?: string[];
  postings: TransactionPostingInput[];
  metadata?: Record<string, unknown>;
}

export interface ValidateBookResult {
  errors: FinanceValidationError[];
}

export class FinanceLedgerService {
  constructor(private readonly repository = financeLedgerRepository) {}

  async createFinanceBook(
    db: Queryable,
    spaceId: string,
    userId: string,
    input: CreateFinanceBookInput,
  ): Promise<FinanceBookRow> {
    assertCommoditySymbol(input.baseCurrency);
    assertCommoditySymbol(input.operatingCurrency ?? input.baseCurrency);
    return this.repository.createBook(db, {
      spaceId,
      name: input.name.trim(),
      baseCurrency: input.baseCurrency,
      operatingCurrency: input.operatingCurrency ?? input.baseCurrency,
      createdByUserId: userId,
      metadata: input.metadata,
    });
  }

  listFinanceBooks(db: Queryable, spaceId: string): Promise<FinanceBookRow[]> {
    return this.repository.listBooks(db, spaceId);
  }

  createLedgerOption(
    db: Queryable,
    spaceId: string,
    bookId: string,
    input: { name: string; value: Record<string, unknown>; source?: string },
  ): Promise<void> {
    return this.repository.createLedgerOption(db, {
      spaceId,
      bookId,
      name: input.name,
      value: input.value,
      source: input.source,
    });
  }

  async createCommodity(
    db: Queryable,
    spaceId: string,
    bookId: string,
    input: CreateCommodityInput,
  ): Promise<FinanceCommodityRow> {
    assertCommoditySymbol(input.symbol);
    const record: CreateCommodityRecord = {
      spaceId,
      bookId,
      symbol: input.symbol,
      commodityType: input.commodityType ?? "custom",
      name: input.name,
      precision: input.precision,
      displayPrecision: input.displayPrecision,
      metadata: input.metadata,
    };
    return this.repository.createCommodity(db, record);
  }

  async openAccount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    input: OpenAccountInput,
  ): Promise<FinanceAccountRow> {
    const rootType = rootTypeForAccountName(input.name);
    const bookingMethod = parseBooking(input.bookingMethod);
    if (input.visibility === "private" && !input.ownerUserId) {
      throw new Error("Only personal accounts can be private");
    }
    if (input.defaultCommodity) {
      assertCommoditySymbol(input.defaultCommodity);
      if (
        input.commodityConstraints &&
        !input.commodityConstraints.includes(input.defaultCommodity)
      ) {
        throw new Error("Default commodity must be one of the account's allowed currencies");
      }
    }
    return this.repository.openAccount(db, {
      spaceId,
      bookId,
      name: input.name,
      displayName: input.displayName,
      rootType,
      parentAccountId: input.parentAccountId,
      commodityConstraints: input.commodityConstraints,
      openedAt: input.openedAt,
      bookingMethod,
      accountRole: input.accountRole,
      defaultCommodity: input.defaultCommodity,
      ownerUserId: input.ownerUserId,
      visibility: input.visibility,
      metadata: input.metadata,
    });
  }

  /** Only the owner of a personal account may change its visibility. */
  async setAccountVisibility(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
    userId: string,
    visibility: AccountVisibility,
  ): Promise<FinanceAccountRow> {
    const account = await this.repository.findAccount(db, spaceId, bookId, accountId);
    if (!account) throw new Error("Account not found");
    if (!account.owner_user_id) {
      throw new Error("Shared accounts are always visible to the space");
    }
    if (account.owner_user_id !== userId) {
      throw new Error("Only the account owner can change its visibility");
    }
    return this.repository.updateAccountVisibility(db, spaceId, bookId, accountId, visibility);
  }

  async closeAccount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
    date: string,
  ): Promise<FinanceAccountRow> {
    return this.repository.closeAccount(db, spaceId, bookId, accountId, date);
  }

  async createDirectiveDraft(
    db: Queryable,
    spaceId: string,
    bookId: string,
    userId: string,
    input: CreateDirectiveDraftInput,
  ): Promise<FinanceDirectiveRow> {
    const insert = (sequence: number) =>
      this.repository.insertDirective(db, {
        spaceId,
        bookId,
        directiveType: input.directiveType,
        date: input.date,
        sequence,
        status: input.status ?? "draft",
        createdByUserId: userId,
        metadata: input.metadata,
      });

    if (input.sequence !== undefined) return insert(input.sequence);

    // MAX+1 allocation races with concurrent inserts on the same book/date;
    // the unique constraint rejects the loser, so retry with a fresh sequence.
    let lastConflict: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sequence = await this.repository.nextSequence(db, spaceId, bookId, input.date);
      try {
        return await insert(sequence);
      } catch (err) {
        if (!isSequenceConflict(err)) throw err;
        lastConflict = err;
      }
    }
    throw new Error("Could not allocate a directive sequence, please retry", {
      cause: lastConflict,
    });
  }

  async createTransactionDraft(
    db: Queryable,
    spaceId: string,
    bookId: string,
    userId: string,
    input: CreateTransactionDraftInput,
  ): Promise<FinanceDirectiveRow> {
    const directive = await this.createDirectiveDraft(db, spaceId, bookId, userId, {
      directiveType: "transaction",
      date: input.date,
      sequence: input.sequence,
      metadata: input.metadata,
    });

    await this.repository.insertTransaction(db, {
      spaceId,
      bookId,
      directiveId: directive.id,
      flag: input.flag ?? "*",
      payee: input.payee,
      narration: input.narration,
      externalId: input.externalId,
      importHash: input.importHash,
      tags: input.tags,
      links: input.links,
      metadata: input.metadata,
    });

    let sortOrder = 0;
    for (const posting of input.postings) {
      const account = await this.requireActiveAccount(
        db,
        spaceId,
        bookId,
        posting.accountId,
        input.date,
      );
      const record = await this.buildPostingRecord(
        db,
        spaceId,
        bookId,
        directive.id,
        account,
        posting,
        sortOrder,
      );
      await this.repository.insertPosting(db, record);
      sortOrder += 1;
    }

    return directive;
  }

  async proposeDirective(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
  ): Promise<FinanceDirectiveRow> {
    return this.repository.updateDirectiveStatus(db, spaceId, bookId, directiveId, "proposed");
  }

  async postDirective(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
  ): Promise<FinanceDirectiveRow> {
    const directive = await this.repository.findDirective(db, spaceId, bookId, directiveId);
    if (!directive) throw new Error("Directive not found");
    if (directive.status === "posted") return directive;
    if (directive.status === "voided") throw new Error("Cannot post a voided directive");
    if (directive.directive_type === "transaction") {
      const errors = await this.validateTransactionBalance(db, spaceId, bookId, directiveId);
      if (errors.length > 0) {
        throw new Error(errors.map((error) => error.message).join("; "));
      }
    }
    return this.repository.updateDirectiveStatus(db, spaceId, bookId, directiveId, "posted");
  }

  async voidDirective(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
  ): Promise<FinanceDirectiveRow> {
    return this.repository.updateDirectiveStatus(db, spaceId, bookId, directiveId, "voided");
  }

  /** With a viewer, other members' private accounts are hidden. */
  listAccounts(
    db: Queryable,
    spaceId: string,
    bookId: string,
    viewerUserId?: string,
  ): Promise<FinanceAccountRow[]> {
    return this.repository.listAccounts(db, spaceId, bookId, viewerUserId);
  }

  findFinanceBook(db: Queryable, spaceId: string, bookId: string): Promise<FinanceBookRow | null> {
    return this.repository.findBook(db, spaceId, bookId);
  }

  listCommodities(db: Queryable, spaceId: string, bookId: string): Promise<FinanceCommodityRow[]> {
    return this.repository.listCommodities(db, spaceId, bookId);
  }

  listLedgerOptions(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): ReturnType<typeof financeDirectiveRepository.listLedgerOptions> {
    return financeDirectiveRepository.listLedgerOptions(db, spaceId, bookId);
  }

  listDirectives(
    db: Queryable,
    spaceId: string,
    bookId: string,
    filters?: { status?: DirectiveStatus; directiveType?: DirectiveType; importSourceId?: string },
  ): Promise<FinanceDirectiveRow[]> {
    return this.repository.listDirectives(db, spaceId, bookId, filters);
  }

  listTransactions(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): ReturnType<typeof financeLedgerRepository.listTransactions> {
    return this.repository.listTransactions(db, spaceId, bookId);
  }

  /** With a viewer, another member's private account behaves as not found. */
  async getAccountLedger(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
    viewerUserId?: string,
  ): Promise<FinancePostingRow[]> {
    if (viewerUserId) {
      const account = await this.repository.findAccount(db, spaceId, bookId, accountId);
      if (!account || !accountVisibleTo(account, viewerUserId)) {
        throw new Error("Account not found");
      }
    }
    return this.repository.getAccountLedger(db, spaceId, bookId, accountId);
  }

  async computeBalances(
    db: Queryable,
    spaceId: string,
    bookId: string,
    options: { viewerUserId?: string; scope?: BalanceScope } = {},
  ): Promise<FinanceBalancePosition[]> {
    const scope = options.scope ?? "all";
    const accounts = await this.repository.listAccounts(db, spaceId, bookId);
    const included = new Set(
      accounts
        .filter((account) => {
          if (options.viewerUserId && !accountVisibleTo(account, options.viewerUserId)) {
            return false;
          }
          if (scope === "shared") return account.owner_user_id === null;
          if (scope === "personal") {
            return options.viewerUserId
              ? account.owner_user_id === options.viewerUserId
              : account.owner_user_id !== null;
          }
          return true;
        })
        .map((account) => account.id),
    );

    const postings = await this.repository.getPostedPostings(db, spaceId, bookId);
    const byAccount = new Map<string, { accountName: string; inventory: Inventory }>();
    for (const posting of postings) {
      if (!posting.amount_text || !posting.commodity_symbol) continue;
      if (!included.has(posting.account_id)) continue;
      const key = posting.account_id;
      const current = byAccount.get(key) ?? {
        accountName: posting.account_name,
        inventory: Inventory.empty(),
      };
      current.inventory.addPosition(
        new Position(Amount.of(posting.amount_text, posting.commodity_symbol)),
      );
      byAccount.set(key, current);
    }

    return [...byAccount.entries()].map(([accountId, value]) => ({
      accountId,
      accountName: value.accountName,
      positions: value.inventory.positions().map((position) => position.toString()),
    }));
  }

  async validateBook(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<ValidateBookResult> {
    const errors: FinanceValidationError[] = [];
    const transactions = await this.repository.listTransactions(db, spaceId, bookId);
    for (const transaction of transactions) {
      if (transaction.directive.status !== "posted") continue;
      errors.push(
        ...(await this.validateTransactionBalance(
          db,
          spaceId,
          bookId,
          transaction.directive_id,
        )),
      );
    }
    return { errors };
  }

  parseBeancount(text: string, filename?: string): LedgerLoadResult {
    return financeLedgerEngine.loadFromText(text, filename);
  }

  importBeancount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    userId: string,
    input: ImportBeancountInput,
  ): Promise<ImportBeancountResult> {
    return importBeancountToDb(db, spaceId, bookId, userId, input);
  }

  exportBeancount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    userId: string,
  ): Promise<ExportBeancountResult> {
    return exportBeancountFromDb(db, spaceId, bookId, userId);
  }

  async postImportBatch(
    db: Queryable,
    spaceId: string,
    bookId: string,
    importSourceId: string,
    proposalId?: string | null,
  ): Promise<{ posted: number }> {
    const directives = await this.repository.listDirectives(db, spaceId, bookId, {
      importSourceId,
    });
    const pending = directives.filter(
      (directive) => directive.status === "draft" || directive.status === "proposed",
    );
    const errors: FinanceValidationError[] = [];
    for (const directive of pending) {
      if (directive.directive_type !== "transaction") continue;
      errors.push(...(await this.validateTransactionBalance(db, spaceId, bookId, directive.id)));
    }
    if (errors.length > 0) {
      throw new Error(errors.map((error) => error.message).join("; "));
    }
    const posted = await this.repository.postDirectivesByIds(
      db,
      spaceId,
      bookId,
      pending.map((directive) => directive.id),
      proposalId,
    );
    return { posted };
  }

  private async requireActiveAccount(
    db: Queryable,
    spaceId: string,
    bookId: string,
    accountId: string,
    date: string,
  ): Promise<FinanceAccountRow> {
    const account = await this.repository.findAccount(db, spaceId, bookId, accountId);
    if (!account) throw new Error(`Unknown account: ${accountId}`);
    if (account.opened_at > date) {
      throw new Error(`Account is not open yet: ${account.name}`);
    }
    if (account.closed_at && account.closed_at <= date) {
      throw new Error(`Account is closed: ${account.name}`);
    }
    return account;
  }

  private async buildPostingRecord(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
    account: FinanceAccountRow,
    posting: TransactionPostingInput,
    sortOrder: number,
  ): Promise<InsertPostingRecord> {
    if (!posting.amount) {
      return {
        spaceId,
        bookId,
        transactionDirectiveId: directiveId,
        accountId: account.id,
        accountName: account.name,
        sortOrder,
        flag: posting.flag,
        metadata: posting.metadata,
      };
    }

    const amount = parseDecimal(posting.amount.number);
    assertCommoditySymbol(posting.amount.commoditySymbol);
    if (
      account.commodity_constraints &&
      !account.commodity_constraints.includes(posting.amount.commoditySymbol)
    ) {
      throw new Error(
        `Commodity ${posting.amount.commoditySymbol} is not allowed for account ${account.name}`,
      );
    }
    const commodity = await this.repository.findCommodityBySymbol(
      db,
      spaceId,
      bookId,
      posting.amount.commoditySymbol,
    );
    if (!commodity) throw new Error(`Unknown commodity: ${posting.amount.commoditySymbol}`);

    return {
      spaceId,
      bookId,
      transactionDirectiveId: directiveId,
      accountId: account.id,
      accountName: account.name,
      amountText: amount.decimal,
      amountScale: amount.scale,
      commodityId: commodity.id,
      commoditySymbol: commodity.symbol,
      sortOrder,
      flag: posting.flag,
      metadata: posting.metadata,
    };
  }

  private async validateTransactionBalance(
    db: Queryable,
    spaceId: string,
    bookId: string,
    directiveId: string,
  ): Promise<FinanceValidationError[]> {
    const postings = await this.repository.getTransactionPostings(db, spaceId, bookId, directiveId);
    if (postings.length < 2) {
      return [
        {
          code: "transaction_postings_min",
          message: "Posted transaction must have at least two postings",
          directiveId,
        },
      ];
    }

    return transactionBalanceErrors(postings.map((posting) => postingEntryFromRow(posting))).map(
      (error) => ({ ...error, directiveId }),
    );
  }
}

export const financeLedgerService = new FinanceLedgerService();

export function accountVisibleTo(account: FinanceAccountRow, viewerUserId: string): boolean {
  return account.visibility === "space" || account.owner_user_id === viewerUserId;
}

function isSequenceConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const pgError = err as { code?: string; constraint?: string };
  return (
    pgError.code === "23505" &&
    (pgError.constraint ?? "").includes("book_date_sequence")
  );
}

export { rootTypeForAccountName };
