import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Database,
  FileSearch,
  FileText,
  GitCompare,
  Loader2,
  PackageCheck,
  Play,
  Save,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { contextOpsApi, knowledgeApi, objectSchemaApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  ContextOpsCountMap,
  ContextOpsDrilldown,
  ContextOpsDrilldownSection,
  ContextOpsSummary,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { TechnicalIdField } from '../../components/TechnicalIdField'

const WINDOWS = [7, 14, 30, 60, 90]

function fmt(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function countEntries(counts: ContextOpsCountMap): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function total(counts: ContextOpsCountMap): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0)
}

function MiniMetric({ label, value, tone = 'default' }: { label: string; value: number | string; tone?: 'default' | 'warn' | 'ok' }) {
  const toneClass = tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : tone === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-foreground'
  return (
    <div className="min-w-[8rem] rounded-md border border-border bg-background p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}

function CountList({ counts, empty = 'None' }: { counts: ContextOpsCountMap; empty?: string }) {
  const rows = countEntries(counts).slice(0, 6)
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map(([key, count]) => (
        <Badge key={key} variant="secondary">{key}: {count}</Badge>
      ))}
    </div>
  )
}

function Panel({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <CardTitle className="text-sm">{title}</CardTitle>
      </div>
      {children}
    </Card>
  )
}

function fmtRelative(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleDateString() : '—'
}

const ARTIFACT_SECTIONS: ContextOpsDrilldownSection[] = ['maintenance_reports', 'diagnostics_reports', 'explain_reports', 'recent_briefs']

interface ExplainPreset {
  label: string
  query: string
  objectType: 'knowledge_item' | 'note' | 'source' | 'claim'
  mode: 'exact' | 'lexical' | 'hybrid' | 'hybrid_rerank'
  maxResults: number
}

function isExplainPreset(value: unknown): value is ExplainPreset {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ExplainPreset>
  return typeof item.label === 'string'
    && typeof item.query === 'string'
    && ['knowledge_item', 'note', 'source', 'claim'].includes(String(item.objectType))
    && ['exact', 'lexical', 'hybrid', 'hybrid_rerank'].includes(String(item.mode))
    && typeof item.maxResults === 'number'
}

/**
 * Lazy, on-demand drill-down for one aggregate section. Fetches only when
 * expanded so the summary page stays cheap, and renders the bounded, already
 * access-revalidated detail the backend returns (no retrieval internals are
 * reconstructed client-side). Artifact sections additionally expose guided
 * follow-up (open the report / proposal, or build a Claim Candidate Packet).
 */
function Drilldown({
  section,
  label,
  onPacket,
  packetBusy,
}: {
  section: ContextOpsDrilldownSection
  label: string
  onPacket?: (artifactIds: string | string[], reviewScope?: 'private' | 'space_ops', promotePrivate?: boolean) => void
  packetBusy?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<ContextOpsDrilldown | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([])

  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && !data) {
      setLoading(true)
      try {
        setData(await contextOpsApi.drilldown(section, { limit: 25 }))
      } catch (error) {
        toast.error(errMsg(error))
        setOpen(false)
      } finally {
        setLoading(false)
      }
    }
  }, [open, data, section])

  const isArtifactSection = ARTIFACT_SECTIONS.includes(section)
  const toggleArtifact = (artifactId: string) => {
    setSelectedArtifactIds(current =>
      current.includes(artifactId) ? current.filter(id => id !== artifactId) : [...current, artifactId])
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {label}
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {loading ? (
            <Skeleton className="h-16" />
          ) : !data ? null : isArtifactSection ? (
            data.artifacts.length === 0 && data.packets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No reports in the lookback window.</p>
            ) : (
              <>
                {onPacket && data.artifacts.length > 1 && (
                  <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                    <span className="text-muted-foreground">{selectedArtifactIds.length} selected</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={selectedArtifactIds.length === 0 || packetBusy != null}
                      onClick={() => onPacket(selectedArtifactIds)}
                    >
                      <PackageCheck className="size-3.5" />
                      Batch packet
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={selectedArtifactIds.length === 0 || packetBusy != null}
                      onClick={() => onPacket(selectedArtifactIds, 'space_ops', true)}
                    >
                      <ShieldCheck className="size-3.5" />
                      Batch space
                    </Button>
                  </div>
                )}
                {data.packets.map(packet => (
                  <div key={packet.proposal_id} className="rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/proposals/${packet.proposal_id}`} className="min-w-0 flex-1 truncate hover:text-foreground">{packet.title}</Link>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge variant="secondary">{packet.status}</Badge>
                        {onPacket && packet.report_artifact_id && (
                          <Button variant="outline" size="sm" onClick={() => onPacket(packet.report_artifact_id!)} disabled={packetBusy != null}>
                            {packetBusy === `private:${packet.report_artifact_id}` ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
                            Packet
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {data.artifacts.map(artifact => (
                  <div key={artifact.artifact_id} className="rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      {onPacket && (
                        <input
                          type="checkbox"
                          checked={selectedArtifactIds.includes(artifact.artifact_id)}
                          onChange={() => toggleArtifact(artifact.artifact_id)}
                          className="size-3.5 shrink-0 accent-primary"
                          aria-label={`Select ${artifact.title}`}
                        />
                      )}
                      <Link to={`/artifacts/${artifact.artifact_id}`} className="min-w-0 flex-1 hover:text-foreground">
                        <div className="truncate">{artifact.title}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {artifact.surface ?? artifact.artifact_type}
                          {artifact.finding_count != null ? ` · ${artifact.finding_count} finding(s)` : ''} · {fmtRelative(artifact.created_at)}
                        </div>
                      </Link>
                      {onPacket && (
                        <Button variant="outline" size="sm" onClick={() => onPacket(artifact.artifact_id)} disabled={packetBusy != null}>
                          {packetBusy === `private:${artifact.artifact_id}` ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
                          Packet
                        </Button>
                      )}
                    </div>
                    {artifact.diagnostic_codes.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {artifact.diagnostic_codes.slice(0, 6).map(code => (
                          <Badge key={code} variant="secondary" className="text-[10px]">{code}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )
          ) : section === 'source_warnings' ? (
            data.sources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No source connections with warnings.</p>
            ) : (
              data.sources.map(source => (
                <div key={source.source_connection_id} className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{source.name}</span>
                    <Badge variant="outline">{source.status}</Badge>
                  </div>
                  {source.warnings.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {source.warnings.map(w => (
                        <Badge key={w} variant="secondary" className="text-[10px]">{w}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )
          ) : data.objects.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing readable in this category.</p>
          ) : (
            data.objects.map(obj => (
              <div key={`${obj.object_type}:${obj.object_id}`} className="rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{obj.title}</span>
                  <Badge variant="outline">{obj.object_type}</Badge>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {section === 'embedding_backlog'
                    ? `${obj.missing_chunk_count ?? 0} chunk(s) pending`
                    : `indexed ${fmtRelative(obj.indexed_at)} · source ${fmtRelative(obj.source_updated_at)}`}
                </div>
              </div>
            ))
          )}
          {data?.truncated && <p className="text-[11px] text-muted-foreground">More not shown (showing top {data.limit}).</p>}
        </div>
      )}
    </div>
  )
}

export default function ContextOpsPage() {
  const { activeSpaceId, activeSpaceName, spaces } = useSpace()
  const activeSpace = spaces.find(space => space.id === activeSpaceId)
  const waitingForSpace = Boolean(activeSpaceId && !activeSpace && spaces.length === 0)
  const [windowDays, setWindowDays] = useState(14)
  const [summary, setSummary] = useState<ContextOpsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [scanBusy, setScanBusy] = useState<null | 'maintenance' | 'diagnostics' | 'review' | 'contradictions' | 'discovery' | 'shape'>(null)
  const [includeMemoryMaintenance, setIncludeMemoryMaintenance] = useState(true)
  const [packetBusy, setPacketBusy] = useState<string | null>(null)
  // Review Loops (Slice E/F) options.
  const [loopReviewScope, setLoopReviewScope] = useState<'private' | 'space_ops'>('private')
  const [discoveryIncludeNotes, setDiscoveryIncludeNotes] = useState(false)
  const [discoveryIncludeUnresolved, setDiscoveryIncludeUnresolved] = useState(false)
  const [explainPresets, setExplainPresets] = useState<ExplainPreset[]>([])
  const [explainPresetLabel, setExplainPresetLabel] = useState('default')
  const [explainQuery, setExplainQuery] = useState('')
  const [explainObjectType, setExplainObjectType] = useState<ExplainPreset['objectType']>('knowledge_item')
  const [explainMode, setExplainMode] = useState<ExplainPreset['mode']>('exact')
  const [explainMaxResults, setExplainMaxResults] = useState('10')
  const [explainTargetA, setExplainTargetA] = useState('')
  const [explainTargetB, setExplainTargetB] = useState('')
  const [explainBusy, setExplainBusy] = useState(false)
  const [explainArtifactIds, setExplainArtifactIds] = useState<string[]>([])

  useEffect(() => {
    const key = `context_ops.explain_presets.${activeSpaceId ?? 'default'}`
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (Array.isArray(parsed)) setExplainPresets(parsed.filter(isExplainPreset).slice(0, 12))
    } catch {
      setExplainPresets([])
    }
  }, [activeSpaceId])

  const load = useCallback(async () => {
    if (!activeSpaceId || waitingForSpace) {
      setSummary(null)
      setLoading(false)
      setPermissionDenied(false)
      return
    }
    setLoading(true)
    setPermissionDenied(false)
    try {
      setSummary(await contextOpsApi.summary({ window_days: windowDays, limit: 10 }))
    } catch (error) {
      const message = errMsg(error)
      if (message.includes('403') || message.toLowerCase().includes('permission') || message.toLowerCase().includes('admin')) {
        setPermissionDenied(true)
      } else {
        toast.error(message)
      }
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, waitingForSpace, windowDays])

  useEffect(() => { load() }, [load])

  const runMaintenanceScan = useCallback(async () => {
    setScanBusy('maintenance')
    try {
      const result = await knowledgeApi.maintenanceScan({ persist_report: true, create_packet: true })
      toast.success(
        result.proposal_id
          ? 'Maintenance scan complete — review packet created.'
          : 'Maintenance scan complete.',
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanBusy(null)
    }
  }, [load])

  const runDiagnostics = useCallback(async () => {
    setScanBusy('diagnostics')
    try {
      const result = await knowledgeApi.diagnosticsReport({
        window_days: windowDays,
        create_packet: true,
        compare_previous_window: true,
      })
      toast.success(
        result.proposal_id
          ? 'Diagnostics report generated — review packet created.'
          : 'Diagnostics report generated.',
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanBusy(null)
    }
  }, [load, windowDays])

  const runContextReviewCycle = useCallback(async () => {
    setScanBusy('review')
    try {
      const result = await contextOpsApi.reviewCycleRun({
        window_days: windowDays,
        create_packets: true,
        include_memory_maintenance: includeMemoryMaintenance,
      })
      toast.success(
        result.degraded
          ? `Context Review Cycle complete with ${result.warnings.length} warning(s).`
          : result.claim_candidates.proposal_id
          ? 'Context Review Cycle complete — review packets created.'
          : 'Context Review Cycle complete.',
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanBusy(null)
    }
  }, [includeMemoryMaintenance, load, windowDays])

  // Slice E: deterministic, access-safe contradiction-discovery scan. Reuses the
  // Claim Candidate Packet flow so the only canonical write stays proposal-gated.
  const runContradictionScan = useCallback(async () => {
    setScanBusy('contradictions')
    try {
      const result = await knowledgeApi.contradictionScan({ create_packet: true, review_scope: loopReviewScope })
      const findings = result.report.findings.length
      toast.success(
        result.candidate_packet_proposal_id
          ? `Contradiction scan found ${findings} candidate(s) — review packet created.`
          : `Contradiction scan complete — ${findings} finding(s).`,
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanBusy(null)
    }
  }, [load, loopReviewScope])

  // Slice F: deterministic candidate-relation discovery; emits one batched
  // discovery packet of child Knowledge relation/item proposals.
  const runRelationDiscovery = useCallback(async () => {
    setScanBusy('discovery')
    try {
      const result = await knowledgeApi.relationDiscoveryScan({
        create_packet: true,
        review_scope: loopReviewScope,
        source_object_types: discoveryIncludeNotes
          ? ['knowledge_item', 'note', 'activity', 'artifact']
          : ['knowledge_item', 'activity', 'artifact'],
        include_unresolved_item_candidates: discoveryIncludeUnresolved,
      })
      const proposalReady = result.proposal_candidate_count ?? result.candidate_count
      const reviewOnly = result.review_only_candidate_count ?? 0
      const candidateSummary = reviewOnly > 0
        ? `${result.candidate_count} candidate(s): ${proposalReady} proposal-ready, ${reviewOnly} review-only`
        : `${result.candidate_count} proposal-ready candidate(s)`
      toast.success(
        result.proposal_id
          ? `Discovery found ${candidateSummary} — review packet created.`
          : `Discovery complete — ${candidateSummary}.`,
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanBusy(null)
    }
  }, [load, loopReviewScope, discoveryIncludeNotes, discoveryIncludeUnresolved])

  const runShapeSuggestions = useCallback(async () => {
    setScanBusy('shape')
    try {
      const result = await objectSchemaApi.suggestionScan({
        persist_artifact: true,
        review_scope: loopReviewScope,
      })
      toast.success(
        result.artifact_id
          ? `Schema scan found ${result.finding_count} finding(s) — report saved.`
          : `Schema scan complete — ${result.finding_count} finding(s).`,
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setScanBusy(null)
    }
  }, [load, loopReviewScope])

  const createClaimPacket = useCallback(async (
    artifactIds: string | string[],
    reviewScope: 'private' | 'space_ops' = 'private',
    promotePrivate = false,
  ) => {
    const ids = Array.isArray(artifactIds) ? artifactIds : [artifactIds]
    if (ids.length === 0) return
    if (promotePrivate) {
      const confirmed = window.confirm(
        'Promote private-source derived claim candidates into shared Context Ops review for this space?',
      )
      if (!confirmed) return
    }
    const busyKey = `${reviewScope}:${ids.join(',')}`
    setPacketBusy(busyKey)
    try {
      const result = await knowledgeApi.claimCandidatePacket({
        source_artifact_ids: ids,
        review_scope: reviewScope,
        promote_private_sources_to_space_ops: promotePrivate,
        private_source_promotion_confirmed: promotePrivate,
      })
      toast.success(
        result.proposal_id
          ? reviewScope === 'space_ops' ? 'Space claim packet created.' : 'Claim packet created.'
          : 'Claim packet artifact created.',
      )
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setPacketBusy(null)
    }
  }, [load])

  const saveExplainPreset = useCallback(() => {
    const query = explainQuery.trim()
    const label = explainPresetLabel.trim()
    const maxValue = Number(explainMaxResults)
    if (!activeSpaceId || !query || !label) return
    const preset: ExplainPreset = {
      label,
      query,
      objectType: explainObjectType,
      mode: explainMode,
      maxResults: Number.isFinite(maxValue) && maxValue > 0 ? Math.min(50, Math.trunc(maxValue)) : 10,
    }
    const next = [preset, ...explainPresets.filter(item => item.label !== label)].slice(0, 12)
    setExplainPresets(next)
    localStorage.setItem(`context_ops.explain_presets.${activeSpaceId}`, JSON.stringify(next))
    toast.success('Explain preset saved')
  }, [activeSpaceId, explainMaxResults, explainMode, explainObjectType, explainPresetLabel, explainPresets, explainQuery])

  const applyExplainPreset = useCallback((label: string) => {
    const preset = explainPresets.find(item => item.label === label)
    if (!preset) return
    setExplainPresetLabel(preset.label)
    setExplainQuery(preset.query)
    setExplainObjectType(preset.objectType)
    setExplainMode(preset.mode)
    setExplainMaxResults(String(preset.maxResults))
  }, [explainPresets])

  const runExplainComparison = useCallback(async () => {
    const query = explainQuery.trim()
    const targetA = explainTargetA.trim()
    const targetB = explainTargetB.trim()
    if (!query || !targetA || !targetB) {
      toast.error('Query and both targets are required')
      return
    }
    const maxValue = Number(explainMaxResults)
    setExplainBusy(true)
    setExplainArtifactIds([])
    try {
      const responses = await Promise.all([targetA, targetB].map(objectId => knowledgeApi.explain({
        query,
        object_type: explainObjectType,
        object_id: objectId,
        object_types: [explainObjectType],
        mode: explainMode,
        max_results: Number.isFinite(maxValue) && maxValue > 0 ? Math.min(50, Math.trunc(maxValue)) : 10,
        persist_artifact: true,
      })))
      const ids = responses.map(response => response.artifact_id).filter((id): id is string => Boolean(id))
      setExplainArtifactIds(ids)
      toast.success('Explain comparison saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setExplainBusy(false)
    }
  }, [explainMaxResults, explainMode, explainObjectType, explainQuery, explainTargetA, explainTargetB])

  const missingEmbeddingRatio = useMemo(() => {
    if (!summary || summary.embedding_backlog.total_chunks === 0) return 0
    return Math.round((summary.embedding_backlog.missing_embedding_chunks / summary.embedding_backlog.total_chunks) * 100)
  }, [summary])

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <Activity className="size-5 text-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Context Health</h1>
          <p className="text-xs text-muted-foreground">
              {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'} · {summary ? `generated ${fmt(summary.generated_at)}` : 'summary'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={String(windowDays)}
            onChange={value => setWindowDays(Number(value))}
            options={WINDOWS.map(days => ({ value: String(days), label: `${days}d` }))}
            size="sm"
            className="w-24"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeMemoryMaintenance}
              onChange={event => setIncludeMemoryMaintenance(event.target.checked)}
              className="size-3.5 accent-primary"
            />
            Memory
          </label>
          <Button variant="outline" size="sm" onClick={load} disabled={loading || !activeSpaceId}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={runContextReviewCycle} disabled={scanBusy !== null || !activeSpaceId || permissionDenied}>
            {scanBusy === 'review' ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run Context Review Cycle
          </Button>
        </div>
      </div>

      {!activeSpaceId ? (
        <Card className="p-4 text-sm text-muted-foreground">Select an operational space to inspect Context Ops.</Card>
      ) : waitingForSpace ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : permissionDenied ? (
        <Card className="p-4">
          <CardTitle className="text-sm">Context Ops access is not enabled</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">
            This space only exposes Context Ops to owners and admins unless member review or member scan initiation is enabled in retrieval settings.
          </p>
        </Card>
      ) : loading && !summary ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : summary ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MiniMetric label="retrieval objects" value={total(summary.index_freshness.object_counts)} />
            <MiniMetric label="stale projections" value={summary.index_freshness.stale_projection_count} tone={summary.index_freshness.stale_projection_count > 0 ? 'warn' : 'ok'} />
            <MiniMetric label="missing embeddings" value={`${summary.embedding_backlog.missing_embedding_chunks} (${missingEmbeddingRatio}%)`} tone={summary.embedding_backlog.missing_embedding_chunks > 0 ? 'warn' : 'ok'} />
            <MiniMetric label="pending packets" value={summary.maintenance.pending_packet_count} tone={summary.maintenance.pending_packet_count > 0 ? 'warn' : 'default'} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel icon={Database} title="Index Freshness">
              <div className="mb-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <span>oldest indexed: {fmt(summary.index_freshness.oldest_indexed_at)}</span>
                <span>newest indexed: {fmt(summary.index_freshness.newest_indexed_at)}</span>
                <span>newest source update: {fmt(summary.index_freshness.newest_source_updated_at)}</span>
              </div>
              <CountList counts={summary.index_freshness.object_counts} />
              {summary.index_freshness.stale_projection_count > 0 && (
                <Drilldown section="index_freshness" label="View stale projections" />
              )}
            </Panel>

            <Panel icon={BarChart3} title="Embedding Backlog">
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="outline">total: {summary.embedding_backlog.total_chunks}</Badge>
                <Badge variant="outline">embedded: {summary.embedding_backlog.embedded_chunks}</Badge>
                <Badge variant="outline">claimed: {summary.embedding_backlog.claimed_chunks}</Badge>
                <Badge variant="outline">attempted: {summary.embedding_backlog.attempted_chunks}</Badge>
              </div>
              <CountList counts={summary.embedding_backlog.missing_by_object_type} />
              {summary.embedding_backlog.missing_embedding_chunks > 0 && (
                <Drilldown section="embedding_backlog" label="View objects awaiting embeddings" />
              )}
            </Panel>

            <Panel icon={ShieldCheck} title="Source Policy">
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="outline">active sources: {summary.source_policy_warnings.active_source_connections}</Badge>
                {summary.source_policy_warnings.external_egress_disabled_source_count > 0 && (
                  <Badge variant="secondary">egress disabled: {summary.source_policy_warnings.external_egress_disabled_source_count}</Badge>
                )}
              </div>
              <CountList counts={summary.source_policy_warnings.warning_counts} />
              {summary.source_policy_warnings.active_source_connections > 0 && (
                <Drilldown section="source_warnings" label="View source connections" />
              )}
            </Panel>

            <Panel icon={PackageCheck} title="Maintenance">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge variant="outline">reports: {summary.maintenance.recent_report_count}</Badge>
                <Button variant="outline" size="sm" onClick={runMaintenanceScan} disabled={scanBusy !== null}>
                  {scanBusy === 'maintenance' ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  Run scan
                </Button>
                <Link to="/proposals"><Button variant="outline" size="sm">Review</Button></Link>
                <Link to="/artifacts?artifact_type=memory_maintenance_report"><Button variant="outline" size="sm">Artifacts</Button></Link>
              </div>
              <CountList counts={summary.maintenance.finding_counts} />
              <Drilldown section="maintenance_reports" label="Triage maintenance reports & packets" onPacket={createClaimPacket} packetBusy={packetBusy} />
              {summary.maintenance.recent_packets.length > 0 && (
                <div className="mt-3 space-y-2">
                  {summary.maintenance.recent_packets.slice(0, 4).map(packet => (
                    <div key={packet.proposal_id} className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Link to={`/proposals/${packet.proposal_id}`} className="min-w-0 flex-1 truncate hover:text-foreground">
                          {packet.title}
                        </Link>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="secondary">{packet.status}</Badge>
                          {packet.report_artifact_id && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => createClaimPacket(packet.report_artifact_id!)}
                              disabled={packetBusy !== null}
                            >
                              {packetBusy === `private:${packet.report_artifact_id}` ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
                              Packet
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel icon={AlertTriangle} title="Diagnostics">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge variant="outline">reports: {summary.diagnostics.recent_report_count}</Badge>
                {summary.diagnostics.insufficient_trend_sample && <Badge variant="secondary">insufficient trend sample</Badge>}
                <Button variant="outline" size="sm" onClick={runDiagnostics} disabled={scanBusy !== null}>
                  {scanBusy === 'diagnostics' ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  Run report
                </Button>
                {summary.diagnostics.latest_report_artifact_id && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => createClaimPacket(summary.diagnostics.latest_report_artifact_id!)}
                    disabled={packetBusy !== null}
                  >
                    {packetBusy === `private:${summary.diagnostics.latest_report_artifact_id}` ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
                    Packet
                  </Button>
                )}
                <Link to="/artifacts?artifact_type=retrieval_eval_report"><Button variant="outline" size="sm">Reports</Button></Link>
                <Link to="/artifacts?artifact_type=retrieval_explain_report"><Button variant="outline" size="sm">Explain</Button></Link>
              </div>
              <CountList counts={summary.diagnostics.diagnostic_code_counts} />
              {countEntries(summary.diagnostics.trend_metric_deltas).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {countEntries(summary.diagnostics.trend_metric_deltas).slice(0, 4).map(([key, value]) => (
                    <Badge key={key} variant="outline">{key}: {value}</Badge>
                  ))}
                </div>
              )}
              <Drilldown section="diagnostics_reports" label="Triage diagnostics reports" onPacket={createClaimPacket} packetBusy={packetBusy} />
            </Panel>

            <Panel icon={FileSearch} title="Search Explain">
              <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_120px]">
                <input
                  value={explainQuery}
                  onChange={event => setExplainQuery(event.target.value)}
                  placeholder="query"
                  className="h-9 rounded-md border border-border bg-input px-3 text-sm"
                />
                <Select
                  value={explainObjectType}
                  size="sm"
                  onChange={value => setExplainObjectType(value as ExplainPreset['objectType'])}
                  options={[
                    { value: 'knowledge_item', label: 'knowledge_item' },
                    { value: 'note', label: 'note' },
                    { value: 'source', label: 'source' },
                    { value: 'claim', label: 'claim' },
                  ]}
                />
                <Select
                  value={explainMode}
                  size="sm"
                  onChange={value => setExplainMode(value as ExplainPreset['mode'])}
                  options={[
                    { value: 'exact', label: 'exact' },
                    { value: 'lexical', label: 'lexical' },
                    { value: 'hybrid', label: 'hybrid' },
                    { value: 'hybrid_rerank', label: 'rerank' },
                  ]}
                />
              </div>
              <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px]">
                <TechnicalIdField label="Target A ID" value={explainTargetA} onChange={setExplainTargetA} />
                <TechnicalIdField label="Target B ID" value={explainTargetB} onChange={setExplainTargetB} />
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={explainMaxResults}
                  onChange={event => setExplainMaxResults(event.target.value)}
                  className="h-9 rounded-md border border-border bg-input px-3 text-sm"
                />
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                <input
                  value={explainPresetLabel}
                  onChange={event => setExplainPresetLabel(event.target.value)}
                  className="h-8 w-36 rounded-md border border-border bg-input px-2 text-xs"
                  placeholder="preset name"
                />
                <Button variant="outline" size="sm" onClick={saveExplainPreset} disabled={!activeSpaceId || !explainQuery.trim()}>
                  <Save className="size-3.5" />
                  Save preset
                </Button>
                <Button variant="outline" size="sm" onClick={runExplainComparison} disabled={explainBusy || !activeSpaceId}>
                  {explainBusy ? <Loader2 className="size-3.5 animate-spin" /> : <GitCompare className="size-3.5" />}
                  Compare
                </Button>
              </div>
              {explainPresets.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {explainPresets.map(preset => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => applyExplainPreset(preset.label)}
                      className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
              {explainArtifactIds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {explainArtifactIds.map((id, index) => (
                    <Link key={id} to={`/artifacts/${id}`} className="text-xs text-accent-foreground hover:underline">
                      Open explain {index + 1}
                    </Link>
                  ))}
                </div>
              )}
              <Drilldown section="explain_reports" label="View saved explain reports" />
            </Panel>

            <Panel icon={FileText} title="Recent Context Briefs">
              {summary.recent_context_briefs.length === 0 ? (
                <p className="text-sm text-muted-foreground">None</p>
              ) : (
                <div className="space-y-2">
                  {summary.recent_context_briefs.slice(0, 5).map(brief => (
                    <div key={brief.artifact_id} className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Link to={`/artifacts/${brief.artifact_id}`} className="min-w-0 flex-1 hover:text-foreground">
                          <div className="truncate">{brief.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{brief.surface ?? 'surface'} · {fmt(brief.created_at)}</div>
                        </Link>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => createClaimPacket(brief.artifact_id)}
                            disabled={packetBusy !== null}
                          >
                            {packetBusy === `private:${brief.artifact_id}` ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
                            Packet
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => createClaimPacket(brief.artifact_id, 'space_ops', true)}
                            disabled={packetBusy !== null}
                          >
                            {packetBusy === `space_ops:${brief.artifact_id}` ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                            Space
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Drilldown section="recent_briefs" label="View more briefs" onPacket={createClaimPacket} packetBusy={packetBusy} />
            </Panel>

            <Panel icon={Activity} title="Retrieval Feedback">
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="outline">events: {summary.retrieval_feedback.recent_event_count}</Badge>
                <Badge variant="outline">window: {summary.retrieval_feedback.window_days}d</Badge>
              </div>
              <CountList counts={summary.retrieval_feedback.signal_counts} />
              <div className="mt-3">
                <CountList counts={summary.retrieval_feedback.surface_counts} empty="No surfaces" />
              </div>
            </Panel>

            <Panel icon={GitCompare} title="Review Loops">
              <p className="mb-3 text-sm text-muted-foreground">
                Deterministic, access-safe discovery passes. Each emits a batched, proposal-first
                review packet — neither writes canonical claims, relations, or items directly.
              </p>
              <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                  Review scope
                  <Select
                    value={loopReviewScope}
                    onChange={(value) => setLoopReviewScope(value as 'private' | 'space_ops')}
                    size="sm"
                    options={[
                      { value: 'private', label: 'private' },
                      { value: 'space_ops', label: 'space_ops' },
                    ]}
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="size-3.5 accent-primary" checked={discoveryIncludeNotes} onChange={(e) => setDiscoveryIncludeNotes(e.target.checked)} />
                  Include notes (discovery)
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="size-3.5 accent-primary" checked={discoveryIncludeUnresolved} onChange={(e) => setDiscoveryIncludeUnresolved(e.target.checked)} />
                  Unresolved stubs (discovery)
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={runContradictionScan} disabled={scanBusy !== null}>
                  {scanBusy === 'contradictions' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}
                  Scan claim contradictions
                </Button>
                <Button variant="outline" size="sm" onClick={runRelationDiscovery} disabled={scanBusy !== null}>
                  {scanBusy === 'discovery' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}
                  Discover candidate relations
                </Button>
                <Button variant="outline" size="sm" onClick={runShapeSuggestions} disabled={scanBusy !== null}>
                  {scanBusy === 'shape' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-1 h-4 w-4" />}
                  Scan object schema
                </Button>
              </div>
            </Panel>

            <Panel icon={Database} title="Memory Provenance">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">accesses: {summary.memory_provenance.recent_access_count}</Badge>
                <Badge variant="outline">context injections: {summary.memory_provenance.context_injection_count}</Badge>
                <Badge variant="outline">maintenance scans: {summary.memory_provenance.maintenance_scan_count}</Badge>
                {!summary.memory_provenance.inspector_available && <Badge variant="secondary">inspector deferred</Badge>}
              </div>
              {summary.memory_provenance.inspector_available && (
                <Button size="sm" variant="outline" asChild className="mt-3">
                  <Link to="/memory">Open Memory inspector</Link>
                </Button>
              )}
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  )
}
