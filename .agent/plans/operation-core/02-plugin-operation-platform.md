# Plan 2 — Plugin Operation Platform

Status: not started. Depends on the [implemented Plan 1 core contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md) (overall review pending).

## Goal

Plugins contribute their data capabilities only as operations executed by the
core, so every plugin capability is usable by the UI and by Agents through the
same path. Plugins get a scoped database port instead of a raw pool, and can
mount a UI area inside a Project.

## Current state this plan changes

- Plugins can contribute only routes, Jobs, scheduled tasks and proposal
  appliers (`packages/protocol/src/plugins.ts`); `PluginContributions.routeFns`
  is declared and never used.
- `SYSTEM_ACTION_REGISTRY` and `POLICY_ACTION_REGISTRY` are static protocol
  literals; `SystemActionId` / `PolicyActionId` are literal unions used across
  ~25 files; fixtures pin count and order; several call sites read
  `SYSTEM_ACTION_REGISTRY` directly instead of the loader.
- Run tool grants are exact-id only; plugin enablement plays no part.
- `ctx.db` is the raw `pg.Pool`, the same role as the app (currently a
  superuser — see [plan 0](00-audit-defect-fixes.md)), so plugins can run any
  SQL including DDL on core tables. Plugin migrations write `public.*` and run
  inside the HTTP install transaction. finance uses `pool.connect()`; diary reads
  the core table `official_plugin_enablements` directly.
- Scheduled tasks are not gated; plugin routes are always mounted and gated per
  request.
- The server descriptor's `frontend_entries` and the web module registry are two
  unsynchronized copies. Project Areas are hard-coded; there is no slot mechanism.

## Design

### Static manifest (Zod, in `packages/protocol`)

`id`, `version`, `hostApi` range, scope (`space | user`), `requires`, migrations
directory, declared permissions, and contributions:

- `operations` — id, human and model descriptions, input/output Zod,
  `kind: command | query`, side-effect class, `gate_class`, idempotency,
  proposal type, `data_class` (used by plan 4), parameters filled by
  `agent | user_config`;
- `entities` — the data the plugin owns (for the coverage invariant);
- `jobs`, `schedules`, `proposalTypes` (with payload schemas merged into
  proposal validation);
- `web` — routes, navigation, `slots` (e.g. `project.area`, `project.overview.card`);
- `contextProviders`, `skills` (wired in [later extensions](06-later-extensions.md)).

A contribution not declared in the manifest cannot be registered at activation.
The server descriptor and the web registry entry are both derived from it.

### Operations

- Host-enforced namespace `plugin.<plugin_id>.<entity>.<verb>`, MCP-name
  compatible (≤128 chars, `[A-Za-z0-9_.-]`); reject core-prefix collisions.
- Declarations merge into the System Action and policy registries at startup;
  ids widen from literal unions to branded strings; fixtures pin only the core
  portion; direct `SYSTEM_ACTION_REGISTRY` reads move to the loader.
- `ctx.actions.register(id, executor)` in `activate()`; declared-but-missing or
  registered-but-undeclared fails startup.
- Plugin enablement is checked when Run grants are computed and again on every
  call, from the same source as `pluginGuard`.
- Host-guaranteed side effects: `none` → read-only transaction; `proposal` →
  may only submit through the host; `durable` → may only write the plugin's own
  schema. A plugin may raise `gate_class`, never lower it.
- **Plugin UIs use only `/api/v1/actions` and `/api/v1/queries`.** Custom plugin
  routes remain only for non-data cases (file streams, export downloads), listed
  with a reason in the manifest.

### Database port and isolation

- One schema `plugin_<id>` and two NOLOGIN roles: `rainver_plugin_<id>_ddl`
  (schema owner, migrations only) and `rainver_plugin_<id>` (runtime, DML only).
  The server role receives them `WITH INHERIT FALSE, SET TRUE` (PG16+). No
  TRUNCATE, no REFERENCES on core tables.
- `ctx.db` becomes `PluginDb { query(); transaction(scope, fn) }`. Each
  transaction runs `SET LOCAL ROLE`, `SET LOCAL search_path = plugin_<id>, pg_temp`,
  and `set_config('rainver.plugin_id' | 'rainver.space_id' | 'rainver.user_id', …, true)`.
  The tx wrapper dies when `fn` returns; before COMMIT the host checks
  `current_user` and the GUCs and destroys the connection on mismatch.
- Appliers running inside the core proposal transaction are wrapped:
  `SAVEPOINT` → plugin role → applier → explicit `SET LOCAL ROLE NONE` and
  search_path reset (SET LOCAL survives RELEASE) → `RELEASE`.
- Plugins write core data only through host ports (core operations), never SQL;
  plugin rows keep core ids as soft references validated by the host.
- Migration runner: `SET LOCAL ROLE …_ddl`, `lock_timeout`,
  `pg_advisory_xact_lock`; migrations use unqualified names; record `failed`
  with a write outside the rolled-back transaction; production applies pending
  plugin migrations through the offline migrate path with its pre-migration backup.
- An idempotent **reconcile step** (create roles, set owners, re-grant) runs
  after migrate and after restore, because dumps use `--no-owner --no-acl`.
- RLS is not enabled now; the GUCs are set from day one so enabling it later is
  one migration (`ENABLE` + `FORCE ROW LEVEL SECURITY`, policy on
  `current_setting('rainver.space_id', true)`).
- Stated guarantee: this guards against mistakes, not malicious code — a plugin
  sharing the connection can `RESET ROLE`. Documentation must not call it a sandbox.

### Lifecycle

- `registered → installing → migrated → installed → enabled(scope) → disabled`;
  migration failure → `migration_error` with a repair item, no auto-recovery.
- Per-plugin effect scope: every registration returns a disposer; disable runs
  them LIFO and aborts in-flight Jobs. Fastify routes cannot unregister; gating refuses them.
- The host fans scheduled tasks out to enabled scopes; plugins stop reading
  enablement tables.
- `requires` + topological activation; a missing dependency leaves the plugin pending.

### Project UI slot (minimal)

- `ProjectAreaLayout` gains named, typed slots; a plugin declares its slot in the
  manifest and supplies title, icon and a lazy component; the host renders the
  frame, loading, disabled and error states.
- Slot components receive only `{spaceId, projectId, ops, ui}` and use shared
  controls and theme tokens per [UI_STYLE_GUIDE](../../architecture/UI_STYLE_GUIDE.md).

## Work items

- [ ] Manifest Zod schema; derive server descriptor and web registry entry from it.
- [ ] `ctx.actions` port; registry and policy-registry merge; id type widening;
  move direct registry reads to the loader; fixture split.
- [ ] Plugin enablement in `buildRunToolGrants` and at call time.
- [ ] Side-effect class enforcement (read-only tx for queries, write scope for durable).
- [ ] `PluginDb` port, schema/role layout, applier wrapper, pre-commit tripwire.
- [ ] Migration runner changes and the reconcile step (migrate + restore scripts).
- [ ] Host-owned scheduler fan-out and settings port (replaces diary's direct reads).
- [ ] Effect scope / disposers; lifecycle states including `migration_error`.
- [ ] Project Area slot contract and `<PluginSlot>`.
- [ ] Contract tests: every manifest entity has list/get and write operations
  unless exempted with a reason; no plugin data-writing route outside operations;
  per-plugin acceptance matrix (not installed / migration pending / disabled /
  enabled × operations, Jobs, schedules, appliers, slots); cross-Space invisibility;
  idempotency; proposal-class operations never write directly.
- [ ] Real-PostgreSQL tests: plugin role cannot read core tables or run DDL on
  them; tripwire fires after `SET ROLE`/`COMMIT` inside a plugin; reconcile after restore.

## Existing plugins

finance_ledger and diary keep working on the old contract until migrated in
[plan 4](04-plugin-agent-access-and-sensitivity.md). Their tables move to
`plugin_<id>` schemas in this plan only if production has never applied their
migrations (rewrite 0001/0002 unqualified); otherwise the reconcile step moves
them with `ALTER TABLE … SET SCHEMA` + `OWNER TO` and new migration ids supersede
the old ones. Check production `plugin_migrations` before choosing.

## Documents to update

[OFFICIAL_OPTIONAL_MODULES](../../architecture/OFFICIAL_OPTIONAL_MODULES.md),
[ADR 0006](../../decisions/0006-plugin-module-architecture.md),
[DATABASE_AND_TRANSACTIONS](../../architecture/DATABASE_AND_TRANSACTIONS.md),
[SYSTEM_ACTIONS](../../architecture/SYSTEM_ACTIONS.md),
[PROJECTS](../../architecture/PROJECTS.md) (slots).
