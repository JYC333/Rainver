// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { meApi, homeApi, setSpaceContext } from '../api/client'

/**
 * Home is user-scoped: its /me aggregate must NOT be filtered by the active Space, even when
 * one is selected. The space-scoped Space Today endpoint is the contrast.
 */
describe('Home aggregate is not filtered by the active space', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch
  })

  it('meApi.summary omits space context even when a space is active', async () => {
    setSpaceContext('space-team')
    await meApi.summary()
    const [url, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toContain('/me/summary')
    expect(url).not.toContain('space_id')
    expect(url).not.toContain('user_id')
    expect((init.headers as Record<string, string>)['X-Rainver-Space-Id']).toBeUndefined()
  })

  it('homeApi.summary (Space Today) sends explicit space context', async () => {
    setSpaceContext('space-team')
    await homeApi.summary()
    const [url, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toContain('/home/summary')
    expect(url).not.toContain('space_id')
    expect((init.headers as Record<string, string>)['X-Rainver-Space-Id']).toBe('space-team')
  })
})
