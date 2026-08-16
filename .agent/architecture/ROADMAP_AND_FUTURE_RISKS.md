# Roadmap and Future Risks

This document is a roadmap and risk watch only. It should not duplicate current
implementation inventory. For current state, use the linked source-of-truth docs;
code and migrations still win over documentation.

---

## Source Pointers

| Area | Current-state source |
|---|---|
| Product boundaries | [PRODUCT_AND_BOUNDARIES.md](PRODUCT_AND_BOUNDARIES.md), [NON_GOALS_AND_DISABLED_SURFACES.md](NON_GOALS_AND_DISABLED_SURFACES.md) |
| Server ownership | [SERVER_FOUNDATION.md](SERVER_FOUNDATION.md), [SERVER_OWNERSHIP.md](SERVER_OWNERSHIP.md), [MODULES.md](MODULES.md) |
| Runtime, runs, artifacts | [EXECUTION_MODEL.md](EXECUTION_MODEL.md), [RUNS_AND_OUTPUTS.md](RUNS_AND_OUTPUTS.md), [ARTIFACTS.md](ARTIFACTS.md), [../modules/runtime-adapters.md](../modules/runtime-adapters.md) |
| Policy and security | [POLICY_ENFORCEMENT_INVENTORY.md](POLICY_ENFORCEMENT_INVENTORY.md), [SECURITY_AND_ACCESS_BOUNDARIES.md](SECURITY_AND_ACCESS_BOUNDARIES.md), [../modules/policy.md](../modules/policy.md) |
| Credentials | [CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md), [../modules/credentials.md](../modules/credentials.md), [../modules/provider-policy.md](../modules/provider-policy.md), [../decisions/0008-credential-channel-isolation.md](../decisions/0008-credential-channel-isolation.md) |
| Memory, context, provenance | [MEMORY_MODEL.md](MEMORY_MODEL.md), [MEMORY_CONTEXT_RUNTIME.md](MEMORY_CONTEXT_RUNTIME.md), [MEMORY_ACTIVITY_PROVENANCE.md](MEMORY_ACTIVITY_PROVENANCE.md), [MEMORY_EVOLUTION_PLAN.md](MEMORY_EVOLUTION_PLAN.md) |
| Context and retrieval layer | [CONTEXT_AND_RETRIEVAL_LAYER.md](CONTEXT_AND_RETRIEVAL_LAYER.md), [SOURCE_CONNECTOR_CONSENT.md](SOURCE_CONNECTOR_CONSENT.md) |
| Sources and evidence | [SOURCE_EVIDENCE_FOUNDATION.md](SOURCE_EVIDENCE_FOUNDATION.md), [../modules/activity.md](../modules/activity.md), [../modules/activity-inbox.md](../modules/activity-inbox.md) |
| Proposals and tasks | [PROPOSALS.md](PROPOSALS.md), [TASK_BOARD_MODEL.md](TASK_BOARD_MODEL.md), [../modules/proposals.md](../modules/proposals.md) |
| Operations | [OPERATIONS_AND_SAFETY.md](OPERATIONS_AND_SAFETY.md), [DATABASE_AND_TRANSACTIONS.md](DATABASE_AND_TRANSACTIONS.md) |
| Frontend | [FRONTEND_INFORMATION_ARCHITECTURE.md](FRONTEND_INFORMATION_ARCHITECTURE.md), [../modules/product-shell.md](../modules/product-shell.md), [../modules/frontend-layout.md](../modules/frontend-layout.md) |
| Local/offline compatibility | [LOCAL_FIRST_COMPATIBILITY.md](LOCAL_FIRST_COMPATIBILITY.md), [../modules/sync-and-conflicts.md](../modules/sync-and-conflicts.md), [../modules/mobile-client.md](../modules/mobile-client.md) |

---

## Capability Roadmap

### 1. Dogfooding Stabilization

The product target is the personal + household/small-team Agent Workbench in ADR 0010, not
a single-user memory product. The rolling 30-day checkpoint requires two real human members,
three substantial outcomes and one shared-space workflow per week, plus one friction-driven
fix per week.

**Next work**
- Collect incidents from real personal/household/small-team work.
- Expand contract tests only where dogfooding exposes real gaps.
- Rehearse backup and restore on a schedule.

**Prerequisites**
- Current auth, backup, run, proposal, and memory boundaries remain green.

**Risk watch**
- Fixes made during dogfooding can bypass source-of-truth docs or policy gates.
- Backup confidence can drift if restore is not rehearsed.

**Not now**
- More users, remote hosting, public launch.

---

### 2. Retrieval and Context & Retrieval Layer Stabilization

**Current blocker state**
- No current P0/P1 blocker is known for first dogfooding.
- The next work is dogfooding, tests, calibration, and quality enhancement of
  implemented retrieval/context-layer surfaces. It is not another external retrieval
  absorption phase.

**Supported first dogfood scope**
- Knowledge retrieval.
- Context Brief.
- Ask Space.
- Source policy.
- Memory opt-in retrieval.
- Project public summary retrieval.
- Context Ops maintenance and object schema suggestions.

**Out of scope for first dogfood**
- True BM25.
- Non-default ANN.
- Semantic chunking.
- Broad connector refresh/purge edge cases.
- Automatic automatic context review canonical writes.

**Deferred quality work**
- True BM25 via a deliberate search-stack decision.
- ANN for non-default embedding dimensions beyond the shipped default-dimension
  halfvec HNSW path.
- Semantic or title-aware chunking beyond the current fixed chunk slices.
- Optional LLM intent refiner. Intent must not widen eligibility or bypass read
  gates.
- Richer diagnostics and proposal authoring from reviewed diagnostics/finding
  rows.

**Maintenance / Context Review load**
- Maintenance and Context Review outputs must stay batched, clustered, and
  confidence-tiered. They should create review packets and artifacts, not one
  proposal per finding.
- Conservative defaults: bounded scan limits, explicit review queues,
  retention metadata on artifacts/reports, and a manual review cadence before
  broader scheduled use.
- Context Review and maintenance scans must not add automatic paths that write canonical
  Knowledge, Claims, Object Relations, Project summaries, or Memory rows.
- Memory maintenance packets intentionally remain two-step: accepting the packet
  creates child `memory_archive` / `memory_update` proposals, and canonical
  Memory changes still require normal proposal review.

**Rejected / non-goals (not backlog)**
- External retrieval runtime dependency or repository as an Agent Space source of
  truth.
- Dynamic schema-pack runtime or per-call schema-pack overrides.
- Default external MCP retrieval server as the context interface.
- Context Review/maintenance automatic canonical writes.
- Direct application of Memory maintenance packet child proposals on packet
  acceptance.
- Silent Memory/Knowledge merging or automatic promotion between Memory,
  Knowledge, Claims, and Project public summaries.

**Prerequisites**
- Search, Context Brief, Ask Space, Memory opt-in retrieval, Project public
  summary retrieval, Source policy, and Context Ops tests remain green.
- Ranking and diagnostics signals continue to use only visible candidates or
  access-neutral metadata.

**Risk watch**
- Calibration can leak hidden/private candidates if any ranking or diagnostic
  stage uses pre-revalidation top scores, hidden counts, dropped ids, or private
  titles.
- Maintenance/Context Review value can be lost if packet volume overwhelms review.

---

### 3. Runtime and Adapter Safety

OpenCode is a third optional CLI runtime alongside Claude Code and Codex CLI. CLI subscription
allowance and managed APIs remain dual primary resources, but this roadmap defines no
OpenCode-first Router preference and does not route the managed API path through OpenCode.

**Next work**
- Implement the planned OpenCode adapter after C1 and run the normal CLI conformance gates.
- Operate and harden the implemented `one_shot_docker` path: add a reviewed
  egress-enabled profile only if critical CLI workloads require provider
  networking; the current MVP remains `--network none` and fail-closed.
- Add external webhook/cron trigger integration only behind preflight and policy gates.
- Decide whether cross-process subprocess termination is needed after more real CLI runs.

**Prerequisites**
- Existing `model_api`, `claude_code`, and `codex_cli` paths remain stable.
- Credential resolver, worktree sandboxing, RunStep/RunEvent evidence, and preflight stay tested.

**Risk watch**
- New adapters can duplicate or bypass credential, sandbox, and policy behavior.
- Critical-risk execution must fail closed until Docker isolation is actually implemented.
- Provider fallback must record the actual provider/model used so route evidence
  is not attributed to the requested binding after a substitution.
- CLI usage remains unavailable for runtimes that do not expose parseable usage;
  cost-based retry supervision must treat that uncertainty explicitly.
- Managed-provider cancellation currently relies on discarding late results;
  propagate abort support before treating it as reliable execution cancellation.
- Keep Codex CLI at conservative trust. Runtime-internal subagent control stays
  unverified and is no longer required to change — see the delegation boundary
  in [EXECUTION_MODEL.md](EXECUTION_MODEL.md) for why low trust is the accepted
  price rather than a gap.

**Not now**
- Docker sandbox pool, production container infrastructure, broad runtime marketplace.

---

### 4. Policy and Governance Expansion

**Next work**
- Wire reserved actions only when their product surfaces exist: capability enable/update, tool binding, artifact/evidence export, deployment proposal/execute.
- Current credential baseline: ModelProvider keys and CLI login profiles are
  user-owned resources with explicit active-space grants. Add per-run or
  per-tool credential scoping only after this grant boundary remains stable.
- CLI runtime tool installs are instance-admin-managed shared binaries. Space
  policy chooses enabled/default/allowed installed versions; credential grants
  remain user-owned and separate from tool installation.
- Keep policy tests focused on fail-closed behavior and audit durability.

**Prerequisites**
- `proposal.apply`, runtime gates, Project Folder read/write gates, artifact persistence gates, and credential gates stay centralized through the policy module.

**Risk watch**
- Policy can become scattered if new surfaces authorize directly.
- Overbuilding RBAC/ABAC too early can obscure the simpler product approval model.

**Not now**
- Full enterprise RBAC/ABAC, policy editor UI, policy DSL, agent-to-agent delegation.

---

### 5. Memory, Context, Sources, and Evidence Quality

**Next work**
- Implement planned memory-quality phases from [MEMORY_EVOLUTION_PLAN.md](MEMORY_EVOLUTION_PLAN.md) only through proposal-safe flows.
- Extend connector-specific ingestion behind Sources/Evidence lifecycle.
- Add synthesis and gap-analysis loops only when citations and proposal review stay explicit.

**Prerequisites**
- Activity-first capture, provenance links, source trust, context assembly, and proposal apply boundaries stay intact.

**Risk watch**
- External evidence can pollute trusted Memory if candidate and proposal boundaries are skipped.
- Context quality work can become untestable if it mixes retrieval, synthesis, and durable writes.

**Not now**
- Broad web crawling, vector index over external corpora, auto-promotion of external content to Memory.

---

### 6. Automation and Triggers

**Current state**
- Manual and scheduled Automations are separate from source
  post-processing. Sources owns `source.items_materialized` handling through
  source post-processing rules, with min-new-items, cooldown, per-event backlog
  drain caps, cursor-safe batched runs, relevance screening, candidate evidence,
  review proposals, and persisted item decisions. The cooldown/backlog cap are
  the minimal form of the P9 trigger-budget vocabulary.
- The Automation UI now also exposes versioned Workflow targets with explicit
  pin/follow resolution and input JSON. Scheduled Workflow targets are forced
  to pin a version; server-side asset ownership, version scope, policy, and
  budget checks remain authoritative.

**Next work**
- Design external trigger registry after manual/scheduled/internal-event automation behavior is stable.
- Add run caps, cost guardrails, and user-facing credential allowance UX before broad background execution.
- Keep automation-origin runs on the same preflight and policy path as manual runs.
- Decision 1-B (2026-07-11, formerly recorded in the now-retired orchestration
  plan):
  the two hardcoded automation fire paths (`knowledge_retrieval_maintenance`,
  context review cycle in `automations/service.ts`) are frozen — no new
  hardcoded business fires may be added. Re-evaluate migrating them to system
  workflow definitions (or explicitly retiring them as documented native
  targets) once versioned workflow graph execution (plan Track B2/B3) is
  stable. Do not let the freeze silently become permanent.

  **Amended 2026-07-26 — re-evaluation done; the migration option is
  withdrawn.** A Workflow is a *user-facing* process that users choose to run,
  declaring an input schema and output artifact types and moving through the
  evolvable-asset approval path. Both frozen paths — and the
  planned `autonomous_tick` — are maintenance/control-plane jobs with none of
  those properties, so migrating them would surface them in user-facing
  Workflow panels and force control flow into a bounded data-flow DAG. The
  standing rule is now: a domain process a user chooses to run is an approved
  `workflow_definition.v1` version; a maintenance or control-plane job the user
  only switches on or off is a **registered native Automation target**. The freeze is
  replaced by a declarative target registry with a frozen fixture and a
  drift test, which is what actually prevents a new unregistered hardcoded
  fire. See [the current Automation module architecture](../modules/automations.md).

**Prerequisites**
- Automation create/update/fire gates, preflight snapshots, and credential behavior remain auditable.

**Risk watch**
- Background work can silently mutate data if ownership, policy, or proposal gates are weakened.
- Credential fallback in automation paths must stay blocked.

**Not now**
- Arbitrary background jobs, external event trigger marketplace, critical-risk automation without Docker isolation.

---

### 7. Operations, Backup, Retention, and Export

**Next work**
- Define offsite backup procedure, starting with manual encrypted archive transfer.
- Schedule restore rehearsal and record operator checklist gaps.
- Define bulk Memory export and retention/delete semantics.

**Prerequisites**
- Full-system backup/restore remains consistent across database and file storage.
- Artifact and memory lifecycle states remain stable enough to export.

**Risk watch**
- Local-only backups are a single-site data-loss risk.
- Hard-delete semantics can conflict with audit/provenance if not designed explicitly.

**Not now**
- Automatic cloud sync, automatic restore, global hard-delete automation.

---

### 8. Frontend Command Center

**Next work**
- Build review inbox aggregate and continue-working surfaces from runs, tasks, proposals, and artifacts.
- Resolve frontend/backend type contract drift before adding new UI workflows.
- Keep planned modules visibly disabled until backend surfaces are real.

**Prerequisites**
- Backend aggregate APIs are stable and documented.
- Shell/module registry remains the source of truth for active frontend surfaces.

**Risk watch**
- Frontend can imply capabilities that are not active if planned modules become interactive too early.
- Frontend-only business rules can drift from server policy.

**Not now**
- Native mobile app, advanced offline queue, frontend-only permission inference.

---

### 9. Learning and Evolution Loop

**Next work**
- Run managed dogfood flows against real Project Folders before automating more of the loop.
- Validate RunReflection and proposal payload quality through human review.
- Keep automatic system self-evolution removed; Evolution execution must continue to require
  an explicitly selected ordinary Agent.
- The Always-on evolution/autonomy loop is delivered; current-state behavior
  lives in [autonomy.md](../modules/autonomy.md) and
  [automations.md](../modules/automations.md). Remaining
  planning/routing/verification follow-ups (A2.1, B4.1, D1.2) live in
  [backlog.md](../plans/backlog.md).
- Decision 2-B (2026-07-11): the evolvable-asset promotion evaluation gate
  starts **warn-only**. When an asset type accumulates enough evaluation
  cases (threshold set in plan Track D2), high/critical-risk promotions for
  that type must switch to a **hard gate** (missing/failed evaluation blocks
  apply). Warn-only must not become the permanent state — revisit at each
  D2 milestone.
- D2 MVP (2026-07-12): evaluation cases and queued Verification Engine
  fixture execution are live. Promotion proposals carry an explicit
  `warn_only`/`hard_gate` policy; the default remains warn-only, high/critical
  assets automatically switch after five active cases, and the hard gate
  trusts only executor-produced `verification_engine.v1` results.
  The fixture executor is intentionally read-only/mock-connector only until
  sandboxed candidate execution is added.
- The `/evolution` UI now creates candidate versions, edits drafts, transitions
  candidate/testing versions, creates Evaluation Cases, queues evaluations
  against existing successful candidate Runs, shows evidence, and creates the
  proposal-backed Promotion flow. Automatic candidate-run launch remains D2.1,
  which as of 2026-07-26 is merged into the Always-on autonomous work section
  of the orchestration plan as an `evaluation_candidate` candidate kind rather
  than a separate launch mechanism.
- Decision 3-B (2026-07-11): artifact user-edit/revision tracking is
  deferred. Proposal reject/request-changes signals are the interim
  user-correction evidence. Design an artifact revision model (who edited,
  diff storage, link to producing run) when dogfooding shows repeated manual
  corrections to run outputs; it is the prerequisite for `user_correction`
  evolution signals covering direct artifact edits.

**Prerequisites**
- Run finalization, task evaluation bridge, artifacts, proposals, and source monitoring remain auditable.
- Deployment remains host-deployer-only and proposal-gated.

**Risk watch**
- Self-evolution can expand scope or deployment authority if proposal and evaluation gates are bypassed.
- Learning proposals can become noisy if RunReflection quality is not validated against real tasks.

**Not now**
- Direct self-modifying agents, app-container deployment control, plugin marketplace, full native coding-agent loop.

---

## External Absorption Backlog

Items from the PilotDeck (P*) and Hermes (H*) review that are deferred, not
rejected. Each maps to a capability section above. Rejected items are listed
at the end.

P3 status: fully absorbed into current state and no longer a roadmap item. This
covers the TS context engine, the chat conversation-window baseline, managed-API
`messages[]` normalization, and Runtime Context's canonical event/checkpoint
continuity. For the implementation see
[MEMORY_CONTEXT_RUNTIME.md](MEMORY_CONTEXT_RUNTIME.md) and
[SERVER_OWNERSHIP.md](SERVER_OWNERSHIP.md). The only related deferred item is
tool-call message preservation in conversation windows, tracked under P6/P7
(it depends on the tool scheduler).

| Item | Description | Maps to |
|---|---|---|
| H3 | Provider privacy/compliance policy: data-collection deny, provider allow/deny, required parameter rules. Add as space-scoped policy/provider-routing rules, not global config. | Capability 4 (Policy and Governance) |
| P2 | Per-session chat concurrency guard. Add only if real chat ordering issues appear during dogfooding. | Capability 1 (Dogfooding Stabilization) |
| P6/P7 | Self-hosted TS agent loop (AgentSession/TurnRunner/AgentLoop), tool scheduler (sequential/concurrent with observability) including tool-call (`tool_use`/`tool_result`) message preservation in conversation windows, MCP client integration. `RuntimeToolBinding` remains the authorization surface until then. | Capability 3 (Runtime and Adapter Safety) |
| P8 | Channel adapters: IM/email/channel ingestion with external-session mapping. Requires stable source/evidence provenance and proposal boundaries first. | Capability 6 (Automation and Triggers) |
| P9 | Always-On governance: trigger budgets and cooldowns. Future automation/policy vocabulary. | Capability 6 (Automation and Triggers) |

**Explicitly rejected (not to be revisited without a new decision):**
- PilotDeck-style secrets in YAML or `${ENV}` substitution.
- Global single-scope config that ignores `space_id`.
- Gateway-as-plugin/event-bus architecture.
- Hermes local `auth.json` credential pool state.
- Hermes media stack, batch RL trajectory generation, and external memory provider backends as MVP work.
- OpenAI-compatible API server as a planned stage.

---

## Known Future Risks

| Risk | Why it matters | Watch / next action |
|---|---|---|
| Distributed DB locking | Single-host advisory locks do not cover multi-host deployments | Revisit only before multi-host operation |
| RunStep ordering under concurrency | `MAX()+1` style ordering can race with distributed writers | Consider DB sequence or distributed counter before multi-writer runs |
| Cloud/offsite backup | Local backups do not protect against host loss | Define manual encrypted offsite flow first |
| Retention and hard delete | Personal data deletion must preserve clear audit semantics | Design retention/export/delete together |
| Credential scoping | Current resolver is a single release boundary | Add per-run/per-tool grants only with audit and UX |
| Broad ingestion privacy | Connectors can import sensitive data at scale | Keep Sources/Evidence candidate-only and proposal-gated |
| Automation scope creep | Background runs can become hidden mutation paths | Require ownership, preflight, policy, and proposal boundaries |
| Self-evolution scope creep | Agents can gain deployment or permission authority | Keep disabled until lifecycle/evaluation/rollback are real |
| Code patch partial apply | File rollback failures can leave Project Folders inconsistent | Pre-apply snapshots are captured before each accepted code_patch; user-facing `/rollback` restores from snapshot. Keep snapshot expiry and pruning auditable. |
| Disabled surfaces exposed in UI | Users can rely on features that are not active | Keep `planned: true` modules non-interactive |
| Actor identity backfill | Historical nullable user/agent fields remain across tables | Use `actor_ref` on new surfaces; avoid bulk migration until needed |
| API key persistence UI | Operator-only surfaces can become accidental product APIs | Keep feature-gated until ownership and UX are designed (Files & Code's interactive-session stub was fully removed rather than gated — see NON_GOALS_AND_DISABLED_SURFACES.md) |
