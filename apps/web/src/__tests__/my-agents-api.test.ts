// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentsApi, setSpaceContext } from '../api/client'

// My Agents is person-scoped: a browsed (possibly stale or not yet resolved) Space is never sent.
beforeEach(() => { setSpaceContext('browsed'); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => vi.unstubAllGlobals())

it('reads /me/agents with its filters and without the browsed Space', async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0, revision: 'empty' }), { headers: { 'Content-Type': 'application/json' } }))
  await agentsApi.listMine({ manage: 'manageable', source: 'plugin', limit: 50, offset: 0 })
  const [url, init] = vi.mocked(fetch).mock.calls[0]!
  expect(url).toBe('/api/v1/me/agents?manage=manageable&source=plugin&limit=50&offset=0')
  expect(new Headers(init!.headers).has('X-Rainver-Space-Id')).toBe(false)
})
