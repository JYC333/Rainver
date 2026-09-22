import { pgTable, unique, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { modelProviders } from "./providers.js";

/** Future-Agent provisioning input only. Dispatch never reads this table. */
export const spaceAgentRuntimeDefaults = pgTable("space_agent_runtime_defaults", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  runtimeKey: varchar("runtime_key", { length: 64 }).notNull(),
  backendMode: varchar("backend_mode", { length: 32 }).notNull(),
  modelProviderId: varchar("model_provider_id", { length: 36 }),
  modelName: varchar("model_name", { length: 256 }),
  runtimeConfigJson: jsonb("runtime_config_json").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "space_agent_runtime_defaults_space_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.modelProviderId], foreignColumns: [modelProviders.id], name: "space_agent_runtime_defaults_model_provider_id_fkey" }).onDelete("restrict"),
  unique("uq_space_agent_runtime_defaults_space").on(table.spaceId),
  check("ck_space_agent_runtime_defaults_backend_mode", sql`backend_mode IN ('runtime_native', 'model_provider')`),
  check("ck_space_agent_runtime_defaults_binding", sql`(
    (backend_mode = 'runtime_native' AND model_provider_id IS NULL AND model_name IS NULL)
    OR
    (backend_mode = 'model_provider' AND model_provider_id IS NOT NULL AND model_name IS NOT NULL AND length(btrim(model_name)) > 0)
  )`),
]);
