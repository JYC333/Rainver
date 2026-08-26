import { describe, expect, it } from "vitest";
import {
  FINANCE_LEDGER_PLUGIN_ID,
  financeLedgerDescriptor,
} from "../src/modules/plugins/official/financeLedger.js";
import { getOfficialPlugin } from "../src/modules/plugins/registry.js";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime.js";

const {
  plugin: { financeLedgerPlugin },
} = loadFinanceLedgerRuntime();

const REQUIRED_TABLES = [
  "finance_books",
  "finance_ledger_options",
  "finance_directives",
  "finance_accounts",
  "finance_account_groups",
  "finance_commodities",
  "finance_transactions",
  "finance_postings",
  "finance_posting_metadata",
  "finance_directive_metadata",
  "finance_prices",
  "finance_balance_assertions",
  "finance_pad_directives",
  "finance_notes",
  "finance_events",
  "finance_queries",
  "finance_documents",
  "finance_custom_directives",
  "finance_custom_directive_values",
  "finance_includes",
  "finance_plugin_directives",
  "finance_tag_stack_events",
  "finance_meta_stack_events",
  "finance_import_sources",
  "finance_exports",
];

describe("finance ledger official plugin descriptor", () => {
  it("is registered as a space-scoped official optional module", () => {
    expect(getOfficialPlugin(FINANCE_LEDGER_PLUGIN_ID)).toEqual(financeLedgerDescriptor);
    expect(financeLedgerDescriptor.scope).toBe("space");
    expect(financeLedgerDescriptor.default_enabled).toBe(false);
    expect(financeLedgerDescriptor.permissions.uses_ai).toBe(false);
  });
});

describe("finance ledger plugin schema", () => {
  it("bundles an installer-managed migration for all directive stream tables", () => {
    const migration = financeLedgerPlugin.migrations?.find(
      (candidate: { id: string }) => candidate.id === "0001_create_finance_ledger_tables",
    );

    expect(migration).toBeDefined();
    for (const table of REQUIRED_TABLES) {
      expect(migration!.sql).toContain(`CREATE TABLE public.${table}`);
    }
  });

  it("keeps finance tables space scoped", () => {
    const migration = financeLedgerPlugin.migrations![0]!;
    for (const table of REQUIRED_TABLES) {
      const createIndex = migration.sql.indexOf(`CREATE TABLE public.${table}`);
      const nextCreate = migration.sql.indexOf("CREATE TABLE public.", createIndex + 1);
      const block = migration.sql.slice(createIndex, nextCreate === -1 ? undefined : nextCreate);
      expect(block).toContain("space_id");
    }
  });
});
