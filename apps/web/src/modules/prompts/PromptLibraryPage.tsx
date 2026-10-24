import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, FileCode2, GitBranch, Loader2, RefreshCw, RotateCcw, Search, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { promptsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import type {
  PromptAssetDetail,
  PromptAssetSummary,
  PromptAssetScopeType,
  PromptDeploymentRef,
  PromptType,
  PromptVersion,
} from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { Textarea } from '../../components/ui/textarea'
import i18n, { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'

const PROMPT_TYPES: Array<PromptType | ''> = ['', 'agent_system', 'chat', 'retrieval_query', 'retrieval_rerank', 'retrieval_synthesis', 'text', 'workflow']

const EVALUATION_STATUSES = ['passed', 'failed', 'blocked'] as const

const DEPLOYMENT_SCOPE_ORDER: PromptAssetScopeType[] = ['project', 'agent', 'user', 'space', 'system']
const AUTO_RESEARCH_BUNDLE_ID = 'auto_research'
const AUTO_RESEARCH_ASSET_PREFIX = 'workflow.research.'

/** Pipeline stage ids stay stable; labels and details are presentation only. */
const AUTO_RESEARCH_STAGES = [
  { id: 'research.source_collect', key: 'source_collect' },
  { id: 'research.source_summarize', key: 'source_summarize' },
  { id: 'research.evidence_extract', key: 'evidence_extract' },
  { id: 'research.brief_synthesize', key: 'brief_synthesize' },
  { id: 'research.idea_generate', key: 'idea_generate' },
] as const

function isAutoResearchAsset(assetKey: string): boolean {
  return assetKey.startsWith(AUTO_RESEARCH_ASSET_PREFIX)
}

function promptTypeLabel(type: PromptType | '' | null | undefined): string {
  if (type === '') return i18n.t('management_ui.prompts.type.all')
  if (!type) return i18n.t('management_ui.prompts.type.unknown')
  return PROMPT_TYPES.includes(type) ? i18n.t(`management_ui.prompts.type.${type}`) : type.replace(/_/g, ' ')
}

function usageAreaLabel(area: string): string {
  return i18n.t(`management_ui.prompts.area.${area}`)
}

function usageArea(assetKey: string, type: PromptType | null): string {
  if (isAutoResearchAsset(assetKey)) return 'research'
  if (assetKey.startsWith('retrieval.')) return 'retrieval'
  if (assetKey.startsWith('agent_template.') || assetKey.startsWith('agent.')) return 'agents'
  if (type === 'workflow') return 'workflow'
  return 'prompt'
}

function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'muted' | 'outline' | 'secondary' {
  if (status === 'approved' || status === 'active') return 'success'
  if (status === 'draft' || status === 'candidate' || status === 'testing') return 'warning'
  if (status === 'deprecated' || status === 'disabled') return 'muted'
  if (status === 'archived') return 'outline'
  return 'secondary'
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : i18n.t('management_ui.prompts.none')
}

function promptText(version: PromptVersion | null): string {
  const content = version?.content
  if (!content) return ''
  if (Array.isArray(content.messages) && content.messages.length > 0) {
    return content.messages
      .map(message => `[${message.role}]\n${message.content}`)
      .join('\n\n')
  }
  if (typeof content.template === 'string') return content.template
  return JSON.stringify(content, null, 2)
}

function latestVersion(versions: PromptVersion[]): PromptVersion | null {
  return versions.slice().sort((a, b) => b.version - a.version)[0] ?? null
}

function parseMetricsJson(value: string): Record<string, unknown> {
  const trimmed = value.trim()
  if (!trimmed) return {}
  const parsed = JSON.parse(trimmed) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(i18n.t('management_ui.prompts.metrics_object'))
  }
  return parsed as Record<string, unknown>
}

export default function PromptLibraryPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  const [assets, setAssets] = useState<PromptAssetSummary[]>([])
  const [selectedAsset, setSelectedAsset] = useState<PromptAssetDetail | null>(null)
  const [versions, setVersions] = useState<PromptVersion[]>([])
  const [deployments, setDeployments] = useState<PromptDeploymentRef[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<PromptType | ''>('')
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [evalStatus, setEvalStatus] = useState<'passed' | 'failed' | 'blocked'>('passed')
  const [evalSuiteName, setEvalSuiteName] = useState('manual_prompt_review')
  const [evaluatorVersion, setEvaluatorVersion] = useState('manual.v1')
  const [evalMetricsJson, setEvalMetricsJson] = useState('{\n  "score": 1\n}')
  const activeView = searchParams.get('view') === 'bundles' ? 'bundles' : 'assets'
  const requestedBundleId = searchParams.get('bundle')
  const selectedBundleId = requestedBundleId === AUTO_RESEARCH_BUNDLE_ID ? requestedBundleId : AUTO_RESEARCH_BUNDLE_ID
  const selectedAssetKey = searchParams.get('asset') ?? ''
  // The list stays clickable while an action runs; the refresh that follows
  // the action must not put the previous asset back into the detail panel.
  const currentAssetKey = useRef(selectedAssetKey)
  currentAssetKey.current = selectedAssetKey

  const loadAssets = useCallback(async () => {
    setLoadingAssets(true)
    try {
      const next = await promptsApi.listAssets()
      setAssets(next)
    } catch (error) {
      toast.error(errMsg(error))
      setAssets([])
    } finally {
      setLoadingAssets(false)
    }
  }, [])

  useEffect(() => { void loadAssets() }, [loadAssets])

  useEffect(() => {
    if (activeView !== 'assets') return
    if (loadingAssets || assets.length === 0) return
    const requested = selectedAssetKey && assets.some(asset => asset.asset_key === selectedAssetKey)
      ? selectedAssetKey
      : assets[0].asset_key
    if (requested !== selectedAssetKey) {
      setSearchParams({ asset: requested }, { replace: true })
    }
  }, [activeView, assets, loadingAssets, selectedAssetKey, setSearchParams])

  useEffect(() => {
    if (activeView !== 'assets' || !selectedAssetKey) {
      setSelectedAsset(null)
      setVersions([])
      setDeployments([])
      setSelectedVersionId('')
      setLoadingDetail(false)
      return
    }
    let cancelled = false
    setSelectedAsset(null)
    setVersions([])
    setDeployments([])
    setSelectedVersionId('')
    setLoadingDetail(true)
    Promise.all([
      promptsApi.getAsset(selectedAssetKey),
      promptsApi.listVersions(selectedAssetKey),
      promptsApi.listDeployments(selectedAssetKey, { include_history: true }),
    ])
      .then(([asset, nextVersions, nextDeployments]) => {
        if (cancelled) return
        const ordered = nextVersions.slice().sort((a, b) => b.version - a.version)
        setSelectedAsset(asset)
        setVersions(ordered)
        setDeployments(nextDeployments)
        const current = ordered.find(version => version.id === asset.current_system_version_id) ?? ordered[0] ?? null
        setSelectedVersionId(existing => ordered.some(version => version.id === existing) ? existing : current?.id ?? '')
      })
      .catch(error => {
        if (cancelled) return
        toast.error(errMsg(error))
        setSelectedAsset(null)
        setVersions([])
        setDeployments([])
        setSelectedVersionId('')
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => { cancelled = true }
  }, [activeView, selectedAssetKey])

  const refreshSelectedAssetDetail = useCallback(async () => {
    const assetKey = selectedAssetKey
    if (!assetKey) return
    const [asset, nextVersions, nextDeployments] = await Promise.all([
      promptsApi.getAsset(assetKey),
      promptsApi.listVersions(assetKey),
      promptsApi.listDeployments(assetKey, { include_history: true }),
    ])
    if (currentAssetKey.current !== assetKey) return
    const ordered = nextVersions.slice().sort((a, b) => b.version - a.version)
    setSelectedAsset(asset)
    setVersions(ordered)
    setDeployments(nextDeployments)
    setSelectedVersionId(existing => ordered.some(version => version.id === existing) ? existing : ordered[0]?.id ?? '')
  }, [selectedAssetKey])

  const filteredAssets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return assets.filter(asset => {
      if (typeFilter && asset.prompt_type !== typeFilter) return false
      if (!needle) return true
      const haystack = [
        asset.asset_key,
        asset.display_name,
        asset.description ?? '',
        asset.prompt_type ?? '',
        usageArea(asset.asset_key, asset.prompt_type),
        asset.owner_scope_type,
      ].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [assets, query, typeFilter])

  const selectedVersion = versions.find(version => version.id === selectedVersionId) ?? latestVersion(versions)
  const rawPrompt = promptText(selectedVersion)
  const autoResearchAssets = useMemo(
    () => assets
      .filter(asset => isAutoResearchAsset(asset.asset_key))
      .sort((a, b) => a.asset_key.localeCompare(b.asset_key)),
    [assets],
  )
  const activeProductionDeployments = useMemo(
    () => deployments
      .filter(ref => ref.status === 'active' && ref.label === 'production')
      .sort((a, b) => DEPLOYMENT_SCOPE_ORDER.indexOf(a.scope_type) - DEPLOYMENT_SCOPE_ORDER.indexOf(b.scope_type)),
    [deployments],
  )
  const defaultProductionDeployment = activeProductionDeployments[0] ?? null
  const rollbackAvailability = productionRollbackAvailability(defaultProductionDeployment, selectedVersion)
  const canEvaluateSelected = selectedVersion?.status === 'candidate' || selectedVersion?.status === 'testing'
  const canStageSelected = selectedVersion
    ? selectedVersion.status === 'candidate' || selectedVersion.status === 'testing' || selectedVersion.status === 'approved'
    : false
  const canPromoteSelected = canEvaluateSelected

  function setLibraryView(view: 'assets' | 'bundles') {
    const next = new URLSearchParams(searchParams)
    if (view === 'bundles') {
      next.set('view', 'bundles')
      next.set('bundle', selectedBundleId)
    } else {
      next.delete('view')
      next.delete('bundle')
    }
    setSearchParams(next)
  }

  function selectAsset(assetKey: string) {
    const next = new URLSearchParams(searchParams)
    next.delete('view')
    next.delete('bundle')
    next.set('asset', assetKey)
    setSearchParams(next)
  }

  function selectBundle(bundleId: string) {
    const next = new URLSearchParams(searchParams)
    next.set('view', 'bundles')
    next.set('bundle', bundleId)
    setSearchParams(next)
  }

  async function handleRecordEvaluation() {
    if (!selectedAsset || !selectedVersion) return
    setActionLoading('evaluate')
    try {
      const metrics = parseMetricsJson(evalMetricsJson)
      await promptsApi.evaluate(selectedAsset.asset_key, {
        version_id: selectedVersion.id,
        eval_suite_ref: { kind: 'manual_prompt_review', name: evalSuiteName.trim() || 'manual_prompt_review' },
        evaluator_version: evaluatorVersion.trim() || 'manual.v1',
        status: evalStatus,
        metrics,
      })
      toast.success(t('management_ui.prompts.evaluation_recorded'))
      await refreshSelectedAssetDetail()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setActionLoading(null)
    }
  }

  async function handleStageDeployment() {
    if (!selectedAsset || !selectedVersion) return
    setActionLoading('stage')
    try {
      // A built-in version is staged for this Space; any other version where it lives.
      await promptsApi.setDeployment(selectedAsset.asset_key, 'staging', selectedVersion.scope_type === 'system'
        ? { version_id: selectedVersion.id, scope_type: 'space', scope_id: activeSpaceId }
        : { version_id: selectedVersion.id, scope_type: selectedVersion.scope_type, scope_id: selectedVersion.scope_id })
      toast.success(t('management_ui.prompts.staging_updated'))
      await refreshSelectedAssetDetail()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setActionLoading(null)
    }
  }

  async function handleCreatePromotionProposal() {
    if (!selectedAsset || !selectedVersion) return
    setActionLoading('promote')
    try {
      const proposal = await promptsApi.promote(selectedAsset.asset_key, {
        version_id: selectedVersion.id,
        label: 'production',
        scope_type: selectedVersion.scope_type,
        scope_id: selectedVersion.scope_id,
      })
      toast.success(t('management_ui.prompts.promotion_created', { id: proposal.proposal_id }))
      await refreshSelectedAssetDetail()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setActionLoading(null)
    }
  }

  async function handleRollbackProduction() {
    if (!selectedAsset || !defaultProductionDeployment) return
    if (!window.confirm(t('management_ui.prompts.rollback_confirm'))) return
    setActionLoading('rollback')
    try {
      await promptsApi.rollback(selectedAsset.asset_key, {
        label: 'production',
        scope_type: defaultProductionDeployment.scope_type,
        scope_id: defaultProductionDeployment.scope_id,
        // A deployment a rollback wrote has no default "previous": name the version.
        ...(defaultProductionDeployment.rolled_back_from_ref_id && selectedVersion ? { version_id: selectedVersion.id } : {}),
      })
      toast.success(t('management_ui.prompts.rolled_back'))
      await refreshSelectedAssetDetail()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t('management_ui.prompts.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('management_ui.prompts.subtitle')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAssets} disabled={loadingAssets}>
          {loadingAssets ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          <span className="ml-1">{t('management_ui.prompts.refresh')}</span>
        </Button>
      </div>

      <Tabs value={activeView} onValueChange={value => setLibraryView(value === 'bundles' ? 'bundles' : 'assets')}>
        <TabsList>
          <TabsTrigger value="assets">{t('management_ui.prompts.assets')}</TabsTrigger>
          <TabsTrigger value="bundles">{t('management_ui.prompts.bundles')}</TabsTrigger>
        </TabsList>

        <TabsContent value="assets">
          <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-3">
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <Search className="size-4 text-muted-foreground" />
                  <CardTitle>{t('management_ui.prompts.assets')}</CardTitle>
                </div>
                <div className="space-y-2">
                  <Input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder={t('management_ui.prompts.search_placeholder')}
                  />
                  <Select
                    value={typeFilter}
                    options={PROMPT_TYPES.map(type => ({ value: type, label: promptTypeLabel(type) }))}
                    onChange={value => setTypeFilter(value as PromptType | '')}
                  />
                </div>
                {loadingAssets ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> {t('management_ui.prompts.loading_prompts')}
                  </div>
                ) : filteredAssets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('management_ui.prompts.no_match')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {filteredAssets.map(asset => {
                      const selected = asset.asset_key === selectedAssetKey
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          onClick={() => selectAsset(asset.asset_key)}
                          className={[
                            'w-full rounded-md border px-3 py-2 text-left transition-colors',
                            selected ? 'border-primary bg-accent/40' : 'border-border hover:bg-muted/50',
                          ].join(' ')}
                        >
                          <div className="flex min-w-0 items-start justify-between gap-2">
                            <span className="min-w-0 truncate text-sm font-medium">{asset.display_name}</span>
                            <Badge variant={statusVariant(asset.status)}>{asset.status}</Badge>
                          </div>
                          <div className="mt-1 min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                            {asset.asset_key}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Badge variant="outline">{promptTypeLabel(asset.prompt_type)}</Badge>
                            <Badge variant="muted">{usageAreaLabel(usageArea(asset.asset_key, asset.prompt_type))}</Badge>
                            <Badge variant="muted">{asset.owner_scope_type}</Badge>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </Card>
            </div>

            <div className="space-y-4 min-w-0">
              {loadingDetail ? (
                <Card>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> {t('management_ui.prompts.loading_details')}
                  </div>
                </Card>
              ) : !selectedAsset ? (
                <Card>
                  <CardTitle>{t('management_ui.prompts.select_prompt')}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{t('management_ui.prompts.select_prompt_hint')}</p>
                </Card>
              ) : (
                <>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{selectedAsset.display_name}</CardTitle>
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{selectedAsset.asset_key}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusBadge status={selectedAsset.status} />
                    <Badge variant="outline">{promptTypeLabel(selectedAsset.prompt_type)}</Badge>
                    <Badge variant="muted">{selectedAsset.owner_scope_type}</Badge>
                  </div>
                </div>
                {selectedAsset.description && (
                  <p className="text-sm text-muted-foreground">{selectedAsset.description}</p>
                )}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.current_system_version')}</div>
                    <div className="break-all font-mono text-xs">{selectedAsset.current_system_version_id ?? t('management_ui.prompts.none')}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.versions')}</div>
                    <div className="text-sm">{versions.length}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.updated')}</div>
                    <div className="text-sm">{formatDateTime(selectedAsset.updated_at)}</div>
                  </div>
                </div>
              </Card>

              <Tabs defaultValue="preview">
                <TabsList className="w-full flex-wrap justify-start gap-1 h-auto">
                  <TabsTrigger value="preview">{t('management_ui.prompts.tab_preview')}</TabsTrigger>
                  <TabsTrigger value="versions">{t('management_ui.prompts.versions')}</TabsTrigger>
                  <TabsTrigger value="evaluation">{t('management_ui.prompts.evaluation')}</TabsTrigger>
                  <TabsTrigger value="deployment">{t('management_ui.prompts.deployment')}</TabsTrigger>
                  <TabsTrigger value="lineage">{t('management_ui.prompts.tab_lineage')}</TabsTrigger>
                </TabsList>

                <TabsContent value="preview">
                  <Card className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <CardTitle>{t('management_ui.prompts.content_title')}</CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('management_ui.prompts.content_hint')}
                        </p>
                      </div>
                      <Select
                        value={selectedVersion?.id ?? ''}
                        options={versions.map(version => ({
                          value: version.id,
                          label: `v${version.version} - ${version.status} - ${shortHash(version.content_hash)}`,
                        }))}
                        onChange={setSelectedVersionId}
                      />
                    </div>
                    <pre className="max-h-[520px] overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 whitespace-pre-wrap">
                      {rawPrompt || t('management_ui.prompts.no_content')}
                    </pre>
                  </Card>
                </TabsContent>

                <TabsContent value="versions">
                  <Card className="space-y-3">
                    <CardTitle>{t('management_ui.prompts.version_timeline')}</CardTitle>
                    <div className="space-y-2">
                      {versions.map(version => (
                        <button
                          key={version.id}
                          type="button"
                          onClick={() => setSelectedVersionId(version.id)}
                          className={[
                            'w-full rounded-md border px-3 py-2 text-left',
                            selectedVersion?.id === version.id ? 'border-primary bg-accent/40' : 'border-border hover:bg-muted/50',
                          ].join(' ')}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">v{version.version}</span>
                            <div className="flex flex-wrap gap-1.5">
                              <Badge variant={statusVariant(version.status)}>{version.status}</Badge>
                              <Badge variant="outline">{version.source}</Badge>
                              {version.stale_parent && <Badge variant="warning">{t('management_ui.prompts.stale_parent')}</Badge>}
                            </div>
                          </div>
                          <div className="mt-1 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                            <span className="break-all font-mono">{t('management_ui.prompts.hash', { hash: shortHash(version.content_hash) })}</span>
                            <span>{formatDateTime(version.created_at)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </Card>
                </TabsContent>

                <TabsContent value="evaluation">
                  <Card className="space-y-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="size-4 text-muted-foreground" />
                      <CardTitle>{t('management_ui.prompts.evaluation')}</CardTitle>
                    </div>
                    {selectedVersion?.eval_summary_json ? (
                      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
                        {JSON.stringify(selectedVersion.eval_summary_json, null, 2)}
                      </pre>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t('management_ui.prompts.no_evaluation')}
                      </p>
                    )}
                    <div className="grid gap-2 md:grid-cols-3">
                      <Input
                        value={evalSuiteName}
                        onChange={event => setEvalSuiteName(event.target.value)}
                        placeholder={t('management_ui.prompts.evaluation_suite')}
                      />
                      <Input
                        value={evaluatorVersion}
                        onChange={event => setEvaluatorVersion(event.target.value)}
                        placeholder={t('management_ui.prompts.evaluator_version')}
                      />
                      <Select
                        value={evalStatus}
                        options={EVALUATION_STATUSES.map(status => ({ value: status, label: t(`management_ui.prompts.eval_status.${status}`) }))}
                        onChange={value => setEvalStatus(value as 'passed' | 'failed' | 'blocked')}
                      />
                    </div>
                    <Textarea
                      value={evalMetricsJson}
                      onChange={event => setEvalMetricsJson(event.target.value)}
                      rows={4}
                      placeholder='{"score": 1}'
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={handleRecordEvaluation}
                        disabled={!canEvaluateSelected || actionLoading === 'evaluate'}
                        title={canEvaluateSelected ? t('management_ui.prompts.record_evaluation_hint') : t('management_ui.prompts.record_evaluation_blocked')}
                      >
                        {actionLoading === 'evaluate' && <Loader2 className="size-4 animate-spin" />}
                        {t('management_ui.prompts.record_evaluation')}
                      </Button>
                    </div>
                  </Card>
                </TabsContent>

                <TabsContent value="deployment">
                  <Card className="space-y-3">
                    <div className="flex items-center gap-2">
                      <GitBranch className="size-4 text-muted-foreground" />
                      <CardTitle>{t('management_ui.prompts.deployment')}</CardTitle>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.active_production_scope')}</div>
                        <div className="mt-1 break-all font-mono text-xs">
                          {defaultProductionDeployment
                            ? `${defaultProductionDeployment.scope_type}${defaultProductionDeployment.scope_id ? `:${defaultProductionDeployment.scope_id}` : ''}`
                            : t('management_ui.prompts.none')}
                        </div>
                      </div>
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.selected_version')}</div>
                        <div className="mt-1 break-all font-mono text-xs">{selectedVersion?.id ?? t('management_ui.prompts.none')}</div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {deployments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('management_ui.prompts.no_deployments')}</p>
                      ) : deployments.map(ref => (
                        <div key={ref.id} className="rounded-md border border-border px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={ref.label === 'production' ? 'success' : 'outline'}>{ref.label}</Badge>
                              <Badge variant={statusVariant(ref.status)}>{ref.status}</Badge>
                              <Badge variant="muted">{ref.scope_type}</Badge>
                            </div>
                            <span className="text-xs text-muted-foreground">{formatDateTime(ref.updated_at)}</span>
                          </div>
                          <div className="mt-1 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                            <span className="break-all font-mono">{t('management_ui.prompts.ref_version', { id: ref.version_id })}</span>
                            <span className="break-all font-mono">{t('management_ui.prompts.ref_scope', { id: ref.scope_id ?? 'system' })}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>
                          {t('management_ui.prompts.production_gate')}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={handleStageDeployment}
                        disabled={!canStageSelected || actionLoading === 'stage'}
                        title={canStageSelected ? t('management_ui.prompts.stage_hint') : t('management_ui.prompts.stage_blocked')}
                      >
                        {actionLoading === 'stage' && <Loader2 className="size-4 animate-spin" />}
                        {t('management_ui.prompts.deploy_staging')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleCreatePromotionProposal}
                        disabled={!canPromoteSelected || actionLoading === 'promote'}
                        title={canPromoteSelected ? t('management_ui.prompts.promote_hint') : t('management_ui.prompts.promote_blocked')}
                      >
                        {actionLoading === 'promote' && <Loader2 className="size-4 animate-spin" />}
                        {t('management_ui.prompts.propose_production')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleRollbackProduction}
                        disabled={!rollbackAvailability.available || actionLoading === 'rollback'}
                        title={rollbackAvailability.hint}
                      >
                        {actionLoading === 'rollback' ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                        {t('management_ui.prompts.roll_back')}
                      </Button>
                    </div>
                  </Card>
                </TabsContent>

                <TabsContent value="lineage">
                  <Card className="space-y-3">
                    <div className="flex items-center gap-2">
                      <FileCode2 className="size-4 text-muted-foreground" />
                      <CardTitle>{t('management_ui.prompts.usage_lineage')}</CardTitle>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {isAutoResearchAsset(selectedAsset.asset_key) && (
                        <div className="rounded-md border border-border px-3 py-2 sm:col-span-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.prompt_bundle')}</div>
                              <div className="mt-1 text-sm">{t('management_ui.prompts.auto_research')}</div>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={() => selectBundle(AUTO_RESEARCH_BUNDLE_ID)}>
                              {t('management_ui.prompts.open_bundle')}
                            </Button>
                          </div>
                        </div>
                      )}
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.usage_area')}</div>
                        <div className="mt-1 text-sm">{usageAreaLabel(usageArea(selectedAsset.asset_key, selectedAsset.prompt_type))}</div>
                      </div>
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">{t('management_ui.prompts.owner_scope')}</div>
                        <div className="mt-1 break-all text-sm">
                          {selectedAsset.owner_scope_type}{selectedAsset.owner_scope_id ? `:${selectedAsset.owner_scope_id}` : ''}
                        </div>
                      </div>
                    </div>
                    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
                      {JSON.stringify(selectedAsset.metadata_json, null, 2)}
                    </pre>
                  </Card>
                </TabsContent>
              </Tabs>
                </>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="bundles">
          <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-3">
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <FileCode2 className="size-4 text-muted-foreground" />
                  <CardTitle>{t('management_ui.prompts.bundles')}</CardTitle>
                </div>
                <button
                  type="button"
                  onClick={() => selectBundle(AUTO_RESEARCH_BUNDLE_ID)}
                  className={[
                    'w-full rounded-md border px-3 py-2 text-left transition-colors',
                    selectedBundleId === AUTO_RESEARCH_BUNDLE_ID ? 'border-primary bg-accent/40' : 'border-border hover:bg-muted/50',
                  ].join(' ')}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{t('management_ui.prompts.auto_research')}</span>
                    <Badge variant="outline">{t('management_ui.prompts.bundle')}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('management_ui.prompts.workflow_prompts', { count: autoResearchAssets.length })} · {t('management_ui.prompts.stages', { count: AUTO_RESEARCH_STAGES.length })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="muted">{usageAreaLabel('workflow')}</Badge>
                    <Badge variant="muted">{usageAreaLabel('research')}</Badge>
                  </div>
                </button>
              </Card>
            </div>

            <div className="space-y-4 min-w-0">
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>{t('management_ui.prompts.auto_research')}</CardTitle>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {t('management_ui.prompts.auto_research_hint')}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{t('management_ui.prompts.prompts_count', { count: autoResearchAssets.length })}</Badge>
                    <Badge variant="outline">{t('management_ui.prompts.stages', { count: AUTO_RESEARCH_STAGES.length })}</Badge>
                  </div>
                </div>
                <div className="rounded-md border border-border px-3 py-2 text-sm">
                  {t('management_ui.prompts.bundle_scope_note')}
                </div>
              </Card>

              <Card className="space-y-3">
                <CardTitle>{t('management_ui.prompts.runtime_shape')}</CardTitle>
                <div className="overflow-x-auto">
                  <div className="min-w-[720px] divide-y divide-border rounded-md border border-border">
                    <div className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(220px,1fr)] gap-3 px-3 py-2 text-[11px] font-medium uppercase text-muted-foreground">
                      <div>{t('management_ui.prompts.col_type')}</div>
                      <div>{t('management_ui.prompts.col_item')}</div>
                      <div>{t('management_ui.prompts.col_ownership')}</div>
                    </div>
                    <div className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(220px,1fr)] gap-3 px-3 py-2 text-sm">
                      <div className="font-mono text-xs text-muted-foreground">prompt</div>
                      <div className="min-w-0">
                        <div className="font-medium">{t('management_ui.prompts.run_templates')}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{t('management_ui.prompts.run_templates_detail')}</div>
                      </div>
                      <div className="min-w-0">
                        <div>{t('management_ui.prompts.editable_assets')}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{t('management_ui.prompts.editable_assets_detail')}</div>
                      </div>
                    </div>
                    {AUTO_RESEARCH_STAGES.map(stage => (
                      <div key={stage.id} className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(220px,1fr)] gap-3 px-3 py-2 text-sm">
                        <div className="font-mono text-xs text-muted-foreground">stage</div>
                        <div className="min-w-0">
                          <div className="font-medium">{t(`management_ui.prompts.stage.${stage.key}.label`)}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{t(`management_ui.prompts.stage.${stage.key}.detail`)}</div>
                        </div>
                        <div className="min-w-0">
                          <div>{t('management_ui.prompts.not_prompt_asset')}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{stage.id}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card className="space-y-3">
                <CardTitle>{t('management_ui.prompts.prompt_assets')}</CardTitle>
                {loadingAssets ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> {t('management_ui.prompts.loading_prompts')}
                  </div>
                ) : autoResearchAssets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('management_ui.prompts.no_auto_research')}</p>
                ) : (
                  <div className="space-y-2">
                    {autoResearchAssets.map(asset => (
                      <div key={asset.id} className="rounded-md border border-border px-3 py-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{asset.display_name}</div>
                            <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{asset.asset_key}</div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant={statusVariant(asset.status)}>{asset.status}</Badge>
                            <Badge variant="outline">{promptTypeLabel(asset.prompt_type)}</Badge>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs text-muted-foreground">
                            {t('management_ui.prompts.current_system_version')}: <span className="font-mono">{shortHash(asset.current_system_version_id)}</span>
                          </div>
                          <Button type="button" size="sm" variant="outline" onClick={() => selectAsset(asset.asset_key)}>
                            {t('management_ui.prompts.open_asset')}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * Whether the production deployment in view can be rolled back from here.
 * The built-in baseline is release content, so it has nothing to roll back
 * in a Space. A deployment a rollback wrote rolls back only to a version the
 * person names: the selected approved one.
 */
function productionRollbackAvailability(
  deployment: PromptDeploymentRef | null | undefined,
  selectedVersion: PromptVersion | null | undefined,
): { available: boolean; hint: string } {
  if (!deployment) return { available: false, hint: i18n.t('management_ui.prompts.rollback_none') }
  if (deployment.scope_type === 'system') {
    return { available: false, hint: i18n.t('management_ui.prompts.rollback_builtin') }
  }
  if (deployment.rolled_back_from_ref_id) {
    return selectedVersion?.status === 'approved' && selectedVersion.id !== deployment.version_id
      ? { available: true, hint: i18n.t('management_ui.prompts.rollback_to_selected', { version: selectedVersion.version }) }
      : { available: false, hint: i18n.t('management_ui.prompts.rollback_select_version') }
  }
  return { available: true, hint: i18n.t('management_ui.prompts.rollback_previous') }
}
