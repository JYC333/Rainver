import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `apps/web/src/types/api.ts` and `packages/protocol` once declared 204 wire
 * types twice, and 98 of those pairs had drifted apart before anyone noticed.
 * Forwarding fixed the existing pairs; this keeps new ones from appearing.
 *
 * Only *local redeclaration* fails. Forwarding is the target state, so
 * `export type { Thing } from '@agent-space/protocol'` — and the import-then-
 * export form api.ts uses — must keep passing.
 */
const here = dirname(fileURLToPath(import.meta.url))
const apiTypesPath = join(here, '..', '..', '..', 'apps', 'web', 'src', 'types', 'api.ts')
const protocolSrc = join(here, '..', 'src')

/** Names that legitimately collide: client view models, not wire contracts. */
const ALLOWED_LOCAL_REDECLARATIONS = new Set<string>([])

function protocolExports(): Set<string> {
  const names = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!full.endsWith('.ts')) continue
      for (const match of readFileSync(full, 'utf8').matchAll(/^export (?:type|interface|const|enum) ([A-Za-z0-9_]+)/gm)) {
        names.add(match[1]!)
      }
    }
  }
  walk(protocolSrc)
  return names
}

function localDeclarations(source: string): string[] {
  return [...source.matchAll(/^export (?:type|interface) ([A-Za-z0-9_]+)\b/gm)].map(match => match[1]!)
}

describe('protocol forwarding', () => {
  it('never redeclares a type the protocol package already exports', () => {
    const exported = protocolExports()
    const duplicated = localDeclarations(readFileSync(apiTypesPath, 'utf8'))
      .filter(name => exported.has(name) && !ALLOWED_LOCAL_REDECLARATIONS.has(name))
      .sort()

    expect(
      duplicated,
      duplicated.length
        ? `api.ts redeclares wire types the protocol package owns: ${duplicated.join(', ')}. `
          + 'Forward them (`import type { X } from \'@agent-space/protocol\'` plus `export type { X }`) '
          + 'instead of writing a second declaration, or rename the client view model if it only shares the name.'
        : undefined,
    ).toEqual([])
  })
})
