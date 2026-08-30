import { useEffect, useRef, useState } from 'react'
import { personLabel } from './audience'
import { toast } from 'sonner'
import { projectsApi, roomsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { SearchableMultiSelect } from '../../components/ui/searchable-multi-select'
import { errMsg } from '../../lib/utils'
import { useSpace } from '../../contexts/SpaceContext'
import type { ProjectReader, Room } from '../../types/api'

/**
 * Opening a Room by choosing who can see it.
 *
 * The audience *is* what a Room is (ADR 0018), so it is what this asks for
 * first; the name is optional and comes after. One dialog for every surface
 * that opens a limited Room — the conversation list and the Room page — so the
 * two cannot drift in what they offer or how they recover.
 *
 * Candidates are the Project's **readers**, not the Space's members. The
 * server refuses to invite anyone who cannot read the Project
 * (`inviteUser` → `assertProjectReadable`), so a Space-wide list offers people
 * it will then reject.
 *
 * The whole cost of the Room layer is paid here, once, by the people who need
 * it: pick the audience and the Room exists with that roster. No conversation
 * is created with it — the composer it lands in creates that when the first
 * message is sent (ADR 0018 decision 5) — so abandoning the destination leaves
 * a Room and not an empty thread.
 */
export function LimitedRoomDialog({ open, projectId, onClose, onOpened }: {
  open: boolean
  projectId: string
  onClose: () => void
  /**
   * The created Room itself, not just its id: the caller has to retain it
   * before any follow-up read, or a lagging catalog can lose a Room that is
   * already committed and invite a duplicate.
   */
  onOpened: (room: Room) => void
}) {
  const { userId } = useSpace()
  const [candidates, setCandidates] = useState<ProjectReader[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const idempotencyKey = useRef(crypto.randomUUID())

  useEffect(() => {
    if (!open) return
    let active = true
    setSelected([])
    setTitle('')
    setLoadFailed(false)
    idempotencyKey.current = crypto.randomUUID()
    projectsApi.readers(projectId)
      .then(page => { if (active) setCandidates(page.readers.filter(reader => reader.user_id !== userId)) })
      .catch(error => {
        if (!active) return
        // Distinguished from "nobody else reads this Project": an empty list
        // for the wrong reason would read as a fact about the Project.
        setLoadFailed(true)
        toast.error(errMsg(error))
      })
    return () => { active = false }
  }, [open, projectId, userId])

  async function create() {
    setCreating(true)
    try {
      // Keyed, so a double click cannot leave two half-populated groups.
      const room = await roomsApi.create({
        project_id: projectId,
        title: title.trim() || 'Limited group',
      }, idempotencyKey.current)
      // Each invitation activates immediately when the Room holds no private
      // specialists, which a Room created a moment ago does not. One failing
      // does not undo the Room: the group exists, and the roster panel is
      // where a missing person is added.
      // Whom the server refused, and why. Someone in the Space who is not on
      // this Project cannot be added to a Room in it — the server says
      // "Project not found", which read alone is baffling.
      const failures: string[] = []
      for (const memberId of selected) {
        try {
          // No private specialists can be on a Room created a moment ago, so
          // there is nothing for the inviter to confirm sharing.
          await roomsApi.inviteUser(room.room.id, {
            user_id: memberId,
            confirm_owned_private_agent_shares: false,
          })
        } catch (error) {
          const who = personLabel(candidates.find(reader => reader.user_id === memberId) ?? { user_id: memberId })
          failures.push(`${who} (${errMsg(error)} — they may not be on this Project)`)
        }
      }
      if (failures.length === selected.length && selected.length > 0) {
        toast.error(`The group was created but nobody could be added — ${failures.join('; ')}`)
      } else if (failures.length > 0) {
        toast.error(`Added ${selected.length - failures.length} of ${selected.length} — could not add ${failures.join('; ')}`)
      }
      onOpened(room.room)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Who can see this?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Only the people you pick will see these conversations. Nobody else in the Project
            is told they exist.
          </p>
          <SearchableMultiSelect
            ariaLabel="People who can see this"
            placeholder="Choose people"
            searchPlaceholder="Search this Project"
            emptyMessage={loadFailed
              ? 'Could not load who reads this Project.'
              : 'Nobody else reads this Project.'}
            options={candidates.map(reader => ({
              value: reader.user_id,
              label: personLabel(reader),
            }))}
            value={selected}
            onChange={setSelected}
          />
          <Input
            aria-label="Name this group"
            placeholder="Name this group (optional)"
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button size="sm" onClick={() => void create()} disabled={creating || selected.length === 0}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
