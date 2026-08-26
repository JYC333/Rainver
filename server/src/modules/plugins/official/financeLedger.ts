import type { OfficialPluginDescriptor } from "@rainver/protocol";

export const FINANCE_LEDGER_PLUGIN_ID = "finance_ledger";
export const FINANCE_LEDGER_PLUGIN_VERSION = "0.1.0";

/**
 * finance_ledger — official optional module descriptor.
 *
 * Runtime behavior lives in the package under
 * `plugins/official/finance_ledger/` and is loaded from the compiled official
 * plugin artifact at server startup. Ledger rows are space-scoped business
 * data; Beancount text is only an import/export compatibility format.
 */
export const financeLedgerDescriptor: OfficialPluginDescriptor = {
  id: FINANCE_LEDGER_PLUGIN_ID,
  name: "Finance Ledger",
  description:
    "A Beancount-compatible double-entry finance ledger. Stores the ledger in PostgreSQL and supports import/export without realtime market data.",
  version: FINANCE_LEDGER_PLUGIN_VERSION,
  category: "household",
  default_enabled: false,
  default_visible: true,
  scope: "space",
  lifecycle_status: "available",
  frontend_entries: [
    {
      module_id: "finance",
      label: "Finance",
      path: "/finance",
      icon: "landmark",
      section: "knowledge",
      group: "system",
    },
  ],
  backend_feature_ids: [
    "finance_books",
    "finance_directives",
    "finance_import_export",
  ],
  permissions: {
    creates_activity: false,
    can_propose_memory: false,
    can_contribute_context: "opt_in",
    uses_ai: false,
    uses_scheduler: false,
  },
  settings_defaults: {
    proposal_required_for_imports: true,
    include_in_context: false,
    allow_document_paths: false,
  },
};
