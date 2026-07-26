# Module: Automations

## Status

Implemented: manual and scheduled triggers; targets `agent_run`, `workflow`,
`knowledge_retrieval_maintenance`, `context_ops_review_cycle`; optional project
binding for `agent_run` and `workflow`.

## Purpose

Automations are the user-facing objects that fire runs on demand (manual) or on
a cron schedule. Every automation-origin run goes through the same
enforce/preflight/policy path as a manual run — this is the roadmap red line for
Capability 6.

Scheduled fire failures emit a deduplicated, owner-private `operational_alert` Activity
record so unattended failures appear in Activity Inbox. Alert persistence is best-effort
and never replaces schedule advancement or the originating failure state.

Source post-processing is not an Automation trigger. Source-level
summaries, evidence extraction, proposal creation, item marking, and per-source
cursors are owned by the Sources module. Its unattended agent runs use the
Sources-owned `job` execution origin and retain the user's rule/setup
authorization in the immutable run contract; they must not request an
Automation credential grant a second time. Ordinary Automation-origin runs
continue to require their own explicit pre-authorization.

## Owns

- `automations` rows (name, agent, optional Project Folder/project, trigger, config).
- `automation_runs` fire audit rows (`trigger_type`, preflight snapshot,
  `trigger_context_json` when a target needs structured audit context).
- `automation_credential_grants` pre-authorization for unattended schedule
  fires; archiving revokes.
- Cron due state in `scheduler_tasks` for `task_type='automation'`.

## Trigger model

`trigger_type` is the enum of peer trigger kinds:

- `manual` — fired by a user via `POST .../fire`.
- `schedule` — cron in `config_json`; due state lives in `scheduler_tasks`
  (`task_type='automation'`, `next_run_at`/`last_run_at`); the
  `automation_scheduler` heartbeat sweeps `listDue` and fires. There is no
  per-automation registration into the scheduler — it is a poll/sweep model.
External/webhook triggers remain deferred (roadmap Capability 6).

Project Research history expansion is not an Automation fire. Its
`historical_backfill` operation is created by the Project Research
orchestrator, is proposal-gated through Sources, and uses the existing source
cursor and operation reconciliation path. Source events that arrive while it
is active are queued on the research workflow and become an incremental
operation only after the historical checkpoints finish.

## Project Binding

`project_id` is optional for `agent_run` and `workflow` targets, and requires
project writer authority to bind. Fired runs carry the project, so run context
pulls project evidence/memory and outputs are project-attributed. Preflight
fails closed if the bound project was deleted.

Scheduled non-agent targets run as owner/admin operational work and save private
operational reports or packets according to each target's config. Agent-run
targets use the configured agent and optional configured prompt.

Workflow targets require `config_json.workflow_asset_key` and an explicit
`workflow_resolution` of `pin` or `follow`. A pin captures the approved
workflow version when the automation is saved; a manual follow resolves the
approved version at fire time. Scheduled workflow automations must pin, so an
unattended trigger cannot silently move to a later workflow version. Workflow
fire creates a `WorkflowExecution` with an immutable resolved-version and
definition snapshot, materializes `workflow_execution_nodes`, and records the
root/child Runs through `automation_runs.workflow_execution_id`. It never
creates a Plan or `plan_review`; a fixed Workflow is not dynamically planned.

If an automation needs an adaptive execution path, it must explicitly create or
select a source Task and ask its Agent to plan. That is the separate
`Task → planning Run → Plan` product path.

## Cross-Module Boundary

Sources materialization enqueues Sources-owned
`source_post_processing_event` jobs. Automations does not consume source item
deltas and does not own per-source cursors. Project Research is a separate
orchestration consumer: a successful project-bound post-processing run may
notify `ProjectResearchOrchestrator`, which creates or merges a managed
incremental Project operation. It reuses the existing Source cursor and Run
pipeline; Automations must not create a second research scheduler or bypass
the screening/idea checkpoints.

## Related Files

- `server/src/modules/automations/`
- `server/src/modules/projects/projectSourceRoutingService.ts`
- `server/src/modules/runs/finalizationService.ts`
- `server/src/modules/scheduler/`
- `apps/web/src/modules/automations/AutomationsPage.tsx`

The Automation UI shows recent Workflow Executions, node progress, checkpoint
state, and root Run links. It does not expose Plan creation or Plan approval as
part of an Automation fire.

## Related Architecture

- [PROJECTS.md](../architecture/PROJECTS.md)
- [Sources module](sources.md)
- [ROADMAP_AND_FUTURE_RISKS.md](../architecture/ROADMAP_AND_FUTURE_RISKS.md) — Capability 6
