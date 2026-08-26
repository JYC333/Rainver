import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { GraphProjection } from '@rainver/protocol'
import { GraphView } from '../GraphView'
import { normalizeGraphViewState } from '../core/graphViewState'

const graphMock = vi.hoisted(() => ({
  deferLayouts: false,
  instances: [] as Array<{
    options: Record<string, unknown>
    handlers: Record<string, Array<(event: Record<string, unknown>) => void>>
    setDataCalls: unknown[]
    setLayoutCalls: unknown[]
    setBehaviorsCalls: unknown[]
    layoutCalls: unknown[]
    layoutResolvers: Array<() => void>
    updateNodeDataCalls: unknown[]
    updateEdgeDataCalls: unknown[]
    setElementStateCalls: unknown[]
    setFixedPositionCalls: Array<{ id: string; position: unknown }>
    zoomByCalls: number[]
    panByCalls: Array<{ x: number; y: number }>
    focusElementCalls: string[]
    drawCalls: number
    destroyed: boolean
    emit: (eventName: string, event: Record<string, unknown>) => void
    setData: (data: unknown) => void
    setLayout: (layout: unknown) => void
    setBehaviors: (behaviors: unknown) => void
    layout: () => Promise<void>
    updateNodeData: (data: unknown) => void
    updateEdgeData: (data: unknown) => void
    draw: () => Promise<void>
    setElementState: (state: unknown) => Promise<void>
    fitView: () => Promise<void>
    focusElement: (nodeId: string) => Promise<void>
    zoomBy: (ratio: number) => Promise<void>
    translateBy: (offset: [number, number]) => Promise<void>
    setSize: (width: number, height: number) => void
    getZoom: () => number
    destroy: () => void
  }>,
}))

vi.mock('@antv/g6', () => {
  class Graph {
    options: Record<string, unknown>
    handlers: Record<string, Array<(event: Record<string, unknown>) => void>> = {}
    setDataCalls: unknown[] = []
    setLayoutCalls: unknown[] = []
    setBehaviorsCalls: unknown[] = []
    layoutCalls: unknown[] = []
    layoutResolvers: Array<() => void> = []
    updateNodeDataCalls: unknown[] = []
    updateEdgeDataCalls: unknown[] = []
    setElementStateCalls: unknown[] = []
    setFixedPositionCalls: Array<{ id: string; position: unknown }> = []
    forceLayout = {
      id: 'd3-force',
      setFixedPosition: (id: string, position: unknown) => {
        this.setFixedPositionCalls.push({ id, position })
      },
    }
    context = {
      layout: {
        getLayoutInstance: () => [this.forceLayout],
      },
    }
    zoomByCalls: number[] = []
    panByCalls: Array<{ x: number; y: number }> = []
    focusElementCalls: string[] = []
    drawCalls = 0
    destroyed = false
    zoom = 1

    constructor(options: Record<string, unknown>) {
      this.options = options
      graphMock.instances.push(this)
    }

    on(eventName: string, handler: (event: Record<string, unknown>) => void) {
      this.handlers[eventName] = [...(this.handlers[eventName] ?? []), handler]
      return this
    }

    off(eventName: string, handler: (event: Record<string, unknown>) => void) {
      this.handlers[eventName] = (this.handlers[eventName] ?? []).filter((candidate) => candidate !== handler)
      return this
    }

    emit(eventName: string, event: Record<string, unknown>) {
      for (const handler of this.handlers[eventName] ?? []) handler(event)
    }

    async render() {}
    setData(data: unknown) {
      this.setDataCalls.push(data)
    }
    setLayout(layout: unknown) {
      this.setLayoutCalls.push(layout)
    }
    setBehaviors(behaviors: unknown) {
      this.setBehaviorsCalls.push(behaviors)
    }
    async layout() {
      this.layoutCalls.push({})
      if (graphMock.deferLayouts) {
        await new Promise<void>((resolve) => this.layoutResolvers.push(resolve))
      }
    }
    updateNodeData(data: unknown) {
      this.updateNodeDataCalls.push(data)
    }
    updateEdgeData(data: unknown) {
      this.updateEdgeDataCalls.push(data)
    }
    async draw() {
      this.drawCalls += 1
    }
    async setElementState(state: unknown) {
      this.setElementStateCalls.push(state)
    }
    async fitView() {}
    async focusElement(nodeId: string) {
      this.focusElementCalls.push(nodeId)
    }
    async zoomBy(ratio: number) {
      this.zoomByCalls.push(ratio)
      this.zoom *= ratio
    }
    async translateBy(offset: [number, number]) {
      this.panByCalls.push({ x: offset[0], y: offset[1] })
    }
    setSize(_width: number, _height: number) {}
    getZoom() {
      return this.zoom
    }
    destroy() {
      this.destroyed = true
    }
  }
  return { Graph }
})

const projection: GraphProjection = {
  nodes: [
    { id: 'n1', kind: 'note', label: 'First note', degree: 3 },
    { id: 'n2', kind: 'claim', label: 'Claim', degree: 1 },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'supports', weight: 2 }],
  view: { mode: 'local', rootId: 'n1', depth: 1, generatedAt: '2026-07-04T12:00:00.000Z' },
  layout: { mode: 'force' },
}

describe('GraphView', () => {
  beforeEach(() => {
    graphMock.deferLayouts = false
    graphMock.instances.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  it('mounts one G6 instance, updates data, and destroys it on unmount', async () => {
    const { rerender, unmount } = render(<GraphView projection={projection} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!

    const nextProjection = {
      ...projection,
      nodes: [...projection.nodes, { id: 'n3', kind: 'source', label: 'Source' }],
    }
    rerender(<GraphView projection={nextProjection} />)

    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    expect(graph.setDataCalls.length).toBeGreaterThan(0)

    unmount()
    expect(graph.destroyed).toBe(true)
  })

  it('translates node click and drag events into callbacks and view state', async () => {
    const onNodeSelect = vi.fn()
    const onViewStateChange = vi.fn()
    render(
      <GraphView
        projection={projection}
        onNodeSelect={onNodeSelect}
        onViewStateChange={onViewStateChange}
      />,
    )
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!

    act(() => graph.emit('node:click', { id: 'n1' }))
    expect(onNodeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }))
    expect(await screen.findByText('First note')).toBeInTheDocument()

    act(() => graph.emit('node:dragend', { id: 'n1', x: 10, y: 20 }))
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      pinnedNodes: { n1: { x: 10, y: 20 } },
    }))
  })

  it('updates hover and selection states without remapping graph data or layout', async () => {
    const baseState = {
      selectedNodeId: null,
      hoveredNodeId: null,
      focusedNodeId: null,
      expandedClusterIds: [],
      hiddenKinds: [],
      activeEdgeKinds: [],
      currentLayout: 'force' as const,
      layoutSource: 'default' as const,
      pinnedNodes: {},
      rendererMode: 'canvas' as const,
    }
    const { rerender } = render(<GraphView projection={projection} viewState={baseState} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!
    await waitFor(() => expect(graph.updateNodeDataCalls.length).toBeGreaterThan(0))
    graph.setDataCalls.length = 0
    graph.setLayoutCalls.length = 0
    graph.layoutCalls.length = 0
    graph.setElementStateCalls.length = 0
    graph.updateNodeDataCalls.length = 0
    graph.updateEdgeDataCalls.length = 0
    graph.drawCalls = 0

    rerender(<GraphView projection={projection} viewState={{ ...baseState, hoveredNodeId: 'n1' }} />)

    await waitFor(() => expect(graph.updateNodeDataCalls).toHaveLength(1))
    expect(graph.setElementStateCalls.length).toBeGreaterThan(0)
    expect(graph.setDataCalls).toHaveLength(0)
    expect(graph.setLayoutCalls).toHaveLength(0)
    expect(graph.layoutCalls).toHaveLength(0)
    expect(graph.updateNodeDataCalls).toHaveLength(1)
    expect(graph.updateEdgeDataCalls).toHaveLength(1)
    expect(graph.drawCalls).toBe(1)

    graph.setElementStateCalls.length = 0
    graph.updateNodeDataCalls.length = 0
    graph.updateEdgeDataCalls.length = 0
    graph.drawCalls = 0
    rerender(<GraphView projection={projection} viewState={{ ...baseState, selectedNodeId: 'n1' }} />)

    await waitFor(() => expect(graph.updateNodeDataCalls).toHaveLength(1))
    expect(graph.setElementStateCalls.length).toBeGreaterThan(0)
    expect(graph.setDataCalls).toHaveLength(0)
    expect(graph.setLayoutCalls).toHaveLength(0)
    expect(graph.layoutCalls).toHaveLength(0)
    expect(graph.updateNodeDataCalls).toHaveLength(1)
    expect(graph.updateEdgeDataCalls).toHaveLength(1)
    expect(graph.drawCalls).toBe(1)
  })

  it('handles real G6-style context menu events without nativeEvent', async () => {
    const onNodeContextMenu = vi.fn()
    const preventDefault = vi.fn()
    render(<GraphView projection={projection} onNodeContextMenu={onNodeContextMenu} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))

    act(() => graphMock.instances[0]!.emit('node:contextmenu', { id: 'n1', preventDefault }))

    expect(preventDefault).toHaveBeenCalled()
    expect(onNodeContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'n1' }),
      expect.objectContaining({ preventDefault }),
    )
  })

  it('supports viewport overlay controls and Obsidian-style keyboard navigation', async () => {
    const user = userEvent.setup({ delay: null })
    render(<GraphView projection={projection} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!

    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(graph.zoomByCalls).toContain(1.18))

    const surface = screen.getByRole('region', { name: /interactive graph canvas/i })
    surface.focus()
    await user.keyboard('{ArrowRight}')
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(graph.panByCalls).toContainEqual({ x: 36, y: 0 })
    expect(graph.panByCalls).toContainEqual({ x: 0, y: -96 })

    act(() => graph.emit('node:click', { id: 'n1' }))
    await user.click(screen.getByRole('button', { name: 'Focus selected node' }))

    expect(graph.focusElementCalls).toContain('n1')
  })

  it('uses dynamic force dragging for force and seeded layouts', async () => {
    const baseState = {
      selectedNodeId: null,
      hoveredNodeId: null,
      focusedNodeId: null,
      expandedClusterIds: [],
      hiddenKinds: [],
      activeEdgeKinds: [],
      currentLayout: 'force' as const,
      layoutSource: 'default' as const,
      pinnedNodes: {},
      rendererMode: 'canvas' as const,
    }
    const { rerender } = render(<GraphView projection={projection} viewState={baseState} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!

    expect(graph.options.behaviors).toContainEqual({ type: 'drag-element-force', fixed: true })

    rerender(<GraphView projection={projection} viewState={{ ...baseState, currentLayout: 'radial', layoutSource: 'user' }} />)

    await waitFor(() => expect(lastCall(graph.setBehaviorsCalls)).toContainEqual({ type: 'drag-element-force', fixed: true }))
  })

  it('passes connected component ids to the renderer for separated force groups', async () => {
    render(
      <GraphView
        projection={{
          ...projection,
          nodes: [...projection.nodes, { id: 'n3', kind: 'note', label: 'Disconnected note' }],
        }}
      />,
    )
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graphData = graphMock.instances[0]!.options.data as { nodes: Array<{ id: string; componentId: string }> }
    const componentByNode = new Map(graphData.nodes.map((node) => [node.id, node.componentId]))

    expect(componentByNode.get('n1')).toBe(componentByNode.get('n2'))
    expect(componentByNode.get('n3')).not.toBe(componentByNode.get('n1'))
  })

  it('pins dragged nodes in seeded layouts without rerunning the layout', async () => {
    function Harness() {
      const [viewState, setViewState] = useState(() =>
        normalizeGraphViewState({ currentLayout: 'circular', layoutSource: 'user' }))
      return <GraphView projection={projection} viewState={viewState} onViewStateChange={setViewState} />
    }

    render(<Harness />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!
    await waitFor(() => expect(graph.updateNodeDataCalls.length).toBeGreaterThan(0))
    graph.setDataCalls.length = 0
    graph.setLayoutCalls.length = 0
    graph.layoutCalls.length = 0
    graph.updateNodeDataCalls.length = 0
    graph.drawCalls = 0

    act(() => graph.emit('node:dragend', { id: 'n1', x: 42, y: 84 }))

    await waitFor(() => expect(graph.updateNodeDataCalls).toContainEqual([
      { id: 'n1', fx: 42, fy: 84, style: { x: 42, y: 84 } },
    ]))
    expect(graph.setFixedPositionCalls).toContainEqual({ id: 'n1', position: [42, 84] })
    expect(graph.setDataCalls).toHaveLength(0)
    expect(graph.setLayoutCalls).toHaveLength(0)
    expect(graph.layoutCalls).toHaveLength(0)
    expect(graph.drawCalls).toBe(1)
  })

  it('releases force fixed positions when pinned nodes are reset', async () => {
    const user = userEvent.setup({ delay: null })
    function Harness() {
      const [viewState, setViewState] = useState(() =>
        normalizeGraphViewState({ currentLayout: 'circular', layoutSource: 'user' }))
      return <GraphView projection={projection} viewState={viewState} onViewStateChange={setViewState} />
    }

    render(<Harness />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!
    graph.setDataCalls.length = 0

    act(() => graph.emit('node:dragend', { id: 'n1', x: 42, y: 84 }))
    await waitFor(() => expect(graph.setFixedPositionCalls).toContainEqual({ id: 'n1', position: [42, 84] }))

    graph.updateNodeDataCalls.length = 0
    graph.setFixedPositionCalls.length = 0

    await user.click(screen.getByRole('button', { name: /reset view/i }))

    await waitFor(() => expect(graph.updateNodeDataCalls).toContainEqual([
      { id: 'n1', fx: null, fy: null, style: {} },
    ]))
    expect(graph.setFixedPositionCalls).toContainEqual({ id: 'n1', position: null })
    expect(graph.setDataCalls).toHaveLength(0)
  })

  it('reapplies pinned node positions after seeded layout data refreshes', async () => {
    const pinnedState = normalizeGraphViewState({
      currentLayout: 'circular',
      layoutSource: 'user',
      pinnedNodes: { n1: { x: 12, y: 24 } },
    })
    const { rerender } = render(<GraphView projection={projection} viewState={pinnedState} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!

    await waitFor(() => expect(graph.updateNodeDataCalls).toContainEqual([
      { id: 'n1', fx: 12, fy: 24, style: { x: 12, y: 24 } },
    ]))
    graph.setDataCalls.length = 0
    graph.updateNodeDataCalls.length = 0

    rerender(
      <GraphView
        projection={{
          ...projection,
          nodes: [...projection.nodes, { id: 'n3', kind: 'note', label: 'Third note' }],
        }}
        viewState={pinnedState}
      />,
    )

    await waitFor(() => expect(graph.setDataCalls.length).toBeGreaterThan(0))
    await waitFor(() => expect(graph.updateNodeDataCalls).toContainEqual([
      { id: 'n1', fx: 12, fy: 24, style: { x: 12, y: 24 } },
    ]))
    expect(graph.setFixedPositionCalls).toContainEqual({ id: 'n1', position: [12, 24] })
  })

  it('reruns layouts and updates zoom labels without full data remaps', async () => {
    const baseState = {
      selectedNodeId: null,
      hoveredNodeId: null,
      focusedNodeId: null,
      expandedClusterIds: [],
      hiddenKinds: [],
      activeEdgeKinds: [],
      currentLayout: 'force' as const,
      layoutSource: 'default' as const,
      pinnedNodes: {},
      rendererMode: 'canvas' as const,
    }
    const { rerender } = render(<GraphView projection={projection} viewState={baseState} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!
    graph.setDataCalls.length = 0
    graph.setLayoutCalls.length = 0
    graph.layoutCalls.length = 0

    rerender(<GraphView projection={projection} viewState={{ ...baseState, currentLayout: 'radial', layoutSource: 'user' }} />)

    await waitFor(() => expect(graph.setLayoutCalls.length).toBeGreaterThan(0))
    expect(graph.layoutCalls.length).toBeGreaterThan(0)
    expect(graph.setDataCalls).toHaveLength(0)

    graph.setDataCalls.length = 0
    graph.setLayoutCalls.length = 0
    graph.layoutCalls.length = 0

    rerender(
      <GraphView
        projection={projection}
        viewState={{ ...baseState, currentLayout: 'radial', layoutSource: 'user', focusedNodeId: 'n2' }}
      />,
    )

    await waitFor(() => expect(graph.setLayoutCalls[graph.setLayoutCalls.length - 1]).toMatchObject([
      { focusNode: 'n2' },
      { type: 'd3-force' },
    ]))
    expect(graph.layoutCalls.length).toBeGreaterThan(0)
    expect(graph.setDataCalls).toHaveLength(0)

    const setDataCount = graph.setDataCalls.length
    act(() => graph.emit('aftertransform', {}))
    await waitFor(() => expect(graph.updateNodeDataCalls.length).toBeGreaterThan(0))
    expect(graph.updateEdgeDataCalls.length).toBeGreaterThan(0)
    expect(graph.setDataCalls).toHaveLength(setDataCount)
  })

  it('serializes overlapping layout requests and applies the latest layout last', async () => {
    graphMock.deferLayouts = true
    const baseState = normalizeGraphViewState({ currentLayout: 'radial', layoutSource: 'user' })
    const { rerender } = render(<GraphView projection={projection} viewState={baseState} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!
    graph.setDataCalls.length = 0
    graph.setLayoutCalls.length = 0
    graph.layoutCalls.length = 0

    rerender(<GraphView projection={projection} viewState={{ ...baseState, focusedNodeId: 'n1' }} />)
    await waitFor(() => expect(graph.setLayoutCalls).toHaveLength(1))
    expect(graph.setLayoutCalls[0]).toMatchObject([
      { focusNode: 'n1' },
      { type: 'd3-force' },
    ])

    rerender(<GraphView projection={projection} viewState={{ ...baseState, focusedNodeId: 'n2' }} />)
    expect(graph.setLayoutCalls).toHaveLength(1)

    await act(async () => {
      graph.layoutResolvers.shift()?.()
      await Promise.resolve()
    })

    await waitFor(() => expect(graph.setLayoutCalls).toHaveLength(2))
    expect(graph.setLayoutCalls[1]).toMatchObject([
      { focusNode: 'n2' },
      { type: 'd3-force' },
    ])
    expect(graph.setDataCalls).toHaveLength(0)

    await act(async () => {
      graph.layoutResolvers.shift()?.()
      await Promise.resolve()
    })
  })

  it('queues dragged node pins while a layout mutation is running', async () => {
    graphMock.deferLayouts = true
    const baseState = normalizeGraphViewState({ currentLayout: 'radial', layoutSource: 'user' })
    function Harness({ focusedNodeId }: { focusedNodeId: string | null }) {
      const [viewState, setViewState] = useState(baseState)
      return (
        <GraphView
          projection={projection}
          viewState={{ ...viewState, focusedNodeId }}
          onViewStateChange={setViewState}
        />
      )
    }

    const { rerender } = render(<Harness focusedNodeId={null} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!
    graph.setDataCalls.length = 0
    graph.setLayoutCalls.length = 0
    graph.layoutCalls.length = 0
    graph.updateNodeDataCalls.length = 0
    graph.setFixedPositionCalls.length = 0

    rerender(<Harness focusedNodeId="n1" />)
    await waitFor(() => expect(graph.setLayoutCalls).toHaveLength(1))

    act(() => graph.emit('node:dragend', { id: 'n1', x: 42, y: 84 }))

    expect(graph.setDataCalls).toHaveLength(0)
    expect(graph.updateNodeDataCalls).not.toContainEqual([
      { id: 'n1', fx: 42, fy: 84, style: { x: 42, y: 84 } },
    ])

    await act(async () => {
      graph.layoutResolvers.shift()?.()
      await Promise.resolve()
    })

    await waitFor(() => expect(graph.updateNodeDataCalls).toContainEqual([
      { id: 'n1', fx: 42, fy: 84, style: { x: 42, y: 84 } },
    ]))
    expect(graph.setFixedPositionCalls).toContainEqual({ id: 'n1', position: [42, 84] })
    expect(graph.setDataCalls).toHaveLength(0)
  })

  it('keeps the renderer instance alive during refresh loading states', async () => {
    const { rerender } = render(<GraphView projection={projection} />)
    await waitFor(() => expect(graphMock.instances).toHaveLength(1))
    const graph = graphMock.instances[0]!

    rerender(<GraphView projection={projection} loading />)

    expect(await screen.findByText('Loading graph...')).toBeInTheDocument()
    expect(graphMock.instances).toHaveLength(1)
    expect(graph.destroyed).toBe(false)
  })

  it('keeps toolbar layout selections while graph data is unavailable', async () => {
    const user = userEvent.setup({ delay: null })
    function Harness() {
      const [viewState, setViewState] = useState(() => normalizeGraphViewState())
      return (
        <GraphView
          projection={null}
          viewState={viewState}
          onViewStateChange={(nextState) => setViewState(nextState)}
          loading
        />
      )
    }

    render(<Harness />)
    const layoutSelect = screen.getByRole('combobox', { name: /graph layout/i })

    expect(layoutSelect).toHaveValue('force')

    await user.selectOptions(layoutSelect, 'radial')

    expect(layoutSelect).toHaveValue('radial')
  })

  it('shows loading, error, and empty states inside the shared surface', () => {
    const { rerender } = render(<GraphView projection={null} loading />)
    expect(screen.getByText('Loading graph...')).toBeInTheDocument()

    rerender(<GraphView projection={null} error="Graph failed" />)
    expect(screen.getByText('Graph failed')).toBeInTheDocument()

    rerender(<GraphView projection={{ ...projection, nodes: [], edges: [] }} />)
    expect(screen.getByText('No graph data')).toBeInTheDocument()
  })
})

function lastCall<T>(calls: T[]): T | undefined {
  return calls[calls.length - 1]
}
