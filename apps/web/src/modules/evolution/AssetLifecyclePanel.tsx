import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ExternalLink, Loader2, Pencil, Play, Plus, Send, TestTube2 } from 'lucide-react'
import { toast } from 'sonner'
import { evolutionApi, runsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useSpaceNavigate as useNavigate } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type {
  EvolvableAsset,
  EvolvableAssetEvaluationCase,
  EvolvableAssetEvaluationRun,
  EvolvableAssetVersion,
  Run,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { EvolutionStatusBadge } from './EvolutionStatusBadge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { ProjectSelector } from '../../components/ProjectFolderSelectors'
import i18n, { useAppTranslation } from '../../i18n'

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Report a stable form error below.
  }
  throw new Error(i18n.t('evolution.lifecycle.json_object_required', { label }))
}

function parseAny(value: string, label: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error(i18n.t('evolution.lifecycle.json_invalid', { label })) }
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-xs">{jsonText(value)}</pre>
}

function VersionDialog({
  open,
  asset,
  versions,
  editing,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  asset: EvolvableAsset
  versions: EvolvableAssetVersion[]
  editing: EvolvableAssetVersion | null
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [parentId, setParentId] = useState('')
  const [content, setContent] = useState('{}')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setParentId(editing?.parent_version_id ?? '')
    setContent(jsonText(editing?.content_json ?? {}))
  }, [editing, open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const contentJson = parseObject(content, t('evolution.lifecycle.field_content'))
      if (editing) {
        await evolutionApi.updateAssetVersion(asset.id, editing.id, { content_json: contentJson })
        toast.success(t('evolution.lifecycle.draft_updated'))
      } else {
        await evolutionApi.createAssetVersion(asset.id, {
          parent_version_id: parentId || null,
          source: 'user_authored',
          content_json: contentJson,
        })
        toast.success(t('evolution.lifecycle.draft_created'))
      }
      onOpenChange(false)
      await onSaved()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? t('evolution.lifecycle.edit_draft_title', { version: editing.version }) : t('evolution.lifecycle.create_candidate_title', { type: asset.asset_type })}</DialogTitle>
          <DialogDescription>{t('evolution.lifecycle.draft_only_hint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {!editing && <div className="space-y-1.5"><Label>{t('evolution.lifecycle.parent_version')}</Label><Select value={parentId} onChange={setParentId} options={[{ value: '', label: t('evolution.lifecycle.no_parent') }, ...versions.map(version => ({ value: version.id, label: `v${version.version} · ${version.status}` }))]} /></div>}
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.content_json')}</Label><Textarea className="min-h-64 font-mono text-xs" value={content} onChange={event => setContent(event.target.value)} /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('evolution.cancel')}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />}{editing ? t('evolution.lifecycle.save_draft') : t('evolution.lifecycle.create_draft')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CaseDialog({
  open,
  asset,
  approvedVersions,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  asset: EvolvableAsset
  approvedVersions: EvolvableAssetVersion[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [fromRun, setFromRun] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [baselineVersionId, setBaselineVersionId] = useState('')
  const [sourceRunId, setSourceRunId] = useState('')
  const [sourceRuns, setSourceRuns] = useState<Run[]>([])
  const [inputJson, setInputJson] = useState('{}')
  const [expectationJson, setExpectationJson] = useState('{}')
  const [recipeJson, setRecipeJson] = useState('{\n  "checks": [{ "type": "output_schema", "schema": { "type": "object" } }]\n}')
  const [baselineOutputJson, setBaselineOutputJson] = useState('{}')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setFromRun(false)
    setName('')
    setDescription('')
    setBaselineVersionId(approvedVersions[0]?.id ?? '')
    setSourceRunId('')
    setInputJson('{}')
    setExpectationJson('{}')
    setRecipeJson('{\n  "checks": [{ "type": "output_schema", "schema": { "type": "object" } }]\n}')
    setBaselineOutputJson('{}')
  }, [approvedVersions, open])

  useEffect(() => {
    if (!open || !fromRun) return
    runsApi.list({ status: 'succeeded', limit: 100 })
      .then(setSourceRuns)
      .catch(error => {
        setSourceRuns([])
        toast.error(errMsg(error))
      })
  }, [fromRun, open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      if (!name.trim() || !baselineVersionId) throw new Error(t('evolution.lifecycle.case_required'))
      const common = {
        name: name.trim(),
        description: description.trim() || undefined,
        baseline_version_id: baselineVersionId,
        input_json: parseObject(inputJson, t('evolution.lifecycle.field_input')),
        expectation_json: parseObject(expectationJson, t('evolution.lifecycle.field_expectation')),
        verification_recipe_json: parseObject(recipeJson, t('evolution.lifecycle.field_recipe')),
      }
      if (fromRun) {
        if (!sourceRunId.trim()) throw new Error(t('evolution.lifecycle.select_source_run'))
        await evolutionApi.createEvaluationCaseFromRun(asset.id, { ...common, source_run_id: sourceRunId.trim() })
      } else {
        await evolutionApi.createEvaluationCase(asset.id, { ...common, baseline_output_json: parseAny(baselineOutputJson, t('evolution.lifecycle.field_baseline_output')) })
      }
      toast.success(t('evolution.lifecycle.case_created'))
      onOpenChange(false)
      await onSaved()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader><DialogTitle>{t('evolution.lifecycle.create_case')}</DialogTitle><DialogDescription>{t('evolution.lifecycle.case_hint')}</DialogDescription></DialogHeader>
        <form className="max-h-[70vh] space-y-4 overflow-y-auto pr-1" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-2"><div className="space-y-1.5"><Label>{t('evolution.name')}</Label><Input value={name} onChange={event => setName(event.target.value)} /></div><div className="space-y-1.5"><Label>{t('evolution.lifecycle.approved_baseline')}</Label><Select value={baselineVersionId} onChange={setBaselineVersionId} options={[{ value: '', label: t('evolution.lifecycle.select_baseline') }, ...approvedVersions.map(version => ({ value: version.id, label: `v${version.version}` }))]} /></div></div>
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.description')}</Label><Textarea value={description} onChange={event => setDescription(event.target.value)} /></div>
          <div className="flex items-center gap-2"><input id="case-from-run" type="checkbox" checked={fromRun} onChange={event => setFromRun(event.target.checked)} /><Label htmlFor="case-from-run">{t('evolution.lifecycle.use_source_run')}</Label></div>
          {fromRun ? <div className="space-y-1.5"><Label>{t('evolution.lifecycle.passed_source_run')}</Label><Select value={sourceRunId} onChange={setSourceRunId} options={[{ value: '', label: t('evolution.lifecycle.select_succeeded_run') }, ...sourceRuns.map(run => ({ value: run.id, label: run.instruction ?? run.prompt ?? t('evolution.lifecycle.succeeded_run', { type: run.run_type }) }))]} /></div> : <div className="space-y-1.5"><Label>{t('evolution.lifecycle.baseline_output_json')}</Label><Textarea className="min-h-28 font-mono text-xs" value={baselineOutputJson} onChange={event => setBaselineOutputJson(event.target.value)} /></div>}
          <div className="grid gap-3 lg:grid-cols-3"><div className="space-y-1.5"><Label>{t('evolution.lifecycle.input_json')}</Label><Textarea className="min-h-32 font-mono text-xs" value={inputJson} onChange={event => setInputJson(event.target.value)} /></div><div className="space-y-1.5"><Label>{t('evolution.lifecycle.expectation_json')}</Label><Textarea className="min-h-32 font-mono text-xs" value={expectationJson} onChange={event => setExpectationJson(event.target.value)} /></div><div className="space-y-1.5"><Label>{t('evolution.lifecycle.recipe_json')}</Label><Textarea className="min-h-32 font-mono text-xs" value={recipeJson} onChange={event => setRecipeJson(event.target.value)} /></div></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('evolution.cancel')}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} {t('evolution.lifecycle.create_case_button')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EvaluationDialog({
  open,
  asset,
  versions,
  cases,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  asset: EvolvableAsset
  versions: EvolvableAssetVersion[]
  cases: EvolvableAssetEvaluationCase[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [versionId, setVersionId] = useState('')
  const [caseId, setCaseId] = useState('')
  const [candidateRunId, setCandidateRunId] = useState('')
  const [candidateRuns, setCandidateRuns] = useState<Run[]>([])
  const [busy, setBusy] = useState(false)

  const candidateVersions = useMemo(() => versions.filter(version => version.status === 'candidate' || version.status === 'testing'), [versions])

  useEffect(() => {
    if (!open) return
    setVersionId(candidateVersions[0]?.id ?? '')
    setCaseId(cases[0]?.id ?? '')
    setCandidateRunId('')
    setCandidateRuns([])
  }, [candidateVersions, cases, open])

  useEffect(() => {
    if (!open || !versionId) return
    let active = true
    void runsApi.list({ workflow_version_id: versionId, limit: 200 })
      .then(runs => { if (active) setCandidateRuns(runs.filter(run => run.status === 'succeeded' || run.status === 'degraded')) })
      .catch(error => { if (active) toast.error(errMsg(error)) })
    return () => { active = false }
  }, [open, versionId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!versionId || !caseId || !candidateRunId) {
      toast.error(t('evolution.lifecycle.evaluation_required'))
      return
    }
    setBusy(true)
    try {
      await evolutionApi.executeEvaluation(asset.id, versionId, caseId, { candidate_run_id: candidateRunId })
      toast.success(t('evolution.lifecycle.evaluation_queued'))
      onOpenChange(false)
      await onSaved()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('evolution.lifecycle.run_evaluation')}</DialogTitle><DialogDescription>{t('evolution.lifecycle.run_evaluation_hint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.candidate_version')}</Label><Select value={versionId} onChange={value => { setVersionId(value); setCandidateRunId('') }} options={[{ value: '', label: t('evolution.lifecycle.select_candidate') }, ...candidateVersions.map(version => ({ value: version.id, label: `v${version.version} · ${version.status}` }))]} /></div>
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.evaluation_case')}</Label><Select value={caseId} onChange={setCaseId} options={[{ value: '', label: t('evolution.lifecycle.select_case') }, ...cases.map(item => ({ value: item.id, label: item.name }))]} /></div>
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.candidate_run')}</Label><Select value={candidateRunId} onChange={setCandidateRunId} options={[{ value: '', label: candidateRuns.length ? t('evolution.lifecycle.select_successful_run') : t('evolution.lifecycle.no_successful_runs') }, ...candidateRuns.map(run => ({ value: run.id, label: `${run.id.slice(0, 8)} · ${run.status}` }))]} disabled={!versionId || candidateRuns.length === 0} /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('evolution.cancel')}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} {t('evolution.lifecycle.queue_evaluation')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PromotionDialog({
  open,
  asset,
  versions,
  evaluations,
  initialVersionId,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  asset: EvolvableAsset
  versions: EvolvableAssetVersion[]
  evaluations: EvolvableAssetEvaluationRun[]
  /** The version whose own Promote button opened the dialog, if one did. */
  initialVersionId: string | null
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const navigate = useNavigate()
  const [versionId, setVersionId] = useState('')
  const [scopeType, setScopeType] = useState<'project' | 'space'>('space')
  const [scopeId, setScopeId] = useState('')
  const [selectedEvaluationIds, setSelectedEvaluationIds] = useState<string[]>([])
  const [pin, setPin] = useState(false)
  const [deprecate, setDeprecate] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const promotableVersions = useMemo(() => versions.filter(version => version.status === 'candidate' || version.status === 'testing'), [versions])
  const versionEvaluations = evaluations.filter(run => run.candidate_version_id === versionId)

  useEffect(() => {
    if (!open) return
    setVersionId(promotableVersions.find(version => version.id === initialVersionId)?.id ?? promotableVersions[0]?.id ?? '')
    setScopeType('space')
    setScopeId(activeSpaceId ?? '')
    setSelectedEvaluationIds([])
    setPin(false)
    setDeprecate(false)
    setReason('')
  }, [activeSpaceId, initialVersionId, open, promotableVersions])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!versionId) { toast.error(t('evolution.lifecycle.choose_promotable')); return }
    if (!scopeId.trim()) { toast.error(scopeType === 'project' ? t('evolution.lifecycle.choose_target_project') : t('evolution.lifecycle.choose_target_space')); return }
    setBusy(true)
    try {
      const result = await evolutionApi.createAssetPromotionProposal(asset.id, versionId, {
        target_scope_type: scopeType,
        target_scope_id: scopeId.trim(),
        pin_after_approval: pin,
        deprecate_previous: deprecate,
        evaluation_run_ids: selectedEvaluationIds,
        reason: reason.trim() || undefined,
      })
      toast.success(t('evolution.lifecycle.promotion_created', { id: result.proposal_id.slice(0, 8) }))
      onOpenChange(false)
      onCreated()
      navigate('/evolution/inbox')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('evolution.lifecycle.create_promotion')}</DialogTitle><DialogDescription>{t('evolution.lifecycle.promotion_hint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.candidate_version')}</Label><Select value={versionId} onChange={value => { setVersionId(value); setSelectedEvaluationIds([]) }} options={[{ value: '', label: t('evolution.lifecycle.select_version') }, ...promotableVersions.map(version => ({ value: version.id, label: `v${version.version} · ${version.status}` }))]} /></div>
          <div className="grid gap-3 md:grid-cols-2"><div className="space-y-1.5"><Label>{t('evolution.lifecycle.target_scope')}</Label><Select value={scopeType} onChange={value => { const next = value as 'project' | 'space'; setScopeType(next); setScopeId(next === 'space' ? activeSpaceId ?? '' : '') }} options={[{ value: 'space', label: t('evolution.lifecycle.current_space') }, { value: 'project', label: t('evolution.lifecycle.project') }]} /></div>{scopeType === 'project' ? <ProjectSelector value={scopeId} onChange={setScopeId} label={t('evolution.lifecycle.target_project')} optional={false} /> : <div className="space-y-1.5"><Label>{t('evolution.lifecycle.target')}</Label><Input value={t('evolution.lifecycle.current_space')} disabled /></div>}</div>
          <p className="text-xs text-muted-foreground">{t('evolution.lifecycle.scope_hint')}</p>
          <div className="space-y-2"><Label>{t('evolution.inbox_page.evaluation_evidence')}</Label>{versionEvaluations.length === 0 ? <p className="text-xs text-muted-foreground">{t('evolution.lifecycle.no_version_evaluations')}</p> : versionEvaluations.map(run => <label key={run.id} className="flex items-start gap-2 rounded border border-border p-2 text-sm"><input type="checkbox" checked={selectedEvaluationIds.includes(run.id)} onChange={event => setSelectedEvaluationIds(current => event.target.checked ? [...current, run.id] : current.filter(id => id !== run.id))} /><span><EvolutionStatusBadge status={run.status} /><span className="ml-2 font-mono text-xs">{run.id.slice(0, 12)}</span><span className="mt-1 block text-xs text-muted-foreground">{JSON.stringify(run.metrics)}</span></span></label>)}</div>
          <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={pin} onChange={event => setPin(event.target.checked)} /> {t('evolution.lifecycle.pin_after_approval')}</label><label className="flex items-center gap-2"><input type="checkbox" checked={deprecate} onChange={event => setDeprecate(event.target.checked)} /> {t('evolution.lifecycle.deprecate_previous')}</label></div>
          <div className="space-y-1.5"><Label>{t('evolution.lifecycle.reason')}</Label><Textarea value={reason} onChange={event => setReason(event.target.value)} /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('evolution.cancel')}</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} {t('evolution.lifecycle.create_proposal')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function AssetLifecyclePanel({
  asset,
  versions,
  evaluations,
  onReload,
}: {
  asset: EvolvableAsset
  versions: EvolvableAssetVersion[]
  evaluations: EvolvableAssetEvaluationRun[]
  onReload: () => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [cases, setCases] = useState<EvolvableAssetEvaluationCase[]>([])
  const [casesLoading, setCasesLoading] = useState(false)
  const [versionDialogOpen, setVersionDialogOpen] = useState(false)
  const [editingVersion, setEditingVersion] = useState<EvolvableAssetVersion | null>(null)
  const [caseDialogOpen, setCaseDialogOpen] = useState(false)
  const [evaluationDialogOpen, setEvaluationDialogOpen] = useState(false)
  const [promotionDialogOpen, setPromotionDialogOpen] = useState(false)
  const [promotionVersionId, setPromotionVersionId] = useState<string | null>(null)
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null)

  const approvedVersions = useMemo(() => versions.filter(version => version.status === 'approved'), [versions])
  const loadCases = useCallback(async () => {
    setCasesLoading(true)
    try { setCases(await evolutionApi.evaluationCases(asset.id)) } catch (error) { toast.error(errMsg(error)); setCases([]) } finally { setCasesLoading(false) }
  }, [asset.id])

  useEffect(() => { void loadCases() }, [loadCases])

  async function transition(version: EvolvableAssetVersion, status: string) {
    setBusyVersionId(version.id)
    try { await evolutionApi.transitionAssetVersion(asset.id, version.id, { status }); toast.success(t('evolution.lifecycle.version_moved', { status })); await onReload() } catch (error) { toast.error(errMsg(error)) } finally { setBusyVersionId(null) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { setEditingVersion(null); setVersionDialogOpen(true) }}><Plus className="size-3.5" /> {t('evolution.lifecycle.create_candidate_version')}</Button><Button size="sm" variant="outline" onClick={() => setCaseDialogOpen(true)} disabled={approvedVersions.length === 0}><TestTube2 className="size-3.5" /> {t('evolution.lifecycle.create_case')}</Button><Button size="sm" variant="outline" onClick={() => setEvaluationDialogOpen(true)} disabled={cases.length === 0}><Play className="size-3.5" /> {t('evolution.lifecycle.run_evaluation')}</Button><Button size="sm" variant="outline" onClick={() => { setPromotionVersionId(null); setPromotionDialogOpen(true) }} disabled={versions.every(version => version.status !== 'candidate' && version.status !== 'testing')}><Send className="size-3.5" /> {t('evolution.lifecycle.promotion_proposal')}</Button></div>
      <p className="text-xs text-muted-foreground">{t('evolution.lifecycle.panel_hint')}</p>
      <Card className="mb-0 p-4"><CardTitle className="mb-3">{t('evolution.lifecycle.version_lifecycle')}</CardTitle>{versions.length === 0 ? <EmptyState title={t('evolution.lifecycle.no_versions')} description={t('evolution.lifecycle.no_versions_hint')} /> : <div className="space-y-2">{versions.map(version => <div key={version.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-1.5"><Badge variant="secondary">v{version.version}</Badge><EvolutionStatusBadge status={version.status} />{version.stale_parent && <Badge variant="warning">{t('evolution.lifecycle.stale_parent')}</Badge>}</div><div className="flex flex-wrap gap-1.5">{version.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => { setEditingVersion(version); setVersionDialogOpen(true) }}><Pencil className="size-3.5" /> {t('evolution.edit')}</Button>}{version.status === 'draft' && <Button size="sm" variant="outline" onClick={() => void transition(version, 'candidate')} disabled={busyVersionId === version.id}>{t('evolution.lifecycle.move_candidate')}</Button>}{version.status === 'candidate' && <Button size="sm" variant="outline" onClick={() => void transition(version, 'testing')} disabled={busyVersionId === version.id}>{t('evolution.lifecycle.move_testing')}</Button>}{(version.status === 'candidate' || version.status === 'testing') && <Button size="sm" variant="ghost" onClick={() => { setPromotionVersionId(version.id); setPromotionDialogOpen(true) }}>{t('evolution.lifecycle.promote')}</Button>}</div></div><div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><span>{t('evolution.lifecycle.meta_source', { value: version.source })}</span><span>{t('evolution.lifecycle.meta_parent', { value: version.parent_version_id?.slice(-8) ?? '-' })}</span><span>{t('evolution.lifecycle.meta_scope', { value: `${version.scope_type}${version.scope_id ? `:${version.scope_id.slice(-8)}` : ''}` })}</span><span>{t('evolution.lifecycle.meta_content', { value: version.content_ref ?? t('evolution.lifecycle.inline_json') })}</span></div></div>)}</div>}</Card>
      <Card className="mb-0 p-4"><div className="flex items-center justify-between gap-2"><CardTitle className="mb-0">{t('evolution.lifecycle.evaluation_cases')}</CardTitle><span className="text-xs text-muted-foreground">{casesLoading ? t('evolution.lifecycle.loading') : t('evolution.lifecycle.case_count', { count: cases.length })}</span></div>{cases.length === 0 ? <EmptyState className="mt-3" title={t('evolution.lifecycle.no_cases')} description={t('evolution.lifecycle.no_cases_hint')} /> : <div className="mt-3 space-y-2">{cases.map(item => <div key={item.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{item.name}</p><p className="text-xs text-muted-foreground">{t('evolution.lifecycle.case_baseline', { id: item.baseline_version_id.slice(-8) })}{item.source_run_id ? ` · ${t('evolution.lifecycle.case_source_run', { id: item.source_run_id.slice(-8) })}` : ''}</p></div><EvolutionStatusBadge status={item.status} /></div><div className="mt-2 grid gap-2 md:grid-cols-3"><div><Label className="text-xs">{t('evolution.lifecycle.field_input')}</Label><JsonBlock value={item.input_json} /></div><div><Label className="text-xs">{t('evolution.lifecycle.field_expectation')}</Label><JsonBlock value={item.expectation_json} /></div><div><Label className="text-xs">{t('evolution.lifecycle.field_baseline_output')}</Label><JsonBlock value={item.baseline_output_json} /></div></div></div>)}</div>}</Card>
      <Card className="mb-0 p-4"><div className="flex items-center justify-between gap-2"><CardTitle className="mb-0">{t('evolution.lifecycle.evaluation_runs_title')}</CardTitle><Button size="sm" variant="ghost" onClick={() => void onReload()}><ExternalLink className="size-3.5" /> {t('evolution.lifecycle.refresh_evidence')}</Button></div>{evaluations.length === 0 ? <EmptyState className="mt-3" title={t('evolution.no_evaluation_runs')} description={t('evolution.lifecycle.no_runs_hint')} /> : <div className="mt-3 space-y-2">{evaluations.map(run => <div key={run.id} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center gap-1.5"><EvolutionStatusBadge status={run.status} /><Badge variant="outline">{run.evaluator_version}</Badge><span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 12)}</span></div><div className="mt-2 grid gap-2 md:grid-cols-2"><JsonBlock value={run.metrics} /><JsonBlock value={run.blockers} /></div></div>)}</div>}</Card>
      <VersionDialog open={versionDialogOpen} asset={asset} versions={versions} editing={editingVersion} onOpenChange={setVersionDialogOpen} onSaved={onReload} />
      <CaseDialog open={caseDialogOpen} asset={asset} approvedVersions={approvedVersions} onOpenChange={setCaseDialogOpen} onSaved={loadCases} />
      <EvaluationDialog open={evaluationDialogOpen} asset={asset} versions={versions} cases={cases} onOpenChange={setEvaluationDialogOpen} onSaved={onReload} />
      <PromotionDialog open={promotionDialogOpen} asset={asset} versions={versions} evaluations={evaluations} initialVersionId={promotionVersionId} onOpenChange={setPromotionDialogOpen} onCreated={() => { void onReload() }} />
    </div>
  )
}
