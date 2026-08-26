import type {
  GraphProjection,
  GraphProjectionEdge,
  GraphProjectionLayoutMode,
  GraphProjectionNode,
} from '@rainver/protocol'

export type GraphRendererMode = 'canvas' | 'webgl'
export type GraphThemeMode = 'light' | 'dark'
export type GraphLayoutSource = 'default' | 'user'

export interface GraphNodeStyle {
  color: string
  borderColor: string
  textColor: string
  size: number
  shape?: 'circle' | 'rect' | 'diamond'
  haloColor?: string
}

export interface GraphEdgeStyle {
  color: string
  textColor: string
  width: number
  opacity: number
  lineDash?: number[]
}

export interface GraphTheme {
  mode: GraphThemeMode
  background: string
  node: Record<string, GraphNodeStyle>
  edge: Record<string, GraphEdgeStyle>
  fallbackNode: GraphNodeStyle
  fallbackEdge: GraphEdgeStyle
}

export type GraphThemeOverrides = Partial<{
  node: Record<string, Partial<GraphNodeStyle>>
  edge: Record<string, Partial<GraphEdgeStyle>>
}>

export interface GraphViewState {
  selectedNodeId: string | null
  hoveredNodeId: string | null
  focusedNodeId: string | null
  expandedClusterIds: string[]
  hiddenKinds: string[]
  activeEdgeKinds: string[]
  currentLayout: GraphProjectionLayoutMode
  layoutSource: GraphLayoutSource
  pinnedNodes: Record<string, { x: number; y: number }>
  rendererMode: GraphRendererMode
}

export interface GraphPointerEventLike {
  preventDefault?: () => void
  clientX?: number
  clientY?: number
}

export type GraphViewAction =
  | { type: 'select-node'; nodeId: string | null }
  | { type: 'hover-node'; nodeId: string | null }
  | { type: 'focus-node'; nodeId: string | null }
  | { type: 'toggle-kind'; kind: string }
  | { type: 'set-edge-kind-active'; kind: string; active: boolean }
  | { type: 'set-active-edge-kinds'; kinds: string[] }
  | { type: 'set-layout'; layout: GraphProjectionLayoutMode }
  | { type: 'set-renderer'; renderer: GraphRendererMode }
  | { type: 'pin-node'; nodeId: string; point: { x: number; y: number } }
  | { type: 'unpin-node'; nodeId: string }
  | { type: 'toggle-cluster-expanded'; clusterId: string }
  | { type: 'reset-view' }
  | { type: 'replace'; state: GraphViewState }

export interface GraphViewport {
  zoom: number
}

export interface GraphViewProps {
  projection: GraphProjection | null
  viewState?: GraphViewState
  onViewStateChange?: (state: GraphViewState) => void
  renderer?: GraphRendererMode
  themeMode?: GraphThemeMode
  theme?: GraphThemeOverrides
  loading?: boolean
  error?: string | null
  className?: string
  onNodeSelect?: (node: GraphProjectionNode | null) => void
  onNodeExpand?: (node: GraphProjectionNode) => void
  onNodeContextMenu?: (node: GraphProjectionNode, event: MouseEvent | PointerEvent | GraphPointerEventLike) => void
  onViewportChange?: (viewport: GraphViewport) => void
  renderNodeDetails?: (node: GraphProjectionNode) => React.ReactNode
}

export interface GraphRenderNode {
  id: string
  type: string
  fx?: number
  fy?: number
  data: {
    projection: GraphProjectionNode
    kind: string
    labelVisible: boolean
  }
  style: Record<string, unknown>
  states?: string[]
}

export interface GraphRenderEdge {
  id: string
  source: string
  target: string
  data: {
    projection: GraphProjectionEdge
    kind: string
    labelVisible: boolean
  }
  style: Record<string, unknown>
  states?: string[]
}

export interface GraphRenderData {
  nodes: GraphRenderNode[]
  edges: GraphRenderEdge[]
}

export type GraphLayoutConfig = Record<string, unknown> | Array<Record<string, unknown>>
export type GraphNodePosition =
  | { id: string; x: number; y: number; fixed: true }
  | { id: string; fixed: false }

export interface GraphRendererHandle {
  setData: (data: GraphRenderData) => Promise<void>
  setLayout: (layout: GraphLayoutConfig) => Promise<void>
  setLabelVisibility: (labels: GraphLabelVisibility) => Promise<void>
  setElementLabelVisibility: (labels: GraphLabelVisibility) => Promise<void>
  setElementStates: (states: Record<string, string[]>) => Promise<void>
  setNodePositions: (positions: GraphNodePosition[]) => Promise<void>
  fitView: () => Promise<void>
  focusNode: (nodeId: string) => Promise<void>
  zoomBy: (ratio: number) => Promise<void>
  panBy: (offset: { x: number; y: number }) => Promise<void>
  resize: (width: number, height: number) => void
  getZoom: () => number
  destroy: () => void
}

export interface GraphLabelVisibility {
  nodes: Array<{ id: string; labelText: string }>
  edges: Array<{ id: string; labelText: string }>
}
