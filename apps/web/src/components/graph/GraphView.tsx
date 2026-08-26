import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GraphProjectionNode } from '@rainver/protocol'
import { Crosshair, Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { createGraphRenderer, type GraphEventLike } from './core/createGraphRenderer'
import { resolveGraphLayout } from './core/graphLayouts'
import { graphViewReducer, normalizeGraphViewState, useGraphViewState } from './core/graphViewState'
import {
  buildElementStateMap,
  buildInteractionLabelVisibility,
  buildLabelVisibility,
  mapProjectionToRenderData,
} from './core/mapProjectionToRenderData'
import { createGraphTheme } from './core/graphTheme'
import { nativePointerEvent } from './core/graphInteractions'
import { GraphDetailPanel } from './GraphDetailPanel'
import { GraphLegend } from './GraphLegend'
import { GraphSearchBox } from './GraphSearchBox'
import { GraphToolbar } from './GraphToolbar'
import type { GraphLayoutConfig, GraphNodePosition, GraphRenderData, GraphRendererHandle, GraphViewAction, GraphViewProps, GraphViewState } from './types'

export function GraphView({
  projection,
  viewState,
  onViewStateChange,
  renderer,
  themeMode = 'light',
  theme,
  loading = false,
  error = null,
  className,
  onNodeSelect,
  onNodeExpand,
  onNodeContextMenu,
  onViewportChange,
  renderNodeDetails,
}: GraphViewProps) {
  const [internalState, internalDispatch] = useGraphViewState({ rendererMode: renderer ?? 'canvas' })
  const [handle, setHandle] = useState<GraphRendererHandle | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const nodeByIdRef = useRef<Map<string, GraphProjectionNode>>(new Map())
  const projectionRef = useRef<typeof projection>(projection)
  const handleRef = useRef<GraphRendererHandle | null>(null)
  const stateRef = useRef<GraphViewState>(internalState)
  const previousInteractionStateRef = useRef<Pick<GraphViewState, 'selectedNodeId' | 'hoveredNodeId'>>({
    selectedNodeId: null,
    hoveredNodeId: null,
  })
  const previousPinnedNodesRef = useRef<GraphViewState['pinnedNodes']>({})
  const pendingPinnedNodePositionsRef = useRef<Map<string, GraphNodePosition>>(new Map())
  const zoomRef = useRef(1)
  const labelVisibilityFrameRef = useRef<number | null>(null)
  const renderDataRef = useRef<GraphRenderData>({ nodes: [], edges: [] })
  const renderStructureRef = useRef<object | null>(null)
  const layoutRef = useRef<GraphLayoutConfig>({ type: 'force' })
  const appliedRenderDataRef = useRef<GraphRenderData | null>(null)
  const appliedRenderStructureRef = useRef<object | null>(null)
  const appliedLayoutRef = useRef<GraphLayoutConfig | null>(null)
  const rendererMutationRunningRef = useRef(false)
  const controlledRef = useRef(Boolean(viewState))
  const onViewStateChangeRef = useRef(onViewStateChange)
  const callbacksRef = useRef({
    onNodeSelect,
    onNodeExpand,
    onNodeContextMenu,
    onViewportChange,
  })

  controlledRef.current = Boolean(viewState)
  onViewStateChangeRef.current = onViewStateChange
  callbacksRef.current = { onNodeSelect, onNodeExpand, onNodeContextMenu, onViewportChange }

  const state = useMemo(() => viewState ? normalizeGraphViewState(viewState) : internalState, [viewState, internalState])
  projectionRef.current = projection
  handleRef.current = handle
  stateRef.current = state
  const effectiveRenderer = renderer ?? state.rendererMode
  const graphTheme = useMemo(() => createGraphTheme(themeMode, theme), [themeMode, theme])
  const structuralState = useMemo(
    () => ({
      ...state,
      selectedNodeId: null,
      hoveredNodeId: null,
      focusedNodeId: null,
    }),
    [
      state.hiddenKinds,
      state.activeEdgeKinds,
      state.pinnedNodes,
    ],
  )
  const labelState = useMemo(
    () => ({
      ...state,
      selectedNodeId: null,
      hoveredNodeId: null,
    }),
    [
      state.hiddenKinds,
      state.activeEdgeKinds,
      state.focusedNodeId,
    ],
  )
  const layoutResolution = useMemo(
    () => projection ? resolveGraphLayout(projection, state) : { layout: { type: 'force' }, mode: 'force' as const, warning: null },
    [projection, state.currentLayout, state.layoutSource, state.focusedNodeId],
  )
  const renderStructure = useMemo(
    () => ({
      projection,
      graphTheme,
      hiddenKinds: state.hiddenKinds,
      activeEdgeKinds: state.activeEdgeKinds,
    }),
    [projection, graphTheme, state.hiddenKinds, state.activeEdgeKinds],
  )
  const renderData = useMemo(
    () => projection
      ? mapProjectionToRenderData(projection, { theme: graphTheme, viewState: structuralState, zoom: 1 })
      : { nodes: [], edges: [] },
    [projection, graphTheme, structuralState],
  )
  const rendererReady = Boolean(projection && projection.nodes.length > 0)

  renderDataRef.current = renderData
  renderStructureRef.current = renderStructure
  layoutRef.current = layoutResolution.layout

  useEffect(() => {
    nodeByIdRef.current = new Map((projection?.nodes ?? []).map((node) => [node.id, node]))
  }, [projection])

  const applyAction = useCallback((action: GraphViewAction) => {
    const next = graphViewReducer(stateRef.current, action)
    if (!controlledRef.current) internalDispatch({ type: 'replace', state: next })
    onViewStateChangeRef.current?.(next)
  }, [internalDispatch])

  const handleNodeClick = useCallback((nodeId: string) => {
    const node = nodeByIdRef.current.get(nodeId) ?? null
    applyAction({ type: 'select-node', nodeId })
    callbacksRef.current.onNodeSelect?.(node)
  }, [applyAction])

  const handleNodeDoubleClick = useCallback((nodeId: string) => {
    const node = nodeByIdRef.current.get(nodeId)
    if (!node) return
    if (node.kind === 'cluster') applyAction({ type: 'toggle-cluster-expanded', clusterId: node.id })
    callbacksRef.current.onNodeExpand?.(node)
  }, [applyAction])

  const handleContextMenu = useCallback((nodeId: string, event: GraphEventLike) => {
    const node = nodeByIdRef.current.get(nodeId)
    const nativeEvent = nativePointerEvent(event)
    if (!node || !nativeEvent) return
    nativeEvent.preventDefault?.()
    callbacksRef.current.onNodeContextMenu?.(node, nativeEvent)
  }, [])

  const handleHover = useCallback((nodeId: string | null) => {
    applyAction({ type: 'hover-node', nodeId })
  }, [applyAction])

  const handleDragEnd = useCallback((nodeId: string, point: { x: number; y: number }) => {
    applyAction({ type: 'pin-node', nodeId, point })
  }, [applyAction])

  const cancelScheduledLabelVisibility = useCallback(() => {
    if (labelVisibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(labelVisibilityFrameRef.current)
      labelVisibilityFrameRef.current = null
    }
  }, [])

  const handleViewport = useCallback((nextZoom: number) => {
    zoomRef.current = nextZoom
    callbacksRef.current.onViewportChange?.({ zoom: nextZoom })
    cancelScheduledLabelVisibility()
    labelVisibilityFrameRef.current = window.requestAnimationFrame(() => {
      labelVisibilityFrameRef.current = null
      const currentProjection = projectionRef.current
      const currentHandle = handleRef.current
      if (currentProjection && currentHandle) {
        void currentHandle.setLabelVisibility(buildLabelVisibility(currentProjection, stateRef.current, nextZoom))
      }
    })
  }, [cancelScheduledLabelVisibility])

  const zoomGraph = useCallback((ratio: number) => {
    const currentHandle = handleRef.current
    if (!currentHandle) return
    void currentHandle.zoomBy(ratio).then(() => {
      if (handleRef.current === currentHandle) handleViewport(currentHandle.getZoom())
    })
  }, [handleViewport])

  const panGraph = useCallback((offset: { x: number; y: number }) => {
    void handleRef.current?.panBy(offset)
  }, [])

  const fitGraph = useCallback(() => {
    void handleRef.current?.fitView()
  }, [])

  const focusSelectedNode = useCallback(() => {
    const nodeId = stateRef.current.selectedNodeId
    if (!nodeId) return
    applyAction({ type: 'focus-node', nodeId })
    void handleRef.current?.focusNode(nodeId)
  }, [applyAction])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableGraphKeyTarget(event.target)) return
    const panStep = event.shiftKey ? 96 : 36
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomGraph(1.18)
      return
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      zoomGraph(1 / 1.18)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      fitGraph()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      panGraph({ x: 0, y: -panStep })
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      panGraph({ x: 0, y: panStep })
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      panGraph({ x: -panStep, y: 0 })
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      panGraph({ x: panStep, y: 0 })
      return
    }
    if (event.key === 'Escape' && stateRef.current.selectedNodeId) {
      event.preventDefault()
      applyAction({ type: 'select-node', nodeId: null })
      callbacksRef.current.onNodeSelect?.(null)
    }
  }, [applyAction, fitGraph, panGraph, zoomGraph])

  useEffect(() => () => cancelScheduledLabelVisibility(), [cancelScheduledLabelVisibility])

  const applyPendingRendererChanges = useCallback(() => {
    if (rendererMutationRunningRef.current) return
    rendererMutationRunningRef.current = true
    void (async () => {
      let failed = false
      try {
        while (true) {
          const currentHandle = handleRef.current
          if (!currentHandle) break

          const targetData = renderDataRef.current
          const targetStructure = renderStructureRef.current
          const hasPendingPinnedNodes = pendingPinnedNodePositionsRef.current.size > 0
          const structureChanged = appliedRenderStructureRef.current !== targetStructure
          const dataChanged = appliedRenderDataRef.current !== targetData
          if (dataChanged && (structureChanged || !hasPendingPinnedNodes)) {
            await currentHandle.setData(targetData)
            if (handleRef.current !== currentHandle) break
            appliedRenderDataRef.current = targetData
            appliedRenderStructureRef.current = targetStructure
          }

          const targetLayout = layoutRef.current
          if (appliedLayoutRef.current !== targetLayout) {
            await currentHandle.setLayout(targetLayout)
            if (handleRef.current !== currentHandle) break
            appliedLayoutRef.current = targetLayout
          }

          if (
            pendingPinnedNodePositionsRef.current.size > 0 &&
            appliedRenderStructureRef.current === renderStructureRef.current &&
            appliedLayoutRef.current === layoutRef.current
          ) {
            const positions = consumePendingPinnedNodePositions(pendingPinnedNodePositionsRef.current, renderDataRef.current)
            if (positions.length > 0) {
              await currentHandle.setNodePositions(positions)
              if (handleRef.current !== currentHandle) break
            }
            appliedRenderDataRef.current = renderDataRef.current
          }

          if (
            appliedRenderDataRef.current === renderDataRef.current &&
            appliedLayoutRef.current === layoutRef.current &&
            pendingPinnedNodePositionsRef.current.size === 0
          ) {
            break
          }
        }
      } catch (error) {
        failed = true
        console.error('Graph renderer update failed', error)
      } finally {
        rendererMutationRunningRef.current = false
        if (
          !failed &&
          handleRef.current &&
          (
            appliedRenderDataRef.current !== renderDataRef.current ||
            appliedLayoutRef.current !== layoutRef.current ||
            pendingPinnedNodePositionsRef.current.size > 0
          )
        ) {
          applyPendingRendererChanges()
        }
      }
    })()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !rendererReady) return undefined
    let disposed = false
    let localHandle: GraphRendererHandle | null = null
    const initialData = renderDataRef.current
    const initialStructure = renderStructureRef.current
    const initialLayout = layoutRef.current

    createGraphRenderer({
      container,
      data: initialData,
      layout: initialLayout,
      renderer: effectiveRenderer,
      background: graphTheme.background,
      onNodeClick: handleNodeClick,
      onNodeDoubleClick: handleNodeDoubleClick,
      onNodeContextMenu: handleContextMenu,
      onNodeHover: handleHover,
      onNodeDragEnd: handleDragEnd,
      onViewportChange: handleViewport,
    }).then((nextHandle) => {
      if (disposed) {
        nextHandle.destroy()
        return
      }
      localHandle = nextHandle
      appliedRenderDataRef.current = initialData
      appliedRenderStructureRef.current = initialStructure
      appliedLayoutRef.current = initialLayout
      setHandle(nextHandle)
    })

    return () => {
      disposed = true
      cancelScheduledLabelVisibility()
      handleRef.current = null
      localHandle?.destroy()
      appliedRenderDataRef.current = null
      appliedRenderStructureRef.current = null
      appliedLayoutRef.current = null
      setHandle(null)
    }
  }, [
    effectiveRenderer,
    graphTheme.background,
    graphTheme.mode,
    rendererReady,
    cancelScheduledLabelVisibility,
  ])

  useEffect(() => {
    const previousPinnedNodes = previousPinnedNodesRef.current
    const positions = changedPinnedNodePositions(previousPinnedNodes, state.pinnedNodes)
    previousPinnedNodesRef.current = state.pinnedNodes
    if (positions.length === 0) return
    for (const position of positions) pendingPinnedNodePositionsRef.current.set(position.id, position)
    if (!handle || !projection) return
    applyPendingRendererChanges()
  }, [handle, projection, state.pinnedNodes, applyPendingRendererChanges])

  useEffect(() => {
    if (!handle) return
    applyPendingRendererChanges()
  }, [handle, renderData, layoutResolution.layout, applyPendingRendererChanges])

  useEffect(() => {
    if (!handle || !projection) return
    void handle.setElementStates(buildElementStateMap(projection, state))
  }, [handle, projection, state])

  useEffect(() => {
    if (!handle || !projection) return
    cancelScheduledLabelVisibility()
    void handle.setLabelVisibility(buildLabelVisibility(projection, labelState, zoomRef.current))
  }, [handle, projection, labelState, cancelScheduledLabelVisibility])

  useEffect(() => {
    const previousState = previousInteractionStateRef.current
    previousInteractionStateRef.current = {
      selectedNodeId: state.selectedNodeId,
      hoveredNodeId: state.hoveredNodeId,
    }
    if (!handle || !projection) return
    const labels = buildInteractionLabelVisibility(projection, state, previousState, zoomRef.current)
    if (labels.nodes.length === 0 && labels.edges.length === 0) return
    void handle.setElementLabelVisibility(labels)
  }, [handle, projection, state.selectedNodeId, state.hoveredNodeId, state.hiddenKinds, state.activeEdgeKinds])

  useEffect(() => {
    if (!handle || !state.focusedNodeId) return
    void handle.focusNode(state.focusedNodeId)
  }, [handle, state.focusedNodeId])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !handle) return undefined
    if (typeof ResizeObserver === 'undefined') {
      handle.resize(container.clientWidth, container.clientHeight)
      return undefined
    }
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (!box) return
      handle.resize(box.width, box.height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [handle])

  const selectedNode = state.selectedNodeId ? nodeByIdRef.current.get(state.selectedNodeId) ?? null : null
  const edgeKinds = useMemo(
    () => Array.from(new Set((projection?.edges ?? []).map((edge) => edge.kind))).sort(),
    [projection],
  )
  const toolbarWarning = useMemo(() => {
    const warnings = [
      projection?.view.truncated ? 'Projection is aggregated.' : null,
      layoutResolution.warning,
    ].filter((warning): warning is string => Boolean(warning))
    return warnings.length ? warnings.join(' ') : null
  }, [projection?.view.truncated, layoutResolution.warning])
  const toolbarLayout = state.currentLayout === 'preset' ? 'force' : state.currentLayout

  function focusNode(node: GraphProjectionNode) {
    applyAction({ type: 'focus-node', nodeId: node.id })
    void handle?.focusNode(node.id)
  }

  function resetView() {
    applyAction({ type: 'reset-view' })
    void handle?.fitView()
  }

  function setEdgeKindActive(kind: string, active: boolean) {
    const current = state.activeEdgeKinds.length === 0 ? edgeKinds : state.activeEdgeKinds
    const next = active
      ? Array.from(new Set([...current, kind])).sort()
      : current.filter((candidate) => candidate !== kind)
    applyAction({
      type: 'set-active-edge-kinds',
      kinds: next.length === edgeKinds.length ? [] : next,
    })
  }

  return (
    <div
      className={cn(
        'flex h-full min-h-[32rem] overflow-hidden rounded-md border border-border bg-background text-foreground',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      tabIndex={0}
      role="region"
      aria-label="Interactive graph canvas"
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/80 px-3 py-2">
          {projection && <GraphSearchBox projection={projection} onFocusNode={focusNode} />}
        </div>
        <GraphToolbar
          layout={toolbarLayout}
          renderer={effectiveRenderer}
          warning={toolbarWarning}
          onLayoutChange={(layout) => applyAction({ type: 'set-layout', layout })}
          onRendererChange={(mode) => applyAction({ type: 'set-renderer', renderer: mode })}
        />
        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} className="absolute inset-0" data-testid="graph-canvas" />
          <GraphViewportControls
            disabled={!handle}
            canFocusSelected={Boolean(state.selectedNodeId)}
            onZoomIn={() => zoomGraph(1.18)}
            onZoomOut={() => zoomGraph(1 / 1.18)}
            onFitView={fitGraph}
            onFocusSelected={focusSelectedNode}
            onReset={resetView}
          />
          {projection && (
            <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
              {projection.nodes.length} nodes · {projection.edges.length} edges
            </div>
          )}
          {loading && <OverlayText>Loading graph...</OverlayText>}
          {error && <OverlayText>{error}</OverlayText>}
          {!loading && !error && projection && projection.nodes.length === 0 && <OverlayText>No graph data</OverlayText>}
        </div>
      </div>
      {projection && (
        <GraphLegend
          projection={projection}
          theme={graphTheme}
          viewState={state}
          onToggleKind={(kind) => applyAction({ type: 'toggle-kind', kind })}
          onToggleEdgeKind={setEdgeKindActive}
        />
      )}
      {selectedNode && (
        <GraphDetailPanel
          node={selectedNode}
          onClose={() => {
            applyAction({ type: 'select-node', nodeId: null })
            callbacksRef.current.onNodeSelect?.(null)
          }}
        >
          {renderNodeDetails?.(selectedNode)}
        </GraphDetailPanel>
      )}
    </div>
  )
}

function GraphViewportControls({
  disabled,
  canFocusSelected,
  onZoomIn,
  onZoomOut,
  onFitView,
  onFocusSelected,
  onReset,
}: {
  disabled: boolean
  canFocusSelected: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFitView: () => void
  onFocusSelected: () => void
  onReset: () => void
}) {
  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-background/90 p-1 shadow-sm backdrop-blur">
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={onZoomIn} disabled={disabled} title="Zoom in" aria-label="Zoom in">
        <ZoomIn className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={onZoomOut} disabled={disabled} title="Zoom out" aria-label="Zoom out">
        <ZoomOut className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={onFitView} disabled={disabled} title="Fit view" aria-label="Fit view">
        <Maximize2 className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 px-0"
        onClick={onFocusSelected}
        disabled={disabled || !canFocusSelected}
        title="Focus selected node"
        aria-label="Focus selected node"
      >
        <Crosshair className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={onReset} disabled={disabled} title="Reset view" aria-label="Reset view">
        <RotateCcw className="size-3.5" />
      </Button>
    </div>
  )
}

function OverlayText({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-background/80 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function isEditableGraphKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return target.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    tagName === 'button'
}

function changedPinnedNodePositions(
  previous: GraphViewState['pinnedNodes'],
  current: GraphViewState['pinnedNodes'],
): GraphNodePosition[] {
  const addedOrMoved = Object.entries(current)
    .filter(([nodeId, point]) => {
      const previousPoint = previous[nodeId]
      return !previousPoint || previousPoint.x !== point.x || previousPoint.y !== point.y
    })
    .map(([id, point]) => ({ id, x: point.x, y: point.y, fixed: true as const }))
  const removed = Object.keys(previous)
    .filter((nodeId) => !current[nodeId])
    .map((id) => ({ id, fixed: false as const }))
  return [...addedOrMoved, ...removed]
}

function consumePendingPinnedNodePositions(
  pending: Map<string, GraphNodePosition>,
  renderData: GraphRenderData,
): GraphNodePosition[] {
  if (pending.size === 0) return []
  const visibleNodeIds = new Set(renderData.nodes.map((node) => node.id))
  const positions = Array.from(pending.values()).filter((position) => visibleNodeIds.has(position.id))
  pending.clear()
  return positions
}
