# Inquiry problem engine

Current Inquiry method/round implementation, constrained by [ADR 0027](../decisions/0027-problem-engine-research-separation.md).
[Research](PROJECT_RESEARCH_CALLS.md), Task associations and the project-local
workspace are implemented; [upgrade/recovery](PROBLEM_ENGINE_UPGRADE.md) has an
isolated real-PG procedure. [Cross-domain acceptance](PROBLEM_ENGINE_ACCEPTANCE.md)
records evidence and limits separately. The P1 contract is a design archive.

## Authority and storage

Inquiry Thread remains the root; no new problem aggregate, scheduler or Round
execution lifecycle exists. `problem_solving.v1` records Frame / Plan / Act /
Verify / Conclude as method classification, separately from work kind and
Step slot/status. `inquiry_thread_steps` stores method, work, round and explicit
select/skip/return facts. Its existing partial unique index still enforces one
open primary Step. A global `fact_order` provides insertion order and the
history pagination cursor.
Current Step facts accept only `problem_solving.v1`; offline cutover rules are
owned by [ADR 0027](../decisions/0027-problem-engine-research-separation.md)
decision 6.

`inquiry_round_closeouts` is an immutable boundary/summary fact. Thread/round
number and non-null Iteration references are unique. `inquiry_problem_commands`
is a scoped idempotency receipt, unique by Space/key; it is not execution state.
Commands lock the active Project and Thread, check both definition version and
`problem_revision`, and compare replay payloads under a scoped advisory lock.
Keys are namespaced by trusted Run identity (or instructing user for HTTP),
not model-supplied prefixes. Identical retry retains its outcome and re-reads
authorized projection data; another payload or a stale version returns 409. Work and cognitive changes invalidate the revision.

`problemFacts.ts` owns transactional fact writes; `problemEngineService.ts`
owns versioned work/unchanged close-out commands and coherent read projection;
`roundUndo.ts` owns close-out compensation. The cognitive command remains in
`iterationService.ts`. No new writer bypasses the canonical work-event writer.
Reuse: existing transaction/ACL helpers, Step storage, actor/event writer and
shared PG fixtures; Zod/Drizzle already supply contract/schema tooling. Domain
semantics require no external state-machine or scheduling dependency.

## API and Agent tools

Under `/api/v1/projects/:projectId/inquiry/threads/:threadId`:

| Entry | Contract |
| --- | --- |
| GET `/problem` | Coherent repeatable-read version/current-round snapshot plus bounded history: default 50, maximum 100 rows per collection, independent Step/close-out cursors; stage aggregates cover the actual current round |
| POST `/problem/work` | `ProblemWorkRequestSchema`: expected versions, key, stage/work, reason; optional explicit skip/return and separate input/output references |
| POST `/problem/close-round` | `ProblemCloseRoundRequestSchema`: unchanged judgment, summary/inputs, optional historical next intent and explicit next primary |
| POST `/iterations` | Cognitive change with `round_intent`; all requests require versions/key and explicit round intent |

`inquiry.list_threads` uses a compact SQL page (default 25, max 100), ordered by
Thread ID with explicit next_cursor; it returns no Step/close-out bodies and
does not run one projection per Thread. Titles over 500 characters carry a
truncation flag. `inquiry.read_problem` is the separately granted bounded full
read. Summary-only Threads expose no problem body. `inquiry.record_work`
and `inquiry.close_round` use the existing Dispatcher, explicit grants and
origin-gated policy actions `inquiry.work.record` / `inquiry.round.close`.
`inquiry.record_conclusion` accepts explicit modern position-only/close-round
intent; unchanged modern conclusions dispatch to the close-out command.
Unattended origins retain approval. No tool selection grants itself authority. Both actions preserve expected-version
checks and replay receipts. The permission snapshot must explicitly grant them;
a Run with only older Inquiry grants receives `system_action_not_granted`.

The open primary Step alone defines current next work. There are no old
next_focus columns, Advice producer/adoption tool or parallel focus workspace.
Use record_work for explicit method/work selection, skip/return or references.
Research background work starts only with an admitted Operation/Step binding;
selection or an unexecuted next intent never manufactures running work.

## Cognitive writes, close-out and history

Modern HTTP/Agent cognitive requests explicitly choose `position_only` or
`close_round`. Candidate acceptance and cognitive undo force position-only,
ignore injected next-step/close-out intent, and leave existing Steps open.
Protected cognitive fields still require a substantive Iteration. Unchanged
close-out creates no Iteration; changed-position close-out links exactly one
Iteration in the same transaction. Background work keeps its original round.
The next round does not inherit prior output ticks. Skip/return facts do not
pretend skipped work completed, and outputs never mean verification passed.

Cognitive updates always require problem_solving.v1, expected version/revision,
a scoped idempotency key and position_only or close_round. Candidate acceptance
and Updates undo use the same command with trusted current tokens and explicit
position_only intent. No old Iteration adapter remains. Existing cognitive
history remains immutable; offline boundaries are archived/converted once.

## Updates and compensation

`thread.work_recorded`, `thread.round_closed` and
`thread.round_closeout_reverted` are registered Inquiry events, visible through
Updates only with full Thread content and inherited Run permissions. A changed
close-out also keeps the cognitive `thread.concluded` event, linked by Iteration;
round counts come only from close-outs, not the count of Updates rows. The
cognitive event has its independent undo. Updates displays one close-out entry
with both audit events as members and their separate undo actions; filtering
happens before cursor pagination, so the cognitive row is not shown twice.

Updates undo calls Inquiry's close-out compensation in its existing transaction
(boundary documented under B33). It appends an event with server-owned
`undo_of_event_id`; no historical row or round number is deleted or rewritten.
Only the latest close-out at the current revision, with no later work or active
background dependency, may be compensated. A next primary opened by the close-out
itself (`start_next_primary`) is part of the compensated command: it ends as
`closeout_reverted`. Prior attention, with its input references, is recorded as
a new primary Step, never a reopened historical Step or a restarted operation. Later
dependencies return 409. Cognitive undo similarly rejects a superseded position
and writes only a compensating Iteration in the current round.

## Verification

Focused real-PG coverage lives in `server/test/inquiryProblemEngineDb.test.ts`,
`inquiryProblemReadModelDb.test.ts`, and the existing Thread/Signal/
DirectWrites/ReadPlane suites. Protocol parsing is covered by
`packages/protocol/test/problemEngine.test.ts`. Schema, registered actions,
policy, Updates and Research consumers are checked separately. The migration
chain itself is covered by `baselineSchema.test.ts`.

## Current consumers and references

HTTP and Agent summaries expose the actual open primary and persisted round
boundary. Full histories page independently; no client infers round from an
Iteration count. Typed references validate kind, Space/Project and full source
content permission before writes and reads. Inputs, output facts and acceptance
are distinct; private body/title content is withheld rather than cached in a
readable parent. Query history is bounded.

One-time cutover and backup/restore are documented in
[the cutover guide](PROBLEM_ENGINE_UPGRADE.md). Old page links can be routing
aliases; this does not restore old data codecs, writers or Loop DTOs.

## Task association and result references (P4)

`InquiryTaskAssociationService` composes the canonical Task repository,
`linkTaskEntities`, existing problem receipts/locks and work-event writer. No
parallel relationship lifecycle or execution container exists. Reuse / Dependency
Check: existing domain mechanisms and Zod suffice; no external dependency is
needed for a domain permission/transaction contract.

Under `/projects/:projectId/inquiry/threads/:threadId/tasks`:

- POST creates and links (`task`) or links an existing `task_id`, with exactly
  one endpoint choice, role, reason and scoped idempotency key. Task creation,
  all requested links, events and receipt commit or roll back together.
- GET returns actual Task status/roles, 50 rows per id-keyset page with optional
  `after_task_id`; `/tasks/:taskId/inquiry-threads` reads the other direction
  using `after_thread_id`. Both return `next_cursor`, omit unreadable endpoints
  and never copy visibility, ownership or method stages onto Tasks.
- GET `/:taskId/result` returns actual status, a Task Work pointer and up to 50
  full-authorized Artifact pointers (explicit truncation). No report text or
  summary is copied. Legacy projectless artifacts qualify only through a
  same-Project, full-readable TaskArtifact association; Artifact/Run gates remain.
- POST `/:taskId/reference-result` takes the versioned problem-work command with
  `reference_result` intent and adds the linked Task input reference. Explicit
  output Artifacts must belong to this Task. All references are revalidated;
  the 20-input budget includes the Task pointer. This is evidence collection,
  never cognition acceptance or a close-out.

New Agent actions `inquiry.link_task`, `inquiry.list_tasks` and
`inquiry.reference_task_result` require explicit Run grants. Writes reuse
`inquiry.work.record` policy and its unattended-origin approval boundary; reads
reuse `inquiry.problem.read`. Their Agent inputs take no idempotency key: the
receipt uses the dispatcher call id and Run attempt (call ids restart on a
Supervisor retry) in a `call` namespace that model-supplied keys cannot reach.
The actor/Run source is recorded on the canonical events. Only server callers
set a Task's Run origin: HTTP Task creation ignores a body `source_run_id`, so a
request cannot attribute its Task, link events or creation ceiling to another
Run. Tasks created through a link keep their `required_outputs`. Task creation
through ordinary/batch commands retains the normal per-turn ceiling or explicit
bounded-list exception.

Tasks finishing does not close the problem; closing a round does not change any
linked Task. Failed Runs settle only the Task through existing finalization
rules. Generic foreground Steps remain the only next-work authority; a long-lived
Task link does not open a primary Step or force the five-stage method.

Association writes, Task updates, review/completion and planning admission use
Project authority locks before Task row locks, then re-read Task state/scope.
A scope change during admission returns a conflict rather than admitting a Run
in the stale Project. A Task with existing Inquiry links cannot move to another
Project (or lose its Project), preserving the endpoint contract; unlinked Tasks
retain normal Project moves. No relation is silently removed on a move.

The P4 shared association fact writer lives in `taskLinkFacts.ts` (a leaf with
no Task repository/service import). `linkTaskEntities` routes every Thread edge
through it, including repository and single/batch Task creation/update. Only
active lifecycle accepts writes; all new edges have one revision advance and
both canonical events. Read access to older nonactive associations is retained.
Verified Run creation is shared like ordinary Room `task.create`; human defaults
and existing Task visibility are unchanged. See [Project Work](PROJECT_WORK.md)
for blocker, terminal-state, dispatch-event and visibility rules.

## Project-local workspace (P5)

`/projects/:projectId/inquiry` is presented as Problems / 问题推进. The list is
keyset-paged (50), searchable, and includes active/history filters. Its compact
judgment excerpt requires full Thread access; summary readers receive no
cognitive body. Definition/detail and the problem projection retain their own
content gates. `can_write` is advisory presentation metadata; mutations still
recheck Project/Thread authority and lifecycle transactionally.

The five stage buttons only change URL navigation. Explicit work selection,
skip (including the skipped stage), return, evidence reference and round
closeout use existing versioned commands. The open primary is current focus;
worked/output/running indicators come from server facts independently. Changed
judgment uses cognitive Iteration with `round_intent=close_round`; unchanged
judgment uses only closeout. Neither completes a Task or Research call.
History pages closeouts and work independently; cognitive Iterations remain a
separate history.

A nullable `scope_boundary` is part of the Thread definition, introduced by
Drizzle migration `0009_problem_engine`. Only a semantic Definition revision changes it, using
the existing Project/Thread locks, version increment and immutable revision
snapshot. Older snapshots are preserved. It is not a cognitive judgment patch.
Question resolution criteria and hypothesis falsification criteria use the same
existing Definition route. FINER remains an optional question assessment link.

The Task section uses P4 create-and-link, existing-link, paged reads and explicit
result references. It shows canonical Task status and opens the Project Task
surface with the existing problem backlink; it has no Task method stage.
The Research section uses bound P3 calls/results and explicit applicability
assessment into Verify. Read-only/closed Threads retain readable history;
backend gates remain authoritative for stale clients.

One-time offline cutover and static archives are documented in [the upgrade guide](PROBLEM_ENGINE_UPGRADE.md).
