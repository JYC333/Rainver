# System Actions and Agent Tool Gateway

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
  and whether advance approval grants may apply.

There are currently no public `external_mcp` actions. The private Run-scoped
MCP transport is not a public registration surface and does not change action
visibility.

## Dispatch boundary

`SystemActionGateway` performs registry lookup, actor and visibility checks,
idempotency validation, input validation, policy enforcement, executor lookup,
and output validation in that order. Unknown actions, missing executors,
unsupported actor/visibility combinations, missing idempotency keys, invalid
schemas, and denied policy decisions fail closed.

The gateway is actor-neutral. HTTP routes continue to call their owning
application services and `PolicyGateway` enforcement points. Server jobs may
use internal/system-job actions. Managed model runs use `AgentToolGateway`, the
agent-specific adapter over `SystemActionGateway`.

Local CLI Runs use that same gateway through a Run-scoped MCP transport. The
server issues an opaque, in-memory, short-lived identity only for the executing
Run, exposes `initialize`, `tools/list`, and `tools/call`, and revokes the
identity when the CLI exits. The transport reloads the Run in the identity's
Space, requires it to remain `running`, and offers only the gateway's
permission/capability intersection. It never gives the CLI database credentials
or an internal service token.

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

## Managed-agent exposure

`AgentToolGateway` composes retrieval, delegation, and enabled generic actions
for a managed run. Exposure requires all of:

1. registry visibility includes `agent_tool` and actor type includes `agent`;
2. the immutable AgentVersion `tool_permissions_json.allowed_tools` permits the
   action and the action is present in `runs.capabilities_json`;
3. a call-time PolicyGateway decision allows the registered policy action.

The currently enabled generic write-capable tools are proposal-only:
`source.connection.propose_create`, `project.source.propose_bind`, and
`source.backfill.propose_start`. They receive the run's space, agent, instructed
user, run, and Project scope. Project-only actions reject an unscoped run;
backfill proposal lookup also proves the plan belongs to that Project. Agents
do not receive direct activation, proposal-apply, grant-management, credential,
deployment, or memory-write actions.

These three tools have concrete Zod input contracts and matching model-visible
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

## Invariants

- Registry absence, policy-adapter absence, or unknown action means deny.
- Visibility metadata is an exposure ceiling, never authorization by itself.
- Agents create proposals; they do not apply them directly.
- A grant never changes the proposal payload or bypasses apply-time checks.
- Credentials are resolved by their owning service and never accepted as tool
  payload secrets.
- `external_mcp` remains empty until separately designed.
- RunEvent/action audit metadata contains no prompts, credentials, raw source
  content, stdout, or stderr.
