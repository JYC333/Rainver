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
    expect(viteConfigSource).toContain("'/internal'")
    expect(viteConfigSource).toContain('ws: true')
  })
})
