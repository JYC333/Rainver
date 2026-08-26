import type { GraphProjectionEdge, GraphProjectionNode } from '@rainver/protocol'

export type SemanticZoomBand = 'overview' | 'standard' | 'detail'

export function zoomBandForScale(scale: number): SemanticZoomBand {
  if (scale < 0.55) return 'overview'
  if (scale < 1.2) return 'standard'
  return 'detail'
}

export function shouldShowNodeLabel(
  node: GraphProjectionNode,
  scale: number,
  state: { selectedNodeId?: string | null; hoveredNodeId?: string | null; focusedNodeId?: string | null } = {},
): boolean {
  if (node.metadata && node.metadata.forceLabel === true) return true
  if (state.selectedNodeId === node.id || state.hoveredNodeId === node.id || state.focusedNodeId === node.id) {
    return true
  }
  const band = zoomBandForScale(scale)
  if (node.kind === 'cluster') return true
  if (band === 'detail') return true
  if (band === 'standard') return (node.degree ?? 0) >= 2
  return (node.degree ?? 0) >= 5
}

export function shouldShowEdgeLabel(
  edge: GraphProjectionEdge,
  scale: number,
  state: { selectedNodeId?: string | null; hoveredNodeId?: string | null } = {},
): boolean {
  if (!edge.label) return false
  const hasActiveEndpoint =
    state.selectedNodeId === edge.source ||
    state.selectedNodeId === edge.target ||
    state.hoveredNodeId === edge.source ||
    state.hoveredNodeId === edge.target
  if (hasActiveEndpoint) return scale >= 0.85
  return zoomBandForScale(scale) === 'detail' && (edge.weight ?? 1) >= 2
}
