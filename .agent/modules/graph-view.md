# Module: Graph View

## Status
**IMPLEMENTED** - shared graph projection contract, backend projection routes,
frontend rendering core, built-in Graph page, and Project graph lens support are
in place.

## Purpose
Graph View is the shared read-only relationship visualization surface for Agent
Space. It gives core modules and domain surfaces one durable graph contract and
one renderer-backed interaction layer without making the renderer or a specific
domain model part of the public API.

The graph engine is an implementation detail. Current rendering uses G6 inside
`apps/web/src/components/graph/`, but producers and consumers only exchange
`GraphProjection` from `packages/protocol/src/graphProjection.ts`.

## Contract Ownership

`GraphProjection` is the frontend/backend graph wire contract. It owns the
portable shape:

- `nodes[]`: stable ids, kind, label/subtitle, optional style hints, optional
  coordinates, cluster id, degree, collapsed state, and metadata.
- `edges[]`: stable ids, source/target ids, kind, optional label/weight/style
  hints, hidden flag, and metadata.
- `view`: projection mode, root/depth/limit context, generation timestamp,
  truncation flag, and total visible node count when known.
- `layout`: producer layout preference only; the renderer may downgrade for
  scale.

Producers own all graph semantics before the DTO exists: domain SQL, permission
trimming, aggregation, relation naming, business labels, clustering decisions,
and node/edge metadata. The Graph View core renders the projection and provides
generic interactions; it must not infer domain meaning from ids, kinds, or
metadata.

## Backend Projection Layer

Core graph reads live in `server/src/modules/graph/`.

| Route | Role |
|---|---|
| `GET /api/v1/graph/projection` | Space-scoped projection over visible `space_objects` and active `object_relations`. Modes: `global`, `local`, `cluster`, `search`. Optional `project_id` restricts object visibility to active object-backed `project_corpus_items` for that Project. Optional `lens_id` applies a server-known graph lens such as `academic_citation_v1`. |
| `GET /api/v1/graph/view-state?scope_key=` | Per-user, per-space persisted view state lookup. |
| `PUT /api/v1/graph/view-state` | Per-user, per-space persisted view state upsert. |

The projection builder applies the shared object visibility predicate and
returns only nodes and edges the caller can see. A missing or inaccessible
`root_id` is reported as not found, not as a cross-space leak. The server's
`global` mode is intentionally aggregated: it returns cluster nodes plus capped
hub/recent objects rather than an unbounded raw graph.

When `project_id` is supplied, the route first validates the project in the
current Space, then every visible-object query adds an active
`project_corpus_items` object filter. Edges are still read from
`object_relations`, but only between nodes already present in the Project
corpus. `lens_id=academic_citation_v1` narrows the same projection to the
academic citation/authorship relation set over source/person/organization
objects. This is the generic Project graph lens used by presets such as
`academic_research`; it does not create Profile-specific graph storage.

`debug` graph mode is frontend-only and is rejected by the backend.

## Frontend Core

The shared React API is exported from `apps/web/src/components/graph/`.

Core exports include:

- `GraphView`
- `GraphToolbar`
- `GraphDetailPanel`
- `GraphSearchBox`
- `GraphLegend`
- `normalizeGraphViewState`, `persistentGraphViewState`, and
  `useGraphViewState`
- `GraphViewProps`, `GraphViewState`, and theme/renderer types

`GraphView` accepts a `GraphProjection | null` plus optional controlled
`GraphViewState`, renderer/theme overrides, loading/error state, and generic
node callbacks. It handles search/focus, layout switching, canvas/webgl
selection, node hover/selection highlighting, pinned nodes, semantic zoom label
visibility, viewport overlay controls, keyboard zoom/pan navigation, dynamic
force dragging, connected-component separation, legend filtering, and
details-panel rendering.

## Renderer Boundary

G6 imports are confined to `apps/web/src/components/graph/core/createGraphRenderer.ts`
and tests that mock or assert that boundary. `@antv/g-webgl` is loaded lazily
only when the selected renderer is `webgl`.

No domain module, API client, or server file may import G6 or pass G6-specific
option objects as part of its public contract. Renderer replacement is therefore
scoped to `apps/web/src/components/graph/` internals:

- keep `GraphProjection` unchanged unless product-level graph semantics change;
- keep producers emitting domain-neutral projection DTOs;
- keep domain surfaces accepting `GraphProjection` and generic callbacks;
- replace only the renderer handle, mapper, interaction binding, and layout
  adapter behind `GraphView`.

## No Business Logic In Renderer Config

Business logic must not be embedded in G6 configuration or renderer-specific
style callbacks. The renderer config may describe generic graph states such as
selected, active, focused, faded, and pinned. Domain-specific behavior belongs
elsewhere:

| Concern | Owner |
|---|---|
| Which objects and relations exist | Domain producer or core graph projection builder |
| Visibility and access trimming | Backend producer before `GraphProjection` is returned |
| Domain labels, relation kinds, metadata, clustering | Projection producer |
| Kind and edge styling | `graphTheme.ts` plus optional theme overrides |
| Layout tier and downgrade policy | `graphLayouts.ts` |
| Semantic label visibility | `semanticZoom.ts` |
| Renderer event translation | `graphInteractions.ts` |

The test boundary is strict: no `@antv/g6` or `@antv/g-webgl` imports outside
the graph component internals.

## Built-In Graph Page

The built-in Graph module is registered at `/graph` and implemented in
`apps/web/src/modules/graph/GraphPage.tsx`. It owns the product-facing controls
around the shared view:

- calls `graphApi.projection` for `global`, `local`, `cluster`, and `search`;
- validates user-entered query requirements before requesting a projection;
- merges one-hop expansion results into the current projection with a client
  node budget;
- persists view state under `scope_key='core:graph'` for the space graph,
  `scope_key='core:graph:<lens_id>'` for lens-scoped space graphs,
  `scope_key='project:graph:<project_id>'` for Project corpus graphs, and
  `scope_key='project:graph:<project_id>:<lens_id>'` for Project lens graphs;
- guards async responses against active-space changes;
- exposes dev-only `?debug=synthetic:n` projection generation.

The Graph page is read-only. Any future relation creation from a graph surface
must route through the existing proposal-gated object-relation flow, not through
direct graph interaction writes.

## Domain Consumption

Domain surfaces consume Graph View by requesting a `GraphProjection` from the
core graph API or by linking into the built-in `/graph` page with the relevant
query parameters. Project Profiles use this path for focused graph lenses such as
`/graph?project_id=...&lens_id=academic_citation_v1`.

Domain modules may choose node/edge kinds and theme hints through the projection
contract. They must not import renderer packages directly and must not create
domain-specific graph renderer forks.

## Scale Policy

The renderer layout policy is centralized in
`apps/web/src/components/graph/core/graphLayouts.ts`.

| Threshold | Behavior |
|---|---|
| `<= 1500` nodes | In-thread force layout. |
| `1501..3000` nodes | Worker-backed force layout when the selected layout supports it. |
| `> 3000` nodes | Degraded grid layout with a warning. |
| `> 5000` nodes | Client node budget exceeded; producer-side capping or aggregation is required. |
| `> 15000` edges | Warning that the projection exceeds the client edge budget; producers should cap or aggregate edges. |

The backend core graph route caps normal API projections at `limit <= 2000` and
uses an edge cap of `limit * 3`. The frontend Graph page applies the same
5000-node client budget when merging expansion results. Dev synthetic
projections can exceed normal API caps only in `import.meta.env.DEV`.

Scale policy belongs in code, not in temporary reports. Benchmark reports under
`.agent/reports/` are investigation artifacts only and are not source of truth.

Small in-thread force layouts use G6's `d3-force` layout with layout animation
and `drag-element-force` so dragging a node reheats the simulation and moves
neighboring nodes in real time. Larger worker/degraded tiers keep cheaper
non-interactive layouts to protect responsiveness.

Pinned node moves are applied incrementally through the renderer handle. A
manual drag must not trigger `setData()` plus a full layout rerun. Layout modes
such as circular, radial, concentric, and preset are seed arrangements only; the
graph still runs force as the final layout stage so nodes can continue to move
and respond to drag interactions.

## Testing

Use the smallest layer that proves the change:

- protocol schema changes: protocol tests around `GraphProjectionSchema`;
- mapper, theme, semantic zoom, view-state, and layout policy: pure web unit
  tests;
- `GraphView`: component tests with a mocked G6 renderer in jsdom;
- renderer import boundary: grep-style web test that only graph internals import
  G6 packages;
- backend projection and view state: real-DB server tests, because visibility,
  CTE traversal, aggregation, truncation, and upsert behavior depend on SQL;
- domain graph producers: route tests that parse responses with
  `GraphProjectionSchema`.

## Related Files

- `packages/protocol/src/graphProjection.ts`
- `server/src/modules/graph/`
- `apps/web/src/components/graph/`
- `apps/web/src/modules/graph/GraphPage.tsx`
- `apps/web/src/api/client.ts` (`graphApi`)
