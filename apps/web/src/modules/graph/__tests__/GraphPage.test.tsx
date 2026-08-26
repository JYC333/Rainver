import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphProjection } from '@rainver/protocol'
import GraphPage from '../GraphPage'

const graphApiMock = vi.hoisted(() => ({
  projection: vi.fn(),
  getViewState: vi.fn(),
  saveViewState: vi.fn(),
}))
const spaceContextMock = vi.hoisted(() => ({
  activeSpaceId: 'space-1' as string | null,
}))

vi.mock('../../../api/client', () => ({ graphApi: graphApiMock }))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: spaceContextMock.activeSpaceId }),
}))

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: () => {}, toggleTheme: () => {} }),
}))

vi.mock('../../../components/graph', () => {
  const defaultState = {
    selectedNodeId: null as string | null,
    hoveredNodeId: null as string | null,
    focusedNodeId: null as string | null,
    expandedClusterIds: [] as string[],
    hiddenKinds: [] as string[],
    activeEdgeKinds: [] as string[],
    currentLayout: 'force',
    layoutSource: 'default',
    pinnedNodes: {} as Record<string, { x: number; y: number }>,
    rendererMode: 'canvas',
  }
  return {
    normalizeGraphViewState: (state = {}) => {
      const record = state as { currentLayout?: string; layoutSource?: string; pinnedNodes?: Record<string, unknown> }
      return {
        ...defaultState,
        ...state,
        layoutSource: record.layoutSource ?? (record.currentLayout && record.currentLayout !== 'force' ? 'user' : 'default'),
        pinnedNodes: { ...(record.pinnedNodes ?? {}) },
      }
    },
    persistentGraphViewState: (state: typeof defaultState) => ({
      expandedClusterIds: state.expandedClusterIds,
      hiddenKinds: state.hiddenKinds,
      activeEdgeKinds: state.activeEdgeKinds,
      currentLayout: state.currentLayout,
      layoutSource: state.layoutSource,
      pinnedNodes: state.pinnedNodes,
      rendererMode: state.rendererMode,
    }),
    GraphView: (props: {
      projection: GraphProjection | null
      loading?: boolean
      error?: string | null
      viewState: typeof defaultState
      onNodeExpand?: (node: GraphProjection['nodes'][number]) => void
      onViewStateChange?: (state: typeof defaultState) => void
    }) => (
      <div data-testid="graph-view">
        <div>loading:{String(Boolean(props.loading))}</div>
        <div>error:{props.error ?? ''}</div>
        <div>layout:{props.viewState.currentLayout}</div>
        <div>nodes:{props.projection?.nodes.length ?? 0}</div>
        <div>edges:{props.projection?.edges.length ?? 0}</div>
        <button
          type="button"
          onClick={() => {
            const expandable = props.projection?.nodes.find(node => node.kind === 'cluster') ?? props.projection?.nodes[0]
            if (expandable) props.onNodeExpand?.(expandable)
          }}
        >
          expand first
        </button>
        <button
          type="button"
          onClick={() => props.onViewStateChange?.({
            ...props.viewState,
            pinnedNodes: { n1: { x: 10, y: 20 } },
          })}
        >
          change view state
        </button>
        <button
          type="button"
          onClick={() => props.onViewStateChange?.({
            ...props.viewState,
            selectedNodeId: 'n1',
          })}
        >
          select node
        </button>
      </div>
    ),
  }
})

const baseProjection: GraphProjection = {
  nodes: [
    { id: 'cluster:note', kind: 'cluster', label: 'Notes', metadata: { count: 2 } },
    { id: 'n1', kind: 'knowledge_item', label: 'Alpha', metadata: { status: 'active' } },
  ],
  edges: [{ id: 'c1', source: 'cluster:note', target: 'n1', kind: 'cluster_contains' }],
  view: { mode: 'global', generatedAt: '2026-07-04T12:00:00.000Z', truncated: true, totalNodeCount: 5 },
  layout: { mode: 'clustered' },
}

const expandedProjection: GraphProjection = {
  nodes: [
    { id: 'n2', kind: 'note', label: 'Beta', metadata: { status: 'active' } },
  ],
  edges: [],
  view: { mode: 'cluster', rootId: 'cluster:note', generatedAt: '2026-07-04T12:01:00.000Z', totalNodeCount: 1 },
  layout: { mode: 'force' },
}

const spaceTwoProjection: GraphProjection = {
  nodes: [
    { id: 'space-2-node', kind: 'knowledge_item', label: 'Space 2' },
  ],
  edges: [],
  view: { mode: 'global', generatedAt: '2026-07-04T12:02:00.000Z', totalNodeCount: 1 },
  layout: { mode: 'force' },
}

const searchProjection: GraphProjection = {
  nodes: [
    { id: 'search-node', kind: 'knowledge_item', label: 'Search result' },
  ],
  edges: [],
  view: { mode: 'search', generatedAt: '2026-07-04T12:03:00.000Z', totalNodeCount: 1 },
  layout: { mode: 'force' },
}

describe('GraphPage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    spaceContextMock.activeSpaceId = 'space-1'
    graphApiMock.projection.mockReset()
    graphApiMock.getViewState.mockReset()
    graphApiMock.saveViewState.mockReset()
    graphApiMock.getViewState.mockResolvedValue({ scope_key: 'core:graph', state_json: {}, updated_at: null })
    graphApiMock.saveViewState.mockResolvedValue({ scope_key: 'core:graph', state_json: {}, updated_at: 'now' })
    graphApiMock.projection.mockResolvedValue(baseProjection)
  })

  it('loads the graph projection from URL query params', async () => {
    renderGraph('/spaces/space-1/graph?mode=local&root_id=n1&depth=2&limit=25')

    await waitFor(() => expect(graphApiMock.projection).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'local',
      root_id: 'n1',
      depth: 2,
      q: undefined,
      limit: 25,
      include_clusters: false,
    })))
    expect(await screen.findByText('nodes:2')).toBeInTheDocument()
    expect(screen.getByText('2 nodes · 1 edges')).toBeInTheDocument()
  })

  it('preserves project graph lens params for load, view state, and expansion', async () => {
    graphApiMock.projection
      .mockResolvedValueOnce(baseProjection)
      .mockResolvedValueOnce(expandedProjection)
    graphApiMock.getViewState.mockResolvedValueOnce({
      scope_key: 'project:graph:project-1:academic_citation_v1',
      state_json: {},
      updated_at: null,
    })
    renderGraph('/spaces/space-1/graph?project_id=project-1&lens_id=academic_citation_v1')

    await waitFor(() => expect(graphApiMock.getViewState).toHaveBeenCalledWith('project:graph:project-1:academic_citation_v1'))
    await waitFor(() => expect(graphApiMock.projection).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'global',
      project_id: 'project-1',
      lens_id: 'academic_citation_v1',
    })))
    expect(await screen.findByText('Academic citation lens')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /expand first/i }))
    await waitFor(() => expect(graphApiMock.projection).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'cluster',
      root_id: 'cluster:note',
      project_id: 'project-1',
      lens_id: 'academic_citation_v1',
      include_clusters: false,
    })))
  })

  it('merges a cluster expansion into the current projection', async () => {
    graphApiMock.projection
      .mockResolvedValueOnce(baseProjection)
      .mockResolvedValueOnce(expandedProjection)
    renderGraph('/spaces/space-1/graph')

    expect(await screen.findByText('nodes:2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand first/i }))

    await waitFor(() => expect(graphApiMock.projection).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'cluster',
      root_id: 'cluster:note',
      depth: 1,
      limit: 300,
      include_clusters: false,
    })))
    expect(await screen.findByText('nodes:3')).toBeInTheDocument()
  })

  it('loads and persists graph view state by scope key', async () => {
    graphApiMock.getViewState.mockResolvedValueOnce({
      scope_key: 'core:graph',
      state_json: { currentLayout: 'radial' },
      updated_at: null,
    })
    renderGraph('/spaces/space-1/graph')

    await waitFor(() => expect(graphApiMock.getViewState).toHaveBeenCalledWith('core:graph'))
    fireEvent.click(await screen.findByRole('button', { name: /change view state/i }))
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)) })

    await waitFor(() => expect(graphApiMock.saveViewState).toHaveBeenCalledWith(
      'core:graph',
      expect.objectContaining({
        currentLayout: 'radial',
        pinnedNodes: { n1: { x: 10, y: 20 } },
      }),
    ))
  })

  it('does not persist defaults when saved view state cannot be loaded', async () => {
    graphApiMock.getViewState.mockRejectedValueOnce(new Error('state unavailable'))
    renderGraph('/spaces/space-1/graph')

    expect(await screen.findByText('nodes:2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /change view state/i }))
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)) })

    expect(graphApiMock.saveViewState).not.toHaveBeenCalled()
  })

  it('validates initial URL query params before loading the projection', async () => {
    renderGraph('/spaces/space-1/graph?mode=local')

    expect(await screen.findByText('error:root_id is required for this graph mode.')).toBeInTheDocument()
    expect(graphApiMock.projection).not.toHaveBeenCalled()
  })

  it('keeps synthetic refresh on the local generator', async () => {
    renderGraph('/spaces/space-1/graph?debug=synthetic:5')

    expect(await screen.findByText('nodes:11')).toBeInTheDocument()
    expect(graphApiMock.projection).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))

    expect(graphApiMock.projection).not.toHaveBeenCalled()
  })

  it('does not persist ephemeral selection-only view state changes', async () => {
    graphApiMock.getViewState.mockResolvedValueOnce({
      scope_key: 'core:graph',
      state_json: { currentLayout: 'radial' },
      updated_at: null,
    })
    renderGraph('/spaces/space-1/graph')

    expect(await screen.findByText('layout:radial')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /select node/i }))
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)) })

    expect(graphApiMock.saveViewState).not.toHaveBeenCalled()
  })

  it('clears projections on space change and ignores stale refresh responses', async () => {
    graphApiMock.projection.mockResolvedValueOnce(baseProjection)
    const staleRefresh = createDeferred<GraphProjection>()
    const spaceTwoLoad = createDeferred<GraphProjection>()
    const view = renderGraph('/spaces/space-1/graph')

    expect(await screen.findByText('nodes:2')).toBeInTheDocument()
    graphApiMock.projection.mockReturnValueOnce(staleRefresh.promise)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(graphApiMock.projection).toHaveBeenCalledTimes(2))

    graphApiMock.projection.mockReturnValueOnce(spaceTwoLoad.promise)
    spaceContextMock.activeSpaceId = 'space-2'
    view.rerender(
      <MemoryRouter initialEntries={['/spaces/space-2/graph']}>
        <GraphPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('nodes:0')).toBeInTheDocument()
    await act(async () => {
      staleRefresh.resolve(expandedProjection)
      await staleRefresh.promise
    })
    expect(screen.getByText('nodes:0')).toBeInTheDocument()

    await act(async () => {
      spaceTwoLoad.resolve(spaceTwoProjection)
      await spaceTwoLoad.promise
    })
    expect(await screen.findByText('nodes:1')).toBeInTheDocument()
  })

  it('ignores stale same-space refresh responses after the URL query changes', async () => {
    graphApiMock.projection.mockResolvedValueOnce(baseProjection)
    const staleRefresh = createDeferred<GraphProjection>()
    graphApiMock.projection.mockReturnValueOnce(staleRefresh.promise)
    renderGraph('/spaces/space-1/graph')

    expect(await screen.findByText('nodes:2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(graphApiMock.projection).toHaveBeenCalledTimes(2))

    graphApiMock.projection.mockResolvedValueOnce(searchProjection)
    fireEvent.click(screen.getByRole('button', { name: /^Global$/i }))
    fireEvent.click(screen.getByRole('option', { name: /^Search$/i }))
    fireEvent.change(screen.getByPlaceholderText('Search graph text'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))

    await waitFor(() => expect(graphApiMock.projection).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'search',
      root_id: undefined,
      depth: 1,
      q: 'Beta',
      limit: 300,
      include_clusters: false,
    })))
    expect(await screen.findByText('nodes:1')).toBeInTheDocument()

    await act(async () => {
      staleRefresh.resolve(expandedProjection)
      await staleRefresh.promise
    })
    expect(screen.getByText('nodes:1')).toBeInTheDocument()
  })
})

function renderGraph(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GraphPage />
    </MemoryRouter>,
  )
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
