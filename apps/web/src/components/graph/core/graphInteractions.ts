export interface GraphEventLike {
  target?: unknown
  item?: unknown
  id?: unknown
  x?: unknown
  y?: unknown
  canvas?: unknown
  preventDefault?: unknown
  nativeEvent?: MouseEvent | PointerEvent
}

export interface GraphEventSource {
  on: (eventName: string, handler: (event: GraphEventLike) => void) => void
  off?: (eventName: string, handler: (event: GraphEventLike) => void) => void
}

export interface GraphInteractionCallbacks {
  onNodeClick?: (nodeId: string, event: GraphEventLike) => void
  onNodeDoubleClick?: (nodeId: string, event: GraphEventLike) => void
  onNodeContextMenu?: (nodeId: string, event: GraphEventLike) => void
  onNodeDragEnd?: (nodeId: string, point: { x: number; y: number }, event: GraphEventLike) => void
  onNodeHover?: (nodeId: string | null, event: GraphEventLike) => void
  onViewportChange?: (zoom: number) => void
  getZoom?: () => number
}

export function bindGraphInteractions(
  graph: GraphEventSource,
  callbacks: GraphInteractionCallbacks,
): () => void {
  const handlers: Array<[string, (event: GraphEventLike) => void]> = [
    ['node:click', (event) => callWithNode(event, callbacks.onNodeClick)],
    ['node:dblclick', (event) => callWithNode(event, callbacks.onNodeDoubleClick)],
    ['node:contextmenu', (event) => callWithNode(event, callbacks.onNodeContextMenu)],
    ['node:dragend', (event) => {
      const nodeId = extractElementId(event)
      const point = extractCanvasPoint(event)
      if (nodeId && point) callbacks.onNodeDragEnd?.(nodeId, point, event)
    }],
    ['node:pointerenter', (event) => callbacks.onNodeHover?.(extractElementId(event), event)],
    ['node:pointerleave', (event) => callbacks.onNodeHover?.(null, event)],
    ['canvas:wheel', () => callbacks.onViewportChange?.(callbacks.getZoom?.() ?? 1)],
    ['aftertransform', () => callbacks.onViewportChange?.(callbacks.getZoom?.() ?? 1)],
  ]
  handlers.forEach(([eventName, handler]) => graph.on(eventName, handler))
  return () => {
    if (!graph.off) return
    handlers.forEach(([eventName, handler]) => graph.off?.(eventName, handler))
  }
}

function extractElementId(event: GraphEventLike): string | null {
  const candidates = [event.id, readPath(event.target, ['id']), readPath(event.item, ['id'])]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    if (typeof candidate === 'number') return String(candidate)
  }
  return null
}

export function nativePointerEvent(
  event: GraphEventLike,
): MouseEvent | PointerEvent | { preventDefault?: () => void; clientX?: number; clientY?: number } | null {
  if (event.nativeEvent) return event.nativeEvent
  if (typeof event.preventDefault === 'function') {
    return event as { preventDefault?: () => void; clientX?: number; clientY?: number }
  }
  return null
}

function extractCanvasPoint(event: GraphEventLike): { x: number; y: number } | null {
  const x = typeof event.x === 'number' ? event.x : readPath(event.canvas, ['x'])
  const y = typeof event.y === 'number' ? event.y : readPath(event.canvas, ['y'])
  if (typeof x === 'number' && typeof y === 'number') return { x, y }
  return null
}

function callWithNode(
  event: GraphEventLike,
  callback: ((nodeId: string, event: GraphEventLike) => void) | undefined,
) {
  const nodeId = extractElementId(event)
  if (!nodeId) return
  callback?.(nodeId, event)
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
