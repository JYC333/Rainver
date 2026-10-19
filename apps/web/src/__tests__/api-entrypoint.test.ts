// @vitest-environment node
import { describe, expect, it } from 'vitest'
import clientSource from '../api/client.ts?raw'
import viteConfigSource from '../../vite.config.ts?raw'

describe('web API entrypoint', () => {
  it('uses same-origin API paths in browser code', () => {
    expect(clientSource).toContain("const BASE = '/api/v1'")
  })

  it('defaults the Vite dev proxy to server, not backend', () => {
    expect(viteConfigSource).toContain("'http://server:8010'")
  })

  it('proxies the trusted-host WebSocket through the same dev origin', () => {
    // The one `/internal` path the browser legitimately opens, named exactly.
    // Do not proxy all of `/internal`. Production nginx does not forward it,
    // so a Run tool surface under `/internal/runs/...` would look like it
    // worked only in dev.
    expect(viteConfigSource).toContain("'/internal/hosts/ws'")
    expect(viteConfigSource).not.toContain("'/internal':")
    expect(viteConfigSource).toContain('ws: true')
  })

  it('does not cache authenticated API GET bodies in the service worker', () => {
    expect(viteConfigSource).toContain('NetworkOnly')
    expect(viteConfigSource).not.toContain('NetworkFirst')
  })
})
