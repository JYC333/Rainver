// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Patterns that made this suite slow once and must not come back. Each is a
 * cost paid per keystroke or per file rather than per assertion, so a test
 * using one looks fine alone and drags the suite as it grows. Exemptions are
 * listed here, by file, so adding one is a visible decision.
 */

const srcDir = join(__dirname, '..')
const files: string[] = []
;(function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.test\.tsx?$/.test(entry) && !path.endsWith('testHygiene.test.ts')) files.push(path)
  }
})(srcDir)
const source = new Map(files.map(path => [relative(srcDir, path), readFileSync(path, 'utf8')]))

function offenders(matches: (text: string) => boolean, exempt: readonly string[] = []): string[] {
  return [...source.entries()].filter(([name, text]) => !exempt.includes(name) && matches(text)).map(([name]) => name).sort()
}

describe('test hygiene', () => {
  it('sets up userEvent without the per-keystroke macrotask delay', () => {
    expect(offenders(text => /userEvent\.setup\(\s*\)/.test(text))).toEqual([])
  })

  it('does not wait on real time for more than 100ms', () => {
    const sleep = /setTimeout\(\s*(?:\(\)\s*=>\s*)?(?:resolve|r|res|done)\b[^,)]*,\s*(\d[\d_]*)\s*\)/g
    expect(offenders(text => {
      for (const match of text.matchAll(sleep)) {
        if (Number(match[1].replaceAll('_', '')) > 100) return true
      }
      return false
    }, [
      // Waits out the panel's own 500ms poll to prove scroll-follow is released; converting it needs fake timers across the whole file.
      'modules/projects/QuestionRefinementPanel.test.tsx',
      // Waits out the view-state save debounce three times; same trade.
      'modules/graph/__tests__/GraphPage.test.tsx',
    ])).toEqual([])
  })
})
