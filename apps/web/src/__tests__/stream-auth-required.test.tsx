import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { AuthProvider, useAuth } from '../contexts/AuthContext'
import { __resetLogoutChannelForTests } from '../lib/sessionResidue'
import { ApiRequestError, agentAttentionApi, artifactsApi, conversationInputApi, hostsApi, ordinaryToolsApi, projectsApi, providersApi, runsApi } from '../api/client'

/**
 * Authenticated SSE clients against the real AuthProvider and session-residue
 * clearing: only the HTTP fetch is stubbed. A 401 on the control-plane
 * response, or a typed 401 `server.error` inside an opened turn stream, signs
 * this browser out exactly once and tells the other tabs; 403/404, aborts and
 * a stream's own business errors do not.
 */
const user = { id: 'u1', display_name: 'Ada', email: 'ada@example.test', avatar_url: null, default_space_id: 's1', created_at: '', last_login_at: null }

function Probe() {
  const { currentUser, isLoading } = useAuth()
  return <span>{isLoading ? 'loading' : currentUser ? currentUser.display_name : 'signed out'}</span>
}

function sse(frames: string[], status = 200): Response {
  return new Response(frames.join(''), { status, headers: { 'content-type': 'text/event-stream' } })
}

/** Serves `/me`, and `stream` for everything else; records what the cancelled bodies were. */
function serve(stream: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const cancelled: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/me') return new Response(JSON.stringify(user), { status: 200, headers: { 'content-type': 'application/json' } })
    const response = await stream(url, init)
    const body = response.body
    if (body) {
      const cancel = body.cancel.bind(body)
      body.cancel = async reason => { cancelled.push(url); return cancel(reason) }
    }
    return response
  }))
  return cancelled
}

async function signedIn() {
  const announced: unknown[] = []
  const tabs = new BroadcastChannel('rainver:auth')
  tabs.addEventListener('message', event => { announced.push(event.data) })
  const required = vi.fn()
  window.addEventListener('auth:required', required)
  render(<AuthProvider><Probe /></AuthProvider>)
  expect(await screen.findByText('Ada')).toBeInTheDocument()
  localStorage.setItem('project:p1:research-workflow', 'wf-1')
  return {
    announced, required,
    async settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) },
    stop() { tabs.close(); window.removeEventListener('auth:required', required) },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetLogoutChannelForTests()
  localStorage.clear()
})

const drain = async (iterator: AsyncGenerator<unknown>) => { for await (const _ of iterator) { /* consume */ } }

describe('authenticated streams and a session that ended', () => {
  it.each([
    ['turn stream', () => runsApi.streamTurn('r1', { onTurn: () => {} })],
    ['attention stream', () => agentAttentionApi.stream(() => {})],
    ['project updates stream', () => projectsApi.streamUpdates('p1', () => {})],
    ['host login stream', () => drain(hostsApi.loginStream('h1', 'claude_code', 'own'))],
    ['ordinary tool account stream', () => drain(ordinaryToolsApi.sessionStream('h1', 'gh', 'login'))],
    ['subscription login stream', () => drain(providersApi.subscriptionLoginStream('claude' as never))],
  ])('signs out once on a 401 %s response and releases its body', async (_name, open) => {
    const cancelled = serve(() => sse(['{"detail":"Authentication required"}'], 401))
    const session = await signedIn()
    try {
      await expect(open()).rejects.toMatchObject({ name: 'ApiRequestError', status: 401 })
      await session.settle()
      expect(screen.getByText('signed out')).toBeInTheDocument()
      expect(localStorage.getItem('project:p1:research-workflow')).toBeNull()
      expect(session.required).toHaveBeenCalledTimes(1)
      expect(session.announced).toEqual(['logged-out'])
      expect(cancelled).toHaveLength(1)
    } finally { session.stop() }
  })

  it('signs out on a typed 401 server.error inside an opened turn stream, and not on a 404 one', async () => {
    const snapshot = 'event: turn.snapshot\ndata: {"type":"turn.snapshot","turn":{"run_id":"r1","state":"working","parts":[],"cursor":0}}\n\n'
    let status = 404
    serve(() => sse([snapshot, `event: server.error\ndata: {"error":"x","message":"Stream ended","status":${status}}\n\n`]))
    const session = await signedIn()
    try {
      await expect(runsApi.streamTurn('r1', { onTurn: () => {} })).rejects.toMatchObject({ status: 404 })
      await session.settle()
      expect(screen.getByText('Ada')).toBeInTheDocument()
      expect(session.required).not.toHaveBeenCalled()
      status = 401
      await expect(runsApi.streamTurn('r1', { onTurn: () => {} })).rejects.toMatchObject({ status: 401 })
      await session.settle()
      expect(screen.getByText('signed out')).toBeInTheDocument()
      expect(session.required).toHaveBeenCalledTimes(1)
    } finally { session.stop() }
  })

  it('raises one sign-out for several streams refused together', async () => {
    serve(() => sse([], 401))
    const session = await signedIn()
    try {
      const outcomes = await Promise.allSettled([
        runsApi.streamTurn('r1', { onTurn: () => {} }),
        runsApi.streamTurn('r2', { onTurn: () => {} }),
        agentAttentionApi.stream(() => {}),
        projectsApi.streamUpdates('p1', () => {}),
      ])
      expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true)
      await session.settle()
      expect(session.required).toHaveBeenCalledTimes(1)
      expect(session.announced).toEqual(['logged-out'])
    } finally { session.stop() }
  })

  it('leaves the session alone on 403, on an aborted request, and on a stream business error', async () => {
    serve((url, init) => {
      if (url.includes('/subscriptions/login/stream')) return sse(['data: {"type":"error","message":"Upstream said 401"}\n\n'])
      if (url.includes('/turn/stream') && init?.signal?.aborted) return sse([], 401)
      return sse([], 403)
    })
    const session = await signedIn()
    try {
      await expect(runsApi.streamTurn('r1', { onTurn: () => {} })).rejects.toBeInstanceOf(ApiRequestError)
      await expect(drain(hostsApi.loginStream('h1', 'claude_code', 'own'))).rejects.toMatchObject({ status: 403 })
      const aborted = new AbortController()
      aborted.abort()
      await expect(runsApi.streamTurn('r1', { signal: aborted.signal, onTurn: () => {} })).rejects.toMatchObject({ status: 401 })
      await drain(providersApi.subscriptionLoginStream('claude' as never))
      await session.settle()
      expect(screen.getByText('Ada')).toBeInTheDocument()
      expect(session.required).not.toHaveBeenCalled()
      expect(session.announced).toEqual([])
    } finally { session.stop() }
  })
})

/** A stub XHR: `answer(status)` completes the upload that was sent last. */
function stubUploads() {
  const sent: Array<{ answer: (status: number) => void }> = []
  class FakeXhr {
    status = 0; statusText = ''; responseText = ''; withCredentials = false
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
    onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
    private loadend: Array<() => void> = []
    open() {} setRequestHeader() {} getResponseHeader() { return null }
    addEventListener(type: string, listener: () => void) { if (type === 'loadend') this.loadend.push(listener) }
    send() {
      const entry = { answer: (status: number) => {
        this.status = status; this.responseText = '{"detail":"Authentication required"}'
        this.onload?.(); for (const listener of this.loadend) listener()
      } }
      sent.push(entry)
    }
    abort() { this.onabort?.(); for (const listener of this.loadend) listener() }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  return sent
}

function ReloadProbe() {
  const { currentUser, isLoading, reloadUser } = useAuth()
  return <><span>{isLoading ? 'loading' : currentUser ? currentUser.display_name : 'signed out'}</span><button onClick={() => { void reloadUser() }}>reload</button></>
}

const image = () => new File(['x'], 'x.png', { type: 'image/png' })

describe('non-stream control-plane reads and a session that ended', () => {
  it.each([
    ['image upload (XHR)', 'xhr'],
    ['image blob', '/conversation-inputs/media/'],
    ['artifact export', '/artifacts/a1/export'],
  ])('signs out once on a 401 %s', async (_name, kind) => {
    const uploads = stubUploads()
    const cancelled = serve(() => new Response('{"detail":"Authentication required"}', { status: 401 }))
    const session = await signedIn()
    try {
      if (kind === 'xhr') {
        const pending = conversationInputApi.uploadImage(image())
        uploads[uploads.length - 1]!.answer(401)
        await expect(pending).rejects.toMatchObject({ status: 401 })
      } else if (kind.includes('media')) {
        await expect(conversationInputApi.imageBlob('m1')).rejects.toMatchObject({ status: 401 })
        expect(cancelled).toHaveLength(1)
      } else {
        await expect(artifactsApi.export('a1')).rejects.toMatchObject({ status: 401 })
      }
      await session.settle()
      expect(screen.getByText('signed out')).toBeInTheDocument()
      expect(session.required).toHaveBeenCalledTimes(1)
      expect(session.announced).toEqual(['logged-out'])
    } finally { session.stop() }
  })

  it('does not sign out the next login with a 401 for a request sent in the previous session', async () => {
    const uploads = stubUploads()
    let me: typeof user | null = user
    let answerBlob: (response: Response) => void = () => {}
    let answerExport: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/v1/me') return me
        ? new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{}', { status: 401 })
      if (url.includes('/conversation-inputs/media/')) return new Promise<Response>(resolve => { answerBlob = resolve })
      return new Promise<Response>(resolve => { answerExport = resolve })
    }))
    const required = vi.fn()
    window.addEventListener('auth:required', required)
    const otherTab = new BroadcastChannel('rainver:auth')
    try {
      render(<AuthProvider><ReloadProbe /></AuthProvider>)
      expect(await screen.findByText('Ada')).toBeInTheDocument()
      // Sent by Ada's session...
      const upload = conversationInputApi.uploadImage(image())
      const blob = conversationInputApi.imageBlob('m1')
      const exported = artifactsApi.export('a1')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      // ...which another tab then signs out; Grace signs in here.
      otherTab.postMessage('logged-out')
      await screen.findByText('signed out')
      me = { ...user, id: 'u2', display_name: 'Grace' }
      await act(async () => { screen.getByText('reload').click() })
      expect(await screen.findByText('Grace')).toBeInTheDocument()
      // The old requests' 401s arrive in Grace's session and change nothing.
      uploads[uploads.length - 1]!.answer(401)
      answerBlob(new Response('{}', { status: 401 }))
      answerExport(new Response('{}', { status: 401 }))
      await expect(upload).rejects.toMatchObject({ status: 401 })
      await expect(blob).rejects.toMatchObject({ status: 401 })
      await expect(exported).rejects.toBeDefined()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      expect(screen.getByText('Grace')).toBeInTheDocument()
      expect(required).not.toHaveBeenCalled()
    } finally {
      otherTab.close()
      window.removeEventListener('auth:required', required)
    }
  })

  it('leaves the session alone on 403 and on an aborted upload, blob read or attention stream', async () => {
    const uploads = stubUploads()
    serve((url, init) => {
      if (init?.signal?.aborted) return new Response('{}', { status: 401 })
      return new Response('{}', { status: url.includes('agent-attention') ? 401 : 403 })
    })
    const session = await signedIn()
    try {
      const upload = conversationInputApi.uploadImage(image())
      uploads[uploads.length - 1]!.answer(403)
      await expect(upload).rejects.toMatchObject({ status: 403 })
      await expect(conversationInputApi.imageBlob('m1')).rejects.toMatchObject({ status: 403 })
      await expect(artifactsApi.export('a1')).rejects.toMatchObject({ status: 403 })
      // Aborted while in flight: the 401 that still comes back is not a sign-out.
      const leaving = new AbortController()
      const aborting = conversationInputApi.uploadImage(image(), undefined, { signal: leaving.signal })
      const sent = uploads[uploads.length - 1]!
      leaving.abort()
      sent.answer(401)
      await expect(aborting).rejects.toBeDefined()
      const aborted = new AbortController(); aborted.abort()
      await expect(conversationInputApi.imageBlob('m1', { signal: aborted.signal })).rejects.toMatchObject({ status: 401 })
      // The attention reader returns quietly once its caller left.
      await agentAttentionApi.stream(() => {}, { signal: aborted.signal })
      await session.settle()
      expect(screen.getByText('Ada')).toBeInTheDocument()
      expect(session.required).not.toHaveBeenCalled()
    } finally { session.stop() }
  })
})
