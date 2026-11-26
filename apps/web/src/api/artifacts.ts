import { sessionEpoch } from '../lib/sessionResidue'
import type {
  ApiError,
  Artifact,
  EgressApprovalRequest,
  Page,
  PersonalMemoryGrantAuditResponse,
  PersonalMemoryGrantCreateRequest,
  PersonalMemoryGrantPreviewRequest,
  PersonalMemoryGrantResponse,
  Proposal,
} from '../types/api'
import { operationAt } from './operations'
import type { RequestOptions } from './transport'
import { _spaceId, ACCOUNT_SWITCHED_HEADER, accountFetch, accountHeaders, ApiRequestError, BASE, formatApiErrorMessage, get, noteAccountSwitched, signalAuthRequired } from './transport'
import type { OperationOutput } from '@rainver/protocol'

// ── Personal Memory Grants ─────────────────────────────────────────────────
export const personalMemoryGrantsApi = {
  previewPersonalMemoryGrant: (input: PersonalMemoryGrantPreviewRequest, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal_memory_grant.preview'>>('POST','/personal-memory-grants/preview',input,key),
  createPersonalMemoryGrant: (input: PersonalMemoryGrantCreateRequest, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal_memory_grant.create'>>('POST','/personal-memory-grants',input,key),
  listPersonalMemoryGrants: (filters: { status?: string; target_space_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (filters.status !== undefined) q.status = filters.status
    if (filters.target_space_id !== undefined) q.target_space_id = filters.target_space_id
    return get<PersonalMemoryGrantResponse[]>('/personal-memory-grants?' + new URLSearchParams(q))
  },
  revokePersonalMemoryGrant: (grantId: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal_memory_grant.revoke'>>('POST',`/personal-memory-grants/${grantId}/revoke`,{},key),
  getPersonalMemoryGrantAudit: (grantId: string) =>
    get<PersonalMemoryGrantAuditResponse>(`/personal-memory-grants/${grantId}/audit`),
}

// ── Artifacts ─────────────────────────────────────────────────────────────
export const artifactsApi = {
  list: (params: {
    artifact_type?: string
    project_id?: string
    project_folder_id?: string
    run_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.artifact_type !== undefined) q.artifact_type = params.artifact_type
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    if (params.run_id !== undefined) q.run_id = params.run_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Artifact>>('/artifacts?' + new URLSearchParams(q))
  },
  get: (id: string, params: { project_folder_id?: string } = {}, options: RequestOptions = {}) => {
    const q: Record<string, string> = {}
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    const suffix = new URLSearchParams(q).toString()
    return get<Artifact>(`/artifacts/${id}${suffix ? `?${suffix}` : ''}`, options)
  },
  export: (id: string, params: { project_folder_id?: string } = {}, options: RequestOptions = {}) => downloadArtifactExport(id, params, options),
}

async function downloadArtifactExport(
  artifactId: string,
  params: { project_folder_id?: string } = {},
  options: RequestOptions = {},
): Promise<void> {
  const authGeneration = sessionEpoch()
  const assertCurrent = () => {
    if (authGeneration !== sessionEpoch() || options.signal?.aborted) {
      throw new DOMException('Download cancelled', 'AbortError')
    }
  }
  const headers: Record<string, string> = { ...accountHeaders() }
  headers['X-Rainver-Space-Id'] = options.spaceId ?? _spaceId
  const sep = '/artifacts/' + artifactId + '/export'
  const query = new URLSearchParams()
  if (params.project_folder_id !== undefined) query.set('project_folder_id', params.project_folder_id)
  const artifactParams = query.toString()
  const url = BASE + sep + (artifactParams ? `?${artifactParams}` : '')
  const startedIn = sessionEpoch()
  const r = await accountFetch(url, { method: 'GET', headers, signal: options.signal })
  assertCurrent()
  if (r.status === 401) signalAuthRequired(startedIn)
  noteAccountSwitched(r.status, r.headers.get(ACCOUNT_SWITCHED_HEADER), startedIn, options.signal)
  if (r.status === 404) throw new ApiRequestError('Artifact not found or not exportable', 404)
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const err = await r.json() as ApiError
      msg = formatApiErrorMessage(err, msg)
    } catch {
      const text = await r.text().catch(() => '')
      if (text) msg = text
    }
    throw new ApiRequestError(msg, r.status)
  }
  const cd = r.headers.get('Content-Disposition')
  let filename = 'artifact'
  if (cd) {
    const m = /filename="([^"]+)"/.exec(cd) ?? /filename=([^;]+)/.exec(cd)
    if (m) filename = m[1].trim()
  }
  const blob = await r.blob()
  assertCurrent()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

// ── Proposals (canonical list) ────────────────────────────────────────────
export const proposalsApi = {
  list: (params: {
    status?: string
    type?: string
    proposal_type?: string
    types?: readonly string[]
    urgency?: string
    expired?: boolean
    project_id?: string
    limit?: number
    offset?: number
  } = {}, options: RequestOptions = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.type !== undefined) q.type = params.type
    if (params.proposal_type !== undefined) q.type = params.proposal_type
    if (params.types?.length) q.types = params.types.join(',')
    if (params.urgency !== undefined) q.urgency = params.urgency
    if (params.expired !== undefined) q.expired = String(params.expired)
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Proposal>>('/proposals?' + new URLSearchParams(q), options)
  },
  get: (id: string, options: RequestOptions = {}) => get<Proposal>(`/proposals/${id}`, options),
  /** `expectedRevision`: the revision the person was shown (a card's `card_revision`); refused once the Proposal changed since. */
  accept: (id: string, options: RequestOptions & { confirmIncompletePatch?: boolean; expectedRevision?: string } = {}) => {
    return operationAt<OperationOutput<'proposal.accept'>>('POST', `/proposals/${encodeURIComponent(id)}/accept`, {confirm_incomplete_patch:options.confirmIncompletePatch??false,...(options.expectedRevision?{expected_revision:options.expectedRevision}:{})}, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  rollback: (id: string, options: RequestOptions = {}) => operationAt<OperationOutput<'proposal.rollback'>>('POST', `/proposals/${encodeURIComponent(id)}/rollback`, {}, options.idempotencyKey ?? crypto.randomUUID(), options),
  reject: (id: string, options: RequestOptions = {}) => operationAt<OperationOutput<'proposal.reject'>>('POST', `/proposals/${encodeURIComponent(id)}/reject`, {}, options.idempotencyKey ?? crypto.randomUUID(), options),
  approveEgressGrantingUserProposal: (id: string, input: EgressApprovalRequest = {}, options: RequestOptions = {}) =>
    operationAt<OperationOutput<'proposal.egress.approve'>>('POST', `/proposals/${encodeURIComponent(id)}/approvals/egress-granting-user`, input, options.idempotencyKey ?? crypto.randomUUID(), options),
}
