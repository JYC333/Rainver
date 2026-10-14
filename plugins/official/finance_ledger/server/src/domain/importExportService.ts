import { createHash } from "node:crypto";
import type { Queryable } from "@rainver/protocol";
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
import type { FinanceAccountRow, FinanceCommodityRow } from "./directives.js";
import { financeDirectiveRepository, type FinanceExportRow, type FinanceImportSourceRow } from "./directiveRepository.js";
import { FinanceRuleError } from "./errors.js";
import {
  emptyStatusCounts,
  financeImportEntryRepository,
  identifyImportEntries,
  type FinanceImportEntryRow,
  type ImportEntryOutcome,
  type ImportEntryStatus,
  type ParsedImportEntry,
} from "./importEntries.js";
import { Cost, CostSpec } from "./position.js";
import { financeLedgerRepository, isSequenceConflict, type InsertPostingRecord } from "./repository.js";
import { attempt, withLockedBook } from "./transaction.js";

export interface ImportBeancountInput {
  text: string;
  sourceType?: string;
  sourceName?: string | null;
}

export interface ImportBatchResult {
  importSource: FinanceImportSourceRow;
  /** The file was already a batch of this book; its unfinished entries were retried. */
  batchExisted: boolean;
  /** Dated directives persisted by this call. */
  createdDirectives: number;
  summary: Record<ImportEntryStatus, number>;
  entries: FinanceImportEntryRow[];
  /** Parse and validation errors that belong to no entry. */
  errors: LedgerError[];
  options: Record<string, string>;
}

export interface ImportSourceSummary {
  importSource: FinanceImportSourceRow;
  summary: Record<ImportEntryStatus, number>;
}

export type ImportReviewDecision = "import" | "duplicate";

export interface ExportBeancountResult {
  export: FinanceExportRow;
  content: string;
  contentHash: string;
  errors: LedgerError[];
}

/**
 * Directives an import records but never executes. Opening or closing an
 * account, declaring a commodity, and setting a book option change the book's
 * structure; the file is not authority for that, account and commodity
 * management are. Everything else lands as `proposed` for review.
 */
const EXCLUDED_ENTRY_TYPES = new Set<LedgerEntry["type"]>(["open", "close", "commodity", "option"]);

/** Every import lands for review; nothing in an upload posts on its own. */
const IMPORTED_STATUS = "proposed" as const;

/** Statuses an import pass tries again. */
const RETRIED_STATUSES = new Set<ImportEntryStatus>(["error", "pending_mapping"]);

export async function importBeancountToDb(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  input: ImportBeancountInput,
): Promise<ImportBatchResult> {
  const contentHash = createHash("sha256").update(input.text, "utf8").digest("hex");
  return withLockedBook(db, spaceId, bookId, async (tx) => {
    const existing = await financeDirectiveRepository.findImportSourceByHash(tx, spaceId, bookId, contentHash);
    if (existing && existing.imported_by_user_id !== userId) {
      // Another member already holds this file as a batch; its entries and
      // their original text are theirs to follow up, not this person's to read.
      throw new FinanceRuleError("This file was already imported by another member of the space");
    }
    const importSource = existing ?? await financeDirectiveRepository.insertImportSource(tx, {
      spaceId,
      bookId,
      sourceType: input.sourceType ?? "upload",
      sourceName: input.sourceName ?? importFilename(userId),
      contentHash,
      contentText: input.text,
      importedByUserId: userId,
    });
    const pass = await runImportPass(tx, spaceId, bookId, userId, importSource, input.text);
    return { ...pass, importSource, batchExisted: existing !== null };
  });
}

/** Retries every entry of a batch that is not yet settled. */
export async function retryImportBatch(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  importSourceId: string,
): Promise<ImportBatchResult> {
  return withLockedBook(db, spaceId, bookId, async (tx) => {
    const importSource = await requireOwnImportSource(tx, spaceId, bookId, userId, importSourceId);
    const pass = await runImportPass(tx, spaceId, bookId, userId, importSource, importSource.content_text);
    return { ...pass, importSource, batchExisted: true };
  });
}

/**
 * Maps account names the file uses onto accounts this book already has, then
 * retries the entry. The mapping is checked here and again when the entry is
 * persisted: an account must be one this person may see, in this book, and
 * open on the entry's date. The original record is not changed by it.
 */
export async function applyImportEntryMapping(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  importSourceId: string,
  entryId: string,
  accountMapping: Record<string, string>,
): Promise<ImportBatchResult> {
  return withLockedBook(db, spaceId, bookId, async (tx) => {
    const importSource = await requireOwnImportSource(tx, spaceId, bookId, userId, importSourceId);
    const entry = await requireEntry(tx, spaceId, importSource, entryId);
    if (!RETRIED_STATUSES.has(entry.status)) {
      throw new FinanceRuleError(`Import entry is ${entry.status.replace("_", " ")}; only an unfinished entry takes a mapping`);
    }
    const parsed = findParsedEntry(importSource, entry, userId);
    const referenced = new Set(referencedAccountNames(parsed.entry));
    for (const [name, accountId] of Object.entries(accountMapping)) {
      if (!referenced.has(name)) throw new FinanceRuleError(`The entry does not reference account ${name}`);
      if (typeof accountId !== "string" || !accountId.trim()) throw new FinanceRuleError(`Mapping for ${name} needs an account id`);
      const account = await financeLedgerRepository.findAccountForViewer(tx, spaceId, bookId, accountId, userId);
      if (!account) throw new FinanceRuleError(`Mapping for ${name}: account not found`);
      const date = "date" in parsed.entry ? parsed.entry.date : null;
      if (date && !accountOpenOn(account, date)) {
        throw new FinanceRuleError(`Mapping for ${name}: ${account.name} is not open on ${date}`);
      }
    }
    await financeImportEntryRepository.setAccountMapping(tx, entry.id, accountMapping);
    const pass = await runImportPass(tx, spaceId, bookId, userId, importSource, importSource.content_text, {
      only: new Set([entry.entry_key]),
    });
    return { ...pass, importSource, batchExisted: true };
  });
}

/**
 * Settles entries whose content matches a record another batch of this book
 * already holds. `import` persists them as records of their own; `duplicate`
 * records them as the same record and persists nothing.
 */
export async function decideImportEntryReview(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  importSourceId: string,
  decision: ImportReviewDecision,
  entryIds: readonly string[] | null,
): Promise<ImportBatchResult> {
  return withLockedBook(db, spaceId, bookId, async (tx) => {
    const importSource = await requireOwnImportSource(tx, spaceId, bookId, userId, importSourceId);
    const all = await financeImportEntryRepository.listForSource(tx, spaceId, importSource.id);
    const wanted = entryIds === null
      ? all.filter((entry) => entry.status === "needs_review")
      : entryIds.map((id) => {
          const entry = all.find((candidate) => candidate.id === id);
          if (!entry) throw new FinanceRuleError("Import entry not found");
          if (entry.status !== "needs_review") throw new FinanceRuleError("Import entry is not awaiting review");
          return entry;
        });
    const keys = new Set<string>();
    for (const entry of wanted) {
      if (decision === "duplicate") {
        await financeImportEntryRepository.setOutcome(tx, entry.id, {
          status: "duplicate",
          statusReason: "review_duplicate",
          duplicateOfEntryId: entry.duplicate_of_entry_id,
        });
        continue;
      }
      // Marked as reviewed so the pass below persists it instead of asking again.
      await financeImportEntryRepository.setOutcome(tx, entry.id, { status: "error", statusReason: "review_import" });
      keys.add(entry.entry_key);
    }
    const pass = await runImportPass(tx, spaceId, bookId, userId, importSource, importSource.content_text, { only: keys });
    return { ...pass, importSource, batchExisted: true };
  });
}

export async function getImportBatch(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  importSourceId: string,
): Promise<ImportBatchResult> {
  const importSource = await requireOwnImportSource(db, spaceId, bookId, userId, importSourceId);
  const entries = await financeImportEntryRepository.listForSource(db, spaceId, importSource.id);
  const parsed = parseBeancountText(importSource.content_text ?? "", importFilename(userId));
  return {
    importSource,
    batchExisted: true,
    createdDirectives: 0,
    summary: summarize(entries),
    entries,
    errors: fileLevelErrors(parsed.errors, entries),
    options: parsed.options,
  };
}

export async function listImportBatches(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
): Promise<ImportSourceSummary[]> {
  const sources = await financeDirectiveRepository.listImportSourcesForUser(db, spaceId, bookId, userId);
  const result: ImportSourceSummary[] = [];
  for (const importSource of sources) {
    result.push({ importSource, summary: await financeImportEntryRepository.countByStatus(db, spaceId, importSource.id) });
  }
  return result;
}

export async function exportBeancountFromDb(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
): Promise<ExportBeancountResult> {
  const rendered = await financeLedgerEngine.exportFromDb(db, spaceId, bookId, userId);
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

// ── One import pass over a batch ──────────────────────────────────────────────

interface PassOptions {
  /** Entry keys to attempt; every other entry is left as it is. */
  only?: ReadonlySet<string>;
}

type PassResult = Omit<ImportBatchResult, "importSource" | "batchExisted">;

async function runImportPass(
  tx: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  importSource: FinanceImportSourceRow,
  text: string | null,
  options: PassOptions = {},
): Promise<PassResult> {
  if (text === null) throw new FinanceRuleError("This import batch has no stored text to retry from");
  // The server names the file being imported. Do not trust the client's name:
  // a request naming `<db>` — the label this engine gives entries loaded from
  // the ledger — turns the upload-error list into a readout of the stored
  // ledger, including balance assertions over other members' accounts.
  const filename = importFilename(userId);
  const parsed = parseBeancountText(text, filename);
  const identified = identifyImportEntries(text, parsed.entries, parsed.errors);

  // Validate the incoming file against the ledger this person can see. Do not
  // load the whole book: a balance assertion would be checked against totals
  // that include accounts they may not read, and the difference would be
  // reported back. A `balance` over a subtree that contains another member's
  // private account is checked against the part they can see, so it can fail
  // for them where it holds for the book; a `pad` whose source account is
  // hidden never discharges. The entry still lands as `proposed` with the
  // error attached; posting it is a separate, re-validated step.
  const dbLoaded = await financeLedgerEngine.loadFromDb(tx, spaceId, bookId, userId);
  const combined = transformEntries([...dbLoaded.entries, ...parsed.entries]);
  const validationErrors = validateEntries(combined).filter((error) => error.source?.filename === filename);
  const errorsByLine = new Map<number, LedgerError[]>();
  for (const error of [...parsed.errors, ...validationErrors]) {
    const lineno = error.source?.lineno;
    if (lineno === undefined) continue;
    errorsByLine.set(lineno, [...(errorsByLine.get(lineno) ?? []), error]);
  }

  // Sequence numbers are allocated in ledger order, as the engine sorts, so
  // the pass walks entries that way while keeping each one's identity.
  const byEntry = new Map<LedgerEntry, ParsedImportEntry>();
  const interpolated = interpolateEntries(identified.map((item) => item.entry));
  identified.forEach((item, index) => byEntry.set(interpolated[index]!, { ...item, entry: interpolated[index]! }));
  const ordered = sortEntries(interpolated).map((entry) => byEntry.get(entry)!);

  const persister = new ImportPersister(tx, spaceId, bookId, userId, importSource);
  await persister.preload();
  let createdDirectives = 0;
  const rows = new Map<string, FinanceImportEntryRow>();
  for (const item of ordered) {
    const row = await financeImportEntryRepository.ensure(tx, { spaceId, bookId, importSourceId: importSource.id, parsed: item });
    const entryErrors = errorsByLine.get(item.sourceLineno) ?? [];
    const outcome = await settleEntry(tx, persister, spaceId, bookId, importSource.id, row, item, entryErrors, options);
    if (outcome === null) {
      rows.set(row.id, row);
      continue;
    }
    if (outcome.status === "imported" && outcome.directiveId) createdDirectives += 1;
    rows.set(row.id, await financeImportEntryRepository.setOutcome(tx, row.id, outcome));
  }
  const entries = [...rows.values()].sort((left, right) => left.source_lineno - right.source_lineno);
  return {
    createdDirectives,
    summary: summarize(entries),
    entries,
    errors: fileLevelErrors(parsed.errors, entries),
    options: parsed.options,
  };
}

/** Null means the entry was left as it was. */
async function settleEntry(
  tx: Queryable,
  persister: ImportPersister,
  spaceId: string,
  bookId: string,
  importSourceId: string,
  row: FinanceImportEntryRow,
  item: ParsedImportEntry,
  entryErrors: LedgerError[],
  options: PassOptions,
): Promise<ImportEntryOutcome | null> {
  if (options.only && !options.only.has(row.entry_key)) return null;
  if (EXCLUDED_ENTRY_TYPES.has(item.entry.type)) {
    // Re-diagnosed on every pass: the account may have been opened since.
    return { status: "excluded", statusReason: exclusionReason(item.entry), errors: [...entryErrors, ...(await persister.diagnoseExcluded(item.entry))] };
  }
  if (item.repeatOfLineno !== null) {
    return {
      status: "error",
      statusReason: "external_id_repeated_in_file",
      errors: [...entryErrors, {
        code: "external_id_repeated_in_file",
        message: `external_id "${item.externalId}" already identifies the entry at line ${item.repeatOfLineno} of this file; give each record its own id`,
        ...(item.entry.source ? { source: item.entry.source } : {}),
      }],
    };
  }
  if (!RETRIED_STATUSES.has(row.status)) return null;
  if (row.status_reason === "not_attempted") {
    const review = await reviewAgainstOtherBatches(tx, spaceId, bookId, importSourceId, row);
    if (review) return review;
  }
  const persisted = await persister.persistEntry(item, row.account_mapping_json);
  switch (persisted.kind) {
    case "imported":
      return { status: "imported", directiveId: persisted.directiveId, errors: entryErrors };
    case "pending":
      return {
        status: "pending_mapping",
        statusReason: persisted.missingAccounts.length > 0 ? "missing_account" : "missing_commodity",
        missingAccounts: persisted.missingAccounts,
        missingCommodities: persisted.missingCommodities,
        errors: entryErrors,
      };
    case "error":
      return { status: "error", statusReason: "persist_failed", errors: [...entryErrors, persisted.error] };
  }
}

/**
 * The same identity in another batch of this book. A trusted external id that
 * another batch already imported is the same record, settled as a duplicate.
 * A content match is only probably the same record, so it waits for the
 * importer rather than being merged or copied on a guess.
 */
async function reviewAgainstOtherBatches(
  tx: Queryable,
  spaceId: string,
  bookId: string,
  importSourceId: string,
  row: FinanceImportEntryRow,
): Promise<ImportEntryOutcome | null> {
  const others = (await financeImportEntryRepository.findInOtherSources(tx, spaceId, bookId, importSourceId, row.entry_key))
    .filter((other) => other.status !== "duplicate" && other.status !== "excluded");
  if (others.length === 0) return null;
  const imported = others.find((other) => other.status === "imported");
  if (row.identity_kind === "external_id" && imported) {
    return { status: "duplicate", statusReason: "external_id_imported", duplicateOfEntryId: imported.id };
  }
  // The same id still unfinished in another batch is the same record twice
  // in flight; which upload carries it is the importer's call.
  return {
    status: "needs_review",
    statusReason: row.identity_kind === "external_id" ? "external_id_in_other_import" : "content_matches_other_import",
    duplicateOfEntryId: (imported ?? others[0]!).id,
  };
}

function exclusionReason(entry: LedgerEntry): string {
  switch (entry.type) {
    case "open":
    case "close":
      return "account_lifecycle";
    case "commodity":
      return "commodity_declaration";
    case "option":
      return "book_option";
    default:
      throw new Error(`${entry.type} is not an excluded entry type`);
  }
}

async function requireOwnImportSource(
  db: Queryable,
  spaceId: string,
  bookId: string,
  userId: string,
  importSourceId: string,
): Promise<FinanceImportSourceRow> {
  const importSource = await financeDirectiveRepository.findImportSource(db, spaceId, bookId, importSourceId);
  // Another member's upload is not found, not forbidden: its text names
  // accounts they may keep private.
  if (!importSource || importSource.imported_by_user_id !== userId) throw new FinanceRuleError("Import not found");
  return importSource;
}

async function requireEntry(
  db: Queryable,
  spaceId: string,
  importSource: FinanceImportSourceRow,
  entryId: string,
): Promise<FinanceImportEntryRow> {
  const entry = await financeImportEntryRepository.find(db, spaceId, importSource.id, entryId);
  if (!entry) throw new FinanceRuleError("Import entry not found");
  return entry;
}

function findParsedEntry(importSource: FinanceImportSourceRow, entry: FinanceImportEntryRow, userId: string): ParsedImportEntry {
  if (importSource.content_text === null) throw new FinanceRuleError("This import batch has no stored text to retry from");
  const parsed = parseBeancountText(importSource.content_text, importFilename(userId));
  const found = identifyImportEntries(importSource.content_text, parsed.entries, parsed.errors)
    .find((candidate) => candidate.entryKey === entry.entry_key);
  if (!found) throw new FinanceRuleError("Import entry no longer matches its batch");
  return found;
}

function summarize(entries: readonly FinanceImportEntryRow[]): Record<ImportEntryStatus, number> {
  const counts = emptyStatusCounts();
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}

function fileLevelErrors(parseErrors: readonly LedgerError[], entries: readonly FinanceImportEntryRow[]): LedgerError[] {
  const entryLines = new Set(entries.map((entry) => entry.source_lineno));
  return parseErrors.filter((error) => error.source === undefined || !entryLines.has(error.source.lineno));
}

function referencedAccountNames(entry: LedgerEntry): string[] {
  switch (entry.type) {
    case "transaction":
      return entry.postings.map((posting) => posting.account);
    case "balance":
    case "note":
    case "document":
      return [entry.account];
    case "pad":
      return [entry.account, entry.sourceAccount];
    default:
      return [];
  }
}

function referencedCommoditySymbols(entry: LedgerEntry): string[] {
  switch (entry.type) {
    case "transaction":
      return entry.postings.flatMap((posting) => [
        ...(posting.units ? [posting.units.currency] : []),
        ...(posting.price ? [posting.price.currency] : []),
      ]);
    case "balance":
      return [entry.amount.currency];
    case "price":
      return [entry.currency, entry.amount.currency];
    default:
      return [];
  }
}

function accountOpenOn(account: FinanceAccountRow, date: string): boolean {
  return account.opened_at <= date && (account.closed_at === null || account.closed_at >= date);
}

type PersistOutcome =
  | { kind: "imported"; directiveId: string | null }
  | { kind: "pending"; missingAccounts: string[]; missingCommodities: string[] }
  | { kind: "error"; error: LedgerError };

/**
 * Writes one entry's rows. Accounts and commodities are resolved from what the
 * book already has, as this person sees it; nothing is created on the way.
 * An entry that names something the book lacks writes nothing and waits for
 * a mapping or for the account to be opened.
 */
class ImportPersister {
  private readonly accounts = new Map<string, FinanceAccountRow>();
  private readonly commodities = new Map<string, FinanceCommodityRow>();
  private readonly sequenceByDate = new Map<string, number>();

  constructor(
    private readonly db: Queryable,
    private readonly spaceId: string,
    private readonly bookId: string,
    private readonly userId: string,
    private readonly importSource: FinanceImportSourceRow,
  ) {}

  async preload(): Promise<void> {
    // The importer's own view of the book, read on its locked transaction.
    const accounts = await financeLedgerRepository.listAccounts(this.db, this.spaceId, this.bookId, this.userId);
    const commodities = await financeLedgerRepository.listCommodities(this.db, this.spaceId, this.bookId);
    for (const account of accounts) this.accounts.set(account.name, account);
    for (const commodity of commodities) this.commodities.set(commodity.symbol, commodity);
  }

  async diagnoseExcluded(entry: LedgerEntry): Promise<LedgerError[]> {
    switch (entry.type) {
      case "open": {
        const exists = await financeLedgerRepository.accountNameExists(this.db, this.spaceId, this.bookId, entry.account);
        return [{
          code: "open_not_imported",
          message: exists
            ? `${entry.account} already exists in this book; the open directive is not applied`
            : `${entry.account} is not an account of this book; open it from account management, then retry the entries that use it`,
          source: entry.source,
        }];
      }
      case "close":
        return [{ code: "close_not_imported", message: `Closing ${entry.account} is done from account management, not by import`, source: entry.source }];
      case "commodity":
        return [{
          code: "commodity_not_imported",
          message: this.commodities.has(entry.currency)
            ? `${entry.currency} is already a commodity of this book`
            : `${entry.currency} is not a commodity of this book; add it from the commodities panel, then retry the entries that use it`,
          source: entry.source,
        }];
      case "option":
        return [{ code: "option_not_imported", message: `option "${entry.name}" is set from the book's settings, not by import`, source: entry.source }];
      default:
        return [];
    }
  }

  async persistEntry(item: ParsedImportEntry, accountMapping: Record<string, string>): Promise<PersistOutcome> {
    const { entry } = item;
    const resolved = await this.resolveReferences(entry, accountMapping);
    if (resolved.missingAccounts.length > 0 || resolved.missingCommodities.length > 0) {
      return { kind: "pending", missingAccounts: resolved.missingAccounts, missingCommodities: resolved.missingCommodities };
    }
    // Whole or not at all: a failed statement aborts the transaction, so the
    // entry runs under its own savepoint and is undone alone.
    const savedSequences = new Map(this.sequenceByDate);
    try {
      const directiveId = await attempt(this.db, () =>
        isDatedEntry(entry)
          ? this.persistDatedEntry(entry, item, resolved.accounts, resolved.commodities)
          : this.persistConfigEntry(entry, item.sourceLineno));
      return { kind: "imported", directiveId };
    } catch (err) {
      this.sequenceByDate.clear();
      savedSequences.forEach((value, key) => this.sequenceByDate.set(key, value));
      return {
        kind: "error",
        error: {
          code: "import_persist_error",
          message: err instanceof Error ? err.message : "Failed to persist entry",
          source: entry.source,
        },
      };
    }
  }

  private async resolveReferences(entry: LedgerEntry, accountMapping: Record<string, string>): Promise<{
    accounts: Map<string, FinanceAccountRow>;
    commodities: Map<string, FinanceCommodityRow>;
    missingAccounts: string[];
    missingCommodities: string[];
  }> {
    const date = "date" in entry ? entry.date : null;
    const accounts = new Map<string, FinanceAccountRow>();
    const missingAccounts: string[] = [];
    for (const name of new Set(referencedAccountNames(entry))) {
      const account = await this.resolveAccount(name, date, accountMapping[name]);
      if (account) accounts.set(name, account);
      else missingAccounts.push(name);
    }
    const commodities = new Map<string, FinanceCommodityRow>();
    const missingCommodities: string[] = [];
    for (const symbol of new Set(referencedCommoditySymbols(entry))) {
      const commodity = this.commodities.get(symbol);
      if (commodity) commodities.set(symbol, commodity);
      else missingCommodities.push(symbol);
    }
    return { accounts, commodities, missingAccounts, missingCommodities };
  }

  /**
   * A mapped name resolves to the mapped account, re-checked now rather than
   * trusted from when the mapping was saved; an unmapped name resolves to the
   * account of that name this person can see. Either must be open on the
   * entry's date. A name that resolves to nothing usable is missing, not an
   * error: the entry waits.
   */
  private async resolveAccount(name: string, date: string | null, mappedId: string | undefined): Promise<FinanceAccountRow | null> {
    const account = mappedId
      ? await financeLedgerRepository.findAccountForViewer(this.db, this.spaceId, this.bookId, mappedId, this.userId)
      : this.accounts.get(name) ?? null;
    if (!account) return null;
    if (date !== null && !accountOpenOn(account, date)) return null;
    return account;
  }

  private async persistConfigEntry(entry: Exclude<LedgerEntry, DatedEntry>, sortOrder: number): Promise<null> {
    switch (entry.type) {
      case "include":
        await financeDirectiveRepository.insertInclude(this.db, { spaceId: this.spaceId, bookId: this.bookId, path: entry.path, sortOrder });
        return null;
      case "plugin":
        await financeDirectiveRepository.insertPluginDirective(this.db, {
          spaceId: this.spaceId, bookId: this.bookId, module: entry.module, config: entry.config, sortOrder,
        });
        return null;
      case "pushtag":
      case "poptag":
        await financeDirectiveRepository.insertTagStackEvent(this.db, {
          spaceId: this.spaceId, bookId: this.bookId, eventType: entry.type === "pushtag" ? "push" : "pop",
          tag: entry.tag, sortOrder, sourceLineno: entry.source?.lineno,
        });
        return null;
      case "pushmeta":
      case "popmeta":
        await financeDirectiveRepository.insertMetaStackEvent(this.db, {
          spaceId: this.spaceId, bookId: this.bookId, eventType: entry.type === "pushmeta" ? "push" : "pop",
          key: entry.key, value: entry.value, sortOrder, sourceLineno: entry.source?.lineno,
        });
        return null;
      case "option":
        throw new Error("option directives are excluded before persistence");
    }
  }

  private async persistDatedEntry(
    entry: DatedEntry,
    item: ParsedImportEntry,
    accounts: Map<string, FinanceAccountRow>,
    commodities: Map<string, FinanceCommodityRow>,
  ): Promise<string> {
    const account = (name: string) => accounts.get(name)!;
    const commodity = (symbol: string) => commodities.get(symbol)!;
    switch (entry.type) {
      case "open":
      case "close":
      case "commodity":
        throw new Error(`${entry.type} directives are excluded before persistence`);
      case "transaction":
        return this.persistTransaction(entry, item, accounts, commodities);
      case "balance": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertBalanceAssertion(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account(entry.account).id,
          accountName: account(entry.account).name,
          amountText: entry.amount.number.decimal,
          amountScale: entry.amount.number.scale,
          commodityId: commodity(entry.amount.currency).id,
          commoditySymbol: commodity(entry.amount.currency).symbol,
          toleranceText: entry.tolerance?.number.decimal,
          toleranceScale: entry.tolerance?.number.scale,
        });
        return directive.id;
      }
      case "pad": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertPad(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account(entry.account).id,
          accountName: account(entry.account).name,
          sourceAccountId: account(entry.sourceAccount).id,
          sourceAccountName: account(entry.sourceAccount).name,
        });
        return directive.id;
      }
      case "price": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertPrice(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          commodityId: commodity(entry.currency).id,
          commoditySymbol: commodity(entry.currency).symbol,
          amountText: entry.amount.number.decimal,
          amountScale: entry.amount.number.scale,
          priceCommodityId: commodity(entry.amount.currency).id,
          priceCommoditySymbol: commodity(entry.amount.currency).symbol,
        });
        return directive.id;
      }
      case "note": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertNote(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account(entry.account).id,
          accountName: account(entry.account).name,
          comment: entry.comment,
          tags: [...entry.tags],
          links: [...entry.links],
        });
        return directive.id;
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
        return directive.id;
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
        return directive.id;
      }
      case "document": {
        const directive = await this.insertDirective(entry);
        await financeDirectiveRepository.insertDocument(this.db, {
          directiveId: directive.id,
          spaceId: this.spaceId,
          bookId: this.bookId,
          accountId: account(entry.account).id,
          accountName: account(entry.account).name,
          filename: entry.filename,
          tags: [...entry.tags],
          links: [...entry.links],
        });
        return directive.id;
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
        return directive.id;
      }
    }
  }

  private async persistTransaction(
    entry: TransactionEntry,
    item: ParsedImportEntry,
    accounts: Map<string, FinanceAccountRow>,
    commodities: Map<string, FinanceCommodityRow>,
  ): Promise<string> {
    const directive = await this.insertDirective(entry);
    await financeLedgerRepository.insertTransaction(this.db, {
      spaceId: this.spaceId,
      bookId: this.bookId,
      directiveId: directive.id,
      flag: entry.flag,
      payee: entry.payee,
      narration: entry.narration,
      externalId: item.externalId,
      importHash: this.importSource.content_hash,
      tags: [...entry.tags],
      links: [...entry.links],
      metadata: entry.meta,
    });
    let sortOrder = 0;
    for (const posting of entry.postings) {
      const record = this.buildPostingRecord(directive.id, accounts.get(posting.account)!, posting, commodities, sortOrder);
      await financeLedgerRepository.insertPosting(this.db, record);
      sortOrder += 1;
    }
    return directive.id;
  }

  private buildPostingRecord(
    directiveId: string,
    account: FinanceAccountRow,
    posting: PostingEntry,
    commodities: Map<string, FinanceCommodityRow>,
    sortOrder: number,
  ): InsertPostingRecord {
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
      const commodity = commodities.get(posting.units.currency)!;
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
      const priceCommodity = commodities.get(posting.price.currency)!;
      record.priceNumberText = posting.price.number.decimal;
      record.priceNumberScale = posting.price.number.scale;
      record.priceCommodityId = priceCommodity.id;
      record.priceCommoditySymbol = priceCommodity.symbol;
      record.priceIsTotal = posting.priceIsTotal;
    }

    return record;
  }

  private async insertDirective(entry: DatedEntry) {
    // The cached MAX+1 races with a directive another member creates on the
    // same day; the unique sequence refuses one of the two, so re-read and
    // retry rather than drop the entry.
    for (let round = 0; ; round += 1) {
      try {
        const sequence = await this.nextSequence(entry.date);
        return await attempt(this.db, () => financeLedgerRepository.insertDirective(this.db, {
          spaceId: this.spaceId,
          bookId: this.bookId,
          directiveType: entry.type,
          date: entry.date,
          sequence,
          status: IMPORTED_STATUS,
          createdByUserId: this.userId,
          importSourceId: this.importSource.id,
          sourceFilename: entry.source?.filename,
          sourceLineno: entry.source?.lineno,
          sourceHash: this.importSource.content_hash,
          metadata: entry.meta,
        }));
      } catch (err) {
        if (round >= 9 || !isSequenceConflict(err)) throw err;
        this.sequenceByDate.delete(entry.date);
      }
    }
  }

  private async nextSequence(date: string): Promise<number> {
    let next = this.sequenceByDate.get(date);
    if (next === undefined) {
      next = await financeLedgerRepository.nextSequence(this.db, this.spaceId, this.bookId, date);
    }
    this.sequenceByDate.set(date, next + 1);
    return next;
  }
}

/**
 * The name recorded for an uploaded file.
 *
 * Server-chosen, and never one of the engine's own reserved labels, so the
 * filename filter over validation errors can only ever select the upload's.
 */
function importFilename(userId: string): string {
  return `<import:${userId}>`;
}
