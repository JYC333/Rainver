import { mergeAbortSignals } from '../lib/mergeAbortSignals'
import { sessionEpoch } from '../lib/sessionResidue'
import type {
  ApiError,
  ChatTurnAccepted,
  ChatTurnOut,
  ConversationAttachmentMutation,
  ConversationAttachmentMutationResponse,
  ConversationExecutionInitializeRequest,
  ConversationExecutionPreflightRequest,
  ConversationExecutionPreflightResponse,
  ConversationExecutionSummary,
  DiagnosticTurnPart,
  Message,
  Page,
  ReflectResult,
  RunTurn,
  Session,
  TurnPart,
  TurnStreamFrame,
} from '../types/api'
import { commandReceipt, queryOperation } from './operations'
import { readServerSentEvents } from './streams'
import type { RequestOptions } from './transport'
import { _spaceId, accountFetch, accountHeaders, ApiRequestError, BASE, del, formatApiErrorMessage, get, noteAccountSwitched, signalAuthRequired, streamRefusal } from './transport'
import type { ConversationInputFileSearchResponse, ConversationInputMediaOut, OperationInput } from '@rainver/protocol'
import { ConversationInputMediaOutSchema, TurnStreamErrorSchema } from '@rainver/protocol'

export const conversationInputApi = {
  uploadImage: (file: File, onProgress?: (progress: number) => void, options: RequestOptions = {}): Promise<ConversationInputMediaOut> => {
    const form = new FormData()
    form.append('file', file, file.name)
    return new Promise((resolve, reject) => {
      // Captured when the request is sent (below), never when it answers.
      let startedIn: number
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BASE}/conversation-inputs/media`)
      xhr.withCredentials = true
      xhr.setRequestHeader('X-Rainver-Space-Id', options.spaceId ?? _spaceId)
      for (const [name, value] of Object.entries(accountHeaders())) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100))
      }
      xhr.onerror = () => reject(new ApiRequestError('Image upload failed', 0))
      xhr.onabort = () => reject(new ApiRequestError('Image upload cancelled', 0))
      xhr.onload = () => {
        if (xhr.status === 401 && !options.signal?.aborted) signalAuthRequired(startedIn)
        noteAccountSwitched(xhr.status, xhr.getResponseHeader('x-rainver-account-switched'), startedIn, options.signal)
        let payload: unknown = null
        try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { /* use status text */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = payload && typeof payload === 'object'
            ? payload as ApiError & { code?: unknown }
            : { error: `${xhr.status} ${xhr.statusText}` }
          const message = formatApiErrorMessage(error, `${xhr.status} ${xhr.statusText}`)
          reject(new ApiRequestError(message, xhr.status, typeof error.code === 'string' ? error.code : undefined, error as unknown as Record<string, unknown>))
          return
        }
        try {
          resolve(ConversationInputMediaOutSchema.parse(payload))
        } catch {
          reject(new ApiRequestError('Image upload returned an invalid response', xhr.status))
        }
      }
      const abort = () => xhr.abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      xhr.addEventListener('loadend', () => options.signal?.removeEventListener('abort', abort), { once: true })
      if (options.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      startedIn = sessionEpoch()
      xhr.send(form)
    })
  },
  deletePendingImage: (mediaId: string, options: RequestOptions = {}) => del<null>(`/conversation-inputs/media/${encodeURIComponent(mediaId)}`, options),
  imageBlob: async (mediaId: string, options: RequestOptions = {}): Promise<Blob> => {
    const headers: Record<string, string> = { 'X-Rainver-Space-Id': options.spaceId ?? _spaceId, ...accountHeaders() }
    const startedIn = sessionEpoch()
    const response = await accountFetch(`${BASE}/conversation-inputs/media/${encodeURIComponent(mediaId)}`, { headers, signal: options.signal })
    if (!response.ok) throw await streamRefusal(response, 'Could not load image', startedIn, options.signal)
    return response.blob()
  },
  searchFiles: (sessionId: string, query: string, signal?: AbortSignal, options: RequestOptions = {}) =>
    get<ConversationInputFileSearchResponse>(`/sessions/${encodeURIComponent(sessionId)}/input-files?q=${encodeURIComponent(query)}&limit=20`, { ...options, signal: mergeAbortSignals(signal, options.signal) }),
}

/**
 * A `server.error` frame, as the failure it reports. A 401 inside an opened
 * turn stream is the server finding the session gone mid-stream (logout,
 * revocation), so it signs out exactly like a refused response; a 404 is the
 * Run no longer being readable in full and leaves the session alone.
 */
function turnStreamFailure(data: string, startedIn: number): ApiRequestError {
  const parsed = TurnStreamErrorSchema.safeParse(JSON.parse(data))
  const failure = parsed.success ? parsed.data : null
  if (failure?.status === 401) signalAuthRequired(startedIn)
  return new ApiRequestError(failure?.message ?? 'Run turn stream failed', failure?.status ?? 502, failure?.error)
}

function turnStreamUrl(runId: string): string {
  return `${BASE}/runs/${encodeURIComponent(runId)}/turn/stream`
}

function streamHeaders(spaceId?: string): Record<string, string> {
  const headers: Record<string, string> = { ...accountHeaders() }
  headers['X-Rainver-Space-Id'] = spaceId ?? _spaceId
  return headers
}

/**
 * Folds one stream frame into the turn so far.
 *
 * A snapshot replaces; a state change replaces the state; an appended or
 * updated part lands at its own index. Both are one case: a
 * tool call finishing writes over the part it started as.
 *
 * A `streamed` text part is the exception: it is live prose the projection
 * does not hold, so it is kept at the end of the list rather than at an index
 * the next projected part would claim. It survives only until the projection
 * has prose of its own — the persisted reply says the same thing, and showing
 * both reads the answer out twice.
 */
function applyTurnFrame(turn: RunTurn | null, frame: TurnStreamFrame): RunTurn | null {
  if (frame.type === 'turn.snapshot') {
    // The snapshot is the projection; anything streamed is superseded by it.
    return frame.turn
  }
  if (!turn) return null
  if (frame.type === 'turn.model_changed') {
    return { ...turn, model_selection: frame.model_selection }
  }
  if (frame.type === 'turn.state_changed') {
    return { ...turn, state: frame.state, blocked_on: frame.blocked_on,
      ...(frame.queue_wait_reason !== undefined ? {queue_wait_reason:frame.queue_wait_reason} : {}) }
  }

  const projected = turn.parts.filter(part => !(part.type === 'text' && part.streamed))
  const held = turn.parts.find(part => part.type === 'text' && part.streamed)

  if (frame.part.type === 'text' && frame.part.streamed) {
    const live = frame.part.text ? frame.part : null
    return { ...turn, parts: withLiveProse(projected, live), cursor: frame.cursor }
  }
  // At or one past the end. Anything further would leave a hole, and the
  // consumers that scan backwards for the newest part dereference holes.
  if (frame.part.index > projected.length) return turn
  const parts = [...projected]
  parts[frame.part.index] = frame.part
  return { ...turn, parts: withLiveProse(parts, held ?? null), cursor: frame.cursor }
}

/**
 * Puts the live prose back on the end of a projected list, unless the
 * projection now has prose of its own.
 *
 * The retraction frame the server sends is a frame behind the projected reply
 * it replaces, so a client that waited for it would show the answer twice in
 * between. This condition is local and needs no such coordination.
 */
function withLiveProse(projected: TurnPart[], live: TurnPart | null): TurnPart[] {
  if (!live || projected.some(part => part.type === 'text')) return projected
  return [...projected, { ...live, index: projected.length }]
}

/**
 * The live turn, as parts.
 *
 * `onTurn` receives the whole turn on every change rather than a patch: a
 * turn is small, and handing a renderer the current state is simpler to hold
 * correctly than replaying appends and updates into a local copy.
 */
export async function streamTurnParts(
  runId: string,
  options: {
    spaceId?: string
    signal?: AbortSignal
    onTurn: (turn: RunTurn) => void
  },
): Promise<void> {
  const startedIn = sessionEpoch()
  const response = await accountFetch(turnStreamUrl(runId), {
    headers: streamHeaders(options.spaceId),
    signal: options.signal,
  })
  if (!response.ok || !response.body) throw await streamRefusal(response, 'Run turn stream failed', startedIn, options.signal)
  let turn: RunTurn | null = null
  for await (const { event, data } of readServerSentEvents(response)) {
    if (event === 'server.error') throw turnStreamFailure(data, startedIn)
    const frame = JSON.parse(data) as TurnStreamFrame | { error?: string; message?: string }
    if (!('type' in frame)) continue
    turn = applyTurnFrame(turn, frame)
    if (!options.signal?.aborted && turn) options.onTurn(turn)
  }
  // The server sends the settled state before it closes, so a stream that
  // ends on `working` ended for some other reason — the poll hit a database
  // error, the connection dropped, a proxy timed out. Resolving quietly here
  // would leave the caller holding a turn that says the Agent is still
  // working, on a reply that is finished, with nothing to correct it: the
  // stream is gone and every read-back guard treats a held turn as current.
  // Reported so the caller can go and read the turn again.
  //
  // `blocked` is deliberately not included. The server keeps that stream
  // open on purpose — the turn resumes where it stopped once somebody
  // decides — so it waits at human pace, and an idle timeout on that
  // connection is the ordinary ending rather than a fault. Reporting it
  // would make the caller drop the one turn that carries the approval link.
  if (turn && turn.state === 'working') {
    throw new ApiRequestError('Run turn stream ended before the turn settled', 502)
  }
}

export async function postChatTurn(
  agentId: string,
  body: Omit<OperationInput<'agent.chat.send'>, 'agent_id'>,
  options: RequestOptions & {
    onAccepted?: (accepted: ChatTurnAccepted) => void
    onTurn?: (turn: RunTurn) => void
  } = {},
): Promise<ChatTurnOut> {
  // One keyed turn command, never retried automatically; the stream is a read.
  const { space_id: _space, ...accepted } = await commandReceipt('agent.chat.send', { ...body, agent_id: agentId }, options.idempotencyKey ?? crypto.randomUUID(), options)
  if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
  options.onAccepted?.(accepted)
  const startedIn = sessionEpoch()
  const response = await accountFetch(accepted.event_stream_url, { headers: streamHeaders(options.spaceId), signal: options.signal })
  if (!response.ok || !response.body) throw await streamRefusal(response, 'Run turn stream failed', startedIn, options.signal)

  let turn: RunTurn | null = null
  for await (const { event, data } of readServerSentEvents(response)) {
    if (event === 'server.error') throw turnStreamFailure(data, startedIn)
    const frame = JSON.parse(data) as TurnStreamFrame | { error?: string; message?: string }
    if (!('type' in frame)) continue
    turn = applyTurnFrame(turn, frame)
    if (!turn) continue
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    options.onTurn?.(turn)
    // A blocked turn has stopped, but it is not over: it resumes when the
    // person decides, so the caller keeps watching rather than going to read
    // a reply that has not been written.
    if (turn.state === 'working' || turn.state === 'blocked') continue

    // The turn is over. Its durable form is the assistant message the Run
    // finalized into — the stream is what the person watched, the message is
    // what the conversation keeps.
    if (turn.state === 'failed') {
      const failure = turn.parts.find(
        (part): part is DiagnosticTurnPart => part.type === 'diagnostic' && part.level === 'error')
      return {
        schema_version: 'chat_turn_completion.v1',
        session_id: accepted.session_id,
        run_id: accepted.run_id,
        ok: false,
        error: failure?.text ?? 'The assistant could not complete this turn.',
        error_code: failure?.error_code ?? 'run_failed',
        assistant_message: null,
      }
    }
    const messages = await get<Message[]>(
      `/sessions/${encodeURIComponent(accepted.session_id)}/messages`,
      { spaceId: options.spaceId, signal: options.signal },
    )
    const assistant = messages.find(message =>
      message.role === 'assistant' && message.run_id === accepted.run_id)
    if (!assistant) {
      throw new ApiRequestError('Chat completion message is unavailable', 502)
    }
    const artifactRefs = Array.isArray(assistant.metadata_json?.artifact_refs)
      ? assistant.metadata_json.artifact_refs.filter((value): value is string => typeof value === 'string')
      : []
    const actionPreviews = Array.isArray(assistant.metadata_json?.action_previews)
      ? assistant.metadata_json.action_previews as ChatTurnOut['action_previews']
      : undefined
    return {
      schema_version: 'chat_turn_completion.v1',
      session_id: accepted.session_id,
      run_id: accepted.run_id,
      ok: true,
      reply: assistant.content,
      assistant_message: {
        schema_version: 'assistant_message.v1',
        id: assistant.id,
        session_id: accepted.session_id,
        run_id: accepted.run_id,
        content: assistant.content,
        ...(assistant.metadata_json?.gmail_result === true ? { gmail_result: true as const } : {}),
        artifact_refs: artifactRefs,
        tool_call_refs: actionPreviews?.flatMap(preview =>
          preview.tool_call_id ? [preview.tool_call_id] : []) ?? [],
        created_at: assistant.created_at,
      },
      ...(actionPreviews ? { action_previews: actionPreviews } : {}),
    }
  }
  throw new ApiRequestError('Run turn stream ended without a finished turn', 502)
}

// ── Sessions ──────────────────────────────────────────────────────────────
export const sessionsApi = {
  list:       (params: Record<string, string> = {}) =>
    get<Page<Session>>('/sessions?' + new URLSearchParams(params)),
  create:     async (data: { title?: string | null; project_id?: string | null; project_folder_id?: string | null; metadata?: Record<string, unknown> | null }, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('session.create', data, key)
    return get<Session>(`/sessions/${encodeURIComponent(receipt.session_id)}`, { spaceId: receipt.space_id })
  },
  get:        (id: string, options: RequestOptions = {})                          => get<Session>(`/sessions/${id}`, options),
  messages:   (id: string, options: RequestOptions = {})                          => get<Message[]>(`/sessions/${id}/messages`, options),
  addMessage: async (id: string, data: { content: string }, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('session.message.add', { ...data, session_id: id }, key)
    const messages = await get<Message[]>(`/sessions/${encodeURIComponent(receipt.session_id)}/messages`, { spaceId: receipt.space_id })
    const message = messages.find(item => item.id === receipt.message_id)
    if (!message) throw new Error('Message no longer available')
    return message
  },
  reflect:    async (id: string, key: string = crypto.randomUUID()): Promise<ReflectResult> => {
    const receipt = await commandReceipt('session.reflect', { session_id: id }, key)
    return { session_id: receipt.session_id, proposals_created: receipt.proposals_created }
  },
  executionContext: (id: string, options: RequestOptions = {}) => get<ConversationExecutionPreflightResponse>(`/sessions/${encodeURIComponent(id)}/execution-context`, options),
  // A read-only query: no key, nothing written.
  preflightExecution: async (id: string, body: ConversationExecutionPreflightRequest, options: RequestOptions = {}): Promise<ConversationExecutionPreflightResponse> => {
    const result = await queryOperation('conversation.execution.preflight', { ...body, session_id: id }, options)
    if (!('status' in result) || result.status !== 'succeeded') throw new Error('Preview did not complete')
    return result.data
  },
  initializeExecution: async (id: string, body: ConversationExecutionInitializeRequest, options: RequestOptions = {}): Promise<ConversationExecutionSummary> => {
    const receipt = await commandReceipt('conversation.execution.initialize', { ...body, session_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return (await sessionsApi.executionContext(receipt.session_id, { ...options, spaceId: receipt.space_id })).summary
  },
  mutateExecutionAttachments: async (id: string, body: ConversationAttachmentMutation, options: RequestOptions = {}): Promise<ConversationAttachmentMutationResponse> => {
    const receipt = await commandReceipt('conversation.execution.attachment.mutate', { ...body, session_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    const context = await sessionsApi.executionContext(receipt.session_id, { ...options, spaceId: receipt.space_id })
    const attachment = context.summary.attachments.find(item => item.id === receipt.attachment_id)
    if (!attachment) throw new Error('Folder attachment no longer available')
    return { attachment, effective_after_run_id: receipt.effective_after_run_id }
  },
  remove:     async (id: string, key: string = crypto.randomUUID()) => { await commandReceipt('session.delete', { session_id: id }, key) },
}
