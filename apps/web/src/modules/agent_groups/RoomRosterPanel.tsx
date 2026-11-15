import {RoomConversationDefaults} from './RoomConversationDefaults'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { personLabel } from './audience'
import { Loader2, NotebookPen, RefreshCw, RotateCcw, Settings2, UserPlus, UserRoundMinus, UserRoundX } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, ApiRequestError, roomsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  ProjectReader,
  RoomAgentCandidate,
  RoomDetail,
  RoomInvitation,
  SpaceMember,
} from '../../types/api'
import { type HostExecutionSelection } from '../command_center/HostExecutionTargetPicker'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { ConfirmDialog } from '../../components/ui/dialog'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { newAgentHref } from '../projects/agentCreationReturn'
import { AddRoomAgentDialog } from './AddRoomAgentDialog'

/**
 * Who is in one Room: its people and its Agents, and the roster controls.
 *
 * Membership here is the Room's visibility boundary, not the Project's Agent
 * list. Adding an Agent from the library completes its Project link; removing
 * one from the Room keeps it on the Project. Which members answer a given
 * message is chosen per message in the composer, not here.
 */
export function RoomRosterPanel({
  detail,
  spaceMembers,
  projectReaders,
  userId,
  onChanged,
  createdAgentId = null,
  onCreatedAgentHandled,
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
  /** An Agent just created from this Room's "Create a new Agent", offered for one-click adding. */
  createdAgentId?: string | null
  onCreatedAgentHandled?: () => void
}) {
  const { t } = useAppTranslation()
  const [candidates, setCandidates] = useState<RoomAgentCandidate[]>([])
  const [invitations, setInvitations] = useState<RoomInvitation[]>([])
  const [invitee, setInvitee] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null)
  const [presetExecution, setPresetExecution] = useState<HostExecutionSelection | null>(null)
  const presetIdempotencyKeys = useRef(new Map<string, string>())
  const [restoreChoice, setRestoreChoice] = useState(false)
  const restoreChoiceRef = useRef(false)
  /** One in-app confirmation at a time. Do not call `window.confirm`. */
  const [confirmation, setConfirmation] = useState<{
    title: string
    description?: string
    confirmLabel: string
    variant: 'destructive' | 'default'
    onConfirm: () => void
    restoreAvailable?: boolean
  } | null>(null)
  function ask(question: Omit<NonNullable<typeof confirmation>, 'onConfirm'>): Promise<boolean> {
    return new Promise(resolve => {
      setRestoreChoice(false)
      restoreChoiceRef.current = false
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
  const nameOf = (id: string) => personLabel(spaceMembers.find(member => member.user_id === id) ?? projectReaders.find(reader => reader.user_id === id) ?? { user_id: id })
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
      setInvitations(invitationPage.items)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [detail.room.id])

  useEffect(() => { void refresh() }, [refresh])

  // Returned here from "Create a new Agent": name it and offer the add.
  useEffect(() => {
    if (!createdAgentId) return
    let active = true
    agentsApi.get(createdAgentId)
      .then(agent => { if (active) setCreated({ id: agent.id, name: agent.name }) })
      .catch(() => { if (active) setCreated(null) })
    return () => { active = false }
  }, [createdAgentId])

  async function mutate(action: () => Promise<unknown>, options: { notify?: boolean; rethrow?: boolean } = {}) {
    setBusy(true)
    try {
      await action()
      await Promise.all([refresh(), onChanged()])
      return true
    } catch (error) {
      if (options.notify !== false) toast.error(errMsg(error))
      if (options.rethrow) throw error
      return false
    } finally {
      setBusy(false)
    }
  }

  function privateShareIds(): string[] {
    return activeUserIds.filter(id => id !== userId)
  }

  async function addExisting(candidate: Pick<RoomAgentCandidate, 'agent_id' | 'name' | 'private' | 'host_state_archive_available'>) {
    // Not gated on a managed workspace: what is archived when a specialist
    // leaves is always its runtime profile — its login, sessions and CLI
    // memory — and only sometimes the shared cwd.
    const restoreAvailable = candidate.host_state_archive_available === true
    const shareWith = candidate.private ? privateShareIds() : []
    if (candidate.private || restoreAvailable) {
      const returnToAdding = adding
      setAdding(false)
      const confirmed = await ask({
        title: candidate.private ? t('collab_ui.roster.share_title', { name: candidate.name }) : t('collab_ui.roster.readd_title', { name: candidate.name }),
        description: candidate.private ? t('collab_ui.roster.share_text') : t('collab_ui.roster.readd_text'),
        confirmLabel: candidate.private ? t('collab_ui.roster.share_confirm') : t('collab_ui.roster.readd_confirm'),
        variant: 'default',
        restoreAvailable,
      })
      if (!confirmed) { setAdding(returnToAdding); return }
    }
    // A restore runs on the Host after the add commits; one that brought
    // nothing back is posted as a notice in the conversation it was for.
    const added = await mutate(() => roomsApi.addAgent(detail.room.id, {
      agent_id: candidate.agent_id,
      share_private_with_member_ids: shareWith,
      confirm_room_share: candidate.private,
      restore_workspace: restoreAvailable && restoreChoiceRef.current,
    }))
    if (added) setAdding(false)
  }

  async function addCreated() {
    if (!created) return
    const candidate = candidates.find(item => item.agent_id === created.id)
    await addExisting(candidate ?? { agent_id: created.id, name: created.name, private: false, host_state_archive_available: false })
    setCreated(null)
    onCreatedAgentHandled?.()
  }

  async function addPreset(presetId: string) {
    // One key per preset until the add is confirmed: a retry after a failed
    // refresh (which reads as the add failing) is then deduplicated by the
    // server instead of creating a second private Agent.
    const idempotencyKey = presetIdempotencyKeys.current.get(presetId) ?? newIdempotencyKey()
    presetIdempotencyKeys.current.set(presetId, idempotencyKey)
    const selectedExecution = presetExecution
      ? {
          host_id: presetExecution.host_id,
          workspace_location_id: presetExecution.workspace_location_id,
          workspace_mode: presetExecution.workspace_mode,
          runtime_key: presetExecution.runtime_key,
          installation: presetExecution.installation,
        }
      : undefined
    try {
      await mutate(() => roomsApi.addAgentPreset(
        detail.room.id,
        { preset_id: presetId, confirm_room_share: false, ...(selectedExecution ? { execution: selectedExecution } : {}) },
        idempotencyKey,
      ), { notify: false, rethrow: true })
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'private_agent_share_confirmation_required') {
        if (!await ask({
          title: t('collab_ui.roster.preset_title'),
          description: t('collab_ui.roster.preset_text'),
          confirmLabel: t('collab_ui.roster.preset_confirm'),
          variant: 'default',
        })) return
        try {
          await mutate(() => roomsApi.addAgentPreset(
            detail.room.id,
            { preset_id: presetId, confirm_room_share: true, ...(selectedExecution ? { execution: selectedExecution } : {}) },
            idempotencyKey,
          ), { rethrow: true })
        } catch {
          return
        }
      } else {
        toast.error(errMsg(error))
        return
      }
    }
    presetIdempotencyKeys.current.delete(presetId)
    setAdding(false)
  }

  async function removeAgent(agentId: string, name: string) {
    if (!await ask({
      title: t('collab_ui.roster.remove_title', { name }),
      description: t('collab_ui.roster.remove_text'),
      confirmLabel: t('collab_ui.roster.remove_confirm'),
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.removeAgent(detail.room.id, agentId))
  }

  async function summarizeAgentContext(agentId: string, name: string) {
    if (!await ask({
      title: t('collab_ui.roster.summarize_title', { name }),
      description: t('collab_ui.roster.summarize_text'),
      confirmLabel: t('collab_ui.roster.summarize_confirm'),
      variant: 'default',
    })) return
    await mutate(() => roomsApi.summarizeAgentContext(detail.room.id, agentId))
  }

  async function restartFromSummary(agentId: string, name: string) {
    if (!await ask({
      title: t('collab_ui.roster.restart_title', { name }),
      description: t('collab_ui.roster.restart_text'),
      confirmLabel: t('collab_ui.roster.restart_confirm'),
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.restartFromSummary(detail.room.id, agentId))
  }

  async function resetAgentContext(agentId: string, name: string) {
    if (!await ask({
      title: t('collab_ui.roster.reset_title', { name }),
      description: t('collab_ui.roster.reset_text'),
      confirmLabel: t('collab_ui.roster.reset_confirm'),
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
          title: t('collab_ui.roster.invite_share_title'),
          description: t('collab_ui.roster.invite_share_text'),
          confirmLabel: t('collab_ui.roster.invite_share_confirm'),
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
      title: t('collab_ui.roster.remove_person_title'),
      confirmLabel: t('collab_ui.roster.remove_confirm'),
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.removeUser(detail.room.id, memberId))
  }

  async function transferOwner(targetUserId: string) {
    if (!targetUserId) return
    if (!await ask({
      title: t('collab_ui.roster.transfer_title'),
      description: t('collab_ui.roster.transfer_text'),
      confirmLabel: t('collab_ui.roster.transfer_confirm'),
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.transferOwner(detail.room.id, { user_id: targetUserId }))
  }

  async function claimOwner() {
    if (!await ask({
      title: t('collab_ui.roster.claim_title'),
      description: t('collab_ui.roster.claim_text'),
      confirmLabel: t('collab_ui.roster.claim_confirm'),
      variant: 'destructive',
    })) return
    await mutate(() => roomsApi.claimOwner(detail.room.id))
  }

  const specialists = detail.agent_members.filter(member => member.role !== 'manager')
  const createHref = newAgentHref(
    detail.room.project_id,
    `/projects/${detail.room.project_id}/rooms?${new URLSearchParams({ room: detail.room.id, view: 'members' }).toString()}`,
  )
  const pendingDecisions = invitations.flatMap(invitation => invitation.status === 'pending' && invitation.can_decide
    ? invitation.approvals.filter(approval => approval.status === 'pending' && approval.owner_user_id === userId).map(approval => ({ invitation, approval }))
    : [])
  const activePeople = detail.user_members.filter(member => member.status === 'active')

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RoomConversationDefaults detail={detail} onChanged={onChanged}/>
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t('collab_ui.room.people')} <span className="text-xs font-normal text-muted-foreground">{activePeople.length}</span></CardTitle>
        </div>
        <ul className="space-y-1.5">
          {activePeople.map(member => (
            <li key={member.user_id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
              <span className="min-w-0 truncate">
                {nameOf(member.user_id)}
                {member.user_id === userId && <span className="ml-1 text-xs text-muted-foreground">({t('collab_ui.common.you')})</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {member.role === 'owner' && <Badge variant="secondary">{t('collab_ui.room.owner')}</Badge>}
                {canAdminister && isOwner && member.role !== 'owner' && (
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={t('collab_ui.roster.remove_person', { name: nameOf(member.user_id) })} onClick={() => void removeMember(member.user_id)}>
                    <UserRoundMinus className="size-3.5" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>

        {canAdminister && inviteableUsers.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-xs font-medium">{t('collab_ui.roster.invite')}</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1">
                <Select
                  ariaLabel={t('collab_ui.roster.invite')}
                  value={invitee}
                  onChange={setInvitee}
                  options={[{ value: '', label: t('collab_ui.roster.invite_choose') }, ...inviteableUsers.map(reader => ({ value: reader.user_id, label: personLabel(reader) }))]}
                />
              </div>
              <Button size="sm" disabled={busy || !invitee} onClick={() => void inviteUser()}>{t('collab_ui.roster.invite_submit')}</Button>
            </div>
          </div>
        )}

        {canAdminister && isOwner && activePeople.filter(member => member.role !== 'owner').length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-xs font-medium">{t('collab_ui.roster.ownership')}</div>
            <Select
              ariaLabel={t('collab_ui.roster.transfer_label')}
              value=""
              onChange={value => { void transferOwner(value) }}
              options={[{ value: '', label: t('collab_ui.roster.transfer') }, ...activePeople.filter(member => member.role !== 'owner').map(member => ({ value: member.user_id, label: nameOf(member.user_id) }))]}
            />
          </div>
        )}

        {/* Not `canAdminister`. `claimOwner` requires the Project owner or
            a Space owner/admin — a strict subset of Project writers, so gating
            on write would offer it to a Project member who is then refused. The
            client is not told which of those the viewer is, so the button stays
            where it was: offered to a member of a Room whose owner may be
            suspended, and answered by the server. */}
        {!isOwner && activeUserIds.includes(userId) && (
          <Button variant="outline" size="sm" className="w-full text-xs" disabled={busy} onClick={() => void claimOwner()}>
            {t('collab_ui.roster.claim')}
          </Button>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t('collab_ui.room.agents')} <span className="text-xs font-normal text-muted-foreground">{detail.agent_members.length}</span></CardTitle>
          <span className="flex items-center gap-2">
            {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            {canAdminister && (
              <Button size="sm" disabled={busy} onClick={() => setAdding(true)}><UserPlus className="size-3.5" />{t('collab_ui.roster.add_agent')}</Button>
            )}
          </span>
        </div>

        {created && canAdminister && !detail.agent_members.some(member => member.agent_id === created.id) && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 p-2.5 text-sm">
            <span>{t('collab_ui.roster.created_prompt', { name: created.name })}</span>
            <span className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void addCreated()}>{t('collab_ui.roster.created_add')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setCreated(null); onCreatedAgentHandled?.() }}>{t('collab_ui.common.dismiss')}</Button>
            </span>
          </div>
        )}

        <ul className="space-y-1.5">
          {detail.agent_members.filter(member => member.role === 'manager').map(member => (
            <li key={member.agent_id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
              <span className="min-w-0 truncate">{member.agent_name}</span>
              <Badge variant="secondary">{t('collab_ui.roster.manager_locked')}</Badge>
            </li>
          ))}
          {specialists.map(member => (
            <li key={member.agent_id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate">{member.agent_name}</span>
                {member.host_name && (
                  <span className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <Badge variant={member.host_online === false ? 'destructive' : 'secondary'}>
                      {t('collab_ui.roster.on_host', { mode: member.workspace_mode === 'managed' ? t('collab_ui.roster.managed_workspace') : t('collab_ui.roster.location'), host: member.host_name })}
                    </Badge>
                    {member.host_online === false && <span>{t('collab_ui.roster.offline')}</span>}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                {/* Instructions, model and tools are the Agent's own settings; the roster only decides who is in the Room. */}
                {candidates.some(candidate => candidate.agent_id === member.agent_id && candidate.owner_user_id === userId) && <Button asChild variant="ghost" size="sm" aria-label={t('collab_ui.roster.configure', { name: member.agent_name })}>
                  <Link to={`/agents/${member.agent_id}`}><Settings2 className="size-3.5" /></Link>
                </Button>}
                {detail.viewer_can_write && activeUserIds.includes(userId) && candidates.filter(candidate => candidate.agent_id === member.agent_id && candidate.private
                  && candidate.owner_user_id === userId && privateShareIds().some(id => !candidate.shared_with_user_ids.includes(id))).map(candidate => (
                  <Button key={candidate.agent_id} variant="ghost" size="sm" disabled={busy} onClick={() => void addExisting(candidate)}>
                    {t('collab_ui.roster.authorize_members')}
                  </Button>
                ))}
                {canAdminister && (
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={t('collab_ui.roster.remove', { name: member.agent_name })} onClick={() => void removeAgent(member.agent_id, member.agent_name)}>
                    <UserRoundX className="size-3.5" />
                  </Button>
                )}
                {canAdminister && member.host_name && member.host_owner_is_me && (
                  <>
                    <Button variant="ghost" size="sm" disabled={busy} aria-label={t('collab_ui.roster.summarize', { name: member.agent_name })} onClick={() => void summarizeAgentContext(member.agent_id, member.agent_name)}>
                      <NotebookPen className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} aria-label={t('collab_ui.roster.restart', { name: member.agent_name })} onClick={() => void restartFromSummary(member.agent_id, member.agent_name)}>
                      <RotateCcw className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} aria-label={t('collab_ui.roster.reset', { name: member.agent_name })} onClick={() => void resetAgentContext(member.agent_id, member.agent_name)}>
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>

        {/* Not behind `canAdminister`. `decideInvitation` requires an active
            Space user who is the inviter, the invitee, or **the owner of the
            private Agent** — Project write is never consulted. A reader who owns
            a private specialist is exactly who this is waiting on, and hiding it
            from them is what leaves the invitation blocked. */}
        {pendingDecisions.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-xs font-medium">{t('collab_ui.roster.approvals')}</div>
            {pendingDecisions.map(({ invitation, approval }) => (
              <div key={`${invitation.id}:${approval.agent_id}`} className="space-y-2 rounded-md border border-border p-2 text-xs">
                <div>
                  {t('collab_ui.roster.approval_text', {
                    agent: candidates.find(candidate => candidate.agent_id === approval.agent_id)?.name ?? approval.agent_id,
                    person: nameOf(invitation.invitee_user_id),
                  })}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void decide(invitation, approval.agent_id, 'approved')}>{t('collab_ui.roster.approve')}</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(invitation, approval.agent_id, 'rejected')}>{t('collab_ui.roster.reject')}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <AddRoomAgentDialog
        open={adding}
        roomId={detail.room.id}
        projectId={detail.room.project_id}
        busy={busy}
        createHref={createHref}
        presetExecution={presetExecution}
        onPresetExecutionChange={setPresetExecution}
        onClose={() => setAdding(false)}
        onAdd={addExisting}
        onAddPreset={addPreset}
      />
      <ConfirmDialog
        open={Boolean(confirmation)}
        onOpenChange={closeConfirmation}
        title={confirmation?.title ?? ''}
        description={confirmation?.description}
        restoreAvailable={confirmation?.restoreAvailable}
        restoreChecked={restoreChoice}
        onRestoreChange={checked => { setRestoreChoice(checked); restoreChoiceRef.current = checked }}
        confirmLabel={confirmation?.confirmLabel}
        variant={confirmation?.variant}
        onConfirm={() => confirmation?.onConfirm()}
      />
    </div>
  )
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
