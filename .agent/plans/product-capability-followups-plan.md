# Product Capability Follow-ups

Date: 2026-07-26
Status: active small backlog, organized by domain
Audited 2026-08-08 against the current implementation; completed multi-Project
Note work removed and Save Run as Workflow narrowed to its actual draft-to-use
gap.

## Purpose

Split out of the former orchestration-and-self-evolution-plan.md on
2026-07-26 once that plan's Always-on chain (B3.1 → N8.1 → section 6, Phases
2-5 plus self-service activation) was fully delivered; that plan was then
retired (its remaining Always-on scope moved to
[current-focus.md](../tasks/current-focus.md) and current-state architecture).
These items never depended on Always-on and are unrelated to each other — each
is a standalone capability gap in a different subsystem. They were bundled
into one file only because they happened to share a backlog document; keeping
them there after Always-on shipped would have made that file, and this one,
read as "a pile of unrelated things" rather than an inventory anyone could
act on. Grouped here by the domain each belongs to.

Implementation truth remains the code. Current-state architecture belongs
under `.agent/architecture/`; this file is only the forward-looking backlog
and its completion gates. Remove an item once its behavior is implemented and
recorded in a current-state architecture document — do not keep it as a
changelog.

## 1. Verification Engine

### A2.1 — Manual and model-based verification

- [ ] Implement the declared manual_review verifier lifecycle, including
  durable pending/approved/rejected state and its effect on completion.
- [ ] Implement model_judge with a separately selected verifier model, never
  silently reusing the generator model.
- [ ] Add policy, audit, retry, and API read-model coverage.

Constraint: deterministic Verification Engine results remain the completion
authority; model or human judgment must be an explicit verifier result.

Scheduling rule: this remains open but does not block controlled acceptance
unless an acceptance Workflow declares one of these verifier types as required
completion evidence. It must be completed before such a Workflow is enabled.

## 2. Workflow / Automation Lifecycle

### B4.1 — Complete Save Run as Workflow lifecycle

Current code already provides the Run-detail UI, sanitized preview/extraction,
low-risk draft creation, and a high-risk `workflow_save` Proposal whose
acceptance creates a draft `workflow_template` asset version. Real-PostgreSQL
coverage stops at that draft boundary.

- [ ] Connect the created draft visibly into the existing proposal/promotion
  lifecycle so the user can review and promote it without reconstructing which
  asset came from the source Run.
- [ ] Add end-to-end coverage from source Run through save Proposal (when
  required), draft, promotion/approval, approved version, and subsequent
  Workflow launch.

Constraints: extraction stays sanitized; credentials, host paths, transient
Run IDs, and unreviewed mutable runtime state must not become Workflow
definition content. Always-draft behavior and standard proposal/promotion
gates remain in force.

## 3. Evolution & Artifact Provenance

### D1.2 — Artifact user-edit tracking

- [ ] Record user edits to generated artifacts with actor, artifact version,
  source Run, and before/after provenance.
- [ ] Convert meaningful edit patterns into evolution evidence/signals without
  treating every edit as an automatic promotion or memory write.
- [ ] Add Project Folder, Artifact, privacy, and cross-space isolation tests.

Scheduling rule: enters after the core workbench loop is accepted. Proposal
reject/request-changes signals are the interim user-correction evidence in the
meantime (see [../architecture/EVOLUTION_SIGNAL_SYSTEM.md](../architecture/EVOLUTION_SIGNAL_SYSTEM.md)).

## 4. Deliberately parked ideas

These remain incomplete but are not part of any active implementation
sequence. Do not pull one in without a separately observed trigger.

- PARKED — OMO / oh-my-openagent integration: benchmark/reference track only.
- PARKED — ML-based routing: the deterministic Router remains authoritative.
- PARKED — Native capability executor: keep disabled until separately designed
  and policy-gated.
- PARKED — Workflow canvas UI: structured Plan/Workflow views remain
  sufficient for the current scope.
- PARKED — AgentRunGroup extensions into a task graph: keep AgentRunGroup as a
  collaboration surface. The delivered Room layer (`../modules/rooms.md`) does
  not violate this: AgentRunGroup keeps its "one collaboration task" semantics
  and becomes a task opened inside a Room. Room is a persistent conversation
  container, not a DAG.

## Completion and retirement

Remove an item's section here once it is implemented and recorded in
current-state architecture, or once it is re-scoped into another active plan.
Retire this file when no section remains — do not let a closed item's section
linger as history; that belongs to git, not this file.
