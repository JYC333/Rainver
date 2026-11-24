import { sessionEpoch } from '../lib/sessionResidue'
import type {
  CrossSpaceRetrievalRequest,
  HomeSummaryOut,
  MePendingProposalItem,
  MeSummaryOut,
  MeTaskItem,
  MeTimelineEntry,
  Page,
  SpaceMemberNotification,
} from '../types/api'
import { operationAt } from './operations'
import { readServerSentEvents } from './streams'
import type { RequestOptions } from './transport'
import { ApiRequestError, BASE, get, streamRefusal } from './transport'
import type {
  AgentAttentionPage,
  AgentAttentionQueryInput,
  AgentAttentionReadRequest,
  AgentAttentionReadState,
  AgentAttentionViewRequest,
  AgentAttentionViewResult,
  AgentWorkIdentity,
  AgentWorkItem,
  OperationOutput,
} from '@rainver/protocol'
import {
  AgentAttentionQuerySchema,
  AgentAttentionReadRequestSchema,
  AgentAttentionStreamFrameSchema,
  AgentAttentionViewRequestSchema,
} from '@rainver/protocol'

/** User-level aggregate: active Space never supplies authority or filters. */
export const agentAttentionApi = {
  snapshot: (options: RequestOptions = {}) => get<import('@rainver/protocol').AgentAttentionStreamFrame>('/me/agent-attention/snapshot', { ...options, includeSpaceContext: false }),
  stream: async (onFrame: (frame: import('@rainver/protocol').AgentAttentionStreamFrame) => void, options: RequestOptions = {}) => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    const startedIn = sessionEpoch()
    const response = await fetch(`${BASE}/me/agent-attention/stream`, { headers, signal: options.signal })
    if (options.signal?.aborted) { await response.body?.cancel().catch(() => {}); return }
    if (!response.ok || !response.body) throw await streamRefusal(response, 'Attention stream failed', startedIn, options.signal)
    for await (const event of readServerSentEvents(response)) {
      if (options.signal?.aborted) return
      onFrame(AgentAttentionStreamFrameSchema.parse(JSON.parse(event.data)))
    }
    if (!options.signal?.aborted) throw new ApiRequestError('Attention stream disconnected', 502)
  },
  list(query: AgentAttentionQueryInput = {}, options: RequestOptions = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(AgentAttentionQuerySchema.parse(query))) {
      if (value !== undefined) params.set(key, String(value))
    }
    return get<AgentAttentionPage>(`/me/agent-attention?${params}`, { ...options, includeSpaceContext: false })
  },
  item(identity: AgentWorkIdentity & { space_id: string; runs_cursor?: string }, options: RequestOptions = {}) {
    const params = new URLSearchParams(Object.entries(identity).filter((entry): entry is [string, string] => entry[1] !== undefined))
    return get<AgentWorkItem>(`/me/agent-attention/item?${params}`, { ...options, includeSpaceContext: false })
  },
  async setReadState(body: AgentAttentionReadRequest, options: RequestOptions = {}):Promise<AgentAttentionReadState> {
    const receipt=await operationAt<OperationOutput<'attention.read_state.change'>>('PATCH','/me/agent-attention/read-state',AgentAttentionReadRequestSchema.parse(body),options.idempotencyKey??crypto.randomUUID(),{...options,includeSpaceContext:false})
    return receipt.state
  },
  /** A conversation surface displayed these messages; the server decides what that reads. */
  recordViews(body: AgentAttentionViewRequest, options: RequestOptions = {}) {
    return operationAt<OperationOutput<'attention.views.record'>>('POST','/me/agent-attention/views',AgentAttentionViewRequestSchema.parse(body),options.idempotencyKey??crypto.randomUUID(),{...options,includeSpaceContext:false}).then(({read_count,read_states}):AgentAttentionViewResult=>({read_count,read_states}))
  },
}

// ── Home (Today Command Center summary) ───────────────────────────────────
export const homeApi = {
  summary: (params: Record<string, string> = {}) =>
    get<HomeSummaryOut>('/home/summary?' + new URLSearchParams(params)),
}

// ── Personal perspective (/me aggregation) ─────────────────────────────────
export const meApi = {
  summary: (params: Record<string, string> = {}) =>
    get<MeSummaryOut>('/me/summary?' + new URLSearchParams(params), { includeSpaceContext: false }),
  timeline: (params: Record<string, string> = {}) =>
    get<MeTimelineEntry[]>('/me/timeline?' + new URLSearchParams(params), { includeSpaceContext: false }),
  tasks: (params: Record<string, string> = {}) =>
    get<Page<MeTaskItem>>('/me/tasks?' + new URLSearchParams(params), { includeSpaceContext: false }),
  pending: (params: Record<string, string> = {}) =>
    get<MePendingProposalItem[]>('/me/pending?' + new URLSearchParams(params), { includeSpaceContext: false }),
  retrievalSearch: (data: CrossSpaceRetrievalRequest, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.search'>>('POST','/me/retrieval/search',data,key,{includeSpaceContext:false}),
  resolveRetrievalPointers: (pointerIds: string[], key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.resolve'>>('POST','/me/retrieval/pointers/resolve',{pointer_ids:pointerIds},key,{includeSpaceContext:false}),
  storeSourceSummary: (pointerIds: string[], summary: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.summary.store'>>('POST','/me/retrieval/summaries',{pointer_ids:pointerIds,summary},key,{includeSpaceContext:false}),
  discloseFusedStore: (pointerIds: string[], key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.egress.disclose'>>('POST','/me/retrieval/egress/disclose',{pointer_ids:pointerIds},key,{includeSpaceContext:false}),
  storeFusedConclusion: (disclosureId: string, pointerIds: string[], conclusion: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.fused.store'>>('POST','/me/retrieval/fused-conclusions',{disclosure_id:disclosureId,pointer_ids:pointerIds,conclusion},key,{includeSpaceContext:false}),
  notifications: () =>
    get<{ items: SpaceMemberNotification[] }>('/me/notifications', { includeSpaceContext: false }),
}

export const spaceEgressApi = {
  updateNotifications: (spaceId: string, enabled: boolean, idempotencyKey: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'space.egress_notifications.update'>>('PATCH',`/spaces/${encodeURIComponent(spaceId)}/egress-notifications`, {
      egress_notifications_enabled: enabled,
    }, idempotencyKey),
}
