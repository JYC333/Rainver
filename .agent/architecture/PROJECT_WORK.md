# Project Work

Current state of how a Project advances: the work event stream, the Loop stage
fold, and Run settlement. Owned by `server/src/modules/projectWork/`.

It sits between `tasks` (the editable work commitment) and `runs` (one attempt
at it) and owns neither. See [`TASK_BOARD_MODEL.md`](TASK_BOARD_MODEL.md) for
the Task/Board domain and [`EXECUTION_MODEL.md`](EXECUTION_MODEL.md) for Run,
Attempt and Supervisor.

## 1. Four state axes, not one status

A Task carries more than one situation at a time, and merging them into one
column is what made "why is this not finished" unanswerable.

| Axis | Where it lives | Answers |
|---|---|---|
| **Flow state** | `tasks.status` | Where the work sits in the queue. Board columns show this. |
| **Loop stage** | `task_loop_states.current_stage_key` | Which *kind* of problem the work is solving now. |
| **Acceptance** | `task.accepted` event + `tasks.completed_at` | Whether the result was taken, and on what basis. |
| **Execution** | `runs.status` per attempt | How one attempt went. |

Flow vocabulary: `inbox · ready · in_progress · waiting_for_review · blocked ·
done · cancelled`. `ck_tasks_status` and `ck_board_columns_status_key` carry
the same list, because a status with no column to sit in is a card the Board
cannot show.

`waiting_for_review` means **a person has to decide**. `blocked` means **held
up by something else** and is only ever set deliberately — Run outcomes no
longer write it.

## 2. The five Loop stages

`frame → plan → act → verify → conclude`, declared in
`packages/protocol/src/projectWork.ts`.

A **system constant**, not per-Project configuration. `primary_mode` swaps the
labels (`verify` reads *Evaluate* in a research Project and *Verify* in a
delivery one) and changes nothing else — same keys, same order, same meaning
everywhere. A versioned per-Project loop definition would carry only those
labels, which does not justify a configuration table with a publish lifecycle.

Movement is classified, not restricted. `stageTransitionKind()` reads the
ordering to label a move `advance / regress / skip / reopen`:

- **skip** — a Task that does not need a plan should not have to pretend it
  made one.
- **regress** — verification that fails because the method was wrong belongs
  back at `plan`; because the goal was misunderstood, back at `frame`.

This is why the stage is **stored rather than derived**. A Task that skipped
planning and one still planning have identical surrounding facts; so do one
sent back after a failed check and one that has already verified. Only an
actor's decision separates them, so the decision is what gets recorded.

## 3. The event stream is the authority

`project_work_events` is append-only and Project-scoped. `task_loop_states`
and the Task's own columns are **folds** of it, rebuildable at any time.

`run_events` is deliberately not extended for this: it is Run-scoped harness
evidence with a Run's lifetime, and Project advancement outlives every Run that
produced it.

Envelope: `event_kind · subject_type/subject_id · actor_id · occurred_at ·
correlation_id · causation_id · idempotency_key · data_json`.

- **Actor-neutral from the start.** `actor_id` is an `actors` FK, which already
  spans user, agent, system, automation, connector, integration, service and
  job. A handoff whose recipient could only be an Agent would need redesigning
  the first time the answer is "wait for the supplier" or "wait for Tuesday".
- **Idempotency is the design point.** At-least-once delivery means settlement
  re-enters with the same facts; a partial unique index on
  `(space_id, idempotency_key)` is the dedupe, so a retry inserts
  optimistically and treats the conflict as success.
- **`event_kind` carries a format check only.** The closed set lives in
  `modules/projectWork/eventKinds.ts`, open for modules and plugins to register
  into, exactly as link types are. A demoted constraint is only safe while
  something asks the registry — `assertWorkEventKind` is that something, and it
  is called from the one writer.

`eventWriter.ts` is the only place that writes the table. A test asserts no
second writer appears, and asserts it before any of the writer's own rules,
because hardening a choke point is worthless if a domain can hand-roll the
insert next to it.

### Kinds

`task.created · task.flow_changed · task.stage_changed · task.accepted ·
task.responsibility_changed · task.run_settled · task.reported ·
project.reported · thread.created · thread.archived · thread.reopened ·
thread.concluded · thread.next_step_adopted · memory.remembered ·
memory.revised · memory.archived`

The `thread.*` kinds are Inquiry advancement, subject `inquiry_thread`,
declared by the `inquiry` module in the same registry. They exist because
[ADR 0017](../decisions/0017-authorization-by-cost-not-authorship.md) §4 makes
a direct write conditional on the person seeing it afterwards and being able
to reverse it: this stream is where they see it. Each carries the statement,
`origin` (`agent`/`user`), the `run_id` when a Run did it, and a `batch_key`
(`<run id>:<kind>`) so one turn's writes of one kind fold into one row.
`thread.concluded` also carries the Iteration id and both positions, because
reverting a conclusion means recording the position it replaced.

The `memory.*` kinds are the same arrangement for what an Agent chose to
remember during Project work, subject `memory_entry`, declared by the
`memory` module ([ADR 0003](../decisions/0003-memory-proposal-flow.md) §3).
The entry itself is user-scoped and carries no Project — a user-scoped memory
may not, by `ck_memory_entries_scope_placement` — so this event is what ties
the write to the work it happened during. `memory.archived` is the reversal
and offers no undo of its own: restoring is done from the Memory page, where
the whole version chain is readable. The attribution, folding and undo
linkage of every direct write live in one place,
`projectWork/domainWorkEvents.ts`; `inquiry/threadWorkEvents.ts` fixes its
subject to a Thread and adds nothing else.

`task.reported` / `project.reported` are the **readable account** — what an
actor did and concluded, at Task close-out and as a periodic cross-Task
summary. An "Updates" surface is a filter over these rather than a second
table: a separate `project_updates` table would let the readable account and
the machine record disagree, with no way to resolve which was right.

## 4. Run settlement

`settlement.ts` decides what a finished Run means for its Task.

**Settleable** requires that every *execution* Run of the Task has stopped
advancing: `succeeded · degraded · failed · cancelled · waiting_for_review`.
`orphaned` is deliberately absent — crash recovery terminalises the orphaned
attempt and the Supervisor creates the next one, so settling on it would
settle mid-retry. `task_runs.role ∈ planning, review` are not execution: a
planning Run (*Ask Agent to plan*) does not advance the work, and a successful
plan closing its Task was the most wrong answer the old projection could give.

**Decided** additionally requires the latest Run to carry a `run_finalizations`
row, unless it is `cancelled`. Finalization is where the evaluation is bridged
into `task_evaluations` and where the Supervisor decides retry-or-hold; before
it, a succeeded Run has no evaluation and a failed Run may be about to retry.
A policy pause is also `waiting_for_review` but is not finalized and the same
attempt resumes after approval — it correctly does not settle. Cancellation is
a person's decision with nothing to evaluate.

**Trigger.** Settlement is registered as a run-finalization reconciler
(`projectWork/finalizationReconciler.ts`); the registry runs after the
evaluation bridge, the finalization row and the Supervisor decision. The
terminal-status-time call (`publishRunTerminalWithConversationSession`,
`markRunDegraded`, stale-Run recovery, job cancellation) still runs; it settles
`cancelled` immediately and finds nothing decided for everything else.

The decision reads the **latest** execution Run, then:

| Run | Task |
|---|---|
| `succeeded` / `degraded`, evaluation recommends `accept`, declared outputs present | `done` + `task.accepted`, stage → `conclude` |
| `succeeded` / `degraded`, anything else | `waiting_for_review`, stage → `verify` |
| `failed` · `cancelled` · `waiting_for_review` | `waiting_for_review`, **stage unchanged** |
| `orphaned` | not settled |

Two Tasks are never touched by settlement. A `blocked` one: that is a
person's deliberate hold, never written by a Run and not erased by one. And a
`waiting_for_review` one **for the Run that was in flight when it was parked**
— an Agent that handed a decision back must not watch settlement close the
Task under it. The guard is causal rather than by status: a Run started
*after* the hold is the person's answer, and its result counts. (By status,
a retry from `waiting_for_review` was discarded and the Task waited forever.)

Failure and cancellation produce nothing to verify, so they do not move the
stage: claiming the work reached a phase it never reached would be a lie the
Board then displays. Where it goes next is a person's or an agent's decision.

The `task.run_settled` idempotency key carries the outcome reason: the same
Run can settle the same Task twice with different facts (held for a missing
output, then closed once it is attached), and a key without the outcome
swallowed the second settlement, leaving a status change the stream did not
explain.

`task_evaluations` is load-bearing here. `RunFinalization` already projects
every run evaluation into one, with `recommendation ∈ accept / review / retry /
needs_evidence` and deterministic verification status — the previous projection
simply never read it.

Required outputs: each entry in `tasks.required_outputs_json` is matched
case-insensitively against the `artifact_type` of the Task's `role = 'output'`
artifacts. An empty or absent declaration imposes no gate.

### What this replaced

`bool_and(terminal) AND NOT bool_or(failure)` over **every Run the Task ever
had**, with two defects pulling in opposite directions:

- `bool_or` never expired, so one failed attempt made a Task permanently
  unclosable: every later success still saw the old failure and wrote `blocked`
  again. Re-running after a failure is the normal case, which is why this read
  as a permanent state rather than a transient one.
- Three of the four statuses it counted as failure are not failures.

And the status it should have counted it could not see: `waiting_for_review` is
what the Supervisor writes when it stops retrying, and it was absent from the
terminal set — so a Run parked for a human decision settled nothing and left
its Task in `in_progress` with no sign a person was needed.

## 5. Who is interrupted

One responsible party per Task, resolved as a chain read whole, in **one**
place (`responsibility.ts`) because four surfaces ask it — the attention
adapter ("interrupt whom"), the Board ("whose card"), `/me/tasks` and
`/tasks?assigned_to_me` ("what is mine"). Two of those last three carried their
own narrower definition before P2, and one of them counted a Task an Agent had
claimed as still yours:

```
claimed_by_user → claimed_by_agent → assigned_user → assigned_agent
  → created_by_user → project owner
```

An Agent that claimed a Task is the responsible party even when a person is
assigned, because the person handed it over. The Project owner is the floor:
an Agent-created, unassigned Task has no person anywhere else in the chain and
would otherwise wait for review while interrupting nobody.

**The chain is status-aware, and this is the handback.** In
`waiting_for_review` and `blocked` — `PERSON_ONLY_TASK_STATUSES`, shared from
the protocol so the chain, the Board badge and the Board filter cannot drift —
it steps past the Agent to the person behind it. Those two states are *defined*
as needing a person, so stopping at an Agent left the Task with nobody to
interrupt and it waited forever: no attention item, no Board `needs me`, and a
Pulse that listed it as "In progress". There is no separate release step,
because `waiting_for_review` has six producers and `blocked` has no Agent
writer at all, so a release would have to be remembered in seven places instead
of being a property of the state.

The claim is deliberately **not** cleared. Who did the work and who must now
decide are different questions, and overwriting the first to answer the second
loses the only record of which Agent to hand the work back to. While an Agent
holds a Task in any other status it interrupts nobody, which is the boundary
between *Agent Next* and *Needs You*.

The Delivery attention adapter surfaces `waiting_for_review`, `blocked` and
overdue Tasks **to the responsible person only**. Everyone else still sees the
Task and can take it over; they are simply not told to. A shared inbox was the
alternative and it fails in both directions at once — everyone assumes someone
else has it, or two people start the same work.

## 6. Entry point and transaction boundary

`tasks/taskRunStatusProjection.ts` stays the entry point called by the runs and
jobs repositories, so the host-thread queue lock is taken where it always was.
It delegates the decision here because settling a Task writes work events and
moves its Loop stage as well as its flow status, and those are one transaction
rather than three modules agreeing afterwards.

A settled Task has its queued host-thread messages withdrawn — whether it
finished or stopped for review. Letting a queued message dispatch into a fresh
Run behind that decision is what the withdrawal prevents.

That queue-settling set (`waiting_for_review · blocked · done · cancelled`) is
**not** the dispatch-refusal set (`blocked · done · cancelled`). A person may
run a `waiting_for_review` Task again — re-running is one of the decisions the
hold exists to ask for — and the first version of this layer conflated the two
sets and made the hold a dead end.

Every append-only surface that records who acted resolves its `actors` row
through `db/actorResolver.ts`. Two partial unique indexes (one person per
Space, one service name per Space) make its insert-on-conflict real; without
them two concurrent first writes for the same person produced two actors.

## 7. Read models and the surfaces over them

`GET /projects/:projectId/board` and `GET /tasks/:taskId/work` are the two read
models (`boardReadModel.ts`). They exist because the client cannot answer their
questions from domain rows alone — which stage a Task is in, who is on the
hook, why it cannot close — and reconstructing any of it in the browser would
put a second copy of the rules where nothing tests them against the write path.
Both are one statement plus their bounded detail queries; the completion check
reads attached outputs in the same query rather than per card.

Card lanes are flow statuses. `cancelled` is archived off the Board, and
`blocked` is an **overlay**: it keeps its own status and carries a
`column_key` naming the lane it is drawn in, because a status with no lane is a
card that is counted and then never drawn.

Person-facing writes:

- `PATCH /tasks/:taskId` records `task.flow_changed`, and `task.accepted` when
  the move closes the Task. A close whose declared requirements are unmet is
  refused with `completion_requirements_unmet`; supplying
  `override_completion.acknowledged` lets it through and records exactly what
  was skipped, so the record says the Task was closed early rather than that it
  met its bar. The gate reads the **stored** declaration, never one edited in
  the same request.
- `POST /tasks/:taskId/stage` records `task.stage_changed` through the same
  `recordStageChange` the agent path will use.
- `POST /tasks` records `task.created`, in the same transaction as the insert.

### Updates

`GET /projects/:projectId/updates` (`updatesReadModel.ts`) is the third read
model: the same stream filtered to `task.reported`, `project.reported`,
`task.accepted` (a Task closing is an update; nothing writes a report for it,
so the acceptance is rendered as itself), the five `thread.*` kinds and the
three `memory.*` kinds, newest first. Task lifecycle kinds stay out — Board state is not a readable
account and has its own surface.

Each row names its `subject` (`task`, `inquiry_thread` or `memory_entry` —
`project.reported`
carries none, since no read model joins `projects` and an unreachable third
member would be speculative) and, where the
advancement can be put back, an `undo` (`archive_thread`, `reopen_thread`,
`revert_iteration`, `archive_memory`) that `POST /projects/:projectId/updates/:eventId/undo`
dispatches to the owning domain command. Undo is an ordinary `manual`-origin
write: it goes through `transitionLifecycle`/`recordIteration` under their own
authority checks and locks, records its own event naming the one it reversed
(`data_json.undo_of_event_id`, set only by the undo path and never readable
from a request body), and the reversed row then reports `undone_by_event_id`
and offers no second undo. The whole load-guard-dispatch runs in one
transaction, so two concurrent undos cannot both revert the same conclusion.
Rows sharing a `batch_key` collapse into one update whose `members` keep their
own undo; the fold itself has none, and folding is a read concern only —
storage stays one row per event. It is a filter and not a table, because a separate
`project_updates` would let the readable account and the machine record drift
with no way afterwards to say which was right. An update whose subject Task the
reader cannot see contributes no row — the title is the part worth reading, so
dropping the row is the only honest option.

Its cursor carries **both** ordering columns (`occurred_at|id`), because
`project_work_events.id` is a v4 UUID with no time component: a keyset
predicate on the id alone cuts the stream at a random point, returning half of
the page just read and making everything below the cut unreachable. A cursor
the endpoint did not issue is refused with 422 rather than silently restarting,
which would loop "load more" over page one forever.

The response carries `viewer_can_write`, because reading the account and adding
to it are different permissions: `GET` needs Project read, `POST
/projects/:projectId/updates` takes the Project lock and requires a writer. The
surface has to be told which it has, or a `viewer` gets a composer that always
refuses.

### What the person is looking at

A Room message may carry `focus_refs` — at most four, Task only. The Room is
already bound to one Project, so a `project` focus said nothing the turn did
not already carry. The server states it as one sentence inside the existing
`project_state_context` prompt block (`describeRoomFocus`), so `"is this one
done?"` resolves without the person restating which Task they mean. It is a
hint and never a filter: retrieval keeps its Project scope either way.

Two gates, because that sentence travels further than the person who caused it.
The sender must be able to read the Task (`contentReadSql`), and the Task must
be `space_shared` — the sentence is written into the prompt of a Run whose
output every active Room member can read, and the focus is derived from the
route rather than typed, so a `private` or `selected_users` Task would be
disclosed by navigation alone. The person can still ask about it in words,
which is a deliberate act. What was injected is recorded on the dispatched
message as `metadata_json.injected_focus_task_ids`, so "which Task entered
which turn" is a query rather than a search through prompt text.

## 8. What an Agent may do

Five System Actions (`projectWork/taskActions.ts`,
`projectWorkSystemActionExecutors.ts`), on the Room conversation tool surface:

| Action | Writes | Records |
|---|---|---|
| `task.create` | a Task, and its `task_entity_links` | `task.created` |
| `task.report` | nothing | `task.reported` |
| `task.handoff` | the claim on a Task | `task.responsibility_changed` |
| `task.advance_stage` | the Loop fold | `task.stage_changed` |
| `task.request_review` | `status = waiting_for_review` | `task.flow_changed` + `task.reported` |

They are the smallest set that lets an Agent advance work at all: name a piece
of it, say what happened, give it to someone else, move it through its Loop,
and stop to ask. Without them an Agent could describe a decomposition in a
reply but not create it — the gap between sounding like it advanced the work
and having advanced it.

**`task.request_review` is what makes "a person is involved only at the points
that are theirs" true rather than aspirational.** Without a deliberate way to
hand a decision back, the only signals a person gets are failures.

### The origin gate

`task.create` and `task.advance_stage` are `require_approval` when the Run's
`trigger_origin` is `autonomous` or `automation`
(`ruleUnattendedProjectWrite` in `decisionCore.ts`). The same action definition
serves both origins, because it is the same write — what differs is who wanted
it. A person saying "split this into three tasks" *is* the authorization for
the Tasks that follow; the identical call from an unattended wake-up is a
commitment made on the Project's behalf that nobody asked for, and a Loop stage
skipped or reversed without a person seeing it is a claim about the work.

The other three are ungated at any origin. A report only records, a handoff can
only give work away, and a review request can only stop work — none can take
ground. Gating them would mean an Agent advancing work unattended could not say
what it had done, which is the opposite of what the origin gate is for.

The origin the rule reads is the **root** Run's: a delegated child carries
`delegation` whoever started the chain, so reading its own would let an
unattended root launder a gated write through a specialist. And the attended
set is an allowlist (`manual`) rather than a denylist, so a new origin is gated
until someone decides it should not be.

`require_approval` here is a **refusal**, not a prompt: nothing in P3 produces
an unattended Project write, because the Steward that would is P6. When that
lands, the right shape for `task.create` under an autonomous origin is a
proposal — the person sees the draft cards — rather than an approval dialog.
Until then the gate is a closed door with nothing behind it, which is the
correct state for a capability that has no caller.

Two definitions — one "manual" and one "autonomous" — were the alternative, and
would have meant two schemas, two executors, and two places to forget one.

### Attribution

A Task an Agent creates is **owned** by the person who asked (it inherits their
access) but its `task.created` is **attributed to the Agent**. The timeline
records who did what, and a Task the Agent decomposed out of a request did not
appear because the person typed it. `task.created` is keyed on the Task, so a
second write cannot correct this afterwards — the attribution has to be right
the first time.

### Handoff recipients

A handoff target must already be able to see the Task's Project: a person who
is a Project member or its owner, or an Agent that is Space-wide or bound to
this Project. An Agent that could hand a Task to anyone in the Space would be a
way to disclose it. `to: null` releases the claim back to the assignment chain.

### Deferred, recorded

`task.create` writes `visibility: "space_shared"`, discarding the narrowing a
Room Run carries (Room runs are `selected_users` scoped to the Room's
members). Threading it through would need `createTask` to write
`content_access_grants`, which it has no path for — narrowing without the
grants would leave the Task readable by its owner alone, which is worse than
the current widening. A Task-domain change, recorded rather than done.

## 9. Not here yet

- An Agent-written `project.reported`. `POST /projects/:projectId/updates` is
  the only producer and it is a person's; the Steward that would post a
  cross-Task summary is later. Task close-out likewise writes no
  `task.reported` — the readable account belongs to whoever wrote one — so
  Updates renders the `task.accepted` event itself rather than inventing prose
  for it.
- Actor-neutral handoff with join and resume semantics, plus role/capability
  declaration on the contract. `task.handoff` as a single responsibility
  transfer is the intended starting point.
- **Steward autonomy.** Event-triggered wake-up on `task.run_settled` /
  `task.reported`, with per-Project autonomy settings (level, budget, wake
  policy). Not a Steward *binding* — P5 already fixes the Agent identity, one
  instance per Project. Under an autonomous origin `task.create` becomes a
  proposal rather than a write, which is what the `unattended_project_write`
  rule in `decisionCore.ts` already anticipates.
- **Roadmap and dependencies.** Milestone nodes and a live `task_dependencies`
  table; both are new designs, not extensions of this one.

**Known smaller gaps**, recorded so they are decisions rather than oversights:

- A flow status with no Board lane would be counted and never drawn.
  `ck_tasks_status` and `ck_board_columns_status_key` carry the same list and
  `COLUMN_FOR_STATUS` maps the one exception, so it is unreachable today —
  but nothing enforces the correspondence.
- The Delivery attention adapter uses the same responsibility SQL as the
  Board, but its own coverage is fixture-staged rather than database-backed;
  the chain itself is exercised against real Postgres through the Board.
- The four Task-addressed Agent actions carry no Run-to-Project constraint
  (`task.create` does), so a Project's Assistant can append to another
  Project's stream if instructed by someone who can read both. Recorded in
  `SYSTEM_ACTIONS.md` as intended — an Agent's reach is the instructing
  person's — but it sits awkwardly beside one-Assistant-per-Project.
- No periodic job re-materializes a managed Assistant when its seed changes;
  it happens on the next Room creation in that Project. See
  [`../modules/agents.md`](../modules/agents.md).

**Who may write.** Reading a Task is not licence to change it. `PATCH
/tasks/:taskId`, `POST /tasks/:taskId/stage` and the four Task-addressed Agent
actions all require Project **writer** authority
(`assertProjectWriterForMutation`) on the Task's Project — and, for a move, on
the Project it is moving to. A Project `viewer` can read every shared Task and
change none of them, through an Agent exactly as directly. The Board says so
(`viewer_can_write`) and offers a viewer no drag. `PATCH` also reads the row
under the transaction's lock, so two people closing the same Task at once
record one acceptance, not two. A viewer may still *talk* about a Task in the
Project's mainline Room; the Agent they talk to is bound by the same rule
(`modules/rooms.md`). A consequence worth knowing: a Task still bound to a
soft-deleted Project cannot be edited by anyone, because writer authority is
checked against a live Project.
