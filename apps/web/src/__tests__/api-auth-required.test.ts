import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, artifactsApi, authApi, diaryApi, notesApi, setAuth } from '../api/client'

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
    setAuth(null)
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
    setAuth(null)
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
  it('invalidates queued writes on cookie sign-out even when the bearer key remains null', () => {
    setAuth(null)
    const before = diaryApi.saveContextKey()
    setAuth(null)
    expect(diaryApi.saveContextKey()).not.toBe(before)
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
})
