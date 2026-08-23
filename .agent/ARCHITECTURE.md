# Architecture

## Layer Map

```
┌─────────────────────────────────────────────────────┐
│  13. Mobile Client Layer  [PLANNED]                  │
│     PWA, offline queue, swipe review                │
│     apps/web/src/ (mobile layout variants)          │
├─────────────────────────────────────────────────────┤
│  12. Product UI / Shell Layer                        │
│     Shell, NavRail, CommandPalette, PanelLayout     │
│     Activity Inbox, Memory Review, Knowledge, Cards │
│     apps/web/src/                                   │
├─────────────────────────────────────────────────────┤
│  11. Files & Code Layer                              │
│     File browser, git diff review, run logs,        │
│     artifact review, diff approval UI               │
├─────────────────────────────────────────────────────┤
│  10. Runtime Adapter / Sandbox Layer                 │
│     RuntimeAdapterSpec, GenericCliRuntimeAdapter     │
│     typed Delivery, worktree/sandbox governance     │
│     server/src/modules/runtimeContext + runs         │
├─────────────────────────────────────────────────────┤
│  10b. Deployment Layer                               │
│     DeployerClient → Unix socket → host deployer    │
│     DeploymentJob records, whitelisted scripts       │
│     server/src/modules/deployment + deployer  │
├─────────────────────────────────────────────────────┤
│   9. Proposal / Approval Layer                       │
│     Generalized Proposal, ApprovalEvent, Artifact   │
│     memory_update, code_patch, artifact review      │
│     server/src/modules/proposals + artifacts  │
├─────────────────────────────────────────────────────┤
│   8. Governance / Policy Layer                       │
│     PolicyEngine: allow / deny / require_approval   │
│     server/src/modules/policy                 │
├─────────────────────────────────────────────────────┤
│   7. Capability Layer                                │
│     YAML manifests, code, prompts, tests            │
│     Lifecycle: draft → testing → enabled            │
│     catalog/capabilities/ + server catalog    │
├─────────────────────────────────────────────────────┤
│   6. Learning Layer  [PARTIAL / PLANNED]             │
│     FlashCards, CardReview, FSRS scheduling         │
│     Media cards (image occlusion, audio cloze)      │
│     server/migrations + future module         │
├─────────────────────────────────────────────────────┤
│   5. Knowledge Layer  [MVP IMPLEMENTED]              │
│     KnowledgeItem, ObjectRelation, Source,          │
│     KnowledgeItemSource, note_links                 │
│     Structured, agent-generated, proposal-gated     │
│     server/src/modules/knowledge              │
├─────────────────────────────────────────────────────┤
│   4. Memory Layer                                    │
│     Scoped long-term context (not raw data)         │
│     MemoryStore, typed acquisition, evolution       │
│     server/src/modules/memory + runtimeContext       │
├─────────────────────────────────────────────────────┤
│   3. Activity Layer                                  │
│     Raw inputs: user_input, web_capture, file_import │
│     ActivityRecord -> proposals -> memory/knowledge │
│     server/src/modules/activity               │
├─────────────────────────────────────────────────────┤
│   2. User / Agent Layer                              │
│     User (identity, membership)                     │
│     Agent (profile, policy, adapters, runs)         │
│     server/src/modules/auth + agents          │
├─────────────────────────────────────────────────────┤
│   1. Space Layer                                     │
│     Space, SpaceMembership                          │
│     All data scoped by space_id                     │
│     server/migrations + modules/spaces        │
└─────────────────────────────────────────────────────┘
```

## Key Cross-Cutting Concerns

- **space_id** — every record carries it; the primary isolation boundary
- **Run is the central execution object** — every agent invocation creates a Run; Run produces Activities, Artifacts, and Proposals; Session is conversation-level, Run is execution-level
- **Proposal gate** — memory and code changes require explicit proposal approval before durable mutation
- **Runtime-agnostic core** — Agent is a product-level actor; Runtime Adapter (capability, model_api, claude_code, codex_cli, opencode, ...) is a replaceable execution backend; Model Provider (Anthropic, OpenAI, MiniMax, an OpenAI-compatible endpoint, ...) is the underlying LLM, its vendor identity and capabilities recorded in the server's vendor registry. These three are distinct. Tool-using / filesystem Claude work goes through the `claude_code` CLI RuntimeAdapterSpec. Per ADR 0008 the governing invariant is **credential channel isolation** — an Anthropic API key must never enter a Claude Code CLI subprocess env; server-owned encrypted Provider task and `model_api` channels resolve the key in process (never via ambient CLI env) and pass it to the managed chat adapter as a parameter, and may serve any provider including Anthropic. Agent-facing model calls require Runtime Context Delivery rather than a public Provider Chat bypass.
- **Sandbox enforcement** — file-access local CLI runtimes (`claude_code`, `codex_cli`) always run sandboxed (never `none`/`dry_run`). The working-directory scope is resolved from Project Folder binding + risk: no Folder bound → `ephemeral` (a system-provisioned throwaway run-scope dir, server-owned); Folder bound → `risk_level=high` → `worktree` (detached git worktree, diff → `code_patch` proposal). The agent never works directly in the real Project Folder. See `modules/sandbox.md`.
- **Runtime Context Gateway** — the sole typed acquisition, model-aware planning,
  ordered Delivery, live reauthorization, safe Invocation Snapshot, and
  continuity boundary for managed and CLI invocations
- **Invocation Snapshot** — immutable safe record of one actual Delivery attempt;
  stores refs, hashes, budget and acknowledgement metadata, never raw context
- **Run Exchange** — runtime-neutral typed input/output manifests for declared
  file outputs; it is not a context transport
- **MemoryProvider** — abstract interface for memory backends; `LocalMemoryProvider` is the only enabled provider in MVP
- **Module registry** — `server/src/gateway/routeRegistry.ts` (backend) and `apps/web/src/modules/registry.ts` (frontend) are the single sources of truth for which features are active; see [ADR 0006](decisions/0006-plugin-module-architecture.md)
- **Client-server protocol** — REST (current) + WebSocket events + SSE streaming (planned)
- **Partial offline support** — mobile captures and card reviews can queue offline and sync on reconnect; memory writes and proposal apply remain server-authoritative, and agent execution stays authoritative to the control plane's server host or a paired execution host (never the client — see [decisions/0016-control-plane-execution-hosts.md](decisions/0016-control-plane-execution-hosts.md)); see [architecture/LOCAL_FIRST_COMPATIBILITY.md](architecture/LOCAL_FIRST_COMPATIBILITY.md)
- **Run resilience fields** — status includes `degraded`; mode includes `live|dry_run`; temporal fields are explicit; artifacts are exportable; proposals have urgency/deadline
- **Home aggregate APIs** — Home UI consumes lightweight backend read models
  (`/api/v1/me/*`, `/api/v1/home/summary`) only; no full ContextPackage and no
  frontend reconstruction of proposal/activity/runtime logic

## Where Does a New Feature Belong?

| Feature type | Layer | Module path |
|---|---|---|
| New data entity tied to a space | Layer 1–2 | `server/migrations/` + owning server module |
| New agent capability or tool | Layer 7 | `catalog/capabilities/<id>/` |
| New AI-driven analysis or transformation | Layers 7–9 | capability + proposal modules |
| New permission rule | Layer 8 | `server/src/modules/policy/` |
| New memory scope or type | Layer 4 | `server/src/modules/memory/` |
| New raw capture source | Layer 3 | `server/src/modules/activity/` |
| New structured knowledge type | Layer 5 | `server/src/modules/knowledge/` |
| New review card type | Layer 6 | future server module + migrations |
| New UI view (web) | Layer 12 | `apps/web/src/modules/<name>/` |
| New UI view (mobile-primary) | Layer 13 | `apps/web/src/modules/<name>/` mobile variants |
| New runtime adapter (CLI or SDK) | Layer 10 | `server/src/modules/runtimeAdapters/` — see `modules/runtime-adapters.md` |
| Project Folder file operation | Layer 11 | `server/src/modules/projectFolders/` |
| New optional feature module | All | add to `server/src/gateway/routeRegistry.ts` + `apps/web/src/modules/registry.ts` |

## Runtime Targets (MVP)

- **Runtime**: Linux / WSL2 / server (Docker Compose)
- **UI**: Browser (React SPA) — also serves as PWA
- **Mobile**: PWA (same codebase, mobile layout variants)
- **Desktop**: Deferred — see [decisions/0005](decisions/0005-desktop-runtime.md)
