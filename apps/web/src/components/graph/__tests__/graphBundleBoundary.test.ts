// @vitest-environment node
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import mapViewSource from '../../../modules/projects/inquiryArea/MapView.tsx?raw'

describe('graph bundle boundary', () => {
  it('loads the Inquiry relation graph through a dynamic import', () => {
    expect(mapViewSource).toContain("import('../../../components/graph')")
    expect(mapViewSource).not.toMatch(/import\s+\{\s*GraphView\s*\}\s+from/)
  })
})
