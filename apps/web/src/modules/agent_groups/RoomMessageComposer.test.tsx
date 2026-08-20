import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RoomMessageComposer, emptyRoomMessageComposerValue } from './RoomMessageComposer'

// Enter=send / Shift+Enter=newline is a system-wide default (see sibling
// composers' own keydown tests where they exist). This is the trickiest of
// the five composers to verify: it's a TipTap/ProseMirror editor, not a plain
// textarea, so Shift+Enter's newline has to fall through to StarterKit's
// HardBreak keymap rather than being handled by native textarea behavior.
function Harness() {
  const [value, setValue] = useState(emptyRoomMessageComposerValue())
  const [submitCount, setSubmitCount] = useState(0)
  return (
    <>
      <RoomMessageComposer
        value={value}
        onChange={setValue}
        agents={[]}
        members={[]}
        disabled={false}
        resetToken={0}
        onSubmit={() => setSubmitCount(count => count + 1)}
      />
      <div data-testid="submit-calls">{submitCount}</div>
    </>
  )
}

async function getEditor() {
  await screen.findByText('Message...', {}, { timeout: 5000 })
  return document.querySelector('.ProseMirror') as HTMLElement
}

describe('RoomMessageComposer keyboard behavior', () => {
  it('sends on plain Enter', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.getByTestId('submit-calls').textContent).toBe('1'))
  })

  it('does not send on Shift+Enter (inserts a hard break instead)', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')
    expect(editor.querySelectorAll('br').length).toBeGreaterThan(0)
  })

  it('does not send while IME composition is in progress (isComposing or keyCode 229)', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, isComposing: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, keyCode: 229, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')
  })

  it('still sends on a normal Enter after a composition ends', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, isComposing: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.getByTestId('submit-calls').textContent).toBe('1'))
  })
})
