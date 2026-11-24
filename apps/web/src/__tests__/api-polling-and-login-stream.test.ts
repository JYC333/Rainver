// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { automationsApi, hostsApi, ordinaryToolsApi, providersApi } from '../api/client'
import { clearSessionResidue } from '../lib/sessionResidue'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' },
})

describe('waiting for an accepted operation', () => {
  it('aborts the in-flight Host status read and never replays the write', async () => {
    const controller = new AbortController()
    let reading!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>(resolve => { reading = resolve })
    const transport = vi.fn()
      .mockResolvedValueOnce(reply({ status: 'succeeded', data: {
        id: 'command', host_id: 'host', job_id: 'job', space_id: 'original-space',
      } }))
      .mockImplementationOnce((_url: string, options: RequestInit) => {
        reading(options.signal!)
        return new Promise(() => {})
      })
    vi.stubGlobal('fetch', transport)
    const wait = hostsApi.refreshUsage('host', 'claude_code', 'own', 'once', { signal: controller.signal })
    const outcome = expect(wait).rejects.toMatchObject({ name: 'AbortError' })
    const readSignal = await started
    controller.abort()
    await outcome
    expect(readSignal.aborted).toBe(true)
    expect(transport.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'GET'])
    expect(new Headers(transport.mock.calls[1][1].headers).get('X-Rainver-Space-Id')).toBe('original-space')
  })

  it('discards a receipt from a submit that answered after logout', async () => {
    let accepted!: (value: Response) => void
    const transport = vi.fn(() => new Promise<Response>(resolve => { accepted = resolve }))
    vi.stubGlobal('fetch', transport)
    const wait = automationsApi.fire('automation')
    const refused = expect(wait).rejects.toMatchObject({ code: 'authentication_required' })
    clearSessionResidue()
    accepted(reply({ status: 'succeeded', data: { space_id: 'old-space', automation_id: 'automation', job_id: 'job' } }))
    await refused
    expect(transport).toHaveBeenCalledOnce()
  })

  it('ends a hung read at the deadline and retains the durable automation receipt', async () => {
    vi.useFakeTimers()
    const receipt = { automation_id: 'automation', job_id: 'job', space_id: 'space' }
    const transport = vi.fn()
      .mockResolvedValueOnce(reply({ status: 'succeeded', data: receipt }))
      .mockImplementationOnce(() => new Promise(() => {}))
    vi.stubGlobal('fetch', transport)

    const wait = automationsApi.fire('automation')
    const timeout = expect(wait).rejects.toMatchObject({
      code: 'operation_temporarily_unavailable',
      payload: { error: { metadata: { receipt } } },
    })
    await vi.advanceTimersByTimeAsync(180_000)
    await timeout
    expect(transport.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'GET'])
    expect(transport.mock.calls[1][1].signal.aborted).toBe(true)
  })
})

describe('Host and provider login streams', () => {
  it.each([
    () => hostsApi.loginStream('host', 'claude_code', 'own'),
    () => ordinaryToolsApi.sessionStream('host', 'tool', 'login'),
    () => providersApi.subscriptionLoginStream('anthropic'),
  ])('decodes split UTF-8 and CRLF frames and closes an abandoned body', async start => {
    const cancel = vi.fn()
    const data = new TextEncoder().encode('data: ignored\r\n\r\ndata: {"type":"output",\r\ndata: "text":"你好"}\r\n\r\n')
    const split = data.indexOf(0xe4) + 1
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(data.slice(0, split))
        controller.enqueue(data.slice(split))
      },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const iterator = start()
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'output', text: '你好' }, done: false })
    await iterator.return(undefined)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
