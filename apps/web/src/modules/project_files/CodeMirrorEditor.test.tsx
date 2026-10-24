import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeMirrorEditor } from './CodeMirrorEditor'

describe('CodeMirrorEditor', () => {
  it('mounts one accessible editable view and handles the save shortcut', () => {
    const onSave = vi.fn()
    render(<CodeMirrorEditor value="const answer = 42" language="javascript" onSave={onSave} />)
    const editor = screen.getByRole('textbox', { name: 'File content' })
    expect(editor).toHaveAttribute('contenteditable', 'true')
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('switches color mode without losing edits, selection or undo history', () => {
    const { rerender } = render(<CodeMirrorEditor value="original" colorMode="dark" />)
    const textbox = screen.getByRole('textbox', { name: 'File content' })
    const view = EditorView.findFromDOM(textbox.closest('.cm-editor')!)!
    act(() => { view.dispatch({ changes: { from: 8, insert: ' edited' }, selection: { anchor: 3 } }) })
    expect(view.state.facet(EditorView.darkTheme)).toBe(true)
    rerender(<CodeMirrorEditor value="original" colorMode="light" />)
    expect(screen.getByRole('textbox', { name: 'File content' })).toBe(textbox)
    expect(view.state.facet(EditorView.darkTheme)).toBe(false)
    expect(view.state.doc.toString()).toBe('original edited')
    expect(view.state.selection.main.anchor).toBe(3)
    act(() => { undo(view) })
    expect(view.state.doc.toString()).toBe('original')
  })

  it('renders read-only content without exposing an editable surface', () => {
    render(<CodeMirrorEditor value="binary preview unavailable" readOnly ariaLabel="Read-only file" />)
    expect(screen.getByRole('textbox', { name: 'Read-only file' })).toHaveAttribute('contenteditable', 'false')
  })

  it('keeps syntax highlighting when the view is rebuilt for a read-only switch', async () => {
    const highlightedToken = () => screen.getByRole('textbox', { name: 'File content' }).querySelector('.cm-line span[class]')
    const { rerender } = render(<CodeMirrorEditor value="const answer = 42" language="javascript" />)
    await waitFor(() => expect(highlightedToken()).not.toBeNull())

    rerender(<CodeMirrorEditor value="const answer = 42" language="javascript" readOnly />)
    expect(screen.getByRole('textbox', { name: 'File content' })).toHaveAttribute('contenteditable', 'false')
    await waitFor(() => expect(highlightedToken()).not.toBeNull(), { timeout: 3000 })
  })
})
