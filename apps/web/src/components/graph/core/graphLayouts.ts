import type { GraphProjection, GraphProjectionLayoutMode } from '@rainver/protocol'
import type { GraphLayoutConfig, GraphViewState } from '../types'

export const IN_THREAD_FORCE_NODE_LIMIT = 1500
export const WORKER_LAYOUT_NODE_LIMIT = 3000
export const CLIENT_GRAPH_NODE_BUDGET = 5000
export const CLIENT_GRAPH_EDGE_BUDGET = CLIENT_GRAPH_NODE_BUDGET * 3
export const IN_THREAD_DYNAMIC_FORCE_ITERATIONS = 260
export const WORKER_FORCE_ITERATIONS = 80

const COMPONENT_CLUSTER_BY = 'node.componentId'
const SEMANTIC_CLUSTER_BY = 'node.clusterId || node.data.projection.clusterId || node.data.kind || node.componentId'

export type GraphLayoutTier = 'in-thread' | 'worker' | 'degraded'

export interface GraphScalePolicy {
  nodeCount: number
  edgeCount: number
  layoutTier: GraphLayoutTier
  nodeBudgetExceeded: boolean
  edgeBudgetExceeded: boolean
  warning: string | null
}

export interface GraphLayoutResolution {
  layout: GraphLayoutConfig
  mode: GraphProjectionLayoutMode
  warning: string | null
}

export function resolveGraphLayout(
  projection: GraphProjection,
  viewState: GraphViewState,
): GraphLayoutResolution {
  const userSelectedLayout = viewState.layoutSource === 'user'
  const mode = userSelectedLayout
    ? viewState.currentLayout
    : projection.layout?.mode ?? viewState.currentLayout ?? 'force'
  const scale = graphScalePolicy(projection)
  const warning = scale.warning
  if (scale.layoutTier === 'degraded') {
    return {
      layout: { type: 'grid', preventOverlap: true, iterations: WORKER_FORCE_ITERATIONS, enableWorker: false },
      mode,
      warning,
    }
  }
  if (mode === 'preset' || (!userSelectedLayout && hasPresetCoordinates(projection))) {
    return {
      layout: forceLayoutWithSeed({
        seed: { type: 'preset' },
        scale,
        semanticClusters: false,
      }),
      mode: 'preset',
      warning,
    }
  }

  if (mode === 'circular') {
    return {
      layout: forceLayoutWithSeed({
        seed: { type: 'circular' },
        scale,
        semanticClusters: false,
      }),
      mode,
      warning,
    }
  }
  if (mode === 'radial') {
    return {
      layout: forceLayoutWithSeed({
        seed: {
          type: 'radial',
          focusNode: viewState.focusedNodeId ?? projection.view.rootId,
          preventOverlap: true,
        },
        scale,
        semanticClusters: false,
      }),
      mode,
      warning,
    }
  }
  if (mode === 'concentric') {
    return {
      layout: forceLayoutWithSeed({
        seed: {
          type: 'concentric',
          sortBy: 'degree',
          preventOverlap: true,
        },
        scale,
        semanticClusters: false,
      }),
      mode,
      warning,
    }
  }
  if (mode === 'clustered') {
    return {
      layout: forceLayoutWithSeed({
        seed: null,
        scale,
        semanticClusters: true,
      }),
      mode,
      warning,
    }
  }

  return {
    layout: forceLayoutWithSeed({
      seed: null,
      scale,
      semanticClusters: false,
    }),
    mode: 'force',
    warning,
  }
}

export function layoutWarningForNodeCount(nodeCount: number): string | null {
  return layoutWarningForCounts(nodeCount, 0)
}

export function layoutWarningForCounts(nodeCount: number, edgeCount: number): string | null {
  if (nodeCount > CLIENT_GRAPH_NODE_BUDGET && edgeCount > CLIENT_GRAPH_EDGE_BUDGET) {
    return 'Projection exceeds the client node and edge budgets; using a degraded layout and requiring producer-side capping or aggregation.'
  }
  if (nodeCount > CLIENT_GRAPH_NODE_BUDGET) {
    return 'Projection exceeds the client node budget; using a degraded layout.'
  }
  if (edgeCount > CLIENT_GRAPH_EDGE_BUDGET) {
    return 'Projection exceeds the client edge budget; ask the projection producer to cap or aggregate edges.'
  }
  if (nodeCount > WORKER_LAYOUT_NODE_LIMIT) {
    return 'Projection exceeds the worker layout budget; using a degraded layout.'
  }
  if (nodeCount > IN_THREAD_FORCE_NODE_LIMIT) {
    return 'Large projection; layout may run in a worker or degrade.'
  }
  return null
}

export function graphScalePolicy(projection: Pick<GraphProjection, 'nodes' | 'edges'>): GraphScalePolicy {
  const nodeCount = projection.nodes.length
  const edgeCount = projection.edges.length
  const nodeBudgetExceeded = nodeCount > CLIENT_GRAPH_NODE_BUDGET
  const edgeBudgetExceeded = edgeCount > CLIENT_GRAPH_EDGE_BUDGET
  const layoutBudgetExceeded = nodeCount > WORKER_LAYOUT_NODE_LIMIT
  const layoutTier: GraphLayoutTier = nodeBudgetExceeded || layoutBudgetExceeded
    ? 'degraded'
    : nodeCount > IN_THREAD_FORCE_NODE_LIMIT
      ? 'worker'
      : 'in-thread'
  return {
    nodeCount,
    edgeCount,
    layoutTier,
    nodeBudgetExceeded,
    edgeBudgetExceeded,
    warning: layoutWarningForCounts(nodeCount, edgeCount),
  }
}

export function graphLayoutModes(): GraphProjectionLayoutMode[] {
  return ['force', 'circular', 'radial', 'concentric', 'clustered']
}

function hasPresetCoordinates(projection: GraphProjection): boolean {
  return projection.nodes.length > 0 && projection.nodes.every((node) => node.x != null && node.y != null)
}

function forceLayoutWithSeed({
  seed,
  scale,
  semanticClusters,
}: {
  seed: Record<string, unknown> | null
  scale: Pick<GraphScalePolicy, 'layoutTier'>
  semanticClusters: boolean
}): GraphLayoutConfig {
  const forceLayout = scale.layoutTier === 'in-thread'
    ? dynamicForceLayout({
      iterations: IN_THREAD_DYNAMIC_FORCE_ITERATIONS,
      clusterBy: semanticClusters ? SEMANTIC_CLUSTER_BY : COMPONENT_CLUSTER_BY,
      semanticClusters,
    })
    : workerForceLayout({ semanticClusters })
  return seed ? [seed, forceLayout] : forceLayout
}

function dynamicForceLayout({
  iterations,
  clusterBy,
  semanticClusters,
}: {
  iterations: number
  clusterBy: string
  semanticClusters: boolean
}): Record<string, unknown> {
  return {
    type: 'd3-force',
    animation: true,
    iterations,
    preventOverlap: true,
    clustering: true,
    clusterBy,
    center: { strength: semanticClusters ? 0.08 : 0.1 },
    link: {
      distance: semanticClusters ? 86 : 72,
      strength: semanticClusters ? 0.36 : 0.48,
      iterations: 1,
    },
    manyBody: {
      strength: semanticClusters ? -120 : -90,
      theta: 0.88,
      distanceMax: semanticClusters ? 360 : 280,
    },
    collide: {
      strength: 0.72,
      iterations: 2,
    },
    clusterFociStrength: semanticClusters ? 0.34 : 0.2,
    clusterNodeStrength: semanticClusters ? -24 : -16,
    clusterEdgeDistance: semanticClusters ? 140 : 118,
    clusterEdgeStrength: semanticClusters ? 0.04 : 0.02,
    clusterNodeSize: semanticClusters ? 52 : 40,
    alpha: 1,
    alphaMin: 0.002,
    alphaDecay: 0.032,
    velocityDecay: 0.42,
  }
}

function workerForceLayout({ semanticClusters }: { semanticClusters: boolean }): Record<string, unknown> {
  return {
    type: 'force',
    clustering: true,
    preventOverlap: true,
    nodeClusterBy: semanticClusters ? SEMANTIC_CLUSTER_BY : COMPONENT_CLUSTER_BY,
    iterations: WORKER_FORCE_ITERATIONS,
    enableWorker: true,
  }
}
