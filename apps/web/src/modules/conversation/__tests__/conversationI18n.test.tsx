import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunTurn } from '../../../types/api'
import i18n from '../../../i18n'
import { formatTime } from '../../../i18n/format'
import { ConversationTurn } from '../ConversationTurn'
import { OpenDiscussionDialog } from '../OpenDiscussionDialog'
import { resetLabel } from '../DiscussionGroup'

afterEach(async () => { await i18n.changeLanguage('en') })

function turnWithSteps(count: number): RunTurn {
  return {
    schema_version: 'run_turn.v1',
    run_id: 'run-1',
    state: 'done',
    source: 'run_events',
    blocked_on: null,
    cursor: count,
    updated_at: null,
    parts: [
      ...Array.from({ length: count }, (_, index) => ({
        type: 'tool_call' as const, index, call_id: `call-${index}`, name: 'read_file', kind: null,
        status: 'failed' as const, input: null, output: null,
      })),
      { type: 'text' as const, index: count, text: 'Done.' },
    ],
  } as RunTurn
}

describe('conversation surfaces in Chinese', () => {
  it('labels the discussion dialog, counts steps per plural rule, and writes times in the locale', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<OpenDiscussionDialog open agents={[{ id: 'a', name: 'Critic' }]} onClose={() => undefined} onSubmit={async () => undefined} />)
    expect(screen.getByRole('heading', { name: '发起讨论' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '主题' })).toBeInTheDocument()

    // Zero steps offer nothing to fold; one and several use the plural rule.
    const { rerender } = render(<MemoryRouter><ConversationTurn turn={turnWithSteps(0)} /></MemoryRouter>)
    expect(screen.queryByText(/显示过程/)).not.toBeInTheDocument()
    rerender(<MemoryRouter><ConversationTurn turn={turnWithSteps(1)} /></MemoryRouter>)
    expect(screen.getByText('显示过程（1 步）')).toBeInTheDocument()
    rerender(<MemoryRouter><ConversationTurn turn={turnWithSteps(3)} /></MemoryRouter>)
    expect(screen.getByText('显示过程（3 步）')).toBeInTheDocument()

    const now = new Date('2026-10-14T08:00:00Z')
    const later = '2026-10-14T09:30:00Z'
    expect(resetLabel(later, now)).toBe(formatTime(later))
    expect(resetLabel('2026-10-20T09:30:00Z', now)).toMatch(/2026年10月20日/)
  })

  it('words the quiet-runtime notice in the reader\'s language, not the server\'s', async () => {
    const quiet: RunTurn = {
      schema_version: 'run_turn.v1', run_id: 'run-1', state: 'working', source: 'host_thread_events',
      blocked_on: null, cursor: 1, updated_at: null,
      parts: [{ type: 'diagnostic', index: 0, level: 'info', text: 'server fallback', error_code: 'run_quiet' }],
    } as RunTurn
    const { rerender } = render(<MemoryRouter><ConversationTurn turn={quiet} /></MemoryRouter>)
    expect(screen.getByText(/No new output yet/)).toBeInTheDocument()
    expect(screen.queryByText('server fallback')).not.toBeInTheDocument()
    await i18n.changeLanguage('zh-CN')
    rerender(<MemoryRouter><ConversationTurn turn={{ ...quiet }} /></MemoryRouter>)
    expect(screen.getByText(/暂未收到新输出/)).toBeInTheDocument()
  })

  it('keeps English plurals distinct for one and several steps', () => {
    const { rerender } = render(<MemoryRouter><ConversationTurn turn={turnWithSteps(1)} /></MemoryRouter>)
    expect(screen.getByText('show work (1 step)')).toBeInTheDocument()
    rerender(<MemoryRouter><ConversationTurn turn={turnWithSteps(2)} /></MemoryRouter>)
    expect(screen.getByText('show work (2 steps)')).toBeInTheDocument()
  })
})
