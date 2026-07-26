import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphProjection, GraphProjectionNode, GraphProjectionViewMode } from '@agent-space/protocol'
import { GitBranch, Loader2, Network, RefreshCw, Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { graphApi, type GraphProjectionQuery } from '../../api/client'
import { GraphView, normalizeGraphViewState, persistentGraphViewState, type GraphViewState } from '../../components/graph'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { useTheme } from '../../contexts/ThemeContext'
import { errMsg } from '../../lib/utils'

type ServerGraphMode = Exclude<GraphProjectionViewMode, 'debug'>

const GRAPH_SCOPE_KEY = 'core:graph'
const CLIENT_NODE_BUDGET = 5000
const SYNTHETIC_NODE_MAX = 10000
const GRAPH_LENS_LABELS: Record<string, string> = {
  academic_citation_v1: 'Academic citation lens',
}
const MODE_OPTIONS = [
  { value: 'global', label: 'Global' },
  { value: 'local', label: 'Local' },
  { value: 'cluster', label: 'Cluster' },
  { value: 'search', label: 'Search' },
]
const DEPTH_OPTIONS = [
  { value: '1', label: 'Depth 1' },
  { value: '2', label: 'Depth 2' },
]

export default function GraphPage() {
  const { activeSpaceId } = useSpace()
  const { theme } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryKey = searchParams.toString()
  const query = useMemo(() => parseGraphQuery(searchParams), [queryKey])
  const graphScopeKey = useMemo(
    () => {
      if (query.project_id) {
        return query.lens_id ? `project:graph:${query.project_id}:${query.lens_id}` : `project:graph:${query.project_id}`
      }
      return query.lens_id ? `${GRAPH_SCOPE_KEY}:${query.lens_id}` : GRAPH_SCOPE_KEY
    },
    [query.project_id, query.lens_id],
  )
  const debugSyntheticCount = useMemo(() => parseSyntheticDebug(searchParams.get('debug')), [queryKey])

  const [mode, setMode] = useState<ServerGraphMode>(query.mode)
  const [rootId, setRootId] = useState(query.root_id ?? '')
  const [search, setSearch] = useState(query.q ?? '')
  const [depth, setDepth] = useState(String(query.depth ?? 1))
  const [limit, setLimit] = useState(String(query.limit ?? 300))
  const [projection, setProjection] = useState<GraphProjection | null>(null)
  const [viewState, setViewState] = useState<GraphViewState>(() => normalizeGraphViewState())
  const [loading, setLoading] = useState(false)
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stateLoaded, setStateLoaded] = useState(false)
  const viewStateRef = useRef(viewState)
  const viewStateDirtyRef = useRef(false)
  const lastSavedViewStateRef = useRef<string | null>(null)
  const activeSpaceIdRef = useRef(activeSpaceId)
  const projectionRequestSeqRef = useRef(0)
  const expandRequestSeqRef = useRef(0)

  viewStateRef.current = viewState
  activeSpaceIdRef.current = activeSpaceId

  function beginProjectionRequest(): number {
    projectionRequestSeqRef.current += 1
    return projectionRequestSeqRef.current
  }

  function isCurrentProjectionRequest(requestId: number, spaceId: string): boolean {
    return projectionRequestSeqRef.current === requestId && activeSpaceIdRef.current === spaceId
  }

  useEffect(() => {
    setMode(query.mode)
    setRootId(query.root_id ?? '')
    setSearch(query.q ?? '')
    setDepth(String(query.depth ?? 1))
    setLimit(String(query.limit ?? 300))
  }, [query.mode, query.root_id, query.q, query.depth, query.limit])

  useEffect(() => {
    setProjection(null)
    setViewState(normalizeGraphViewState())
    setExpandingNodeId(null)
    projectionRequestSeqRef.current += 1
    expandRequestSeqRef.current += 1
    setStateLoaded(false)
    viewStateDirtyRef.current = false
    lastSavedViewStateRef.current = null
    if (!activeSpaceId) return undefined
    let disposed = false
    graphApi.getViewState(graphScopeKey)
      .then(record => {
        if (disposed) return
        const next = normalizeGraphViewState(record.state_json as Partial<GraphViewState>)
        setViewState(next)
        lastSavedViewStateRef.current = persistentViewStateKey(next)
        setStateLoaded(true)
      })
      .catch(error => {
        if (!disposed) toast.error(errMsg(error))
      })
    return () => { disposed = true }
  }, [activeSpaceId, graphScopeKey])

  useEffect(() => {
    if (!stateLoaded || !activeSpaceId) return undefined
    if (!viewStateDirtyRef.current) return undefined
    const requestSpaceId = activeSpaceId
    const handle = window.setTimeout(() => {
      const key = persistentViewStateKey(viewStateRef.current)
      if (key === lastSavedViewStateRef.current) {
        viewStateDirtyRef.current = false
        return
      }
      void graphApi.saveViewState(graphScopeKey, persistentGraphViewState(viewStateRef.current) as Record<string, unknown>)
        .then(() => {
          if (activeSpaceIdRef.current !== requestSpaceId) return
          lastSavedViewStateRef.current = key
          if (persistentViewStateKey(viewStateRef.current) === key) viewStateDirtyRef.current = false
        })
        .catch(error => {
          if (activeSpaceIdRef.current === requestSpaceId) toast.error(errMsg(error))
        })
    }, 600)
    return () => window.clearTimeout(handle)
  }, [activeSpaceId, graphScopeKey, stateLoaded, viewState])

  const loadProjection = useCallback(async (params: GraphProjectionQuery, options: { merge?: boolean } = {}) => {
    const requestSpaceId = activeSpaceIdRef.current
    if (!requestSpaceId) return
    const requestId = beginProjectionRequest()
    const validationError = validateProjectionQuery(params)
    if (validationError) {
      if (isCurrentProjectionRequest(requestId, requestSpaceId)) {
        setError(validationError)
        if (!options.merge) setLoading(false)
      }
      return
    }
    setLoading(!options.merge)
    setError(null)
    try {
      const next = await graphApi.projection(params)
      if (!isCurrentProjectionRequest(requestId, requestSpaceId)) return
      setProjection(current => options.merge && current
        ? mergeProjection(current, next, viewStateRef.current)
        : next)
    } catch (error) {
      if (isCurrentProjectionRequest(requestId, requestSpaceId)) setError(errMsg(error))
    } finally {
      if (isCurrentProjectionRequest(requestId, requestSpaceId)) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const requestSpaceId = activeSpaceId
    const requestId = requestSpaceId ? beginProjectionRequest() : 0
    expandRequestSeqRef.current += 1
    setExpandingNodeId(null)
    async function load() {
      if (!requestSpaceId) return
      setLoading(true)
      setError(null)
      try {
        if (debugSyntheticCount !== null && import.meta.env.DEV) {
          const { syntheticProjection } = await import('../../components/graph/devtools/syntheticProjection')
          if (!disposed && isCurrentProjectionRequest(requestId, requestSpaceId)) setProjection(syntheticProjection(debugSyntheticCount))
          return
        }
        const validationError = validateProjectionQuery(query)
        if (validationError) {
          if (!disposed && isCurrentProjectionRequest(requestId, requestSpaceId)) {
            setProjection(null)
            setError(validationError)
          }
          return
        }
        const next = await graphApi.projection(query)
        if (!disposed && isCurrentProjectionRequest(requestId, requestSpaceId)) setProjection(next)
      } catch (error) {
        if (!disposed && isCurrentProjectionRequest(requestId, requestSpaceId)) setError(errMsg(error))
      } finally {
        if (!disposed && isCurrentProjectionRequest(requestId, requestSpaceId)) setLoading(false)
      }
    }
    void load()
    return () => { disposed = true }
  }, [activeSpaceId, queryKey, debugSyntheticCount])

  function applyQuery() {
    const numericLimit = Number(limit)
    const nextQuery: GraphProjectionQuery = {
      mode,
      root_id: (mode === 'local' || mode === 'cluster') ? rootId.trim() : undefined,
      depth: mode === 'local' ? Number(depth) : undefined,
      q: mode === 'search' ? search.trim() : undefined,
      project_id: query.project_id,
      lens_id: query.lens_id,
      limit: Number.isInteger(numericLimit) && numericLimit > 0 ? numericLimit : 300,
      include_clusters: mode === 'global',
    }
    const validationError = validateProjectionQuery(nextQuery)
    if (validationError) {
      setError(validationError)
      return
    }
    const params = new URLSearchParams()
    params.set('mode', mode)
    params.set('limit', String(nextQuery.limit ?? 300))
    if (nextQuery.root_id) params.set('root_id', nextQuery.root_id)
    if (mode === 'local') params.set('depth', depth)
    if (nextQuery.q) params.set('q', nextQuery.q)
    if (nextQuery.project_id) params.set('project_id', nextQuery.project_id)
    if (nextQuery.lens_id) params.set('lens_id', nextQuery.lens_id)
    setSearchParams(params)
  }

  function updateViewState(next: GraphViewState) {
    if (persistentViewStateKey(next) !== lastSavedViewStateRef.current) viewStateDirtyRef.current = true
    setViewState(next)
  }

  async function refreshGraph() {
    const requestSpaceId = activeSpaceIdRef.current
    if (!requestSpaceId) return
    if (debugSyntheticCount !== null && import.meta.env.DEV) {
      const requestId = beginProjectionRequest()
      setLoading(true)
      setError(null)
      try {
        const { syntheticProjection } = await import('../../components/graph/devtools/syntheticProjection')
        if (isCurrentProjectionRequest(requestId, requestSpaceId)) setProjection(syntheticProjection(debugSyntheticCount))
      } catch (error) {
        if (isCurrentProjectionRequest(requestId, requestSpaceId)) setError(errMsg(error))
      } finally {
        if (isCurrentProjectionRequest(requestId, requestSpaceId)) setLoading(false)
      }
      return
    }
    await loadProjection(query)
  }

  const expandNode = useCallback(async (node: GraphProjectionNode) => {
    if (debugSyntheticCount !== null && import.meta.env.DEV) return
    const requestSpaceId = activeSpaceIdRef.current
    if (!requestSpaceId) return
    const expandRequestId = ++expandRequestSeqRef.current
    setExpandingNodeId(node.id)
    try {
      await loadProjection({
        mode: node.kind === 'cluster' ? 'cluster' : 'local',
        root_id: node.id,
        depth: 1,
        limit: 300,
        project_id: query.project_id,
        lens_id: query.lens_id,
        include_clusters: false,
      }, { merge: true })
    } finally {
      if (activeSpaceIdRef.current === requestSpaceId && expandRequestSeqRef.current === expandRequestId) {
        setExpandingNodeId(null)
      }
    }
  }, [debugSyntheticCount, loadProjection, query.lens_id, query.project_id])

  return (
    <div className="flex h-full min-h-[calc(100vh-8rem)] flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Network className="size-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold">Graph</h1>
              {query.project_id && <Badge variant="outline">Project graph</Badge>}
              {query.lens_id && <Badge variant="secondary">{GRAPH_LENS_LABELS[query.lens_id] ?? query.lens_id}</Badge>}
              {projection?.view.truncated && <Badge variant="warning">aggregated</Badge>}
              {debugSyntheticCount !== null && import.meta.env.DEV && <Badge variant="outline">synthetic {debugSyntheticCount}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {projection ? `${projection.nodes.length} nodes · ${projection.edges.length} edges` : 'Space relationship projection'}
            </p>
          </div>
          <Button variant="outline" onClick={() => void refreshGraph()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh
          </Button>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[9rem_minmax(12rem,1fr)_7rem_7rem_auto]">
          <Select value={mode} onChange={(value) => setMode(value as ServerGraphMode)} options={MODE_OPTIONS} />
          {mode === 'search' ? <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search graph text" /> : mode === 'global' ? <Input value="Whole visible graph" disabled /> : <Select
            value={rootId}
            onChange={setRootId}
            options={[
              { value: '', label: 'Select a visible object…' },
              ...(projection?.nodes ?? []).map(node => ({ value: node.id, label: `${node.label || node.kind} · ${node.kind}` })),
              ...Array.from(new Set((projection?.nodes ?? []).map(node => node.kind))).map(kind => ({ value: `cluster:${kind}`, label: `All ${kind}` })),
            ]}
          />}
          <Select value={depth} onChange={setDepth} options={DEPTH_OPTIONS} disabled={mode !== 'local'} />
          <Input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" aria-label="Graph node limit" />
          <Button onClick={applyQuery}>
            <Search className="size-4" />
            Apply
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <GraphView
          projection={projection}
          viewState={viewState}
          onViewStateChange={updateViewState}
          renderer={viewState.rendererMode}
          themeMode={theme}
          loading={loading}
          error={error}
          className="h-full"
          onNodeExpand={expandNode}
          renderNodeDetails={(node) => <GraphNodeDetails node={node} expanding={expandingNodeId === node.id} />}
        />
      </div>
    </div>
  )
}

function GraphNodeDetails({ node, expanding }: { node: GraphProjectionNode; expanding: boolean }) {
  const status = typeof node.metadata?.status === 'string' ? node.metadata.status : null
  const updatedAt = typeof node.metadata?.updatedAt === 'string' ? node.metadata.updatedAt : null
  const count = typeof node.metadata?.count === 'number' ? node.metadata.count : null
  const href = entityHref(node)
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{node.kind}</Badge>
          {status && <StatusBadge status={status} />}
          {expanding && <Badge variant="secondary">expanding</Badge>}
        </div>
        {node.subtitle && <p className="text-sm text-muted-foreground">{node.subtitle}</p>}
      </div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">ID</dt>
        <dd className="break-all font-mono text-xs">{node.id}</dd>
        {node.degree !== undefined && (
          <>
            <dt className="text-muted-foreground">Degree</dt>
            <dd>{node.degree}</dd>
          </>
        )}
        {count !== null && (
          <>
            <dt className="text-muted-foreground">Members</dt>
            <dd>{count}</dd>
          </>
        )}
        {updatedAt && (
          <>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{new Date(updatedAt).toLocaleString()}</dd>
          </>
        )}
      </dl>
      {href && (
        <Button variant="outline" size="sm" asChild>
          <Link to={href}>
            <GitBranch className="size-3.5" />
            Open entity
          </Link>
        </Button>
      )}
    </div>
  )
}

function parseGraphQuery(params: URLSearchParams): GraphProjectionQuery & { mode: ServerGraphMode } {
  const rawMode = params.get('mode')
  const mode: ServerGraphMode = rawMode === 'local' || rawMode === 'cluster' || rawMode === 'search' ? rawMode : 'global'
  const depth = Number(params.get('depth') ?? '1')
  const limit = Number(params.get('limit') ?? '300')
  return {
    mode,
    root_id: params.get('root_id') ?? undefined,
    depth: Number.isInteger(depth) ? depth : 1,
    q: params.get('q') ?? undefined,
    project_id: params.get('project_id') ?? undefined,
    lens_id: params.get('lens_id') ?? undefined,
    limit: Number.isInteger(limit) && limit > 0 ? limit : 300,
    include_clusters: mode === 'global',
  }
}

function parseSyntheticDebug(value: string | null): number | null {
  if (!value?.startsWith('synthetic:')) return null
  const count = Number(value.slice('synthetic:'.length))
  return Number.isInteger(count) && count > 0 ? Math.min(count, SYNTHETIC_NODE_MAX) : 300
}

function validateProjectionQuery(params: GraphProjectionQuery): string | null {
  if ((params.mode === 'local' || params.mode === 'cluster') && !params.root_id?.trim()) {
    return 'root_id is required for this graph mode.'
  }
  if (params.mode === 'search' && !params.q?.trim()) {
    return 'Search text is required for search mode.'
  }
  return null
}

function persistentViewStateKey(state: GraphViewState): string {
  return JSON.stringify(persistentGraphViewState(state))
}

function mergeProjection(
  current: GraphProjection,
  next: GraphProjection,
  viewState: GraphViewState,
): GraphProjection {
  const nodeMap = new Map(current.nodes.map(node => [node.id, node]))
  next.nodes.forEach(node => nodeMap.set(node.id, node))
  let nodes = Array.from(nodeMap.values())
  let clientTruncated = false
  if (nodes.length > CLIENT_NODE_BUDGET) {
    clientTruncated = true
    const pinnedIds = new Set(Object.keys(viewState.pinnedNodes))
    const pinned = nodes.filter(node => pinnedIds.has(node.id)).slice(-CLIENT_NODE_BUDGET)
    const restBudget = Math.max(0, CLIENT_NODE_BUDGET - pinned.length)
    const rest = restBudget > 0
      ? nodes.filter(node => !pinnedIds.has(node.id)).slice(-restBudget)
      : []
    nodes = [...pinned, ...rest]
  }
  const nodeIds = new Set(nodes.map(node => node.id))
  const edgeMap = new Map(current.edges.map(edge => [edge.id, edge]))
  next.edges.forEach(edge => edgeMap.set(edge.id, edge))
  const edges = Array.from(edgeMap.values())
    .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(-(CLIENT_NODE_BUDGET * 3))
  return {
    nodes,
    edges,
    view: {
      ...current.view,
      generatedAt: next.view.generatedAt,
      truncated: Boolean(current.view.truncated || next.view.truncated || clientTruncated),
      totalNodeCount: Math.max(current.view.totalNodeCount ?? nodes.length, next.view.totalNodeCount ?? next.nodes.length),
    },
    layout: next.layout ?? current.layout,
  }
}

function entityHref(node: GraphProjectionNode): string | null {
  if (node.kind === 'knowledge_item') return `/knowledge/wiki/${node.id}`
  if (node.kind === 'note') return `/knowledge/notes/${node.id}`
  if (node.kind === 'source') return '/knowledge/sources'
  return null
}
