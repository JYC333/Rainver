import { SpaceLink as Link } from '../../../core/spaceNav'
import { personLabel } from '../audience'
import { Quote, ShieldAlert } from 'lucide-react'
import { MessageResponse } from '../../../components/ai-elements/message'
import type { RoomMessage, SpaceMember, ThreadReferenceProvenance } from '../../../types/api'

/** The provenance a `reference` message carries, or null if it is not one. */
export function messageReference(
  metadata: Record<string, unknown> | null | undefined,
): ThreadReferenceProvenance | null {
  if (metadata?.room_display !== 'reference') return null
  const value = metadata.reference
  return value && typeof value === 'object' ? value as ThreadReferenceProvenance : null
}

const ORIGIN_LABEL: Record<ThreadReferenceProvenance['kind'], string> = {
  thread: 'a conversation',
  messages: 'messages from a conversation',
  imported_session: 'an imported session',
  imported_records: 'records from an imported session',
}

/**
 * A reference, rendered as what it is: content from somewhere else that a
 * person chose to bring here.
 *
 * Not a speech bubble. It has no speaker — it is `role: 'system'` — and
 * showing it as one would attribute a colleague's words, or a vendor
 * transcript's, to whoever appears to have said them. What it needs instead is
 * its origin, who brought it, and whether it is trusted.
 *
 * One-shot, so the link goes to the source as it is *now* while the quoted
 * text is as it was when attached. The two can differ, which is the point of
 * saying when it was taken.
 */
export function ReferenceMessage({
  message,
  reference,
  humans,
  viewerUserId,
  projectId,
}: {
  message: RoomMessage
  reference: ThreadReferenceProvenance
  humans: SpaceMember[]
  /** So a surface that has no member list can still say "You" for the common case. */
  viewerUserId: string | null
  /** Null while the Room's detail is still loading; the link waits for it. */
  projectId: string | null
}) {
  const attacher = humans.find(member => member.user_id === reference.attached_by_user_id)
  const attacherName = reference.attached_by_user_id === viewerUserId
    ? 'You'
    : attacher ? personLabel(attacher) : 'Someone'
  const external = reference.trust === 'external_untrusted'
  const origin = originLink(reference, projectId)
  const count = reference.item_ids.length

  return (
    <div className="flex justify-center" data-role="reference" data-testid={`reference-${message.id}`}>
      <div className="w-full rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <Quote className="size-3.5 shrink-0" />
          <span>
            {attacherName} brought in {ORIGIN_LABEL[reference.kind]}
            {count > 0 && ` (${count} ${count === 1 ? 'item' : 'items'})`}
          </span>
          {origin ? (
            <Link to={origin} className="font-medium text-foreground hover:underline">
              {reference.source_title ?? 'Open the source'}
            </Link>
          ) : (
            reference.source_title && <span className="font-medium text-foreground">{reference.source_title}</span>
          )}
          <span>· {new Date(reference.attached_at).toLocaleString()}</span>
          {external && (
            // Said plainly, because the fence around the content says it to
            // the model and this says it to the person: nothing in here is
            // Rainver's record of what a colleague decided.
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-500">
              <ShieldAlert className="size-3.5" />outside Rainver
            </span>
          )}
          {reference.clipped && <span>· shortened to fit</span>}
        </div>
        <MessageResponse className="text-sm">{message.content}</MessageResponse>
      </div>
    </div>
  )
}

/**
 * Where the source can be opened, or null when it cannot be.
 *
 * Logical, unscoped paths: `SpaceLink` adds the Space prefix every route in
 * this app lives under. Building it here instead is how the conversation link
 * came to point outside the router and land on Home.
 *
 * Null rather than a guess: a conversation attached before `source_room_id`
 * was recorded has no Room to open, and a link onto the wrong Room is worse
 * than none.
 */
function originLink(
  reference: ThreadReferenceProvenance,
  projectId: string | null,
): string | null {
  if (!projectId) return null
  if (reference.kind === 'imported_session' || reference.kind === 'imported_records') {
    return `/projects/${projectId}/imported-sessions/${reference.source_id}`
  }
  if (!reference.source_room_id) return null
  return `/projects/${projectId}/rooms?room=${reference.source_room_id}&conversation=${reference.source_id}`
}
