import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, artifactsApi, authApi, notesApi } from '../api/client'
import { request } from '../api/transport'
import { beginPendingLogout, clearSessionResidue } from '../lib/sessionResidue'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function listenForSignOut() {
  const heard = vi.fn()
  window.addEventListener('auth:required', heard)
  return { heard, stop: () => window.removeEventListener('auth:required', heard) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('artifact downloads belong to the requesting session', () => {
  function captureDownloads() {
    const createObjectURL = vi.fn(() => 'blob:artifact')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    return { createObjectURL, revokeObjectURL, click }
  }

  it.each(['response', 'body'])('does not save a download whose %s arrives after cookie logout', async stage => {
    clearSessionResidue()
    const downloads = captureDownloads()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const response = new Response('private artifact')
    if (stage === 'body') vi.spyOn(response, 'blob').mockImplementation(async () => {
      await pending
      return new Blob(['private artifact'])
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (stage === 'response') await pending
      return response
    }))
    const outcome = artifactsApi.export('artifact-1').catch(error => error)
    // Let the successful response enter blob reading in the body variant.
    await Promise.resolve()
    clearSessionResidue()
    release()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(downloads.createObjectURL).not.toHaveBeenCalled()
    expect(downloads.click).not.toHaveBeenCalled()
  })

  it('saves an authorized file and releases its temporary URL', async () => {
    const downloads = captureDownloads()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('artifact', {
      headers: { 'Content-Disposition': 'attachment; filename="result.txt"' },
    })))
    await artifactsApi.export('artifact-1')
    expect(downloads.click).toHaveBeenCalledOnce()
    expect(downloads.revokeObjectURL).toHaveBeenCalledWith('blob:artifact')
  })

  it.each([403, 404])('preserves a download refusal status (%s) without saving its response', async status => {
    const downloads = captureDownloads()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Not accessible' }, status)))
    await expect(artifactsApi.export('artifact-1')).rejects.toMatchObject({ name: 'ApiRequestError', status })
    expect(downloads.createObjectURL).not.toHaveBeenCalled()
    expect(downloads.click).not.toHaveBeenCalled()
  })
})

describe('a 401 from the API', () => {
  it('does not send a password sign-in until pending sign-out succeeds', async () => {
    beginPendingLogout()
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'new-user' } }, 200))
    vi.stubGlobal('fetch', fetch)
    const credentials = { email: 'new@example.test', password: 'password', rememberMe: false }
    await expect(authApi.passwordLogin(credentials)).rejects.toMatchObject({ code: 'logout_pending' })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/auth/logout'])
    await expect(authApi.passwordLogin(credentials)).resolves.toEqual({ user: { id: 'new-user' } })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/logout', '/api/v1/auth/logout', '/api/v1/auth/sign-in/email',
    ])
  })

  it('signs the browser out when the session is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'authentication_required', message: 'Authentication required' }, 401)))
    const { heard, stop } = listenForSignOut()
    try {
      await expect(notesApi.get('note-1')).rejects.toBeInstanceOf(ApiRequestError)
      expect(heard).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('leaves the session alone when only the authentication step failed', async () => {
    // A mistyped password at re-authentication: the session is still valid.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'operation_unavailable', message: 'The authentication operation could not be completed' }, 401)))
    const { heard, stop } = listenForSignOut()
    try {
      await expect(authApi.reauth('wrong password')).rejects.toMatchObject({ status: 401, code: 'operation_unavailable' })
      expect(heard).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('leaves any existing session alone when password sign-in is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'invalid_credentials', message: 'Invalid email or password' }, 401)))
    const { heard, stop } = listenForSignOut()
    try {
      await expect(authApi.passwordLogin({ email: 'owner@example.test', password: 'incorrect', rememberMe: false }))
        .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' })
      expect(heard).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

describe('HTTP error responses', () => {
  it.each([
    ['Gateway timed out', 'text/plain', 'Gateway timed out'],
    ['<html>Gateway timed out</html>', 'text/html', '504 Gateway Timeout'],
    ['', 'text/plain', '504 Gateway Timeout'],
  ])('formats a gateway response with body %j', async (body, contentType, message) => {
    vi.stubGlobal('fetch', async () => new Response(body, {
      status: 504,
      statusText: 'Gateway Timeout',
      headers: { 'Content-Type': contentType, 'X-Request-Id': 'proxy-id' },
    }))
    await expect(request('GET', '/test')).rejects.toMatchObject({
      message: `${message} (request id: proxy-id)`,
      requestId: 'proxy-id',
    })
  })

  it.each([
    [{ request_id: 'body-id', message: 'Refused', code: 'refusal' }, 'body-id'],
    [{ request_id: 'body-id', error: { request_id: 'operation-id', message: 'Refused', code: 'refusal' } }, 'operation-id'],
  ])('preserves error correlation and payload for %j', async (body, requestId) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
      status: 409,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'proxy-id' },
    }))
    await expect(request('GET', '/test')).rejects.toMatchObject({
      status: 409,
      code: 'refusal',
      message: `Refused (request id: ${requestId})`,
      payload: body,
      requestId,
    })
  })
})
