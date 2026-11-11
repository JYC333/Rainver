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

### Skill and Tool boundaries

A Skill is procedural content. `skills/` owns its original package,
review and scoped bindings; `/skills` is the library. A Tool / System Action is
a code-owned operation governed by the registry and gateway. Neither is an
Official Optional Module, and neither uses plugin enablement rows. YAML under
`catalog/capabilities/` is diagnostic, never executable.

| | Skill | Official Optional Module |
|---|---|---|
| Unit | Immutable original package | Product feature package |
| Discovery | `GET /api/v1/skill-packages` | `GET /api/v1/plugins` |
| Enablement | Reviewed package and proposal-approved `skill_bindings` | DB-backed per Space or user |
| Frontend | `/skills` | The plugin's own page; rail item when enabled |
| Authority | Procedural content grants no Tool or plugin permissions | Registered product behavior with plugin guards |

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
`POST /api/v1/plugins/:id/install` (`official_plugin.install`, a system command:
instance admin, its multi-statement migrations run in the worker's own
transaction together with the command's settlement, read through
`GET /api/v1/system/commands/:commandId`; the worker share-locks the issuer's
user and membership rows before its authority check and holds them until the
install commits, so a concurrent disable, membership removal or instance-admin
revocation either commits first and the install is refused, or waits for the
install's commit) runs its plugin-owned schema migrations and
writes `plugin_installs`/`plugin_migrations`, and only then can
`POST /api/v1/plugins/:id/enable` (`official_plugin.enable`) enable it for a user or space.
Enable, disable and settings are keyed operation-core commands at their declared
scope (B53); an operation package's process-local effects are admitted under
durable scope holds and released by their owning process only after a disable
commits (`plugins/lifecycle.ts`, see SQL data-port and lifecycle hardening). The
`plugin.<id>.*` operation namespace stays reserved for plugin-owned operations.

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
Core plugin control-plane schema (`official_plugin_enablements`, `official_plugin_events`, `official_plugin_scope_holds` (0026), `plugin_installs`, and `plugin_migrations`) uses the standard `server/migrations/` append-only chain.

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
takes the file text and an optional `source_type` label and nothing else (any
other field, `post_directly` included, is a 400), lands
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
upstream record (a later line of the same file reusing that id gets its own
key `external:<id>#<n>` and the status `error` /
`external_id_repeated_in_file`, never merged into the first), otherwise the hash of the entry's own lines plus its
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

## Operation manifest platform

P2 stage 1 was independently dual-reviewed and committed in `992b5d12`.
Stage 2 lifecycle code passed independent dual review and is committed in `a2e623f3`.
Manifest-derived web navigation and Project slots are implemented in stage 3, which passed independent Claude/Antigravity review. Legacy diary
and finance keep their existing routes/public tables; no production package,
role change or sensitive Agent access is enabled by this work.

### Registration and authority

`PluginOperationManifestSchema` validates host API 1, bounded lowercase schema
namespaces, operation versions/effects, entity coverage, declared migrations,
Jobs, schedules and proposal payload schemas. PluginHost validates the whole
`requires` graph before activation: cycles abort startup; missing/transitively
pending dependencies have descriptors but no operations or background handlers.
Declarations must match actual registrations exactly. Contribution registration
returns a disposer; the retained host wrappers check disposal before use.

Core literal IDs/fixtures stay intact beside `PluginOperationId`. Operations,
policy actions, descriptors, expected package contracts and lifecycle services
are config-local. A loader without config returns only core/static legacy IDs;
Agent grant building, policy approval lookup and canonical apply pass their
actual config. Two server configs cannot grant each other's plugin operations.
Manifest-derived descriptors default disabled. Admission, catalog listing,
immutable grant construction and replay require current membership, enabled
scope/dependencies, installed version/state and the offline installation's exact
authority-contract hash. A new manifest/schema/effect/dependency contract at the
same version is not silently trusted. Human and Agent HTTP/CLI consumers use P1.

`caller_owned` is an owning-code SQL review obligation, not row isolation or an
automatic B11 exemption. Domain SQL must filter both host GUCs
`rainver.space_id` and `rainver.user_id`; input does not select authority. The
runtime role can access its whole schema and RLS is off. Only genuinely
same-owner reads qualify for B11's same-owner exclusion; operation policy audit
is mandatory. Cross-person content needs a canonical B11 adapter before enabling
that package. Sensitive operations remain user-only, even with a frozen Agent
grant. Fixtures exercise cross-person/Space predicates; the manifest label
cannot prove every future plugin query safe.

### Offline installation and restore

`plugins/operationMigrations.ts` owns the explicit offline transaction. Packages
from the compiled image are ordered by dependency, reject missing dependencies,
and must list exactly their generated migrations. Installed legacy IDs are
excluded from this path: their applied public migrations are not rewritten or
moved. Only an explicit later migration/inventory may change those packages.

A nonwaiting session advisory lock protects the full install/failure-journal
window; DDL also takes the matching transaction lock with bounded `lock_timeout`.
Generated statements execute under the schema's DDL role, never runtime or host
role. Applied checksums are immutable. `installing → migrated → installed` is
atomic (intermediate states are not exposed as independently committed installs).
Failure rolls back data/DDL, then a new transaction on the reserved connection
records disabled `migration_error`, failed journal and a safe-code event. Earlier
applied rows/data survive. It requires explicit offline `--repair-failed`;
ordinary restart never auto-repairs. A same-ID failed row may be retried only
with that option; durable failure events remain. No remote download or HTTP DDL.

`migrateCli up` installs pending operation packages and reconciles their roles.
Pending package changes on an existing DB participate in `maintenance-pending`:
normal start/deployer refuses them and the existing maintenance/backup flow must
stop writers first. With no package changes, ordinary `up` does no plugin-role
DDL. The explicit `plugin-install`/`plugin-reconcile` commands are offline owner
commands; they do not themselves drain applications or create backups. Both
restore scripts run reconcile after `pg_restore --no-owner --no-acl`, with the
existing owner channel and matching package image. Missing previously installed
operation packages fail closed; supplying the correct image is required.

`roleReconcile.ts` recreates/repairs NOLOGIN nonprivileged runtime/DDL roles,
removes inherited memberships, restores schema/table/view/sequence/type/routine
ownership and own-schema ACL/default privileges. Unexpected foreign runtime
table grants fail closed. Host gets SET membership without inheritance (PG16+).
Runtime admission rechecks role flags/membership. Reconcile is idempotent and is
never a startup, activation or HTTP side effect. No product DB or roles were
inspected or modified during implementation.

### Scoped DB and host domain ports

Invocation `PluginDb` joins the existing P1 transaction under local runtime
role/search_path/Space/person GUCs, expires on return and restores the host
before core request/result/audit writes. It owns only private savepoints, not
COMMIT/pool/session controls. Host-owned nested savepoints remain compatible.
Queries retain PostgreSQL READ ONLY. SQL guards also refuse SELECT INTO,
LISTEN, prepared statements, holdable cursors and session/advisory controls.
Role/GUC tripwires poison a corrupted connection rather than returning it to the
pool. Same-backend two-person tests check no temp/listener/prepared/cursor residue.
These are safeguards for trusted same-process code, not a malicious-code sandbox.

The only new core-data domain port is declared Job enqueue, implemented by the
host's existing PgJobQueueRepository in the current transaction. A private
savepoint bridge restores host role only for this fixed adapter and then
returns to plugin role. The plugin never receives that host client. Calling
another top-level OperationExecutor inside an operation remains prohibited.
Settings are host-resolved from the canonical scoped enablement row, not plugin
SQL reads of core tables.

### Canonical proposals

Declared `proposalTypes` contribute namespaced, config-local Zod schemas and
appliers to the existing ProposalApplierRegistry. A linked proposal-class action
only creates a private host-owned Proposal and P1 request; its action executor
never runs business SQL. Acceptance uses PgProposalApplyService and P1 approval
hooks, current requester authority/enablement, frozen preconditions, output
validation and the same transaction for plugin writes, Job intents, decision
and request result. Plugin SQL runs under its runtime role, restored before
canonical audit/result writes. Rejection writes no business effect. Concurrent
accepts, retry, expired/superseded reconciliation use P1's existing key-lock
order; failed apply rolls back data/Jobs/status and independently recovers audit.
Unlinked proposal actions still fail closed with mapping-unavailable.

The new namespace has only host submission/canonical decision/P1 reconciliation
writers. Legacy type-specific bypass writers cannot target it. The eight legacy
writer families inventoried in [Operation core acceptance](OPERATION_CORE_ACCEPTANCE.md)
remain unmigrated/production mappings off; this fixture is not their closure.
No operation package with these new mappings ships enabled in production.

### Jobs, schedules and disable

Manifest lifecycle registrations wrap the existing JobHandlerRegistry,
ScheduledTask and ProposalApplierRegistry. Schedule fanout selects enabled scope
rows on the host; a user scope gets one Job per person/pass in the first eligible
Space, not one per membership. Current person, dependency/version/scope and
PolicyGateway checks precede enqueue. A failed scope does not starve later scopes;
errors reach scheduler health after per-scope work. Job payloads are
validated; system Job/schedule policy audits retain the responsible human.
Jobs recheck live authority and enabled dependency closure before commit.

The enable/disable route's canonical lifecycle service serializes install and
enablement rows in sorted order. Nothing local is touched until a new outcome
commits: an unkeyed, malformed, refused, conflicting or replayed command leaves
local effects as they were.

**Durable scope holds (generation + owner).** Every local effect of an
operation package is admitted under a row of `official_plugin_scope_holds`
(migration 0026): one `active` hold per (package, Space, user, owner process).
Admission (`admitPluginScopeHold`, used by the Job wrapper through
`PluginBackground.admit`) is a short transaction that share-locks the scope's
install/enablement rows, checks the live enabled state and returns the current
hold; resources are entered under that hold id, never under the bare scope.
A disable, in its own transaction, cancels the scope's canonical Jobs, opens a
new **release round**: every `active` or still-`releasing` hold of the affected
packages in the scope becomes `releasing` (`release_plugin_id`, `release_round`,
attempts reset), and records a delayed `official_plugin_scope_cleanup` Job. A
later enable admits new work under a **new** hold; a cleanup only ever closes
the holds of its round, so an old round, replayed or delayed in any process,
never closes a newer generation, and an old-generation Job's final transaction
refuses to commit once its hold is no longer `active` (even after re-enable).
An enable is refused with 409 while any hold of the scope is `releasing`,
in whichever process it lives.

**Commit fence (the hold row).** Work under a hold commits only if its own
transaction, after the scope lock, reads the hold `active`, owned by the
instance that admitted it (still this process's live lease) and that lease
held by its own session at that statement — with the row read `FOR SHARE`
(`pluginScopeHoldCurrent`). The row lock lasts through COMMIT, so no
transition of the hold (disable round, release, adoption, `owner_gone`) can
take effect before that commit, and every transition after it makes the check
fail; a failed statement throws (fail closed). This, not a timer or a
`pg_locks` read, is what orders a Job's COMMIT with every settlement: the
running Job's 1 s abort check only stops work earlier. Admission's write
requires the lease in the same statement; an admitted hold is `active`, which
no foreign settlement touches.

**Owner lease.** A hold belongs to the process instance that admitted it. Its
owner identity is a lease: the session advisory lock
`plugin-scope-owner:<instance>` held on a dedicated connection
(`withDedicatedSessionAdvisoryLock`, backend `pid` recorded at acquisition) for
the instance's life, released by PostgreSQL when the process or its session
ends. Only that session ever takes the key — other processes read `pg_locks`
and never acquire it — so a free lease stays free and a reused pid can never
appear to hold it. The lease is checked on its own timer (every 1 s,
`pluginScopeLeaseCheck`) for detection; every claim, admission, reopen and
commit proves it in its own SQL statement or transaction. A lost lease fences
the process at once: admission refused and every local signal aborted (no
callback runs then), and a fresh lease under a new instance follows without
waiting for the old unlock; right after renewal (and on every recovery pass)
it **adopts** every hold that still holds something here through the
scope-locked reopen (made `releasing` under the new instance, a new round if
it had left `releasing`, `scope_cleanup_reopened`), and records released what
the old lease left with nothing local (skipping a row a commit still locks).

**Attempts.** Only the owner releases its holds — the disabling request after
commit, its periodic recovery (`pluginScopeOwnerTick`, every 2 s), the cleanup
Job in that process, its exit, or an early dispose (the function `onDispose`
returns). Invariant **A1**: every invocation of a dispose callback, from any of
these entries, happens inside an attempt claimed by the one SQL claim
(`claimHoldAttempt`): a single statement against the hold's durable counter for
its round — only when due (`next_attempt_at`, backoff 5 s × attempt; process
exit does not wait), not `needs_attention`, below three, owned by the live
lease and that lease held in the same statement. **A2**: a callback is invoked
at most once per claimed attempt (each claim has its own key; a callback in
flight is shared, never re-invoked), so per round it runs at most as often as
the round's durable `attempts`, never more than three times. There is no
process-local budget. A timer, a Job, a request, an exit and early disposes, in
any order or at once, never double count, re-enter or exceed three, and a late
callback's first run is attempt 1 of its round. The claim of the third attempt
already marks `needs_attention`; after it nothing is invoked (an early dispose
is refused with `PluginDisposeRefused`, as it is when the attempt is not due or
the claim fails) until a new disable round (attempts reset). Registration, a Job
leaving, a lease loss or a shutdown never start a drain by themselves; inside a
running attempt's bounded wait a registration or a leave continues that
attempt's drain. Callbacks run with **no DB transaction or lock held**, and one
short write records the outcome. A hold is `released` only when every callback
registered under it is done and no handle on it is open. Callbacks that
resolved never run again.

**Early dispose.** The function `onDispose` returns goes through the same
claim. It resolves at once for a callback already done, shares an invocation in
flight, and is refused without invoking anything inside an open Job
transaction. On a `releasing` hold it is a full attempt (the same drain and
outcome write as the host's). On an `active` hold it claims against the hold's
active counter (`release_round` null) and invokes only the callbacks whose early
dispose is pending (concurrent requests join one claim); when it succeeds and no
callback of the hold has failed, the counter is reset (`last_outcome`
`disposed`), otherwise its backoff and attention apply until the disable round,
which starts a fresh round.

**Registration windows (late resources).** A resource that outlives a running
handler must be covered by a durable obligation before it can be registered;
no asynchronous reopen or takeover compensates afterwards. Invariants:

- **R1** A registration capability exists only on an open handle, and a handle
  is opened only while its hold is durably an obligation: the Job's entry,
  opened right after admission committed the hold `active` (an entry of a
  closing hold is refused), or a `ctx.retain()` handle, pinned locally and then
  confirmed in one transaction holding the scope's write locks (the order
  enable and disable use), the hold's row lock and the lease proof, before the
  plugin receives it. `retain()` refuses a hold whose generation ended
  (`released`, `owner_gone`) instead of reopening it; a failure (no lease, a DB
  fault, a lock timeout) unpins and rejects with nothing registered.
- **R2** While any handle on a hold is open here, no owner path records it
  released (the local check and the release write are ordered per hold, and
  the write rechecks inside its transaction); other processes only ever settle
  it `owner_gone`, after its owner's lease was verifiably free past the grace.
  So every registration lands on a hold that is `active` or `releasing` in
  PostgreSQL, and an enable in any process either committed before the hold
  was admitted or retained (nothing existed yet) or sees it `releasing` (409).
- **R3** A handle closes only where no registration can follow it. With the
  bounded contract — `ctx.lifecycle.jobs.register(id, handler,
  { disposeRegistration: 'handler' })` — the Job's handle closes when the
  handler settles; a resource created later is reserved with `ctx.retain()`
  first, and its handle closes at `release()`. A Job registered without the
  option (the original contract, where a saved `ctx.onDispose` may register at
  any time) keeps its handle open after the handler returns, until this
  process ends: its hold is never recorded released here, a disable round
  drains what is registered (late registrations included, through claimed
  attempts) and records the outcome `registering`; after three attempts it
  needs attention, an enable stays refused in every process, and the hold
  settles `owner_gone` once the owner exited and its lease was free past the
  grace. The original contract is therefore retained but safe, at the cost of
  re-enabling a disabled scope only after the owning process restarted.
- **R4** A registration through a closed handle throws `PluginRegistrationClosed`
  synchronously (it is reachable only by breaking the declared contract).

Every in-repository producer uses the bounded contract (the lifecycle fixture
keeps an original-contract variant for evidence).

**Other owners.** While an owner's lease is held it is alive: nothing settles
its holds (the Job defers without spending an attempt). A lease verifiably free
is observed twice across `OWNER_LOST_GRACE_MS` (15 s) before its `releasing`
holds become `owner_gone` (`scope_cleanup_owner_gone`) — not `released`; each
statement reads the lease itself and skips rows another transaction holds.
Every process's recovery pass visits foreign owners with a `releasing` hold in
rotation (ordered by owner instance after a per-process cursor, wrapping
around, at most 20 per pass), for any round, so whatever the first owners'
state every owner is visited within ceil(owners / 20) passes, and a cancelled,
exhausted or missing cleanup Job, a worker that does not host the plugin, or a
missing plugin descriptor never leaves a crashed owner's hold releasing
forever. A DB error ends the pass where it is and settles nothing; the next
pass (2 s) retries. The cursor is per process and resets on restart. The Job
(its own per-round cursor) defers while an automatic path remains (own retry
not yet due, live owner not at attention, a free lease inside its grace),
fails when every remaining hold needs attention, and completes only when no
hold of its round is `releasing` (`{settled, released, owner_gone}`).
Graceful shutdown fences, gives every hold still holding something one claimed
exit attempt (an active one opens a round), records released what holds
nothing, and ends the lease.

**Not guaranteed.** The fences cover PostgreSQL state. An effect outside it
that plugin code already issued (a network call, a file) is not undone by the
abort signal or the grace: a process paused or cut off from PostgreSQL past
the grace is presumed gone (`owner_gone`), and what it registers on return is
adopted again but an enable may have run in between. An external effect that
must never act for a stale owner goes through the Job's transaction (an
outbox row committed under the fence) or checks a fencing token at its own
resource.

**Repair surface.** `GET /api/v1/plugins` and `GET /api/v1/plugins/:id` add
`cleanup` (`OfficialPluginCleanupStatus`) for a person who administers the
plugin in this context (B53: Space owner/admin for a Space plugin, the user for
a user plugin): `state`, three counts and the last attempt time; no owner,
process, path or error text is exposed. Each `releasing` hold counts once, from
existing columns (no migration):

| Count | Hold | Recovery |
| --- | --- | --- |
| `awaiting_restart` | last outcome `registering` (only an original-contract registration window keeps it, R3) and its owner not known lost | none by retry: it settles `owner_gone` after the owning service process restarts or exits and the grace passes |
| `attention` | needs attention, last outcome not `registering`, owner not known lost (a failed callback) | a new disable round |
| `pending` | everything else, including any hold whose owner is known lost (`owner_lost_at`) | automatic |

`state` is `needs_attention` when anything is retryable, else
`awaiting_restart` when a hold waits for its process, else `pending`. The
Optional Modules card shows one line per non-zero count under the card text.
Outside `awaiting_restart` it offers **Retry cleanup**, a new disable round
(`POST /api/v1/plugins/:id/disable`; a still-pending result says to see the
status above). In `awaiting_restart` it offers only **Refresh status**: the
copy says that a retry cannot release those resources and that they are
released after the service process restarts or exits; the page never
restarts or deploys anything itself. Enable stays visibly disabled while any
obligation remains, and the read clears once the hold settled. Events remain
audit, not the repair entry.

In-flight SQL is cancelled through the independent audit pool, fenced by backend
pid plus transaction ID; cancellation is awaited before returning the data
connection. Other processes observe durable disable/Job cancellation through
polling and final transactional checks. Arbitrary JavaScript cannot be forcibly
preempted; plugin handlers must honor AbortSignal and dispose resource callbacks.
A retained PluginDb cannot be used by cleanup. Host shutdown disposes registrations
in reverse order. Existing Jobs retries are at-least-once: handlers must use
natural Job IDs/idempotent effects; external exactly-once is not claimed.
Uninstall/data deletion and hot module reload remain out of scope.

### Executable evidence

`server/test/pluginLifecycleDb.test.ts` uses real PG, generic HTTP, Run bearer
HTTP and the built Agent CLI, offline compiled plugin-install/reconcile CLI,
separate canonical worker process, real pg_dump/pg_restore no-owner/no-acl,
failed DDL/lock timeout/repair, dependency scopes, contract drift, config
isolation, canonical proposal accept/reject/concurrency/effect rollback,
disable SQL cancellation/LIFO/error journal and same-connection residue checks.
`pluginOperationsDb.test.ts` covers the original role/query/core/Agent boundary;
protocol `pluginOperations.test.ts` covers declaration invariants. All roles,
DDL, data and subprocesses in these tests belong to isolated test databases.

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
| `server/src/modules/plugins/registry.ts` | Static legacy and config-local manifest descriptors (in-memory) |
| `server/src/modules/plugins/builtInPlugins.ts` | Runtime official plugin artifact loader entrypoint |
| `server/src/modules/plugins/packageLoader.ts` | Loads compiled official plugin package artifacts |
| `server/src/modules/plugins/host/` | PluginHost and host context/ports |
| `server/src/modules/plugins/repository.ts` | DB access for install, migration, enablement, and event rows |
| `server/src/modules/plugins/service.ts` | Business logic: list, enable, disable, settings patch |
| `server/src/modules/plugins/installer.ts` | Legacy public-table installer (manifest packages refused) |
| `server/src/modules/plugins/operationMigrations.ts` | Offline operation-package migration/failure journal |
| `server/src/modules/plugins/roleReconcile.ts` | Offline schema owners/role/ACL recovery |
| `server/src/modules/plugins/lifecycle.ts` | Scoped enable/disable, durable scope holds, owner lease, release rounds and the cleanup read |
| `server/src/modules/plugins/effectScopes.ts` | Per-hold local resource tracking (late registration, entered Jobs, bounded drains) |
| `server/src/modules/plugins/background.ts` | Canonical Job handlers, scoped resource ports |
| `server/src/modules/plugins/schedules.ts` | Canonical scheduler scope fanout |
| `server/src/modules/plugins/proposalContributions.ts` | Canonical proposal schemas/applier wrappers |
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


## Manifest web contributions

All three P2 stages and final whole-P2 review passed independent Claude and
Antigravity review for the original delivery. The later invocation/session
security correction below also passed independent dual review; nothing is deployed.
Stage 2 remains `a2e623f3`; this does not complete the whole Operation Core program.

New first-party operation packages export their browser-safe declaration as
`plugins/official/<id>/operationManifest.ts` (default export). The server runtime
uses that same declaration as `operationManifest`; it must not import Node-only
runtime code into the declaration. `web.entries` declares bounded entry IDs,
default titles/icons and typed placements: `navigation`, `project.area`, and
`project.overview.card`. Protocol `pluginFrontendEntries()` derives descriptor
`frontend_entries`, namespaced module IDs and reserved `/plugins/<id>/<entry>`
paths. Arbitrary URLs, code fields, duplicate entry IDs and unknown placements
are rejected. Web declarations participate in the installed contract hash.

The existing `MODULE_REGISTRY` appends entries derived from these declarations.
`manifestCatalog.tsx` uses build-time local globs, never imports a URL received
from a server or manifest. Each package supplies bundled
`web/src/operationViews.tsx`, default-exporting an entry-ID→component map; the
host refuses a missing/extra registration or mismatched backend descriptor/version.
Only `navigation` placement contributes a global module/rail route. Project
Areas append links inside ProjectAreaLayout's existing navigation, and Pulse
renders overview cards after the Project goal. No competing navigation system,
remote frontend code, marketplace or hot reload is provided. With no declared
Project contributions, these wrappers mount no hook and make no extra request.
Labels reuse the host's existing `modules.<module_id>` i18next keys (for example
`modules.plugin.operation_probe.records`); Project links, global navigation and
slot headings use the same lookup and authored-title fallback. The fixture's
English “Records” / Chinese “记录” are host-authored translations. Missing keys
fall back to the manifest title; user text is never automatically translated.
No second localization system or manifest translation field is introduced.
Legacy diary/finance retain their existing descriptors, registry entries, pages
and permissions; they are not claimed migrated to this declaration convention.

`PluginViewContext<UI>` is browser-neutral protocol: only `spaceId`, nullable
`projectId`, `ops`, and `ui`. UI packages describe the structural controls they
need without importing app/server implementation. The host supplies shared
Button/Input/Card and translated state copy, plus a normal link to the existing
canonical Proposal review page. Scoped ops accept only declared IDs of the
matching command/query kind, validate input/output against the local manifest,
use the canonical actions/queries HTTP client, bind Space, and require an explicit
command key. They expose neither raw request/config/actor nor DB ports and never
automatically retry writes. A Project slot also rechecks its Project read gate
before a UI invocation. The Project ID is view context, not a new domain grant:
Project-owned operations must still declare/authorize their Project targets;
the fixture's records are intentionally Space/person-owned.

PluginSlot owns initial loading, disabled/withheld, transport/bundle mismatch
error/retry, and component-error fallback. It does not show raw exception bodies.
Account/Space/Project/placement changes remount the scope; old ports expire and
requests abort, with generation/session fences rejecting late results. Current
membership/enablement is rechecked by P1 on every call/replay. Background refresh
keeps an enabled same-scope frame stable, while a denial/error immediately removes
its content; focus and periodic checks revalidate metadata. Logout residue cleanup
also invalidates the port. These controls prevent trusted-code mistakes; same-
process browser/plugin code is not a malicious sandbox.

## Invocation role and session follow-up

Post-review real-PG diagnostics exposed two missed boundaries: concurrent plugin
SQL could run during a named host port's elevated role, and Unicode / internal-$
SELECT aliases could bypass the SELECT-INTO guard and leave pooled temp data.
The original full-suite passes and whole-P2 reviews below did not cover these
cases. They remain historical evidence, not proof of these boundaries. This
security patch passed independent Claude/Antigravity review without blockers.
Review approval is distinct from test execution; no reviewer test rerun is claimed.
The patch has its own implementation-run verification and pre-commit gate.

Each PluginDb invocation now owns one callback-scoped serial dispatcher on the
same P1 transaction/connection. Queries, the entire nested savepoint lifecycle,
and named host role transitions share it. Siblings (including Promise.all Jobs)
queue; ordinary nested transaction callbacks reenter through a child queue
instead of reacquiring the ancestor queue they occupy. Plugin SQL/nested host calls from inside a host
callback are explicitly refused. No extra connection or alternate Job engine is
used. Open frames expire as soon as their callback returns; already-running SQL
and role restoration drain before rollback/close, queued work is refused, and
unfinished unawaited work fails that scope. Delayed descendants/retained ports
cannot start work after scope expiry. This is protection against ordinary trusted
code misuse, not arbitrary JavaScript preemption or a malicious-code sandbox.

Unsupported task dependency cycles remain possible: a callback awaiting an
ancestor-created Promise queued behind its current transaction creates a cycle.
The dispatcher does not detect or time out that user-code cycle and does not
guarantee global deadlock freedom. During cleanup, an Unawaited-work error can
replace the callback's earlier exception; original-error preservation is not
guaranteed. No new timeout or arbitrary JavaScript preemption is provided.

The existing SQL literal/comment scanner now supplies whole PostgreSQL identifier
tokens: unquoted high-bit/Unicode characters and internal `$`, opaque quoted
identifiers, AS/CTE parentheses and Unicode dollar-quoted literals. SELECT state
is not reset by DML-looking aliases; legal WITH SELECT → INSERT remains allowed.
Session/TEMP creation is still refused, not made safe by wider role privileges.

Permanent behavior evidence: `pluginInvocationDb.test.ts` uses the actual
PluginHost Jobs port, a jobs trigger and advisory-lock observation scoped to its
own test database (no timing sleep), checking direct core denial, legal data+Job
commit, two concurrent enqueues, sibling/nested transactions, rollback, unawaited
work and expired descendants. `pluginSessionReuseDb.test.ts` first proves the
alias syntax on real PG, then guard denial, same-backend next-person read failure,
no temp residue and successful role reconcile. Both use shared useTestDatabase.

Patch implementation-run evidence: related regression files passed 165 tests
without skips. The separate pre-commit full gate passed server 6419 tests / 5
existing conditional skips (no PG skip), web 2308, Host 574 / 22 optional skips,
protocol 382, CLI 49, folder-read 54, reader-document 52 and outbound-guard 12.
Python deployer / backup / installer passed 38 / 7 / 15. Workspace typechecks,
recursive builds and schema check (13 migrations in sync) passed. The first web
attempt executed no tests because its ignored Vitest cache directory was missing
(ENOENT); recreating that directory and rerunning the complete web suite after
builds finished passed. That failed attempt is not counted as a pass. No budget,
skip condition or runtime behavior was changed during commit gating. These are
implementation validations, not claims that the reviewers reran these suites.

Reuse / Dependency Check: reuse P1 operationTransaction, canonical PluginHost
Jobs, shared PG fixtures/lock observation, the existing SQL scanner and Node's
AsyncLocalStorage already used by the transaction layer. A plain non-reentrant
mutex would deadlock callback queries; the purpose-specific hierarchical queue
adds callback lifetime control without a generic parser, new dependency, pool or
execution engine. Caller-owned/RLS/B11 and P3/P4/P5 exclusions are unchanged.

## SQL data-port and lifecycle hardening

A subsequent P2 review found utility wrapping (`EXPLAIN ANALYZE CREATE TEMP
TABLE AS`), Unicode-escaped function identifiers, SQL-evaluating functions and
the `pg_try_advisory_*` family outside the earlier guards. Historical review and
suite results above do not cover this follow-up.

`operationSqlPolicy.ts` now owns PluginDb statement admission: SELECT, INSERT,
UPDATE, DELETE, MERGE, WITH, VALUES and TABLE are the supported data roots.
Utility wrappers are refused as a class. The only control exception is a local
savepoint form recognized by the shared P1 helper; P1 still generates private
names and enforces ownership. SELECT INTO remains forbidden. Session controls,
all advisory-lock families, dblink and built-in SQL evaluators (`query_to_xml`,
`query_to_xmlschema`, `query_to_xml_and_xmlschema`, `ts_stat`, `ts_rewrite`) are
refused; arbitrary SQL carried in literals/parameters is not recursively parsed.
Both operation ports fail closed on Unicode-escaped identifiers (`U&"..."`,
including UESCAPE) rather than treating executable names as opaque data. Ordinary
Unicode/quoted identifiers, comments and literal contents remain supported.
This remains a bounded safeguard for trusted first-party code: custom routines,
operators, extension functions and tenant predicates require domain SQL review;
this does not make arbitrary PostgreSQL functions safe or create a sandbox.

Plugin local effects are bound to durable scope holds
(`official_plugin_scope_holds`): admission is a short transaction serialized
with enable/disable by the scope's install/enablement row locks; a disable
marks the scope's holds `releasing` in its own transaction (a release round);
the owning process releases them after commit with no DB transaction or lock
held across dispose and one short write per outcome. A newer enable admits
work under a new hold, so an old round never closes it, and an old-generation
Job cannot commit after its hold left `active`: its commit check share-locks
the hold row through COMMIT, so every transition of the hold waits for it.
Ownership is a session advisory lock lease, proven in every admission, claim,
reopen and commit statement; another process settles a hold only as
`owner_gone` after that lease is verifiably free for the grace period, visiting
foreign owners in rotation. Dispose callbacks run only in claimed attempts
against the hold's durable per-round counter (at most three), early disposes
included; a callback is registered only through a handle opened while its hold
is durably an obligation (a late resource is reserved by `ctx.retain()` before
it exists; an original-contract Job keeps its handle, and so its hold's
obligation, open until its process ends). Process-local serialization only
orders one process's own transitions and releases.

The shared operation-session guard also refuses references to `pg_settings`,
including qualified/quoted names and DML inside WITH. Its UPDATE rewrite is
session control despite a data-statement root; both P1 and PluginDb use the same
guard. Read-only diagnostics on that view belong to host code. PluginDb also
refuses calls to the explicit PostgreSQL large-object API (including descriptor
operations, `lowrite` and `loread`), which can otherwise create database-wide
objects outside the plugin schema through public functions. This checks exact
function names followed by a call, not a reserved `lo_` identifier prefix:
ordinary columns/aliases such as lo_limit and even a lo_create alias are allowed.
Quoted/schema-qualified function calls remain refused; literal text containing
these names remains ordinary data. The list follows PostgreSQL's
[server-side large-object API](https://www.postgresql.org/docs/18/lo-funcs.html).
The shared session guard also refuses setseed calls in both P1 and PluginDb,
preventing pooled-session PRNG state from leaking between invocations.

Local resources are tracked per hold (`effectScopes.ts`). A claimed attempt
(`closeHold`, called only by `lifecycle.ts` after its SQL claim) aborts the
hold's signal, refuses any further admission under it and drains its callbacks
LIFO; a callback registered while that drain runs, or within the attempt's
bounded wait, is drained by it too, and a hold with an open handle (an entered
Job, a retained handle) is not released until it closes. A registration after
the attempt's wait waits for the next claimed attempt; a registration through
a closed handle throws `PluginRegistrationClosed`, and an original-contract
Job's handle lingers (`linger`, status `registering`) instead of closing. A
callback that resolved never runs again, one that rejected is retried by a
later attempt (callbacks must tolerate a retry after their own rejection), and
one in flight is shared, never re-invoked. Each invocation carries the key of
the claimed attempt it runs under and a callback runs at most once per key;
there is no local budget. The function `onDispose` returns (an early dispose
of that resource) asks the owner for a claim through the same SQL statement
(`earlyAttempt` → `claimHoldAttempt`; concurrent requests join one claim),
resolves on success without running it again, shares the in-flight
invocation, and is refused without running while the Job's transaction is
open (`inJobTransaction`, inherited by continuations, cleared once the
transaction ended) or when no attempt can be claimed. One early runner per
hold claims attempts until no request is pending; it gives up its scheduling
right in the same synchronous step that found nothing pending, so a request
made by the continuation of a caller it just settled (`await a(); await b()`)
either is seen by that runner or starts the next one, never waits on a runner
that already finished. The runner never rejects: a claim fault refuses the
requests it considered, and an unexpected fault refuses every pending request
and releases the right. Each wait is bounded at three seconds and never inside a DB
transaction (a Job's handle closes after its own transaction ended); a drain
may outlive the wait and stays tracked as in flight. Timeouts do not cancel
arbitrary JavaScript and synchronous event-loop blocking cannot be preempted.
Cleanup rejection is observed even after the timeout.

Migration failure events identify `phase` (install, provision, migration,
reconcile or finalize) separately from nullable migration_id. Only failures
attributed to an actual migration enter plugin_migrations; an installation or
reconcile failure no longer invents an install migration or blames the last
applied migration. Install state still fails closed until explicit offline repair.
Historical records are not rewritten. A retry without explicit repair first
checks migration_error under the install session lock, before the journaled
transaction. Its 409 refusal preserves the original install error, migration
rows and failure events instead of recording a second migration failure.

Executable evidence extends `pluginSessionReuseDb.test.ts`: PostgreSQL first
executes the actual syntax in a rolled-back probe, then PluginDb refuses it and
reuses the same backend across people without temp/GUC/advisory residue.
`pluginLifecycleDb.test.ts` covers concurrent enable/disable, new resource
admission, failed-enable preservation, cleanup deadlines/retention, durable
holds across independent process compositions (generation fence, live-owner
obligations, wrong-worker deferral, cancel/exhaustion, owner end/restart as
`owner_gone`, lease-loss self-fence), the lease barrier (killed lease while the
recovery pass is busy: admission and commit refused, a running Job not
committed, no callback outside a claim, foreign `owner_gone` only after grace
while adoption is held back, then adoption under the new lease), the commit
fence (check passed → barrier → lease terminated → adoption, foreign disable
and foreign pass all wait → old COMMIT first; a failed statement throws; an
impersonating holder of the old key does not revive it), one attempt counter
across timer (fake-clock interval), Job, request and concurrent entries, late
resources (`retain()` with an
injected write failure, stuck behind a row lock while another process
disables, an ended generation refused behind this process's uncommitted enable
and never reopened, then owner exit; the newer generation untouched; a
released retained handle refuses registration), a retained late callback's
first run counted as attempt 1 (three across request/timer/Job/concurrent,
then only a new round; a real Job's `ctx.retain()`), original-contract
consumers of the real fixture in another process (a handler returns, then
creates a resource after the disable round began: the hold is never released,
the foreign enable is refused throughout, the resource drains in a claimed
attempt, three attempts reach attention, no reopen exists, and only the
owner's exit plus the grace settles it `owner_gone`; a failed round write and
an exit with the window open never record it released, a registration after
exit is tracked and settled `owner_gone`), a bounded-contract producer whose
registration after its handler settled is refused, early disposes through the
SQL claim (two concurrent requests in one active claim, reset on success; a
failing one: refused when not due, shared when concurrent, then interleaved
with the timer pass and the cleanup Job — each invocation records the durable
round and attempt it ran under: active `[1, 2]`, round `[1, 2, 3]`, nothing
after attention, then the product retry route once), an early dispose inside
the Job transaction refused and disposed once afterwards, the foreign-owner
rotation (twenty live owners at
attention before a crashed one, an injected DB fault settling nothing),
recovery with no Job left (cancelled, exhausted, plugin not hosted), a real
Job's late registration and the `cleanup` read, and phase-specific failure
journals. `pluginHost.test.ts` checks deadlines with fake timers, closed-handle
refusal, pins, lingering handles, an early dispose with no owner refused, and
that no callback runs outside a claimed attempt, without timing sleeps. The shared core consumer also checks
Unicode identifier refusal in `operationExecutorDb.test.ts`.

Reuse / Dependency Check: keep P1's transaction, savepoint translation, existing
SQL lexical scanner, PluginEffectScopes and shared PostgreSQL fixture. Evaluated
[libpg_query](https://github.com/pganalyze/libpg_query), the PostgreSQL parser with
Node bindings: it can parse utility ASTs, but cannot determine the effects of
SQL hidden in function inputs or custom routines. A full parser/native runtime
is unnecessary for this explicitly bounded data-port admission contract; no new
parser, dependency, connection pool or execution engine is introduced. The small
per-scope transition tail orders only the existing local resource lifecycle.
Deadlines use Node timers and observed native Promises within PluginEffectScopes;
no generic timeout engine, retry loop or dependency is introduced.

## Operation platform acceptance

Reviewed P2 changesets: stage 1 `992b5d12`, stage 2 `a2e623f3`, and stage 3
`20ef5240`, including build isolation, SQL alias and localization fixes. Independent
ACP change `b66f1b52` is outside P2 review scope. Both final whole-P2 reviews
passed without blockers. They were read-only code reviews; no reviewer rerun of
tests is claimed. Verification below is implementation-run evidence, separate
from review approval. The completed temporary P2 ledger is retired to this guide. No production DB, role, credential, deployment or old published
image was inspected/changed. New production operation packages/mappings remain
absent; the only complete demonstration is an isolated first-party test fixture.

| Contract / layer | Executable evidence | Actual boundary |
|---|---|---|
| Single declaration → descriptor → registry / typed placements | protocol `pluginOperations.test.ts`; `pluginFrontendDb.test.ts` | Shared fixture manifest is imported by the real server and the acceptance-mode local catalog; no duplicated frontend metadata |
| Namespace / declared vs registered / unsupported API / B11 eligibility | protocol manifest tests; `pluginOperationsDb.test.ts` | Core literals unchanged; caller_owned is a domain SQL review obligation, not RLS or automatic audit exemption; cross-person declarations refused |
| Install, migration failure, advisory/DDL locks, runtime vs DDL role | `pluginLifecycleDb.test.ts`, generated fixture migration | Real isolated PG, independent failed journal, explicit repair; legacy applied public migrations never rewritten |
| Role/pool/session and read-only boundary | `pluginOperationsDb.test.ts`, `pluginSessionReuseDb.test.ts` | Same backend across people; legal SELECT CTE + INSERT allowed; SELECT INTO/TEMP/session residue refused, including PostgreSQL-valid AS insert/update/delete and quoted aliases; legal SELECT CTE then INSERT preserved; host role restored |
| Human HTTP + Run grants/HTTP/CLI replay | `pluginOperationsDb.test.ts`, `pluginLifecycleDb.test.ts` | Real P1 consumers; live permission/enablement, immutable exact grants and no automatic write retry |
| Canonical Proposal accept/reject/concurrent/rollback | `pluginLifecycleDb.test.ts`; browser clicks existing review/Accept page | Real PgProposalApplyService; plugin data/Job/result/status atomic; failure audit independent; no second approval engine |
| Host Jobs / schedules / disable | lifecycle tests + browser's real JobWorker | Two real scheduler processes reserve one equivalent pending/running intent; original enabling person lost → diagnostic, no arbitrary owner substitution; LIFO/cancel preserved |
| Audit capacity | lifecycle pool-saturation test | Control probes/cancel use separate max-2 pool at 1s, one outstanding probe per Job; audit pool capacity unaffected |
| Project parent entry + overview + destination | `pluginFrontendDb.test.ts` | Actual App/registry/ProjectAreaLayout/PluginSlot, Vite and Chromium with real moduleServer+PG; browser `/me`/`/me/spaces` and the existing server auth test seam select seeded real people; domain APIs/data remain real |
| UI reads/writes → review → Job → disable → reload | same browser workflow | Real HTTP and PG assertions, no browser-only data backend; host loading/error/disabled rendered |
| User/Space/Project switch, late response, real Project grant revocation | browser workflow; `PluginSlot.test.tsx`, `useEffectivePlugins.test.tsx` | Old PG response held across client-side route switch; other Space/person has no previous records; expired ports/abort results refused; real team-Project viewer grant revoked |
| Restore → role reconcile → browser reload | browser workflow + stage-2 actual offline CLI test | Real pg_dump/pg_restore --no-owner --no-acl, host reconcile, then browser reads restored rows rather than post-dump changes |
| Desktop/phone visual acceptance | browser workflow; screenshot names below | 1280×900 and 390×844, dark/light, English/Chinese; navigation and destination both inspected; loading/error/disabled and phone overview inspected |

Implementation-run pre-commit evidence for `20ef5240`: server full suite 6400
passed / 5 existing conditional skips (no PG skip), web 2301 passed, Host 571
passed / 22 optional skips. Protocol / CLI / folder-read / reader-document /
outbound-guard full suites passed 376 / 49 / 54 / 52 / 12 tests; Python deployer /
backup / installer passed 38 / 7 / 15. Workspace typechecks and recursive builds,
schema check (13 migrations in sync), 25 guide/hygiene/boundary tests and 74 local
documentation links passed. Initial sandbox socket EPERM passed on the legal
permission path. High-worker overlap caused timing/assertion and budget failures;
separate full runs passed with existing budgets unchanged. Server used a 5-CPU
affinity so its existing availableParallelism rule selected 4 workers; Chromium
workflow took about 24s against the original 30s limit. No threshold, skip condition
or runtime behavior was changed to hide failures. Normal production build parsed
zero fixture modules; acceptance mode parsed only its three intended consumers.

Reproduce the focused browser acceptance from the repository root, with existing
Playwright Chromium (or `CHROMIUM_EXECUTABLE`) and access to isolated test Docker:

```bash
REQUIRE_TEST_POSTGRES=true PLUGIN_VISUAL_OUT=/tmp/rainver-plugin-platform-visual \
  pnpm --dir server exec vitest run test/pluginFrontendDb.test.ts --maxWorkers=1
```

`plugin-acceptance` Vite mode activates the bundled fixture only; normal production
builds resolve an empty `acceptanceCatalog` instead: only plugin-acceptance mode
aliases that entry to the fixture manifest/view consumer. The normal source graph
has no fixture import and a build hook fails if a test module is parsed; this is
not dependent on tree-shaking an imported fixture. Both build modes are verified;
normal builds do not ship its view chunk. It uses the same
`server/test/fixtures/pluginOperation/manifest.ts` as the real runtime consumer.
The normal build still has no new advertised operation package. Authentication cookie/SSO flows are not acceptance targets here; the existing
server auth seam selects the same seeded people as the browser bootstrap. The test starts
only local services with minimal environments, uses the existing shared real-PG
fixture and cleans the auth seams/processes; missing PG/browser fails when required,
not a fake-DB fallback. An unrelated attention SSE endpoint is absent from the
focused moduleServer composition; ordinary HTTP attention/chrome reads are real.
No SSE, provider login, deployment or old-image compatibility acceptance is inferred.

Screenshot family (generated outside the repository, copied to this Run's output
artifacts for review): `{desktop,phone}-{parent,slot}-{dark-en,light-zh}.png`,
`{desktop,phone}-{loading,error,disabled}.png`, and
`phone-overview-{dark-en,light-zh}.png`. The implementer inspected these images:
Project goal precedes the optional overview card; the area link is in the existing
nav; the adjacent Pulse goal takes a full row on phones instead of being squeezed
by its existing action group; controls use shared tokens and wrap on narrow screens, with local 44px narrow
form targets; keyboard Tab reaches Save. Initial wrong-entry/transition selectors,
StrictMode lifetime reactivation, same-scope refresh remount, and fixture-origin
CSRF setup were corrected. This is visual evidence, not just overflow/jsdom checks.
No budget threshold or permission gate was relaxed to obtain a pass.

Limits retained: the PhD application plugin remains P3; sensitive Agent access/
full diary-finance migration remain P4;
eight legacy Proposal writer families remain unmapped for P5; no RLS/cross-person
B11 adapter, hostile-code isolation, remote packages, uninstall/data deletion,
external exactly-once or arbitrary-JS preemption is claimed. Existing backend
lifecycle evidence is reused, not relabeled as production migration closure.
