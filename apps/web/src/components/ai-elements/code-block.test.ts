// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    getLoadedLanguages: () => ['text'],
    codeToTokens: (code: string) => ({
      bg: '#000',
      fg: '#fff',
      tokens: code.split('\n').map(line => [{ content: line, color: 'inherit' }]),
    }),
  }),
}))
vi.mock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }))

import { highlightCode } from './code-block'

describe('highlightCode token cache', () => {
  it('never answers one block with the tokens of another whose text differs only in the middle', async () => {
    // Two tool results of the same shape: same length, same first and last
    // hundred characters, a different id in between. The second must not be
    // shown with the first one's id.
    const pad = 'x'.repeat(100)
    const first = `${pad}\nid: 11111111\n${pad}`
    const second = `${pad}\nid: 22222222\n${pad}`
    expect(first.length).toBe(second.length)

    const highlighted = await new Promise<{ tokens: Array<Array<{ content: string }>> }>(resolve => {
      const sync = highlightCode(first, 'text', resolve)
      if (sync) resolve(sync)
    })
    expect(highlighted.tokens.flat().map(token => token.content).join('\n')).toContain('id: 11111111')

    // Either not cached yet (null) or, once highlighted, its own text.
    const cachedForSecond = highlightCode(second, 'text')
    const shown = cachedForSecond?.tokens.flat().map(token => token.content).join('\n') ?? ''
    expect(shown).not.toContain('id: 11111111')
  })
})
