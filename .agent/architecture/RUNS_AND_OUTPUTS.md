# Runs And Outputs

Runs are durable execution records. `execution_kind` distinguishes an ACP
Agent Run from a bounded ProviderTask Run; `run_role` independently marks an
execution or coordinator. A Run must be auditable: request metadata, selected
Profile/runtime, status, output, errors, activities, artifacts, and proposals
must be inspectable after execution.

## Logical input and output contracts

The protocol defines three runtime-neutral contracts:

- `run_input.v1` is a computed adapter input assembled from existing durable
  Run/contract/Context/permission authorities.
- `runtime_event.v1` is the bounded semantic adapter-event vocabulary; raw
  token deltas and stdout/stderr are not members of this persisted contract.
- `run_output.v1` is the canonical final result plus declared-output
  validation manifest.

`run_input.v1` is a server-computed logical I/O projection; it creates no new
database authority. ACP Agent prompts receive authorized context through
Runtime Context Delivery, not by serializing the whole envelope into a second
prompt channel.

Selectable Agent runtimes execute through ACP on a Host daemon. Declared output
artifacts are collected from the execution Host and checked against the Run's
output contract. Missing or invalid required outputs fail the Run; undeclared
files cannot satisfy a declaration.

Terminal `runs.output_json` is always the strict `run_output.v1` envelope.
Adapter-native structured values and materialization summaries live under
`result`; the top level contains only schema version, semantic status, bounded
summary, result, and the validated output manifest. Workflow JSON Pointer
bindings resolve against `result` and fail closed when the source Run has no
canonical envelope. The summary is evidence text, capped (32,000 characters,
`evidenceRedaction.ts`), so it is not a lossless channel. When the Run's
contract declares a structured output schema (`structured_output_json.schema`)
and the adapter returned that object only inside its reply text, as a CLI
runtime does, the execution owner keeps it as `result.structured_output`. The
kept object is the reply as JSON, or its last fenced JSON block, whose `schema`
is the declared one, at most 262,144 characters. The terminal writer's sanitize
then bounds each string in it, not the object, so a long valid reply survives
whole. Nothing is extracted without a declared schema, and redaction is not
relaxed.

ACP session and Agent events are normalized to `runtime_event.v1`. The shared
ACP controller consumes protocol messages as they arrive; stdout/stderr
chunks, raw token deltas, and unknown vendor payloads are not persisted as
RunEvent rows.

ACP Agent runtimes receive an opaque, short-lived, Run-scoped bearer identity
(`run_tool_identities`) and only the intersection of the Run's declared grants
and the System Action Registry. The Run-scoped REST tool surface
(`/api/v1/runs/:runId/tools`) re-loads the Run and space boundary for every
call; the caller's `Idempotency-Key` header is the action idempotency key, and
a caller that sends none gets a fresh one per request. See
[`SYSTEM_ACTIONS.md`](SYSTEM_ACTIONS.md) for the surface and how it is
delivered. A
`require_approval` policy result moves the Run and current Attempt to
`waiting_for_review`. The adapter completion path re-checks CLI Run state and
does not overwrite that pause with a terminal result.

## Trace Read Model

`GET /api/v1/runs/{id}/trace` is the replay-oriented read model for failed and
succeeded runs. It returns one space-scoped aggregate containing:

- `Run`
- safe `Agent` summary
- immutable `AgentVersion` snapshot with system-prompt presence/hash metadata, not raw prompt text
- execution kind and selected `runtime_key`/Profile summary (Agent Runs only)
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
executes an adapter on the request path. The client then follows the Run's
turn (`/runs/{runId}/turn/stream`), which projects whichever event log this Run
wrote to into one ordered list of parts. A `summary` viewer may see Run
metadata with `output_json` withheld; the turn, turn-stream, and `/io` bodies
require effective `full`. The accepted `run_id` is also attached
to the durable user message, so a reload retains a direct recovery link even if
the live stream disconnects. The worker persists one assistant message keyed by
`run_id` before appending the sole terminal `chat_completed` event, and that
event — not the Run going terminal — is what moves the turn to `done`, because
everything earlier happens while the reply does not yet exist. On `done` the
client reads the durable message, including Artifact and canonical tool-call
references. Worker recovery periodically reconciles any terminal Chat Run
missing this event, including stale/orphaned and retry-exhausted work; a turn
whose finalization keeps failing is completed as failed after a bounded number
of passes (`recordChatTurnFinalizationFailure`), each failure visible as a
turn warning. While
the adapter is running, non-durable `chat.text_delta` frames reach the client
as a growing `text` part, so the reply renders incrementally.

Conversation backend selection is frozen in the selected Runtime Profile and
Conversation/Host-thread snapshot. Every Agent Run uses the canonical Runtime
Context Gateway Delivery, projected into ACP's single user-prompt channel, and
the immutable permission snapshot. Persistent Host-thread context cursors are
bound to the same opaque ACP session; a context/session mismatch starts a fresh
session. Native login remains on that Host; ModelProvider-backed OpenCode uses
the server proxy lease. There is no synchronous Chat endpoint or second Chat
execution path. Run cancellation remains the normal Run stop operation.

Each Room message creates one `agent_run_group`; the group is a collaboration
task, not the persistent conversation. The group records `room_id`,
`session_id`, `trigger_message_id`, `project_id`, and the Room's nullable
`project_folder_id`. Every recipient Run
records the speaking human as `instructed_by_user_id`, uses that human's
conversation backend binding, and declares `conversation_capture.json` as an
output-contract proposal packet for the ACP Agent Run. Its schema requires an explicit
`status=succeeded|rejected`; `rejected` is a semantic failure signal, while
`proposed_changes` remains the proposal payload. The server never infers
semantic failure from natural-language output. Materialization first creates
staged proposals through normal policy enforcement. Terminal publication
atomically promotes them to pending only for accepted Runs, or rejects them for
failed/cancelled/orphaned Runs; it never activates memory directly.
Room Runs use `selected_users` visibility with active content grants for the
current Room roster, still bounded by the canonical Project ACL. Every Run,
Artifact, and Proposal read (and every Proposal decision/apply path) also
rechecks active Room membership for Room-backed Runs, so a permanent selected-
user grant cannot preserve a removed member's historical output. Artifacts and
proposals materialized from those Runs remain `selected_users` and inherit the
Run grants; adapter output cannot widen them to `space_shared`. Room members may
read task evidence, but only the speaking task's `manager_user_id` may mutate,
pause, cancel, or append directly to that task — and only while they remain an
active Room member: `manager_user_id` is provenance, not authority (B8A), so
removal from the Room ends the manager's reads of and controls over the Room
tasks they started, in the list as well as the detail.

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
- Run output does not directly create active Knowledge or Memory. A Knowledge
  write from run output goes through a `knowledge_*` proposal and human
  acceptance.
- Knowledge proposal apply uses proposal approval and the `proposal.apply`
  policy gate. It does not classify through source monitoring.

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

A successful adapter result is also `degraded` when a governed tool call this
Run made failed. The evidence is the Run's own `action_completed` events: the
System Action dispatcher records every governed call as one, and marks a
refusal `failed`, so `degraded` is derived from the `failed` ones at the
**latest attempt** — a retry that went through cleanly is not a degraded
answer. Both an ungranted refusal and a `wait_for_results` park failure count;
a vendor-internal tool failure inside the ACP runtime deliberately does not,
because a runtime's own grep missing is its business and not a statement about
Rainver's surface. Such a Run still produces an answer, but it produced it
without the tool, and a terminal `succeeded` would make an answer written
without a granted tool indistinguishable from one written with it. The Run
additionally carries a `warning` event with `error_code`
`managed_tool_degraded` naming the tools and their error codes. That status and
that event are what an unattended Run leaves behind for a reader who was not
there; see the Always-on enablement gate in
[../tasks/deferred-register.md](../tasks/deferred-register.md).

ACP Agent tools dispatch through Rainver's Agent Tool/System Action Gateways.
Bounded ProviderTask calls use their own policy, Delivery, snapshot, error,
and usage ledger; they do not pass through the Agent runtime adapter. A formal
bounded operation needing Run-level lifecycle records its ProviderTask refs on
a `provider_task` Run; incidental calls do not create Runs. One bounded task is
one Run however many provider attempts its key pool makes: each attempt links
itself to the same Run, and the Run's terminal state is decided once, when the
task itself succeeds or fails. `runs/boundedProviderTaskRun.ts` is the single
implementation of that rule for both `text` and `structured` completions; a
domain contributes the request and, optionally, a `finalize` step that turns
the accepted completion into the Run's durable result. `finalize` runs *before*
the Run is marked terminal, so a terminal bounded Run always has its output
applied.

A `provider_task` Run has two database shapes, mirroring the Agent shape's
"snapshot required before dispatch". A **queued** row has no ModelProvider and
no ProviderTask control/delivery/snapshot references and no `started_at`; it
may only be `queued`, `cancelling`, or terminal without ever having started. A
**started** row has all four. The attempt that starts the task fills them in
the attempt's own transaction, so the Run cannot be `running` while pointing at
a ledger record that was rolled back, and it refuses to start a Run that has
left `queued` (`run_not_queued`) rather than spending the provider on work
already called off. Cancellation and job exhaustion treat a queued ProviderTask
Run as ordinary queued work: `cancelJob` and `reclaimStuckJobs` end the Run
behind a `provider_task_run` job exactly as they end an `agent_run`'s —
through the Run repository's one terminal write, never by writing `runs`
themselves; its Task is then settled from finalization
(`PROJECT_WORK.md`, "Trigger"). A Run ended this way (`run_abandoned`,
`run_cancelled`) that nobody finalized is picked up by the orphan-finalization
step of recovery (`listOrphanedRunIds`), so every domain's settlement
reconciler runs for it (a briefing version is settled, not left queued
behind its dead job) — and
the handler settles the Run `failed` when its own last attempt throws — which
is the only thing that finishes a Run the worker never dispatched, because
`recoverStaleRuns` reclaims only rows that actually started.

A bounded task whose caller should not wait for it — because it writes durable
records the request path must not lose — is admitted on the request path and
performed by the worker. The request creates the queued Run through the same
budget admission a queued Agent Run uses and enqueues one `provider_task_run`
job carrying only `run_id`; the handler reloads the Run, rebuilds the request
from its frozen contract, applies the same instance-update drain admission
`agent_run` applies, and settles the Run failed only once the job has no
retries left. Nothing about what the task does comes from the job payload.

Artifact INSERTs run the `artifact.persist` policy gate first. Proposal INSERTs
run the `proposal.create` policy gate first.

Delegation materialization is available only for grouped runs. Each
`output_json.delegations[]` entry must be structured (`target_agent_id`,
`instruction`, optional trace-safe `budget` and `context`). The server does not
parse free text to authorize delegation. Materialization calls
`AgentGroupRunService.spawnChildRun`, which performs membership, parent-agent,
authority-envelope, and `run.spawn_child` policy checks before queueing any
child run.

ACP Agent Runs inside an AgentRunGroup expose authorized room tools through the
same `SystemActionGateway`: `agent.delegate` and `agent.wait_for_results`. The
corresponding
snapshotted Run tool grant. They are available to every active room agent, not
only the manager. Natural-language requests such as
"ask two reviewers" should be handled by the current recipient agent calling
`agent.delegate` for selected room members rather than by the model simulating
their answers. If the current agent needs sibling or delegated results before it
can answer, it calls `agent.wait_for_results`; the run moves to
`waiting_for_dependency`, releases the worker, and is requeued as the same run
after all declared dependency runs are terminal. A wait on runs that are
themselves waiting, directly or through others, for the caller is refused
(`dependency_cycle`) instead of parking both: a later recipient of the same
message is parked behind the first at creation, so the first waiting on
`current_turn` would otherwise never wake.

Product UI room messages create one manager/root run for an initialized
Conversation, not at Room creation. Conversation setup is an explicit draft
action that pins execution before the first message. The room `goal` is optional, can be edited after creation, and
is used as run instruction/background only when present; it is not inserted as a
synthetic chat message. Structured `@agent` mention tokens from the Tiptap room
composer are classified by one protocol rule (`agentMentionRoute` in
`packages/protocol/src/roomDiscussions.ts`): a mention cluster that opens the
message or a line (only whitespace and list markers before it; a quoted `>`
line does not count, and a line break ends a cluster) is an **address**; any
other mention is a **reference**. A message with an address
is sent `direct` with trace-safe `recipient_segments`: one address cluster
receives the whole message, adjacent mentions fan the same segment out to
several agents, and separate address clusters (for example one per line)
create separate recipient prompts. A message whose mentions are all
references is sent as `agent_coordination`: the full message goes to the
manager, with the referenced agents as `coordination_target_agent_ids`, which
the server checks are active Agent members of the Room (422 otherwise), records
on the message and in the manager Run's `model_override_json.room_coordination`,
and states in the manager's prompt as a "[The person asked you to arrange this
with]" block so the manager delegates to them through room tools. The composer
shows this route as one line under the editor whenever the draft mentions
anyone, and the person can switch it to the other route for that draft. Segment
and message content keep the `@Name` text as written. Plain text resembling an
`@agent` mention is not trusted for routing. When no structured mention is
present, the message goes to the manager by default. A retry routes the
message the way it was sent, including its still-active coordination targets.
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
- Native capability execution is not active. System bookkeeping runs may
  carry `capability_id` / `capabilities_json` provenance, but they do not execute
  `runtime_key="capability"`; that runtime definition is disabled.
- There is no external-capability execution path: no enable switch or
  `capability_disabled` resolution error exists, and the `capability` runtime
  definition is `planned` and disabled by default.
- `one_shot_docker` is the sandbox level a critical-risk vendor CLI run receives
  from `resolveSandboxLevelForRuntime`. File-access CLI specs set
  `supports_one_shot_docker`; an adapter whose spec does not fails preparation
  with `docker_sandbox_not_supported` and does not run. The level does not start
  a container. `workingDirScopeForLevel` maps it to `worktree`. On a daemon run
  the level is carried on the isolation policy; the workspace is the Location,
  and only `read_only` changes what the run is given. Worktree execution scopes
  repository changes and does not provide OS, network, or resource isolation.

## Validation status

The A2 Verification Engine runs before a worktree sandbox is cleaned up and
persists one `verification_results` row per `(run, verifier_type,
verifier_version)`. It consumes the immutable Run contract, the Project Folder's
enabled `ValidationRecipe`/profile checks, adapter output, materialization
summaries, and the live sandbox. Supported deterministic checks are
`command`, `test`, `lint`, `typecheck`, `file_exists`, `file_changed`,
`diff_scope`, `artifact_exists`, `artifact_schema`, `output_schema`,
`proposal_created`, and `no_forbidden_change`. Code-patch collection
records structural validation metadata and the engine verifies changed files
and forbidden-path boundaries.

Command execution and Git inspection use the typed `command_run` host frame,
with one workspace identity and recipe argv. There is no shell or ambient
environment inheritance. The built-in host adds an empty-root namespace with
no network; a trusted host runs natively and retains native network access.
The aggregate stdout/stderr budget is 256 KiB; overflow terminates the command
and reports an error, so a partial changed-file list cannot pass verification.
There is no application-server subprocess fallback.

`PostRunFinalizationService` reads these results. A declared failed/error
check makes a successful runtime evaluation `failed`; a declared but skipped
or missing check is `unknown` with `insufficient_evidence`; a successful
runtime exit alone cannot produce `passed` when deterministic checks are
declared. Result evidence stores references, paths, exit metadata, and bounded
schema error codes, never raw stdout/stderr, full patches, credentials, or
file contents. `GET /api/v1/runs/{run_id}/verification(s)` exposes the
space-scoped result read model.

## Attempts, cancellation, and supervision

An execution-time `subscription_quota_exhausted` refusal can park a bounded
successor attempt through `rooms/quotaRecovery.ts` and the existing
`waiting_for_quota` gate. The failed attempt and its usage remain intact; the
Run stays queued without a new job, releases its dispatch lock and conversation
turn, and is not projected as terminal to its parent. A task contract or an
explicit task-scoped collaboration defaults to automatic continuation; ordinary
chat defaults to a paused choice. Managed fail-fast work retains its own failure
surface. The existing attempt and cost caps still apply, and quota recovery
always uses the same route, without a model/funding fallback or a new
collaboration budget.

The marker's typed `recovery` records the choice, refusal/intent times, next
check, seven-day expiry and pause reason. The existing minute pass reads due,
enabled recoveries only. A known vendor reset permits one bounded attempt;
newer telemetry or a later CLI refusal showing a full window postpones it.
Refusal-derived readings retain the refusal's timestamp. Admission considers
the fullest window that has not reset; equal percentages use the later or
unknown reset, so one reset cannot bypass another exhausted window. Cached
usage displays retain the original reading. Without a reset, only a
new readable quota below the Space's reserve line can release it. Unresolved checks back off at
least fifteen minutes. Recovery admissions serialize per login and wait behind
active work on that account. New user messages, closed/blocked tasks, lost
membership/Project write authority, edits to the task or a cancelled collaboration pause recovery;
dispatch still performs normal policy, Profile and fresh context authorization.
Expiry pauses the choice rather than starting old work later.

Recovery admission creates a job for the successor physical attempt while
holding the Run row lock. It never reuses the failed attempt's still-finishing
job; clearing the waiting marker and enqueueing the successor commit together.

`PATCH /api/v1/runs/:runId/quota-recovery` accepts only `auto_continue` and uses
the existing owner/instructing-user command rule. Its row lock serializes with
admission: disabling persists without discarding progress; enabling renews the
person's intent. After admission it returns 409 and directs the person to stop
the active Run. Generic execution, FIFO and reserve overrides cannot erase or
bypass an interrupted Run's choice. Normal Stop cancels the Run altogether.
The same scoped controls appear in the transcript, its fixed bottom activity
bar, and Run detail. A queued quota hold is a blocked Turn with `blocked_on =
quota`, not active model work. The retry context requires inspecting completed
actions/current files before continuing; external CLI side effects still have
no universal exactly-once guarantee, and uncertain outcomes need the person.

`runs` is the logical execution record; `run_attempts` is the physical
execution record. The first dispatch claims a pre-created queued attempt when
available. A Run with no attempt row is recorded as attempt 1. A retry never creates
a second logical Run: it records the completed attempt, writes an idempotent
`run_supervisor_decisions` row, and queues the next attempt. When C2 has a
persisted fallback chain, the next untried eligible profile is selected and
stamped for that attempt; an explicit profile remains a hard pin.

The supervisor retries classified transient failures plus explicit
semantic rejection, deterministic verification failure, and required Run
Exchange output validation failure. A successful adapter process with an
explicit `status=rejected` or failed/error acceptance check is terminalized as
a failed Attempt before finalization. `RunEvaluation` classifies the structured
reason, and the existing Supervisor remains the sole physical-attempt authority.
Finalization rechecks the Run and physical attempt under its existing lock;
the Supervisor compares that attempt number again under the Run row lock.
An earlier attempt's evaluation cannot finalize or supervise a newer one.
Settlement rechecks the attempt after supervision as well: once a retry has
superseded it, the earlier finalization leaves domain reconciliation to the
successor's own finalization, even if another worker has already finished it.
The superseded finalization closes its own completion gate without running
reconcilers, because it owes no further domain settlement.
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

Finalization has one PostgreSQL owner per Run attempt. Contenders, including
reentrant domain callbacks, return `finalization_in_progress` immediately;
jobs defer completion without consuming a model attempt and explicit finalize
requests return HTTP 409. They never wait on the owner's advisory lock.
An existing current-attempt finalization can resume its owed settlement after
the Supervisor moves the Run to `waiting_for_review`; this does not resume
execution or grant approval. A policy pause without that finalization remains
ineligible. Failed settlement backs off to at most one hour, including after
many failed passes.
`runSettlement.ts` composes the durable completion steps. Host-thread outcome
and dispatch release are a required `host_thread` step for hard terminal Runs,
shared by cancellation, adapter completion and recovery. Failed steps remain
owed while completed steps are skipped on replay. A review hold does not mark
Host release done: later cancellation adds that obligation. Recovery also finds
legacy settled records whose dispatch claim is still held, independently of
whether `chat_completed` was already written. Terminal Run update results
retain the Host-thread dispatch metadata needed for this replay.

The `host_thread` step settles two obligations in one transaction
(`PgHostThreadRepository.settleRunOutcome`), locking the Run row (FOR SHARE)
before the thread row, the order quota admission uses. Nothing is written
unless the Run, under that lock, is hard terminal and on this thread: a
terminal snapshot held after a Supervisor successor attempt queued the Run
again leaves claim, session, identity, occupancy and `last_run_id` unchanged.
- **Outcome** (vendor session, identity/standing digests, occupancy,
  `last_run_id`) is written only when it is the thread's latest word: refused
  when a newer Run already reported, a handoff rotated the session, or another
  turn holds the thread. A Room turn held for quota and re-admitted after the
  person's newer turn finished therefore never replaces that turn's session.
- **Claim release** clears `dispatch_lock_id` only when it equals this Run's
  id on its own thread and the Run is hard terminal under that lock. Another
  Run's claim, an admission nonce, or the Run's claim while a Supervisor
  successor attempt has it queued again is never touched.
The linearization point is that transaction's commit. The step completes only
when the Run no longer holds the claim; a claim held by a Run that is not
terminal throws `host_thread_claim_held` and stays owed (settlement retry and
backoff). A refused outcome is not a failure. Settlement steps may declare an
`owed` state check: a ledger that recorded `host_thread` done while the claim
is still held (written before the claim was its own obligation) is reopened by
the settlement sweep, which selects terminal Runs still holding a claim.

`RunRecoveryService` replays these durable obligations; `RunRecoveryLoop` owns
one background pass on its own timer independently of business job lanes;
even occupied lanes cannot stop maintenance, and passes never overlap. Each
step of a pass (cancellation intent, stale preparation, orphan finalization,
chat completion, Task finalization, settlement) and each Run inside a step
fails on its own: it is logged and retried next pass while the rest proceeds;
this includes failures reading an individual Run before its reconciliation.
Stuck-job reclaim failing does not skip the lifecycle replay. A pass still
running after ten minutes is reported once in the server log with the last
completed pass; it is not abandoned or raced, so no second pass starts beside
a hung one. A hung database call still holds that pass (no statement timeout
is imposed on recovery). Sources settlement callbacks
project only the named Run's terminal result; deadline cancellation runs in
the ordinary read/tick path outside finalization ownership.

Runs in `waiting_for_review` have explicit human controls: `POST /resume`
requeues after approval (`same_attempt` for an in-flight policy pause,
`new_attempt` for a Supervisor terminal hold) and `POST /abandon` records a
cancelled terminal outcome after review. There is no implicit automatic resume.
Who may issue these and the other Run commands is one rule, stated with the
API in [EXECUTION_MODEL.md](EXECUTION_MODEL.md).

CLI cancellation is two-phase: the Run enters `cancelling`, the control plane
asks the host daemon to terminate the process group, and the Run is marked
`cancelled` only after the daemon confirms exit; otherwise it stays
`cancelling` with a `cancel_confirmation_timeout` result. The cancel signals
are the daemon's (ADR 0016). `RunExecutionControl` owns this protocol for user
cancellation, explicit deadlines and lost-worker recovery. An empty local
process registry is not proof that a persisted Host launch exited. Persisted
`cancelling` intent with no live job is re-enqueued through the canonical queue,
so a request-process crash does not lose the stop obligation.
No CLI process runs in the server. On worker
startup, stale preparation without a recorded Host launch can be recovered
directly. A dispatched attempt is recovered by its reclaimed `agent_run` job:
after acquiring the abandoned execution lock, it sends a forced stop naming
the persisted `launch_id` and waits for that Host's matching `complete`.
Only then does the Run become `orphaned` and pass through the existing
Supervisor, or `cancelled` if a person had already stopped it. An offline Host
or missing confirmation defers the job without consuming its retry budget;
even an exhausted job retains a reconciliation claim to stop its old process.
Recovery failure events carry the interrupted attempt number, so a delayed
recovery cannot add its error evidence to a successor attempt.
Recovery never rebinds a running Run as queued work. A daemon attempt has no default run
deadline and no no-output watchdog: prolonged silence records one
informational `run_quiet` status event and the attempt keeps running until it
finishes, is stopped, loses its host connection, or reaches an explicitly set
time limit — the contract's `max_duration_seconds` or the dispatch's
`timeout_ms` — which stops it through the normal stop path and fails it with
the non-retryable `run_timed_out` (`modules/hosts.md`, "no default whole-run
time budget").

`manual_review` and `model_judge` return `skipped`. A skipped result cannot
make a run pass. Do not implement `model_judge` with the same model that
generated the output. Root and integration verification are implemented by the
Plan graph layer.

The runtime registry exposes `AgentRuntimeDefinition`s for selectable ACP
runtimes. One `AcpRuntimeAdapter` and `AcpController` implement Agent execution;
runtime definitions provide command, installation, backend and capability
facts. Static runtime capability declarations are not dynamic conformance
evidence. The Host-daemon path does not apply a vendor subagent-deny
declaration, so local CLI candidates stay at low
effective trust. Do not treat a static declaration as that control.

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
new interactive grant. A scheduled recovery task cancels an autonomous
Run that remains `waiting_for_review` beyond one hour.

## Run model config (`resolved_model`)

`RunOut.resolved_model` is a safe read projection of the selected Profile's
backend/model and whether the runtime definition consumes model configuration.
It does not imply that a native runtime exposes its account's actual model.
`runs.runtime_profile_id`, `runtime_key` and
`runtime_profile_snapshot_json` preserve the selected deployment authority;
AgentVersion is never a model/runtime fallback. A daemon resolves the selected
Profile backend at launch. Provider-backed OpenCode receives the explicitly
selected model through its short-lived proxy configuration; native runtimes
use their Host-local account/configuration. ProviderTask Runs record their
bounded invocation separately and have no Agent runtime model projection.

Conversation text deltas are ephemeral transport events. The server keeps a
bounded, five-minute in-process replay buffer so an SSE subscriber that connects
after a queued Run starts can catch up before the durable assistant message is
available. This transport assumes the official single-server deployment: a
multi-server or separately deployed worker topology must replace the process
local bus with shared pub/sub while preserving the same `chat.text_delta`
contract. The durable message remains the canonical conversation record.

`RunOut.model_selection` and the status/Turn projections additionally expose
requested ACP selection and runtime-reported identity separately. The shared
ACP controller reports the current model only after option application, then
persists subsequent model updates. A queued retry suppresses its previous
attempt's observation; dispatch clears it before opening ACP. Missing reports
and `default` remain unknown rather than being inferred from the selected
Profile or requested alias. The Turn stream updates this metadata through
`turn.model_changed` without replacing in-flight text.

## ModelProvider secrets

Provider API keys are write-only on the API. Storage uses `Credential.secret_ref` with scheme `model_provider_api_key:v1:` (encrypted payload + nonce). Runtime credential resolution decrypts via `Credential.secret_ref` through the canonical `runtimes.credentials` boundary. `ModelProvider.credential_id` is the single source of truth for provider API keys.

## Shared web Run actions

`apps/web/src/modules/runs/useRunActions.ts` owns the web command adapter shared
by RunDetailPage and ConversationRunControls: resume, abandon, and exact
pending authorization decisions. ConversationRunControls also uses its stop
command; RunDetailPage does not add a stop button. It accepts the source Space and abort signal,
serializes a component's in-flight commands, discards responses after a Run/Space
change, and rereads the canonical Run before refreshing its caller. If only that
reread (or the caller refresh) fails, the command still reports success and
exposes a separate `refreshError` note, so an applied command is not retried. Authorization
reconciliation remains server-owned and is never followed by a duplicate resume.
`hasRunAuthorizationPause` is the shared UI distinction between that hold and a
Run review; server command authorization remains authoritative. `useRun` keeps
its existing status polling with an optional explicit Space and cancels reads
when that scope changes. Reloading the same Run keeps the loaded page visible
while refetching; only Run/Space changes clear it. Combined request signals use
the listener-based `lib/mergeAbortSignals.ts` for older browser targets. There is no new Run state classifier or polling engine.

Completed Run commands abort their local controller after delivering the canonical
Run and clearing busy state; this releases listeners on the shared panel signal.

Known scope limit: RunDetailPage's ContentAccessControl and PersonalContextPanel
subtrees, plus evolutionApi.previewWorkflowFromRun/saveWorkflowFromRun, still use
the API's global Space default. The current page's scope is the URL's current
Space, so those calls agree today. Embedding this detail subtree for a Run from
a different Space would first require scoping these consumers. This is a
prerequisite for any such stage 4 integration, not an implemented embedded view.

Agent Work embeds only scoped ConversationTurn/ConversationRunControls, not the
standalone RunDetailPage subtree described above. Expanded members read their
canonical Run and Turn in the source Space, and shared useRunActions handles
stop/resume/abandon and authorization decisions followed by a canonical reread.
Workbench controls filter UI eligibility by source membership and Run standing;
Task/Proposal lifecycle changes remain linked to their existing owning pages.
The attention DTO adds optional bounded Agent label, runtime key and start time
from existing Run facts; it adds no state machine or database columns.

## Conversation previews

`GET /api/v1/runs/{runId}/file-preview?path=...` resolves an authorized primary
workspace file into a Files & Code destination, or returns bounded published
Run output text/raster bytes for an in-page preview. Run and artifact bodies
must be readable now; no arbitrary host pathname is served. See
[Conversation file previews](CONVERSATION.md#file-links-and-temporary-previews).


### Headless domain work surface

A headless Sources goal explore/repair Run with domain grants and no `task.report` receives a domain work
skill listing its actual grants. It is not instructed to call unavailable Task
or Artifact actions. Conversation turns and Task Runs retain their existing
work skill. This changes the bound Run context, not Room sibling admission,
Conversation locking, Host workspace leases or collaboration budgets. Sources
goal Runs use this path through the same Profile/router/dispatcher.

This headless variant is restricted to the Sources goal explore/repair contract;
an unrelated headless Run without Task reporting does not select it. Its rendered
skill retains the normal `name`/`description` frontmatter.

Sources collection Runs use ordinary ACP launch and the existing Run-scoped
system-action transport. Only `source.material.submit` is granted;
the bound Work Skill describes its strict fields and finite same-Run corrections.
No overlay/CLI hash handshake or search-only Host permission claim is made.
Submissions are Agent-provided, not independently verified. Final model output
and native tool events cannot replace the action. Selected Profile/model/mode,
cost/consent admission, deadline/cancellation and Source authority are rechecked;
accepted results use the existing materializer and cursor transaction. See
[SOURCE_GOALS](SOURCE_GOALS.md#selected-agent-assisted-search) for provenance,
reference-only retention, manual Reading and ongoing collection semantics.
