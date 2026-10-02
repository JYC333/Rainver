import { Graph } from '@antv/g6'
import type { GraphData, GraphOptions } from '@antv/g6'
import { bindGraphInteractions, type GraphEventLike, type GraphEventSource, type GraphInteractionCallbacks } from './graphInteractions'
import type { GraphLabelVisibility, GraphLayoutConfig, GraphNodePosition, GraphRenderData, GraphRendererHandle, GraphRendererMode } from '../types'

interface CreateGraphRendererOptions extends GraphInteractionCallbacks {
  container: HTMLElement
  data: GraphRenderData
  layout: GraphLayoutConfig
  renderer: GraphRendererMode
  background?: string
}

export async function createGraphRenderer(
  options: CreateGraphRendererOptions,
): Promise<GraphRendererHandle> {
  const renderer = options.renderer === 'webgl' ? await createWebglRenderer() : undefined
  let currentData = options.data
  const graph = new Graph({
    container: options.container,
    background: options.background,
    autoResize: false,
    renderer,
    data: toG6Data(options.data),
    layout: options.layout as GraphOptions['layout'],
    animation: false,
    node: {
      state: {
        selected: { lineWidth: 3, shadowBlur: 10, shadowColor: '#2563eb' },
        active: { lineWidth: 2.5, shadowBlur: 8, shadowColor: '#38bdf8' },
        focused: { lineWidth: 3, shadowBlur: 12, shadowColor: '#14b8a6' },
        faded: { opacity: 0.18, labelOpacity: 0.18 },
        pinned: { lineDash: [3, 3] },
      },
    },
    edge: {
      state: {
        selected: { lineWidth: 2.5, opacity: 0.82 },
        active: { lineWidth: 2, opacity: 0.72 },
        faded: { opacity: 0.08, labelOpacity: 0.08 },
      },
    },
    behaviors: graphBehaviorsForLayout(options.layout),
  })
  const cleanupInteractions = bindGraphInteractions(graph as unknown as GraphEventSource, {
    ...options,
    getZoom: () => graph.getZoom(),
  })
  await graph.render()
  await applyPinnedNodePositions(graph, currentData)

  return {
    async setData(data) {
      currentData = data
      graph.setData(toG6Data(data))
      await graph.render()
      await applyPinnedNodePositions(graph, currentData)
    },
    async setLayout(layout) {
      graph.setLayout(layout as NonNullable<GraphOptions['layout']>)
      graph.setBehaviors(graphBehaviorsForLayout(layout))
      await graph.layout()
      await applyPinnedNodePositions(graph, currentData)
    },
    async setLabelVisibility(labels) {
      applyLabelVisibility(graph, labels)
      await graph.draw()
    },
    async setElementLabelVisibility(labels) {
      applyLabelVisibility(graph, labels)
      await graph.draw()
    },
    async setElementStates(states) {
      await graph.setElementState(states)
    },
    async setNodePositions(positions) {
      if (positions.length === 0) return
      await applyNodePositions(graph, positions)
    },
    fitView() {
      return graph.fitView()
    },
    focusNode(nodeId) {
      return graph.focusElement(nodeId)
    },
    zoomBy(ratio) {
      return graph.zoomBy(ratio)
    },
    panBy(offset) {
      return graph.translateBy([offset.x, offset.y])
    },
    resize(width, height) {
      graph.setSize(width, height)
    },
    getZoom() {
      return graph.getZoom()
    },
    destroy() {
      cleanupInteractions()
      graph.destroy()
    },
  }
}

function toG6Data(data: GraphRenderData): GraphData {
  const componentIds = connectedComponentIds(data)
  return {
    nodes: data.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      fx: node.fx,
      fy: node.fy,
      clusterId: node.data.projection.clusterId,
      componentId: componentIds.get(node.id),
      data: node.data,
      style: node.style,
      states: node.states,
    })),
    edges: data.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: edge.data,
      style: edge.style,
      states: edge.states,
    })),
  } as GraphData
}

function graphBehaviorsForLayout(layout: GraphLayoutConfig): NonNullable<GraphOptions['behaviors']> {
  const dragBehavior = supportsDynamicDrag(layout)
    ? { type: 'drag-element-force', fixed: true }
    : 'drag-element'
  return [
    'zoom-canvas',
    'drag-canvas',
    dragBehavior,
    'hover-activate',
    'click-select',
  ] as NonNullable<GraphOptions['behaviors']>
}

function supportsDynamicDrag(layout: GraphLayoutConfig): boolean {
  if (Array.isArray(layout)) return layout.some((candidate) => supportsDynamicDrag(candidate))
  return layout.type === 'd3-force' || layout.type === 'd3-force-3d'
}

function connectedComponentIds(data: GraphRenderData): Map<string, string> {
  const nodeIds = new Set(data.nodes.map((node) => node.id))
  const adjacency = new Map<string, string[]>()
  for (const nodeId of nodeIds) adjacency.set(nodeId, [])
  for (const edge of data.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    adjacency.get(edge.source)?.push(edge.target)
    adjacency.get(edge.target)?.push(edge.source)
  }

  const componentIds = new Map<string, string>()
  let componentIndex = 0
  for (const nodeId of nodeIds) {
    if (componentIds.has(nodeId)) continue
    const componentId = `component:${componentIndex}`
    componentIndex += 1
    const pending = [nodeId]
    componentIds.set(nodeId, componentId)
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index]!
      for (const next of adjacency.get(current) ?? []) {
        if (componentIds.has(next)) continue
        componentIds.set(next, componentId)
        pending.push(next)
      }
    }
  }
  return componentIds
}

function applyLabelVisibility(graph: Graph, labels: GraphLabelVisibility): void {
  if (labels.nodes.length > 0) {
    graph.updateNodeData(labels.nodes.map((node) => ({
      id: node.id,
      style: { labelText: node.labelText },
    })))
  }
  if (labels.edges.length > 0) {
    graph.updateEdgeData(labels.edges.map((edge) => ({
      id: edge.id,
      style: { labelText: edge.labelText },
    })))
  }
}

async function applyPinnedNodePositions(graph: Graph, data: GraphRenderData): Promise<void> {
  const positions = data.nodes
    .filter((node) => typeof node.fx === 'number' && typeof node.fy === 'number')
    .map((node) => ({ id: node.id, x: node.fx as number, y: node.fy as number, fixed: true as const }))
  await applyNodePositions(graph, positions)
}

async function applyNodePositions(
  graph: Graph,
  positions: GraphNodePosition[],
): Promise<void> {
  if (positions.length === 0) return
  graph.updateNodeData(positions.map((position) => ({
    id: position.id,
    fx: position.fixed ? position.x : null,
    fy: position.fixed ? position.y : null,
    style: position.fixed ? { x: position.x, y: position.y } : {},
  })))
  applyFixedPositionsToForceLayouts(graph, positions)
  await graph.draw()
}

function applyFixedPositionsToForceLayouts(graph: Graph, positions: GraphNodePosition[]): void {
  for (const layout of activeForceLayouts(graph)) {
    for (const position of positions) {
      callLayoutMethod(layout, 'setFixedPosition', position.id, position.fixed ? [position.x, position.y] : null)
    }
  }
}

function activeForceLayouts(graph: Graph): unknown[] {
  const context = (graph as unknown as {
    context?: {
      layout?: {
        getLayoutInstance?: () => unknown[]
      }
    }
  }).context
  const layouts = context?.layout?.getLayoutInstance?.() ?? []
  return layouts.filter((layout) => {
    const id = layoutId(layout)
    return id === 'd3-force' || id === 'd3-force-3d'
  })
}

function layoutId(layout: unknown): unknown {
  if (!layout || typeof layout !== 'object') return null
  const record = layout as Record<string, unknown>
  if (typeof record.id === 'string') return record.id
  const instance = record.instance
  return instance && typeof instance === 'object'
    ? (instance as Record<string, unknown>).id
    : null
}

function callLayoutMethod(layout: unknown, method: string, ...args: unknown[]): unknown {
  if (!layout || typeof layout !== 'object') return null
  const record = layout as Record<string, unknown>
  const ownMethod = record[method]
  if (typeof ownMethod === 'function') return ownMethod.apply(layout, args)
  const instance = record.instance
  if (!instance || typeof instance !== 'object') return null
  const instanceMethod = (instance as Record<string, unknown>)[method]
  return typeof instanceMethod === 'function' ? instanceMethod.apply(instance, args) : null
}

async function createWebglRenderer(): Promise<GraphOptions['renderer']> {
  const module = await import('@antv/g-webgl')
  return (() => new module.Renderer({ targets: ['webgl2', 'webgl1'] })) as GraphOptions['renderer']
}

export type { GraphEventLike }
