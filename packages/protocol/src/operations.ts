import { z } from 'zod';
export const OperationActorSchema = z.object({
  principal: z.object({
    kind: z.enum(['user', 'agent', 'automation', 'system']),
    id: z.string().min(1)
  }).strict(),
  on_behalf_of_user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  origin: z.enum(['manual', 'scheduled', 'delegated', 'continuation', 'system_event']),
  effective_origin: z.string(),
  root_run_id: z.string().nullable(),
  continuation_hops: z.number().int().nonnegative(),
  surface: z.enum(['web', 'public_api', 'agent_tool', 'external_mcp', 'system_job']),
  space_id: z.string().min(1)
}).strict();
export type OperationActor = z.infer<typeof OperationActorSchema>;
export const OPERATION_ERROR_CODES = ['authentication_required', 'operation_not_found', 'operation_version_unsupported', 'operation_invalid_input', 'idempotency_key_required', 'idempotency_key_reused', 'idempotency_in_progress', 'operation_approval_mapping_unavailable', 'operation_approval_state_inconsistent', 'operation_approval_rejected', 'operation_approval_expired', 'operation_approval_superseded', 'operation_result_unavailable', 'operation_invalid_output', 'operation_audit_unavailable', 'operation_temporarily_unavailable', 'operation_internal_error', 'operation_conflict'] as const;
export type OperationErrorCode = typeof OPERATION_ERROR_CODES[number];
export const OperationErrorSchema = z.object({
  error: z.object({
    code: z.enum(OPERATION_ERROR_CODES),
    domain: z.string(),
    message: z.string(),
    metadata: z.record(z.unknown()),
    retryable: z.boolean(),
    request_id: z.string()
  }).strict()
}).strict();
export type OperationErrorBody = z.infer<typeof OperationErrorSchema>;
export type OperationOutcome<T = unknown> = {
  status: 'succeeded';
  data: T;
} | {
  status: 'pending_approval';
  proposal_id: string;
} | OperationErrorBody;
export interface OperationResponse<T = unknown> {
  http_status: number;
  request_id: string;
  replayed: boolean;
  policy_decision_record_id: string | null;
  body: OperationOutcome<T>;
}
export const ActionCatalogInputSchema = z.object({}).strict();
export const ActionCatalogOutputSchema = z.object({
  actions: z.array(z.object({
    id: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    kind: z.enum(['command', 'query'])
  }).strict())
}).strict();
export const OPERATION_SCHEMA_TABLE = {
  'system.actions.list': {
    input: ActionCatalogInputSchema,
    output: ActionCatalogOutputSchema
  }
} as const;
export type OperationId = keyof typeof OPERATION_SCHEMA_TABLE;
export type OperationInput<Id extends OperationId> = z.input<(typeof OPERATION_SCHEMA_TABLE)[Id]['input']>;
export type OperationOutput<Id extends OperationId> = z.output<(typeof OPERATION_SCHEMA_TABLE)[Id]['output']>;
