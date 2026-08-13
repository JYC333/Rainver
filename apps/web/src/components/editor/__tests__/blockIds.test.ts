import { describe, expect, it, vi } from 'vitest'
import { Transform } from '@tiptap/pm/transform'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BLOCK_ID_ATTR, BlockIds, stripEmptyBlockIds } from '../blockIds'

/**
 * The split guard, against the real ProseMirror schema rather than a mock.
 *
 * The failure it exists for is silent: ProseMirror copies a node's attrs onto
 * the new node when Enter splits a block, so both halves would carry the same
 * id and relocating "the captured paragraph" would extract two paragraphs.
 */

function editorWith(doc: unknown): Editor {
  return new Editor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), BlockIds],
    content: doc as never,
  })
}

function ids(editor: Editor): (string | null)[] {
  const content = (editor.getJSON() as { content?: { attrs?: Record<string, unknown> }[] }).content ?? []
  const value = content.map(node => node.attrs?.[BLOCK_ID_ATTR])
  return value.map(id => (typeof id === 'string' && id ? id : null))
}

const paragraph = (text: string, blockId?: string) => ({
  type: 'paragraph',
  ...(blockId ? { attrs: { [BLOCK_ID_ATTR]: blockId } } : {}),
  content: [{ type: 'text', text }],
})

describe('block ids in the editor', () => {
  it('keeps the ids the server wrote instead of stripping them on load and save', () => {
    const editor = editorWith({ type: 'doc', content: [paragraph('Captured thought', 'server-id-1')] })
    expect(ids(editor)).toEqual(['server-id-1'])
    editor.destroy()
  })

  it('gives the new half of a split a fresh id and leaves the original anchored', () => {
    const editor = editorWith({ type: 'doc', content: [paragraph('one two', 'anchor')] })
    // Split mid-paragraph, which is what pressing Enter does.
    editor.commands.setTextSelection(4)
    editor.commands.splitBlock()

    const after = ids(editor)
    expect(after).toHaveLength(2)
    expect(after[0]).toBe('anchor')
    expect(after[1]).not.toBe('anchor')
    expect(after[1]).toBeTruthy()
    expect(new Set(after).size).toBe(2)
    editor.destroy()
  })

  it('stamps a block that has none, so a note written before ids acquires them', () => {
    const editor = editorWith({ type: 'doc', content: [paragraph('older note')] })
    // Nothing has changed the document yet, so the id arrives on the first edit
    // rather than by rewriting what was loaded.
    expect(ids(editor)).toEqual([null])
    editor.commands.insertContent(' more')
    const after = ids(editor)
    expect(after[0]).toBeTruthy()
    editor.destroy()
  })

  it('does not break the editor when stamping an id will not validate', () => {
    // Markdown can produce a block the reader displays but an attribute step
    // rejects — an image where a paragraph expects inline content. Stamping it
    // throws, and without the guard that throw takes the user's whole edit with
    // it. Losing one id is acceptable; losing the edit is not.
    //
    // The rejection is provoked at the step itself rather than by loading such a
    // document: the editor's schema has no image node, so a document containing
    // one is refused wholesale on load and never reaches this code path.
    const editor = editorWith({ type: 'doc', content: [paragraph('before')] })
    const stamping = vi.spyOn(Transform.prototype, 'setNodeAttribute').mockImplementation(() => {
      throw new RangeError('Unknown node type: image')
    })
    try {
      expect(() => editor.commands.insertContent('!')).not.toThrow()
      // The edit survived; only the id was given up.
      expect(editor.getText()).toBe('!before')
      expect(ids(editor)).toEqual([null])
    } finally {
      stamping.mockRestore()
      editor.destroy()
    }
  })

  it('repairs a duplicate id rather than leaving two blocks claiming one anchor', () => {
    const editor = editorWith({
      type: 'doc',
      content: [paragraph('first', 'shared'), paragraph('second', 'shared')],
    })
    editor.commands.insertContent('!')
    const after = ids(editor)
    expect(after[0]).toBe('shared')
    expect(after[1]).not.toBe('shared')
    expect(new Set(after).size).toBe(2)
    editor.destroy()
  })
})

describe('split at the start of a block', () => {
  it('leaves the anchor on the text, not on the empty paragraph above it', () => {
    // Cursor at position 1 is the very start of the paragraph. Pressing Enter
    // there opens a line above, so the empty half comes first in the document
    // — a position-first rule would hand it the capture's anchor and
    // relocation would extract nothing.
    const editor = editorWith({ type: 'doc', content: [paragraph('CAPTURED', 'anchor')] })
    editor.commands.setTextSelection(1)
    editor.commands.splitBlock()

    const json = editor.getJSON() as { content: { attrs?: Record<string, unknown>; content?: unknown[] }[] }
    const anchored = json.content.find(node => node.attrs?.[BLOCK_ID_ATTR] === 'anchor')
    expect(anchored).toBeTruthy()
    expect(JSON.stringify(anchored)).toContain('CAPTURED')
    expect(new Set(ids(editor)).size).toBe(2)
    editor.destroy()
  })
})

describe('undo after a split', () => {
  it('gives the anchor back to the text when the split is undone', () => {
    // Undo merges the halves back into the *first* block and takes its attrs.
    // With the guard's id move outside the history, the merge would land on the
    // freshly minted id and the capture's anchor would vanish from the note.
    const editor = editorWith({ type: 'doc', content: [paragraph('CAPTURED', 'anchor')] })
    editor.commands.setTextSelection(1)
    editor.commands.splitBlock()
    editor.commands.undo()

    expect(ids(editor)).toEqual(['anchor'])
    expect(JSON.stringify(editor.getJSON())).toContain('CAPTURED')
    editor.destroy()
  })

  it('still reverts one user gesture per undo', () => {
    const editor = editorWith({ type: 'doc', content: [paragraph('CAPTURED', 'anchor')] })
    editor.commands.setTextSelection(1)
    editor.commands.splitBlock()
    editor.commands.undo()

    // The id move is folded into the split's history event, not a step of its own.
    expect(editor.can().undo()).toBe(false)
    editor.destroy()
  })

  it('keeps the anchor when a mid-text split is undone', () => {
    const editor = editorWith({ type: 'doc', content: [paragraph('CAPTURED', 'anchor')] })
    editor.commands.setTextSelection(4)
    editor.commands.splitBlock()
    editor.commands.undo()

    expect(ids(editor)).toEqual(['anchor'])
    editor.destroy()
  })
})

describe('stripEmptyBlockIds', () => {
  it('removes the null the global attribute leaves on nested paragraphs', () => {
    const editor = editorWith({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }],
      }],
    })
    editor.commands.insertContent('!')
    const stripped = JSON.stringify(stripEmptyBlockIds(editor.getJSON()))

    expect(stripped).not.toContain('"blockId":null')
    // The top-level block keeps its id; only the nested null goes.
    expect(stripped).toContain('"bulletList","attrs":{"blockId":"')
    editor.destroy()
  })

  it('leaves a document with no ids at all untouched in shape', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }] }
    expect(stripEmptyBlockIds(doc)).toEqual(doc)
  })
})
