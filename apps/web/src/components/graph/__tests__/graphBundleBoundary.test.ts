// @vitest-environment node
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import mapViewSource from '../../../modules/projects/inquiryArea/MapView.tsx?raw'
import viteConfigSource from '../../../../vite.config.ts?raw'

describe('graph bundle boundary', () => {
  it('loads the Inquiry relation graph through a dynamic import', () => {
    expect(mapViewSource).toContain("import('../../../components/graph')")
    expect(mapViewSource).not.toMatch(/import\s+\{\s*GraphView\s*\}\s+from/)
  })

  it('keeps optional graph chunks out of the PWA shell precache', () => {
    expect(viteConfigSource).toContain("return 'assets/graph-engine-[hash].js'")
    expect(viteConfigSource).toContain("return 'assets/graph-webgl-[hash].js'")
    expect(viteConfigSource).toContain("'**/GraphView-*.js'")
    expect(viteConfigSource).toContain("'**/graph-engine-*.js'")
    expect(viteConfigSource).toContain("'**/graph-webgl-*.js'")
    expect(viteConfigSource).toContain("cacheName: 'graph-runtime-v1'")
    expect(viteConfigSource).toContain("handler: 'CacheFirst'")
  })
})
