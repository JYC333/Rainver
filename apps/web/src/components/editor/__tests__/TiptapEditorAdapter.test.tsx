import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TiptapEditorAdapter } from '../TiptapEditorAdapter'

const { setContentSpy, editorStub, liveDocRef } = vi.hoisted(() => {
  const setContentSpy = vi.fn()
  const liveDocRef: { current: unknown } = { current: { type: 'doc', content: [] } }
  const editorStub = {
    commands: { setContent: setContentSpy, focus: vi.fn() },
    chain: () => ({ focus: () => ({ toggleBold: () => ({ run: vi.fn() }), toggleItalic: () => ({ run: vi.fn() }), toggleStrike: () => ({ run: vi.fn() }), setParagraph: () => ({ run: vi.fn() }), toggleHeading: () => ({ run: vi.fn() }), toggleBulletList: () => ({ run: vi.fn() }), toggleOrderedList: () => ({ run: vi.fn() }), toggleBlockquote: () => ({ run: vi.fn() }), toggleCode: () => ({ run: vi.fn() }), undo: () => ({ run: vi.fn() }), redo: () => ({ run: vi.fn() }) }) }),
    can: () => ({ undo: () => false, redo: () => false }),
    isActive: () => false,
    getJSON: () => liveDocRef.current,
  }
  return { setContentSpy, editorStub, liveDocRef }
})

vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>()
  return {
    ...actual,
    useEditor: () => editorStub,
    EditorContent: () => <div>editor surface</div>,
  }
})

const docA = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original claim' }] }] }
const docB = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Different content' }] }] }

function Harness({ content }: { content: unknown }) {
  const [rerenderCount, setRerenderCount] = useState(0)
  // A fresh object reference every render, but byte-identical JSON to
  // `content` — exactly what a parent re-render (e.g. an unrelated
  // workspace refetch) produces even when nothing actually changed.
  const initialContent = JSON.parse(JSON.stringify(content))
  return (
    <div>
      <button onClick={() => setRerenderCount((c) => c + 1)}>Rerender {rerenderCount}</button>
      <TiptapEditorAdapter initialContent={initialContent} variant="notes" />
    </div>
  )
}

describe('TiptapEditorAdapter', () => {
  it('does not re-apply content on an unrelated re-render that only produces a new (but equal) initialContent reference', async () => {
    setContentSpy.mockClear()
    const { rerender } = render(<Harness content={docA} />)
    expect(setContentSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: /Rerender/ }))
    rerender(<Harness content={docA} />)

    // Same content, new object reference both times — must not re-apply.
    expect(setContentSpy).toHaveBeenCalledTimes(1)
  })

  it('still re-applies content when it actually changes', async () => {
    setContentSpy.mockClear()
    liveDocRef.current = { type: 'doc', content: [] }
    const { rerender } = render(<Harness content={docA} />)
    expect(setContentSpy).toHaveBeenCalledTimes(1)

    rerender(<Harness content={docB} />)
    expect(setContentSpy).toHaveBeenCalledTimes(2)
  })

  it('does not reset the cursor by calling setContent when the live document already equals the new initialContent (e.g. a caller re-confirming what it just saved)', () => {
    setContentSpy.mockClear()
    // The live editor is already showing docB's content (the user typed it,
    // or a caller like NotebookSectionCard is re-deriving `initialContent`
    // from what it just captured via getSnapshot) — a caller passing a
    // *different object* representing that same content must not trigger a
    // pointless reset that would otherwise jump the cursor to the document end.
    liveDocRef.current = JSON.parse(JSON.stringify(docB))
    const { rerender } = render(<Harness content={docA} />)
    setContentSpy.mockClear()

    rerender(<Harness content={docB} />)
    expect(setContentSpy).not.toHaveBeenCalled()
  })
})
