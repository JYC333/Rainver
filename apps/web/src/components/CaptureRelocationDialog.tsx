import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { captureApi } from '../api/client'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { errMsg } from '../lib/utils'
import type {
  CaptureDestination,
  RelocationMode,
  RelocationPreview,
} from '../types/api'

/**
 * Relocating a capture, and promoting private marginalia to team material.
 *
 * The checkboxes are the point. If the user wrote further lines beside a
 * captured paragraph and considers them one thought, no automatic rule can be
 * right in every case — absorb too few and the thought is torn in half, absorb
 * too many and a colleague's paragraph is dragged along, and both directions
 * damage data. Once content has been edited into the note, "what this capture
 * now is" has no objective answer; only the author knows. So the anchored block
 * is preselected, the blocks after it are offered unchecked, and the user
 * decides.
 */
export function CaptureRelocationDialog({
  activityId,
  projectId,
  open,
  onOpenChange,
  onRelocated,
}: {
  activityId: string
  projectId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRelocated?: () => void
}) {
  const [preview, setPreview] = useState<RelocationPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [destination, setDestination] = useState<CaptureDestination>('project_raw')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setPreview(null)
    setError(null)
    captureApi.relocationPreview(activityId)
      .then(next => {
        if (!active) return
        setPreview(next)
        // Only the anchor starts checked — the orphans are a question, not a
        // default.
        setSelected(next.blocks.filter(block => block.anchored).map(block => block.block_id))
      })
      .catch(err => { if (active) setError(errMsg(err)) })
    return () => { active = false }
  }, [open, activityId])

  const leavingSpace = destination === 'personal_inbox' && projectId !== null
  // Copying out is the only act a Space can forbid outright; moving needs
  // authority over the content itself.
  const mode: RelocationMode = leavingSpace && preview?.can_move === false ? 'copy' : 'move'
  const blocked =
    (mode === 'move' && preview?.can_move === false) ||
    (mode === 'copy' && leavingSpace && preview?.can_copy_out === false)

  const submit = useCallback(async () => {
    if (!preview || selected.length === 0 || busy) return
    setBusy(true)
    try {
      await captureApi.relocate(activityId, {
        destination,
        mode,
        block_ids: selected,
        ...(destination === 'personal_inbox' ? {} : { project_id: projectId ?? undefined }),
      })
      toast.success(destination === 'project_raw' ? 'Promoted to project raw material' : 'Relocated')
      onOpenChange(false)
      onRelocated?.()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }, [preview, selected, busy, activityId, destination, mode, projectId, onOpenChange, onRelocated])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Relocate this capture</DialogTitle>
          <DialogDescription>
            Choose which blocks travel with this thought, and where they land.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!preview && !error && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading the surrounding blocks…
          </div>
        )}

        {preview && (
          <>
            <div className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {preview.blocks.map(block => (
                <label key={block.block_id} className="flex cursor-pointer items-start gap-2 rounded p-1.5 text-sm hover:bg-muted/50">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(block.block_id)}
                    onChange={event => setSelected(current => event.target.checked
                      ? [...current, block.block_id]
                      : current.filter(id => id !== block.block_id))}
                  />
                  <span className={block.anchored ? 'font-medium' : 'text-muted-foreground'}>
                    {block.text || <em>empty block</em>}
                  </span>
                </label>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Send to</span>
              <select
                value={destination}
                onChange={event => setDestination(event.target.value as CaptureDestination)}
                className="h-7 rounded-md border border-border bg-transparent px-2"
              >
                {projectId && <option value="project_raw">Project raw material · team visible</option>}
                {projectId && <option value="project_marginalia">Project marginalia · only you</option>}
                <option value="personal_inbox">Personal inbox · only you</option>
              </select>
            </div>

            {blocked && (
              <p className="text-xs text-destructive">
                {mode === 'move'
                  ? 'Moving this out needs to be your own capture, or you administering the Project.'
                  : 'This Space does not allow copying content into a personal Space.'}
              </p>
            )}
            {!blocked && leavingSpace && mode === 'copy' && (
              <p className="text-xs text-muted-foreground">
                A copy leaves the original with the team, and the other members are told it left.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={selected.length === 0 || busy || blocked} onClick={() => void submit()}>
                {busy ? 'Relocating…' : mode === 'copy' ? 'Copy' : 'Move'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
