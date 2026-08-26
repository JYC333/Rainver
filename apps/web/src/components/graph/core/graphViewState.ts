import { useReducer } from 'react'
import type { GraphLayoutSource, GraphRendererMode, GraphViewAction, GraphViewState } from '../types'
import type { GraphProjectionLayoutMode } from '@rainver/protocol'

export const DEFAULT_GRAPH_VIEW_STATE: GraphViewState = {
  selectedNodeId: null,
  hoveredNodeId: null,
  focusedNodeId: null,
  expandedClusterIds: [],
  hiddenKinds: [],
  activeEdgeKinds: [],
  currentLayout: 'force',
  layoutSource: 'default',
  pinnedNodes: {},
  rendererMode: 'canvas',
}

export function graphViewReducer(state: GraphViewState, action: GraphViewAction): GraphViewState {
  switch (action.type) {
    case 'select-node':
      return { ...state, selectedNodeId: action.nodeId }
    case 'hover-node':
      return { ...state, hoveredNodeId: action.nodeId }
    case 'focus-node':
      return { ...state, focusedNodeId: action.nodeId }
    case 'toggle-kind':
      return toggleListValue(state, 'hiddenKinds', action.kind)
    case 'set-edge-kind-active':
      return setListMembership(state, 'activeEdgeKinds', action.kind, action.active)
    case 'set-active-edge-kinds':
      return { ...state, activeEdgeKinds: Array.from(new Set(action.kinds)).sort() }
    case 'set-layout':
      return { ...state, currentLayout: action.layout, layoutSource: 'user' }
    case 'set-renderer':
      return { ...state, rendererMode: action.renderer }
    case 'pin-node':
      return {
        ...state,
        pinnedNodes: { ...state.pinnedNodes, [action.nodeId]: action.point },
      }
    case 'unpin-node': {
      const { [action.nodeId]: _removed, ...rest } = state.pinnedNodes
      void _removed
      return { ...state, pinnedNodes: rest }
    }
    case 'toggle-cluster-expanded':
      return toggleListValue(state, 'expandedClusterIds', action.clusterId)
    case 'reset-view':
      return {
        ...DEFAULT_GRAPH_VIEW_STATE,
        rendererMode: state.rendererMode,
      }
    case 'replace':
      return normalizeGraphViewState(action.state)
    default:
      return state
  }
}

export function useGraphViewState(initialState: Partial<GraphViewState> = {}) {
  return useReducer(graphViewReducer, normalizeGraphViewState(initialState))
}

export function normalizeGraphViewState(state: Partial<GraphViewState> = {}): GraphViewState {
  const source = isRecord(state) ? state : {}
  const layout = graphLayoutMode(source.currentLayout)
  return {
    selectedNodeId: nullableString(source.selectedNodeId),
    hoveredNodeId: nullableString(source.hoveredNodeId),
    focusedNodeId: nullableString(source.focusedNodeId),
    expandedClusterIds: stringList(source.expandedClusterIds, DEFAULT_GRAPH_VIEW_STATE.expandedClusterIds),
    hiddenKinds: stringList(source.hiddenKinds, DEFAULT_GRAPH_VIEW_STATE.hiddenKinds),
    activeEdgeKinds: stringList(source.activeEdgeKinds, DEFAULT_GRAPH_VIEW_STATE.activeEdgeKinds),
    currentLayout: layout ?? DEFAULT_GRAPH_VIEW_STATE.currentLayout,
    layoutSource: graphLayoutSource(source.layoutSource, layout),
    pinnedNodes: pinnedNodes(source.pinnedNodes, DEFAULT_GRAPH_VIEW_STATE.pinnedNodes),
    rendererMode: graphRendererMode(source.rendererMode),
  }
}

export function persistentGraphViewState(state: GraphViewState): Pick<
  GraphViewState,
  'expandedClusterIds' | 'hiddenKinds' | 'activeEdgeKinds' | 'currentLayout' | 'layoutSource' | 'pinnedNodes' | 'rendererMode'
> {
  return {
    expandedClusterIds: state.expandedClusterIds,
    hiddenKinds: state.hiddenKinds,
    activeEdgeKinds: state.activeEdgeKinds,
    currentLayout: state.currentLayout,
    layoutSource: state.layoutSource,
    pinnedNodes: state.pinnedNodes,
    rendererMode: state.rendererMode,
  }
}

function toggleListValue<K extends 'hiddenKinds' | 'expandedClusterIds'>(
  state: GraphViewState,
  key: K,
  value: string,
): GraphViewState {
  const values = new Set(state[key])
  if (values.has(value)) values.delete(value)
  else values.add(value)
  return { ...state, [key]: Array.from(values) }
}

function setListMembership<K extends 'activeEdgeKinds'>(
  state: GraphViewState,
  key: K,
  value: string,
  active: boolean,
): GraphViewState {
  const values = new Set(state[key])
  if (active) values.add(value)
  else values.delete(value)
  return { ...state, [key]: Array.from(values) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.every((entry) => typeof entry === 'string')
    ? value
    : value.filter((entry): entry is string => typeof entry === 'string')
}

function graphLayoutMode(value: unknown): GraphProjectionLayoutMode | null {
  return value === 'preset' ||
    value === 'force' ||
    value === 'circular' ||
    value === 'radial' ||
    value === 'concentric' ||
    value === 'clustered'
    ? value
    : null
}

function graphLayoutSource(value: unknown, layout: GraphProjectionLayoutMode | null): GraphLayoutSource {
  if (value === 'user' || value === 'default') return value
  return layout && layout !== DEFAULT_GRAPH_VIEW_STATE.currentLayout ? 'user' : DEFAULT_GRAPH_VIEW_STATE.layoutSource
}

function graphRendererMode(value: unknown): GraphRendererMode {
  return value === 'webgl' || value === 'canvas' ? value : DEFAULT_GRAPH_VIEW_STATE.rendererMode
}

function pinnedNodes(value: unknown, fallback: GraphViewState['pinnedNodes']): GraphViewState['pinnedNodes'] {
  if (!isRecord(value)) return fallback
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fallback
  const normalized: GraphViewState['pinnedNodes'] = {}
  let changed = false
  for (const [nodeId, point] of Object.entries(value)) {
    if (!isRecord(point)) {
      changed = true
      continue
    }
    if (typeof point.x !== 'number' || typeof point.y !== 'number') {
      changed = true
      continue
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      changed = true
      continue
    }
    normalized[nodeId] = { x: point.x, y: point.y }
  }
  return changed ? normalized : value as GraphViewState['pinnedNodes']
}
