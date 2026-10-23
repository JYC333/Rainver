import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsApi, authorizationRequestsApi, conversationInputApi, projectFoldersApi, proposalsApi, roomsApi, runsApi, sessionsApi, setSpaceContext } from '../api/client'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  setSpaceContext('active-space')
})
describe('conversation source Space transport', () => {
  it.each(['source-a', 'source-b'])('keeps all reads and commands in %s while URL context stays elsewhere', async spaceId => {
    const options = { spaceId, signal: new AbortController().signal }
    await roomsApi.get('room', options)
    await roomsApi.messages('room', 'session', { offset: 50 }, options)
    await roomsApi.sendMessage('room', 'session', { content: 'Reply', routing_mode: 'direct', backends: [] }, options)
    await roomsApi.retryMessage('room', 'session', 'run', { ...options, idempotencyKey: 'retry-key' })
    await sessionsApi.executionContext('session', options)
    await agentsApi.conversationBackends('agent', { ...options, sessionId: 'session' })
    await conversationInputApi.searchFiles('session', 'file', undefined, options)
    await projectFoldersApi.file('project', 'folder', 'file.ts', options)
    await runsApi.turn('run', options)
    await runsApi.stop('run', options)
    await authorizationRequestsApi.approve('authorization', options)
    await proposalsApi.get('proposal', options)
    await proposalsApi.accept('proposal', options)
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(init?.headers).get('X-Rainver-Space-Id')).toBe(spaceId)
      expect(init?.signal).toBe(options.signal)
    }
    expect(new Headers(vi.mocked(fetch).mock.calls[3]![1]?.headers).get('Idempotency-Key')).toBe('retry-key')
    await runsApi.get('active-run')
    expect(new Headers(vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1]![1]?.headers).get('X-Rainver-Space-Id')).toBe('active-space')
  })
})
