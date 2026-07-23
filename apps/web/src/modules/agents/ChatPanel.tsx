import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { agentsApi, proposalsApi, sessionsApi } from '../../api/client'
import type { AgentOut, ChatActionPreview, Message } from '../../types/api'
import { ChatThread, type ChatThreadMessage } from '../../components/ChatThread'
import { errMsg } from '../../lib/utils'

interface ChatMessage extends ChatThreadMessage { actionPreviews?: ChatActionPreview[] }

/**
 * Synchronous chat surface for the space's Personal Assistant. Each turn calls
 * POST /agents/{id}/chat, which runs the no-tools model_api path server-side and
 * returns the reply. The active session id is reflected in the URL by the parent
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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId ?? undefined)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(Boolean(initialSessionId))
  const autoSentRef = useRef(false)
  // Capture the session that was provided at mount time (via URL). Sessions
  // created during chat are already reflected in local state; re-fetching them
  // from the DB would wipe error messages that were never persisted.
  const externalSessionRef = useRef(initialSessionId)

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
        const history = await Promise.all(rows.map(async m => ({ id: m.id, role: m.role, content: m.content, actionPreviews: await refreshActionPreviews(Array.isArray(m.metadata_json?.action_previews) ? m.metadata_json.action_previews as ChatActionPreview[] : undefined) })))
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

  const send = useCallback(async (text: string) => {
    const message = text.trim()
    if (!message || sending || loadingHistory) return
    setInput('')
    setMessages(m => [...m, { role: 'user', content: message }])
    setSending(true)
    try {
      const res = await agentsApi.chat(agent.id, { message, session_id: sessionId, ...(projectId ? { project_id: projectId } : {}) }, { spaceId: agent.space_id })
      setSessionId(res.session_id)
      if (res.ok) {
        onSessionChange?.(res.session_id)
        setMessages(m => [...m, { role: 'assistant', content: res.reply ?? '', actionPreviews: res.action_previews }])
      } else {
        const note = res.error_code === 'model_provider_required'
          ? 'No model provider is configured for this space yet. Add one to enable chat.'
          : (res.error ?? 'The assistant could not complete this turn.')
        setMessages(m => [...m, { role: 'assistant', content: note, error: true, actionPreviews: res.action_previews }])
      }
    } catch (e) {
      toast.error(errMsg(e))
      setMessages(m => [...m, { role: 'assistant', content: errMsg(e), error: true }])
    } finally {
      setSending(false)
    }
  }, [agent.id, agent.space_id, loadingHistory, onSessionChange, projectId, sessionId, sending])

  // Auto-send a draft carried from Home's assistant entry (the user already hit "Open").
  useEffect(() => {
    if (initialDraft && initialDraft.trim() && !autoSentRef.current && !loadingHistory) {
      autoSentRef.current = true
      void send(initialDraft)
    }
  }, [initialDraft, loadingHistory, send])

  const providerMissing = messages.some(m => m.error && m.content.includes('model provider'))

  return (
    <div className="flex flex-col h-full min-h-0">
      {sessionId && (
        <div className="mb-2 flex items-center justify-end">
          <Link to={`/sessions?open=${sessionId}`} className="text-[12px] text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
            Chat history
          </Link>
        </div>
      )}
      <ChatThread
        messages={messages.map(m => ({
          ...m,
          extra: (
            <>
              {m.actionPreviews?.length ? <div className="mt-2 space-y-2">{m.actionPreviews.map((preview, index) => <ActionPreviewCard key={`${preview.action_id}:${preview.proposal_id ?? index}`} preview={preview} />)}</div> : null}
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
      />
    </div>
  )
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
