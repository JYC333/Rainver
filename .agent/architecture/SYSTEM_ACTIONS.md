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

There are currently no public `external_mcp` actions, and no MCP surface at
all: the Run-scoped one this repository used to mount was deleted with the
`rainver` command that replaced it. `external_mcp` stays in the enum because
its trigger is real and recorded — an external MCP client becoming a
requirement, which is a different question from how Rainver's own dispatched
agents call back.

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
  managed loop's tool set. The CLI tool surface and the managed loop both
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

Local CLI Runs reach `SystemActionDispatcher` through a Run-scoped REST
surface: `GET /internal/runs/:runId/tools`, `GET
/internal/runs/:runId/tools/:actionId` and `POST
/internal/runs/:runId/tools/:actionId` (`runs/routes.ts`), in front of
`runs/cliToolTransport.ts`'s `CliAgentToolTransport`. The agent calls them
with the `rainver` command (`packages/agent-cli`), which the executing side
puts in front of it — the host daemon on a paired machine, the server for a
sandboxed Run — as an absolute path in `RAINVER_CLI`, never on `PATH`
(ADR 0016 §6). The command is a pass-through (`list`, `describe`, `call`):
action names and input schemas come from the server at run time, so a new
System Action needs nothing added to it.

The identity is a `run_tool_identities` row: a bearer token stored only as a
digest, issued for one Run, matched against the Run id rather than trusted
from the token, expiring, and revoked when the Run stops. Durable rather than
in-process because the caller outlives the process — a remote Run's CLI keeps
working across a server restart. The route reloads the Run and rejects unless
it is `running`; the transport (`assertActive()`) repeats that check before
every `list`/`call`, then only builds a dispatcher and forwards to it —
neither computes tool permissions itself, that intersection is
`SystemActionDispatcher`'s grant computation. The CLI never receives database
credentials or an internal service token.

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

**Delivery carries no runtime name.** A Run is given a handful of environment
variables and the files behind them — the command, reachable at `RAINVER_CLI`
(the daemon resolves its own copy and generates a launcher; the server, whose
sandbox mounts nothing of its own, stages the file itself), the Rainver Work
Skill
(`capabilities/workSkill.ts`, rendered from `systemActions/conversationPolicy.ts`
constants the conversational surfaces share),
and a pointer to the Skill appended to the prompt the runtime is actually
sent. There is no per-vendor branch anywhere in that path, which is what the
three generated MCP configuration files it replaced each required. A newly
registered ACP agent needs nothing added.

Side-effecting calls use the caller's `Idempotency-Key` header as the
canonical tool-call/idempotency key; a caller that sends none gets a fresh one
per request rather than a constant, so a second call of the same action in one
attempt is not swallowed by the event writer. Network-isolated one-shot Docker
execution fails closed when a Run requests tools because it cannot reach the
server.

There are two delivery sites, one per execution host kind, and they differ
only in where the files land: the daemon writes them into the Run's own
directory under its config root and removes them with the Run
(`packages/host-daemon/src/execution.ts`); the server writes them into the
Run's isolated HOME, which the sandbox runner mounts at `/home/sandbox`
(`runs/sandboxWorkSurface.ts`). Neither writes into the workspace — on the
server host a staged directory there would be collected as an untracked change
in the Run's own code patch, and on a paired machine the workspace is the
user's checkout.

`artifact.submit` is granted only on the remote-host path. It declares that a
file the Run leaves behind is a Task's output, and only that path applies a
declaration today (the executing host uploads its output directory and
`hosts/repository.ts` gives those files the declared type and Task link, which
is what lets settlement match `tasks.required_outputs_json`). A sandboxed
Run's artifacts come through `materializationService` instead, which does not
consume declarations, so the action is withheld rather than accepted and
ignored.

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
`modules/systemActions/scenarioToolAllowance.ts` declares two:
`CONVERSATION_TOOL_ALLOWANCE`, what an Agent may do because a person is
talking to it at all, and `ROOM_CONVERSATION_TOOL_ALLOWANCE`, that plus the
Project write surface an Agent may use because it was spoken to in a Room.
`RunCreateInput.scenario_tool_allowance` supplies the applicable one in place
of the AgentVersion's for every Run dispatched from a group message. A
delegated child spawned inside a group is not one of those: it carries no
declared capabilities and so no system-action grants at all.

This is a change of scope, not of strength: the intersection is unchanged, an
action outside the list is still denied, and the Run must still declare it.
The allowance also carries the four id-discovery reads (`inquiry.list_threads`,
`task.list`, `proposal.list_pending`, `research.list_operations`), without
which the id-taking actions below could only be called with a composed id —
see "Where an Agent gets an id".

Part of the allowance is proposal-gated (`project.propose_definition`,
`inquiry.promote_knowledge`); `inquiry.create_thread`,
`inquiry.record_conclusion`, `agent.delegate`, `research.start_acquisition`
(room-advancement-reliability-plan Phase 4), `research.cancel_acquisition`,
and `proposal.decide` (a person's decision on one of this conversation's own
proposals, carried by the Agent on the person's word in the person's own turn
— origin-gated, same-conversation only; see `modules/rooms.md`)
are the directly-executed exceptions — durable actions guarded
by idempotency rather than a human accept/reject step, because delegating a
specialist investigation, starting a tracked research acquisition, and
stopping one are all execution on an already-accepted Thread, not the
agent-drafted structure/content write ADR 0003 gates. Cancel is in the list so
a Room notification about running research always has a matching in-Room
action; a report the user can only act on by leaving for the web UI is the
interruption the reform removed, moved rather than deleted. It exists because a Room's roster
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

The proposal-shaped generic write tools are
`source.channel.propose_activation`, `project.source.propose_bind`,
`project.propose_definition`, `source.backfill.propose_start`, `task.plan.propose`,
and `inquiry.promote_knowledge` (plus
`authorization.request`, which is not itself proposal-shaped). They receive
the run's space, agent, instructed user, run, and Project scope. Project-only
actions reject an unscoped run; backfill proposal lookup also proves the plan
belongs to that Project. Agents do not receive direct activation, proposal-apply,
grant-management, credential, or deployment actions. They do receive the two
memory writes (`memory.remember`, `memory.revise`) — bounded rather than
withheld, on the terms ADR 0003 §2 sets and described below.

**Authorization follows cost, not authorship**
([ADR 0017](../decisions/0017-authorization-by-cost-not-authorship.md)). A
write waits for a person per instance when, and only when, it falls in one of
seven classes — self-modification, belief reach, real checkout, exposure,
money, credential or deployment, direction — and an action that registers as a
proposal names its class in the registry (`gate_class`, required by
`gatedProposalAction`; a protocol test asserts `side_effects === "proposal"`
and a non-null class imply each other). Nothing else is a proposal, because
"an Agent wrote it" is not a reason: under an Agent that advances work,
per-write approval degrades into a rubber stamp on exactly the writes that
matter, and one Room turn once produced six pending cards for a single
decomposition a person had asked for.

Every other Project-internal write is governed by two things instead. **The
trigger origin**: a write from a person's own turn (`manual`) executes, and a
write from any other origin — scheduled, automated, or a delegated child whose
root was unattended — is `require_approval` (`ruleUnattendedProjectWrite`,
covering `task.create`, `task.stage.advance`, `proposal.decide`,
`inquiry.thread.create`, `inquiry.iteration.record`, `inquiry.advice.adopt`
and `research.acquisition.start`). And **bounds set before the work runs**: at
most five Threads opened per turn (`THREAD_FAN_OUT_PER_TURN`, counted from the
Project's own event stream so a resumed Run cannot spend the budget twice),
and a bounded acquisition corpus. Refusing a bound costs a turn, not a
decision — the sixth question is opened in the next one.

The counterpart is review-after: every such write is in the Project's updates
with a one-click undo, and attention carries only what a person must decide
(see `PROJECT_WORK.md`). `task.report`, `task.handoff` and
`task.request_review` are ungated at any origin because they are append-only
or self-limiting — a report only records, a handoff can only give work away, a
review request can only stop work.

**What flipped, and what did not.** `inquiry.propose_thread` became
`inquiry.create_thread` and `inquiry.record_conclusion` became a direct write;
their proposal types, services, appliers and the per-proposal continuation
that had to count its own pending siblings are deleted. Still gated, each
naming its class: `inquiry.promote_knowledge` (exposure — it leaves the
Project for Space-level Knowledge), `project.propose_definition` (direction),
`source.channel.propose_activation` / `project.source.propose_bind` /
`source.backfill.propose_start` and `research_history_extend` (money).

`task.create` takes its Project from the Run, not the input, and re-checks
Project writer authority under the aggregate lock. The other four resolve their
Task through the content read predicate for the instructing user, so an Agent's
reach is that person's and never wider. See
[`PROJECT_WORK.md`](PROJECT_WORK.md) §8.

`inquiry.create_thread` and `inquiry.record_conclusion` let a Room-dispatched
agent open an Inquiry Thread and record its conclusion directly, bounded and
origin-gated; `inquiry.promote_knowledge` stays a reviewable Proposal the user
accepts inline in the Room, because promoting leaves the Project for
Space-level Knowledge. Both direct writes run under the instructing person's
Project writer identity, checked under the Project lock by the domain command
itself — `InquiryThreadService.createThread` and
`InquiryIterationService.recordIteration`, the same commands a person's own
edit uses, with `trigger_kind: "agent_conclusion"` marking who wrote it. The
Thread create is additionally bounded and deduped: at most
`THREAD_FAN_OUT_PER_TURN` per turn, counted under that same lock, and a
retried tool call reuses its Thread through
`producer_idempotency_key`, the sha256 of `<run id>:<tool call id>` — hashed
because the column is bounded at 128 characters and a composed id is not.
`memory.remember` and `memory.revise` are granted in *any* conversation with
a person, Room or not: the allowance splits into the Room's Project write
surface and `CONVERSATION_TOOL_ALLOWANCE`, which every group-dispatched Run
gets. Remembering what someone told you is a capability of talking with them —
what it writes is private to the speaker and touches no Project — so none of
the reasoning that binds the Project writes to a Room applies. (A group with
no Room previously declared no capabilities at all, so its Agent could call
nothing whatever its own permissions said.) They are the same shape applied to
memory
([ADR 0003](../decisions/0003-memory-proposal-flow.md)). Before them no Agent
could write memory from a conversation at all, so the person was not the
bottleneck on what it learned — nothing was. A write that stays `private`,
`normal`-sensitivity and about the person in the turn applies through
`PgMemoryApplyRepository.applyDirect` as a new version with
`created_by = agent:<id>`, `approved_by = null` and the run, session and
rationale in its provenance; one that would change reach — a wider
visibility, a higher sensitivity, or replacing what a person or another Agent
wrote — is turned into a `memory_create`/`memory_update` proposal by the
executor rather than returned as an error. Both are origin-gated
(`memory.write` is in `ORIGIN_GATED_PROJECT_WRITES`), both refuse without a
rationale, and writing more than `SERVER_MEMORY_DIRECT_WRITES_PER_SESSION`
entries within one session — or within one Run, where a conversation outside
a Room has no session — is paused with one `uncertain` attention item. An Agent version with
`memory_policy_json.requires_proposal` writes only by proposal — the first
place that flag is enforced rather than merely displayed.

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

## `inquiry.adopt_next_step`

Takes the next step the system already recorded for a Thread, on the user's
instruction, making the same two writes the Inquiry Area's Adopt button makes:
the Thread takes the recommended focus (`step_origin: "advice"`, attention
`focused`) and the advice row becomes `adopted`. It refuses anything that is
not currently open and current, so an already-taken or stale recommendation
cannot be adopted twice. Policy action `inquiry.advice.adopt` (low risk,
allow, audited); a proposal gate would have meant reviewing a suggestion the
system itself made.

It exists because the advice had nowhere to go. Written the moment a search
finishes (`tryQueueAdviceForWorkflowThread`, trigger `search_completed`), it
rendered only in the Inquiry Area's stage workspace for the one Thread you had
selected — so a finished four-hour search ended with the Project front page
silent about what to do next, and the Room's Agent inventing a question of its
own because it could not read the advice either. Three surfaces now carry it:
Project Attention (`inquiry_advice` items, stale ones omitted), the
`research_workflow_terminal` completed instruction (which relays the recorded
step and its reasoning and forbids substituting one of the Agent's own), and
this action for taking it without leaving the conversation.

## Where an Agent gets an id (id-discovery reads)

A conversation's rendered history carries no ids — `productionAcquisition.ts`
renders `role:\ncontent`, and the Room's Project-state block lists titles.
An id-taking action therefore has exactly one legitimate source for that id: a
read that returned it in the same turn. Every such action is paired with one:

| Read | Returns | Feeds |
| --- | --- | --- |
| `inquiry.list_threads` | `{thread_id, kind, statement, attention_state}` | `research.start_acquisition`, `inquiry.record_conclusion`, `inquiry.promote_knowledge` |
| `task.list` | `{task_id, title, status}` (optional `status` filter) | `task.report`, `task.handoff`, `task.advance_stage`, `task.request_review`, `task.plan.propose` |
| `proposal.list_pending` | `{proposal_id, proposal_type, title}` for *this conversation* | `proposal.decide` |
| `research.list_operations` | `{operation_id, title, status}` (`include_terminal` opt-in) | `research.cancel_acquisition` |

All four are `none`-side-effect reads scoped to the Run's own Project (and, for
proposals, its own conversation, matching `proposal.decide`'s reach), carry
low-risk allow policy actions (`inquiry.thread.list`, `task.list`,
`proposal.list`, `research.operation.list`), and read under the instructing
person's identity — so a helpful failure can never name an object that person
could not already see.

Three layers keep a composed id out of an action:

1. **The rule.** `IDENTIFIER_POLICY` heads the Room execution rules: an id is
   never remembered or derived; call the matching read and copy it verbatim,
   and if nothing matches, ask instead of sending a constructed id.
2. **The schema.** Every `*_id` input for an already-existing object carries a
   `.describe()` naming the read it comes from.
3. **The failure.** An unknown id answers with the ids that do exist
   (`… Use one of these ids exactly: <id> — <title>`), so the next call can
   correct itself. `task.*`, `proposal.decide`, `research.start_acquisition`
   and `research.cancel_acquisition` all do this.

The Room focus sentence carries `task_id:` alongside the title, so the Task a
person is looking at is addressable without a `task.list` round trip.

Action failures persist their reason: the dispatcher's `onFailed` writes
`error_message` onto the `action_completed` Run event (alongside
`error_code`), and `loadProjectChatActionPreviews` shows the message on the
failed card in preference to the code.

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

**Bounded before it runs.** The acquisition passes
`max_items: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT` (200). Unbounded — which is
what `history_mode: "all_available"` meant with no cap — one Room turn walked
a source's whole history, ingested 873 documents and put every one through an
LLM classification: hours of work and roughly a million input tokens, with no
confirmation asked and nothing on screen until the failure four hours later.
The history walk is newest-first and the item budget is operation-wide, so the
cap buys the most recent 200 matches and stops; earlier history stays
reachable as a decision rather than a default. The `started` outcome carries
`screening_cap` and `matched_estimate`, so the Room is told what this pass
reads *before* it runs — the cap first, the match size second and labelled as
an upper bound. `matched_estimate` is the *largest* single provider's recorded
hit count, not the sum: providers overlap heavily, and summing them announced
2,065 for a query whose corpus was 873, which read as the scope having grown
when it had just been capped.

**Scope is the caller's.** `max_items` and `since` are inputs on
`research.start_acquisition`, defaulting to the cap and to all available
history. "Only read the last year" and "500 is fine" are ordinary instructions
the Agent passes through, rather than a server constant nobody could reach —
`IDENTIFIER_POLICY` tells it to pass them when the user says how much, and
never to raise the cap on its own initiative.

**The rest is offered once, when it can be acted on.** A finished baseline
whose coverage does not reach the source's floor raises a pending
`research_history_extend` proposal (`researchHistoryExtendOffer.ts`), which
renders as an Accept/Reject card in the Room and as a Project attention row.
Accepting runs `startHistoricalBackfill` over the earlier range through the
applier — the same method the manual Extend-history path uses, so coverage
overlap, idempotency, and the Operation it produces are that method's
already. The offer is made at completion rather than at the start because
that is when there is a baseline to extend from; the start message already
says how much matched and how much this pass reads, so nothing about the size
waits for it. One standing offer per workflow. `startHistoricalBackfill` used
to refuse an `all_available` baseline outright as having nothing earlier to
reach; that stopped being true when the acquisition became bounded, so it now
refuses only coverage that already reaches the floor (and the front end's
`canExtendHistory` no longer tests the history mode's name either).

The same number bounds a daily incremental update, which answers differently:
it does not ask. `triggerIncremental` takes at most that many scanned items
into one update — backlog first — and leaves the remainder in the workflow's
`pending_incremental_source_item_ids`, which the next update drains, recording
`deferred_incremental_items` on the operation so a monitor falling behind is
visible. A cadence that runs daily drains its own backlog; a question nobody
is awake to answer would not.

The Thread's own statement is the authoritative question. Assessment
legitimately rewrites the question it plans queries from (translating or
narrowing it), so `resolveResearchThreadScope` no longer compares the
strategy's text with the Thread's — text equality rejected the pipeline's own
output and made `research.start_acquisition` unable to start once a single
word changed. It checks provenance instead: the strategy's research-context
version must belong to an assessment session for this Thread. A strategy built
for a *different* Question is still a 409.

A run that stops before `startInitialIntake` records the attempt as a
terminal `failed` research Operation (`progress_json.run_kind =
"acquisition_attempt"`, carrying the stage, reason and pipeline job id), so a
failure that produced no acquisition is still visible where the work is looked
for rather than living only in `jobs.result_json`. Every domain failure
reports its own message; there is no catch-all remap of 409s.

Completion reports back through the `ConversationContinuationRegistry` event
side (Phase 3): `research_pipeline_outcome` (keyed by `<thread id>:<pipeline
job id>`, so each run reports its own outcome and a retry is never silently
answered with the previous attempt's message) covers
acquisition started, the question failing its FINER assessment (a first-class
outcome relayed to the user for question refinement, not an error), and a
stage failure; `research_workflow_terminal` (keyed by `<operation id>:<status>`)
covers the Operation's own later lifecycle. The Operation's Room origin is a
loose `origin_room_id`/`origin_session_id` pair written into
`project_operations.progress_json` at intake time (the established
non-FK-cross-domain-identifier pattern; `progress_json->>'workflow_id'`
already carries a unique index this way) — terminal paths that find it
notify the Room, paths that do not (every non-Room-originated research flow)
stay silent.

All three `research_workflow_terminal` variants are wired, through the single
`ProjectResearchOrchestrator.notifyRoomOfOperationStatus`: `failed` from
`failOperation`, `completed` from the idea-review advance, and
`waiting_review` from the one surviving screening pause. The status is part of
the event key because one Operation can legitimately report twice — pause over
the screening budget, then finish — and a bare operation id would make
`findRoomEventContinuation` swallow the second as a duplicate.

## `research.cancel_acquisition`

The symmetric stop for the action above, and the control that replaced the
blocking checkpoints. Direct execution, not
proposal-gated, for the same reason as its counterpart plus one of its own: a
stop that waits on a review is not a stop while a Run keeps spending.

`ResearchOperationCancelService` writes the Operation's `cancelled` status —
`startResearchReconcilePass` reads that status under `FOR UPDATE`, so no
later pass can begin — and enqueues `research_operation_cancel` in one
transaction with it (callers hand the service a plain pool, so the service
opens the transaction itself; without it a failed enqueue would leave a dead
Operation whose Runs keep spending and no path that ever re-enqueues the
kill). The handler then stops the four kinds of live work an Operation owns,
from the jobs worker where the process registry lives: its Runs (found by the
`operation_id` every research Run stamps into its contract snapshot, scoped
by `project_id` for the index), its screening batch jobs, its source backfill
plans (the acquisition itself — the segment scheduler never consults the
Operation's status), and its pass Execution. It also waives the Operation's
still-pending checkpoints: pre-reform the checkpoint decision *was* the stop
lever, so stopping resolved the row as a side effect, and a surviving pending
gate would keep the web UI advertising a review whose approval no-ops. A Run
that answers `cancelling` (kill requested, process exit unconfirmed) defers
the job for a later retry rather than being counted as cancelled. Managed API
Runs register their AbortController in the same process-wide execution
registry as CLI Runner callbacks, so Stop aborts the live provider request and
waits for the adapter to unwind instead of only changing the database row.
Cancelled Runs are reselected because terminal finalization and delegation
projection are idempotent; the job fails and retries until both complete.
Everything skips other work already terminal, so
a Run that produced its report between the stop and the job keeps its result.

The web route enforces and durably records `research.acquisition.cancel`
before calling the service; the managed SystemAction dispatcher applies the
same policy action on the Agent path. An optional caller reason is carried in
the cancellation job and becomes the Run's terminal cancellation reason.

## Research checkpoint policy

`researchCheckpointPolicy.ts` is the single authority for which checkpoints
still stop a workflow. Dogfooding (2026-08-20) found the gates were
rubber-stamp approved every time, so they interrupted without changing any
decision; the reform keeps the checkpoint row as the durable record of what
the machine concluded and lets the workflow continue.

`manuscript_gate` still blocks, because its output is external-facing and
nothing downstream can un-send it. `screening_gate` blocks conditionally, on
corpus size (`SCREENING_AUTO_CONTINUE_CORPUS_LIMIT`): removing it removed the
only place a user saw "N papers matched" before paying for a synthesis over
all of them, so the budget protection moved from a prompt to a limit. Under
it the operation continues unattended; over it the operation pauses and tells
the Room why, which is a report the user acts on rather than a question they
answer on every ordinary run. `idea_review`, `integrity_gate`, and
`review_gate` are records only.

An automatic pass writes `status='waived'` with `user_decision` and
`decided_by_user_id` left NULL, so an audit can still tell whether anybody
looked. Auto-continue additionally waits for classification to drain: on the
incremental path the checkpoint opens before classification finishes and each
reconcile tick refreshes its snapshot in place, so the gate was also serving
as that sync point — waiving early would both freeze the snapshot (only
pending rows refresh) and send a partly-classified corpus to synthesis. A
human approving the still-pending gate from the web UI remains the manual
override for a classification that will never finish.

A classification that will never finish fails the Operation outright —
`failed` is the only status whose advertised remedies (retry, cancel) both
actually work. Two detections, because there are two shapes: a batch that
exhausted its retries is visible in `failed_batches`, but the incremental
path enqueues no recovery batches at all, so items left unclassified at the
current research-question version show every counter at zero. The second is
caught by watching whether the classified count moves
(`screening_stall_watch`, since `screening_progress.updated_at` is recomputed
each tick and cannot say): same count, nothing in flight, past the stall
window, is stuck rather than slow.

Room reporting rides `research_workflow_terminal` once per episode: `failed`
from `failOperation` (keyed with the pass generation, so a retried failure is
a new event), `completed` from every terminal-success path — the idea-review
advance and the three empty-result completions — and `waiting_review` only on
the tick that pauses over the screening budget. Approving a paused screening
checkpoint happens on the web UI's Operations surface; the Room's matching
action is cancel.

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
