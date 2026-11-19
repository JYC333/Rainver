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

Current bundled modules use both scopes: `diary` (an operation package since
[Plan 7](#diary-package)) uses `user` scope for personal entries, while
`finance_ledger` uses `space` scope for shared finance books.

A **Project-level** operation package additionally declares
`project_binding: 'required'`. Its `space`/`user` enablement stays the
admission layer; each Project it reaches needs its own binding. See
[Project binding](#project-binding).

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
{ "detail": "Plugin is not enabled", "error_code": "plugin_disabled", "plugin_id": "finance_ledger" }
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

Plugin-owned domain tables do not live in the core baseline. The `diary` operation package owns `plugin_diary.entries` and `plugin_diary.reflections` through its generated operation migration; an existing database's retired `public.diary_entries` / `public.diary_reflections` are adopted once by the offline installer and left in place (see [Diary package](#diary-package)). The `finance_ledger` operation package owns its ledger and import/export tables in `plugin_finance_ledger`. The offline installer adopts the retired public Finance tables once. See [Finance ledger package](#finance-ledger-package).

### Editor-owned content vs raw input
Diary entries are editor-owned user documents, similar to Notes. A person's
save writes the Diary tables through the person-only `plugin.diary.entry.save`
operation. It does not create an `ActivityRecord` or Memory, and nothing writes
Memory, Knowledge, Runtime Context, FlashCards or an agent-readable summary from
a save. An Agent's only Diary write is an append Proposal (see
[Diary package](#diary-package)).

The Diary editor serializes saves for the same operation port and day,
including debounced, manual and unmount saves. The queue survives editor
remounts, continues after a failed request, and a scope change (account, Space)
gives the page a new port whose predecessor refuses queued text. This orders
one browser's writes; it does not resolve conflicting edits from separate
browser sessions.

Finance ledger rows are space-owned business data. Direct ledger editing writes
the finance plugin tables and does not create an `ActivityRecord`. Beancount text
is an import/export compatibility format, not the source of truth; PostgreSQL
rows are authoritative at runtime. A personal account with `visibility =
private` is readable and exportable only by its owner; other Space members do
not receive that account, its postings, or transactions that touch it.
The `plugin.finance_ledger.import.beancount` command stages dated entries as
`proposed`. It takes `book_id`, text and an optional `source_type`. Posting
uses the separate proposal commands. The importer records `open`, `close`,
`commodity` and `option` directives as `excluded`. An entry with unresolved
accounts or commodities waits in `pending_mapping`. The uploader can manage
the book, map the file's account name onto an existing account with
`import.map_entry`, or retry with `import.retry`. Mapping rechecks account
visibility and the entry date when persisted. Each mapping has a version
and the entry keeps the original text.

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
as `needs_review` until the uploader uses `import.review`
with `import` or `duplicate`; a trusted external id already imported settles
as `duplicate` on its own. A batch, its entries and their text are visible
only to the member who uploaded it.

Account close, direct posting, import validation/persistence and batch import
approval share a transaction-held `FOR NO KEY UPDATE` book lock. Posting checks
account dates again after acquiring it, and closing refuses later posted
entries. The lock is compatible with the book foreign keys' `KEY SHARE` locks
held while creating drafts. A directive dated on the closing day remains valid.
The transaction creation command acquires the book lock before allocating its
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
| Proposal types/appliers | Implemented | `ctx.proposals.register()`; host wraps appliers with enablement gating and passes the proposal's business subject (linked requester, else owner/creator) as `proposal.user_id`, never the approver; a `user`-scope plugin proposal is refused unless that subject is the approver |
| Context providers | Not wired | No registration point; legacy `include_in_context` has no consumer and operation descriptors declare `never` (ADR 0030 §10) |
| Core objects | Implemented (operation plugins) | Declared typed `core_ports` only; see [Agent data access](#agent-data-access-adr-0030) |
| Activity sources | Not wired | No registration point |
| Memory proposal generators | Not wired | No registration point |
| Artifacts | Core port only | `artifacts.create` typed core port for operation plugins; no contribution type |

Any other contribution type preserves the same fail-closed enablement rule.

## Operation manifest platform

P2 stage 1 was independently dual-reviewed and committed in `992b5d12`.
Stage 2 lifecycle code passed independent dual review and is committed in `a2e623f3`.
Manifest-derived web navigation and Project slots are implemented in stage 3, which passed independent Claude/Antigravity review. Plan 7 moved Diary and Finance onto those package contracts and the same data-access gates.

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
that package. Personal and sensitive operations reach an Agent only through
the [ADR 0030 data access gates](#agent-data-access-adr-0030); without data-side
consent they stay user-only, even with a frozen Agent grant. Fixtures exercise cross-person/Space predicates; the manifest label
cannot prove every future plugin query safe.

### Agent data access (ADR 0030)

Decision: [ADR 0030](../decisions/0030-plugin-agent-data-access.md).
Implementation: `plugins/dataAccess.ts` (meta, pins, Run audience through the
Rooms owner's `roomAudience`, scenario, consent lookup, launch-isolation proof
and call-time facts), `dataGrantRepository.ts` / `dataGrantOperations.ts`
(consent writer and person operations), `releaseGate.ts` (trusted
classification and the release gate), `egress.ts` (outward-write
classification), `corePorts.ts` (typed ports); attribution store
`contentAccess/agentReads.ts` written through `ContentAccessAuditService`.

- Package facts: installing the composition computes each operation package's
  parsed, frozen manifest and admission identity once per config
  (`operationPackageFacts`); tool metadata, consent and enablement read those
  facts and the composition's release drops them. Install rows, enablement,
  consent and revocation are never cached: `operationPluginEnabled` applies one
  live check to the package and each dependency, the dispatcher reads it only
  for granted plugin tools and the catalog/grant builder once per plugin per
  build, while call-time authorize and the release gate recheck it.
- Manifest: `data_class` ∈ `non_sensitive | personal | sensitive`; optional
  entity `data_class` floor; optional `core_ports`. Floors and ports join the
  contract hash only when declared, so earlier packages keep their admitted hash.
- Registry: `permissions.agent` makes every class Agent-eligible at the
  definition level; personal/sensitive then pass `authorize` facts →
  `rulePluginDataConsent` (requestable `plugin_data_consent_required` or
  `plugin_data_scenario_refused`) → hard invariant
  `hard_invariant_sensitive_plugin_read_egress` for outward writes. After a
  sensitive read, the gate treats plugin proposal submissions as outward writes
  regardless of their data class.
- Scenario: personal/sensitive writes are proposals from a person's own turn in
  an owner-only audience; sensitive reads need an owner-only audience, a
  manual turn (per-Run consent) or the owner's own scheduled Run (`background`
  consent); delegated Runs and system wakes get neither. A shared audience
  (multi-person Room, selected users, Space-shared Run) may get **personal
  reads only**, released as the readable intersection below (rows every
  reader's result contains; each non-row field — total, cursor, summary, at
  any depth — only when identical for every reader, else nothing is released).
  The call-time
  origin compares the Run with its lineage root (`effective_origin`).
- Sensitive isolation: owner consent never stands in for network isolation.
  A plugin's sensitive data reaches a Run only when its latest live attempt carries a
  server-written `run_attempts.launch_isolation_json` naming that attempt's
  launch nonce, the built-in strict Host and egress profile `none` (the daemon's
  `--unshare-net`). `default`/`install` egress, a paired Host, no launch or a
  relaunch without the record refuse. The dispatcher
  (`runs/modelChannelLaunch.ts`) composes that launch for a Run whose snapshot
  pins a sensitive tool, bound to a ModelProvider, on the built-in Host whose
  daemon reports `model_channel`: egress `none` plus the Run's model-only
  channel (`HostLaunchModelChannelSchema`; daemon `modelChannel.ts`), recorded
  as `model_channel: "provider_lease"`. Runs on a CLI's own vendor login, paired
  Hosts and older daemons keep ordinary egress, so their sensitive reads refuse.
  That Run's lease is `model_only` at the provider proxy
  (`providers/proxy/modelOnlyPolicy.ts`): inference endpoints, the leased model
  and an allowlisted request structure only — no hosted tools, URL/file-sourced
  content, or file/batch/stored-response endpoints.
  Project-bound core data tools (Gmail) are exempt from this launch proof
  (`plugins/dataAccess.ts`): they run on the conversation's own runtime and
  their boundary is the consent's Project
  ([ADR 0033](../decisions/0033-gmail-project-consent-and-private-delivery.md) §6).
  A plugin's sensitive tool, and a conversation holding sensitive plugin data,
  still launch isolated or not at all.
- Snapshot: `buildRunToolGrants(..., {scenario})` admits personal/sensitive
  tools only for an eligible scenario and consent; Run creation and Work
  Context rebinding compute the scenario from the same audience predicate and
  store `permission_snapshot_json.plugin_tool_pins`. A pin mismatch at call time
  is `operation_not_granted`; legacy snapshots without pins keep only
  `non_sensitive` tools.
- Classification: `assertOutputWithinClass` reads the raw executor output before
  the declared output schema can strip a label; a `data_class` anywhere above
  the operation's pinned class (or not a class) withholds the result for every
  actor, and a command rolls back. Lower labels never lower the class.
- Release gate: every successful result body — query, command after its commit,
  and idempotent command replay — passes `releasePluginResult` in a separate
  audit transaction before it leaves the server; a failure returns
  `operation_audit_unavailable` (a committed command's receipt is released by
  the same gate on retry). Lock order, identical to the writers': people
  (`lockActivePeople`) → Run `FOR UPDATE` → plugin installs → enablements
  (dependency closure, sorted) → consent `FOR SHARE`; disable takes the install
  row and revocation the consent row `FOR UPDATE`, so either commits first and
  the release withholds, or waits. It rechecks actor, audience, dependency
  enablement and consent, merges taint `plugin_reads` and writes
  `agent_data_read_logs`. Command receipts persist host-only release facts
  (`frozen_json.release`).
- Shared per-reader reads (`perReaderRead` in `dataAccess.ts`): every personal
  read and, because `caller_owned` rows belong to the person who wrote them,
  every query of a `caller_owned` package whatever its class. The same
  read-only query runs as each other current reader (active Space member with
  the plugin enabled and, for a Project-bound package, reading the Project); a
  reader's own refusal withholds the result, and so does the requester's own
  (the same `operation_not_found` response, so a shared Run cannot tell whose
  record is missing); only rows every reader's own result contains are released. The release pins and rechecks that audience,
  its enablement and (Project-bound) each reader's Project read.
- Core ports: `tasks.create` and `relations.person.create` run the core
  command registration's own steps, shared with the executor
  (`systemActions/operations/registrationSteps.ts`: resolve → normalizeInput →
  authorize → policy → execute → output schema → authorizeResult, with its
  `classifyError`), and its policy action in the same transaction (audit metadata
  `via_plugin_core_port`), never a recursive `execute`. A port runs under the
  enclosing plugin operation's grant: the manifest's declared `core_ports` are
  the plugin's reviewed host ceiling, so the Run needs no grant of the core
  action (`task.create` called directly stays `system_action_not_granted`), while
  the core's actor eligibility (user-only Relations), Project gates, turn fan-out
  limit and refusal codes still decide, and any refusal rolls the whole command
  back; `memory.propose`
  creates a canonical B10 proposal (sensitivity ≥ `sensitive` for non-normal
  operations or a Run already tainted by a sensitive read); `artifacts.create`
  (commands) writes a private inline Artifact (≤ 64 KiB) through
  `insertArtifactRow` under the Task writer's Project gate and the
  `artifact.plugin_create` policy action with the egress invariant — an Agent
  only in its Run's Project from a person's own turn, attributed to the Run;
  `references.resolve` (queries only) returns a title only when every current
  reader of the output reads the object fully without oversight and, for an
  Agent, inside its Run/Agent Project scope; for a Project-bound operation the
  object must also be the bound Project's own, for a person too (the release
  facts carry that Project). `references.verify` (commands too) answers the same
  condition as a boolean for a reference about to be stored, so a command output
  carries no resolved content; it first pins the object's read closure (its row,
  Project shares, every reader's grants and membership, the Projects involved:
  `lockSourceRetrievalRelease`) to commit, so authorization and Project
  ownership are decided on one state and a concurrent move or revocation either
  commits first or waits for the save (a closure that changed while waiting is
  not verified). A Project-bound operation never reaches a space object through
  `references.*` (resolve returns null, verify false); Notes go through
  `notes.read` only. `notes.read` (`PluginCorePorts.notes`) is a read-only Notes
  port over Knowledge's own revision reader (`readNoteRevision` in
  `knowledge/noteRevisionService.ts`): a Note qualifies when it is active (not
  trashed or archived), every current reader reads it fully without oversight
  and, for an Agent, inside its Run/Agent Project scope, and for a Project-bound
  operation its whole content-ACL Project closure (owner Project and every active
  Project share) stays inside the bound Project, so a Note of this Project or a
  Project-free personal Note qualifies while another Project's Note, or one
  shared to another Project, does not. `notes.verify` (commands too) pins the
  same closure as `references.verify` (`confineProjects` included) and returns
  only `{current_version}`, optionally checking that a given version exists;
  `notes.read` (queries only) returns one revision (current unless `version` is
  given) with title, current version, hash, creation time and, with `body: true`,
  its plain text cut at `PLUGIN_NOTE_TEXT_MAX` characters (`truncated`). It adds
  the Note to the release references, so the release gate rechecks it for the
  final audience, records the read and taints the Run with the Note's
  visibility. `notes.draft` (`PluginCorePorts.drafts`, `plugins/noteDraftPort.ts`)
  is the one Notes write path, for a person only (an Agent actor is refused) and
  only for the bound Project: `start` (commands) checks that each pinned
  `{note_id, version}` qualifies as for `notes.read` and exists and that the inputs
  may go to the resolved provider (`egress_denied` otherwise, nothing queued), then queues one
  private `provider_task` Run of the person (capability/task `plugin_note_draft`,
  provider resolved like a reading-method revision: requested, the task's provider
  policy, else the Space default; at most two active and 30 a day per person) with
  the plugin's request text frozen on it and its Job; the revisions are never copied
  into it. The worker's preparer rechecks the Project and every input, reads the
  pinned revisions (each cut to its share of 120 000 characters) and builds a
  code-owned prompt; each attempt rechecks again, and the reply (JSON
  `rainver.note_draft.v1`: draft at most 30 000 characters, at most 20 `verify`
  strings, `sources_used` cut down to the pinned inputs) commits with the Run's
  `succeeded` under the Run terminal owner after one more recheck, so a revoked or
  moved input fails the Run and its reply is never kept. Reading a Note is not consent
  to send it: every input is also judged by the egress rule every model send applies —
  its Source lineage (`provenance_links` to Source items, snapshots and evidence), the
  person's own read of each Source, each Source's model-egress consent and class, and
  the Space's `external_egress_enabled` — against the destination of the provider and
  model actually used (`providerEgressDestination`). The preparer passes that policy to
  the provider invocation (`BoundedProviderTaskInput.egressPolicy`), which refuses a
  denied destination before any request; each attempt rechecks it
  (`note_draft_egress_denied`), and its `authorizeSend` fence rechecks read and egress
  under the current Job claim and the Space egress-settings lock right before each
  physical send. Every one of these checks (the preparer, each attempt, the send fence
  and the result's commit) holds what it rests on until it commits, in the canonical
  Delivery order: the bound Project's audience (`lockProjectAudience`, which every
  membership writer's `lockProjectAudienceForChange` conflicts with), each input
  Note's content-read authority (`lockContentReadAuthority`: the Space, the Note root,
  then the person's grant — the root-then-grant order `content.access.update` takes —,
  its Project scope and shares) in id order, then the inputs'
  Sources — and only then the Run row and the Job claim. A membership removal, unshare,
  grant revoke or Source change that commits first is seen (nothing is sent, or the
  result is rejected as `note_draft_rejected`), and one that comes later waits for the
  send admission or publication. The Run freezes the inputs' Source connections when
  it starts (`source_connection_ids`); every later check answers to those as well as
  to the live lineage. The preparer declares the task claim-bound (`claimBound`), so the
  production `provider_task_run` handler writes the Job's one-attempt start fence and
  runs the task under `withJobEffectAuthority`: the fence's `lockCurrentJobClaim` and
  `authorizeJobEffect`, and the result's settlement, refuse once the Job was reclaimed,
  cancelled or claimed again — that worker sends nothing, publishes nothing and leaves
  the Run to the claim's current owner (`reclaimStuckJobs` ends it), and the start fence
  keeps a later claim from sending it again. Failure settlement is claim-bound too: a
  provider or contract failure, and the handler's exhaustion path (a preparer that
  throws before any claim-bound work included), fail the Run only in a Run-terminal
  transaction that first locks the Job row under the current claim
  (`failBoundedProviderTaskRunUnderClaim`); a worker that lost it fails nothing. Generic Run reads (`getVisibleRun`/`listRuns`: Run detail, status,
  I/O and lists) admit a draft Run only for the person who started it, without Space
  oversight — the rule reading-method Runs keep — and only while they still read its
  Project, every pinned input and every Source in the inputs' lineage under its own
  reader consent (`draftRunReadable`, through `domainRunReadable`), so a revoked
  source Note or Source withholds the derived draft on every entry as the preview
  does, even while the Note's own ACL still admits the person.
  `read` (queries) returns a
  generation this package started for the person in the bound Project (status,
  inputs, draft, checks, used sources, a short failure code, never the Run's
  message) and adds its inputs to the release references; it returns nothing once the
  person no longer reads the Project, an input or an input's Source. `apply` (commands)
  writes a succeeded draft through the core `knowledge.note.update` (with
  `expect_version`) or `knowledge.note.create` registration steps
  (`invokeCoreOperation`), as a document and plain text the way an editor save
  does. In the same transaction it first holds everything it decides on, in
  Knowledge's own lock order: the bound and target Projects' audiences
  (`lockProjectAudience`), the Space row (type and oversight mode), the Note roots
  (the target `FOR UPDATE`, as Knowledge's writer and the content-access share writer
  take it; the inputs `FOR SHARE`), then the members and the inputs' Sources; a
  concurrent share, grant, role or oversight change therefore commits before and is
  seen, or waits. A new Space member is covered by the Space audience fence: every
  writer that adds an active membership (invitation acceptance and invited
  registration) takes the Space row `FOR NO KEY UPDATE` first
  (`lockSpaceAudienceForChange`), which conflicts with the save's Space share lock, so
  an oversight admin who joins either joins before the save enumerates the readers or
  waits until it commits. Then it rechecks the inputs and their Sources, and an existing target must be read by no one else
  (`not_private` otherwise) and still at `expect_version` (`conflict` with the current
  version otherwise, nothing written). “Private” is the Note's actual audience under
  the content gate **including Space oversight**: no other active member reads it, and
  an owner/admin's `summary`, `content` or `full` oversight reach counts as reading, so
  a Project Note of a one-person Space qualifies, while in a Space with oversight no
  Note does. Without a target the new Note follows the ordinary creation rule for
  person content without Project context (`resolveContentCreationContext`: the
  person's Personal Space, no Project, private): it is created only when that rule
  lands in the bound Project's own Space — a Project in the person's Personal Space,
  which has no oversight — and is refused as `placement_unavailable` in a shared Space,
  because moving drafted Space content into the Personal Space would be a cross-Space
  transfer and a Project placement would share it. `read` reports this as `save_new`.
  The written Note inherits the inputs' Source lineage: Knowledge's
  `inheritNoteSourceLineage` copies their `source_item`, `source_snapshot` and
  `extracted_evidence` provenance through the canonical `writeProvenanceLinks` (no
  duplicates), each entry pinning the Source connections the text was derived under
  (the Run's frozen `source_connection_ids` and the inputs' lineage at save), so a
  later draft, read or send of that Note answers to the same Sources' readers and
  egress consent as the text it came from — even after `source.item.update` rebinds
  or clears an input item's connection. Every later body read answers to that
  lineage: Knowledge's Note detail, history and other single-Note entries
  (`getNoteRow`), the plugin Note read (`referenceReadable`), the Reader's
  `research_notebook` document and its annotations, comments and positions
  (`assertDocumentReadable`), the Project Research notebook (Area view, and the
  context `discoverNotebookChat` admits for ask-AI and notebook chat — rechecked at
  every provider attempt of a queued Run and at publication) withhold the body from a
  viewer one of its lineage Sources no longer admits
  (`sourceLineageReadable`/`sourceLineageReadableTargets`, the rule retrieval
  applies). A notebook-chat write-back inherits that lineage into the Note it writes
  and adds pinned `source_item` lineage for directly selected excerpts (as Ask-AI
  does), and an in-place edit re-pins the edited Note's own lineage; queued Runs
  check the Sources frozen with their prompt (Ask-AI's target Note included, frozen
  under the same lineage locks as its body) beside the live lineage; a monitoring comparison never uses a Note with Source lineage as its
  `understanding` baseline, at queueing, sending or merging (its outputs are
  Project-shared); see PROJECTS.md. Old data: the draft save (`noteDraftPort.ts`, added in
  `9a9e4c82`) is in no release tag (`prod-stable` = `c9bc9ec6` and every
  `prod-sha-*` tag lack it); lineage inheritance (`039a7fdf`) and pinned connections
  (`bfd578b1`) followed on the same unreleased branch. An instance built only from
  those releases therefore has no saved derived Note to backfill, and none is written
  or guessed. This is evidence from Git release history, not an inspection of any
  deployed database: an instance that ran an intermediate pre-release build of this
  branch may hold derived Notes saved without inherited lineage or without pins.
  Whether a draft was applied is the plugin's own record. The release gate rechecks each
  reference and records B11 cross-person reads, the owner's Agent read log and
  taint. Agents cannot use write ports from personal or sensitive operations. No
  core SQL or other core writer is exposed.
- Person-only operations: an operation may declare `actors: ['user']` (it joins
  the authority-contract hash). Its registration is `public_api` only with
  `allowed_actor_types: ['user']`, so it is never an Agent tool, and
  `pluginToolsetExpansion` leaves it out of every toolset. This models an act the
  person must do themselves (recording a reviewed version) as its own operation
  rather than an actor check inside an executor.
- Attribution beyond plugins: runtime-context retrieval injection and
  `RetrievalSearchService` pass the executing Run and an action id
  (`runtime_context.retrieval`, `retrieval.search`) to
  `ContentAccessAuditService`, which writes the owner's content-free Agent read
  log for same-owner rows beside B11's unchanged cross-person rows; a failed
  audit throws before release. A person's own read is never attributed to an
  Agent.
- Owner view: `plugin_data_grant.list {run_id}` returns consents bound to the
  Run and those its reads used (background; personal for a Space owner);
  `revoke_run` also revokes the owner's background consents that Run used,
  never another person's or an unused one. Run detail lists them with an
  explicit per-consent stop for background consent.
- Standing consent entry: `plugin_data_grant.list` without `run_id` also returns
  `consentable` — for each package enabled for the caller, the Space-wide
  personal consent (Space owner only) and the caller's own read-only sensitive
  `background` consent, each with the exact tools `create` would freeze
  (`pluginToolsetExpansion`), the composed package identity they were expanded
  from (`authority_hash`, the hash a grant pins), default expiry, the active
  grant and the diff from that key's latest grant. An option is never a grant;
  `create` reapplies every rule and requires the confirmed option's
  `authority_hash`: when it differs from the running composition (an upgrade
  changed the package) the write is refused with 409 and the person must
  refresh and confirm again — the client never supplies a tool list, and the
  identity check, expansion and pinned hash read the same immutable composed
  facts. Per-Run sensitive consent stays with the Run's authorization request.
  Settings (`PluginDataConsentPanel`) offers options for the current Space,
  allowing after a confirmation naming scope, owner, tools and expiry, and
  lists the person's active Space-wide and background grants on their own,
  each with the tools, version and scope it froze (not the current package's)
  and a revoke action. A disabled, removed or upgraded plugin offers no option
  but its grants stay listed and revocable (revocation never needs the plugin
  enabled); a revoked grant is never revived by re-enabling.
- Context push: `include_in_context` / `can_contribute_context` have no consumer
  (operation descriptors declare `never`); this was audited as an interface and
  no push port exists.
- Acceptance: `server/test/pluginDataAccessDb.test.ts`,
  `pluginCorePortsDb.test.ts`, `runtimeContextPlanner.test.ts` (coordinator
  attribution); UI `RunPluginDataPanel`, `PluginDataConsentPanel`, Run-control
  approver rule, `apps/web/src/__tests__/plugin-data-access.browser.mjs` and
  `plugin-data-consent.browser.mjs`; real namespace
  `packages/host-daemon/test/networkNamespace.acceptance.mjs`.

### Offline installation and restore

`plugins/operationMigrations.ts` owns the explicit offline transaction. Packages
from the compiled image are ordered by dependency, reject missing dependencies,
and must list exactly their generated migrations. Installed legacy IDs are
excluded from this path: their applied public migrations are not rewritten or
moved. Only an explicit later migration/inventory may change those packages.

A nonwaiting session advisory lock protects the full install/failure-journal
window; DDL also takes the matching transaction lock with bounded `lock_timeout`.
Generated statements execute under the schema's DDL role, never runtime or host
role. Applied checksums are immutable. Before entering the DDL role, the host
sets the transaction-local `rainver.previous_migration_applied_at` to the
immediately preceding migration's applied timestamp for that package (empty
for the first migration). The DDL role gets no access to the core journal.
`installing → migrated → installed` is
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
COMMIT/pool/session controls. Host-owned nested savepoints remain compatible. Canonical Proposal decisions
may nest bounded ports; the trusted plugin host resolves those active ports
to the same owning transaction before changing roles. The plugin never
receives that host client.
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
and request result. A package may register a proposal `preconditions` reader
(`lifecycle.proposals.register(id, apply, {preconditions})`): run as the
requester under the plugin role, its output is frozen with the request beside
the manifest version and re-read on approval, and a different value supersedes
the Proposal rather than apply a stale decision. The reader receives
`propose` or `approve` as its third argument. Use `propose` for new-request
validation and return the live snapshot during `approve` even when that state
would block a new proposal. The applier still validates the actual effect.
A superseded approval (changed
preconditions or mapping) is a committed decision through the canonical accept
path, not a missing Proposal: the accept returns the Proposal as `superseded` with
`result_type: operation_failure` (`operation_approval_superseded`), the linked
request becomes `superseded` (its retry replays that refusal), an accept retry
with the same key replays the receipt, and nothing is applied. An accept that is
the first to find its linked request expired likewise commits that `expired`
state rather than rolling it back behind a 404: it returns the still-`pending`
(expired) Proposal with `operation_failure` (`operation_approval_expired`), the
same key replays that receipt, a new accept is 404, and nothing is applied;
unexpired unlinked Proposals keep their normal accept, and an expired unlinked one
is refused by canonical apply (409 `operation_approval_expired`, nothing written,
see [Proposals](PROPOSALS.md)). Retention
(`pruneOperationRequests`) later deletes the terminal request; a decision under a
new key then finds no request, and the Proposal's durable origin marker
`operation_request_linked` refuses both accept and reject (404) in
`beforeDecision` — the frozen version, preconditions and requester are gone, so
nothing reaches the applier. An action-grant auto-accept refuses a marked
Proposal too. Unmarked (legacy) Proposals decide normally.
Every decision entry reads the same outcome
(`apps/web/src/modules/memory/acceptOutcome.ts`): Proposal detail, list, Today
and the Room approval card read `operation_failure` as “not applied”
(superseded/expired/other) and never as accepted, on replay too; a pending but
expired Proposal (`decisionOpen`) offers no Accept/Reject, the card shows it as
expired, and a refused decision re-reads the live state instead of leaving stale
buttons. The card continues the conversation only after a decision that took
effect. `proposal.decide` neither lists an expired Proposal (linked or not) in
`proposal.list_pending` nor decides it, reports an `operation_failure`
accept as not applied rather than `accepted`, and returns a continuation
only when the Proposal's committed status is the requested decision. It is a
legacy Room tool, not on the core Agent result adapter: a refusal is an HTTP 200
receipt `{ok: false, tool: 'proposal.decide', error_code: 'system_action_failed',
error}` whose `error` names the reason (expired, superseded, already decided),
never an HTTP error status; the Room
card projection does not offer an expired Proposal. Plugin SQL runs under its runtime role, restored before
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
| `diary` | `user` | `/plugins/diary/journal` (manifest `navigation` entry) | none (P1 actions/queries only) | Operations (all `sensitive`), one append proposal type, the reflection Job | Plugin-owned entries/reflections in `plugin_diary`, keyed by person only (user-level across Spaces); see [Diary package](#diary-package) |
| `finance_ledger` | `space` | `/plugins/finance_ledger/ledger` (manifest navigation) | none (P1 actions/queries only) | Operations and two posting proposal types | Space ledger in `plugin_finance_ledger`; see [Finance ledger package](#finance-ledger-package) |
| `applications` | `space`, Project-level | Project Area `/projects/:id/plugins/applications/board` and Pulse card | none (P1 actions/queries only) | Operations, one proposal type, core ports `tasks.create`/`references.resolve`/`notes.read`/`notes.draft` | Plugin-owned application records in `plugin_applications`, keyed by Space, person and Project; see [Application management package](#application-management-package) |

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
| `server/src/modules/plugins/packageLoader.ts` | Loads compiled official plugin package artifacts: before any import it admits only directories named by a registry descriptor or, for operation packages, by the build index `packages.json` that `build-official-plugins.mjs` writes for the packages it compiled (only ids in its `operation_packages`, the category that build observed; an older index without that list admits nothing by itself, and a descriptor package is unaffected); a package manifest never admits itself, its id must equal its directory, and its `server.main` must resolve (after symlinks) inside its own package |
| `server/src/modules/plugins/host/` | PluginHost and host context/ports |
| `server/src/modules/plugins/repository.ts` | DB access for install, migration, enablement, and event rows |
| `server/src/modules/plugins/service.ts` | Business logic: list, enable, disable, settings patch |
| `server/src/modules/plugins/installer.ts` | Legacy public-table installer (manifest packages refused) |
| `server/src/modules/plugins/operationMigrations.ts` | Offline operation-package migration/failure journal |
| `server/src/modules/plugins/roleReconcile.ts` | Offline schema owners/role/ACL recovery |
| `server/src/modules/plugins/projectBindings.ts` | Project bindings: the per-entry host Project gate, bind/unbind writer and list read |
| `server/src/modules/plugins/projectBindingOperations.ts` | `official_plugin.project_binding.*` P1 registrations |
| `server/src/modules/plugins/lifecycle.ts` | Scoped enable/disable, durable scope holds, owner lease, release rounds and the cleanup read |
| `server/src/modules/plugins/effectScopes.ts` | Per-hold local resource tracking (late registration, entered Jobs, bounded drains) |
| `server/src/modules/plugins/background.ts` | Canonical Job handlers, scoped resource ports |
| `server/src/modules/plugins/schedules.ts` | Canonical scheduler scope fanout |
| `server/src/modules/plugins/proposalContributions.ts` | Canonical proposal schemas/applier wrappers |
| `server/src/modules/plugins/routes.ts` | HTTP routes: GET/POST/PATCH /api/v1/plugins/* |
| `server/src/modules/plugins/guards.ts` | `requireOfficialPluginEnabled()` reusable guard |
| `server/src/modules/plugins/index.ts` | Module facade: exports pluginsModule + guard |
| `plugins/official/diary/` | Diary operation package: `operationManifest.ts`, `schema.ts` + `drizzle.config.ts`, migrations, `server/src/index.ts`, `web/src/operationViews.tsx` (the editor page over `opsApi.ts`) |
| `plugins/official/finance_ledger/` | Bundled finance ledger plugin package source, manifest, server runtime, web page, and migrations |
| `plugins/official/applications/` | Application management package: `operationManifest.ts`, `domain.ts`, `schema.ts` + `drizzle.config.ts`, migrations, `server/src/index.ts`, `web/src/operationViews.tsx` |
| `server/dist/official-plugins/diary/` | diary build output loaded by the server at startup |
| `server/dist/official-plugins/finance_ledger/` | finance_ledger build output loaded by the server at startup |
| `server/migrations/0000_baseline.sql` | DB migration — plugin control-plane and install tracking only |
| `apps/web/src/api/client.ts` | Frontend API client |
| `apps/web/src/modules/plugins/useEffectivePlugins.ts` | Plugin state hook |
| `apps/web/src/modules/plugins/useProjectPluginBindings.ts` | One Project's binding state for navigation, slots and the settings card |
| `apps/web/src/modules/plugins/ProjectPluginBindingsCard.tsx` | Project settings card: binding status and owner-level Bind/Unbind |
| `apps/web/src/modules/plugins/PluginsPage.tsx` | Official plugins management page |
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
Diary and Finance use this convention since Plan 7.

`PluginViewContext<UI>` is browser-neutral protocol: only `spaceId`, nullable
`projectId`, `ops`, and `ui`. UI packages describe the structural controls they
need without importing app/server implementation. The host supplies shared
Button/Input/Textarea/Select/Badge/Card, `t(key, options)`, `formatDay` for
calendar days and translated state copy, plus a normal link to the existing
canonical Proposal review page. Scoped ops accept only declared IDs of the
matching command/query kind, validate input/output against the local manifest,
use the canonical actions/queries HTTP client, bind Space, and require an explicit
command key. They expose neither raw request/config/actor nor DB ports and never
automatically retry writes. A Project slot also rechecks its Project read gate
before a UI invocation. The Project ID is view context, not a new domain grant:
Project-owned operations must still declare/authorize their Project targets;
the fixture's records are intentionally Space/person-owned.

Bundled package sources live outside `apps/web`: `apps/web/bundledPluginDeps.ts`
aliases `zod` (in both Vite and Vitest configs) to the copy `@rainver/protocol`
uses, so manifests share the app's zod instance, and `index.css` adds
`@source` for `plugins/official/*/web/src`, so classes used only by a package
view are generated. Project navigation entries and Project slots are each
wrapped in an error boundary that renders nothing on failure, so a plugin
contribution cannot take the core Project navigation or Pulse down.

PluginSlot owns initial loading, disabled/withheld, transport/bundle mismatch
error/retry, and component-error fallback. It does not show raw exception bodies.
Account/Space/Project/placement changes remount the scope; old ports expire and
requests abort, with generation/session fences rejecting late results. Current
membership/enablement is rechecked by P1 on every call/replay. Background refresh
keeps an enabled same-scope frame stable, while a denial/error immediately removes
its content; focus and periodic checks revalidate metadata. Logout residue cleanup
also invalidates the port. These controls prevent trusted-code mistakes; same-
process browser/plugin code is not a malicious sandbox.

## Project binding

Implemented 2026-11-18 as the first stage of the Project-level application
plugin work ([P3](../plans/operation-core/03-phd-application-plugin.md)). The
first bundled package declaring it is the
[Application management package](#application-management-package). It adds a
Project layer on top of install and enablement; it does not replace either.

**Manifest contract.** `project_binding: 'required'` marks a Project-level
package. Validation then requires every operation's input to be an object schema
whose `project_id` key is required and not nullable (optional, nullable and
defaulted keys are refused, so an input cannot arrive without its target), refuses Jobs and schedules (Project-scoped holds and
cleanup do not exist; a Space/user Job would outlive an unbind), and refuses the
`navigation` web placement (entries live inside a Project). The declaration
joins the authority-contract hash only when present, so earlier packages keep
their admitted hash. The descriptor carries `project_binding` for the web.

**Binding state.** `official_plugin_project_bindings` (migration 0029) holds
one row per (package, Project): `bound` or `unbound`, who/when for each, FK to
the Space and Project. `plugins/projectBindings.ts` is the only writer; bind and
unbind also append `project_bound` / `project_unbound` to `official_plugin_events`,
only for a real change: concurrent first binds meet at the unique key
(`ON CONFLICT … WHERE status<>'bound'`), and only the one that changes the row
records the event; the other returns the committed binding.

| Operation | Who | Behaviour |
| --- | --- | --- |
| `official_plugin.project_binding.list` (query) | Project reader or Project owner level | Every composed Project-level package with its status (`bound` / `unbound` / `available`), `plugin_enabled` and `effective` for this person (enabled ∧ bound ∧ Project readable), plus `can_manage` |
| `official_plugin.project_binding.bind` | Project owner level (owner, owner member, Space owner/admin) | Package must be Project-level and currently enabled for the person (else 409), the Project active (else 409); idempotent when already bound; rebinding reuses the row |
| `official_plugin.project_binding.unbind` | Project owner level | Allowed while the package is disabled or the Project archived, since it only narrows reach; keeps every plugin-owned row; idempotent |

All three are person-only P1 operations (`public_api`, `user`), policy actions
`official_plugin.project_binding.view` / `.manage`. A Project writer that is not
owner level cannot bind: binding is Project configuration. `authorize` applies
the same gate (list: reader or owner level; bind/unbind: owner level), so a
stored receipt replays only for someone who still passes it.

**Space owner/admin outside the Project.** Plugin data in a Project is
Project-private content and follows the `project_members` ACL, as core Project
content does; the binding is configuration. A Space owner/admin who is not in
the Project is owner level for that configuration: they list, bind and unbind
(the card offers the buttons and says they cannot open the data), but
`effective` is false for them, and every plugin query and command, fresh or
replayed, is not found before plugin code runs. Once they read the Project
(any Project role), their Space role makes them a Project writer, as
`canWriteProject` does for core content.

**Host gate on every entry.** For a Project-level package the operation
registration (`operationRegistry.ts`) resolves `project_id` from the input into
the authority scope and targets, and `assertPluginProjectTarget` runs in
`authorize` after the existing enablement check, before plugin code:

- An Agent reaches only its Run's Project (and its Agent's access Project when
  set). A Run without a Project, or another Project even if bound and readable,
  is not found.
- The person (the actor, or the Agent's instructing person) must read the
  Project for a query, and read and write the active Project for a command
  (archived: 409 for writes, reads continue).
- The binding must be `bound`, share-locked for commands.

Because P1 reruns `authorize` for an idempotent replay and for a proposal's
apply (`beforeApply`), a stored receipt is not released and a pending plugin
proposal does not apply after an unbind; rebinding lets the same proposal apply.
The `proposal.accept` receipt carries the plugin result too, so the
registration's `authorizeApprovedResult` gates it: on the decision the reviewer
must read the Project, and every replay of that accept receipt
(`authorizeAcceptReplay` decision hook) also rechecks the frozen requester's
enablement and Project target and the binding (`FOR SHARE`); an unbind or a lost
Project read withholds it, a rebind releases it again. Operation retention
(`pruneOperationRequests`) can delete the original request before the accept
receipt; without its frozen requester the gate cannot be rechecked, so the
replay is refused with `operation_result_unavailable` (410) when the Proposal
carries the durable origin marker `proposals.operation_request_linked` (set when
the approval request is recorded; migration `0028` backfills it from retained
requests and from the `{proposal_type,input,requester}` payload only
`approval.create` writes), when the receipt is an `operation_failure`, or when the
Proposal type is still an approval-mapped registration. `result_type` alone is
not origin evidence: legacy host appliers (`ctx.proposals.register`) may also
return `plugin_proposal`, and unlinked receipts keep their ordinary replay.
`PgProposalApplyService.fromConfig` installs these decision hooks even when no
operation package is registered, so after an uninstall — including when an
independent legacy applier still handles the same Proposal type — the assembled
`proposal.accept` replay still consults the marker and refuses (410). Without
such an applier, the earlier `operation_accept_authorize` apply policy
(unregistered Proposal type) or `proposal.accept`'s own authorization may refuse
the replay first.
The release gate rechecks the binding (share lock) and Project read access
before any result body leaves, after the existing ADR 0030 release, so an unbind
committed between execution and release withholds the body. A shared personal
read is executed per reader only when every reader reads the Project, and its
release rechecks every reader of the recorded audience live under
`lockProjectAudience` (`assertPluginProjectAudience`): a membership change
either commits first and the body is withheld, or waits for the release. Typed core ports of a
Project-level operation accept only that operation's `project_id`; a mismatch
is not found and rolls the whole command back.

Lock order: plugin installs → enablements → Project authority rows → binding
row. A command takes the Project row `FOR UPDATE` first, the canonical
aggregate write fence (`lockActiveProjectForMutation`, which the Task and
Artifact core write ports also take), then its authority rows `FOR SHARE`; no
command holds the Project `FOR SHARE` and upgrades it later, which deadlocked
two concurrent commands using a core write port. Bind/unbind take the Project
and authority rows `FOR SHARE` and the binding `FOR UPDATE`; operations,
replays, proposal apply and release take the binding `FOR SHARE`, so an unbind
either commits first and they refuse, or waits for them.

**Effective state and retention.** Effective = installed contract ∧ enabled for
this person's scope (and dependencies) ∧ binding `bound` ∧ Project access.
Disabling the package stops every bound Project and keeps the bindings;
re-enabling restores them. Unbinding one Project stops only that Project; other
Projects keep working. Neither deletes plugin data; a hard-deleted Project
cascades its binding rows. A user-scope Project-level package is effective
only for members who enabled it themselves.

**Web.** `useProjectPluginBindings` reads the list query for the current
Project (only when a bundled package is Project-level; otherwise no hook mounts
and no request is made). Project Area navigation and overview slots show a
Project-level package only when `effective`; other operation packages keep
their enablement rule. `PluginSlot` checks the binding before loading a
Project-level view and refuses it outside a Project; a slot mounted on its own
(a Project plugin route) also rereads on the binding-change announcement for
its Project, so an unbind in the same tab closes it at once, not on the next poll. Project settings show
`ProjectPluginBindingsCard`: status for every reader, Bind/Unbind for owner
level, each a keyed `callOperation`; bindings are read again after a change.

**Ownership.** Project-level plugin rows must key their data by the
host-authorized `project_id` from the input (and keep `caller_owned` Space/person
filters). The binding is not a Project content ACL: who may read or write is the
Project's existing gate; the binding only decides whether the package reaches
the Project. Core objects stay with their owners through typed ports.

**Not in this stage.** No default landing Area,
Project-scoped Jobs/schedules/holds, Project-archive hooks beyond the write
refusal, cross-Project aggregate views, a Project-scoped DB GUC, or Agent tool
catalog filtering by binding (an unbound tool call is refused at call time).

Evidence: `server/test/pluginProjectBindingDb.test.ts` (real PG; HTTP and Agent
tool entries: owner-level bind, ACL per entry, other Space, unbind one of two
Projects with replay refusal and retention, disable/re-enable, archived Project,
Agent Run Project scope, core-port confinement, pending proposal after unbind,
concurrent first binds with one event, concurrent core-port commands without
deadlock, a Space admin outside the Project with bind-receipt replay,
`proposal.accept` receipt replay across unbind/rebind/lost read and after the
original request is pruned, shared-audience
release recheck blocking a membership change), protocol
`pluginOperations.test.ts` (manifest rules incl. optional/nullable `project_id`),
web `modules/plugins/__tests__/ProjectPluginBinding.test.tsx` (navigation, slot,
independent slot on a binding change, settings card incl. the admin hint).

## Application management package

Implemented 2026-11-18 as stage 2 of
[P3](../plans/operation-core/03-phd-application-plugin.md): the first bundled
Project-level operation package, `plugins/official/applications/` (id
`applications`, "Application management"). PhD application (one program at one
institution) is its first *track* and `funding` (a scholarship, studentship or
grant) its second (`domain.ts`: `APPLICATION_TRACKS`, `TRACK_CONFIG`,
`FUNDING_SUBMISSIONS`); both use the same records and operations, and a later
job track adds a configuration entry the same way. It is disabled by default.
The four-area revision (programs by institution, funding, material library,
contacts tab; below) was implemented 2026-11-18 and is privately saved, not deployed.

**Package.** Space-scope enablement, `project_binding: 'required'`,
`data_access: 'caller_owned'`, `permissions.agent: true`, no Jobs or schedules,
core ports `tasks.create`, `references.resolve`, `notes.read` and `notes.draft`. The browser-safe
declaration (`operationManifest.ts`, with `domain.ts`) is shared by the server
runtime (`server/src/index.ts`, compiled to
`dist/official-plugins/applications/server/src/index.js`, its `plugin.json`
`server.main`) and the bundled views (`web/src/operationViews.tsx`). Schema
`plugin_applications` is authored in `schema.ts` and generated by drizzle-kit
(command in [COMMANDS](../COMMANDS.md)); `migrations/0000_application_records.sql`
creates `applications`, `application_deadlines`, `application_materials`,
`application_contacts` and `application_contact_events`;
`0001_material_notes.sql` adds `application_materials.note_id`,
`application_material_reviews` and `application_material_sources`;
`0002_material_generations.sql` adds `application_material_generations`;
`0003_funding_library_contact_links.sql` adds `applications.submission`,
`application_funding_links`, `application_library_items` and
`application_contact_links`, copies every existing `application_contacts.application_id`
binding into one link row (Project-level contacts get none) and then drops that
column, in the installer's single migration transaction.
`0004_submission_recorded.sql` adds the submission history guard and
`0005_narrow_submission_history.sql` corrects the legacy backfill.
Every table's key is
(Space, person, Project, id); child rows reference their parent with that
whole key, so a deadline, material or event cannot leave its owner's
application/contact. Core objects (Projects, Tasks, Artifacts) are referenced
by id only: the plugin role cannot reference core tables.

**Ownership.** Each statement filters `rainver.space_id`, `rainver.user_id` and
the host-authorized `project_id`. Records are the person's own inside the
Project: another Project member (any role) neither reads nor changes them, a
viewer cannot write (Project write gate), and nothing reads across persons, so
no B11 adapter is needed. Sharing records between members would first need a
canonical B11 cross-person adapter. An Agent Run another person can also read
(a multi-person Room, selected users, a Space-shared Run) receives every query
only as the readable intersection of each reader's own result (see
[Agent data access](#agent-data-access-adr-0030)): its list shows only rows
every reader has, which for per-person records is none, and `get`/`summary`
are withheld unless identical; the release gate rechecks that audience and each
reader's Project read.

**Operations** (`plugin.applications.<entity>.<verb>`, every input carries a
required `project_id`):

| Entity / class | Queries | Commands |
| --- | --- | --- |
| `application`, `non_sensitive` | `list` (optional `track` filter; next deadline, deadline count, checklist done/total, `submission`, `funding_ids` / `applies_to`; archived only on request), `get` (deadlines, checklist with resolved references, and the linked records on the other side as list rows: `funding` for a program application, `applies_to` for a funding record), `summary` (program applications: counts by status, open count, open checklist totals; `funding` total/open; next five deadlines of either track with `track`) | `create` (track `phd` or `funding`; institution — the funder for funding — program — the funding name — department, intake, notes, opportunity source label/http(s) URL, any number of deadlines, `create_tasks`, `checklist: track_default|empty`; funding only: required `submission: separate|automatic` and optional `applies_to` program applications), `update` (needs the current `revision`; archive/restore; a funding record's `submission`), `update_status` (reversible progress and external results: planning … interview, offer, waitlisted, rejected), `propose_status` (proposal, `gate_class: direction`: submitted, accepted, declined, withdrawn) |
| `funding` (exempt: funding records are `application` rows of track `funding`, read with `application.list`/`get`) | — | `link`, `unlink` (`funding_id`, `application_id`) |
| `deadline`, `non_sensitive` (read through `application.get`) | — | `add` (optional `create_task`), `update`, `remove` |
| `material`, `non_sensitive` (read through `application.get`) | `read_note` (one revision of a Note this material links, reviewed or draws on; see [Materials in Notes](#materials-in-notes)), `get_generation` (person-only draft preview; see [Generated drafts](#generated-drafts)) | `add`, `update` (status, label, required, reference to an `artifact` or `task`), `remove`, `link_note`, `add_source`, `remove_source`, `mark_reviewed`, `generate`, `apply_generation` (the last three person-only) |
| `library`, `non_sensitive` | `list` (each entry's Note title/current version through `notes.read` and every material that uses the Note; see [Material library](#material-library)) | `add`, `update` (kind, label), `remove` |
| `contact`, entity floor `personal` | `list` (`application_ids`, latest event and count; optional `application_id` filter), `list_events` | `create` and `update` (`application_ids`: any number of applications of either track; `update` replaces the set), `log_event` (a contact that already happened; nothing is sent) |

Classes follow the P4 mapping: application records are the normal class;
third-party contact details and communication history are `personal` (ADR
0030), so an Agent reads them only with the Space owner's personal consent and
never writes them (personal writes are proposal-only; no contact proposal
exists). An Agent reaches these tools through the Runs Rainver creates in a
Project — a direct chat, a Room message, its delegated child and a Task
dispatched to a Workspace Location on the built-in or a paired Host declare
`PROJECT_APPLICATIONS_TOOL_ALLOWANCE` (`systemActions/scenarioToolAllowance.ts`,
the package's Agent-eligible operations named one by one, not a plugin
wildcard), and each entry builds the Run's snapshot with the server
configuration that registers the package; a Run without a Project declares
none, and a Task with no Workspace Location declares no capabilities at all, so
it gets no Rainver tool
([SYSTEM_ACTIONS](SYSTEM_ACTIONS.md#scenario-tool-allowances)). Records are
always the instructing person's own in the Run's bound Project. Who reads a
Run's output is its live audience (`runAudience`): a private direct chat only
that person; a Room turn and its delegated child the Room's audience (a mainline
Room is every Project reader); a Task Run is private, or every active Space
member when the dispatched Agent is Space-shared. When that audience includes
anyone besides the instructing person, the package being `caller_owned`, every
query is released only as the rows each current reader reads themselves
(intersected per reader, so in practice none of one person's records), while
commands still act on the instructing person's records; contacts stay
owner-only. Writes on an archived application are refused, including its details
(`application.update` with any field besides `archived`, even together with a
restore; restoring alone is allowed) and new links to it: `contact.create` or
`contact.update` adding it, and `funding.link` or a funding `create` naming it,
return `application_archived`. A contact whose every linked application is
archived is read-only (`contact.update` leaving it so and `contact.log_event`
return `application_archived`); replacing its links so that it is Project-level
(`application_ids: []`) or involves an active application is allowed, and a kept
archived link may stay beside an active one. Contact writers lock every current
and target application row (id order) before the contact row and refuse with
`revision_conflict` when the links changed between the read and the locks. A
Project-level contact belongs to no application and is listed by `contact.list`
without `application_id`. Removing a link never removes the contact or its events.
A final decision (accepted, declined, withdrawn) is not changed by
`update_status`, only by another approved decision. Each `propose_status`
Proposal freezes the application's `revision` at submission (the package's
proposal `preconditions` reader) and re-reads it on approval: any change in
between, including another approved decision, supersedes the older Proposal
instead of applying it (the older Proposal is committed as `superseded`).

<a id="funding-records"></a>
**Funding records.** A scholarship or grant is an `applications` row of track
`funding`, so a separately submitted one reuses deadlines, the checklist
(`TRACK_CONFIG.funding`: CV, statement, optional reference), Notes links,
reviews, drafts, progress, archive and the `propose_status` decision exactly as
a program application. `submission` says how it is decided: `separate` (its own
submission) or `automatic` (considered with the program application): an
automatic record is created without a checklist, `material.add` is refused
(`no_submission`), and a `submitted` decision is refused before any Proposal
exists (the decision `preconditions` reader) and again on apply; switching an
existing record to `automatic` needs an empty checklist (`checklist_not_empty`)
and no confirmed or conservatively inferred submission (`submission_recorded`).
When a `submitted` decision applies, the applier fills
`applications.submission_recorded_at` if it is empty. Later progress and
decisions preserve any existing marker, including a legacy backfill. The switch and approval both lock the application row. If the
switch takes effect first, the next standard accept compares the new revision
with the frozen one, commits the old Proposal and linked request as
`superseded`, and returns the usual HTTP 200 `operation_failure` receipt
(`operation_approval_superseded`). No submission or result note is written.
If approval applies first, a switch at the old revision sees
`revision_conflict`, and a switch at the current revision sees
`submission_recorded`. The check constraint
`applications_submitted_not_automatic` protects the database invariant.
Only funding has a mode (`funding_only`, `submission_required` on create).

The original 0004 remains checksum-identical. Migration 0005 removes its
marker when the revision is at most 2 and the current status differs from
`submitted`. A record starts at `planning`, revision 1, and an approved
submission followed by any other status takes at least two writes. For
funding records created before 0004, a current `submitted` status confirms
submission. A different status at revision 3 or later leaves enough writes
for submission and another status, including a return to preparation.
Ordinary edits also advance the revision, so these rows may be conservatively
locked even if they only received edits. The backfill uses the row's
`updated_at` as a guard timestamp and cannot supply the actual submission
time. It preserves automatic records as-is, including any older submission
history their current rows can no longer establish. Records created after
0004 use their actual recorded marker. The backfill reads only plugin-owned
rows and the prior migration timestamp supplied by the installer, without
access to core Proposals.

`application_funding_links` (Space, person, Project, funding, application; both
composite foreign keys to `applications`, cascade) links one funding record to
zero or more program applications and one application to any number of funding
records: `create` with `applies_to` or `funding.link` (both records active, the
funding side of track `funding` — `not_funding` — and the other a program
application — `not_program_application`; at most 50 per side, `link_limit`;
linking again is a no-op). Both entries share one lock and capacity path
(`lockFundingLink` then `insertFundingLinks`): the program applications are locked
in id order (with the funding record for `funding.link`) before the links are
inserted and both ends counted, so a new linked record and a concurrent
`funding.link` cannot together exceed the limit and a refused create keeps nothing; `funding.unlink` (the funding record active; it may be
moved off an archived application; `link_not_found`). Both records' revisions
are bumped on a change; the two rows are locked in id order like every
multi-application writer. Records of another person or Project are
`application_not_found`.

<a id="material-library"></a>
**Material library.** `application_library_items` registers the person's reusable
material Notes in this Project (master CV, experience, research, publications,
statement material, other): a Note id, kind and optional label, unique per Note
(`library_note_exists`, at most 200, `library_limit`). `library.add` admits only a
Note `notes.verify` accepts (active, every reader reads it, its closure inside the
bound Project or Project-free; `note_unavailable` otherwise) and never changes it.
`library.list` resolves each Note's title and current version through `notes.read`
(unavailable Notes show no title) and lists every material of the person in this
Project that uses it — as a pinned source (`relation: source`, the pinned version)
or as its own text (`relation: linked`, the newest reviewed version or none) —
with the application's track, names and archive state and `updated` when the Note
is newer than that version. Tailored materials stay in their application (a
funding record's included); removing a library entry (`library_item_not_found`
when absent) leaves the Note and every pin. No Note text is read or copied.

**Core boundaries.** A deadline becomes a to-do only through `tasks.create`
(the Project Board stays the progress truth, ADR 0027); the deadline keeps the
Task id, and editing or removing the deadline never changes the Task. A material
reference is stored as `{type, id}` only after `references.verify` confirms the
object exists, every current reader reads it and it belongs to this Project
(else `reference_unavailable`). The command already holds its bound Project, so
a reference whose read closure reaches another Project is refused before any
other Project's lock (crossed saves between two Projects cannot form a lock
cycle). The release's own discovery is confined to the bound Project
(`confineProjects` of `lockSourceRetrievalReleaseBatch`): it refuses with 409
before taking any lock, so an unplaced Task moved into another Project by an
ordinary `task.update` between discoveries is refused, never waited on; a move
after locking fails the release's final closure comparison. A same-Project
reference is then verified on its pinned closure. It is resolved on `get` through
`references.resolve` with the same Project condition, so a title appears only
when every reader may still read the object in this Project; one that became
unreadable or moved shows as unavailable, and the release gate rechecks it. Notes are reached only through
the `notes.read` port (below). Relations people and organization records are
not used yet (Relations person creation is user-only and organizations have no
port).

<a id="materials-in-notes"></a>
**Materials in Notes.** A material's text (CV, statement, research proposal)
lives in Notes, which keeps its body, history, editor and conflict checks; the
package stores only Note ids and version numbers, and no Notes write exists.

- `material.link_note` sets (or, with `note_id: null`, clears) the material's
  own Note after `notes.verify`; its output carries the current version only.
- `material.add_source` records a Note the material draws on (master CV,
  experience, supervisor facts), pinned to a given existing version or the
  current one; adding the same Note again re-pins it. At most 20 per material
  (`source_limit`). `material.remove_source` deletes only the reference.
- `material.mark_reviewed` (`actors: ['user']`, never an Agent tool) appends a
  review of an existing version of the linked Note; the request names the Note and
  version the person saw (`note_id`, `note_version`), and a material relinked since
  (another tab or device) is refused as `note_relinked` rather than recorded against
  the new Note. The same (Note, version) is recorded once. Reviews are append-only and keep their own Note id, so they
  survive later edits, regeneration and relinking the material to another Note;
  a revision is immutable, so a review always reads exactly the reviewed text.
- `application.get` lists each material's `note`, `reviews` (newest first) and
  `sources` (with `updated` when the Note has a newer version than pinned).
  Titles and current versions come through `notes.read` for every current
  reader; a Note that became unreadable, trashed or reaches another Project
  shows `available: false` with no title.
- `material.read_note` returns one revision's text, only for a Note this
  material links, reviewed or draws on (`note_not_linked` otherwise), through
  `notes.read` (`note_unavailable` when the gate refuses or the version is
  missing). An Agent in a Run another person also reads gets no private Note.

Writes are refused on an archived application like other material writes.
Removing a material deletes its reviews, sources and generation records (cascade)
but never a Note or a Run.

<a id="generated-drafts"></a>
**Generated drafts.** A person drafts a material's text from its pinned sources
through `notes.draft`; nothing is written to Notes until they save a draft they
previewed. All three operations are person-only (`actors: ['user']`).

- `material.generate` takes this application's requirements (institution or
  person, at most 4000 characters), optional target length and emphasis, which of
  the material's pinned sources to use (default all, each at its pinned version)
  and whether to include the linked Note's current version to revise (default when
  one is linked; a pinned source of the same Note then yields to that current version,
  so the model sees exactly the version a save to it is checked against), plus an
  optional provider/model. The request text the host
  freezes names the institution, program and material, never Note content. It
  records a generation row (requirements, the linked Note and its version then)
  for the Run `notes.draft` queued. Refusals: `no_inputs`, `source_not_found`,
  `note_not_linked`, `note_unavailable` (an input no longer qualifies),
  `note_egress_denied` (an input may not go to the provider: Source consent or the
  Space's external switch), `generation_busy`, `provider_unavailable`.
- `material.get_generation` previews one generation: the Run's status, the draft,
  the statements to check (`verify`), every pinned input with its version,
  whether the model reports using it and whether the Note has a newer version
  since, the base Note with `changed` when it was edited after the draft
  started, the applied Note version and `save_new` (whether a new Note can be
  created here). Another Project member (records are per person), a Space
  oversight admin and any Agent get nothing, here or through the generic Run entries;
  neither does the person once they lose an input Note, its Project or one of its Sources.
- `material.apply_generation` saves a succeeded draft once (`generation_applied`
  afterwards): `target: 'linked'` writes the next version of the Note the material
  linked when the draft started, only if the material still links it and it is
  still at that version (`note_changed` otherwise: a concurrent edit wins and
  nothing is written) and only into a Note no one else in the Space reads
  or can read through Space oversight (`note_not_private`); `target: 'new'` creates a
  Project-free private Note titled “<material> — <institution>” (or the given title)
  and links the material to it, only where the creation rule keeps it in this Space
  (`note_placement_unavailable` in a shared Space). The Note it writes inherits the
  inputs' Source lineage, so drafting from it later needs the same Source consent
  (`note_egress_denied` once a Source withdraws it), and its body and history stay
  unreadable to anyone a lineage Source no longer admits, even after the Source item
  is rebound. A share or oversight change that races the save, or an oversight admin
  who joins the Space meanwhile, is decided under the Note and Space locks
  (`note_not_private`, or the join waits for the save).
  `generation_not_ready` until the Run succeeded. The Note keeps its history; the
  person edits it in the Notes editor and confirms a version with
  `material.mark_reviewed` as before.
- `application.get` lists each material's five newest generations (requirements,
  time, applied Note version) beside its Note, reviews and sources.

The same pinned source can serve two applications: each material keeps its own
requirements, Runs, Note and reviews, and the source Note is only read.

**Refusals.** Plugin code throws `PluginOperationRefusal(kind, reason)` from
`@rainver/protocol`; the registration's `classifyError` maps `conflict` to
`operation_conflict` (409) and `invalid` to `operation_invalid_input` (422),
with `{reason}` as metadata and the reason code as message, recognised by shape
so a separately compiled package matches. Reasons: `application_not_found`,
`application_archived`, `revision_conflict`, `status_decided`,
`deadline_not_found`, `material_not_found`, `contact_not_found`,
`reference_unavailable`, `note_unavailable`, `note_not_linked`,
`source_not_found`, `source_limit`, `no_inputs`, `generation_not_found`,
`generation_busy`, `provider_unavailable`, `generation_not_ready`,
`generation_applied`, `note_changed`, `note_not_private`, `note_relinked`,
`note_egress_denied`, `note_placement_unavailable`, `submission_required`,
`funding_only`, `not_funding`, `not_program_application`, `link_not_found`,
`link_limit`, `no_submission`, `checklist_not_empty`, `library_note_exists`,
`library_limit`, `library_item_not_found`. Any other
throw stays an internal error. The views translate reasons; they never show
server text.

**Web.** Entries `board` (`project.area`, Project navigation “Applications” /
“申请”; still the one Project entry) and `summary` (`project.overview.card`, after
the Project goal; adds the open funding count and funding deadlines). The board
has four tabs through the host's shared Radix tabs (`ui.Tabs`/`TabsList`/
`TabsTrigger`/`TabsContent`, added to the plugin UI kit in `slotTypes.ts` /
`PluginSlot.tsx`): **Programs** / 院校申请 (default; `operationViews.tsx`), program
applications grouped under an institution heading, each program its own card;
**Scholarships & funding** / 奖学金与资助, funding records with an all / linked /
independent filter (the open record stays shown, and a program stays under the
institution group it was opened in, until it is closed, so an edit that moves it
out of the filter or to another institution keeps its detail and save feedback), the programs each applies to and a create form (name, funder,
separate/automatic, the program applications it applies to); **My materials** /
我的材料库 (`libraryTab.tsx`), library entries with kind, current version, *Open in
Notes*, stale-use count and every use with its pinned or reviewed version and an
*Open* to the record, plus registering a Note by id; **Supervisors & contacts** /
导师与联系人 (`contactsTab.tsx`), the former Project-wide list, each contact with
its linked records (buttons that open them), a multi-application picker
(`linkPicker.tsx`; an archived application appears only while linked and can only
be cleared) and the history/log form. A card opens the shared detail
(`applicationDetail.tsx`) for either track, ordered progress/decision (no
`submitted` for automatic funding) → linked records (a program's **Funding**, a
funding record's **Applies to**: status, mode, next deadline, checklist, *Open* in
its own tab — the same record — *Unlink*, linking another active one and *New
funding for this application*, which opens the funding tab with that program
preselected) → deadlines (add, edit kind/label/date, remove) → checklist (a note
instead for automatic funding) → related contacts (read-only, *Open in contacts*
focuses the contact and its history) → editable details (funder/name/mode for
funding). Each material row has a **Notes and drafts** disclosure
(`web/src/materialNotes.tsx`; shared helpers in `web/src/viewKit.tsx`): the linked
Note with its current version, a Reviewed / Not reviewed badge and the reviewed
versions, *Open in Notes* (the host's `NoteLink`, the global
`/knowledge/notes/:id` route and its shared editor), marking the current version
reviewed, linking or unlinking a Note; the pinned source Notes with their version,
a “Newer: version n” prompt and *Use version n* (re-pin), removal and adding one
(from the library through a select, or by Note id);
and *Draft with AI*: requirements, length and emphasis, revising the linked Note,
*Generate draft*, the five newest drafts and a preview of the newest that follows
a running draft every two seconds until its Run settles, then shows the text
(headings, lists and paragraphs as Notes will keep them, as plain React text), the
checks, the sources given with used/not used and newer-version badges, and *Save
as version n of the linked Note* (only when the base is unchanged) or, where
`save_new` holds, *Save as a new private Note* — in a shared Space it explains
instead that a draft is saved only into a linked Note no one else, oversight
included, can read; after saving it shows the version and *Open in Notes*. The
review action sends the Note it shows.
Refusals use the translated reasons. An archived application's detail is read-only (disabled detail fields,
no Save, a read-only hint; Restore stays); a deadline or material link editor
open when it is archived closes and cannot be reopened. A proposed decision shows
the host's review link. The overview card links to the Area through the host's
`EntryLink` (only this package's own `project.area` entries). Enable/disable on
the Plugins page announces `rainver:plugin-state-changed`
(`pluginStateEvents.ts`); effective-plugin readers, Project bindings, Project
navigation and mounted slots refresh on it at once. All reads and writes use the slot's scoped `ops`;
copy lives in `apps/web/src/i18n/applicationsUi.*.ts`; dates are calendar days
formatted by the host's `formatDay`.

**Retention.** Disable, unbind or archiving the Project keeps every plugin row (links and library entries included);
re-enable or rebind shows them again (Project archive keeps reads). Tasks and
Artifacts created or referenced stay with their core owners. Uninstall and data
deletion are not provided. A hard-deleted Project cascades its binding but not
plugin rows, which no entry can reach afterwards.

**Deployment note.** A bundled operation package changes `migrate
maintenance-pending` for an existing database: the next deployment needs the
stopped-writer maintenance path that installs `plugin_applications` (offline
installer). Nothing was deployed or installed on a live instance.

**Evidence.** `server/test/applicationsPluginDb.test.ts` (real PG; the compiled,
loader-admitted artifact installed by the offline installer; HTTP and Agent
tool entries: binding gate, end-to-end deadlines→Tasks, checklist, revision
conflict, material reference title through the core gate, reversible progress,
approved decision, final-decision refusal, script-URL refusal, other Project,
archive, per-person ownership and viewer refusal, contact events, personal
class refused to an unconsented Agent, identical UI/Agent records with one
policy decision each, disable/unbind retention with surviving Tasks, a shared
two-person Room Run releasing none of one person's records, an older decision
Proposal refused after a newer approved one or any edit, material references
refused at save when missing/another Project's/unreadable (HTTP and Agent) and
unavailable after moving Projects, crossed saves referencing each other's
Project refused without waiting on that Project's lock, an unplaced Task moved
into another Project by `task.update` while a save starts refused without
waiting on that Project (and the confined release primitive), the first API
accept of an expired decision Proposal committing `expired` and replaying it,
after real retention a new accept or reject refused (404) and the kept receipt
410 while an unlinked Proposal still decides, the Room Agent's
`proposal.list_pending`/`proposal.decide` (through the actual Run tool HTTP route,
exact 200 `ok: false` receipts) never listing, deciding or reporting a
superseded or expired Proposal as applied, an expired unlinked Proposal refused
alike by the Room and both HTTP decisions, and the card projection not offering
them, deadline
edits keeping their Task, and
Project-level contacts, rebinding and the archived-contact contract);
`server/test/applicationsNotesDb.test.ts` (real PG, materials in Notes: the
`notes.read` declaration and person-only review outside every toolset; link,
source pins, reviews kept through edits and relinking, reading the current
and a reviewed revision; another Project's Note, a Note shared to another
Project and a linked Note later moved there refused or unavailable; another
person's private, missing, trashed, unlinked and missing-version Notes refused,
viewer writes refused; removing a source or the material leaving Notes
untouched; an Agent reading a private Note in its owner's private Run with
private taint, refused in a two-person Room, and unable to record a review; a
review from a page opened before a relink refused as `note_relinked`);
`server/test/applicationsDraftsDb.test.ts` (real PG, the real `provider_task_run`
job with only the provider HTTP reply faked: a private queued Run without Note
text, the model seeing the pinned revision and not a later edit, preview with
checks, used and updated sources, saving once as a Project-free private Note and
linking it in a Personal Space; one source drafted for two schools into separate
Notes and reviews with the source untouched; a concurrent edit refusing a save into
the linked Note, a fresh draft saved as its next version with history kept, and a new
Note refused in a team Space (`note_placement_unavailable`) but allowed in a Personal
Space; the linked Note's current version replacing an older pinned source of it; a
Project-shared target refused, another member, generic Run I/O and an Agent tool
reaching nothing; a source moved to another Project before dispatch never sent; in a
team Space with `content` oversight the admin denied the draft Run's detail, status,
I/O and list entry and the private linked Note refused as not private; another
member's shared Note derived from their Source readable by the person yet refused for
drafting while that Source withholds external egress (no Run, no send), drafting once
consent is given, and refused again when the Space disables external egress; consent
withdrawn between request and worker sending nothing and failing the Run; a revoked
source withholding the derived draft from Run detail, status, I/O, list and preview,
served again once restored);
`server/test/applicationsFundingLibraryDb.test.ts` (real PG: the upgrade from an
install with migrations 0000–0002 keeping a bound contact as one link, a
Project-level contact unlinked and the history, and dropping the column; one
funding record applying to several programs and read from both sides with its own
checklist, deadline and progress, track filters and the summary; independent
funding linked later; automatic funding without a checklist, `material.add` and a
`submitted` decision refused with no Proposal created while a result and an
`accepted` Proposal work; the mode switch rules, including an approved separate
submission refused a switch to automatic with its status and Proposal unchanged,
still refused (also for an Agent) after normal progress to `under_review`,
`interview`, `waitlisted`, `rejected`, `preparing` and an approved `withdrawn`,
progress without a submission still allowed to switch, a switch superseding a
pending `submitted` Proposal so nothing is recorded, both lock orders with
accept receipts and durable linked request states, and the staged 0003/0004
upgrade through 0005 (original checksums, confirmed and presumed history,
one-write progress and post-0004 records without a submission stay
switchable, and the CHECK refuses incompatible direct writes);
a new linked record and `funding.link` racing for the last place (one refused,
`link_limit`) and a create over the limit refused with nothing kept; links refused across tracks,
Projects, people and onto archived work, unlink off an archived application, an
Agent unlinking in its Run's Project; the library refusing another Project's and
another person's Notes and duplicates, uses as source and linked text with stale
versions cleared by re-pinning and review, per-person entries, removal keeping Notes
and pins; a contact linked to three records, writable while one link is active,
read-only once all are archived until relinked, and kept with its history when
unlinked);
`server/test/applicationsAgentToolsDb.test.ts` (real PG, shipped package: a Room
message sent through `RoomService.sendMessage`, its child spawned by
`AgentGroupRunService.spawnChildRun` and Tasks started by the `task.run.create`
action on a built-in-Host and a paired-Host Location each carry the non-personal
tools in the snapshot their entry wrote (grants and plugin pins), list exactly
those through the Run tool transport (`rainver list`) and create records in their
bound Project, never another Project nor a person-only operation; once another
person reads the Project the Room Run and its child read none of the owner's
records; a Task with no Location has no grants and lists nothing; a direct chat's
grant input lists and calls them, an unbound Project refused, contacts listed for
reading only after the Space owner's personal consent and never as writes; the
allowance equal to the manifest's Agent-eligible operations);
`server/test/applicationsPluginFrontendDb.test.ts` (Chromium, normal web
bundle, real server/PG: overview card beside the goal, navigation entry, Area with
the four tabs and Programs selected, institution groups,
create/proposal/checklist from the UI, related contacts in the detail, the overview card's Area link,
deadline edit, *New funding for this application* opening the funding tab
pre-linked and the created record's *Applies to* opening back to the program,
which lists the same funding; *Open in contacts* focusing the contact's history,
linking it to the program and the funding record, then clearing both to Project
level; a program renamed to another institution and a funding record unlinked under
“Linked to a program” and relinked under “Independent” each staying open with its
*Saved* feedback until closed; registering a Note in the library and seeing its pinned use; archiving
with “Show archived” on closing open deadline and material link editors, the
contacts tab adding a Project-level contact, disable/re-enable
announced in the tab closing and reopening the Project entry without reload,
unbind closing the Area;
dark/light, English/Chinese, 1280 px and 390 px, no horizontal overflow,
44 px touch targets on phone; screenshots in `APPLICATIONS_VISUAL_OUT`, default
`/tmp/rainver-applications-visual`);
`server/test/applicationsMaterialsFrontendDb.test.ts` (Chromium, normal web bundle,
real server/PG, the queued draft Run performed by the real worker with only the
provider reply faked: the *Notes and drafts* entry beside the material's status and
link actions, a pinned source's newer-version prompt, requirements → *Generate
draft* → the running state followed without reload → preview with checks and
sources → *Save as a new private Note* (private, Project-free, linked) → *Mark
version 1 reviewed* → *Open in Notes* landing in the shared editor with the saved
text, in a Personal Space; the same Space as a team Space offering no *Save as a new
private Note* and showing why; dark/light, English/Chinese, 1280 px and 390 px, no horizontal overflow, 44 px
touch targets on phone; screenshots prefixed `materials-`).

**Not in this package yet.** Templates, PDF/Word export, sending or submitting
anything, automatic opportunity intake, timeline/calendar view, a Note picker
(Notes and sources are linked by id), an Agent contact proposal,
Relations/organization records, default landing Area, cross-Project views.

## Diary package

Plan 7 (2026-11-19) rebuilt `diary` as an operation package with the same
plugin id; the legacy descriptor, `/api/v1/diary*` routes, `/diary` page
route, scheduler and web adapter are retired without a compatibility layer.

- **Scope and ownership.** `scope: 'user'`: one person's Diary across all their
  Spaces. Every statement filters `rainver.user_id` only (no Space filter, by
  design), so another member of a Space reads nothing of it; reflections carry
  their entry's owner and reference the entry by `(user_id, id)`.
- **Operations** (`plugin.diary.*`, all `data_class: 'sensitive'`): queries
  `entry.get`, `entry.list`, `entry.on_this_day` (earlier years of the same
  day), `reflection.list`; person-only commands `entry.save` and `entry.delete`
  (`actors: ['user']`, never Agent tools); `entry.propose_append` (proposal,
  gate `belief_reach`). Business refusals are `PluginOperationRefusal` reasons
  (`entry_not_found`, `entry_too_long`), never record text.
- **Agents.** ADR 0030 applies unchanged: Diary tools reach an Agent only in an
  owner-only, non-delegated audience, with the data owner's own consent
  (`read` and `write` toolsets separately) and the isolated launch; a shared
  audience sees no Diary tool name. The only Agent write is an append
  Proposal: nothing is written until the person accepts it, the applier adds
  the text after the existing entry (or starts the day's entry) and never
  rewrites it; reject writes nothing; accept replays by key. An approval that
  no longer fits (`entry_too_long`) commits as `superseded` with
  `operation_failure` and writes nothing.
- **Reflection Job.** `entry.save` enqueues `plugin.diary.reflection.generate`
  in its own transaction when the person's settings have
  `ai_reflection_enabled: true`; the Job rechecks that setting and its entry,
  then upserts one reflection per entry and day (`ai_model: 'stub'`, a
  deterministic same-day summary, no model call). The legacy 6-hourly
  "daily prompt" task only wrote log lines and is retired. Settings stay in
  the existing enablement rows (same plugin id); the manifest descriptor
  declares no `settings_defaults`, so the Optional Modules page shows no
  toggle for it (page rebuild deferred).
- **Storage.** The offline installer initializes the package schema. It does not
  copy or drop old public tables. Existing plugin migration history is retained.
- **Web.** The manifest `navigation` entry `journal` mounts the existing editor
  page through `PluginSlot`; `opsApi.ts` maps it onto the scoped operation port
  (a fresh command key per write, no automatic retry). Like Finance, it keeps
  the mounted page and its draft on same-scope catalog refreshes and forwards
  calls to the current operation port. The slot discards the page on scope
  changes or loss of access. The page redesign is deferred.

Evidence: `server/test/diaryPluginDb.test.ts` (real PG: person isolation across Spaces, disable, reflection Job and
concurrency, Agent snapshot/consent/isolated read/taint/attribution, append
Proposal accept/replay/reject/superseded rollback) and
`apps/web/src/__tests__/diary-page.test.tsx`. The ordinary catalog refresh
for both package pages is covered by
`apps/web/src/modules/plugins/OfficialPluginRefresh.test.tsx`.

## Finance ledger package

Plan 7 rebuilt `finance_ledger` under the same plugin ID and retired its
legacy descriptor, `/api/v1/finance*` routes and `/finance` page. The bundled
`ledger` view mounts the existing page through `PluginSlot`; `opsApi.ts`
uses the scoped Web operation port. No Project binding is required.

- The Space owns the books. Only the owner can read a private account and
  its derived entries, balances, ledgers and exports. Import batch details
  belong to the uploader. `book.validate` is a query over the viewer's posted
  transactions and returns problem codes and visible directive IDs.
- Catalog reads are `personal`. Reads that can return private ledger
  content and both posting proposal operations are `sensitive` and use
  ADR 0030. An Agent can submit a posting proposal in an eligible owner-only
  isolated Run with the owner's consent. Durable commands are person-only.
- `directive.propose_post` and `import.propose_post` create private money
  Proposals of types `plugin.finance_ledger.directive.post` and
  `plugin.finance_ledger.import.post`. The canonical approval checks the
  frozen directive or pending batch under the same book lock as posting,
  import and account visibility changes. Posting revalidates the entries
  and applies the approved work atomically. A person can also post a
  transaction they enter directly through `transaction.create`.
The focused suites are `server/test/financeLedgerPluginDb.test.ts`,
`server/test/financeLedgerImportExport.test.ts`, and
`apps/web/src/__tests__/finance-page.test.tsx`.

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
