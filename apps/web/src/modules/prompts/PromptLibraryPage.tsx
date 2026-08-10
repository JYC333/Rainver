import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, FileCode2, GitBranch, Loader2, RefreshCw, RotateCcw, Search, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { promptsApi } from '../../api/client'
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

const PROMPT_TYPE_OPTIONS: Array<{ value: PromptType | ''; label: string }> = [
  { value: '', label: 'All prompt types' },
  { value: 'agent_system', label: 'Agent system' },
  { value: 'chat', label: 'Chat' },
  { value: 'retrieval_query', label: 'Retrieval query' },
  { value: 'retrieval_rerank', label: 'Retrieval rerank' },
  { value: 'retrieval_synthesis', label: 'Retrieval synthesis' },
  { value: 'text', label: 'Text' },
  { value: 'workflow', label: 'Workflow' },
]

const EVALUATION_STATUS_OPTIONS: Array<{ value: 'passed' | 'failed' | 'blocked'; label: string }> = [
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
  { value: 'blocked', label: 'Blocked' },
]

const DEPLOYMENT_SCOPE_ORDER: PromptAssetScopeType[] = ['project', 'agent', 'user', 'space', 'system']
const AUTO_RESEARCH_BUNDLE_ID = 'auto_research'
const AUTO_RESEARCH_ASSET_PREFIX = 'workflow.research.'

const AUTO_RESEARCH_CAPABILITIES = [
  { id: 'research.source_collect', label: 'Source Collection', detail: 'Collect candidate sources from project sources, manual URLs, or runtime-native source tools.' },
  { id: 'research.source_summarize', label: 'Source Summarization', detail: 'Summarize source material with citations and stated uncertainty.' },
  { id: 'research.evidence_extract', label: 'Evidence Extraction', detail: 'Extract structured evidence, claims, and provenance from source material.' },
  { id: 'research.brief_synthesize', label: 'Brief Synthesis', detail: 'Synthesize cited evidence into a concise research brief.' },
  { id: 'research.idea_generate', label: 'Idea Generation', detail: 'Generate candidate ideas, questions, or follow-up directions from research evidence.' },
] as const

function isAutoResearchAsset(assetKey: string): boolean {
  return assetKey.startsWith(AUTO_RESEARCH_ASSET_PREFIX)
}

function promptTypeLabel(type: PromptType | null | undefined): string {
  if (!type) return 'Unknown'
  return PROMPT_TYPE_OPTIONS.find(option => option.value === type)?.label ?? type.replace(/_/g, ' ')
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
  return value ? value.slice(0, 12) : 'none'
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
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
    throw new Error('Metrics JSON must be an object.')
  }
  return parsed as Record<string, unknown>
}

export default function PromptLibraryPage() {
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
    if (!selectedAssetKey) return
    const [asset, nextVersions, nextDeployments] = await Promise.all([
      promptsApi.getAsset(selectedAssetKey),
      promptsApi.listVersions(selectedAssetKey),
      promptsApi.listDeployments(selectedAssetKey, { include_history: true }),
    ])
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
      toast.success('Evaluation evidence recorded.')
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
      await promptsApi.setDeployment(selectedAsset.asset_key, 'staging', {
        version_id: selectedVersion.id,
        scope_type: selectedVersion.scope_type,
        scope_id: selectedVersion.scope_id,
      })
      toast.success('Staging deployment updated.')
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
        reason: `Promote ${selectedAsset.asset_key} v${selectedVersion.version} to production`,
      })
      toast.success(`Promotion proposal created: ${proposal.id}`)
      await refreshSelectedAssetDetail()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setActionLoading(null)
    }
  }

  async function handleRollbackProduction() {
    if (!selectedAsset || !defaultProductionDeployment) return
    if (!window.confirm('Roll back this production deployment to the previous immutable version?')) return
    setActionLoading('rollback')
    try {
      await promptsApi.rollback(selectedAsset.asset_key, {
        label: 'production',
        scope_type: defaultProductionDeployment.scope_type,
        scope_id: defaultProductionDeployment.scope_id,
      })
      toast.success('Production deployment rolled back.')
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
          <h1 className="text-xl font-semibold tracking-tight">Prompt Library</h1>
          <p className="text-sm text-muted-foreground">
            Central registry for runtime prompts, versions, evaluation state, and deployment references.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAssets} disabled={loadingAssets}>
          {loadingAssets ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          <span className="ml-1">Refresh</span>
        </Button>
      </div>

      <Tabs value={activeView} onValueChange={value => setLibraryView(value === 'bundles' ? 'bundles' : 'assets')}>
        <TabsList>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="bundles">Bundles</TabsTrigger>
        </TabsList>

        <TabsContent value="assets">
          <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-3">
              <Card className="space-y-3">
                <div className="flex items-center gap-2">
                  <Search className="size-4 text-muted-foreground" />
                  <CardTitle>Assets</CardTitle>
                </div>
                <div className="space-y-2">
                  <Input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search asset key, title, area..."
                  />
                  <Select
                    value={typeFilter}
                    options={PROMPT_TYPE_OPTIONS}
                    onChange={value => setTypeFilter(value as PromptType | '')}
                  />
                </div>
                {loadingAssets ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading prompts...
                  </div>
                ) : filteredAssets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No prompt assets match the current filter.</p>
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
                            <Badge variant="muted">{usageArea(asset.asset_key, asset.prompt_type)}</Badge>
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
                    <Loader2 className="size-4 animate-spin" /> Loading prompt details...
                  </div>
                </Card>
              ) : !selectedAsset ? (
                <Card>
                  <CardTitle>Select a prompt</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">Select an asset to inspect its versions and governance state.</p>
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
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">Current system version</div>
                    <div className="break-all font-mono text-xs">{selectedAsset.current_system_version_id ?? 'none'}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">Versions</div>
                    <div className="text-sm">{versions.length}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">Updated</div>
                    <div className="text-sm">{formatDate(selectedAsset.updated_at)}</div>
                  </div>
                </div>
              </Card>

              <Tabs defaultValue="preview">
                <TabsList className="w-full flex-wrap justify-start gap-1 h-auto">
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                  <TabsTrigger value="versions">Versions</TabsTrigger>
                  <TabsTrigger value="evaluation">Evaluation</TabsTrigger>
                  <TabsTrigger value="deployment">Deployment</TabsTrigger>
                  <TabsTrigger value="lineage">Lineage</TabsTrigger>
                </TabsList>

                <TabsContent value="preview">
                  <Card className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <CardTitle>Prompt Content</CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Raw content from the selected immutable version.
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
                      {rawPrompt || 'No prompt content is available for this version.'}
                    </pre>
                  </Card>
                </TabsContent>

                <TabsContent value="versions">
                  <Card className="space-y-3">
                    <CardTitle>Version Timeline</CardTitle>
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
                              {version.stale_parent && <Badge variant="warning">stale parent</Badge>}
                            </div>
                          </div>
                          <div className="mt-1 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                            <span className="break-all font-mono">hash {shortHash(version.content_hash)}</span>
                            <span>{formatDate(version.created_at)}</span>
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
                      <CardTitle>Evaluation</CardTitle>
                    </div>
                    {selectedVersion?.eval_summary_json ? (
                      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
                        {JSON.stringify(selectedVersion.eval_summary_json, null, 2)}
                      </pre>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No evaluation evidence is attached to the selected version.
                      </p>
                    )}
                    <div className="grid gap-2 md:grid-cols-3">
                      <Input
                        value={evalSuiteName}
                        onChange={event => setEvalSuiteName(event.target.value)}
                        placeholder="Evaluation suite"
                      />
                      <Input
                        value={evaluatorVersion}
                        onChange={event => setEvaluatorVersion(event.target.value)}
                        placeholder="Evaluator version"
                      />
                      <Select
                        value={evalStatus}
                        options={EVALUATION_STATUS_OPTIONS}
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
                        title={canEvaluateSelected ? 'Record external or manual evaluation evidence for this version.' : 'Evaluation evidence can only be recorded for candidate or testing versions.'}
                      >
                        {actionLoading === 'evaluate' && <Loader2 className="size-4 animate-spin" />}
                        Record evaluation
                      </Button>
                    </div>
                  </Card>
                </TabsContent>

                <TabsContent value="deployment">
                  <Card className="space-y-3">
                    <div className="flex items-center gap-2">
                      <GitBranch className="size-4 text-muted-foreground" />
                      <CardTitle>Deployment</CardTitle>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">Active production scope</div>
                        <div className="mt-1 break-all font-mono text-xs">
                          {defaultProductionDeployment
                            ? `${defaultProductionDeployment.scope_type}${defaultProductionDeployment.scope_id ? `:${defaultProductionDeployment.scope_id}` : ''}`
                            : 'none'}
                        </div>
                      </div>
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">Selected version</div>
                        <div className="mt-1 break-all font-mono text-xs">{selectedVersion?.id ?? 'none'}</div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {deployments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No deployment refs are visible for this prompt.</p>
                      ) : deployments.map(ref => (
                        <div key={ref.id} className="rounded-md border border-border px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={ref.label === 'production' ? 'success' : 'outline'}>{ref.label}</Badge>
                              <Badge variant={statusVariant(ref.status)}>{ref.status}</Badge>
                              <Badge variant="muted">{ref.scope_type}</Badge>
                            </div>
                            <span className="text-xs text-muted-foreground">{formatDate(ref.updated_at)}</span>
                          </div>
                          <div className="mt-1 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                            <span className="break-all font-mono">version {ref.version_id}</span>
                            <span className="break-all font-mono">scope {ref.scope_id ?? 'system'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>
                          Production changes require evaluation evidence and the scoped proposal approval gate.
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={handleStageDeployment}
                        disabled={!canStageSelected || actionLoading === 'stage'}
                        title={canStageSelected ? 'Point the staging label at the selected immutable version.' : 'Staging requires a candidate, testing, or approved version.'}
                      >
                        {actionLoading === 'stage' && <Loader2 className="size-4 animate-spin" />}
                        Deploy staging
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleCreatePromotionProposal}
                        disabled={!canPromoteSelected || actionLoading === 'promote'}
                        title={canPromoteSelected ? 'Create a production promotion proposal. Approval applies the production deployment ref.' : 'Production promotion proposals start from candidate or testing versions.'}
                      >
                        {actionLoading === 'promote' && <Loader2 className="size-4 animate-spin" />}
                        Propose production
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleRollbackProduction}
                        disabled={!defaultProductionDeployment || actionLoading === 'rollback'}
                        title={defaultProductionDeployment ? 'Roll back the active production deployment to its previous immutable version.' : 'No active production deployment ref is visible.'}
                      >
                        {actionLoading === 'rollback' ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                        Roll back
                      </Button>
                    </div>
                  </Card>
                </TabsContent>

                <TabsContent value="lineage">
                  <Card className="space-y-3">
                    <div className="flex items-center gap-2">
                      <FileCode2 className="size-4 text-muted-foreground" />
                      <CardTitle>Usage And Lineage</CardTitle>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {isAutoResearchAsset(selectedAsset.asset_key) && (
                        <div className="rounded-md border border-border px-3 py-2 sm:col-span-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[11px] font-medium uppercase text-muted-foreground">Prompt bundle</div>
                              <div className="mt-1 text-sm">Auto Research</div>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={() => selectBundle(AUTO_RESEARCH_BUNDLE_ID)}>
                              Open bundle
                            </Button>
                          </div>
                        </div>
                      )}
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">Usage area</div>
                        <div className="mt-1 text-sm">{usageArea(selectedAsset.asset_key, selectedAsset.prompt_type)}</div>
                      </div>
                      <div className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">Owner scope</div>
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
                  <CardTitle>Bundles</CardTitle>
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
                    <span className="min-w-0 truncate text-sm font-medium">Auto Research</span>
                    <Badge variant="outline">Bundle</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {autoResearchAssets.length} workflow prompts · {AUTO_RESEARCH_CAPABILITIES.length} capabilities
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="muted">workflow</Badge>
                    <Badge variant="muted">research</Badge>
                  </div>
                </button>
              </Card>
            </div>

            <div className="space-y-4 min-w-0">
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>Auto Research</CardTitle>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Research workflow prompt bundle for preset-based research runs.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{autoResearchAssets.length} prompts</Badge>
                    <Badge variant="outline">{AUTO_RESEARCH_CAPABILITIES.length} capabilities</Badge>
                  </div>
                </div>
                <div className="rounded-md border border-border px-3 py-2 text-sm">
                  This bundle contains workflow run prompts. Source access, tools, Project Folder access, memory writes, and approval requirements remain owned by workflow and policy configuration.
                </div>
              </Card>

              <Card className="space-y-3">
                <CardTitle>Runtime Shape</CardTitle>
                <div className="overflow-x-auto">
                  <div className="min-w-[720px] divide-y divide-border rounded-md border border-border">
                    <div className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(220px,1fr)] gap-3 px-3 py-2 text-[11px] font-medium uppercase text-muted-foreground">
                      <div>Type</div>
                      <div>Item</div>
                      <div>Prompt ownership</div>
                    </div>
                    <div className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(220px,1fr)] gap-3 px-3 py-2 text-sm">
                      <div className="font-mono text-xs text-muted-foreground">prompt</div>
                      <div className="min-w-0">
                        <div className="font-medium">Workflow run templates</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">Academic literature review, news scan, market research, and technical survey.</div>
                      </div>
                      <div className="min-w-0">
                        <div>Editable prompt assets</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">One run prompt per workflow template.</div>
                      </div>
                    </div>
                    {AUTO_RESEARCH_CAPABILITIES.map(capability => (
                      <div key={capability.id} className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(220px,1fr)] gap-3 px-3 py-2 text-sm">
                        <div className="font-mono text-xs text-muted-foreground">cap</div>
                        <div className="min-w-0">
                          <div className="font-medium">{capability.label}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{capability.detail}</div>
                        </div>
                        <div className="min-w-0">
                          <div>Not a prompt asset</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{capability.id}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card className="space-y-3">
                <CardTitle>Prompt Assets</CardTitle>
                {loadingAssets ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading prompts...
                  </div>
                ) : autoResearchAssets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No Auto Research prompt assets are visible.</p>
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
                            Current system version: <span className="font-mono">{shortHash(asset.current_system_version_id)}</span>
                          </div>
                          <Button type="button" size="sm" variant="outline" onClick={() => selectAsset(asset.asset_key)}>
                            Open asset
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
