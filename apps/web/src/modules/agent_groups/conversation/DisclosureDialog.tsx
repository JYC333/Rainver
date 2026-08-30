import { Button } from '../../../components/ui/button'
import { personLabel } from '../audience'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog'
import type { SpaceMember } from '../../../types/api'

/**
 * Confirming that a copy crosses an audience boundary.
 *
 * The server refuses the attach until it is confirmed and names who would
 * gain access, and this shows that list — a confirmation that cannot say who
 * is being let in is not informed consent (ADR 0013, ADR 0018 decision 3).
 *
 * What goes back is the ids the refusal named, not a bare `true`: a roster can
 * grow between the refusal and the confirmation, and `true` would consent to
 * people who were never shown.
 *
 * Declining attaches nothing. That is the whole of it — there is no partial
 * attach, because the picks are resolved and written in one transaction.
 */
export function DisclosureDialog({
  request,
  humans,
  busy,
  onConfirm,
  onCancel,
}: {
  request: { gainsAccessUserIds: string[]; detail: string } | null
  humans: SpaceMember[]
  busy: boolean
  onConfirm: (confirmUserIds: string[]) => void
  onCancel: () => void
}) {
  const names = (request?.gainsAccessUserIds ?? []).map(userId => {
    const person = humans.find(member => member.user_id === userId)
    return personLabel(person ?? { user_id: userId })
  })

  return (
    <Dialog open={Boolean(request)} onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>This shares it wider than it is now</DialogTitle>
          <DialogDescription>{request?.detail}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            {names.length === 1 ? 'This person could not read it before:' : `These ${names.length} people could not read it before:`}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded border border-border p-2">
            {names.map((name, index) => (
              <li key={`${name}:${index}`} className="truncate">{name}</li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>Don't attach</Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onConfirm(request?.gainsAccessUserIds ?? [])}
          >
            Share it with them
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
