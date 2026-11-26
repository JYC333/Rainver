import {
  GmailConnectionDisconnectOutputSchema, GmailConnectionForgetOutputSchema, GmailConnectionListSchema, GmailConnectionSetAgentReadOutputSchema, GmailMonitorDeleteOutputSchema,
  GmailMonitorListSchema, GmailMonitorProposalPayloadSchema, GmailMonitorSetStatusOutputSchema, GmailOAuthStartOutputSchema,
  GmailShareOutputSchema, GmailSharePreviewOutputSchema, GmailDigestListSchema, GmailDigestSetStatusOutputSchema, GmailDigestEndOutputSchema,
  GmailSelectionRemoveOutputSchema, GmailThreadReadOutputSchema, GmailThreadSelectionListSchema, GmailApplicationExecutionOptionsOutputSchema,
  PLUGIN_DATA_ACCESS_OPERATION_SCHEMAS, GMAIL_OPERATION_SCHEMAS,
  type OperationInput, type GmailApplicationExecutionOptions, type GmailApplicationExecutionSelection, type GmailConnectionList, type GmailMonitorCriteria, type GmailMonitorList, type GmailThreadReadOutput, type GmailThreadSelection,
} from '@rainver/protocol'
import { apiTransport, queryOperation } from './operations'
import { ApiRequestError } from './transport'

/**
 * Typed consumer of the owner-only Gmail routes (`packages/protocol/src/gmail.ts`).
 * Every call names its Space explicitly and takes the caller's AbortSignal; every
 * reply is parsed by the protocol schema, which carries no token, code, secret
 * or Google subject. Nothing here caches or persists a reply: mail text lives
 * only in the calling component's state.
 */
export interface GmailCallOptions { spaceId: string; signal?: AbortSignal }
/** A conversation card's request scope: its source Space when known (else the active one) and its lifetime. */
export interface CardCallOptions { spaceId?: string; signal?: AbortSignal }

// Read at call time so a test can mock the client module wholesale.
const request = <T,>(...args: Parameters<typeof apiTransport.request>) => apiTransport.request<T>(...args)
const operationAt = <T,>(...args: Parameters<typeof apiTransport.operationAt>) => apiTransport.operationAt<T>(...args)
const at = (o: GmailCallOptions) => ({ spaceId: o.spaceId, signal: o.signal })
const seg = encodeURIComponent

/** A pending monitor draft an Agent wrote for this person; only they can accept or decline it. */
export interface GmailMonitorDraft { id: string; created_at: string; connection_id: string; purpose: string; criteria: GmailMonitorCriteria }
function draftItems(raw: unknown): { id: string; created_at: string; payload_json: unknown }[] {
  const items = (raw as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) throw new Error('Unexpected proposal list')
  return items.flatMap(item => {
    const row = item as { id?: unknown; created_at?: unknown; payload_json?: unknown }
    return typeof row.id === 'string' && typeof row.created_at === 'string' ? [{ id: row.id, created_at: row.created_at, payload_json: row.payload_json }] : []
  })
}

export const gmailApi = {
  connections: async (o: GmailCallOptions): Promise<GmailConnectionList> =>
    GmailConnectionListSchema.parse(await request('GET', '/sources/gmail/connections', undefined, at(o))),
  /** Returns Google's consent URL; the caller navigates only on the person's own click. */
  startOAuth: async (input: { reconnect_connection_id?: string }, o: GmailCallOptions) =>
    GmailOAuthStartOutputSchema.parse(await request('POST', '/sources/gmail/oauth/start', input, at(o))),
  disconnect: async (connectionId: string, key: string, o: GmailCallOptions) =>
    GmailConnectionDisconnectOutputSchema.parse(await operationAt('POST', `/sources/gmail/connections/${seg(connectionId)}/disconnect`, {}, key, at(o))),
  /** The owner's switch for Agent reads in their own private Project conversations (ADR 0032/0033); reads nothing itself. Off ends every Project consent. */
  setAgentRead: async (connectionId: string, enabled: boolean, key: string, o: GmailCallOptions) =>
    GmailConnectionSetAgentReadOutputSchema.parse(await operationAt('POST', '/actions/source.gmail.connection.set_agent_read', { connection_id: connectionId, enabled }, key, at(o))),
  /** Ends the owner's standing consent for one Project (ADR 0033); the next read there asks again. */
  revokeAgentReadGrant: async (grantId: string, key: string, o: GmailCallOptions) =>
    PLUGIN_DATA_ACCESS_OPERATION_SCHEMAS['plugin_data_grant.revoke'].output.parse(await operationAt('POST', '/actions/plugin_data_grant.revoke', { grant_id: grantId }, key, at(o))),
  /** Ends one member's read delegation now (ADR 0035 §4); a read of theirs in progress delivers nothing. */
  revokeDelegation: async (delegationId: string, key: string, o: GmailCallOptions) =>
    GMAIL_OPERATION_SCHEMAS['source.gmail.delegation.revoke'].output.parse(await operationAt('POST', '/actions/source.gmail.delegation.revoke', { delegation_id: delegationId }, key, at(o))),
  forget: async (connectionId: string, key: string, o: GmailCallOptions) =>
    GmailConnectionForgetOutputSchema.parse(await operationAt('DELETE', `/sources/gmail/connections/${seg(connectionId)}`, {}, key, at(o))),
  previewSummaryAudience: async (input: OperationInput<'source.gmail.summary.preview'>, o: GmailCallOptions) => {
    const outcome = await queryOperation('source.gmail.summary.preview', input, at(o))
    if (!('status' in outcome) || outcome.status !== 'succeeded') throw new Error('Could not load audience')
    return GmailSharePreviewOutputSchema.parse(outcome.data)
  },
  shareSummary: async (input: OperationInput<'source.gmail.summary.share'>, key: string, o: GmailCallOptions) =>
    GmailShareOutputSchema.parse(await operationAt('POST', '/actions/source.gmail.summary.share', input, key, at(o))),
  /**
   * ADR 0036: on the owner's own pending application-update card, the scope it covers and which Agents and models can
   * run it in the background (each unavailable one with its reason). Reads no mail.
   */
  /** `cursor`: the `next_cursor` of the page shown before (the first page when omitted). */
  /** One page of the card's configurations (`cursor`), or more models of one configuration (`models_of`). */
  applicationExecutionOptions: async (proposalId: string, o: CardCallOptions, page?: string | { agent_id: string; runtime_profile_id: string; models_cursor: string }): Promise<GmailApplicationExecutionOptions> => {
    const more = typeof page === 'string' ? { cursor: page } : page ? { models_of: page } : {}
    const outcome = await queryOperation('source.gmail.application_updates.execution_options', { proposal_id: proposalId, ...more }, o)
    if (!('status' in outcome) || outcome.status !== 'succeeded') throw new Error('Could not load the Agent and model choices')
    return GmailApplicationExecutionOptionsOutputSchema.parse(outcome.data)
  },
  /** The owner's choice on their pending card; the server rechecks it and redraws the card. Nothing runs until they accept. */
  selectApplicationExecution: async (proposalId: string, selection: GmailApplicationExecutionSelection, key: string, o: CardCallOptions): Promise<GmailApplicationExecutionOptions> =>
    GmailApplicationExecutionOptionsOutputSchema.parse(await operationAt('POST', '/actions/source.gmail.application_updates.select_execution', { proposal_id: proposalId, ...selection }, key, o)),
  digests: async (o: GmailCallOptions & { reviewProjectId?: string }) => {
    const query = o.reviewProjectId ? `?application_review_project_id=${seg(o.reviewProjectId)}` : ''
    return GmailDigestListSchema.parse(await request('GET', `/sources/gmail/digests${query}`, undefined, at(o))).digests
  },
  setDigestStatus: async (id: string, status: 'active' | 'paused', key: string, o: GmailCallOptions) =>
    GmailDigestSetStatusOutputSchema.parse(await operationAt('POST', `/sources/gmail/digests/${seg(id)}/status`, { status }, key, at(o))),
  setDigestTime: async (id: string, localTime: string, key: string, o: GmailCallOptions) =>
    GmailDigestSetStatusOutputSchema.parse(await operationAt('POST', '/actions/source.gmail.digest.set_time', { digest_id: id, local_time: localTime }, key, at(o))),
  endDigest: async (id: string, key: string, o: GmailCallOptions) =>
    GmailDigestEndOutputSchema.parse(await operationAt('POST', `/sources/gmail/digests/${seg(id)}/end`, {}, key, at(o))),
  selections: async (filter: { project_id?: string; connection_id?: string }, o: GmailCallOptions): Promise<GmailThreadSelection[]> => {
    const q = new URLSearchParams()
    if (filter.project_id) q.set('project_id', filter.project_id)
    if (filter.connection_id) q.set('connection_id', filter.connection_id)
    const suffix = q.toString() ? `?${q}` : ''
    return GmailThreadSelectionListSchema.parse(await request('GET', `/sources/gmail/selections${suffix}`, undefined, at(o))).selections
  },
  removeSelection: async (selectionId: string, key: string, o: GmailCallOptions) =>
    GmailSelectionRemoveOutputSchema.parse(await operationAt('DELETE', `/sources/gmail/selections/${seg(selectionId)}`, {}, key, at(o))),
  read: async (selectionId: string, cursor: string | null, o: GmailCallOptions): Promise<GmailThreadReadOutput> =>
    GmailThreadReadOutputSchema.parse(await request('POST', `/sources/gmail/selections/${seg(selectionId)}/read`, cursor ? { cursor } : {}, at(o))),
  /** The person's monitors, content-free sync status and recent match links (ids only, never subject or text). */
  monitors: async (o: GmailCallOptions): Promise<GmailMonitorList> =>
    GmailMonitorListSchema.parse(await request('GET', '/sources/gmail/monitors', undefined, at(o))),
  setMonitorStatus: async (monitorId: string, status: 'active' | 'paused', key: string, o: GmailCallOptions) =>
    GmailMonitorSetStatusOutputSchema.parse(await operationAt('POST', `/sources/gmail/monitors/${seg(monitorId)}/status`, { status }, key, at(o))),
  deleteMonitor: async (monitorId: string, key: string, o: GmailCallOptions) =>
    GmailMonitorDeleteOutputSchema.parse(await operationAt('DELETE', `/sources/gmail/monitors/${seg(monitorId)}`, {}, key, at(o))),
  /** Pending monitor drafts: the server lists only proposals this person may read, and these are private to them. */
  monitorDrafts: async (o: GmailCallOptions): Promise<GmailMonitorDraft[]> => {
    return draftItems(await request('GET', '/proposals?status=pending&type=gmail_monitor_create&limit=50', undefined, at(o))).flatMap(item => {
      const payload = GmailMonitorProposalPayloadSchema.safeParse(item.payload_json)
      return payload.success ? [{ id: item.id, created_at: item.created_at, connection_id: payload.data.connection_id, purpose: payload.data.purpose, criteria: payload.data.criteria }] : []
    })
  },
  /** The ordinary proposal decision: the same accept/decline as everywhere else, with its idempotency key. */
  decideMonitorDraft: async (proposalId: string, decision: 'accept' | 'reject', key: string, o: GmailCallOptions) => {
    await operationAt('POST', `/proposals/${seg(proposalId)}/${decision}`, decision === 'accept' ? { confirm_incomplete_patch: false } : {}, key, at(o))
  },
}

/**
 * What the person can do about a refused Gmail call. The clearing set below
 * (401/403/404 and the owner's own withdrawal) removes content already shown.
 */
export type GmailFailure =
  | 'gone' | 'signed_out' | 'reauth' | 'inactive' | 'changed' | 'cursor' | 'rate_limited' | 'deadline' | 'busy'
  | 'not_configured' | 'unavailable' | 'cancelled'
  /** Client-side only: the server's consent URL is not Google's OAuth page, so no link is shown. */
  | 'consent_invalid'

export function gmailFailure(error: unknown): GmailFailure {
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
  if (!(error instanceof ApiRequestError)) return 'unavailable'
  const metadata = (error.payload?.error as { metadata?: { code?: unknown } } | undefined)?.metadata
  const code = typeof metadata?.code === 'string' ? metadata.code : error.code
  switch (code) {
    case 'gmail_reauth_required': return 'reauth'
    case 'gmail_connection_inactive': return 'inactive'
    case 'gmail_connection_changed': case 'gmail_selection_changed': return 'changed'
    case 'gmail_cursor_invalid': case 'gmail_cursor_expired': return 'cursor'
    case 'gmail_quota_exhausted': case 'gmail_rate_limited': return 'rate_limited'
    case 'gmail_upstream_timeout': return 'deadline'
    case 'gmail_authority_busy': case 'gmail_audit_unavailable': return 'busy'
    case 'gmail_not_configured': return 'not_configured'
    case 'gmail_cancelled': return 'cancelled'
  }
  if (error.status === 401) return 'signed_out'
  if (error.status === 403 || error.status === 404) return 'gone'
  if (error.status === 429) return 'rate_limited'
  if (error.status === 504) return 'deadline'
  return 'unavailable'
}

/** Failures after which content from the refused scope must not stay on screen. */
export const GMAIL_CLEARING_FAILURES: ReadonlySet<GmailFailure> = new Set<GmailFailure>(['gone', 'signed_out', 'reauth', 'inactive', 'changed'])

const GMAIL_CONSENT_HOST = 'accounts.google.com'
const GMAIL_CONSENT_ORIGIN = `https://${GMAIL_CONSENT_HOST}`
const GMAIL_CONSENT_PATH = '/o/oauth2/v2/auth'

/**
 * The only consent page a "Continue to Google" link may point to: Google's
 * OAuth endpoint on its exact origin and path, over HTTPS, without embedded
 * credentials. Anything else — another host or path, plain HTTP, any written
 * port (even `:443`), `user:pass@` — is refused here even if the server returned it, so no link
 * is rendered. Returns the normalized URL or `null`.
 */
export function gmailConsentUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  // URL parsing normalizes `:443`, `:0443`, case and the like away, so the
  // authority is checked as written first: exactly Google's host, with no
  // port and no userinfo.
  if (!raw.startsWith('https://')) return null
  const authorityEnd = raw.slice(8).search(/[/?#\\]/)
  if (authorityEnd < 0 || raw.slice(8, 8 + authorityEnd) !== GMAIL_CONSENT_HOST) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:' || url.origin !== GMAIL_CONSENT_ORIGIN || url.pathname !== GMAIL_CONSENT_PATH) return null
  if (url.username || url.password) return null
  return url.href
}
