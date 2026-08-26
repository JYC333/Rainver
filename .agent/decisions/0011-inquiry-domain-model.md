# ADR 0011: Inquiry Domain Model And Workflow Node Extension

Date: 2026-07-23
Rewritten: 2026-08-04

## Status

Accepted - 2026-07-23. Rewritten 2026-08-04: decisions 1-3 were reversed by
[ADR 0012](0012-ontology-ownership-and-language-alignment.md); decisions 4-6
carry forward unchanged. See History at the end of this document.

## Context

Rainver added Project-owned domains — Inquiry Thread (questions and
hypotheses with a confirmed position), Experiment, and Decision Case — plus a
versioned Workflow Template that runs the existing Auto Research pipeline.
Two questions had to be settled: where these domains' data and relationships
live relative to the existing object model, and what execution engine the new
Workflow Template runs on.

`space_objects` is the shared identity/governance root for app-owned objects,
and FK-backed `object_relations` is the canonical relation graph over it.
ADR 0012 settles their ownership and contract; this ADR settles how the
Inquiry, Experiment, and Decision Case domains sit on top of them.

A `WorkflowExecution` engine (`workflow_executions` /
`workflow_execution_nodes`) already exists and its approval-checkpoint
mechanism works end to end. It has no deterministic action-handler dispatch
and no per-node input/output schema. The Academic Research orchestrator
(`modules/projectResearch/`) runs independently of it, with its own job queue
and stage state machine.

## Decision

**1. Domain aggregate roots are ontology objects.** Inquiry Thread,
Experiment, and Decision Case are `space_objects` rows. They gain the root
contract defined in ADR 0012 decision 1 — shared identity, visibility,
access level, ownership, project scope, agent/run provenance, and
archive/delete timestamps — and keep their own domain fields, including their
own status columns and state machines, in their extension tables.

`primary_project_id` is non-null for these aggregates, enforced by
constraint: the content read gate's scope predicate treats a null project as
"no Project restriction", so a null value would silently bypass Project
membership.

Recovered Threads default to `visibility='space_shared'`, preserving the
Project-membership-equivalent behaviour they had before per-object visibility
existed.

**2. Domain-internal tables stay domain-private.** Revision histories, event
streams, typed state rows, per-user working state, and per-project settings
are internal structure of an aggregate, not objects. Applied to Inquiry:
`inquiry_thread_statement_revisions`, `inquiry_thread_revisions`,
`inquiry_thread_lifecycle_events`, `inquiry_thread_structure_events`,
`inquiry_thread_work_events`, `inquiry_question_states`,
`inquiry_hypothesis_states`, `inquiry_iterations`,
`inquiry_thread_personal_focus`, and `inquiry_project_settings` remain owned
by the `inquiry` module and are never `space_objects` rows.

**3. Cross-aggregate relationships use `object_relations`.** Business edges
between aggregate roots — Thread structure, Thread-to-Note, Experiment-to-
Thread, Decision-to-Thread — are `object_relations` rows with declared link
types and per-link-type governance (ADR 0012 decision 3).
`inquiry_thread_relations` and `inquiry_thread_note_links` are removed; their
`decomposes_into` and `proposes` values enter the canonical link-type
vocabulary. The "narrowly owned domain join table" exception applies only when
an edge's lifecycle is genuinely different from the canonical edge table's,
which was not the case for either of these.

No new generic or authoritative relation table is introduced.
`retrieval_edges` remains a rebuildable, non-authoritative projection; it is
not the authority for cross-domain association.

**4. `WorkflowExecution` is the single execution authority** for the Academic
Literature Review Template and future fixed workflows; no new orchestration
table is introduced. Its existing `node_kind` discriminator is extended, not
replaced, to cover three roles: Action (a deterministic registered-handler
kind, no LLM run spawned), Model (the existing `leaf` kind, gaining declared
input/output schema validation before completion), and Checkpoint (the
existing `approval_checkpoint` kind, already correct, gaining a sub-kind so
one mechanism serves every domain review use instead of a new proposal type
per use).

**5. A full-environment cutover between schema-affecting changes is a database
reset** via the existing `reset-postgres.sh` + `start.sh` scripts, matching
this repo's single-baseline `schema:generate` convention. No new tooling and
no legacy-row migration or compatibility path is introduced; old rows are not
preserved across a cutover.

**6. Each Mode's Project Overview projection is supplied by a registered
adapter owned by that Mode's module**, mirroring the `ProposalApplierRegistry`
dispatch model. The Project module aggregates and never queries
Inquiry/Experiment/Decision tables directly.

### Amended 2026-08-07 — Modes and entities are separate registries

Decision 6 held that each Mode's module supplies its Overview projection.
That stays true, but it conflated two things. `inquiry` and `decision` were
Modes here, and neither is a way of *advancing* work: asking is how research
starts, deciding is where it ends, and a Project that advances by delivery
makes decisions too. Both were absorbed into a `research` Mode, leaving four —
`research`, `delivery`, `operations`, `learning`.

`overviewRegistry` therefore holds two registries. A
`ProjectModeProjectionAdapter` answers "what should happen next" and only the
four Modes register one. A `ProjectEntitySummaryAdapter` answers "how much of
this does the Project hold, and where does it live"; Inquiry and Decision
register these, keeping their first-class Areas and their attention adapters
without claiming to be Modes. `area_summaries` is replaced by
`entity_summaries`, which is never a list of Areas — every installed Area
stays reachable through the navigation shell regardless of what it contains.

The boundary decision 6 exists to enforce is unchanged: the Project module
still never queries Inquiry/Experiment/Decision tables directly.

## Consequences

- Inquiry, Experiment, and Decision Case gain per-object visibility, retrieval
  identity, graph participation, and citation identity through the shared
  ontology instead of through domain-specific implementations.
- `InquiryGraphService.getCombinedProjectGraph`'s manual union of an
  Inquiry-specific projection with the `space_objects`/`object_relations`
  projection is removed; one projection serves both.
- `retrieval_object_type` no longer needs a separate extension per new domain
  to make it cross-domain discoverable; discoverability follows from the
  `Retrievable` interface declaration (ADR 0012 decision 6).
- The Action/Model/Checkpoint schema additions to `workflow_execution_nodes`
  are only needed once a Workflow Template consumes them; nothing upstream is
  blocked on that work landing first.
- Inquiry's own CRUD and review loop needs no `WorkflowExecution` or
  Action/Model/Checkpoint change.
- No compatibility layer or converter is built for existing
  `academic_research` Project data; a schema cutover deletes and recreates the
  database rather than migrating old rows.

## Non-Goals

- A second generic or authoritative relation table.
- Deciding Delivery/Operations schema beyond composing existing Task / Run /
  Automation / Alert modules.
- Ontology ownership, the root contract, definition authority, interfaces, and
  naming — all settled in
  [ADR 0012](0012-ontology-ownership-and-language-alignment.md).

## History

Between 2026-07-23 and 2026-08-04 this ADR held the opposite position on
decisions 1-3: that Project-domain aggregates were their own root tables and
never `space_objects` rows, that each domain used its own FK link tables for
business relationships, and that cross-domain association was served by
`retrieval_edges`. That position was reversed by ADR 0012 after an audit found
that the shared root carries no domain data, that root membership never
implied proposal gating, that the split had duplicated the shared columns
while dropping the governance ones, and that the domain link tables were
column-for-column duplicates of `object_relations`. This ADR's original
Non-Goals had already deferred the ownership question as a separate future
decision; ADR 0012 is that decision.

Decisions 4-6 are unchanged from the original. Code comments and tests that
cite "ADR 0011 decision N" predate this rewrite and use inconsistent numbering
for the registered-adapter decision; they are audited in the phase that
touches the corresponding code.
