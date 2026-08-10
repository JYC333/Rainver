import { useEffect, useMemo, useState } from 'react'
import { Archive, Ban, CheckCircle2, Download, Pencil, Plus, RefreshCw, Save, Shapes, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { objectSchemaApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { errMsg } from '../../lib/utils'
import {
  SPACE_OBJECT_PROFILE_KEYS_BY_BASE_OBJECT_TYPE,
  type ObjectSchemaExportManifest,
  type RetrievalObjectType,
  type SpaceObjectProfileCreateProposalRequest,
  type SpaceObjectProfileOut,
  type SpaceObjectProfileRelationHintRequest,
  type SpaceObjectProfileStatus,
} from '../../types/api'

const BASE_TYPES: RetrievalObjectType[] = [
  'knowledge_item',
  'note',
  'source',
  'claim',
  'memory_entry',
  'project_public_summary',
]
const STATUSES: SpaceObjectProfileStatus[] = ['draft', 'active', 'deprecated', 'archived']

interface CreateForm {
  key: string
  label: string
  description: string
  base_object_type: RetrievalObjectType
  status: 'draft' | 'active'
  field_schema: string
  relation_hints: string
}

const EMPTY_CREATE: CreateForm = {
  key: 'concept',
  label: '',
  description: '',
  base_object_type: 'knowledge_item',
  status: 'draft',
  field_schema: '',
  relation_hints: '',
}

export function ObjectSchemaPanel() {
  const [items, setItems] = useState<SpaceObjectProfileOut[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [busyKind, setBusyKind] = useState<string | null>(null)
  const [status, setStatus] = useState<SpaceObjectProfileStatus | 'all'>('all')
  const [baseType, setBaseType] = useState<RetrievalObjectType | 'all'>('all')
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE)
  const [exportedManifest, setExportedManifest] = useState('')
  const [importManifest, setImportManifest] = useState('')
  const [editingHintsFor, setEditingHintsFor] = useState<string | null>(null)
  const [relationHintDraft, setRelationHintDraft] = useState('')
  const [updatingHints, setUpdatingHints] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const page = await objectSchemaApi.listKinds({
        status: status === 'all' ? undefined : status,
        base_object_type: baseType === 'all' ? undefined : baseType,
        limit: 100,
      })
      setItems(page.items)
    } catch (e) {
      toast.error(errMsg(e))
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [status, baseType])

  const grouped = useMemo(() => {
    const out = new Map<RetrievalObjectType, SpaceObjectProfileOut[]>()
    for (const item of items) {
      const arr = out.get(item.base_object_type) ?? []
      arr.push(item)
      out.set(item.base_object_type, arr)
    }
    return out
  }, [items])

  function setField<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm(current => ({ ...current, [key]: value }))
  }

  function setBaseObjectType(value: RetrievalObjectType) {
    const allowed = SPACE_OBJECT_PROFILE_KEYS_BY_BASE_OBJECT_TYPE[value]
    setForm(current => ({
      ...current,
      base_object_type: value,
      key: allowed.includes(current.key as never) ? current.key : allowed[0] ?? '',
    }))
  }

  function parseJsonObject(raw: string, label: string): Record<string, unknown> {
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`)
    }
    return parsed as Record<string, unknown>
  }

  function parseRelationHints(raw: string): SpaceObjectProfileRelationHintRequest[] {
    if (!raw.trim()) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('relation_hints must be a JSON array')
    return parsed as SpaceObjectProfileRelationHintRequest[]
  }

  async function createProposal() {
    if (!form.key.trim() || !form.label.trim()) {
      toast.error('Key and label are required')
      return
    }
    let fieldSchema: Record<string, unknown>
    let relationHints: SpaceObjectProfileRelationHintRequest[]
    try {
      fieldSchema = parseJsonObject(form.field_schema, 'field_schema')
      relationHints = parseRelationHints(form.relation_hints)
    } catch (e) {
      toast.error(errMsg(e))
      return
    }
    setCreating(true)
    try {
      const body: SpaceObjectProfileCreateProposalRequest = {
        key: form.key.trim(),
        label: form.label.trim(),
        description: form.description.trim() || null,
        base_object_type: form.base_object_type,
        status: form.status,
        field_schema: fieldSchema,
        relation_hints: relationHints,
      }
      const proposal = await objectSchemaApi.proposeCreateKind(body)
      toast.success(`Object kind proposal ${proposal.id} created`)
      setForm(EMPTY_CREATE)
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  function editRelationHints(kind: SpaceObjectProfileOut) {
    setEditingHintsFor(kind.id)
    setRelationHintDraft(JSON.stringify((kind.relation_hints ?? []).map(hint => ({
      endpoint_object_type: hint.endpoint_object_type,
      endpoint_object_profile_id: hint.endpoint_object_profile_id ?? null,
      link_type: hint.link_type,
      direction: hint.direction ?? 'from',
      confidence_default: hint.confidence_default ?? 0.55,
      required: hint.required ?? false,
    })), null, 2))
  }

  async function proposeRelationHintUpdate(kind: SpaceObjectProfileOut) {
    let relationHints: SpaceObjectProfileRelationHintRequest[]
    try {
      relationHints = parseRelationHints(relationHintDraft)
    } catch (e) {
      toast.error(errMsg(e))
      return
    }
    setUpdatingHints(true)
    setBusyKind(kind.id)
    try {
      const proposal = await objectSchemaApi.proposeUpdateKind(kind.id, { relation_hints: relationHints })
      toast.success(`Object kind proposal ${proposal.id} created`)
      setEditingHintsFor(null)
      setRelationHintDraft('')
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusyKind(null)
      setUpdatingHints(false)
    }
  }

  async function proposeAction(kind: SpaceObjectProfileOut, action: 'activate' | 'deprecate' | 'archive') {
    setBusyKind(kind.id)
    try {
      const proposal = action === 'activate'
        ? await objectSchemaApi.proposeUpdateKind(kind.id, { status: 'active' })
        : action === 'deprecate'
          ? await objectSchemaApi.proposeDeprecateKind(kind.id)
          : await objectSchemaApi.proposeArchiveKind(kind.id)
      toast.success(`Object kind proposal ${proposal.id} created`)
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusyKind(null)
    }
  }

  async function exportSchema() {
    setExporting(true)
    try {
      const manifest = await objectSchemaApi.exportSchema()
      setExportedManifest(JSON.stringify(manifest, null, 2))
      toast.success(`Exported ${manifest.object_profiles.length} object kinds`)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setExporting(false)
    }
  }

  async function importSchema() {
    let manifest: ObjectSchemaExportManifest
    try {
      const parsed = JSON.parse(importManifest) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('manifest must be a JSON object')
      }
      manifest = parsed as ObjectSchemaExportManifest
    } catch (e) {
      toast.error(errMsg(e))
      return
    }
    setImporting(true)
    try {
      const result = await objectSchemaApi.importSchema({ manifest })
      toast.success(`Created ${result.created_proposal_count} draft proposals`)
      if (result.warnings.length > 0) toast.warning(result.warnings[0])
      setImportManifest('')
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Shapes className="size-3.5" /> Object Schema
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Select
            value={baseType}
            onChange={v => setBaseType(v as RetrievalObjectType | 'all')}
            options={[{ value: 'all', label: 'all types' }, ...BASE_TYPES.map(v => ({ value: v, label: v }))]}
          />
          <Select
            value={status}
            onChange={v => setStatus(v as SpaceObjectProfileStatus | 'all')}
            options={[{ value: 'all', label: 'all statuses' }, ...STATUSES.map(v => ({ value: v, label: v }))]}
          />
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="size-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <Label>key</Label>
          <Select
            value={form.key}
            onChange={v => setField('key', v)}
            options={SPACE_OBJECT_PROFILE_KEYS_BY_BASE_OBJECT_TYPE[form.base_object_type].map(v => ({ value: v, label: v }))}
          />
        </div>
        <div>
          <Label>label</Label>
          <Input value={form.label} onChange={e => setField('label', e.target.value)} placeholder="Decision" />
        </div>
        <div>
          <Label>base object type</Label>
          <Select value={form.base_object_type} onChange={v => setBaseObjectType(v as RetrievalObjectType)} options={BASE_TYPES.map(v => ({ value: v, label: v }))} />
        </div>
        <div>
          <Label>initial status</Label>
          <Select value={form.status} onChange={v => setField('status', v as 'draft' | 'active')} options={[{ value: 'draft', label: 'draft' }, { value: 'active', label: 'active' }]} />
        </div>
        <div className="md:col-span-2">
          <Label>description</Label>
          <Input value={form.description} onChange={e => setField('description', e.target.value)} placeholder="optional" />
        </div>
        <div className="md:col-span-2">
          <Label>field_schema JSON</Label>
          <Textarea
            value={form.field_schema}
            onChange={e => setField('field_schema', e.target.value)}
            placeholder='optional, e.g. {"enforcement":"strict","fields":[{"key":"risk","type":"string","required":true}]}'
          />
        </div>
        <div className="md:col-span-2">
          <Label>relation_hints JSON</Label>
          <Textarea
            value={form.relation_hints}
            onChange={e => setField('relation_hints', e.target.value)}
            placeholder='optional, e.g. [{"endpoint_object_type":"source","link_type":"references","direction":"from"}]'
          />
        </div>
      </div>
      <div className="mt-3">
        <Button size="sm" onClick={createProposal} disabled={creating}>
          <Plus className="size-3.5 mr-1.5" />
          {creating ? 'Creating...' : 'Create kind proposal'}
        </Button>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <CardTitle className="text-sm">Import / Export</CardTitle>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={exportSchema} disabled={exporting}>
                <Download className="size-3.5 mr-1.5" />
                {exporting ? 'Exporting...' : 'Export'}
              </Button>
            </div>
            <Textarea
              className="mt-2 min-h-32 font-mono text-xs"
              value={exportedManifest}
              onChange={e => setExportedManifest(e.target.value)}
              placeholder="exported object_schema manifest"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={importSchema} disabled={importing || !importManifest.trim()}>
                <Upload className="size-3.5 mr-1.5" />
                {importing ? 'Importing...' : 'Import Drafts'}
              </Button>
            </div>
            <Textarea
              className="mt-2 min-h-32 font-mono text-xs"
              value={importManifest}
              onChange={e => setImportManifest(e.target.value)}
              placeholder="paste agent_space.object_schema.v1 JSON"
            />
          </div>
        </div>
      </div>

      <div className="mt-5 divide-y divide-border">
        {loading ? (
          <p className="py-3 text-sm text-muted-foreground">Loading object schema...</p>
        ) : items.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No object kinds match this filter.</p>
        ) : (
          [...grouped.entries()].map(([group, groupItems]) => (
            <div key={group} className="py-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">{group}</div>
              <div className="space-y-2">
                {groupItems.map(kind => (
                  <div key={kind.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{kind.label}</span>
                        <Badge variant="outline">{kind.key}</Badge>
                        <Badge variant={kind.status === 'active' ? 'success' : kind.status === 'archived' ? 'muted' : 'secondary'}>
                          {kind.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">v{kind.version}</span>
                      </div>
                      {kind.description && <p className="mt-1 text-xs text-muted-foreground">{kind.description}</p>}
                      {Boolean(kind.relation_hints?.length) && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {kind.relation_hints?.map(hint => (
                            <Badge key={hint.id} variant="outline">
                              {hint.link_type} {hint.direction ?? 'from'} {hint.endpoint_object_type}
                              {hint.required ? ' required' : ''}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {editingHintsFor === kind.id && (
                        <div className="mt-2 space-y-2">
                          <Textarea
                            className="min-h-28 font-mono text-xs"
                            value={relationHintDraft}
                            onChange={e => setRelationHintDraft(e.target.value)}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={() => void proposeRelationHintUpdate(kind)} disabled={updatingHints || busyKind === kind.id}>
                              <Save className="size-3.5 mr-1.5" />Save hints
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setEditingHintsFor(null)} disabled={updatingHints}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                    {editingHintsFor !== kind.id && kind.status !== 'archived' && (
                      <Button variant="outline" size="sm" onClick={() => editRelationHints(kind)} disabled={busyKind === kind.id}>
                        <Pencil className="size-3.5 mr-1.5" />Hints
                      </Button>
                    )}
                    {kind.status === 'draft' && (
                      <Button variant="outline" size="sm" onClick={() => void proposeAction(kind, 'activate')} disabled={busyKind === kind.id}>
                        <CheckCircle2 className="size-3.5 mr-1.5" />Activate
                      </Button>
                    )}
                    {kind.status === 'active' && (
                      <Button variant="outline" size="sm" onClick={() => void proposeAction(kind, 'deprecate')} disabled={busyKind === kind.id}>
                        <Ban className="size-3.5 mr-1.5" />Deprecate
                      </Button>
                    )}
                    {kind.status !== 'archived' && (
                      <Button variant="outline" size="sm" onClick={() => void proposeAction(kind, 'archive')} disabled={busyKind === kind.id}>
                        <Archive className="size-3.5 mr-1.5" />Archive
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}
