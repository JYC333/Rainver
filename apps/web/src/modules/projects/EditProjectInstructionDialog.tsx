import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { projectsApi } from '../../api/client'
import type { ProjectInstructionVersion } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { currentPendingContextVersion } from './currentPendingContextVersion'

export default function EditProjectInstructionDialog(props: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<ProjectInstructionVersion | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!props.open) return
    setTitle('')
    setText('')
    setDraft(null)
    void projectsApi.listInstructionVersions(props.projectId)
      .then(versions => {
        const pending = currentPendingContextVersion(versions)
        setDraft(pending)
        if (pending) { setTitle(pending.title); setText(pending.instruction_text) }
      })
      .catch(error => toast.error(errMsg(error)))
  }, [props.open, props.projectId])
  async function create() {
    setSaving(true)
    try { setDraft(await projectsApi.createInstructionVersion(props.projectId, { title, instruction_text: text })); toast.success('Instruction draft created') }
    catch (error) { toast.error(errMsg(error)) } finally { setSaving(false) }
  }
  async function transition(publish: boolean) {
    if (!draft) return
    setSaving(true)
    try {
      const next = publish ? await projectsApi.publishInstruction(props.projectId, draft.id) : await projectsApi.submitInstructionForReview(props.projectId, draft.id)
      setDraft(next); toast.success(publish ? 'Project instruction published' : 'Instruction submitted for review')
      if (publish) { setDraft(null); setTitle(''); setText(''); props.onOpenChange(false) }
    } catch (error) { toast.error(errMsg(error)) } finally { setSaving(false) }
  }
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Project instruction</DialogTitle><DialogDescription>Only an explicitly reviewed and published instruction is delivered to agents.</DialogDescription></DialogHeader>
    <div className="space-y-3"><div><Label htmlFor="instruction-title">Title</Label><Input id="instruction-title" value={title} onChange={e => setTitle(e.target.value)} disabled={Boolean(draft)} /></div><div><Label htmlFor="instruction-text">Instruction</Label><Textarea id="instruction-text" rows={7} value={text} onChange={e => setText(e.target.value)} disabled={Boolean(draft)} /></div></div>
    <DialogFooter><Button variant="ghost" onClick={() => props.onOpenChange(false)}>Cancel</Button>{draft && <Button variant="outline" disabled={saving} onClick={() => setDraft(null)}>Create corrected version</Button>}{!draft && <Button disabled={saving || !title.trim() || !text.trim()} onClick={() => void create()}>Save draft</Button>}{draft?.status === 'draft' && <Button disabled={saving} onClick={() => void transition(false)}>Submit for review</Button>}{draft?.status === 'in_review' && <Button disabled={saving} onClick={() => void transition(true)}>Publish</Button>}</DialogFooter>
  </DialogContent></Dialog>
}
