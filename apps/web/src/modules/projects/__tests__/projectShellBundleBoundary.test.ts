// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Relative modules a file imports statically; `import type` and `import()` are erased or deferred. */
function staticImports(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const specifiers = [...code.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)].map(match => match[1]!)
  return specifiers.flatMap(specifier => {
    const base = join(dirname(file), specifier)
    const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(candidate => existsSync(candidate) && !candidate.endsWith('/'))
    return found && /\.(?:ts|tsx)$/.test(found) ? [found] : []
  })
}

function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const pending = [resolve(src, entry)]
  for (const file of pending) {
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...staticImports(file))
  }
  return new Set([...seen].map(file => relative(src, file)))
}

describe('Project shell bundle boundary', () => {
  // The Project heading waits for this closure. The Room conversation stack
  // (composer editor, message rendering, highlighting) loads beside it.
  it('keeps the sidecar conversation stack out of the Project layout static imports', () => {
    const closure = staticClosure('modules/projects/ProjectAreaLayout.tsx')
    expect(closure).toContain('modules/projects/sidecar/ProjectChatSidecar.tsx')
    expect(closure).toContain('modules/projects/ProjectDetailPage.tsx')
    for (const heavy of [
      'modules/projects/sidecar/ProjectSidecarConversation.tsx',
      'modules/conversation/ConversationSurface.tsx',
      'modules/conversation/ConversationExecutionPreflight.tsx',
      'modules/conversation/ConversationInputComposer.tsx',
    ]) expect(closure, heavy).not.toContain(heavy)
    expect(readFileSync(resolve(src, 'modules/projects/sidecar/ProjectChatSidecar.tsx'), 'utf8'))
      .toContain("import('./ProjectSidecarConversation')")
  })
})
