# ADR 0007 - Managed Multi-CLI Runtime Usage

## Status

Accepted — 2026-05-06

## Context

Rainver is the governance and context layer for users who work across
multiple AI/agent CLI tools.

- Users subscribe to multiple AI/agent CLI tools (Claude Code, Codex CLI, OpenCode, Gemini CLI, etc.).
- Each subscription has a monthly quota that may run out before month end.
- The user wants one unified workspace to switch between CLI tools without losing workspace context, run history, artifacts, proposals, or approval flows.
- Each CLI tool continues using its own account, model selection, and subscription.
- Rainver is not a model-provider router.

## Decision

Rainver focuses on managed multi-CLI runtime usage, not direct
multi-provider model orchestration.

## Architecture

```
Rainver Core
├── WorkspaceManager      - workspace isolation and path policy
├── SandboxManager        - worktree execution environments
├── ContextCompiler       - compiles unified context into vendor-specific files
├── RuntimeAdapterSpecCatalog — which runtime adapters exist and how they behave
├── RunManager            - orchestrates run lifecycle + delegation chain
├── UsageTracker          - fallback/cached runtime usage
├── ArtifactStore         - diffs, logs, validation results
└── ProposalSystem        - human-in-the-loop approval for agent changes
```

Runtime Adapters are adapters to the core, not the foundation.

## Three-Layer Separation

| Layer | What it is | Examples |
|---|---|---|
| Agent (product layer) | Configured actor with policy, memory, delegation rules | system.coding-agent |
| Runtime Adapter | Execution backend selected for a run | claude_code, codex_cli, capability, model_api |
| Model Provider | LLM API (future optional) | Anthropic, OpenAI, Google |

## Model Selection Modes

Runs carry a `model_selection_mode` field:

| Mode | Meaning | When |
|---|---|---|
| `cli_default` | CLI uses its own configured model/account | default |
| `cli_model_override` | Rainver passes a model flag to the CLI | only when the spec supports it |
| `rainver_provider` | The run resolves a configured ModelProvider | implemented |

The default is `cli_default`.

`rainver_provider` works in both directions: managed adapters call the provider in
process, and local CLIs receive a run-scoped provider
binding — Claude Code through injected proxy environment variables, Codex CLI through a
run-scoped `CODEX_HOME/config.toml`, OpenCode through a run-scoped `opencode.json` — each
carrying only the provider-proxy URL and a short-lived lease token. The upstream key
never leaves the server proxy boundary (ADR 0008). That URL is not loopback even today —
it is built from `SANDBOX_RUNNER_SERVER_HOST` (default `server`, the Compose service
name), so it already crosses the deployment's own network in plaintext; see ADR 0008's
2026-08-24 amendment.

## RuntimeAdapterSpec And RuntimeAdapter

`RuntimeAdapterSpec` is the source of truth for adapter behavior. Per-space
`RuntimeAdapter` rows store configuration such as enabled state, executable
override, and health/usage status. User-owned credential profiles are resolved
per Run from the instructing user's enabled space grants; they are not runtime
profile configuration. There is no separate
configured-adapter product model.

Implemented local CLI specs execute through `GenericCliRuntimeAdapter`.
The native adapter is `capability`.

## Usage Tracking

Token accounting is stored in the canonical usage ledger. Every implemented local CLI
(Claude Code, Codex CLI, OpenCode) emits exact token counts in its structured output, each
separating cache reads from cache writes in its own runtime-specific shape:

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| usage location | terminal result `modelUsage` | app-server `thread/tokenUsage/updated.tokenUsage.total` | ACP `session/prompt` response `usage` |
| cache read | `cacheReadInputTokens` | `cachedInputTokens` | `cachedReadTokens` |
| cache write | `cacheCreationInputTokens` | `cacheWriteInputTokens` | `cachedWriteTokens` |

Extraction uses a per-runtime parser and protocol controller for each shape rather than a
shared heuristic. `usage_accuracy = provider_reported` covers these exact runtime envelopes;
Claude auxiliary-model calls produce separate model-attributed events; Codex cached-input and
reasoning counts are converted from inclusive provider totals into mutually exclusive pricing
buckets before ledger ingestion. Exact subscription CLI events use the `local_cli` execution
channel and are idempotently attributed to the Run. Provider-backed CLI runs are accounted at
the provider proxy instead and do not emit a second CLI ledger event.

`transcript_lower_bound` reconstructs usage from historical transcripts that were never
observed at execution time — a recovery path for import, not the primary accounting path, and
it cannot attribute usage to a specific run. Figures that are neither provider-reported nor
reconstructable remain `unknown`. The Run read model obtains its totals by aggregating
Run-attributed ledger events rather than duplicating token columns on `runs`.

Subscription quota is separate from token accounting and cached per CLI credential profile,
not overloaded into runtime health. Claude Code additionally emits a `rate_limit_event` in its
ordinary output stream — `rateLimitType`, `utilization`, `resetsAt`, `isUsingOverage`, and a
status such as `allowed_warning` — so live quota state arrives as a byproduct of running work,
with no separate probe or call. Codex CLI and OpenCode expose no equivalent event, so quota
state for those runtimes stays manual or cached.

## Context Compilation

The ContextCompiler remains the source of truth. Vendor context files are
generated per run inside a server-owned sandbox or read-only-context staging
directory:

| CLI | Vendor file |
|---|---|
| Claude Code | `sandbox/CLAUDE.md` |
| Codex CLI | `sandbox/AGENTS.md` |
| OpenCode / custom | `sandbox/prompt.md` |

Vendor files are never the source of truth and are never written to the real workspace.

## CLI Surfaces

A CLI run is reachable from a task or automation dispatch (the original MVP surface), a direct
conversation, or a Room. Conversation and Room turns share a common resumable runtime-session
mechanism.

**Conversation.** A CLI runtime may back a conversation turn. The backend is selected per
user per session and resolves the signed-in speaker's own CLI credential profile, so
subscription capacity is spendable on conversation and never charged to another member.
Conversation is not restricted to the managed API channel; see the ADR 0008 amendment.
Direct CLI conversation uses a lightweight one-shot path: it keeps the
credential boundary and an isolated working directory, but skips vendor context
file rendering, Run Exchange, tool transport, and full sandbox/worktree
preparation. Agent identity and retrieved context are carried in the prompt.
Text deltas are forwarded live over the Run SSE connection and are not persisted;
the final assistant message remains the durable source of truth.

**Runtime session.** `RuntimeAdapterSpec.checkpoint_resume` distinguishes runtimes that can
resume a prior session. Conversation uses a hybrid context strategy: the first turn replays
rainver-composed context to establish the vendor session, later turns resume and send
only the increment. Backend switch, session invalidation, or required context re-injection
degrades back to replay. The vendor session is permitted runtime state and is never a source
of truth (ADR 0004).

Session ids are stored as opaque strings — each runtime's own format, never assumed to be a
UUID. Claude Code resumes with `--resume` in a stable cwd, Codex app-server resumes with
`thread/resume`, and OpenCode ACP resumes with `session/resume`. Every conversation receives a
server-owned state key and private HOME/cwd pair, so OpenCode never shares its single session
database across conversations. Turns sharing a user/session binding are serialized. The
binding is invalidated — causing the next turn to replay — on execution failure or when the
Agent version, backend, model, provider, runtime config/policy, or summary fingerprint
changes. Retired state is deleted after binding commit, with a binding/nonterminal-Run-aware
30-day retention sweep as the orphan backstop. Run terminal state and binding
record/invalidation commit as one atomic PostgreSQL statement, so a new turn cannot observe a
terminal Run with stale resume state.

**Room.** A Room is a persistent, project-bound, multi-party aggregate with
human and agent rosters and multiple durable conversations. It does not change
`agent_run_groups` into a conversation container: every Room message opens one
group as one collaboration task. The triggering human is resolved per message
(ADR 0002), and every recipient resolves a user × session × agent backend from
that speaker's own credential grants. A resumed CLI recipient receives Room
messages after its binding cursor, including increments from other members;
missing cursor or changed context falls back to replay. Terminal top-level task
output is projected into the Room conversation, while the Run and group remain
the audit authorities.

Room resume is a full governed execution mode, not the prompt-only direct Chat
mode: it preserves the CLI session and isolated persistent HOME while retaining
Project sandbox/context preparation, tool grants, and Run Exchange. Room
membership never widens Project authority; creation validates writer/reader
ACLs and every later operation re-checks Project readability.

**Read-only Project Folder.** `required_sandbox_level=read_only` sits between "no file access"
and "writable worktree": the real Project Folder is mounted read-only with zero copy, and the
run is not raised to high risk. The write barrier is enforced below the vendor, because every
local CLI carries baseline trust `low`. The server validates the registered Folder, creates
only a context staging directory, and runs the CLI in a rootless bubblewrap mount namespace.
The namespace starts with an empty filesystem, allowlists system runtime trees and exact
DNS/NSS/linker/CA configuration paths rather than the whole `/etc`, then assembles the
selected Folder's top-level entries as recursive read-only binds. It overlays generated
context from staging, then remounts the view root read-only; other spaces and host paths are
absent. Only the brokered HOME and Run Exchange output are writable; network access remains
available for subscription CLIs. Codex additionally receives `sandbox=read-only` in app-server
`thread/start`, but that vendor flag is defense in depth, not the write boundary itself.
Bubblewrap/user-namespace failure returns `read_only_sandbox_unavailable` and never falls back
to a normal subprocess.

## Consequences

- Users can switch CLI tools on a per-run basis without losing context.
- Quota awareness is manual but practical (no API access to subscription data needed).
- Precise token accounting is available from every implemented subscription CLI's
  structured output; historical transcript import remains a lower-bound recovery path.
- `one_shot_docker` is deny-by-default (`--network none`) and fail-closed when
  Docker/image/path prerequisites are unavailable.
- Adding a new CLI adapter should usually mean adding a RuntimeAdapterSpec, not
  a new runtime class.
