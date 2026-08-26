import { describe, expect, it } from "vitest";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime.js";

const {
  engine: { financeLedgerEngine },
} = loadFinanceLedgerRuntime();

describe("finance ledger Beancount engine", () => {
  it("parses, interpolates, validates, and exports a Beancount transaction", () => {
    const text = `
option "operating_currency" "USD"

2026-01-01 open Assets:Bank:Checking USD
2026-01-01 open Expenses:Food:Groceries USD
2026-07-02 * "Tesco" "Groceries" #food ^import-abc
  Assets:Bank:Checking  -12.50 USD
  Expenses:Food:Groceries
`;

    const loaded = financeLedgerEngine.loadFromText(text, "fixture.beancount");
    const exported = financeLedgerEngine.exportEntries(loaded.entries, loaded.options);

    expect(loaded.errors).toEqual([]);
    expect(exported).toContain('option "operating_currency" "USD"');
    expect(exported).toContain('2026-07-02 * "Tesco" "Groceries" #food ^import-abc');
    expect(exported).toContain("  Expenses:Food:Groceries  12.50 USD");
  });

  it("returns structured errors for unbalanced transactions", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Bank:Checking USD
2026-01-01 open Expenses:Food:Groceries USD
2026-07-02 * "Bad import"
  Assets:Bank:Checking  -12.50 USD
  Expenses:Food:Groceries  11.50 USD
`);

    expect(loaded.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "transaction_unbalanced",
        }),
      ]),
    );
  });

  it("checks balance assertions against running balances", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Bank:Checking USD
2026-01-01 open Equity:Opening-Balances USD
2026-01-02 * "Opening"
  Assets:Bank:Checking  10 USD
  Equity:Opening-Balances  -10 USD
2026-01-03 balance Assets:Bank:Checking 11 USD
`);

    expect(loaded.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "balance_assertion_failed",
        }),
      ]),
    );
  });

  it("applies simple pad directives before balance checks", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Bank:Checking USD
2026-01-01 open Equity:Opening-Balances USD
2026-01-02 pad Assets:Bank:Checking Equity:Opening-Balances
2026-01-03 balance Assets:Bank:Checking 10 USD
`);
    const exported = financeLedgerEngine.exportEntries(loaded.entries, loaded.options);

    expect(loaded.errors).toEqual([]);
    expect(exported).toContain('P "Pad Assets:Bank:Checking"');
    expect(exported).toContain("  Assets:Bank:Checking  10 USD");
    expect(exported).toContain("  Equity:Opening-Balances  -10 USD");
  });

  it("balances postings held at cost and converted at price by weight", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Broker GOOG,USD
2026-01-01 open Assets:Cash USD
2026-01-01 open Assets:CashEUR EUR
2026-01-02 * "Buy GOOG"
  Assets:Broker  10 GOOG {30.00 USD}
  Assets:Cash  -300.00 USD
2026-01-03 * "FX transfer"
  Assets:CashEUR  90.00 EUR
  Assets:Cash  -100.00 USD @ 0.90 EUR
`);

    expect(loaded.errors).toEqual([]);
  });

  it("infers balancing tolerance from posting precision", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Cash USD
2026-01-01 open Expenses:Fees USD
2026-01-02 * "Rounding within tolerance"
  Assets:Cash  -10.00 USD
  Expenses:Fees  10.004 USD
2026-01-03 * "Rounding beyond tolerance"
  Assets:Cash  -10.00 USD
  Expenses:Fees  10.006 USD
`);

    const unbalanced = loaded.errors.filter((error) => error.code === "transaction_unbalanced");
    expect(unbalanced).toHaveLength(1);
    expect(unbalanced[0]!.source?.lineno).toBe(7);
  });

  it("checks balance assertions with explicit and inferred tolerances", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Cash USD
2026-01-01 open Equity:Opening USD
2026-01-02 * "Opening"
  Assets:Cash  10.004 USD
  Equity:Opening  -10.004 USD
2026-01-03 balance Assets:Cash 10.00 USD
2026-01-04 balance Assets:Cash 10.1 USD ~ 0.2
2026-01-05 balance Assets:Cash 10.10 USD
`);

    const failed = loaded.errors.filter((error) => error.code === "balance_assertion_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toContain("expected 10.10 USD");
  });

  it("rejects invalid transaction and posting flags", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Cash USD
2026-01-01 open Expenses:Fees USD
2026-01-02 Z "Bad flag"
  Assets:Cash  -1.00 USD
  Expenses:Fees  1.00 USD
`);

    expect(loaded.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_flag" })]),
    );
  });

  it("flags documents with an empty path", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 open Assets:Cash USD
2026-01-02 document Assets:Cash ""
`);

    expect(loaded.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_document_path" })]),
    );
  });

  it("roundtrips costs, prices, metadata, and pushed tags through export", () => {
    const loaded = financeLedgerEngine.loadFromText(`
pushtag #trip
2026-01-01 open Assets:Broker GOOG,USD
2026-01-01 open Assets:Cash USD
2026-01-02 * "Buy GOOG"
  category: "invest"
  Assets:Broker  10 GOOG {30.00 USD, 2026-01-02, "lot-1"}
  Assets:Cash  -300.00 USD
poptag #trip
`);
    const exported = financeLedgerEngine.exportEntries(loaded.entries, loaded.options);

    expect(loaded.errors).toEqual([]);
    expect(exported).toContain("#trip");
    expect(exported).toContain('category: "invest"');
    expect(exported).toContain('{30.00 USD, 2026-01-02, "lot-1"}');
  });

  it("sorts entries with Beancount-compatible same-day directive ordering", () => {
    const loaded = financeLedgerEngine.loadFromText(`
2026-01-01 close Assets:Bank:Checking
2026-01-01 * "Opening"
  Assets:Bank:Checking  0 USD
  Equity:Opening-Balances  0 USD
2026-01-01 balance Assets:Bank:Checking 0 USD
2026-01-01 open Assets:Bank:Checking USD
2026-01-01 open Equity:Opening-Balances USD
`);

    expect(loaded.entries.map((entry) => entry.type)).toEqual([
      "open",
      "open",
      "balance",
      "transaction",
      "close",
    ]);
  });
});
