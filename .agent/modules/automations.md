# Module: Automations

## Status

Implemented: manual and scheduled triggers; targets `agent_run`, `workflow`,
`knowledge_retrieval_maintenance`, `context_ops_review_cycle`; optional project
binding for `agent_run` and `workflow`. Native targets are declared by the
protocol-owned `AUTOMATION_TARGET_REGISTRY` and dispatched through a
server-owned handler registry. `autonomous_tick` is declared as a non-user-
selectable control-plane target with a working handler (observe-only and
bounded-launch modes; see [autonomy.md](autonomy.md)).

`autonomous_tick` is unreachable through the generic `POST /api/v1/spaces/:spaceId/automations`
body — `assertUserSelectableTarget` rejects it there by design, since that
endpoint accepts an open-ended `config_json` for a control-plane target with a
fixed shape and identity model. The activation path is the dedicated,
self-service `PUT /api/v1/spaces/:spaceId/automations/autonomy` /
`GET .../automations/autonomy` pair: any active Space member (`role >= member`,
not just admin/owner) enables, reads back, or reconfigures only their own
tick, scoped to their own identity and whatever Agent they can already reach
in the Space — the same reachability rule manual Run creation already applies
(Space membership plus `agent_id` existing in-Space; no extra per-Agent
ownership check). It is a per-`(space_id, owner_user_id)` singleton: enabling
twice reconfigures the same row rather than creating a second one. The
`ruleAutomation` policy rule's `autonomous_tick`-and-`actor_is_owner` branch is
the only place a non-admin/owner role is allowed to create, update, or fire an
Automation, and it cannot reach another member's tick.

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

## Native target authority

A user-chosen reusable process is a Workflow Template. A maintenance or
control-plane job that a user only enables or disables is a registered native
Automation target. The protocol registry records every target's kind,
selectability, Run fan-out, Project-binding requirement, credential-grant
requirement, enforcement point, and description. A frozen fixture pins its
count, order, and fields.

The server derives valid target types from that registry. Unknown targets fail
at create/update/fire, and a registered target with no active handler fails
closed. Fastify startup validates exact registry-to-handler coverage after all
domain modules register. Handler registration is upsert-by-key so module load
order and test resets cannot leave stale one-shot registration state.

Automations owns the `agent_run` and `workflow` handlers. Retrieval owns
`knowledge_retrieval_maintenance`, Context Ops owns
`context_ops_review_cycle`, and Autonomy owns `autonomous_tick`. Runtime
control flows from Automation to the selected handler, while compile-time
dependencies flow from each owning domain to the Automations registry
interface. The Automations module does not import those owning domains.

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
- `server/src/modules/retrieval/automationTarget.ts`
- `server/src/modules/contextOps/automationTarget.ts`
- `server/src/modules/autonomy/automationTarget.ts`
- `packages/protocol/src/automationTargets.ts`
- `server/src/modules/projects/projectSourceRoutingService.ts`
- `server/src/modules/runs/finalizationService.ts`
- `server/src/modules/scheduler/`
- `apps/web/src/modules/automations/AutomationsPage.tsx`

The Automation UI shows recent Workflow Executions, node progress, checkpoint
state, and root Run links. It does not expose Plan creation or Plan approval as
part of an Automation fire.

`autonomous_tick` remains non-user-selectable through the generic create body;
it is reachable only through the self-service `.../automations/autonomy`
routes described in Status above. A member's own instance may run it
observe-only or with bounded launch enabled. Its `automation_runs` row points
to a private coordinator Run and its trigger context records the full
candidates-seen/ranked/admitted/launched/refused fan-out. Candidate and report
ownership remains in `autonomy`.

## Related Architecture

- [PROJECTS.md](../architecture/PROJECTS.md)
- [Sources module](sources.md)
- [ROADMAP_AND_FUTURE_RISKS.md](../architecture/ROADMAP_AND_FUTURE_RISKS.md) — Capability 6
