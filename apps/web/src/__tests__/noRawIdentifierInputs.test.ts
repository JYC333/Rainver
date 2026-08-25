// @vitest-environment node
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'

const RAW_IDENTIFIER = /(?:\bUUIDs?\b|\bIDs?\b|_ids?\b|引用\s*ID|来源\s*ID)/i
const USER_PROMPTS = [
  /<Label\b[^>]*>([^<]*)<\/Label>/g,
  /placeholder\s*=\s*["']([^"']*)["']/g,
  /ariaLabel\s*=\s*["']([^"']*)["']/g,
  /aria-label\s*=\s*["']([^"']*)["']/g,
]

describe('normal product forms do not request internal identifiers', () => {
  it('allows raw IDs only through the explicit technical-details component', () => {
    const modules = import.meta.glob('../**/*.tsx', {
      eager: true,
      import: 'default',
      query: '?raw',
    }) as Record<string, string>
    const violations: string[] = []
    for (const [path, source] of Object.entries(modules)) {
      if (path.includes('__tests__') || path.includes('.test.') || path.endsWith('/components/TechnicalIdField.tsx')) continue
      for (const pattern of USER_PROMPTS) {
        for (const match of source.matchAll(pattern)) {
          if (!RAW_IDENTIFIER.test(match[1])) continue
          const lineNumber = source.slice(0, match.index).split('\n').length
          const line = source.split('\n')[lineNumber - 1]?.trim() ?? match[0]
          if (line.includes('<TechnicalIdField')) continue
          violations.push(`${path}:${lineNumber}: ${line}`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
