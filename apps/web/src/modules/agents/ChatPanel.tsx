import { useAttentionViewing } from '../agent_work/AgentAttentionProvider'
import { ConversationScope, useConversationScope } from '../conversation/ConversationScope'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConversationLink as Link } from '../conversation/ConversationScope'
import { agentsApi, hostsApi, runsApi, sessionsApi } from '../../api/client'
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
  SavedConversationSessionConfig,
  mergeSessionConfig,
  type SessionConfigSelection,
} from '../conversation/ConversationSessionConfig'
import { readBackTurnState, settledTurn } from '../conversation/settledTurn'
import { ActionPreviewCards } from '../conversation/ActionPreviewCard'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { ConfirmDialog } from '../../components/ui/dialog'
import type { ConversationInputPart } from '@rainver/protocol'
import { ConversationGitContext } from '../conversation/ConversationGitContext'
import { clearConversationDraft, writeConversationDraft } from '../conversation/conversationDraft'
import { useConversationDraft } from '../conversation/useConversationDraft'
import { ConversationRunControls } from '../conversation/ConversationRunControls'

/**
 * How far back a reload reads turns for.
 *
 * Every read is a `loadRunTurn`, so this is what keeps opening a long
 * conversation from fanning out one request per reply. Older replies render
 * as prose.
 */
const HISTORY_TURN_READS = 20

const emptyText = () => ''
const sameText = (text: string) => text
const replaceText = (_current: string, text: string) => text

const STREAM_PLACEHOLDER_PREFIX = 'stream:'
const RETRY_STREAM_PLACEHOLDER_PREFIX = 'retry-stream:'
const isStreamPlaceholderId = (id: string) => id.startsWith(STREAM_PLACEHOLDER_PREFIX) || id.startsWith(RETRY_STREAM_PLACEHOLDER_PREFIX)

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
export default function ChatPanel(props: Parameters<typeof ChatPanelContent>[0]) {
  const [destination, setDestination] = useState({ requested: props.initialSessionId, accepted: undefined as string | undefined, epoch: 0 })
  if (destination.requested !== props.initialSessionId) {
    setDestination({ requested: props.initialSessionId, accepted: undefined, epoch: destination.epoch + (props.initialSessionId === destination.accepted ? 0 : 1) })
  }
  const sessionChanged = useCallback((sessionId: string) => {
    setDestination(current => ({ ...current, accepted: sessionId }))
    props.onSessionChange?.(sessionId)
  }, [props.onSessionChange])
  return <ConversationScope key={`${props.agent.space_id}:${props.agent.id}:${destination.epoch}`} spaceId={props.agent.space_id}>
    <ChatPanelContent {...props} onSessionChange={sessionChanged} />
  </ConversationScope>
}

function ChatPanelContent({
  agent,
  initialDraft,
  initialSessionId,
  onSessionChange,
  projectId,
  onMessagesDisplayed,
  onReadError,
}: {
  agent: AgentOut
  onMessagesDisplayed?: (ids: string[]) => void
  onReadError?: (error: unknown) => void
  initialDraft?: string | null
  initialSessionId?: string | null
  onSessionChange?: (sessionId: string) => void
  projectId?: string
}) {
  const scope = useConversationScope()
  const { userId } = useSpace()
  const { t } = useAppTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId ?? undefined)
  const draftDestination = `direct:${agent.id}:${projectId ?? ''}:${sessionId ?? 'new'}`
  const {
    value: input,
    parts: inputParts,
    setValue: changeInput,
    setParts: changeInputParts,
    draftRef: draftInputRef,
    readyRef: draftReadyRef,
  } = useConversationDraft({
    destination: draftDestination,
    initialValue: emptyText,
    textOf: sameText,
    withText: replaceText,
    sessionId,
  })
  const [sending, setSending] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(Boolean(initialSessionId))
  // A streaming placeholder has a client-only id; the stored reply reports itself once it arrives.
  useAttentionViewing(agent.space_id, sessionId, {
    messages: messages.flatMap(message => message.id && !isStreamPlaceholderId(message.id) ? [{ id: message.id, content: message.content }] : []),
    ready: !loadingHistory,
  })
  useEffect(() => {
    if (!loadingHistory && messages.length) onMessagesDisplayed?.(messages.flatMap(message => message.id ? [message.id] : []))
  }, [loadingHistory, messages, onMessagesDisplayed])
  const readErrorRef = useRef(onReadError)
  readErrorRef.current = onReadError
  const [backendOptions, setBackendOptions] = useState<ConversationBackendOption[]>([])
  const [backend, setBackend] = useState<ConversationBackendBinding | null>(null)
  const [loadingBackends, setLoadingBackends] = useState(true)
  const [savedSessionConfig, setSavedSessionConfig] = useState<SessionConfigSelection[]>([])
  const [sessionConfig, setSessionConfig] = useState<SessionConfigSelection[]>([])
  const [hosts, setHosts] = useState<Awaited<ReturnType<typeof hostsApi.list>>['items']>([])
  const [restoreWorkspace, setRestoreWorkspace] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const autoSentRef = useRef(false)
  // Capture the session that was provided at mount time (via URL). Sessions
  // created during chat are already reflected in local state; re-fetching them
  // from the DB would wipe error messages that were never persisted.
  const externalSessionRef = useRef(initialSessionId)

  useEffect(() => {
    let cancelled = false
    setLoadingBackends(true)
    agentsApi.conversationBackends(agent.id, { ...scope,
      spaceId: agent.space_id,
      sessionId: initialSessionId ?? undefined,
    })
      .then(catalog => {
        if (cancelled) return
        const selected = catalogBackend(catalog.options, catalog.binding)
        setBackendOptions(catalog.options)
        setBackend(selected)
        const option = catalog.options.find(candidate => candidate.runtime_profile_id === selected?.runtime_profile_id)
        setSavedSessionConfig(catalog.session_config ?? [])
        setSessionConfig(mergeSessionConfig(option?.session_config_options ?? [], catalog.session_config ?? []))
      })
      .catch(error => {
        if (!cancelled) toast.error(errMsg(error))
      })
      .finally(() => {
        if (!cancelled) setLoadingBackends(false)
      })
    return () => { cancelled = true }
  }, [agent.id, agent.space_id, initialSessionId, scope])

  useEffect(() => {
    if (!backendOptions.some(option => option.host_bound)) {
      setHosts([])
      return
    }
    if (typeof hostsApi?.list !== 'function') {
      setHosts([])
      return
    }
    hostsApi.list(scope).then(response => setHosts(response.items)).catch(() => setHosts([]))
  }, [backendOptions, scope])

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
    sessionsApi.messages(id, scope)
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
          actionPreviews: Array.isArray(m.metadata_json?.action_previews) ? m.metadata_json.action_previews as ChatActionPreview[] : undefined,
          artifactRefs: Array.isArray(m.metadata_json?.artifact_refs) ? m.metadata_json.artifact_refs.filter((value): value is string => typeof value === 'string') : undefined,
          runId: m.run_id ?? undefined,
          runIds: uniqueRunIds(m.run_id, m.metadata_json?.retry_run_ids),
          // The turn behind a saved reply, so the fold survives a reload
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
            ? await runsApi.turn(m.run_id, scope)
              .then(read => settledTurn(read, readBackTurnState(read.state, read.blocked_on), m.content))
              .catch(() => null)
            : null,
        })))
        if (cancelled) return
        setSessionId(id)
        setMessages(history)
      })
      .catch(e => {
        if (!cancelled) { toast.error(errMsg(e)); readErrorRef.current?.(e) }
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false)
      })
    return () => { cancelled = true }
  }, [initialSessionId, scope])

  const selectedBackendOption = backendOptions.find(option => option.runtime_profile_id === backend?.runtime_profile_id) ?? null
  const directInputFileSources = selectedBackendOption?.workspace_mode === 'location'
    && selectedBackendOption.project_folder_id
    && selectedBackendOption.workspace_location_id
    ? [{
      projectFolderId: selectedBackendOption.project_folder_id,
      workspaceLocationId: selectedBackendOption.workspace_location_id,
      label: t('conversation_ui.chat.primary_workspace'),
    }]
    : []
  /**
   * A turn's request, from send until it resolves — including while it is
   * blocked, which is a stop rather than an end.
   *
   * `sending` says the same thing and drives the spinner and the composer.
   * `send` reads this ref synchronously, before a
   * state update could have landed.
   */
  const inFlight = useRef(false)
  const sendGeneration = useRef(0)
  // A turn waiting for its directory is still running, not waiting on a person.
  const awaitingDecision = messages.some(message => message.turn?.state === 'blocked'
    && message.turn.blocked_on !== 'workspace' && message.turn.blocked_on !== 'quota')

  const send = useCallback(async (text: string, parts: ConversationInputPart[] = inputParts) => {
    const message = text.trim()
    // `inFlight` rather than `sending`: a blocked turn hands the composer back
    // so the person can go and approve something, but its request is still
    // open, and a second send while it is would be two turns at once.
    //
    // `awaitingDecision` as well as `inFlight`, because the same stop is
    // reachable two ways: a turn blocked in this session, whose request is
    // still open, and one blocked before a reload, whose is not. The note
    // above the composer is driven by `awaitingDecision`. Guard on both: a
    // guard that only sees `inFlight` tells the person their message is held
    // and then sends it anyway.
    if ((!message && parts.length === 0) || inFlight.current || savingSettings || awaitingDecision || loadingHistory || loadingBackends || !backend || selectedBackendOption?.usable === false) return
    inFlight.current = true
    const generation = ++sendGeneration.current
    const submittedDraft = draftInputRef.current
    setHostError(null)
    setMessages(m => [...m, { role: 'user', content: message, inputParts: parts }])
    setSending(true)
    const streamingMessageId = `${STREAM_PLACEHOLDER_PREFIX}${crypto.randomUUID()}`
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
          ...(!sessionId && sessionConfig.length ? { session_config: sessionConfig } : {}),
          ...(restoreWorkspace ? { restore_workspace: true } : {}),
        },
        { ...scope,
          spaceId: agent.space_id,
          onAccepted: accepted => {
            if (scope.signal?.aborted) return
            // Acceptance consumes this submission, while the live response may
            // outlast several edits to the next draft. Keep those edits and any
            // attachments added since send, including uploads still in flight.
            const currentDraft = draftInputRef.current
            if (currentDraft.textVersion === submittedDraft.textVersion && submittedDraft.value === text) changeInput('')
            changeInputParts(currentDraft.parts.filter(part => !parts.includes(part)))
            const acceptedDestination = `direct:${agent.id}:${projectId ?? ''}:${accepted.session_id}`
            draftReadyRef.current = acceptedDestination
            if (draftDestination !== acceptedDestination) clearConversationDraft(draftDestination)
            writeConversationDraft({
              destination: acceptedDestination,
              text: draftInputRef.current.value,
              input_parts: draftInputRef.current.parts,
            })
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
            if (scope.signal?.aborted) return
            // A quota hold releases the server conversation turn. Keep its
            // stream for eventual completion while allowing a new instruction.
            // An older stream must never clear a newer send's guard or draft.
            if (sendGeneration.current === generation) {
              const waitingQuota = turn.state === 'blocked' && turn.blocked_on === 'quota'
              inFlight.current = !waitingQuota
              setSending(!waitingQuota)
            }

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
      if (scope.signal?.aborted) return
      setSessionId(res.session_id)
      setRestoreWorkspace(false)
      onSessionChange?.(res.session_id)
      if (res.ok) {
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
        const note = res.error ?? t('conversation_ui.chat.turn_failed')
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
          ? t('conversation_ui.chat.host_owner_only')
          : errorStatus === 503
            ? t('conversation_ui.chat.host_offline')
            : t('conversation_ui.chat.workspace_unavailable')
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
      if (sendGeneration.current === generation) {
        inFlight.current = false
        setSending(false)
      }
    }
  }, [agent.id, agent.space_id, awaitingDecision, backend, changeInput, changeInputParts, draftDestination, inputParts, loadingBackends, loadingHistory, onSessionChange, projectId, restoreWorkspace, selectedBackendOption?.usable, sessionConfig, sessionId, scope, savingSettings])

  const retryRun = useCallback(async (runId: string) => {
    const retried = await agentsApi.retryConversation(agent.id, runId, { ...scope, spaceId: agent.space_id })
    if (scope.signal?.aborted) return
    const streamingMessageId = `${RETRY_STREAM_PLACEHOLDER_PREFIX}${crypto.randomUUID()}`
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
      await runsApi.streamTurn(retried.run_id, { ...scope,
        spaceId: agent.space_id,
        onTurn: turn => {
            if (scope.signal?.aborted) return
          streamedTurn = turn
          const text = turn.parts.filter(part => part.type === 'text').map(part => part.text).join('')
          setMessages(current => current.map(message => message.id === streamingMessageId
            ? { ...message, content: text, turn }
            : message))
        },
      })
      const rows = await sessionsApi.messages(retried.session_id, scope)
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
  }, [agent.id, agent.space_id, onSessionChange, scope])

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
  }, [backend, initialDraft, loadingBackends, loadingHistory, send, scope])

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
      await agentsApi.resetContext(agent.id, scope)
      setRestoreWorkspace(false)
      toast.success(t('conversation_ui.chat.context_reset'))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title={t('conversation_ui.chat.reset_title')}
        description={t('conversation_ui.chat.reset_description')}
        confirmLabel={t('conversation_ui.chat.reset_confirm')}
        onConfirm={() => void resetContext()}
      />
      <div className="mb-2 flex items-center justify-between gap-3">
        {/* Not a <label>: the shared Select renders a <button>, which is not a
            labelable element, so the wrapper gave the control no accessible
            name. `ariaLabel` is what names it. */}
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">{t('conversation_ui.chat.backend')}</span>
          <Select
            ariaLabel={t('conversation_ui.chat.backend_label')}
            size="sm"
            className="min-w-0 max-w-[22rem]"
            value={selectedBackendKey}
            disabled={loadingBackends || sending || backendChoices.length === 0}
            onChange={nextKey => {
              const selected = backendChoices.find(choice => choice.key === nextKey)
              if (selected) {
                setBackend(selected.backend)
                const option = backendOptions.find(candidate => candidate.runtime_profile_id === selected.backend.runtime_profile_id)
                setSessionConfig(mergeSessionConfig(option?.session_config_options ?? [], []))
              }
            }}
            options={[
              ...(loadingBackends ? [{ value: '', label: t('conversation_ui.chat.loading_backends') }] : []),
              ...(!loadingBackends && backendChoices.length === 0 ? [{ value: '', label: t('conversation_ui.chat.no_backend') }] : []),
              ...(!loadingBackends && backendChoices.length > 0 && !backend
                ? [{ value: '', label: t('conversation_ui.chat.select_backend'), disabled: true }]
                : []),
              ...backendChoices.map(choice => ({
                value: choice.key,
                label: `${choice.label}${choice.usable ? '' : t('conversation_ui.chat.unavailable_suffix')}`,
                disabled: !choice.usable,
              })),
            ]}
          />
        </div>
        {sessionId && (
          <Link to={`/sessions?open=${sessionId}`} className="text-[12px] text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
            {t('conversation_ui.chat.history')}
          </Link>
        )}
      </div>
      {selectedBackendOption?.host_bound && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs" role="status">
          <span className={hostBlocked ? 'text-destructive' : 'text-muted-foreground'}>
            {t(selectedBackendOption.workspace_mode === 'managed' ? 'conversation_ui.chat.managed_on' : 'conversation_ui.chat.location_on', { host: selectedBackendOption.host_name ?? t('conversation_ui.chat.host_fallback') })}
            {hostBlocked ? ` · ${selectedBackendOption.reason ?? t('conversation_ui.chat.unavailable')}` : t('conversation_ui.chat.owner_only_suffix')}
          </span>
          {selectedBackendOption.host_owner_is_me && selectedBackendOption.host_online && (
            <Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => setResetConfirmOpen(true)}>{t('conversation_ui.chat.reset_confirm')}</Button>
          )}
        </div>
      )}
      {selectedBackendOption && <div className="mb-2 rounded-md border border-border bg-muted/20 px-3 py-2"><ConversationGitContext snapshot={selectedBackendOption.git ?? null} /></div>}
      {hostError && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
        <span>{hostError}</span>
      </div>}
      {archivedManagedWorkspace && !hostBlocked && (
        <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={restoreWorkspace} onChange={event => setRestoreWorkspace(event.target.checked)} disabled={sending} />
          {t('conversation_ui.chat.restore_workspace')}
        </label>
      )}
      {!loadingBackends && backendChoices.length === 0 && (
        <p className="mb-2 text-xs text-warning" role="alert">
          {t('conversation_ui.chat.no_eligible_backend')}
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
                <ActionPreviewCards previews={m.actionPreviews ?? []} viewerUserId={userId} />
                {m.artifactRefs?.length ? <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                  {m.artifactRefs?.map((artifactId, index) => <Link key={artifactId} className="text-accent-foreground hover:underline" to={`/artifacts/${artifactId}`}>{t('conversation_ui.chat.produced_artifact', { index: index + 1 })}</Link>)}
                </div> : null}
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
        onInputChange={changeInput}
        onSend={() => void send(input)}
        runHref={entry => (entry.turn ? `/runs/${entry.turn.run_id}` : undefined)}
        placeholder={t('conversation_ui.chat.placeholder')}
        emptyTitle={t('conversation_ui.chat.empty_title')}
        emptyDescription={t('conversation_ui.chat.empty_description')}
        composerDisabled={savingSettings || loadingBackends || !backend || hostBlocked}
        inputDisabled={savingSettings || loadingBackends || !backend || hostBlocked}
        composerControls={selectedBackendOption?.session_config_options?.length ? (
          <SavedConversationSessionConfig key={`${agent.space_id}:${agent.id}:${sessionId}:${selectedBackendOption.runtime_profile_id}`}
            options={selectedBackendOption.session_config_options}
            value={sessionConfig}
            persistedValue={savedSessionConfig}
            onChange={setSessionConfig}
            onSave={sessionId && backend ? async value => {
              setSavingSettings(true)
              try {
                await agentsApi.saveConversationSessionConfig(agent.id, {
                  session_id: sessionId, runtime_profile_id: backend.runtime_profile_id, session_config: value,
                }, scope)
                if (!scope.signal?.aborted) setSavedSessionConfig(value)
              } finally { setSavingSettings(false) }
            } : undefined}
            disabled={sending || loadingBackends || hostBlocked}
          />
        ) : undefined}
        composerNote={!sessionId ? t('conversation_ui.session_config.first_send') : awaitingDecision
          ? t('conversation_ui.chat.awaiting_decision')
          : undefined}
        inputParts={inputParts}
        skillAgentId={agent.id}
        onInputPartsChange={changeInputParts}
        sessionId={sessionId}
        projectId={projectId}
        inputFileSources={directInputFileSources}
        inputCapabilities={selectedBackendOption?.prompt_capabilities}
      />
    </div>
  )
}

/**
 * One choice per runtime profile. A CLI runs on an execution host with its own
 * login, so the profile names the whole choice. Do not fan one CLI out into a
 * choice per credential profile.
 */
function flattenBackendChoices(options: ConversationBackendOption[]): BackendChoice[] {
  return options.map<BackendChoice>(option => {
    const backend: ConversationBackendBinding = {
      runtime_profile_id: option.runtime_profile_id,
      runtime_key: option.runtime_key,
    }
    return {
      key: backendKey(backend),
      label: `${option.name} · ${option.model_name ?? option.runtime_key}`,
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
