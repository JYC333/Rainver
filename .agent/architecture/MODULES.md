# Modules

> Current module map and ownership facts. Source of truth is still the code:
> `server/src/gateway/routeRegistry.ts`,
> package facades, and boundary tests.

## Repository Roles

| Path | Role |
|---|---|
| `server/` | TypeScript API backend. The gateway module is permanent; unknown API paths return the local 404 catch-all. |
| `server/src/db/schema/` | Drizzle schema authoring source for database table/constraint/index shape. |
| `server/migrations/` | Generated SQL artifacts applied by the server migration runner. In this pre-history phase, `0001_baseline.sql` is the consolidated baseline. |
| `apps/web/` | Web client. It consumes APIs and shared protocol types; it is not a business-rule authority. |
| `catalog/` | Built-in definitions, including agent templates and capabilities. |
| `packages/protocol/` | Shared TypeScript protocol package only. No handlers, persistence, routing, or authority. |
| `ops/` | Compose files, env templates, and scripts. |
| `deployer/` | Host deployment subsystem behind the deployer boundary. |
| `sandbox/` | First-level sandbox subsystem. Runtime code uses documented interfaces rather than importing internals. |

Current server ownership is summarized in
[`SERVER_OWNERSHIP.md`](SERVER_OWNERSHIP.md).

## Module Kinds

| Kind | Meaning |
|---|---|
| `kernel` | Identity, isolation, governance, execution spine. |
| `infra` | Cross-cutting infrastructure and runtime/host integration. |
| `capability` | Code-defined agent skills and reviewable evolution surfaces. |
| `product` | User-facing domain feature surface. |
| `frontend-support` | Backend read models and aggregation endpoints for UI views. |
| `support-package` | Import-only package with no HTTP module registration. |

## Module Kinds vs. Official Optional Modules

**ServerModule** (in `gateway/routeRegistry.ts`) is the internal backend code registration unit. All `ServerModule` entries are unconditionally mounted at startup — they are not toggled at the code level.

**PluginHost** activates official plugin package artifacts from `server/dist/official-plugins/<plugin_id>/` after core server modules and before the API catch-all. Source for bundled official plugins lives under `plugins/official/<plugin_id>/`. PluginHost is the startup activation point for official plugin routes, jobs, scheduled tasks, and proposal appliers. Activation is synchronous by contract.

**Official Optional Modules** are a product control-plane layer above `ServerModule` and `PluginHost`. They gate runtime behavior (route responses, job handlers, scheduled tasks, proposal appliers, context contribution) via DB-backed plugin enablement, without per-scope route mounting. See [`OFFICIAL_OPTIONAL_MODULES.md`](OFFICIAL_OPTIONAL_MODULES.md) and ADR 0006.

The `plugins` module (Kind: `kernel`) is the control plane for official optional modules. Built-in official plugin code is activated through `PluginHost` and gated by the plugin guard in route handlers or host-wrapped contribution points.

## Registered HTTP Modules

Core modules are `always_on=True`. Optional product routes are still mounted by PluginHost, but respond with `plugin_disabled` when the plugin is disabled for the space/user.

| Module | Kind | Routes | Public facade | Main ownership / notes |
|---|---|---|---|---|
| `system` | infra | `/health`, `/server/health`, `/status`, `/server/features`, `/features` | empty | Server health, component-level runtime status, and feature descriptors. `/health` is a container probe; `/status` reports database, per-scheduled-task liveness, jobs-worker presence, and queue depth, and requires a space owner/admin. |
| `auth` | kernel | `/auth/*`, `/me`, `/me/spaces` | yes | Users, auth accounts, sessions, feature-gated API keys, Google auth. |
| `spaces` | kernel | `/spaces`, `/invitations` | hook registry | Spaces, memberships, invitations, space-created hook dispatch. |
| `catalog` | capability | `/server/catalog*`, `/capabilities*` | yes | Read-only on-disk catalog. Owns legacy catalog-backed capability/template manifest surfaces. |
| `capabilities` | capability | `/capability-definitions*`, `/capability-packs*`, `/workflow-templates*`, `/projects/{projectId}/workflow-profiles*`, `/skill-sources*`, `/skill-packages*` | yes | Capability/workflow/open-skill control plane: canonical definitions, packs, workflow templates, imported skill packages, project workflow profiles, and runtime skill bindings. Does not execute native capabilities. |
| `streaming` | infra | `/runs/{runId}/events/stream` | empty | Run event SSE stream. |
| `notifications` | infra | `/server/notifications/webhooks/*` | empty | Notification webhook egress policy plus durable operational-alert pointers delivered through Activity Inbox. |
| `runtimeTools` | infra | `/runtime-tools*` | empty | Controlled runtime CLI installer/status/catalog. |
| `providers` | infra | `/providers*`, `/credentials/cli*`, `/internal/providers-credentials/*` | yes | Model providers, credential pools, provider invocation, and CLI credential broker/audit. There is no separate credentials route module. |
| `runtime_tool_bindings` | infra | `/runtime-tool-bindings*` | empty | Runtime tool binding reads. |
| `runtimeHost` | infra | `/internal/runtime-host/execute` | empty | Internal runtime-host execution for server-owned model/runtime paths. |
| `usage` | frontend-support | `/usage*` | yes | Token usage ledger and permission-filtered read models for managed API calls, provider-proxy calls, exact Run-attributed subscription CLI usage, and managed-profile CLI transcript recovery imports. Usage events are registered content resources with owner, visibility, disclosure level, source snapshot, and copied `selected_users` or `space_shared` disclosure grants. User aggregation filters events through the canonical content predicate before grouping; instance operations receive only de-identified totals. Protocol/schema values reserve future manual and cross-instance imports, but no product ingestion endpoint exposes them. Raw prompts, messages, request/response bodies, transcripts, and provider secrets are excluded. |
| `runs` | kernel | `/runs*`, `/internal/runs/execute` | yes, lazy | Run lifecycle, execution, events, pre-cleanup deterministic Verification Engine, run-scoped verification results, finalization, runtime bridge, outputs/artifacts. |
| `artifacts` | product | `/artifacts*` | empty | Client-facing artifact list/get/export and run materialization artifacts. |
| `projects` | product | `/projects*` | yes | Projects and their owned Project Folders (`GET/POST /projects/{projectId}/folders` list/create; the `projectFolders` module owns the rest of the Folder surface). `ProjectSourceBindingService` is the application boundary for project source-consumption configuration; its HTTP/schema ownership move is tracked separately. Also owns the Project Kernel (ADR 0011): Brief Versions, Primary Mode + append-only Mode Transitions, Template application at creation, and the registered-adapter Overview/Attention aggregation (`overviewRegistry.ts`, `attentionRegistry.ts`) that other Mode-owning modules (e.g. `inquiry`) plug into — `projects` never queries another domain's tables directly. |
| `project_templates` | product | `/project-templates`, `/projects/{projectId}/template` | yes | Code-owned Project Template descriptors (creation-time defaults bundle: initial Primary Mode, starter Workflow Templates) and creation-time Project shape selection. `projects.template_key` is the first-class stored selection; it is provenance only and never gates Area/capability visibility. |
| `inquiry` | product | `/projects/{projectId}/inquiry*`, `/projects/{projectId}/graph/combined` | yes | Inquiry Domain (plan section 9-10, ADR 0011): Question/Hypothesis Threads with typed state, working Thread relations, statement revisions, confirmed Iterations, Evidence Signals over the Project Corpus, Candidate consolidation, bounded Review Packets, and read-only Delta Briefs. Threads are their own root tables, never `space_objects` rows, and never write `object_relations`. Its retrieval adapter revalidates Project membership against canonical rows; its Inquiry and Combined Project graph producers are bounded read models. Registers Overview and Attention adapters into `projects`' registries. |
| `experiments` | product | `/projects/{projectId}/experiments*` | yes | Experiment Domain (ADR 0011): stable Definitions, immutable executor-config Versions, Runs with frozen config snapshots, Observations, and reviewed Interpretations that convert to Inquiry Evidence Signals. `manual` and `managed_code_comparison` are executor types under one authority. Managed comparison launch maps an approved Version to a governed Run, preserves Project Folder/sandbox/credential policy, captures parsed metrics as Observations, and reconciles terminal Run state idempotently. The retired `project_experiment_campaigns` model has no compatibility path. |
| `knowledge_promotion` | product | `/projects/{projectId}/knowledge-candidates*`, `/projects/{projectId}/knowledge-candidate-review-packets*`, `/projects/{projectId}/knowledge-candidate-extractions*` | empty | Note/Inquiry/Experiment-to-Knowledge promotion, AI-assisted Candidate extraction, and source-change revalidation. Candidates pin immutable source revisions, inherit source visibility, enter bounded review packets, and create proposal-gated Knowledge writes. Extraction uses governed Runs and cannot write canonical Knowledge. The leased outbox sweep records retry diagnostics and idempotent no-impact/candidate outcomes. |
| `project_review` | frontend-support | `/projects/{projectId}/review-session` | empty | Ephemeral cross-domain Project Review composition over bounded Inquiry and Knowledge Promotion packets. It stores no Candidate or decision state and links actions back to the owning domains. |
| `decisions` | product | `/projects/{projectId}/decision-cases*` | empty | Decision Cases, Options, Criteria, scored trade-offs, Commitments, Inquiry Thread source references, and an atomic explicit Commitment-to-Delivery-Task action. Registers Decision Overview and Attention adapters. |
| `learning` | product | `/learning*`, `/projects/{projectId}/learning-*` | empty | Space-global and Project-contextual Learning Objectives/Items anchored to shared versioned Knowledge, with per-user concurrency-safe mastery state and fixed-interval review foundations. Registers Learning Overview and Attention adapters. |
| `project_research` | product | `/projects/{projectId}/research*` | yes | Academic Research workflow implementation: research profile approval, workflow/stage/checkpoint projection, artifact links, screening criteria, and literature-matrix/synthesis/integrity reads. Every run kind uses immutable execution-per-pass `WorkflowExecution` authority. `project_operations` is the long-lived domain projection linked to the current pass; it is not a second workflow engine. There is no legacy state-machine or per-operation dual-authority path. |
| `policy` | kernel | `/internal/policy/*` | yes | Service-authenticated policy enforcement and proposal-apply policy gate. |
| `proposals` | kernel | `/proposals*` | yes | Proposal approval/apply orchestration and applier registry; unsupported proposal types fail closed. |
| `sessions` | product | `/sessions*`, `/internal/sessions/session-summary/get-latest` | empty | Conversation sessions, messages, latest summary reads, user × session backend bindings, serialized turn claims, and opaque vendor runtime-session state mappings. Vendor state is an invalidatable replay optimization; messages and summaries remain authoritative. |
| `agentTemplates` | product | `/agent-templates*` | empty | Catalog-backed template list/read/create-agent surfaces. |
| `agents` | product | `/agents*` | empty | Agent profiles, versions, assistant chat/settings, template services, agent-scoped run/proposal reads. |
| `prompts` | capability | `/prompts/assets*` | empty | Prompt asset facade over evolvable assets, built-in manifest sync, immutable prompt versions, rendering/preview, evaluation evidence, labeled deployment refs, production promotion proposals, rollback, and runtime resolution. |
| `personalMemoryGrants` | kernel | `/personal-memory-grants*` | empty | Personal memory grant preview/create/list/revoke/audit. |
| `memory` | kernel | `/memory*` | yes, lazy | Memory entries, read logging, search, and memory proposal creation. |
| `context` | kernel | `/context/build` | empty | Frontend context preview/native context build route. |
| `activity` | product | `/activity*` | yes | Activity records, upload, review/archive, consolidation, and summary runs. |
| `publications` | product | `/publications*` | empty | Targeted immutable snapshots, target-Space discovery/import, and revocation. |
| `sources` | product | `/sources*` | empty | Source connections, source items, extraction evidence, trust helpers, summary runs. Connection lifecycle callers use `SourceConnectionService`; recipe planning/create/dry-run/activation and version reads use the unified `SourceRecipeService`. |
| `knowledge` | product | `/knowledge*`, `/notes/collections*` | empty | Knowledge items, notes, sources, entity links, source links, read model, and proposal appliers. |
| `relations` | product | `/relations*` | yes | People, organizations, identities, affiliations, relation notes, and relation provenance links over shared `space_objects` / `object_relations`. |
| `academic` | product | `/academic*` | yes | Academic paper object extension, paper authorship links, and citation links for Project Templates and graph lenses. |
| `graph` | frontend-support | `/graph*` | empty | Read-only `GraphProjection` routes and per-user graph view-state persistence over visible `space_objects` / `object_relations`. |
| `evolution` | capability | `/evolution*` | empty | Evolution targets/signals, strategy assets, selector decisions, experiences, review prompts, validation reads, review artifacts, D3 proposal bundles with partial approval and guarded version-set rollback, and the domain-owned `evolution_review` autonomy candidate handler. |
| `tasks` | product | `/tasks*`, `/boards*`, `/me/tasks` | empty | Boards, tasks, task-run links, task evaluation, and run-finalized hook. Registers the Delivery Overview/Attention projection over Project Tasks; there is no parallel Delivery aggregate. |
| `plans` | product | `/plans*` | empty | Durable plan/version execution read and command surface: approval-gated materialization, structured list/detail views, execution, reconciliation, and revision. |
| `projectFolderExecutionConfigs` | product | `/projects/{projectId}/folders/{folderId}/execution-config*` | empty | Project Folder execution config read/create/update. |
| `projectFolders` | product | `/projects/{projectId}/folders*` | yes | Project Folder records, PathPolicy, sandbox/worktree helpers, and Files & Code (tree/file/git status/git diff) read routes. There is no separate console route module. |
| `jobs` | infra | `/jobs*` | yes | Durable job queue, worker, and registry-dispatched handlers. Re-exports scheduler types for compatibility only; new scheduler code imports `scheduler`. |
| `scheduler` | infra | none | yes | In-process periodic task registry, background service startup composition, and scheduler-owned `scheduler_tasks` cursor/state store. |
| `autonomy` | infra | none | empty | Owns the `autonomous_tick` native Automation target, exact-coverage domain candidate registry, durable candidate/tick audit, deterministic ranking, per-candidate bounded launch, private report provenance, successful-review cursors/signal links, and stale-review recovery. `periodic_digest` and `evolution_review` share the observe/launch queue and safety invariants. Automations never imports this module. |
| `automations` | product | `/spaces/{spaceId}/automations*` | empty | Server-owned automations, schedule/manual fire, credential preflight, scheduler state in `scheduler_tasks`, fixed WorkflowExecution DAG scheduling, bounded per-node attempts, and protocol-declared native target dispatch through an exact-coverage handler registry. Target-owning domains register their own handlers; unknown or handlerless targets fail closed. Also owns registered deterministic Workflow Action handlers and a terminal-outcome registry that lets owning domains project results without Automations writing their tables. Registers the Operations Overview/Attention projection over Project Automations, visible Runs, and operational alerts; there is no parallel Operations aggregate. |
| `dailyReports` | product | `/daily-capture-report*` | empty | Daily capture report user settings, manual run, scheduler scan, scheduler state in `scheduler_tasks`, durable job handler. |
| `backups` | infra | `/system/backups*` | empty | Server-owned full-system backup service and scheduled backup ticks. |
| `deployment` | infra | `/deployments/jobs*` | empty | Deployer client edge; create/detail currently fail closed with 501. |
| `frontendSupport` | frontend-support | `/home/summary`, `/me/summary`, `/me/timeline`, `/me/pending` | empty | Backend aggregate read models for Home and personal cross-space views. There are no separate `home` or `me` modules. |
| `plugins` | kernel | `/plugins*` | yes | Official optional module control plane: descriptor registry, DB-backed enablement, plugin guard. Must be registered before PluginHost activation. |

## Plugin-Hosted HTTP Surfaces

These routes are not `ServerModule` entries. They are mounted by `PluginHost` after `SERVER_MODULES` and before the API catch-all.

| Plugin | Kind | Routes | Main ownership / notes |
|---|---|---|---|
| `diary` | product (official_plugin) | `/diary*` | Personal diary editor, same-day history, reflection job, reminder scheduler. Routes use `ctx.http.pluginGuard()`. Diary entries are editor-owned user documents, not raw ActivityRecord input; memory/context extraction remains opt-in proposal/sources work. |
| `finance_ledger` | product (official_plugin) | `/finance*` | Space-scoped double-entry finance ledger: books, accounts, commodities, directives, postings, prices, and Beancount import/export. Routes use `ctx.http.pluginGuard()`. Proposal appliers are registered through PluginHost and plugin migrations own finance tables. |

## Code-Only Support Surfaces

| Package | Kind | Public facade | Main ownership / notes |
|---|---|---|---|
| `runtimeAdapters` | support-package / infra | yes | Runtime adapter specs/types only. Consumed by `agents`, `automations`, `runtimeTools`, and `runs`; not route-registered. |
| `routeUtils` | support-package / kernel | empty | Shared route helpers for DB pool access, identity resolution, pagination, parsing, and route error handling. |
| `access` | support-package / kernel | empty | Shared resource visibility predicates, common SQL read predicates, and space role helpers. It does not replace PolicyGateway or domain-owned ACLs. |
| `settings` | support-package / infra | yes | Generic scoped settings store for low-frequency instance, space, user, and space-user settings. Product modules own validation and DTOs; new code must not add feature-specific settings tables. |
| `scheduler` | support-package / infra | yes | In-process periodic task registry, scheduler task state store, and background service startup composition. |
| `projectFolders/pathPolicy`, `projectFolders/sandbox`, `projectFolders/codePatch` | module-internal infra | yes via `projectFolders` | Project Folder path validation, worktree/sandbox preparation, and code-patch collection/apply ports. |

`memory/consolidation/` is part of the registered `memory` module.

## Extension Registries And Hooks

| Concern | Owner | Registration model |
|---|---|---|
| HTTP routes | server `gateway/routeRegistry.ts` + `PluginHost` | `ServerModule` entries mounted under `/api/v1`, then PluginHost mounts official plugin routes, then the catch-all. |
| Periodic tasks | server `modules/scheduler/SchedulerRegistry` | Server startup registers `ScheduledTask`; owning server modules keep tick behavior. |
| Scoped settings | server `modules/settings/ScopedSettingsStore` | Owning modules define typed descriptors and product validation; the settings module owns generic persistence for instance/space/user/space-user settings. |
| Durable job handlers | server `modules/jobs/JobHandlerRegistry` | server worker runtime registers allowlisted handlers, including `agent_run` and `authorization_request_reconcile`; unregistered types fail fast. |
| Official plugin routes/jobs/scheduler/proposal appliers | server `modules/plugins/host` | Built-in official plugins register synchronously through `PluginHostContext`; host wraps job handlers and proposal appliers with enablement checks. |
| Space-created initialization | server space hooks | server modules register space-created hooks; hook runs in caller transaction and must not commit. |
| Run-finalized side effects | server `runs` finalization service | Post-run finalization and task-board side effects are server-owned. |
| Proposal application | server proposal applier registry | Target modules own mutation logic; unsupported types fail closed. |
| Routing decisions | server router service | Single owner for intent classification, adapter resolution, and `needs_cli`. |
| Runtime execution | server `runs` | Run create, execute/stop, top-level read/status/trace, post-run finalization/evaluation, internal execute, `agent_run` dispatch, and runtime context preparation are server-owned. |
| Model invocation | server `providers` / `runtimeHost` | Run orchestration calls the server runtime-host/provider broker for `model_api` and `ts_agent_host` no-tool runs. |

## Current Boundary Status

- The route registry is the HTTP source of truth. Credential, Home, personal-view,
  and Files & Code routes are owned by `providers`, `frontendSupport`, and
  `projectFolders` as listed above. The legacy `/capabilities*` manifest surface is
  owned by `catalog`; the capability/workflow/open-skill control plane is owned
  by `capabilities`.
- The server boundary guard restricts bare runtime package imports and forbids
  web, sandbox, deployer, ops, migration-tooling, and ORM internals from
  `server/src`.
- Lazy facades: `memory`, `runs`.
- Router compatibility wrappers are removed; do not recreate `IntentRouter` or `TaskRouter`.
- `runtimeAdapters` is code-only; runtime evidence/process registration flows through
  injected ports implemented by `runs`.
- Runs do not import task-board internals directly; task-board side effects use
  run-finalized hooks/finalization services.
- Proposal apply dispatch goes through `ProposalApplierRegistry`; no hardcoded proposal-type
  apply chain remains.
- Interactive agent-session execution over a Project Folder was never
  implemented and has been removed; current Files & Code routes are
  read-only tree/file/git status/git diff surfaces under `projectFolders`.
- Frontend Home and personal views consume `frontendSupport`/`/me` aggregate read
  models instead of independently re-implementing proposal/activity/runtime logic.

Target modules keep owning proposal mutations through the server proposal applier
registry; unsupported proposal types fail closed.

## Guardrails

Run these after structural module changes:

```bash
cd server
npm run typecheck
npx vitest run test/boundaries.test.ts
```
