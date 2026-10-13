import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { resetTables } from "./support/resetTables.js";
import { loadFinanceLedgerRuntime, type ImportEntryForTest, type ImportResultForTest } from "./financeLedgerRuntime.js";
import { useTestDatabase } from "./support/testDatabase.js";

const {
  plugin: { financeLedgerPlugin },
  service: { financeLedgerService },
  engine: { financeLedgerEngine },
  proposalAppliers: {
    PROPOSAL_TYPE_POST_DIRECTIVE,
    PROPOSAL_TYPE_POST_IMPORT_BATCH,
    applyPostDirective,
    applyPostImportBatch,
  },
} = loadFinanceLedgerRuntime();


const SPACE_A = "space-finance-import-a";
const SPACE_B = "space-finance-import-b";
const USER_1 = "user-finance-import-1";
const USER_2 = "user-finance-import-2";

const FULL_FIXTURE = `
option "title" "Household Book"
include "prices.beancount"
plugin "beancount.plugins.leafonly"
pushtag #import2026

2026-01-01 commodity USD
2026-01-01 open Assets:Bank:Checking USD
2026-01-01 open Equity:Opening-Balances
2026-01-01 open Expenses:Food USD
2026-01-01 open Assets:Broker

2026-01-02 pad Assets:Bank:Checking Equity:Opening-Balances
2026-01-03 balance Assets:Bank:Checking 100.00 USD

2026-01-04 * "Tesco" "Groceries" ^receipt-1
  category: "food"
  Assets:Bank:Checking  -12.50 USD
  Expenses:Food

2026-01-05 * "Buy GOOG"
  Assets:Broker  2 GOOG {30.00 USD}
  Assets:Bank:Checking  -60.00 USD

2026-01-06 price GOOG 31.00 USD
2026-01-06 note Assets:Bank:Checking "Reconciled with statement"
2026-01-06 event "location" "Berlin"
2026-01-06 query "food-spend" "SELECT account WHERE account ~ 'Food'"
2026-01-06 document Assets:Bank:Checking "statement-jan.pdf"
2026-01-06 custom "budget" "food" 100.00 USD

poptag #import2026
`;

/** The fixture's dated directives an import lands once the book has its accounts and commodities. */
const FIXTURE_IMPORTABLE_DIRECTIVES = 10;

const db = useTestDatabase(import.meta.filename, { max: 10, empty: true });

beforeAll(async () => {
  if (!db.available) return;
  for (const migration of financeLedgerPlugin.migrations!) {
  await db.pool.query(migration.sql);
  }
});

beforeEach(async () => {
  await resetTables(db.pool, ["finance_books"], { cascade: true });
});

async function createBook(spaceId = SPACE_A) {
  return financeLedgerService.createFinanceBook(db.pool, spaceId, USER_1, {
    name: "Household",
    baseCurrency: "USD",
  });
}

async function openAccounts(bookId: string, names: string[], openedAt = "2026-01-01", spaceId = SPACE_A) {
  const accounts: Record<string, string> = {};
  for (const name of names) {
    const account = await financeLedgerService.openAccount(db.pool, spaceId, bookId, { name, openedAt });
    accounts[name] = account.id;
  }
  return accounts;
}

async function addCommodities(bookId: string, symbols: string[], spaceId = SPACE_A) {
  for (const symbol of symbols) {
    await financeLedgerService.createCommodity(db.pool, spaceId, bookId, { symbol, commodityType: "currency" });
  }
}

/** A book that holds everything the full fixture refers to. */
async function createFixtureBook() {
  const book = await createBook();
  await addCommodities(book.id, ["USD", "GOOG"]);
  await openAccounts(book.id, ["Assets:Bank:Checking", "Equity:Opening-Balances", "Expenses:Food", "Assets:Broker"]);
  return book;
}

function importText(bookId: string, text: string, userId = USER_1, spaceId = SPACE_A): Promise<ImportResultForTest> {
  return financeLedgerService.importBeancount(db.pool, spaceId, bookId, userId, { text });
}

function entriesOf(result: ImportResultForTest, type: string): ImportEntryForTest[] {
  return result.entries.filter((entry) => entry.entry_type === type);
}

describe("finance ledger Beancount import", () => {
  it("lands what the book can hold as proposed and holds the rest for mapping, opening nothing", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    const result = await importText(book.id, FULL_FIXTURE);

    expect(result.batchExisted).toBe(false);
    // event, query and custom name no account; everything else waits.
    expect(result.createdDirectives).toBe(3);
    expect(result.summary).toEqual({
      imported: 7, pending_mapping: 7, needs_review: 0, duplicate: 0, error: 0, excluded: 6,
    });
    expect(result.errors).toEqual([]);
    const pending = result.entries.filter((entry) => entry.status === "pending_mapping");
    expect(pending.map((entry) => entry.entry_type).sort()).toEqual(
      ["balance", "document", "note", "pad", "price", "transaction", "transaction"],
    );
    expect(pending.find((entry) => entry.entry_type === "pad")?.missing_accounts).toEqual(
      ["Assets:Bank:Checking", "Equity:Opening-Balances"],
    );
    expect(pending.find((entry) => entry.entry_type === "price")).toMatchObject({
      status_reason: "missing_commodity", missing_accounts: [], missing_commodities: ["GOOG"],
    });
    expect(result.entries.filter((entry) => entry.status === "excluded").map((entry) => [entry.entry_type, entry.status_reason]))
      .toEqual([
        ["option", "book_option"], ["commodity", "commodity_declaration"], ["open", "account_lifecycle"],
        ["open", "account_lifecycle"], ["open", "account_lifecycle"], ["open", "account_lifecycle"],
      ]);
    expect(result.entries.find((entry) => entry.entry_type === "open")?.errors_json).toEqual([
      expect.objectContaining({ code: "open_not_imported", message: expect.stringContaining("open it from account management") }),
    ]);

    // The file opened nothing, declared nothing, and set no option.
    expect(await financeLedgerService.listAccounts(db.pool, SPACE_A, book.id)).toEqual([]);
    expect((await financeLedgerService.listCommodities(db.pool, SPACE_A, book.id)).map((c) => c.symbol)).toEqual(["USD"]);
    expect(await financeLedgerService.listLedgerOptions(db.pool, SPACE_A, book.id)).toEqual([]);
    const directives = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id);
    expect(directives.map((d) => d["directive_type"]).sort()).toEqual(["custom", "event", "query"]);
    expect(new Set(directives.map((d) => d["status"]))).toEqual(new Set(["proposed"]));
    const configRows = await db.pool.query(
      `SELECT
         (SELECT count(*) FROM finance_includes WHERE book_id = $1) AS includes,
         (SELECT count(*) FROM finance_plugin_directives WHERE book_id = $1) AS plugins,
         (SELECT count(*) FROM finance_tag_stack_events WHERE book_id = $1) AS tag_events,
         (SELECT count(*) FROM finance_ledger_options WHERE book_id = $1) AS options,
         (SELECT count(*) FROM finance_import_sources WHERE book_id = $1) AS sources`,
      [book.id],
    );
    expect(configRows.rows[0]).toEqual({ includes: "1", plugins: "1", tag_events: "2", options: "0", sources: "1" });
  });

  it("retries only the unfinished entries when the same file is uploaded again", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    const first = await importText(book.id, FULL_FIXTURE);
    const importedBefore = first.entries.filter((entry) => entry.status === "imported").map((entry) => entry.directive_id);

    await addCommodities(book.id, ["GOOG"]);
    await openAccounts(book.id, ["Assets:Bank:Checking", "Equity:Opening-Balances", "Expenses:Food", "Assets:Broker"]);
    const second = await importText(book.id, FULL_FIXTURE);

    expect(second.importSource.id).toBe(first.importSource.id);
    expect(second.batchExisted).toBe(true);
    expect(second.createdDirectives).toBe(7);
    expect(second.summary).toMatchObject({ imported: 14, pending_mapping: 0, error: 0, excluded: 6 });
    // The drafts made the first time are the same drafts.
    const importedAfter = second.entries.filter((entry) => entry.status === "imported").map((entry) => entry.directive_id);
    for (const id of importedBefore) expect(importedAfter).toContain(id);
    const directives = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id);
    expect(directives).toHaveLength(FIXTURE_IMPORTABLE_DIRECTIVES);
    const configRows = await db.pool.query(
      `SELECT (SELECT count(*) FROM finance_includes WHERE book_id = $1) AS includes,
              (SELECT count(*) FROM finance_tag_stack_events WHERE book_id = $1) AS tag_events`,
      [book.id],
    );
    expect(configRows.rows[0]).toEqual({ includes: "1", tag_events: "2" });

    // A third upload changes nothing.
    const third = await importText(book.id, FULL_FIXTURE);
    expect(third.createdDirectives).toBe(0);
    expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id)).toHaveLength(FIXTURE_IMPORTABLE_DIRECTIVES);
  });

  it("maps a missing account name onto an existing account for one entry without touching the original", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    const accounts = await openAccounts(book.id, ["Assets:Cash", "Expenses:Food", "Expenses:Dining"]);
    const result = await importText(book.id, `2026-01-02 * "Lunch"
  Assets:Cash  -8.00 USD
  Expenses:Restaurants  8.00 USD
2026-01-03 * "Groceries"
  Assets:Cash  -20.00 USD
  Expenses:Food  20.00 USD
`);
    expect(result.summary).toMatchObject({ imported: 1, pending_mapping: 1 });
    const lunch = result.entries.find((entry) => entry.status === "pending_mapping")!;
    expect(lunch.missing_accounts).toEqual(["Expenses:Restaurants"]);

    // A name the entry does not use, and an account not open on the date, are refused.
    await expect(financeLedgerService.applyImportEntryMapping(
      db.pool, SPACE_A, book.id, USER_1, result.importSource.id, lunch.id, { "Expenses:Other": accounts["Expenses:Dining"]! },
    )).rejects.toThrow("does not reference account Expenses:Other");
    const late = await financeLedgerService.openAccount(db.pool, SPACE_A, book.id, { name: "Expenses:Late", openedAt: "2026-02-01" });
    await expect(financeLedgerService.applyImportEntryMapping(
      db.pool, SPACE_A, book.id, USER_1, result.importSource.id, lunch.id, { "Expenses:Restaurants": late.id },
    )).rejects.toThrow("is not open on 2026-01-02");

    const mapped = await financeLedgerService.applyImportEntryMapping(
      db.pool, SPACE_A, book.id, USER_1, result.importSource.id, lunch.id, { "Expenses:Restaurants": accounts["Expenses:Dining"]! },
    );
    expect(mapped.createdDirectives).toBe(1);
    const entry = mapped.entries.find((candidate) => candidate.id === lunch.id)!;
    expect(entry).toMatchObject({ status: "imported", mapping_version: 1, account_mapping_json: { "Expenses:Restaurants": accounts["Expenses:Dining"] } });
    expect(entry.raw_text).toContain("Expenses:Restaurants  8.00 USD");
    const postings = await db.pool.query<{ account_name: string }>(
      `SELECT account_name FROM finance_postings WHERE transaction_directive_id = $1 ORDER BY sort_order`,
      [entry.directive_id],
    );
    expect(postings.rows.map((row) => row.account_name)).toEqual(["Assets:Cash", "Expenses:Dining"]);
    // Mapping an entry that is already imported is refused.
    await expect(financeLedgerService.applyImportEntryMapping(
      db.pool, SPACE_A, book.id, USER_1, result.importSource.id, lunch.id, { "Expenses:Restaurants": accounts["Expenses:Food"]! },
    )).rejects.toThrow("only an unfinished entry takes a mapping");
  });

  it("never closes an account from a file", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Food"]);
    const result = await importText(book.id, `2026-07-01 close Assets:Cash
2026-07-02 * "Later expense"
  Assets:Cash -1 USD
  Expenses:Food 1 USD
`);
    expect(result.summary).toMatchObject({ imported: 1, excluded: 1 });
    expect(entriesOf(result, "close")[0]).toMatchObject({
      status: "excluded",
      status_reason: "account_lifecycle",
      errors_json: [expect.objectContaining({ code: "close_not_imported" })],
    });
    const accounts = await financeLedgerService.listAccounts(db.pool, SPACE_A, book.id, USER_1);
    expect(accounts.find((account) => account.name === "Assets:Cash")?.closed_at).toBeNull();
  });

  it("refuses to approve an import after its account closes before the transaction date", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Food"]);
    const imported = await importText(book.id, `2026-07-02 * "Later expense"
  Assets:Cash -1 USD
  Expenses:Food 1 USD
`);
    expect(imported.summary.imported).toBe(1);
    const accounts = await financeLedgerService.listAccounts(db.pool, SPACE_A, book.id, USER_1);
    const cash = accounts.find((account) => account.name === "Assets:Cash")!;
    await financeLedgerService.closeAccount(db.pool, SPACE_A, book.id, cash.id as string, "2026-07-01", USER_1);
    await expect(financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, imported.importSource.id))
      .rejects.toThrow("Directive uses an account that is not open on its date");
    const directives = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id);
    expect(directives.every((directive) => directive.status === "proposed")).toBe(true);
  });

  it("reads and writes a balance tolerance in Beancount's order", async () => {
    // Beancount writes `NUMBER ~ TOLERANCE CURRENCY`. A file from bean-check
    // or Fava has to import, and what this plugin exports has to parse there.
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Equity:Opening-Balances"]);
    const imported = await importText(book.id, `
2026-01-02 pad Assets:Cash Equity:Opening-Balances
2026-01-03 balance Assets:Cash 100.00 ~ 0.01 USD
`);
    expect(imported.summary).toMatchObject({ imported: 2, error: 0, pending_mapping: 0 });
    await financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, imported.importSource.id);

    const exported = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);
    expect(exported.content).toContain("2026-01-03 balance Assets:Cash 100.00 ~ 0.01 USD");
    const reparsed = financeLedgerEngine.loadFromText(exported.content, "roundtrip.beancount");
    expect(reparsed.errors).toEqual([]);
    const balance = reparsed.entries.find((entry) => entry.type === "balance");
    expect(balance).toMatchObject({ amount: { currency: "USD" }, tolerance: { currency: "USD" } });
    expect(String((balance as unknown as { tolerance: { number: { decimal: string } } }).tolerance.number.decimal)).toBe("0.01");
  });

  it("lands an entry with validation errors as proposed with the errors attached", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Misc"]);
    const result = await importText(book.id, `
2026-01-02 * "Unbalanced"
  Assets:Cash  -1.00 USD
  Expenses:Misc  2.00 USD
`);
    const [entry] = entriesOf(result, "transaction");
    expect(entry).toMatchObject({
      status: "imported",
      errors_json: [expect.objectContaining({ code: "transaction_unbalanced" })],
    });
    await expect(financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, result.importSource.id))
      .rejects.toThrow("does not balance");
  });

  it("keeps two transactions that read the same as two records", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Coffee"]);
    const coffee = `2026-01-02 * "Coffee"
  Assets:Cash  -3.00 USD
  Expenses:Coffee  3.00 USD
`;
    const result = await importText(book.id, `${coffee}\n${coffee}`);
    expect(result.summary).toMatchObject({ imported: 2 });
    const [first, second] = entriesOf(result, "transaction");
    expect(first!.entry_key).not.toBe(second!.entry_key);
    expect(first!.entry_key.replace(/:\d+$/, "")).toBe(second!.entry_key.replace(/:\d+$/, ""));
    const transactions = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, { directiveType: "transaction" });
    expect(transactions).toHaveLength(2);
    // The same file again: the same two records, not four.
    await importText(book.id, `${coffee}\n${coffee}`);
    expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, { directiveType: "transaction" })).toHaveLength(2);
  });

  it("asks before importing content another batch already holds, and settles trusted external ids itself", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Coffee", "Expenses:Food"]);
    const coffee = `2026-01-02 * "Coffee"
  Assets:Cash  -3.00 USD
  Expenses:Coffee  3.00 USD
`;
    const withId = `2026-01-05 * "Bank fee"
  external_id: "bank-7"
  Assets:Cash  -1.00 USD
  Expenses:Food  1.00 USD
`;
    const first = await importText(book.id, `${coffee}\n${withId}`);
    expect(first.summary).toMatchObject({ imported: 2 });
    expect(entriesOf(first, "transaction").map((entry) => entry.identity_kind)).toEqual(["content_occurrence", "external_id"]);

    const groceries = `2026-01-03 * "Groceries"
  Assets:Cash  -20.00 USD
  Expenses:Food  20.00 USD
`;
    const second = await importText(book.id, `${coffee}\n${groceries}\n${withId}`);
    expect(second.importSource.id).not.toBe(first.importSource.id);
    expect(second.summary).toEqual({ imported: 1, pending_mapping: 0, needs_review: 1, duplicate: 1, error: 0, excluded: 0 });
    const review = second.entries.find((entry) => entry.status === "needs_review")!;
    expect(review.raw_text).toContain('"Coffee"');
    expect(review.duplicate_of_entry_id).toBe(entriesOf(first, "transaction")[0]!.id);
    const fee = second.entries.find((entry) => entry.status === "duplicate")!;
    expect(fee).toMatchObject({ external_id: "bank-7", status_reason: "external_id_imported", directive_id: null });
    expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, { directiveType: "transaction" })).toHaveLength(3);

    // Nothing moves until the importer decides; a retry does not re-ask or import it.
    const retried = await financeLedgerService.retryImportBatch(db.pool, SPACE_A, book.id, USER_1, second.importSource.id);
    expect(retried.summary.needs_review).toBe(1);

    const decided = await financeLedgerService.decideImportEntryReview(
      db.pool, SPACE_A, book.id, USER_1, second.importSource.id, "import", [review.id],
    );
    expect(decided.entries.find((entry) => entry.id === review.id)).toMatchObject({ status: "imported", directive_id: expect.any(String) });
    expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, { directiveType: "transaction" })).toHaveLength(4);

    // The other way round, for a third batch: recorded as the same record.
    const third = await importText(book.id, `${groceries}\n; a comment\n`);
    expect(third.summary.needs_review).toBe(1);
    const settled = await financeLedgerService.decideImportEntryReview(db.pool, SPACE_A, book.id, USER_1, third.importSource.id, "duplicate", null);
    expect(settled.summary).toMatchObject({ duplicate: 1, imported: 0 });
    expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, { directiveType: "transaction" })).toHaveLength(4);
  });

  it("makes one batch and one set of drafts when the same file is imported concurrently", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Food"]);
    const text = `2026-01-03 * "Groceries"
  Assets:Cash  -20.00 USD
  Expenses:Food  20.00 USD
`;
    const results = await Promise.all([importText(book.id, text), importText(book.id, text), importText(book.id, text)]);
    expect(new Set(results.map((result) => result.importSource.id)).size).toBe(1);
    expect(results.map((result) => result.createdDirectives).sort()).toEqual([0, 0, 1]);
    expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id)).toHaveLength(1);
    const entries = await db.pool.query(`SELECT count(*)::int AS n FROM finance_import_entries WHERE book_id = $1`, [book.id]);
    expect(entries.rows[0].n).toBe(1);
  });

  it("keeps a batch to the member who uploaded it", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Food"]);
    const text = `2026-01-03 * "Groceries"
  Assets:Cash  -20.00 USD
  Expenses:Food  20.00 USD
`;
    const mine = await importText(book.id, text);
    await expect(importText(book.id, text, USER_2)).rejects.toThrow("already imported by another member");
    await expect(financeLedgerService.getImportBatch(db.pool, SPACE_A, book.id, USER_2, mine.importSource.id)).rejects.toThrow("Import not found");
    await expect(financeLedgerService.retryImportBatch(db.pool, SPACE_A, book.id, USER_2, mine.importSource.id)).rejects.toThrow("Import not found");
    expect(await financeLedgerService.listImportBatches(db.pool, SPACE_A, book.id, USER_2)).toEqual([]);
    const listed = await financeLedgerService.listImportBatches(db.pool, SPACE_A, book.id, USER_1);
    expect(listed).toEqual([{ importSource: expect.objectContaining({ id: mine.importSource.id }), summary: expect.objectContaining({ imported: 1 }) }]);
  });

  it("drops an entry that fails part way whole, keeping the rest of the import, and retries it later", async () => {
    // Stands in for any write failing after an entry's first rows are in.
    await db.pool.query(`
      CREATE OR REPLACE FUNCTION finance_test_refuse_posting() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'posting refused for test'; END $$;
      CREATE TRIGGER finance_test_refuse_posting BEFORE INSERT ON finance_postings
        FOR EACH ROW WHEN (NEW.account_name = 'Expenses:Boom') EXECUTE FUNCTION finance_test_refuse_posting();
    `);
    try {
      const book = await createBook();
      await addCommodities(book.id, ["USD"]);
      await openAccounts(book.id, ["Assets:Cash", "Expenses:Boom", "Expenses:Food"]);
      const text = `
2026-01-02 * "Breaks"
  Assets:Cash  -1.00 USD
  Expenses:Boom  1.00 USD
2026-01-03 * "Fine"
  Assets:Cash  -2.00 USD
  Expenses:Food  2.00 USD
`;
      const result = await importText(book.id, text);
      expect(result.summary).toMatchObject({ imported: 1, error: 1 });
      const broken = result.entries.find((entry) => entry.status === "error")!;
      expect(broken.errors_json).toEqual([expect.objectContaining({ code: "import_persist_error", message: "posting refused for test" })]);
      const transactions = await db.pool.query<{ narration: string; postings: number }>(
        `SELECT t.narration, (SELECT count(*)::int FROM finance_postings p WHERE p.transaction_directive_id = t.directive_id) AS postings
           FROM finance_transactions t WHERE t.book_id = $1`,
        [book.id],
      );
      expect(transactions.rows).toEqual([{ narration: "Fine", postings: 2 }]);
      expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id)).toHaveLength(1);

      await db.pool.query("DROP TRIGGER finance_test_refuse_posting ON finance_postings");
      const retried = await financeLedgerService.retryImportBatch(db.pool, SPACE_A, book.id, USER_1, result.importSource.id);
      expect(retried.createdDirectives).toBe(1);
      expect(retried.summary).toMatchObject({ imported: 2, error: 0 });
      expect(await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id)).toHaveLength(2);
    } finally {
      await db.pool.query("DROP TRIGGER IF EXISTS finance_test_refuse_posting ON finance_postings");
    }
  });

  it("keeps a garbage line out of its neighbours' identities", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Food"]);
    const lunch = `2026-01-02 * "Lunch"
  Assets:Cash  -8.00 USD
  Expenses:Food  8.00 USD
`;
    const broken = await importText(book.id, `${lunch}this is not beancount\n`);
    expect(broken.summary.imported).toBe(1);
    expect(broken.errors).toEqual([expect.objectContaining({ code: "parse_error", source: expect.objectContaining({ lineno: 4 }) })]);
    const fixed = await importText(book.id, lunch);
    // The lunch is the same record once the garbage line is gone.
    expect(fixed.summary).toMatchObject({ needs_review: 1, imported: 0 });
  });
});

describe("finance ledger Beancount export", () => {
  it("exports every stored core directive after posting and records finance_exports", async () => {
    const book = await createFixtureBook();
    await financeLedgerService.createLedgerOption(db.pool, SPACE_A, book.id, { name: "title", value: { value: "Household Book" } });
    const imported = await importText(book.id, FULL_FIXTURE);
    expect(imported.summary).toMatchObject({ imported: 14, pending_mapping: 0, error: 0 });
    await financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, imported.importSource.id);

    const result = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    expect(result.content).toContain('option "title" "Household Book"');
    expect(result.content).toContain('option "operating_currency" "USD"');
    expect(result.content).toContain('include "prices.beancount"');
    expect(result.content).toContain('plugin "beancount.plugins.leafonly"');
    expect(result.content).toContain("pushtag #import2026");
    expect(result.content).toContain("poptag #import2026");
    expect(result.content).toMatch(/\d{4}-\d{2}-\d{2} commodity USD/);
    expect(result.content).toContain("2026-01-01 open Assets:Bank:Checking");
    expect(result.content).toContain("2026-01-02 pad Assets:Bank:Checking Equity:Opening-Balances");
    expect(result.content).toContain("2026-01-03 balance Assets:Bank:Checking 100.00 USD");
    expect(result.content).toContain('2026-01-04 * "Tesco" "Groceries"');
    expect(result.content).toContain('category: "food"');
    expect(result.content).toContain("{30.00 USD}");
    expect(result.content).toContain("2026-01-06 price GOOG 31.00 USD");
    expect(result.content).toContain('2026-01-06 note Assets:Bank:Checking "Reconciled with statement"');
    expect(result.content).toContain('2026-01-06 event "location" "Berlin"');
    expect(result.content).toContain('2026-01-06 query "food-spend"');
    expect(result.content).toContain('2026-01-06 document Assets:Bank:Checking "statement-jan.pdf"');
    expect(result.content).toContain('2026-01-06 custom "budget" "food" 100.00 USD');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const exportRows = await db.pool.query(
      `SELECT status, content_hash, validation_summary_json FROM finance_exports WHERE book_id = $1`,
      [book.id],
    );
    expect(exportRows.rows).toHaveLength(1);
    expect(exportRows.rows[0].status).toBe("created");
    expect(exportRows.rows[0].content_hash).toBe(result.contentHash);
  });

  it("excludes non-posted directives from export", async () => {
    const book = await createFixtureBook();
    await importText(book.id, FULL_FIXTURE);

    const result = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    // Structural rows (accounts/commodities/options) export; proposed
    // transactions and other directives do not.
    expect(result.content).toContain("2026-01-01 open Assets:Bank:Checking");
    expect(result.content).not.toContain('"Tesco"');
    expect(result.content).not.toContain("2026-01-06 price GOOG");
  });

  it("roundtrips export output through the parser without errors", async () => {
    const book = await createFixtureBook();
    const imported = await importText(book.id, FULL_FIXTURE);
    await financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, imported.importSource.id);
    const exported = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    const reparsed = financeLedgerEngine.loadFromText(exported.content, "roundtrip.beancount");
    expect(reparsed.errors).toEqual([]);

    const typeCounts = new Map<string, number>();
    for (const entry of reparsed.entries) {
      typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
    }
    // 2 imported transactions plus the pad-synthesized one; USD and GOOG are
    // the book's own commodities, so two commodity directives export.
    expect(typeCounts.get("open")).toBe(4);
    expect(typeCounts.get("commodity")).toBe(2);
    expect(typeCounts.get("pad")).toBe(1);
    expect(typeCounts.get("balance")).toBe(1);
    expect(typeCounts.get("transaction")).toBe(3);
    expect(typeCounts.get("price")).toBe(1);
    expect(typeCounts.get("note")).toBe(1);
    expect(typeCounts.get("event")).toBe(1);
    expect(typeCounts.get("query")).toBe(1);
    expect(typeCounts.get("document")).toBe(1);
    expect(typeCounts.get("custom")).toBe(1);
    expect(typeCounts.get("include")).toBe(1);
    expect(typeCounts.get("plugin")).toBe(1);
    expect(typeCounts.get("pushtag")).toBe(1);
    expect(typeCounts.get("poptag")).toBe(1);
  });
});

describe("finance ledger proposal appliers", () => {
  function proposalCtx(proposalType: string, spaceId: string | null, payload: Record<string, unknown>) {
    return {
      proposal: {
        id: "proposal-1",
        proposal_type: proposalType,
        space_id: spaceId,
        user_id: USER_1,
        payload,
      },
      db: db.pool,
      config: null,
    };
  }

  it("posts a valid directive through finance_ledger.post_directive", async () => {
    const book = await createBook();
    await addCommodities(book.id, ["USD"]);
    await openAccounts(book.id, ["Assets:Cash", "Expenses:Misc"]);
    const imported = await importText(book.id, `
2026-01-02 * "Coffee"
  Assets:Cash  -3.00 USD
  Expenses:Misc  3.00 USD
`);
    const transactions = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      directiveType: "transaction",
    });

    await applyPostDirective(
      proposalCtx(PROPOSAL_TYPE_POST_DIRECTIVE, SPACE_A, {
        book_id: book.id,
        directive_id: transactions[0]!["id"],
      }),
    );

    const posted = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      directiveType: "transaction",
      status: "posted",
    });
    expect(posted).toHaveLength(1);
    expect(imported.errors).toEqual([]);
  });

  it("rejects posting an invalid directive and leaves status unchanged", async () => {
    const book = await createBook();
    // Bypass import validation by inserting an unbalanced draft directly.
    const commodity = await financeLedgerService.createCommodity(db.pool, SPACE_A, book.id, {
      symbol: "USD",
      commodityType: "currency",
    });
    const cash = await financeLedgerService.openAccount(db.pool, SPACE_A, book.id, {
      name: "Assets:Cash",
      openedAt: "2026-01-01",
    });
    const misc = await financeLedgerService.openAccount(db.pool, SPACE_A, book.id, {
      name: "Expenses:Misc",
      openedAt: "2026-01-01",
    });
    const draft = await financeLedgerService.createTransactionDraft(db.pool, SPACE_A, book.id, USER_1, {
      date: "2026-01-02",
      narration: "Unbalanced",
      postings: [
        { accountId: cash.id, amount: { number: "-1.00", commoditySymbol: commodity.symbol } },
        { accountId: misc.id, amount: { number: "2.00", commoditySymbol: commodity.symbol } },
      ],
    });

    await expect(
      applyPostDirective(
        proposalCtx(PROPOSAL_TYPE_POST_DIRECTIVE, SPACE_A, {
          book_id: book.id,
          directive_id: draft.id,
        }),
      ),
    ).rejects.toThrow("does not balance");

    const stillDraft = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      status: "draft",
    });
    expect(stillDraft.map((d) => d["id"])).toContain(draft.id);
  });

  it("fails closed on cross-space payloads", async () => {
    const book = await createBook();
    const imported = await importText(book.id, '2026-01-06 event "location" "Berlin"\n');
    expect(imported.summary.imported).toBe(1);

    await expect(
      applyPostImportBatch(
        proposalCtx(PROPOSAL_TYPE_POST_IMPORT_BATCH, SPACE_B, {
          book_id: book.id,
          import_source_id: imported.importSource.id,
        }),
      ),
    ).resolves.toBeUndefined();

    // The batch resolves but posts nothing because the book is scoped to space A.
    const posted = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      status: "posted",
    });
    expect(posted).toHaveLength(0);
  });

  it("posts a full import batch through finance_ledger.post_import_batch", async () => {
    const book = await createFixtureBook();
    const imported = await importText(book.id, FULL_FIXTURE);

    await applyPostImportBatch(
      proposalCtx(PROPOSAL_TYPE_POST_IMPORT_BATCH, SPACE_A, {
        book_id: book.id,
        import_source_id: imported.importSource.id,
      }),
    );

    const pending = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      status: "proposed",
    });
    expect(pending).toHaveLength(0);
    const posted = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      status: "posted",
    });
    expect(posted).toHaveLength(FIXTURE_IMPORTABLE_DIRECTIVES);
  });
});
