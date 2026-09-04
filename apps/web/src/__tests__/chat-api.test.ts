// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsApi, setSpaceContext, streamTurnParts } from '../api/client'
import type { RunTurn, TurnStreamFrame } from '../types/api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * The frames a stream sends, typed as the contract types them.
 *
 * `unknown` here is what let a fixture omit `blocked_on` while the schema
 * required it — the field was added to the turn and to the frame, and the
 * tests that were supposed to prove it kept compiling without it.
 */
function sse(frames: Array<{ event: string; data: TurnStreamFrame }>): Response {
  return new Response(
    `${frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n`).join('\n')}\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('agentsApi.chat', () => {
  beforeEach(() => {
    setSpaceContext('space-default')
  })

  it('queues one Run, follows its turn, and reads the durable assistant message', async () => {
    const turns: RunTurn[] = []
    const accepted = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-1',
        run_id: 'run-1',
        user_message_id: 'message-user-1',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-1/turn/stream',
        backend: {
          runtime_profile_id: 'runtime-profile-1',
          adapter_type: 'model_api',
          credential_profile_id: null,
        },
      }, 202))
      .mockResolvedValueOnce(sse([
        {
          event: 'turn.snapshot',
          data: {
            type: 'turn.snapshot',
            turn: {
              schema_version: 'run_turn.v1',
              run_id: 'run-1',
              state: 'working',
              source: 'run_events',
              parts: [{
                type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
                kind: null, status: 'running', input: null, output: null,
              }],
              blocked_on: null,
              cursor: 0,
              updated_at: null,
            },
          },
        },
        // The tool finishing lands on the part that started it, not beside it.
        {
          event: 'turn.part_updated',
          data: {
            type: 'turn.part_updated', run_id: 'run-1', cursor: 1,
            part: {
              type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
              kind: null, status: 'succeeded', input: null, output: null,
            },
          },
        },
        {
          event: 'turn.part_appended',
          data: {
            type: 'turn.part_appended', run_id: 'run-1', cursor: 1,
            part: { type: 'text', index: 1, text: 'Live reply' },
          },
        },
        { event: 'turn.state_changed', data: { type: 'turn.state_changed', run_id: 'run-1', state: 'done', blocked_on: null } },
      ]))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'message-assistant-1',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: 'user-1',
        role: 'assistant',
        content: 'Durable reply.',
        metadata_json: { artifact_refs: ['artifact-1'] },
        parent_message_id: 'message-user-1',
        run_id: 'run-1',
        created_at: '2026-07-26T10:00:02.000Z',
      }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(agentsApi.chat(
      'agent-1',
      { message: 'Hello' },
      { spaceId: 'space-1', onAccepted: accepted, onTurn: turn => { turns.push(turn) } },
    )).resolves.toMatchObject({
      schema_version: 'chat_turn_completion.v1',
      session_id: 'session-1',
      run_id: 'run-1',
      ok: true,
      // The stream is what the person watched; the message is what the
      // conversation keeps, and it is the reply.
      reply: 'Durable reply.',
      assistant_message: { id: 'message-assistant-1', artifact_refs: ['artifact-1'] },
    })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agents/agent-1/chat')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/runs/run-1/turn/stream')
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/sessions/session-1/messages')
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'run-1' }))

    // Each frame hands the caller the whole turn as it now stands.
    expect(turns.map(turn => turn.parts.map(part => part.type))).toEqual([
      ['tool_call'],
      ['tool_call'],
      ['tool_call', 'text'],
      ['tool_call', 'text'],
    ])
    expect(turns[turns.length - 1]).toMatchObject({ state: 'done' })
    expect(turns[1]!.parts[0]).toMatchObject({ status: 'succeeded' })
  })

  it('shows live prose once, not twice, when the persisted reply lands', async () => {
    const turns: RunTurn[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-3',
        run_id: 'run-3',
        user_message_id: 'message-user-3',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-3/turn/stream',
        backend: { runtime_profile_id: 'p', adapter_type: 'model_api', credential_profile_id: null },
      }, 202))
      .mockResolvedValueOnce(sse([
        {
          event: 'turn.snapshot',
          data: {
            type: 'turn.snapshot',
            turn: {
              schema_version: 'run_turn.v1', run_id: 'run-3', state: 'working',
              source: 'run_events', parts: [], blocked_on: null, cursor: 0, updated_at: null,
            },
          },
        },
        // Live prose: it has no place in the projection, so it is marked and
        // kept beside it.
        {
          event: 'turn.part_updated',
          data: {
            type: 'turn.part_updated', run_id: 'run-3', cursor: 0,
            part: { type: 'text', index: Number.MAX_SAFE_INTEGER, text: 'Live reply.', streamed: true },
          },
        },
        // The persisted reply arrives as a projected part...
        {
          event: 'turn.part_appended',
          data: {
            type: 'turn.part_appended', run_id: 'run-3', cursor: 1,
            part: { type: 'text', index: 0, text: 'Live reply.' },
          },
        },
        // ...and the server retracts the live copy, which is now a duplicate.
        {
          event: 'turn.part_updated',
          data: {
            type: 'turn.part_updated', run_id: 'run-3', cursor: 1,
            part: { type: 'text', index: Number.MAX_SAFE_INTEGER, text: '', streamed: true },
          },
        },
        { event: 'turn.state_changed', data: { type: 'turn.state_changed', run_id: 'run-3', state: 'done', blocked_on: null } },
      ]))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'message-assistant-3', session_id: 'session-3', space_id: 'space-1', user_id: 'user-1',
        role: 'assistant', content: 'Live reply.', metadata_json: null,
        parent_message_id: 'message-user-3', run_id: 'run-3', created_at: '2026-07-26T10:00:02.000Z',
      }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await agentsApi.chat('agent-1', { message: 'Hello' },
      { spaceId: 'space-1', onTurn: turn => { turns.push(turn) } })

    // Every consumer joins all text parts, so a surviving live copy would
    // read the reply out twice.
    for (const turn of turns) {
      const prose = turn.parts.filter(part => part.type === 'text').map(part => part.text).join('')
      expect(prose).not.toBe('Live reply.Live reply.')
    }
    const final = turns[turns.length - 1]!
    expect(final.parts.filter(part => part.type === 'text')).toHaveLength(1)
  })

  it('carries what a turn is waiting for, not just that it is waiting', async () => {
    const turns: RunTurn[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-4',
        run_id: 'run-4',
        user_message_id: 'message-user-4',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-4/turn/stream',
        backend: { runtime_profile_id: 'p', adapter_type: 'model_api', credential_profile_id: null },
      }, 202))
      .mockResolvedValueOnce(sse([
        {
          event: 'turn.snapshot',
          data: {
            type: 'turn.snapshot',
            turn: {
              schema_version: 'run_turn.v1', run_id: 'run-4', state: 'working',
              source: 'run_events', parts: [], blocked_on: null, cursor: 0, updated_at: null,
            },
          },
        },
        // A Run is streamed from queued, so it blocks *during* the stream —
        // this frame, not the snapshot, is where the reader learns of it. A
        // state without its reason would render "waiting for a decision" and
        // link to the wrong place for an approval the person could grant.
        {
          event: 'turn.state_changed',
          data: {
            type: 'turn.state_changed', run_id: 'run-4',
            state: 'blocked', blocked_on: 'authorization',
          },
        },
      ]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // The stream ends while blocked, which the client reports as such.
    await expect(agentsApi.chat('agent-1', { message: 'Hello' },
      { spaceId: 'space-1', onTurn: turn => { turns.push(turn) } })).rejects.toThrow()

    const blocked = turns[turns.length - 1]!
    expect(blocked.state).toBe('blocked')
    expect(blocked.blocked_on).toBe('authorization')
  })

  it('reports a failed turn from its own diagnostic, without reading a message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-1',
        run_id: 'run-2',
        user_message_id: 'message-user-2',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-2/turn/stream',
        backend: { runtime_profile_id: 'p', adapter_type: 'model_api', credential_profile_id: null },
      }, 202))
      .mockResolvedValueOnce(sse([{
        event: 'turn.snapshot',
        data: {
          type: 'turn.snapshot',
          turn: {
            schema_version: 'run_turn.v1',
            run_id: 'run-2',
            state: 'failed',
            source: 'run_events',
            parts: [{
              type: 'diagnostic', index: 0, level: 'error',
              text: 'Upstream refused.', error_code: 'provider_unavailable',
            }],
            blocked_on: null,
            cursor: 0,
            updated_at: null,
          },
        },
      }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(agentsApi.chat('agent-1', { message: 'Hello' }, { spaceId: 'space-1' }))
      .resolves.toMatchObject({
        ok: false,
        error: 'Upstream refused.',
        error_code: 'provider_unavailable',
        assistant_message: null,
      })
    // No message read: a failed turn has no durable reply to fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('streamTurnParts — how a stream is allowed to end', () => {
  beforeEach(() => {
    setSpaceContext('space-default')
  })

  const turn = (state: RunTurn['state'], blockedOn: RunTurn['blocked_on'] = null): RunTurn => ({
    schema_version: 'run_turn.v1',
    run_id: 'run-1',
    state,
    source: 'run_events',
    parts: [{ type: 'tool_call', index: 0, call_id: 'c1', name: 'search', kind: null, status: 'succeeded', input: null, output: null }],
    blocked_on: blockedOn,
    cursor: 1,
    updated_at: null,
  })

  it('reports a stream that ended while the turn was still working', async () => {
    // The server sends the settled state before it closes, so an ending on
    // `working` means the stream died — a database error on the poll, a
    // dropped connection, a proxy timeout. Resolving quietly would leave the
    // caller holding a turn that says the Agent is still going, with nothing
    // able to correct it.
    globalThis.fetch = vi.fn().mockResolvedValue(
      sse([{ event: 'turn.snapshot', data: { type: 'turn.snapshot', turn: turn('working') } }]),
    ) as unknown as typeof fetch

    await expect(streamTurnParts('run-1', { onTurn: () => {} }))
      .rejects.toThrow(/ended before the turn settled/)
  })

  it('accepts a stream that ended while the turn was blocked', async () => {
    // The one state the server keeps open on purpose: the turn resumes when
    // somebody decides, so it waits at human pace and an idle timeout on that
    // connection is the ordinary ending. Reporting it would make the caller
    // drop the only turn carrying the approval link.
    const seen: RunTurn[] = []
    globalThis.fetch = vi.fn().mockResolvedValue(
      sse([{ event: 'turn.snapshot', data: { type: 'turn.snapshot', turn: turn('blocked', 'authorization') } }]),
    ) as unknown as typeof fetch

    await expect(streamTurnParts('run-1', { onTurn: next => seen.push(next) })).resolves.toBeUndefined()
    const last = seen[seen.length - 1]
    expect(last?.state).toBe('blocked')
    expect(last?.blocked_on).toBe('authorization')
  })

  it('accepts a stream that settled before it closed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sse([
        { event: 'turn.snapshot', data: { type: 'turn.snapshot', turn: turn('working') } },
        { event: 'turn.state_changed', data: { type: 'turn.state_changed', run_id: 'run-1', state: 'done', blocked_on: null } },
      ]),
    ) as unknown as typeof fetch

    await expect(streamTurnParts('run-1', { onTurn: () => {} })).resolves.toBeUndefined()
  })
})
