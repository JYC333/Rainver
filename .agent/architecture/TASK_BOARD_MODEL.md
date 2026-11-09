# Task board model

Implemented separation: [ADR 0027](../decisions/0027-problem-engine-research-separation.md)
places method/round authority in [Inquiry](INQUIRY_PROBLEM_ENGINE.md) and
execution-call authority in [Research](PROJECT_RESEARCH_CALLS.md). Tasks retain
one Board status; Plan remains the execution graph of one source Task.



This document describes the **agent-native task board** domain layer.
The Project Board UI at `/projects/:projectId/board` reads
`GET /projects/:id/board`. There is no separate space-level Kanban product
outside the Project shell.

## Core separation

- **Board** — A Space-scoped work surface, normally bound to a Project (`boards.project_id`; it may also name a Project Folder). Groups columns and tasks for planning and visibility; the Project Board reads the Project's active Board.
- **Task** — The **product-level work item**. Humans and agents share this vocabulary. Tasks carry acceptance criteria, priority, assignment, and lifecycle status **independent of the job queue**.
- **Task role** — `source` identifies a user/Agent-owned product goal and may
  own one Agent-generated Plan; `subtask` is an ordinary product child Task.
  `task_type` remains the business classification and is never a Plan-node
  discriminator.
- **Plan Node** — An internal step in an Agent Plan. It lives in
  `plan_nodes`, not in `tasks`, and links to physical Runs through
  `plan_node_runs`. It is not shown in the Task board. Its contract fields are
  an immutable PlanVersion snapshot after insertion; execution may update only
  lifecycle fields such as status, blocking/checkpoint state, and timestamps.
- **Run** — One **logical execution** for an agent (or system workflow), carrying an immutable contract snapshot. A task may have many runs over time (re-execution, validation passes, reviews). Physical retries live one level below: a Run owns `run_attempts` rows, and Supervisor retries create a new attempt under the same Run rather than a new Run (see EXECUTION_MODEL.md).
- **Job** — An **infrastructure queue row** (`jobs` table). Used for workers, retries, and dispatch plumbing. **Jobs are not product tasks** and must not be used as the source of truth for user-visible task state.
- **Artifact** — Output attached to a run or task (files, reports, logs). Linked to tasks through `task_artifacts` when needed.
- **Proposal** — A requested system change (for example memory updates). Linked to tasks through `task_proposals`. **Task done does not imply a proposal was applied** — approval is a separate workflow.
- **Evaluation** — Review of a task or run. `RunFinalization` projects every run
  evaluation into a `task_evaluations` row carrying `recommendation` ∈ `accept` /
  `review` / `retry` / `needs_evidence`, and Run settlement reads it: a Task closes
  only when the evaluation accepted the result. See
  [`PROJECT_WORK.md`](PROJECT_WORK.md).

## Relationships

- A task may optionally sit on a **board** and **column** (`board_id`, `column_id`).
- A task links to many **runs** via `task_runs` (roles such as `primary`, `retry`, `review`).
- A TaskRun creates its Run with an immutable `runs.contract_snapshot_json`
  carrying the Task's acceptance criteria, definition of done, required
  outputs, project/Project Folder binding, risk, budget caps, and route hints. The
  snapshot is the execution input; later Task edits do not rewrite prior Runs.
- A task links to **artifacts** and **proposals** through junction tables with roles (for example `output`, `evidence`, `main_change`). `task_artifacts.run_id` records the task-run context for a selected artifact when known; `artifacts.run_id` remains the artifact's producing run.
- Dependencies between tasks use `task_dependencies` (`blocks`, `requires`, `related`, etc.).

## Planning boundary

Creating a source Task does not create a Plan. Task Detail may enqueue a
`planning` Run through `POST /api/v1/tasks/{id}/plan-requests`; the Agent then
uses `task.plan.propose` to create or revise the Task's PlanVersion. Human
users review and execute an approved Plan, but do not submit raw Plan
definitions through a public Plan-create API. A fixed Workflow Automation has
its own `WorkflowExecution` aggregate and never creates Plan Nodes or Task
rows.

`tasks` is the only editable work-item model: title, description, assignment,
priority, acceptance criteria, budget, and board placement may be revised by
the Task API. Those edits never rewrite an existing `plan_node` or
`workflow_execution_node`. The three tables intentionally remain separate
because editable product work, immutable versioned planning snapshots, and
immutable execution instances have different lifecycles.

## Agent–human collaboration

Boards and tasks are scoped by **space** and optionally a **Project** (and Project Folder). Assignments may reference both users and agents. The API enforces space boundaries so cross-space references are rejected.

## Task ↔ Run linkage

- **Canonical:** `task_runs` (`TaskRun` ORM) — every product association between a `Task` and a `Run` that the task board should list or join on **must** go through this table. `GET /api/v1/tasks/{id}/runs` is implemented by querying `TaskRun`, then loading `Run` rows by id.
- There is **no `runs.task_id` column** in the canonical schema. `task_runs` is the only Task ↔ Run linkage; do not reintroduce a denormalized shortcut column on `runs`.

**Task is not Job.** Jobs (`jobs` table) are infrastructure queue rows with their own `attempts` counter; that counter is queue plumbing and is unrelated to `run_attempts`. The Supervisor enqueues each retry job with `max_attempts: 3` (`runs/supervisor.ts`); that queue budget covers delivery of one job and is not counted as a Run attempt.

## Execution boundary

`POST /api/v1/tasks/{id}/runs` creates a **queued** `Run` (plus its initial attempt) through the runs repository inside one transaction with the `max_runs` admission lock, inserts a `task_runs` row (canonical), and may move the task to `in_progress`. It does **not** call runtime adapters or enqueue infrastructure jobs. Running the same Task again always creates a new Run and a new `task_runs` row; a terminal Run is never reopened by user request.

`PATCH /api/v1/tasks/{id}` leaves an omitted nullable column unchanged and
stores an explicit `null`. For `max_runs`, `max_cost` and
`max_duration_seconds`, `null` means the Task sets no such limit: the next
Run's contract snapshot carries none from the Task (a Space budget still
applies). The Web contract editor therefore sends `null` when a person clears a
stored limit, shows "No limit" for an empty field, and omits a field that was
empty and untouched.

On an execution host, a Task's write-capable execution Runs share one branch,
`rainver/task-<task_id>`, in a worktree the daemon owns, and run one at a time
(the `agent_run` job waits while another of them has not ended); each Run ends
as one commit on that branch. A Task that reaches `done` by any path is merged
into each such Location's main branch (a `task_merges` row and `task_merge`
job per Location: squash, merge onto the main branch, a conflict to the Task's Agent through a
`task_runs.role = 'merge'` Run and then the person, the Task's checks again,
fast-forward; a Run that settles after the Task closed gets a merge of its
own). A Task that leaves `done` withdraws its merges, a merge's
conflict-resolution Run is the one Run admitted on a `done` Task, and a Task
cancelled or deleted has its branch removed from every Location its Runs
worked on (a durable `task_branch_delete` job per Location). See [`modules/hosts.md`](../modules/hosts.md), "Location
lease, Task worktrees and `git_after`", and ADR 0016 §11.

A Run finishing is not the Task finishing. Settlement runs when every Run of the Task has stopped advancing, reads the **latest** one, and closes the Task only on an accepted evaluation with its declared outputs present; everything else holds the Task in `waiting_for_review` for a person. `blocked` is not written by a Run outcome — it means held up by something else. See [`PROJECT_WORK.md`](PROJECT_WORK.md).

## Frontend

Tasks expose only their Board status as progress. Task Detail retains completion
requirements, responsibility and history; the former internal Loop stage rail
and editor are retired. Agent `task.set_status` changes that same Board status.

The Project Board at `/projects/:projectId/board` is the Task surface: a
drag-and-drop Kanban over the ACL-filtered server read model
(`GET /projects/:id/board`), with lanes from `board_columns` or the defaults,
`blocked` drawn as an overlay in the lane the work sits in, and a drag to Done
refused when the Task has not met what it declared. A Project's Task also opens
inside the Project shell at `/projects/:projectId/tasks/:taskId`. See
[`PROJECT_WORK.md`](PROJECT_WORK.md) and
[`FRONTEND_INFORMATION_ARCHITECTURE.md`](FRONTEND_INFORMATION_ARCHITECTURE.md).

The Board read model includes the Task's nullable `completed_at`. Each lane
initially shows at most 20 Done Tasks completed within the last seven days;
Tasks without a known completion time remain eligible for that initial set.
Older and excess Done Tasks can be expanded 20 at a time and collapsed again.
This is local presentation state, preserves full lane counts, and never hides
non-Done Tasks or changes Task status. Lane card lists scroll independently
within the visible Board height; drag previews use an overlay outside the clips.

## Obsolete patterns (do not reintroduce)

- `POST /api/v1/tasks/{id}/run` (singular **`/run`**) that returned a `Job` and enqueued worker execution.
- Storing product tasks as `Job` rows with `job_type="product_task"` (or any **Task = Job** mapping).

## Problem association boundary

P4 reuses `task_entity_links` for many-to-many Inquiry associations. Creation
and linking share the canonical Task transaction; both endpoints must be
fully readable and in the same Space/Project. The Task remains one record
with its original owner, visibility, status, completion bar and Plan. Linking
neither starts a method nor copies a Task per problem. Task Work returns only
currently readable problem backlinks. Result references remain evidence for
explicit Inquiry judgment. See [Inquiry](INQUIRY_PROBLEM_ENGINE.md) for routes,
Agent tools and bounded reads; [Project Work](PROJECT_WORK.md) for historical
absence of old stage APIs/DTOs and one-time archived history.

## Task deletion

`DELETE /api/v1/tasks/:id` and the Agent `task.delete` action share
`tasks/deleteTask.ts`. Deletion sets `deleted_at`, hides the Task from normal
lists, Board and detail reads, and preserves its status, execution records,
outputs and audit evidence. It never marks work complete or deletes linked
problems. Full Task content access and Project writer authority are required;
private/foreign-scope targets are not disclosed. Repeated authorized deletion
is a no-op. Unfinished Runs (including review/cancellation waits) or an active
Plan cause409; stop execution before deleting. Branch cleanup and merge
withdrawal use the existing durable mechanisms, atomically with `task.deleted`.
PATCH cannot edit `deleted_at`; use the named deletion action.

Task Detail provides a destructive confirmation dialog and returns to its
parent Board/list after success. The Agent action takes a Task ID from
`task.list` and a reason, preserves trusted Run/actor provenance and applies the
same unattended-origin approval gate as other structural Task writes. It is
not a substitute for completion/cancellation and should be used only on the
person's deletion request. No hard-delete or bulk-delete interface is exposed.

## Project-local columns and card actions

Project Board columns have stable identities separate from their lifecycle
`status_key`. Several columns may share a lifecycle (for example Design and
Build both mean `in_progress`). Names, ordering and WIP hints are local to the
Project's selected active Board, using the existing `boards`/`board_columns`
rows. No separate database, workflow engine or browser-local configuration is
introduced. Before configuration, the normal five default lanes are read-only
projections; the first explicit save materializes them without changing Task
status or ownership.

`PUT /api/v1/projects/:id/board/columns` is a thin adapter to the core
`board.configure` command. An explicit Idempotency-Key is required; it saves a complete ordered configuration
with the read model's `columns_revision`. The Project must be active and the
caller a writer. A stale revision returns409. Existing columns can be renamed, reordered or assigned a different lifecycle
meaning. A meaning change migrates the column's current Tasks through the same
Task mutation and completion gates, in the same transaction. New columns choose
a lifecycle meaning. At least one column remains; the editor supports up to30.
Deletion requires an explicit destination for any Tasks the column currently
draws. Relocations call the same Task mutation service inside the configuration
transaction: Task content authority and the normal Done completion gate still
apply. Any refusal rolls back the entire save. Private Tasks are never silently
moved by another Project writer. Removing a column never deletes a Task.

Task placement uses `column_id` only while compatible with its current
lifecycle. Run settlement and Agent status changes therefore place the card in
a matching lane instead of leaving it visually Done or stranded. Unmapped
statuses appear in a non-droppable Unassigned lane until a matching column is
added or the Task is explicitly moved. A blocked Task can remain an overlay on
an in-progress column; moving between equivalent columns does not unblock it.

Clicking the six-dot card grip opens the same actions as right-clicking the
card. Right-click actions open at the pointer, with viewport collision handling;
grip-click actions remain anchored to the grip. Left-dragging the card body,
title or grip moves the Task while a normal title click still opens it. Enter opens actions; Space, arrow keys
and Space perform keyboard movement. Viewers get only the Open action. Writers
may edit title/description or request deletion with confirmation, using normal
Task APIs. Each eligible column and the Board header offer Task creation; the
Done lane does not create pre-completed Tasks. Destructive/permission refusals
remain visible without hiding the card. Column names edit in place when clicked,
keeping the label's compact width, height, font and spacing so the header controls do not move.
Leaving the input or pressing Enter saves only a changed, nonempty name;
unchanged names do not write, and Escape or an empty name retains the stored
name. There are no Save/Cancel controls for renaming. A failed save keeps the
input and error for retry. Each column header displays its system status meaning and lets writers change
it after a focused confirmation of the effect on current Tasks. Each header offers add-to-the-right
and deletion; an inline Add column tile also appends a column. Columns reorder
by dragging their header grip (or Space, left/right, Space on the keyboard),
with optimistic ordering and rollback on refusal. Only deleting a column opens
a focused confirmation dialog for its Task destination. There is no centralized
Manage columns editor. Configuration writes pause polling and invalidate older
read responses so a stale poll cannot overwrite a saved layout.


## Agent Board operations

`board.read` returns the Run's own Project columns, visible counts, system status
meanings and `columns_revision`; `task.list` additionally returns each listed
Task's effective `column_key`. These are read-derived keys, never constructed
from titles. `board.configure` accepts the complete ordered column definition
and read revision, plus a reason. It covers create (`new:<unique label>` keys),
rename, reorder, WIP limits, changing existing status meanings, and deletion
with `moves` mapping removed keys to retained/new destination keys. Omit the
read-only Unassigned lane. Successful configuration returns the new actual
keys and revision; read again after409 rather than replaying stale selections.

`task.move_to_column` takes a Task ID from `task.list`, a column key and revision
from `board.read`, and a reason. `task.create` and `task.create_batch` accept an
optional `board_column: {column_key, columns_revision}`. New Tasks cannot be
created pre-completed in Done. All writes are scoped to the Run's Project and
instructing person's live permissions. Column configuration and exact Task
moves use the unattended-origin approval gate; Task flow events retain the
trusted Run/Agent provenance even when a column change moves many Tasks.
Normal completion requirements still apply, and column remapping/deletion is
atomic. Internal Task/Run status semantics remain fixed; Project column labels
and their mappings customize the workflow presentation.

## Core Project Board configuration and exact placement

`board.configure` and `task.move_to_column` are core-owned commands enabled for
session users and existing Agent Run tools. They use one strict schema table,
one policy admission and the existing domain writers under the core transaction.
The public move URL is `POST /api/v1/tasks/:id/move-to-column`; configuration
retains its PUT URL. Generic POST and CLI calls share the same registrations.
Human API callers supply explicit keys; the Board UI creates a key for each
explicit save/move and never automatically retries writes or stale revisions.

Configure returns a strict receipt containing project_id, columns (no Task
content/counts) and columns_revision. The browser then reads the full Board
through its existing authorized GET. Move returns task_id, project_id, status
and nullable column_id. Both commands recheck live Project writer authority;
move also locks the full-readable Task. Cross-Space/private/Run-Project denial is
hidden as canonical 404. Replaying a committed configure does not reapply its old
revision: it reauthorizes and returns the original receipt. A new command with
stale revision conflicts. Changed input on the same key is 422; concurrent keys
for the same invocation return retryable 409. No current revision is guessed.

Agent scope is derived from the current stored Run, with immutable grants,
current Agent/person authority and effective origin checked by the core. An
input Project cannot replace that scope. Reasons remain required for Agents;
Actor identity is resolved from the actual Agent, never the instructing user.
Agents cannot send human completion overrides. The origin-gated unattended
policy remains in force; production approval mappings are not enabled. An
unattended source requiring approval returns operation_approval_mapping_unavailable
(503, nonretryable), with no business effect or approval request and one failed
policy audit. The Agent adapter explains the human initiation/approval boundary
and forbids automatic retry or origin substitution. Generated Agent tool schemas
require reason and omit override_completion; canonical human schemas retain
optional/default-null reason and completion acknowledgement.

`configureProjectBoard` joins the explicit core query port via
withQueryableTransaction, while Task relocations call updateTask with that same
port. Columns, Tasks, work events, merge Job intents and receipt commit or roll
back together. Host process work remains in the worker. Domain revision checks,
flow-event identities and merge uniqueness remain separate from command keys.
WIP limits remain the existing stored/display hints, not new hard admission
quotas. Unassigned cannot be configured or selected; duplicate-status columns
keep distinct keys, and blocked overlays are preserved between in-progress
columns. Completion failures are canonical operation_invalid_input with allowlisted
metadata code completion_requirements_unmet and the owning gate's missing/
unacknowledged list. Human acknowledgement uses the existing completion gate.

The Project Board UI uses exact key/revision movement even for virtual default
columns, keeping optimistic rollback and its completion confirmation dialog.
Project Task PATCH rejects raw board_id and column_id (including mixed edits
and Project reassignment) against the locked Task and target Project inside the
writer transaction; concurrent reparenting conflicts rather than bypassing it.
This retired placement entry returns the canonical operation_invalid_input
envelope; other unmigrated PATCH failures retain their existing route errors.
A hidden Task blocking configuration returns canonical hidden 404, without
identifying the Task or committing partial columns/placement.
Use the named move command so metadata edits cannot bypass column revision.
Task creation and ordinary metadata/edit commands remain explicit legacy scopes;
standalone Space Board placement now uses the dedicated core command below.
Internal legitimate updateTask writers
retain their transaction port. The subsequent
[Task lifecycle family](PROJECT_WORK.md#core-task-lifecycle-boundary) now migrates
set_status's complete/review dispatch and delete's Run/Plan/Host cleanup intents;
the workers retain the actual external cleanup. No status/complete/handoff/
report/review semantics or Task owner is substituted by this migration.

Project Task contract dialogs omit placement fields and the standalone Board
selector; exact placement remains on the Project Board. Standalone Task contract
dialogs retain their existing Board selection. taskLifecycleOperationsDb (Task contract browser case) exercises
both from the real Task Detail parent through the real locked writers.

### Standalone Space Board placement

`task.place_in_space_board` is a user-only core command. Its formal entry is
`POST /tasks/:taskId/space-board-placement` with `{changes: {...}}` and an explicit
Idempotency-Key. Generic callers include task_id. Changes require board_id or
column_id and may include the existing accompanying contract fields, so a
contract save and its placement remain one atomic write. Explicit status,
deleted_at and a non-null Project destination are excluded: lifecycle commands
and revision-bearing Project movement retain those responsibilities.

The current full-readable Task must remain standalone under its lock. A supplied
destination must be an active, undeleted Board in the same Space without a
Project; it is pinned before the Task. Reparenting either object cannot turn
this command into a Project write. Column placement reuses the canonical writer,
including its stored completion gate and required Jobs. Changing Board without
selecting a column clears the old column while preserving status. Replays check
live authority and return the retained receipt without another edit.

All raw PATCH board_id/column_id writes are now refused under the Task lock,
including null clears and mixed edits. The browser sends placement-bearing
contract saves through this core command and then refreshes the Task; metadata
edits without placement retain their ordinary PATCH path. No Agent tool or
permission, automatic retry, or production approval mapping is added.
