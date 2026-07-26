import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { knowledgeApi, objectSchemaApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  KnowledgeContentFormat,
  KnowledgeCreateProposalBody,
  KnowledgeItemKind,
  KnowledgeVisibility,
  Proposal,
  SpaceObjectKindOut,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { ProjectFolderSelectors } from '../../components/ProjectFolderSelectors'
import KnowledgeProposalNotice from './KnowledgeProposalNotice'
import {
  KNOWLEDGE_FORMATS,
  KNOWLEDGE_ITEM_KINDS,
  KNOWLEDGE_VISIBILITIES,
  parseOptionalConfidence,
  parseTags,
  validateConfidence,
} from './utils'

interface CreateForm {
  knowledge_kind: KnowledgeItemKind
  title: string
  content: string
  content_format: KnowledgeContentFormat
  visibility: KnowledgeVisibility
  tags: string
  confidence: string
  project_id: string
  project_folder_id: string
  object_kind_fields: string
  rationale: string
}

const EMPTY_CREATE_FORM: CreateForm = {
  knowledge_kind: 'concept',
  title: '',
  content: '',
  content_format: 'markdown',
  visibility: 'space_shared',
  tags: '',
  confidence: '',
  project_id: '',
  project_folder_id: '',
  object_kind_fields: '',
  rationale: '',
}

interface KnowledgeCreateProposalFormProps {
  hasOperationalSpace: boolean
}

export default function KnowledgeCreateProposalForm({ hasOperationalSpace }: KnowledgeCreateProposalFormProps) {
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE_FORM)
  const [objectKinds, setObjectKinds] = useState<SpaceObjectKindOut[]>([])
  const [lastProposal, setLastProposal] = useState<Proposal | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!hasOperationalSpace) {
      setObjectKinds([])
      return
    }
    objectSchemaApi.listKinds({ base_object_type: 'knowledge_item', status: 'active', limit: 100 })
      .then(page => setObjectKinds(page.items.filter(kind => isKnowledgeItemKind(kind.key))))
      .catch(() => setObjectKinds([]))
  }, [hasOperationalSpace])

  const kindOptions = useMemo(() => {
    const labels = new Map(objectKinds.map(kind => [kind.key, kind.label]))
    return KNOWLEDGE_ITEM_KINDS.map(kind => ({
      value: kind,
      label: labels.get(kind) ? `${labels.get(kind)} (${kind})` : kind,
    }))
  }, [objectKinds])

  function setField<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function submitCreateProposal() {
    if (!hasOperationalSpace) {
      toast.error('Select an operational space before proposing knowledge')
      return
    }
    if (!form.title.trim() || !form.content.trim()) {
      toast.error('Title and content are required')
      return
    }
    const confidence = parseOptionalConfidence(form.confidence)
    if (!validateConfidence(confidence)) {
      toast.error('Confidence must be a number from 0 to 1')
      return
    }
    let objectKindFields: Record<string, unknown> | undefined
    if (form.object_kind_fields.trim()) {
      try {
        const parsed = JSON.parse(form.object_kind_fields) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('object_kind_fields must be a JSON object')
        }
        objectKindFields = parsed as Record<string, unknown>
      } catch (e) {
        toast.error(errMsg(e))
        return
      }
    }
    const body: KnowledgeCreateProposalBody = {
      knowledge_kind: form.knowledge_kind,
      title: form.title.trim(),
      content: form.content,
      content_format: form.content_format,
      visibility: form.visibility,
      tags: parseTags(form.tags),
      confidence,
      project_id: form.project_id.trim() || null,
      project_folder_id: form.project_folder_id.trim() || null,
      source_run_id: null,
      source_refs: [],
      ...(objectKindFields ? { object_kind_fields: objectKindFields } : {}),
      rationale: form.rationale.trim() || null,
    }
    setSubmitting(true)
    try {
      const p = await knowledgeApi.proposeCreate(body)
      setLastProposal(p)
      setForm(EMPTY_CREATE_FORM)
      toast.success('Knowledge proposal created')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-4">
        <CardTitle>Propose Knowledge</CardTitle>
        <Badge variant="outline">proposal only</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label>Title</Label>
          <Input value={form.title} onChange={e => setField('title', e.target.value)} placeholder="Short title..." />
        </div>
        <div>
          <Label>Knowledge kind</Label>
          <Select value={form.knowledge_kind} onChange={v => setField('knowledge_kind', v as KnowledgeItemKind)} options={kindOptions} />
        </div>
        <div>
          <Label>Content format</Label>
          <Select value={form.content_format} onChange={v => setField('content_format', v as KnowledgeContentFormat)} options={KNOWLEDGE_FORMATS.map(f => ({ value: f, label: f }))} />
        </div>
        <div>
          <Label>Visibility</Label>
          <Select value={form.visibility} onChange={v => setField('visibility', v as KnowledgeVisibility)} options={KNOWLEDGE_VISIBILITIES.map(v => ({ value: v, label: v }))} />
        </div>
        <div>
          <Label>Tags</Label>
          <Input value={form.tags} onChange={e => setField('tags', e.target.value)} placeholder="comma, separated" />
        </div>
        <div>
          <Label>Confidence</Label>
          <Input value={form.confidence} onChange={e => setField('confidence', e.target.value)} placeholder="optional, 0 to 1" />
        </div>
        <div className="md:col-span-2">
          <Label>Content</Label>
          <Textarea value={form.content} onChange={e => setField('content', e.target.value)} placeholder="Knowledge content..." />
        </div>
        <div className="md:col-span-2">
          <Label>Rationale</Label>
          <Textarea value={form.rationale} onChange={e => setField('rationale', e.target.value)} placeholder="Optional. Backend will default if empty." />
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <CardTitle>Advanced Associations</CardTitle>
        <div className="grid gap-3 md:grid-cols-2 mt-3">
          <ProjectFolderSelectors projectId={form.project_id} folderId={form.project_folder_id} onProjectChange={value => setField('project_id', value)} onFolderChange={value => setField('project_folder_id', value)} />
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <CardTitle>Advanced fields</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">Run and source provenance is attached by the owning extraction/review flow, not entered manually.</p>
        <div className="grid gap-3 md:grid-cols-2 mt-3">
          <div className="md:col-span-2">
            <Label>object_kind_fields JSON</Label>
            <Textarea value={form.object_kind_fields} onChange={e => setField('object_kind_fields', e.target.value)} placeholder='optional, e.g. {"risk":"low"}' />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-4">
        <Button onClick={submitCreateProposal} disabled={submitting || !hasOperationalSpace}>
          <Plus className="size-4 mr-1" />Submit proposal
        </Button>
      </div>
      {lastProposal && <div className="mt-4"><KnowledgeProposalNotice proposal={lastProposal} /></div>}
    </Card>
  )
}

function isKnowledgeItemKind(value: string): value is KnowledgeItemKind {
  return (KNOWLEDGE_ITEM_KINDS as readonly string[]).includes(value)
}
