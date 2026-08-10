# Runs And Outputs

Date: 2026-05-14

Runs are the durable execution record for agent work. A run must be auditable: request metadata, selected runtime, status, output, errors, activities, artifacts, and proposals must be inspectable after execution.

## Logical input and output contracts

The protocol defines three runtime-neutral contracts:

- `run_input.v1` is a computed adapter input assembled from existing durable
  Run/contract/Context/permission authorities.
- `runtime_event.v1` is the bounded semantic adapter-event vocabulary; raw
  token deltas and stdout/stderr are not members of this persisted contract.
- `run_output.v1` is the canonical final result plus declared-output
  validation manifest.

`run_input.v1` is passed to both managed and local-CLI adapter boundaries and
to the internal runtime host. It does not create a new database authority and
does not duplicate rendered private context.

For local CLI Runs, the server projects the envelope to a hidden Run Exchange.
Declared files are collected into the logical output manifest only after
containment, regular-file, size, and optional JSON Schema checks. A successful
process with a missing/invalid required output is a failed Run output.
Undeclared bounded files may be materialized as candidate Artifacts but never
satisfy a declaration. Raw Exchange state is deleted after materialization.

Terminal `runs.output_json` is always the strict `run_output.v1` envelope.
Adapter-native structured values and materialization summaries live under
`result`; the top level contains only schema version, semantic status, bounded
summary, result, and the validated output manifest. Workflow JSON Pointer
bindings resolve against `result` and fail closed when the source Run has no
canonical envelope.

Managed model lifecycle events and the JSONL modes of OpenCode, Codex CLI, and
Claude Code normalize to `runtime_event.v1`. Local CLI stdout is parsed by
complete line as it arrives, so supported tool lifecycle events are appended
before process exit. Text/token deltas, stderr/stdout chunks, and unknown
vendor payloads are not persisted as RunEvent rows.

Local CLI runtimes receive an opaque, short-lived, Run-scoped MCP identity and
only the intersection of the Run's declared grants and the System Action
Registry. The MCP endpoint re-loads the Run and space boundary for every call;
the canonical JSON-RPC call id is the action idempotency key. A
`require_approval` policy result moves the Run and current Attempt to
`waiting_for_review`. The adapter completion path re-checks CLI Run state and
does not overwrite that pause with a terminal result.

## Trace Read Model

`GET /api/v1/runs/{id}/trace` is the replay-oriented read model for failed and
succeeded runs. It returns one space-scoped aggregate containing:

- `Run`
- safe `Agent` summary
- immutable `AgentVersion` snapshot with system-prompt presence/hash metadata, not raw prompt text
- `RuntimeAdapter` summary
- `ModelProvider` summary without secrets
- safe Invocation Snapshot metadata, hashes, source refs, acknowledgements, and redaction metadata without raw rendered context text
- ordered `RunStep`
- ordered `RunEvent`
- linked artifact summaries without artifact content
- linked proposal summaries without raw proposal payload/content
- parent run summary
- child run summaries

The trace endpoint is for reconstruction and debugging. Artifact content,
export, and any raw context/prompt inspection remain separate gated reads.
Cross-space trace reads return not found and must not reveal whether the run
exists.

`GET /api/v1/runs/{id}/io` is the user-facing logical I/O view. It reconstructs
the runtime-neutral input without rendered hidden context or physical Exchange
paths, returns only a validated `run_output.v1`, filters the event list to the
semantic runtime vocabulary, and permission-filters Artifact references.
Run Detail renders this view separately from phase audit data.
It opens on logical I/O, with routing/model/profile provenance, verification,
attempt/fallback evidence, Artifacts, Proposals, and actionable review recovery
available without exposing physical Exchange paths or hidden rendered context.

Ordinary Assistant Chat uses the same queued Run pipeline. `POST
/api/v1/agents/{id}/chat` atomically persists the session/user message, Run,
and `agent_run` job in one database transaction, then returns
HTTP 202 with `chat_turn_accepted.v1`; it never
executes an adapter on the request path. The client then follows the canonical
RunEvent SSE endpoint. The accepted `run_id` is also attached to the durable
user message, so a reload retains a direct recovery link even if the live
stream disconnects. The worker persists one assistant message keyed by
`run_id` before appending the sole terminal `chat_completed` event. On that
event the client reads the durable message, including Artifact and canonical
tool-call references. Worker recovery periodically reconciles any terminal Chat
Run missing this event, including stale/orphaned and retry-exhausted work.
While the adapter is running, non-durable `chat.text_delta` frames share that
SSE connection so the reply renders incrementally; lifecycle remains the
persisted RunEvent granularity.

Conversation backend selection is a user × session binding. The selectable
runtime profiles come from the Agent, while CLI credentials come only from the
signed-in user's enabled space grants. The chosen backend is frozen on the Run.
Shared Agent runtime profiles never store a user credential. Direct CLI chat
uses the same accepted Runtime Context Delivery and typed Sandbox Runner
boundary as every CLI invocation. Vendor context files are not created; the
instructing user's scoped continuity is acquired by Runtime Context and rendered
directly at invocation.
There is no synchronous Chat endpoint or second Chat execution path. Run
cancellation remains the normal Run stop operation.

Each Room message creates one `agent_run_group`; the group is a collaboration
task, not the persistent conversation. The group records `room_id`,
`session_id`, `trigger_message_id`, `project_id`, and the Room's nullable
`project_folder_id`. Every recipient Run
records the speaking human as `instructed_by_user_id`, uses that human's
conversation backend binding, and declares `conversation_capture.json` as a
Run Exchange proposal packet (required for local CLI, declared as an optional
closing backstop for managed API). Its schema requires an explicit
`status=succeeded|rejected`; `rejected` is a semantic failure signal, while
`proposed_changes` remains the proposal payload. The server never infers
semantic failure from natural-language output. Materialization first creates
staged proposals through normal policy enforcement. Terminal publication
atomically promotes them to pending only for accepted Runs, or rejects them for
failed/cancelled/orphaned Runs; it never activates memory directly.
Room Runs use `selected_users` visibility with active content grants for the
current Room roster, still bounded by the canonical Project ACL. Artifacts and
proposals materialized from those Runs remain `selected_users` and inherit the
Run grants; adapter output cannot widen them to `space_shared`. Room members may
read task evidence, but only the speaking task's `manager_user_id` may mutate,
pause, cancel, or append directly to that task.

`GET /api/v1/agent-groups/{group_id}/trace` is the grouped-run companion read
model. It returns the group, members, task messages, delegations, root run id,
child run ids, linked artifact/proposal ids, and `run.spawn_child`
policy-decision ids. It is manager-scoped for ordinary groups and readable by
active Project-authorized Room members for Room tasks; it must not inline artifact content,
raw rendered context, or secret material. A newly created task group has no
root run until its triggering message is dispatched.

## RunStep vs RunEvent — grain rule

`RunStep` and `RunEvent` are intentionally kept as two tables with a strict
division of responsibility. They must not duplicate the same payload:

- **`RunEvent` is the append-only audit source of truth.** It carries the
  detailed phase payload — `summary`, `metadata_json`, exposure/trust levels,
  error codes — and is written through the server runs repository. Rows are never
  updated or deleted. Event writes are best-effort and must not block terminal
  run status writes.
- **`RunStep` is the coarse lifecycle/status projection.** A step carries only
  `step_type`, `status`, `title`, structured FKs (artifact_id,
  proposal_id, …), timing, and `error_type`/`error_message`.
  RunStep writers must **not** receive `metadata_json` or `*_summary`
  detail that already lives on a `RunEvent`. Step writes are best-effort
  lifecycle summaries.

Rule of thumb: rich, queryable phase detail goes on `RunEvent`; a `RunStep` is a
human-/UI-facing lifecycle marker. New orchestration code must not write the same
detail to both.

## Durable Outputs

- A run may produce an `Artifact`.
- A run produces a `Proposal` only for durable mutation requests.
- Artifacts and proposals materialized from a Run may narrow visibility but never widen beyond
  the Run: a `private` Run always produces owner-private outputs, and a `selected_users` Run
  retains its selected-user boundary and inherited grants.
- Accepted Runtime Context items freeze `owner_user_id` and `visibility` in the
  safe Delivery audit projection. Runs persist their aggregate
  `context_taint_json`. Another user's
  input forces outputs to `selected_users` over the instructing user and all
  contributing owners, even when the Run itself is `space_shared`.
- Widening a tainted Artifact uses a high-risk `egress_review` proposal.
  `ContentAccessService` rejects direct widening, and the proposal remains
  unappliable until every non-instructing content owner has recorded an
  `egress_granting_user` approval.
- `output_text` alone is display output and does not create an Artifact or
  Proposal.
- Durable mutations are review-gated; run execution does not auto-apply proposals.
- Future Knowledge generation from run output must follow Run/Artifact -> `knowledge_*`
  proposal -> human acceptance -> active KnowledgeItem. Run output must not
  directly create active Knowledge or Memory.
- Knowledge source monitoring is a future evaluator. Current Knowledge proposal
  apply relies on explicit proposal approval and the `proposal.apply` policy
  gate, not on source-monitoring classification.

## Materialization

Adapter result materialization supports these fields before the canonical
terminal envelope is written:

- `output_json.artifacts` for content-backed artifacts.
- `output_json.activities` for run-event activity records.
- `output_json.proposed_changes` for proposal creation.
- `output_json.delegations` for structured agent-group child-run requests.
- `produced_artifact_paths` from the runtime result for file-backed artifacts.

Materialization records errors in
`run.output_json.result.materialization_errors` when structured output cannot
be safely converted into durable records. Safe records are still created when
possible. If the adapter succeeds but artifact/proposal/finalization
materialization partially fails, the run is marked `degraded`.

Artifact INSERTs run the `artifact.persist` policy gate first. Proposal INSERTs
run the `proposal.create` policy gate first.

Delegation materialization is available only for grouped runs. Each
`output_json.delegations[]` entry must be structured (`target_agent_id`,
`instruction`, optional trace-safe `budget` and `context`). The server does not
parse free text to authorize delegation. Materialization calls
`AgentGroupRunService.spawnChildRun`, which performs membership, parent-agent,
authority-envelope, and `run.spawn_child` policy checks before queueing any
child run.

Managed API and local CLI runs inside an AgentRunGroup expose authorized room
tools through the same `AgentToolGateway`: `agent.delegate` and
`agent.wait_for_results`. Both execution channels require the corresponding
snapshotted Run tool grant. They are available to every active room agent, not
only the manager. Natural-language requests such as
"ask two reviewers" should be handled by the current recipient agent calling
`agent.delegate` for selected room members rather than by the model simulating
their answers. If the current agent needs sibling or delegated results before it
can answer, it calls `agent.wait_for_results`; the run moves to
`waiting_for_dependency`, releases the worker, and is requeued as the same run
after all declared dependency runs are terminal.

Product UI room messages create one manager/root run on the first message, not
at room creation. The room `goal` is optional, can be edited after creation, and
is used as run instruction/background only when present; it is not inserted as a
synthetic chat message. Structured `@agent` mention tokens from the Tiptap room
composer are resolved by the product UI into a visible routing preview and
trace-safe `recipient_segments`: one mention routes that segment directly to
that agent, adjacent mentions fan out the same segment to multiple agents in
parallel, and separated mention groups create separate recipient prompts. The
message content remains the displayed chat text, while each run prompt uses the
segment content with mention tokens removed. The user can explicitly choose
Agent coordination, which routes the full message to the manager instead of
direct fan-out so the manager can decompose/delegate through room tools. Plain
text resembling an `@agent` mention is not trusted for routing. When no
structured mention is present, the message goes to the manager by default.
Direct segmented routing does not contain server-side hard-coded summary
semantics; a manager or other recipient that needs the other segment results
must use `agent.wait_for_results(scope=current_turn)`. Multi-recipient direct
turns include the original user message, recipient segment plan, and current
recipient marker in each recipient run's model context so the agent can decide
whether to wait on sibling runs instead of seeing only its own segment. Internal
agent IDs and run IDs are tool/audit identifiers and should not be included in
user-facing room replies unless the user explicitly asks for debug/audit
identifiers. Each
`agent.delegate` tool call routes through the same
`AgentGroupRunService.spawnChildRun` path and produces normal `run_delegations`
and delegated child `runs`.

Delegated child-run lifecycle is projected back into the group audit surface by
`AgentGroupRunLifecycleProjector`. When the child run starts, the linked
`run_delegations` row moves to `running` and `delegation_started` events are
written on the child run and root run trace spine. When the child reaches a
terminal state, the delegation row moves to `succeeded`, `failed`, or
`cancelled` (`degraded` child runs map to failed delegations), stores a bounded
`result_summary`, appends a `delegation_result` group message, and writes
`delegation_completed` events on the child/root trace spine. Child artifacts and
proposals remain normal run outputs: group trace exposes their IDs for
drill-down and never auto-applies proposals.
The projector does not infer automatic follow-up summaries. Instead, it watches
for runs in `waiting_for_dependency`; when a completed run satisfies one of
their declared dependencies and all declared dependencies are terminal, it
requeues the same waiting run with the dependency result summaries in its
continuation prompt. Non-delegated grouped agent runs project their
`output_text`/summary back into the room as `agent_message` rows linked to the
original user conversation. Product chat surfaces should keep delegation
internals folded by user turn by default and show the recipient/delegating
agent's final `agent_message` as the main reply for that turn.

Claim/ObjectRelation proposal materialization is packet-only: `claim_*` and
`object_relation_*` entries must carry a structured
`payload_json` or `payload` object with a matching `operation`. The materializer
does not infer claims or relations from free text, gap-analysis strings, or flat
proposal-envelope fields.

## Boundaries

- Runtime/provider execution is outside the core product boundary and should be represented through adapter results.
- Managed artifacts and proposals are durable product records.
- Native capability execution is planned, not active. System bookkeeping runs may
  carry `capability_id` / `capabilities_json` provenance, but they do not execute
  `adapter_type="capability"`; that adapter spec remains disabled until a native
  executor exists.
- External capabilities default **disabled**; enable state persists in `$AGENT_SPACE_HOME/config/settings.yaml` (`capabilities.enabled_external_capabilities`) and survives registry reload.
- Disabled external capabilities fail at adapter resolution with `capability_disabled` before execution.
- `one_shot_docker` is the critical local-CLI executor mode. It provides a
  separate container with deny-by-default networking, read-only root, dropped
  capabilities, no-new-privileges, and fixed resource limits. Docker/image/path
  failures are terminal and never downgrade to worktree execution. Worktree
  execution still scopes repository changes only and does not provide OS,
  network, or resource isolation.

## Validation status

The A2 Verification Engine runs before a worktree sandbox is cleaned up and
persists one `verification_results` row per `(run, verifier_type,
verifier_version)`. It consumes the immutable Run contract, the Project Folder's
enabled `ValidationRecipe`/profile checks, adapter output, materialization
summaries, and the live sandbox. Supported deterministic checks are
`command`, `test`, `lint`, `typecheck`, `file_exists`, `file_changed`,
`diff_scope`, `artifact_exists`, `artifact_schema`, `output_schema`,
`proposal_created`, and `no_forbidden_change`. Code-patch collection now
records structural validation metadata and the engine verifies changed files
and forbidden-path boundaries; the proposal payload no longer claims that
patch validation is skipped.

Command execution and git worktree inspection use the typed Sandbox Runner
`verification` runtime. That runtime receives one managed workspace mount and
the immutable recipe argv, runs without a shell or network in an empty-root
namespace, exposes the Runner-owned Node toolchain path, rejects output beyond
the fixed 64 KiB evidence ceiling, and has no application-server subprocess
fallback.

`PostRunFinalizationService` reads these results. A declared failed/error
check makes a successful runtime evaluation `failed`; a declared but skipped
or missing check is `unknown` with `insufficient_evidence`; a successful
runtime exit alone cannot produce `passed` when deterministic checks are
declared. Result evidence stores references, paths, exit metadata, and bounded
schema error codes, never raw stdout/stderr, full patches, credentials, or
file contents. `GET /api/v1/runs/{run_id}/verification(s)` exposes the
space-scoped result read model.

## Attempts, cancellation, and supervision

`runs` is the logical execution record; `run_attempts` is the physical
execution record. The first dispatch claims a pre-created queued attempt when
available, while legacy runs are backfilled as attempt 1. A retry never creates
a second logical Run: it records the completed attempt, writes an idempotent
`run_supervisor_decisions` row, and queues the next attempt. When C2 has a
persisted fallback chain, the next untried eligible profile is selected and
stamped for that attempt; an explicit profile remains a hard pin.

The deterministic MVP retries classified transient failures plus explicit
semantic rejection, deterministic verification failure, and required Run
Exchange output validation failure. A successful adapter process with an
explicit `status=rejected` or failed/error acceptance check is terminalized as
a failed Attempt before finalization. `RunEvaluation` classifies the structured
reason, and the existing Supervisor remains the sole physical-attempt authority.
It respects the `max_attempts` cap and aggregate run cost cap. A retry receives
the original task plus bounded prior-attempt reason context; a grouped/Room Run
is not projected terminal while the Supervisor has requeued it. Exhaustion,
non-retryable failures, missing retry identity, and budget exhaustion move the
logical Run to `waiting_for_review`. Cost is read from the append-only usage
ledger.

Pre-materialization checks run before proposal, artifact, delegation, or code
patch side effects. Output-dependent checks run after passive outputs have been
staged. Runtime delegation is deferred to terminal finalization and replayed
from the durable canonical output using a stable idempotency key, so worker
reclaim and explicit finalization use one recoverable path. A finalization
failure leaves the committed Run outcome intact and retries the Job; chat/Room
completion is withheld until that finalization succeeds.

Runs in `waiting_for_review` have explicit human controls: `POST /resume`
requeues after approval (`same_attempt` for an in-flight policy pause,
`new_attempt` for a Supervisor terminal hold) and `POST /abandon` records a
cancelled terminal outcome after review. There is no implicit automatic resume.

CLI cancellation is two-phase: the Run enters `cancelling`, the process gets
SIGTERM, the server waits for exit, and escalates to SIGKILL when needed. The
Run is marked `cancelled` only after exit confirmation; otherwise it remains
`cancelling` with a confirmation-timeout result. On worker startup, stale
running/cancelling runs whose process registry was lost become `orphaned`, are
finalized, and pass through the same supervisor policy. Local CLI attempts also
have a no-output/no-activity watchdog that emits `cli_stall_timeout`.

`manual_review` and `model_judge` are represented as declared, skipped
verifier types only. They are not completion evidence until their respective
review/model boundaries land; model-judge execution must use a model distinct
from the generator. Root/integration verification is implemented by the B2
Plan graph layer.

The `RuntimeAdapterSpec` catalog is the dispatch declaration: each spec names
an executor family, and orchestration selects the family implementation from a
registry map. Adapter-specific names are not dispatch branches. The same spec
records conservative runtime capability declarations for future routing and
conformance checks. For Claude Code, the local CLI path renders and verifies a
run-scoped `.claude/settings.json` denying the runtime-internal `Task` tool;
Codex remains unknown for this control.

Workflow definitions are versioned through the evolvable-asset control plane.
`runs.workflow_version_id` records the approved version selected for a fixed
Workflow launch. Workflow Automation materializes that version into a durable
`WorkflowExecution` and its execution-node tables. An Agent Plan may retain a
`reference_workflow_version_id` as planning context, but its Plan Nodes are
independent and are never copied into `tasks`.

Task/Automation/Workflow contract fields such as `acceptance_criteria_json`,
`definition_of_done`, `required_outputs_json`, `risk_level`, `max_runs`,
`max_cost`, and `max_duration_seconds` are declared in the task schema but
are snapshotted into the Run contract. A run contract may additionally declare
`max_attempts`; budget dimensions are resolved from immutable Space, Task,
Automation, Workflow, and Plan sources. Explicit precedence selects the
highest tier per dimension and the strictest cap wins within a tier; without
precedence the strictest cap wins across all sources. The Run snapshot and
PlanVersion `budget_json` retain the effective values, selected source,
declared precedence, and server-owned authority trace. Agent tool input can
narrow its Plan declaration but cannot manufacture an inherited authority.
`max_runs` limits
logical executions for the selected Space, Task, Automation, or Workflow/plan
coordinator source. Plan children carry `root_run_id`, so one workflow fire
is not multiplied by its child count. `max_attempts` limits physical
executions of one Run. A1 carries the applicable project/route context
forward; A2 owns verification of acceptance and required outputs; A3 enforces
both limits at their respective boundaries.

`trigger_origin='autonomous'` is an Automation-authorized execution subtype,
not a credential-policy bypass. Its separate Space/owner/UTC-day pool uses a
transaction-scoped advisory lock, root execution Run count, optional measured
cost, and fresh subscription-utilization telemetry. Missing, stale, or
over-ceiling quota refuses admission. The decision callback, domain-budget
check, Run/link creation, and audit persistence share one transaction.
Autonomous execution permission snapshots remove `authorization.request` and
all side-effecting system actions, so unattended work cannot park itself for a
new interactive grant. A scheduled recovery task cancels any legacy/unexpected
autonomous Run that nevertheless remains `waiting_for_review` beyond one hour.

## Run model config (resolved_model)

Each Run may snapshot its selected Agent runtime profile plus model provider
and model name at creation. `RunOut.resolved_model` exposes a safe summary:

- `provider_id`, `provider_name`, `provider_type`, `model`, `source` (`runtime_profile` | `request` | `agent_default` | `runtime_default` | `space_default` | `none`)
- `used_by_adapter` — whether the selected runtime adapter consumes model config
- `adapter_model_support` — `uses_model` | `not_applicable` | `unsupported` | `unknown`
- `disclosure_note` — user-facing text when a model was recorded but not used (e.g. capability adapters)

For managed calls, adapter evidence distinguishes intent from execution:
`requested_model_provider_id` is the routed/requested Provider and
`model_provider_id` plus `model` name the Provider/model that actually served
the turn after any invocation-layer fallback. When those Provider ids differ,
the adapter also emits a `warning` Run event with
`event_code=model_provider_mismatch` and both ids, so event-stream consumers do
not need to infer fallback from adapter metadata.

`runs.runtime_profile_id` records which `AgentRuntimeProfile` was selected.
`runs.runtime_profile_snapshot_json` stores the selected profile's adapter,
provider/model, the Run-owner credential selected by routing, runtime config,
and runtime policy at run creation. Execution uses that snapshot before falling back to the immutable
`AgentVersion`, so later runtime profile edits affect only future runs.

Adapters that consume model config today depend on runtime requirements.
`claude_code` and `codex_cli` may receive model hints only when the underlying
CLI supports them. `capability` records model config but does not call an LLM.
Claude execution must go through the `claude_code`
RuntimeAdapterSpec and `GenericCliRuntimeAdapter`.

Conversation text deltas are ephemeral transport events. The server keeps a
bounded, five-minute in-process replay buffer so an SSE subscriber that connects
after a queued Run starts can catch up before the durable assistant message is
available. This transport assumes the official single-server deployment: a
multi-server or separately deployed worker topology must replace the process
local bus with shared pub/sub while preserving the same `chat.text_delta`
contract. The durable message remains the canonical conversation record.

## ModelProvider secrets

Provider API keys are write-only on the API. Storage uses `Credential.secret_ref` with scheme `model_provider_api_key:v1:` (encrypted payload + nonce). Runtime credential resolution decrypts via `Credential.secret_ref` through the canonical `runtimes.credentials` boundary. `ModelProvider.credential_id` is the single source of truth for provider API keys.
