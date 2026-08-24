# System Actions, Dispatcher, and Agent Tool Surfaces

## Purpose and source of truth

System actions are the typed inventory of application capabilities that may be
exposed through HTTP, managed-agent tools, internal jobs, or server-only calls.
They do not replace policy actions: a system action describes what can be
invoked, while its `policy_action` identifies the mandatory enforcement gate.

The canonical definition list is `SYSTEM_ACTION_REGISTRY` in
`packages/protocol/src/systemActions.ts`. Server loading and semantic
validation live in `server/src/modules/systemActions/registry.ts`.
`POLICY_ACTION_REGISTRY` in `packages/protocol/src/policy.ts` remains the
canonical policy vocabulary.

Every system action declares:

- stable dotted id and version;
- visibility (`internal_only`, `agent_tool`, `public_api`, `external_mcp`, or
  `system_job`);
- allowed actor types;
- input/output Zod schemas;
- owning module and application-service boundary;
- policy action, side-effect class, idempotency requirement, proposal type,
  and whether advance approval grants may apply;
- Agent-tool surface (`generic`, `retrieval`, `delegation`, or `research`) and
  policy adapter (`declared_resource`, `retrieval`, or `agent_delegate`) when
  the action is Agent-callable.

There are currently no public `external_mcp` actions. The private Run-scoped
MCP transport is not a public registration surface and does not change action
visibility.

## Dispatch boundary

Three layers, each owning exactly one concern (action authority consolidation
plan):

- **`SystemActionGateway`** (`systemActions/gateway.ts`) is the actor-neutral
  core: registry lookup, actor and visibility checks, idempotency validation,
  input validation, policy enforcement, executor lookup, and output
  validation, in that order. Unknown actions, missing executors, unsupported
  actor/visibility combinations, missing idempotency keys, invalid schemas,
  and denied policy decisions fail closed. It knows nothing about Runs, grants,
  or transports.
- **`SystemActionDispatcher`** (`systemActions/systemActionDispatcher.ts`) is
  the run-scoped layer every Agent-facing entry point actually calls. Given a
  `RunRecord` and a request, it computes the Run's tool grants, builds the
  gateway's executor map (via `registerModuleSystemActionExecutors` /
  `executorRegistry.ts`, one registration function per owning module) and
  policy enforcer, and normalizes gateway results/errors into one structured
  tool-call shape. `dispatch()` and `listGrantedDefinitions()` are its call
  surface; `ManagedAgentToolSurface` also reads its already-resolved
  retrieval/delegation/generic/research bindings directly to assemble the
  managed loop's tool set. The CLI MCP transport and the managed loop both
  call `dispatch`/`listGrantedDefinitions` directly and neither recomputes
  grants or re-runs policy itself. Runtime delegation
  materialization (Path B, below) is the one deliberate exception: it runs
  after the Run has already terminated, when a run-scoped in-flight dispatch
  is no longer meaningful, so it does not call `SystemActionDispatcher` at
  all — it independently checks the same grant snapshot and shares the
  schema and audit-event shape, but its own code is the dispatch path for
  that one case.
- **`ManagedAgentToolSurface`** (`systemActions/managedAgentToolSurface.ts`)
  is managed-loop-only: it constructs a `SystemActionDispatcher`, assembles
  the retrieval/delegation/generic/research tool contributions it exposes,
  and drives `executeManagedToolLoop`. It owns no dispatch or grant logic of
  its own.

HTTP routes continue to call their owning application services and
`PolicyGateway` enforcement points directly; they do not go through
`SystemActionDispatcher`. Server jobs may use internal/system-job actions.

Local CLI Runs reach `SystemActionDispatcher` through a Run-scoped MCP
transport (`runs/cliToolTransport.ts`'s `CliAgentToolTransport`, mounted by
the JSON-RPC route in `runs/routes.ts`). The server issues an opaque,
in-memory, short-lived identity only for the executing Run, exposes
`initialize`, `tools/list`, and `tools/call`, and revokes the identity when
the CLI exits. The route (`runs/routes.ts`) reloads the Run and rejects
unless it is `running`; the transport (`cliToolTransport.ts`'s
`assertActive()`) repeats that same check before every `list`/`call`, then
only builds a dispatcher and forwards to it — neither adapter computes tool
permissions itself, that intersection is `SystemActionDispatcher`'s grant
computation. It never gives the CLI database credentials or an internal
service token.

Run creation computes that intersection from the Run's declared
`capabilities_json`, its immutable AgentVersion
`tool_permissions_json.allowed_tools`, and the agent-tool-visible entries in
`SYSTEM_ACTION_REGISTRY`. The result is persisted once in
`runs.permission_snapshot_json.tool_grants`; an unknown, undeclared, or
unpermitted action is absent. This snapshot controls CLI tool exposure, while
the normal call-time PolicyGateway decision remains mandatory and authoritative.
`authorization.request` is the sole built-in companion to capability
intersection: a Run receives it only when that intersection exposes at least
one other Agent tool, so an Agent can reference a denial from a tool it could
actually call. Tool-free Runs remain tool-free (including network-isolated
Docker CLI execution). The action does not grant authority; it can only create
a bounded `authorization_requests` row.

Codex, Claude Code, and OpenCode receive generated sandbox-only MCP
configuration. Side-effecting calls use the MCP JSON-RPC request id as the
canonical tool-call/idempotency key. Network-isolated one-shot Docker execution
fails closed when a Run requests tools because it cannot reach the loopback
broker.

## Declarative policy resources and derived schemas

Most actions need no hand-written `if (definition.id === ...)` branch in
`SystemActionDispatcher`'s policy enforcer. A definition instead declares its
`policy_adapter` and, for the generic adapter, carries an optional
`policy_resource` (`SystemActionPolicyResource`,
`packages/protocol/src/systemActions.ts`):
`{resource_type?, resource_id_input_field?, resource_id_fallback: "run" |
"project_or_run", check_action_approval_grant}`. The generic adapter
(`enforceDeclaredResourcePolicy` / `resolveDeclaredResourceId`) reads
`resource_type` (or falls back to the action's own `owning_module`), reads
`resource_id` from the named input field when present or falls back per
`resource_id_fallback`, and consults `ActionApprovalGrantService` only when
`check_action_approval_grant` is true. This is the single place resource
resolution and grant-checking happen; adding an action with ordinary
resource-scoped policy is a data change to its definition, not a new code
branch.

Retrieval and `agent.delegate` are the declared custom adapters: they carry no
`policy_resource` and keep explicit adapter metadata, because their
enforcement genuinely differs (domain enablement; group budget and lineage)
rather than fitting the resource_type/resource_id/grant shape. An action
without either a `policy_resource` or a recognized custom adapter is denied.

Every registry-validated input schema is derived from one Zod authority, never
hand-maintained twice: `systemActionInputJsonSchema()`
(`packages/protocol/src/systemActions.ts`) converts a definition's
`input_schema` to Draft-7 JSON Schema (`zod-to-json-schema`, `$refStrategy:
"none"`, `$schema` stripped) for a generic tool/binding, and this is what
every ordinary generic action's model-visible schema comes from.
`agent.wait_for_results` follows the same authority rule: its registry and
dispatch schema is `AgentWaitForResultsInputSchema`, and
`agentWaitForResultsToolDefinition()` derives the model-facing JSON Schema
from it before adding descriptions and dynamic room context.

Dynamic tool presentation has two bounded exceptions:

- **Retrieval's eight actions** keep `objectInput` in the registry — a
  permissive placeholder, not the real authority — because the real schema is
  generated per binding at runtime from the binding's settings snapshot
  (`runs/managedRetrievalTools.ts`'s `retrievalToolInputSchema`), so it
  cannot be a static Zod at the definition at all.
- **`agent.delegate`** does have a real static registry Zod
  (`RuntimeDelegationOutputItemSchema`, shared with Path B's structured
  output validation, D8), but its hand-written tool definition
  (`agentDelegateToolDefinition()`, same file) exists because the
  model-facing schema needs a `target_agent_id` enum populated from that
  Run's live room roster — a per-request enrichment
  `systemActionInputJsonSchema()` cannot express from a static definition.
  `SystemActionGateway` still validates the actual call against the shared
  Zod at dispatch time; only the tool-definition JSON Schema shown to the
  model is hand-built.

## Managed-agent exposure

`SystemActionDispatcher` composes retrieval, delegation, and enabled generic
actions for a managed run; `ManagedAgentToolSurface` assembles those into the
managed loop's tool set. Exposure requires all of:

1. registry visibility includes `agent_tool` and actor type includes `agent`;
2. the action is present in `runs.capabilities_json` **and** permitted by the
   run's allowance — normally the immutable AgentVersion
   `tool_permissions_json.allowed_tools`, or a scenario allowance where the
   capability belongs to the place the Run was opened in rather than to the
   Agent (see below);
3. a call-time PolicyGateway decision allows the registered policy action.

### Scenario tool allowances

`buildRunToolGrants` intersects what a Run declares with what it is allowed,
and fails closed when the allowance is missing or malformed. That allowance
normally comes from the AgentVersion, which models a tool as a property of the
Agent. Some capabilities are properties of a *place* instead:
`modules/systemActions/scenarioToolAllowance.ts` declares
`ROOM_CONVERSATION_TOOL_ALLOWANCE`, the actions an Agent may use because it was
spoken to in a Room, and `RunCreateInput.scenario_tool_allowance` supplies it
in place of the AgentVersion's for exactly those Runs.

This is a change of scope, not of strength: the intersection is unchanged, an
action outside the list is still denied, and the Run must still declare it.
Most of the allowance is proposal-gated (`project.propose_definition`,
`inquiry.propose_thread`, `inquiry.record_conclusion`,
`inquiry.promote_knowledge`); `agent.delegate` and `research.start_acquisition`
(room-advancement-reliability-plan Phase 4) are the two directly-executed
exceptions — durable actions guarded by idempotency rather than a human
accept/reject step, because delegating a specialist investigation and
starting a tracked research acquisition are both execution on an
already-accepted Thread, not the agent-drafted structure/content write ADR
0003 gates. It exists because a Room's roster
is fixed at creation and no product surface edits `tool_permissions_json` at
all, so binding Room conversation to Agent permissions means a Room built
around a differently configured Agent silently does nothing, with nowhere for
the user to see why. Non-Room agent groups keep the AgentVersion allowance
unchanged.

The allowance is also written to the Run's `capabilities_json`, because the
declaration side of the intersection has to be satisfied too. That field is
overloaded and the coupling is load-bearing in two directions worth knowing
about:

- `explicitRetrievalToolDomainsFromRun` (`runs/managedRetrievalTools.ts`)
  treats a retrieval action id in `capabilities_json` as the *enablement
  switch* for that retrieval domain. **No retrieval action may be added to a
  scenario allowance without solving viewer scope first**: retrieval runs
  under `instructed_by_user_id` — the message sender, whose reads include
  their own `private` content — while the Room reply is visible to every Room
  member, so granting it would let one member's private material be surfaced
  into a shared conversation by asking a question.
- `capabilityIdsForRun` selects runtime-skill bindings from the same field, so
  a Run carrying a scenario allowance selects bindings keyed on these action
  ids rather than the AgentVersion's own capability list. Inert today (nothing
  writes `agent_versions.capabilities_json` either), but it is why the two
  concerns should be separated if either grows.

The allowance and its resulting grants are persisted together in
`permission_snapshot_json`. Production execution binds queued Runs to their
effective Work Context before starting them; `bindRunToWorkContext` preserves
the snapshotted scenario allowance while recomputing the intersection, rather
than silently reverting a Room Run to the AgentVersion allowance.

The Inquiry proposal executors also preserve the Room Run's visibility. A
`selected_users` Run produces a `selected_users` Proposal and copies the
Run's active grants in the same transaction. Knowledge promotion keeps its
intermediate Candidate private to the instructing user; the reviewable
Proposal is the Room-visible shared result. This is the direct-executor
equivalent of Run materialization's derived-output clamp (B8A).

The currently enabled generic write-capable tools are proposal-only:
`source.channel.propose_activation`, `project.source.propose_bind`,
`project.propose_definition`, `source.backfill.propose_start`, `task.plan.propose`,
`inquiry.propose_thread`, `inquiry.record_conclusion`, and
`inquiry.promote_knowledge` (plus
`authorization.request`, which is not itself proposal-shaped). They receive
the run's space, agent, instructed user, run, and Project scope. Project-only
actions reject an unscoped run; backfill proposal lookup also proves the plan
belongs to that Project. Agents do not receive direct activation, proposal-apply,
grant-management, credential, deployment, or memory-write actions.
`research.start_acquisition` is the one durable exception in the Room
allowance to this proposal-only shape (see below).

`inquiry.propose_thread`, `inquiry.record_conclusion`, and
`inquiry.promote_knowledge` (plan:
`.agent/plans/project-conversational-advancement-plan.md`, Phase A) let a
Room-dispatched agent draft a new Inquiry Thread, draft an Inquiry Thread
conclusion, or promote a concluded round to Knowledge, as a single reviewable
Proposal the user accepts inline in the Room. `inquiry.propose_thread` creates
the canonical Thread only after acceptance, under the accepting user's Project
writer identity. `inquiry.record_conclusion`'s applier calls
`InquiryIterationService.recordIteration` under the *accepting* user's
identity at accept time — a second legitimate `trigger_kind` for the same
write authority a direct user edit already uses, not a bypass of it.
`inquiry.promote_knowledge` combines `KnowledgePromotionCandidateService
.createFromThread` and an immediate `decideCandidate({decision:"promote"})`
into one call so a conversational instruction produces one Proposal instead of
a Candidate stranded pending a second manual visit to Knowledge Review; the
two-hop Candidate design is unchanged for the manual review path.

`project.propose_definition` is the Room action for formal Project
initialization. It drafts a complete next Brief version (preserving omitted
fields from the active Brief); accepting the owner-review Proposal creates,
reviews, publishes, and activates that immutable version through
`ProjectKernelService`. An Inquiry Thread is downstream work and is not used as
the Project-initialization marker.

These tools have concrete Zod input contracts and matching model-visible
JSON schemas. Missing connection, plan, or required connection-draft fields are
rejected before policy enforcement or executor dispatch.

Retrieval and delegation retain their domain-specific policy adapters behind
the gateway. An action without a canonical policy adapter is denied. Tool-call
failures are returned as structured tool results so one denied action does not
silently become an ungoverned execution path.

## Audit and idempotency

Managed action dispatch emits best-effort RunEvents `action_invoked` and
`action_completed`. Completion metadata includes the safe action summary and
PolicyDecisionRecord id; failures use `action_completed` with `ok=false` and a
safe error code. RunEvent persistence failure does not roll back or block an
action. The fail-closed audit boundary is PolicyGateway decision-record
persistence according to the policy action's `record_failure_mode`.

Path B runtime delegation materialization follows the same audit contract. An
admitted spawn emits the invocation/completion pair; a post-terminal grant
refusal emits a completed `delegation_not_granted` denial event because there
is no live tool-response channel. These events remain best-effort and never
turn a missing audit row into permission to spawn.

Side-effecting definitions require an idempotency key. Managed calls use the
canonical tool-call id. Proposal-producing services additionally persist
`created_by_run_id` plus `action_idempotency_key`, so replay returns the same
proposal rather than duplicating a draft or mutation.

## Proposal and approval-grant boundary

Agent-initiated durable source changes always create a normal proposal first.
`ProposalApplyService` is the only apply boundary and reruns `proposal.apply`
policy and domain authorization in the apply transaction.

`action_approval_grants` are human-created, revocable advance approvals scoped
to space, agent, action, and optional Project/resource, with expiry and optional
use limit. A matching grant may cause the just-created agent proposal to be
accepted immediately through the same apply service; it records the grant as
the approval source and increments usage atomically. Expired, revoked,
exhausted, or scope/payload/type-mismatched grants leave the proposal pending.

Only registry actions marked `grantable` can use this path. Grant create/revoke
are user-only public actions and are not agent tools. Proposal apply, memory
writes, credentials, policy override, and deployment remain fresh-human-review
boundaries.

## Authorization requests after deny

A denied Agent tool result carries its sanitized
`policy_decision_record_id`. The Agent may call `authorization.request` with
that id and a bounded, secret-redacted reason. Request creation and the
executing Run's transition to `waiting_for_review` commit together. The server
proves that the decision is the built-in
`managed_system_action_grant_required` deny, belongs to the same Space,
active Run, and Agent, and names the exact registry action in its audited
metadata. Only registry actions marked `grantable` are requestable. A Space
owner's approval is fulfilled through a one-use, one-hour
`ActionApprovalGrant` scoped to that Agent, action, and Run.

Hard-invariant, Space-boundary, credential, unknown-action, non-grantable,
proposal-apply, deployment, and policy-override denials cannot create a
request. Approval never edits a PolicyDecisionRecord. A grantable action still
re-enters the normal SystemActionGateway and proposal-apply path; the grant
cannot override a hard-invariant decision, and its use is consumed atomically
only by the proposal apply transaction.

The decision and an `authorization_request_reconcile` job commit together.
While the old execution lock remains held, the reconciler durably returns its
Job to `pending` with a bounded future `scheduled_at` and restores the claim's
attempt budget instead of burning attempts in the worker loop. After release,
approval requeues the same Run exactly once; rejection uses canonical Run
cancellation and its chat, materialization, Room, and AgentGroup finalizers.
The generic Run resume endpoint cannot resume an authorization-request pause.

## Current source and Project actions

The registry covers recipe planning/creation/dry-run/activation, connection
create/update/propose/activate, Project binding/proposal actions,
ProjectOperation read/create/status changes, history-import preview/plan/
proposal/pause/resume, and internal approved backfill start. Sources owns
connection and history-import execution state; Projects owns binding,
operation, and corpus state.

Room is not a second execution pipeline. A message creates a canonical
collaboration task and queued Runs. Tool calls remain registry- and
policy-gated. Each Room Run declares a `conversation_capture` Run Exchange
output as a closing backstop; its structured changes become pending proposals
through the same proposal creation policy path and never apply directly.

## Object-bound actions

`SystemActionDefinition.applies_to` names the ontology object types an action
operates on. Most of the registry is not object-bound — connection creation,
backfill start, `authorization.request` — so the field is optional and its
absence is meaningful rather than an omission (ADR 0012 decision 8).

The first three are Note actions: `note.promote_to_knowledge`,
`note.raise_as_question`, and `note.link_to_evidence`. A surface rendering an
object asks `systemActionsForObjectType()` what it can offer instead of
hard-coding a menu; the note editor's selection bar is the first caller and
derives both which items exist and their order from the registry. Only the
wording stays in the client — the registry's `title` is descriptive prose for
audit and policy surfaces, not a toolbar label — and its label map is typed on
`NoteSystemActionId`, so registering a fourth Note action fails the web build
until it has one.

All three are **`public_api` only, `allowed_actor_types: ["user"]`**. ADR 0012
decision 8 deferred the binding half partly because registering object actions
would mean "widening the agent's callable surface" — that does not happen here,
because the agent tool gateway admits a definition only when it is `agent_tool`
visible *and* lists `agent` as an actor. Making any of them agent-callable is a
separate product decision; `server/test/noteObjectActions.test.ts` fails if one
silently becomes so.

Their side effects follow the governance each target already has:
`note.promote_to_knowledge` is `proposal` (promotion changes nothing about the
knowledge review gate), while the other two are `durable` direct writes —
Thread structure stays direct and a `note_link` is navigational with no graph
authority (B12A).

Two of the policy actions they name — `inquiry.thread.create` and
`note.link.create` — are **`reserved`**, meaning declared and not evaluated by
any code path. They were introduced alongside the actions and first marked
`wired_direct` on the grounds that they made the operation auditable. They do
not: enforcement is the route's own Project ACL and note read gate, and who
performed the write is already on the canonical row
(`space_objects.created_by_user_id`, `note_links.created_by_user_id`), so a
policy audit record would restate it. Wiring them is a decision still to be
made; `reserved` is what the registry's own vocabulary calls that state.
Reserved declarations default to `deny`; descriptive registration never grants
authority before an enforcement point is deliberately wired.

Standing Project Research adds one Source action,
`source.raise_as_question`. A `new_direction` comparison stores this action id
and its typed input on a non-executing advice card. The browser invokes the
ordinary `InquiryThreadService.createThread` path only after a user clicks;
the engine never creates a Thread itself. The input carries a producer
idempotency key, persisted under the Project on `inquiry_threads`, so browser
retries return the same Thread and a conflicting replay fails closed.

## `research.start_acquisition` (room-advancement-reliability-plan Phase 4)

The Room's other research-execution tool alongside `agent.delegate`: given an
accepted Inquiry Thread, it enqueues a background job
(`research_pipeline_start`) that runs question assessment (reusing an
existing passing assessment session when one exists) → `AdaptiveQueryOrchestrator
.evaluate` → `ResearchMonitorMaterializer.materialize` (source-channel
materialization plus strategy activation in one call) →
`ProjectResearchOrchestrator.startInitialIntake`. Providers, candidate budget,
and execution model are server-derived defaults, not caller-supplied — the
action's only input is `thread_id` (plus an optional `intent_note`);
auto-selecting these per invocation is a recorded follow-up
(`.agent/plans/backlog.md` R1.2), not this phase. The Manager Agent chooses
between `agent.delegate` (an ad hoc specialist investigation) and this action
(a tracked, monitored acquisition Workflow) from context; the two are not
mutually exclusive and no server code intercepts a phrasing to force one.

Idempotency is layered: a pending/running pipeline job for the Thread is a
no-op, and each pipeline stage checks persisted state before redoing it (an
assessment session already passed, a strategy already materialized) so a
retry after a mid-pipeline failure resumes rather than restarts. A second,
fully-identical invocation coalesces onto the same Operation through
`startInitialIntake`'s own idempotency-key fingerprint match; a *different*
concurrent start on an already-active workflow surfaces as a reported stage
failure instead of a duplicate Operation.

Completion reports back through the `ConversationContinuationRegistry` event
side (Phase 3): `research_pipeline_outcome` (keyed by thread id) covers
acquisition started, the question failing its FINER assessment (a first-class
outcome relayed to the user for question refinement, not an error), and a
stage failure; `research_workflow_terminal` (keyed by operation id) covers
the Operation's own later failure, posted from
`ProjectResearchOrchestrator.failOperation`. The Operation's Room origin is a
loose `origin_room_id`/`origin_session_id` pair written into
`project_operations.progress_json` at intake time (the established
non-FK-cross-domain-identifier pattern; `progress_json->>'workflow_id'`
already carries a unique index this way) — terminal paths that find it
notify the Room, paths that do not (every non-Room-originated research flow)
stay silent. `research_workflow_terminal`'s `completed` and `waiting_review`
(checkpoint pause) variants are not wired yet: the operations that reach
`completed` status or create a checkpoint do so from the
`screeningCoordinator`/`synthesisCoordinator`/`monitoringCoordinator`
pipeline stages, which are deliberately built behind a `ports` abstraction
with no `ServerConfig`/Room dependency, unlike `failOperation`
(a `ProjectResearchOrchestrator` method with `this.config` already in scope).
Wiring those two variants means extending those ports, not adding another
one-line hook, and is scoped to the checkpoint-reform follow-up
(`.agent/plans/backlog.md` R1.1) rather than this phase. Until then, a
Room-started acquisition that reaches a checkpoint stalls silently from the
Room's perspective; the user still sees and can act on it from the web UI's
Operation surface.

## Invariants

- Registry absence, policy-adapter absence, or unknown action means deny.
- An `applies_to` entry must name a registered ontology entity.
- Visibility metadata is an exposure ceiling, never authorization by itself.
- Agents create proposals; they do not apply them directly.
- A grant never changes the proposal payload or bypasses apply-time checks.
- Credentials are resolved by their owning service and never accepted as tool
  payload secrets.
- `external_mcp` remains empty until separately designed.
- RunEvent/action audit metadata contains no prompts, credentials, raw source
  content, stdout, or stderr.
- A new Agent entry point is a thin adapter over `SystemActionDispatcher`
  (`.agent/BOUNDARIES.md` B66): it may translate transport shapes and choose
  which actions to expose, but must not itself decide grants, evaluate
  policy, or mutate a domain table.
- Deterministic system projections stay outside this path. The shared
  Run-terminal → Task-status projector
  (`.agent/architecture/DATA_AUTHORITY_MATRIX.md`) is automatic domain
  bookkeeping with a single owning projector, not an agent-authorized action;
  it must not be reimplemented as, or routed through, a system action.
