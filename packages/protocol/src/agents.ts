import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { SecretFreeJsonRecordSchema } from "./jsonSafety.js";
import { AgentRuntimeBackendModeSchema, RuntimeKeySchema } from "./runtimeAuthority.js";

export const AgentRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type AgentRiskLevel = z.infer<typeof AgentRiskLevelSchema>;

export const AgentExecutionConstraintsSchema = z.object({
  risk_level: AgentRiskLevelSchema.default("medium"),
  max_run_time_seconds: z.number().int().min(1).max(3600).default(300),
}).strict();
export type AgentExecutionConstraints = z.infer<typeof AgentExecutionConstraintsSchema>;
export const AgentExecutionConstraintsPatchSchema = z.object({
  risk_level: AgentRiskLevelSchema.optional(),
  max_run_time_seconds: z.number().int().min(1).max(3600).optional(),
}).strict();
export type AgentExecutionConstraintsPatch = z.infer<typeof AgentExecutionConstraintsPatchSchema>;

const RUNTIME_OPTION_AUTHORITY_KEYS = new Set([
  "runtime_key", "default_runtime_key", "allowed_runtime_keys",
  "risk_level", "riskLevel",
  "max_run_time_seconds", "maxRunTimeSeconds", "execution_constraints", "executionConstraints",
]);

/**
 * Runtime option bags cannot shadow runtime identity or immutable Agent
 * execution constraints.
 *
 * This is the **only** implementation of that rule. The server admits every
 * Profile option bag through this schema (route bodies and internal
 * provisioning alike) rather than re-walking the same key set beside it: a
 * bag key that shadows `runtime_key` or `risk_level` is a real authority leak,
 * and a second walk is how the two answers drift.
 *
 * Only names this epoch owns are listed. `adapter_type` and its
 * `default_`/`allowed_` forms named runtime identity before the ACP runtime
 * authority reset; nothing defines, writes or reads them now, so listing them
 * here would be a second name for a concept that has one (B58) and would
 * refuse an unrelated runtime's own option that happened to use the word.
 *
 * Read paths keep this permissive schema; the ownership rule below is an
 * admission (write) rule only.
 */
export const RuntimeProfileOptionsJsonSchema = SecretFreeJsonRecordSchema.superRefine((value, ctx) => {
  function visit(node: unknown, path: Array<string | number>): void {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, [...path, index]));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = [...path, key];
      if (RUNTIME_OPTION_AUTHORITY_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: childPath,
          message: "Runtime identity and Agent execution constraints must use their owning fields",
        });
      } else {
        visit(child, childPath);
      }
    }
  }
  visit(value, []);
});

/**
 * Which of the two Profile option bags authors a key.
 *
 * A Profile carries two untyped bags, and a key present in both used to be
 * resolved by a silent precedence in whichever reader happened to look
 * (`runtime_config_json.tools ?? runtime_policy_json.tools`). The plan's rule
 * is that a key has one authoring authority, so admission refuses to store it
 * in the bag that does not own it and the precedence never arises.
 *
 * Only keys with a live reader are listed. `runtime_config_json` owns the
 * candidate-shape keys the routing filter reads; `runtime_policy_json` owns
 * the per-deployment permission gate the CLI renderer reads
 * (`spec.permissions.permission_bypass_policy_key`). Everything else is
 * runtime-specific and belongs to whichever bag the author chose.
 *
 * Top level only: a nested `{ opencode: { tools: [...] } }` is a runtime's own
 * option, not a Rainver-owned key, and no reader treats it as one.
 */
export const RUNTIME_CONFIG_OWNED_KEYS = [
  "tools", "tool_ids", "supports_live", "supports_dry_run",
] as const;
export const RUNTIME_POLICY_OWNED_KEYS = [
  "allow_permission_bypass",
] as const;

function ownedElsewhere(
  bag: "runtime_config_json" | "runtime_policy_json",
  foreignKeys: readonly string[],
  owner: "runtime_config_json" | "runtime_policy_json",
) {
  return RuntimeProfileOptionsJsonSchema.superRefine((value, ctx) => {
    for (const key of foreignKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${bag}.${key} is authored on ${owner}`,
      });
    }
  });
}

/** Admission schema for the deployment/candidate-shape option bag. */
export const RuntimeProfileConfigJsonSchema = ownedElsewhere(
  "runtime_config_json", RUNTIME_POLICY_OWNED_KEYS, "runtime_policy_json",
);

/** Admission schema for the per-deployment runtime policy bag. */
export const RuntimeProfilePolicyJsonSchema = ownedElsewhere(
  "runtime_policy_json", RUNTIME_CONFIG_OWNED_KEYS, "runtime_config_json",
);

/**
 * Whether the Space provisioning template can still provision an Agent.
 *
 * `needs_repair` means the template names a ModelProvider that is no longer
 * selectable in this Space (deleted, disabled, or its Space grant withdrawn).
 * Disabling a Provider is a visible repair, not a silent downgrade to native
 * mode, so the template keeps its selection and says so here while Agent
 * creation fails with the matching repair error.
 */
export const SpaceAgentRuntimeDefaultStateSchema = z.enum(["ready", "needs_repair"]);
export type SpaceAgentRuntimeDefaultState = z.infer<typeof SpaceAgentRuntimeDefaultStateSchema>;

export const SpaceAgentRuntimeDefaultOutSchema = z.object({
  space_id: IdSchema,
  runtime_key: RuntimeKeySchema,
  backend_mode: AgentRuntimeBackendModeSchema,
  model_provider_id: IdSchema.nullable(),
  model_name: z.string().trim().min(1).nullable(),
  runtime_config_json: RuntimeProfileOptionsJsonSchema,
  state: SpaceAgentRuntimeDefaultStateSchema,
  /** Human-readable cause when `state` is `needs_repair`; null otherwise. */
  state_reason: z.string().min(1).nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
}).strict();
export type SpaceAgentRuntimeDefaultOut = z.infer<typeof SpaceAgentRuntimeDefaultOutSchema>;

export const SpaceAgentRuntimeDefaultWriteSchema = z.object({
  runtime_key: RuntimeKeySchema,
  backend_mode: AgentRuntimeBackendModeSchema,
  model_provider_id: IdSchema.nullish(),
  model_name: z.string().trim().min(1).nullish(),
  runtime_config_json: RuntimeProfileConfigJsonSchema.nullish(),
}).strict().superRefine((value, ctx) => {
  if (value.backend_mode === "runtime_native" && (value.model_provider_id || value.model_name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backend_mode"], message: "runtime_native cannot bind a provider or model" });
  }
  if (value.backend_mode === "model_provider" && (!value.model_provider_id || !value.model_name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backend_mode"], message: "model_provider requires both a provider and model" });
  }
});
export type SpaceAgentRuntimeDefaultWrite = z.infer<typeof SpaceAgentRuntimeDefaultWriteSchema>;

/** The provider/model summary returned with an Agent runtime profile. */
export const AgentRuntimeProfileModelSchema = z.object({
  provider_id: IdSchema.nullable(),
  provider_name: z.string().nullable(),
  provider_type: z.string().nullable(),
  model: z.string().nullable(),
}).strict();
export type AgentRuntimeProfileModel = z.infer<typeof AgentRuntimeProfileModelSchema>;

/** Wire response for an Agent runtime profile, including optional host binding. */
export const AgentRuntimeProfileOutSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  agent_id: IdSchema,
  name: z.string().trim().min(1),
  runtime_key: RuntimeKeySchema,
  backend_mode: AgentRuntimeBackendModeSchema,
  execution_host_id: IdSchema.nullable(),
  workspace_location_id: IdSchema.nullable(),
  workspace_mode: z.enum(["location", "managed"]).nullable(),
  runtime_installation: z.string().trim().min(1).max(64).nullable(),
  model: AgentRuntimeProfileModelSchema.nullable(),
  /** Provider selection is a per-Profile authority, distinct from Host-native login state. */
  provider_binding: z.object({
    state: z.enum(["unbound", "bound"]),
    provider_id: IdSchema.nullable(),
    model: z.string().nullable(),
  }).strict(),
  runtime_config_json: RuntimeProfileOptionsJsonSchema,
  runtime_policy_json: RuntimeProfileOptionsJsonSchema,
  enabled: z.boolean(),
  is_default: z.boolean(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type AgentRuntimeProfileOut = z.infer<typeof AgentRuntimeProfileOutSchema>;

/** POST body for creating an Agent runtime profile. */
export const AgentRuntimeProfileCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  runtime_key: RuntimeKeySchema,
  backend_mode: AgentRuntimeBackendModeSchema.optional(),
  execution_host_id: IdSchema.nullish(),
  workspace_location_id: IdSchema.nullish(),
  workspace_mode: z.enum(["location", "managed"]).nullish(),
  runtime_installation: z.string().trim().min(1).max(64).nullish(),
  model_provider_id: IdSchema.nullish(),
  model_name: z.string().trim().min(1).nullish(),
  runtime_config_json: RuntimeProfileConfigJsonSchema.nullish(),
  runtime_policy_json: RuntimeProfilePolicyJsonSchema.nullish(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
}).strict();

export type AgentRuntimeProfileCreateBody = z.infer<typeof AgentRuntimeProfileCreateBodySchema>;

/** PATCH body for updating an Agent runtime profile: the same fields, all optional. */
export const AgentRuntimeProfileUpdateBodySchema = AgentRuntimeProfileCreateBodySchema.partial();
export type AgentRuntimeProfileUpdateBody = z.infer<typeof AgentRuntimeProfileUpdateBodySchema>;
