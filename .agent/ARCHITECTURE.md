# Architecture

## Layer Map

```
┌─────────────────────────────────────────────────────┐
│  12. Product UI / Shell                             │
│     Shell, GlobalRail, SceneSidebar, capture        │
│     apps/web/src/                                   │
├─────────────────────────────────────────────────────┤
│  11. Files & Code                                   │
│     tree, file, git status, git diff (read-only)    │
│     server/src/modules/projectFolders + hosts       │
├─────────────────────────────────────────────────────┤
│  10. Runtime / host daemon                          │
│     RuntimeAdapterSpec, rainver-host, Delivery      │
│     server/src/modules/runtimeContext + runs + hosts│
├─────────────────────────────────────────────────────┤
│  10b. Deployment                                    │
│     deployment_jobs + deployer pull (ADR 0020)      │
│     server/src/modules/deployment + deployer        │
├─────────────────────────────────────────────────────┤
│   9. Proposal / Approval                            │
│     ProposalApplierRegistry                         │
│     server/src/modules/proposals                    │
├─────────────────────────────────────────────────────┤
│   8. Governance / Policy                            │
│     server/src/modules/policy                       │
├─────────────────────────────────────────────────────┤
│   7. Capability / Evolution                         │
│     catalog + capabilities + evolution              │
├─────────────────────────────────────────────────────┤
│   6. Learning HTTP (no Cards UI)                    │
│     server/src/modules/learning                     │
│     cards tables exist with no write path           │
├─────────────────────────────────────────────────────┤
│   5. Knowledge                                      │
│     KnowledgeItem, notes, object_relations          │
│     server/src/modules/knowledge + ontology         │
├─────────────────────────────────────────────────────┤
│   4. Memory                                         │
│     server/src/modules/memory + runtimeContext      │
├─────────────────────────────────────────────────────┤
│   3. Activity / Sources / Capture                   │
│     server/src/modules/activity + sources + capture │
├─────────────────────────────────────────────────────┤
│   2. User / Agent                                   │
│     server/src/modules/auth + agents                │
├─────────────────────────────────────────────────────┤
│   1. Space                                          │
│     server/src/modules/spaces                       │
└─────────────────────────────────────────────────────┘
```

The web app is also a PWA. There is no mobile-specific product layer and
no general WebSocket event bus. Agent-turn SSE exists at
`GET /api/v1/runs/{runId}/turn/stream`.

## Key Cross-Cutting Concerns

- **space_id** — every record carries it; the primary isolation boundary
- **Run is the central execution object** — Session is conversation-level,
  Run is execution-level
- **Proposal gate** — durable Memory / Knowledge / code-patch and other
  registered types require apply through `ProposalApplierRegistry`
- **Runtime-agnostic core** — Agent, RuntimeAdapterSpec, and ModelProvider
  are distinct. Credential channels follow ADR 0008
- **Execution isolation** — CLI Runs use a host daemon (ADR 0016)
- **Runtime Context Gateway** — typed acquisition, planning, Delivery,
  snapshot, continuity
- **Module registry** — `server/src/gateway/routeRegistry.ts` and
  `apps/web/src/modules/registry.ts`
- **Home aggregates** — `/api/v1/me/*`, `/api/v1/home/summary`

## Where Does a New Feature Belong?

| Feature type | Layer | Module path |
|---|---|---|
| New data entity tied to a space | Layer 1–2 | `server/src/db/schema/` + owning module |
| New agent capability or tool | Layer 7 | `catalog/capabilities/<id>/` and/or `capabilities` |
| New permission rule | Layer 8 | `server/src/modules/policy/` |
| New memory scope or type | Layer 4 | `server/src/modules/memory/` |
| New raw capture source | Layer 3 | `server/src/modules/activity/` or `capture` |
| New structured knowledge type | Layer 5 | `server/src/modules/knowledge/` + ontology registry |
| New UI view | Layer 12 | `apps/web/src/modules/<name>/` + `registry.ts` |
| New runtime adapter | Layer 10 | `server/src/modules/runtimeAdapters/` |
| Project Folder file operation | Layer 11 | `server/src/modules/projectFolders/` |
| New optional feature module | — | PluginHost + `plugins/official/` |

## Runtime Targets

- **Runtime**: Linux / WSL2 / server (Docker Compose)
- **UI**: Browser (React SPA / PWA)
- **Desktop**: Tauri scaffold only — [0005](decisions/0005-desktop-runtime.md)

Unimplemented layers (mobile product, sync, Cards UI, generic WS):
[plans/unimplemented-from-guides.md](plans/unimplemented-from-guides.md).
