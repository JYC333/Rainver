import { type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { RunTurn } from '../../types/api'
import {
  Conversation, ConversationContent, ConversationScrollButton,
} from '../../components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '../../components/ai-elements/message'
import { Textarea } from '../../components/ui/textarea'
import { EmptyState } from '../../components/ui/empty-state'
import { ConversationTurn } from './ConversationTurn'
import { ConversationComposer } from './ConversationComposer'

/**
 * What a surface hands this view for one entry in the transcript.
 *
 * A person's message is text. An Agent's is a turn — the parts it produced —
 * or, once it is history, the text it settled on. A surface that has the turn
 * passes it; one reading persisted messages back does not, and the reply
 * renders as prose.
 */
export interface ConversationEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** The live or replayed turn, when this surface has it. */
  turn?: RunTurn | null
  error?: boolean
  /** Rendered after the body — a reference card, an edit summary. */
  extra?: ReactNode
}

/**
 * The message list and composer every conversation surface shares.
 *
 * It renders a person's message as a bubble and an Agent's through
 * `ConversationTurn`, so the same turn looks the same in the Room, in a chat
 * panel, and beside a notebook. Callers own session, history and send state;
 * this is presentational.
 */
export function ConversationView({
  entries,
  sending,
  loadingHistory,
  input,
  onInputChange,
  onSend,
  placeholder,
  emptyTitle,
  emptyDescription,
  composerDisabled = false,
  composerNote,
  composerControls,
  runHref,
}: {
  entries: ConversationEntry[]
  sending: boolean
  loadingHistory: boolean
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  placeholder: string
  emptyTitle: string
  emptyDescription: string
  composerDisabled?: boolean
  /** Why the composer is disabled, when there is something worth saying. */
  composerNote?: string
  composerControls?: ReactNode
  runHref?: (entry: ConversationEntry) => string | undefined
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        `Conversation` sticks to the bottom while new messages arrive and lets
        go the moment the reader scrolls up — which a plain scroll-on-update
        does not, and which matters most in the turn that is still growing.
      */}
      <Conversation className="flex-1 rounded-lg border border-border bg-card">
        <ConversationContent className="p-4">
        {loadingHistory ? (
          <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading conversation…
          </div>
        ) : entries.length === 0 && !sending ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          <div className="flex flex-col gap-4">
            {entries.map(entry => (
              <ConversationEntryView key={entry.id} entry={entry} runHref={runHref?.(entry)} />
            ))}
            {/*
              Only until *this* turn appears. A turn renders what it is doing
              — including that it has stopped and is waiting on the person —
              and a spinner beside it would say the opposite.

              The last entry, not any entry: once history reads its turns
              back, an older reply carrying one would otherwise suppress the
              indicator for every new message, leaving nothing at all between
              the send and the first frame.
            */}
            {sending && !entries[entries.length - 1]?.turn && (
              <Message from="assistant">
                <MessageContent>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Thinking…
                  </span>
                </MessageContent>
              </Message>
            )}
          </div>
        )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form className="mt-3" onSubmit={event => { event.preventDefault(); onSend() }}>
        <ConversationComposer
          editor={<Textarea
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              onSend()
            }
          }}
          placeholder={placeholder}
          disabled={composerDisabled}
          rows={2}
          className="min-h-[84px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />}
          controls={composerControls}
          note={composerNote}
          sending={sending}
          sendDisabled={composerDisabled || sending || loadingHistory || !input.trim()}
          onSend={onSend}
        />
      </form>
    </div>
  )
}

function ConversationEntryView({ entry, runHref }: { entry: ConversationEntry; runHref?: string }) {
  if (entry.role === 'assistant' && entry.turn) {
    return (
      <div>
        <ConversationTurn turn={entry.turn} runHref={runHref} />
        {entry.extra}
      </div>
    )
  }

  return (
    <Message from={entry.role}>
      <MessageContent>
        {entry.error && (
          <span className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3" /> Could not complete
          </span>
        )}
        <MessageResponse>{entry.content}</MessageResponse>
        {entry.extra}
      </MessageContent>
    </Message>
  )
}
