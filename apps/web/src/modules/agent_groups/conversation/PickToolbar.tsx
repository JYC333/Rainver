import { Loader2, MessageSquarePlus, Quote, X } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'
import type { RoomConversation as RoomConversationRecord } from '../../../types/api'

/**
 * What to do with the messages someone has picked.
 *
 * Picking happens at the *source* — in the conversation the content is in,
 * where it can be read — rather than in a browser opened from the destination.
 * Choosing a thing should happen where the thing can be seen.
 *
 * Two destinations, because a reference is either the start of a new line of
 * thought or an addition to one already running. Both copy once and are done;
 * neither follows the source afterwards.
 */
export function PickToolbar({
  count,
  busy,
  canUseInNewThread,
  conversations,
  currentConversationId,
  onUseInNewThread,
  onAttachTo,
  onCancel,
}: {
  count: number
  busy: boolean
  /** False on a surface with nowhere to start a thread; the action is hidden. */
  canUseInNewThread: boolean
  conversations: RoomConversationRecord[]
  currentConversationId: string | null
  onUseInNewThread: () => void
  onAttachTo: (sessionId: string) => void
  onCancel: () => void
}) {
  // Never itself: copying a conversation's messages back into it would
  // duplicate content that is already there.
  const others = conversations.filter(conversation => conversation.id !== currentConversationId)

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/40 px-3 py-2 text-sm"
      role="region"
      aria-label="Picked messages"
    >
      <Quote className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">{count} {count === 1 ? 'message' : 'messages'} picked</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {canUseInNewThread && (
          <Button size="sm" variant="outline" disabled={busy || count === 0} onClick={onUseInNewThread}>
            {busy ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <MessageSquarePlus className="size-3.5 mr-1" />}
            Use in a new thread
          </Button>
        )}
        {others.length > 0 && (
          <div className="w-52">
            <Select
              ariaLabel="Attach to a thread"
              value=""
              size="sm"
              onChange={sessionId => { if (sessionId) onAttachTo(sessionId) }}
              options={[
                { value: '', label: 'Attach to a thread…' },
                ...others.map(conversation => ({
                  value: conversation.id,
                  label: conversation.title || 'Untitled conversation',
                })),
              ]}
            />
          </div>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel} aria-label="Cancel picking">
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
