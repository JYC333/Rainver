import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { resetTables } from "./support/resetTables.js";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime.js";
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

describe("finance ledger Beancount import", () => {
  it("persists the full directive stream as proposed by default", async () => {
    const book = await createBook();
    const result = await financeLedgerService.importBeancount(
      db.pool,
      SPACE_A,
      book.id,
      USER_1,
      { text: FULL_FIXTURE, filename: "household.beancount" },
    );

    expect(result.deduplicated).toBe(false);
    expect(result.importSourceId).toBeTruthy();
    expect(result.errors).toEqual([]);
    // 4 open + 1 commodity + pad + balance + 2 transactions + price + note +
    // event + query + document + custom = 15 dated directives
    expect(result.createdDirectives).toBe(15);

    const directives = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id);
    expect(directives).toHaveLength(15);
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
    expect(configRows.rows[0]).toEqual({
      includes: "1",
      plugins: "1",
      tag_events: "2",
      options: "1",
      sources: "1",
    });
  });

  it("deduplicates identical imports by content hash", async () => {
    const book = await createBook();
    const first = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: FULL_FIXTURE,
    });
    const second = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: FULL_FIXTURE,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.importSourceId).toBe(first.importSourceId);
    expect(second.createdDirectives).toBe(0);
    const directives = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id);
    expect(directives).toHaveLength(15);
  });

  it("refuses to post-directly an import with validation errors", async () => {
    const book = await createBook();
    await expect(
      financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
        text: `
2026-01-01 open Assets:Cash USD
2026-01-01 open Expenses:Misc USD
2026-01-02 * "Unbalanced"
  Assets:Cash  -1.00 USD
  Expenses:Misc  2.00 USD
`,
        status: "posted",
      }),
    ).rejects.toThrow("transaction_unbalanced");
  });

  it("records structured errors for unknown account references and skips them", async () => {
    const book = await createBook();
    const result = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: `
2026-01-01 open Assets:Cash USD
2026-01-02 note Assets:Nonexistent "orphan"
`,
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown_account" })]),
    );
    const directives = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id);
    expect(directives.map((d) => d["directive_type"])).toEqual(["open"]);
  });
});

describe("finance ledger Beancount export", () => {
  it("exports every stored core directive after posting and records finance_exports", async () => {
    const book = await createBook();
    const imported = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: FULL_FIXTURE,
    });
    await financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, imported.importSourceId!);

    const result = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    expect(result.content).toContain('option "title" "Household Book"');
    expect(result.content).toContain('option "operating_currency" "USD"');
    expect(result.content).toContain('include "prices.beancount"');
    expect(result.content).toContain('plugin "beancount.plugins.leafonly"');
    expect(result.content).toContain("pushtag #import2026");
    expect(result.content).toContain("poptag #import2026");
    expect(result.content).toContain("2026-01-01 commodity USD");
    expect(result.content).toContain("2026-01-01 open Assets:Bank:Checking USD");
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
    const book = await createBook();
    await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: FULL_FIXTURE,
    });

    const result = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    // Structural rows (accounts/commodities/options) export; proposed
    // transactions and other directives do not.
    expect(result.content).toContain("2026-01-01 open Assets:Bank:Checking USD");
    expect(result.content).not.toContain('"Tesco"');
    expect(result.content).not.toContain("2026-01-06 price GOOG");
  });

  it("roundtrips export output through the parser without errors", async () => {
    const book = await createBook();
    const imported = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: FULL_FIXTURE,
    });
    await financeLedgerService.postImportBatch(db.pool, SPACE_A, book.id, imported.importSourceId!);
    const exported = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    const reparsed = financeLedgerEngine.loadFromText(exported.content, "roundtrip.beancount");
    expect(reparsed.errors).toEqual([]);

    const typeCounts = new Map<string, number>();
    for (const entry of reparsed.entries) {
      typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
    }
    // 2 imported transactions plus the pad-synthesized one; GOOG commodity is
    // auto-created during import, so two commodity directives export.
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
    const imported = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: `
2026-01-01 open Assets:Cash USD
2026-01-01 open Expenses:Misc USD
2026-01-02 * "Coffee"
  Assets:Cash  -3.00 USD
  Expenses:Misc  3.00 USD
`,
    });
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
    const imported = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: "2026-01-01 open Assets:Cash USD\n",
    });

    await expect(
      applyPostImportBatch(
        proposalCtx(PROPOSAL_TYPE_POST_IMPORT_BATCH, SPACE_B, {
          book_id: book.id,
          import_source_id: imported.importSourceId,
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
    const book = await createBook();
    const imported = await financeLedgerService.importBeancount(db.pool, SPACE_A, book.id, USER_1, {
      text: FULL_FIXTURE,
    });

    await applyPostImportBatch(
      proposalCtx(PROPOSAL_TYPE_POST_IMPORT_BATCH, SPACE_A, {
        book_id: book.id,
        import_source_id: imported.importSourceId,
      }),
    );

    const pending = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      status: "proposed",
    });
    expect(pending).toHaveLength(0);
    const posted = await financeLedgerService.listDirectives(db.pool, SPACE_A, book.id, {
      status: "posted",
    });
    expect(posted).toHaveLength(15);
  });
});
