# Module: Runtime Tools And Adapter Types

Agent-space owns agents, runs, Runtime Context Delivery, policy, credential gating,
worktree governance, artifacts, proposals, audit records, and events. Vendor
CLIs are runtime adapter types, but their binaries are installed as controlled
runtime tools.

## Canonical Standard

`RuntimeAdapterSpec` is the source of truth for adapter behavior. Built-in specs
live in `server/src/modules/runtimeAdapters/specs.ts`. Specs define:

- runtime kind and implementation status
- runtime tool requirement, command argv template, and parser behavior
- accepted Delivery rendering behavior
- credential mode and credential profile runtime name
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
| `claude_code` | local_cli | implemented | `cli_profile` | accepted Delivery | Sandbox Runner |
| `codex_cli` | local_cli | implemented | `cli_profile` | accepted Delivery | Sandbox Runner |
| `opencode` | local_cli | implemented (low trust pending C3) | `cli_profile` | accepted Delivery + locked agent control | Sandbox Runner |
| `gemini_cli` | local_cli | planned | disabled | prompt/custom | worktree |
| `custom` | custom | planned | disabled | custom | custom |

Planned adapters may appear in code/catalog metadata but cannot be enabled or
executed. Implemented local CLI adapters support `one_shot_docker` through the
Docker executor. Critical runs fail closed if the configured image, daemon, or
runtime-tool mount is unavailable; they never downgrade to worktree execution.

Conformance is persisted per runtime tool version in
`runtime_conformance_results`. The C3 evaluator requires all five MVP checks —
file-scope obedience, subagent-attempt detection, cancellation reliability,
structured-output compliance, and credential leakage — to be explicitly
observed before recording `passed`. Missing or failed checks remain low trust;
the router therefore cannot select OpenCode for non-low-risk work without a
passed result.

## Product API Surface

Runtime tool installation and status are server-owned:

- `GET /api/v1/runtime-tools/catalog`
- `GET /api/v1/runtime-tools`
- `GET /api/v1/runtime-tools/{runtime}`
- `GET /api/v1/runtime-tools/space-policy`
- `GET /api/v1/runtime-tools/space-policy/{runtime}`
- `PUT /api/v1/runtime-tools/space-policy/{runtime}`
- `POST /api/v1/runtime-tools/{runtime}/install`
- `POST /api/v1/runtime-tools/{runtime}/activate`

Runtime tool installs are instance operations. `INSTANCE_ADMIN_EMAIL` identifies
the single user allowed to install or activate CLI tool versions. Space
owners/admins do not install binaries; they manage `space_runtime_tool_policies`
for their space: enabled/disabled state, default version, and optional allowed
version list. Runtime tool installs run npm from the server container. The
compose server service passes proxy and npm network settings (`HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NPM_CONFIG_REGISTRY`,
`NPM_CONFIG_STRICT_SSL`, and `NPM_CONFIG_CAFILE`) into the container, and the
server allowlists only network settings for the npm subprocess. Provider API
keys and CLI credentials must not be passed through this path.

CLI credential login and status are served by the server providers/credentials
authority under `/api/v1/credentials/cli/*`. The frontend runtime page is
`/runtime-tools`.

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
   `server/src/modules/runs/vendorCliAdapter.ts`. Shared local CLI execution
   details are split by responsibility: command rendering in
   `cliCommandRendering.ts`, subprocess execution and process registration in
   `localCliExecution.ts`, subprocess env allowlisting in `cliSubprocessEnv.ts`,
   runtime provider binding in `runtimeProviderBinding.ts`, and Codex/OpenCode
   config materialization in `codexProviderConfig.ts` and the subagent config
   helper.
5. For local CLI runtimes, `RunOrchestrationService` resolves the run's
   effective tool version from immutable
   `Run.runtime_profile_snapshot_json.runtime_config_json`, active-space
   `space_runtime_tool_policies`, and installed instance tool versions.
   Disabled, disallowed, or missing versions fail closed before credential
   release. `RuntimeToolRegistry` then resolves that exact installed version
   under `$AGENT_SPACE_HOME/runtime-tools/<runtime>/versions/<version>`.
6. Credential profiles are granted through the server CLI credential broker.
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
   means no base URL override; the CLI uses its managed login state and the
   CLI credential profile's default NetworkProfile, if one is configured.
   OpenCode can use a CLI profile or a run-scoped ModelProvider binding. It runs
   through the ACP stdio protocol with a sandbox `--cwd` and a run-scoped
   `opencode.json` that makes `agent-space-locked` the primary default agent,
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
    agent-space contexts.

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

## Controlled CLI Tool Installation

Vendor CLIs are not installed into backend, server, or sandbox Docker
images. They are instance runtime state under:

```
$AGENT_SPACE_HOME/runtime-tools/
  claude_code/
    versions/<version>/
      tool.json
      node_modules/.bin/claude
    active -> versions/<version>
  codex_cli/
    versions/<version>/
      tool.json
      node_modules/.bin/codex
    active -> versions/<version>
  opencode/
    versions/<version>/
      tool.json
      node_modules/.bin/opencode
    active -> versions/<version>
```

The server-owned `runtimeTools` module provides the controlled installer. The
installer is restricted to the configured instance admin and accepts only
code-allowlisted runtime/package mappings:

| runtime | package | bin |
|---|---|---|
| `claude_code` | `@anthropic-ai/claude-code` | `claude` |
| `codex_cli` | `@openai/codex` | `codex` |
| `opencode` | `opencode-ai` | `opencode` |

It invokes `npm` with argv (`shell=false`) and writes into
`$AGENT_SPACE_HOME/runtime-tools`; npm cache is under
`$AGENT_SPACE_HOME/cache/npm`. API callers cannot provide arbitrary package
names or shell commands. The installer passes through only npm network
configuration such as proxy, registry, strict-ssl, cafile, and fetch retry env
vars; provider/API tokens are not inherited. Codex CLI and Claude Code validate
their platform native optional packages (for example
`@openai/codex-linux-x64` and `@anthropic-ai/claude-code-linux-x64`) and
explicitly install the package spec declared by `optionalDependencies` when npm
does not materialize it automatically. Claude Code also reruns its fixed
postinstall script so the wrapper package places the native binary under
`bin/claude.exe`. OpenCode installs its wrapper with postinstall disabled, then
selects and copies only the libc-compatible package for the server container;
this avoids the upstream postinstall probe choosing a musl package in a glibc
container. CLI login resolves the instance active binary through
`RuntimeToolRegistry`. Runtime execution resolves the version pinned on
`AgentRuntimeProfile.runtime_config_json.runtime_tool_version`, after applying
the active-space runtime policy. Neither path falls back to ambient PATH or
image-global installs.

## Space Runtime Version Policy

Installed CLI binaries are shared instance state; spaces do not own separate
installs. Each space can set a policy row per CLI runtime:

- `enabled=false` blocks that runtime in the space.
- `default_version` is used when an agent does not request a version.
- `allowed_versions_json` optionally constrains which installed versions can be
  selected in that space. Empty means any installed version is allowed.

Agent create/update resolves the effective CLI tool version and stores it on
the default `AgentRuntimeProfile.runtime_config_json.runtime_tool_version`. Runs
snapshot the selected profile at creation; HTTP workflow execution selects a
runtime profile instead of overriding adapter config. If the pinned version is
later uninstalled, disabled, or removed from the space allowlist, the run fails
closed with `runtime_tool_version_unavailable` before credential resolution.

## Credential Profile Binding

CLI credential profile ids are UUIDs from `cli_credential_profiles.id`.
They are user-owned and selected through the user × session conversation
backend binding. The router snapshots the selected profile id into the Run at
creation. Shared Agent runtime profiles contain no credential reference.

CLI runs fail closed with `runtime_credential_profile_required` when a required
profile is missing. No ambient HOME or inherited API-key fallback is allowed.
`credential_id` remains reserved for DB/vault credentials and model-provider
API keys.

Credential audit rows record metadata only: adapter type, credential profile id,
trigger origin, fallback flags/reason, and cleanup status. Raw tokens, HOME
paths, and credential file content are never stored.

OpenCode CLI login state is brokered from its documented
`~/.local/share/opencode/auth.json` location into an isolated credential home;
the host user's home and OpenCode session database are never used by the run.
Provider-backed OpenCode runs also receive a clean private `HOME`, without a
CLI login profile.

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
excluded from backup, and separate from the shared credential profile. A
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

CLI quota probe homes are unique per probe and removed in `finally`. Cached
quota snapshots are partitioned by runtime and credential profile id so one
user's subscription state cannot be returned for another profile.

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
Research never accepts CLI credential profiles, OpenCode, Claude Code, or Codex
runtime values. Those runtimes remain available to generic Agent and Coding
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
Local CLI adapters use the same `AgentToolGateway` through the Run-scoped MCP
transport rather than a separate tool authority.

## Permission Bypass

Permission bypass is disabled by default. It can be used only when:

- the spec declares support
- the run's snapshotted runtime profile config requests `permission_bypass`
- the run's snapshotted runtime profile policy allows `allow_permission_bypass`
- the run is high or critical risk
- execution uses a worktree workspace

Blocked requests fail before invocation with `permission_bypass_not_allowed`.

## Isolation Limits

Low/medium-risk Folder-bound CLI runs use `read_only`: the real Project Folder
is exposed by Sandbox Runner through a rootless bubblewrap mount namespace with
an OS-enforced read-only view. The brokered HOME and Run Exchange output are the
only persistent writable mounts. The namespace begins with an empty filesystem and exposes only
system runtime trees, exact DNS/NSS/linker/CA configuration files (not the
whole `/etc`), runtime tools, the current Folder view, the current
brokered HOME, and Run Exchange input/output; other host paths, spaces,
credential profiles, and runtime-state directories are not readable. Network remains shared for
subscription access. Official
Compose relaxes its seccomp profile solely because Docker's built-in profile
blocks rootless namespace creation; it grants no capabilities or privileged
mode. Namespace preflight failure is terminal and never downgrades to a normal
subprocess.

Worktree isolation protects repository state and proposal review flow for
high-risk mutation. It does not provide OS, process, network, or resource
isolation. Runtime Context Delivery is passed directly to the CLI adapter and
is not written into vendor context files. Any vendor control file used to
disable unsupported delegation is generated only in the private worktree, so
real Project Folder files such as `CLAUDE.md`, `AGENTS.md`, or `prompt.md` are
never mutated by runtime execution.

`one_shot_docker` is the critical-risk execution mode for implemented local CLI
adapters. The executor uses a deny-by-default network namespace, read-only
container root, dropped capabilities, no-new-privileges, bounded PID/CPU/memory
resources, and at most one read-only credential mount. Networked provider proxy
leases are rejected until an egress-enabled profile has its own policy review.

## Usage And Output Parsing

The retired `/runtime-adapters/*/usage` endpoint is not part of the current
product. Run history and trace read models remain the source for execution
evidence, while token accounting lives under `/usage`: managed provider calls
and provider-proxy responses emit ledger events, subscription CLI runs emit
Run-attributed `local_cli` events from their exact runtime envelopes, and
managed CLI profiles can import transcript-derived lower bounds only as a
recovery path. Claude's live `rate_limit_event` updates the selected profile's
quota cache. CLI quota snapshots remain under `/credentials/cli/usage*` and
are not token-accounting events.

Claude Code uses its structured JSON stream; Codex uses app-server JSON-RPC;
OpenCode uses ACP JSON-RPC. Their protocol controllers validate scoped
responses and terminal usage before producing the adapter envelope. Output
text remains normalized, stdout/stderr are redacted, and nonzero/timeout errors
use stable codes. Raw output and transcripts are not stored in the usage
ledger.

## Adding an Adapter

To add a new local CLI runtime, add a validated `RuntimeAdapterSpec` with
invocation, context, credentials, sandbox, model, permission, usage, and output
sections, then add a `RuntimeToolRegistry` allowlist entry for the installable
tool package/bin. If existing parsers are sufficient, no hardcoded factory
change is required.

To add a managed API adapter, add the spec and a concrete adapter class or
runtime-host handler that maps to the stable runtime boundary. Use
`server_runtime_host` only when the server owns the secret release
point.
