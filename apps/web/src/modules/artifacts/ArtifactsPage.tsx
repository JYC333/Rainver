import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { BarChart3, FilePlus2, FileSearch, FolderKanban, Loader2, Package, SlidersHorizontal, X } from 'lucide-react'
import { toast } from 'sonner'
import { artifactsApi, knowledgeApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  Artifact,
  RetrievalCalibrationDecision,
  RetrievalCalibrationDecisionValue,
  RetrievalCalibrationMechanic,
  RetrievalObjectType,
  RetrievalSearchMode,
} from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { PreviewBadge } from '../../components/PreviewBadge'
import { ScopeBadge } from '../../components/ScopeBadge'
import { ProjectFolderSelectors } from '../../components/ProjectFolderSelectors'
import { TechnicalIdField } from '../../components/TechnicalIdField'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

export default function ArtifactsPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  const projectFilter = searchParams.get('project_id') ?? ''
  const artifactTypeFilter = searchParams.get('artifact_type') ?? ''
  const folderFilter = searchParams.get('project_folder_id') ?? ''

  const [items, setItems] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [fType, setFType] = useState(artifactTypeFilter)
  const [windowDays, setWindowDays] = useState('30')
  const [diagnosticLimit, setDiagnosticLimit] = useState('200')
  const [createDiagnosticsPacket, setCreateDiagnosticsPacket] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatedArtifactId, setGeneratedArtifactId] = useState<string | null>(null)
  const [generatedProposalId, setGeneratedProposalId] = useState<string | null>(null)
  const [explainQuery, setExplainQuery] = useState('')
  const [explainObjectType, setExplainObjectType] = useState<RetrievalObjectType>('knowledge_item')
  const [explainObjectId, setExplainObjectId] = useState('')
  const [explainMaxResults, setExplainMaxResults] = useState('10')
  const [explainMode, setExplainMode] = useState<RetrievalSearchMode>('exact')
  const [explaining, setExplaining] = useState(false)
  const [explainArtifactId, setExplainArtifactId] = useState<string | null>(null)
  const [calibrationLabel, setCalibrationLabel] = useState('')
  const [calibrationSuite, setCalibrationSuite] = useState('retrieval_quality_feedback_loop')
  const [calibrationMechanic, setCalibrationMechanic] = useState<RetrievalCalibrationMechanic>('visible_edge_backlink')
  const [calibrationDecision, setCalibrationDecision] = useState<RetrievalCalibrationDecisionValue>('defer')
  const [calibrationProof, setCalibrationProof] = useState('')
  const [calibrationEvalDelta, setCalibrationEvalDelta] = useState('')
  const [calibrationEvidenceIds, setCalibrationEvidenceIds] = useState('')
  const [calibrationRationale, setCalibrationRationale] = useState('')
  const [calibrationGuardrails, setCalibrationGuardrails] = useState('')
  const [calibrating, setCalibrating] = useState(false)
  const [calibrationArtifactId, setCalibrationArtifactId] = useState<string | null>(null)
  const [calibrationDrafts, setCalibrationDrafts] = useState<RetrievalCalibrationDecision[]>([])

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const p = await artifactsApi.list({
        limit: 100,
        artifact_type: fType.trim() || undefined,
        project_id: projectFilter || undefined,
        project_folder_id: folderFilter || undefined,
      })
      setItems(p.items)
    } catch (e) {
      toast.error(errMsg(e))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [fType, projectFilter, folderFilter, activeSpaceId])

  useEffect(() => { setFType(artifactTypeFilter) }, [artifactTypeFilter])
  useEffect(() => { load() }, [load])

  function setArtifactTypeFilter(value: string) {
    setFType(value)
    setSearchParams(params => {
      if (value) params.set('artifact_type', value)
      else params.delete('artifact_type')
      return params
    })
  }

  function artifactHref(id: string): string {
    return `/artifacts/${id}${folderFilter ? `?project_folder_id=${encodeURIComponent(folderFilter)}` : ''}`
  }

  const types = Array.from(new Set(items.map(a => a.artifact_type))).sort()
  const typeOptions = types

  async function dl(id: string) {
    try {
      await artifactsApi.export(id, { project_folder_id: folderFilter || undefined })
      toast.success('Download started')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function generateDiagnostics() {
    setGenerating(true)
    setGeneratedArtifactId(null)
    setGeneratedProposalId(null)
    try {
      const windowValue = Number(windowDays)
      const limitValue = Number(diagnosticLimit)
      const result = await knowledgeApi.diagnosticsReport({
        window_days: Number.isFinite(windowValue) && windowValue > 0 ? windowValue : 30,
        limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 200,
        create_packet: createDiagnosticsPacket,
      })
      setGeneratedArtifactId(result.artifact_id)
      setGeneratedProposalId(result.proposal_id ?? null)
      setFType('retrieval_eval_report')
      toast.success(result.proposal_id
        ? `Diagnostics packet created (${result.diagnostic_codes.join(', ') || 'no diagnostics'})`
        : `Diagnostics report created (${result.diagnostic_codes.join(', ') || 'no diagnostics'})`)
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setGenerating(false)
    }
  }

  async function generateExplainReport() {
    const query = explainQuery.trim()
    const objectId = explainObjectId.trim()
    if (!query || !objectId) return
    setExplaining(true)
    setExplainArtifactId(null)
    try {
      const maxValue = Number(explainMaxResults)
      const result = await knowledgeApi.explain({
        query,
        object_type: explainObjectType,
        object_id: objectId,
        object_types: [explainObjectType],
        mode: explainMode,
        max_results: Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 10,
        persist_artifact: true,
      })
      setExplainArtifactId(result.artifact_id ?? null)
      setFType('retrieval_explain_report')
      toast.success(result.target.returned ? 'Explain report created: target returned' : 'Explain report created: target missed')
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setExplaining(false)
    }
  }

  function currentCalibrationDecision(): RetrievalCalibrationDecision | null {
    const proof = calibrationProof.trim()
    if (!proof) {
      toast.error('Access-safety proof is required')
      return null
    }
    const evalDelta = parseMetricMap(calibrationEvalDelta)
    const evidenceArtifactIds = splitList(calibrationEvidenceIds)
    if (calibrationDecision === 'adopt' && evidenceArtifactIds.length === 0) {
      toast.error('Adopt decisions require evidence artifact ids')
      return null
    }
    if (calibrationDecision === 'adopt' && Object.keys(evalDelta).length === 0) {
      toast.error('Adopt decisions require eval delta')
      return null
    }
    return {
      mechanic: calibrationMechanic,
      decision: calibrationDecision,
      access_safety_proof: proof,
      eval_delta: evalDelta,
      evidence_artifact_ids: evidenceArtifactIds,
      rationale: calibrationRationale.trim() || undefined,
      guardrails: splitList(calibrationGuardrails),
    }
  }

  function addCalibrationDecision() {
    const decision = currentCalibrationDecision()
    if (!decision) return
    setCalibrationDrafts(current => [...current, decision].slice(0, 10))
    toast.success('Calibration decision added')
  }

  async function createCalibrationDecision() {
    const inline = calibrationDrafts.length === 0 ? currentCalibrationDecision() : null
    const decisions = calibrationDrafts.length > 0 ? calibrationDrafts : inline ? [inline] : []
    if (decisions.length === 0) return
    setCalibrating(true)
    setCalibrationArtifactId(null)
    try {
      const result = await knowledgeApi.calibrationDecision({
        report_label: calibrationLabel.trim() || undefined,
        suite: calibrationSuite.trim() || undefined,
        review_scope: 'private',
        decisions,
      })
      setCalibrationArtifactId(result.artifact_id)
      setCalibrationDrafts([])
      setFType('retrieval_calibration_decision')
      toast.success(`Calibration decision saved (${result.decision_count})`)
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCalibrating(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Package className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Artifacts</h1>
          <p className="text-sm text-muted-foreground">Browse and export space-scoped artifacts.</p>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
          {projectFilter && (
            <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-accent/40 text-xs text-accent-foreground">
              <FolderKanban className="size-3" />
              Filtered by project
              <button onClick={() => setSearchParams(p => { p.delete('project_id'); return p })} className="ml-0.5 hover:text-foreground" aria-label="Clear project filter">
                <X className="size-3" />
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="min-w-[180px]">
          <Label className="text-xs">artifact_type</Label>
          <Select
            value={fType}
            options={[
              { value: '', label: 'All (loaded page)' },
              ...typeOptions.map(t => ({ value: t, label: t })),
            ]}
            onChange={setArtifactTypeFilter}
          />
        </div>
        <div className="grid min-w-[360px] grid-cols-2 gap-2">
          <ProjectFolderSelectors
            projectId={projectFilter}
            folderId={folderFilter}
            onProjectChange={value => setSearchParams(params => {
              if (value) params.set('project_id', value)
              else params.delete('project_id')
              return params
            })}
            onFolderChange={value => setSearchParams(params => {
              if (value) params.set('project_folder_id', value)
              else params.delete('project_folder_id')
              return params
            })}
            projectLabel="Project"
            folderLabel="Project Folder"
          />
        </div>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md border border-border bg-muted/30 p-2">
              <BarChart3 className="size-4 text-accent-foreground" />
            </div>
            <div>
              <h2 className="text-sm font-medium">Retrieval diagnostics</h2>
              <p className="text-xs text-muted-foreground">
                Build an aggregate eval report from saved private Context Brief artifacts in this space.
              </p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-[110px_110px_auto]">
            <div className="space-y-1">
              <Label className="text-xs">window_days</Label>
              <input
                value={windowDays}
                onChange={event => setWindowDays(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">limit</Label>
              <input
                value={diagnosticLimit}
                onChange={event => setDiagnosticLimit(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-2 self-end">
              <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={createDiagnosticsPacket}
                  onChange={event => setCreateDiagnosticsPacket(event.target.checked)}
                  className="accent-primary"
                />
                create packet
              </label>
              <Button size="sm" onClick={generateDiagnostics} disabled={generating || !activeSpaceId}>
                {generating ? <Loader2 className="size-3.5 animate-spin" /> : <FilePlus2 className="size-3.5" />}
                Generate
              </Button>
            </div>
          </div>
        </div>
        {(generatedArtifactId || generatedProposalId) && (
          <div className="flex flex-wrap gap-3 text-xs">
            {generatedArtifactId && (
              <Link to={artifactHref(generatedArtifactId)} className="text-accent-foreground hover:underline">
                Open generated diagnostics report
              </Link>
            )}
            {generatedProposalId && (
              <Link to={`/proposals/${generatedProposalId}`} className="text-accent-foreground hover:underline">
                Open diagnostics packet
              </Link>
            )}
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md border border-border bg-muted/30 p-2">
              <FileSearch className="size-4 text-accent-foreground" />
            </div>
            <div>
              <h2 className="text-sm font-medium">Retrieval explain</h2>
              <p className="text-xs text-muted-foreground">
                Diagnose a visible Knowledge retrieval target and save an owner-private explain artifact.
              </p>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_140px_minmax(220px,1fr)_90px_120px_auto] xl:min-w-[840px]">
            <div className="space-y-1">
              <Label className="text-xs">query</Label>
              <input
                value={explainQuery}
                onChange={event => setExplainQuery(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">object_type</Label>
              <Select
                value={explainObjectType}
                options={[
                  { value: 'knowledge_item', label: 'knowledge_item' },
                  { value: 'note', label: 'note' },
                  { value: 'source', label: 'source' },
                  { value: 'claim', label: 'claim' },
                ]}
                onChange={value => setExplainObjectType(value as RetrievalObjectType)}
              />
            </div>
            <TechnicalIdField label="Object ID" value={explainObjectId} onChange={setExplainObjectId} />
            <div className="space-y-1">
              <Label className="text-xs">max</Label>
              <input
                value={explainMaxResults}
                onChange={event => setExplainMaxResults(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">mode</Label>
              <Select
                value={explainMode}
                options={[
                  { value: 'exact', label: 'exact' },
                  { value: 'lexical', label: 'lexical' },
                  { value: 'hybrid', label: 'hybrid' },
                  { value: 'hybrid_rerank', label: 'hybrid_rerank' },
                ]}
                onChange={value => setExplainMode(value as RetrievalSearchMode)}
              />
            </div>
            <Button
              size="sm"
              onClick={generateExplainReport}
              disabled={explaining || !activeSpaceId || !explainQuery.trim() || !explainObjectId.trim()}
              className="self-end"
            >
              {explaining ? <Loader2 className="size-3.5 animate-spin" /> : <FileSearch className="size-3.5" />}
              Explain
            </Button>
          </div>
        </div>
        {explainArtifactId && (
          <Link to={artifactHref(explainArtifactId)} className="text-xs text-accent-foreground hover:underline">
            Open generated explain report
          </Link>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md border border-border bg-muted/30 p-2">
              <SlidersHorizontal className="size-4 text-accent-foreground" />
            </div>
            <div>
              <h2 className="text-sm font-medium">Retrieval calibration</h2>
              <p className="text-xs text-muted-foreground">
                Record decisions before ranking changes ship. Adopt requires evidence artifact ids and eval delta; this does not change live ranking.
              </p>
            </div>
          </div>
          <div className="grid gap-2 lg:grid-cols-[150px_150px_180px_110px_minmax(220px,1fr)_minmax(180px,1fr)_auto] 2xl:min-w-[1080px]">
            <div className="space-y-1">
              <Label className="text-xs">label</Label>
              <input
                value={calibrationLabel}
                onChange={event => setCalibrationLabel(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">suite</Label>
              <input
                value={calibrationSuite}
                onChange={event => setCalibrationSuite(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">mechanic</Label>
              <Select
                value={calibrationMechanic}
                options={[
                  { value: 'visible_edge_backlink', label: 'visible_edge_backlink' },
                  { value: 'candidate_owned_salience', label: 'candidate_owned_salience' },
                  { value: 'richer_dedup', label: 'richer_dedup' },
                  { value: 'autocut', label: 'autocut' },
                  { value: 'semantic_results_cache', label: 'semantic_results_cache' },
                ]}
                onChange={value => setCalibrationMechanic(value as RetrievalCalibrationMechanic)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">decision</Label>
              <Select
                value={calibrationDecision}
                options={[
                  { value: 'defer', label: 'defer' },
                  { value: 'adopt', label: 'adopt' },
                  { value: 'reject', label: 'reject' },
                ]}
                onChange={value => setCalibrationDecision(value as RetrievalCalibrationDecisionValue)}
              />
            </div>
            <div className="space-y-1 self-end">
              <TechnicalIdField label="Evidence artifact identifiers" value={calibrationEvidenceIds} onChange={setCalibrationEvidenceIds} placeholder="comma-separated internal artifact ids" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">eval delta</Label>
              <input
                value={calibrationEvalDelta}
                onChange={event => setCalibrationEvalDelta(event.target.value)}
                placeholder="recall_10=0.03"
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
              />
            </div>
            <div className="flex gap-2 self-end">
              <Button
                size="sm"
                variant="outline"
                onClick={addCalibrationDecision}
                disabled={calibrating || !activeSpaceId || !calibrationProof.trim()}
              >
                <FilePlus2 className="size-3.5" />
                Add
              </Button>
              <Button
                size="sm"
                onClick={createCalibrationDecision}
                disabled={calibrating || !activeSpaceId || (!calibrationProof.trim() && calibrationDrafts.length === 0)}
              >
                {calibrating ? <Loader2 className="size-3.5 animate-spin" /> : <SlidersHorizontal className="size-3.5" />}
                Save {calibrationDrafts.length > 0 ? `(${calibrationDrafts.length})` : ''}
              </Button>
            </div>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">access_safety_proof</Label>
            <textarea
              value={calibrationProof}
              onChange={event => setCalibrationProof(event.target.value)}
              className="min-h-20 w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">guardrails</Label>
              <input
                value={calibrationGuardrails}
                onChange={event => setCalibrationGuardrails(event.target.value)}
                placeholder="comma-separated"
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">rationale</Label>
              <input
                value={calibrationRationale}
                onChange={event => setCalibrationRationale(event.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm"
              />
            </div>
          </div>
        </div>
        {calibrationArtifactId && (
          <Link to={artifactHref(calibrationArtifactId)} className="text-xs text-accent-foreground hover:underline">
            Open calibration decision
          </Link>
        )}
        {calibrationDrafts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {calibrationDrafts.map((draft, index) => (
              <Badge key={`${draft.mechanic}-${index}`} variant="secondary">
                {draft.mechanic}: {draft.decision}
              </Badge>
            ))}
            <Button variant="outline" size="sm" onClick={() => setCalibrationDrafts([])} disabled={calibrating}>
              <X className="size-3.5" />
              Clear
            </Button>
          </div>
        )}
      </Card>

      {loading ? (
        <Card className="p-6"><Skeleton className="h-24 w-full" /></Card>
      ) : items.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          {activeSpaceId ? 'No artifacts.' : 'Select an operational space to browse artifacts.'}
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map(a => (
            <Card key={a.id} className="p-4 flex flex-wrap justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">
                  <Link to={artifactHref(a.id)} className="text-accent-foreground hover:underline">
                    {a.title}
                  </Link>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1 items-center">
                  <Badge variant="secondary">{a.artifact_type}</Badge>
                  <ScopeBadge visibility={a.visibility} omitShared />
                  {a.project_folder_id && <Badge variant="outline">folder</Badge>}
                  {a.preview && <PreviewBadge />}
                  <span className="text-xs text-muted-foreground">{fmt(a.created_at)}</span>
                </div>
                {a.run_id && (
                  <Link to={`/runs/${a.run_id}`} className="text-xs text-accent-foreground hover:underline mt-2 inline-block">
                    Run {a.run_id.slice(0, 10)}…
                  </Link>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => dl(a.id)}>Export</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseMetricMap(value: string): Record<string, number> {
  const trimmed = value.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    return numericRecord(parsed)
  }
  const out: Record<string, number> = {}
  for (const part of splitList(trimmed)) {
    const [rawKey, rawValue] = part.split('=')
    const key = rawKey?.trim()
    const number = Number(rawValue?.trim())
    if (!key || !Number.isFinite(number)) {
      throw new Error('eval delta must be JSON or comma-separated key=value pairs')
    }
    out[key] = number
  }
  return out
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const number = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(number)) throw new Error('eval delta JSON values must be numbers')
    out[key] = number
  }
  return out
}
