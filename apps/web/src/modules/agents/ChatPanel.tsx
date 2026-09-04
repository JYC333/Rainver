import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { agentsApi, hostsApi, proposalsApi, runsApi, sessionsApi } from '../../api/client'
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
import { errMsg } from '../../lib/utils'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'

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
          actionPreviews: await refreshActionPreviews(Array.isArray(m.metadata_json?.action_previews) ? m.metadata_json.action_previews as ChatActionPreview[] : undefined),
          artifactRefs: Array.isArray(m.metadata_json?.artifact_refs) ? m.metadata_json.artifact_refs.filter((value): value is string => typeof value === 'string') : undefined,
          runId: m.run_id ?? undefined,
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

  const selectedBackendOption = backendOptions.find(option => option.runtime_profile_id === backend?.runtime_profile_id) ?? null
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

  const send = useCallback(async (text: string) => {
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
    if (!message || inFlight.current || awaitingDecision || loadingHistory || loadingBackends || !backend || selectedBackendOption?.usable === false) return
    inFlight.current = true
    setInput('')
    setHostError(null)
    setMessages(m => [...m, { role: 'user', content: message }])
    setSending(true)
    const streamingMessageId = `stream:${crypto.randomUUID()}`
    let streamedContent = ''
    try {
      const res = await agentsApi.chat(
        agent.id,
        {
          message,
          session_id: sessionId,
          ...(projectId ? { project_id: projectId } : {}),
          backend: {
            runtime_profile_id: backend.runtime_profile_id,
            credential_profile_id: backend.credential_profile_id ?? null,
          },
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
                      ? { ...item, runId: accepted.run_id }
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
      const note = errorStatus !== null && [403, 409, 503].includes(errorStatus) && selectedBackendOption?.host_bound
        ? errorStatus === 403
          ? 'This host-bound Agent can only be triggered by the Host owner.'
          : errorStatus === 503
            ? 'The execution Host is offline. Reconnect it before sending this direct message.'
            : 'The host-bound workspace is unavailable or belongs to a different conversation context.'
        : errMsg(e)
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
  }, [agent.id, agent.space_id, awaitingDecision, backend, loadingBackends, loadingHistory, onSessionChange, projectId, restoreWorkspace, selectedBackendOption?.usable, sessionConfig, sessionId])

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
      void send(initialDraft)
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
      {hostError && <p className="mb-2 text-xs text-destructive" role="alert">{hostError}</p>}
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
        entries={messages.map((m, index) => ({
          id: m.id ?? `entry-${index}`,
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: m.content,
          turn: m.turn ?? null,
          error: m.error,
          extra: (
            <>
              {m.actionPreviews?.length ? <div className="mt-2 space-y-2">{m.actionPreviews.map((preview, index) => <ActionPreviewCard key={`${preview.action_id}:${preview.proposal_id ?? index}`} preview={preview} />)}</div> : null}
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
        }))}
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
      />
    </div>
  )
}

function flattenBackendChoices(options: ConversationBackendOption[]): BackendChoice[] {
  return options.flatMap<BackendChoice>(option => {
    if (!option.requires_cli_credential) {
      const backend: ConversationBackendBinding = {
        runtime_profile_id: option.runtime_profile_id,
        adapter_type: option.adapter_type,
        credential_profile_id: null,
      };
      return [{
        key: backendKey(backend),
        label: `${option.name} · ${option.model_name ?? option.adapter_type}`,
        backend,
        usable: option.usable !== false,
        reason: option.reason,
      }]
    }
    return option.credential_profiles.map(credential => {
      const backend: ConversationBackendBinding = {
        runtime_profile_id: option.runtime_profile_id,
        adapter_type: option.adapter_type,
        credential_profile_id: credential.id,
      }
      return {
        key: backendKey(backend),
        label: `${option.name} · ${option.adapter_type} · ${credential.name}${credential.is_default ? ' (default)' : ''}`,
        backend,
        usable: option.usable !== false,
        reason: option.reason,
      }
    })
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

function backendKey(backend: Pick<ConversationBackendBinding, 'runtime_profile_id' | 'credential_profile_id'>) {
  return `${backend.runtime_profile_id}:${backend.credential_profile_id ?? ''}`
}


function hostErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
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
