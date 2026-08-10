import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { projectsApi } from '../../api/client'
import type { ProjectBriefVersion } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { currentPendingContextVersion } from './currentPendingContextVersion'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'

interface EditProjectBriefGoalDialogProps {
  projectId: string
  brief: ProjectBriefVersion | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (updated: ProjectBriefVersion) => void
  canPublish: boolean
}

/** Brief Versions are immutable. Editing the Overview's goal creates the next
 * version while preserving the fields this compact dialog does not expose. */
export default function EditProjectBriefGoalDialog({
  projectId,
  brief,
  open,
  onOpenChange,
  onSaved,
  canPublish,
}: EditProjectBriefGoalDialogProps) {
  const [goal, setGoal] = useState(brief?.goal ?? '')
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<ProjectBriefVersion | null>(null)
  const [correctionSource, setCorrectionSource] = useState<ProjectBriefVersion | null>(null)

  useEffect(() => {
    if (!open) return
    setGoal(brief?.goal ?? '')
    setDraft(null)
    setCorrectionSource(null)
    void projectsApi.listBriefVersions(projectId)
      .then(versions => {
        const pending = currentPendingContextVersion(versions)
        setDraft(pending)
        if (pending) setGoal(pending.goal ?? '')
      })
      .catch(error => toast.error(errMsg(error)))
  }, [brief, open, projectId])

  async function save() {
    setSaving(true)
    try {
      const source = correctionSource ?? brief
      const updated = await projectsApi.createBriefVersion(projectId, {
        goal: goal.trim() || null,
        scope_included: source?.scope_included ?? null,
        scope_excluded: source?.scope_excluded ?? null,
        success_definition: source?.success_definition ?? null,
        constraints: source?.constraints ?? null,
        assumptions: source?.assumptions ?? null,
        confirmed_decisions: source?.confirmed_decisions ?? [],
        workspace_identity: source?.workspace_identity ?? {},
        workspace_boundary: source?.workspace_boundary ?? {},
        source_refs: source?.source_refs ?? [],
      })
      toast.success('Brief draft created')
      setDraft(updated)
      setCorrectionSource(null)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  async function transition(action: 'review' | 'publish') {
    if (!draft) return
    setSaving(true)
    try {
      const updated = action === 'review'
        ? await projectsApi.submitBriefForReview(projectId, draft.id)
        : await projectsApi.publishBrief(projectId, draft.id)
      setDraft(updated)
      if (updated.status === 'published') { onSaved(updated); onOpenChange(false) }
      toast.success(updated.status === 'published' ? 'Brief published' : 'Brief submitted for review')
    } catch (error) { toast.error(errMsg(error)) } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Project goal</DialogTitle>
          <DialogDescription>
            Saving creates an immutable draft. Only a reviewed, explicitly published version becomes runtime context.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="project-brief-goal">Goal</Label>
          <Textarea
            id="project-brief-goal"
            value={goal}
            onChange={event => setGoal(event.target.value)}
            disabled={Boolean(draft)}
            placeholder="What outcome should this Project produce?"
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          {draft && <Button variant="outline" onClick={() => { setCorrectionSource(draft); setDraft(null); setGoal(draft.goal ?? '') }} disabled={saving}>
            Create corrected version
          </Button>}
          {!draft && <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save goal'}
          </Button>}
          {draft?.status === 'draft' && <Button onClick={() => void transition('review')} disabled={saving}>Submit for review</Button>}
          {draft?.status === 'in_review' && canPublish && <Button onClick={() => void transition('publish')} disabled={saving}>Publish</Button>}
          {draft?.status === 'in_review' && !canPublish && <span className="text-sm text-muted-foreground">Awaiting Project owner review</span>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
