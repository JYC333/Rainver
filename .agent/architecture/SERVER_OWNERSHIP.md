# Server Ownership

> **Status:** current repository fact, refreshed 2026-07-24. Code remains the
> source of truth. This document records only the active ownership split; it is
> not a migration log.

Rules:

- A command has exactly one authority at a time.
- Server-owned routes are explicitly registered in
  `server/src/gateway/routeRegistry.ts`.
- Unknown `/api/v1/*` routes return the local 404 catch-all.
- Database schema authoring is owned by Drizzle definitions under
  `server/src/db/schema/`; generated SQL artifacts are applied by the explicit
  server migration runner under `server/migrations/`.

## Owned Contexts

| Context / surface | Server owns today | Deferred / fail-closed |
|---|---|---|
| Auth / spaces / identity | Session-cookie identity resolution, Google OAuth login/callback/config, `GET /auth/introspect`, `GET /me`, `GET /me/spaces`, `POST /auth/logout`, feature-gated API-key routes, `POST /spaces`, `GET /spaces/{id}`, `GET /spaces/{id}/members`, `POST /spaces/{id}/invitations`, `POST /invitations/{token}/accept`, and deterministic space-created default seeds | DB-persisted API-key storage until the canonical schema adds an `api_keys` table |
| Providers/credentials | Provider reads, commands, invocation, API-key credential pools, CLI credential login/broker/audit, internal provider/credential ports | — |
| Usage metering | Append-only normalized token ledger, source/owner attribution snapshots, copied selected-user grants, pricing enrichment, permission-filtered dashboard aggregation, private CLI-history import, and de-identified instance operations totals. Provider/model invocations must enter through the required metering context on `completeProvider*` or the provider proxy. | Billing and payment enforcement |
| Runtime adapters | `RuntimeAdapterSpec` catalog, adapter-type semantics, runtime-tool binding reads, server runtime-host/tool integration, and the local/Docker CLI executors | managed API tool execution |
| Agents | Agent CRUD (`/agents*`), current-version/version list/read/restore, config updates as immutable `agent_versions`, default Assistant ensure/read, Assistant settings, agent-scoped run list/read subresources, catalog-backed agent template list/version reads, and create-from-template | Template catalog persistence remains catalog-file-backed; DB-backed template authoring is not implemented |
| Runs | Run creation via agent subresources, top-level run list/detail/status/trace, activity/artifact/proposal/verification child read surfaces, execute/stop/resume/abandon commands, internal execute port, deterministic pre-cleanup Verification Engine execution and attempt-scoped post-run evaluation/finalization, durable RunAttempt tracking, deterministic Supervisor retry/cost policy with C2 fallback-chain reroute, cancellation escalation and orphan recovery, `agent_run` dispatch plus authorization-request reconciliation, run execution evidence writes, native context.prepare consumption, and server worktree/ephemeral sandbox preparation for CLI runs | Root/integration verification, model-judge/manual-review authority |
| Rooms | `/rooms*` project-bound persistent Rooms, human/agent rosters, multiple durable conversations, per-message speaker identity, per-user conversation backend binding, and projection of terminal task results into Room messages | Cross-space Rooms and execution under a Room creator's identity |
| Agent group runs | `/agent-groups*` one-task collaboration records opened by Room messages or advanced callers, structured recipient segments, timeline/trace reads, pause/resume/cancel controls, authorized `agent.delegate` / `run.spawn_child`, `agent.wait_for_results`, and delegation/wait lifecycle projection | Long-lived conversation ownership; unmanaged execution outside a task group |
| Jobs | Generic durable `jobs` queue (`/jobs*`), unified allowlisted worker registry (including `agent_run`, `authorization_request_reconcile`, consolidation, reporting, retrieval, Source, research, evaluation, and experiment handlers), stuck-job reclaim, stale running-run detection, and orphan finalization/supervisor recovery at worker startup | — |
| Scheduler | Scheduler-owned `scheduler_tasks` cursor/state store, in-process scheduler registry, background service startup composition, non-overlapping scheduler task execution, and scheduled ticks for daily capture report, automation, memory access-log retention, memory maintenance, source extraction polling, Custom Source polling/reclaim, and backup | — |
| Settings | Generic scoped `settings` persistence for low-frequency instance, space, user, and space-user settings via `ScopedSettingsStore`; owning product modules define typed descriptors, authorization, validation, and DTOs | Feature-specific settings tables are not allowed for new low-frequency settings |
| Automations | `/spaces/{id}/automations*`, schedule/manual fire with policy preflight, automation run records, automation schedule rows in scheduler-owned `scheduler_tasks`, immutable WorkflowExecution DAGs with bounded node attempts, Action handlers, terminal outcome dispatch, and the Operations Project adapter | Conditional node branching/skipping, generic conditional Checkpoint migration, and evidence-triggered retry backoff |
| Daily capture report | `/daily-capture-report/*` user settings via scoped settings, manual run, report listing, daily report task rows in scheduler-owned `scheduler_tasks`, scheduler enqueue of `daily_capture_report` jobs | — |
| Backups | `/system/backups` list/manual trigger, scheduled backup ticks, prod backup policy guard, and backup lock/stale-lock handling | — |
| Policy | Sensitive-action enforcement, proposal-apply policy gate, durable policy audit | — |
| Proposals | External proposal review/read routes, accept/reject/egress-approval/rollback commands, proposal-apply orchestration, and the server applier registry for registered memory, knowledge, task follow-up, and code-patch types | Target-module appliers that are not registered; unregistered proposal types fail closed |
| Sessions | Public list/get/create session commands, list/add canonical messages, conversation backend bindings, and session reflection proposal creation | Continuity derivation belongs to Runtime Context |
| Runtime Context | Policy/setup resolution, typed acquisition and planning, Delivery/Snapshot lifecycle, scope-sequenced canonical Context Events, capture-gap reconciliation, deterministic Micro Checkpoints, validated Semantic Checkpoints, and immutable corrections | Canonical bodies stay in owning domains; Memory/Project/Policy promotion stays separately governed |
| Agent conversation | Direct agent chat turn orchestration, user × session backend binding, hybrid CLI runtime-session resume, and queued Run creation | Room persistence, which is owned by Rooms |
| Ask Space / personal aggregated retrieval | Same-Space `/ask-space/think`; user-centred `/me/retrieval*` fan-out with per-Space live adapter authorization; pointer-only result persistence/re-resolution; source-private single-Space summaries; pre-disclosed explicit Personal-Space fused storage; per-source pointer-only egress records; mutable Space egress notification settings and member broadcasts | Automatic persistence of fused conclusions remains prohibited |
| Memory read/write boundary | `/memory` list/get/search, read-access logging, public memory create/update/archive proposal creation, batch activity consolidation via `POST /memory/consolidation/run` | Memory quality/evolution jobs (digest refresh, memory-health solidification, source-monitoring producers) |
| Memory apply | Accepted `memory_create` / `memory_update` / `memory_archive` apply after the proposal-apply policy gate, including creation-context/taint placement and producing-Agent provenance | Capability learning, which belongs to evolvable assets |
| Activity | DB-backed `/activity*` capture/list/detail/upload/review/archive, per-activity consolidation, targeted content publication/import, and summary artifact/proposal creation with activity/evidence/sources provenance | LLM summarization quality improvements beyond the current classifier pipeline |
| Sources | DB-backed `/sources*` connector/connection config, manual URL source capture, extraction-job audit records, candidate evidence/evidence links, project source bindings, project source item links, source health read models, summary artifact/proposal creation, and in-process extraction polling | External fetch fidelity beyond the current extraction worker |
| Knowledge | DB-backed `/knowledge*` item proposal routes, source/note/entity-link CRUD, note collection CRUD, item/source links, relation proposals, knowledge proposal appliers, immutable-source Knowledge Promotion Candidates, bounded review packets, AI-assisted extraction, and revalidation | Deferred background knowledge quality jobs |
| Tasks | DB-backed `/tasks*`, `/boards*`, and `/me/tasks` boards/tasks CRUD, queued Run creation through `task_runs`, task artifacts/proposals reads, task evaluations, the run-finalization → task-evaluation bridge, and the Delivery Project adapter | Worker execution itself remains owned by Runs/runtime |
| Plans | DB-backed `/plans*` Agent Plan list/detail reads, approval-gated version reads, execution, reconciliation, and Agent-only `task.plan.propose` materialization | Public Plan creation/revision, Canvas editing, and planner/model authority beyond the stored plan contract |
| Artifacts | Client-facing `GET /artifacts`, `GET /artifacts/{id}`, `GET /artifacts/{id}/export`, and run-scoped artifact routes, including scoped visibility checks and managed-storage export path guards | — |
| Projects | DB-backed `/projects*` CRUD/archive, immutable Brief Versions, Primary Mode transitions (every installed Area always reachable — no enabled-Area gate), owned Project Folders (`/projects/{id}/folders*`), adapter-composed Overview/Attention, and ephemeral cross-domain Project Review sessions. Inquiry owns Questions/Hypotheses; Project Research owns one version-pinned Question scope per Workflow; Experiment, Decision, Learning, Delivery, and Operations retain their own authorities. | Incident/Runbook aggregates remain usage-triggered |
| Capabilities / templates | Catalog-backed `/capabilities*` and `/agent-templates*` product routes | Capability/template authoring remains file/catalog controlled |
| Prompts | Catalog-backed built-in prompt manifests, `/prompts/assets*` prompt asset/version reads and writes, preview/evaluation, labeled deployment refs, production promotion proposals, rollback, and runtime prompt resolution | Tool/capability grants, provider credentials, Project Folder access, memory write policy, and capability graph changes remain outside prompt edits |
| Evolution | `/evolution*` target/signal surfaces, strategy assets, selector decisions, experiences, review prompts, real `run_type='evolution'` run creation, review artifact recording, and D3 evolution bundle grouping/partial review/version-set rollback | Automatic apply/deploy/code-merge loops, rollback adapters for proposal types without durable domain snapshots, and unregistered proposal appliers |
| Personal memory grants | `/personal-memory-grants*` preview/create/list/revoke/audit for run-scoped summary-only grants | Raw personal-memory egress apply path remains fail-closed |
| Project Folders / sandbox | DB-backed `/projects/{id}/folders*`, Folder execution-config list/create/read/update, Folder snapshot-retention settings (`snapshot_retention_days`, `snapshot_max_count`), Files & Code read routes, PathPolicy, Folder read policy audit, worktree prepare/cleanup, sandbox GC, worktree code_patch collection, accepted `code_patch` proposal apply through `project_folder.write_patch` (with pre-apply `code_patch_snapshots` capture), and user-facing rollback via `POST /api/v1/proposals/{id}/rollback` | Interactive agent-session execution over a Folder was never implemented and has been removed |
| Deployment | Authenticated `/deployments/jobs*` fail-closed edge routes and a dormant core socket-client type limited to `rebuild_agent_space`, `restart_agent_space`, and `health_check` | No production server caller; deployer socket is private to its privileged sidecar; deployment job persistence, proposal verification, audit, and product submission remain deferred |

Current ownership aliases to avoid migration-drift mistakes:

- `catalog` owns catalog-backed `/capabilities*` and `/server/catalog*` surfaces;
  there is no standalone `capabilities` route module.
- `providers` owns provider credentials and the `/credentials/cli*` broker/audit
  surfaces; there is no standalone `credentials` route module.
- `frontendSupport` owns `/home/summary` and `/me/{summary,timeline,pending}`;
  there are no standalone `home` or `me` route modules.
- `projectFolders` owns the current Files \& Code read/status routes; there
  is no standalone Files \& Code route module.

The exact active route-module list is intentionally not duplicated here.
`server/src/gateway/routeRegistry.ts::SERVER_MODULES` is its executable source
of truth, and [`MODULES.md`](MODULES.md) records the current human-readable
module inventory and route ownership.
`runtimeAdapters` is a first-class code-only domain consumed by `runs`,
`runtimeHost`, and `runtimeTools`.

## Deferred Boundaries

These are intentional deferred/fail-closed gaps today, not evidence that the
TypeScript backend cutover failed:

- DB-persisted API-key storage; the API-key routes return the canonical
  feature-gated response while the schema has no `api_keys` table;
- memory digest refresh, memory-health solidification, source-monitoring producers, and quality loops;
- non-memory/non-knowledge/non-task/non-code-patch proposal target appliers;
- deployer host/sidecar process internals and deferred deployment job persistence.

## Guards

Fail-closed behavior lives in server route/service boundaries and explicit 501
responses for deferred surfaces.

## Operational Notes

In bundled compose modes, server connects with the Postgres owner/app
role derived from `POSTGRES_*`; `ops/scripts/lib/local-compose.sh` generates
`SERVER_DATABASE_URL` and the internal token, but does not create a
separate per-table app role.

Server DB connections and transactions are centralized in
`server/src/db/`. Drizzle definitions under `server/src/db/schema/` are the
schema authoring source; generated SQL files under `server/migrations/` are the
runtime-applied artifacts. Migration is an explicit ops command invoked by
`ops/scripts/start.sh` before app services start; it is not wired into the
long-running server service process startup.

Focused verification commands are listed in [`../COMMANDS.md`](../COMMANDS.md).
