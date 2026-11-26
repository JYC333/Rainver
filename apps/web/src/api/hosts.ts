import { readLoginEvents } from './streams'
import { sessionEpoch } from '../lib/sessionResidue'
import type {
  AmbientImportPolicy,
  AmbientSessionCount,
  AmbientSyncReport,
  ExtractionOutcome,
  Host,
  HostExecutionTargetsResponse,
  HostPairingCode,
  HostRuntimeChange,
  HostRuntimeDefinitionOption,
  HostRuntimeProvisioningStatus,
  HostRuntimeUsage,
  ImportedSession,
  ImportedSessionRecord,
  NetworkProfileCreateBody,
  NetworkProfileOut,
  NetworkProfileUpdateBody,
} from '../types/api'
import { hostCommand, hostPath, waitForJobResult } from './jobReads'
import { commandReceipt, operationAt } from './operations'
import type { RequestOptions } from './transport'
import { _spaceId, ACCOUNT_SWITCHED_HEADER, accountFetch, accountHeaders, ApiRequestError, BASE, get, post, streamRefusal } from './transport'



/**
 * Ambient CLI history a paired host holds for a folder, and the consent that
 * governs importing it. Consent hangs off the Location because it is about
 * one folder on one machine; the sessions themselves belong to the Project.
 */
export const ambientSessionsApi = {
  offer: (locationId: string) =>
    get<{ policy: AmbientImportPolicy; counts: AmbientSessionCount[]; attention: import('@rainver/protocol').AmbientImportAttention }>(
      `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/offer`,
    ),
  setPolicy: async (locationId: string, body: { runtime_key: string; installation?: string; sync: boolean; default_visibility?: 'private' | 'space_shared'; auto_extract?: boolean }, key: string = crypto.randomUUID()): Promise<AmbientImportPolicy> =>
    (await operationAt<{ policy: AmbientImportPolicy }>('PUT', `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/policy`, body, key)).policy,
  setReminder: async (locationId: string, mode: 'later' | 'never' | 'enable', key: string = crypto.randomUUID()): Promise<AmbientImportPolicy> =>
    (await operationAt<{ policy: AmbientImportPolicy }>('POST', `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/reminder`, { mode }, key)).policy,
  list: (locationId: string) =>
    get<{ sessions: ImportedSession[] }>(`/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions`),
  /** Everything in the Project this viewer may read, gated by the content predicate rather than host ownership. */
  listForProject: (projectId: string) =>
    get<{ sessions: ImportedSession[] }>(`/projects/${encodeURIComponent(projectId)}/imported-sessions`),
  /**
   * A durable Host command: imports on the Host after commit; the report is released by its status read.
   * An import that ended in an error still answers its real report (its `error` set, and what it
   * committed counted), so what was written is never shown as not having happened.
   */
  sync: async (locationId: string, body: { runtime_key: string; installation?: string; session_ids?: string[] | null; visibility?: 'private' | 'space_shared' }, key?: string): Promise<AmbientSyncReport> => {
    try {
      return await hostCommand<AmbientSyncReport>('POST', `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/sync`, body, 'History import', key)
    } catch (error) {
      const report = error instanceof ApiRequestError
        ? ((error.payload?.error as { metadata?: { result?: unknown } } | undefined)?.metadata?.result as AmbientSyncReport | null | undefined)
        : null
      if (report && typeof report.error === 'string') return report
      throw error
    }
  },
  records: (sessionId: string) =>
    get<{ session: ImportedSession; records: ImportedSessionRecord[]; truncated: boolean }>(`/imported-sessions/${encodeURIComponent(sessionId)}`),
  setVisibility: async (sessionId: string, visibility: 'private' | 'space_shared', key: string = crypto.randomUUID()): Promise<ImportedSession> =>
    (await operationAt<{ session: ImportedSession }>('PATCH', `/imported-sessions/${encodeURIComponent(sessionId)}`, { visibility }, key)).session,
  remove: async (sessionIds: string[], key: string = crypto.randomUUID()): Promise<{ deleted: number }> =>
    ({ deleted: (await operationAt<{ deleted: number }>('POST', '/imported-sessions/delete', { session_ids: sessionIds }, key)).deleted }),
  /** What an extraction would read right now — the count behind the "Extract to Brief" button. */
  pendingExtraction: (projectId: string) =>
    get<{ records: number; sessions: number }>(`/projects/${encodeURIComponent(projectId)}/imported-sessions/extraction`),
  /** Claims one batch with an explicit key, then reads its Job until it settles; never resubmits. */
  extract: async (projectId: string, key:string=crypto.randomUUID()):Promise<ExtractionOutcome> => {
    const receipt=await commandReceipt('project.imported_sessions.extract',{project_id:projectId},key)
    if(!receipt.job_id)return {brief_proposal_id:null,memory_packet_proposal_id:null,records_covered:0,sessions_covered:0,decisions:0,facts:0,records_remaining:0}
    return waitForJobResult<ExtractionOutcome>({job_id:receipt.job_id,space_id:receipt.space_id},'History extraction')
  },
}

// ADR 0016: multi-host control center — pairing, dispatch, and the
// work-stream read side (task threads). See .agent/modules/hosts.md.
export const hostsApi = {
  subscriptionUsage: () => get<{ items: import('@rainver/protocol').SubscriptionQuotaPool[] }>('/hosts/subscription-usage'),
  toolOperations: (hostId: string) =>
    get<{ items: Array<{ runtime_key: string; action: string }> }>(`/hosts/${encodeURIComponent(hostId)}/tool-operations`),
  list: (options: RequestOptions = {}) => get<{ items: Host[] }>('/hosts', options),
  executionTargets: (projectId?: string | null) =>
    get<HostExecutionTargetsResponse>(`/hosts/execution-targets${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  pairingCode: (name: string) => post<HostPairingCode>('/hosts/pairing-codes', { name }),
  revoke: async (hostId: string, key: string = crypto.randomUUID()): Promise<null> => {
    await operationAt<{ revoked: true }>('POST', `${hostPath(hostId)}/revoke`, {}, key)
    return null
  },
  listRuntimeDefinitions: () => get<{ items: HostRuntimeDefinitionOption[] }>('/hosts/runtime-definitions'),
  /** Pinned Server OpenCode provisioning and ACP health state. */
  serverRuntimeProvisioning: (hostId: string) =>
    get<HostRuntimeProvisioningStatus>(`/hosts/${encodeURIComponent(hostId)}/runtime-provisioning/opencode`),
  /** Requeues a failed Server OpenCode install/health check; admins only. */
  retryServerRuntimeProvisioning: async (hostId: string, key: string = crypto.randomUUID()) => {
    const { space_id: _space, ...state } = await operationAt<{ host_id: string; space_id: string; runtime_key: 'opencode'; state: 'queued' | 'installing'; desired_version: string }>(
      'POST', `${hostPath(hostId)}/runtime-provisioning/opencode/retry`, {}, key)
    return state
  },
  /** One level of subdirectory names on an owned host — the daemon answers; lazy and bounded. */
  browseDirectories: (hostId: string, path?: string | null) =>
    post<{ path: string | null; parent: string | null; dirs: string[]; truncated: boolean }>(
      `/hosts/${encodeURIComponent(hostId)}/browse-directories`, { path: path ?? null }),
  /** Registers a directory on an owned host as a Project Location, exactly as the CLI's `workspace add` would. */
  registerWorkspace: (hostId: string, body: { path: string; project_id: string; name: string }, key?: string) =>
    hostCommand<{ workspace_id: string | null; display_path: string | null }>('POST', `${hostPath(hostId)}/workspaces`, body, 'Location registration', key),
  /** Asks the host's daemon to install a managed copy of a runtime (any ACP adapter with a distribution). */
  installRuntime: (hostId: string, runtimeKey: string, expectedVersion?: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}`, expectedVersion ? { expected_version: expectedVersion } : {}, 'Installation', key),
  updateManagedRuntime: (hostId: string, runtimeKey: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/managed/update`, {}, 'CLI update', key),
  updateOwnRuntime: (hostId: string, runtimeKey: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/own/update`, {}, 'Own CLI update', key),
  uninstallRuntime: (hostId: string, runtimeKey: string, installation: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('DELETE', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}`, undefined, 'Removal', key),
  /** Undoes the last upgrade of a managed copy, promoting the version the host kept behind it. */
  rollbackRuntime: (hostId: string, runtimeKey: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/rollback`, {}, 'Rollback', key),
  /** What has changed about every host's runtimes, newest first. */
  runtimeChanges: () => get<{ items: HostRuntimeChange[] }>('/hosts/runtime-changes'),
  /** The cached subscription quota for each copy on a host; a read, never a probe. */
  usage: (hostId: string) => get<{ items: HostRuntimeUsage[] }>(`/hosts/${encodeURIComponent(hostId)}/usage`),
  /** Asks one copy now, on the host that holds its login. */
  refreshUsage: (hostId: string, runtimeKey: string, installation: string, key?: string, options?: RequestOptions) =>
    hostCommand<HostRuntimeUsage>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/usage`, {}, 'Quota check', key, options),
  /**
   * The login terminal for one copy of a runtime on a host: the daemon runs
   * the copy's login command on a PTY and this relays it, frame by frame,
   * until the command exits. Type through `loginInput`.
   */
  /**
   * The login event stream. Pass a signal and abort it when the panel goes
   * away: closing the response is what tells the server to end the daemon's
   * login session, so an abandoned panel does not leave a login program
   * waiting on the host.
   */
  async *loginStream(hostId: string, runtimeKey: string, installation: string, target?: HostLoginTarget | null, signal?: AbortSignal): AsyncGenerator<RuntimeLoginEvent> {
    const query = target?.kind === 'acp'
      ? `?auth_method_id=${encodeURIComponent(target.methodId)}`
      : target?.kind === 'cli' ? '?login_action=cli'
      : target?.kind === 'logout' ? '?login_action=logout' : ''
    const url = `${BASE}/hosts/${encodeURIComponent(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/login/stream${query}`
    const headers: Record<string, string> = { ...accountHeaders() }
    headers['X-Rainver-Space-Id'] = _spaceId
    const startedIn = sessionEpoch()
    const response = await accountFetch(url, { headers, signal })
    if (!response.ok || !response.body) throw await streamRefusal(response, 'Login stream failed', startedIn, signal)
    yield* readLoginEvents<RuntimeLoginEvent>(response)
  },
  /** Delivers the `http://127.0.0.1:…` address a browser on another device landed on to the login on the host. */
  loginCallback: (hostId: string, runtimeKey: string, installation: string, url: string) =>
    post<null>(`/hosts/${encodeURIComponent(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/login/callback`, { url }),
  loginInput: (hostId: string, runtimeKey: string, installation: string, data: string) =>
    post<null>(`/hosts/${encodeURIComponent(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/login/input`, { data }),
  /** Empty string clears the override and returns this host to the derived address. */
  setProviderProxyUrl: async (hostId: string, baseUrl: string, key: string = crypto.randomUUID()) => {
    const out = await operationAt<{ host_id: string; space_id: string; provider_proxy_base_url: string | null }>(
      'PUT', `${hostPath(hostId)}/provider-proxy-url`, { base_url: baseUrl.trim() ? baseUrl : null }, key)
    return { host_id: out.host_id, provider_proxy_base_url: out.provider_proxy_base_url }
  },
}

/** What the account session stream sends to the person who opened it. */
export type OrdinaryAccountStreamEvent =
  | { type: 'authorization'; url: string; user_code: string | null; expires_in: number | null }
  | { type: 'exit'; outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out'; error: string | null; status: import('@rainver/protocol').OrdinaryAccountStatus | null }

/**
 * Ordinary CLI tools on a Host and the signed-in person's own account for one
 * of them (`.agent/modules/hosts.md`). The server decides every permission;
 * the account is always the caller's, so nothing here names a user.
 */
export const ordinaryToolsApi = {
  list: (hostId: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').HostOrdinaryToolsResponse>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools`, options),
  install: (hostId: string, toolId: string, key?: string) =>
    hostCommand<unknown>('POST', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/install`, {}, 'Tool installation', key),
  register: (hostId: string, toolId: string, path: string | null, key?: string) =>
    hostCommand<unknown>('POST', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/register`, path ? { path } : {}, 'Tool registration', key),
  remove: (hostId: string, toolId: string, source: 'managed' | 'registered', key?: string) =>
    hostCommand<unknown>('DELETE', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}?source=${source}`, undefined, 'Tool removal', key),
  account: (hostId: string, toolId: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').HostOrdinaryAccountResponse>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account`, options),
  verify: (hostId: string, toolId: string) =>
    post<import('@rainver/protocol').HostOrdinaryAccountResponse>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/verify`),
  /** A durable Host command for the caller's own account; the account is then read back from the Host. */
  logout: async (hostId: string, toolId: string, key?: string): Promise<import('@rainver/protocol').HostOrdinaryAccountResponse & { logout?: { local_cleared: boolean; remote_revocation: 'attempted_unconfirmed' | 'not_applicable' } }> => {
    const done = await hostCommand<{ logout?: { local_cleared: boolean; remote_revocation: 'attempted_unconfirmed' | 'not_applicable' } }>('POST', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/logout`, {}, 'Logout', key)
    const account = await get<import('@rainver/protocol').HostOrdinaryAccountResponse>(`${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account`)
    return { ...account, ...(done?.logout ? { logout: done.logout } : {}) }
  },
  cancelSession: (hostId: string, toolId: string) =>
    post<{ cancelled: boolean }>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/session/cancel`),
  /**
   * The official setup (`init`) or personal login (`login`) for the caller's
   * own account, as server-sent events. Aborting the signal closes the
   * stream, which cancels the session on the Host.
   */
  async *sessionStream(hostId: string, toolId: string, flow: 'init' | 'login', signal?: AbortSignal): AsyncGenerator<OrdinaryAccountStreamEvent> {
    const url = `${BASE}/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/session/stream?flow=${flow}`
    const headers: Record<string, string> = { ...accountHeaders() }
    headers['X-Rainver-Space-Id'] = _spaceId
    const startedIn = sessionEpoch()
    const response = await accountFetch(url, { headers, signal })
    if (response.status === 401 || (response.status === 409 && response.headers.get(ACCOUNT_SWITCHED_HEADER))) throw await streamRefusal(response, 'Account session stream failed', startedIn, signal)
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json() as { detail?: unknown; reason?: unknown }
        if (typeof body.detail === 'string') detail = body.detail
        else if (typeof body.reason === 'string') detail = body.reason
      } catch { /* keep the status line */ }
      throw new ApiRequestError(detail, response.status)
    }
    if (!response.body) throw new Error('No response body')
    yield* readLoginEvents<OrdinaryAccountStreamEvent>(response)
  },
}

// ── ACP registry agents ───────────────────────────────────────────────────
export type AcpDistribution =
  | { kind: 'npx' | 'uvx'; package: string; args: string[]; env: Record<string, string> }
  | { kind: 'binary'; platforms: Record<string, { archive: string; cmd: string; args: string[]; sha256: string | null; env: Record<string, string> }> }

export interface AcpRegistryEntry {
  id: string
  name: string
  version: string
  description: string | null
  repository: string | null
  license: string | null
  icon: string | null
  distribution: AcpDistribution
}

/** An enabled registry agent, with the adapter type the server derived for it. */
export interface AcpAgentOut extends AcpRegistryEntry {
  enabled_at: string
  enabled_by_user_id: string | null
  runtime_key: string
  /** Hosts that still carry a managed copy; disabling is refused while any do. */
  installed_on: Array<{ host_id: string; name: string }>
}

export const acpAgentsApi = {
  registry: () => get<{ items: AcpRegistryEntry[] }>('/acp-agents/registry'),
  list: () => get<{ items: AcpAgentOut[] }>('/acp-agents'),
  enable: (registryId: string, key: string = crypto.randomUUID()) => operationAt<AcpAgentOut>('PUT', `/acp-agents/${encodeURIComponent(registryId)}`, {}, key),
  disable: async (registryId: string, key: string = crypto.randomUUID()): Promise<null> => {
    await operationAt('DELETE', `/acp-agents/${encodeURIComponent(registryId)}`, undefined, key)
    return null
  },
}

/** One frame of a runtime copy's login terminal. */
export type RuntimeLoginEvent =
  | { type: 'output'; data: string }
  | { type: 'hint'; text: string }
  /** The login waits for an OAuth redirect to a loopback port of the host; a browser elsewhere cannot reach it. */
  | { type: 'callback_wanted'; port: number; authorize_url: string }
  | { type: 'exit'; exit_code: number; logged_in: boolean | null }
  | { type: 'error'; message: string }

export type HostLoginTarget =
  | { kind: 'acp'; methodId: string }
  | { kind: 'cli' }
  | { kind: 'logout' }

/** The daemon's report for one install/uninstall of a managed runtime copy. */
interface RuntimeInstallResult {
  from_version?: string | null
  to_version?: string | null
  host_id: string
  runtime_key: string
  ok: boolean
  error: string | null
  installation: string | null
}

export const networkProfilesApi = {
  list: () => get<NetworkProfileOut[]>('/network-profiles'),
  get: (id: string) => get<NetworkProfileOut>(`/network-profiles/${encodeURIComponent(id)}`),
  create: (body: NetworkProfileCreateBody, key: string = crypto.randomUUID()) => operationAt<NetworkProfileOut>('POST', '/network-profiles', body, key),
  patch: (id: string, body: NetworkProfileUpdateBody, key: string = crypto.randomUUID()) =>
    operationAt<NetworkProfileOut>('PATCH', `/network-profiles/${encodeURIComponent(id)}`, body, key),
  delete: async (id: string, key: string = crypto.randomUUID()): Promise<void> => {
    await operationAt('DELETE', `/network-profiles/${encodeURIComponent(id)}`, undefined, key)
  },
}
