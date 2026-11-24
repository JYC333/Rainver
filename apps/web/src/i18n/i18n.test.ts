import { describe, expect, it } from 'vitest'
import i18n from './index'
import './authenticated'

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

function messages(bundle: Record<string, string>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(bundle)) {
    const plural = interpolationNames(value).includes('count')
    const message = plural ? key.replace(/_(?:zero|one|two|few|many|other)$/, '') : key
    const variants = result[message] ??= []
    variants.push(value)
  }
  return result
}

describe('registered UI translations', () => {
  const english = messages(leafStrings(i18n.getResourceBundle('en', 'translation')))
  const chinese = messages(leafStrings(i18n.getResourceBundle('zh-CN', 'translation')))

  it('registers the same messages in both languages regardless of plural forms', () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
  })

  it('keeps interpolation values aligned for every translated message', () => {
    const names = (variants: string[]) => [...new Set(variants.map(value => JSON.stringify(interpolationNames(value))))].sort()
    for (const [key, variants] of Object.entries(english)) {
      expect(names(chinese[key] ?? []), key).toEqual(names(variants))
    }
  })

  it.each([
    ['en', ['0 providers', '1 provider', '2 providers']],
    ['zh-CN', ['0 家供应商', '1 家供应商', '2 家供应商']],
  ] as const)('renders the provider count in %s without fallback', (lng, expected) => {
    expect([0, 1, 2].map(count => {
      const resolved = i18n.t('management_ui.host_catalog.provider_count', { lng, count, returnDetails: true })
      expect(resolved.usedLng).toBe(lng)
      return resolved.res
    })).toEqual(expected)
  })
})
