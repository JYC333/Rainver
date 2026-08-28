# Task board model

This document describes the **agent-native task board** domain layer. It is backend-only; Kanban UI is deferred.

## Core separation

- **Board** — A space- or Project-Folder-level work surface. Groups columns and tasks for planning and visibility.
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

Boards and tasks are scoped by **space** (and optionally **Project Folder**). Assignments may reference both users and agents. The API enforces space boundaries so cross-space references are rejected.

## Task ↔ Run linkage

- **Canonical:** `task_runs` (`TaskRun` ORM) — every product association between a `Task` and a `Run` that the task board should list or join on **must** go through this table. `GET /api/v1/tasks/{id}/runs` is implemented by querying `TaskRun`, then loading `Run` rows by id.
- There is **no `runs.task_id` column** in the canonical schema. `task_runs` is the only Task ↔ Run linkage; do not reintroduce a denormalized shortcut column on `runs`.

**Task is not Job.** Jobs (`jobs` table) are infrastructure queue rows with their own `attempts` counter; that counter is queue plumbing and is unrelated to `run_attempts`. The Supervisor enqueues retry jobs with `max_attempts: 1` so the queue layer never adds a second retry loop on top of Run attempts.

## Execution boundary

`POST /api/v1/tasks/{id}/runs` creates a **queued** `Run` (plus its initial attempt) through the runs repository inside one transaction with the `max_runs` admission lock, inserts a `task_runs` row (canonical), and may move the task to `in_progress`. It does **not** call runtime adapters or enqueue infrastructure jobs. Running the same Task again always creates a new Run and a new `task_runs` row; a terminal Run is never reopened by user request.

A Run finishing is not the Task finishing. Settlement runs when every Run of the Task has stopped advancing, reads the **latest** one, and closes the Task only on an accepted evaluation with its declared outputs present; everything else holds the Task in `waiting_for_review` for a person. `blocked` is no longer written by a Run outcome — it means held up by something else. See [`PROJECT_WORK.md`](PROJECT_WORK.md).

## Frontend

The Project Board at `/projects/:projectId/board` is the Task surface: a
drag-and-drop Kanban over the ACL-filtered server read model
(`GET /projects/:id/board`), with lanes from `board_columns` or the defaults,
`blocked` drawn as an overlay in the lane the work sits in, and a drag to Done
refused when the Task has not met what it declared. A Project's Task also opens
inside the Project shell at `/projects/:projectId/tasks/:taskId`. See
[`PROJECT_WORK.md`](PROJECT_WORK.md) and
[`FRONTEND_INFORMATION_ARCHITECTURE.md`](FRONTEND_INFORMATION_ARCHITECTURE.md).

## Obsolete patterns (do not reintroduce)

- `POST /api/v1/tasks/{id}/run` (singular **`/run`**) that returned a `Job` and enqueued worker execution.
- Storing product tasks as `Job` rows with `job_type="product_task"` (or any **Task = Job** mapping).
