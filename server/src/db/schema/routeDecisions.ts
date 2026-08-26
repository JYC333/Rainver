import { pgTable, index, unique, foreignKey, varchar, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";

export const routeDecisions = pgTable("route_decisions", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  runId: varchar("run_id", { length: 36 }).notNull(),
  attemptNumber: integer("attempt_number").default(1).notNull(),
  status: varchar({ length: 32 }).notNull(),
  selectedRuntimeProfileId: varchar("selected_runtime_profile_id", { length: 36 }),
  selectedAdapterType: varchar("selected_adapter_type", { length: 64 }),
  selectedModelProviderId: varchar("selected_model_provider_id", { length: 36 }),
  reason: varchar({ length: 1024 }).notNull(),
  hintsJson: jsonb("hints_json").notNull(),
  candidatesJson: jsonb("candidates_json").notNull(),
  rejectedJson: jsonb("rejected_json").notNull(),
  fallbackChainJson: jsonb("fallback_chain_json").notNull(),
  scoreTraceJson: jsonb("score_trace_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_route_decisions_space_created").using("btree", table.spaceId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
  index("ix_route_decisions_selected_profile").using("btree", table.selectedRuntimeProfileId.asc().nullsLast()),
  unique("uq_route_decisions_run_attempt").on(table.spaceId, table.runId, table.attemptNumber),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "route_decisions_space_id_fkey" }),
  foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "route_decisions_run_id_fkey" }),
]);
