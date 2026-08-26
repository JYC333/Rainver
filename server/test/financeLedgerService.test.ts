import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { resetTables } from "./support/resetTables.js";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime.js";
import { useTestDatabase } from "./support/testDatabase.js";

const {
  plugin: { financeLedgerPlugin },
  service: { financeLedgerService, rootTypeForAccountName },
} = loadFinanceLedgerRuntime();


const SPACE_A = "space-finance-a";
const SPACE_B = "space-finance-b";
const USER_1 = "user-finance-1";

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

async function createBasicLedger() {
  const book = await financeLedgerService.createFinanceBook(db.pool, SPACE_A, USER_1, {
    name: "Household",
    baseCurrency: "USD",
  });
  const usd = await financeLedgerService.createCommodity(db.pool, SPACE_A, book.id, {
    symbol: "USD",
    commodityType: "currency",
  });
  const checking = await financeLedgerService.openAccount(db.pool, SPACE_A, book.id, {
    name: "Assets:Bank:Checking",
    openedAt: "2026-01-01",
    commodityConstraints: ["USD"],
  });
  const groceries = await financeLedgerService.openAccount(db.pool, SPACE_A, book.id, {
    name: "Expenses:Food:Groceries",
    openedAt: "2026-01-01",
    commodityConstraints: ["USD"],
  });
  return { book, usd, checking, groceries };
}

describe("finance ledger account names", () => {
  it("derives Beancount root types from account names", () => {
    expect(rootTypeForAccountName("Assets:Bank:Checking")).toBe("assets");
    expect(rootTypeForAccountName("Income:Salary")).toBe("income");
    expect(() => rootTypeForAccountName("Cash")).toThrow("Invalid account name");
    expect(() => rootTypeForAccountName("Unknown:Cash")).toThrow("Invalid account root");
  });
});

describe("finance ledger service", () => {
  it("creates books, commodities, and accounts within a space", async () => {
    const { book, usd, checking } = await createBasicLedger();

    expect(book.space_id).toBe(SPACE_A);
    expect(usd.symbol).toBe("USD");
    expect(checking.root_type).toBe("assets");

    const otherSpaceBooks = await financeLedgerService.listFinanceBooks(db.pool, SPACE_B);
    expect(otherSpaceBooks).toEqual([]);
  });

  it("posts balanced transactions and computes balances", async () => {
    const { book, checking, groceries } = await createBasicLedger();
    const directive = await financeLedgerService.createTransactionDraft(
      db.pool,
      SPACE_A,
      book.id,
      USER_1,
      {
        date: "2026-07-02",
        payee: "Tesco",
        narration: "Groceries",
        postings: [
          { accountId: checking.id, amount: { number: "-12.50", commoditySymbol: "USD" } },
          { accountId: groceries.id, amount: { number: "12.50", commoditySymbol: "USD" } },
        ],
      },
    );

    await financeLedgerService.postDirective(db.pool, SPACE_A, book.id, directive.id);
    const balances = await financeLedgerService.computeBalances(db.pool, SPACE_A, book.id);
    const exported = await financeLedgerService.exportBeancount(db.pool, SPACE_A, book.id, USER_1);

    expect(balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountName: "Assets:Bank:Checking",
          positions: ["-12.50 USD"],
        }),
        expect.objectContaining({
          accountName: "Expenses:Food:Groceries",
          positions: ["12.50 USD"],
        }),
      ]),
    );
    expect(exported.content).toContain("2026-07-02 *");
    expect(exported.content).toContain("Assets:Bank:Checking  -12.50 USD");
    expect(exported.export.id).toBeTruthy();
  });

  it("rejects unbalanced transactions before posting", async () => {
    const { book, checking, groceries } = await createBasicLedger();
    const directive = await financeLedgerService.createTransactionDraft(
      db.pool,
      SPACE_A,
      book.id,
      USER_1,
      {
        date: "2026-07-02",
        narration: "Bad import",
        postings: [
          { accountId: checking.id, amount: { number: "-12.50", commoditySymbol: "USD" } },
          { accountId: groceries.id, amount: { number: "11.50", commoditySymbol: "USD" } },
        ],
      },
    );

    await expect(
      financeLedgerService.postDirective(db.pool, SPACE_A, book.id, directive.id),
    ).rejects.toThrow("Transaction does not balance for USD");
  });

  it("rejects postings to closed accounts", async () => {
    const { book, checking, groceries } = await createBasicLedger();
    await financeLedgerService.closeAccount(db.pool, SPACE_A, book.id, checking.id, "2026-07-01");

    await expect(
      financeLedgerService.createTransactionDraft(db.pool, SPACE_A, book.id, USER_1, {
        date: "2026-07-02",
        narration: "After close",
        postings: [
          { accountId: checking.id, amount: { number: "-12.50", commoditySymbol: "USD" } },
          { accountId: groceries.id, amount: { number: "12.50", commoditySymbol: "USD" } },
        ],
      }),
    ).rejects.toThrow("Account is closed");
  });

  it("allocates distinct sequences under concurrent same-date entry", async () => {
    const { book, checking, groceries } = await createBasicLedger();

    // All ten drafts race MAX+1 on the same book/date; the retry on the
    // unique-constraint conflict must let every one of them land.
    const directives = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        financeLedgerService.createTransactionDraft(db.pool, SPACE_A, book.id, USER_1, {
          date: "2026-07-02",
          narration: `Concurrent ${index}`,
          postings: [
            { accountId: checking.id, amount: { number: "-1.00", commoditySymbol: "USD" } },
            { accountId: groceries.id, amount: { number: "1.00", commoditySymbol: "USD" } },
          ],
        }),
      ),
    );

    const sequences = directives.map((directive) => directive.sequence);
    expect(new Set(sequences).size).toBe(10);
  });
});
