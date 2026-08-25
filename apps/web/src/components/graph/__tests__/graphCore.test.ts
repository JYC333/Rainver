// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { GraphProjection } from '@agent-space/protocol'
import { createGraphTheme } from '../core/graphTheme'
import { graphViewReducer, normalizeGraphViewState, persistentGraphViewState } from '../core/graphViewState'
import { mapProjectionToRenderData, buildElementStateMap, buildInteractionLabelVisibility } from '../core/mapProjectionToRenderData'
import {
  CLIENT_GRAPH_EDGE_BUDGET,
  graphScalePolicy,
  resolveGraphLayout,
  WORKER_LAYOUT_NODE_LIMIT,
} from '../core/graphLayouts'
import { shouldShowNodeLabel, zoomBandForScale } from '../core/semanticZoom'
import { syntheticProjection } from '../devtools/syntheticProjection'

const projection: GraphProjection = {
  nodes: [
    { id: 'cluster:note', kind: 'cluster', label: 'Notes', degree: 5 },
    { id: 'n1', kind: 'note', label: 'First note', degree: 5, metadata: { forceLabel: true } },
    { id: 'n2', kind: 'claim', label: 'Claim', degree: 1 },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', kind: 'supports', label: 'supports', weight: 3 },
    { id: 'e2', source: 'cluster:note', target: 'n1', kind: 'cluster_contains' },
  ],
  view: { mode: 'local', rootId: 'n1', depth: 1, generatedAt: '2026-07-04T12:00:00.000Z' },
  layout: { mode: 'force' },
}

describe('graph core pure helpers', () => {
  it('maps projection nodes and edges through theme and semantic zoom', () => {
    const theme = createGraphTheme('light', { node: { note: { color: '#111111', size: 42 } } })
    const viewState = normalizeGraphViewState({ selectedNodeId: 'n1', pinnedNodes: { n1: { x: 10, y: 12 } } })
    const data = mapProjectionToRenderData(projection, { theme, viewState, zoom: 0.4 })

    expect(data.nodes.find((node) => node.id === 'n1')).toMatchObject({ fx: 10, fy: 12 })
    expect(data.nodes.find((node) => node.id === 'n1')?.style).toMatchObject({
      fill: '#111111',
      size: 42,
      labelText: 'First note',
    })
    expect(data.edges.find((edge) => edge.id === 'e1')?.style).toMatchObject({
      labelText: '',
    })
    expect(data.nodes.find((node) => node.id === 'cluster:note')?.type).toBe('rect')
  })

  it('filters hidden node kinds and inactive edge kinds', () => {
    const theme = createGraphTheme('light')
    const viewState = normalizeGraphViewState({ hiddenKinds: ['claim'], activeEdgeKinds: ['cluster_contains'] })
    const data = mapProjectionToRenderData(projection, { theme, viewState, zoom: 1 })

    expect(data.nodes.map((node) => node.id)).toEqual(['cluster:note', 'n1'])
    expect(data.edges.map((edge) => edge.id)).toEqual(['e2'])
  })

  it('builds selected neighborhood state without mutating projection semantics', () => {
    const state = normalizeGraphViewState({ hoveredNodeId: 'n1' })
    const states = buildElementStateMap(projection, state)

    expect(states.n1).toContain('active')
    expect(states.n2).not.toContain('faded')
    expect(states['cluster:note']).not.toContain('faded')
  })

  it('builds targeted interaction label patches for hovered and selected nodes', () => {
    const state = normalizeGraphViewState({ hoveredNodeId: 'n2' })
    const labels = buildInteractionLabelVisibility(projection, state, { selectedNodeId: null, hoveredNodeId: null }, 0.2)

    expect(labels.nodes).toEqual([{ id: 'n2', labelText: 'Claim' }])
    expect(labels.edges).toEqual([{ id: 'e1', labelText: '' }])
  })

  it('reduces persistent view state', () => {
    const base = normalizeGraphViewState()
    const withLayout = graphViewReducer(base, { type: 'set-layout', layout: 'radial' })
    const pinned = graphViewReducer(withLayout, { type: 'pin-node', nodeId: 'n1', point: { x: 10, y: 12 } })
    const hidden = graphViewReducer(pinned, { type: 'toggle-kind', kind: 'claim' })
    const edgeFiltered = graphViewReducer(hidden, { type: 'set-active-edge-kinds', kinds: ['supports'] })

    expect(edgeFiltered.currentLayout).toBe('radial')
    expect(edgeFiltered.layoutSource).toBe('user')
    expect(edgeFiltered.pinnedNodes.n1).toEqual({ x: 10, y: 12 })
    expect(persistentGraphViewState(edgeFiltered)).toMatchObject({
      currentLayout: 'radial',
      layoutSource: 'user',
      hiddenKinds: ['claim'],
      activeEdgeKinds: ['supports'],
      pinnedNodes: { n1: { x: 10, y: 12 } },
    })
  })

  it('normalizes malformed persisted view state without throwing', () => {
    const state = normalizeGraphViewState({
      selectedNodeId: 123,
      expandedClusterIds: 'cluster:note',
      hiddenKinds: ['note', false, 'claim'],
      activeEdgeKinds: null,
      currentLayout: 'sideways',
      rendererMode: 'svg',
      pinnedNodes: {
        n1: { x: 10, y: 12 },
        n2: { x: 'bad', y: 5 },
        n3: null,
      },
    } as never)

    expect(state.selectedNodeId).toBeNull()
    expect(state.expandedClusterIds).toEqual([])
    expect(state.hiddenKinds).toEqual(['note', 'claim'])
    expect(state.activeEdgeKinds).toEqual([])
    expect(state.currentLayout).toBe('force')
    expect(state.layoutSource).toBe('default')
    expect(state.rendererMode).toBe('canvas')
    expect(state.pinnedNodes).toEqual({ n1: { x: 10, y: 12 } })
  })

  it('preserves stable view state references during normalization', () => {
    const expandedClusterIds = ['cluster:note']
    const hiddenKinds = ['claim']
    const activeEdgeKinds = ['supports']
    const pinnedNodes = { n1: { x: 10, y: 12 } }
    const state = normalizeGraphViewState({
      expandedClusterIds,
      hiddenKinds,
      activeEdgeKinds,
      pinnedNodes,
    })

    expect(state.expandedClusterIds).toBe(expandedClusterIds)
    expect(state.hiddenKinds).toBe(hiddenKinds)
    expect(state.activeEdgeKinds).toBe(activeEdgeKinds)
    expect(state.pinnedNodes).toBe(pinnedNodes)
  })

  it('fills fallback style fields for partial plugin theme overrides', () => {
    const theme = createGraphTheme('light', { node: { paper: { color: '#111111' } } })
    const data = mapProjectionToRenderData({
      ...projection,
      nodes: [{ id: 'p1', kind: 'paper', label: 'Paper' }],
      edges: [],
    }, { theme, viewState: normalizeGraphViewState(), zoom: 1 })

    expect(data.nodes[0]?.style).toMatchObject({
      fill: '#111111',
      size: 26,
      r: 13,
    })
  })

  it('selects semantic zoom bands and scale-aware layout tiers', () => {
    expect(zoomBandForScale(0.2)).toBe('overview')
    expect(shouldShowNodeLabel({ id: 'n', kind: 'note', label: 'N', degree: 1 }, 0.2)).toBe(false)
    const largeProjection = {
      ...projection,
      nodes: Array.from({ length: WORKER_LAYOUT_NODE_LIMIT + 1 }, (_, index) => ({
        id: `n${index}`,
        kind: 'note',
        label: `N ${index}`,
      })),
      edges: [],
    }
    expect(resolveGraphLayout(projection, normalizeGraphViewState()).layout).toMatchObject({
      type: 'd3-force',
      animation: true,
      iterations: 260,
      clustering: true,
      clusterBy: 'node.componentId',
      link: { distance: 72, strength: 0.48 },
      manyBody: { strength: -90, distanceMax: 280 },
      clusterFociStrength: 0.2,
    })
    expect(resolveGraphLayout(projection, normalizeGraphViewState({ currentLayout: 'clustered' })).layout).toMatchObject({
      type: 'd3-force',
      clustering: true,
      clusterBy: 'node.clusterId || node.data.projection.clusterId || node.data.kind || node.componentId',
      link: { distance: 86, strength: 0.36 },
      manyBody: { strength: -120, distanceMax: 360 },
      clusterFociStrength: 0.34,
    })
    expect(resolveGraphLayout({
      ...projection,
      layout: { mode: 'clustered' },
    }, normalizeGraphViewState())).toMatchObject({
      mode: 'clustered',
      layout: expect.objectContaining({ clustering: true }),
    })
    expect(resolveGraphLayout({
      ...projection,
      nodes: projection.nodes.map((node, index) => ({ ...node, x: index * 10, y: index * 5 })),
      layout: { mode: 'preset' },
    }, normalizeGraphViewState({ currentLayout: 'force', layoutSource: 'user' })).layout).toMatchObject({
      type: 'd3-force',
      clusterBy: 'node.componentId',
    })
    expect(resolveGraphLayout({
      ...projection,
      nodes: projection.nodes.map((node, index) => ({ ...node, x: index * 10, y: index * 5 })),
      layout: { mode: 'preset' },
    }, normalizeGraphViewState()).layout).toMatchObject([
      { type: 'preset' },
      { type: 'd3-force', clusterBy: 'node.componentId' },
    ])
    expect(resolveGraphLayout(projection, normalizeGraphViewState({ currentLayout: 'circular' })).layout).toMatchObject([
      { type: 'circular' },
      { type: 'd3-force', clusterBy: 'node.componentId' },
    ])
    expect(resolveGraphLayout(projection, normalizeGraphViewState({ currentLayout: 'radial', focusedNodeId: 'n2' })).layout).toMatchObject([
      { type: 'radial', focusNode: 'n2' },
      { type: 'd3-force', clusterBy: 'node.componentId' },
    ])
    expect(resolveGraphLayout(projection, normalizeGraphViewState({ currentLayout: 'concentric' })).layout).toMatchObject([
      { type: 'concentric', sortBy: 'degree' },
      { type: 'd3-force', clusterBy: 'node.componentId' },
    ])
    expect(resolveGraphLayout(largeProjection, normalizeGraphViewState()).layout).toMatchObject({ type: 'grid' })
    expect(resolveGraphLayout(largeProjection, normalizeGraphViewState()).warning).toContain('worker layout budget')
    for (const currentLayout of ['circular', 'radial', 'concentric', 'clustered'] as const) {
      expect(resolveGraphLayout(largeProjection, normalizeGraphViewState({ currentLayout })).layout).toMatchObject({
        type: 'grid',
        enableWorker: false,
      })
    }

    const workerProjection = { ...largeProjection, nodes: largeProjection.nodes.slice(0, WORKER_LAYOUT_NODE_LIMIT) }
    expect(graphScalePolicy(workerProjection)).toMatchObject({ layoutTier: 'worker', nodeBudgetExceeded: false })
    expect(resolveGraphLayout(workerProjection, normalizeGraphViewState()).layout).toMatchObject({
      type: 'force',
      clustering: true,
      nodeClusterBy: 'node.componentId',
      iterations: 80,
      enableWorker: true,
    })
    expect(resolveGraphLayout(workerProjection, normalizeGraphViewState({ currentLayout: 'circular' })).layout).toMatchObject([
      { type: 'circular' },
      {
        type: 'force',
        clustering: true,
        nodeClusterBy: 'node.componentId',
        enableWorker: true,
      },
    ])
    expect(resolveGraphLayout(workerProjection, normalizeGraphViewState({ currentLayout: 'clustered' })).layout).toMatchObject({
      type: 'force',
      clustering: true,
      nodeClusterBy: 'node.clusterId || node.data.projection.clusterId || node.data.kind || node.componentId',
    })

    const denseProjection = {
      ...projection,
      edges: Array.from({ length: CLIENT_GRAPH_EDGE_BUDGET + 1 }, (_, index) => ({
        id: `dense:${index}`,
        source: 'n1',
        target: 'n2',
        kind: 'related_to',
      })),
    }
    expect(graphScalePolicy(denseProjection)).toMatchObject({ edgeBudgetExceeded: true })
    expect(resolveGraphLayout(denseProjection, normalizeGraphViewState()).warning).toContain('edge budget')
  })

  it('keeps synthetic debug projections available up to the local benchmark size', () => {
    const synthetic = syntheticProjection(10000)

    expect(synthetic.nodes.length).toBe(10006)
    expect(synthetic.edges.length).toBeGreaterThan(29000)
    expect(graphScalePolicy(synthetic)).toMatchObject({
      layoutTier: 'degraded',
      nodeBudgetExceeded: true,
      edgeBudgetExceeded: true,
    })
    expect(graphScalePolicy(synthetic).warning).toContain('node and edge budgets')
  })
})
