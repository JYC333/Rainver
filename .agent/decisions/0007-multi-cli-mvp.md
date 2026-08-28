# ADR 0007: Managed Multi-CLI Runtime Usage

Date: 2026-05-06
Rewritten: 2026-08-27

## Status

Accepted.

Current mechanism lives in
[`modules/runtime-adapters.md`](../modules/runtime-adapters.md),
[`architecture/RUNTIME_ADAPTER_STANDARD.md`](../architecture/RUNTIME_ADAPTER_STANDARD.md),
and [`architecture/EXECUTION_MODEL.md`](../architecture/EXECUTION_MODEL.md).
This document holds the decisions and their reasoning; behaviour changes
update those documents, not this one.

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
any one vendor CLI. Every adapter is independently disableable.

### 2. Three layers stay separate

| Layer | What it is | Examples |
|---|---|---|
| Agent (product) | Configured actor with policy, memory, delegation rules | a Project's coding agent |
| Runtime Adapter | Execution backend selected for a Run | `claude_code`, `codex_cli`, `opencode`, `model_api`, `ts_agent_host` |
| Model Provider | LLM API credential the server holds | Anthropic, OpenAI, Google |

`RuntimeAdapterSpec` (code) is the source of truth for how an adapter
behaves. Per-Space `RuntimeAdapter` rows hold configuration only — enabled
state, executable override, health. Credential profiles are user-owned and
resolved per Run from the instructing user's enabled Space grants
([ADR 0008](0008-credential-channel-isolation.md)); they are not adapter
configuration. Adding a CLI normally means adding a spec, not a runtime class.

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

`runs.model_selection_mode`:

| Mode | Meaning |
|---|---|
| `cli_default` (default) | the CLI uses its own configured model and account |
| `cli_model_override` | Rainver forwards a model choice, only where the spec supports it |
| `rainver_provider` | the Run resolves a configured ModelProvider |

`rainver_provider` works in both directions: managed adapters call the
provider in process, and a local CLI receives a run-scoped provider binding
carrying only the provider-proxy URL and a short-lived lease token. The
upstream key never leaves the server proxy boundary (ADR 0008).

### 5. Usage is accounted exactly where it can be, and labelled where it cannot

Token accounting lives in the canonical usage ledger, attributed to the Run.
ACP reports exact per-turn usage with cache reads and writes separated;
those events carry `usage_accuracy = provider_reported` and the `local_cli`
execution channel. A provider-bound CLI Run is accounted at the provider
proxy instead and emits no second CLI event. Usage reconstructed from
historical transcripts is `transcript_lower_bound` — a recovery path for
import that cannot attribute to a Run — and anything else is `unknown`. The
Run read model aggregates ledger events; `runs` carries no token columns.

Subscription quota is separate from token accounting and cached per
credential profile, never overloaded into runtime health. It arrives as a
byproduct of running work where the vendor emits it (Claude Code's
rate-limit metadata), through a dedicated probe where one exists (Codex),
and stays manual otherwise.

### 6. Three surfaces, one runtime-session mechanism

A CLI Run is reachable from a Task or automation dispatch, a direct
conversation, or a Room. All three prepare context through the Runtime
Context Gateway ([ADR 0014](0014-unified-runtime-context-engine.md)); they
differ in execution preparation, not in context authority.

- **Conversation.** The backend is chosen per user per session and resolves
  the signed-in speaker's own credential profile, so subscription capacity is
  spendable on conversation and never charged to another member. A
  conversation with no Project and no Project action capabilities runs in
  `conversation_lightweight.v1`: credential boundary and isolated working
  directory kept, Project sandbox/worktree, tool grants, and Run Exchange
  skipped. Text deltas stream over the Run SSE connection and are not
  persisted; the final assistant message is the durable record.
- **Runtime session.** `RuntimeAdapterSpec.checkpoint_resume` marks runtimes
  that can resume. Session ids are opaque strings in each runtime's own
  format, resumed with ACP `session/resume`. Every conversation gets a
  server-owned state key and a private HOME/cwd pair; turns sharing a
  user × session binding are serialised. The binding is invalidated — the
  next turn rebuilds from Rainver's own record — on execution failure or when
  Agent version, backend, model, provider, runtime config/policy, or context
  fingerprint changes. Run terminal state and binding commit in one atomic
  statement, so a new turn cannot observe a terminal Run with stale resume
  state. Retired state is deleted after binding commit, with a 30-day sweep
  as the orphan backstop.
- **Room.** A Room is a persistent, Project-bound, multi-party aggregate with
  human and agent rosters. Every Room message opens one run group as one
  collaboration task; the instructing human is resolved per message
  ([ADR 0002](0002-agent-model.md)) and every recipient resolves a backend
  from that speaker's own grants. A resumed recipient receives messages after
  its binding cursor, including other members' turns. Room resume is a full
  governed execution mode — CLI session and isolated HOME preserved, Project
  sandbox, tool grants, and Run Exchange retained. Room membership never
  widens Project authority.

### 7. Sandbox level is a Run property enforced below the vendor

Every local CLI carries baseline trust `low`, so the write barrier is the
server's, not the vendor's. Sandbox levels form a ladder — none, dry run,
ephemeral, read-only Project Folder, writable worktree, one-shot container —
and a Run may not be lowered beneath its adapter's minimum. The read-only
level mounts the real Folder with zero copy in a rootless bubblewrap
namespace that starts empty, allowlists exact system paths, binds the
Folder's entries read-only, and remounts the view root read-only; only the
brokered HOME and Run Exchange output are writable, and network stays
available for subscription CLIs. Isolation failure returns a typed error and
never falls back to an unisolated subprocess. A vendor's own read-only flag
is defence in depth, not the boundary.

This applies to the server host. A paired personal host runs natively under
ADR 0016's trusted-host model.

## Consequences

- Users switch CLIs per Run without losing context; a new CLI is a spec plus
  an ACP adapter, not a protocol implementation.
- Vendor protocol drift lands in one controller and one wrapper, not across
  three parsers.
- Exact accounting is available from every implemented CLI; quota awareness
  is as good as what the vendor exposes.
- The controller is one more moving part on the credential path: every ACP
  wrapper is pinned, installed through the controlled tool path, and never
  the machine's ambient copy on the server host.

## Non-goals

- Routing between providers by price or capability.
- Reimplementing any vendor's agent harness or tool loop.
- Programmatic driving of consumer subscriptions beyond what each vendor's
  terms permit ([ADR 0010](0010-agent-workbench-product-direction.md)).

## Revision history

- **2026-05-06** — accepted as the multi-CLI MVP with per-vendor stream
  parsers, a `GenericCliRuntimeAdapter`, and vendor context files compiled
  into the sandbox.
- **2026-06 → 2026-08** — per-vendor usage extraction, runtime sessions,
  Rooms, read-only mounts, and provider bindings added as amendments.
- **2026-08-22** — ACP runtime replatform replaced every vendor-specific
  protocol path.
- **2026-08-27** — rewritten. The architecture box of retired class names,
  the three-vendor usage and resume tables, the vendor context-file table
  (contradicted [ADR 0014](0014-unified-runtime-context-engine.md)
  decision 12), the `GenericCliRuntimeAdapter` claim, and the Codex
  `app-server` sandbox flag are removed; decisions 3 and 6 record what
  replaced them.
