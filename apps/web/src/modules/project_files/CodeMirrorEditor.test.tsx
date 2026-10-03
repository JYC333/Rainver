import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
