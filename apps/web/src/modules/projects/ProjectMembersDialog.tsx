import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMember } from '@rainver/protocol'
import { projectsApi, spacesApi } from '../../api/client'
import type { Project, SpaceMember } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, ConfirmDialog } from '../../components/ui/dialog'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'

type Role = ProjectMember['role']

export default function ProjectMembersDialog({ project, open, onOpenChange, onChanged }: {
  project: Project
  open: boolean
  onOpenChange: (value: boolean) => void
  onChanged: () => void
}) {
  const { t } = useAppTranslation()
  const [members, setMembers] = useState<ProjectMember[] | null>(null)
  const [people, setPeople] = useState<SpaceMember[]>([])
  const [selected, setSelected] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removeId, setRemoveId] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestVersion.current++ } }, [])
  const limit = project.current_user_grantable_member_role
  const canManage = limit === 'member' || limit === 'owner'

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    const [nextMembers, nextPeople] = await Promise.all([projectsApi.members(project.id), spacesApi.members(project.space_id)])
    if (!mounted.current || version !== requestVersion.current) return
    setMembers(nextMembers)
    setPeople(nextPeople)
    setError('')
  }, [project.id, project.space_id])

  useEffect(() => {
    if (!open || !canManage) return
    setMembers(null)
    setPeople([])
    setSelected('')
    setError('')
    setRemoveId(null)
    void load().catch(error => { if (mounted.current) setError(errMsg(error)) })
    return () => { requestVersion.current++ }
  }, [open, canManage, load])

  async function mutate(action: () => Promise<unknown>) {
    if (busy || !canManage) return
    setBusy(true)
    setError('')
    try {
      await action()
      if (!mounted.current) return
      setSelected('')
      // Re-read the canonical roster; a refused request never changes the UI optimistically.
      setMembers(null)
      await load()
      if (mounted.current) onChanged()
    } catch (error) {
      if (mounted.current) setError(errMsg(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const roles: Role[] = limit === 'owner' ? ['viewer', 'member', 'owner'] : ['viewer', 'member']
  const options = roles.map(value => ({ value, label: t(`management_ui.project_members.role_${value}`) }))
  const available = people.filter(person => person.user_id !== project.owner_user_id && !members?.some(member => member.user_id === person.user_id))
  const personLabel = (userId: string) => {
    const person = people.find(candidate => candidate.user_id === userId)
    return person ? `${person.display_name}${person.email ? ` (${person.email})` : ''}` : t('management_ui.project_members.unavailable_person')
  }
  const ownerLabel = project.owner_user_id ? personLabel(project.owner_user_id) : null

  return <Dialog open={open && canManage} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
    <DialogContent className="max-w-xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('management_ui.project_members.title')}</DialogTitle>
        <DialogDescription>{t('management_ui.project_members.description')}</DialogDescription>
      </DialogHeader>
      {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>{members === null && <Button variant="outline" size="sm" disabled={busy} onClick={() => void load().catch(error => setError(errMsg(error)))}>{t('management_ui.project_members.retry')}</Button>}</div>}
      {members === null ? <p className="text-sm text-muted-foreground">{t('management_ui.project_members.loading')}</p> : <div className="space-y-4">
        {ownerLabel && <div className="space-y-1 border-b border-border pb-3"><p className="break-words text-sm font-medium">{ownerLabel}</p><p className="text-xs text-muted-foreground">{t('management_ui.project_members.creator')}</p></div>}
        <div className="space-y-3">
          {members.filter(member => member.user_id !== project.owner_user_id).map(member => {
            const mutable = limit === 'owner' || member.role !== 'owner'
            return <div key={member.user_id} className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 basis-44 break-words text-sm">{personLabel(member.user_id)}</p>
              <div className="flex items-center gap-2">
                <Select size="sm" ariaLabel={t('management_ui.project_members.role_for', { name: personLabel(member.user_id) })} value={member.role} options={mutable ? options : [{ value: member.role, label: t(`management_ui.project_members.role_${member.role}`) }]} disabled={busy || !mutable} onChange={value => void mutate(() => projectsApi.addMember(project.id, { user_id: member.user_id, role: value as Role }))} />
                <Button variant="ghost" size="sm" disabled={busy || !mutable} aria-label={t('management_ui.project_members.remove_person', { name: personLabel(member.user_id) })} onClick={() => setRemoveId(member.user_id)}>{t('management_ui.project_members.remove')}</Button>
              </div>
            </div>
          })}
        </div>
        <form className="space-y-3 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); if (selected) void mutate(() => projectsApi.addMember(project.id, { user_id: selected, role })) }}>
          <p className="text-sm font-medium">{t('management_ui.project_members.add')}</p>
          {available.length ? <>
            <Select ariaLabel={t('management_ui.project_members.person')} value={selected} disabled={busy} options={[{ value: '', label: t('management_ui.project_members.choose_person'), disabled: true }, ...available.map(person => ({ value: person.user_id, label: personLabel(person.user_id) }))]} onChange={setSelected} />
            <div className="flex items-center gap-2"><Select ariaLabel={t('management_ui.project_members.role')} value={role} options={options} disabled={busy} onChange={value => setRole(value as Role)} /><Button size="sm" type="submit" disabled={busy || !selected}>{t('management_ui.project_members.add')}</Button></div>
          </> : <p className="text-sm text-muted-foreground">{t('management_ui.project_members.no_candidates')}</p>}
          <p className="text-xs text-muted-foreground">{t('management_ui.project_members.roles_help')}</p>
        </form>
      </div>}
      <ConfirmDialog open={removeId !== null} onOpenChange={value => { if (!value && !busy) setRemoveId(null) }} title={t('management_ui.project_members.remove_title')} description={t('management_ui.project_members.remove_help')} confirmLabel={t('management_ui.project_members.remove')} onConfirm={() => { if (removeId) void mutate(() => projectsApi.removeMember(project.id, removeId)) }} />
    </DialogContent>
  </Dialog>
}
