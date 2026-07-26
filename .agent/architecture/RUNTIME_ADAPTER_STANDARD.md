# Runtime Adapter Standard

The runtime adapter standard separates product orchestration from vendor
execution tools.

Agent-space owns run lifecycle, context snapshots, policy gates, credential
gating, sandbox/worktree governance, artifacts, proposals, and audit/events.
Vendor CLIs such as Claude Code and Codex CLI are local CLI runtime adapters.

`RuntimeAdapterSpec` defines built-in adapter semantics. For server-owned execution
the catalog lives in `server/src/modules/runtimeAdapters/specs.ts`.
Specs cover credential mode, sandbox requirement, context
target, invocation template, permission bypass capability, usage behavior,
output parser, catalog display, executor family, and conservative delegation/
observability/trust claims. Where a runtime exposes a verified config control,
the local CLI renderer must materialize and verify it before execution; the
current Claude Code path denies the runtime-internal `Task` tool, while Codex
remains unknown until conformance evidence exists.
Runtime adapter database rows are not part of the current product schema. Runtime
selection uses an Agent's selected/default `AgentRuntimeProfile`, which is
snapshotted onto each run.

`GenericCliRuntimeAdapter` executes all implemented local CLI specs through the
same command rendering, credential, context, subprocess, output parser, and
usage provider path. Native adapters are limited to `capability`.

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

Vendor context files (`CLAUDE.md`, `AGENTS.md`, `prompt.md`) are generated only
inside the run worktree. They are never written to the real Project Folder because
agent-space remains the source of truth for context snapshots and proposals.

`one_shot_docker` is implemented for local CLI specs through the server's
`DockerCliCommandExecutor`. It is network-isolated and resource-bounded; the
executor fails closed if Docker, the configured sandbox image, or an approved
runtime-tool path is unavailable. Provider-proxy/network-profile execution is
not permitted in this MVP Docker mode.

Usage providers are runtime-generic. Adapters without a real probe return
unknown accuracy plus fallback run statistics. Live Claude Code and Codex
quota probes use unique isolated homes, and cached snapshots are scoped to the
selected credential profile.

Output parsers must describe real behavior. Claude Code uses stream JSON with
partial messages enabled. Codex uses its app-server stdio protocol and OpenCode
uses ACP over stdio; those protocol surfaces provide native assistant-text
deltas instead of completion-only CLI envelopes. Supported lifecycle events
are normalized incrementally; unknown vendor payload and text deltas are not
promoted to persisted semantic events.

To add a new local CLI adapter, add a validated `RuntimeAdapterSpec` and the
corresponding server adapter behavior if command rendering, parsing, or credential
handling differs from the generic local CLI path.
