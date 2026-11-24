import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOOT_TRANSLATIONS } from './index'
import { translationResources } from './resources'

// Surfaces that render before the signed-in app (and its full string set)
// loads: the boot chunk's pages and panels and the viewport probe entry.
const BOOT_SURFACES = [
  '../pages/LoginPage.tsx', '../pages/RegistrationPage.tsx', '../pages/AcceptInvitationPage.tsx',
  '../pages/ResetPasswordPage.tsx', '../core/ErrorBoundary.tsx', '../core/ModuleLoadFailure.tsx',
  '../core/UpdateNotAppliedNotice.tsx', './PublicLocaleSwitcher.tsx',
  '../modules/settings/viewportTest/ViewportTest.tsx', '../modules/settings/viewportTest/ProbeVersion.tsx',
]

function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), bundle)
}

describe('sign-in translation subset', () => {
  it.each(['en', 'zh-CN'] as const)('keeps every %s group identical to the full set', locale => {
    const boot = BOOT_TRANSLATIONS[locale] as Record<string, unknown>
    const full = translationResources[locale] as Record<string, unknown>
    for (const group of Object.keys(boot)) expect(full[group], group).toEqual(boot[group])
  })

  it('holds every literal key the boot surfaces translate', () => {
    const missing: string[] = []
    for (const file of BOOT_SURFACES) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      for (const [, key, template] of source.matchAll(/(?<![\w.])t\(\s*['"`]([\w.]+)(\$\{)?/g)) {
        for (const locale of ['en', 'zh-CN'] as const) {
          const bundle = BOOT_TRANSLATIONS[locale] as Record<string, unknown>
          // `t(\`group.prefix_${x}\`)`: some sibling key must start with the prefix.
          const parent = key.slice(0, key.lastIndexOf('.'))
          const stem = key.slice(key.lastIndexOf('.') + 1)
          const node = lookup(bundle, parent)
          const found = template
            ? node && typeof node === 'object' && Object.keys(node).some(name => name.startsWith(stem))
            : lookup(bundle, key) ?? lookup(bundle, `${key}_one`)
          if (!found) missing.push(`${locale} ${file} ${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
