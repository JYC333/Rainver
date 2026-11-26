import { mergeAbortSignals } from '../lib/mergeAbortSignals'
import { sessionEpoch } from '../lib/sessionResidue'
import type { ApiError } from '../types/api'

/** `limit`/`offset`/`q` as a query string, omitting what was not given. */
export function pageQuery(params: Record<string, string | number | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    query.set(key, String(value))
  }
  return query
}

export const BASE = '/api/v1'

export let _spaceId = 'personal'

export function setSpaceContext(spaceId: string): void {
  _spaceId = spaceId
}

/**
 * The browser account this tab was loaded for (`/me`'s `account_handle`).
 * Every control-plane request carries it; after another tab switches
 * account the server refuses the request (409 `account_switched`) instead of
 * running it as the newly selected person.
 *
 * It is kept, never cleared, until the page is gone: a tab told of a switch
 * still sends it while it unloads (a `keepalive` write on `pagehide`), and
 * after an unload the person cancelled. A request without it would run as
 * whoever the browser is now. Once the browser has signed out it becomes
 * `SIGNED_OUT_ACCOUNT_HANDLE`, the server's own handle for a browser with no
 * account: the tab can sign in again, and is still refused if another tab
 * signs in first.
 */
let accountHandle: string | null = null
/** The handle of a browser that holds no selected account (the server's `-`). */
export const SIGNED_OUT_ACCOUNT_HANDLE = '-'
export const ACCOUNT_SWITCHED_EVENT = 'auth:account-switched'
/** Marks the server's refusal of a stale tab, also on a stream whose body is never read. */
export const ACCOUNT_SWITCHED_HEADER = 'x-rainver-account-switched'
/** Set from `/me`, or from the server's answer to this tab's own rotation of its session (a password change). */
export function setAccountHandle(handle: string | null): void { accountHandle = handle }
export function currentAccountHandle(): string | null { return accountHandle }
export function accountHeaders(): Record<string, string> {
  return accountHandle ? { 'X-Rainver-Account': accountHandle } : {}
}
function signalAccountSwitched(): void {
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT))
}
/**
 * A response that refused this tab as one of another account. Every path
 * that reads a response itself (a stream, an upload, a download) reports it
 * here, as `request` does, so the tab reloads instead of only failing.
 */
export function noteAccountSwitched(status: number, switchedHeader: string | null, startedIn: number, signal?: AbortSignal): void {
  if (status === 409 && switchedHeader && !signal?.aborted && sessionEpoch() === startedIn) signalAccountSwitched()
}

/**
 * Ends with this tab's account: once the browser is someone else, every
 * stream opened through `accountFetch` is aborted, and any opened later is
 * refused here without reaching the server.
 */
let accountStreams = new AbortController()
export function endAccountStreams(): void { accountStreams.abort() }
/** Exported for tests: a fresh page's streams. */
export function __resetAccountStreamsForTests(): void { accountStreams = new AbortController() }
/** `fetch` for a control-plane stream or download, closed with this tab's account (`endAccountStreams`). */
export function accountFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (accountStreams.signal.aborted) return Promise.reject(new ApiRequestError('This browser switched to another account; reload the page', 409, 'account_switched'))
  return fetch(url, { ...init, signal: mergeAbortSignals(init.signal ?? undefined, accountStreams.signal) })
}

export function formatApiErrorMessage(err: ApiError, fallback: string): string {
  const requestId = typeof err.request_id === 'string' && err.request_id.trim()
    ? ` (request id: ${err.request_id})`
    : ''
  const withRequestId = (message: string) => `${message}${requestId}`
  if (typeof err.detail === 'string') return withRequestId(err.detail)
  if (err.detail && typeof err.detail === 'object') return withRequestId(JSON.stringify(err.detail))
  const m = err.message
  if (typeof m === 'string') return withRequestId(m)
  if (m && typeof m === 'object') {
    const rec = m as Record<string, unknown>
    const code = rec.code
    if (typeof code === 'string') return withRequestId(code)
    return withRequestId(JSON.stringify(m))
  }
  return withRequestId(fallback)
}

export interface RequestOptions {
  includeSpaceContext?: boolean
  spaceId?: string
  idempotencyKey?: string
  signal?: AbortSignal
  /** Lets a small write finish while the page is being left (the Reader's last position). */
  keepalive?: boolean
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The server's machine-readable `code`, when it sent one. Present exactly
     * where the client is expected to *do* something specific rather than
     * surface the message — matching on prose is how error handling rots.
     */
    readonly code?: string,
    readonly payload?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

/**
 * A refused operation's structured details (`error.metadata`), if it sent
 * any. Structural rather than `instanceof`, so a test double of the error
 * class reads the same way.
 */
export function refusalMetadata(error: unknown): Record<string, unknown> | undefined {
  const payload = error instanceof Error ? (error as { payload?: { error?: { metadata?: unknown } } }).payload : undefined
  const metadata = payload?.error?.metadata
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : undefined
}

/** The domain code of a refused operation (`error.metadata.code`), else its operation code. */
export function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const domain = refusalMetadata(error)?.code
  const code = (error as { code?: unknown }).code
  return typeof domain === 'string' ? domain : typeof code === 'string' ? code : undefined
}

/**
 * This browser's session ended: the one `auth:required` every control-plane
 * 401 raises (AuthContext clears residue and tells the other tabs).
 *
 * `startedIn` is the session epoch the request began in. A 401 for a request
 * begun before an already-handled sign-out says nothing new — and after a
 * re-login it would sign the next person out — so it raises nothing. This is
 * also what keeps several streams refused together from raising one sign-out
 * each.
 */
export function signalAuthRequired(startedIn: number): void {
  if (sessionEpoch() !== startedIn) return
  window.dispatchEvent(new CustomEvent('auth:required'))
}

/**
 * A control-plane response that did not open (a stream, or a blob read
 * whole). Its body is cancelled
 * first so a refused stream does not hold the connection; a 401 is the
 * session ending (unless the caller already left), anything else that
 * endpoint's own refusal. Errors inside an opened stream are the stream's
 * business events and are never treated as a sign-out here.
 */
export async function streamRefusal(response: Response, message: string, startedIn: number, signal?: AbortSignal): Promise<ApiRequestError> {
  await response.body?.cancel().catch(() => {})
  if (response.status === 401 && !signal?.aborted) signalAuthRequired(startedIn)
  noteAccountSwitched(response.status, response.headers.get(ACCOUNT_SWITCHED_HEADER), startedIn, signal)
  return new ApiRequestError(`${message} (${response.status})`, response.status, response.status === 409 && response.headers.get(ACCOUNT_SWITCHED_HEADER) ? 'account_switched' : undefined)
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const startedIn = sessionEpoch()
  // FormData (file/voice upload) must keep the browser-set multipart boundary, so
  // we do not force a Content-Type for it and pass the body through unserialized.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const headers: Record<string, string> = { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...accountHeaders() }
  if (options.includeSpaceContext ?? true) headers['X-Rainver-Space-Id'] = options.spaceId ?? _spaceId
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  const url = BASE + path

  const opts: RequestInit = { method, headers }
  if (options.signal) opts.signal = options.signal
  if (options.keepalive) opts.keepalive = true
  if (body !== undefined) opts.body = isForm ? (body as FormData) : JSON.stringify(body)

  const r = await fetch(url, opts)

  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    let code: string | undefined
    let payload: Record<string, unknown> | undefined
    let requestId = r.headers.get('x-request-id')?.trim() || undefined
    const text = await r.text().catch(() => '')
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const err = parsed as ApiError & { code?: unknown }
          payload = parsed as Record<string, unknown>
          const operationError = payload.error as { code?: unknown; message?: unknown; request_id?: unknown } | undefined
          const nestedId = operationError?.request_id
          const bodyId = err.request_id
          if (typeof nestedId === 'string' && nestedId.trim()) requestId = nestedId.trim()
          else if (typeof bodyId === 'string' && bodyId.trim()) requestId = bodyId.trim()
          code = typeof operationError?.code === 'string' ? operationError.code : undefined
          if (code === undefined && typeof err.code === 'string') code = err.code
          msg = typeof operationError?.message === 'string'
            ? operationError.message
            : formatApiErrorMessage({ ...err, request_id: undefined }, msg)
        }
      } catch {
        if (!r.headers.get('content-type')?.toLowerCase().includes('text/html')) msg = text
      }
    }
    if (requestId) msg += ` (request id: ${requestId})`
    // A failed credential check does not revoke an existing browser session.
    const passwordRefused = path === '/auth/sign-in/email' && code === 'invalid_credentials'
    if (r.status === 401 && code !== 'operation_unavailable' && !passwordRefused && !options.signal?.aborted) {
      signalAuthRequired(startedIn)
    }
    if (r.status === 409 && code === 'account_switched' && sessionEpoch() === startedIn) signalAccountSwitched()
    throw new ApiRequestError(msg, r.status, code, payload, requestId)
  }

  if (r.status === 204) return null as T
  return r.json() as Promise<T>
}

export const get   = <T>(path: string, options?: RequestOptions)                => request<T>('GET',    path, undefined, options)

export const post  = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST',   path, body, options)

export const del   = <T>(path: string, options?: RequestOptions)                => request<T>('DELETE', path, undefined, options)
