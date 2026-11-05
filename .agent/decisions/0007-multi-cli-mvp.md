# ADR 0007: Managed Multi-CLI Runtime Usage

Date: 2026-05-06

## Status

Accepted.

Current mechanism lives in
[`modules/runtime-adapters.md`](../modules/runtime-adapters.md),
[`architecture/RUNTIME_ADAPTER_STANDARD.md`](../architecture/RUNTIME_ADAPTER_STANDARD.md),
and [`architecture/EXECUTION_MODEL.md`](../architecture/EXECUTION_MODEL.md).
This document holds decisions and their reasoning. Implementation detail
changes update those guides; changes to the decisions also update the affected
ADR scope and cross-references.

## Context

Users subscribe to several AI coding CLIs (Claude Code, Codex CLI, OpenCode,
Gemini CLI). Each has its own account, model selection, and monthly quota that
may run out before month end. The user wants one workspace to switch between
them without losing Project context, run history, artifacts, proposals, or
approval flows — and wants subscription capacity, which they already pay for,
to be usable for conversation as well as dispatched tasks.

Two things Rainver is not: a model-provider router, and a re-implementation
of any vendor's harness.

## Decision

### 1. Rainver manages CLI runtimes; it does not orchestrate providers

Rainver is the governance and context layer over vendor CLIs. Runtime
adapters are adapters to the core, never its foundation, and no core
authority (canonical state, policy, memory, proposals, context) may depend on
any one vendor CLI. An adapter is available only where an execution host
holds an installed, logged-in copy of it; there is no separate per-adapter
enable switch, and a CLI nobody installs cannot run (`RUNTIME_ADAPTER_STANDARD.md`).

### 2. Three layers stay separate

| Layer | What it is | Examples |
|---|---|---|
| Agent (product) | Configured actor with policy, memory, delegation rules | a Project's coding agent |
| Runtime Adapter | Execution backend selected for a Run | `claude_code`, `codex_cli`, `opencode`, `gemini_cli` |
| Model Provider | LLM API credential the server holds | Anthropic, OpenAI, Google |

`RuntimeAdapterSpec` (code) is the source of truth for how an adapter
behaves; there are no runtime-adapter database rows. A Space's runtime choice
lives on `AgentRuntimeProfile` rows (`runtime_key`, backend mode, options —
[ADR 0022](0022-acp-runtime-authority-and-schema-epoch.md)), and each host
reports the installation and health of the copies it holds. A CLI's login
lives with its copy on the execution host, and a `model_provider` Profile
reaches a Space-granted ModelProvider through the proxy lease
([ADR 0008](0008-credential-channel-isolation.md)); neither is adapter
configuration. Adding a CLI normally means adding a spec, not
a runtime class.

### 3. One protocol: the Agent Client Protocol

Every local CLI is driven through one server-side ACP controller. Adapters
that do not speak ACP natively are reached through thin wrapper adapters
(`claude-agent-acp` for Claude Code; Rainver's own pinned `codex-acp` for
Codex); OpenCode speaks ACP directly; further agents come from the ACP
registry. Rainver implements no vendor-specific stream protocol, and a
vendor's own RPC surface is used only where ACP has no equivalent (today: the
Codex quota probe).

Consequences of a single protocol: one usage parser, one permission-request
handler, one session-resume mechanism, and one byte-relay transport for
remote execution hosts ([ADR 0016](0016-control-plane-execution-hosts.md)).

### 4. Model selection is explicit per Run

The Run's `AgentRuntimeProfile` sets its `backend_mode`
([ADR 0022](0022-acp-runtime-authority-and-schema-epoch.md)):

| Mode | Meaning |
|---|---|
| `runtime_native` | the CLI uses its own configured model and account |
| `model_provider` | the Run resolves a Space-selectable ModelProvider and model |

Under `model_provider` the local CLI receives a run-scoped provider binding
carrying only the provider-proxy URL and a short-lived lease token. The
upstream key never leaves the server proxy boundary (ADR 0008). The legacy
`runs.model_selection_mode` column keeps its `cli_default` default and is not
read by dispatch.

### 5. Usage is accounted exactly where it can be, and labelled where it cannot

Token accounting lives in the canonical usage ledger, attributed to the Run.
ACP reports provider-counted usage with cache reads and writes separated;
those events carry `usage_accuracy = provider_reported` and the `local_cli`
execution channel. Whether the count covers the whole turn is the adapter's
to say: Claude Code and OpenCode report the turn, `codex-acp` reports its last
model request, and the runtime spec's `usage.acp_prompt_usage` labels the
ledger event's `usage_scope` accordingly
([runtime-adapters](../modules/runtime-adapters.md)). A provider-bound CLI Run is accounted at the provider
proxy instead and emits no second CLI event. Usage read from an
ambient session import is recorded as `provider_reported` with the vendor's
own counts (`cli.history_usage`, attributed to the imported session rather
than a Run), and anything else is `unknown`. The
Run read model aggregates ledger events; `runs` carries no token columns.

Subscription quota is separate from token accounting and cached per host,
runtime and installation (`host_runtime_usage`), never overloaded into
runtime health. It is read on the host that holds the login, through the
daemon's usage probe where the runtime has one (Claude Code, Codex), and is
unavailable otherwise.

### 6. Three surfaces, one runtime-session mechanism

A CLI Run is reachable from a Task or automation dispatch, a direct
conversation, or a Room. On every execution host, all three prepare context
through the Runtime Context Gateway
([ADR 0014](0014-unified-runtime-context-engine.md); ADR 0016 §3 amendment).
Login and session state are host-owned (ADR 0016 sections 2 and 5).

- **Conversation.** The backend is chosen per user per session and binds the
  signed-in speaker's own choice of host and installation, so subscription
  capacity is spendable on conversation; on a paired host that is the
  speaker's own machine and is never charged to another member, while the
  built-in host's one copy is shared (ADR 0016 §3). A
  conversation with no Project and no Project action capabilities runs in
  `conversation_lightweight.v1`: credential boundary and isolated working
  directory kept, Project sandbox/worktree, tool grants, and Run Exchange
  skipped. Text deltas stream over the Run SSE connection and are not
  persisted; the final assistant message is the durable record.
- **Runtime session.** `RuntimeAdapterSpec.checkpoint_resume` marks runtimes
  that can resume. Session ids are opaque strings in each runtime's own
  format, resumed with ACP `session/resume`. The vendor session is held by one
  host thread per Conversation × Agent (`host_threads.vendor_session_id`), and
  the runtime's own state lives in that Agent's profile directory on the host
  (ADR 0016); turns sharing a binding are serialised. A mismatch or authority
  rotation starts a new ACP session, which begins from the Room-built prompt
  rather than a replay of Rainver's record (ADR 0014 §11).
- **Room.** A Room is a persistent, Project-bound, multi-party aggregate with
  human and agent rosters. Every Room message opens one run group as one
  collaboration task; the instructing human is resolved per message
  ([ADR 0002](0002-agent-model.md)) and every recipient resolves a backend
  from that speaker's own grants. A resumed recipient receives messages after
  its binding cursor, including other members' turns. Room resume is a full
  governed execution mode — CLI session and the Agent's host profile
  preserved, Project workspace and tool grants retained. Room membership never
  widens Project authority.

### 7. Sandbox level is a Run property enforced below the vendor

Every local CLI carries baseline trust `low`, so the write barrier is
Rainver's, not the vendor's. Sandbox levels form a ladder — none, dry run,
ephemeral, read-only Project Folder, writable worktree, one-shot container —
and a Run may not be lowered beneath its adapter's minimum. The read-only
level mounts the real Folder with zero copy in a rootless bubblewrap
namespace that starts empty, allowlists exact system paths, binds the
Folder's entries read-only, and remounts the view root read-only; only the
Run's profile/HOME and its per-Run directory are writable, and network stays
available for subscription CLIs. Isolation failure returns a typed error and
never falls back to an unisolated subprocess. A vendor's own read-only flag
is defence in depth, not the boundary.

This applies to the built-in strict host. A paired personal host runs natively
under ADR 0016's trusted-host model.

## Consequences

- Users switch CLIs per Run without losing context; a new CLI is a spec plus
  an ACP adapter, not a protocol implementation.
- Vendor protocol drift lands in one controller and one wrapper, not across
  three parsers.
- Exact accounting is available from every implemented CLI; quota awareness
  is as good as what the vendor exposes.
- The controller is one more moving part on the credential path: every ACP
  wrapper is pinned, installed through the controlled tool path, and never
  the machine's ambient copy on the built-in host.

## Non-goals

- Routing between providers by price or capability.
- Reimplementing any vendor's agent harness or tool loop.
- Programmatic driving of consumer subscriptions beyond what each vendor's
  terms permit ([ADR 0010](0010-agent-workbench-product-direction.md)).
