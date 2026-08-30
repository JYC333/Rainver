import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { agentsApi, hostsApi, proposalsApi, sessionsApi } from '../../api/client'
import type {
  AgentOut,
  ChatActionPreview,
  ConversationBackendBinding,
  ConversationBackendOption,
  Message,
} from '../../types/api'
import { ChatThread, type ChatThreadMessage } from '../../components/ChatThread'
import { errMsg } from '../../lib/utils'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'

interface ChatMessage extends ChatThreadMessage {
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
  const [lifecycle, setLifecycle] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(Boolean(initialSessionId))
  const [backendOptions, setBackendOptions] = useState<ConversationBackendOption[]>([])
  const [backend, setBackend] = useState<ConversationBackendBinding | null>(null)
  const [loadingBackends, setLoadingBackends] = useState(true)
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
        setBackendOptions(catalog.options)
        setBackend(catalogBackend(catalog.options, catalog.binding))
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
        const history = await Promise.all(rows.map(async m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          actionPreviews: await refreshActionPreviews(Array.isArray(m.metadata_json?.action_previews) ? m.metadata_json.action_previews as ChatActionPreview[] : undefined),
          artifactRefs: Array.isArray(m.metadata_json?.artifact_refs) ? m.metadata_json.artifact_refs.filter((value): value is string => typeof value === 'string') : undefined,
          runId: typeof m.metadata_json?.run_id === 'string' ? m.metadata_json.run_id : undefined,
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

  const send = useCallback(async (text: string) => {
    const message = text.trim()
    if (!message || sending || loadingHistory || loadingBackends || !backend || selectedBackendOption?.usable === false) return
    setInput('')
    setHostError(null)
    setMessages(m => [...m, { role: 'user', content: message }])
    setSending(true)
    setLifecycle('Queued')
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
          onLifecycle: event => {
            setLifecycle(event.summary?.trim() || lifecycleLabel(event.event_type))
          },
          onTextDelta: delta => {
            streamedContent += delta
            setMessages(current => {
              const index = current.findIndex(item => item.id === streamingMessageId)
              if (index < 0) {
                return [...current, {
                  id: streamingMessageId,
                  role: 'assistant',
                  content: delta,
                }]
              }
              return current.map((item, itemIndex) =>
                itemIndex === index ? { ...item, content: item.content + delta } : item)
            })
          },
        },
      )
      setSessionId(res.session_id)
      setRestoreWorkspace(false)
      onSessionChange?.(res.session_id)
      if (res.ok) {
        setMessages(current => {
          const completed: ChatMessage = {
            id: res.assistant_message?.id,
            role: 'assistant',
            content: res.reply ?? '',
            actionPreviews: res.action_previews,
            artifactRefs: res.assistant_message?.artifact_refs,
            runId: res.run_id,
          }
          return current.some(item => item.id === streamingMessageId)
            ? current.map(item => item.id === streamingMessageId ? completed : item)
            : [...current, completed]
        })
      } else {
        const note = res.error_code === 'model_provider_required'
          ? 'No model provider is configured for this space yet. Add one to enable chat.'
          : (res.error ?? 'The assistant could not complete this turn.')
        setMessages(current => {
          const failed: ChatMessage = {
            role: 'assistant',
            content: streamedContent ? `${streamedContent}\n\n${note}` : note,
            error: true,
            actionPreviews: res.action_previews,
          }
          return current.some(item => item.id === streamingMessageId)
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
        const failed: ChatMessage = {
          role: 'assistant',
          content: streamedContent ? `${streamedContent}\n\n${note}` : note,
          error: true,
        }
        return current.some(item => item.id === streamingMessageId)
          ? current.map(item => item.id === streamingMessageId ? failed : item)
          : [...current, failed]
      })
    } finally {
      setSending(false)
      setLifecycle(null)
    }
  }, [agent.id, agent.space_id, backend, loadingBackends, loadingHistory, onSessionChange, projectId, restoreWorkspace, selectedBackendOption?.usable, sessionId, sending])

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
      workspace.agent_id === agent.id && workspace.container_kind === 'direct' && workspace.container_id === userId && workspace.archived_available)
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
              if (selected) setBackend(selected.backend)
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
      {sending && lifecycle && (
        <div className="mb-2 text-xs text-muted-foreground" role="status">
          {lifecycle}
        </div>
      )}
      <ChatThread
        messages={messages.map(m => ({
          ...m,
          extra: (
            <>
              {m.actionPreviews?.length ? <div className="mt-2 space-y-2">{m.actionPreviews.map((preview, index) => <ActionPreviewCard key={`${preview.action_id}:${preview.proposal_id ?? index}`} preview={preview} />)}</div> : null}
              {(m.artifactRefs?.length || m.runId) && <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                {m.artifactRefs?.map((artifactId, index) => <Link key={artifactId} className="text-accent-foreground hover:underline" to={`/artifacts/${artifactId}`}>Produced artifact {index + 1}</Link>)}
                {m.runId && <Link className="text-muted-foreground hover:text-foreground hover:underline" to={`/runs/${m.runId}`}>Inspect Run</Link>}
              </div>}
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
        placeholder="Ask your assistant… (Enter to send, Shift+Enter for newline)"
        emptyTitle="Ask your assistant"
        emptyDescription="It is aware of your space — memory, projects, captures, runs, and proposals. Long-term changes are always proposals you approve."
        assistantLabel="Assistant"
        composerDisabled={loadingBackends || !backend || hostBlocked}
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

function lifecycleLabel(eventType: string) {
  return eventType
    .split('_')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
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
