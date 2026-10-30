import { useEffect, useRef, useState } from 'react'
import { ClipboardCheck, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import type { BriefingAdoptionPreview, BriefingAdoptionResult, BriefingFollowUpPreview } from '@rainver/protocol'
import { projectsApi, roomsApi } from '../../../api/client'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { useSpaceNavigate } from '../../../core/spaceNav'
import { useAppTranslation } from '../../../i18n'
import { sessionEpoch } from '../../../lib/sessionResidue'
import { errMsg } from '../../../lib/utils'
import { holdReferences } from '../../agent_groups/pendingReferences'

export type BriefingActionScope = { type: 'project'; projectId: string } | { type: 'personal' }

/** Which highlight a set of actions belongs to: its scope, its briefing and its stable index in that version. */
export const highlightActionOwner = (scope: BriefingActionScope, briefingId: string, index: number) =>
  `${scope.type === 'project' ? `project:${scope.projectId}` : 'personal'}:${briefingId}:${index}`

export interface HighlightActionApi {
  followUp: (briefingId: string, index: number) => Promise<BriefingFollowUpPreview>
  previewAdoption: (briefingId: string, index: number) => Promise<BriefingAdoptionPreview>
  adopt: (briefingId: string, index: number, previewHash: string) => Promise<BriefingAdoptionResult>
}

/**
 * The two explicit things a person may do with one highlight, each shown
 * before it happens:
 * - Ask about it: the server prepares the exact text; opening the draft only
 *   holds it for a conversation in the briefing's own scope (its Project's
 *   Room, or a private Room only you read). Nothing is sent, attached or run
 *   until you send the draft yourself; the server checks it again then.
 * - Adopt as a Task (writers): a preview of the Task, created only on Confirm,
 *   and only if nothing it rests on changed since; repeated confirmations
 *   return the same Task.
 */
export function HighlightActions({ briefingId, index, scope, api, canAdopt }: {
  briefingId: string
  index: number
  scope: BriefingActionScope
  api: HighlightActionApi
  canAdopt: boolean
}) {
  const { t } = useAppTranslation()
  const navigate = useSpaceNavigate()
  // The business owner of everything below: one highlight (its stable index)
  // of one briefing in one scope. Previews, results and pending requests
  // belong to it and never carry over to another.
  const owner = highlightActionOwner(scope, briefingId, index)
  const [ownedBy, setOwnedBy] = useState(owner)
  const [followUp, setFollowUp] = useState<BriefingFollowUpPreview | null>(null)
  const [adoption, setAdoption] = useState<BriefingAdoptionPreview | null>(null)
  const [adopted, setAdopted] = useState<BriefingAdoptionResult | null>(null)
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [target, setTarget] = useState('')
  // The request that holds the buttons, by its token: only it, or closing what it was for, releases them.
  const [busyToken, setBusyToken] = useState<number | null>(null)
  if (ownedBy !== owner) {
    // Another highlight now: drop the previous one's state during render, before it can be shown or acted on.
    setOwnedBy(owner)
    setFollowUp(null); setAdoption(null); setAdopted(null); setProjects([]); setTarget(''); setBusyToken(null)
  }
  // Only the newest action of this mount, for this owner, in this login session, may land.
  const token = useRef(0)
  const mounted = useRef(false)
  const current = useRef(owner)
  const epoch = useRef(sessionEpoch())
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; token.current++ }
  }, [])
  useEffect(() => {
    if (current.current !== owner) { current.current = owner; token.current++ }
  }, [owner])
  const invalidate = () => { token.current++; setBusyToken(null) }
  const run = async (action: (live: () => boolean) => Promise<void>) => {
    const own = ++token.current
    const live = () => mounted.current && token.current === own && current.current === owner && sessionEpoch() === epoch.current
    setBusyToken(own)
    try { await action(live) } catch (error) { if (live()) toast.error(errMsg(error)) } finally {
      setBusyToken(held => (held === own ? null : held))
    }
  }
  const busy = busyToken !== null
  const ownsPreview = (preview: { briefing_id: string; highlight: number } | null) =>
    preview !== null && preview.briefing_id === briefingId && preview.highlight === index

  const openFollowUp = () => run(async live => {
    const preview = await api.followUp(briefingId, index)
    if (!live() || !ownsPreview(preview)) return
    setFollowUp(preview)
    if (scope.type === 'personal') {
      const page = await projectsApi.list({ status: 'active', limit: 100 })
      if (!live()) return
      const items = page.items.map(project => ({ id: project.id, name: project.name }))
      setProjects(items)
      setTarget(items[0]?.id ?? '')
    }
  })

  const openDraft = () => run(async live => {
    if (!ownsPreview(followUp)) return
    // A Project briefing stays in its Project's Room; a personal one goes only to a Room only you read.
    const projectId = scope.type === 'project' ? scope.projectId : target
    if (!projectId) return
    const roomId = scope.type === 'project'
      ? (await projectsApi.mainlineRoom(projectId)).room.id
      : (await roomsApi.create({ project_id: projectId, title: t('briefing.actions.private_room'), personal: true })).room.id
    if (!live()) return
    holdReferences(roomId, [{ kind: 'briefing_highlight', id: briefingId, highlight: index }])
    setFollowUp(null)
    navigate(`/projects/${projectId}/rooms?room=${roomId}&new=1&reference=1`)
  })

  const openAdoption = () => run(async live => {
    const preview = await api.previewAdoption(briefingId, index)
    if (live() && ownsPreview(preview)) { setAdopted(null); setAdoption(preview) }
  })

  const confirmAdoption = () => run(async live => {
    if (!adoption || !ownsPreview(adoption)) return
    const result = await api.adopt(briefingId, index, adoption.preview_hash)
    if (!live()) return
    setAdopted(result)
    toast.success(result.created ? t('briefing.actions.adopted') : t('briefing.actions.already_adopted'))
  })

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void openFollowUp()}>
        <MessageSquarePlus className="size-4" />{t('briefing.actions.ask')}
      </Button>
      {canAdopt ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void openAdoption()}>
          <ClipboardCheck className="size-4" />{t('briefing.actions.adopt')}
        </Button>
      ) : null}

      <Dialog open={followUp !== null} onOpenChange={open => { if (!open) { invalidate(); setFollowUp(null) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('briefing.actions.ask_title')}</DialogTitle>
            <DialogDescription>{t(scope.type === 'project' ? 'briefing.actions.ask_project' : 'briefing.actions.ask_personal')}</DialogDescription>
          </DialogHeader>
          <pre data-testid="follow-up-preview" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs">{followUp?.preview}</pre>
          {scope.type === 'personal' ? (
            projects.length ? (
              <label className="flex flex-wrap items-center gap-2 text-xs">
                <span>{t('briefing.actions.private_in')}</span>
                <select className="max-w-full rounded-md border border-border bg-background px-2 py-1" value={target} onChange={event => setTarget(event.target.value)}>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
            ) : <p className="text-xs text-muted-foreground">{t('briefing.actions.no_project')}</p>
          ) : null}
          <DialogFooter>
            <Button disabled={busy || (scope.type === 'personal' && !target)} onClick={() => void openDraft()}>{t('briefing.actions.open_draft')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={adoption !== null} onOpenChange={open => { if (!open) { invalidate(); setAdoption(null); setAdopted(null) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('briefing.actions.adopt_title')}</DialogTitle>
            <DialogDescription>{t(adoption?.visibility === 'private' ? 'briefing.actions.adopt_private' : 'briefing.actions.adopt_project')}</DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium break-words">{adoption?.title}</p>
          <pre data-testid="adoption-preview" className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs">{adoption?.description}</pre>
          {adoption?.existing_task_id && !adopted ? <p className="text-xs text-muted-foreground">{t('briefing.actions.already_adopted')}</p> : null}
          {adopted ? <p role="status" className="text-sm">{adopted.created ? t('briefing.actions.adopted') : t('briefing.actions.already_adopted')}</p> : null}
          <DialogFooter>
            {adopted
              ? <Button variant="outline" onClick={() => navigate(adopted.task.project_id ? `/projects/${adopted.task.project_id}/tasks/${adopted.task.id}` : `/tasks/${adopted.task.id}`)}>{t('briefing.actions.open_task')}</Button>
              : <Button disabled={busy} onClick={() => void confirmAdoption()}>{t('briefing.actions.confirm_adopt')}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
