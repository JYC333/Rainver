import type { ReactNode } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '../../components/ui/button'

/** One composer frame for direct chat, Rooms, and the Project sidecar. */
export function ConversationComposer({ editor, controls, note, sending, sendDisabled, onSend }: {
  editor: ReactNode
  controls?: ReactNode
  note?: ReactNode
  sending: boolean
  sendDisabled: boolean
  onSend: () => void
}) {
  return (
    <div className="rounded-lg border border-border bg-background focus-within:ring-1 focus-within:ring-ring">
      {editor}
      <div className="flex min-h-10 items-end justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {controls}
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
        <Button type="button" size="sm" disabled={sendDisabled} onClick={onSend} aria-label="Send">
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  )
}
