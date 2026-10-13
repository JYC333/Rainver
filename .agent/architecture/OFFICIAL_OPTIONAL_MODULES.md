# Official Optional Modules

_See also ADR 0006._

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
A product capability is a built-in definition in
`server/src/modules/capabilities/registry.ts`, read through
`/api/v1/capability-definitions`. YAML under `catalog/capabilities/` is a
diagnostic catalog. Do not execute a catalog manifest. `memory.reflect` in
that catalog is manifest metadata. Session reflection does not run it.

Capabilities are not Official Optional Modules. Do not turn a capability on
with a plugin enablement row, and do not use a capability id as a plugin id.

| | Capability | Official Optional Module |
|---|---|---|
| Unit | Built-in definition in `capabilities/registry.ts` | Product feature package |
| Discovery | `GET /api/v1/capability-definitions` | `GET /api/v1/plugins` |
| Enablement | `capability_enable` / `capability_disable` proposals; state in `capability_enablements` | DB-backed per space or user |
| Frontend | `/capabilities` | The plugin's own page; a rail item only when `enabled` |
| Catalog | `GET /api/v1/server/catalog` lists manifests and is not the product path | Not listed there |

### RuntimeAdapter
A backend plugin for the agent runtime execution layer (CLI runtime, model API, etc.). Defined under `server/src/modules/runtimeAdapters/`. Not a product feature visible to end users. Not related to official optional modules.

### Third-party plugin packages

Third-party plugin packages are not loaded. There is no download, sandbox, or
migration runner for them. See Non-Goals below.

---

## 2. Core Decisions

### ServerModule remains the core backend code registration unit
`SERVER_MODULES` in `routeRegistry.ts` continues to list every core server module unconditionally. The `plugins` ServerModule owns the official optional module control plane. Product feature code for bundled official plugins is activated separately through `PluginHost`; runtime behavior is still gated by the plugin guard.

### Official Optional Module is a product control-plane object
`OfficialPluginDescriptor` is a pure data descriptor (no functions). It lives in `server/src/modules/plugins/registry.ts` (static in-memory) and `packages/protocol/src/plugins.ts` (shared wire types). It does not replace or extend `ServerModule`.

### Plugin frontend source lives with the plugin package
Official plugin frontend pages live under `plugins/official/<plugin_id>/web/src/`.
The shell uses `apps/web/src/modules/registry.ts` as the route and nav source of
truth. The registry statically imports an app-owned adapter under
`apps/web/src/plugins/<plugin_id>/`, and that adapter injects host APIs (navigation,
API client, and plugin-state hook) into the plugin page. Plugin web source must not
import `apps/web/src` directly. This keeps feature source colocated with the plugin
package without introducing remote frontend bundle loading.

### Official optional modules install before they enable
There is no remote package download. Built-in official plugin source lives in
this monorepo under `plugins/official/*`, is compiled into
`server/dist/official-plugins/*`, loaded by `builtInPlugins.ts`, and activated
by `PluginHost` at startup. A plugin is catalog-visible first, then
`POST /api/v1/plugins/:id/install` runs its plugin-owned schema migrations and
writes `plugin_installs`/`plugin_migrations`, and only then can
`POST /api/v1/plugins/:id/enable` enable it for a user or space.

Install state and plugin schema are managed independently of the core baseline
migration. `RainverPlugin.activate(ctx)` is the startup activation contract.
Do not download a plugin package.

### Remote package download is not implemented
There is no remote download, manifest verification, or compatibility check for
official plugin packages. The startup-load contract and installer are
implemented for in-repo artifacts. Third-party plugins are out of scope.

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
`requireOfficialPluginEnabled(config, request, reply, { pluginId, spaceId?, userId? })` (exported from `server/src/modules/plugins/guards.ts`; returns `false` after sending the error response) and `ctx.http.pluginGuard()` (for PluginHost routes) are reusable helpers for backend routes to fail-closed when a plugin is disabled.

Response for disabled plugin (403):
```json
{ "detail": "Plugin is not enabled", "error_code": "plugin_disabled", "plugin_id": "diary" }
```

Response for unknown plugin (404):
```json
{ "detail": "Plugin not found", "error_code": "plugin_not_found", "plugin_id": "..." }
```

Response for a plugin that is not installed (403):
```json
{ "detail": "Plugin is not installed", "error_code": "plugin_not_installed", "plugin_id": "..." }
```

---

## 4. Data Lifecycle

### Migrations
Core plugin control-plane schema (`official_plugin_enablements`, `official_plugin_events`, `plugin_installs`, and `plugin_migrations`) uses the standard `server/migrations/` append-only chain.

Plugin-owned domain tables do not live in the core baseline. The `diary` plugin owns `diary_entries` and `diary_reflections` through SQL files under `plugins/official/diary/migrations/`. The `finance_ledger` plugin owns its finance book, account, directive, posting, price, import/export, and metadata tables through SQL files under `plugins/official/finance_ledger/migrations/`. Plugin migrations are copied into `server/dist/official-plugins/<plugin_id>/migrations/` during build. The installer executes those migrations only when the plugin is installed and records their checksums in `plugin_migrations`.

### Editor-owned content vs raw input
Diary entries are editor-owned user documents, similar to Notes. Direct diary editing writes the diary plugin tables. It does not create an `ActivityRecord` or Memory. The descriptor allows opt-in context contribution (`can_contribute_context: opt_in`) and memory proposals (`can_propose_memory`). Do not write Memory, Knowledge, Runtime Context, FlashCards, or an agent-readable summary from a diary save. A proposal is the write path.

The Diary editor serializes saves for the same API, user/Space context and day,
including debounced, manual and unmount saves. The queue survives editor
remounts, continues after a failed request and refuses queued text when the
editing context no longer matches the host. This orders one browser's writes;
it does not resolve conflicting edits from separate browser sessions.

Finance ledger rows are space-owned business data. Direct ledger editing writes
the finance plugin tables and does not create an `ActivityRecord`. Beancount text
is an import/export compatibility format, not the source of truth; PostgreSQL
rows are authoritative at runtime. A personal account with `visibility =
private` is readable and exportable only by its owner; other Space members do
not receive that account, its postings, or transactions that touch it.
Finance import never posts. `POST /api/v1/finance/books/:bookId/import/beancount`
takes the file text and nothing else (a `post_directly` field is a 400), lands
every dated entry as `proposed`, and the posting step is the separate
`finance_ledger.post_import_batch` / `finance_ledger.post_directive` proposal
application with apply-time revalidation. A file is not authority over the
book's structure either: `open`, `close`, `commodity` and `option` directives
are recorded as `excluded` with a diagnosis, and nothing in an import creates,
closes or declares an account, commodity or option. An entry that names an
account or commodity the book lacks writes nothing and waits
(`pending_mapping`); the importer opens the account or adds the commodity
through the ordinary management routes, then maps the file's account name onto
an existing account id (`POST .../imports/:importSourceId/entries/:entryId/mapping`,
re-checked for visibility and the entry date at persist time) or retries the
batch (`POST .../imports/:importSourceId/retry`). The mapping is stored on the
entry with a version; the original text is kept.

Each parsed entry is one `finance_import_entries` row with a stable identity:
`external:<id>` for a transaction whose `external_id` metadata names an
upstream record, otherwise the hash of the entry's own lines plus its
occurrence index in the file, so two identical transactions in one file stay
two records while the same file uploaded again (`finance_import_sources` is
unique per book and content hash) finds its existing rows and retries only the
unfinished ones. Every transaction is written with all its postings under one
savepoint; a failure rolls back that entry alone and the rest of the batch
continues. Content that matches an entry of another batch of the book is held
as `needs_review` until the importer decides (`POST .../imports/:importSourceId/review`
with `import` or `duplicate`); a trusted external id already imported settles
as `duplicate` on its own. A batch, its entries and their text are visible
only to the member who uploaded it.

Account close, direct posting, import validation/persistence and batch import
approval share a transaction-held `FOR NO KEY UPDATE` book lock. Posting checks
account dates again after acquiring it, and closing refuses later posted
entries. The lock is compatible with the book foreign keys' `KEY SHARE` locks
held while creating drafts. A directive dated on the closing day remains valid.
The transaction creation route acquires the book lock before allocating its
sequence or inserting draft rows, keeping its lock order consistent with imports.

### Disable is not uninstall
Disabling a module preserves all its data. `disabled_at` and `disabled_by_user_id` are recorded in the enablement row. Uninstall/data deletion is out of scope.

### Settings persistence
`settings_json` is stored in the enablement row. Settings are opaque JSON and can be patched even when a module is disabled (pre-configuration): a patch for a scope with no row creates the row in the plugin's default enabled state, without enable/disable stamps, and records a `settings_updated` event. Patches merge in SQL (`settings_json || patch`) so concurrent patches of different keys both land. There is no settings engine.

---

## 5. Security and Privacy

- Official modules declare sensitive integrations in their `OfficialPluginDescriptor.permissions` field
- Memory writes must still go through proposals (`B10`)
- Raw capture inputs must enter via `ActivityRecord` first where applicable (`B24`); editor-owned documents such as diary entries are not raw input records
- Context contribution must be `opt_in` for private/personal or sensitive product data modules (e.g. diary and finance ledger default to `can_contribute_context: "opt_in"` and `include_in_context: false` in settings)
- Plugin settings must not leak across spaces or users — the guard and repository enforce the descriptor's `space` or `user` scope
- Third-party modules are not supported.


---

## 6. Contribution Points

An official optional module may contribute to these extension points:

| Contribution point | Status | How |
|---|---|---|
| Backend route surface | Implemented | Via `PluginHost` + `ctx.http.pluginGuard()` |
| Frontend module entry | Implemented | Page source in `plugins/official/<plugin_id>/web/src/`; app adapter in `apps/web/src/plugins/<plugin_id>/`; `official_plugin` source entry in `MODULE_REGISTRY` + overlay |
| Settings | Opaque JSON in the enablement row | `settings_json` field |
| Job handlers | Implemented | `ctx.jobs.register()`; host wraps handlers with enablement gating |
| Scheduled tasks | Implemented | `ctx.scheduler.register()`; task code must fan out only to enabled scopes |
| Proposal types/appliers | Implemented | `ctx.proposals.register()`; host wraps appliers with enablement gating |
| Context providers | Not wired | No registration point |
| Activity sources | Not wired | No registration point |
| Memory proposal generators | Not wired | No registration point |
| Artifacts | Not typed | No contribution type |

Any other contribution type preserves the same fail-closed enablement rule.

## 7. Bundled Official Modules

| Plugin | Scope | Frontend | Routes | Runtime contributions | Data ownership |
|---|---|---|---|---|---|
| `diary` | `user` | `/diary` | `/api/v1/diary*` | Routes, scheduler, reflection job | Plugin-owned diary entries/reflections; editor-owned personal documents; memory/context extraction remains opt-in and proposal/sources-gated. One reflection per entry and day is a unique key (`diary_reflections (entry_id, reflection_date)`), so concurrent reflection jobs upsert one row. |
| `finance_ledger` | `space` | `/finance` | `/api/v1/finance*` | Routes and proposal appliers | Plugin-owned finance books/accounts/directives/postings/prices/import-export records; PostgreSQL is the runtime source of truth; Beancount text is import/export compatibility. Personal `private` accounts stay off other members' reads and export. |

---

## 8. Non-Goals for This Implementation

The following are out of scope for the current implementation:

- **No marketplace**: no browse/discover/install UI for third-party plugins
- **No external downloads**: no fetching plugin packages from a remote URL
- **No dynamic code loading at runtime**: no hot-load/unload of plugin code
- **No startup DDL from PluginHost**: plugin migrations run only through the installer, never during `activate()`
- **No remote frontend bundle loading**: `React.lazy()` always points to bundled code
- **No app store for third-party plugins**: this is a first-party control plane
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
| `server/migrations/0000_baseline.sql` | DB migration — plugin control-plane and install tracking only |
| `apps/web/src/api/client.ts` | Frontend API client |
| `apps/web/src/plugins/diary/DiaryPageAdapter.tsx` | App-owned adapter that injects web host APIs into the diary plugin page |
| `apps/web/src/plugins/finance_ledger/FinancePageAdapter.tsx` | App-owned adapter that injects web host APIs into the finance ledger plugin page |
| `apps/web/src/modules/plugins/useEffectivePlugins.ts` | Plugin state hook |
| `apps/web/src/modules/plugins/PluginsPage.tsx` | Official plugins management page |
| `plugins/official/diary/web/src/DiaryPage.tsx` | diary editor page |
| `plugins/official/finance_ledger/web/src/FinancePage.tsx` | finance ledger page |
