import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { projectResearchApi, notesApi, sessionsApi, type ModelProviderOut } from '../../../api/client'
import type { Message } from '../../../types/api'
import { ChatThread, type ChatThreadMessage } from '../../../components/ChatThread'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'
import { errMsg } from '../../../lib/utils'
import { defaultModelProvider } from '../../providers/defaultProvider'

interface NotebookEdit { note_id: string; version: number; conflict: boolean }
interface ChatMessage extends ChatThreadMessage { notebookEdit?: NotebookEdit | null }

const sessionStorageKey = (projectId: string) => `research-notebook-chat-session:${projectId}`

/**
 * Multi-turn conversation grounded in the project's notes + selected papers,
 * living next to the Notebook tab's note cards. Each turn calls
 * POST .../research/notebook-chat synchronously; when the reply includes a
 * notebook edit, the note already changed by the time the turn renders —
 * `onNotebookChanged` lets the parent refresh the note cards immediately.
 * The model may also create a brand-new note (see areaService.ts
 * notebookChat) rather than only editing one of the four starter notes.
 */
export function NotebookChatPanel({
  projectId,
  providers,
  noteTitleById,
  onNotebookChanged,
}: {
  projectId: string
  providers: ModelProviderOut[]
  noteTitleById: Map<string, string>
  onNotebookChanged: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(() => {
    try { return window.localStorage.getItem(sessionStorageKey(projectId)) ?? undefined } catch { return undefined }
  })
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(Boolean(sessionId))
  const [provider, setProvider] = useState('')

  useEffect(() => {
    setProvider(defaultModelProvider(providers)?.id ?? '')
  }, [providers])

  useEffect(() => {
    if (!sessionId) {
      setLoadingHistory(false)
      return
    }
    let cancelled = false
    setLoadingHistory(true)
    sessionsApi.messages(sessionId)
      .then((rows: Message[]) => {
        if (cancelled) return
        setMessages(rows.map(m => ({
          id: m.id, role: m.role, content: m.content,
          error: Boolean(m.metadata_json?.error),
          notebookEdit: (m.metadata_json?.notebook_edit as NotebookEdit | null | undefined) ?? null,
        })))
      })
      .catch(e => { if (!cancelled) toast.error(errMsg(e)) })
      .finally(() => { if (!cancelled) setLoadingHistory(false) })
    return () => { cancelled = true }
    // Only reload from the server for the session restored from storage on
    // mount — sessions created during this conversation already live in
    // local state, same rationale as ChatPanel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function send() {
    const message = input.trim()
    if (!message || sending || loadingHistory || !provider) return
    setInput('')
    setMessages(m => [...m, { role: 'user', content: message }])
    setSending(true)
    try {
      const result = await projectResearchApi.notebookChat(projectId, {
        message, session_id: sessionId, execution: { model_provider_id: provider },
      })
      setSessionId(result.session_id)
      try { window.localStorage.setItem(sessionStorageKey(projectId), result.session_id) } catch { /* ignore */ }
      if (result.ok) {
        setMessages(m => [...m, { role: 'assistant', content: result.reply ?? '', notebookEdit: result.notebook_edit ?? null }])
        if (result.notebook_edit) onNotebookChanged()
      } else {
        setMessages(m => [...m, { role: 'assistant', content: result.error ?? 'The notebook chat could not complete this turn.', error: true }])
      }
    } catch (e) {
      toast.error(errMsg(e))
      setMessages(m => [...m, { role: 'assistant', content: errMsg(e), error: true }])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-2">
      <p className="text-xs text-muted-foreground">Discuss and edit the project's notes. Edits apply immediately and can always be undone.</p>
      <Select value={provider} onChange={setProvider} ariaLabel="AI provider" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
      <div className="min-h-0 flex-1">
        <ChatThread
          messages={messages.map(m => ({
            ...m,
            extra: m.notebookEdit ? (
              <NotebookEditCard
                edit={m.notebookEdit}
                title={noteTitleById.get(m.notebookEdit.note_id) ?? 'a note'}
                onUndone={onNotebookChanged}
              />
            ) : null,
          }))}
          sending={sending}
          loadingHistory={loadingHistory}
          input={input}
          onInputChange={setInput}
          onSend={() => void send()}
          placeholder="Ask about or update the project's notes…"
          emptyTitle="Discuss the notes"
          emptyDescription="Ask a question or ask for an update — edits are applied immediately and can be undone."
          assistantLabel="Research"
        />
      </div>
    </div>
  )
}

function NotebookEditCard({ edit, title, onUndone }: { edit: NotebookEdit; title: string; onUndone: () => void }) {
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)

  async function undo() {
    setUndoing(true)
    try {
      await notesApi.rollback(edit.note_id, edit.version - 1)
      setUndone(true)
      toast.success('Change undone.')
      onUndone()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-background p-3 text-foreground">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{edit.conflict ? `Appended a labeled update to "${title}"` : `Updated "${title}"`}</span>
        {undone ? (
          <span className="text-[11px] text-muted-foreground">Undone</span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void undo()} disabled={undoing}>{undoing ? 'Undoing…' : 'Undo'}</Button>
        )}
      </div>
    </div>
  )
}
