import { sessionEpoch } from '../lib/sessionResidue'
import type {
  AgentConfigUpdateBody,
  AgentCreateBody,
  AgentOut,
  AgentRuntimeProfileCreateBody,
  AgentRuntimeProfileOut,
  AgentRuntimeProfileUpdateBody,
  AgentTemplateOut,
  AgentTemplateVersionOut,
  AgentUpdateBody,
  AgentVersionOut,
  AskSpaceRequest,
  AskSpaceResponse,
  ChatTurnAccepted,
  ChatTurnRequest,
  ContextOpsContextObservationScanRequestInput,
  ContextOpsContextObservationScanResponse,
  ContextOpsDrilldown,
  ContextOpsDrilldownSection,
  ContextOpsSummary,
  ContextReviewCycleRequestInput,
  ContextReviewCycleResponse,
  ConversationBackendBinding,
  ConversationBackendCatalog,
  ConversationRetryResponse,
  CreateAgentFromTemplateBody,
  Page,
  Proposal,
  Run,
  RunCreateBody,
  RunTurn,
  SkillImportApprovalProposalResponse,
  SkillImportPreviewResponse,
  SkillPackage,
  SpaceAgentRuntimeDefaultOut,
  SpaceAgentRuntimeDefaultWrite,
  SpaceAssistantSettingsOut,
  SpaceAssistantSettingsUpdate,
} from '../types/api'
import { postChatTurn } from './conversation'
import { pollRead, READ_PENDING } from './pollRead'
import { contentRequest } from './jobReads'
import { commandReceipt, operationAt } from './operations'
import type { RequestOptions } from './transport'
import { ApiRequestError, get } from './transport'
import type {
  ConversationInputPart,
  UsageAccuracy,
  UsageBudgetPreviewResponse,
  UsageDimensionsResponse,
  UsageEventsResponse,
  UsageExecutionChannel,
  UsageOperationalTotalsResponse,
  UsageSessionsResponse,
  UsageSubjectsResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
  UsageView,
} from '@rainver/protocol'

// ── Agents ────────────────────────────────────────────────────────────────
/** Current Profile view after a Profile command; the receipt carries only identities. */
async function runtimeProfile(receipt:{agent_id:string;profile_id:string;space_id:string}):Promise<AgentRuntimeProfileOut>{
  const profiles=await get<AgentRuntimeProfileOut[]>(`/agents/${encodeURIComponent(receipt.agent_id)}/runtime-profiles`,{spaceId:receipt.space_id})
  const profile=profiles.find(row=>row.id===receipt.profile_id);if(!profile)throw new Error('Runtime profile no longer available');return profile
}

export const agentsApi = {
  list: (params: Record<string, string> = {}, options: { spaceId?: string } = {}) =>
    get<AgentOut[]>('/agents?' + new URLSearchParams(params), { spaceId: options.spaceId }),
  get: (agentId: string, options: RequestOptions = {}) => get<AgentOut>(`/agents/${agentId}`, options),
  /** The managed Assistant instance for a scope: the Space's own, or a Project's (null before its first Room message). */
  getSystemAssistant: (projectId?: string | null) =>
    get<{ assistant: AgentOut | null }>(`/agents/system-assistant${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  // One keyed command per call (no retries); the receipt names the Agent, then the current view is read.
  create: async (data: AgentCreateBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.create', data, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  update: async (agentId: string, data: AgentUpdateBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.update', { ...data, agent_id: agentId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  // Config edit: appends a new immutable AgentVersion and repoints current_version_id.
  updateConfig: async (agentId: string, data: AgentConfigUpdateBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.config.update', { ...data, agent_id: agentId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  listRuntimeProfiles: (agentId: string, options: RequestOptions = {}) =>
    get<AgentRuntimeProfileOut[]>(`/agents/${agentId}/runtime-profiles`, options),
  getSpaceRuntimeDefault: () => get<SpaceAgentRuntimeDefaultOut | null>('/agents/runtime-default'),
  setSpaceRuntimeDefault: async (data: SpaceAgentRuntimeDefaultWrite, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.runtime_default.set', data, key)
    const value = await get<SpaceAgentRuntimeDefaultOut | null>('/agents/runtime-default', { spaceId: receipt.space_id })
    if (!value) throw new Error('Runtime default no longer available')
    return value
  },
  createRuntimeProfile: async (agentId: string, data: AgentRuntimeProfileCreateBody, key: string = crypto.randomUUID()) =>
    runtimeProfile(await commandReceipt('agent.runtime_profile.create', { ...data, agent_id: agentId }, key)),
  resolveHostRuntimeProfile: async (agentId: string, data: {
    execution_host_id: string
    workspace_location_id: string | null
    workspace_mode: 'location' | 'managed'
    runtime_key: string
    runtime_installation: string
  }, key: string = crypto.randomUUID()) => runtimeProfile(await commandReceipt('agent.runtime_profile.ensure_host', { ...data, agent_id: agentId }, key)),
  updateRuntimeProfile: async (agentId: string, profileId: string, data: AgentRuntimeProfileUpdateBody, key: string = crypto.randomUUID()) =>
    runtimeProfile(await commandReceipt('agent.runtime_profile.update', { ...data, agent_id: agentId, profile_id: profileId }, key)),
  currentVersion: (agentId: string) => get<AgentVersionOut>(`/agents/${agentId}/current-version`),
  conversationBackends: (
    agentId: string,
    options: RequestOptions & { sessionId?: string; projectId?: string } = {},
  ) =>
    get<ConversationBackendCatalog>(
      `/agents/${agentId}/conversation-backends${options.sessionId
        ? `?session_id=${encodeURIComponent(options.sessionId)}`
        : options.projectId ? `?project_id=${encodeURIComponent(options.projectId)}` : ''}`,
      { spaceId: options.spaceId, signal: options.signal },
    ),
  saveConversationSessionConfig: async (
    agentId: string,
    data: { session_id: string; runtime_profile_id: string; session_config: NonNullable<ConversationBackendCatalog['session_config']>; allow_quota_model_switch?: boolean },
    options: RequestOptions = {},
  ): Promise<{ session_config: NonNullable<ConversationBackendCatalog['session_config']>; allow_quota_model_switch?: boolean }> => {
    const receipt = await commandReceipt('conversation.session_config.save', { ...data, agent_id: agentId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    try {
      const catalog = await get<ConversationBackendCatalog>(`/agents/${encodeURIComponent(agentId)}/conversation-backends?session_id=${encodeURIComponent(receipt.session_id)}`, { spaceId: receipt.space_id, signal: options.signal })
      return { session_config: catalog.session_config ?? [], allow_quota_model_switch: catalog.allow_quota_model_switch ?? false }
    } catch (error) {
      // The command is already committed. Consumers must retry only readback.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { settingsSaved: true })
    }
  },
  // Assistant preferences (soft UI/context layer — never edits prompt or hard policy).
  getAssistantSettings: () => get<SpaceAssistantSettingsOut>('/agents/default-assistant/settings'),
  updateAssistantSettings: async (data: SpaceAssistantSettingsUpdate, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.assistant_settings.update', data, key)
    return get<SpaceAssistantSettingsOut>(`/agents/default-assistant/settings${receipt.project_id ? `?project_id=${encodeURIComponent(receipt.project_id)}` : ''}`, { spaceId: receipt.space_id })
  },
  listVersions: (agentId: string) => get<AgentVersionOut[]>(`/agents/${agentId}/versions`),
  getVersion: (agentId: string, versionId: string, options?: RequestOptions) =>
    get<AgentVersionOut>(`/agents/${agentId}/versions/${versionId}`, options),
  restoreVersion: async (agentId: string, versionId: string, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.version.restore', { agent_id: agentId, version_id: versionId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  listProposals: (agentId: string, status = 'pending') =>
    get<Proposal[]>(`/agents/${agentId}/proposals?status=${encodeURIComponent(status)}`),
  createRun: async (agentId: string, body: RunCreateBody = {}, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.run.create', { ...body, agent_id: agentId }, key)
    return get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { spaceId: receipt.space_id })
  },
  // Queue the Chat Run, then subscribe to its canonical lifecycle stream.
  chat: (
    agentId: string,
    body: {
      message: string
      input_parts?: ConversationInputPart[]
      session_id?: string
      project_id?: string
      restore_workspace?: boolean
      backend?: Pick<ConversationBackendBinding, 'runtime_profile_id'>
      session_config?: NonNullable<ChatTurnRequest['session_config']>
    },
    options: RequestOptions & {
      onAccepted?: (accepted: ChatTurnAccepted) => void
      onTurn?: (turn: RunTurn) => void
    } = {},
  ) => postChatTurn(agentId, body, options),
  // A same-key replay returns the same receipt; the transport no longer reports a separate `reused` flag.
  retryConversation: async (agentId: string, runId: string, options: RequestOptions = {}): Promise<Omit<ConversationRetryResponse, 'reused'>> => {
    const { space_id: _space, ...retry } = await commandReceipt('agent.chat.retry', { agent_id: agentId, run_id: runId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return retry
  },
  /** `sessionId`: the open direct conversation; the server resets the Host container its turns use (its own, or the person's direct one). */
  resetContext: async (agentId: string, options: RequestOptions & { sessionId?: string } = {}) => {
    const { sessionId, ...request } = options
    const receipt = await commandReceipt('agent.chat.reset_context', { agent_id: agentId, ...(sessionId ? { session_id: sessionId } : {}) }, request.idempotencyKey ?? crypto.randomUUID(), request)
    return { agent_id: receipt.agent_id, session_reset: receipt.session_reset, thread_id: receipt.thread_id, workspace_mode: receipt.workspace_mode }
  },
  listRuns:       (limit = 50)        => get<Run[]>(`/agents/runs?limit=${limit}`),
  getRun:         (runId: string, options: RequestOptions = {})     => get<Run>(`/runs/${runId}`, options),
  listRunsForAgent:  (agentId: string, options: RequestOptions = {})   => get<Run[]>(`/agents/${agentId}/runs`, options),
}

// ── Agent Templates (reusable factories) ────────────────────────────────────
export const agentTemplatesApi = {
  list: (params: Record<string, string> = {}) =>
    get<AgentTemplateOut[]>('/agent-templates?' + new URLSearchParams(params)),
  get: (templateId: string) => get<AgentTemplateOut>(`/agent-templates/${templateId}`),
  listVersions: (templateId: string) =>
    get<AgentTemplateVersionOut[]>(`/agent-templates/${templateId}/versions`),
  getVersion: (templateId: string, versionId: string) =>
    get<AgentTemplateVersionOut>(`/agent-templates/${templateId}/versions/${versionId}`),
  createAgent: async (templateId: string, body: CreateAgentFromTemplateBody = {}, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.template.instantiate', { ...body, template_id: templateId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
}

/** A single source command followed only by authorized result reads. */
async function skillSourceRequest<T>(path:string,input:unknown,options:RequestOptions={}):Promise<T>{
  const epoch = sessionEpoch()
  const receipt = await operationAt<{ job_id: string; space_id: string }>('POST', path, input, options.idempotencyKey ?? crypto.randomUUID(), options)
  return pollRead({
    signal: options.signal, epoch, timeoutMs: 180_000, intervalMs: 500,
    sessionChanged: 'The session changed while Skills were loading',
    timedOut: () => new Error('Skill source request is still running; refresh later'),
  }, signal => get<{ status: string; result: T | null; error?: { code: string; message: string } | null }>(
    `/skill-sources/requests/${encodeURIComponent(receipt.job_id)}`, { ...options, spaceId: receipt.space_id, signal },
  ), job => {
    if (job.status === 'completed' && job.result) return job.result
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (job.error) throw new ApiRequestError(job.error.message, 409, job.error.code)
      throw new Error('Skill source request did not complete')
    }
    return READ_PENDING
  })
}

export const skillsApi = {
  scanHostSkills: (hostId: string, options?: RequestOptions) =>
    skillSourceRequest<import('@rainver/protocol').HostSkillScan>(`/skill-sources/hosts/${encodeURIComponent(hostId)}/scan`, {}, options),
  /** Skills enabled for every addressed recipient; a Room menu names them in `recipient_agent_ids` (none means the manager). */
  availableSkills: (query: { session_id?: string | null; project_id?: string | null; agent_id?: string | null; recipient_agent_ids?: readonly string[] }, options?: RequestOptions) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      const text = typeof value === 'string' || value == null ? value : value.join(',')
      if (text) params.set(key, text)
    }
    return get<import('@rainver/protocol').ConversationInputSkillPart[]>(`/skills/available?${params}`, options)
  },
  previewSkillImport: (data: import('@rainver/protocol').SkillImportPreviewRequest, options?: RequestOptions) =>
    skillSourceRequest<SkillImportPreviewResponse>('/skill-sources/import-preview', data, options),
  /** Imports the previewed package; `package_hash` is the preview's, and a changed package answers 409 `skill_package_changed`. */
  importSkill: (data: import('@rainver/protocol').SkillImportRequest, options?: RequestOptions) =>
    skillSourceRequest<SkillPackage>('/skill-sources/import', data, options),
  listSkillPackages: (options?: RequestOptions, offset = 0) =>
    get<Page<SkillPackage>>(`/skill-packages?limit=100&offset=${offset}`, options),
  getSkillContent: (id: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').SkillPackageContent>(`/skill-packages/${encodeURIComponent(id)}/content`, options),
  listSkillBindings: (id: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').SkillBinding[]>(`/skill-packages/${encodeURIComponent(id)}/bindings`, options),
  createSkillBindingProposal: (id: string, data: import('@rainver/protocol').SkillBindingRequest, options?: RequestOptions) =>
    operationAt<{proposal_id:string}>('POST',`/skill-packages/${encodeURIComponent(id)}/binding-proposal`,data,options?.idempotencyKey??crypto.randomUUID(),options).then(receipt=>get<Proposal>(`/proposals/${encodeURIComponent(receipt.proposal_id)}`,options)),
  getSkillPackage: (id: string, options?: RequestOptions) =>
    get<SkillPackage>(`/skill-packages/${encodeURIComponent(id)}`, options),
  /** Files the review; an enabling `binding` makes the same approval enable the package for that scope. */
  createSkillReviewProposal: (skillPackageId: string, data: import('@rainver/protocol').SkillReviewProposalRequest = {}, options?: RequestOptions) =>
    operationAt<{proposal_id:string}>('POST',`/skill-packages/${encodeURIComponent(skillPackageId)}/review-proposal`,data,options?.idempotencyKey??crypto.randomUUID(),options).then(receipt=>get<SkillImportApprovalProposalResponse>(`/proposals/${encodeURIComponent(receipt.proposal_id)}`,options)),

}

export const contextOpsApi = {
  summary: (params: { window_days?: number; limit?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.window_days !== undefined) q.window_days = String(params.window_days)
    if (params.limit !== undefined) q.limit = String(params.limit)
    const suffix = new URLSearchParams(q).toString()
    return get<ContextOpsSummary>(`/context-ops/summary${suffix ? `?${suffix}` : ''}`)
  },
  drilldown: (section: ContextOpsDrilldownSection, params: { limit?: number } = {}) => {
    const q: Record<string, string> = { section }
    if (params.limit !== undefined) q.limit = String(params.limit)
    return get<ContextOpsDrilldown>(`/context-ops/drilldown?${new URLSearchParams(q).toString()}`)
  },
  reviewCycleRun: (data: ContextReviewCycleRequestInput = {},key:string=crypto.randomUUID()) =>
    operationAt<ContextReviewCycleResponse>('POST','/context-ops/review-cycle/run',data,key),
  contextObservationScan: (data: ContextOpsContextObservationScanRequestInput = {},key:string=crypto.randomUUID()) =>
    operationAt<ContextOpsContextObservationScanResponse>('POST','/context-ops/context-observations/scan',data,key),
}

export const askSpaceApi = {
  think: (data: AskSpaceRequest,key:string=crypto.randomUUID()) => contentRequest<AskSpaceResponse>('ask_space.think',data,key),
}

export interface UsageApiQuery {
  view?: UsageView
  from?: string
  to?: string
  group_by?: string
  granularity?: 'day' | 'week' | 'month'
  accuracy?: UsageAccuracy
  execution_channel?: UsageExecutionChannel
  provider_id?: string
  model?: string
  task?: string
  subject_type?: string
  subject_id?: string
  session_id?: string
  external_session_id?: string
  session_path?: string
  dimension_key?: string
  dimension_value?: string
  include_imported?: boolean
  limit?: number
  offset?: number
  projection_window_days?: number
}

function usageQuery(params: UsageApiQuery = {}): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    q.set(key, String(value))
  }
  const queryString = q.toString()
  return queryString ? `?${queryString}` : ''
}

export const usageApi = {
  summary: (params: UsageApiQuery = {}) =>
    get<UsageSummaryResponse>(`/usage/summary${usageQuery(params)}`),
  timeseries: (params: UsageApiQuery = {}) =>
    get<UsageTimeseriesResponse>(`/usage/timeseries${usageQuery(params)}`),
  events: (params: UsageApiQuery = {}) =>
    get<UsageEventsResponse>(`/usage/events${usageQuery(params)}`),
  dimensions: (params: UsageApiQuery = {}) =>
    get<UsageDimensionsResponse>(`/usage/dimensions${usageQuery(params)}`),
  subjects: (params: UsageApiQuery = {}) =>
    get<UsageSubjectsResponse>(`/usage/subjects${usageQuery(params)}`),
  sessions: (params: UsageApiQuery = {}) =>
    get<UsageSessionsResponse>(`/usage/sessions${usageQuery(params)}`),
  budgetPreview: (params: UsageApiQuery = {}) =>
    get<UsageBudgetPreviewResponse>(`/usage/budget-preview${usageQuery(params)}`),
  operationalTotals: (params: Pick<UsageApiQuery, 'from' | 'to'> = {}) =>
    get<UsageOperationalTotalsResponse>(`/usage/operations/totals${usageQuery(params)}`),
}
