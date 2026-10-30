import { describe, expect, it } from 'vitest';
import { readerContentFromFetchedText } from '../src/modules/sources/contentParsing.js';
import { normalizeReaderText } from '../src/modules/reader/repository.js';

// The canonical text the Reader's annotation tests use
// (apps/web/src/components/reader/__tests__/anchorCreation.test.tsx): if the
// server's text for these Markdown inputs changes, those fixtures must too.
const L = 'Long repeated paragraph '.repeat(5).trim();
const FIXTURES: Record<string, { markdown: string; canonical: string }> = {
  code: { markdown: '```\n    x\n```\n\nQ\n\ngap\n\nQ', canonical: 'x Q gap Q' },
  list: { markdown: '- Same item\n  - Same item\n- Other item', canonical: 'Same item Same item\nOther item' },
  table: { markdown: '| A | B |\n|---|---|\n| Same | Same |', canonical: 'A | B\nSame | Same' },
  emoji: { markdown: '🙂 Q\n\nmiddle\n\n🙂 Q', canonical: '🙂 Q middle 🙂 Q' },
  long: { markdown: `${L}\n\nQ\n\n${L}\n\nQ\n\n${L}`, canonical: [L, 'Q', L, 'Q', L].join(' ') },
  tableEscaped: { markdown: '| X | Y |\n|---|---|\n| A \\| | B |\n| A | B |', canonical: 'X | Y\nA | | B\nA | B' },
  codeCopy: { markdown: '```\ndef f():\n    return 1\n```', canonical: 'def f():\n    return 1' },
};

describe('canonical Reader text of Markdown inputs used by the annotation tests', () => {
  it.each(Object.entries(FIXTURES))('%s', (_name, { markdown, canonical }) => {
    const content = readerContentFromFetchedText(markdown, 'text/markdown', 'https://example.test/a.md');
    expect(normalizeReaderText(content.plain_text)).toBe(canonical);
  });
});
