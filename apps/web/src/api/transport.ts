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
  return new ApiRequestError(`${message} (${response.status})`, response.status)
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const startedIn = sessionEpoch()
  // FormData (file/voice upload) must keep the browser-set multipart boundary, so
  // we do not force a Content-Type for it and pass the body through unserialized.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const headers: Record<string, string> = isForm ? {} : { 'Content-Type': 'application/json' }
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
    throw new ApiRequestError(msg, r.status, code, payload, requestId)
  }

  if (r.status === 204) return null as T
  return r.json() as Promise<T>
}

export const get   = <T>(path: string, options?: RequestOptions)                => request<T>('GET',    path, undefined, options)

export const post  = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST',   path, body, options)

export const del   = <T>(path: string, options?: RequestOptions)                => request<T>('DELETE', path, undefined, options)
