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

Beside these builtins, each ACP registry agent an instance admin enables in
`modules/acpAgents` is published as a dynamic adapter `acp_<id>`
(`runtimeAdapters/dynamicSpecs.ts`): implemented, ACP, `remote_host_only`, and
`credential_mode: cli_profile`, so it is a selectable runtime with Host-native
login only.

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

The pinned Claude ACP 0.70.0 and Codex ACP 1.12.0 distributions both advertise
`_meta.steering.supported` at initialization and implement the
`_session/steering` extension with `{ sessionId, prompt: ContentBlock[] }`.
Rainver does not expose that extension: its controller receives its prompt
list at construction and closes stdin after that list completes. The Host's
duplex transport is sufficient, but no runtime option enables live input in
the current product. Conversation queueing still waits for the turn boundary.
Claude injects active-turn steering with `priority: "now"`; its separate
`claudeCode.promptQueueing` capability is not the same operation. Claude can
refuse idle steering without starting work via
`_meta.steering.idleBehavior: "promptRequired"`. The pinned Codex adapter has
no such idle option: it can return `startedNewTurn` and start work when the
original turn finishes before injection. A future integration must keep that
work tracked, authorize and record the new input through Runtime Context,
and bind its acknowledgement to the correct Run, attempt and CLI lease;
concurrent ordinary `session/prompt` calls are not a portable substitute.
See the mid-turn steering entry in the
[deferred register](../tasks/deferred-register.md).

The shared controller accepts non-message session metadata while a known
session is being resumed, between context and current-user prompts, or just
after a prompt response. Resume metadata does not acknowledge the resume or
start a prompt: the controller still waits for the matching response, and a
resume error still fails the handshake. Message and thought chunks remain
confined to an active prompt and updates from another session are rejected.

Claude ACP 0.70 logs the unhandled SDK `system/permission_check_status`
metadata as `Unexpected case: <JSON>` on stderr. The thread-event projection
recognizes that exact diagnostic for `claude_code` and omits it from the
conversation, including split chunks and a final line without a newline.
Other stderr, malformed JSON and unknown message kinds remain diagnostics.
This does not acknowledge a permission request or change Run failure handling;
the Host still relays the original stderr. Keep vendor recognition in
`runtimeAdapters/runtimeDiagnostic.ts`, rather than matching words in the UI.

Model picker values are not necessarily all the model identifiers an adapter
accepts. The Claude adapter also resolves aliases in `session/set_config_option`
(for example, `fable` to a canonical model id). Its spec declares
`model.acp_model_aliases`; the shared controller sends an unlisted model alias
to that adapter and waits for a successful response with a canonical picker
value before prompting. A picker value alone does not prove the alias was
honoured — an adapter that ignores an unknown alias echoes its unchanged
default — so the response must either move the session to another value or
name the alias (the choice's display name, or a dash-separated word of its
canonical id such as `fable` in `claude-fable-5-1`). Otherwise the Run fails,
or, for a saved selection, keeps the runtime default with a dropped-selection
notice. Usage attribution uses that returned value. Rainver
does not keep its own alias map. Explicit picker selections still require an
exact acknowledgement, as do non-model options; other runtimes retain exact
validation unless their spec declares alias support. An already-current value
can be retained even when the picker omits it, as can happen on session resume.
Rainver's `initialize` opts into boolean session options, so an adapter may
advertise a toggle (Codex `fast-mode`, Claude `fast`) as `type: "boolean"`;
the controller then sets it as `{ type: "boolean", value }`, the protocol's
discriminated request shape, which schema-validating adapters require.

Interactive requests from the runtime. There is no "ask the person and
suspend" tool: an Agent asks by ending its turn with the question, and the
vendor session keeps its working state for the answer, which is the person's
next message. A vendor CLI's own interactive question is translated into that
shape rather than approved or treated as a failure. A
`session/request_permission` is a tool permission and is pre-authorized
through `runPermissionPolicy.ts`, unless the runtime's
`RuntimeAdapterSpec.interaction.question_detector` says that shape is a
question (Claude Code: a request naming no `toolCall`). A question — that, an
`elicitation/create` form, or any other interactive method except the
capability-gated `fs/*` and `terminal/*`, which still refuse and fail the Run —
is answered with the protocol's cancel (`cancelled` outcome, `action:
"cancel"`, or a `-32601` refusal), preceded by `session/cancel`; the prompt then
completes on whatever stop reason or error it ends with, and the controller's
result carries `asked_user: { question, options }` (`runs/vendorQuestion.ts`
reads the form). The Run succeeds; see CONVERSATION.md for the reply. The
detector's `form_elicitation` also makes the controller advertise
`clientCapabilities.elicitation.form`, which is what makes Claude Code offer
AskUserQuestion and Codex's `request_user_input` reach the client at all
(claude-agent-acp 0.70 and codex-acp 1.12); OpenCode declares
nothing and is not offered it. Room execution rules tell the Agent to ask by
replying instead (`ASK_THE_PERSON_POLICY`). Per-runtime question shapes on a
real host are an open acceptance item in `tasks/deferred-register.md`.

## Run and Host boundary

Terminal subscription refusals are normalized by the runtime spec, including
Claude's `session limit` wording. `runtimeAdapters/quotaReset.ts` reads only
spec-declared reset formats; Claude's epoch and a clock with an IANA timezone
are supported. `Intl` supplies timezone/DST rules, never the server's local
zone. Unknown reset prose stays unknown. The Supervisor may park the next
physical attempt at the existing subscription gate; see
[Runs and outputs](../architecture/RUNS_AND_OUTPUTS.md#attempts-cancellation-and-supervision).
A runtime that is itself still waiting has not returned a terminal refusal,
so Rainver never creates a concurrent successor. There is no extra vendor
agent loop or native-terminal configuration change.

Reuse / Dependency Check:
- Existing capability: Run Supervisor/attempts, quota gate and minute scheduler, shared Run commands.
- Installed dependencies: existing PostgreSQL/transaction helpers and Zod; native Date/Intl for reset instants.
- External option: n/a for Run intent, authorization and continuation semantics; the scheduler already exists.
- Approach: extend these existing mechanisms, with no new dependency or migration.
- Reason: one durable admission and cancellation authority prevents competing retry engines.

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

The shared controller counts the ACP prompts it actually sends, including a
context phase when present, and reports the runtime's last valid context
occupancy/capacity. Neither is an internal model-call count. The server adds
the accepted Gateway plan's numeric allocation estimate to usage diagnostics;
it never reads vendor transcripts to guess missing measurements. Unreported
model calls are unknown, including legacy aggregate CLI observations. See
[execution accounting](../architecture/EXECUTION_MODEL.md) for the ledger and
Usage page semantics. This does not require an execution Host protocol change.

The built-in Server Runtime is an execution Host using the same daemon protocol
as a paired Host. Its managed OpenCode version is pinned by the Rainver release
and maintained by Server lifecycle policy; paired Host installs and upgrades
remain explicit Host-owner actions. A runtime that is not installed, healthy,
or reported by its Host fails admission/launch rather than silently switching
to another copy.

ACP Agent Runs have no default elapsed-time budget, and the legacy
AgentVersion `max_run_time_seconds` and adapter `timeout` values never limit
them. An explicitly set limit is enforced: the Run contract's
`max_duration_seconds` or a dispatch's `timeout_ms`, the shorter of the two,
stops the attempt server-side through the normal stop path and fails it as
`run_timed_out` (`runs/runTimeLimit.ts`; `modules/hosts.md`, "no default
whole-run time budget"). The launch frame sends no deadline, and the daemon
ignores launch deadlines. Explicit stop, runtime completion/failure and
connection loss still apply. Silence after launch (300 seconds by default, configured through
the legacy `stall_timeout_seconds` option) produces one neutral waiting notice
per Run. It never terminates execution, reports failure, or invalidates a stored
session. Both stdout and stderr count as output; queued processes do not trigger
this notice. The observation timer is cleared on completion or failure.
Linux Run work surfaces use the Host's private file tool channel when both
server and Host support `file-v1`. Commands need no network permission for
Rainver actions. The controller negotiates ACP `additionalDirectories`; the
Host resolves only the current launch's IPC directory into session setup,
including resume. This uses the shared controller, adds no vendor protocol,
and changes no model or command-network setting. See
[System Actions](../architecture/SYSTEM_ACTIONS.md) for identity, request bounds
and older-Host behavior.
Provider leases and work-surface identities use renewable 15-minute lifetimes,
refreshed every minute while execution is active and revoked when it ends.
Renewal cannot revive an expired/revoked identity or another attempt's token.

## Credentials and backend modes

`runtime_native` uses the runtime's own provider/account state on its execution
Host, when a selected model needs one. ACP `session/new` can also succeed with
no native login and advertise model-category `configOptions`; the shared
conversation selector offers those choices without a vendor-specific model
catalog. `logged_in` remains account state, while ACP session availability is
reported separately. Server native state is instance-wide; paired-Host native
state belongs to that Host's owner. This sharing must be disclosed for the
Server Runtime.

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
login. A `model_provider` Profile must name an enabled Provider granted to the Space, an
explicit model, and an execution Host with an installation; either Host kind
qualifies, because the daemon receives a proxy lease address rather than a key
(`assertProviderExecutionTarget`, `hostProviderProxyBaseUrl`). The Server
authorizes each spend and issues that short-lived lease; runtime-specific proxy
configuration contains only the lease, never the upstream secret. ACP itself
grants no Provider compatibility.

Which endpoint and proxy route a binding uses is the spec's
`model.provider_api`. OpenCode declares `vendor`: the binding follows the bound
Provider's vendor protocol (`providers/vendors.ts`), resolved by
`runs/adapterProviderRequirement.ts`. An `anthropic_messages` vendor binds on
its `claude_compatible_base_url` with an `anthropic`-route lease and is
registered in OpenCode as `@ai-sdk/anthropic` (so OpenCode applies its own
Anthropic prompt-cache breakpoints); an `openai_completions` vendor binds on
its `openai_compatible_base_url` with an `openai`-route lease as
`@ai-sdk/openai-compatible`. Any other protocol is refused
(`provider_protocol_unsupported`) before a lease is minted. The OpenCode
provider id is `rainver_provider` either way. Retrieval egress classification
(`runtimeProviderEgressDestination`) reads the same resolution. An OpenCode
profile bound to an Anthropic-protocol Provider that has
only an OpenAI-compatible URL fails its dispatch with
`claude_compatible_base_url_required` and is greyed out in the Provider
selector; add the Provider's Claude-compatible URL or bind a
different Provider. Nothing rewrites such a binding automatically.

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
the Host-daemon launch sets `skip_subagent_disable_check`, so these
declarations are not applied to a Run and do not raise its effective trust
above the low baseline. Do not treat declarative capability as
enforcement evidence. External permissions are mediated by Rainver's controller
and policy/tool gateways, not delegated to an independent server-side Agent
loop.

Runtime sessions and continuations are scoped by the owning Conversation or
Host thread. Run snapshots preserve the selected runtime identity and backend
for audit; edits to a live Profile cannot rebind existing Conversation state.

Conversation tool results retain the execution-reported state for audit. When a
failed tool result contains a parsed nonzero process exit code, the conversation
shows the numeric exit code with neutral styling and explains that it may mean
no matches, differences, or command failure. It does not infer success from a
command name or downgrade the Run's terminal failure. Tool failures without a
process exit code keep their error indicator.

### Model observation

After all requested options have been acknowledged, the shared ACP controller
reports the model-category option's current value at prompt dispatch and on
subsequent in-prompt option updates. Missing requested model options fail before
prompting rather than silently using a default. The adapter serializes these
observations to `runs.model_override_json.runtime_reported_model`, clearing the
previous attempt's report before launch. `default` and absent reports remain
unknown; a request or a Provider binding alone is not runtime confirmation.
Run/Turn read models expose requested and reported values separately. This
identifies what ACP reports, not an independently verified upstream model when
the adapter exposes only an alias.

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
