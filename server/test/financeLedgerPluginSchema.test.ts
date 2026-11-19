import { describe, expect, it } from "vitest";
import type { RainverPlugin } from "@rainver/protocol";
import { BUILT_IN_PLUGINS } from "../src/modules/plugins/builtInPlugins.js";
import { getOfficialPlugin } from "../src/modules/plugins/registry.js";

const financeLedgerPlugin = BUILT_IN_PLUGINS.find((plugin) => plugin.id === "finance_ledger") as RainverPlugin;

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

const SCHEMA = '"plugin_finance_ledger"';
const columnsOf = (sql: string, prefix: string, table: string) => {
  const start = sql.indexOf(`CREATE TABLE ${prefix}.${table} (`);
  const block = sql.slice(start, sql.indexOf("\n)", start));
  return block.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((name) => name && name !== "CONSTRAINT" && !name.startsWith("--"));
};

describe("finance ledger operation package (Plan 7)", () => {
  it("is a Space-level operation package, no longer a legacy descriptor", () => {
    expect(getOfficialPlugin("finance_ledger")).toBeUndefined();
    expect(financeLedgerPlugin.operationManifest).toMatchObject({ id: "finance_ledger", scope: "space", version: "1.0.0", migrations: ["0000_finance_records"] });
  });
});

describe("finance ledger plugin schema", () => {
  it("creates every directive stream table, space scoped, in the package schema", () => {
    const [migration] = financeLedgerPlugin.migrations!;
    expect(migration!.id).toBe("0000_finance_records");
    expect(migration!.sql).not.toContain("public.");
    for (const table of [...REQUIRED_TABLES, "finance_import_entries"]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${SCHEMA}.${table}`);
      expect(columnsOf(migration!.sql, SCHEMA, table)).toContain("space_id");
    }
    expect(migration!.sql).toContain("UNIQUE (import_source_id, entry_key)");
    expect(migration!.sql).toContain("finance_import_sources_book_content_hash_unique");
  });
});
