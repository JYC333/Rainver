import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, authApi, notesApi } from '../api/client'

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
})

describe('a 401 from the API', () => {
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
})
