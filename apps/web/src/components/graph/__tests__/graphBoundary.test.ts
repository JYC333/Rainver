// @vitest-environment node
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'

describe('graph dependency boundary', () => {
  it('keeps AntV imports confined to the renderer adapter', () => {
    const appModules = import.meta.glob('../../../**/*.{ts,tsx}', {
      eager: true,
      import: 'default',
      query: '?raw',
    }) as Record<string, string>
    const pluginModules = import.meta.glob('../../../../../../plugins/official/*/web/src/**/*.{ts,tsx}', {
      eager: true,
      import: 'default',
      query: '?raw',
    }) as Record<string, string>
    const matches = Object.entries({ ...appModules, ...pluginModules })
      .filter(([file]) => !file.includes('__tests__') && !file.includes('.test.'))
      .filter(([, text]) => text.includes('@antv/g6') || text.includes('@antv/g-webgl'))
      .map(([file]) => file.replace('../../../', ''))
      .sort()

    expect(matches).toEqual(['../core/createGraphRenderer.ts'])
  })
})
