import { createHash } from "node:crypto";
import type { Queryable } from "@agent-space/protocol";
import type {
  DatedEntry,
  LedgerEntry,
  LedgerError,
  PostingEntry,
  TransactionEntry,
} from "../beancount/entries.js";
import { isDatedEntry } from "../beancount/entries.js";
import { financeLedgerEngine } from "../beancount/engine.js";
import { parseBeancountText } from "../beancount/importer.js";
import { sortEntries } from "../beancount/sort.js";
import { interpolateEntries, transformEntries, validateEntries } from "../beancount/validation.js";
import { rootTypeForAccountName } from "./accountName.js";
import type { DirectiveStatus, FinanceAccountRow, FinanceCommodityRow } from "./directives.js";
import { financeDirectiveRepository, type FinanceExportRow } from "./directiveRepository.js";
import { Cost, CostSpec } from "./position.js";
import { financeLedgerRepository, type InsertPostingRecord } from "./repository.js";

export interface ImportBeancountInput {
  text: string;
  filename?: string;
  sourceType?: string;
  sourceName?: string | null;
  /** Imports default to `proposed`; posting directly requires a clean file. */
  status?: DirectiveStatus;
}

export interface ImportBeancountResult {
  importSourceId: string | null;
  deduplicated: boolean;
  createdDirectives: number;
  errors: LedgerError[];
  options: Record<string, string>;
}

export interface ExportBeancountResult {
  export: FinanceExportRow;
  content: string;
  contentHash: string;
  errors: LedgerError[];
}

export async function importBeancountToDb(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  input: ImportBeancountInput,
): Promise<ImportBeancountResult> {
  const filename = input.filename ?? "<import>";
  const status = input.status ?? "proposed";
  const parsed = parseBeancountText(input.text, filename);
  const contentHash = createHash("sha256").update(input.text, "utf8").digest("hex");

  const existing = await financeDirectiveRepository.findImportSourceByHash(
    db,
    spaceId,
    bookId,
    contentHash,
  );
  if (existing) {
    return {
      importSourceId: existing.id,
      deduplicated: true,
      createdDirectives: 0,
      errors: [],
      options: parsed.options,
    };
  }

  // Validate the incoming file against the existing committed ledger so
  // references to already-open accounts do not report as unknown.
  const dbLoaded = await financeLedgerEngine.loadFromDb(db, spaceId, bookId);
  const combined = transformEntries([...dbLoaded.entries, ...parsed.entries]);
  const validationErrors = validateEntries(combined).filter(
    (error) => error.source?.filename === filename,
  );
  const errors: LedgerError[] = [...parsed.errors, ...validationErrors];

  if (status === "posted" && errors.length > 0) {
    throw new Error(
      `Cannot post import with validation errors: ${errors
        .map((error) => `${error.code}: ${error.message}`)
        .join("; ")}`,
    );
  }

  const importSource = await financeDirectiveRepository.insertImportSource(db, {
    spaceId,
    bookId,
    sourceType: input.sourceType ?? "upload",
    sourceName: input.sourceName ?? filename,
    contentHash,
    importedByUserId: userId,
    metadata: { error_count: errors.length },
  });

  const persister = new ImportPersister(
    db,
    spaceId,
    bookId,
    userId,
    status,
    contentHash,
    importSource.id,
    errors,
  );
  await persister.preload();
  for (const entry of sortEntries(interpolateEntries(parsed.entries))) {
    await persister.persistEntry(entry);
  }

  return {
    importSourceId: importSource.id,
    deduplicated: false,
    createdDirectives: persister.createdDirectives,
    errors,
    options: parsed.options,
  };
}

export async function exportBeancountFromDb(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
): Promise<ExportBeancountResult> {
  const rendered = await financeLedgerEngine.exportFromDb(db, spaceId, bookId);
  const contentHash = createHash("sha256").update(rendered.content, "utf8").digest("hex");
  const exportRow = await financeDirectiveRepository.insertExport(db, {
    spaceId,
    bookId,
    exportFormat: "beancount",
    status: "created",
    contentHash,
    validationSummary: {
      error_count: rendered.errors.length,
      error_codes: [...new Set(rendered.errors.map((error) => error.code))],
    },
    createdByUserId: userId,
  });
  return { export: exportRow, content: rendered.content, contentHash, errors: rendered.errors };
}

class ImportPersister {
  createdDirectives = 0;

  private readonly accounts = new Map<string, FinanceAccountRow>();
  private readonly commodities = new Map<string, FinanceCommodityRow>();
  private readonly sequenceByDate = new Map<string, number>();
  private configSortOrder = 0;

  constructor(
    private readonly db: Queryable,
    private readonly spaceId: string,
    private readonly bookId: string,
    private readonly userId: string,
    private readonly status: DirectiveStatus,
    private readonly contentHash: string,
    private readonly importSourceId: string,
    private readonly errors: LedgerError[],
  ) {}

  async preload(): Promise<void> {
    const [accounts, commodities] = await Promise.all([
      financeLedgerRepository.listAccounts(this.db, this.spaceId, this.bookId),
      financeLedgerRepository.listCommodities(this.db, this.spaceId, this.bookId),
    ]);
    for (const account of accounts) this.accounts.set(account.name, account);
    for (const commodity of commodities) this.commodities.set(commodity.symbol, commodity);
  }

  async persistEntry(entry: LedgerEntry): Promise<void> {
    try {
      if (!isDatedEntry(entry)) {
        await this.persistConfigEntry(entry);
        return;
      }
      await this.persistDatedEntry(entry);
    } catch (err) {
      this.errors.push({
        code: "import_persist_error",
        message: err instanceof Error ? err.message : "Failed to persist entry",
        source: entry.source,
      });
    }
  }

  private async persistConfigEntry(entry: Exclude<LedgerEntry, DatedEntry>): Promise<void> {
    const sortOrder = this.configSortOrder;
    this.configSortOrder += 1;
    switch (entry.type) {
      case "option":
        await financeLedgerRepository.createLedgerOption(this.db, {
          spaceId: this.spaceId,
          bookId: this.bookId,
          name: entry.name,
          value: { value: entry.value },
          source: "import",
        });
        return;
      case "include":
        await financeDirectiveRepository.insertInclude(this.db, {
          spaceId: this.spaceId,
          bookId: this.bookId,
          path: entry.path,
          sortOrder,
        });
        return;
      case "plugin":
        await financeDirectiveRepository.insertPluginDirective(this.db, {
          spaceId: this.spaceId,
          bookId: this.bookId,
          module: entry.module,
          config: entry.config,
          sortOrder,
        });
        return;
      case "pushtag":
      case "poptag":
        await financeDirectiveRepository.insertTagStackEvent(this.db, {
          spaceId: this.spaceId,
          bookId: this.bookId,
          eventType: entry.type === "pushtag" ? "push" : "pop",
          tag: entry.tag,
          sortOrder,
          sourceLineno: entry.source?.lineno,
        });
        return;
      case "pushmeta":
      case "popmeta":
        await financeDirectiveRepository.insertMetaStackEvent(this.db, {
          spaceId: this.spaceId,
          bookId: this.bookId,
          eventType: entry.type === "pushmeta" ? "push" : "pop",
          key: entry.key,
          value: entry.value,
          sortOrder,
          sourceLineno: entry.source?.lineno,
        });
        return;
    }
  }

  private async persistDatedEntry(entry: DatedEntry): Promise<void> {
    switch (entry.type) {
      case "open": {
        if (!this.accounts.get(entry.account)) {
          const account = await financeLedgerRepository.openAccount(this.db, {
            spaceId: this.spaceId,
            bookId: this.bookId,
            name: entry.account,
            rootType: rootTypeForAccountName(entry.account),
            commodityConstraints: entry.currencies.length > 0 ? entry.currencies : null,
            openedAt: entry.date,
            bookingMethod: entry.booking,
            metadata: entry.meta,
          });
          this.accounts.set(account.name, account);
        }
        await this.insertDirective(entry);
        return;
      }
      case "close": {
        const account = this.requireAccount(entry.account, entry);
        if (!account) return;
        const closed = await financeLedgerRepository.closeAccount(
          this.db,
          this.spaceId,
          this.bookId,
          account.id,
          entry.date,
        );
        this.accounts.set(closed.name, closed);
        await this.insertDirective(entry);
        return;
      }
      case "commodity": {
        await this.ensureCommodity(entry.currency, entry.date, entry.meta);
        await this.insertDirective(entry);
        return;
      }
      case "transaction": {
        await this.persistTransaction(entry);
        return;
      }
      case "balance": {
        const account = this.requireAccount(entry.account, entry);
        if (!account) return;
        const commodity = await this.ensureCommodity(entry.amount.currency, entry.date);
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertBalanceAssertion(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account.id,
          accountName: account.name,
          amountText: entry.amount.number.decimal,
          amountScale: entry.amount.number.scale,
          commodityId: commodity.id,
          commoditySymbol: commodity.symbol,
          toleranceText: entry.tolerance?.number.decimal,
          toleranceScale: entry.tolerance?.number.scale,
        });
        return;
      }
      case "pad": {
        const account = this.requireAccount(entry.account, entry);
        const sourceAccount = this.requireAccount(entry.sourceAccount, entry);
        if (!account || !sourceAccount) return;
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertPad(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account.id,
          accountName: account.name,
          sourceAccountId: sourceAccount.id,
          sourceAccountName: sourceAccount.name,
        });
        return;
      }
      case "price": {
        const commodity = await this.ensureCommodity(entry.currency, entry.date);
        const priceCommodity = await this.ensureCommodity(entry.amount.currency, entry.date);
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertPrice(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          commodityId: commodity.id,
          commoditySymbol: commodity.symbol,
          amountText: entry.amount.number.decimal,
          amountScale: entry.amount.number.scale,
          priceCommodityId: priceCommodity.id,
          priceCommoditySymbol: priceCommodity.symbol,
        });
        return;
      }
      case "note": {
        const account = this.requireAccount(entry.account, entry);
        if (!account) return;
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertNote(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account.id,
          accountName: account.name,
          comment: entry.comment,
          tags: [...entry.tags],
          links: [...entry.links],
        });
        return;
      }
      case "event": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertEvent(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          eventType: entry.eventType,
          description: entry.description,
        });
        return;
      }
      case "query": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertQuery(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          name: entry.name,
          queryString: entry.queryString,
        });
        return;
      }
      case "document": {
        const account = this.requireAccount(entry.account, entry);
        if (!account) return;
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertDocument(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account.id,
          accountName: account.name,
          filename: entry.filename,
          tags: [...entry.tags],
          links: [...entry.links],
        });
        return;
      }
      case "custom": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertCustom(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          customType: entry.customType,
          values: entry.values,
        });
        return;
      }
    }
  }

  private async persistTransaction(entry: TransactionEntry): Promise<void> {
    const resolved: Array<{ posting: PostingEntry; account: FinanceAccountRow }> = [];
    for (const posting of entry.postings) {
      const account = this.requireAccount(posting.account, entry);
      if (!account) return;
      resolved.push({ posting, account });
    }

    const directive = await this.insertDirective(entry);
    await financeLedgerRepository.insertTransaction(this.db, {
      spaceId: this.spaceId,
      bookId: this.bookId,
      directiveId: directive.id,
      flag: entry.flag,
      payee: entry.payee,
      narration: entry.narration,
      importHash: this.contentHash,
      tags: [...entry.tags],
      links: [...entry.links],
      metadata: entry.meta,
    });

    let sortOrder = 0;
    for (const { posting, account } of resolved) {
      const record = await this.buildPostingRecord(directive.id, account, posting, entry, sortOrder);
      await financeLedgerRepository.insertPosting(this.db, record);
      sortOrder += 1;
    }
  }

  private async buildPostingRecord(
    directiveId: string,
    account: FinanceAccountRow,
    posting: PostingEntry,
    entry: TransactionEntry,
    sortOrder: number,
  ): Promise<InsertPostingRecord> {
    const record: InsertPostingRecord = {
      spaceId: this.spaceId,
      bookId: this.bookId,
      transactionDirectiveId: directiveId,
      accountId: account.id,
      accountName: account.name,
      flag: posting.flag,
      sortOrder,
      metadata: posting.meta,
    };

    if (posting.units) {
      const commodity = await this.ensureCommodity(posting.units.currency, entry.date);
      record.amountText = posting.units.number.decimal;
      record.amountScale = posting.units.number.scale;
      record.commodityId = commodity.id;
      record.commoditySymbol = commodity.symbol;
    }

    if (posting.cost instanceof Cost) {
      record.costNumberText = posting.cost.number.decimal;
      record.costNumberScale = posting.cost.number.scale;
      record.costCurrency = posting.cost.currency;
      record.costDate = posting.cost.date;
      record.costLabel = posting.cost.label;
    } else if (posting.cost instanceof CostSpec) {
      record.costNumberText = posting.cost.numberPer?.decimal ?? null;
      record.costNumberScale = posting.cost.numberPer?.scale ?? null;
      record.costNumberTotalText = posting.cost.numberTotal?.decimal ?? null;
      record.costNumberTotalScale = posting.cost.numberTotal?.scale ?? null;
      record.costCurrency = posting.cost.currency;
      record.costDate = posting.cost.date;
      record.costLabel = posting.cost.label;
      record.costMerge = posting.cost.merge;
    }

    if (posting.price) {
      const priceCommodity = await this.ensureCommodity(posting.price.currency, entry.date);
      record.priceNumberText = posting.price.number.decimal;
      record.priceNumberScale = posting.price.number.scale;
      record.priceCommodityId = priceCommodity.id;
      record.priceCommoditySymbol = priceCommodity.symbol;
      record.priceIsTotal = posting.priceIsTotal;
    }

    return record;
  }

  private async insertDirective(entry: DatedEntry) {
    const directive = await financeLedgerRepository.insertDirective(this.db, {
      spaceId: this.spaceId,
      bookId: this.bookId,
      directiveType: entry.type,
      date: entry.date,
      sequence: await this.nextSequence(entry.date),
      status: this.status,
      createdByUserId: this.userId,
      importSourceId: this.importSourceId,
      sourceFilename: entry.source?.filename,
      sourceLineno: entry.source?.lineno,
      sourceHash: this.contentHash,
      metadata: entry.meta,
    });
    this.createdDirectives += 1;
    return directive;
  }

  private async nextSequence(date: string): Promise<number> {
    let next = this.sequenceByDate.get(date);
    if (next === undefined) {
      next = await financeLedgerRepository.nextSequence(this.db, this.spaceId, this.bookId, date);
    }
    this.sequenceByDate.set(date, next + 1);
    return next;
  }

  private requireAccount(name: string, entry: DatedEntry): FinanceAccountRow | null {
    const account = this.accounts.get(name);
    if (!account) {
      this.errors.push({
        code: "unknown_account",
        message: `Cannot persist reference to unknown account ${name}`,
        source: entry.source,
      });
      return null;
    }
    return account;
  }

  private async ensureCommodity(
    symbol: string,
    declaredDate: string,
    meta?: Record<string, unknown>,
  ): Promise<FinanceCommodityRow> {
    const cached = this.commodities.get(symbol);
    if (cached) return cached;
    const commodity = await financeLedgerRepository.createCommodity(this.db, {
      spaceId: this.spaceId,
      bookId: this.bookId,
      symbol,
      commodityType: "custom",
      metadata: { ...(meta ?? {}), declared_date: declaredDate },
    });
    this.commodities.set(symbol, commodity);
    return commodity;
  }
}
