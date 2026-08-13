import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import { Button } from '../../../components/ui/button'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog'

/**
 * Replaces the `window.prompt` calls this Area used for reasons and free-text
 * decisions: those bypassed validation, could not explain what the value was
 * for, and rendered outside the app's own styling.
 */
export function ReasonDialog({ open, onOpenChange, title, description, label, placeholder, required, confirmLabel, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  label: string
  placeholder?: string
  required?: boolean
  confirmLabel: string
  onConfirm: (reason: string) => Promise<void | boolean> | void | boolean
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (open) setReason('') }, [open])

  async function confirm() {
    if (required && !reason.trim()) { toast.error(`${label} is required`); return }
    setSaving(true)
    try {
      const confirmed = await onConfirm(reason.trim())
      if (confirmed !== false) onOpenChange(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="reason-dialog-input">{label}{required && <span className="text-destructive"> *</span>}</Label>
          <Textarea
            id="reason-dialog-input"
            value={reason}
            onChange={event => setReason(event.target.value)}
            placeholder={placeholder}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={confirm} disabled={saving}>{saving ? 'Saving…' : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CreateThreadDialog({ open, onOpenChange, onCreated, projectId, defaultKind }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  projectId: string
  defaultKind: 'question' | 'hypothesis'
}) {
  const [kind, setKind] = useState<'question' | 'hypothesis'>(defaultKind)
  const [statement, setStatement] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => { if (open) setKind(defaultKind) }, [defaultKind, open])

  async function create() {
    if (!statement.trim()) { toast.error('Statement is required'); return }
    setCreating(true)
    try {
      const created = await inquiryApi.createThread(projectId, { kind, statement: statement.trim() })
      setStatement('')
      onCreated(created.id)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Thread</DialogTitle>
          <DialogDescription className="sr-only">Create a Question or Hypothesis Thread.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-2">
            <Button variant={kind === 'question' ? 'default' : 'outline'} size="sm" onClick={() => setKind('question')}>Question</Button>
            <Button variant={kind === 'hypothesis' ? 'default' : 'outline'} size="sm" onClick={() => setKind('hypothesis')}>Hypothesis</Button>
          </div>
          <div className="space-y-1.5">
            <Label>Statement <span className="text-destructive">*</span></Label>
            <Textarea
              value={statement}
              onChange={event => setStatement(event.target.value)}
              placeholder={kind === 'question' ? 'What is the current question?' : 'What is the proposed claim?'}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={creating}>{creating ? 'Creating…' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
