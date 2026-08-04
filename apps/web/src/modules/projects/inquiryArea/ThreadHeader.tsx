import { useEffect, useState } from 'react'
import { Check, MoreHorizontal, Pencil, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type { InquiryAttentionState, InquiryThreadDetail, SpaceMember } from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { Textarea } from '../../../components/ui/textarea'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import { ReasonDialog } from './dialogs'
import { PRIORITY_OPTIONS, priorityLabel } from './threadGrouping'

const ATTENTION_STATES: InquiryAttentionState[] = ['focused', 'monitoring', 'backlog', 'blocked']

/**
 * Identity plus the low-frequency management commands. Only `wording_only`
 * revision lives here: a semantic change reshapes what the Thread is about and
 * can strand a pinned research Workflow at its alignment guard, so it belongs
 * in the assessment workspace that owns confirmed wording.
 */
export function ThreadHeader({ projectId, detail, members, onChanged }: {
  projectId: string
  detail: InquiryThreadDetail
  members: SpaceMember[]
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [statement, setStatement] = useState(detail.statement)
  const [saving, setSaving] = useState(false)
  const [lifecycleTarget, setLifecycleTarget] = useState<'resolved' | 'rejected' | 'archived' | null>(null)

  useEffect(() => { setStatement(detail.statement); setEditing(false) }, [detail])

  const canAct = detail.lifecycle_status === 'active'
  const owner = members.find(member => member.user_id === detail.owner_user_id)

  async function saveWording() {
    if (!statement.trim()) { toast.error('A statement is required'); return }
    if (statement.trim() === detail.statement) { setEditing(false); return }
    setSaving(true)
    try {
      await inquiryApi.reviseDefinition(projectId, detail.id, {
        revision_kind: 'wording_only',
        new_statement: statement.trim(),
      })
      setEditing(false)
      await onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  async function updateWork(body: Record<string, unknown>) {
    try {
      const result = await inquiryApi.updateWork(projectId, detail.id, body)
      if (result.wip_limit_exceeded) toast.warning('Shared Focus WIP limit exceeded — consider moving another Thread to Monitoring')
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  /**
   * The domain requires a focused Thread to carry exactly one of a Next Focus
   * or a blocking reason. Saying so here beats letting the command 422.
   */
  function focusOrWarn(state: InquiryAttentionState) {
    if (state === 'focused' && !detail.next_focus_kind && !detail.blocked_reason) {
      toast.error('Decide a next step first — a focused Thread needs one.')
      return
    }
    void updateWork({ attention_state: state })
  }

  async function togglePersonalFocus() {
    try {
      await inquiryApi.setPersonalFocus(projectId, detail.id, !detail.in_personal_focus)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  async function transitionLifecycle(status: 'active' | 'resolved' | 'rejected' | 'archived', reason?: string) {
    try {
      await inquiryApi.transitionLifecycle(projectId, detail.id, status, reason || undefined)
      await onChanged()
    } catch (error) { toast.error(errMsg(error)) }
  }

  return (
    <>
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{detail.kind}</Badge>
          {detail.lifecycle_status !== 'active' && <Badge variant="secondary">{detail.lifecycle_status}</Badge>}
          <Badge variant="secondary">v{detail.version}</Badge>
          <Badge variant="outline" className="text-[10px]">{detail.attention_state}</Badge>
          {detail.priority !== 1 && <Badge variant="outline" className="text-[10px]">{priorityLabel(detail.priority)} priority</Badge>}
          {owner && <span className="text-xs text-muted-foreground">· {owner.display_name}</span>}
          <div className="flex-1" />
          {detail.in_personal_focus && <Star className="size-3.5 fill-current text-amber-500" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Thread actions"><MoreHorizontal className="size-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={togglePersonalFocus}>
                {detail.in_personal_focus ? 'Remove from My Focus' : 'Add to My Focus'}
              </DropdownMenuItem>
              {canAct && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Priority</DropdownMenuLabel>
                  {PRIORITY_OPTIONS.map(option => (
                    <DropdownMenuItem key={option.value} onSelect={() => updateWork({ priority: Number(option.value) })}>
                      {option.label}{detail.priority === Number(option.value) ? ' ✓' : ''}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Attention</DropdownMenuLabel>
                  {ATTENTION_STATES.filter(state => state !== 'blocked').map(state => (
                    <DropdownMenuItem key={state} onSelect={() => focusOrWarn(state)}>
                      {state}{detail.attention_state === state ? ' ✓' : ''}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Owner</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => updateWork({ owner_user_id: null })}>
                    Unassigned{detail.owner_user_id === null ? ' ✓' : ''}
                  </DropdownMenuItem>
                  {members.map(member => (
                    <DropdownMenuItem key={member.user_id} onSelect={() => updateWork({ owner_user_id: member.user_id })}>
                      {member.display_name}{detail.owner_user_id === member.user_id ? ' ✓' : ''}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to={`/projects/${projectId}/inquiry/${detail.id}/assess`}>Redefine this {detail.kind}…</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLifecycleTarget('resolved')}>Mark resolved…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLifecycleTarget('rejected')}>Mark rejected…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLifecycleTarget('archived')}>Archive…</DropdownMenuItem>
                </>
              )}
              {!canAct && detail.lifecycle_status !== 'superseded' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => transitionLifecycle('active')}>Reopen</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {editing
          ? (
            <div className="space-y-2">
              <Textarea value={statement} onChange={event => setStatement(event.target.value)} rows={3} aria-label="Thread statement" />
              <p className="text-xs text-muted-foreground">
                Wording fixes only. To change what this {detail.kind} is asking, use “Redefine this {detail.kind}”.
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveWording} disabled={saving}><Check className="size-4" />{saving ? 'Saving…' : 'Save wording'}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setStatement(detail.statement); setEditing(false) }}><X className="size-4" />Cancel</Button>
              </div>
            </div>
          )
          : (
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-base font-medium">{detail.statement}</p>
              {canAct && (
                <Button variant="ghost" size="icon" aria-label="Edit wording" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                </Button>
              )}
            </div>
          )}

        <p className="mt-2 text-sm text-muted-foreground">
          {detail.kind === 'question'
            ? `Answer (${detail.question_state?.answer_state ?? 'open'}): ${detail.question_state?.current_answer_summary || '—'}`
            : `Evaluation: ${detail.hypothesis_state?.evaluation_state ?? 'untested'}${
              detail.hypothesis_state?.confidence !== null && detail.hypothesis_state?.confidence !== undefined
                ? ` (confidence ${detail.hypothesis_state.confidence})` : ''}`}
        </p>
      </Card>

      <ReasonDialog
        open={lifecycleTarget !== null}
        onOpenChange={open => { if (!open) setLifecycleTarget(null) }}
        title={`Mark this Thread ${lifecycleTarget ?? ''}`}
        description="Recorded with the transition so the history explains why this Thread stopped being active."
        label="Reason (optional)"
        confirmLabel="Confirm"
        onConfirm={async reason => {
          if (lifecycleTarget) await transitionLifecycle(lifecycleTarget, reason)
          setLifecycleTarget(null)
        }}
      />
    </>
  )
}
