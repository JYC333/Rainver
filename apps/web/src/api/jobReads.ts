import { sessionEpoch } from '../lib/sessionResidue'
import type { Job, JobEvent, Page, Run } from '../types/api'
import { commandReceipt, operationAt } from './operations'
import { pollRead, READ_PENDING } from './pollRead'
import type { RequestOptions } from './transport'
import { ApiRequestError, get } from './transport'
import type { HostCommandStatus, OperationOutput, SourceRetrievalRequestView, SystemCommandStatus } from '@rainver/protocol'

export const hostPath = (hostId: string) => `/hosts/${encodeURIComponent(hostId)}`

function jobPolling(label: string, options: RequestOptions = {}, epoch = sessionEpoch()) {
  return {
    signal: options.signal, epoch, intervalMs: 1000, timeoutMs: 180_000,
    sessionChanged: `The session changed while the ${label} was running`,
    timedOut: () => new Error(`${label} is still running; refresh later`),
  }
}

/** Read-only polling of one requester-owned Job. */
export function waitForJobResult<T>(receipt: { job_id: string; space_id: string }, label: string, options?: RequestOptions): Promise<T> {
  return pollRead(jobPolling(label, options), signal =>
    get<{ status: string; result: T | null }>(`/jobs/${encodeURIComponent(receipt.job_id)}`, { spaceId: receipt.space_id, signal }),
  job => {
    if (job.status === 'completed' && job.result) return job.result
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`${label} did not complete`)
    return READ_PENDING
  })
}

/** One keyed command, followed only by current-authority result reads. */
export async function contentRequest<T>(operation: keyof typeof import('@rainver/protocol').CONTENT_RETRIEVAL_OPERATION_SCHEMAS, input: unknown, key: string = crypto.randomUUID()): Promise<T> {
  const epoch = sessionEpoch()
  const receipt = operation === 'ask_space.think'
    ? await operationAt<OperationOutput<'ask_space.think'>>('POST', '/ask-space/think', input, key)
    : await commandReceipt(operation, input as never, key)
  const domain = operation.startsWith('memory.') ? 'memory' : 'knowledge'
  const path = operation === 'ask_space.think'
    ? `/ask-space/requests/${encodeURIComponent(receipt.job_id)}`
    : `/${domain}/retrieval/requests/${encodeURIComponent(receipt.job_id)}`
  return pollRead({ ...jobPolling('Retrieval', {}, epoch), sessionChanged: 'The session changed while retrieval was running' }, signal =>
    get<{ status: string; result: T | null; withheld: number }>(path, { spaceId: receipt.space_id, signal }),
  view => {
    if (view.status === 'completed' && view.result !== null) return view.result
    if (view.status === 'completed' && view.withheld) throw new ApiRequestError('The content access changed. Search again.', 404, 'operation_not_found')
    if (['failed', 'cancelled', 'completed'].includes(view.status)) throw new Error('Retrieval did not complete')
    return READ_PENDING
  })
}

export function waitForSourceRequest(receipt: { job_id: string; space_id: string }, label: string, options?: RequestOptions): Promise<Record<string, unknown>> {
  return pollRead(jobPolling(label, options), signal =>
    get<SourceRetrievalRequestView>(`/sources/retrieval/requests/${encodeURIComponent(receipt.job_id)}`, { spaceId: receipt.space_id, signal }),
  view => {
    if (view.status === 'completed' && view.result) return view.result
    if (['failed', 'cancelled', 'completed'].includes(view.status)) throw new Error(`${label} did not complete`)
    return READ_PENDING
  })
}

export function waitForProviderRun(receipt: { run_id: string; space_id: string }, label: string, options?: RequestOptions): Promise<void> {
  return pollRead(jobPolling(label, options), signal =>
    get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { spaceId: receipt.space_id, signal }),
  run => {
    if (run.status === 'succeeded' || run.status === 'degraded') return
    if (['failed', 'cancelled', 'orphaned'].includes(run.status)) throw new Error(`${label} did not complete`)
    return READ_PENDING
  })
}

type CommandMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type CommandReceipt = { id: string; job_id: string; space_id: string }

function waitForCommand<T>(receipt: CommandReceipt, statusPath: string, label: string, kind: 'host' | 'system', timeoutMs: number, epoch: number, signal?: AbortSignal): Promise<T> {
  const onHost = kind === 'host'
  const metadata = { command_id: receipt.id, job_id: receipt.job_id }
  return pollRead({
    signal, epoch, timeoutMs, intervalMs: onHost ? 500 : 400, maxIntervalMs: 3000,
    sessionChanged: `The session changed while the ${label} was running`,
    timedOut: () => new ApiRequestError(
      onHost ? `${label} is still running on the Host; check again later` : `${label} is still running; check again later`,
      503, 'operation_temporarily_unavailable', { error: { code: 'operation_temporarily_unavailable', metadata } },
    ),
    // A lost read is not the durable result. Refusals end the wait.
    retryRead: error => !(error instanceof ApiRequestError) || error.status >= 500,
  }, readSignal => get<HostCommandStatus | SystemCommandStatus>(statusPath, { spaceId: receipt.space_id, signal: readSignal }), current => {
    if (current.status === 'succeeded') return current.result as T
    if (current.status !== 'failed' && current.status !== 'needs_attention') return READ_PENDING
    const detail = current.error?.detail ?? current.error?.code ?? null
    const reason = detail ? ` (${detail})` : ''
    const message = current.status === 'failed'
      ? `${label} did not complete${detail ? `: ${detail}` : ''}`
      : onHost
        ? `${label}: the Host may have acted, but its outcome is unknown${reason}. Check the Host's current state before repeating.`
        : `${label}: it may have run, but its outcome is unknown${reason}. Check the current state before repeating.`
    // Host results may retain the part of an import that already committed.
    throw new ApiRequestError(message, 409, 'operation_conflict', {
      error: { code: 'operation_conflict', metadata: {
        ...metadata, code: current.error?.code ?? null, status: current.status,
        ...(onHost ? { result: current.result ?? null } : {}),
      } },
    })
  })
}

/** One keyed submission followed by owner-only reads of its durable status. */
export async function hostCommand<T>(method: CommandMethod, path: string, body: unknown, label: string, key: string = crypto.randomUUID(), options: RequestOptions = {}): Promise<T> {
  const epoch = sessionEpoch()
  const receipt = await operationAt<import('@rainver/protocol').HostCommandReceipt>(method, path, body, key, options)
  return waitForCommand(receipt, `${hostPath(receipt.host_id)}/commands/${encodeURIComponent(receipt.id)}`,
    label, 'host', 25 * 60_000, epoch, options.signal)
}

/** System commands have the same browser lifetime but their own status resource. */
export async function systemCommand<T>(method: CommandMethod, path: string, body: unknown, label: string, key: string = crypto.randomUUID(), timeoutMs = 10 * 60_000, options: RequestOptions = {}): Promise<T> {
  const epoch = sessionEpoch()
  const receipt = await operationAt<import('@rainver/protocol').SystemCommandReceipt>(method, path, body, key, options)
  return waitForCommand(receipt, `/system/commands/${encodeURIComponent(receipt.id)}`, label, 'system', timeoutMs, epoch, options.signal)
}

// ── Jobs ──────────────────────────────────────────────────────────────────
export const jobsApi = {
  list:   (params: Record<string, string> = {}) =>
    get<Page<Job>>('/jobs?' + new URLSearchParams(params)),
  get:    (id: string)    => get<Job>(`/jobs/${id}`),
  events: (id: string)    => get<JobEvent[]>(`/jobs/${id}/events`),
  cancel: (id: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'job.cancel'>>('POST', `/jobs/${encodeURIComponent(id)}/cancel`, {}, key),
}
