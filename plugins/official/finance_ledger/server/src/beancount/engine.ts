import type { Queryable } from "@rainver/protocol";
import { Amount } from "../domain/amount.js";
import { financeDirectiveRepository } from "../domain/directiveRepository.js";
import type { FinancePostingRow } from "../domain/directives.js";
import { Cost, CostSpec } from "../domain/position.js";
import { financeLedgerRepository } from "../domain/repository.js";
import type {
  EntryMetadata,
  LedgerEntry,
  LedgerError,
  LedgerLoadResult,
  MetadataValue,
  PostingEntry,
  TransactionEntry,
} from "./entries.js";
import { BeancountExporter } from "./exporter.js";
import { parseBeancountText } from "./importer.js";
import { sortEntries } from "./sort.js";
import { transformEntries, validateEntries } from "./validation.js";

const DB_SOURCE = "<db>";

export class FinanceLedgerEngine {
  constructor(
    private readonly repository = financeLedgerRepository,
    private readonly directiveRepository = financeDirectiveRepository,
    private readonly exporter = new BeancountExporter(),
  ) {}

  loadFromText(text: string, filename?: string): LedgerLoadResult {
    const parsed = parseBeancountText(text, filename);
    const entries = sortEntries(transformEntries(parsed.entries));
    const errors = [...parsed.errors, ...validateEntries(entries)];
    return { entries, errors, options: parsed.options };
  }

  /**
   * Loads the committed (posted) directive stream from PostgreSQL as raw
   * ledger entries. Entries are sorted but not transformed, so pads remain
   * pad directives; validation runs on a transformed copy.
   */
  async loadFromDb(db: Queryable, spaceId: string, bookId: string): Promise<LedgerLoadResult> {
    const [
      book,
      ledgerOptions,
      includes,
      pluginDirectives,
      tagStacks,
      metaStacks,
      accounts,
      commodities,
      transactions,
      balances,
      pads,
      prices,
      notes,
      events,
      queries,
      documents,
      customs,
    ] = await Promise.all([
      this.repository.findBook(db, spaceId, bookId),
      this.directiveRepository.listLedgerOptions(db, spaceId, bookId),
      this.directiveRepository.listIncludes(db, spaceId, bookId),
      this.directiveRepository.listPluginDirectives(db, spaceId, bookId),
      this.directiveRepository.listTagStackEvents(db, spaceId, bookId),
      this.directiveRepository.listMetaStackEvents(db, spaceId, bookId),
      this.repository.listAccounts(db, spaceId, bookId),
      this.repository.listCommodities(db, spaceId, bookId),
      this.repository.listTransactions(db, spaceId, bookId),
      this.directiveRepository.listBalanceAssertions(db, spaceId, bookId, "posted"),
      this.directiveRepository.listPads(db, spaceId, bookId, "posted"),
      this.directiveRepository.listPrices(db, spaceId, bookId, "posted"),
      this.directiveRepository.listNotes(db, spaceId, bookId, "posted"),
      this.directiveRepository.listEvents(db, spaceId, bookId, "posted"),
      this.directiveRepository.listQueries(db, spaceId, bookId, "posted"),
      this.directiveRepository.listDocuments(db, spaceId, bookId, "posted"),
      this.directiveRepository.listCustoms(db, spaceId, bookId, "posted"),
    ]);

    const options: Record<string, string> = {};
    if (book) {
      options["title"] = book.name;
      options["operating_currency"] = book.operating_currency;
    }
    for (const option of ledgerOptions) {
      const value = option.value_json["value"];
      options[option.name] = typeof value === "string" ? value : JSON.stringify(value);
    }

    const entries: LedgerEntry[] = [];
    for (const include of includes) {
      entries.push({ type: "include", path: include.path, meta: {} });
    }
    for (const plugin of pluginDirectives) {
      entries.push({ type: "plugin", module: plugin.module, config: plugin.config, meta: {} });
    }
    for (const event of tagStacks) {
      entries.push({
        type: event.event_type === "push" ? "pushtag" : "poptag",
        tag: event.tag,
        meta: {},
      });
    }
    for (const event of metaStacks) {
      const value = event.value_json?.["value"];
      entries.push({
        type: event.event_type === "push" ? "pushmeta" : "popmeta",
        key: event.key,
        value: typeof value === "string" ? value : null,
        meta: {},
      });
    }

    for (const commodity of commodities) {
      const { declared_date: declaredDate, ...meta } = commodity.metadata_json;
      entries.push({
        type: "commodity",
        date: typeof declaredDate === "string" ? declaredDate : commodity.created_at.slice(0, 10),
        currency: commodity.symbol,
        meta: metadataFromRecord(meta),
      });
    }
    for (const account of accounts) {
      entries.push({
        type: "open",
        date: account.opened_at,
        account: account.name,
        currencies: account.commodity_constraints ?? [],
        booking: account.booking_method,
        meta: metadataFromRecord(account.metadata_json),
      });
      if (account.closed_at) {
        entries.push({ type: "close", date: account.closed_at, account: account.name, meta: {} });
      }
    }

    for (const balance of balances) {
      entries.push({
        type: "balance",
        date: balance.date,
        account: balance.account_name,
        amount: Amount.of(balance.amount_text, balance.commodity_symbol),
        tolerance: balance.tolerance_text
          ? Amount.of(balance.tolerance_text, balance.commodity_symbol)
          : null,
        meta: metadataFromRecord(balance.metadata_json),
        source: dbSource(balance.sequence),
      });
    }
    for (const pad of pads) {
      entries.push({
        type: "pad",
        date: pad.date,
        account: pad.account_name,
        sourceAccount: pad.source_account_name,
        meta: metadataFromRecord(pad.metadata_json),
        source: dbSource(pad.sequence),
      });
    }
    for (const price of prices) {
      entries.push({
        type: "price",
        date: price.date,
        currency: price.commodity_symbol,
        amount: Amount.of(price.amount_text, price.price_commodity_symbol),
        meta: metadataFromRecord(price.metadata_json),
        source: dbSource(price.sequence),
      });
    }
    for (const note of notes) {
      entries.push({
        type: "note",
        date: note.date,
        account: note.account_name,
        comment: note.comment,
        tags: new Set(note.tags),
        links: new Set(note.links),
        meta: metadataFromRecord(note.metadata_json),
        source: dbSource(note.sequence),
      });
    }
    for (const event of events) {
      entries.push({
        type: "event",
        date: event.date,
        eventType: event.event_type,
        description: event.description,
        meta: metadataFromRecord(event.metadata_json),
        source: dbSource(event.sequence),
      });
    }
    for (const query of queries) {
      entries.push({
        type: "query",
        date: query.date,
        name: query.name,
        queryString: query.query_string,
        meta: metadataFromRecord(query.metadata_json),
        source: dbSource(query.sequence),
      });
    }
    for (const document of documents) {
      entries.push({
        type: "document",
        date: document.date,
        account: document.account_name,
        filename: document.filename,
        tags: new Set(document.tags),
        links: new Set(document.links),
        meta: metadataFromRecord(document.metadata_json),
        source: dbSource(document.sequence),
      });
    }
    for (const custom of customs) {
      entries.push({
        type: "custom",
        date: custom.date,
        customType: custom.custom_type,
        values: custom.values,
        meta: metadataFromRecord(custom.metadata_json),
        source: dbSource(custom.sequence),
      });
    }

    for (const transaction of transactions) {
      if (transaction.directive.status !== "posted") continue;
      const postings = await this.repository.getTransactionPostings(
        db,
        spaceId,
        bookId,
        transaction.directive_id,
      );
      entries.push({
        type: "transaction",
        date: transaction.directive.date,
        flag: transaction.flag,
        payee: transaction.payee,
        narration: transaction.narration,
        tags: new Set(transaction.tags),
        links: new Set(transaction.links),
        postings: postings.map((posting) => postingEntryFromRow(posting)),
        meta: metadataFromRecord(transaction.metadata_json),
        source: dbSource(transaction.directive.sequence),
      } satisfies TransactionEntry);
    }

    const sorted = sortEntries(entries);
    return { entries: sorted, errors: validateEntries(transformEntries(sorted)), options };
  }

  async exportFromDb(
    db: Queryable,
    spaceId: string,
    bookId: string,
  ): Promise<{ content: string; errors: LedgerError[] }> {
    const loaded = await this.loadFromDb(db, spaceId, bookId);
    return { content: this.exporter.export(loaded.entries, loaded.options), errors: loaded.errors };
  }

  exportEntries(entries: readonly LedgerEntry[], options: Record<string, string> = {}): string {
    return this.exporter.export(sortEntries(transformEntries(entries)), options);
  }
}

export const financeLedgerEngine = new FinanceLedgerEngine();

function dbSource(sequence: number): { filename: string; lineno: number } {
  return { filename: DB_SOURCE, lineno: sequence + 1 };
}

export function postingEntryFromRow(posting: FinancePostingRow): PostingEntry {
  return {
    account: posting.account_name,
    units:
      posting.amount_text && posting.commodity_symbol
        ? Amount.of(posting.amount_text, posting.commodity_symbol)
        : null,
    cost: costFromRow(posting),
    price:
      posting.price_number_text && posting.price_commodity_symbol
        ? Amount.of(posting.price_number_text, posting.price_commodity_symbol)
        : null,
    priceIsTotal: posting.price_is_total,
    flag: posting.flag,
    meta: metadataFromRecord(posting.metadata_json),
  };
}

function costFromRow(posting: FinancePostingRow): Cost | CostSpec | null {
  const hasCost =
    posting.cost_number_text !== null ||
    posting.cost_number_total_text !== null ||
    posting.cost_currency !== null ||
    posting.cost_merge !== null;
  if (!hasCost) return null;
  if (
    posting.cost_number_text &&
    posting.cost_currency &&
    !posting.cost_number_total_text &&
    !posting.cost_merge
  ) {
    return new Cost({
      number: posting.cost_number_text,
      currency: posting.cost_currency,
      date: posting.cost_date,
      label: posting.cost_label,
    });
  }
  return new CostSpec({
    numberPer: posting.cost_number_text,
    numberTotal: posting.cost_number_total_text,
    currency: posting.cost_currency,
    date: posting.cost_date,
    label: posting.cost_label,
    merge: posting.cost_merge,
  });
}

function metadataFromRecord(input: Record<string, unknown>): EntryMetadata {
  const result: EntryMetadata = {};
  for (const [key, value] of Object.entries(input)) {
    if (isMetadataValue(value)) result[key] = value;
  }
  return result;
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
