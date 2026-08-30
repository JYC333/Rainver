import { useCallback, useEffect, useMemo, useState } from 'react'
import { personLabel } from './audience'
import { Loader2, UserPlus, UserRoundMinus, UserRoundX } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError, roomsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  ProjectReader,
  RoomAgentCandidate,
  RoomDetail,
  RoomInvitation,
  SpaceMember,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Select } from '../../components/ui/select'

export function RoomRosterPanel({
  detail,
  spaceMembers,
  projectReaders,
  userId,
  onChanged,
  embedded = false,
}: {
  detail: RoomDetail
  /** For rendering names of people already here — a superset, and stable. */
  spaceMembers: SpaceMember[]
  /**
   * Who may be invited: `project_members ∪ owner`.
   *
   * Not the Space's members. `inviteUser` refuses anyone who cannot read the
   * Project, so offering them is offering a control that only ever fails.
   */
  projectReaders: ProjectReader[]
  userId: string
  onChanged: () => Promise<void>
  embedded?: boolean
}) {
  const [candidates, setCandidates] = useState<RoomAgentCandidate[]>([])
  const [presets, setPresets] = useState<Array<{ preset_id: string; name: string; description: string }>>([])
  const [invitations, setInvitations] = useState<RoomInvitation[]>([])
  const [invitee, setInvitee] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const owner = detail.user_members.find(member => member.role === 'owner' && member.status === 'active')
  const isOwner = owner?.user_id === userId
  const activeUserIds = useMemo(
    () => detail.user_members.filter(member => member.status === 'active').map(member => member.user_id),
    [detail.user_members],
  )
  const inviteableUsers = projectReaders.filter(reader => !activeUserIds.includes(reader.user_id))
  /**
   * Project write authority, which is what `withRoomWriter` requires — and so
   * what invite, remove, transfer and the specialist controls need. A reader
   * is shown the roster and none of *those*, not because reading is
   * restricted, but because each would 403 on the press.
   *
   * Deliberately not applied to everything on this panel. Two controls answer
   * to different authorities and are gated by their own rules below: deciding
   * a private-Agent share (the Agent's owner, who may be a reader) and
   * claiming a suspended Room (the Project owner or a Space owner/admin).
   */
  const canAdminister = detail.viewer_can_write

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [candidatePage, invitationPage] = await Promise.all([
        roomsApi.agentCandidates(detail.room.id, { limit: 100 }),
        roomsApi.invitations(detail.room.id, { limit: 100 }),
      ])
      setCandidates(candidatePage.agents)
      setPresets(candidatePage.presets)
      setInvitations(invitationPage.items)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [detail.room.id])

  useEffect(() => { void refresh() }, [refresh])

  async function mutate(action: () => Promise<unknown>, options: { notify?: boolean; rethrow?: boolean } = {}) {
    setBusy(true)
    try {
      await action()
      await Promise.all([refresh(), onChanged()])
    } catch (error) {
      if (options.notify !== false) toast.error(errMsg(error))
      if (options.rethrow) throw error
    } finally {
      setBusy(false)
    }
  }

  function privateShareIds(): string[] {
    return activeUserIds.filter(id => id !== userId)
  }

  async function addExisting(candidate: RoomAgentCandidate) {
    if (candidate.private && !window.confirm(
      `${candidate.name} is private. Share it with current Room members only?`,
    )) return
    await mutate(() => roomsApi.addAgent(detail.room.id, {
      agent_id: candidate.agent_id,
      share_private_with_member_ids: candidate.private ? privateShareIds() : [],
      confirm_room_share: candidate.private,
    }))
  }

  async function addPreset(presetId: string) {
    const idempotencyKey = newIdempotencyKey()
    try {
      await mutate(() => roomsApi.addAgentPreset(
        detail.room.id,
        { preset_id: presetId, confirm_room_share: false },
        idempotencyKey,
      ), { notify: false, rethrow: true })
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'private_agent_share_confirmation_required') {
        if (!window.confirm('This preset creates a private Agent shared with current Room members only. Continue?')) return
        await mutate(() => roomsApi.addAgentPreset(
          detail.room.id,
          { preset_id: presetId, confirm_room_share: true },
          idempotencyKey,
        ))
      } else {
        toast.error(errMsg(error))
      }
    }
  }

  async function removeAgent(agentId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this Room? Historical output stays available.`)) return
    await mutate(() => roomsApi.removeAgent(detail.room.id, agentId))
  }

  async function inviteUser() {
    if (!invitee) return
    try {
      setBusy(true)
      await roomsApi.inviteUser(detail.room.id, {
        user_id: invitee,
        confirm_owned_private_agent_shares: false,
      })
      setInvitee('')
      await Promise.all([refresh(), onChanged()])
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'private_agent_share_confirmation_required') {
        const accepted = window.confirm('This invitation will share your private specialists inside this Room only. Continue?')
        if (accepted) {
          await mutate(() => roomsApi.inviteUser(detail.room.id, {
            user_id: invitee,
            confirm_owned_private_agent_shares: true,
          }))
          setInvitee('')
        }
      } else {
        toast.error(errMsg(error))
      }
    } finally {
      setBusy(false)
    }
  }

  async function decide(invitation: RoomInvitation, agentId: string, decision: 'approved' | 'rejected') {
    await mutate(() => roomsApi.decideInvitation(detail.room.id, invitation.id, { agent_id: agentId, decision }))
  }

  async function removeMember(memberId: string) {
    if (!window.confirm('Remove this person from the Room?')) return
    await mutate(() => roomsApi.removeUser(detail.room.id, memberId))
  }

  async function transferOwner(targetUserId: string) {
    if (!targetUserId || !window.confirm('Transfer Room ownership?')) return
    await mutate(() => roomsApi.transferOwner(detail.room.id, { user_id: targetUserId }))
  }

  async function claimOwner() {
    if (!window.confirm('Claim Room ownership because the current owner is suspended?')) return
    await mutate(() => roomsApi.claimOwner(detail.room.id))
  }

  const specialists = detail.agent_members.filter(member => member.role !== 'manager')
  const availableAgents = candidates.filter(candidate => !candidate.in_room || candidate.member_status === 'removed')
  const pendingDecisions = invitations.flatMap(invitation => invitation.status === 'pending' && invitation.can_decide
    ? invitation.approvals.filter(approval => approval.status === 'pending' && approval.owner_user_id === userId).map(approval => ({ invitation, approval }))
    : [])

  return (
    <Card className={embedded ? 'border-0 bg-transparent p-0 shadow-none space-y-4' : 'p-3 space-y-4'}>
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Room roster</CardTitle>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="space-y-2">
        {detail.agent_members.filter(member => member.role === 'manager').map(member => (
          <div key={member.agent_id} className="flex items-center justify-between rounded border p-2 text-sm">
            <span>{member.agent_name}</span>
            <Badge variant="secondary">Manager · locked</Badge>
          </div>
        ))}
        {specialists.map(member => (
          <div key={member.agent_id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
            <span className="truncate">{member.agent_name}</span>
            {canAdminister && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeAgent(member.agent_id, member.agent_name)}>
                <UserRoundX className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>

      {canAdminister && (availableAgents.length > 0 || presets.length > 0) && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2 text-xs font-medium"><UserPlus className="size-3.5" />Add a specialist</div>
          {availableAgents.map(candidate => (
            <Button key={candidate.agent_id} variant="outline" size="sm" className="w-full justify-between" disabled={busy} onClick={() => void addExisting(candidate)}>
              <span>{candidate.name}</span>
              <span className="text-xs text-muted-foreground">{candidate.private ? 'private Room share' : 'existing Agent'}</span>
            </Button>
          ))}
          {presets.map(preset => (
            <Button key={preset.preset_id} variant="ghost" size="sm" className="w-full justify-start" disabled={busy} onClick={() => void addPreset(preset.preset_id)}>
              {preset.name} <span className="ml-1 text-xs text-muted-foreground">preset</span>
            </Button>
          ))}
        </div>
      )}

      {canAdminister && inviteableUsers.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="text-xs font-medium">Invite a person</div>
          <Select
            ariaLabel="Invite a person"
            value={invitee}
            onChange={setInvitee}
            options={[{ value: '', label: 'Choose a Project reader' }, ...inviteableUsers.map(reader => ({ value: reader.user_id, label: personLabel(reader) }))]}
          />
          <Button size="sm" className="w-full" disabled={busy || !invitee} onClick={() => void inviteUser()}>Invite</Button>
        </div>
      )}

      {/* Not behind `canAdminister`. `decideInvitation` requires an active
          Space user who is the inviter, the invitee, or **the owner of the
          private Agent** — Project write is never consulted. A reader who owns
          a private specialist is exactly who this is waiting on, and hiding it
          from them is what leaves the invitation blocked. */}
      {pendingDecisions.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="text-xs font-medium">Private-Agent approvals</div>
          {pendingDecisions.map(({ invitation, approval }) => (
            <div key={`${invitation.id}:${approval.agent_id}`} className="rounded border p-2 text-xs space-y-2">
              <div>
                Approve sharing Agent {candidates.find(candidate => candidate.agent_id === approval.agent_id)?.name ?? approval.agent_id}
                {' '}with invited user {personLabel(spaceMembers.find(member => member.user_id === invitation.invitee_user_id) ?? { user_id: invitation.invitee_user_id })}?
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void decide(invitation, approval.agent_id, 'approved')}>Approve</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(invitation, approval.agent_id, 'rejected')}>Reject</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {canAdminister && isOwner && detail.user_members.filter(member => member.status === 'active' && member.role !== 'owner').length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="text-xs font-medium">Ownership</div>
          <Select
            ariaLabel="Transfer Room ownership"
            value=""
            onChange={value => { void transferOwner(value) }}
            options={[{ value: '', label: 'Transfer ownership…' }, ...detail.user_members.filter(member => member.status === 'active' && member.role !== 'owner').map(member => ({ value: member.user_id, label: personLabel(spaceMembers.find(user => user.user_id === member.user_id) ?? { user_id: member.user_id }) }))]}
          />
        </div>
      )}

      {/* Also not `canAdminister`. `claimOwner` requires the Project owner or
          a Space owner/admin — a strict subset of Project writers, so gating
          on write would offer it to a Project member who is then refused. The
          client is not told which of those the viewer is, so the button stays
          where it was: offered to a member of a Room whose owner may be
          suspended, and answered by the server. */}
      {!isOwner && activeUserIds.includes(userId) && (
        <Button variant="outline" size="sm" className="w-full text-xs" disabled={busy} onClick={() => void claimOwner()}>
          Claim ownership if suspended
        </Button>
      )}

      {canAdminister && isOwner && detail.user_members.filter(member => member.status === 'active' && member.role !== 'owner').map(member => (
        <Button key={member.user_id} variant="ghost" size="sm" className="w-full justify-start text-xs" disabled={busy} onClick={() => void removeMember(member.user_id)}>
          <UserRoundMinus className="size-3.5 mr-1" />Remove {personLabel(spaceMembers.find(user => user.user_id === member.user_id) ?? { user_id: member.user_id })}
        </Button>
      ))}
    </Card>
  )
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
