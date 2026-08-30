import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { personLabel } from './audience'
import { Loader2, Plus, RefreshCw, Settings2, UserPlus, UserRoundMinus, UserRoundX } from 'lucide-react'
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
import HostExecutionTargetPicker, { type HostExecutionSelection } from '../command_center/HostExecutionTargetPicker'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { ConfirmDialog } from '../../components/ui/dialog'
import { SpaceLink as Link } from '../../core/spaceNav'

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
  const [presetExecution, setPresetExecution] = useState<HostExecutionSelection | null>(null)
  /** One in-app confirmation at a time, replacing the browser's `window.confirm`. */
  const [confirmation, setConfirmation] = useState<{
    title: string
    description?: string
    confirmLabel: string
    variant: 'destructive' | 'default'
    onConfirm: () => void
  } | null>(null)
  function ask(question: Omit<NonNullable<typeof confirmation>, 'onConfirm'>): Promise<boolean> {
    return new Promise(resolve => {
      let answered = false
      setConfirmation({
        ...question,
        onConfirm: () => { answered = true; resolve(true) },
      })
      // Cancel or dismiss closes the dialog without calling onConfirm.
      pendingCancel.current = () => { if (!answered) resolve(false) }
    })
  }
  const pendingCancel = useRef<(() => void) | null>(null)
  function closeConfirmation(open: boolean) {
    if (open) return
    setConfirmation(null)
    pendingCancel.current?.()
    pendingCancel.current = null
  }
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
    if (candidate.private && !await ask({
      title: `Share ${candidate.name} with this Room?`,
      description: 'The Agent is private. Current Room members, and only they, get access to it here.',
      confirmLabel: 'Share and add',
      variant: 'default',
    })) return
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
        { preset_id: presetId, confirm_room_share: false, ...(presetExecution ? { execution: presetExecution } : {}) },
        idempotencyKey,
      ), { notify: false, rethrow: true })
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'private_agent_share_confirmation_required') {
        if (!await ask({
          title: 'Create a private specialist?',
          description: 'This preset creates a private Agent shared with current Room members only.',
          confirmLabel: 'Create and add',
          variant: 'default',
        })) return
        await mutate(() => roomsApi.addAgentPreset(
          detail.room.id,
          { preset_id: presetId, confirm_room_share: true, ...(presetExecution ? { execution: presetExecution } : {}) },
          idempotencyKey,
        ))
      } else {
        toast.error(errMsg(error))
      }
    }
  }

  async function removeAgent(agentId: string, name: string) {
    if (!await ask({
      title: `Remove ${name} from this Room?`,
      description: 'The Agent itself is kept, and its historical output stays available.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.removeAgent(detail.room.id, agentId))
  }

  async function resetAgentContext(agentId: string, name: string) {
    if (!await ask({
      title: `Reset ${name}'s context?`,
      description: 'The host runtime session is cleared. The next turn starts with a fresh conversation context.',
      confirmLabel: 'Reset context',
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.resetAgentContext(detail.room.id, agentId))
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
        const accepted = await ask({
          title: 'Share your private specialists?',
          description: 'This invitation shares your private specialists inside this Room only.',
          confirmLabel: 'Share and invite',
          variant: 'default',
        })
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
    if (!await ask({
      title: 'Remove this person from the Room?',
      confirmLabel: 'Remove',
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.removeUser(detail.room.id, memberId))
  }

  async function transferOwner(targetUserId: string) {
    if (!targetUserId) return
    if (!await ask({
      title: 'Transfer Room ownership?',
      description: 'You keep your membership; the new owner takes over roster and ownership controls.',
      confirmLabel: 'Transfer',
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.transferOwner(detail.room.id, { user_id: targetUserId }))
  }

  async function claimOwner() {
    if (!await ask({
      title: 'Claim Room ownership?',
      description: 'Only possible because the current owner is suspended.',
      confirmLabel: 'Claim',
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.claimOwner(detail.room.id))
  }

  const specialists = detail.agent_members.filter(member => member.role !== 'manager')
  const newAgentHref = (() => {
    const params = new URLSearchParams({ project: detail.room.project_id })
    if (presetExecution) {
      params.set('host', presetExecution.host_id)
      params.set('location', presetExecution.workspace_location_id)
      params.set('adapter', presetExecution.adapter_type)
      params.set('installation', presetExecution.installation)
    }
    return `/agents/new?${params.toString()}`
  })()
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
            <span className="min-w-0 truncate">
              <span>{member.agent_name}</span>
              {member.host_name && (
                <span className="ml-2 inline-flex items-center gap-1 align-middle text-xs text-muted-foreground">
                  <Badge variant={member.host_online === false ? 'destructive' : 'secondary'}>
                    on {member.host_name} · owner-only
                  </Badge>
                  {member.host_online === false && <span>offline</span>}
                </span>
              )}
            </span>
            <span className="flex items-center gap-0.5 shrink-0">
              {/* Instructions, model and tools are the Agent's own settings; the roster only decides who is in the Room. */}
              <Button asChild variant="ghost" size="sm" aria-label={`Configure ${member.agent_name}`}>
                <Link to={`/agents/${member.agent_id}`}><Settings2 className="size-3.5" /></Link>
              </Button>
              {canAdminister && (
                <Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${member.agent_name}`} onClick={() => void removeAgent(member.agent_id, member.agent_name)}>
                  <UserRoundX className="size-3.5" />
                </Button>
              )}
              {canAdminister && member.host_name && member.host_owner_is_me && (
                <Button variant="ghost" size="sm" disabled={busy} aria-label={`Reset context for ${member.agent_name}`} onClick={() => void resetAgentContext(member.agent_id, member.agent_name)}>
                  <RefreshCw className="size-3.5" />
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>

      {canAdminister && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2 text-xs font-medium"><UserPlus className="size-3.5" />Add a specialist</div>
          {availableAgents.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Every existing Agent in this Space is already here. Presets below create a new one with fixed instructions; to shape your own, create an Agent first.
            </p>
          )}
          {availableAgents.map(candidate => (
            <Button key={candidate.agent_id} variant="outline" size="sm" className="w-full justify-between" disabled={busy} onClick={() => void addExisting(candidate)}>
              <span>{candidate.name}</span>
              <span className="text-xs text-muted-foreground">{candidate.private ? 'private Room share' : 'existing Agent'}</span>
            </Button>
          ))}
          <HostExecutionTargetPicker
            projectId={detail.room.project_id}
            value={presetExecution}
            onChange={setPresetExecution}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            {presetExecution
              ? 'Pick a preset to create it on that host now, or open the full form with the host already chosen.'
              : 'Pick a preset to create it on the server, or open the full form.'}
          </p>
          {presets.map(preset => (
            <Button key={preset.preset_id} variant="ghost" size="sm" className="w-full justify-start" disabled={busy} title={preset.description} onClick={() => void addPreset(preset.preset_id)}>
              {preset.name} <span className="ml-1 text-xs text-muted-foreground">{presetExecution ? 'preset · on host' : 'preset'}</span>
            </Button>
          ))}
          <Button asChild variant="outline" size="sm" className="w-full justify-start">
            <Link to={newAgentHref}><Plus className="size-3.5 mr-1" />{presetExecution ? 'Create a new Agent on that host…' : 'Create a new Agent…'}</Link>
          </Button>
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
      <ConfirmDialog
        open={Boolean(confirmation)}
        onOpenChange={closeConfirmation}
        title={confirmation?.title ?? ''}
        description={confirmation?.description}
        confirmLabel={confirmation?.confirmLabel}
        variant={confirmation?.variant}
        onConfirm={() => confirmation?.onConfirm()}
      />
    </Card>
  )
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
