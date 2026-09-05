# ADR 0011: Inquiry Domain Model And Workflow Node Extension

Date: 2026-07-23

## Status

Accepted. Decisions on ontology ownership, the root contract, definition
authority, interfaces, and naming belong to
[ADR 0012](0012-ontology-ownership-and-language-alignment.md); this ADR
settles how the Inquiry, Experiment, and Decision Case domains sit on top of
that ontology, what engine fixed workflows run on, and how domains contribute
attention. Project type and conversation pacing follow
[ADR 0019](0019-project-has-no-type-field.md).

## Context

Rainver added Project-owned domains — Inquiry Thread (questions and
hypotheses with a confirmed position), Experiment, and Decision Case — plus a
versioned Workflow Template running the existing Auto Research pipeline. Two
questions had to be settled: where these domains' data and relationships live
relative to the object model, and what execution engine the Workflow Template
runs on.

`space_objects` is the shared identity/governance root for app-owned
objects and FK-backed `object_relations` is the canonical relation graph over
it (ADR 0012). A `WorkflowExecution` engine (`workflow_executions` /
`workflow_execution_nodes`) already existed with a working approval
checkpoint, but no deterministic action dispatch and no per-node schema; the
Academic Research orchestrator ran beside it with its own queue.

## Decision

### 1. Domain aggregate roots are ontology objects

Inquiry Thread, Experiment, and Decision Case are `space_objects` rows. They
take the root contract of ADR 0012 — shared identity, visibility, access
level, ownership, Project scope, agent/run provenance, archive/delete
timestamps — and keep their own domain fields, including their own status
columns and state machines, in extension tables.

`primary_project_id` is non-null for these aggregates, enforced at the single
`space_objects` write path (ADR 0012 decision 10): the read gate's scope
predicate treats a null Project as "no Project restriction", so a null would
silently bypass Project membership. Recovered Threads default to
`visibility = 'space_shared'`, preserving the behaviour they had before
per-object visibility existed.

### 2. Domain-internal tables stay domain-private

Revision histories, event streams, typed state rows, per-user working state,
and per-Project settings are internal structure of an aggregate, not objects.
For Inquiry that is `inquiry_thread_statement_revisions`,
`inquiry_thread_revisions`, `inquiry_thread_lifecycle_events`,
`inquiry_thread_structure_events`, `inquiry_thread_work_events`,
`inquiry_question_states`, `inquiry_hypothesis_states`,
`inquiry_iterations`, `inquiry_thread_personal_focus`, and
`inquiry_project_settings`; they are owned by the `inquiry` module and are
never `space_objects` rows.

### 3. Cross-aggregate relationships use `object_relations`

Business edges between aggregate roots — Thread structure, Thread-to-Note,
Experiment-to-Thread, Decision-to-Thread — are `object_relations` rows with
declared link types and per-link-type governance (ADR 0012 decision 3).
`inquiry_thread_relations` and `inquiry_thread_note_links` are removed; their
`decomposes_into` and `proposes` values join the canonical vocabulary. The
"narrowly owned domain join table" exception applies only when an edge's
lifecycle genuinely differs from the canonical table's, which was not so
here. `retrieval_edges` remains a rebuildable, non-authoritative projection.

### 4. `WorkflowExecution` is the single execution authority for fixed workflows

No new orchestration table. The existing `node_kind` discriminator is
extended, not replaced, to three roles: **Action** (deterministic registered
handler, no LLM run spawned; `actionNodeRegistry`), **Model** (the existing
`leaf` kind, gaining declared input/output schema validation), and
**Checkpoint** (the existing `approval_checkpoint` kind, gaining a sub-kind so
one mechanism serves every domain review use instead of a new proposal type
per use).

### 5. Schema changes follow the repository data-preservation boundary

Use [BOUNDARIES B59](../BOUNDARIES.md) and
[COMMANDS](../COMMANDS.md) for schema changes. The single-baseline/reset
convention applies only while no deployment holds data that must be preserved.
This ADR does not authorize deleting instance data; once preservation matters,
use real migrations.

### 6. Domains reach the shell through attention

A Project has no Mode/type field; its shared Loop and conversation pacing are
specified by [ADR 0019](0019-project-has-no-type-field.md). A domain contributes to
the attention registry (`projectAttentionRegistry`): Inquiry, Decisions,
Tasks, Automations and research operations each register an adapter that says
what needs a person, and that list is what Pulse, the shell sidebar and the
Room's side panel all render.

"Needs a person" is defined by [ADR 0017](0017-authorization-by-cost-not-authorship.md)
§4, not by each adapter's own judgement: a hard-gated write awaiting a
decision, a bounded pipeline's remainder offer, the system's own recorded
next step for a Thread, or a write the Agent itself flagged as uncertain. An
adapter emits nothing else — in particular no "confirm what I already did"
items, and no one item per element of a decomposition a person asked for.
Within a Project the Agent advances Threads directly under ADR 0017 §2
(origin-gated and bounded); the attention list is where the Project tells the
person what it cannot decide alone, which is why it must stay short enough
to be read.

The boundary this enforces: the Project module aggregates through registered
adapters and never queries Inquiry/Experiment/Decision tables directly,
mirroring the `ProposalApplierRegistry` dispatch model.

## Consequences

- Inquiry, Experiment, and Decision Case gain per-object visibility,
  retrieval identity, graph participation, and citation identity through the
  shared ontology instead of domain-specific implementations.
- `InquiryGraphService.getCombinedProjectGraph`'s manual union of two
  projections is removed; one projection serves both.
- Cross-domain discoverability follows from the `Retrievable` declaration
  (ADR 0012 decision 6), not a per-domain enum extension.
- Inquiry's own CRUD and review loop needs no `WorkflowExecution` change.
- No converter is built for existing `academic_research` data.

## Non-goals

- A second generic or authoritative relation table.
- Delivery/Operations schema beyond composing existing Task / Run /
  Automation / Alert modules.
