import { describe, expect, it } from 'vitest'
import i18n from './index'

function leafStrings(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Translation resource ${prefix} must be a string or object`)
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
    Object.entries(leafStrings(child, prefix ? `${prefix}.${key}` : key)),
  ))
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(/{{\s*([\w.]+)(?:\s*,[^}]*)?\s*}}/g)]
    .map(match => match[1])
    .sort()
}

describe('registered UI translations', () => {
  const english = leafStrings(i18n.getResourceBundle('en', 'translation'))
  const chinese = leafStrings(i18n.getResourceBundle('zh-CN', 'translation'))

  it('registers the same keys in both languages', () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
  })

  it('keeps interpolation values aligned for every translated message', () => {
    for (const [key, source] of Object.entries(english)) {
      expect(interpolationNames(chinese[key] ?? ''), key).toEqual(interpolationNames(source))
    }
  })
})
