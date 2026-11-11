# Module: ACP Runtime Adapters

Rainver owns Agent identity, context, policy, tools, Runs and audit. An
Agent's autonomous loop runs in an ACP runtime process launched by an
execution Host daemon. Bounded model calls remain in the Provider subsystem;
they are not Agent runtime adapters.

## Conversation events

All built-in and Registry ACP Agents share the same tool/output normalizer and
Turn presentation. The ACP client advertises display-only terminal output
and session notices, and accepts standard ACP plans; client-side terminal execution and filesystem RPC
remain disabled. Tool updates retain exit/signal/error evidence, file locations
and bounded step diffs in the canonical thread event. Missing output is a
capability gap, never a derived failed status. Technical stderr stays in the
diagnostic disclosure, while authoritative Run failures and typed warning/error
notices remain visible. See [Conversation](../architecture/CONVERSATION.md).

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

OpenCode launches without a CLI working-directory flag. Both capability probes
and Runs set the process working directory and pass `cwd` in ACP session requests.

Beside these builtins, each ACP registry agent an instance admin enables in
`modules/acpAgents` is published as a dynamic adapter `acp_<id>`
(`runtimeAdapters/dynamicSpecs.ts`): implemented, ACP, `remote_host_only`, and
`credential_mode: cli_profile`, so it is a selectable runtime with Host-native
login only.

Antigravity (`acp_antigravity_acp`) uses the official Google CLI’s `agy acp`
entrypoint over ACP v1. Its install/update catalog comes from Google’s CLI
platform manifests, including SHA-512 verification. The Host translates its
Rainver profile selector to `--gemini-dir`, links only the native OAuth token
file, and delivers skills through the official discovery manifest. Models and
configuration options remain runtime-reported; Rainver does not impersonate
another editor to unlock model access.

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

Codex and Claude ACP bridges are repository-managed dependencies. The release
catalog in `packages/protocol/src/acpAdapters.json` names the approved packages;
`pnpm-lock.yaml` records the reproducible dependency graph. Installation and
release preparation verify the catalog against installed packages. Scheduled CI
resolves stable candidates and exercises the current contracts. Tested updates
ship with Rainver and Host releases.

Both personal and managed CLI copies use the Host release's bridge. Managed
native CLIs update independently through a fixed npm recipe, staged version
verification and isolated ACP initialization. Promotion changes the managed
manifest atomically and retains one native CLI rollback target. Login HOME,
installation identity and conversation bindings stay stable. OpenCode and
Registry Agent packages retain their explicit installation lifecycle.

Negotiated identity is bounded to name, version, wire version and supported
capabilities; raw vendor account metadata is not persisted. Completion/usage
metadata records the actual wrapper version and native CLI version separately
from the selected installation. Model attribution prefers reported per-model
`_meta.quota.model_usage` rows, then reported actual model identity and a
concrete selection. `default` remains unknown, never a model name. Claude model
IDs retain release suffixes; a changed suffix is a distinct ledger model.
Codex quota input is already uncached and must not be reduced a second time.
Claude subagent model rows need not sum to parent prompt usage.

Usage Provider groups distinguish native CLI sources by `runtime_key` and keep
actual ModelProvider bindings as their Provider group. Source selectors such as
`cli:codex_cli` work in the Provider filter without creating Provider records.
Event `provider_display_name` includes the CLI name for native usage and the
actual Provider plus the CLI name for proxy usage. These are read projections
over the existing ledger, including historical events; token data is unchanged.

Current Claude/Codex wrappers advertise `_meta.steering.supported` on the
initialize result. Rainver enables active-turn input only for a verified
idle-safe extension contract. It sends `_session/steering` with
`_meta.steering.idleBehavior: "promptRequired"`; an ended turn cannot start an
unowned turn. An unverified idle-safe contract remains unavailable.
The owner/instructor's explicit additional instruction is saved as a canonical
conversation message and pending `run.live_input` command event, then compiled
through Runtime Context with fresh Delivery authority. The exact physical
Delivery binding must still match. Accepted, rejected and unconfirmed outcomes
are acknowledged and audited. One submission is in flight; a lost acknowledgement
never causes an automatic resend. Ordinary Room FIFO messages are unchanged.

The shared controller projects auth-state kinds, compaction transitions,
OpenCode native retry deadlines and declared native subagent lifecycle into
bounded status events. These are informational: no account detail is stored,
no second retry loop is started, and native children are not Rainver Agents.
Only the root and explicitly declared child sessions are accepted. Child text
never becomes the parent's answer. Declared running/background children keep
the process alive after the parent response; Stop cancels the existing process
group. No independent background scheduler or ACP v2 migration is introduced. Claude currently gates some child-session behavior behind its AIR integration; Rainver advertises the standard client capability and does not impersonate AIR.

Current limitations: declared child-session permission requests still pass
through the root-only permission check, and unknown/absent child work states
and error stop reasons are not fully projected. These can fail or retain a
Run; the native subagent integration is partial. Compaction summaries and the
capability descriptor also need completion. Ordinary per-Run process shutdown
prevents the upstream idle-compaction timer from remaining active between
turns. Restart does not resolve these limitations.

The shared controller accepts non-message session metadata while a known
session is being resumed, between context and current-user prompts, or just
after a prompt response. Resume metadata does not acknowledge the resume or
start a prompt: the controller still waits for the matching response, and a
resume error still fails the handshake. Message and thought chunks remain
confined to an active prompt and updates from another session are rejected.

Runtime stderr is preserved as diagnostic events across chunk boundaries,
including the final unterminated line. Runtime state uses structured ACP
notifications rather than vendor-log suppression filters.

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
(the current Claude/Codex wrappers); OpenCode declares
nothing and is not offered it. Room execution rules tell the Agent to ask by
replying instead (`ASK_THE_PERSON_POLICY`). Per-runtime question shapes on a
real host are an open acceptance item in `tasks/deferred-register.md`.

## Run and Host boundary

ACP JSON-RPC failures retain bounded, redacted human diagnostics from the
wrapper and its known `data` fields through `runtimeAdapters/acpFailure.ts`.
Claude's typed `startupFailureReason` distinguishes authentication from workspace/proxy configuration failures. Codex's `codexErrorInfo` and Claude's
native `errorKind` or API error types distinguish subscription exhaustion,
authentication, rate limits, and known transient failures. Raw vendor payloads
are not persisted. An opaque
`-32603` alone is not evidence of a transient failure; `-32000` alone is not
evidence of authentication failure. Authentication is non-retryable
`runtime_auth_required`; known rate/transient failures use the existing bounded
Supervisor policy. A quota/auth/rate/transient refusal during resume preserves
the stored native session; an invalid resume still clears it.

Evidence optionally includes the failing ACP phase and elapsed milliseconds in
that phase. Startup timing begins when initialize is sent, excluding the Host's
workspace queue. A failed controller ignores late frames while its process
drains; a late error cannot overwrite a completed prompt. Failed adapter results
also carry `runtime_target` (Host, runtime, exact installation and backend mode)
into the Run/attempt error evidence, with no native session id or credential.
Failure evidence and optional measurements use the shared protocol schemas.

`packages/host-daemon/test/acpConformance.test.ts` launches the actual resolved
Codex and Claude ACP packages with isolated HOME/config roots and fake native
processes. It reads back model and mode changes, runs synthetic turns, validates per-model usage, consecutive-turn deltas and idle-safe steering, and inherits no ambient credentials or real inference access. CI runs it with the packaged shutdown tests. Scheduled/manual CI resolves current stable candidates every six hours and runs the same contract tests. A local frozen install retains the tested lockfile snapshot. These checks do not validate live account login or upstream
inference availability.

The thread projection suppresses identical bounded tool snapshots by call id;
changed progress, prose boundaries and final outputs remain observable. Late
nonterminal progress cannot reopen a terminal tool call. The semantic event
projection publishes each call's start and each unchanged terminal status once;
replayed full tool frames cannot reopen a terminal call. A repeated-progress
fixture measures 1,002 input frames as three stored tool events (start, changed
progress, completion), rather than 1,002; this is synthetic evidence, not a
production throughput benchmark.

Terminal subscription refusals also use spec-declared text, including Claude's
`session limit` wording. Valid structured reset instants take priority.
`runtimeAdapters/quotaReset.ts` reads spec-declared epochs, explicit delays,
and local reset clocks. Codex's unzoned `try again at 7:10 PM` requires the
executing Host's optional completion `time_zone`; an explicit vendor timezone
takes precedence. The daemon pins the CLI's `TZ` to the reported zone. Older
Hosts remain compatible but cannot disambiguate an unzoned clock. `Intl`
supplies timezone/DST rules, never the server's local zone. Unknown reset prose,
invalid zones and out-of-window timestamps stay unknown. The Supervisor may
park the next physical attempt at the existing subscription gate; see
[Runs and outputs](../architecture/RUNS_AND_OUTPUTS.md#attempts-cancellation-and-supervision).
A runtime that is itself still waiting has not returned a terminal refusal,
so Rainver never creates a concurrent successor. There is no extra vendor
agent loop or native-terminal configuration change.

Reuse / Dependency Check:
- Existing capability: Run Supervisor/attempts, quota gate and minute scheduler, shared Run commands.
- Installed dependencies: existing PostgreSQL/transaction helpers and Zod; native Date/Intl for reset instants.
- External option: OpenHands SDK's ACP error extraction, classification and adapter conformance patterns were evaluated ([source snapshot](https://github.com/OpenHands/software-agent-sdk/tree/232d0b05fa5cd798c9c827d1a1c1aafa541757ad)). Reuse the diagnostic pattern; retain Rainver's redaction, native Host login and single retry authority.
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

A spec may declare `invocation.max_prompt_chars`, the most text one ACP
prompt may carry when the runtime refuses anything longer (Codex: 1,048,576,
its app-server's limit; codex-acp reports a refusal only as "Internal
error"). Before launch `runs/promptInputLimit.ts` counts each prompt's text
and embedded text resources; an oversized turn is not dispatched and fails as
`runtime_input_too_large` with both sizes in its message and a diagnostic
thread event, whatever put the text there. The code is not retryable: the
same prompt fails again. Specs without a stated limit are not checked.

The shared controller counts ACP prompts and records context occupancy/capacity.
Neither is an internal model-call count. `usage_updates` and
`usage_updates_used_total` are counts and sums of occupancy **samples**;
notifications can repeat or reset at compaction, so their sum is not token
spend or processed context volume. Prompt-result token usage is whole-turn for
current Claude/OpenCode and Codex 2.5+. Missing, unverified, preview or
future-major Codex identities have `unknown` scope. The writer exposes only
whole-attempt or unknown scope.
This is derived from actual wrapper identity, not a static per-runtime flag.
Unreported model calls remain unknown, including vendor helper/title calls.
A spec's `usage.prompt_cache_ttl_seconds` remains a preflight notice only.
The accepted Gateway plan's numeric allocation estimate is diagnostic; vendor
transcripts are never read to guess missing measurements. History is not
rewritten by this upgrade. See [execution accounting](../architecture/EXECUTION_MODEL.md).

The built-in Server Runtime is an execution Host using the same daemon protocol
as a paired Host. Its managed OpenCode distribution follows stable Registry discovery and Server lifecycle policy; paired Host installs and upgrades
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

Skill delivery uses the original-package library only: `PgRuntimeSkillProvider`
delegates to `loadSelectedSkills`; acquisition and both Gateway authorization
passes preserve Run scope and revalidate bindings and exact bytes (locking on
the final pass). Hosts materialize accepted Delivery files with their original
hashes and source/planned-item references. There are no normalized Skill
renderers. The Work Skill remains a separate required code contract.

Antigravity CLI reports uncached input and cached reads as separate ACP buckets.
The shared measurement parser preserves those counts with strict nonnegative
values and total consistency checks. An absent or
null optional prompt usage is unknown, not an execution failure. Successful
preauthorization notices remain in the audit trail but are omitted from ordinary
conversation parts; cancellations and errors remain visible.

Independent quota allowances carry `windows[].scope` (`account`, `model`, or
`family`). Claude's shared session/week rows remain account meters; its scoped
weekly rows and Antigravity's model-family buckets never become a maximum-based
account total. Antigravity exposes no overall meter, so its legacy summary
percentages remain unknown. The server also corrects older cached Antigravity
summaries and prefers Claude's named shared meters. A refusal with independently
scoped allowances is not itself proof that the entire login is exhausted.

Interrupted native-login Runs offer an explicit “allow another model and
continue” action when the same installation advertises an alternative. The action
revalidates that catalog, records the selected model in the Run, and enables the
existing recovery scheduler without waiting for the failed model's reset. It
keeps the Host, login, workspace, native session and all other session options.
The existing authority/changed-conversation checks, dispatch locks, cost and
Supervisor attempt caps still apply. The vendor confirms the replacement through
normal ACP model selection; availability not exposed by quota telemetry is
unknown and a further refusal consumes the remaining attempt budget. This is
consent for this interrupted Run, not a global model-routing preference.

Reuse / Dependency Check: reuses quota recovery, the Supervisor's attempt budget,
Host-advertised ACP model options and shared Run controls. This is Rainver-owned
admission/consent behavior, with no new retry engine, dependency or migration.

Explicit “exhausted capacity on this model” / “model quota exhausted” terminal
refusals share the quota recovery path across registered ACP runtimes, in
addition to spec-declared vendor wording. Generic 429/rate limits retain their
existing classification; Provider-bound executions do not enter native-login
quota recovery.

Conversation settings may save advance model-switch consent. It is off by
default and scoped to the conversation's Agent, the person saving it, runtime
profile and runtime key in `sessions.metadata_json.quota_model_switch`. It is
Rainver recovery policy, never an ACP option. The existing authorized settings
transaction saves it with the CLI options. Recovery selects an alternative from
the same installation without another question only when this consent matches;
the normal Supervisor attempt/cost limits still apply. Revocation is checked
again before scheduler admission. Changing person/profile/runtime does not
inherit consent. Without an alternative, recovery retains its waiting controls.

Reuse / Dependency Check: extends the existing settings command, session metadata,
quota model selection and recovery scheduler; no new dependency, migration or
retry mechanism.
