# Runtime Adapter Standard

The runtime adapter standard separates product orchestration from vendor
execution tools.

Agent-space owns run lifecycle, accepted Runtime Context Delivery, policy gates, credential
gating, sandbox/worktree governance, artifacts, proposals, and audit/events.
Vendor CLIs such as Claude Code and Codex CLI are local CLI runtime adapters.

`RuntimeAdapterSpec` defines built-in adapter semantics. For server-owned execution
the catalog lives in `server/src/modules/runtimeAdapters/specs.ts`.
Specs cover credential mode, sandbox requirement, invocation template,
permission bypass capability, usage behavior,
output parser, catalog display, executor family, and conservative delegation/
observability/trust claims. Where a runtime exposes a verified config control,
the local CLI renderer must materialize and verify it before execution; the
current Claude Code path denies the runtime-internal `Task` tool, while Codex
remains unknown until conformance evidence exists.
Runtime adapter database rows are not part of the current product schema. Runtime
selection uses an Agent's selected/default `AgentRuntimeProfile`, which is
snapshotted onto each run.

`GenericCliRuntimeAdapter` executes all implemented local CLI specs through the
same command rendering, credential, accepted-Delivery, scoped-Runner, output parser, and
usage provider path. The application server never spawns these vendor
processes. Native adapters are limited to `capability`.

When `run_input.v1` contains tool grants, the generic CLI path configures the
vendor's MCP client for the private Run tool broker. The broker is only a
transport over `AgentToolGateway`/`SystemActionGateway`; registry schemas,
capability and immutable AgentVersion allowlists, policy,
approval/proposal behavior, idempotency, domain executors, and audit remain
server-owned.

Use `/runtime-tools` for CLI binary installation/status, space runtime policy,
and
`RuntimeAdapterSpec` / `adapter_type` for runtime semantics. The old
`/runtime-adapters` instance API is retired.

Runtime tool status is non-mutating: it checks the active allowlisted binary
and installed versions under `$AGENT_SPACE_HOME/runtime-tools` without creating
runs, sandboxes, events, credential grants, or model calls. Installing or
activating tool versions requires the configured `INSTANCE_ADMIN_EMAIL` user.
Space owners/admins choose enabled/default/allowed versions for their own
space; agent versions store the resolved CLI tool version used by runs.

Credential profile binding uses UUID profile ids from
`cli_credential_profiles.id`. Permission bypass is policy controlled and denied
before invocation unless both runtime config and runtime policy allow it under
worktree isolation.

Credential profile readiness requires the selected source path to exist.

Accepted Runtime Context Delivery is rendered directly at the adapter boundary;
its context is not copied into vendor context files. Vendor-specific control
files needed to disable unsupported delegation may still be generated only in
the private run/conversation sandbox. They are never written to the real
Project Folder because agent-space remains the source of truth.

Subscription CLIs are explicit `local_cli` external-egress destinations in the
immutable execution-control snapshot. Preflight and live Delivery authorization
both require the Space external-egress switch and the exact adapter id.

Every file-capable level, including the historical `one_shot_docker` risk
value, is implemented through `SandboxRunnerCliCommandExecutor` and the
dedicated `sandbox-runner` service. The server sends a typed runtime/tool/scope
request with managed mount ids and an explicit egress profile; it cannot send
an executable command, image, host path, shell string, or environment map.
The Runner resolves the selected tool version, constructs an empty-root
bubblewrap mount/PID namespace, and fails closed on request, mount, connection,
or namespace failure. There is no application-server subprocess fallback.
Interactive credential login uses the same Runner through its typed PTY mode.
Subscription credentials receive a short-lived authenticated CONNECT lease
whose host allowlist is fixed by the registered runtime; the CLI never receives
direct access to the default Compose network.

Usage providers are runtime-generic. Adapters without a real probe return
unknown accuracy plus fallback run statistics. Live Claude Code quota uses the
server-owned OAuth API; Codex quota RPC runs through the Sandbox Runner with a
unique run home and workspace. Cached snapshots are scoped to the selected
credential profile, and no quota refresh spawns a vendor CLI in the
application-server namespace.

Output parsers must describe real behavior. Claude Code uses stream JSON with
partial messages enabled. Codex uses its app-server stdio protocol and OpenCode
uses ACP over stdio; those protocol surfaces provide native assistant-text
deltas instead of completion-only CLI envelopes. Supported lifecycle events
are normalized incrementally; unknown vendor payload and text deltas are not
promoted to persisted semantic events.

For stateful CLI runs, the adapter consumes ordered Delivery phases: full
bootstrap or acknowledged-cursor delta first, and the current user item last.
Those phases are separate physical vendor turns; bootstrap responses are not
published as the user-visible result. A durable binding execution lease spans
Delivery preparation, vendor execution, acknowledgement, and session-id
persistence so parallel Workflow nodes cannot mutate one vendor session.
It may resume only the vendor session named by the scoped CLI binding. It does
not fetch context, concatenate a route-authored replay prompt, advance cursors,
or treat vendor archives as canonical state.

To add a new local CLI adapter, add a validated `RuntimeAdapterSpec` and the
corresponding server adapter behavior if command rendering, parsing, or credential
handling differs from the generic local CLI path.
