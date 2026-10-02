import type { GraphProjection } from '@rainver/protocol'
import { shouldShowEdgeLabel, shouldShowNodeLabel } from './semanticZoom'
import { resolveEdgeStyle, resolveNodeStyle } from './graphTheme'
import type { GraphLabelVisibility, GraphRenderData, GraphTheme, GraphViewState } from '../types'

interface MapProjectionOptions {
  theme: GraphTheme
  viewState: GraphViewState
  zoom?: number
}

export function mapProjectionToRenderData(
  projection: GraphProjection,
  options: MapProjectionOptions,
): GraphRenderData {
  const zoom = options.zoom ?? 1
  const visible = visibleElements(projection, options.viewState)

  const nodes = visible.nodes
    .map((node) => {
      const style = resolveNodeStyle(node, options.theme)
      const pinned = options.viewState.pinnedNodes[node.id]
      const x = pinned?.x ?? node.x
      const y = pinned?.y ?? node.y
      const labelVisible = shouldShowNodeLabel(node, zoom, options.viewState)
      return {
        id: node.id,
        type: style.shape === 'rect' ? 'rect' : 'circle',
        fx: pinned ? pinned.x : undefined,
        fy: pinned ? pinned.y : undefined,
        data: {
          projection: node,
          kind: node.kind,
          labelVisible,
        },
        style: {
          size: style.size,
          r: style.size / 2,
          width: style.shape === 'rect' ? style.size * 1.45 : undefined,
          height: style.shape === 'rect' ? style.size * 0.82 : undefined,
          fill: style.color,
          stroke: style.borderColor,
          lineWidth: node.kind === 'cluster' ? 2 : 1.5,
          lineDash: node.kind === 'cluster' ? [5, 4] : undefined,
          labelText: labelVisible ? node.label : '',
          labelFill: style.textColor,
          labelFontSize: node.kind === 'cluster' ? 12 : 11,
          labelPlacement: 'bottom',
          x,
          y,
        },
        states: initialNodeStates(node.id, options.viewState),
      }
    })

  const edges = visible.edges
    .map((edge) => {
      const style = resolveEdgeStyle(edge, options.theme)
      const labelVisible = shouldShowEdgeLabel(edge, zoom, options.viewState)
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        data: {
          projection: edge,
          kind: edge.kind,
          labelVisible,
        },
        style: {
          stroke: style.color,
          lineWidth: style.width,
          opacity: style.opacity,
          lineDash: style.lineDash,
          labelText: labelVisible ? edge.label : '',
          labelFill: style.textColor,
          labelFontSize: 10,
        },
        states: initialEdgeStates(edge.source, edge.target, options.viewState),
      }
    })

  return { nodes, edges }
}

function initialNodeStates(nodeId: string, state: GraphViewState): string[] {
  const states: string[] = []
  if (state.selectedNodeId === nodeId) states.push('selected')
  if (state.hoveredNodeId === nodeId) states.push('active')
  if (state.focusedNodeId === nodeId) states.push('focused')
  if (state.pinnedNodes[nodeId]) states.push('pinned')
  return states
}

function initialEdgeStates(source: string, target: string, state: GraphViewState): string[] {
  const states: string[] = []
  if (state.selectedNodeId === source || state.selectedNodeId === target) states.push('selected')
  if (state.hoveredNodeId === source || state.hoveredNodeId === target) states.push('active')
  return states
}

/** The nodes and edges `mapProjectionToRenderData` draws for this view state. */
function visibleElements(projection: GraphProjection, state: GraphViewState) {
  const hiddenKinds = new Set(state.hiddenKinds)
  const activeEdgeKinds = new Set(state.activeEdgeKinds)
  const nodes = projection.nodes.filter((node) => !hiddenKinds.has(node.kind))
  const visibleNodeIds = new Set(nodes.map((node) => node.id))
  const edges = projection.edges
    .filter((edge) => !edge.hidden)
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .filter((edge) => activeEdgeKinds.size === 0 || activeEdgeKinds.has(edge.kind))
  return { nodes, edges }
}

export function buildElementStateMap(
  projection: GraphProjection,
  state: GraphViewState,
): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  const activeNode = state.hoveredNodeId ?? state.selectedNodeId
  const neighbors = new Set<string>()
  if (activeNode) {
    neighbors.add(activeNode)
    for (const edge of projection.edges) {
      if (edge.source === activeNode) neighbors.add(edge.target)
      if (edge.target === activeNode) neighbors.add(edge.source)
    }
  }

  // Only what is drawn: G6 refuses a whole state batch that names an element
  // it does not hold, so a hidden kind or an edge filter would otherwise stop
  // every hover and selection highlight.
  const visible = visibleElements(projection, state)
  for (const node of visible.nodes) {
    const states = initialNodeStates(node.id, state)
    if (activeNode && !neighbors.has(node.id)) states.push('faded')
    map[node.id] = states
  }
  for (const edge of visible.edges) {
    const states = initialEdgeStates(edge.source, edge.target, state)
    if (activeNode && edge.source !== activeNode && edge.target !== activeNode) states.push('faded')
    map[edge.id] = states
  }
  return map
}

export function buildLabelVisibility(
  projection: GraphProjection,
  state: GraphViewState,
  zoom: number,
): GraphLabelVisibility {
  const visible = visibleElements(projection, state)
  return {
    nodes: visible.nodes
      .map((node) => ({
        id: node.id,
        labelText: shouldShowNodeLabel(node, zoom, state) ? node.label : '',
      })),
    edges: visible.edges
      .map((edge) => ({
        id: edge.id,
        labelText: shouldShowEdgeLabel(edge, zoom, state) ? edge.label ?? '' : '',
      })),
  }
}

export function buildInteractionLabelVisibility(
  projection: GraphProjection,
  state: GraphViewState,
  previousState: Pick<GraphViewState, 'selectedNodeId' | 'hoveredNodeId'>,
  zoom: number,
): GraphLabelVisibility {
  const affectedNodeIds = new Set(
    [
      state.selectedNodeId,
      state.hoveredNodeId,
      previousState.selectedNodeId,
      previousState.hoveredNodeId,
    ].filter((nodeId): nodeId is string => Boolean(nodeId)),
  )
  if (affectedNodeIds.size === 0) return { nodes: [], edges: [] }

  const visible = visibleElements(projection, state)

  return {
    nodes: visible.nodes
      .filter((node) => affectedNodeIds.has(node.id))
      .map((node) => ({
        id: node.id,
        labelText: shouldShowNodeLabel(node, zoom, state) ? node.label : '',
      })),
    edges: visible.edges
      .filter((edge) => affectedNodeIds.has(edge.source) || affectedNodeIds.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        labelText: shouldShowEdgeLabel(edge, zoom, state) ? edge.label ?? '' : '',
      })),
  }
}
