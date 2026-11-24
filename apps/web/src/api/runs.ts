import type {
  ActivityInboxRecord,
  Artifact,
  AuthorizationRequest,
  Page,
  PlanDetail,
  PlanExecuteBody,
  PlanSummary,
  Proposal,
  Run,
  RunAttempt,
  RunEvaluation,
  RunFinalization,
  RunLogicalIO,
  RunStatusOut,
  RunSupervisorDecision,
  RunTurn,
  RunVerificationResult,
} from '../types/api'
import { streamTurnParts } from './conversation'
import { commandReceipt, operationAt } from './operations'
import type { RequestOptions } from './transport'
import { get, request } from './transport'
import type { OperationOutput, RunFilePreview, RunLiveInputAvailability, RunLiveInputRequest, RunLiveInputResult } from '@rainver/protocol'

const LIVE_INPUT_READBACK_ATTEMPTS = 6

const LIVE_INPUT_READBACK_DELAY_MS = 500

const LIVE_INPUT_STATES: readonly RunLiveInputResult['state'][] = ['pending', 'deferred', 'injected', 'delivered_with_results', 'not_injected', 'unconfirmed']

/** Current Room roster after a roster command; the receipt names only the Room. */
// ── Runs (canonical API) ──────────────────────────────────────────────────
export const runsApi = {
  filePreview: (id: string, path: string, options?: RequestOptions) => request<RunFilePreview>("GET", `/runs/${id}/file-preview?path=${encodeURIComponent(path)}`, undefined, options),
  list: (params: {
    status?: string
    mode?: string
    agent_id?: string
    project_folder_id?: string
    project_id?: string
    workflow_version_id?: string
    capability_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.mode !== undefined) q.mode = params.mode
    if (params.agent_id !== undefined) q.agent_id = params.agent_id
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.workflow_version_id !== undefined) q.workflow_version_id = params.workflow_version_id
    if (params.capability_id !== undefined) q.capability_id = params.capability_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Run[]>('/runs?' + new URLSearchParams(q))
  },
  get:    (id: string, options: RequestOptions = {}) => get<Run>(`/runs/${id}`, options),
  logicalIO: (id: string, options: RequestOptions = {}) => get<RunLogicalIO>(`/runs/${id}/io`, options),
  status: (id: string, options: RequestOptions = {}) => get<RunStatusOut>(`/runs/${id}/status`, options),
  // One keyed command; the process stop completes before the reply, then the Run is re-read.
  stop:   async (id: string, options: RequestOptions = {}) => {
    const receipt = await commandReceipt('run.stop', { run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { ...options, spaceId: receipt.space_id })
  },
  liveInput: (id: string, options: RequestOptions = {}) => get<RunLiveInputAvailability>(`/runs/${id}/live-input`, options),
  sendLiveInput: async (id: string, body: RunLiveInputRequest, options: RequestOptions = {}): Promise<RunLiveInputResult> => {
    const receipt = await commandReceipt('run.live_input.submit', { ...body, run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    // Delivery is the server's committed obligation after commit; its outcome is read back for this
    // message. An outcome not yet recorded stays `pending` — never reported as not delivered.
    let state: RunLiveInputResult['state'] = 'pending'
    for (let attempt = 0; attempt < LIVE_INPUT_READBACK_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, LIVE_INPUT_READBACK_DELAY_MS))
      const known = await runsApi.liveInputOutcome(receipt.run_id, receipt.message_id, { ...options, spaceId: receipt.space_id })
      if (known && known !== 'pending') { state = known; break }
      if (options.signal?.aborted) break
    }
    return { state, message_id: receipt.message_id, delivery_id: null }
  },
  /** One read of what happened to a recorded live input; null when the Run records no such input. */
  liveInputOutcome: async (runId: string, messageId: string, options: RequestOptions = {}): Promise<RunLiveInputResult['state'] | null> => {
    const read = await get<RunLiveInputAvailability & { delivery_state?: string | null }>(
      `/runs/${encodeURIComponent(runId)}/live-input?message_id=${encodeURIComponent(messageId)}`, options)
    return LIVE_INPUT_STATES.find(state => state === read.delivery_state) ?? null
  },
  // The new recovery choice is read back with the Run's turn; the command returns identities only.
  quotaRecovery: async (id: string, autoContinue: boolean, options: RequestOptions = {}, switchModel = false): Promise<void> => {
    await commandReceipt('run.quota_recovery.update', { run_id: id, auto_continue: autoContinue, ...(switchModel ? { switch_model: true } : {}) }, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  // Queues the Run's Job; execution happens in the worker, not in this request.
  executeQueuedRun: async (id: string, options: RequestOptions = {}) => {
    const receipt = await commandReceipt('run.execute', { run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { ...options, spaceId: receipt.space_id })
  },
  resume: async (id: string, options: RequestOptions = {}) => {
    const { space_id: _space, run_id: _run, ...receipt } = await commandReceipt('run.resume', { run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return receipt
  },
  abandon: async (id: string, body: { reason?: string | null } = {}, options: RequestOptions = {}) => {
    const { space_id: _space, run_id: _run, ...receipt } = await commandReceipt('run.abandon', { ...body, run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return receipt
  },
  activities: (id: string, params: Record<string, string> = {}, options: RequestOptions = {}) =>
    get<Page<ActivityInboxRecord>>(`/runs/${id}/activities?` + new URLSearchParams(params), options),
  artifacts: (id: string, params: Record<string, string> = {}, options: RequestOptions = {}) =>
    get<Page<Artifact>>(`/runs/${id}/artifacts?` + new URLSearchParams(params), options),
  proposals: (id: string, params: Record<string, string> = {}, options: RequestOptions = {}) =>
    get<Page<Proposal>>(`/runs/${id}/proposals?` + new URLSearchParams(params), options),
  authorizationRequests: (id: string, options: RequestOptions = {}) =>
    get<AuthorizationRequest[]>(`/runs/${id}/authorization-requests`, options),
  attempts: (id: string, options: RequestOptions = {}) => get<{ attempts: RunAttempt[]; supervisor_decisions: RunSupervisorDecision[] }>(`/runs/${id}/attempts`, options),
  evaluations: (id: string, options: RequestOptions = {}) => get<RunEvaluation[]>(`/runs/${id}/evaluations`, options),
  verifications: (id: string, options: RequestOptions = {}) => get<RunVerificationResult[]>(`/runs/${id}/verifications`, options),
  finalizations: (id: string, options: RequestOptions = {}) => get<RunFinalization[]>(`/runs/${id}/finalizations`, options),
  routeDecision: (id: string, options: RequestOptions = {}) => get<Record<string, unknown>>(`/runs/${id}/route-decision`, options),
  /**
   * The turn as it stands. For a surface showing a turn that has stopped —
   * one waiting on a person, say — where streaming would poll forever.
   */
  turn: (id: string, options: RequestOptions = {}) => get<RunTurn>(`/runs/${encodeURIComponent(id)}/turn`, options),
  /** The live turn, as parts. See `streamTurnParts`. */
  streamTurn: (
    id: string,
    options: { spaceId?: string; signal?: AbortSignal; onTurn: (turn: RunTurn) => void },
  ) => streamTurnParts(id, options),
}

async function decideAuthorizationRequest(id:string,decision:'approve'|'reject',options:RequestOptions):Promise<AuthorizationRequest>{
  const receipt=await operationAt<{run_id:string;request_id:string}>('POST',`/authorization-requests/${encodeURIComponent(id)}/${decision}`,{},options.idempotencyKey??crypto.randomUUID(),options)
  const rows=await get<AuthorizationRequest[]>(`/runs/${encodeURIComponent(receipt.run_id)}/authorization-requests`,options)
  const request=rows.find(row=>row.id===receipt.request_id)
  if(!request)throw new Error('Authorization request no longer available')
  return request
}

export const authorizationRequestsApi = {
  approve: (id: string, options: RequestOptions = {}) => decideAuthorizationRequest(id,'approve',options),
  reject: (id: string, options: RequestOptions = {}) => decideAuthorizationRequest(id,'reject',options),
}

// ── Plans / structured workflow execution ────────────────────────────────
export const plansApi = {
  list: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<PlanSummary[]>(`/plans?${new URLSearchParams(q)}`)
  },
  get: (id: string) => get<PlanDetail>(`/plans/${encodeURIComponent(id)}`),
  execute: (id: string, body: PlanExecuteBody, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'plan.execute'>>('POST', `/plans/${encodeURIComponent(id)}/execute`, body, key),
  reconcile: (id: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'plan.reconcile'>>('POST', `/plans/${encodeURIComponent(id)}/reconcile`, {}, key),
}
