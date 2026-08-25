// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  emptyRichTextDocument,
  normalizeRichTextDocument,
  plainTextToRichTextDocument,
  richTextSnapshotFromDocument,
} from '../document'

describe('rich text document helpers', () => {
  it('wraps stored plain text in editor JSON', () => {
    expect(plainTextToRichTextDocument('First paragraph\n\nSecond paragraph')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      ],
    })
  })

  it('prefers valid structured content over fallback text', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] }
    expect(normalizeRichTextDocument(doc, 'fallback text')).toBe(doc)
  })

  it('falls back to an empty document for blank content', () => {
    expect(plainTextToRichTextDocument('   ')).toEqual(emptyRichTextDocument())
  })

  it('creates the storage snapshot used by note writes', () => {
    const doc = emptyRichTextDocument()
    expect(richTextSnapshotFromDocument(doc)).toEqual({
      content_json: doc,
      content_format: 'prosemirror_json',
      content_schema_version: 1,
    })
  })
})
