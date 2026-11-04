# ADR 0027: Problem Engine, Task Status And Research Capability

Date: 2026-11-04

## Status

Accepted and implemented. Current domain/API owners are
[Inquiry](../architecture/INQUIRY_PROBLEM_ENGINE.md),
[Research](../architecture/PROJECT_RESEARCH_CALLS.md),
[Project Work](../architecture/PROJECT_WORK.md) and the one-time
[cutover](../architecture/PROBLEM_ENGINE_UPGRADE.md).
The original [P1 design contract](../architecture/PROBLEM_ENGINE_CONTRACT.md)
is retained as a historical design archive, not a second current specification.
This status grants no deployment authorization.

Precisely supersedes the universal work-progression use of Loop in ADR 0019
decision 1 (“same Loop”), decision 4 (“The Loop has one wording”) and the
consequence that the Board reads five method stages. This ADR establishes
Task Board status as its only progress state and locates the retained method
in Inquiry. Historical decision 4 established uniform stage wording, not
single Task status. ADR 0019's no Project type,
conversation pacing and independent objects remain in force.

Clarifies ADR 0011 decision 6's reference to a shared Loop in the same limited
way. Its ontology roots, domain-private internal tables, canonical business
relations, fixed-workflow execution authority and attention ownership remain
in force. Task-owned `task_entity_links` retains its existing narrow association
lifecycle; Step target references describe work provenance, not a replacement
cross-aggregate ontology graph.

## Context

Board status describes a Task's commitment and queue position. Method stages
express how an uncertain problem is being worked on. Giving a Task both let
an Agent move the method while leaving the requested card unchanged. Removing
the Task rail alone leaves Inquiry's research-shaped stages, Iteration-only
round boundaries, frontend-derived progression and Research's work-focus
writes unresolved. The generic method remains useful for research and for
non-research problem solving.

## Decision

1. Evolve existing Inquiry Thread, Step and Iteration in place. No parallel
   Problem root or engine execution lifecycle. Keep question/hypothesis kinds.
   Method version `problem_solving.v1` classifies work as Frame, Plan, Act,
   Verify, Conclude, with explicit skips, returns and concurrent work. Stages
   are neither gates nor Task status. The Inquiry server owns the rebuildable
   projection; page navigation does not write progress.
2. Separate method classification, work kind and execution/attention facts.
   `problem_solving.v1` is the only Step method. Stage, work kind and round are
   persisted facts, never inferred from a kind or a timestamp. Step selection
   and evidence are distinct from an accepted judgment. The open primary Step
   alone owns current next work; a close-out's optional next intent is only a
   record. Only an explicit command opens a primary Step; a background Step
   requires a bound execution record.
3. Record round close-out independently of cognitive Iteration. No-change
   close-out records inputs, reason and next intent without a fake cognitive
   change. A changed-position close-out and its Iteration commit atomically
   and count once. HTTP/Agent cognitive writes explicitly choose position-only
   or close-round intent; Candidate acceptance and cognitive undo never close a
   round or open a next Step. Close-out is a direct origin-gated write, with
   `thread.round_closed` in Updates and append-only compensation through
   `thread.round_closeout_reverted`; dependent later work causes a conflict,
   never history deletion or implicit cascading reversal (ADR 0017 §4).
   A close-out does not end the Thread, start execution or finish Tasks.
4. Research remains an existing Workflow/Operation/Run capability. Pin input
   to the original Thread revision and originating work; return findings,
   evidence, limits, reports, execution outcome and actual usage. Bind each
   logical invocation one-to-one to its originating Step and initial Operation
   at start; retries and terminal reconciliation use that binding, never kind.
   A problem call missing its binding is a conflict, never guessed. Research
   may assess evidence locally; Inquiry commands alone adopt results, change
   the problem's position and select its next work. Late results cannot
   overwrite a revised problem. FINER is an optional Frame method, not a
   universal prerequisite. Independent Research, monitoring, Sources and
   routine reading retain direct entry paths and their own owner gates.
5. Establish `tasks.status` as the Task's only progress state. Task Loop state,
   its DTO fields and stage commands do not exist; an old command receives the
   ordinary unknown-route or ungranted-tool refusal, never a status mapping.
   Reuse Task-owned associations and Step references for many-to-many
   problem/task work. Link visibility never grants content visibility. Task
   completion, review, evidence and Plan execution stay with their existing
   owners; neither side's completion advances the other. A Task needs no
   problem or Plan.
6. Keep no runtime compatibility. Application code reads and writes only the
   current model: no historical decoding, alias field, command or event, dual
   write, or translation of a retired command. Old page URLs may redirect as
   navigation; they never carry a data adapter. Data from the older model is
   converted once by append-only maintenance migrations, or refused: the
   cutover migration aborts on any Step that is not `problem_solving.v1`
   instead of guessing its stage or round. Every instance other than the
   converted test instance needs its own offline inventory, backup and
   reviewed conversion before it applies the cutover.
   Original records the cutover replaces (Task Loop snapshots, Advice,
   next-focus values, raw Task stage events, converted close-outs and
   Iterations) are kept in `maintenance_model_archives`, a static
   operator-only archive with no application API, reader or writer; it is not
   a supported data model. Task stage events keep their IDs, actor and scope
   as generic `task.history_imported` history. Task IDs, status, relationships,
   responsibility, outputs, Runs, Plans and Sources are not changed by the
   cutover. Applied migrations are never edited (B59). The previous application
   must not run against the cutover schema; rollback needs a compatible backup
   restore or an explicit forward repair.

## Consequences

The Project workspace presents one problem lifecycle and its bound Research
execution records. Independent Research reports, runs and records stay under
their existing Research routes. Direct Task, no-change close-out, skip/return,
multi-task/multi-round and stale-result examples are specified in the P1
contract archive.

This is domain authority, not a commodity scheduling problem: reuse the
existing Inquiry, Research, Task links and event/transaction infrastructure;
add no state-machine dependency or generic scheduler. Implementation tests
must establish transactions, idempotency, concurrency and permissions against
real PostgreSQL. Documentation checks do not establish those runtime claims.
