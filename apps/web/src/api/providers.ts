import { readLoginEvents } from './streams'
import { sessionEpoch } from '../lib/sessionResidue'
import type { SubscriptionQuotaPolicy, SubscriptionQuotaPolicyUpdate } from '../types/api'
import { systemCommand } from './jobReads'
import { operationAt } from './operations'
import { _spaceId, accountFetch, accountHeaders, BASE, get, post, streamRefusal } from './transport'
import type { ApiPlanUsageProvider, ApiPlanUsageSnapshot } from '@rainver/protocol'

// ── Providers ─────────────────────────────────────────────────────────────
export type ProviderType =
  | 'openai'
  | 'openai_codex'
  | 'anthropic'
  | 'minimax'
  | 'openrouter'
  | 'deepseek'
  | 'ollama'
  | 'zeroentropy'
  | 'cohere'
  | 'openai_compatible'

/** How a Provider is deployed, as declared by its owner; see the server's provider policy. */
export type ProviderDeployment = 'cloud' | 'trusted_local'

export interface ModelProviderOut {
  id: string
  space_id: string
  home_space_id?: string
  owner_user_id?: string | null
  grant_id?: string | null
  name: string
  provider_type: ProviderType | string
  base_url: string
  deployment: ProviderDeployment
  network_profile_id: string | null
  claude_compatible_base_url: string | null
  openai_compatible_base_url: string | null
  default_model: string | null
  available_models: string[]
  enabled: boolean
  is_default: boolean
  has_api_key: boolean
  has_subscription?: boolean
  subscription_type?: 'anthropic' | 'openai_codex' | null
  subscription_quota?: ManagedSubscriptionQuota | null
  manageable?: boolean
  grant_enabled?: boolean
  created_at: string
  updated_at: string
}

interface ModelProviderModelsOut {
  models: string[]
  source: 'configured' | 'live'
}

export type ProviderPresetMode = 'chat' | 'embedding' | 'rerank'

export interface ProviderPresetOut {
  id: string
  mode: ProviderPresetMode
  label: string
  description?: string | null
  name: string
  provider_type: ProviderType
  base_url: string
  claude_compatible_base_url?: string | null
  openai_compatible_base_url?: string | null
  default_model?: string | null
  available_models: string[]
  embedding_dimensions?: number | null
  embedding_dimension_options?: number[]
  api_key_required: boolean
  task?: string | null
}

interface ProviderFromPresetCreateRequest {
  preset_id: string
  api_key?: string | null
  name?: string
  network_profile_id?: string | null
  default_model?: string | null
  available_models?: string[]
  embedding_dimensions?: number
  is_default?: boolean
}

interface ProviderFromPresetCreateResponse {
  provider: ModelProviderOut
}

export interface ProviderTaskChainEntry {
  provider_id: string
  model?: string | null
}

export interface ProviderTaskPolicyOut {
  task: string
  chain: ProviderTaskChainEntry[]
  enabled: boolean
  updated_at: string
}

interface ProviderTaskPolicyPutRequest {
  chain: ProviderTaskChainEntry[]
  enabled?: boolean
}

/**
 * The server-owned vendor registry. The client reads these facts. Do not keep
 * a second copy.
 */
export interface ProviderVendorOut {
  id: ProviderType
  display_name: string
  protocol: string
  supports_chat: boolean
  supports_structured_output: boolean
  supports_embedding: boolean
  supports_rerank: boolean
  default_base_url: string | null
  api_key_required: boolean
  subscription_only: boolean
  self_hostable: boolean
}

interface TestConnectionOut {
  success: boolean
  message: string
  model?: string
}

export interface ManagedSubscriptionQuota {
  available: boolean
  session_pct: number | null
  session_resets: string | null
  week_pct: number | null
  week_resets: string | null
  checked_at: string | null
  error: string | null
}

export type ManagedSubscriptionType = 'anthropic' | 'openai_codex'

export type ManagedSubscriptionLoginEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'prompt'; promptType: string; message: string; placeholder?: string }
  | { type: 'progress' | 'info'; message: string }
  | { type: 'connected'; provider: ModelProviderOut }
  | { type: 'error'; message: string }

export const providersApi = {
  planUsageProviders: () => get<{ items: ApiPlanUsageProvider[] }>('/providers/plan-usage'),
  refreshPlanUsage: (id: string, key?: string) => systemCommand<ApiPlanUsageSnapshot>('POST', `/providers/${encodeURIComponent(id)}/plan-usage`, {}, 'Plan usage refresh', key, 3 * 60 * 1000),
  /** Every Provider this person may see here, including the ones they own and disabled. For management. */
  list: () => get<ModelProviderOut[]>('/providers'),
  /** The Providers a run can use here: enabled, with an enabled grant. For pickers. */
  usable: () => get<ModelProviderOut[]>('/providers')
    .then(rows => rows.filter(row => row.enabled && row.grant_enabled !== false)),

  presets: () => get<ProviderPresetOut[]>('/providers/presets'),

  create: (data: {
    name: string
    provider_type: ProviderType | string
    api_key?: string
    default_model?: string
    available_models?: string[]
    base_url: string
    deployment?: ProviderDeployment
    network_profile_id?: string | null
    claude_compatible_base_url?: string
    openai_compatible_base_url?: string
    enabled?: boolean
    is_default?: boolean
  }, key: string = crypto.randomUUID()) => operationAt<ModelProviderOut>('POST', '/providers', data, key),

  createFromPreset: (data: ProviderFromPresetCreateRequest, key: string = crypto.randomUUID()) =>
    operationAt<ProviderFromPresetCreateResponse>('POST', '/providers/from-preset', data, key),

  patch: (id: string, data: Partial<{
    name: string
    provider_type: ProviderType | string
    api_key: string
    /** null clears the default; undefined leaves it. */
    default_model: string | null
    available_models: string[]
    base_url: string
    deployment: ProviderDeployment
    network_profile_id: string | null
    claude_compatible_base_url: string | null
    openai_compatible_base_url: string | null
    enabled: boolean
    is_default: boolean
  }>, key: string = crypto.randomUUID()) => operationAt<ModelProviderOut>('PATCH', `/providers/${encodeURIComponent(id)}`, data, key),

  delete: async (id: string, key: string = crypto.randomUUID()): Promise<void> => { await operationAt('DELETE', `/providers/${encodeURIComponent(id)}`, undefined, key) },

  models: (id: string) => get<ModelProviderModelsOut>(`/providers/${id}/models`),

  /** A connection test spends one small completion; it runs after commit and is never resubmitted. */
  test: (id: string, key?: string) => systemCommand<TestConnectionOut>('POST', `/providers/${encodeURIComponent(id)}/test`, {}, 'Connection test', key, 3 * 60 * 1000),

  refreshSubscriptionQuota: (id: string, key?: string) =>
    systemCommand<ModelProviderOut>('POST', `/providers/${encodeURIComponent(id)}/subscription/quota`, {}, 'Subscription quota refresh', key, 3 * 60 * 1000),

  /** Where the Space draws the subscription warning and reserve lines. */
  subscriptionQuotaPolicy: () => get<SubscriptionQuotaPolicy>('/providers/subscription-quota-policy'),
  updateSubscriptionQuotaPolicy: (body: SubscriptionQuotaPolicyUpdate, key: string = crypto.randomUUID()) =>
    operationAt<SubscriptionQuotaPolicy>('PUT', '/providers/subscription-quota-policy', body, key),

  disconnectSubscription: (id: string, key: string = crypto.randomUUID()) =>
    operationAt<ModelProviderOut>('DELETE', `/providers/${encodeURIComponent(id)}/subscription`, undefined, key),

  sendSubscriptionLoginInput: (type: ManagedSubscriptionType, input: string) =>
    post<{ status: string }>(`/providers/subscriptions/login/input?type=${encodeURIComponent(type)}`, { input }),

  // The server ends the login session only when this response closes, and
  // allows one session per user and type: the caller aborts when it leaves,
  // as hostsApi.loginStream's callers do.
  async *subscriptionLoginStream(type: ManagedSubscriptionType, signal?: AbortSignal): AsyncGenerator<ManagedSubscriptionLoginEvent> {
    const url = `${BASE}/providers/subscriptions/login/stream?type=${encodeURIComponent(type)}`
    const headers: Record<string, string> = { ...accountHeaders() }
    headers['X-Rainver-Space-Id'] = _spaceId
    const startedIn = sessionEpoch()
    const response = await accountFetch(url, { headers, signal })
    if (!response.ok || !response.body) throw await streamRefusal(response, 'Subscription login stream failed', startedIn, signal)
    yield* readLoginEvents<ManagedSubscriptionLoginEvent>(response)
  },

  taskPolicies: () => get<ProviderTaskPolicyOut[]>('/providers/task-policies'),

  putTaskPolicy: (task: string, data: ProviderTaskPolicyPutRequest, key: string = crypto.randomUUID()) =>
    operationAt<ProviderTaskPolicyOut>('PUT', `/providers/task-policies/${encodeURIComponent(task)}`, data, key),

  deleteTaskPolicy: async (task: string, key: string = crypto.randomUUID()): Promise<void> => {
    await operationAt('DELETE', `/providers/task-policies/${encodeURIComponent(task)}`, undefined, key)
  },

  grant: (id: string, data: {
    space_id: string
    enabled?: boolean
    is_default?: boolean
    network_profile_id?: string | null
  }, key: string = crypto.randomUUID()) => operationAt<unknown>('PUT', `/providers/${encodeURIComponent(id)}/grants`, data, key),

  vendors: () => get<ProviderVendorOut[]>('/providers/vendors'),

}
