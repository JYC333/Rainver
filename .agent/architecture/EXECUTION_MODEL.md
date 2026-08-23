# Execution Model

## Core Objects

**Run** — the central execution object. Every formal agent execution has a durable Run. A run is created by user request, task, automation trigger, API call, or scheduled job. Run produces RunSteps, RunEvents, artifacts, and proposals. A Run also stores an immutable-at-creation `contract_snapshot_json` containing the source, project/Project Folder, acceptance and required-output declarations, risk, budget caps, and route hints used for that execution.

`runs.run_role` separates executable Runs from orchestration aggregates. An
`execution` Run owns physical `run_attempts` and may enter routing, adapter,
verification, and supervision. A `coordinator` Run is the root identity and
budget scope for one Plan or Workflow Execution; it never has an Attempt and
cannot be dispatched or supervised. Run lists and execution statistics exclude
coordinators by default, while graph detail surfaces expose them explicitly.

Workflow-backed Runs additionally carry nullable `workflow_version_id`, which
points to the approved evolvable workflow definition used at launch. Fixed
Workflow Automation materializes that version into a `WorkflowExecution` and
durable execution-node/run links. Agent Plans are a separate Task-owned
aggregate: the Agent planning Run proposes Plan Nodes, and a retained
`reference_workflow_version_id` is context only, never the Plan execution
source.

**RunStep** — coarse execution steps within a run. Provides the replay spine for failure diagnosis without reading raw adapter logs.

**RunEvent** — structured append-only harness evidence records within a run. Finer-grained than RunStep but coarser than raw adapter logs. Each RunEvent captures one significant phase (context compilation, runtime selection, sandbox creation, adapter invocation/completion, governed action invocation/completion, artifact ingestion, patch collection, validation, proposal creation, evaluation, finalization). Used by run finalization as the primary structured evidence source.

**RunFinalization** — canonical post-run record created by the materialization
finalization boundary after a Run reaches a terminal state. Idempotent per
`(run_id, attempt_number, finalizer_version)`, so a successful retry receives a
fresh evaluation and downstream projection. Records run evaluation outcome,
task evaluation bridge result, and skipped reasons. Its evidence is
append-only; `metadata_json.completion_gate_committed` has one permitted
monotonic transition from absent to true after delegation reconciliation,
Supervisor decision, and execution-graph reconciliation all commit.

**RunAttempt** — one physical runtime execution under a logical Run. A queued
execution Run creates queued attempt 1 atomically; Supervisor retries create
the next attempt while preserving the logical Run id. Coordinator Runs never
create attempts. Attempt rows retain start/end/activity timestamps, exit and
error evidence, cancellation request/confirmation, and `orphaned` recovery
state. Usage is retained separately in `token_usage_events` and is keyed to
the logical Run.

Attempt evidence is append-per-attempt: `verification_results` rows are keyed
by `(run_id, attempt_number, verifier_type, verifier_version)` (re-verifying
the same attempt upserts; a retry never overwrites a prior attempt's rows),
`run_steps`/`run_events` are stamped with the attempt that produced them, and
evaluation classifies only the finalized attempt's stamped evidence plus
unstamped rows. `runs.output_json/error_json/exit_code` mirror the latest
attempt only. Usage is read from the canonical token ledger. A policy-pause
resume reuses the same attempt and merges
the approval grant into the attempt's `error_json` instead of clearing the
pause evidence; a dispatch that finds no reusable attempt backfills one marked
`attempt_backfilled_on_dispatch`.

### Task / Run / Attempt lifecycle invariants

1. One Attempt belongs to exactly one Run; `(space_id, run_id, attempt_number)`
   is unique and `attempt_number > 0`.
2. An execution Run has at least one Attempt from creation (same transaction);
   coordinator Runs never own Attempts.
3. `runs.status` and the max-attempt `run_attempts.status` move in the same
   transaction (single CTE dual-write path).
4. Retries only add Attempts; a terminal Attempt's error/exit evidence is never
   cleared or rewritten, and usage remains append-only in the token ledger.
5. A Run returns from a terminal status to `queued` only through a persisted
   `RunSupervisorDecision` for that attempt or an explicit human resume.
6. Crash recovery first terminalizes the orphaned Attempt, then the Supervisor
   creates a new Attempt; an Attempt is never moved from `orphaned` back to
   `running` in place.
7. Manually executing the same Task again creates a new Run and a new
   `task_runs` row through `max_runs` admission; terminal Runs are not reused.
8. `contract_snapshot_json` is immutable; routing/fallback replace `selected_*`
   state but never `requested_*` state.
9. A terminal Attempt (succeeded/failed/degraded/cancelled/orphaned) never
   returns to a non-terminal status; only a `waiting_for_review` policy pause
   resumes the same Attempt, and it must retain the pause evidence.
10. Finalization/evaluation/verification evidence is append-only per
    `(run_id, attempt_number)`. The finalization completion gate is the sole
    allowed monotonic metadata update and never rewrites evaluation evidence.

**RunSupervisorDecision** — an idempotent durable policy decision for a terminal
attempt. The MVP aggregates `token_usage_events` across the logical Run,
classifies retryable structured error codes, including explicit semantic
rejection and deterministic acceptance/Run Exchange validation failure,
enforces the contract attempt/cost caps, and queues either a same-route retry
or a C2 fallback-chain reroute. The next physical Attempt receives bounded
failure-reason context without changing the original contract. There is no
natural-language failure classifier and no retry authority alongside
`RunEvaluation → RunSupervisorDecision`. When no eligible retry remains it
moves the Run to `waiting_for_review`; explicit runtime-profile selections
remain hard pins and therefore cannot be rerouted.

Interactive Chat and Room Runs may use bounded automatic retry for retryable
failures, but an exhausted or non-retryable execution failure remains terminal
so the conversation can publish a failure reply. It must not be converted into
a generic `waiting_for_review` hold. Explicit policy and authorization pauses
still use `waiting_for_review` and must explain the required decision in the
conversation without marking the turn complete.

The worker records bounded completion evidence and usage and cleans Run-scoped
runtime state before publication. The repository then publishes the terminal
Run/Attempt state, synchronizes conversation state, resolves staged proposals,
and removes the execution lock in one database statement. A cancellation that
reaches `cancelling` first forces the execution owner to publish `cancelled`;
public cancellation cannot remove an active execution lock. Crash recovery
orphans the Attempt, rejects its proposals, and removes its stale lock in the
same recovery statement. Consequently, neither automatic nor explicit
finalization can queue the next physical Attempt while the previous Attempt
still owns its execution authority.

Runtime-output delegation has one execution entry: terminal finalization
replays the durable canonical output with a stable idempotency key before
creating RunEvaluation/Supervisor evidence. Explicit finalization uses the same
materializer path. Chat/Room completion recovery only projects Runs that have a
completed current-version finalization for the latest Attempt whose
`completion_gate_committed` marker confirms delegation reconciliation and the
Supervisor decision both committed.

**Job** — background system task (import, consolidation, backup, agent-run dispatch). Separate from Run. Job handlers create or dispatch Runs; jobs themselves are not product execution records.

Terminal Run follow-up is contract-dispatched. The agent-run handler reads the
immutable `workflow_input_json` and queues exactly one applicable reconciliation
job for Project Research, Knowledge Candidate extraction, or a managed
Experiment. Domain reconcilers remain idempotent and own projection updates;
Job retries and the Run Supervisor remain the shared retry authorities. A
feature does not reopen a completed WorkflowExecution or add its own cyclic
retry state machine. Failure to enqueue the terminal reconciliation propagates
from the agent-run handler: retrying that Job observes the already-terminal Run
as a no-op and retries only the contract dispatch.

Project Research is a workflow-level consumer of these execution primitives.
Its `baseline`, `historical_backfill`, and `incremental` run kinds are persisted
as `project_operations` progress, not as a second execution table. Source
backfill and post-processing jobs remain owned by Sources; the research
orchestrator only advances operation stages, links materialized artifacts, and
creates screening/idea checkpoints. A historical operation serializes workflow
state changes while allowing Source ingestion to continue through a persisted
pending-incremental queue.

Auto Research uses only the managed `model_api` path. Setup selects a
ModelProvider and optional model; the server provisions the system research
Agent/profile. Research source post-processing and synthesis Runs snapshot a
JSON Schema output contract in the Run contract, and plain-text output is a
terminal structured-output failure. OpenCode, Claude Code, and Codex remain
generic local CLI runtimes and are not part of the Research execution API.

**AgentRunGroup** — manager-owned multi-agent room for grouped runs. A group has
members, messages, delegations, one root run, and optional child runs. Human
users manage/review the group; child-run creation is server-owned and policy
gated through `run.spawn_child`. Managed API grouped runs can request child
runs through the authorized `agent.delegate` runtime tool and can pause on
other room results through `agent.wait_for_results`; frontend room
messages remain natural-language instructions, but the Tiptap composer resolves
structured `@agent` tokens into traceable recipient segments. No structured
mention defaults to the manager, adjacent mentions can fan out one segment to
multiple agents, separated mention groups create separate prompts, and the user
can explicitly choose Agent coordination to route the full turn to the manager
for decomposition/delegation instead of direct fan-out.

**Artifact** — durable output produced by a run. Stored under `artifact_storage_root`. Exportable within the owning space. `storage_path` is always relative to `artifact_storage_root`.

**Proposal** — requested durable change. Created by runs; reviewed by humans; applied by `ProposalApplyService`.

## Runtime-neutral input contract

`RunOrchestrationService` computes a protocol-owned `run_input.v1` envelope
from the immutable Run contract, Run binding, and
permission snapshot. The envelope is not persisted as a second authority.

It carries the semantic instruction/task goal, canonical conversation
messages, direct/Workflow/upstream inputs, attachment references, optional
Project Folder access descriptor, output declarations, granted action subset,
and execution shape/risk/policy/budget references. It contains logical
references rather than physical Project Folder paths, credentials, rendered
private context, or raw file bodies. Secret-shaped keys and escaping declared
output paths fail closed during assembly.

Managed API execution includes the envelope in the internal runtime-host
request. Local CLI execution receives the same typed envelope at its adapter
boundary; CLI-specific file projection is owned by the Run Exchange lifecycle.

## RunStep Taxonomy

## Run contract snapshot

`runs.contract_snapshot_json` is written once when the Run is created and is
never refreshed from mutable Task, Automation, or Workflow configuration. The
snapshot is versioned as `run_contract.v1` and carries the source kind/id so a
later evaluation can distinguish a Task, Automation, Workflow, delegation, or
direct run.

Runtime request and routing outcome are separate. The immutable
`requested_runtime_profile_id` plus `runtime_profile_selection_source` record
the caller's intent. The current `runtime_profile_id`, `adapter_type`,
`model_provider_id`, runtime snapshot, and `route_decision_id` are selected
execution state. Public DTOs expose them with `selected_*` and
`active_route_decision_id` names. Routing and fallback retries may replace
selected state but never requested state; an explicit request remains a hard pin.

Route hints carry a runtime-neutral execution shape:
`conversational`, `structured_generation`, `agentic_files`, or
`code_execution`, plus required capabilities. (A parallel required-tools channel
exists and is reachable from a Task's `policy_json`, but nothing populates the
candidate side, so declaring one rejects every candidate; see
[ROUTING.md](ROUTING.md).) Conversational Runs
(including session-backed Chat) and structured generation score Managed API as
the default. File/code shapes are admitted on the candidate's declared
`requires_file_access`: a runtime without it has no working directory to act in
and is rejected unconditionally — not as a consequence of which tools the run
was granted — and a runtime with it must carry a C3 pass before serving those
shapes. Managed API is rejected by that declaration rather than by its name. An explicit
Runtime Profile remains a hard pin but still must pass capability, tool,
sandbox, trust, credential, and shape compatibility filters. Fallback chains
contain only candidates that passed those same hard filters; the selected
profile/adapter/provider and decision id are stamped as route evidence.

TaskRun creation copies the Task contract and project binding. Automation fire
copies the automation's validated contract configuration. Direct runs get a
null-contract direct snapshot. When Task, Automation, and Workflow carriers
overlap, creation-time explicit precedence selects the highest-precedence cap;
without precedence the strictest cap wins. The snapshot records both the
declared carriers and the effective budget plus its resolution trace.

The enforcement boundary is deliberately narrow: `max_duration_seconds` caps
the adapter timeout, `max_runs` is resolved from the immutable budget source
precedence and enforced for Task, Automation, and Workflow/plan coordinator
admissions before dispatch. Plan child Runs carry `root_run_id`, so one
workflow fire is counted once rather than once per child; historical source
executions must remain below the cap,
`max_attempts` caps physical attempts for this logical Run, and `max_cost` is
enforced against the sum of `token_usage_events.estimated_cost_usd` before a
retry. The snapshot is exposed by the Run read model, while Task API mappings
expose the source contract fields.

Managed chat usage records cost at the same per-provider-call boundary as its
provider-reported token counts. The amount is pi-ai's catalog-derived total,
rounded to the ledger's eight-decimal USD precision. `cost_accuracy` records
`catalog` for a successful catalog lookup (including a genuine zero) and
`unknown` when no price is known; `cost_details_json` retains the
input/output/cache breakdown plus `source: "pi_ai_catalog"`, but does not
duplicate the accuracy classification. Anthropic's
`cache_creation_1h_input_tokens` is retained as a
priced subset of `cache_creation_input_tokens`; it is never added a second time
when deriving total tokens. `usage_accuracy` describes token evidence only.
Unknown custom models and CLI, embedding, or rerank paths remain uncosted rather
than falling back to a second local pricing engine.

After acquiring the execution lock and before resolving credentials, context,
or a sandbox, dispatch revalidates the instructing user's active Space,
Project, and Room membership. A bound Project Folder must also still be active,
belong to that Project, and remain execution-enabled; disabling it revokes
future execution even for an already queued Room turn.

When multiple sources occupy the effective `max_runs` precedence tier and
declare the same effective cap, admission locks and checks every such source;
the Task admission path performs this resolution before inserting either the
Run or its `task_runs` link. A dispatch check repeats the same source set from
the immutable snapshot, so inherited Automation/Workflow limits cannot first
fail after Task admission has already consumed a run count.

Source execution counts combine the owning domain's durable link
(`task_runs`/`automation_runs`) with immutable Run snapshots and deduplicate by
logical root Run. This lets a Plan child consume an inherited Task or
Automation allowance without creating a false domain-owned link, while every
child in the same Plan execution still counts as one admission.

Every budget source carrying a cap is validated before admission: Task,
Automation, and Plan IDs must resolve to a current-space record, Workflow IDs
must resolve to an approved version under an active Workflow Asset whose
version scope is valid in the current Space and allowed by the parent Asset's
ownership/user-override rules, and missing or foreign references fail closed. A direct Workflow Run
uses the same transaction for source validation, advisory-lock admission,
execution-control snapshot, Run row, and initial attempt; a rejected cap therefore
cannot return a queued Run that will fail only when dispatched. Dispatch
repeats invalid-source detection and turns a malformed historical snapshot
into a failed Run rather than treating it as zero prior executions.

RunStep records the coarse execution spine of a run:

| Step kind | Meaning |
|---|---|
| `queued` | Run created, not yet started |
| `adapter_started` | Runtime adapter began execution |
| `adapter_completed` | Adapter returned a result |
| `artifact_created` | Artifact persisted from run output |
| `proposal_created` | Proposal created from run output |
| `failed` | Run failed; sanitized error captured in step |

RunSteps are **best-effort evidence**. They are savepoint-isolated from critical writes (run terminal state, memory, policy rows). A RunStep write failure must not poison the run's terminal state commit.

## RunEvent Taxonomy

RunEvent records the structured phase-level evidence spine of a run:

| event_type | Meaning |
|---|---|
| `context_compiled` | Legacy evidence name retained by the closed event taxonomy; current managed execution records accepted Runtime Context Delivery and Invocation Snapshot evidence instead |
| `runtime_selected` | Runtime adapter resolved; sandbox level decided |
| `credential_granted` | Credentials resolved for adapter |
| `sandbox_created` | Worktree sandbox created |
| `adapter_invoked` | Adapter.execute() called (status=running) |
| `adapter_completed` | Adapter returned; status succeeded/failed/cancelled |
| `artifact_ingested` | Produced artifact paths ingested |
| `patch_collected` | Code patch proposal collected; one per run attempt |
| `validation_started` | Worktree validation commands started |
| `validation_completed` | Worktree validation commands completed |
| `proposal_created` | Proposal created from run output |
| `evaluation_created` | RunEvaluation appended |
| `run_finalized` | RunFinalization completed or failed |
| `delegation_requested` | Agent group child-run delegation requested |
| `delegation_policy_denied` | `run.spawn_child` blocked a child-run delegation |
| `delegation_queued` | Child run created and queued for dispatch |
| `delegation_started` | Delegated child run started and the group delegation moved to running |
| `delegation_completed` | Delegated child run reached a terminal state and the group delegation result was projected |
| `action_invoked` | AgentToolGateway began a registry action call after exposure checks |
| `action_completed` | Registry action call returned a success or model-visible failed tool result |

RunEvent statuses: `pending`, `running`, `succeeded`, `failed`, `skipped`, `warning`, `cancelled`.

**RunEvent vs RunStep:** RunStep is the coarse lifecycle replay spine. RunEvent is the structured evidence spine used for classification. RunEvent references RunStep, Artifact, Proposal — it does not replace them.

**Append-only:** RunEvent rows are never updated or deleted. `event_index` uses MAX()+1 scoped to `(space_id, run_id)` — same documented distributed-writer risk as RunStep.

**Best-effort writes:** `safe_append_run_event()` wraps all instrumentation points in a savepoint. A RunEvent write failure must not poison Run terminal-state commits, artifact persistence, proposal creation, or evaluation creation.

**Never stored in RunEvent metadata:** raw credentials, stdout/stderr content, full rendered context text, full patch body, raw private memory text, complete file contents.

### Registry actions and Room tasks

Managed model tools dispatch through `AgentToolGateway` and
`SystemActionGateway`; see [SYSTEM_ACTIONS.md](SYSTEM_ACTIONS.md). Registry
visibility, run/profile capability exposure, and call-time PolicyGateway
enforcement are separate gates. Side-effecting calls use the canonical tool
call id as their idempotency key. Best-effort `action_invoked` /
`action_completed` RunEvents carry safe summaries and PolicyDecisionRecord ids;
their persistence failure does not block or roll back the action. Required
PolicyDecisionRecord persistence remains the fail-closed audit boundary.

The managed multi-turn loop is implemented behind the agent-space-owned
`managedAgentLoop` port by pi-agent-core. Pi owns transcript accumulation,
sequential batch execution, truncated-batch failure and turn stopping; it does
not own provider access, tool grants, policy, audit, credentials or context.
Every model turn calls the existing Runtime Host executor, and therefore gets a
fresh accepted Delivery, dispatch fingerprint, provider usage record,
acknowledgement and finalization. Raw model tool arguments cross back into
`SystemActionGateway`, which remains the validation and authorization authority.
Suspend envelopes terminate the current batch and later calls are represented
as blocked tool results without being executed.

Room dispatch reuses the canonical session -> queued Run -> orchestration
pipeline. A Room is project-bound and may own multiple sessions. Every human
message opens exactly one `agent_run_group` collaboration task; recipient Runs
persist the Room session, Project, trigger message, task group, and the
message sender as `instructed_by_user_id`. A Room has one nullable
`project_folder_id`; when bound, it is validated as active,
execution-enabled, Project-scoped, and readable, then propagated unchanged
through the session, task group, and every recipient/delegated Run. Terminal top-level results are
projected back into the Room session, while task trace and lifecycle evidence
remain available on the canonical Run/group read surfaces.

Each local CLI recipient resolves a durable Space × Room-recipient work scope ×
user × Agent binding. A new or rotated binding reconstructs from the active
Semantic Checkpoint and uncovered Context Event tail; a healthy binding resumes
the opaque vendor session and receives only context after its acknowledged CLI
cursor plus the current turn. Adapter acceptance advances that cursor;
delivery failure does not. Hard runtime or authority changes rotate the binding
with a persisted reason, while ordinary selected-reference changes remain
deltas. A durable execution lease serializes parallel users of the same
binding through session persistence, and context/current phases are distinct
vendor turns. Vendor state remains a disposable cache rather than a replay authority.
Folder-backed work keeps normal Project sandbox preparation. A Room without a
Project Folder uses the persistent conversation cwd so cwd-partitioned vendors
such as Claude can resume reliably without introducing a second execution path.

RunStep error/metadata is filtered by `server/src/modules/runs/evidenceRedaction.ts` before persisting. Raw credential values are never stored in RunStep rows.

## Actor Identity on Execution Evidence

New audit, event, and RunStep surfaces carry actor identity via `actor_ref` (structured reference). Actor kinds: `user`, `agent`, `system`, `automation`, `connector`, `service_account`.

Existing Run and Proposal rows use separate nullable `*_user_id` and `*_agent_id` fields. New surfaces use `actor_ref`. These fields are not migrated in bulk; new records use actor_ref.

## Canonical Runtime Path

- **Canonical adapter catalog:** `RuntimeAdapterSpec` entries in
  `server/src/modules/runtimeAdapters/specs.ts`. Each entry declares the
  executor family and runtime capability/trust claims;
  `RunOrchestrationService` dispatches through that family map rather than
  enumerating adapter names.
- **Controlled CLI tools:** `runtimeTools` installs vendor CLI versions under
  `$AGENT_SPACE_HOME/runtime-tools`; only the `INSTANCE_ADMIN_EMAIL` user may
  install/activate instance tool versions.
- **Run authority:** server `runs` owns run execution, stop,
  top-level run read/status/trace, post-run evaluation/finalization, the
  internal `POST /internal/runs/execute` port, server execution locks, and
  `agent_run` job dispatch (the server entrypoint runs the worker loop;
  The agents module owns run creation subresources (`POST /agents/{id}/runs`
  compatibility alias). Runtime Context Gateway delivery, Project Folder
  sandbox preparation, artifact/proposal materialization, and finalization are
  native server.
- **Generic local CLI execution:** server `runs/vendorCliAdapter.ts`
  renders commands, grants CLI credential profiles through the server broker,
  prepares the server sandbox/worktree, sends the typed launch request to the
  dedicated Sandbox Runner, parses streamed output, and materializes produced
  artifacts/proposals. Runtime Context arrives only as ordered protocol
  messages; vendor instruction files are not a context transport.
  OpenCode may instead use a ModelProvider: the server writes a run-scoped
  OpenAI-compatible provider entry to the sandbox `opencode.json` and routes
  requests through the expiring provider proxy lease; provider API keys are
  not ambient subprocess environment variables.
- **Sandbox execution status:** read-only, ephemeral, worktree, and critical
  local-CLI runs all execute in the dedicated `sandbox-runner` service. The
  Runner accepts managed mount ids and typed egress/credential/tool channels,
  resolves one selected runtime-tool version, and starts a fresh empty-root
  bubblewrap mount/PID namespace. Only workspace/Delivery/tool/runtime-home/
  Exchange targets are mounted. Runner and namespace failure are fail-closed;
  the application server has no local, Docker-CLI, or bubblewrap fallback.
  `one_shot_docker` remains the immutable routing/risk value for critical Runs,
  not a process-launch implementation.
  `RunOrchestrationService.enforceRuntimePolicy` derives this upgrade from the
  immutable run contract's `risk_level`, so manual, plan, task, and automation
  entry points share the same critical-risk boundary.
- Run detail reads expose the immutable contract, verification results,
  attempt/supervisor history, route decision, and finalization history as
  separate panels. Saving a successful verified run as a workflow is a
  server-authoritative preview → save flow; the server decides whether the
  save is a draft or a proposal based on the run's recorded evidence and risk.
- **Space runtime policy:** space owners/admins manage
  `space_runtime_tool_policies`. Agent versions store the resolved
  `runtime_tool_version`, and runs fail closed before credential resolution if
  that version is unavailable, disabled, or disallowed for the active space.
- **HostExecutionPort (ADR 0016; extracted in the retired phase-1
  control-center plan's P2):**
  `RunOrchestrationService.prepareRuntimeContext` resolves a `HostExecutionPort`
  once per run — server-host runs and folder-less runs always resolve to
  `ServerHostExecutionAdapter`, a verbatim wrapper around the existing
  `RunSandboxManagerPort`/`RunCodePatchCollectorPort`/`RunExchangePort`
  instances (zero behavior change from before this port existed). A run bound
  to a Project Folder resolves the Folder's `host_kind` via
  `RunExecutionAdapterDeps.hostKindResolver`; a non-`server` result fails the
  run with `remote_execution_not_implemented` rather than falling through to
  local-filesystem code — no dispatch path can bind a run to a remote-host
  Folder yet, so this is a defensive assertion, not a reachable branch. Remote
  execution (`RemoteHostExecutionAdapter`, daemon-driven) is P3; the CLI
  process executor and artifact materialization are not part of this port —
  P3's remote adapter dispatches over the daemon protocol and collects
  uploaded payloads rather than swapping implementations of those interfaces.
  `file_exists` verification (`server/src/modules/runs/verification/engine.ts`)
  takes the resolved `host_kind` and short-circuits for a non-`server` run
  instead of `stat`-ing a path with no meaning on that machine.

Do not add new adapters to the agents module — it contains Agent/AgentVersion CRUD only.

### Runtime delegation boundary

System-level delegation is currently real only for managed API runs inside an
`AgentRunGroup`: `agent.delegate` and `agent.wait_for_results` are exposed
through the group and policy boundary. Vendor CLIs do not receive those
server-owned tools. A CLI may nevertheless create its own runtime-internal
subagents; that behavior is not uniformly controllable across runtimes.
Claude runs currently render and verify a run-scoped `.claude/settings.json`
denying the runtime-internal `Task` tool; OpenCode renders and verifies a
run-scoped locked-agent `opencode.json` denying Task and webfetch; Codex
remains `unknown`. Absence of a server tool alone does not prove single-agent
execution.

Codex is not required to gain an equivalent control (decided 2026-08-13).
Runtime-internal subagents widen no permission surface: they execute in the
same worktree sandbox and the same freshly cleared `HOME`, reach providers only
through the same loopback proxy, and spend the same Run cost cap, and
file-scope conformance judges the resulting worktree diff whichever internal
agent wrote it. What they do cost is attribution and cancellation certainty,
and Codex is already priced for that — its `unknown` declaration fails the
subagent conformance check by construction, which holds every Codex route at
`low` trust. The declaration stays `unknown` because that is the truth; a
verified value would have to come from an actual probe.

### Runtime capability declarations

The spec fields `subagent_support`, `subagent_disable_mechanism`,
`delegation_controllability`, `structured_output`, `checkpoint_resume`,
`cancellation_reliability`, `observability_level`, `side_effect_level`,
`data_exposure`, and `trust_level` are declarations used by later routing and
conformance work. They are intentionally conservative: Claude Code and
OpenCode declare runtime-configurable subagent disablement, Codex CLI remains
`unknown` until verified, and planned runtimes are not treated as executable merely because a
catalog entry exists. C3 turns these declarations into conformance-backed
route constraints.

The C3 MVP stores one result per runtime×version in
`runtime_conformance_results`. A result is `passed` only when every check in
the suite has an explicit passing observation; probe errors become failed
checks. The five MVP checks are file-scope obedience, subagent-attempt
detection, cancellation reliability, structured-output compliance, and
credential leakage. A runtime declaration is not itself conformance evidence.

The runtime execution lifecycle uses this external-call pattern:

1. Open short transaction → write run setup state → commit.
2. Call runtime adapter **outside** the transaction.
3. Open short transaction → write result or failure → commit.

## Runtime Policy Gates

`PolicyGateway` is the only enforcement entry point for all policy gates.
`PolicyEngine` is internal to the policy package; business services must not
call it directly to authorize or perform a sensitive action. `PreflightService`
may call it only for non-mutating dry-run simulation, which does not persist a
`PolicyDecisionRecord`. Actual runtime execution still uses `PolicyGateway`.

Policy gates run in this order inside server run orchestration:

1. **`runtime.execute`** — `PolicyGateway.enforce()` is called **before** credential resolution, Runtime Context Delivery preparation, and `adapter.execute()`. Rule-relevant fields (`agent_status`, `agent_tool_permissions`, `tool_name`, `adapter_type`, `trigger_origin`, etc.) are passed in `PolicyCheckRequest.context`; safe audit copies remain in `metadata_json`. Blocking decisions raise `PolicyGateBlocked`, are written once through `write_blocked_gate_audit()`, and fail the run.

2. **`runtime.use_credential`** — called after adapter type resolution but
   **before** any ModelProvider key fetch or CLI profile release. The resource
   is the selected ModelProvider or CLI credential profile in the run's active
   space. Active-space grant resolution happens before secret/profile material
   is loaded; missing or disabled grants fail closed. Cross-space credential →
   hard DENY (CRITICAL). Automation origin → REQUIRE_APPROVAL. Same-space
   manual/api/delegation → ALLOW. DENY → `error_code=policy_denied_runtime_use_credential`.

3. **`context.inject_memory`** — resolved into the immutable execution-control snapshot before Runtime Context acquires Memory candidates. Cross-space without grant → hard DENY. DENY → Delivery preparation fails closed.

4. **`context.render_for_runtime`** — enforced by execution-control preflight and live Gateway authorization before an accepted Delivery reaches `adapter.execute()`. Cross-space drift hard denies.

Context assembly also freezes each selected item's owner and visibility and
updates the Run's `context_taint_json`. Materialization treats that summary as
an output ceiling: cross-owner inputs produce selected-user outputs and require
owner-approved `egress_review` before Space-wide publication. This is a durable
data-flow boundary, independent of adapter behavior or prompt compliance.

5. **`run.spawn_child`** — called by `AgentGroupRunService` before creating a
   delegated child run. The service proves same-space group membership, active
   group/member/agent status, parent-run agent identity, root lineage, and
   capacity limits. Public HTTP callers may post room messages, but child-run
   creation is initiated by authorized agent runtime output such as
   `agent.delegate`; callers may not directly forge agent-origin child-run
   spawns. Audit write failure is fail-closed and rolls back child-run creation.

None of these gates may be bypassed. No secret material is resolved before `runtime.use_credential` passes. No context is injected before `context.inject_memory` passes. No adapter is invoked before both `runtime.execute` and `context.render_for_runtime` pass.

**artifact.persist** — `RunMaterializationService` calls `PolicyGateway.enforce()` before the egress guard, filesystem write, or Artifact row creation. DENY and REQUIRE_APPROVAL call `write_blocked_gate_audit()` once and then raise `PersonalMemoryEgressError`. `PolicyAuditPersistError` and blocked-decision audit write failures block artifact persistence.

## Runtime Credential Resolver

`server/src/modules/providers` and the server credential broker are the
canonical runtime credential resolver.

- Resolves credentials through active-space grants: ModelProvider API keys from
  encrypted user-owned `Credential` rows, CLI login state from user-owned
  filesystem profiles.
- Runtime adapters must not read `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from
  the ambient environment.
- Raw credential values are never stored in RunStep fields, artifact content, or logs.
- Managed Claude and OpenAI Codex subscription providers use encrypted DB OAuth
  credentials through the same server authority but remain owner-only and
  outside credential pools. Near-expiry refresh is serialized with a database
  row lock before pi-ai receives the in-memory access token. CLI login state is
  neither read nor modified by this path.
- `server/src/modules/runs/evidenceRedaction.ts` redacts sensitive
  content before persisting runtime evidence.

## RunStep Replay and Failure Diagnosis

`GET /api/v1/runs/{id}/steps` returns ordered RunStep records.

`GET /api/v1/runs/{id}/trace` is the preferred reconstruction endpoint. It
aggregates the safe replay spine for a run in one response: Run,
AgentVersion, RuntimeAdapter, ModelProvider, safe Invocation Snapshot metadata,
RunSteps, RunEvents, Artifacts, Proposals, parent, and children. It does not
inline artifact content, raw rendered context text, raw system prompt text, or
secret material.

This allows:
- Identifying which step failed and reading the sanitized error.
- Tracing artifact/proposal creation back to the step.
- Reconstructing a coarse run summary without raw adapter logs.

RunSteps are retained indefinitely (no auto-purge).

## Artifact and Proposal Linkage

- Artifacts carry `run_id` (FK to producing run).
- Proposals carry `run_id` (FK to producing run) when created from run output.
- `Proposal.payload_json["provenance_entries"]` links back to the ActivityRecord or run that produced the proposal.
- `ArtifactReadService.resolve_stored_file` rejects paths escaping `artifact_storage_root` or inside `sandbox_root`.

## Artifact Path Safety

`Artifact.storage_path` is always relative to `artifact_storage_root`. Export never serves files outside artifact storage root. Missing file returns 404, does not leak host path.

## Run Lifecycle

```
queued → running → terminal → finalized
                       ↘ supervisor retry → queued → running → terminal → finalized
queued → running → waiting_for_dependency → queued → running → terminal
```

**Terminal** means runtime execution has ended (status: `succeeded`, `failed`, `degraded`, or `cancelled`).

`waiting_for_dependency` is a non-terminal parked state for AgentRunGroup runs
that called `agent.wait_for_results`. The worker releases the execution lock and
the lifecycle projector requeues the same run after every declared dependency
run reaches a hard terminal state.

**Finalized** means the canonical materializer has reconciled durable
runtime-output delegation, `PostRunFinalizationService` has performed
deterministic evaluation and Supervisor handling, and the completion gate is
committed.

Before finalization, the A2 Verification Engine evaluates declared
deterministic checks in the live run sandbox and persists attempt-scoped
`verification_results` (keyed by run, attempt number, verifier type, and
verifier version; reads return the current attempt's rows). The execution
path emits `validation_started` and
`validation_completed` RunEvents. The verifier is server-owned and uses
`ValidationRecipe`/Project Folder Execution Config command declarations plus Run contract
checks; it executes argv without a shell and bounds command time. The result
rows, not the runtime exit code, are the completion evidence for declared
checks. `manual_review` and `model_judge` are declared-but-skipped types until
their later phases implement the corresponding authority.

Automation should create Runs and call `POST /runs/{id}/finalize` after the run reaches a terminal state. Do not call internal evaluation services directly.

## Materialization Finalization — Canonical Post-Run Boundary

`RunMaterializationService.finalizeRun` is the canonical entry. It replays
runtime-output delegation idempotently, then invokes
`PostRunFinalizationService` for evaluation, task bridging, Supervisor policy,
and the monotonic completion gate. API, worker, recovery, and explicit
finalization use this same entry. A PostgreSQL session advisory lock keyed by
space, Run, Attempt, and finalizer version serializes the evidence-writing
boundary, preventing concurrent recovery/API calls from creating duplicate
evaluations before the finalization uniqueness check. Contenders use
`pg_try_advisory_lock` on short-lived dedicated lock connections; an
unacquired contender closes that connection before retrying. Neither lock
owners nor waiters consume the business-pool connections needed by
finalization dependencies.

### API

- **`POST /api/v1/runs/{run_id}/finalize`** — finalize a terminal run; idempotent.
- **`GET /api/v1/runs/{run_id}/finalization`** — latest `RunFinalization` for the run.
- **`GET /api/v1/runs/{run_id}/finalizations`** — all `RunFinalization` records, newest first.
- **`POST /api/v1/runs/{run_id}/resume`** — human-approved requeue for a
  `waiting_for_review` Run; policy pauses resume the same attempt, while a
  Supervisor terminal hold starts a new explicitly authorized attempt.
- **`POST /api/v1/runs/{run_id}/abandon`** — human-reviewed abandon path that
  records a cancelled terminal outcome.

The finalize endpoint is the single write surface.

### What finalization does

1. Replays durable runtime-output delegation with stable idempotency keys.
2. Creates one `RunEvaluation`.
3. Dispatches the run-finalized hooks through the server finalization service. The tasks-owned `task_evaluation_bridge` hook creates one `TaskEvaluation` bridge row when a `TaskRun` link exists (`runs` never imports `tasks`; `tasks` registers the hook through the module registry).
4. Creates one `RunFinalization` row with `status=completed`.
5. Commits the Supervisor/execution-graph work and the monotonic completion gate.
6. Appends one `run_finalized` `RunEvent`.

When a Run has declared checks, finalization also includes the verification
summary in `RunEvaluation.evidence_json`; failed/error results map to the
`validation` layer and incomplete evidence cannot be classified as passed.

### What finalization does NOT do

- Does not mutate Run status outside the canonical Supervisor decision; that
  decision may requeue the logical Run or move it to `waiting_for_review`.
- Does not write MemoryEntry, Policy, ProjectFolderExecutionConfig, ValidationRecipe, Capability, Artifact, or Proposal.
- Does not create RunReflection.
- Does not create learning proposals.
- Does not auto-apply anything.
- Does not call an LLM.
- Does not execute validators; validator execution belongs to the pre-cleanup
  Verification Engine boundary.

### Idempotency

Repeated calls to `POST /finalize` for the same `(run_id, attempt_number, finalizer_version)` return the existing completed `RunFinalization` without creating additional `RunEvaluation`, `TaskEvaluation`, or `run_finalized` event rows. A later physical attempt has a different attempt number and is finalized independently.

### Non-terminal rejection

Calling `POST /finalize` on a non-terminal run (queued, running, waiting_for_review) returns HTTP 422.

## RunEvaluation — Deterministic Harness Evaluation (Internal Primitive)

`RunEvaluation` is the canonical record for deterministic harness-level evaluation of a completed Run.

### Design principles

- **Append-only.** Each run finalization evaluation creates a new row. Existing evaluations are never deleted or overwritten. `GET /runs/{id}/evaluation` returns the most recent row.
- **Classifier-version auditable.** `evaluator_version` (e.g. `harness_eval.v1`) is stored per row, so classification history is preserved across version upgrades.
- **Harness-boundary evidence only.** Uses Run.status/error_json/output_json/exit_code, ordered RunSteps, RunEvents, safe Invocation Snapshot metadata, Artifacts, Proposals, ValidationRecipe, and linked Task/TaskRun. No LLM-as-judge. No parsing of vendor CLI internal tool calls.
- **RunEvent as primary classification source.** RunEvent structured `error_code` fields are the canonical classification input for patch, artifact, adapter, and materialization event evidence. `output_json.materialization_errors` is never parsed as classifier evidence — it is a debug/summary field only.
- **Materialization outcomes are RunEvent-covered.** `RunMaterializationService` returns materialization items and failures. `RunOrchestrationService` emits `artifact_ingested` / `proposal_created` RunEvents for each output JSON artifact and proposal success and failure. Runtime output text persistence emits `artifact_ingested` on success and failure. All materialization error codes map to the `tool` failure_layer via `_EXACT_ERROR_CODE_MAP`. Activity materialization failures are represented as artifact_ingested warning events with metadata_json.kind="activity" to avoid expanding the RunEvent enum.
- **Evidence-only for CLI runtimes.** Local CLI runtimes are black-box at the harness. No internal tool-call trajectory is reconstructed from stdout/stderr.
- **Verification results are authoritative for declared checks.** The engine
  persists bounded result summaries before sandbox cleanup. RunEvaluation
  consumes them and remains a classifier, while TaskEvaluation projects the
  verification summary and failed/incomplete checks into its checklist and
  known issues.

### RunStep adapter_started semantics

`RunOrchestrationService` creates an `adapter_started` step and later marks it succeeded/failed via `complete_step`/`fail_step`. There is no required separate `adapter_completed` step.

**Evaluation treats `adapter_started` with status in {`succeeded`, `failed`, `cancelled`} as adapter completion from the harness perspective.**

`missing_adapter_completed` is only flagged when `adapter_started` exists AND is still in a non-terminal state (queued/running/pending) AND no `adapter_completed` step was recorded.

### Classification pipeline

**A. outcome_status** (ordered rules):
1. Non-terminal status → `unknown`
2. `status == failed` → `failed`
3. `status == cancelled` → `failed` (`run_cancelled` synthesized into error codes so B2 exact map → `orchestration / run_cancelled`)
4. `exit_code != 0` → `failed`
5. `error_json` present → `failed`
6. `status == degraded` → `partial`
7. Succeeded + failed/error verification result → `failed`
8. Succeeded + skipped/missing declared verification → `unknown`
9. Succeeded + validation-failed proposal → `partial`
10. Succeeded + incomplete patch or materialization warning → `partial`
11. `status == succeeded` → `passed`
12. Otherwise → `unknown`

**B. failure_layer** (ordered rules, exact error-code mapping first):
1. outcome passed/unknown → null
2. Exact error-code mapping (canonical list in `server/src/modules/runs/finalizationService.ts::EXACT_ERROR_CODE_MAP`) — overrides all heuristics
3. Missing required Runtime Context Delivery/Invocation Snapshot evidence → `context`
4. Validation failure signals → `validation`
5. `sandbox` keyword in failed step error_type → `sandbox`
6. Missing adapter completion → `orchestration`
7. Adapter step failed or non-zero exit → `runtime`
8. `tool` keyword in step error_type → `tool`
9. Otherwise → `unknown`

**C. trajectory_status**:
- `insufficient_evidence` — no steps, no snapshot, no artifacts, no proposals
- `unsafe` — high-risk proposal (`risk_level=high/critical`) or low-trust artifact
- `incomplete` — incomplete patch signals, adapter not yet terminal, or no terminal step
- `acceptable`

Note: `trajectory_status` does not imply `failure_layer`. A run can be `outcome_status=passed` and `trajectory_status=unsafe`.

### Canonical error-code mappings

`file_access_adapter_requires_worktree_policy` → `policy` (not `sandbox`; exact map runs first).

Materialization error codes → `tool` failure_layer (all via exact map):
- `produced_artifact_ingestion_error` — produced artifact path ingestion failure
- `runtime_output_artifact` — runtime output text persistence failure
- `output_artifact_materialization_error` — adapter output_json artifact spec failure
- `output_proposal_materialization_error` — adapter output_json proposed_change spec failure
- `output_activity_materialization_error` — adapter output_json activity spec failure
- `code_patch_collection_error` — worktree patch collection exception

### What evaluation does NOT do

- Does not write MemoryEntry, Policy, Proposal, Capability, ProjectFolderExecutionConfig, or ValidationRecipe.
- Run finalization does not create RunReflection; task-level evaluation is created through the task evaluation bridge.
- Does not mutate Run, Artifact, or Proposal rows.
- Does not auto-apply any Proposal.

## Evolvable-Asset Evaluation Harness (D2)

The evaluation harness applies the Verification Engine to an
`evaluation_cases` fixture's stored baseline output and a system-produced
candidate run's stored output for comparison. Cases may be created directly with an
explicit read-only fixture or from a visible successful/degraded Run whose
latest `RunEvaluation` passed. The case records its input, expectation,
verification recipe, baseline version, and source run; sensitive fixture data
is sanitized and bounded before persistence.

`POST /api/v1/evolution/assets/:assetId/versions/:versionId/evaluation-cases/:caseId/execute`
requires a `candidate_run_id` and creates an `evolvable_asset_evaluation` job.
The worker re-reads that run's durable output after validating its visibility,
terminal status, passed post-run evaluation, and exact candidate-version pin.
It then evaluates candidate and baseline outputs with
`verification_engine.v1`'s output-checking core, stores structured scores,
check evidence, and regression blockers in
`evolvable_asset_evaluation_runs`, and updates the candidate's latest
evaluation summary. This MVP does not execute a candidate from `input_json`
inside the evaluation job; the candidate run must already have been produced
by the normal run authority. The evaluation job is read-only and has no shell,
network, or write-capable connector authority. Unsupported checks produce an
error/failed evaluation and never a pass.

Promotion proposals embed a database-derived evaluation summary and a policy.
The default is `warn_only`, so promotion can proceed with a visible warning.
The caller may request `hard_gate`; additionally, high/critical-risk assets
automatically switch to hard-gate after five active evaluation cases. The
applier re-queries evaluation rows and only accepts a passed
`verification_engine.v1` evaluation created by the evaluation-case executor.
Proposal payload summaries are evidence, not authorization. Public metadata
recording cannot forge a passed engine evaluation.

## TaskEvaluation — Task-Level Evaluation Bridge

`TaskEvaluation` records task-level evaluation results. It is downstream of `RunEvaluation` and populated via the task evaluation bridge.

### Evaluation layers

| Layer | Class | Scope | Append-only |
|---|---|---|---|
| Harness | `RunEvaluation` | Per-Run, deterministic, harness-boundary evidence | Yes |
| Task bridge | `TaskEvaluation` | Per-Task, mapped from RunEvaluation | Yes |

### Design principles

- **Append-only.** Each task evaluation bridge call creates a new row. Old rows are never overwritten or deleted.
- **Task ↔ Run source of truth is `TaskRun`.** There is no `runs.task_id` column; all task-run linkage checks use `TaskRun` rows.
- **RunEvaluation bridge.** The task evaluation bridge maps an existing `RunEvaluation` to a new `TaskEvaluation` row during finalization when `TaskRun` linkage exists — do not call it directly from API routes.
- **Does not mutate Task.status.**
- **Does not write MemoryEntry, Policy, Proposal, RunReflection, or any learning object.**
- **Invoked by finalization.** `POST /runs/{id}/finalize` enters
  `RunMaterializationService.finalizeRun`, which invokes
  `PostRunFinalizationService` to orchestrate RunEvaluation and the
  TaskEvaluation bridge. There is no separate public API for creating
  TaskEvaluation bridge rows from a Run.
- **ValidationRecipe is an input/criteria source.** It flows in at the top of the execution loop alongside `ProjectFolderExecutionConfig` and informs `RunEvaluation` classification. It is not downstream of `TaskEvaluation`.

### Evidence artifact linkage rule

| Creation path | Evidence source | TaskArtifact required |
|---|---|---|
| Bridge (`create_from_run_evaluation`) | Artifacts linked to the evaluated Run via `Artifact.run_id` | No |
| Manual (`create_manual_task_evaluation`) | Caller-supplied `evidence_artifact_ids` | Yes — all IDs must be linked through `TaskArtifact` |

When a manual task evaluation also supplies `run_id`, that run must be linked to
the task through `TaskRun`, and each evidence artifact must be linked through a
`TaskArtifact` row whose `run_id` matches the evaluation run. Bridge rows do not
create `TaskArtifact` rows as a side effect.

### Deterministic mapping from RunEvaluation.outcome_status

| outcome_status | score | recommendation | confidence |
|---|---|---|---|
| `passed` | 1.0 | `accept` | 1.0 |
| `partial` | 0.5 | `review` | 0.7 |
| `failed` | 0.0 | `retry` | 1.0 |
| `unknown` | null | `needs_evidence` | 0.3 |

`evaluator_type` is always `run_evaluation_bridge` for bridge-created rows.

### RunReflection

`RunReflection` is not automatically created by run or task finalization. It is populated externally (import, manual entry, or future evaluator output) and acts as the source for `ReflectionProposalBuilder`.

### Learning Loop Apply Path

`ReflectionProposalBuilder` creates pending proposal candidates from a `RunReflection`. Accepted proposals are applied through `ProposalApplyService`.

**Supported apply types (from reflection):**
- `follow_up_task` — accepted proposal creates a `Task` row. This is the first low-risk learning apply path.

**Unsupported apply types (remain pending-only):**
- `project_folder_execution_config_update`, `validation_recipe_update`, `capability_update`, `policy_update` — accepted proposals raise `UnsupportedProposalTypeError`.

Automation manual and schedule-triggered fire queue runs through the existing
runtime gates. The `/automations` UI supports agent-run, maintenance, and
versioned Workflow targets. Workflow targets carry `workflow_asset_key`,
`workflow_resolution`, optional `workflow_version_id`, and `input_json`;
scheduled Workflow targets are pinned for reproducibility. Each fire creates a
`WorkflowExecution` and `automation_runs.workflow_execution_id`; it does not
create a Plan or `plan_review`. Schedule automations can carry same-space
`AutomationCredentialGrant` pre-authorization. No external trigger is
implemented. No proposal type auto-applies without user acceptance.

### Future Work

- Runtime session checkpoint/fork/resume semantics are delivered through the
  CLI-conversation path; see the "Runtime session" section of ADR 0007 and
  [../modules/rooms.md](../modules/rooms.md). The Run Detail Resume action is a
  different thing: it resumes a `waiting_for_review` Run through the existing
  server endpoint and is not a runtime-session checkpoint.
- Apply handlers for `project_folder_execution_config_update`, `validation_recipe_update`, `capability_update`, `policy_update`.

## What Is Intentionally Not Modeled Yet

- Full tool-call ontology (individual tool invocation records per step).
- Token-level traces.
- Sub-agent orchestration schema.
- Cost accounting per run or step.
- Vendor-specific trace schema.
