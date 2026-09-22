# Module: ACP Runtime Adapters

Rainver owns Agent identity, context, policy, tools, Runs and audit. An
Agent's autonomous loop runs in an ACP runtime process launched by an
execution Host daemon. Bounded model calls remain in the Provider subsystem;
they are not Agent runtime adapters.

## Runtime identity and registry

`AgentRuntimeProfile.runtime_key` is the Agent deployment choice. It resolves
through the code-owned runtime registry to an `AgentRuntimeDefinition`.
`RuntimeAdapterSpec` (`runtimeAdapters/specs.ts`) is the authoring catalog and
carries the implementation facts admission, Host installation and process
launch need; `AgentRuntimeDefinition` (`runtimeAdapters/runtimeDefinitions.ts`)
is the narrow ACP-facing projection of that catalog — `runtime_key`, display
name, protocol, supported backend modes — and is what Profile admission,
routing and dispatch read. A projection, not a second Agent authority, and no
execution logic lives there. `getAgentRuntimeDefinition` returns a definition
only for an ACP-backed, implemented runtime, so `isRunnableAgentRuntime` is
exactly "it has a definition"; there is no separate implementation check to
keep in step.

| Runtime key | Current status | ACP launch | Backend modes |
|---|---|---|---|
| `opencode` | implemented | `opencode acp` | Host-native login or ModelProvider proxy |
| `claude_code` | implemented | managed `claude-agent-acp` distribution | Host-native login |
| `codex_cli` | implemented | managed `codex-acp` distribution | Host-native login |

Gemini CLI, generic `custom`, and `capability` entries are not selectable ACP
Agent runtimes. In particular, `model_api` and `ts_agent_host` are not runtime
definitions.

There is one Rainver Agent execution implementation:
`AcpRuntimeAdapter` constructs the shared `AcpController` in
`runs/cliConversationProtocol.ts`. The controller negotiates ACP, creates or
resumes a session, sends prompts, consumes protocol events, handles permission
requests through Rainver's policy path, and reports terminal results. Vendor
specificities belong in the runtime specification/configuration or the Host's
installation distribution, not in parallel Rainver Agent loops. Claude,
Codex, and OpenCode all use ACP; Claude stream-JSON and Codex app-server are
not current execution protocols.

## Run and Host boundary

1. Run creation identifies the Agent and immutable AgentVersion constraints.
   It records a requested Profile when one is explicit; otherwise routing
   selects among that Agent's eligible Profiles.
2. The router checks Profile enablement, ACP implementation, Provider/credential
   eligibility, Host/installation, capabilities, execution mode, isolation,
   workspace and trust. The selected Profile, `runtime_key`, and immutable
   Profile snapshot are stamped before dispatch.
3. The Server prepares and audits Runtime Context Delivery, then sends the Run
   and ACP inputs to the selected Host daemon. Its semantic sections are
   projected into ACP's single user-prompt channel; ACP does not define a
   separate system-message channel. The daemon resolves the installed copy on
   its own machine and owns subprocess lifecycle. The Server does not resolve a
   vendor binary path or add a second direct Agent subprocess path.
4. The daemon returns ACP events and terminal state over the host execution
   protocol. Rainver retains Run finalization, cancellation/recovery,
   artifacts, usage, tool authorization and audit ownership.

The built-in Server Runtime is an execution Host using the same daemon protocol
as a paired Host. Its managed OpenCode version is pinned by the Rainver release
and maintained by Server lifecycle policy; paired Host installs and upgrades
remain explicit Host-owner actions. A runtime that is not installed, healthy,
or reported by its Host fails admission/launch rather than silently switching
to another copy.

## Credentials and backend modes

`runtime_native` uses the runtime's own login on its execution Host. Server
native state is instance-wide; paired-Host native state belongs to that Host's
owner. This sharing must be disclosed for the Server Runtime.

`model_provider` is supported only by runtimes whose registry definition
declares it. The declaration is the spec's `credentials.credential_mode`:
`cli_profile_or_model_provider` yields `supports_model_provider: true`, and
plain `cli_profile` does not. `supportsRuntimeBackendMode` is the only reader
of that fact and the only backend-mode authority; `RuntimeAdapterSpec.model`
carries model-override and rendering facts alone, with no second answer to the
same question (B58). **Today that is OpenCode alone.** Claude Code and
Codex CLI declare `cli_profile`, so their definitions report
`supports_model_provider: false` and `assertBackendModeBinding` answers a
`model_provider` Profile for them with 422 — they run on the Host's own vendor
login. A `model_provider` Profile must name an enabled same-Space Provider, an
explicit model, and an execution Host with an installation; either Host kind
qualifies, because the daemon receives a proxy lease address rather than a key
(`assertProviderExecutionTarget`, `hostProviderProxyBaseUrl`). The Server
authorizes each spend and issues that short-lived lease; runtime-specific proxy
configuration contains only the lease, never the upstream secret. ACP itself
grants no Provider compatibility.

Provider authorization, credential spend, network policy and lease lifecycle
remain owned by `server/src/modules/providers/`. Bounded generation such as
classification or reranking uses ProviderTask policy and usage accounting.
Formal bounded operations needing Run lifecycle use `execution_kind =
provider_task` with ProviderTask control/delivery/snapshot refs; no Agent or
Runtime Profile is fabricated.

## Runtime options and safety

Runtime-specific launch or permission options belong to the Agent's Runtime
Profile, not AgentVersion. AgentVersion remains the authority for behavior and
constraints such as risk, capabilities, tool permissions and output policy.
Live policy, workspace isolation, Host trust and call-time System Action
authorization can narrow execution; runtime selection never grants tools.

The registry declares ACP command/distribution, credential mode, sandbox and
workspace requirements, model/backend support, cancellation and observation
facts. Its subagent-disable declarations describe runtime capabilities only:
the current Host-daemon launch skips the legacy server-local deny-config
writer, so these declarations are not applied to a Run and do not raise its
effective trust above the low baseline. Do not treat declarative capability as
enforcement evidence. External permissions are mediated by Rainver's controller
and policy/tool gateways, not delegated to an independent server-side Agent
loop.

Runtime sessions and continuations are scoped by the owning Conversation or
Host thread. Run snapshots preserve the selected runtime identity and backend
for audit; edits to a live Profile cannot rebind existing Conversation state.

## Source and verification

- Registry/specs: `server/src/modules/runtimeAdapters/specs.ts` and
  `runtimeDefinitions.ts`.
- Single adapter: `server/src/modules/runtimeAdapters/acpRuntimeAdapter.ts`.
- ACP controller: `server/src/modules/runs/cliConversationProtocol.ts`.
- Host dispatch: `server/src/modules/runs/remoteHostCliAdapter.ts` and
  `server/src/modules/hosts/`.
- Runtime provisioning: `server/src/modules/agents/repository.ts` and
  `server/src/modules/hosts/`.
- Bounded provider calls: `server/src/modules/providers/` and
  `server/src/modules/runtimeContext/invocationInventory.ts`.
- Runtime identity, backend modes and public contracts:
  `packages/protocol/src/agents.ts` and `server/src/db/schema/agents.ts`.

Tests should exercise the shared ACP controller and host dispatch, plus
registry admission and Profile backend validation. Do not restore a private
Agent loop or a Provider-backed Agent adapter to obtain a test-only no-login
path.
