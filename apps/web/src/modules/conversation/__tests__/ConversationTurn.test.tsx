import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RunTurn, TurnPart } from '../../../types/api'
import { ConversationTurn } from '../ConversationTurn'

// `SpaceLink` resolves a logical path against the active Space; the turn's
// links are in-space destinations, so the context has to exist.
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1', userId: 'user-1' }),
}))

function turn(state: RunTurn['state'], parts: TurnPart[], blockedOn: RunTurn['blocked_on'] = null): RunTurn {
  return {
    schema_version: 'run_turn.v1',
    run_id: 'run-1',
    state,
    source: 'run_events',
    parts,
    blocked_on: blockedOn,
    cursor: parts.length,
    updated_at: null,
  }
}

const tool = (index: number, name: string, status: 'running' | 'succeeded' | 'failed'): TurnPart =>
  ({ type: 'tool_call', index, call_id: `c${index}`, name, kind: null, status, input: null, output: null })

function show(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

describe('ConversationTurn — the states of D3', () => {
  it('working: shows the steps as they happen, with the text after them', () => {
    show(<ConversationTurn turn={turn('working', [
      tool(0, 'search', 'succeeded'),
      { type: 'text', index: 1, text: 'Looking at the results.' },
    ])} />)
    expect(screen.getByText('search')).toBeInTheDocument()
    expect(screen.getByText('Looking at the results.')).toBeInTheDocument()
    expect(screen.queryByText(/show work/)).not.toBeInTheDocument()
  })

  it('renders assistant messages, thought and tools in protocol order', () => {
    const { container } = show(<ConversationTurn turn={turn('working', [
      { type: 'text', index: 0, text: 'I will inspect.' },
      tool(1, 'read', 'succeeded'),
      { type: 'reasoning', index: 2, text: 'Checking details.' },
      { type: 'text', index: 3, text: 'Done.' },
    ])} />)
    const text = container.textContent ?? ''
    expect(text.indexOf('I will inspect.')).toBeLessThan(text.indexOf('read'))
    expect(text.indexOf('read')).toBeLessThan(text.indexOf('Thought for a few seconds'))
    expect(text.indexOf('Thought for a few seconds')).toBeLessThan(text.indexOf('Done.'))
  })

  it('done: the reply is the bubble, and the work folds into one line', () => {
    show(<ConversationTurn turn={turn('done', [
      tool(0, 'search', 'succeeded'),
      tool(1, 'read', 'succeeded'),
      { type: 'text', index: 2, text: 'Found three.' },
    ])} />)
    expect(screen.getByText('Found three.')).toBeInTheDocument()
    expect(screen.getByText('show work (2 steps)')).toBeInTheDocument()
    expect(screen.queryByText('search')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('show work (2 steps)'))
    expect(screen.getByText('search')).toBeInTheDocument()
    expect(screen.getByText('hide work')).toBeInTheDocument()
  })

  it('done: counts one step in the singular', () => {
    show(<ConversationTurn turn={turn('done', [
      tool(0, 'search', 'succeeded'),
      { type: 'text', index: 1, text: 'Done.' },
    ])} />)
    expect(screen.getByText('show work (1 step)')).toBeInTheDocument()
  })

  it('failed: the bubble carries the failure, and the steps stay open', () => {
    show(<ConversationTurn turn={turn('failed', [
      tool(0, 'write', 'failed'),
      { type: 'diagnostic', index: 1, level: 'error', text: 'Upstream refused.', error_code: 'provider_unavailable' },
    ])} />)
    expect(screen.getByText('Upstream refused.')).toBeInTheDocument()
    expect(screen.getByText('write')).toBeInTheDocument()
    expect(screen.queryByText(/show work/)).not.toBeInTheDocument()
  })

  it('blocked: says what it is waiting for, and where to go', () => {
    show(<ConversationTurn
      turn={turn('blocked', [tool(0, 'write_file', 'succeeded')], 'authorization')}
      runHref="/runs/run-1"
    />)
    expect(screen.getByText('approval needed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review request' })).toBeInTheDocument()
  })

  it('blocked on a supervisor decision reads differently from an approval', () => {
    show(<ConversationTurn turn={turn('blocked', [], 'run_decision')} runHref="/runs/run-1" />)
    expect(screen.getByText('waiting for a decision')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Resolve Run' })).toBeInTheDocument()
  })

  it('leaves out what a backend did not report, and shows what it did', () => {
    const reported: TurnPart = {
      type: 'tool_call', index: 0, call_id: 'c0', name: 'read', kind: null,
      status: 'succeeded', input: 'path=/a.ts, limit=100', output: '42 lines',
    }
    const { container } = show(
      <ConversationTurn turn={turn('done', [reported, { type: 'text', index: 1, text: 'Done.' }])} />)
    fireEvent.click(screen.getByText('show work (1 step)'))
    // A tool call's detail is expandable, as D3 asks — so open it.
    fireEvent.click(screen.getByText('read'))
    // Shown as the runtime summarised it — the code block tokenizes, so this
    // reads the whole text. Serialising a summary as JSON would wrap it in
    // quotes and escape it, which is what the AI SDK's object assumption does
    // to this repository's summary strings.
    expect(container.textContent).toContain('path=/a.ts, limit=100')
    expect(container.textContent).not.toContain('"path=/a.ts, limit=100"')

    cleanup()
    // A managed backend reports the name and the status but neither input nor
    // output, so those sections are absent rather than rendered blank.
    show(<ConversationTurn turn={turn('done', [
      tool(0, 'search', 'succeeded'),
      { type: 'text', index: 1, text: 'Done.' },
    ])} />)
    fireEvent.click(screen.getByText('show work (1 step)'))
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /search/i })).not.toBeInTheDocument()
  })

  it('does not append run navigation to a completed conversation turn', () => {
    show(<ConversationTurn turn={turn('done', [{ type: 'text', index: 0, text: 'Done.' }])} runHref="/runs/run-1" />)
    expect(screen.queryByRole('link', { name: /Open run/i })).not.toBeInTheDocument()
  })
})
