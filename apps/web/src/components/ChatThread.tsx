import { useEffect, useRef, type ReactNode } from 'react'
import { Send, Loader2, Sparkles, AlertTriangle } from 'lucide-react'
import { MarkdownMessage } from '../modules/agent_groups/MarkdownMessage'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { EmptyState } from './ui/empty-state'

export interface ChatThreadMessage {
  id?: string
  role: string
  content: string
  error?: boolean
  /** Rendered after the message body — e.g. action previews, an edit card, a configure-provider link. */
  extra?: ReactNode
}

/**
 * Shared message-list + composer shell for a synchronous chat surface (one
 * request per turn, no streaming). Callers own session/history/send state
 * and pass the current message list in; this component is presentational.
 */
export function ChatThread({
  messages,
  sending,
  loadingHistory,
  input,
  onInputChange,
  onSend,
  placeholder,
  emptyTitle,
  emptyDescription,
  assistantLabel = 'Assistant',
  composerDisabled = false,
}: {
  messages: ChatThreadMessage[]
  sending: boolean
  loadingHistory: boolean
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  placeholder: string
  emptyTitle: string
  emptyDescription: string
  assistantLabel?: string
  composerDisabled?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-lg border border-border bg-card p-4">
        {loadingHistory ? (
          <div className="h-full min-h-[220px] flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" /> Loading conversation…
          </div>
        ) : messages.length === 0 && !sending ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-3">
            {messages.map((m, i) => (
              <li key={m.id ?? i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className="max-w-[85%] rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap break-words"
                  style={
                    m.role === 'user'
                      ? { background: 'var(--primary)', color: 'var(--primary-foreground)' }
                      : m.error
                        ? { background: 'color-mix(in oklch, var(--warning) 14%, transparent)', border: '1px solid color-mix(in oklch, var(--warning) 35%, transparent)', color: 'var(--foreground)' }
                        : { background: 'var(--muted)', color: 'var(--foreground)' }
                  }
                >
                  {m.role === 'assistant' && (
                    <span className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {m.error ? <AlertTriangle className="size-3" /> : <Sparkles className="size-3" />}
                      {m.error ? 'Could not complete' : assistantLabel}
                    </span>
                  )}
                  <MarkdownMessage content={m.content} />
                  {m.extra}
                </div>
              </li>
            ))}
            {sending && (
              <li className="flex justify-start">
                <div className="rounded-lg px-3 py-2 text-[13px] flex items-center gap-2 text-muted-foreground" style={{ background: 'var(--muted)' }}>
                  <Loader2 className="size-3.5 animate-spin" /> Thinking…
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); onSend() }}
      >
        <Textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
          }}
          placeholder={placeholder}
          disabled={composerDisabled}
          rows={2}
          className="resize-none flex-1"
        />
        <Button type="submit" disabled={composerDisabled || sending || loadingHistory || !input.trim()}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </form>
    </div>
  )
}
