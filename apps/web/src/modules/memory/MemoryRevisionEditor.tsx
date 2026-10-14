import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { memoryApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Proposal } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'

/**
 * The revision a maintenance finding asks for. The proposal cannot be accepted
 * as generated: the person who decides what the entry says writes the new
 * text here first, and accepting it is a separate decision.
 */
export function MemoryRevisionEditor({ proposal, onRevised }: {
  proposal: Proposal
  onRevised: (proposal: Proposal) => void
}) {
  const revised = Boolean(proposal.operator_revision?.edited_by_user_id)
  const [content, setContent] = useState(revised ? proposal.proposed_content : '')
  const [loaded, setLoaded] = useState(revised)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (revised || !proposal.target_memory_id) return
    let cancelled = false
    memoryApi.get(proposal.target_memory_id)
      .then(memory => { if (!cancelled) setContent(memory.content ?? '') })
      .catch(error => { if (!cancelled) toast.error(errMsg(error)) })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [proposal.target_memory_id, revised])

  async function save() {
    setSaving(true)
    try {
      onRevised(await memoryApi.reviseProposal(proposal.id, { content: content.trim() }))
      toast.success('Revision saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <p className="text-sm font-medium">Revise this memory</p>
      <p className="text-xs text-muted-foreground">
        {revised
          ? 'Your revision is saved. Accept to write it as the new version, or change it again.'
          : 'This finding is fixed by rewriting the entry. Accepting it unchanged is refused.'}
      </p>
      <Textarea
        aria-label="Revised memory content"
        value={content}
        disabled={!loaded || saving || proposal.status !== 'pending'}
        onChange={event => setContent(event.target.value)}
        rows={6}
      />
      <Button size="sm" disabled={!loaded || saving || !content.trim() || proposal.status !== 'pending'} onClick={() => void save()}>
        Save revision
      </Button>
    </div>
  )
}
