# ADR 0006 — Module Architecture and Official Optional Modules

**Status:** Accepted
**First accepted:** 2026-05-06 (module structure)
**Extended:** 2026-06-18 (official optional module control plane)

---

## Context

### Core module structure (original motivation)

As the system grew it needed to target multiple deployment profiles without surgical restructuring:
- **Personal** — all features enabled (memory, knowledge, cards, media cards, activity inbox)
- **Team** — memory, knowledge, agents, workspaces; cards optional
- **Enterprise** — memory, agents, workspaces; no cards, no media cards

The pre-0007 layout had backend routes registered from a central composition point and frontend pages in a flat `src/pages/` with routes hardcoded in `App.tsx`. Adding or excluding a module required editing multiple unrelated files.

### Official optional module control plane (2026-06 extension)

After establishing the core module structure, a second need emerged: a runtime control plane for features that should be opt-in per space or per user rather than always-on. The existing `ServerModule` / `MODULE_REGISTRY` infrastructure had no concept of per-scope enablement.

An earlier comment in `registry.ts` described overlaying module state from `GET /api/v1/capabilities` — this conflated two distinct concepts:
1. **Capability** — an agent AI skill descriptor (loaded from `catalog/capabilities/`)
2. **Product module** — a user-facing feature package with runtime enablement state

Both problems required a structural resolution in the same files, so this ADR covers both decisions.

---

## Decision

### Part 1 — Core module structure

**Each feature is a self-contained module.** Modules live in named directories at the same level. The server gateway, config, DB helpers, and protocol contracts are shared infrastructure that is never optional.

#### Backend layout

```
server/src/
  config.ts
  db/
  gateway/
    routeRegistry.ts       ← active backend module registry
  modules/
    auth/
      index.ts
      routes.ts
    memory/
      index.ts
      routes.ts
      repository.ts
    agents/
      index.ts
      routes.ts
      repository.ts
    ...
```

Each module exposes a `ServerModule` from `index.ts`; HTTP routes live in `routes.ts`. Modules are registered through `server/src/gateway/routeRegistry.ts`. `server.ts` remains the composition root and does not register module routes directly.

**Core modules are always-on.** They must be in `SERVER_MODULES`. Optional product features that should be disableable per space/user must not be added to `SERVER_MODULES` — they belong to the official optional module framework (Part 2).

#### Frontend layout

```
apps/web/src/
  core/
    Shell.tsx               ← persistent app shell with NavRail
  modules/
    registry.ts             ← module manifest + lazy-loaded component map
    memory/
    agents/
    sessions/
    ...
  plugins/
    <plugin_id>/            ← app-owned adapter per official optional module
  App.tsx                   ← routes generated from MODULE_REGISTRY; React.lazy per module
```

`MODULE_REGISTRY` in `apps/web/src/modules/registry.ts` is the single source of truth for navigation and routing. Each entry uses `React.lazy()` so Vite produces a separate JS chunk per module — unvisited routes are never downloaded.

The `planned: true` flag renders nav items as greyed-out with a "soon" badge; the route still exists so clicking it shows a planned stub rather than a 404.

---

### Part 2 — Official Optional Module control plane

Adds a product-level control plane **above** (not replacing) the `ServerModule`/`MODULE_REGISTRY` infrastructure. Core `SERVER_MODULES` are unchanged; optional product feature routes are activated through `PluginHost`.

#### What does NOT change

- `ServerModule` interface and `SERVER_MODULES` array remain the internal code registration mechanism for core modules
- All existing core module routes continue to be unconditionally mounted
- `/api/v1/server/features` remains server infrastructure advertisement
- `Capability` concept and `catalog/` module are unchanged
- Gateway catch-all behavior is unchanged

#### What is added

**Shared types** (`packages/protocol/src/plugins.ts`)
`OfficialPluginDescriptor`, `OfficialPluginEffectiveState`, `OfficialPluginListItem`, `RainverPlugin`, `PluginHostContext`, enable/disable/settings-patch request types.

**Database tables** (`server/migrations/0001_baseline.sql`)
- `official_plugin_enablements` — one row per (plugin_id, space_id) for space-scoped modules or (plugin_id, user_id) for user-scoped modules; stores `enabled`, `visible`, `settings_json`
- `official_plugin_events` — audit log of enable/disable/settings events
- `plugin_installs` — instance-level install status for plugin packages
- `plugin_migrations` — applied plugin-owned schema migration tracking

**Backend plugins module** (`server/src/modules/plugins/`)
- Static `OfficialPluginRegistry` (descriptor metadata, no functions)
- REST API: `GET /api/v1/plugins`, `GET /api/v1/plugins/effective`, `GET /api/v1/plugins/:id`, `POST /api/v1/plugins/:id/install`, `POST /api/v1/plugins/:id/enable`, `POST /api/v1/plugins/:id/disable`, `PATCH /api/v1/plugins/:id/settings`
- Reusable guard: `requireOfficialPluginEnabled()` for other backend modules
- Registered in `SERVER_MODULES` before `PluginHost` activates built-in official plugins
- `install` runs plugin-owned migrations and writes install metadata; `enable` requires active install and does not execute DDL

**PluginHost and built-in plugin runtime** (`server/src/modules/plugins/host/`, `plugins/official/`)
- `PluginHost` activates built-in official plugins synchronously after `SERVER_MODULES` and before the API catch-all
- Each plugin implements `RainverPlugin.activate(ctx: PluginHostContext)` — synchronously registers routes, job handlers, scheduler tasks, and proposal appliers, then returns `{ activated: true }`
- Plugin source lives under `plugins/official/<plugin_id>/`; compiled into `server/dist/official-plugins/<plugin_id>/` and loaded by `packageLoader.ts` via the `plugin.json` manifest
- Host wraps job handlers and proposal appliers with enablement gating; scheduler tasks fan out to enabled scopes internally; routes use `ctx.http.pluginGuard()`

**Scope model**
- `space` — one enablement row per (plugin_id, space_id); all users in the space share the setting; writes require space owner/admin
- `user` — one enablement row per (plugin_id, user_id); user-scoped setting works across all spaces; self-service

**diary built-in plugin** (`plugins/official/diary/`)
- Routes: `GET /api/v1/diary/today`, `PUT/DELETE /api/v1/diary/entries/:date`, `GET /api/v1/diary/entries`, `GET /api/v1/diary/on-this-day`, `GET /api/v1/diary/entries/:date/reflections`
- Reflection job and reminder scheduler registered through PluginHost
- Plugin-owned tables `diary_entries` and `diary_reflections` created from plugin SQL files during install, not by core baseline or PluginHost activation
- Diary entries are editor-owned user documents, not raw `ActivityRecord` intake; extracting content into memory/context/knowledge remains opt-in proposal/intake work

**Frontend overlay**
- New `AppSource` value `'official_plugin'` in `registry.ts`; `Module.pluginId?` field
- Plugin frontend pages live under `plugins/official/<plugin_id>/web/src/`; must not import `apps/web/src` directly
- Registry lazy-imports an app-owned adapter under `apps/web/src/plugins/<plugin_id>/` that injects host APIs (API client, navigation, plugin-state hook)
- `useEffectivePlugins` hook fetches `/api/v1/plugins/effective` and overlays runtime `enabled`/`visible` state onto `MODULE_REGISTRY` static defaults
- Official Plugins management page at `/plugins`

#### Terminology contract

| Term | Meaning |
|---|---|
| `ServerModule` | Internal backend code registration unit (unchanged). Core. Always-on. |
| `PluginHost` | Startup activation host for official plugin packages. Runs after `SERVER_MODULES`. |
| `Official Optional Module` | Product feature package with DB-backed per-space or per-user enablement state. |
| `Capability` | Agent AI skill descriptor (catalog/capabilities/). Not a product plugin. |
| `RuntimeAdapter` | Backend plugin for agent runtime execution (claude_code, codex_cli, etc.). Not a product plugin. |
| Future third-party plugin | Hypothetical downloadable external extension. Out of scope. Requires stricter sandbox/SDK. |

---

## Consequences

**Good:**
- Adding a new core module = create the directory, add one entry to each registry. No other files change.
- Adding a new official optional module = create descriptor + plugin package + frontend adapter + registry entry. Core files unchanged.
- Core modules are separate Vite chunks; disabled routes (built-in `planned: true`) are never downloaded.
- `server.ts` stays a composition root.
- Tests import module services/repositories directly or exercise the public route boundary.
- Product features can ship as opt-in, gated by space or user without touching core registration.
- Existing core routes and module registrations are unaffected by the plugin control plane.

**Accepted trade-offs:**
- Official plugin routes are always mounted by `PluginHost` (they cannot be per-scope unmounted without a startup DB dependency). The plugin guard provides the runtime gate; disabled plugins return `plugin_disabled` errors. This is intentionally different from core modules, which are never mounted conditionally.
- `settings_json` in the enablement row is opaque JSON in MVP. A typed settings schema per plugin is deferred.

**Constraints:**
- Core modules (always-on product features) must be in `SERVER_MODULES`. Do not add optional product modules there.
- Official plugin package routes must be registered only through `PluginHost`, never through `SERVER_MODULES` directly.
- If a domain needs cross-module behavior, use an explicit service, repository, internal route, or protocol boundary rather than importing an unrelated route module.
- Future packaging can split modules mechanically because each module has a directory boundary and explicit registry entry.

**Still deferred:**
- Remote official plugin package download and signature/hash verification
- Frontend plugin bundle loading from plugin packages (still monorepo source via app-owned adapter)
- Real diary AI reflection (current job is a stub; no LLM call)
- Context provider contribution points for opt-in diary context
- Memory proposal generation from diary entries
- Typed settings schema per plugin
- Third-party plugin marketplace, review process, sandbox/worker isolation
- True hot load/unload of plugin code without restart

---

## Cross-module imports (allowed exceptions)

The following cross-module references express real domain relationships and are allowed as explicit exceptions:

- `tasks` uses the runs domain to create queued Runs and `TaskRun` links. Task is not modeled as Job; tasks enqueue through `POST /api/v1/tasks/{id}/runs`, not a product-task job type.
- `sessions` reflection creates proposals through the memory/proposal boundary.
- `agents` chat and run creation use the context, runs, sessions, and provider/runtime boundaries.

These dependencies must be documented here and may not grow without an update to this ADR.

---

## Alternatives Considered

**Alt A: Use Capabilities as product plugins**
Rejected. Capabilities are agent skill descriptors, not product feature packages. They have different lifecycles, discovery mechanisms, and semantics. Conflating them would corrupt the existing catalog model.

**Alt B: Make SERVER_MODULES conditional at startup**
Rejected. Dynamic route registration based on DB state at startup introduces a startup DB dependency in the gateway layer and makes the module graph hard to reason about. Plugin guards at the route handler level are safer and simpler; always-mounted plugin routes are the explicit design.

**Alt C: Full plugin package system with download/install at Level 1**
Deferred. The package format (`plugin.json`, installer-managed migrations) and startup-load contract (`RainverPlugin.activate(ctx)`) are now implemented. Remote download/verification is the remaining Level 2 gap.

---

## Related

- [0001](0001-space-model.md) — space isolation affects all modules
- [0008](0008-credential-channel-isolation.md) — credential channel isolation applies to plugin runtime as well
