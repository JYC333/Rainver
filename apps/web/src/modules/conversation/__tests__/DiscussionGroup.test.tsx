import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  DiscussionGroup,
  DiscussionNoticeCard,
  groupDiscussionMessages,
  resetLabel,
} from '../DiscussionGroup'
import { OpenDiscussionDialog } from '../OpenDiscussionDialog'
import { ConversationQuotaLine } from '../ConversationQuotaLine'
import type { RoomDiscussion, RoomMessage } from '../../../types/api'

const agents = [
  { id: 'agent-manager', name: 'Manager' },
  { id: 'agent-critic', name: 'Critic' },
  { id: 'agent-builder', name: 'Builder' },
]

function message(id: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id,
    space_id: 'space-1',
    session_id: 'session-1',
    user_id: null,
    sender_agent_id: 'agent-critic',
    role: 'assistant',
    content: `Message ${id}`,
    metadata_json: {},
    created_at: '2026-09-24T10:00:00.000Z',
    ...overrides,
  } as RoomMessage
}

/** An Agent a reply addressed, waiting at the cap: what adding rounds continues with. */
const held = { agent_id: 'agent-builder', from_agent_ids: ['agent-lead'], content: 'Check the numbers.' }

function discussion(overrides: Partial<RoomDiscussion> = {}): RoomDiscussion {
  return {
    id: 'disc-1',
    room_id: 'room-1',
    session_id: 'session-1',
    kind: 'explicit',
    shape: 'open',
    status: 'active',
    stop_reason: null,
    topic: 'Pick a database',
    opened_by_user_id: 'user-1',
    origin_message_id: 'm-topic',
    participant_agent_ids: ['agent-critic', 'agent-builder'],
    round_cap: 3,
    rounds_used: 1,
    round_base: 0,
    turns_used: 2,
    spend_cap_usd: null,
    spend_usd: 0,
    held_mentions: [],
    conclusion_message_id: null,
    quota_override_by_user_id: null,
    created_at: '2026-09-24T10:00:00.000Z',
    updated_at: '2026-09-24T10:00:00.000Z',
    ...overrides,
  }
}

describe('groupDiscussionMessages', () => {
  it('marks consecutive discussion stretches without changing the timeline order', () => {
    const items = groupDiscussionMessages([
      message('m-before', { discussion_id: null }),
      // An emergent discussion's origin: the person's message, named by the row.
      message('m-origin', { role: 'user', sender_agent_id: null }),
      message('m-reply', { discussion_id: 'disc-1' }),
      message('m-other', { discussion_id: null }),
      message('m-notice', {
        role: 'system',
        metadata_json: {
          room_display: 'system_notice',
          discussion_notice: { discussion_id: 'disc-1', kind: 'cap_reached', reason: 'round_cap', agent_ids: [] },
        },
      }),
    ], { 'disc-1': discussion({ kind: 'emergent', origin_message_id: 'm-origin' }) })

    // The notice came after an unrelated message, so it is a later block of
    // the same discussion rather than pulled up above that message.
    expect(items.map(item => item.kind === 'message' ? item.message.id : `${item.discussionId}#${item.segment}`))
      .toEqual(['m-before', 'disc-1#0', 'm-other', 'disc-1#1'])
    const first = items[1]
    expect(first?.kind === 'discussion' && first.messages.map(item => item.id)).toEqual(['m-origin', 'm-reply'])
    const later = items[3]
    expect(later?.kind === 'discussion' && later.messages.map(item => item.id)).toEqual(['m-notice'])
  })
})

describe('DiscussionGroup', () => {
  it('heads the group with topic, participants, rounds and status, and stops it', async () => {
    const onStop = vi.fn().mockResolvedValue(undefined)
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion()}
        messages={[message('m-topic', { role: 'user', content: 'Pick a database' })]}
        agents={agents}
        onStop={onStop}
        onExtend={vi.fn()}
      >
        <p>Inside the discussion</p>
      </DiscussionGroup>,
    )
    const group = screen.getByTestId('discussion-disc-1')
    expect(within(group).getByText('Pick a database')).toBeInTheDocument()
    expect(within(group).getByText(/Critic, Builder · Round 1\/3 · In progress/)).toBeInTheDocument()
    expect(within(group).getByText('Inside the discussion')).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: /Add .* rounds/ })).not.toBeInTheDocument()

    fireEvent.click(within(group).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(onStop).toHaveBeenCalledWith('disc-1'))
  })

  it('marks a later stretch as a continuation without duplicating actions', () => {
    render(<DiscussionGroup discussionId="disc-1" segment={1} latest={false}
      discussion={discussion()} messages={[message('m-later')]} agents={agents} onStop={vi.fn()}>
      <p>Reply after an ordinary interjection</p>
    </DiscussionGroup>)
    const segment = screen.getByTestId('discussion-disc-1-1')
    expect(within(segment).getByText('Discussion continues · Pick a database')).toBeInTheDocument()
    expect(within(segment).getByText('Reply after an ordinary interjection')).toBeInTheDocument()
    expect(within(segment).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('offers more rounds once the cap is reached, sized to the shape', async () => {
    const onExtend = vi.fn().mockResolvedValue(undefined)
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion({ status: 'cap_reached', shape: 'debate', round_cap: 2, rounds_used: 2 })}
        messages={[]}
        agents={agents}
        onStop={vi.fn()}
        onExtend={onExtend}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    // Stopped at its cap it can still be ended for good.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 rounds' }))
    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('disc-1', 2))
  })

  it('offers no more rounds when nothing waits to continue', () => {
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion({ status: 'cap_reached', shape: 'open', held_mentions: [] })}
        messages={[]}
        agents={agents}
        onStop={vi.fn()}
        onExtend={vi.fn()}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    expect(screen.queryByRole('button', { name: /Add \d+ rounds/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('names an emergent discussion by its first message, and offers to open it at the cap', () => {
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion({ kind: 'emergent', topic: null, status: 'cap_reached', round_cap: 1, held_mentions: [held] })}
        messages={[message('m-origin', { role: 'user', content: 'Should we cache this?' })]}
        agents={agents}
        onStop={vi.fn()}
        onExtend={vi.fn()}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    expect(screen.getByText('Should we cache this?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open a discussion' })).toBeInTheDocument()
  })

  it('shows one cost line per funding source, and continues past the subscription reserve line', async () => {
    const resetsAt = '2026-09-24T19:40:00.000Z'
    const onContinueAnyway = vi.fn().mockResolvedValue(undefined)
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion({ spend_cap_usd: 2 })}
        detail={{
          usage: {
            priced_usd: 0.42,
            subscription: [
              { account_label: 'Claude Code · Server', tokens: 12400, window: { kind: 'session', utilization: 88, resets_at: resetsAt } },
              { account_label: 'Codex CLI · Laptop', tokens: 900, window: null },
            ],
          },
          quota_hold: { account_label: 'Claude Code · Server', window: 'session', resets_at: resetsAt, run_ids: ['run-1'], can_continue: true },
        }}
        warnPct={70}
        messages={[]}
        agents={agents}
        onStop={vi.fn()}
        onExtend={vi.fn()}
        onContinueAnyway={onContinueAnyway}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    const lines = within(screen.getByTestId('discussion-cost-disc-1')).getAllByRole('listitem')
    expect(lines.map(line => line.textContent)).toEqual([
      'Priced models · $0.42 of $2.00',
      `Claude Code · Server · ${(12400).toLocaleString()} tokens here · account at 88% of its 5-hour window (resets ${resetLabel(resetsAt)})`,
      'Codex CLI · Laptop · 900 tokens here',
    ])
    // Past the Space's warning line the account's line is marked.
    expect(lines[1]!.className).toContain('amber')
    expect(lines[2]!.className).not.toContain('amber')

    const hold = screen.getByTestId('discussion-quota-hold-disc-1')
    expect(hold).toHaveTextContent(`Waiting for the window (resets ${resetLabel(resetsAt)})`)
    fireEvent.click(within(hold).getByRole('button', { name: 'continue anyway' }))
    await waitFor(() => expect(onContinueAnyway).toHaveBeenCalledTimes(1))
  })

  it("says whose window a discussion waits for when the viewer may not spend that login", () => {
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion()}
        detail={{
          usage: { priced_usd: 0, subscription: [] },
          quota_hold: { account_label: 'Claude Code · Member laptop', window: 'session', resets_at: null, run_ids: ['run-1'], can_continue: false },
        }}
        messages={[]}
        agents={agents}
        onStop={vi.fn()}
        onContinueAnyway={vi.fn()}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    const hold = screen.getByTestId('discussion-quota-hold-disc-1')
    expect(hold).toHaveTextContent("Waiting for Claude Code · Member laptop's window")
    expect(within(hold).queryByRole('button', { name: 'continue anyway' })).not.toBeInTheDocument()
  })

  it('shows no cost lines before the detail is read, and no hold when nothing waits', () => {
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion()}
        detail={{ usage: { priced_usd: 0, subscription: [] }, quota_hold: null }}
        messages={[]}
        agents={agents}
        onStop={vi.fn()}
        onExtend={vi.fn()}
        onContinueAnyway={vi.fn()}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    expect(screen.queryByTestId('discussion-cost-disc-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('discussion-quota-hold-disc-1')).not.toBeInTheDocument()
  })

  it('keeps a concluded discussion visible in the timeline without auto-folding', () => {
    render(
      <DiscussionGroup
        discussionId="disc-1"
        discussion={discussion({ status: 'closed', rounds_used: 2, conclusion_message_id: 'm-conclusion' })}
        messages={[
          message('m-topic', { role: 'user', content: 'Pick a database' }),
          message('m-conclusion', { sender_agent_id: 'agent-manager', content: 'Both agree on Postgres.' }),
        ]}
        agents={agents}
        onStop={vi.fn()}
        onExtend={vi.fn()}
      >
        <p>Inside</p>
      </DiscussionGroup>,
    )
    expect(screen.getByTestId('discussion-conclusion-disc-1')).toHaveTextContent('Conclusion: Both agree on Postgres.')
    expect(screen.getByText(/Round 2\/3 · Concluded/)).toBeInTheDocument()
    expect(screen.getByText('Inside')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByTestId('discussion-disc-1')).not.toHaveAttribute('aria-expanded')
  })
})

describe('DiscussionNoticeCard', () => {
  // As the server writes it: the reason is a code, the words are the message's.
  const capNotice = message('m-notice', {
    role: 'system',
    content: 'The round cap of 3 was reached. Builder is waiting to continue.',
    metadata_json: {
      room_display: 'system_notice',
      discussion_notice: { discussion_id: 'disc-1', kind: 'cap_reached', reason: 'round_cap', agent_ids: ['agent-builder'] },
    },
  })

  it('continues a discussion held at its cap', async () => {
    const onExtend = vi.fn().mockResolvedValue(undefined)
    render(
      <DiscussionNoticeCard
        message={capNotice}
        notice={{ discussion_id: 'disc-1', kind: 'cap_reached', reason: 'round_cap', agent_ids: ['agent-builder'] }}
        discussion={discussion({ status: 'cap_reached', held_mentions: [held] })}
        agents={agents}
        onExtend={onExtend}
      />,
    )
    expect(screen.getByText('Round cap reached')).toBeInTheDocument()
    expect(screen.getByText('The round cap of 3 was reached. Builder is waiting to continue.')).toBeInTheDocument()
    expect(screen.queryByText('round_cap')).not.toBeInTheDocument()
    expect(screen.getByText('Builder')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 rounds' }))
    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('disc-1', 3))
  })

  it('offers nothing once the discussion has moved on', () => {
    render(
      <DiscussionNoticeCard
        message={capNotice}
        notice={{ discussion_id: 'disc-1', kind: 'cap_reached', reason: 'round_cap', agent_ids: [] }}
        discussion={discussion({ status: 'active' })}
        agents={agents}
        onExtend={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('names the cap that stopped it, in the card and the header', () => {
    render(
      <DiscussionNoticeCard
        message={message('m-spend', { role: 'system', content: 'The spend cap of $2.00 was reached.' })}
        notice={{ discussion_id: 'disc-1', kind: 'cap_reached', reason: 'spend_cap', agent_ids: [] }}
        discussion={discussion({ status: 'cap_reached', stop_reason: 'spend_cap' })}
        agents={agents}
        onExtend={vi.fn()}
      />,
    )
    expect(screen.getByText('Spend cap reached')).toBeInTheDocument()
    expect(screen.getByText('The spend cap of $2.00 was reached.')).toBeInTheDocument()
  })

  it('explains a subscription refusal in its own words, and still offers to continue', () => {
    const refusal = message('m-refusal', {
      role: 'system',
      content: 'Claude Code · Server refused: its usage limit is reached. The window resets 19:40 UTC.',
    })
    render(
      <DiscussionNoticeCard
        message={refusal}
        notice={{ discussion_id: 'disc-1', kind: 'cap_reached', reason: 'quota_exhausted', agent_ids: [], resets_at: '2026-09-24T19:40:00.000Z' }}
        discussion={discussion({ status: 'cap_reached' })}
        agents={agents}
        onExtend={vi.fn()}
      />,
    )
    expect(screen.getByText('Subscription limit reached')).toBeInTheDocument()
    expect(screen.getByText(/usage limit is reached/)).toBeInTheDocument()
    expect(screen.queryByText('quota_exhausted')).not.toBeInTheDocument()
  })

  it('names an Agent that was not admitted, with the reason and no action', () => {
    render(
      <DiscussionNoticeCard
        message={capNotice}
        notice={{ discussion_id: 'disc-1', kind: 'not_admitted', reason: 'Builder answers only its owner.', agent_ids: ['agent-builder'] }}
        discussion={discussion({ status: 'cap_reached' })}
        agents={agents}
        onExtend={vi.fn()}
      />,
    )
    expect(screen.getByText('Not admitted')).toBeInTheDocument()
    expect(screen.getByText('Builder answers only its owner.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('OpenDiscussionDialog', () => {
  const six = Array.from({ length: 6 }, (_, index) => ({ id: `agent-${index + 1}`, name: `Agent ${index + 1}` }))

  it('refuses more participants than a discussion seats, naming the count', async () => {
    const onSubmit = vi.fn()
    render(<OpenDiscussionDialog open agents={six} onClose={vi.fn()} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open discussion' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Say what the discussion is about.')

    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Pick a database' } })
    fireEvent.click(screen.getByLabelText('All Agents'))
    fireEvent.click(screen.getByRole('button', { name: 'Open discussion' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This Room has 6 active Agents; a discussion seats at most 5.')

    fireEvent.click(screen.getByLabelText('All Agents'))
    for (const agent of six) fireEvent.click(screen.getByLabelText(agent.name))
    fireEvent.click(screen.getByRole('button', { name: 'Open discussion' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('6 Agents are selected; a discussion seats at most 5.')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends the chosen bounds, with the round cap following the shape until edited', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<OpenDiscussionDialog open agents={six.slice(0, 3)} onClose={vi.fn()} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: '  Pick a database  ' } })
    fireEvent.click(screen.getByLabelText('All Agents'))
    fireEvent.click(screen.getByLabelText(/Debate/))
    expect(screen.getByLabelText('Rounds')).toHaveValue(2)
    fireEvent.change(screen.getByLabelText('Spend cap (USD, optional)'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open discussion' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      topic: 'Pick a database',
      participant_agent_ids: 'all',
      shape: 'debate',
      round_cap: 2,
      spend_cap_usd: 1.5,
    }))
  })

  it('keeps the dialog open with the server\'s reason when opening is refused', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('A discussion is already running: Pick a database'))
    render(<OpenDiscussionDialog open agents={six.slice(0, 2)} onClose={vi.fn()} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Another topic' } })
    fireEvent.click(screen.getByLabelText('Agent 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Open discussion' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A discussion is already running: Pick a database')
    expect(onSubmit).toHaveBeenCalledWith({
      topic: 'Another topic', participant_agent_ids: ['agent-1'], shape: 'open', round_cap: 3,
    })
  })
})

describe('ConversationQuotaLine', () => {
  const quota = {
    warn_pct: 70,
    reserve_pct: 85,
    logins: [{ account_label: 'Claude Code · Server', window: { kind: 'session' as const, utilization: 90, resets_at: null }, checked_at: null }],
    holds: [{ account_label: 'Claude Code · Server', window: 'session' as const, resets_at: null, run_ids: ['run-1'], can_continue: true }],
  }

  it('offers to continue anyway only to someone who may decide to spend', () => {
    const { rerender } = render(<ConversationQuotaLine quota={quota} onContinueAnyway={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'continue anyway' })).toBeInTheDocument()
    rerender(<ConversationQuotaLine quota={quota} />)
    expect(screen.getByText(/Agents are waiting for the window/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'continue anyway' })).not.toBeInTheDocument()
  })

  it('offers it only on a login the viewer may spend', () => {
    const someoneElses = { ...quota, holds: [{ ...quota.holds[0]!, account_label: 'Claude Code · Member laptop', can_continue: false }] }
    render(<ConversationQuotaLine quota={someoneElses} onContinueAnyway={vi.fn()} />)
    expect(screen.getByText(/Agents are waiting for the window/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'continue anyway' })).not.toBeInTheDocument()
  })
})
