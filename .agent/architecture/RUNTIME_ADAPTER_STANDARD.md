# Runtime Adapter Standard

The runtime adapter standard separates product orchestration from vendor
execution tools.

Rainver owns run lifecycle, accepted Runtime Context Delivery, policy gates, credential
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
declares its subagent control `unknown` and is capped at `low` trust by that
declaration alone.
Runtime adapter database rows are not part of the current product schema. Runtime
selection uses an Agent's selected/default `AgentRuntimeProfile`, which is
snapshotted onto each run.

Every implemented local CLI executes through `HostDaemonExecutionAdapter`
and the daemon transport. Non-CLI adapters remain in-process and retain Runtime
Context Delivery. The daemon performs strict isolation on the built-in host
and native execution on a trusted host; the application server never spawns a
vendor process.

**The tool surface is adapter-neutral.** When `run_input.v1` contains tool
grants, the executing side puts the `rainver` command (`packages/agent-cli`)
in front of the Run as an absolute path in `RAINVER_CLI`, writes the Rainver
Work Skill beside it, and appends a pointer to that Skill to the prompt the
runtime is sent. Nothing in that path is keyed on `adapter_type` — an adapter
newly registered from the ACP registry gets the surface with no code added,
which the three per-vendor MCP configuration writers this replaced each
needed. The surface is only a transport over
`AgentToolGateway`/`SystemActionGateway`: registry schemas, capability and
immutable AgentVersion allowlists, policy, approval/proposal behavior,
idempotency, domain executors, and audit remain server-owned.

Use `/api/v1/hosts/:hostId/installations/*` for installing, logging in,
upgrading and rolling back a CLI copy, and `RuntimeAdapterSpec` /
`adapter_type` for runtime semantics. The `/runtime-adapters` and
`/runtime-tools` instance APIs are both retired.

What a host reports about a copy is non-mutating: its id, version, whether it
is logged in, the accounts a multi-account CLI holds, and the version kept
behind it. Reading it creates no run, sandbox, event or model call.

A runtime profile binds a copy by `execution_host_id` + `runtime_installation`;
there is no credential profile to bind, because the copy's login lives on the
host (ADR 0016 §7). Permission bypass is policy controlled and denied before
invocation unless both runtime config and runtime policy allow it under
worktree isolation.

Accepted Runtime Context Delivery is rendered directly at the adapter boundary;
its context is not copied into vendor context files. Vendor-specific control
files needed to disable unsupported delegation may still be generated only in
the private run/conversation sandbox. They are never written to the real
Project Folder because Rainver remains the source of truth.

Subscription CLIs are explicit `local_cli` external-egress destinations in the
immutable execution-control snapshot. Preflight and live Delivery authorization
both require the Space external-egress switch and the exact adapter id.

CLI dispatch carries workspace identity, installation, runtime profile and an
explicit isolation policy over the daemon WebSocket. Strict namespaces enforce
filesystem isolation and fail closed. Verification recipes use `command_run`
with no network; the C3 conformance suite that shared this transport is retired
(2026-09-09, see `modules/hosts.md`). The private Runner protocol and its
application server client are removed. Only `none` confines a Run's network;
`default` and `install` are policy and a record through the daemon's egress
proxy.

Usage providers are runtime-generic. Adapters without a real probe return
unknown accuracy plus fallback run statistics. Live Claude Code quota uses the
server-owned OAuth API. Codex quota comes from an RPC only its own CLI speaks,
so it is read on the execution host that holds the copy and the login; the
server-side probe that ran it beside the application server is gone with the
Runner, and the host-side one lands with the usage work. No quota refresh
spawns a vendor CLI in the application-server namespace.

All three implemented vendor adapters speak ACP over stdio. The server
controller negotiates sessions and consumes semantic events; the daemon only
relays bytes. Host-bound runs resume vendor sessions and receive a prompt plus
work surface, without server-brokered Runtime Context Delivery. In-process
runtimes continue to consume the Runtime Context Gateway.

To add a new local CLI adapter: add its `RuntimeAdapterType` member, add it to
`VendorCliAdapterType`, and add a validated `RuntimeAdapterSpec`. Membership
checks read the spec (`isVendorCliAdapter`, `isAcpRuntimeAdapter`), so a
vendor CLI that speaks ACP natively then dispatches to remote hosts — launch
argv, capability discovery, and the option probe all derive from the spec —
without daemon changes. The compiler then names the per-vendor tables keyed on
`VendorCliAdapterType` that need an entry (subscription egress hosts), and
ModelProvider binding needs vendor-specific config generation
(`runtimeProviderBinding.ts` / `remoteProviderBinding.ts`) if the CLI accepts a
provider at all. Do not add `adapter_type === "<vendor>"` literal checks for
"is this a CLI" — use the predicates.

A builtin ACP adapter also declares how a *managed* copy is obtained on an
execution host (`distribution: { registry_id }`, resolved against the ACP
registry) and how it is logged into (`credentials.login`: PATH command,
`managed_command` inside a tree, `home_subdir`, `credential_file`) — the
server-host login adapters and the daemon both read those fields, so the
knowledge is written once. See `modules/hosts.md` "Installations".

An agent from the ACP registry needs no spec at all: enabling it
(`modules/acpAgents`) publishes a dynamic adapter built from the registry
entry plus low-trust, remote-host-only defaults
(`acpAgentRuntimeAdapterSpec`). Write a builtin spec for such an agent only
when it should get more than that — a ModelProvider binding, subagent
lockdown, usage accounting, server-host execution — each of which is
vendor-specific code, not configuration.
