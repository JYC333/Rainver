# Module: Runtime Tools And Adapter Types

Rainver owns agents, runs, Runtime Context Delivery, policy, credential gating,
worktree governance, artifacts, proposals, audit records, and events. Vendor
CLIs are runtime adapter types, but their binaries are copies installed on an
execution host.

## Canonical Standard

`RuntimeAdapterSpec` is the source of truth for adapter behavior. Built-in specs
live in `server/src/modules/runtimeAdapters/specs.ts`. Specs define:

- runtime kind and implementation status
- runtime tool requirement, command argv template, and parser behavior
- accepted Delivery rendering behavior
- credential mode, and how a managed copy is logged in (`credentials.login`)
- sandbox and Project Folder requirements
- model override support
- permission bypass capability and policy key
- output parser and artifact strategy
- frontend catalog metadata

Runtime adapter database rows are not part of the current product schema. Product
run creation and frontend configuration resolve through an Agent's selected or
default `AgentRuntimeProfile`. Server execution then uses the resulting
`Run.adapter_type` plus the run's snapshotted
`runtime_profile_snapshot_json.runtime_config_json`. Agents without an enabled
runtime profile cannot create normal agent runs.

Before dispatch, orchestration assembles the shared `run_input.v1` contract.
Managed adapters forward it on the runtime-host request; local CLI adapters
receive the same contract alongside their native prompt/config projection.
Adapter-specific payloads are projections of this envelope, not independent
input authorities. Run creation snapshots the intersection of declared Run
capabilities, immutable AgentVersion tool permissions, and the System Action
Registry into `run_input.v1.tool_grants`; local CLI and managed execution share
the same governed tool authority.

The old `/api/v1/runtime-adapters` CRUD, detect, status, probe, and usage API
is retired. Do not reintroduce instance-level runtime adapter configuration.

## Built-In Adapter Types

| adapter_type | kind | status | credentials | context | sandbox |
|---|---|---|---|---|---|
| `capability` | native | planned | none | none | none |
| `model_api` | managed_api | implemented | `model_provider_api_key` or owner-bound `managed_subscription_oauth` | none | none |
| `ts_agent_host` | managed_api | implemented / disabled by default | `model_provider_api_key` (`server_runtime_host`) | canonical host request | none |
| `claude_code` | local_cli | implemented | copy's own login on the host | rendered prompt + work surface | host daemon |
| `codex_cli` | local_cli | implemented | copy's own login on the host | rendered prompt + work surface | host daemon |
| `opencode` | local_cli | implemented (low trust by declaration) | copy's own login on the host | rendered prompt + work surface + locked agent control | host daemon |
| `gemini_cli` | local_cli | planned | disabled | prompt/custom | worktree |
| `custom` | custom | planned | disabled | custom | custom |

Planned adapters may appear in code/catalog metadata but cannot be enabled or
executed. Every CLI Run now executes on a host daemon, so there is no
server-side Docker executor: `supports_one_shot_docker` on a spec is a
declaration the orchestrator still checks (a critical Run on an adapter that
does not declare it fails with `docker_sandbox_not_supported`), but no
execution path builds a container. See *Isolation Limits* for what the level
actually changes. Runs fail closed if the named copy is not installed on the
host; they never downgrade.

**Runtime conformance is retired (2026-09-09).** There was a C3 suite here: it
asked a vendor CLI a handful of behavioural questions once — write only this
file, do not print that secret, stop when told, do not delegate — and cached
the verdict against `(adapter_type, runtime_version)`, which the router then
required before any non-low-risk or file-shaped CLI work.

It was narrowed first and then removed, because narrowing did not reach the
problem. The behaviours it asked about are the *model's*, and the verdict
carried no model, so a pass measured on one model spoke for every model that
copy could select — and a copy offers several. One sample of a
non-deterministic runtime is weak evidence for a permanent verdict, and a
vendor ships a new version faster than a sweep can be repeated. Its strongest
question — will the runtime write outside what it was given — became
structural under ADR 0016: the daemon binds the workspace and nothing else.
What was left either duplicated what using the runtime already proves (an
output contract is exercised by every ACP turn) or tested instruction-following
against a threat the credential channel already closes.

What contains a CLI Run is the host's namespace, its egress profile and
ADR 0008's credential channel. None of those vary by risk level, so risk now
has no effect on CLI dispatch at all; that is recorded in the deferred register
rather than implied by a check that no longer runs. A runtime's trust level is
what its own spec declares — a runtime that cannot say it can stop its own
delegation stays `low`.

## Product API Surface

Installing a runtime, logging it in, reading its subscription and rolling it
back are all **host** operations, under `/api/v1/hosts/:hostId/installations/*`
and `/api/v1/hosts/:hostId/usage`. The host owner acts on a paired machine; the
built-in host is instance-admin gated. The surface is documented in
[hosts.md](hosts.md); the frontend is the Command Center's host card.

## Generic CLI Lifecycle

1. server `runs` creates a run by resolving the final adapter/model binding
   from the selected/default `AgentRuntimeProfile`, then space default provider
   fallback when the adapter requires a provider. The chosen profile is
   snapshotted on the run. Execution resolves the final adapter type from
   `Run.adapter_type` and the immutable
   `runtime_profile_snapshot_json.runtime_config_json`. Managed execution uses
   the routed model persisted in `Run.model_override_json.model` when the worker
   request does not carry an explicit model; it must not silently fall back to
   the provider default. Managed Provider invocation returns the configured
   Provider id and model that actually served the turn. Runtime/adapter evidence
   records those as `model_provider_id` and `model`, while
   `requested_model_provider_id` preserves the routed/requested Provider when
   invocation-layer fallback selected a different one.
2. `server/src/modules/runtimeAdapters` validates that the adapter exists
   and is implemented.
3. Native adapters are planned; no native capability executor is active today.
4. server local CLI runtime specs enter through
   `server/src/modules/runs/remoteHostCliAdapter.ts`. Shared local CLI execution
   details are split by responsibility: command rendering in
   `cliCommandRendering.ts`, the executor contracts and process registry in
   `localCliExecution.ts`, the adapter requirement in
   `adapterProviderRequirement.ts`, and Codex/OpenCode config materialization
   in `codexProviderConfig.ts` and the subagent config helper. Spawning a CLI
   and building its environment are the **daemon's** — the control plane holds
   neither (`packages/host-daemon/src/execution.ts`,
   `packages/host-daemon/src/providerBinding.ts`).
5. For local CLI runtimes, the dispatch carries the host and the installation
   from the immutable `Run.runtime_profile_snapshot_json`, and the **daemon**
   resolves that copy on its own machine. Nothing on the server resolves a
   binary path (B64). A host that does not report the named installation fails
   the launch rather than substituting another copy.
6. A CLI runtime uses the login held by its copy on the execution host that runs it; Rainver brokers none (ADR 0016).
   Claude Code may also receive a per-run Claude-compatible ModelProvider
   binding. When selected, the server resolves the provider's
   `claude_compatible_base_url` and model, creates a short-lived provider proxy
   lease, then injects only the proxy URL, lease token, and model
   environment variables into the Claude subprocess. Codex CLI may also receive
   a per-run OpenAI Responses-compatible ModelProvider binding. When selected,
   the server resolves `openai_compatible_base_url`, creates a short-lived
   provider proxy lease, materializes the run's temporary `CODEX_HOME`, and
   writes a run-scoped `config.toml` with `wire_api = "responses"` plus a
   generated model catalog. The Codex subprocess receives `CODEX_HOME` for both
   provider-backed and CLI-default runs, and the Codex config stores only the
   proxy URL and lease token, not the real provider key. The internal
   provider proxy listener is started by the server process bound `0.0.0.0`, on
   `PROVIDER_PROXY_PORT` — a fixed port when set, else OS-assigned. The URL
   handed to a run is not a loopback URL: its host comes from
   `SANDBOX_RUNNER_SERVER_HOST` (default `server`, the Compose service name),
   so lease traffic crosses the deployment network. A paired execution host
   needs `PROVIDER_PROXY_EXTERNAL_BASE_URL` as well, since it cannot resolve a
   Compose service name. Provider
   API keys are resolved only inside the server proxy and are not released to
   CLI subprocess env. When a provider is selected, upstream proxy/direct
   routing is taken from the Provider's NetworkProfile. No provider selected
   means no base URL override; the CLI uses the login its copy holds on the
   execution host.
   OpenCode can use its host copy's own login or a run-scoped ModelProvider
   binding. It runs
   through the ACP stdio protocol with a sandbox `--cwd` and a run-scoped
   `opencode.json` that makes `rainver-locked` the primary default agent,
   sets subagent depth to zero, and denies Task and webfetch. Every worktree CLI
   run receives a freshly cleared private `HOME`; login-backed runs copy only
   the adapter credential file. Shared sessions, transcripts, databases, and
   general CLI config are never mounted or linked into a run.
7. server Project Folder/sandbox services validate and prepare the worktree.
   Every managed Run, including direct Chat and Room turns, obtains one accepted
   Runtime Context Delivery for each physical managed or CLI call. Direct Chat
   resolves its current canonical Message; Room recipients also resolve the
   canonical triggering Message, while the assigned segment and structured
   sibling-routing facts are separately acquired from the recipient Run. The
   adapter maps that Delivery without fetching, reordering, or rebudgeting
   context. No alternate legacy preparation service exists.
8. server command rendering produces `string[]` argv and never uses
   `shell=True`. Claude receives its prompt through the measured stream-JSON
   CLI invocation. Codex runs `codex app-server --stdio`; the executor performs
   initialize → thread/start → turn/start and consumes
   `item/agentMessage/delta`. OpenCode runs `opencode acp --cwd <sandbox>`; the
   executor performs initialize → session/new → session/prompt and consumes
   `agent_message_chunk`. The NDJSON controller owns stdin until the terminal
   turn response, then closes it so the protocol subprocess exits.
9. The server CLI executor starts the subprocess and registers it in the shared
   `CliProcessRegistry`; `PATCH /runs/{id}/stop` SIGTERMs the registered
   process before writing terminal cancellation state.
10. The output parser normalizes stdout/stderr, errors, usage estimates, and
    artifacts.
11. Run events, proposals, artifacts, validation, and audit stay owned by
    Rainver contexts.

Managed tool loops prepare, acknowledge, and finalize a distinct Delivery for
every physical Runtime Host request, preserving only the tool-loop suffix when
the next accepted Delivery replaces the base semantic context. The HTTP Runtime
Host boundary verifies the persisted provider/model and hashed base request,
accepts only a structurally valid tool-loop suffix, and atomically records a
full-request dispatch fingerprint so Delivery references cannot be replayed.
The loop itself runs through the narrow `managedAgentLoop` port backed by
pi-agent-core. That dependency sees canonical messages and tool results but has
no provider, credential, policy, database, retrieval, or Runtime Context
authority; its stream function calls the ordinary Runtime Host executor once
per turn. `AgentToolGateway` remains the shared managed/CLI exposure and
dispatch authority, and `SystemActionGateway` remains the call-time validation,
grant, policy, idempotency and action-event boundary.
Provider-proxy Usage keeps the shared Delivery audit refs but uses a unique
per-response idempotency suffix. Retrieval-owned
rewrite/rerank/synthesis and embedding calls do not recursively enter Runtime
Context; each physical provider attempt instead persists a domain-owned
provider-task control, Delivery, safe Snapshot, and Usage audit references.

## Where a CLI copy lives

A vendor CLI is installed on an **execution host** — the built-in host inside
`sandbox-runner`, or a paired machine — and never on the server. There is no
instance runtime-tool catalog, no `$RAINVER_HOME/runtime-tools` tree, and no
per-Space version policy: those were retired with ADR 0016, along with the
`/api/v1/runtime-tools/*` and `/api/v1/credentials/cli/*` surfaces.

One current version per adapter per host, plus one kept behind it as the
rollback target. Installing, upgrading, rolling back and removing all go
through the host card and the daemon's `install_tool` / `rollback_tool` /
`uninstall_tool` frames; each drains that copy's Runs first and refuses rather
than killing one. See [hosts.md](hosts.md) for the frames, the drain, the
quota probe and the change record.

## Which copy a Run uses

An Agent runtime profile names `execution_host_id` and `runtime_installation`
(`own`, or `managed:<version>`), and that pair decides the copy. A CLI profile
that names no execution host is not a runnable backend at all — there is no
server-side copy to fall back to (BOUNDARIES B46), so it is filtered out of
conversation backends and marked unavailable in routing.

## Credentials

None are brokered. The copy on the host is logged in on that host and uses its
own login; Rainver stores no CLI credential and resolves no path to one
(BOUNDARIES B45, B64). A Run bound to a `ModelProvider` still reaches it
through an expiring proxy lease, never through a key in the subprocess
environment (ADR 0008). See [credentials.md](credentials.md).


## CLI Conversation Runtime Sessions

Runtime Context owns one active CLI binding per Space × typed work scope × user
× Agent. The database stores the opaque vendor session id, internal UUID state
key, separate authority/runtime fingerprints, generation, rotation reason,
acknowledged Context Event cursor, and acknowledged stable item ids. Direct
sessions, Room recipients, root tasks, and Workflow executions therefore do
not share vendor state accidentally.

The first or rotated turn sends a canonical Semantic Checkpoint + uncovered
event-tail reconstruction and then the current item as two physical vendor
messages. Later turns resume the
vendor session and send only events/stable items not acknowledged by that
binding, followed by the current item:

- Claude Code uses `--resume <session-id>` and a stable conversation cwd,
  because its transcript lookup is cwd-partitioned.
- Codex uses app-server `thread/resume`; restored cumulative token usage is
  captured before `turn/start` and subtracted from the new cumulative total.
- OpenCode uses ACP `session/resume`; each conversation has a private `HOME`
  because OpenCode stores all sessions in one SQLite database.

Conversation runtime state lives only under
`cache/conversation-runtime-homes/<state-key>` and
`sandboxes/conversation-sessions/<state-key>/workspace`. It is server-owned,
excluded from backup. A
runtime/provider/model, credential, sandbox, delegated-instruction,
tool/egress/governing-policy, or sensitivity-revocation change rotates the
binding with a durable reason. Missing state rotates and reconstructs without
treating the filesystem as authority. Ordinary reference additions or updates
remain deltas; removal stops future selection and does not claim to erase a
vendor's opaque archive. The CLI cursor advances only in the accepted Delivery
acknowledgement transaction. Vendor state is therefore an optimization, never
conversation authority.

A durable per-binding execution lease serializes shared Workflow scope use
through Delivery acknowledgement and vendor-session persistence. Checkpoint
sources are reauthorized before reconstruction, and runtime, credential,
provider/tool, AgentVersion, network, and external-egress generations are part
of the hard-rotation fingerprint.

A subscription quota is read on the host that holds the login, and the cache is
keyed by `(host, adapter, installation)` — one copy's subscription state can
never be returned for another copy or another machine.

## Managed API Lifecycle

Managed API adapters do not detect a local executable. They are considered
installed when implemented:

- `model_api` and `ts_agent_host` execute provider-backed turns through server
  `runs` and `POST /internal/runtime-host/execute` when runs authority is the
  server. The provider key is released inside the server providers/credentials
  broker over the internal channel and is never passed through ambient
  environment variables.

### Project Research execution boundary

Project Research is a managed API consumer, not a CLI runtime selection surface.
Its setup accepts a ModelProvider and optional model; the server provisions the
system research Agent and a `model_api` runtime profile. Research source
post-processing and synthesis Runs carry an immutable structured-output
contract, and provider invocation must return the declared JSON Schema object.
The server validates the returned object against that contract after provider
decoding; plain text, missing fields, wrong types, and undeclared fields are
terminal failures with stage/schema/provider/model context. Structured Research
requests use the selected provider directly, so a generic auxiliary task policy
cannot silently reroute them to another provider.
Project Research synthesis uses a result envelope with `status=succeeded` or
`status=rejected`. `rejected` is a semantic, user-correctable outcome for an
unactionable research question or corpus, not a provider/runtime error; its
structured `rejection` details are retained in the Run output and projected to
the research operation progress API. The synthesis instruction itself resolves
from the central `project_research.synthesis` Prompt Library asset and the
resolved version/hash are captured in the Run contract. System, transport, and
schema failures remain ordinary failed Runs.
Research never accepts OpenCode, Claude Code, or Codex runtime values. Those runtimes remain available to generic Agent and Coding
Agent flows and are not removed from the adapter registry.
An instance-admin owner may select their managed Claude or OpenAI Codex
subscription Provider for this in-process path. The ownership check is applied
before OAuth decrypt/refresh. Codex schema-bound requests use one constrained
tool with Responses `tool_choice: "required"`; the subscription is not eligible
for space-wide retrieval task policies because other members cannot spend the
owner's capacity.
- Runs default to `tool_mode: disabled`. Managed runs can expose authorized
  internal retrieval tools through the runtime host when enabled per space
  (`retrieval.space.settings` `retrieval_tool_mode`) or per run. Knowledge tools
  are `retrieval.search` / `retrieval.brief`; Memory and Project public-summary
  tools are exposed only by explicit domain opt-in as
  `memory.retrieval.search`, `memory.retrieval.brief`,
  `project.summary.search`, and `project.summary.brief`. Each tool
  call passes a policy-gateway action before search/brief execution; preflight
  modes append explicit retrieval evidence before the model turn rather than
  bypassing Runtime Context authority. The provider invocation layer gives the
  canonical tool schema to pi-ai, which maps it to OpenAI-compatible/Codex
  function calls or Anthropic Messages `tool_use` / `tool_result` blocks. The runtime host reports an unsupported
  provider with the `runtime_tool_provider_unsupported` code, and the managed-run
  tool loop degrades to a single no-tool turn rather than failing the run.
- Managed API and local CLI runs inside Agent Rooms expose room tools when the
  run belongs to an active group and carries the corresponding snapshotted tool
  grant. `agent.delegate` is available when there are active target
  members and creates child runs through the agent group service and
  `run.spawn_child` policy gate. `agent.wait_for_results` lets the current run
  pause on current-turn sibling runs, its own delegated child runs, or explicit
  same-room run ids; orchestration stores `waiting_for_dependency` and the
  lifecycle projector requeues the same run after every dependency is terminal.
  These tools are not free-form provider tools and do not parse natural-language
  text server-side.

General MCP/tool scheduling is deferred to the extended server runtime stage.
Local CLI adapters use the same `AgentToolGateway` through the Run-scoped REST
tool surface — reached with the `rainver` command the executing side puts in
front of the Run — rather than a separate tool authority.

## Permission Bypass

Permission bypass is disabled by default. It can be used only when:

- the spec declares support
- the run's snapshotted runtime profile config requests `permission_bypass`
- the run's snapshotted runtime profile policy allows `allow_permission_bypass`
- the run is high or critical risk
- execution uses a worktree workspace

Blocked requests fail before invocation with `permission_bypass_not_allowed`.

## Isolation Limits

Low/medium-risk Folder-bound CLI runs use `read_only`: on the built-in host the
daemon exposes the Location through a rootless bubblewrap mount namespace with
an OS-enforced read-only view, built from the dispatch's `isolation` policy.
The namespace begins with an empty filesystem and exposes only system runtime
trees, exact DNS/NSS/linker/CA configuration files (not the whole `/etc`), the
installed copy's own tree, the working directory, the Run's own HOME, and the
explicit binds the daemon materialized for it; other host paths, Spaces, and
other copies' runtime-state directories are not readable. Network reach follows
the dispatch's `egress_profile`, but only `none` is containment (the namespace
gets `--unshare-net`); `default` and `install` point the Run's proxy variables
at the daemon's CONNECT proxy, which is policy and a record rather than a wall
— see *Egress* in `modules/hosts.md`. Official Compose relaxes its seccomp profile
solely because Docker's built-in profile blocks rootless namespace creation; it
grants no capabilities or privileged mode. Namespace preflight failure is
terminal and never downgrades to a normal subprocess.

**The sandbox level no longer narrows a Folder-bound Run at all.** Only
`read_only` ever changed the bind, and a Folder-bound run's floor is `worktree`
now, so every risk level reaches the daemon as `read_write`. That is deliberate
and was a repair, not a relaxation: `read_only` made sense while the server
mounted the Folder read-only and provisioned a *separate* worktree for the
writes. With that gone, the levels came out inverted — a low-risk run could not
write its own workspace while a high-risk one could, so the safer a run was the
less it could do. A run that cannot write cannot do the work it was dispatched
for.

What still contains a Run is the namespace and the egress profile, not the
level. `worktree` and `one_shot_docker` remain resolved and recorded but have
no daemon analogue: the daemon's workspace is the Location itself. So risk
currently decides nothing about containment on the built-in host — stated here
rather than left to be inferred from the level names, and tracked in the
deferred register.

The server-side worktree provisioning that used to serve high-risk CLI runs
still exists in `runs/ephemeralSandbox.ts` and `projectFolders/sandbox.ts`, but
**no CLI Run reaches it**: `worktree` and `one_shot_docker` are produced only
for vendor CLI adapters, every vendor CLI adapter is `executor_family:
"local_cli"`, and that is exactly the predicate routing a Run to the daemon
port. `ServerHostExecutionAdapter` therefore only ever serves managed-API runs,
which never ask for a worktree. Recorded in the deferred register rather than
deleted here; nothing dispatches through it, so it is dead weight, not a risk.

No server-brokered Runtime Context reaches a daemon CLI Run at all — the agent
pulls what it needs through the `rainver` command (`runs/runRemoteness.ts`) —
so real Project Folder files such as `CLAUDE.md`, `AGENTS.md`, or `prompt.md`
are never mutated by runtime execution.


## Usage And Output Parsing

The retired `/runtime-adapters/*/usage` endpoint is not part of the current
product. Run history and trace read models remain the source for execution
evidence, while token accounting lives under `/usage`: managed provider calls
and provider-proxy responses emit ledger events, subscription CLI runs emit
Run-attributed `local_cli` events from their exact runtime envelopes, and
and a Run bound to a `ModelProvider` is metered at the proxy instead, so the
same generation is never counted twice. Claude's live `rate_limit_event` is
folded into that copy's entry in the host quota cache
(`hosts/usageService.ts`). Quota snapshots are not token-accounting events.

Claude Code uses its structured JSON stream; Codex uses app-server JSON-RPC;
OpenCode uses ACP JSON-RPC. Their protocol controllers validate scoped
responses and terminal usage before producing the adapter envelope. Output
text remains normalized, stdout/stderr are redacted, and nonzero/timeout errors
use stable codes. Raw output and transcripts are not stored in the usage
ledger.

## Adding an Adapter

To add a new local CLI runtime, add a validated `RuntimeAdapterSpec` with
invocation, context, credentials, sandbox, model, permission, usage, and output
sections. Its `distribution` is what a host installs a managed copy from, and
its `credentials.login` is how the daemon logs that copy in and recognises the
result — the daemon holds no list of its own, so a spec entry is the whole
change. If existing parsers are sufficient, no hardcoded factory change is
required.

To add a managed API adapter, add the spec and a concrete adapter class or
runtime-host handler that maps to the stable runtime boundary. Use
`server_runtime_host` only when the server owns the secret release
point.
