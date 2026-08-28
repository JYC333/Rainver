# Agent Context Index

## 1. Repository Context

Rainver is a space-based, multi-user, agent-first system for personal, family, and small-team
use within a single deployment instance. It has a server backend (PostgreSQL),
a React/Vite frontend (PWA), and a server-authoritative control plane: canonical state, orchestration,
memory (written only through a proposal → approval workflow), and policy/credential enforcement all
live on the server. Agent execution itself runs on one or more **execution hosts** registered to the
control plane — the server host (strictly isolated, bubblewrap sandboxed, the default and only host
in a single-machine deployment) or a personal machine the user owns and has paired (trusted-host mode,
native execution, no sandbox isolation). See
[decisions/0016-control-plane-execution-hosts.md](decisions/0016-control-plane-execution-hosts.md) for
the two-tier trust model. The system is **not** local-first; it supports offline capture
and draft queuing for personal convenience but active memory, proposals, credentials, and deployment
remain server-authoritative, and Project Folder operations remain authoritative to whichever host owns
that folder. See
[architecture/LOCAL_FIRST_COMPATIBILITY.md](architecture/LOCAL_FIRST_COMPATIBILITY.md) for the
durable position on this boundary.

**Source of truth hierarchy:**

1. **Code** — implementation truth; always wins over docs
2. `server/src/db/schema/` — database schema authoring source
3. `server/migrations/` — generated/applied database SQL artifacts
4. `server/src/` — backend implementation, including the active gateway route registry and modules
5. `packages/protocol/src/` — shared public DTOs and wire contracts
6. `apps/web/src/modules/registry.ts` — active frontend modules and nav items
7. `.agent/BOUNDARIES.md` — architectural invariants; load for any structural change
8. `.agent/decisions/` — accepted architectural decisions

Docs in `.agent/architecture/` describe **current state**, not target-state speculation. Temporary
reports in `.agent/reports/` are not source of truth and should be deleted after consolidation.

---

## 2. Start Here

| What you need | Link |
|---|---|
| Implemented Runtime Context architecture and decision record | [architecture/MEMORY_CONTEXT_RUNTIME.md](architecture/MEMORY_CONTEXT_RUNTIME.md) · [modules/runtime-context.md](modules/runtime-context.md) · [decisions/0014-unified-runtime-context-engine.md](decisions/0014-unified-runtime-context-engine.md) |
| Security and access boundary reference | [architecture/SECURITY_AND_ACCESS_BOUNDARIES.md](architecture/SECURITY_AND_ACCESS_BOUNDARIES.md) |
| Reuse / dependency policy and the canonical mechanism index (load before building anything substantial) | [architecture/REUSE_AND_DEPENDENCY_POLICY.md](architecture/REUSE_AND_DEPENDENCY_POLICY.md) |
| Test layer and product invariant philosophy | [architecture/TESTING_STRATEGY.md](architecture/TESTING_STRATEGY.md) |
| Local-first compatibility position | [architecture/LOCAL_FIRST_COMPATIBILITY.md](architecture/LOCAL_FIRST_COMPATIBILITY.md) |
| Architectural invariants (load before structural changes) | [BOUNDARIES.md](BOUNDARIES.md) |
| Layer map and cross-cutting concerns | [ARCHITECTURE.md](ARCHITECTURE.md) |
| How to run, test, and build | [COMMANDS.md](COMMANDS.md) |
| Practical gotchas | [WORKING_TIPS.md](WORKING_TIPS.md) |
| Repository-wide product and domain glossary | [GLOSSARY.md](GLOSSARY.md) |
| Runtime and extension terminology | [architecture/GLOSSARY.md](architecture/GLOSSARY.md) |

---

## 3. Architecture Map

### Product Model

| Doc | What it covers |
|---|---|
| [architecture/PRODUCT_AND_BOUNDARIES.md](architecture/PRODUCT_AND_BOUNDARIES.md) | Product identity, current enforcement points, architecture fitness checks |
| [architecture/PROJECTS.md](architecture/PROJECTS.md) | Current Project and Project Folder ownership, Project kernel, modes, lifecycle, and information flow |
| [architecture/PRODUCT_ACCEPTANCE.md](architecture/PRODUCT_ACCEPTANCE.md) | Deterministic gate, manual Project acceptance procedure, evidence requirements, and opt-in real integration smoke |
| [architecture/NON_GOALS_AND_DISABLED_SURFACES.md](architecture/NON_GOALS_AND_DISABLED_SURFACES.md) | Disabled surfaces, allowed surfaces, non-goals |
| [architecture/ROADMAP_AND_FUTURE_RISKS.md](architecture/ROADMAP_AND_FUTURE_RISKS.md) | Capability line roadmap, future risks |
| [architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md](architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md) | Capability definitions, packs, workflows, Open Skill import, runtime skill rendering |
| [architecture/CONTEXT_AND_RETRIEVAL_LAYER.md](architecture/CONTEXT_AND_RETRIEVAL_LAYER.md) | Current-state architecture for knowledge retrieval + the context layer: engine/adapter boundary, recall arms (exact/lexical/multi-hop graph/vector+ANN, max-pool, RRF, intent ranking), gated LLM stages (rerank/rewrite/synthesis), Context Brief + gap analysis, maintenance scans, explicit artifact-backed context attachments, Context Ops read models/page, egress governance, agent tool surface, invariants, Object Schema Registry/object schema implementation, and source-of-truth boundaries |
| [architecture/PROJECT_WORK.md](architecture/PROJECT_WORK.md) | Current-state Project advancement: the four state axes, the five Loop stages, the append-only work event stream and its single writer, Run settlement, and who a held Task interrupts |
| [architecture/ONTOLOGY.md](architecture/ONTOLOGY.md) | Current-state ontology layer: Entity registry and Interfaces, which domains join the ontology and why, `space_objects` root contract, link-type endpoints and per-edge governance, the single write path and its guards |
| [architecture/CLAIM_FACT_ATOM_MODEL.md](architecture/CLAIM_FACT_ATOM_MODEL.md) | Current-state model for `space_objects`, global claims/facts/takes, claim evidence, claim relations, and FK-backed `object_relations` |
| [architecture/SOURCE_CONNECTOR_CONSENT.md](architecture/SOURCE_CONNECTOR_CONSENT.md) | Source/connector consent and policy model for future ingestion-heavy context work: owner/subject/readers/agents, egress class, retention, trust, proposal-gated derived writes |
| [architecture/LOCAL_FIRST_COMPATIBILITY.md](architecture/LOCAL_FIRST_COMPATIBILITY.md) | Data classification, offline write rules, sync schema guidelines |

### Security and Access Boundaries

| Doc | What it covers |
|---|---|
| [architecture/SECURITY_AND_ACCESS_BOUNDARIES.md](architecture/SECURITY_AND_ACCESS_BOUNDARIES.md) | Auth boundary, space isolation, object visibility, session/task/activity policy, cross-space exceptions, credential secrecy, dogfooding readiness |
| [architecture/CREDENTIAL_STORAGE.md](architecture/CREDENTIAL_STORAGE.md) | How secrets are stored at rest: ModelProvider API keys (AES-256-GCM + disk master key + `secret_ref`) vs CLI login state; runtime resolution; ADR 0008 channel isolation |
| [architecture/POLICY_ENFORCEMENT_INVENTORY.md](architecture/POLICY_ENFORCEMENT_INVENTORY.md) | All current policy enforcement points; enforcement status per class |

### Backend Domains

| Doc | What it covers |
|---|---|
| [architecture/MODULES.md](architecture/MODULES.md) | Current backend module map, support packages, ownership, registries, facades |
| [architecture/MODULE_DEVELOPMENT_GUIDE.md](architecture/MODULE_DEVELOPMENT_GUIDE.md) | How to add/change backend modules and extension hooks |
| [architecture/REUSE_AND_DEPENDENCY_POLICY.md](architecture/REUSE_AND_DEPENDENCY_POLICY.md) | Mandatory pre-implementation search, reuse ladder, third-party evaluation, canonical mechanism index, parallel-implementation rule, custom-build exception |
| [architecture/DATABASE_AND_TRANSACTIONS.md](architecture/DATABASE_AND_TRANSACTIONS.md) | UnitOfWork, transaction ownership, external call boundary, PostgreSQL rules |
| [architecture/DATA_AUTHORITY_MATRIX.md](architecture/DATA_AUTHORITY_MATRIX.md) | Cross-domain data authorities, canonical writers, and read-model boundaries |
| [architecture/MEMORY_MODEL.md](architecture/MEMORY_MODEL.md) | Memory scopes, visibility, access control |
| [architecture/MEMORY_MAINTENANCE.md](architecture/MEMORY_MAINTENANCE.md) | Current Memory maintenance scan, report/packet, durable job, scheduler, and first UI surface |
| [architecture/PROPOSALS.md](architecture/PROPOSALS.md) | Proposal types, lifecycle, apply flow |
| [architecture/TASK_BOARD_MODEL.md](architecture/TASK_BOARD_MODEL.md) | Task, Board, TaskRun, TaskArtifact, TaskProposal ORM |
| [architecture/ARTIFACTS.md](architecture/ARTIFACTS.md) | Artifact lifecycle, storage paths, export |
| [architecture/READER.md](architecture/READER.md) | Shared document resolution, annotations, and Reader workspace ownership |
| [architecture/OPERATIONS_AND_SAFETY.md](architecture/OPERATIONS_AND_SAFETY.md) | Backup, restore, lifecycle states, deployment boundary, stop conditions |

### Runtime / Agents / Runs

| Doc | What it covers |
|---|---|
| [architecture/EXECUTION_MODEL.md](architecture/EXECUTION_MODEL.md) | Run, RunStep, Job, Artifact, Proposal, actor identity, credential resolver |
| [architecture/AGENT_RUNTIME_AUTHORITY.md](architecture/AGENT_RUNTIME_AUTHORITY.md) | Design-time AgentVersion versus deployment-time AgentRuntimeProfile authority |
| [architecture/RUNTIME_ADAPTER_STANDARD.md](architecture/RUNTIME_ADAPTER_STANDARD.md) | Runtime adapter contract, isolation, conformance, and lifecycle standard |
| [architecture/RUNS_AND_OUTPUTS.md](architecture/RUNS_AND_OUTPUTS.md) | Run outputs, materialization, boundaries |
| [architecture/VERIFICATION_ENGINE.md](architecture/VERIFICATION_ENGINE.md) | A2 deterministic verification lifecycle, result authority, and deferred verifier types |
| [architecture/PLAN_GRAPH_EXECUTION.md](architecture/PLAN_GRAPH_EXECUTION.md) | Task-first Agent Planning, Plan Nodes, fixed Workflow Execution, bounded approval, scheduling, and reconciliation |
| [architecture/ROUTING.md](architecture/ROUTING.md) | C2 deterministic model–runtime candidate filtering, scoring, fallback, and run stamping |

### Server / Backend

| Doc | What it covers |
|---|---|
| [architecture/PROTOCOL_FOUNDATION.md](architecture/PROTOCOL_FOUNDATION.md) | Contracts-only protocol package |
| [architecture/SERVER_FOUNDATION.md](architecture/SERVER_FOUNDATION.md) | The server service: gateway, route registry, compose wiring |
| [architecture/SERVER_OWNERSHIP.md](architecture/SERVER_OWNERSHIP.md) | Current server ownership and deferred surfaces |
| [architecture/SERVER_MODULE_CONVENTION.md](architecture/SERVER_MODULE_CONVENTION.md) | Server-owned module structure, route registry, error envelope |
| [architecture/SYSTEM_ACTIONS.md](architecture/SYSTEM_ACTIONS.md) | System action registry, gateway exposure, policy, proposal, grant, idempotency, and audit boundaries |
| [architecture/OFFICIAL_OPTIONAL_MODULES.md](architecture/OFFICIAL_OPTIONAL_MODULES.md) | Official optional-module packaging, enablement, migrations, and host boundaries |

### Memory / Activity / Proposal

| Doc | What it covers |
|---|---|
| [architecture/MEMORY_ACTIVITY_PROVENANCE.md](architecture/MEMORY_ACTIVITY_PROVENANCE.md) | Activity-first capture, provenance chain, trust gate, memory write boundaries |
| [architecture/MEMORY_CONTEXT_RUNTIME.md](architecture/MEMORY_CONTEXT_RUNTIME.md) | Current Memory-to-context runtime assembly, authorization, snapshots, and injection boundaries |
| [architecture/MEMORY_MODEL.md](architecture/MEMORY_MODEL.md) | Memory scopes, visibility, access control |
| [architecture/SHARED_SPACE_MEMORY_ISOLATION.md](architecture/SHARED_SPACE_MEMORY_ISOLATION.md) | Design proposal: shared system assistant + per-user memory isolation in multi-member spaces (personal vs space tier, promotion-gated sharing) |
| [architecture/PROPOSALS.md](architecture/PROPOSALS.md) | Proposal types, lifecycle, apply flow |
| [architecture/MEMORY_EVOLUTION_PLAN.md](architecture/MEMORY_EVOLUTION_PLAN.md) | Planned Memory-quality work after Knowledge-first retrieval: duplicate signals, ranking, synthesis + gap loop, consolidation cycle |
| [architecture/EVOLUTION_SIGNAL_SYSTEM.md](architecture/EVOLUTION_SIGNAL_SYSTEM.md) | Current rule-based evolution signal emitters, target resolution, deduplication, A2 verification facts, and deferred A3/C3 hooks |

### Sources / Evidence / Provenance

| Doc | What it covers |
|---|---|
| [architecture/SOURCE_EVIDENCE_FOUNDATION.md](architecture/SOURCE_EVIDENCE_FOUNDATION.md) | Source evidence data model, extraction lifecycle, reader artifacts, and accepted evidence boundaries |
| [architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md](architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md) | Custom Source handler registry, configuration, execution, and safety boundaries |
| [architecture/SOURCE_PROVENANCE_MATRIX.md](architecture/SOURCE_PROVENANCE_MATRIX.md) | Source ingestion and derivation provenance requirements by materialization path |

### Project Folder / Sandbox / Artifact

| Doc | What it covers |
|---|---|
| [architecture/ARTIFACTS.md](architecture/ARTIFACTS.md) | Artifact lifecycle, storage paths, export |
| [architecture/EXECUTION_MODEL.md](architecture/EXECUTION_MODEL.md) | Sandbox selection, worktree vs Docker, PathPolicy |

### Frontend Information Architecture

The frontend module registry (`apps/web/src/modules/registry.ts`) and shell (`apps/web/src/core/Shell.tsx`)
are source of truth for active nav and routes. For UI decisions, see the module docs below:

| Doc | What it covers |
|---|---|
| [architecture/FRONTEND_INFORMATION_ARCHITECTURE.md](architecture/FRONTEND_INFORMATION_ARCHITECTURE.md) | Frontend role, dogfooding loop, home direction, module visibility, empty-state policy |
| [architecture/MANUAL_ACCEPTANCE_TASK_PLAN_WORKFLOW.md](architecture/MANUAL_ACCEPTANCE_TASK_PLAN_WORKFLOW.md) | Clickable manual acceptance paths for Task planning, Agent Plans, and fixed Workflow Automation |
| [modules/product-shell.md](modules/product-shell.md) | Shell, NavRail, CommandPalette, PanelLayout |
| [modules/frontend-layout.md](modules/frontend-layout.md) | Responsive layout, mobile variants |
| [modules/client-server-protocol.md](modules/client-server-protocol.md) | REST, WebSocket, SSE, offline queue protocol |
| [modules/activity-inbox.md](modules/activity-inbox.md) | Activity inbox UI and quick capture |
| [modules/graph-view.md](modules/graph-view.md) | Shared GraphProjection contract, graph renderer boundary, core Graph page, Project graph lens consumption |

### Testing Strategy

| Doc | What it covers |
|---|---|
| [architecture/TESTING_STRATEGY.md](architecture/TESTING_STRATEGY.md) | Test layers, product invariant philosophy, what each layer covers |

---

## 4. Module Map

Load only the module docs relevant to your task.

| Task area | Module doc |
|---|---|
| Space / user / Project Folder data model | [modules/space.md](modules/space.md) |
| Agent profiles, runs, adapters | [modules/agents.md](modules/agents.md) |
| Rooms (project-bound multi-party conversation, agent dispatch) | [modules/rooms.md](modules/rooms.md) |
| Automations (manual/schedule/event triggers, project binding) | [modules/automations.md](modules/automations.md) |
| Always-on candidate discovery and autonomous execution | [modules/autonomy.md](modules/autonomy.md) |
| Long-term memory | [modules/memory.md](modules/memory.md) |
| Raw input and event capture | [modules/activity.md](modules/activity.md) |
| Activity inbox UI and quick capture | [modules/activity-inbox.md](modules/activity-inbox.md) |
| Source connections, ingestion, extraction, and Project bindings | [modules/sources.md](modules/sources.md) |
| Sources-derived reading library | [modules/library.md](modules/library.md) |
| Personal and Project information digests | [modules/information-digest.md](modules/information-digest.md) |
| Personal assistant and capture | [modules/assistant-capture.md](modules/assistant-capture.md) |
| Memory review UI | [modules/memory-review.md](modules/memory-review.md) |
| Policy and permission engine | [modules/policy.md](modules/policy.md) |
| Proposal / approval system | [modules/proposals.md](modules/proposals.md) |
| Capability lifecycle | [modules/capability.md](modules/capability.md) |
| Runtime Context acquisition, planning, delivery, and continuity | [modules/runtime-context.md](modules/runtime-context.md) |
| Sandbox execution | [modules/sandbox.md](modules/sandbox.md) |
| Execution hosts (control plane + host daemon), pairing, workspace registration | [modules/hosts.md](modules/hosts.md) |
| Project Folder browser / file UI | [modules/project-files.md](modules/project-files.md) |
| Runtime tools / adapter types | [modules/runtime-adapters.md](modules/runtime-adapters.md) |
| Credentials | [modules/credentials.md](modules/credentials.md) |
| Deployment | [modules/deployment.md](modules/deployment.md) |
| Knowledge Base / knowledge items | [modules/knowledge-base.md](modules/knowledge-base.md) |
| Relationships / people and organizations | [modules/relations.md](modules/relations.md) |
| Spaced repetition / cards | [modules/spaced-repetition.md](modules/spaced-repetition.md) |
| Media cards | [modules/media-cards.md](modules/media-cards.md) |
| Graph view / relationship visualization | [modules/graph-view.md](modules/graph-view.md) |
| Sync and conflict model | [modules/sync-and-conflicts.md](modules/sync-and-conflicts.md) |
| Mobile client | [modules/mobile-client.md](modules/mobile-client.md) |
| Server status bar | [modules/server-status.md](modules/server-status.md) |
| Git diff review | [modules/git-diff-review.md](modules/git-diff-review.md) |
| Provider / LLM policy | [modules/provider-policy.md](modules/provider-policy.md) |
| Commercialization | [modules/commercialization.md](modules/commercialization.md) |

---

## 5. Decision Records

| ADR | Summary |
|---|---|
| [0001](decisions/0001-space-model.md) | Space as product-level isolation boundary |
| [0002](decisions/0002-agent-model.md) | Agent is a separate model from User |
| [0003](decisions/0003-memory-proposal-flow.md) | Agent memory writes are bounded, versioned and reviewable after; a person pre-approves only writes that widen reach (visibility, sensitivity, another person, human-authored content) or come from an unattended origin (rewritten 2026-08-28 under ADR 0017) |
| [0004](decisions/0004-context-wrapper.md) | Vendor context files and vendor runtime sessions are never source of truth; repository guides are development-time material only |
| [0005](decisions/0005-desktop-runtime.md) | The desktop is a browser client or an ADR 0016 execution host, never the control plane; Tauri scaffold kept but unbuilt |
| [0006](decisions/0006-plugin-module-architecture.md) | Module architecture (ServerModule registry, MODULE_REGISTRY) and official optional module control plane (PluginHost, diary) |
| [0007](decisions/0007-multi-cli-mvp.md) | Managed multi-CLI runtime usage: one ACP controller for every local CLI, three-layer Agent/Adapter/Provider separation, explicit model selection modes, exact-where-possible usage accounting, three surfaces (task, conversation, Room), sandbox ladder enforced below the vendor |
| [0008](decisions/0008-credential-channel-isolation.md) | Credential channel isolation |
| [0009](decisions/0009-capability-workflow-open-skill-system.md) | Capability, Workflow, and Open Skill framework |
| [0010](decisions/0010-agent-workbench-product-direction.md) | Personal + small-team Agent Workbench direction, dual funding paths, ACP-peer CLI runtime stance |
| [0011](decisions/0011-inquiry-domain-model.md) | Project domain aggregate roots (Inquiry Thread, Experiment, Decision Case) are `space_objects` rows; their internal tables stay domain-private; cross-aggregate edges use `object_relations`; `WorkflowExecution` node_kind extended for Action/Model/Checkpoint. Rewritten 2026-08-04 — decisions 1-3 reversed by ADR 0012 |
| [0012](decisions/0012-ontology-ownership-and-language-alignment.md) | `ontology` module owns `space_objects`/`object_relations`/object profiles; root contract drops `status`; aggregate-root membership rule; definition authority is code in registerable registries; Interface as an explicit primitive; Link Type / Object Profile naming; Action `applies_to` |
| [0013](decisions/0013-personal-team-content-boundary.md) | Personal vs team content boundary: creation context decides Space/scope/visibility, capture lands in the personal Space, filing is a transformation, Run-level context taint narrows derived output, cross-person read auditing; amends ADR 0001 for per-user aggregated cross-Space reads |
| [0014](decisions/0014-unified-runtime-context-engine.md) | Accepted clean cutover to one Runtime Context Gateway for Agent task context, with separate Retrieval/Policy/Usage authorities, typed deliveries, event/checkpoint continuity, product-owned Project context, and per-work-scope CLI isolation |
| [0015](decisions/0015-focus-area-classification.md) | Focus area is a user-created classification, not a second access scope: it aggregates Projects/Notes/Knowledge, participates in no access decision, and is told apart from a module by whether the thing needs code. Internal identifier `focus_area`; `domain` is reserved for this codebase's DDD vocabulary |
| [0016](decisions/0016-control-plane-execution-hosts.md) | An instance is one control plane plus N execution hosts (`hosts` table; every Project Folder bound to one host); two-tier trust — server host keeps strict sandbox isolation unchanged, a paired personal host runs a thin daemon in trusted-host mode (native execution, no sandbox, own login state); paths are host-owned, never control-plane authority; remote propose→apply governance for in-place execution is explicitly deferred, not settled |
| [0017](decisions/0017-authorization-by-cost-not-authorship.md) | Authorization follows cost, reversibility, exposure and trigger origin — not authorship: an exhaustive hard-gate list (self-modification, reach-widening memory, real checkout, exposure, money above bounded defaults, credentials/deployment, Project direction) is pre-approved per instance; every other Project-internal write executes from a `manual` origin under bounds (fan-out ≤ 5/turn, spend at the pipeline default with the remainder offered once) and is reviewed after via Updates with undo; a default flips from proposal to direct only once that review exists |

---

## 6. Current Work

Planned work lives in the documents below, each with one job, plus one
specification per active convergence under `plans/`. Reorganized 2026-08-13 from
six overlapping files; a specification is retired into current-state
architecture and the defer register once nothing in it can be advanced.

| Document | Holds |
|---|---|
| [plans/backlog.md](plans/backlog.md) | Real work with no trigger condition, pulled on demand |
| [tasks/deferred-register.md](tasks/deferred-register.md) | Everything waiting on a recorded trigger, the standing enablement gates, watch items, and parked ideas — including this repo's "Project kernel — P2" section: the Machine/ExecutionHost/WorkspaceLocation topology plan's deferred Project-control-plane decisions (`primary_mode` deletion, registry merge, Project Steward, Room). That plan's P0 (cleanup) and P1 (topology, Task-as-spine dispatch) shipped and are retired — commits `d0b6b3c5`, `0dcd91ca`. |
| [plans/unattended-execution-hardening-plan.md](plans/unattended-execution-hardening-plan.md) | The unattended execution specification — DEFERRED; entry evidence is expected to come from the retired execution-topology plan's P1 real-usage window |
| Ambient CLI session import (a paired host's own Claude Code / Codex / OpenCode history for a bound folder) | Shipped and retired 2026-08-28 (`293023c3`, `d162aabf`, `178bd9a8`; ledger in git history). Current state: [modules/imported-sessions.md](modules/imported-sessions.md); leftovers in [plans/backlog.md](plans/backlog.md) §9 |
| Remote-host provider binding (host×adapter provider binding, proxy reachability, daemon-side materialization) | Shipped and retired 2026-08-28 (`404b1b87` and following; ledger in git history). Current state: [modules/hosts.md](modules/hosts.md) "Model-backend binding"; open real-host acceptance in [tasks/deferred-register.md](tasks/deferred-register.md) (multi-host section); actionable leftovers in [plans/backlog.md](plans/backlog.md) §8 |

Do not create competing task files, and do not reintroduce a "current focus"
document. One existed and was removed: a file whose job is to declare what is
being worked on requires continuous maintenance that never happened, so it
repeatedly declared work nobody was doing — which is worse than declaring
nothing. What is scheduled is visible in Git and in the plan documents
themselves. Observable instance state (what is installed, what has run, what has
failed) is not written down at all; query the instance, because a recorded
snapshot only rots. An approved multi-phase implementation may keep a
short-lived execution ledger under `plans/`, but it is retired into current-state
architecture as soon as its phases are complete.

---

## 7. Reports Policy

`.agent/reports/` is for temporary audits and one-off investigations only.

Rules:
- Reports are not source of truth for architecture, policy, or design.
- Once the durable content of a report is consolidated into `.agent/architecture/` or a
  decision record, the report should be deleted.
- AI agents must not load reports as authoritative context.
- Do not reference temporary reports from architecture docs or `context-bundles.yaml`.

Long-term architecture information must live in `.agent/architecture/` or `.agent/decisions/`.

---

## 8. Context Loading Guidance for Agents

Use the smallest relevant bundle from [context-bundles.yaml](context-bundles.yaml). Do not
load all docs for every task.

| Task type | Load |
|---|---|
| Security / access change | `security-access` bundle: `SECURITY_AND_ACCESS_BOUNDARIES.md`, `POLICY_ENFORCEMENT_INVENTORY.md`, `TESTING_STRATEGY.md`, `BOUNDARIES.md` |
| Backend domain change | `backend-domain` bundle: relevant domain doc + `DATABASE_AND_TRANSACTIONS.md` + `BOUNDARIES.md` |
| Frontend / home / UI change | `frontend-product` bundle: `product-shell.md`, `frontend-layout.md`, `client-server-protocol.md`, module doc |
| Any new subsystem, shared mechanism, or new dependency | `REUSE_AND_DEPENDENCY_POLICY.md` + the owning module doc |
| Testing change | `TESTING_STRATEGY.md` + the specific test file's domain doc |
| Runtime / agent / run change | `runtime-agent` bundle: `EXECUTION_MODEL.md`, `RUNS_AND_OUTPUTS.md`, `agents.md`, `BOUNDARIES.md` |
| Memory / activity / proposal change | `memory-activity-proposal` bundle: `MEMORY_ACTIVITY_PROVENANCE.md`, `MEMORY_MODEL.md`, `PROPOSALS.md` |
| Project Folder / artifact / path change | `project-folder-artifact` bundle: `ARTIFACTS.md`, `EXECUTION_MODEL.md`, `sandbox.md`, `project-files.md` |
| Dogfooding / product slice | `tasks/deferred-register.md` + `PRODUCT_AND_BOUNDARIES.md` + `NON_GOALS_AND_DISABLED_SURFACES.md` |
| Picking up planned work | `plans/backlog.md` + `tasks/deferred-register.md` |
| Sync / offline / local-first compatibility | `local-first-compatibility` bundle: `LOCAL_FIRST_COMPATIBILITY.md`, `sync-and-conflicts.md`, `mobile-client.md` |

Additional agent rules:
- Never write to `instance/` from code in `core/`.
- Never write active memory directly — use proposals.
- Never turn Runtime Context into vendor context files; adapters consume the accepted Delivery directly.
- Read `BOUNDARIES.md` before making structural changes.
- Search for an existing implementation, dependency, and test fixture before building a new one;
  `architecture/REUSE_AND_DEPENDENCY_POLICY.md` is the source of truth for that decision.
- New backend routes go in `server/src/modules/<module>/routes.ts` and
  the module is registered in `server/src/gateway/routeRegistry.ts`.
- New frontend pages go in `apps/web/src/modules/<module>/`, registered in
  `apps/web/src/modules/registry.ts`.
- Do not treat `.agent/reports/` content as durable source of truth.
- `.agent/architecture/` docs describe **current state**. Do not add target-state aspirations
  without a scoped implementation task.
- `server/test/agentGuides.test.ts` keeps bundle targets, relative links, INDEX coverage,
  and the shared core of `AGENTS.md` / `CLAUDE.md` from drifting. Update the canonical
  guide structure and its invariant together when intentionally changing these rules.

---

## 9. Vendor Context and Conversion Plan

**Current state:** `CLAUDE.md` and `AGENTS.md` are hand-maintained adapter files that point
AI coding assistants toward the right entry points. They are not canonical architecture docs.

**Intended future model:**

| Source (canonical) | Generated output |
|---|---|
| `.agent/INDEX.md` | Section headers in `CLAUDE.md` / `AGENTS.md` |
| `.agent/context-bundles.yaml` | Task-type context directives in vendor files |
| `.agent/architecture/*.md` | Current-state architecture constraints for repository work; never implicit runtime prompt input |

Generated files (`CLAUDE.md`, `AGENTS.md`, sandbox prompt files, runtime-specific context
files) are **disposable adapter outputs**, not canonical docs. When they conflict with
`.agent/architecture/`, the architecture docs win. See [ADR 0004](decisions/0004-context-wrapper.md).
