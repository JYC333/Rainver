# Orchestration + Self-Evolution — Remaining Work Plan

Date: 2026-07-24
Status: active follow-up backlog; H1/H2 are Gate 0 for the Project cutover

This document is intentionally limited to work that is not complete. Completed
implementation history is not repeated here.

Implementation truth remains the code. Current-state architecture belongs in
the documents under .agent/architecture/; accepted cross-cutting decisions
belong in .agent/decisions/. This file is only the forward-looking backlog
and its completion gates.

## How to use this plan

- Status OPEN means the item is still open.
- Status PARKED means the item is deliberately deferred, not current work.
- Every implementation item must update the relevant current-state
  architecture document and add focused tests.
- Database-backed behavior must use the shared real-PostgreSQL test
  infrastructure. A skipped local container is not evidence of completion.
- Proposal, policy, credential, space-isolation, and server-authoritative
  boundaries remain unchanged while these items are implemented.

## 0. Existing correctness gaps to close first

These are not new product features. They are remaining gaps in the current
implementation and must be closed before this plan can be considered fully
reconciled.

### H1 — Plan-node budget admission and source validation

Closed 2026-07-24.

- [x] Make PgPlanRepository.scheduleReadyNodes perform the same budget-source
  admission used by the Task API before creating a child Run or its
  `plan_node_runs` link. (Already correct: `assertBudgetSourcesAvailable` ran
  immediately before `createQueuedRun`/`plan_node_runs` insert.)
- [x] Keep source validation, advisory-lock admission, Run creation,
  `plan_node_runs` insertion, and queue enqueue in the same transaction.
  (Already correct: all inside `scheduleReadyNodes`'s caller transaction.)
- [x] Validate node-level contract_json.budget_sources during Plan creation
  and revision; do not validate only top-level PlanVersion sources. Fixed:
  `createPlanFromAgent` now validates `graph.nodes.flatMap(budgetSourcesFromNode)`
  alongside the top-level sources, and a new `plan_nodes.budget_sources_json`
  column persists each node's declared sources (previously computed for
  approval-cost estimation but never persisted or enforced at scheduling
  time — `scheduleReadyNodes` was reading a different, never-populated
  `metadata_json.budget_sources` field).
- [x] Ensure exhausted Task, Automation, Workflow, or Plan sources cannot
  leave behind a queued Run or a `plan_node_runs` row. Verified: admission
  runs inside the execute/reconcile transaction, so a rejection rolls back
  the coordinator Run and any prior node scheduling from the same pass.
- [x] Add shared-PostgreSQL coverage for exhausted node budgets, inherited
  budgets, concurrent manual-vs-Plan admission, and rollback after rejection.
  `server/test/planGraphExecutionDb.test.ts` now covers node-local flat caps,
  node-level nonexistent-source rejection at Plan creation, an Automation
  source exhausted by a prior manual Run with full transactional rollback,
  Plan-level source inheritance into child snapshots, consumption accounting
  by logical root Run, and concurrent manual-vs-Plan admission with exactly
  one winner.

Plan child consumption is counted from immutable Run snapshots and combined
with the source domain's native links (`task_runs`/`automation_runs`), then
deduplicated by logical root Run. This is required so a Plan can consume an
inherited allowance without creating a false source-domain ownership link.

Primary implementation areas:
server/src/modules/plans/repository.ts,
server/src/modules/plans/graph.ts, and
server/src/modules/runs/budgetEnforcement.ts.

### H2 — Strict Workflow budget-source ownership

Closed 2026-07-24.

- [x] Make Workflow source validation require an approved version of an active
  Workflow asset. Already correct in `budgetSourceExists`'s `workflow`
  branch (`a.status = 'active'`, `v.status = 'approved'`).
- [x] Enforce parent-asset ownership, space visibility, and version-scope
  consistency for caller-supplied Workflow Version IDs. Already correct:
  the same query enforces `a.space_id = $2`/`v.space_id = $2` (or the
  system-scope branch), active owner-scope existence (project/agent/user),
  valid version `scope_type`/`scope_id`, the user-owned Asset restriction,
  and explicit `allow_user_override` for user-scoped Versions under other
  Asset ownership types.
- [x] Cover cross-space, stale/archived-asset, mismatched-scope, and
  system-visible Workflow cases with real-PostgreSQL tests.
  Stale/archived-asset, mismatched-scope, and system-visible cases were
  already covered in `server/test/automationsProjectDb.test.ts`; added the
  missing cross-space case — a space-scoped, approved, active Workflow
  Version genuinely owned by another space is rejected for the caller's
  space and accepted for its own — plus a malformed space-scoped Version
  under a user-owned Asset is rejected until its scope matches that owner.

Primary implementation area:
server/src/modules/runs/budgetEnforcement.ts.

H1 and H2 were prerequisites for the Project model clean cutover. Both and the
cutover are now complete.

## 1. Execution follow-ups

### A2.1 — Manual and model-based verification

- [ ] Implement the declared manual_review verifier lifecycle, including
  durable pending/approved/rejected state and its effect on completion.
- [ ] Implement model_judge with a separately selected verifier model, never
  silently reusing the generator model.
- [ ] Add policy, audit, retry, and API read-model coverage.

Constraint: deterministic Verification Engine results remain the completion
authority; model or human judgment must be an explicit verifier result.

Scheduling rule: this remains open but does not block the Project clean
cutover or controlled acceptance unless an acceptance Workflow declares one
of these verifier types as required completion evidence. It must be completed
before such a Workflow is enabled.

### A3.1 — Runtime sessions and checkpoint/resume

DELIVERED. The trigger came through CLI-backed conversation needing to avoid
replaying full history against subscription capacity on every turn, not
through a long/expensive workflow needing recovery. See the "Runtime session"
section of ADR 0007 and [../modules/rooms.md](../modules/rooms.md) for the
delivered session-key, credential-home, and invalidation model.

- [x] Persist runtime session references with ownership and provenance.
- [x] Define checkpoint creation, resume, fork, and invalidation semantics
  across process restart.
- [x] Define how checkpoint/resume interacts with RunAttempt retry, route
  reroute, cancellation, orphan recovery, and credentials.
- [x] Add runtime-boundary and real workflow tests; do not infer resume
  success from an adapter-local session ID alone.

Resume is a capacity optimization, never a correctness requirement.
Agent-space retains full replay capability, and a backend switch or
invalidated session degrades to replay
(ADR 0004).

## 2. Workflow and automation lifecycle

### B3.1 — Replace or retire hardcoded business fires

- [ ] Migrate executeMaintenanceFire and the context review cycle to
  versioned system Workflow templates, or explicitly retire them as
  documented native targets.
- [ ] Preserve proposal, policy, credential, budget, and audit behavior during
  the migration.
- [ ] Add a guard that prevents new unregistered hardcoded business fires.
- [ ] Update ROADMAP_AND_FUTURE_RISKS.md when the decision is made.

Missed-run/catch-up policy and unattended failure recovery are owned by
[unattended-execution-hardening-plan.md](unattended-execution-hardening-plan.md).
This item owns only target registration/authority cleanup.

### B4.1 — Complete Save Run as Workflow lifecycle

- [ ] Complete the proposal-gated path beyond draft extraction so an accepted
  save can be used through the normal approved Workflow lifecycle.
- [ ] Add end-to-end coverage from source Run to draft, approval, approved
  version, and subsequent launch.

Constraints: extraction stays sanitized; credentials, host paths, transient
Run IDs, and unreviewed mutable runtime state must not become Workflow
definition content. Always-draft behavior and standard proposal/promotion
gates remain in force.

## 3. Runtime hardening follow-ups

### C3.1 — Conformance second wave

- [ ] Add forbidden-tool detection.
- [ ] Add premature-completion detection.
- [ ] Add validation-compliance checks.
- [ ] Add artifact-production checks.
- [ ] Add timeout-behavior checks.
- [ ] Add cost/latency profiling.
- [ ] Feed the results into routing trust decisions without weakening the
  current fail-closed behavior.

Minimum structured event/output conformance and execution-shape routing are
implemented. This item retains the broader trust/profiling wave after
controlled smoke.

### C3.2 — Reviewed egress-enabled execution profile

- [ ] If required, design and separately review an egress-enabled Docker
  profile with explicit destinations, credential channel rules, audit records,
  and resource limits.
- [ ] Add policy and runtime tests before exposing the profile to any route.

Constraint: networked provider-proxy execution remains disabled by default.

This work is now sequenced and accepted through
[unattended-execution-hardening-plan.md](unattended-execution-hardening-plan.md);
keep this heading only as the orchestration backlog cross-reference and do not
implement a competing profile design here.

## 4. Evolution-loop follow-ups

### D1.1 — Remaining automatic signal generation

- [ ] Inventory the signal classes that are still emitted only by manual
  actions.
- [ ] Add automatic emitters at the authoritative durable event boundaries.
- [ ] Preserve deduplication, visibility, target resolution, severity, and
  dismiss/triage behavior.
- [ ] Add emitter and persistence tests for each newly automated class.

### D1.2 — Artifact user-edit tracking

- [ ] Record user edits to generated artifacts with actor, artifact version,
  source Run, and before/after provenance.
- [ ] Convert meaningful edit patterns into evolution evidence/signals without
  treating every edit as an automatic promotion or memory write.
- [ ] Add Project Folder, Artifact, privacy, and cross-space isolation tests.

### D2.1 — Automatic candidate-run launch

- [ ] Allow an evaluation job to launch a candidate Run from
  EvaluationCase.input_json through the normal Plan/Run admission path.
- [ ] Persist candidate version pinning, launch provenance, verification
  results, baseline comparison, and failure state.
- [ ] Preserve warn-only versus hard-gate promotion policy and add real
  workflow coverage for launch, retry, failure, and promotion blocking.

Constraints: candidate output must remain system-produced; callers must not
submit candidate_output_json. Existing warn-only versus hard-gate promotion
policy must not be weakened.

## 5. Approval and budget policy follow-up

### N8.1 — Budget inheritance in auto-approval

- [ ] Define how space-level and Automation-level budget inheritance
  participates in the low-risk Plan auto-approval threshold.
- [ ] Specify precedence, effective-cap calculation, ownership, and the
  transaction boundary before implementation.
- [ ] Persist the resolved decision inputs and add approval-boundary tests.

## 6. Deliberately parked work

These items remain incomplete but are not part of the active implementation
sequence. They should not be silently pulled into the default orchestration
chain.

- PARKED — OMO / oh-my-openagent integration: benchmark/reference track only.
- PARKED — ML-based routing: the deterministic Router remains authoritative.
- PARKED — Native capability executor: keep disabled until separately designed and
  policy-gated.
- PARKED — Workflow canvas UI: structured Plan/Workflow views remain sufficient for
  the current scope.
- PARKED — AgentRunGroup extensions into a task graph: keep AgentRunGroup as a
  collaboration surface. The delivered Room layer (`../modules/rooms.md`) does
  not violate this: AgentRunGroup keeps its "one collaboration task" semantics
  and becomes a task opened inside a Room. Room is a persistent conversation
  container, not a DAG.

The cross-cutting hardening backlog remains in
[hardening-blind-spot-remediation-plan.md](hardening-blind-spot-remediation-plan.md);
this document does not duplicate its work.

## Recommended delivery order

1. H1 and H2 — close current correctness and isolation gaps before the Project
   model cutover.
2. Execute the Project model and Runtime I/O plans, then product acceptance.
   Acceptance runs against the delivered Room/CLI-conversation surface, not a
   replaced one.
3. Complete the minimum C3.1 checks required by the Runtime I/O plan, then run
   controlled real integration smoke.
4. Trigger unattended hardening, including C3.2, only after smoke evidence.
5. A2.1/B3.1/B4.1 enter when their recorded prerequisites occur. A3.1 is
   delivered.
6. D1.1/D1.2/D2.1 remain after the core workbench loop is accepted.
7. N8.1 remains last; auto-approval cannot outrun explicit budget semantics.

## Plan completion and retirement criteria

This plan can be retired or deleted only when:

- all active OPEN items are complete, or explicitly moved to an architecture
  roadmap/decision record;
- each changed behavior has focused unit, route, invariant, or shared
  PostgreSQL workflow coverage as appropriate;
- current-state architecture documents no longer depend on this plan for
  implementation truth;
- related plans and ROADMAP_AND_FUTURE_RISKS.md no longer contain
  broken or ambiguous references to this file.

Until then, this file should remain a small remaining-work backlog rather than
another implementation history document.
