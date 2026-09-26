import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy as CopyIcon, GitBranch, Inbox as InboxIcon, Loader2, Pencil, Play, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { evolutionApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import type {
  EvolutionExperience,
  EvolutionProposal,
  EvolutionRunListItem,
  EvolutionSelectorDecision,
  EvolutionSignal,
  EvolutionStrategy,
  EvolutionSummaryOut,
  EvolutionTarget,
  EvolutionTargetCreateBody,
  EvolutionTargetUpdateBody,
  EvolutionValidationResult,
  EvolvableAsset,
  EvolvableAssetEvaluationRun,
  EvolvableAssetPin,
  EvolvableAssetVersion,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { EvolutionStatusBadge } from './EvolutionStatusBadge'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import {
  EMPTY_SUMMARY,
  type DetailTab,
  type TargetDialogMode,
  type TargetListTab,
  EvolutionProposalsList,
  EvolutionRunsList,
  EvolutionSelectorDecisionsList,
  EvolutionSignalsList,
  EvolutionStrategiesList,
  EvolutionExperiencesList,
  EvolutionValidationPanel,
  OverviewCards,
  SectionCard,
  SignalDialog,
  TargetConfigDialog,
  TargetDefinition,
  TargetList,
  displayTargetName,
  fmt,
  riskVariant,
} from './EvolutionPageParts'
import AssetLifecyclePanel from './AssetLifecyclePanel'

function assetLabel(asset: EvolvableAsset): string {
  return asset.display_name || asset.asset_key
}

function jsonSummary(value: unknown): string {
  if (!value || typeof value !== 'object') return '-'
  const keys = Object.keys(value as Record<string, unknown>)
  return keys.length > 0 ? keys.slice(0, 4).join(', ') : '-'
}

function AssetList({
  assets,
  selectedAssetId,
  onSelect,
}: {
  assets: EvolvableAsset[]
  selectedAssetId: string | null
  onSelect: (assetId: string) => void
}) {
  const { t } = useAppTranslation()
  if (assets.length === 0) {
    return <EmptyState title={t('evolution.no_assets')} description={t('evolution.no_assets_description')} />
  }
  return (
    <div className="space-y-2">
      {assets.map(asset => (
        <button
          key={asset.id}
          type="button"
          className={[
            'w-full rounded-md border px-3 py-2 text-left transition-colors',
            selectedAssetId === asset.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
          ].join(' ')}
          onClick={() => onSelect(asset.id)}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{assetLabel(asset)}</span>
            <EvolutionStatusBadge status={asset.status} />
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant="outline">{asset.asset_type}</Badge>
            <Badge variant="muted">{asset.owner_scope_type}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{asset.asset_key}</p>
        </button>
      ))}
    </div>
  )
}

function AssetPinList({ pins }: { pins: EvolvableAssetPin[] }) {
  const { t } = useAppTranslation()
  if (pins.length === 0) {
    return <EmptyState title={t('evolution.no_active_pins')} description={t('evolution.no_active_pins_description')} />
  }
  return (
    <div className="space-y-2">
      {pins.map(pin => (
        <div key={pin.id} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{pin.scope_type}</Badge>
            <span className="font-mono text-xs">{pin.scope_id}</span>
            <EvolutionStatusBadge status={pin.status} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('evolution.pin_version', { version: pin.version_id.slice(-8), reason: pin.reason ?? t('evolution.no_reason') })}</p>
        </div>
      ))}
    </div>
  )
}

function AssetEvaluationList({ evaluations }: { evaluations: EvolvableAssetEvaluationRun[] }) {
  const { t, locale } = useAppTranslation()
  if (evaluations.length === 0) {
    return <EmptyState title={t('evolution.no_evaluation_runs')} description={t('evolution.no_evaluation_runs_description')} />
  }
  return (
    <div className="space-y-2">
      {evaluations.map(run => (
        <div key={run.id} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <EvolutionStatusBadge status={run.status} />
              <Badge variant="outline">{run.evaluator_version}</Badge>
              <span className="font-mono text-xs text-muted-foreground">{run.candidate_version_id.slice(-8)}</span>
            </div>
            <span className="text-xs text-muted-foreground">{fmt(run.created_at, locale)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('evolution.evaluation_suite', { suite: String(run.eval_suite_ref.name ?? run.eval_suite_ref.kind ?? '-') })} · {t('evolution.evaluation_metrics', { metrics: jsonSummary(run.metrics) })}
          </p>
        </div>
      ))}
    </div>
  )
}

export default function EvolutionPage() {
  const { t, locale } = useAppTranslation()
  const { activeSpaceId, preferredSpaceId, spaces } = useSpace()
  const viewSpaceId = activeSpaceId ?? preferredSpaceId
  const viewSpaceName = useMemo(
    () => spaces.find(space => space.id === viewSpaceId)?.name ?? viewSpaceId ?? t('evolution.no_space_selected'),
    [spaces, viewSpaceId, t],
  )

  const [summary, setSummary] = useState<EvolutionSummaryOut>(EMPTY_SUMMARY)
  const [activeTargets, setActiveTargets] = useState<EvolutionTarget[]>([])
  const [archivedTargets, setArchivedTargets] = useState<EvolutionTarget[]>([])
  const [targetSignals, setTargetSignals] = useState<EvolutionSignal[]>([])
  const [strategies, setStrategies] = useState<EvolutionStrategy[]>([])
  const [selectorDecisions, setSelectorDecisions] = useState<EvolutionSelectorDecision[]>([])
  const [experiences, setExperiences] = useState<EvolutionExperience[]>([])
  const [runs, setRuns] = useState<EvolutionRunListItem[]>([])
  const [proposals, setProposals] = useState<EvolutionProposal[]>([])
  const [validationResults, setValidationResults] = useState<EvolutionValidationResult[]>([])
  const [assets, setAssets] = useState<EvolvableAsset[]>([])
  const [assetVersions, setAssetVersions] = useState<EvolvableAssetVersion[]>([])
  const [assetPins, setAssetPins] = useState<EvolvableAssetPin[]>([])
  const [assetEvaluations, setAssetEvaluations] = useState<EvolvableAssetEvaluationRun[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [targetLoading, setTargetLoading] = useState(false)
  const [assetLoading, setAssetLoading] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('definition')
  const [loading, setLoading] = useState(true)
  const [runningTargetId, setRunningTargetId] = useState<string | null>(null)
  const [signalOpen, setSignalOpen] = useState(false)
  const [savingSignal, setSavingSignal] = useState(false)
  const [targetDialogMode, setTargetDialogMode] = useState<TargetDialogMode>('create')
  const [targetDialogTarget, setTargetDialogTarget] = useState<EvolutionTarget | null>(null)
  const [targetDialogOpen, setTargetDialogOpen] = useState(false)
  const [savingTarget, setSavingTarget] = useState(false)
  const [targetListTab, setTargetListTab] = useState<TargetListTab>('active')

  const targets = useMemo(
    () => [...activeTargets, ...archivedTargets],
    [activeTargets, archivedTargets],
  )
  const visibleTargets = targetListTab === 'active' ? activeTargets : archivedTargets
  const selectedTarget = useMemo(
    () => targets.find(target => target.id === selectedTargetId) ?? null,
    [targets, selectedTargetId],
  )
  const selectedAsset = useMemo(
    () => assets.find(asset => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  )
  const selectedRuns = useMemo(
    () => runs.filter(run => run.target_id === selectedTargetId),
    [runs, selectedTargetId],
  )
  const selectedProposals = useMemo(
    () => proposals.filter(proposal => proposal.target_id === selectedTargetId),
    [proposals, selectedTargetId],
  )
  const selectedValidationResults = useMemo(
    () => validationResults.filter(result => result.target_id === selectedTargetId),
    [validationResults, selectedTargetId],
  )
  const selectedSelectorDecisions = useMemo(
    () => selectorDecisions.filter(decision => decision.target_id === selectedTargetId),
    [selectorDecisions, selectedTargetId],
  )
  const selectedExperiences = useMemo(
    () => experiences.filter(experience => experience.target_id === selectedTargetId),
    [experiences, selectedTargetId],
  )
  const selectedAgentId = useMemo(
    () => {
      const value = selectedTarget?.metadata_json.agent_id
      return typeof value === 'string' && value.trim() ? value.trim() : null
    },
    [selectedTarget],
  )

  const load = useCallback(async () => {
    if (!viewSpaceId) {
      setSummary(EMPTY_SUMMARY)
      setActiveTargets([])
      setArchivedTargets([])
      setTargetSignals([])
      setStrategies([])
      setSelectorDecisions([])
      setExperiences([])
      setRuns([])
      setProposals([])
      setValidationResults([])
      setAssets([])
      setAssetVersions([])
      setAssetPins([])
      setAssetEvaluations([])
      setSelectedTargetId(null)
      setSelectedAssetId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [
        nextSummary,
        nextTargets,
        nextStrategies,
        nextSelectorDecisions,
        nextExperiences,
        nextRuns,
        nextProposals,
        nextValidationResults,
        nextAssets,
      ] = await Promise.all([
        evolutionApi.summary(),
        evolutionApi.targets(),
        evolutionApi.strategies({ status: 'active', limit: 100 }),
        evolutionApi.selectorDecisions({ limit: 50 }),
        evolutionApi.experiences({ limit: 50 }),
        evolutionApi.runs({ limit: 50 }),
        evolutionApi.proposals({ limit: 50 }),
        evolutionApi.validation(),
        evolutionApi.assets(),
      ])
      const nextActiveTargets = nextTargets.filter(target => target.status !== 'archived')
      const nextArchivedTargets = nextTargets.filter(target => target.status === 'archived')
      setSummary(nextSummary)
      setActiveTargets(nextActiveTargets)
      setArchivedTargets(nextArchivedTargets)
      setStrategies(nextStrategies)
      setSelectorDecisions(nextSelectorDecisions)
      setExperiences(nextExperiences)
      setRuns(nextRuns)
      setProposals(nextProposals)
      setValidationResults(nextValidationResults)
      setAssets(nextAssets)
      setSelectedTargetId(current => {
        if (nextTargets.length === 0) return null
        if (current && nextTargets.some(target => target.id === current)) return current
        return nextActiveTargets[0]?.id ?? nextTargets[0].id
      })
      setSelectedAssetId(current => {
        if (nextAssets.length === 0) return null
        if (current && nextAssets.some(asset => asset.id === current)) return current
        return nextAssets[0].id
      })
    } catch (e) {
      toast.error(errMsg(e))
      setSummary(EMPTY_SUMMARY)
      setActiveTargets([])
      setArchivedTargets([])
      setTargetSignals([])
      setStrategies([])
      setSelectorDecisions([])
      setExperiences([])
      setRuns([])
      setProposals([])
      setValidationResults([])
      setAssets([])
      setAssetVersions([])
      setAssetPins([])
      setAssetEvaluations([])
      setSelectedTargetId(null)
      setSelectedAssetId(null)
    } finally {
      setLoading(false)
    }
  }, [viewSpaceId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (visibleTargets.length === 0) {
      setSelectedTargetId(null)
      return
    }
    if (!selectedTargetId || !visibleTargets.some(target => target.id === selectedTargetId)) {
      setSelectedTargetId(visibleTargets[0].id)
    }
  }, [selectedTargetId, visibleTargets])

  const loadTargetSignals = useCallback(async (targetId: string | null) => {
    if (!targetId || !viewSpaceId) {
      setTargetSignals([])
      return
    }
    setTargetLoading(true)
    try {
      setTargetSignals(await evolutionApi.targetSignals(targetId, { limit: 50 }))
    } catch (e) {
      toast.error(errMsg(e))
      setTargetSignals([])
    } finally {
      setTargetLoading(false)
    }
  }, [viewSpaceId])

  useEffect(() => {
    loadTargetSignals(selectedTargetId)
  }, [loadTargetSignals, selectedTargetId])

  const loadAssetDetails = useCallback(async (assetId: string | null) => {
    if (!assetId || !viewSpaceId) {
      setAssetVersions([])
      setAssetPins([])
      setAssetEvaluations([])
      return
    }
    setAssetLoading(true)
    try {
      const [versions, pins, evaluations] = await Promise.all([
        evolutionApi.assetVersions(assetId),
        evolutionApi.assetPins(assetId),
        evolutionApi.assetEvaluationRuns(assetId),
      ])
      setAssetVersions(versions)
      setAssetPins(pins)
      setAssetEvaluations(evaluations)
    } catch (e) {
      toast.error(errMsg(e))
      setAssetVersions([])
      setAssetPins([])
      setAssetEvaluations([])
    } finally {
      setAssetLoading(false)
    }
  }, [viewSpaceId])

  useEffect(() => {
    loadAssetDetails(selectedAssetId)
  }, [loadAssetDetails, selectedAssetId])

  async function resolveSelectedAsset() {
    if (!selectedAssetId) return
    setAssetLoading(true)
    try {
      const resolved = await evolutionApi.resolveAsset(selectedAssetId)
      const fallback = resolved.fallbackReason ? ` · ${resolved.fallbackReason}` : ''
      toast.success(t('evolution.asset_resolved', { version: resolved.versionId.slice(-8), fallback }))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setAssetLoading(false)
    }
  }

  async function runTarget(targetId: string) {
    if (!selectedAgentId) {
      toast.error(t('evolution.need_agent_to_run'))
      return
    }
    setRunningTargetId(targetId)
    try {
      const result = await evolutionApi.runTarget(targetId, { agent_id: selectedAgentId, mode: 'dry_run' })
      toast.success(result.proposal_ids.length > 0
        ? t('evolution.run_complete_with_proposals', { count: result.proposal_ids.length })
        : t('evolution.run_complete'))
      await load()
      await loadTargetSignals(targetId)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setRunningTargetId(null)
    }
  }

  async function createSignal(body: {
    signal_type: string
    source_type: string
    source_id?: string | null
    severity: string
    summary?: string | null
    payload_json: Record<string, unknown>
  }) {
    if (!selectedTargetId) return
    setSavingSignal(true)
    try {
      await evolutionApi.createSignal(selectedTargetId, body)
      toast.success(t('evolution.signal_recorded'))
      setSignalOpen(false)
      await load()
      await loadTargetSignals(selectedTargetId)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingSignal(false)
    }
  }

  function openTargetDialog(mode: TargetDialogMode, target: EvolutionTarget | null = null) {
    setTargetDialogMode(mode)
    setTargetDialogTarget(target)
    setTargetDialogOpen(true)
  }

  async function saveTarget(body: EvolutionTargetCreateBody | EvolutionTargetUpdateBody, mode: TargetDialogMode) {
    if (mode === 'edit' && !targetDialogTarget) return
    setSavingTarget(true)
    try {
      if (mode === 'edit') {
        const updated = await evolutionApi.updateTarget(targetDialogTarget!.id, body as EvolutionTargetUpdateBody)
        toast.success(t('evolution.target_updated'))
        setTargetDialogOpen(false)
        await load()
        setSelectedTargetId(updated.id)
      } else {
        const created = await evolutionApi.createTarget(body as EvolutionTargetCreateBody)
        toast.success(t('evolution.target_created'))
        setTargetDialogOpen(false)
        await load()
        setSelectedTargetId(created.id)
      }
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingTarget(false)
    }
  }

  async function toggleTargetEnabled(target: EvolutionTarget) {
    setSavingTarget(true)
    try {
      const updated = await evolutionApi.updateTarget(target.id, { enabled: !target.enabled })
      toast.success(updated.enabled ? t('evolution.target_activated') : t('evolution.target_deactivated'))
      await load()
      setSelectedTargetId(updated.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingTarget(false)
    }
  }

  async function archiveTarget(target: EvolutionTarget) {
    setSavingTarget(true)
    try {
      const updated = await evolutionApi.updateTarget(target.id, { status: 'archived', enabled: false })
      toast.success(t('evolution.target_archived'))
      setTargetListTab('archived')
      await load()
      setSelectedTargetId(updated.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingTarget(false)
    }
  }

  async function restoreTarget(target: EvolutionTarget) {
    setSavingTarget(true)
    try {
      const updated = await evolutionApi.updateTarget(target.id, { status: 'active', enabled: true })
      toast.success(t('evolution.target_restored'))
      setTargetListTab('active')
      await load()
      setSelectedTargetId(updated.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingTarget(false)
    }
  }

  const canRunSelected = Boolean(
    selectedTarget?.enabled
    && selectedTarget.status === 'active'
    && selectedTarget.recent_signal_count > 0
    && selectedAgentId,
  )
  const runningSelected = runningTargetId === selectedTargetId

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 pb-4 border-b border-border lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <GitBranch className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('evolution.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('evolution.description')}</p>
            <p className="text-xs text-muted-foreground">{t('evolution.current_space', { name: viewSpaceName })}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><Link to="/evolution/inbox"><InboxIcon className="size-3.5" /> {t('evolution.inbox')}</Link></Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading || !viewSpaceId}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('evolution.refresh')}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <OverviewCards summary={summary} />

          <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title={t('evolution.targets')} count={visibleTargets.length}>
              <Button size="sm" variant="outline" className="mb-3 w-full justify-center" onClick={() => openTargetDialog('create')} disabled={!viewSpaceId}>
                <Plus className="size-3.5" />
                {t('evolution.new_target')}
              </Button>
              <Tabs value={targetListTab} onValueChange={value => setTargetListTab(value as TargetListTab)}>
                <TabsList className="mb-3 grid w-full grid-cols-2">
                  <TabsTrigger value="active">{t('evolution.active_count', { count: activeTargets.length })}</TabsTrigger>
                  <TabsTrigger value="archived">{t('evolution.archived_count', { count: archivedTargets.length })}</TabsTrigger>
                </TabsList>
                <TabsContent value="active">
                  <TargetList
                    targets={activeTargets}
                    selectedTargetId={selectedTargetId}
                    onSelect={setSelectedTargetId}
                    onConfigure={target => openTargetDialog('edit', target)}
                    emptyTitle={t('evolution.no_active_targets')}
                    emptyDescription={t('evolution.active_targets_description')}
                  />
                </TabsContent>
                <TabsContent value="archived">
                  <TargetList
                    targets={archivedTargets}
                    selectedTargetId={selectedTargetId}
                    onSelect={setSelectedTargetId}
                    onConfigure={target => openTargetDialog('edit', target)}
                    emptyTitle={t('evolution.no_archived_targets')}
                    emptyDescription={t('evolution.archived_targets_description')}
                  />
                </TabsContent>
              </Tabs>
            </SectionCard>

            <SectionCard title={selectedTarget ? displayTargetName(selectedTarget) : t('evolution.target')} count={selectedTarget ? selectedTarget.recent_signal_count : undefined}>
              {selectedTarget ? (
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{t('evolution.target_type.' + selectedTarget.target_type, { defaultValue: selectedTarget.target_type })}</Badge>
                        <Badge variant={riskVariant(selectedTarget.risk_level)}>{t('evolution.risk_level_value', { level: t('evolution.risk.' + selectedTarget.risk_level, { defaultValue: selectedTarget.risk_level }) })}</Badge>
                        <EvolutionStatusBadge status={selectedTarget.enabled ? selectedTarget.status : 'disabled'} />
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{t('evolution.scope_value', { value: selectedTarget.scope ?? '-' })}</span>
                        <span>{t('evolution.version_value', { value: selectedTarget.current_version ?? selectedTarget.current_version_id ?? '-' })}</span>
                        <span>{t('evolution.signals_value', { count: selectedTarget.recent_signal_count })}</span>
                        <span>{t('evolution.last_run_value', { value: fmt(selectedTarget.last_run_at, locale) })}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openTargetDialog('edit', selectedTarget)}
                      >
                        <Pencil className="size-3.5" />
                        {t('evolution.edit_target')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openTargetDialog('copy', selectedTarget)}
                      >
                        <CopyIcon className="size-3.5" />
                        {t('evolution.copy_target')}
                      </Button>
                      {selectedTarget.status === 'archived' ? (
                        <Button size="sm" variant="outline" onClick={() => restoreTarget(selectedTarget)} disabled={savingTarget}>
                          {t('evolution.restore')}
                        </Button>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" onClick={() => toggleTargetEnabled(selectedTarget)} disabled={savingTarget}>
                            {t(selectedTarget.enabled ? 'evolution.deactivate' : 'evolution.activate')}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => archiveTarget(selectedTarget)} disabled={savingTarget}>
                            {t('evolution.archive')}
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="outline" onClick={() => setSignalOpen(true)}>
                        <Plus className="size-3.5" />
                        {t('evolution.record_signal')}
                      </Button>
                      <Button size="sm" variant="outline" disabled={!canRunSelected || runningSelected} onClick={() => runTarget(selectedTarget.id)}>
                        {runningSelected ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                        {t('evolution.create_improvement_plan')}
                      </Button>
                    </div>
                  </div>
                  {selectedTarget.recent_signal_count === 0 && selectedTarget.enabled && selectedTarget.status === 'active' && (
                    <p className="text-xs text-muted-foreground">{t('evolution.need_signal_to_run')}</p>
                  )}
                  {!selectedAgentId && (
                    <p className="text-xs text-muted-foreground">{t('evolution.need_agent_metadata')}</p>
                  )}

                  <Tabs value={detailTab} onValueChange={value => setDetailTab(value as DetailTab)}>
                    <TabsList className="flex h-auto w-full flex-wrap justify-start">
                      <TabsTrigger value="definition">{t('evolution.tab_definition')}</TabsTrigger>
                      <TabsTrigger value="signals">{t('evolution.tab_signals')}</TabsTrigger>
                      <TabsTrigger value="strategies">{t('evolution.tab_strategies')}</TabsTrigger>
                      <TabsTrigger value="decisions">{t('evolution.tab_decisions')}</TabsTrigger>
                      <TabsTrigger value="experiences">{t('evolution.tab_experiences')}</TabsTrigger>
                      <TabsTrigger value="runs">{t('evolution.tab_runs')}</TabsTrigger>
                      <TabsTrigger value="proposals">{t('evolution.tab_proposals')}</TabsTrigger>
                      <TabsTrigger value="validation">{t('evolution.tab_validation')}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="definition" className="mt-4">
                      <TargetDefinition target={selectedTarget} />
                    </TabsContent>
                    <TabsContent value="signals" className="mt-4">
                      <EvolutionSignalsList signals={targetSignals} loading={targetLoading} />
                    </TabsContent>
                    <TabsContent value="strategies" className="mt-4">
                      <EvolutionStrategiesList strategies={strategies} />
                    </TabsContent>
                    <TabsContent value="decisions" className="mt-4">
                      <EvolutionSelectorDecisionsList decisions={selectedSelectorDecisions} />
                    </TabsContent>
                    <TabsContent value="experiences" className="mt-4">
                      <EvolutionExperiencesList experiences={selectedExperiences} />
                    </TabsContent>
                    <TabsContent value="runs" className="mt-4">
                      <EvolutionRunsList runs={selectedRuns} />
                    </TabsContent>
                    <TabsContent value="proposals" className="mt-4">
                      <EvolutionProposalsList proposals={selectedProposals} />
                    </TabsContent>
                    <TabsContent value="validation" className="mt-4">
                      <EvolutionValidationPanel results={selectedValidationResults} />
                    </TabsContent>
                  </Tabs>
                </div>
              ) : (
                <EmptyState title={t('evolution.no_target_selected')} description={t('evolution.select_or_register_target')} />
              )}
            </SectionCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <SectionCard title={t('evolution.assets')} count={assets.length}>
              <AssetList assets={assets} selectedAssetId={selectedAssetId} onSelect={setSelectedAssetId} />
            </SectionCard>

            <SectionCard title={selectedAsset ? assetLabel(selectedAsset) : t('evolution.asset')} count={assetVersions.length}>
              {selectedAsset ? (
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{selectedAsset.asset_type}</Badge>
                        <Badge variant="outline">{selectedAsset.owner_scope_type}</Badge>
                        <EvolutionStatusBadge status={selectedAsset.status} />
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">{selectedAsset.asset_key}</p>
                      {selectedAsset.description && <p className="text-sm text-muted-foreground">{selectedAsset.description}</p>}
                    </div>
                    <Button size="sm" variant="outline" onClick={resolveSelectedAsset} disabled={assetLoading}>
                      {assetLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                      {t('evolution.resolve_default')}
                    </Button>
                  </div>

                  <Tabs defaultValue="versions">
                    <TabsList className="flex h-auto w-full flex-wrap justify-start">
                      <TabsTrigger value="versions">{t('evolution.versions')}</TabsTrigger>
                      <TabsTrigger value="pins">{t('evolution.pins')}</TabsTrigger>
                      <TabsTrigger value="evaluations">{t('evolution.evaluations')}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="versions" className="mt-4">
                      <AssetLifecyclePanel asset={selectedAsset} versions={assetVersions} evaluations={assetEvaluations} onReload={() => loadAssetDetails(selectedAsset.id)} />
                    </TabsContent>
                    <TabsContent value="pins" className="mt-4">
                      <AssetPinList pins={assetPins} />
                    </TabsContent>
                    <TabsContent value="evaluations" className="mt-4">
                      <AssetEvaluationList evaluations={assetEvaluations} />
                    </TabsContent>
                  </Tabs>
                </div>
              ) : (
                <EmptyState title={t('evolution.no_asset_selected')} description={t('evolution.no_asset_selected_description')} />
              )}
            </SectionCard>
          </div>

          <SignalDialog
            open={signalOpen}
            target={selectedTarget}
            saving={savingSignal}
            onOpenChange={setSignalOpen}
            onSubmit={createSignal}
          />
          <TargetConfigDialog
            open={targetDialogOpen}
            mode={targetDialogMode}
            target={targetDialogTarget}
            saving={savingTarget}
            onOpenChange={setTargetDialogOpen}
            onSubmit={saveTarget}
          />
        </>
      )}
    </div>
  )
}
