# Module Development Guide

> How to add or change backend modules. Current module inventory lives in
> [`MODULES.md`](MODULES.md). Architectural invariants live in
> [`../BOUNDARIES.md`](../BOUNDARIES.md).
>
> **Before any of this**, run the pre-implementation search in
> [`REUSE_AND_DEPENDENCY_POLICY.md`](REUSE_AND_DEPENDENCY_POLICY.md): the module
> you are about to add may not need to exist, and the mechanism you are about to
> build probably already does. That document is the source of truth for the
> reuse ladder, third-party evaluation, and the canonical mechanism index; the
> sections below are its module-shaped application, not a second rule set.

## What Counts As A Module

There are two backend boundary shapes:

- **Registered HTTP module:** exported from `server/src/modules/<module>/index.ts`
  and listed in `server/src/gateway/routeRegistry.ts`.
- **Support package:** import-only package under `server/src/modules/` with no
  direct route registration (`context`, `runtimeAdapters`, shared repositories, etc.).

`server/src/gateway/routeRegistry.ts` is the source of truth for registered HTTP modules.
Support packages are documented in `MODULES.md`.

## Module Classes

| Class | Meaning |
|---|---|
| `kernel` | Identity, isolation, governance, execution spine. |
| `infra` | Cross-cutting infrastructure and host/runtime integration. |
| `capability` | Code-defined agent skills and reviewable evolution surfaces. |
| `product` | User-facing domain feature surface. |
| `frontend-support` | Backend read models and aggregation endpoints for UI views. |
| `support-package` | Import-only package without HTTP route registration. |

## Adding A Registered Backend Module

1. Create `server/src/modules/<module_id>/`.
2. Add `index.ts` exporting the module facade and, when routed, a
   `ServerModule`.
3. Add `routes.ts` that registers Fastify routes under `/api/v1/...`.
4. Put domain logic in `service.ts` and persistence in `repository.ts`; keep helpers internal unless they are intentionally
   exported by the package facade.
5. Add request/response schemas in the module or `packages/protocol/src/` when
   the contract is shared with clients.
6. Add Drizzle schema under `server/src/db/schema/` when the module owns new
   tables, then run `pnpm run schema:generate` from `server/` to merge generated
   SQL into `server/migrations/0001_baseline.sql`. Use UUID/string primary keys
   and include `space_id` for space-scoped data.
7. Register the module in `server/src/gateway/routeRegistry.ts`.
8. Add focused tests under `server/test/`.
9. Run or update protocol tests when shared DTOs change.
10. If the module has a web surface, add it under `apps/web/src/modules/<id>/` and register it
    in `apps/web/src/modules/registry.ts` with a lazy entry point.

Routes must live in module route files, not in `server.ts` or a shared API directory.

For capability/workflow/open-skill work, keep the ownership split explicit:
`catalog` reads raw on-disk manifests, `capabilities` owns the product control
plane, `runtimeAdapters` owns runtime adapter type metadata, `runs` owns
execution, and `runtimeContext` converts approved skill renderings into typed
Delivery items without writing vendor instruction files.

## Public Facades And Imports

Prefer importing package facades:

```ts
import { createProviderCommandStore } from "../providers";
import { RunRepository } from "../runs";
```

Avoid deep cross-package imports:

```ts
import { InternalHelper } from "../providers/internalHelper"; // avoid in peer modules
```

If a needed facade export is missing, add a narrow export instead of adding a deep-import
allowlist entry. The deep-import allowlist should stay empty by default. Copying the
implementation into your module to avoid the boundary is never the answer — see
[`REUSE_AND_DEPENDENCY_POLICY.md`](REUSE_AND_DEPENDENCY_POLICY.md) §6 for the three
permitted resolutions.

Keep facades narrow so tests and peer modules do not couple to internal helpers.

## Dependency Rules

- Modules should use public facades, ports, registries, or hooks rather than importing peer
  internals.
- Do not create package cycles.
- Kernel modules must not import product modules.
- Cross-module writes to Memory/Knowledge go through proposal/application flows, not direct
  service calls.
- `router` owns intent classification, adapter resolution, and `needs_cli`.
- `runs` owns execution lifecycle, run state/events/finalization/output/artifacts.
- `runtimes` own adapter execution and use injected ports for run evidence/process handles.
- `providers` own model invocation and provider credentials.
- `tasks` own task-board behavior, task-run product linkage, and task evaluation.
- `proposals` own approval/apply orchestration and the applier registry; target modules
  own proposal business mutations. Client-facing proposal review/read/apply
  orchestration is owned by the server for registered appliers, and
  unregistered proposal types fail closed until their owning module migrates.

`ProposalApplyService` and the proposal repository live under
`server/src/modules/proposals/`, matching their logical ownership.

## Extension Points

| Need | How to extend |
|---|---|
| HTTP route | Add or update `routes.ts` and register the module in `routeRegistry.ts`. |
| Periodic work | Keep tick behavior in the owning module; register `ScheduledTask` through `server/src/modules/scheduler/backgroundServices.ts` and `SchedulerRegistry`. |
| Durable async job | Add a handler in the owning module and register it with the server job worker registry. |
| Per-space initialization | Register the hook through the server module/service path; hooks run in the caller transaction and must not commit. |
| Post-run side effect | Register a run-finalized hook with `PostRunFinalizationService` integration. |
| Proposal apply behavior | Put mutation logic in the target module and register it with the server proposal applier registry. |
| Runtime adapter | Register adapter/spec in `server/src/modules/runtimeAdapters`; adapters return `RuntimeAdapterResult` and use server runtime services. |
| Model API runtime | Use `model_api` for no-tools provider-backed execution; it calls server providers and does not use CLI credentials, terminal, local-host, or sandbox capabilities. |
| Capability/workflow/open-skill control plane | Add or change `server/src/modules/capabilities`; do not widen `catalog` into remote import, marketplace, or execution ownership. |

### Static contribution registries

Registration performed from a core module's `registerRoutes` path can run more
than once in a process because tests build multiple Fastify applications.
Registries for static module contributions therefore require a stable owner id:
same-owner registration is an idempotent replacement, while a different owner
claiming the same key throws and identifies the existing owner. Register a
cross-module contribution explicitly from the contributing module's init path;
do not rely on importing an implementation file for its side effect.

Use a named `replace()` only where runtime replacement is the documented
contract, currently Project Attention by `areaKind`. A registry and fixed
built-in handlers declared in the same file may self-register once at import
when importing the registry necessarily imports the complete handler set. Do
not add disposal handles until a genuinely runtime-dynamic contribution exists.

## Shared Settings And Scheduler State

New modules must reuse the shared infrastructure for sparse settings and
recurring scheduler cursors. Do not create one settings table or one scheduler
state table per feature. These are the two concerns this repository has seen
duplicated most often; the general rule behind them is
[`REUSE_AND_DEPENDENCY_POLICY.md`](REUSE_AND_DEPENDENCY_POLICY.md) §5 and §8.

### Adding Settings

- Use `server/src/modules/settings/ScopedSettingsStore`.
- Define a typed scoped setting descriptor with a stable `settings_key`, exact
  scope (`instance`, `space`, `user`, or `space_user`), defaults, parser, and
  serializer.
- Use `spaceUserSettingsScopeId()` for composite `space_user` scope ids.
- Put cross-module keys in `server/src/modules/settings/keys.ts`.
- Keep authorization, validation errors, and public DTO shaping in the owning
  module; the settings module is only persistence infrastructure.
- Do not add feature-specific settings tables (`space_*_settings`,
  `user_*_settings`, `instance_*_settings`) or hand-write CRUD against
  `settings`.
- Use env/config for deployment hard limits only. User-, space-, or
  instance-admin-adjustable product policy belongs in scoped settings.

### Adding Scheduler Work

- Register periodic in-process work through `server/src/modules/scheduler`.
- Keep tick behavior in the owning module, but put scheduler startup wiring in
  `scheduler/backgroundServices.ts` and task registry concerns in
  `scheduler/registry.ts`.
- Store recurring cursor/state in `scheduler_tasks` through
  `PgSchedulerTaskStore`. Define a stable `task_type` and `task_key`; populate
  scope columns (`space_id`, `user_id`) where applicable.
- Do not add feature-specific scheduler state tables or product-table cursor
  columns such as `next_run_at`, `next_check_at`, `last_run_at`, or
  `last_checked_at` for recurring scheduler state.
- Keep `jobs` for executable queued work. `jobs.scheduled_at` is queue timing,
  not scheduler cursor state. Domain work-item due fields such as
  `memory_maintenance_jobs.run_after` may stay with the work item when the row
  itself is the durable unit being processed.

## Adding An Official Optional Module

Official optional modules are product feature packages that can be enabled/disabled per
space or per user. Their control-plane descriptor lives in the `plugins` module,
while runtime code for bundled official plugins lives under `plugins/official/<plugin_id>/`,
is compiled into `server/dist/official-plugins/<plugin_id>/`, and is activated by `PluginHost`.

Steps:
1. Add an `OfficialPluginDescriptor` under `server/src/modules/plugins/official/<pluginId>.ts`.
2. Register the descriptor in `server/src/modules/plugins/registry.ts`.
3. If the plugin contributes runtime behavior, create `plugins/official/<plugin-id>/`.
4. Export an `RainverPlugin` whose `activate(ctx)` synchronously registers routes, jobs,
   schedulers, and proposal appliers, then returns `{ activated: true }`.
5. Ensure the plugin package has `plugin.json` and `server/tsconfig.json`; `server/scripts/build-official-plugins.mjs` compiles it into `server/dist/official-plugins/<plugin-id>/`, and `server/src/modules/plugins/builtInPlugins.ts` loads that artifact at startup.
6. In plugin routes, call `ctx.http.pluginGuard(request, reply)` before returning any real content.
   Disabled state returns `{ error_code: "plugin_disabled" }`.
7. Add plugin-owned SQL files under `plugins/official/<plugin-id>/migrations/`,
   load them from the runtime plugin, and expose them through
   `RainverPlugin.migrations`; the installer runs them, not `activate()`.
8. Put plugin-owned frontend pages under `plugins/official/<plugin-id>/web/src/`.
   Plugin frontend source must define the host API it needs and must not import
   `apps/web/src` directly.
9. Add a frontend entry with `source: 'official_plugin'`, `pluginId: '<id>'`, `enabled: false`
   in `apps/web/src/modules/registry.ts`, and lazy-import an app-owned adapter under
   `apps/web/src/plugins/<plugin-id>/`. The adapter imports the plugin page factory
   and injects frontend host APIs. Runtime state is overlaid from backend.
10. Use `useEffectivePlugins()` hook to show/hide UI elements based on backend state.
11. Add core migrations only for control-plane tables shared by all plugins; plugin-owned
    domain tables belong to installer-managed plugin migrations.
12. See `.agent/architecture/OFFICIAL_OPTIONAL_MODULES.md` and ADR 0006 for full context.

Implemented contribution points:
- Routes through `ctx.fastify` plus `ctx.http.pluginGuard()`.
- Job handlers through `ctx.jobs.register()`; the host wraps handlers with enablement checks.
- Scheduled tasks through `ctx.scheduler.register()`; task code must fan out only to enabled scopes.
- Proposal appliers through `ctx.proposals.register()`; the host wraps appliers with enablement checks.

Deferred contribution points:
- Context providers must not contribute when disabled.
- Activity sources and memory proposal generators must preserve the proposal/sources boundary.

Private/personal modules (e.g. diary) must default to `can_contribute_context: "opt_in"`
and not contribute context unless the user has explicitly enabled it in settings. Editor-owned
plugin documents may write their own domain tables directly; extracting them into Memory,
Knowledge, Runtime Context acquisition, or FlashCards must go through proposal/sources flows.

## Ports

Use a `Protocol`/`ABC` when callers need substitution or tests need a fake. Existing examples:

| Port | File |
|---|---|
| Job worker registry | `server/src/modules/jobs` |
| Provider command/store boundary | `server/src/modules/providers` |
| Runtime adapter services | `server/src/modules/runs` and `runtimeAdapters` |
| Memory repositories/read auth | `server/src/modules/memory` |
| Runtime Context preparation and continuity | `server/src/modules/runtimeContext` |
| Policy gateway | `server/src/modules/policy` |

Do not add ports for their own sake. A facade export is enough for a single concrete service
with no substitution need. A port over a third-party package — as with the managed agent loop
over `@earendil-works/pi-agent-core` — is how an adopted dependency stays replaceable without
every caller naming it.

## Guardrails

Run these after structural module changes:

```bash
cd server
pnpm exec vitest run test/boundaries.test.ts
```

Add or run registry-specific tests when changing scheduler/job/space/run/proposal extension
points. Broaden to workflows/contracts when changing execution, proposal, task, or policy
behavior.
