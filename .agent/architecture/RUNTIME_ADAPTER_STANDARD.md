# Runtime Adapter Standard

The runtime adapter standard separates product orchestration from vendor
execution tools.

Rainver owns run lifecycle, accepted Runtime Context Delivery, policy gates, credential
gating, sandbox/worktree governance, artifacts, proposals, and audit/events.
Vendor CLIs such as Claude Code and Codex CLI are local CLI runtime adapters.

`RuntimeAdapterSpec` defines built-in launch, credential, capability, usage and
distribution facts. The code-owned catalog lives in
`server/src/modules/runtimeAdapters/specs.ts`; `AgentRuntimeDefinition` exposes
only selectable ACP runtimes. Runtime adapter database rows are not part of
the product schema. Runtime selection uses the Agent's selected/default
`AgentRuntimeProfile`, which is snapshotted onto each Run.

Do not treat declarative subagent-control or trust metadata as enforcement.
The current Host-daemon launch does not apply the legacy server-local deny
configuration; those claims do not raise the effective trust level. Rainver
still owns tool grants, policy decisions and the Host isolation boundary.

Every implemented Agent runtime is a local CLI using ACP. The Server routes
Runs through `AcpRuntimeAdapter` / `AcpController` and the selected Host
daemon; there is no in-process Agent loop or second runtime protocol. The same
daemon contract serves the built-in Server Runtime and paired Hosts, with
strict isolation on the built-in Host and owner-managed execution on paired
Hosts. The application server never spawns a vendor process.

**The tool surface is adapter-neutral.** When `run_input.v1` contains tool
grants, the executing side puts the `rainver` command (`packages/agent-cli`)
in front of the Run as an absolute path in `RAINVER_CLI`, writes the Rainver
Work Skill beside it, and appends a pointer to that Skill to the prompt the
runtime is sent. Nothing in that path is keyed on `runtime_key` — an adapter
newly registered from the ACP registry gets the surface with no code added,
which the three per-vendor MCP configuration writers this replaced each
needed. The surface is only a transport over
`AgentToolGateway`/`SystemActionGateway`: registry schemas, capability and
immutable AgentVersion allowlists, policy, approval/proposal behavior,
idempotency, domain executors, and audit remain server-owned.

Use `/api/v1/hosts/:hostId/installations/*` for installing, logging in,
upgrading and rolling back a CLI copy, and `AgentRuntimeDefinition` plus its
`RuntimeAdapterSpec` for runtime semantics. `runtime_key` is the one name a
runtime has on the host wire and in a managed installation's manifest; there is
no second identity field. The `/runtime-adapters` and `/runtime-tools` instance
APIs are both retired.

What a host reports about a copy is non-mutating: its id, version, whether it
is logged in, the accounts a multi-account CLI holds, and the version kept
behind it. Reading it creates no run, sandbox, event or model call.

A runtime profile binds a copy by `execution_host_id` + `runtime_installation`;
there is no credential profile to bind, because the copy's login lives on the
host (ADR 0016 §7). Permission bypass is policy controlled and denied before
invocation unless both runtime config and runtime policy allow it under
worktree isolation.

Accepted Runtime Context Delivery is assembled by the Server and projected
into ACP's prompt channel; the Host daemon relays the ACP transport and owns
the runtime process. Runtime context is not copied into the real Project
Folder. Host workspace isolation is enforced by the daemon namespace, not by
the `PathPolicy` used for Rainver-mediated file operations.

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

All implemented builtin runtimes speak ACP over stdio. The Server controller
negotiates or resumes sessions and consumes semantic events; the daemon
relays bytes and owns subprocess lifecycle. Host-bound Runs receive the
Server-prepared prompt and work surface over the same ACP path.

To add a builtin runtime, define its canonical `runtime_key`, validated
`RuntimeAdapterSpec`, and `AgentRuntimeDefinition`; it must declare ACP and
pass the implemented-runtime admission checks. Launch, capability discovery,
and option probes derive from those definitions, so the shared Host daemon
needs no per-runtime execution loop. ModelProvider support, where appropriate,
still needs explicit runtime configuration and compatibility tests in
`runs/adapterProviderRequirement.ts` / `runs/remoteProviderBinding.ts`. Use registry
predicates such as `isAcpRuntimeAdapter`; do not create parallel protocol
drivers or legacy runtime-identity branches.

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
