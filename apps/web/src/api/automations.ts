import { sessionEpoch } from '../lib/sessionResidue'
import type {
  AutomationCreateBody,
  AutomationFireResult,
  AutomationOut,
  AutomationUpdateBody,
  DailyCaptureReportSettingOut,
  DailyCaptureReportSettingUpdate,
  DailyReportArtifactItem,
  WorkflowExecutionSummary,
} from '../types/api'
import { commandReceipt, operationAt } from './operations'
import { pollRead, READ_PENDING } from './pollRead'
import { ApiRequestError, _spaceId, get, type RequestOptions } from './transport'
import type { OperationInput } from '@rainver/protocol'

// ── Automations ───────────────────────────────────────────────────────────
// Space-scoped paths (/spaces/{space_id}/automations); identity via session/bearer.
export const automationsApi = {
  configureAutonomy: (data: import('@rainver/protocol').AutomationAutonomyBody, key:string = crypto.randomUUID()) =>
    operationAt<AutomationOut>('PUT', `/spaces/${_spaceId}/automations/autonomy`, data, key),
  list:   (params: { project_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.project_id !== undefined) q.project_id = params.project_id
    const suffix = new URLSearchParams(q).toString()
    return get<AutomationOut[]>(`/spaces/${_spaceId}/automations${suffix ? `?${suffix}` : ''}`)
  },
  get:    (id: string)                        => get<AutomationOut>(`/spaces/${_spaceId}/automations/${id}`),
  create: (data: AutomationCreateBody, key:string = crypto.randomUUID())        => operationAt<AutomationOut>('POST', `/spaces/${_spaceId}/automations`, data, key),
  update: (id: string, data: AutomationUpdateBody, key:string = crypto.randomUUID()) => operationAt<AutomationOut>('PATCH', `/spaces/${_spaceId}/automations/${id}`, data, key),
  requestFire: (id:string, body:import('@rainver/protocol').AutomationFireBody={}, key:string=crypto.randomUUID(), options: RequestOptions = {}) => {
    const spaceId = options.spaceId ?? _spaceId
    return operationAt<import('@rainver/protocol').AutomationFireReceipt>('POST',
      `/spaces/${spaceId}/automations/${encodeURIComponent(id)}/fire`, body, key, { ...options, spaceId })
  },
  fireRequest: (receipt:import('@rainver/protocol').AutomationFireReceipt, options: RequestOptions = {}) =>
    get<import('@rainver/protocol').AutomationFireRequest>(
      `/spaces/${receipt.space_id}/automations/${encodeURIComponent(receipt.automation_id)}/fire-requests/${encodeURIComponent(receipt.job_id)}`,
      { ...options, spaceId: receipt.space_id },
    ),
  // Preserve the UI's completed-target semantics across the asynchronous HTTP contract.
  fire: async (id:string,body:import('@rainver/protocol').AutomationFireBody={},key:string=crypto.randomUUID(),options: RequestOptions = {}):Promise<AutomationFireResult> => {
    const epoch = sessionEpoch()
    const receipt = await automationsApi.requestFire(id, body, key, options)
    return pollRead({
      signal: options.signal, epoch, timeoutMs: 180_000, intervalMs: 500,
      sessionChanged: 'The session changed while the automation was running',
      timedOut: () => new ApiRequestError('Automation is still running; check the Job Queue', 503, 'operation_temporarily_unavailable', {
        error: { code: 'operation_temporarily_unavailable', metadata: { receipt } },
      }),
    }, signal => automationsApi.fireRequest(receipt, { signal }), request => {
      if (request.outcome === 'completed' && request.result) return request.result as unknown as AutomationFireResult
      if (['completed', 'failed', 'unknown'].includes(request.outcome)) throw new Error(request.error ?? 'Automation fire did not complete')
      return READ_PENDING
    })
  },
  workflowExecutions: (id: string) =>
    get<WorkflowExecutionSummary[]>(`/spaces/${_spaceId}/automations/${encodeURIComponent(id)}/workflow-executions`),
}

export const dailyReportApi = {
  getSettings: () =>
    get<DailyCaptureReportSettingOut>('/daily-capture-report/settings'),

  updateSettings: (data: DailyCaptureReportSettingUpdate,key:string=crypto.randomUUID()) =>
    commandReceipt('daily_capture.settings.patch', data,key),
  setSettings:(data:OperationInput<'daily_capture.settings.set'>,key:string=crypto.randomUUID())=>commandReceipt('daily_capture.settings.set',data,key),

  run: (data: OperationInput<'daily_capture.run'>,key:string=crypto.randomUUID()) =>
    commandReceipt('daily_capture.run', data,key),

  listReports: (limit = 10) =>
    get<DailyReportArtifactItem[]>(`/daily-capture-report/reports?limit=${limit}`),
}
