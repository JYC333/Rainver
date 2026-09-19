import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { agentsApi, conversationInputApi, hostsApi, proposalsApi, runsApi, sessionsApi } from '../../api/client'
import type {
  AgentOut,
  ChatActionPreview,
  ConversationBackendBinding,
  ConversationBackendOption,
  Message,
  RunTurn,
} from '../../types/api'
import { ConversationView } from '../conversation/ConversationView'
import {
  ConversationSessionConfig,
  mergeSessionConfig,
  type SessionConfigSelection,
} from '../conversation/ConversationSessionConfig'
import { readBackTurnState, settledTurn } from '../conversation/settledTurn'
import { decidableByViewer } from '../conversation/ConversationSurface'
import { errMsg } from '../../lib/utils'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'
import type { ConversationInputPart } from '@rainver/protocol'
import { ConversationGitContext } from '../conversation/ConversationGitContext'
import { clearConversationDraft, readConversationDraft, writeConversationDraft } from '../conversation/conversationDraft'
import { ConversationRunControls } from '../conversation/ConversationRunControls'

/**
 * How far back a reload reads turns for.
 *
 * Every read is a `loadRunTurn`, so this is what keeps opening a long
 * conversation from fanning out one request per reply. Older replies render
 * as prose, which is what they were before the fold existed.
 */
const HISTORY_TURN_READS = 20

interface ChatMessage {
  id?: string
  role: string
  content: string
  error?: boolean
  /** The live turn, while the Agent is working on this reply. */
  turn?: RunTurn | null
  actionPreviews?: ChatActionPreview[]
  artifactRefs?: string[]
  runId?: string
  runIds?: string[]
  inputParts?: ConversationInputPart[]
}

interface BackendChoice {
  key: string
  label: string
  backend: ConversationBackendBinding
  usable: boolean
  reason?: string | null
}

/**
 * Streamed Chat Run surface for the space's Personal Assistant. Each turn uses
 * the canonical Run pipeline and terminates in assistant_message.v1. The active
 * session id is reflected in the URL by the parent
 * so a refresh can reload persisted messages through the sessions API.
 */
export default function ChatPanel({
  agent,
  initialDraft,
  initialSessionId,
  onSessionChange,
  projectId,
}: {
  agent: AgentOut
  initialDraft?: string | null
  initialSessionId?: string | null
  onSessionChange?: (sessionId: string) => void
  projectId?: string
}) {
  const { userId } = useSpace()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId ?? undefined)
  const [input, setInput] = useState('')
  const [inputParts, setInputParts] = useState<ConversationInputPart[]>([])
  const [inputResetToken, setInputResetToken] = useState(0)
  const [sending, setSending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(Boolean(initialSessionId))
  const [backendOptions, setBackendOptions] = useState<ConversationBackendOption[]>([])
  const [backend, setBackend] = useState<ConversationBackendBinding | null>(null)
  const [loadingBackends, setLoadingBackends] = useState(true)
  const [sessionConfig, setSessionConfig] = useState<SessionConfigSelection[]>([])
  const [hosts, setHosts] = useState<Awaited<ReturnType<typeof hostsApi.list>>['items']>([])
  const [restoreWorkspace, setRestoreWorkspace] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const autoSentRef = useRef(false)
  // Capture the session that was provided at mount time (via URL). Sessions
  // created during chat are already reflected in local state; re-fetching them
  // from the DB would wipe error messages that were never persisted.
  const externalSessionRef = useRef(initialSessionId)
  const draftDestination = `direct:${agent.id}:${projectId ?? ''}:${sessionId ?? 'new'}`
  const draftReadyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingBackends(true)
    agentsApi.conversationBackends(agent.id, {
      spaceId: agent.space_id,
      sessionId: initialSessionId ?? undefined,
    })
      .then(catalog => {
        if (cancelled) return
        const selected = catalogBackend(catalog.options, catalog.binding)
        setBackendOptions(catalog.options)
        setBackend(selected)
        const option = catalog.options.find(candidate => candidate.runtime_profile_id === selected?.runtime_profile_id)
        setSessionConfig(mergeSessionConfig(option?.session_config_options ?? [], catalog.session_config ?? []))
      })
      .catch(error => {
        if (!cancelled) toast.error(errMsg(error))
      })
      .finally(() => {
        if (!cancelled) setLoadingBackends(false)
      })
    return () => { cancelled = true }
  }, [agent.id, agent.space_id, initialSessionId])

  useEffect(() => {
    if (!backendOptions.some(option => option.host_bound)) {
      setHosts([])
      return
    }
    if (typeof hostsApi?.list !== 'function') {
      setHosts([])
      return
    }
    hostsApi.list().then(response => setHosts(response.items)).catch(() => setHosts([]))
  }, [backendOptions])

  useEffect(() => {
    const id = initialSessionId?.trim()
    if (!id) {
      setLoadingHistory(false)
      return
    }
    if (id !== externalSessionRef.current) {
      // Session was created during this conversation — history is in local state.
      return
    }
    let cancelled = false
    setLoadingHistory(true)
    sessionsApi.messages(id)
      .then(async (rows: Message[]) => {
        if (cancelled) return
        // Turns are read for the tail only. The fold is a reading affordance
        // for what a person is looking at when the page opens, and every
        // reply is one `loadRunTurn` — a long conversation would otherwise
        // fan out one uncapped request per reply on every reload.
        const foldFrom = Math.max(0, rows.length - HISTORY_TURN_READS)
        const history = await Promise.all(rows.map(async (m, index) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          inputParts: m.input_parts,
          actionPreviews: await refreshActionPreviews(Array.isArray(m.metadata_json?.action_previews) ? m.metadata_json.action_previews as ChatActionPreview[] : undefined),
          artifactRefs: Array.isArray(m.metadata_json?.artifact_refs) ? m.metadata_json.artifact_refs.filter((value): value is string => typeof value === 'string') : undefined,
          runId: m.run_id ?? undefined,
          runIds: uniqueRunIds(m.run_id, m.metadata_json?.retry_run_ids),
          // The turn behind a saved reply, so D3's fold survives a reload
          // rather than existing only in the session that watched it stream.
          //
          // Through `settledTurn` like every other settle: the turn supplies
          // the work, the saved message supplies the prose. Rendering the
          // read-back turn as-is would show whatever text the projection
          // holds — for a managed Run, nothing, because its prose is streamed
          // and never persisted in the log — and the reply would vanish.
          //
          // The state is the turn's own, not an assumption that a saved reply
          // means a finished turn: the server writes a reply at the pause too,
          // and a turn read back as `blocked` has to keep saying so — that is
          // the approval link, and without it a paused conversation looks
          // merely finished.
          //
          // A turn that cannot be read (reaped events, a Run gone) — or one
          // further back than the tail — leaves the reply as prose, which is
          // what it was before.
          turn: m.role === 'assistant' && m.run_id && index >= foldFrom
            ? await runsApi.turn(m.run_id)
              .then(read => settledTurn(read, readBackTurnState(read.state), m.content))
              .catch(() => null)
            : null,
        })))
        if (cancelled) return
        setSessionId(id)
        setMessages(history)
      })
      .catch(e => {
        if (!cancelled) toast.error(errMsg(e))
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false)
      })
    return () => { cancelled = true }
  }, [initialSessionId])

  useEffect(() => {
    let cancelled = false
    if (draftReadyRef.current === draftDestination) return () => { cancelled = true }
    draftReadyRef.current = null
    const draft = readConversationDraft(draftDestination)
    if (!draft) {
      draftReadyRef.current = draftDestination
      return
    }
    void (async () => {
      const validated = await Promise.all(draft.input_parts.map(async part => {
        try {
          if (part.kind === 'image') {
            await conversationInputApi.imageBlob(part.media_id)
          } else if (part.kind === 'file_reference' && sessionId) {
            const files = await conversationInputApi.searchFiles(sessionId, part.relative_path)
            if (!files.items.some(file => file.relative_path === part.relative_path
              && file.project_folder_id === part.project_folder_id
              && file.workspace_location_id === part.workspace_location_id)) return null
          } else if (part.kind === 'input_resource') {
            // Resource parts are frozen by the server when the message is
            // sent; a browser draft keeps the opaque request and lets the
            // current-file producer revalidate it at send time.
            return part
          }
          return part
        } catch {
          return null
        }
      }))
      if (cancelled) return
      setInput(draft.text)
      setInputParts(validated.filter((part): part is ConversationInputPart => part !== null))
      setInputResetToken(value => value + 1)
      draftReadyRef.current = draftDestination
    })()
    return () => { cancelled = true }
  }, [draftDestination, sessionId])

  useEffect(() => {
    if (draftReadyRef.current !== draftDestination || sending) return
    const timer = window.setTimeout(() => writeConversationDraft({
      destination: draftDestination,
      text: input,
      input_parts: inputParts,
    }), 250)
    return () => window.clearTimeout(timer)
  }, [draftDestination, input, inputParts, sending])

  const selectedBackendOption = backendOptions.find(option => option.runtime_profile_id === backend?.runtime_profile_id) ?? null
  const directInputFileSources = selectedBackendOption?.workspace_mode === 'location'
    && selectedBackendOption.project_folder_id
    && selectedBackendOption.workspace_location_id
    ? [{
      projectFolderId: selectedBackendOption.project_folder_id,
      workspaceLocationId: selectedBackendOption.workspace_location_id,
      label: 'Primary · Workspace',
    }]
    : []
  /**
   * A turn's request, from send until it resolves — including while it is
   * blocked, which is a stop rather than an end.
   *
   * `sending` says the same thing and drives the spinner and the composer;
   * this ref exists because `send` needs to read it synchronously, before a
   * state update could have landed.
   */
  const inFlight = useRef(false)
  const awaitingDecision = messages.some(message => message.turn?.state === 'blocked')

  const send = useCallback(async (text: string, parts: ConversationInputPart[] = inputParts) => {
    const message = text.trim()
    // `inFlight` rather than `sending`: a blocked turn hands the composer back
    // so the person can go and approve something, but its request is still
    // open, and a second send while it is would be two turns at once.
    //
    // `awaitingDecision` as well as `inFlight`, because the same stop is
    // reachable two ways: a turn blocked in this session, whose request is
    // still open, and one blocked before a reload, whose is not. The note
    // above the composer is driven by `awaitingDecision`, so a guard that
    // only knew about `inFlight` told the person their message was held and
    // then sent it anyway.
    if ((!message && parts.length === 0) || inFlight.current || awaitingDecision || loadingHistory || loadingBackends || !backend || selectedBackendOption?.usable === false) return
    inFlight.current = true
    setHostError(null)
    setMessages(m => [...m, { role: 'user', content: message, inputParts: parts }])
    setSending(true)
    const streamingMessageId = `stream:${crypto.randomUUID()}`
    let streamedContent = ''
    try {
      const res = await agentsApi.chat(
        agent.id,
        {
          message,
          ...(parts.length > 0 ? { input_parts: parts } : {}),
          session_id: sessionId,
          ...(projectId ? { project_id: projectId } : {}),
          backend: { runtime_profile_id: backend.runtime_profile_id },
          ...(sessionConfig.length ? { session_config: sessionConfig } : {}),
          ...(restoreWorkspace ? { restore_workspace: true } : {}),
        },
        {
          spaceId: agent.space_id,
          onAccepted: accepted => {
            setSessionId(accepted.session_id)
            onSessionChange?.(accepted.session_id)
            setMessages(current => {
              let index = -1
              for (let cursor = current.length - 1; cursor >= 0; cursor -= 1) {
                if (current[cursor]?.role === 'user' && !current[cursor]?.runId) {
                  index = cursor
                  break
                }
              }
              return index < 0
                ? current
                : current.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, runId: accepted.run_id, runIds: [accepted.run_id] }
                      : item)
            })
          },
          onTurn: turn => {

            // The turn itself goes into the message, so the bubble shows the
            // steps as they happen rather than a status line beside them.
            streamedContent = turn.parts
              .filter(part => part.type === 'text')
              .map(part => part.text)
              .join('')
            setMessages(current => {
              const index = current.findIndex(item => item.id === streamingMessageId)
              const entry: ChatMessage = {
                id: streamingMessageId, role: 'assistant', content: streamedContent, turn,
              }
              if (index < 0) return [...current, entry]
              return current.map((item, itemIndex) => itemIndex === index ? entry : item)
            })
          },
        },
      )
      setSessionId(res.session_id)
      setRestoreWorkspace(false)
      onSessionChange?.(res.session_id)
      if (res.ok) {
        setInput('')
        setInputParts([])
        clearConversationDraft(draftDestination)
        clearConversationDraft(`direct:${agent.id}:${projectId ?? ''}:new`)
        setInputResetToken(value => value + 1)
        setMessages(current => {
          const streamed = current.find(item => item.id === streamingMessageId)
          const completed: ChatMessage = {
            id: res.assistant_message?.id,
            role: 'assistant',
            content: res.reply ?? '',
            turn: settledTurn(streamed?.turn, 'done', res.reply ?? ''),
            actionPreviews: res.action_previews,
            artifactRefs: res.assistant_message?.artifact_refs,
            runId: res.run_id,
            runIds: [res.run_id],
          }
          return streamed
            ? current.map(item => item.id === streamingMessageId ? completed : item)
            : [...current, completed]
        })
      } else {
        const note = res.error_code === 'model_provider_required'
          ? 'No model provider is configured for this space yet. Add one to enable chat.'
          : (res.error ?? 'The assistant could not complete this turn.')
        setMessages(current => {
          const streamed = current.find(item => item.id === streamingMessageId)
          const failed: ChatMessage = {
            role: 'assistant',
            content: streamedContent ? `${streamedContent}\n\n${note}` : note,
            error: true,
            // The steps stay on a failure, as much as on a success — when
            // something went wrong they are the explanation.
            turn: settledTurn(streamed?.turn, 'failed', note),
            actionPreviews: res.action_previews,
          }
          return streamed
            ? current.map(item => item.id === streamingMessageId ? failed : item)
            : [...current, failed]
        })
      }
    } catch (e) {
      const errorStatus = hostErrorStatus(e)
      const rawNote = errMsg(e)
      const gitContextStale = rawNote.toLowerCase().includes('git branch or commit changed')
      const note = gitContextStale
        ? rawNote
        : errorStatus !== null && [403, 409, 503].includes(errorStatus) && selectedBackendOption?.host_bound
        ? errorStatus === 403
          ? 'This host-bound Agent can only be triggered by the Host owner.'
          : errorStatus === 503
            ? 'The execution Host is offline. Reconnect it before sending this direct message.'
            : 'The host-bound workspace is unavailable or belongs to a different conversation context.'
        : rawNote
      if (errorStatus !== null && [403, 409, 503].includes(errorStatus) && selectedBackendOption?.host_bound) setHostError(note)
      toast.error(note)
      setMessages(current => {
        const streamed = current.find(item => item.id === streamingMessageId)
        const failed: ChatMessage = {
          role: 'assistant',
          content: streamedContent ? `${streamedContent}\n\n${note}` : note,
          error: true,
          // The third way a turn settles, and the same rule: what the Agent
          // did before the break is what explains the break.
          turn: settledTurn(
            streamed?.turn,
            'failed',
            streamedContent ? `${streamedContent}\n\n${note}` : note,
          ),
        }
        return streamed
          ? current.map(item => item.id === streamingMessageId ? failed : item)
          : [...current, failed]
      })
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }, [agent.id, agent.space_id, awaitingDecision, backend, draftDestination, inputParts, loadingBackends, loadingHistory, onSessionChange, projectId, restoreWorkspace, selectedBackendOption?.usable, sessionConfig, sessionId])

  const refreshDirectGit = useCallback(async () => {
    if (!sessionId) return
    try {
      const next = await sessionsApi.refreshGitContext(sessionId)
      setBackendOptions(current => current.map(option => option.runtime_profile_id === backend?.runtime_profile_id
        ? { ...option, git: next.git ?? null }
        : option))
      setHostError(null)
      toast.success('Git context refreshed')
    } catch (error) {
      const note = errMsg(error)
      setHostError(note)
      toast.error(note)
    }
  }, [backend?.runtime_profile_id, sessionId])

  const retryRun = useCallback(async (runId: string) => {
    const retried = await agentsApi.retryConversation(agent.id, runId, { spaceId: agent.space_id })
    const streamingMessageId = `retry-stream:${crypto.randomUUID()}`
    let streamedTurn: RunTurn | null = null
    setSessionId(retried.session_id)
    onSessionChange?.(retried.session_id)
    setMessages(current => current.map(message => message.role === 'user' && message.runIds?.includes(runId)
      ? { ...message, runIds: uniqueRunIds(...(message.runIds ?? []), retried.run_id) }
      : message))
    setMessages(current => [...current, {
      id: streamingMessageId,
      role: 'assistant',
      content: '',
      runId: retried.run_id,
      turn: null,
    }])
    try {
      await runsApi.streamTurn(retried.run_id, {
        spaceId: agent.space_id,
        onTurn: turn => {
          streamedTurn = turn
          const text = turn.parts.filter(part => part.type === 'text').map(part => part.text).join('')
          setMessages(current => current.map(message => message.id === streamingMessageId
            ? { ...message, content: text, turn }
            : message))
        },
      })
      const rows = await sessionsApi.messages(retried.session_id)
      const assistant = rows.find(message => message.role === 'assistant' && message.run_id === retried.run_id)
      const finalTurn = streamedTurn as RunTurn | null
      const finalText = assistant?.content ?? finalTurn?.parts.filter(part => part.type === 'text').map(part => part.text).join('') ?? ''
      setMessages(current => current.map(message => message.id === streamingMessageId
        ? { ...message, id: assistant?.id ?? streamingMessageId, content: finalText, turn: settledTurn(finalTurn, finalTurn?.state ?? 'done', finalText) }
        : message))
    } catch (error) {
      const note = errMsg(error)
      setMessages(current => current.map(message => message.id === streamingMessageId
        ? { ...message, content: message.content ? `${message.content}\n\n${note}` : note, error: true, turn: settledTurn(streamedTurn, 'failed', note) }
        : message))
      throw error
    }
  }, [agent.id, agent.space_id, onSessionChange])

  // Auto-send a draft carried from Home's assistant entry (the user already hit "Open").
  useEffect(() => {
    if (
      initialDraft &&
      initialDraft.trim() &&
      !autoSentRef.current &&
      !loadingHistory &&
      !loadingBackends &&
      backend
    ) {
      autoSentRef.current = true
      void send(initialDraft, [])
    }
  }, [backend, initialDraft, loadingBackends, loadingHistory, send])

  const providerMissing = messages.some(m => m.error && m.content.includes('model provider'))
  const backendChoices = flattenBackendChoices(backendOptions)
  const selectedBackendKey = backend ? backendKey(backend) : ''
  const selectedHost = selectedBackendOption?.host_id ? hosts.find(host => host.id === selectedBackendOption.host_id) : null
  const archivedManagedWorkspace = selectedBackendOption?.workspace_mode === 'managed'
    && selectedHost?.managed_workspaces_json?.some(workspace =>
      workspace.container_kind === 'direct' && workspace.agent_id === agent.id && workspace.container_id === userId && workspace.archived_available)
  const hostBlocked = Boolean(selectedBackendOption?.host_bound && selectedBackendOption.usable === false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  async function resetContext() {
    if (!selectedBackendOption?.host_bound || !selectedBackendOption.host_owner_is_me || !selectedBackendOption.host_online) return
    try {
      await agentsApi.resetContext(agent.id)
      setRestoreWorkspace(false)
      toast.success('Host context reset')
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset this Agent's host context?"
        description="The next direct message starts a fresh vendor session. Files in its workspace stay."
        confirmLabel="Reset context"
        onConfirm={() => void resetContext()}
      />
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Backend</span>
          <select
            aria-label="Conversation backend"
            value={selectedBackendKey}
            disabled={loadingBackends || sending || backendChoices.length === 0}
            onChange={event => {
              const selected = backendChoices.find(choice => choice.key === event.target.value)
              if (selected) {
                setBackend(selected.backend)
                const option = backendOptions.find(candidate => candidate.runtime_profile_id === selected.backend.runtime_profile_id)
                setSessionConfig(mergeSessionConfig(option?.session_config_options ?? [], []))
              }
            }}
            className="h-8 min-w-0 max-w-[22rem] rounded-md border border-border bg-input px-2 text-xs text-foreground"
          >
            {loadingBackends && <option value="">Loading backends…</option>}
            {!loadingBackends && backendChoices.length === 0 && <option value="">No eligible backend</option>}
            {!loadingBackends && backendChoices.length > 0 && !backend && (
              <option value="" disabled>Select backend…</option>
            )}
            {backendChoices.map(choice => (
                <option key={choice.key} value={choice.key} disabled={!choice.usable}>{choice.label}{choice.usable ? '' : ' · unavailable'}</option>
              ))}
          </select>
        </label>
        {sessionId && (
          <Link to={`/sessions?open=${sessionId}`} className="text-[12px] text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
            Chat history
          </Link>
        )}
      </div>
      {selectedBackendOption?.host_bound && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs" role="status">
          <span className={hostBlocked ? 'text-destructive' : 'text-muted-foreground'}>
            {selectedBackendOption.workspace_mode === 'managed' ? 'Managed workspace' : 'Project Location'} on {selectedBackendOption.host_name ?? 'host'}
            {hostBlocked ? ` · ${selectedBackendOption.reason ?? 'unavailable'}` : ' · owner-only'}
          </span>
          {selectedBackendOption.host_owner_is_me && selectedBackendOption.host_online && (
            <Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => setResetConfirmOpen(true)}>Reset context</Button>
          )}
        </div>
      )}
      {selectedBackendOption && <div className="mb-2 rounded-md border border-border bg-muted/20 px-3 py-2"><ConversationGitContext snapshot={selectedBackendOption.git ?? null} /></div>}
      {hostError && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
        <span>{hostError}</span>
        {sessionId && hostError.toLowerCase().includes('git branch or commit changed') && <Button type="button" size="sm" variant="outline" onClick={() => void refreshDirectGit()}>Refresh Git context</Button>}
      </div>}
      {archivedManagedWorkspace && !hostBlocked && (
        <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={restoreWorkspace} onChange={event => setRestoreWorkspace(event.target.checked)} disabled={sending} />
          Restore previous managed workspace for this Agent
        </label>
      )}
      {!loadingBackends && backendChoices.length === 0 && (
        <p className="mb-2 text-xs text-warning" role="alert">
          No eligible conversation backend is configured. Add a model provider or grant one of your CLI login profiles to this space.
        </p>
      )}
      <ConversationView
        entries={messages.map((m, index) => {
          const runIds = m.role === 'user' ? (m.runIds ?? (m.runId ? [m.runId] : [])) : []
          return {
            id: m.id ?? `entry-${index}`,
            role: m.role === 'user' ? 'user' as const : 'assistant' as const,
            content: m.content,
            inputParts: m.inputParts,
            turn: m.turn ?? null,
            error: m.error,
            extra: (
              <>
                {(() => {
                  // Filtered here as in the Room: a card that names one decider
                  // is rendered for that person only (ADR 0003 §5).
                  const cards = decidableByViewer(m.actionPreviews ?? [], userId)
                  return cards.length ? <div className="mt-2 space-y-2">{cards.map((preview, index) => <ActionPreviewCard key={`${preview.action_id}:${preview.proposal_id ?? index}`} preview={preview} />)}</div> : null
                })()}
                {m.artifactRefs?.length ? <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                  {m.artifactRefs?.map((artifactId, index) => <Link key={artifactId} className="text-accent-foreground hover:underline" to={`/artifacts/${artifactId}`}>Produced artifact {index + 1}</Link>)}
                </div> : null}
                {m.error && providerMissing && m.content.includes('model provider') && (
                  <div className="mt-1.5">
                    <Link to="/providers" className="text-[12px] underline text-accent-foreground">Configure a provider →</Link>
                  </div>
                )}
              </>
            ),
            runControls: runIds.length > 0 ? runIds.map(runId => <ConversationRunControls
              key={runId}
              runId={runId}
              projectId={projectId}
              onRetry={retryRun}
            />) : undefined,
          }
        })}
        sending={sending}
        loadingHistory={loadingHistory}
        input={input}
        onInputChange={setInput}
        onSend={() => void send(input)}
        runHref={entry => (entry.turn ? `/runs/${entry.turn.run_id}` : undefined)}
        placeholder="Ask your assistant… (Enter to send, Shift+Enter for newline)"
        emptyTitle="Ask your assistant"
        emptyDescription="It is aware of your space — memory, projects, captures, runs, and proposals. Long-term changes are always proposals you approve."
        composerDisabled={loadingBackends || !backend || hostBlocked}
        composerControls={selectedBackendOption?.session_config_options?.length ? (
          <ConversationSessionConfig
            options={selectedBackendOption.session_config_options}
            value={sessionConfig}
            onChange={setSessionConfig}
            disabled={sending || loadingBackends || hostBlocked}
          />
        ) : undefined}
        composerNote={awaitingDecision
          ? 'This turn is waiting for your decision. Review it to carry on.'
          : undefined}
        inputParts={inputParts}
        onInputPartsChange={setInputParts}
        sessionId={sessionId}
        projectId={projectId}
        inputFileSources={directInputFileSources}
        inputResetToken={inputResetToken}
        inputCapabilities={selectedBackendOption?.prompt_capabilities}
      />
    </div>
  )
}

/**
 * One choice per runtime profile. A CLI backend used to fan out into one
 * choice per brokered credential profile; a CLI now runs on an execution host
 * with its own login, so the profile names the whole choice.
 */
function flattenBackendChoices(options: ConversationBackendOption[]): BackendChoice[] {
  return options.map<BackendChoice>(option => {
    const backend: ConversationBackendBinding = {
      runtime_profile_id: option.runtime_profile_id,
      adapter_type: option.adapter_type,
    }
    return {
      key: backendKey(backend),
      label: `${option.name} · ${option.model_name ?? option.adapter_type}`,
      backend,
      usable: option.usable !== false,
      reason: option.reason,
    }
  })
}

function defaultBackend(options: ConversationBackendOption[]): ConversationBackendBinding | null {
  return flattenBackendChoices(options).find(choice => choice.usable)?.backend ?? null
}

function catalogBackend(
  options: ConversationBackendOption[],
  binding: ConversationBackendBinding | null,
): ConversationBackendBinding | null {
  const choices = flattenBackendChoices(options)
  if (binding) {
    const matched = choices.find(choice => choice.key === backendKey(binding))
    if (matched) return matched.backend
    return null
  }
  return defaultBackend(options)
}

function backendKey(backend: Pick<ConversationBackendBinding, 'runtime_profile_id'>) {
  return backend.runtime_profile_id
}


function hostErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function uniqueRunIds(...values: unknown[]): string[] {
  const ids = values.flatMap(value => Array.isArray(value) ? value : [value])
  return [...new Set(ids.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

async function refreshActionPreviews(previews?: ChatActionPreview[]) {
  if (!previews) return undefined
  return Promise.all(previews.map(async preview => {
    if (!preview.proposal_id) return preview
    try {
      const proposal = await proposalsApi.get(preview.proposal_id)
      const status: ChatActionPreview['status'] = proposal.status === 'pending'
        ? 'proposed'
        : proposal.status === 'accepted'
          ? 'completed'
          : proposal.status === 'rejected'
            ? 'rejected'
            : 'failed'
      return { ...preview, status }
    } catch {
      return preview
    }
  }))
}

function ActionPreviewCard({ preview }: { preview: ChatActionPreview }) {
  return <div className="rounded-md border border-border bg-background p-3 text-foreground">
    <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{preview.title ?? preview.proposal_type ?? preview.action_id}</span><span className="text-[10px] uppercase text-muted-foreground">{preview.status.replace('_', ' ')}</span></div>
    {preview.summary && <p className="mt-1 text-xs text-muted-foreground">{preview.summary}</p>}
    <div className="mt-2 flex gap-3 text-[11px]">{preview.risk_level && <span>{preview.risk_level} risk</span>}{preview.proposal_id && <Link className="text-accent-foreground hover:underline" to={`/proposals/${preview.proposal_id}`}>Review proposal</Link>}</div>
  </div>
}
