# ADR 0011: Domain-Owned Inquiry Model And Workflow Node Extension

Date: 2026-07-23

## Status

Accepted - 2026-07-23

## Context

Agent-space is adding new Project-owned domains — Inquiry Thread (questions
and hypotheses with a confirmed position), Experiment, and Decision Case —
plus a versioned Workflow Template that will run the existing Auto Research
pipeline. This requires deciding where the new domains' data and
relationships live relative to the existing object model, and what execution
engine the new Workflow Template runs on.

Current object model: `space_objects` is the shared identity/status/visibility
root for app-owned objects, and FK-backed `object_relations` (sole writer:
`modules/knowledge/proposalApplier.ts`) is the only canonical relation graph
over it (B12A). It is not settled whether the new domains should extend this
model or use their own tables, or whether cross-domain navigation needs a
second generic relation table.

Verified against current code: a `WorkflowExecution` engine
(`workflow_executions`/`workflow_execution_nodes`) already exists and its
approval-checkpoint mechanism already works end to end. It has no
deterministic action-handler dispatch and no per-node input/output schema.
The existing Academic Research orchestrator (`modules/projectResearch/`) runs
entirely independently of it today, with its own job queue and its own stage
state machine.

## Decision

- New Project-owned domains (Inquiry Thread, Experiment, Decision Case, and
  their relation/state tables) are their own root tables, not `space_objects`
  rows. `object_relations` only accepts `space_objects` endpoints, so it
  cannot and will not model these edges — its scope, ownership, and sole
  writer are unchanged by this decision.
- Each new domain uses its own narrowly-owned FK link tables for business
  relationships (e.g. Thread structure, Thread-to-Note, Experiment-to-Thread,
  Decision-to-Thread), consistent with B12A's existing "narrowly owned domain
  join table only when lifecycle is genuinely different" exception.
- No new generic/authoritative relation table is introduced. Cross-domain
  navigation and discovery is served by extending the existing rebuildable
  `retrieval_edges` projection, which is already derived and
  non-authoritative — not by a second `object_relations`-shaped table.
- `WorkflowExecution` becomes the single execution authority for the Academic
  Literature Review Template and future fixed workflows; no new orchestration
  table is introduced. Its existing `node_kind` discriminator is extended, not
  replaced, to cover three roles: Action (new deterministic
  registered-handler kind, no LLM run spawned), Model (the existing `leaf`
  kind, gaining declared input/output schema validation before completion),
  and Checkpoint (the existing `approval_checkpoint` kind, already correct,
  gaining a sub-kind so one mechanism serves every domain review use instead
  of a new proposal type per use).
- A full-environment cutover between schema-affecting changes is a database
  reset via the existing `reset-postgres.sh` + `start.sh` scripts, matching
  this repo's existing single-baseline `schema:generate` convention. No new
  tooling and no legacy-row migration/compatibility path are introduced; old
  rows are not preserved across a cutover.
- Each Mode's Project Overview projection is supplied by a registered adapter
  owned by that Mode's module, mirroring the existing `ProposalApplierRegistry`
  dispatch model. The Project module aggregates and never queries
  Inquiry/Experiment/Decision tables directly.

## Consequences

- `BOUNDARIES.md` gains a rule extending B12A once this ADR is accepted: new
  Project-domain aggregates never become `space_objects` rows or write
  `object_relations`; cross-domain association stays in `retrieval_edges`.
- Inquiry's own CRUD and review loop needs no `WorkflowExecution` or
  Action/Model/Checkpoint change — only its own domain tables.
- `retrieval_object_type` must be extended before the new domains are
  cross-domain discoverable through search/context/graph.
- The Action/Model/Checkpoint schema additions to `workflow_execution_nodes`
  are only needed once a Workflow Template consumes them; nothing upstream is
  blocked on this work landing first.
- No compatibility layer or converter is built for existing `academic_research`
  Project data; a schema cutover deletes and recreates the database rather
  than migrating old rows.

## Non-Goals

- Deprecating, forking, or dual-writing `object_relations`.
- A second generic/authoritative relation table.
- Reshaping Ontology/canonical-relation ownership (separate future decision).
- Deciding Delivery/Operations schema beyond composing existing Task/Run/
  Automation/Alert modules — no new schema question is raised here.
