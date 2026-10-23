import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationInputPart } from '@rainver/protocol'
import { capabilitiesFrameworkApi } from '../../api/client'
import { ConversationView } from './ConversationView'

vi.mock('../../api/client', async original => ({
  ...await original<typeof import('../../api/client')>(),
  capabilitiesFrameworkApi: { availableSkills: vi.fn() },
}))
const skill = { kind: 'skill' as const, skill_package_id: 'skill-1', package_hash: 'a'.repeat(64), display_name: 'Audit' }
function Harness({ initialText = '', initialParts = [] }: { initialText?: string; initialParts?: ConversationInputPart[] }) {
  const [text, setText] = useState(initialText)
  const [parts, setParts] = useState<ConversationInputPart[]>(initialParts)
  const [sent, setSent] = useState<unknown>(null)
  return <>
    <ConversationView entries={[]} sending={false} loadingHistory={false} input={text} onInputChange={setText}
      onSend={() => setSent({ text, parts })} placeholder="Message" emptyTitle="Start" emptyDescription="Choose a Skill"
      inputParts={parts} onInputPartsChange={setParts} skillAgentId="agent-1" sessionId="session-1" />
    <output data-testid="parts">{JSON.stringify(parts)}</output>
    <output data-testid="sent">{JSON.stringify(sent)}</output>
  </>
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(capabilitiesFrameworkApi.availableSkills).mockResolvedValue([skill])
})
describe('direct conversation Skill selection', () => {
  it.each(['/', '@'])('selects and removes an immutable Skill through %s', async trigger => {
    render(<Harness />)
    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: `${trigger}Aud`, selectionStart: 4 } })
    await screen.findByRole('option', { name: /Audit/ })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor).toHaveValue('/Audit ')
    expect(JSON.parse(screen.getByTestId('parts').textContent!)).toEqual([skill])
    expect(screen.queryByRole('button', { name: 'Remove Audit' })).not.toBeInTheDocument()
    fireEvent.change(editor, { target: { value: '' } })
    expect(screen.getByTestId('parts')).toHaveTextContent('[]')
    expect(capabilitiesFrameworkApi.availableSkills).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', agent_id: 'agent-1' }), expect.anything(),
    )
  })
  it('inserts at the caret, retains surrounding text and sends the pinned selection', async () => {
    render(<Harness />)
    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    const before = 'Before '
    fireEvent.change(editor, { target: { value: `${before}/Aud after`, selectionStart: before.length + 4 } })
    fireEvent.click(await screen.findByRole('option', { name: /Audit/ }))
    expect(editor).toHaveValue('Before /Audit after')
    expect(editor.selectionStart).toBe('Before /Audit'.length)
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(JSON.parse(screen.getByTestId('sent').textContent!)).toEqual({ text: 'Before /Audit after', parts: [skill] })
    // Editing it into a different name must not retain the old package selection.
    fireEvent.change(editor, { target: { value: 'Before /Auditor after' } })
    expect(JSON.parse(screen.getByTestId('parts').textContent!)).toEqual([])
  })
  it('highlights a selected reference and deletes it as one token', async () => {
    const { container } = render(<Harness />)
    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Run /Aud now', selectionStart: 'Run /Aud'.length } })
    fireEvent.click(await screen.findByRole('option', { name: /Audit/ }))
    expect(container.querySelector('mark[data-skill-reference]')).toHaveTextContent('/Audit')
    editor.setSelectionRange('Run /Audit'.length, 'Run /Audit'.length)
    fireEvent.keyDown(editor, { key: 'Backspace' })
    expect(editor).toHaveValue('Run  now')
    expect(editor.selectionStart).toBe('Run '.length)
    expect(JSON.parse(screen.getByTestId('parts').textContent!)).toEqual([])
    expect(container.querySelector('mark[data-skill-reference]')).toBeNull()
  })
  it('makes selections in an older draft visible inline without selecting typed lookalikes', async () => {
    render(<Harness initialText="Review this" initialParts={[skill]} />)
    const editor = screen.getByPlaceholderText('Message')
    await waitFor(() => expect(editor).toHaveValue('Review this /Audit'))
    fireEvent.change(editor, { target: { value: '' } })
    fireEvent.change(editor, { target: { value: '/Audit' } })
    await screen.findByRole('option', { name: /Audit/ })
    expect(JSON.parse(screen.getByTestId('parts').textContent!)).toEqual([])
  })
  it('keeps selection pending during IME input and Shift+Enter', async () => {
    render(<Harness />)
    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: '/Aud', selectionStart: 4 } })
    await screen.findByRole('option', { name: /Audit/ })
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('parts')).toHaveTextContent('[]')
    fireEvent.keyDown(editor, { key: 'Tab' })
    await waitFor(() => expect(JSON.parse(screen.getByTestId('parts').textContent!)).toEqual([skill]))
  })
})
