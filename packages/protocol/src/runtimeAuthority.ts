import { z } from "zod";

/**
 * Stable code-registry key for an ACP runtime definition. The 64-character
 * ceiling is the one width: every `runtime_key` column in
 * `server/src/db/schema/` is `varchar(64)`, so a key admitted here always
 * fits the Profile that selects it and every downstream row that records it.
 */
export const RuntimeKeySchema = z.string().trim().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  "runtime_key must contain only lowercase letters, digits, '.', '_' or '-'",
);
export type RuntimeKey = z.infer<typeof RuntimeKeySchema>;

export const AgentRuntimeBackendModeSchema = z.enum(["runtime_native", "model_provider"]);
export type AgentRuntimeBackendMode = z.infer<typeof AgentRuntimeBackendModeSchema>;

/**
 * The two durable Run shapes; `run_role` remains an independent dimension, so
 * a coordinator is still an Agent Run and not a third execution authority.
 * Which columns each shape may carry is stated once, by the database:
 * `ck_runs_execution_shape` in `server/src/db/schema/runs.ts`.
 */
export const RunExecutionKindSchema = z.enum(["agent", "provider_task"]);
export type RunExecutionKind = z.infer<typeof RunExecutionKindSchema>;

/**
 * A code registry entry, never a database row: the narrow ACP-facing view of
 * `RuntimeAdapterSpec` that Profile admission, routing and dispatch read.
 * It is produced by `server/src/modules/runtimeAdapters/runtimeDefinitions.ts`
 * from the registered spec, so there is no wire input to validate.
 */
export interface AgentRuntimeDefinition {
  runtime_key: RuntimeKey;
  display_name: string;
  protocol: "acp";
  supports_runtime_native: boolean;
  supports_model_provider: boolean;
}
