import type {
  AgentSpacePlugin,
  PluginHostContext,
} from "@agent-space/protocol";
import type { FastifyInstance } from "fastify";
import { registerFinanceLedgerProposalAppliers } from "./proposalAppliers.js";
import { registerFinanceLedgerRoutes } from "./routes.js";
import { financeLedgerMigrations } from "./schema.js";
import {
  FINANCE_LEDGER_PLUGIN_ID,
  FINANCE_LEDGER_PLUGIN_VERSION,
} from "./manifest.js";

export const financeLedgerPlugin: AgentSpacePlugin = {
  id: FINANCE_LEDGER_PLUGIN_ID,
  version: FINANCE_LEDGER_PLUGIN_VERSION,
  migrations: financeLedgerMigrations,

  activate(ctx: PluginHostContext) {
    registerFinanceLedgerRoutes(ctx.fastify as FastifyInstance, ctx.db, ctx);
    registerFinanceLedgerProposalAppliers(ctx);
    return { activated: true };
  },
};
