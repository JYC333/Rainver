# Official Optional Modules

_Last updated: 2026-07-03. See also ADR 0006._

This document defines the official optional module framework for rainver: a product-level control plane that lets maintainers ship optional features that can be enabled or disabled per space or per user, while keeping core `ServerModule` registration stable.

---

## 1. Terminology

### ServerModule
The **internal backend code registration unit**. Defined in `server/src/gateway/routeRegistry.ts`:

```ts
export interface ServerModule {
  name: string;
  registerRoutes(app: FastifyInstance, context: ModuleContext): void;
}
```

Every `ServerModule` in `SERVER_MODULES` has its routes unconditionally mounted at startup. `ServerModule` is a *code organization and route mounting* concept, not a product feature toggle. It is not renamed to Plugin. It is not made optional at the code level.

### PluginHost
The **official plugin activation host**. Bundled official plugin source lives under
`plugins/official/<plugin_id>/`, is compiled into `server/dist/official-plugins/<plugin_id>/`,
is loaded by `server/src/modules/plugins/builtInPlugins.ts`, and is activated by
`PluginHost` after `SERVER_MODULES` and before the API catch-all. Activation is
synchronous: plugins must register routes and contribution points before `activate()`
returns.

### Official Optional Module
A **product/module control-plane object**. Represented by `OfficialPluginDescriptor` (in `packages/protocol/src/plugins.ts`) and backed by `official_plugin_enablements` in the database.

An Official Optional Module:
- is developed by Rainver maintainers and bundled in the repository
- can be disabled by default and enabled per space or per user
- may be backed by PluginHost routes, frontend modules, settings, jobs, schedulers, proposal types, and context providers
- gates actual behavior (route responses, job handlers, proposal appliers, context contribution, scheduled tasks) via plugin guard checks at runtime, not by per-scope route mounting

The distinction: `ServerModule` = core backend module mount; `PluginHost` =
official plugin code activation; Official Optional Module = product feature
package with runtime enablement state.

### Capability
An **agent AI skill/behavior descriptor**. Defined in `catalog/capabilities/<name>/capability.yaml`. Loaded by `CapabilityRegistry` from the catalog. Represents a versioned, executable agent skill (e.g. `memory.reflect`).

Capabilities are NOT product plugins. They do not have a per-space enable/disable toggle. They do not control product feature visibility. A capability may be *used by* an official optional module (e.g., an AI reflection capability used by diary), but the two concepts are separate:

| | Capability | Official Optional Module |
|---|---|---|
| Unit | Agent skill / behavior | Product feature package |
| Discovery | `GET /api/v1/catalog` | `GET /api/v1/plugins` |
| Toggle | None (metadata only) | DB-backed per space or user |
| Frontend | `/capabilities` browse page | Controls module visibility |

### RuntimeAdapter
A backend plugin for the agent runtime execution layer (CLI runtime, model API, etc.). Defined under `server/src/modules/runtimeAdapters/`. Not a product feature visible to end users. Not related to official optional modules.

### Future Third-Party Plugin Package
A hypothetical future extension type: externally developed, downloaded, sandboxed, with its own migration runner and permissions model. This is **explicitly out of scope** for the current implementation. See Non-Goals below. Requires a much stricter sandbox/SDK and is not part of this framework.

---

## 2. Core Decisions

### ServerModule remains the core backend code registration unit
`SERVER_MODULES` in `routeRegistry.ts` continues to list every core server module unconditionally. The `plugins` ServerModule owns the official optional module control plane. Product feature code for bundled official plugins is activated separately through `PluginHost`; runtime behavior is still gated by the plugin guard.

### Official Optional Module is a product control-plane object
`OfficialPluginDescriptor` is a pure data descriptor (no functions). It lives in `server/src/modules/plugins/registry.ts` (static in-memory) and `packages/protocol/src/plugins.ts` (shared wire types). It does not replace or extend `ServerModule`.

### Plugin frontend source lives with the plugin package
Official plugin frontend pages live under `plugins/official/<plugin_id>/web/src/`.
The shell still uses `apps/web/src/modules/registry.ts` as the route/nav source of
truth. The registry statically imports an app-owned adapter under
`apps/web/src/plugins/<plugin_id>/`, and that adapter injects host APIs (navigation,
API client, and plugin-state hook) into the plugin page. Plugin web source must not
import `apps/web/src` directly. This keeps feature source colocated with the plugin
package without introducing remote frontend bundle loading.

### Official optional modules install before they enable
In the current implementation there is no remote package download. Built-in official plugin source is kept in this monorepo under `plugins/official/*`, compiled into package artifacts under `server/dist/official-plugins/*`, loaded by `builtInPlugins.ts`, and activated by `PluginHost` at startup. The package lifecycle is still explicit: a plugin is catalog-visible first, then `POST /api/v1/plugins/:id/install` runs its plugin-owned schema migrations and writes `plugin_installs`/`plugin_migrations`, and only then can `POST /api/v1/plugins/:id/enable` enable it for a user or space.

This is a **Level 2** boundary: plugin source lives in the monorepo under `plugins/official/*`, but the package format (`plugin.json` manifest, compiled artifacts, installer-managed migrations) matches the shape required for downloaded official plugins. Install state and plugin schema are managed independently of the core baseline migration. The remaining Level 2 gap is remote package download and verification — the startup-load activation contract (`RainverPlugin.activate(ctx)`) is already in place.

### Dynamic package download/loading is the remaining Level 2 gap
Remote download, manifest verification, and compatibility checking for official plugin packages are the next planned milestone. The startup-load contract and installer are already implemented; plugging in a remote source is the remaining step. This is distinct from third-party plugins, which require stricter sandboxing and are further out.

---

## 3. Enablement Model

### Scopes
- `space` — module enabled/disabled for the entire space (all users in the space share the setting). Writes require space owner/admin.
- `user` — module enabled/disabled for the user across spaces. This is for personal tools whose setting and data belong to the user rather than a particular space.

Current bundled modules use both scopes: `diary` uses `user` scope for personal
entries, while `finance_ledger` uses `space` scope for shared finance books.

### Default state
Each descriptor declares `default_enabled: boolean`. If no enablement row exists in the database, the module is treated as being in its default state. Current bundled descriptors (`diary`, `finance_ledger`) both have `default_enabled: false`.

### Behavior when disabled
- **Scheduled behavior**: disabled modules must not run scheduled work for disabled scopes. User-scoped scheduled tasks fan out only to enabled users.
- **Context contribution**: disabled modules must not contribute to context assembly
- **AI/memory integration**: disabled modules must not generate memory proposals or activity records
- **Routes**: routes for disabled modules still exist (PluginHost registers bundled plugin routes at startup) but respond with `plugin_disabled` error via the plugin guard. Frontend navigating to a disabled module path sees a disabled page.
- **Data**: disabling a module does not delete its data. Disable is not uninstall.

### Plugin guard
`requireOfficialPluginEnabled(context, { pluginId, spaceId, userId? })` (exported from `server/src/modules/plugins/guards.ts`) and `ctx.http.pluginGuard()` (for PluginHost routes) are reusable helpers for backend routes to fail-closed when a plugin is disabled.

Response for disabled plugin:
```json
{ "detail": "Plugin is not enabled", "error_code": "plugin_disabled", "plugin_id": "diary" }
```

Response for unknown plugin:
```json
{ "detail": "Plugin not found", "error_code": "plugin_not_found", "plugin_id": "..." }
```

---

## 4. Data Lifecycle

### Migrations
Core plugin control-plane schema (`official_plugin_enablements`, `official_plugin_events`, `plugin_installs`, and `plugin_migrations`) uses the standard `server/migrations/` numbered SQL files.

Plugin-owned domain tables do not live in the core baseline. The `diary` plugin owns `diary_entries` and `diary_reflections` through SQL files under `plugins/official/diary/migrations/`. The `finance_ledger` plugin owns its finance book, account, directive, posting, price, import/export, and metadata tables through SQL files under `plugins/official/finance_ledger/migrations/`. Plugin migrations are copied into `server/dist/official-plugins/<plugin_id>/migrations/` during build. The installer executes those migrations only when the plugin is installed and records their checksums in `plugin_migrations`.

### Editor-owned content vs raw input
Diary entries are editor-owned user documents, similar to Notes. Direct diary editing writes the diary plugin tables and does not create an `ActivityRecord`. If diary content is later extracted into Memory, Knowledge, Runtime Context acquisition, FlashCards, or agent-readable summaries, that extraction must go through the proposal/sources boundary and remain opt-in where the descriptor says context contribution is `opt_in`.

Finance ledger rows are space-owned business data. Direct ledger editing writes
the finance plugin tables and does not create an `ActivityRecord`. Beancount text
is an import/export compatibility format, not the source of truth; PostgreSQL
rows are authoritative at runtime. Finance import writes are proposal-gated
through `finance_ledger.post_import_batch`, and direct directive proposal
application uses `finance_ledger.post_directive`.

### Disable is not uninstall
Disabling a module preserves all its data. `disabled_at` and `disabled_by_user_id` are recorded in the enablement row. Uninstall/data deletion is out of scope.

### Settings persistence
`settings_json` is stored in the enablement row. MVP settings are opaque JSON. Settings can be patched even when a module is disabled (to allow pre-configuration). Full settings engine is deferred.

---

## 5. Security and Privacy

- Official modules declare sensitive integrations in their `OfficialPluginDescriptor.permissions` field
- Memory writes must still go through proposals (`B10`)
- Raw capture inputs must enter via `ActivityRecord` first where applicable (`B24`); editor-owned documents such as diary entries are not raw input records
- Context contribution must be `opt_in` for private/personal or sensitive product data modules (e.g. diary and finance ledger default to `can_contribute_context: "opt_in"` and `include_in_context: false` in settings)
- Plugin settings must not leak across spaces or users — the guard and repository enforce the descriptor's `space` or `user` scope
- Future third-party modules require a much stricter sandbox and SDK model not covered here

---

## 6. Contribution Points

An official optional module may contribute to these extension points:

| Contribution point | Status | How |
|---|---|---|
| Backend route surface | Implemented | Via `PluginHost` + `ctx.http.pluginGuard()` |
| Frontend module entry | Implemented | Page source in `plugins/official/<plugin_id>/web/src/`; app adapter in `apps/web/src/plugins/<plugin_id>/`; `official_plugin` source entry in `MODULE_REGISTRY` + overlay |
| Settings | MVP (opaque JSON in enablement row) | `settings_json` field |
| Job handlers | Implemented | `ctx.jobs.register()`; host wraps handlers with enablement gating |
| Scheduled tasks | Implemented | `ctx.scheduler.register()`; task code must fan out only to enabled scopes |
| Proposal types/appliers | Implemented | `ctx.proposals.register()`; host wraps appliers with enablement gating |
| Context providers | Future | Not wired yet |
| Activity sources | Future | Not wired yet |
| Memory proposal generators | Future | Not wired yet |
| Artifacts | Future | Not typed yet |

Future contribution types must preserve the same fail-closed enablement rule.

## 7. Bundled Official Modules

| Plugin | Scope | Frontend | Routes | Runtime contributions | Data ownership |
|---|---|---|---|---|---|
| `diary` | `user` | `/diary` | `/api/v1/diary*` | Routes, scheduler, reflection job | Plugin-owned diary entries/reflections; editor-owned personal documents; memory/context extraction remains opt-in and proposal/sources-gated. |
| `finance_ledger` | `space` | `/finance` | `/api/v1/finance*` | Routes and proposal appliers | Plugin-owned finance books/accounts/directives/postings/prices/import-export records; PostgreSQL is the runtime source of truth; Beancount text is import/export compatibility. |

---

## 8. Non-Goals for This Implementation

The following are out of scope for the current implementation. Some are planned
as Level 2 or further out.

- **No marketplace**: no browse/discover/install UI for third-party plugins
- **No external downloads**: no fetching plugin packages from a remote URL (Level 2 target for official plugins only)
- **No dynamic code loading at runtime**: no hot-load/unload of plugin code (Level 4, distant)
- **No startup DDL from PluginHost**: plugin migrations run only through the installer, never during `activate()`
- **No remote frontend bundle loading**: `React.lazy()` always points to bundled code (Level 2 Phase 2)
- **No app store for third-party plugins**: this is a first-party control plane (third-party is Level 2+ with sandbox)
- **No uninstall data deletion**: disabling or uninstalling a plugin never deletes plugin domain data

---

## 9. Files

| Path | Role |
|---|---|
| `packages/protocol/src/plugins.ts` | Shared descriptor/state/request and PluginHost contract types |
| `server/src/modules/plugins/registry.ts` | Static OfficialPluginDescriptor registry (in-memory) |
| `server/src/modules/plugins/builtInPlugins.ts` | Runtime official plugin artifact loader entrypoint |
| `server/src/modules/plugins/packageLoader.ts` | Loads compiled official plugin package artifacts |
| `server/src/modules/plugins/host/` | PluginHost and host context/ports |
| `server/src/modules/plugins/repository.ts` | DB access for install, migration, enablement, and event rows |
| `server/src/modules/plugins/service.ts` | Business logic: list, enable, disable, settings patch |
| `server/src/modules/plugins/installer.ts` | Installer-managed plugin migration runner |
| `server/src/modules/plugins/routes.ts` | HTTP routes: GET/POST/PATCH /api/v1/plugins/* |
| `server/src/modules/plugins/guards.ts` | `requireOfficialPluginEnabled()` reusable guard |
| `server/src/modules/plugins/index.ts` | Module facade: exports pluginsModule + guard |
| `server/src/modules/plugins/official/diary.ts` | diary descriptor |
| `server/src/modules/plugins/official/financeLedger.ts` | finance_ledger descriptor |
| `plugins/official/diary/` | Bundled diary plugin package source, manifest, server runtime, web page, and migrations |
| `plugins/official/finance_ledger/` | Bundled finance ledger plugin package source, manifest, server runtime, web page, and migrations |
| `server/dist/official-plugins/diary/` | diary build output loaded by the server at startup |
| `server/dist/official-plugins/finance_ledger/` | finance_ledger build output loaded by the server at startup |
| `server/migrations/0001_baseline.sql` (appended) | DB migration — plugin control-plane and install tracking only |
| `apps/web/src/api/client.ts` | Frontend API client |
| `apps/web/src/plugins/diary/DiaryPageAdapter.tsx` | App-owned adapter that injects web host APIs into the diary plugin page |
| `apps/web/src/plugins/finance_ledger/FinancePageAdapter.tsx` | App-owned adapter that injects web host APIs into the finance ledger plugin page |
| `apps/web/src/modules/plugins/useEffectivePlugins.ts` | Plugin state hook |
| `apps/web/src/modules/plugins/PluginsPage.tsx` | Official plugins management page |
| `plugins/official/diary/web/src/DiaryPage.tsx` | diary editor page |
| `plugins/official/finance_ledger/web/src/FinancePage.tsx` | finance ledger page |
