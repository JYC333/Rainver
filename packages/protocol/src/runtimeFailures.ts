import { z } from "zod";

/** Safe diagnostic evidence, shared by Run readers and the ACP controller. */
export const RuntimeFailurePhaseSchema = z.enum(["initialize", "authenticate", "session_new", "set_config", "prompt"]);
export const RuntimeFailureEvidenceSchema = z.object({
  rpc_code: z.number().int().nullable(),
  vendor_code: z.string().max(256).nullable(),
  category: z.enum(["quota", "auth", "rate_limit", "transient", "configuration", "unknown"]),
  message: z.string().max(33_000),
  occurred_at: z.string().datetime({ offset: true }),
  resets_at: z.string().datetime({ offset: true }).nullable(),
  phase: RuntimeFailurePhaseSchema.optional(),
  phase_elapsed_ms: z.number().nonnegative().optional(),
});
export type RuntimeFailureEvidence = z.infer<typeof RuntimeFailureEvidenceSchema>;

/** Execution identity only: no native session id, local path or credential. */
export const RuntimeFailureTargetSchema = z.object({
  host_id: z.string().min(1).max(256),
  runtime_key: z.string().min(1).max(256),
  installation: z.string().min(1).max(256),
  backend_mode: z.enum(["runtime_native", "model_provider", "unknown"]).optional(),
});
export type RuntimeFailureTarget = z.infer<typeof RuntimeFailureTargetSchema>;
