import { sessionEpoch } from '../lib/sessionResidue'
import type {
  ReaderAnnotation,
  ReaderAnnotationCreate,
  ReaderAnnotationUpdate,
  ReaderAnnotationsResponse,
  ReaderCommentCreate,
  ReaderCommentThread,
  ReaderCommentUpdate,
  ReaderCreateEvidenceRequest,
  ReaderCreateProposalRequest,
  ReaderDocumentPayload,
  ReaderThreadUpdate,
} from '../types/api'
import { operationAt } from './operations'
import { pollRead, READ_PENDING } from './pollRead'
import type { RequestOptions } from './transport'
import { ApiRequestError, get } from './transport'
import type {
  ReaderAnnotationRangeUpdate,
  ReaderAppearance,
  ReaderDocumentNoteResponse,
  ReaderPositionResult,
  ReaderPositionWrite,
} from '@rainver/protocol'

// ── Reader ────────────────────────────────────────────────────────────────
type ReaderWriteReceipt = import('@rainver/protocol').ReaderWriteReceipt

/** One explicit-key Reader command, never retried; bodies come only from the authorized Reader readers. */
function readerWrite(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, options: RequestOptions = {}): Promise<ReaderWriteReceipt> {
  return operationAt<ReaderWriteReceipt>(method, `/reader${path}`, body ?? {}, crypto.randomUUID(), options)
}

function readerWriteRefusal(outcome: import('@rainver/protocol').ReaderWriteJobResult['outcome']): ApiRequestError {
  if (outcome === 'unavailable') return new ApiRequestError('This document or annotation is no longer available', 404, 'operation_not_found')
  if (outcome === 'conflict') return new ApiRequestError('The document changed. Reload before trying again.', 409, 'operation_conflict')
  return new ApiRequestError('The change could not be applied', 422, 'operation_invalid_input')
}

/** Read-only polling of one queued Reader write through its current-access reader. Never resubmits. */
function waitForReaderWrite(receipt: ReaderWriteReceipt, epoch: number, signal?: AbortSignal): Promise<import('@rainver/protocol').ReaderWriteJobResult> {
  const jobId = receipt.job_id ?? receipt.id
  return pollRead({
    signal, epoch, timeoutMs: 60_000, intervalMs: 150, maxIntervalMs: 1000,
    sessionChanged: 'The session changed while saving',
    timedOut: () => new ApiRequestError('The Reader change is still being saved; refresh later', 503, 'operation_temporarily_unavailable', {
      error: { code: 'operation_temporarily_unavailable', metadata: { job_id: jobId, space_id: receipt.space_id } },
    }),
  }, readSignal => get<import('@rainver/protocol').ReaderWriteRequestView>(
    `/reader/write-requests/${encodeURIComponent(jobId)}`, { spaceId: receipt.space_id, signal: readSignal },
  ), view => {
    if (view.status === 'completed' && view.result) return view.result
    if (['failed', 'cancelled', 'completed'].includes(view.status)) throw new Error('The Reader change did not complete')
    return READ_PENDING
  })
}

async function readerAnnotationAfter(receipt: ReaderWriteReceipt): Promise<ReaderAnnotation> {
  const list = await get<ReaderAnnotationsResponse>(`/reader/documents/${receipt.document_type}/${receipt.document_id}/annotations`, { spaceId: receipt.space_id })
  const found = list.items.find(item => item.id === receipt.annotation_id)
  if (!found) throw readerWriteRefusal('unavailable')
  return found
}

async function readerThreadsAfter(receipt: ReaderWriteReceipt): Promise<ReaderCommentThread[]> {
  return (await get<{ items: ReaderCommentThread[] }>(`/reader/annotations/${receipt.annotation_id}/threads`, { spaceId: receipt.space_id })).items
}

export const readerApi = {
  sourceVersions: (itemId: string, offset = 0) =>
    get<import('@rainver/protocol').ReaderSourceVersions>(`/reader/source-items/${itemId}/versions?offset=${offset}`),
  sourceVersion: (itemId: string, snapshotId: string) =>
    get<ReaderDocumentPayload>(`/reader/source-items/${itemId}/versions/${encodeURIComponent(snapshotId)}`),
  /** `origin: 'serendipity'` marks an open that came from the digest's serendipity section; it is not interest evidence. */
  getDocument: (documentType: string, documentId: string, options: { origin?: 'library' | 'serendipity' | 'project' } = {}) =>
    get<ReaderDocumentPayload>(`/reader/documents/${documentType}/${documentId}${options.origin ? `?origin=${options.origin}` : ''}`),

  documentNote: (documentType: string, documentId: string) =>
    get<ReaderDocumentNoteResponse>(`/reader/documents/${documentType}/${documentId}/note`),
  createDocumentNote: async (documentType: string, documentId: string, title: string) => {
    const receipt = await readerWrite('POST', `/documents/${documentType}/${documentId}/note`, { title })
    return get<ReaderDocumentNoteResponse>(`/reader/documents/${documentType}/${documentId}/note`, { spaceId: receipt.space_id })
  },

  listAnnotations: (documentType: string, documentId: string) =>
    get<ReaderAnnotationsResponse>(`/reader/documents/${documentType}/${documentId}/annotations`),

  createAnnotation: async (body: ReaderAnnotationCreate) =>
    readerAnnotationAfter(await readerWrite('POST', '/annotations', body)),

  updateAnnotation: async (annotationId: string, body: ReaderAnnotationUpdate) =>
    readerAnnotationAfter(await readerWrite('PATCH', `/annotations/${annotationId}`, body)),

  /** Queued: the server reads the body outside its transaction, then the current annotation is reread. */
  updateAnnotationRange: async (annotationId: string, body: ReaderAnnotationRangeUpdate) => {
    const epoch = sessionEpoch()
    const receipt = await readerWrite('PATCH', `/annotations/${annotationId}/range`, body)
    const result = await waitForReaderWrite(receipt, epoch)
    if (result.outcome !== 'applied') throw readerWriteRefusal(result.outcome)
    return readerAnnotationAfter(receipt)
  },

  deleteAnnotation: async (annotationId: string) => { await readerWrite('DELETE', `/annotations/${annotationId}`) },

  listThreads: (annotationId: string) =>
    get<{ items: ReaderCommentThread[] }>(`/reader/annotations/${annotationId}/threads`),

  createComment: async (annotationId: string, body: ReaderCommentCreate) => {
    const receipt = await readerWrite('POST', `/annotations/${annotationId}/comments`, body)
    const thread = (await readerThreadsAfter(receipt)).find(item => item.id === receipt.id)
    if (!thread) throw readerWriteRefusal('unavailable')
    return { thread }
  },

  updateComment: async (commentId: string, body: ReaderCommentUpdate) => {
    const receipt = await readerWrite('PATCH', `/comments/${commentId}`, body)
    const comment = (await readerThreadsAfter(receipt)).flatMap(thread => thread.comments).find(item => item.id === receipt.id)
    if (!comment) throw readerWriteRefusal('unavailable')
    return comment
  },

  updateThread: async (threadId: string, body: ReaderThreadUpdate) => {
    const receipt = await readerWrite('PATCH', `/comment-threads/${threadId}`, body)
    const thread = (await readerThreadsAfter(receipt)).find(item => item.id === receipt.id)
    if (!thread) throw readerWriteRefusal('unavailable')
    return thread
  },

  /** Identity-only receipt; the candidate Evidence is read through its own reader. */
  createEvidence: (annotationId: string, body: ReaderCreateEvidenceRequest) =>
    readerWrite('POST', `/annotations/${annotationId}/evidence`, body),

  /** Identity-only receipt of the pending proposal (memory_create or knowledge_create). */
  createProposal: (annotationId: string, body: ReaderCreateProposalRequest) =>
    readerWrite('POST', `/annotations/${annotationId}/proposals`, body),

  /** The person's own reading position in a document (private; not read status). */
  getPosition: (spaceId: string, documentType: string, documentId: string) =>
    get<ReaderPositionResult>(`/reader/documents/${documentType}/${documentId}/position`, { spaceId }),

  /** Queued, then reread. A keepalive report at page exit is sent once and not awaited. */
  putPosition: async (spaceId: string, documentType: string, documentId: string, body: ReaderPositionWrite, options: Pick<RequestOptions, 'keepalive' | 'signal'> = {}): Promise<ReaderPositionResult> => {
    const epoch = sessionEpoch()
    const receipt = await readerWrite('PUT', `/documents/${documentType}/${documentId}/position`, body, { spaceId, ...options })
    if (options.keepalive) return { position: null, accepted: true }
    const result = await waitForReaderWrite(receipt, epoch, options.signal)
    if (result.outcome === 'stale_document') return { position: null, accepted: false, reason: 'stale_document' }
    if (result.outcome !== 'applied' && result.outcome !== 'not_accepted') throw readerWriteRefusal(result.outcome)
    const current = await get<ReaderPositionResult>(`/reader/documents/${documentType}/${documentId}/position`, { spaceId, signal: options.signal })
    return { position: current.position, accepted: result.outcome === 'applied' }
  },

  getAppearance: () => get<ReaderAppearance>('/reader/preferences/appearance'),

  putAppearance: async (body: ReaderAppearance) => {
    await readerWrite('PUT', '/preferences/appearance', body)
    return get<ReaderAppearance>('/reader/preferences/appearance')
  },

  listByProject: (projectId: string, limit?: number) =>
    get<{ items: ReaderAnnotation[] }>(
      `/reader/annotations?project_id=${encodeURIComponent(projectId)}${limit != null ? `&limit=${limit}` : ''}`,
    ),
}
