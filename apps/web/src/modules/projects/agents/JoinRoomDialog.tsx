import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { roomsApi } from '../../../api/client'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Select } from '../../../components/ui/select'
import { useAppTranslation } from '../../../i18n'
import { errMsg } from '../../../lib/utils'
import type { ProjectAgent, ProjectRoomSummary } from '../../../types/api'
import { roomVisibilityLabel } from '../../agent_groups/audience'
import { displayRoomTitle } from '../../agent_groups/roomTitle'

/**
 * Put a Project Agent into one chosen Room.
 *
 * The target list is the viewer's own Rooms index, so it names no Room they
 * are not in. A private Agent is shared only with that Room's current members,
 * and only after its owner confirms exactly that — never with the whole
 * Project.
 */
export function JoinRoomDialog({ agent, rooms, projectName, userId, onClose, onJoined }: {
  agent: ProjectAgent | null
  rooms: ProjectRoomSummary[]
  projectName: string | undefined
  userId: string | null
  onClose: () => void
  onJoined: () => Promise<void> | void
}) {
  const { t } = useAppTranslation()
  const [roomId, setRoomId] = useState('')
  const [busy, setBusy] = useState(false)
  const [share, setShare] = useState<{ roomId: string; memberIds: string[] } | null>(null)
  const available = agent ? rooms.filter(item => !agent.rooms.some(room => room.room_id === item.room.id)) : []

  useEffect(() => {
    setRoomId(available[0]?.room.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.agent_id])

  async function join(targetRoomId: string, memberIds: string[] | null) {
    if (!agent) return
    setBusy(true)
    try {
      await roomsApi.addAgent(targetRoomId, {
        agent_id: agent.agent_id,
        share_private_with_member_ids: memberIds ?? [],
        confirm_room_share: memberIds !== null,
        restore_workspace: false,
      })
      const room = rooms.find(item => item.room.id === targetRoomId)
      toast.success(t('collab_ui.join_room.added', { name: agent.name, room: room ? displayRoomTitle(room.room, projectName) : '' }))
      await onJoined()
      onClose()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!agent || !roomId) return
    if (!agent.private) {
      await join(roomId, null)
      return
    }
    // The exact current members, read now: a private Agent is shared with them and nobody else.
    setBusy(true)
    try {
      const detail = await roomsApi.get(roomId)
      const memberIds = detail.user_members.filter(member => member.status === 'active' && member.user_id !== userId).map(member => member.user_id)
      setShare({ roomId, memberIds })
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={Boolean(agent) && !share} onOpenChange={next => { if (!next) onClose() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('collab_ui.join_room.title', { name: agent?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('collab_ui.join_room.description')}</DialogDescription>
          </DialogHeader>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('collab_ui.join_room.none')}</p>
          ) : (
            <div className="space-y-2">
              <Select
                ariaLabel={t('collab_ui.join_room.room')}
                value={roomId}
                onChange={setRoomId}
                options={available.map(item => ({
                  value: item.room.id,
                  label: `${displayRoomTitle(item.room, projectName)} · ${roomVisibilityLabel({ isMainline: item.room.is_mainline, otherMemberNames: item.other_member_names }, t)}`,
                }))}
              />
            </div>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>{t('collab_ui.common.cancel')}</Button>
            <Button size="sm" onClick={() => void submit()} disabled={busy || !roomId || available.length === 0}>
              {t('collab_ui.join_room.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(share)}
        onOpenChange={next => { if (!next) setShare(null) }}
        title={t('collab_ui.join_room.private_title', { name: agent?.name ?? '' })}
        description={t('collab_ui.join_room.private_text')}
        confirmLabel={t('collab_ui.join_room.private_confirm')}
        variant="default"
        onConfirm={() => { const pending = share; setShare(null); if (pending) void join(pending.roomId, pending.memberIds) }}
      />
    </>
  )
}
