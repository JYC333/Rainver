import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime";

const {
  plugin: { financeLedgerPlugin },
  service: { financeLedgerService, rootTypeForAccountName },
} = loadFinanceLedgerRuntime();

let container: TestPostgresDatabase | null = null;
let pool: Pool | null = null;

const SPACE_A = "space-finance-a";
const SPACE_B = "space-finance-b";
const USER_1 = "user-finance-1";

beforeAll(async () => {
  container = await getTestPostgres(__filename, { empty: true });
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const migration of financeLedgerPlugin.migrations!) {
    await pool.query(migration.sql);
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await resetTables(pool!, ["finance_books"], { cascade: true });
});

async function createBasicLedger() {
  const book = await financeLedgerService.createFinanceBook(pool!, SPACE_A, USER_1, {
    name: "Household",
    baseCurrency: "USD",
  });
  const usd = await financeLedgerService.createCommodity(pool!, SPACE_A, book.id, {
    symbol: "USD",
    commodityType: "currency",
  });
  const checking = await financeLedgerService.openAccount(pool!, SPACE_A, book.id, {
    name: "Assets:Bank:Checking",
    openedAt: "2026-01-01",
    commodityConstraints: ["USD"],
  });
  const groceries = await financeLedgerService.openAccount(pool!, SPACE_A, book.id, {
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

    const otherSpaceBooks = await financeLedgerService.listFinanceBooks(pool!, SPACE_B);
    expect(otherSpaceBooks).toEqual([]);
  });

  it("posts balanced transactions and computes balances", async () => {
    const { book, checking, groceries } = await createBasicLedger();
    const directive = await financeLedgerService.createTransactionDraft(
      pool!,
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

    await financeLedgerService.postDirective(pool!, SPACE_A, book.id, directive.id);
    const balances = await financeLedgerService.computeBalances(pool!, SPACE_A, book.id);
    const exported = await financeLedgerService.exportBeancount(pool!, SPACE_A, book.id, USER_1);

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
      pool!,
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
      financeLedgerService.postDirective(pool!, SPACE_A, book.id, directive.id),
    ).rejects.toThrow("Transaction does not balance for USD");
  });

  it("rejects postings to closed accounts", async () => {
    const { book, checking, groceries } = await createBasicLedger();
    await financeLedgerService.closeAccount(pool!, SPACE_A, book.id, checking.id, "2026-07-01");

    await expect(
      financeLedgerService.createTransactionDraft(pool!, SPACE_A, book.id, USER_1, {
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
        financeLedgerService.createTransactionDraft(pool!, SPACE_A, book.id, USER_1, {
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
