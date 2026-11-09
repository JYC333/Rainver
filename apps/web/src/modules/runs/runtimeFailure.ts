import { RuntimeFailureEvidenceSchema, RuntimeFailureTargetSchema } from '@rainver/protocol'
import type { Run } from '../../types/api'

const CODE_CAUSES = {
  runtime_auth_required: 'auth', subscription_quota_exhausted: 'quota',
  provider_rate_limit: 'rate_limit', adapter_runtime_error: 'transient',
  sandbox_runner_unavailable: 'host_unavailable', runtime_timeout: 'timeout',
  runtime_stall_timeout: 'timeout', run_timed_out: 'timeout',
  runtime_session_invalid: 'session_invalid', runtime_input_too_large: 'configuration',
  runtime_nonzero_exit: 'unknown', runtime_adapter_not_found: 'configuration',
  runtime_adapter_not_implemented: 'configuration',
} as const

/** Read only server-classified evidence, never infer auth/quota from prose. */
export function runtimeFailure(run: Run) {
  if (run.execution_kind !== 'agent' || !['failed', 'orphaned'].includes(run.status) || !run.error_json) return null
  const evidence = RuntimeFailureEvidenceSchema.safeParse(run.error_json.runtime_failure)
  const target = RuntimeFailureTargetSchema.safeParse(run.error_json.runtime_target)
  const code = typeof run.error_json.error_code === 'string' ? run.error_json.error_code : ''
  const mapped = Object.prototype.hasOwnProperty.call(CODE_CAUSES, code) ? CODE_CAUSES[code as keyof typeof CODE_CAUSES] : null
  // A generic process exit adds no diagnosis. Keep typed evidence when the
  // server has it, while specific outcomes (timeout/session loss) still win.
  const cause = mapped && mapped !== 'unknown' ? mapped : evidence.success ? evidence.data.category : mapped
  if (!cause) return null
  return { cause: cause === 'auth' && target.success && target.data.backend_mode === 'model_provider' ? 'auth_provider' : cause,
    evidence: evidence.success ? evidence.data : null, target: target.success ? target.data : null }
}
