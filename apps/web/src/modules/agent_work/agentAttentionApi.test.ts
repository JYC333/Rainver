import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentAttentionApi, setSpaceContext } from '../../api/client'
import { page, work } from './fixtures.test-support'

beforeEach(() => {
  setSpaceContext('active-a')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => vi.unstubAllGlobals())
describe('Agent Attention transport', () => {
  it('uses user-level typed queries and forwards cancellation without active Space', async () => {
    const signal = new AbortController().signal
    await agentAttentionApi.list({ scope: 'all_visible', space_id: 'space-b', view: 'history', since: '2026-01-01T00:00:00Z', cursor: 'opaque+/=' }, { signal })
    await agentAttentionApi.item({ ...work().identity, space_id: 'space-b', runs_cursor: 'child+/=' }, { signal })
    const source = work()
    await agentAttentionApi.setReadState({ identity: source.identity, space_id: source.space_id, subject: source.read_states[0]!.subject,
      state_version: 0, action: 'read' }, { signal })
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(init?.headers).has('X-Rainver-Space-Id')).toBe(false)
      expect(init?.signal).toBe(signal)
    }
    const listUrl = new URL(String(vi.mocked(fetch).mock.calls[0]![0]), 'http://local')
    expect(listUrl.searchParams.get('cursor')).toBe('opaque+/=')
    expect(listUrl.searchParams.get('space_id')).toBe('space-b')
    const itemUrl = new URL(String(vi.mocked(fetch).mock.calls[1]![0]), 'http://local')
    expect(itemUrl.searchParams.get('runs_cursor')).toBe('child+/=')
    expect(itemUrl.searchParams.get('kind')).toBe('run')
  })
  it('reuses the shared SSE parser for split multiline frames and omits active Space', async () => {
    const frame = { type: 'attention.snapshot', seq: 1, version: 'v', page: page(), unread_count: 4, notices: [] }
    const encoder = new TextEncoder()
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      const body = `event: attention.snapshot\r\ndata: ${JSON.stringify(frame).replace(',', ',\r\ndata: ')}\r\n\r\n`
      const boundary = body.indexOf('\r') + 1
      controller.enqueue(encoder.encode(body.slice(0, boundary))); controller.enqueue(encoder.encode(body.slice(boundary))); controller.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    const received: unknown[] = []; const signal = new AbortController().signal
    await expect(agentAttentionApi.stream(frame => received.push(frame), { signal })).rejects.toThrow('disconnected')
    expect(received).toEqual([frame])
    const [url, options] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('/api/v1/me/agent-attention/stream'); expect(options?.signal).toBe(signal)
    expect(new Headers(options?.headers).has('X-Rainver-Space-Id')).toBe(false)
  })
  it('sends the exact displayed revision and exposes the authoritative conflict state', async () => {
    const state = work().read_states[0]!
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ current: { ...state, state_version: 4 } }), { status: 409 }))
    const signal = new AbortController().signal
    const request = { identity: work().identity, space_id: 'space-b', subject: state.subject, state_version: 0, action: 'read' as const }
    await expect(agentAttentionApi.setReadState(request, { signal })).rejects.toMatchObject({ status: 409, payload: { current: { state_version: 4 } } })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('/api/v1/me/agent-attention/read-state')
    expect(JSON.parse(String(init?.body))).toEqual(request)
    expect(new Headers(init?.headers).has('X-Rainver-Space-Id')).toBe(false)
    expect(init?.signal).toBe(signal)

  })
  it.each([403,500])('preserves HTTP %s from a failed stream response', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}',{status,headers:{'Content-Type':'application/json'}}))
    await expect(agentAttentionApi.stream(vi.fn())).rejects.toMatchObject({status})
  })

})
