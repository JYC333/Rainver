// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsApi, setSpaceContext } from '../api/client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('agentsApi.chat', () => {
  beforeEach(() => {
    setSpaceContext('space-default')
  })

  it('queues one Run, follows its lifecycle stream, and reads the durable assistant message', async () => {
    const lifecycle = vi.fn()
    const textDelta = vi.fn()
    const accepted = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-1',
        run_id: 'run-1',
        user_message_id: 'message-user-1',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-1/events/stream',
        backend: {
          runtime_profile_id: 'runtime-profile-1',
          adapter_type: 'model_api',
          credential_profile_id: null,
        },
      }, 202))
      .mockResolvedValueOnce(new Response(
        [
          'event: run.event_appended',
          'data: {"payload":{"event":{"event_type":"adapter_invoked","status":"running","summary":"Invoking adapter."}}}',
          '',
          'event: chat.text_delta',
          'data: {"type":"chat.text_delta","run_id":"run-1","delta":"Live "}',
          '',
          'event: chat.text_delta',
          'data: {"type":"chat.text_delta","run_id":"run-1","delta":"reply"}',
          '',
          'event: run.event_appended',
          'data: {"payload":{"event":{"event_type":"chat_completed","status":"succeeded","summary":"Chat turn completed.","metadata_json":{"session_id":"session-1","assistant_message_id":"message-assistant-1"}}}}',
          '',
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'message-assistant-1',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: 'user-1',
        role: 'assistant',
        content: 'Durable reply.',
        metadata_json: { run_id: 'run-1', artifact_refs: ['artifact-1'] },
        created_at: '2026-07-26T10:00:02.000Z',
      }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(agentsApi.chat(
      'agent-1',
      { message: 'Hello' },
      {
        spaceId: 'space-1',
        onAccepted: accepted,
        onLifecycle: lifecycle,
        onTextDelta: textDelta,
      },
    )).resolves.toMatchObject({
      schema_version: 'chat_turn_completion.v1',
      session_id: 'session-1',
      run_id: 'run-1',
      ok: true,
      reply: 'Durable reply.',
      assistant_message: {
        id: 'message-assistant-1',
        artifact_refs: ['artifact-1'],
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agents/agent-1/chat')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Agent-Space-Id': 'space-1' }),
    })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/runs/run-1/events/stream')
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/sessions/session-1/messages')
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      run_id: 'run-1',
    }))
    expect(lifecycle).toHaveBeenNthCalledWith(1, {
      event_type: 'adapter_invoked',
      status: 'running',
      summary: 'Invoking adapter.',
    })
    expect(lifecycle).toHaveBeenNthCalledWith(2, {
      event_type: 'chat_completed',
      status: 'succeeded',
      summary: 'Chat turn completed.',
    })
    expect(textDelta.mock.calls).toEqual([['Live '], ['reply']])
  })
})
