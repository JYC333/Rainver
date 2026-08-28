# ADR 0006: Module Architecture And Official Optional Modules

Date: 2026-05-06 (module structure), 2026-06-18 (optional module control plane)
Rewritten: 2026-08-27

## Status

Accepted.

## Context

As the system grew, adding or excluding a feature required editing several
unrelated files: backend routes were registered from one composition point,
frontend pages sat in a flat directory with routes hardcoded in `App.tsx`.

A second need followed: some product features should be opt-in per Space or
per user rather than always-on. The `ServerModule` registry had no concept of
per-scope enablement, and an early comment proposed overlaying module state
from `GET /api/v1/capabilities` — conflating a **Capability** (an agent skill
descriptor from `catalog/capabilities/`) with a **product module** (a
user-facing feature package with runtime enablement state).

## Decision

### 1. Every feature is a self-contained module

Backend modules live under `server/src/modules/<name>/`, each exposing a
`ServerModule` from `index.ts` with HTTP routes in `routes.ts`, and are
registered through `server/src/gateway/routeRegistry.ts`. `server.ts` is the
composition root and registers no module routes directly. Gateway, config,
DB helpers, and protocol contracts are shared infrastructure and never
optional.

Frontend modules live under `apps/web/src/modules/<name>/`;
`apps/web/src/modules/registry.ts` (`MODULE_REGISTRY`) is the single source of
truth for navigation and routing. Each entry is `React.lazy()`-loaded so Vite
emits one chunk per module. `planned: true` renders a greyed nav item with a
"soon" badge and a stub route instead of a 404.

**Core modules are always-on** and must be in `SERVER_MODULES`. A product
feature that should be disableable per Space or user must not be added there;
it belongs to decision 2.

### 2. Official optional modules sit above the module registry

A product-level control plane is added **above** (not replacing) the
`ServerModule` / `MODULE_REGISTRY` infrastructure:

- **Enablement is DB-backed and scoped.** `official_plugin_enablements`
  holds one row per (plugin, Space) for `space`-scoped modules — shared by all
  members, written by Space owner/admin — or per (plugin, user) for
  `user`-scoped modules, which are self-service and apply across Spaces.
  `official_plugin_events` is the audit log; `plugin_installs` and
  `plugin_migrations` track instance-level install and plugin-owned schema.
- **Install and enable are separate.** `install` runs plugin-owned migrations
  and records install metadata; `enable` requires an active install and
  executes no DDL.
- **`PluginHost` activates built-in plugins at startup**, after
  `SERVER_MODULES` and before the API catch-all. A plugin implements
  `RainverPlugin.activate(ctx)` and synchronously registers routes, job
  handlers, scheduler tasks, and proposal appliers. Plugin source lives under
  `plugins/official/<plugin_id>/` with a `plugin.json` manifest and its own
  `migrations/`, `server/`, and `web/` trees.
- **Routes are always mounted; enablement is a runtime gate.** Plugin routes
  use the host's plugin guard and disabled plugins return `plugin_disabled`;
  job handlers and proposal appliers are wrapped with enablement gating;
  scheduler tasks fan out to enabled scopes. Mounting conditionally on DB
  state at startup was rejected because it puts a DB dependency into the
  gateway layer and makes the module graph hard to reason about.
- **Frontend pages are contributed through an app-owned adapter.**
  `MODULE_REGISTRY` entries with `source: 'official_plugin'` lazy-import
  `apps/web/src/plugins/<plugin_id>/`, which injects host APIs into the plugin's
  own `web/src/` pages; plugin pages never import `apps/web/src` directly.
  `useEffectivePlugins` overlays runtime `enabled`/`visible` state onto the
  static registry, and `/plugins` is the management page.

Shared types live in `packages/protocol/src/plugins.ts`; the backend control
plane is `server/src/modules/plugins/`, exposing `/api/v1/plugins*` and the
reusable `requireOfficialPluginEnabled()` guard.

### 3. Terminology

| Term | Meaning |
|---|---|
| `ServerModule` | Internal backend registration unit. Core. Always-on. |
| `PluginHost` | Startup activation host for official plugin packages. |
| Official Optional Module | Product feature package with DB-backed per-Space or per-user enablement. |
| Capability | Agent skill descriptor. Not a product plugin ([ADR 0009](0009-capability-workflow-open-skill-system.md)). |
| Runtime Adapter | Agent execution backend. Not a product plugin ([ADR 0007](0007-multi-cli-mvp.md)). |
| Third-party plugin | Hypothetical downloadable extension. Out of scope; would need a stricter sandbox/SDK. |

### 4. Cross-module dependencies

A domain that needs another module's behaviour uses an explicit service,
repository, internal route, protocol contract, or registry (for example
`ProposalApplierRegistry`, the Project overview registries of
[ADR 0011](0011-inquiry-domain-model.md)) — never an import of an unrelated
module's route file. Which modules currently depend on which is described in
`.agent/modules/` and enforced by boundary tests where one exists; this ADR
does not maintain a frozen allowlist.

## Consequences

- Adding a core module: create the directory, add one entry to each registry.
- Adding an official optional module: descriptor + plugin package + frontend
  adapter + registry entry; core files unchanged.
- Modules are separate Vite chunks; unvisited routes are never downloaded.
- Future packaging can split modules mechanically because each has a
  directory boundary and an explicit registry entry.

Accepted trade-offs: plugin routes cannot be per-scope unmounted (the guard is
the gate); `settings_json` on an enablement row is opaque JSON, a typed
per-plugin settings schema is deferred.

Still deferred: remote plugin package download with signature/hash
verification; frontend bundle loading from plugin packages (still monorepo
source through the adapter); third-party marketplace, review, and worker
isolation; true hot load/unload without restart.

## Alternatives considered

- **Capabilities as product plugins** — rejected; different lifecycle,
  discovery, and semantics.
- **Conditional `SERVER_MODULES` at startup** — rejected; see decision 2.
- **Full download/install package system at once** — deferred; the package
  format and startup contract are implemented, remote download is the gap.

## Revision history

- **2026-05-06** — module structure accepted.
- **2026-06-18** — official optional module control plane added.
- **2026-08-27** — rewritten. Deployment-profile motivation (personal / team
  / enterprise) removed — nothing in code corresponds to it; a self-reference
  left over from ADR renumbering fixed; the diary plugin's route and table
  inventory moved out (it is implementation detail, and a second built-in
  plugin now exists); the frozen cross-module import allowlist replaced by
  decision 4, because nothing enforced it and it had silently grown.
