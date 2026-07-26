import { useState } from 'react'
import { Link2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  KnowledgeItemSummary,
  KnowledgeRelationStatus,
  KnowledgeRelationType,
  Proposal,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { ScopeBadge } from '../../components/ScopeBadge'
import {
  KNOWLEDGE_RELATION_STATUSES,
  KNOWLEDGE_RELATION_TYPES,
  parseOptionalConfidence,
  validateConfidence,
} from './utils'

interface RelationForm {
  relation_type: KnowledgeRelationType
  status: Extract<KnowledgeRelationStatus, 'candidate' | 'active'>
  confidence: string
  evidence_summary: string
  rationale: string
}

interface KnowledgeRelationProposalFormProps {
  currentItemId: string
  onProposalCreated: (proposal: Proposal) => void
}

export default function KnowledgeRelationProposalForm({ currentItemId, onProposalCreated }: KnowledgeRelationProposalFormProps) {
  const [form, setForm] = useState<RelationForm>({
    relation_type: 'related_to',
    status: 'active',
    confidence: '',
    evidence_summary: '',
    rationale: '',
  })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KnowledgeItemSummary[]>([])
  const [selected, setSelected] = useState<KnowledgeItemSummary | null>(null)
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  function setField<K extends keyof RelationForm>(key: K, value: RelationForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function searchTargets() {
    if (!query.trim()) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const page = await knowledgeApi.list({ q: query.trim(), status: 'active', limit: 8 })
      setResults(page.items.filter(item => item.id !== currentItemId))
    } catch (e) {
      toast.error(errMsg(e))
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  function selectTarget(item: KnowledgeItemSummary) {
    if (item.id === currentItemId) {
      toast.error('Cannot relate an item to itself')
      return
    }
    setSelected(item)
  }

  async function submitRelationProposal() {
    const targetId = selected?.id ?? ''
    if (!targetId) {
      toast.error('Search for and select a target Knowledge item')
      return
    }
    if (targetId === currentItemId) {
      toast.error('Cannot relate an item to itself')
      return
    }
    const confidence = parseOptionalConfidence(form.confidence)
    if (!validateConfidence(confidence)) {
      toast.error('Confidence must be a number from 0 to 1')
      return
    }
    setSubmitting(true)
    try {
      const p = await knowledgeApi.proposeRelation({
        from_object_id: currentItemId,
        to_object_id: targetId,
        relation_type: form.relation_type,
        status: form.status,
        confidence,
        evidence_summary: form.evidence_summary.trim() || null,
        rationale: form.rationale.trim() || null,
      })
      onProposalCreated(p)
      setForm({
        relation_type: 'related_to',
        status: 'active',
        confidence: '',
        evidence_summary: '',
        rationale: '',
      })
      setSelected(null)
      setResults([])
      setQuery('')
      toast.success('Relation proposal created')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-4">
        <CardTitle>Propose Relation</CardTitle>
        <Badge variant="outline">proposal only</Badge>
      </div>

      <div className="space-y-4">
        <div>
          <Label>Search target</Label>
          <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); searchTargets() }}>
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search active knowledge items..." />
            <Button type="submit" size="sm" disabled={searching}>
              <Search className="size-3.5" />Search
            </Button>
          </form>
        </div>

        {results.length > 0 && (
          <div className="rounded-md border border-border divide-y divide-border">
            {results.map(item => (
              <button
                type="button"
                key={item.id}
                className="w-full text-left px-3 py-2 hover:bg-accent/40"
                onClick={() => selectTarget(item)}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{item.title}</span>
                  <Badge variant="secondary">{item.knowledge_kind}</Badge>
                  <ScopeBadge visibility={item.visibility} />
                </div>
                {item.content_preview && <p className="line-clamp-2 text-xs text-muted-foreground">{item.content_preview}</p>}
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="rounded-md border border-border p-3 bg-muted/30">
            <p className="text-xs text-muted-foreground mb-1">Selected target</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium">{selected.title}</span>
              <Badge variant="secondary">{selected.knowledge_kind}</Badge>
              <ScopeBadge visibility={selected.visibility} />
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>relation_type</Label>
            <Select value={form.relation_type} onChange={v => setField('relation_type', v as KnowledgeRelationType)} options={KNOWLEDGE_RELATION_TYPES.map(t => ({ value: t, label: t }))} />
          </div>
          <div>
            <Label>status</Label>
            <Select value={form.status} onChange={v => setField('status', v as Extract<KnowledgeRelationStatus, 'candidate' | 'active'>)} options={KNOWLEDGE_RELATION_STATUSES.map(s => ({ value: s, label: s }))} />
          </div>
          <div>
            <Label>confidence</Label>
            <Input value={form.confidence} onChange={e => setField('confidence', e.target.value)} placeholder="optional, 0 to 1" />
          </div>
          <div>
            <Label>evidence_summary</Label>
            <Input value={form.evidence_summary} onChange={e => setField('evidence_summary', e.target.value)} placeholder="optional" />
          </div>
          <div className="md:col-span-2">
            <Label>rationale</Label>
            <Textarea value={form.rationale} onChange={e => setField('rationale', e.target.value)} placeholder="Optional. Backend will default if empty." />
          </div>
        </div>
      </div>

      <Button className="mt-4" onClick={submitRelationProposal} disabled={submitting}>
        <Link2 className="size-4 mr-1" />Submit relation proposal
      </Button>
    </Card>
  )
}
