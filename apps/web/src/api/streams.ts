import { ApiRequestError } from './transport'

/**
 * Reads an SSE body, yielding one `{ event, data }` per frame.
 *
 * Shared by the two turn readers below: the chat turn, which waits for the
 * whole thing, and `streamTurnParts`, which hands parts to a renderer as they
 * arrive.
 */
export async function* readServerSentEvents(
  response: Response,
): AsyncGenerator<{ event: string | undefined; data: string }> {
  // Callers refuse an unopened response first (`streamRefusal`), so
  // its 401 reaches the session; this is only the type narrowing.
  if (!response.ok || !response.body) {
    throw new ApiRequestError(`Run turn stream failed (${response.status})`, response.status)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/)
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        yield { event: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data }
      }
      if (done) return
    }
  } finally {
    // Cancel rather than just release: a caller that returns from inside the
    // loop (a finished turn) or throws on `server.error` would otherwise
    // leave the body undrained and the connection open.
    await reader.cancel().catch(() => {})
  }
}

/** Login endpoints use JSON data frames and treat an aborted read as the person leaving. */
export async function* readLoginEvents<Event>(response: Response): AsyncGenerator<Event> {
  try {
    for await (const frame of readServerSentEvents(response)) {
      let event: Event
      try { event = JSON.parse(frame.data) as Event } catch { continue }
      yield event
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
  }
}
