# Module: Hosts

See [decisions/0016-control-plane-execution-hosts.md](../decisions/0016-control-plane-execution-hosts.md)
for the design decision this module implements. The phase-1 rollout plan
(`control-center-plan.md`) is retired — execution ledger in git history, as is
phase 2's (`control-center-phase2-plan.md`, which shipped the conversational
thread surface, normalized event pipeline, and setup simplification). So is the ACP runtime replatform plan (P1-P5, complete 2026-08-22, plan
document retired 2026-08-23): every conversation runtime — `claude_code`,
`codex_cli`, `opencode` — now speaks the Agent Client Protocol exclusively on
both the server-host and remote-host execution paths; the self-maintained
vendor CLI protocol implementations (stream-json argv, NDJSON-RPC) it
replaced are deleted. So is the remote-host provider-binding plan
(`remote-host-provider-binding-plan.md`, P1–P2 shipped in `404b1b87` and the
commits that followed, retired 2026-08-28): its shipped state is the
"Model-backend binding" material below (host×adapter defaults, the
`provider_binding` launch frame, host-side profile materialization, the B67
allowlist at spawn); its open real-host acceptance items are in the deferred
register's multi-host section and its two actionable leftovers in
`plans/backlog.md` §8. **This document describes the ACP-based system as it
stands today.**

## Purpose

`hosts` is the control-plane registry of ExecutionHosts: the server host
(exactly one row, seeded automatically, `owner_user_id` NULL) and any
personal machine a user has paired in trusted-host mode. It owns pairing,
authentication, and liveness for hosts — it does not execute anything itself
and does not know any host's real filesystem paths.

## Data model

`server/src/db/schema/hosts.ts` and `server/src/db/schema/machines.ts` model
the physical topology:

- `machines` identifies a physical device. It has no filesystem path or
  runtime capability state.
- `hosts` identifies one execution environment on a Machine. The server has
  exactly one seeded `server` Host; a personal Machine may have multiple
  remote Hosts such as native Windows and WSL.
- `workspace_locations` (in `projectFolders/workspaceLocations.ts`) binds a
  logical Project Folder to one Host. A Folder may have several Locations;
  Location owns path/display metadata, lifecycle status, git observations,
  and persisted `execution_ready`. Exactly one Location may be `active` for
  new work. Explicit activation demotes the former active checkout to `stale`:
  initialized Conversations pinned there may continue, while drafts and new
  attachments see only the new active Location. `archived` is non-executable.

`server/src/db/schema/hosts.ts` — Host fields:

- `kind`: `server` (exactly one row ever, enforced by
  `uq_hosts_single_server`) or `remote`.
- `status`: `pending_pairing` → `offline` → `online` (round-trips on
  connect/disconnect) → `revoked` (terminal).
- `token_hash` doubles as the pairing-code hash before registration and the
  long-lived bearer-token hash afterward — a pairing code **is** a host row
  in `pending_pairing` status; there is no separate pairing-code table.
- `owner_user_id` is NULL only for the server host (`ck_hosts_server_no_owner`
  / `ck_hosts_remote_has_owner`); every remote host has exactly one owner.
- `machine_id` and `environment_kind` are required. Location retains a
  constrained `execution_host_kind` copy of `hosts.kind` for database-level
  remote-root and scope invariants.
- `agent_runtime_profiles.workspace_mode` is `location` for a registered
  Project directory and `managed` for a daemon-created private root. Managed
  profiles carry no Workspace Location; the server stores only Agent and
  container identity.
- `hosts.managed_workspaces_json` is the daemon's bounded heartbeat inventory
  of managed Agent × container directories and archive availability. It never
  contains a filesystem path.

Managed workspaces are daemon-owned directories, not Workspace Locations. A
launch names an Agent and either a Conversation id or the direct owner's user
id; the daemon derives the directory under its private config root. The server can
request archive/restore actions and records a pending archive when the daemon
is offline, but it never receives or stores the derived path.

## Server-host guard (ADR 0016 B62)

`assertServerHostLocation()` (`server/src/modules/projectFolders/workspaceLocations.ts`)
throws before any server-host local-filesystem operation runs against a Location whose
`execution_host_kind` is not `server`. It gates server-host `PgRunSandboxManager.prepareRunWorkspace`
(`server/src/modules/projectFolders/sandbox.ts`), code-patch proposal apply
(`server/src/modules/projectFolders/codePatch.ts`), and code-patch rollback
(`server/src/modules/proposals/applyService.ts`) — every code path capable of
touching disk. The last two are unreachable for a remote-host row today (no
Run can currently produce a `code_patch` proposal against one, since proposal
creation only happens downstream of the already-guarded sandbox-prep path),
but the guard is placed at the point of disk access rather than relied on as
an emergent property of the call graph — a future P2/P3 change to how
proposals get created cannot silently reopen this.

## REST surface (`server/src/modules/hosts/routes.ts`)

User-session authenticated (`getCurrentUser`/`sessionTokenFromRequest`,
matching `spaces` routes — hosts are user-scoped, not Space-scoped):

- `POST /api/v1/hosts/pairing-codes` — `{ name }` → `{ host_id, pairing_code, expires_at }` (10 min TTL).
- `GET /api/v1/hosts` — the server host plus every remote host the caller owns.
- `GET /api/v1/hosts/execution-targets?project_id=` — the caller's online
  remote hosts and ACP installations. Without `project_id`, hosts have no
  registered Locations; with it, only Locations in that readable Project are
  returned. Every target advertises the managed-workspace choice. This is the
  canonical Host/CLI/Workspace candidate projection for both Project Settings
  and Conversation first-Run setup; neither surface derives a separate list
  from Agent runtime profiles.
- `POST /api/v1/hosts/:hostId/revoke` — terminal; a revoked host's token stops
  authenticating. Also closes the host's live WebSocket connection
  immediately if it has one (`HostConnectionRegistry.closeConnection`) — so
  revoke cuts off an already-connected daemon right away, not just its next
  reconnect attempt.

Unauthenticated (the pairing code itself is the one-time credential):

- `POST /api/v1/hosts/register` — `{ pairing_code, platform?, arch?, daemon_version?, capabilities_json? }` → `{ host_id, token, name }`.

Host-bearer-token authenticated (`Authorization: Bearer <token>`, never a
user session — the daemon has no session to present):

- `POST /api/v1/hosts/me/revoke` — terminally revokes the calling Host's own
  token. This is the server half of `rainver-host unregister`; the token has
  no authority over another Host.
- `POST /api/v1/hosts/me/workspaces` — `{ project_id, name, display_path? }`,
  requires the host owner to hold Project write access
  (`PgProjectFolderRepository.createRemoteWorkspace`); creates a logical
  Folder plus a remote Location whose server `root_path` is NULL.
- `GET /api/v1/hosts/me/workspaces` — every Location registered under this
  Host.
- `DELETE /api/v1/hosts/me/workspaces/:folderId` — unregisters a Location
  (never touches the daemon's disk; the daemon owns that).
- `POST /api/v1/hosts/me/runs/:runId/diff` / `.../outputs` — daemon uploads a
  completed run's git diff and `RAINVER_OUTPUT_DIR` contents as read-only
  artifacts (D7: never fed into code-patch proposal apply). Scoped by
  `runOwnedByHost` — a host can only upload for a Run bound to its own
  Location.
  Size-capped server-side (`MAX_DIFF_BYTES`, `MAX_OUTPUT_FILE_BYTES`,
  `MAX_OUTPUT_FILES` in `repository.ts`) regardless of what the daemon sends.

User-session authenticated dispatch is owned by the Tasks module, not this
Host registry:

- `POST /api/v1/tasks/:taskId/runs` dispatches an existing coding Task and
  accepts `workspace_location_id`; without one it uses the Folder's sole
  active, execution-ready Location.

It enforces Project write access, Location/Folder/Space scope, execution
readiness, remote Host ownership, implemented ACP adapter and host capability
checks, then creates one Run and enqueues the durable agent job. The former
`POST /api/v1/hosts/dispatch` and `POST /api/v1/tasks/runs` routes are removed;
no compatibility route is registered by the server.

A remote dispatch creates its Run synchronously, exactly as a server-host one
does — the two differ in what they stamp on the Run (the thread, the adapter,
the installation and the vendor session to resume), not in when the Run comes
into being. It used to enqueue a message on the thread and let a per-thread
queue turn it into a Run once nothing blocked it; that queue existed for the
Command Center's thread page, which paused it on any non-success and offered a
Resume button. With the page gone nothing could resume a paused queue, so a
remote Task run whose predecessor failed would have sat queued forever. Deleted
with it: `host_thread_messages`, `advanceThreadQueue`, `queue_paused_at`,
`threadMessageRepository`, and the thread routes (withdraw, resume-queue,
cancel, events read, messages read).

Cancelling a remote Run goes through `PATCH /api/v1/runs/:runId/stop` like any
other Run — the deleted thread-cancel route was a thread-to-run lookup wrapping
that same `orchestration.cancelRun`, not separate machinery.

Model-backend binding. Space-scoped
via `introspectIdentity` because validating a ModelProvider needs the Space its
grant lives in, but host **ownership** is still the gate (B63) and an unowned
host id answers 404, not 403 — matching `revoke`:

- `GET /api/v1/hosts/:hostId/runtime-provider-bindings` — this host's defaults.
- `PUT /api/v1/hosts/:hostId/runtime-provider-bindings/:adapterType` —
  `{ model_provider_id, model? }`. Validates that the adapter is remote-eligible
  and that the provider exposes the compatible base URL that adapter needs
  (`adapterProviderRequirement` in `runs/runtimeProviderBinding.ts` is the one
  place that mapping lives, shared with execution-time binding construction).
- `DELETE /api/v1/hosts/:hostId/runtime-provider-bindings/:adapterType` —
  returns that host×adapter to the machine's own login state.

`host_runtime_provider_bindings` is keyed `(host_id, adapter_type)` only. A
provider is reachable through a Space grant, so a binding whose provider has no
enabled grant in the *dispatching* Space fails at dispatch with a 422 rather
than resolving differently per Space.

Both dispatch routes accept per-dispatch `model_provider_id` / `model`
overrides. Precedence is **override > the thread's own backend > host×adapter
default > none**, and an explicit `model_provider_id: null` is a real choice
("ambient login for this one dispatch"), so the override is read by key
presence, not truthiness.

A thread's own backend is the resolved provider and model of its newest Run
(`threadRunBinding` in `tasks/repository.ts`). The Host × adapter default
therefore decides a thread's *first* backend only. Without that step,
resolution re-read the default at every dispatch, so changing it moved
**every** existing thread on that host onto a new backend, and since a bound
run's vendor session lives inside that provider's profile directory, each of
them lost its conversation as well — a setting meant to pick a default for new
work silently reset old work. An override becomes what the thread inherits
next, which is how a user changes a thread's backend. (This used to read the
thread's newest *message* — the queue's ledger — where queued rows counted and
withdrawn ones did not; with one Run created per dispatch there is no queued
state to reason about.)

Resolution happens at **dispatch** time, and the result is stamped onto the Run
it creates: `runs.model_provider_id` and `model_override_json.model`.
Validation can then fail the request the sender is waiting on. The snapshot
names a concrete model, not "whatever the provider defaults to" — a thread that
inherited a null model would follow the provider's `default_model` if that were
later edited, which is the same drift one level down. `source: "request"` is
written even when the decision was "no provider at all", because that is what
tells an admission that deliberately chose ambient login apart from a Run that
never chose and should fall back to the Host default.

Such a Run is `run_type: 'system'`, which `routeRun` skips. That is load-bearing
rather than cosmetic: on any other run_type the router would stamp its own
predicted provider over the backend the dispatch already resolved and
validated, and binding resolution reads that column.

The admission also writes the thread and the vendor session to resume into the
Run's `model_override_json.host_thread` — the same shape the Room, delegation
and direct-chat paths write. The `agent_run` job handler reads both from the
Run (`hosts/threadDispatchInputs.ts`), never from the job payload: twenty
places enqueue that job, and the ones that did not know they were re-dispatching
a thread-bound Run (the supervisor retry, an authorization re-enqueue, the
resume endpoint, direct chat) used to start a fresh vendor session every turn
while the thread believed it was resuming one. At execution, a Run that never
went through dispatch — an Automation, Room root run, Plan or Workflow node,
evolution run whose Folder prefers a remote Location — falls back to the Host ×
adapter default, so the per-host setting means what the Command Center says it
means rather than applying only to dispatched threads.

**Before execution, `runs.model_provider_id` is not evidence of a binding**:
`PgRouteDecisionRepository.routeRun` stamps that column for any routed run
before host kind is resolved, so a remote run created by another path can carry
a provider it never used. A dispatched Run is `run_type: 'system'`, which the
router skips, so on that path the column carries the dispatch's own decision
and binding resolution reads it; a Run without one falls back to the Host
default. Once the binding is resolved — before the run launches — the
column becomes authoritative in the other direction: the remote adapter writes
back what it bound and marks it `source = "host_binding"`, so a reader can tell
a chosen provider from a predicted one. The write-back merges into
`model_override_json` rather than replacing it — that column also carries
`execution_mode`, `chat_turn` and Conversation/Host-thread continuity, and a
Room turn pinned to a remote Location reaches this path.

`route_decisions.selected_model_provider_id` is the router's own second copy of
that value and means nothing for a thread-dispatched run: those runs are
`run_type = 'system'`, which `routeRun` skips, so they have no route decision
row at all. For a remote run created by any *other* path there is a row, and it
records what the router selected — not what executed. Neither column is
evidence of a binding.

`runToOut`'s `resolved_model` reports `used_by_adapter` for a remote run only
when the column carries the `host_binding` marker — otherwise Run detail would
present the router's prediction as a fact about what ran. Remoteness itself
comes from the Run's Location, **not** from `trust_mode`: only the
thread-dispatch path writes that column, so an Automation, Workflow or
evolution run on a remote Location can have it null and still run remotely.
Every read path that renders a Run passes the answer in, resolved by
`resolveRunRemoteness` (`runs/runRemoteness.ts`), which answers a whole page in
one query and skips rows with nothing recorded to qualify. `trust_mode` is the
floor for a caller that has not been given the answer.

At execution, `remoteHostCliAdapter` reads the binding from the message,
creates a provider-proxy lease bound to that Host, and carries a
`provider_binding` frame in the launch message: the proxy URL the *host* can
reach, a short-lived lease token, and the model. The provider's real key never
leaves the server — the proxy substitutes it. The adapter owns the lease's
lifetime, so it is revoked when the run reaches any terminal state rather than
at its own TTL, and revoking a Host revokes its live leases immediately
(`ProviderProxyLeaseRegistry.revokeHost`), since a lease is plain HTTP and a
cut socket does not stop it.

The address a host uses to reach the proxy is **derived, not configured**: the
daemon reports the control-plane address it connects to
(`hosts.daemon_server_url`, refreshed on every heartbeat), and the proxy's
address follows from it plus `PROVIDER_PROXY_PORT`. The server cannot work this
out alone — its own in-network hostname is a Compose service name no paired
machine can resolve — which is why it is the daemon that answers.

`hostProviderProxyBaseUrl` is the one place that resolves it: an explicit
per-host override (`hosts.provider_proxy_base_url`, editable in the Command
Center, for a reverse proxy in front of the API or a proxy published elsewhere)
→ the derived address → the instance-wide `PROVIDER_PROXY_EXTERNAL_BASE_URL`.
`GET /api/v1/hosts` returns the resolved answer as
`provider_proxy_effective_url` so the UI shows what a dispatched run will
actually get rather than deriving a second, possibly different one. With
nothing to resolve, a bound remote run fails with a stated reason rather than
receiving a URL it cannot resolve.

`PROVIDER_PROXY_PORT` (listen port) and the published port binding stay
deployment settings — one needs a socket rebind, the other is a container port
mapping the app cannot change about itself. Compose binds the published port to loopback by default;
widening that bind is the deliberate step that puts lease traffic on the local
network, and it is plaintext until a TLS entry exists.

The frame is runtime-agnostic on purpose:
`{ profile_key, env, profile_env, files }`. The
server generates every Codex-TOML and OpenCode-JSON decision using the **same**
builders the server-host path uses (`renderCodexProviderToml`,
`codexModelCatalog`, `applyOpenCodeProviderConfig`), and the daemon creates a
directory, writes those bytes, and reports the paths back as environment. A
second set of generators on the daemon is what would silently drift — a catalog
Codex never reads, an OpenCode provider block missing the `npm` field that
makes it loadable at all — so the daemon stays a byte writer, consistent with
its rule against becoming a vendor protocol translator. `files[].contents` may
carry `{{RAINVER_RUN_PROFILE}}`, which the daemon replaces with the
absolute profile path; Codex's config has to name its own catalog absolutely
and only the executing machine knows where that is. Paths that escape the
profile are refused — the daemon runs unsandboxed on a machine the user owns.

`profile_key` is `<adapter_type>/<provider_id>`, and the profile lives at
`profiles/<adapter_type>/<provider_id>` under the daemon's config directory —
shared by every run with that adapter and provider on that machine, never
per-run. A CLI keeps its conversation state inside the profile (Claude Code's
session transcripts live under `CLAUDE_CONFIG_DIR`), so a profile deleted when
its run exits takes with it the session the next turn is about to resume: every
turn after the first then fails with the runtime reporting no such
conversation, and the thread is reset. Sharing per adapter and provider keeps a
conversation resumable for as long as its backend does not change, and makes
changing the backend start a fresh session rather than resume one whose context
another vendor's model produced. The daemon validates the key before building a
path from it — it runs unsandboxed on a machine the user owns.

Two consequences of a profile that outlives its run: a written config keeps
that run's lease token after the lease is revoked (a dead credential in a 0700
directory; the provider's real key is never there), and two concurrent runs
sharing an adapter and provider share the directory, so one can end up using a
sibling run's lease — same upstream, but usage attributes to the sibling.

**All three runtimes need a profile**, and all three keep conversation state
inside one: Claude Code under `CLAUDE_CONFIG_DIR`, Codex under
`CODEX_HOME/sessions/YYYY/MM/DD`, OpenCode under `HOME/.local/share/opencode`
(reached through HOME, since `XDG_DATA_HOME` is not on the ambient allowlist).
On the server host their isolation comes from the credential broker, which does
not exist on a trusted host, so environment injection alone would leave the
machine's own `~/.claude` or `~/.codex` in play.

This granularity is the minimal extension of what ADR 0016 already decided for
remote runs: session continuity is the vendor CLI's own state on that machine,
addressed by the thread's opaque `vendor_session_id`, and machine-global when
the run is unbound. A binding subdivides that state by provider and changes
nothing else. The server-host conversation-home machinery
(`prepareConversationHome(state_key)`) is deliberately *not* what this reuses —
ADR 0016 records that server-brokered Runtime Context continuity has no meaning
for a remote host.

A remote run is given up on for two distinct reasons, and the failure says
which: `runtime_timeout` when the whole run budget elapsed, and
`runtime_stall_timeout` when the runtime produced no output for the stall
budget. Both carry how long the runtime had been silent. The stall budget is
one rule for both execution paths (`runs/stallTimeout.ts`): five minutes by
default, `adapter_config.stall_timeout_seconds` per dispatch, never longer
than the run budget. The remote path briefly used a third of the run budget
instead — 100s for the default — which killed legitimate turns in the middle
of a long tool call, since a runtime busy inside one emits nothing until it
returns; the Run then retried from scratch on the same run id. The server-host
path has had this stall budget all along; the remote path originally
accepted the option and never implemented it, so a runtime that went quiet —
an OpenCode turn waiting on a free-tier model that never answered — burned the
entire timeout and then reported only that it "timed out", which is equally
true of a run that worked the whole time. Both codes are retryable, like their
`cli_adapter_timeout`/`cli_stall_timeout` twins on the server host; listing
only the local pair meant an identical failure was retried automatically there
and sent straight to human review on a paired machine.

A bound run tells its runtime which model over ACP
(`session/set_config_option`), and the value is the binding's resolved model
expressed in **that runtime's** identifier space — not the router's model,
which can name something the bound provider does not serve. `boundAcpModelId`
owns the translation, next to the config generation that defines each space:
OpenCode addresses a model as `<providerId>/<model>` where the provider id is
the one `applyOpenCodeProviderConfig` declares (`openCodeModelId` is the single
constructor for it, so the config and the ACP value cannot drift); Codex
resolves against the catalog the binding writes, keyed by the provider's own
model name.

**On this path Claude deliberately does not use this channel.** Its model is
decided entirely by `ANTHROPIC_MODEL` and the three `ANTHROPIC_DEFAULT_*`
variables the binding sets. ACP's model options are Claude's own alias space (`default`,
`sonnet`, `opus`, …), in which a third-party provider's model name does not
exist, so reconciling against it necessarily falls through to the session's
current value — `default` on a fresh session, and on a **resumed** one the
model the previous turn used. Sending that would re-assert the old model while
`ANTHROPIC_MODEL`, `runs.model_provider_id` and the conversation all named the
new one. Saying nothing leaves the environment in sole charge, which is where
the answer already is.

Sending a bare name to OpenCode names no provider it knows, against an endpoint
that looks correctly configured — so a rejection names both the model asked for
and the one the runtime is on.

The capability probe asks each ACP runtime for its modern `configOptions` and
stores them without projecting special model/effort fields. Select options
(including groups), boolean options, categories, descriptions, and current
values remain runtime-owned. The probe opens a throwaway session in a temp
directory and caches a successful answer for 15 minutes. A failed ask is
cached for only one minute and is cleared immediately when the daemon receives
a fresh control-plane `hello_ack`, so one transient probe failure cannot hide
the composer controls across a server restart. While the runtime cannot
answer, that installation reports no options; Rainver does not read vendor
config files or synthesize a fallback catalog.

*How* each runtime's ACP process is launched for the ask is not the daemon's
knowledge: `hello_ack` carries `runtime_probes` — one `{ runtime, argv }` per
implemented ACP adapter, rendered by the server from the adapter spec's
`headless_command_template` (`server/src/modules/hosts/runtimeProbes.ts`),
keyed by the same binary name the capability probe reports. The daemon
resolves that argv exactly as it resolves a `launch` frame's
(`resolveAcpLaunch` — vendor CLI as named, bundled adapter through `node`),
so adding a runtime is a spec entry and the daemon needs no change. Because
the first `hello` precedes `hello_ack`, it carries no option lists; the daemon
sends a heartbeat immediately after the ack rather than an interval later.

### Installations: own and managed copies (`hosts/runtimeProbes.ts`, daemon `src/tools.ts`)

A host can carry more than one copy of a runtime, and every ACP adapter is
handled the same way — the builtin CLIs and enabled registry agents alike:

- **`own`** — the machine's PATH install, driven as before (bundled
  `claude-agent-acp`/`codex-acp` for Claude/Codex, the vendor binary for
  OpenCode). Detected by `--version`; never installed, upgraded, or
  reconfigured by the daemon. Its login state is the machine's.
- **`managed:<version>`** — a copy the daemon installed on the owner's
  request into `<config dir>/tools/<adapter_type>/<version>/`, with its own
  `home/` so its login state is separate from the machine's and from every
  other copy. Removal deletes the directory.

`hello_ack.runtime_probes` is the daemon's initial whole catalog, one entry per
adapter: the PATH binary to look for (`runtime`, null for a registry agent),
the launch `argv`, the `distribution` to install a managed copy from (a
builtin spec names its ACP registry entry — `distribution: { registry_id }` —
resolved by the acpAgents refresh loop, persisted in instance settings and
read from memory, never fetched on the hello path; a registry agent carries
a snapshot), and the `login` knowledge (`credentials.login` in the spec:
command, `managed_command` inside a tree, `home_subdir`, `credential_file`).
The server-host login adapters read the same spec fields. Every
`heartbeat_ack` carries the current catalog again; when enabling an ACP agent
changes it, the connected daemon adopts the new probes and immediately sends a
fresh heartbeat, so installing an agent never requires a daemon reconnect.

A runtime on a host has **one identity: adapter type × copy**, and
everything about a copy lives on the copy. The capability report is
`{ runtimes, versions, installations }`: `installations[adapter_type]` holds
one `{ id, version, logged_in, options }` per copy (`logged_in` comes from
the configured credential file for built-ins, otherwise from whether ACP
session setup succeeds when the Agent advertises authentication;
`options.config_options` and `options.auth_methods` are the generic ACP
capabilities that copy advertised; `options.cli_login_available` is a separate
Rainver compatibility capability and is never represented as an ACP method).
`runtimes`/`versions`
are the plain PATH inventory (vendor binaries and git), for display only.
The shape is the protocol's (`packages/protocol/src/hosts.ts`:
`HostCapabilitiesSchema`), so server and web share one definition and the
server validates what it stores and serves. Daemon and server deploy together;
`hosts/capabilities.ts` accepts only the current installations shape and does
not translate obsolete heartbeat layouts.

Install (`POST /api/v1/hosts/:hostId/installations/:adapterType`, host owner)
sends `install_tool { request_id, adapter_type, version, distribution, login }`;
the daemon materializes the distribution — `npx` as a pinned `npm install
--prefix`, `uvx` as `uv tool install` with a private `UV_TOOL_DIR`, `binary`
as an https download verified against its sha256 and extracted — behind a
staging rename, writes `manifest.json` (absolute command, args, env, `home`,
the rendered `login_command`), answers `tool_result { installation }` and
heartbeats. `DELETE .../installations/:adapterType/:installation` sends
`uninstall_tool`; only a managed copy can be removed.

What a dispatch may choose is decided where dispatch is validated — the
admission resolves the backend and refuses an unusable one, so the caller
finds out on the request it is waiting for rather than on someone's laptop
minutes later. There is no longer a read endpoint for the option list: it
existed for the Command Center's dispatch composer, which was deleted with
that surface.

A thread pins its copy (`host_threads.runtime_installation`, default
`own`) the way it pins its adapter: the vendor session lives in that copy's
login state. Dispatch takes `installation` on a new thread, validates it
against the host's `installations`, and stamps it into the Run's
`model_override_json` so the launch frame names it; the daemon launches a
managed copy from its manifest with `HOME` set to that copy's home.

**Login** follows the runtime's declared mechanism: `GET
/api/v1/hosts/:hostId/installations/:adapterType/:installation/login/stream`
(host owner, SSE) opens `login_open` on the daemon. Built-ins with an explicit
login spec continue to run that command. Otherwise every method returned by
ACP `initialize.authMethods` is exposed without a vendor allowlist: missing
type is normalized to Agent Auth, which invokes ACP `authenticate` with the
advertised method id; Terminal Auth appends the advertised args and env to
the installed Agent's normal command and runs it to completion before the
capability is probed again. The daemon advertises ACP Terminal Auth only when
the host can actually provide the required PTY. Terminal commands use a PTY
from `script(1)` (no native addon to build on the host; Windows unsupported for now), with `HOME`
set to that copy's home and any ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
removed. Output comes back as
`login_output` frames (`{ type: "output" }` on the stream, escape codes
stripped in the UI); http(s) URLs in that output render as a short clickable
**Open login link** rather than exposing an unbroken raw URL; typed text goes
through `POST .../login/input` →
`login_input`; the command's exit is `login_exit { exit_code, logged_in }`,
after which the daemon clears that copy's ACP capability cache and heartbeats
so both `installations[].logged_in` and its advertised auth methods are current.
Some Agents advertise Agent Auth but wait indefinitely for credentials their
own CLI must create first. A managed installation without an explicit login
spec is probed with its fixed top-level `login --help`; when that succeeds,
Rainver reports a separate restricted **CLI login** compatibility capability
without altering any Agent Auth or Terminal Auth method the Agent advertised.
The login request selects either an ACP method id or this Rainver-owned action,
never a synthetic ACP method. It runs only that
installation's fixed executable entry plus the
`login` subcommand in the same isolated HOME; it accepts terminal input but
does not expose a shell or a remotely supplied command. New manifests preserve
the executable-entry prefix separately from ACP arguments, so this also works
for package-backed Agents. Older binary manifests safely imply an empty prefix;
older Node package manifests must be reinstalled. After five seconds without
an Agent Auth response, the stream points the user to CLI login instead of
appearing silently stuck. When neither an explicit adapter login command nor a
selected ACP method/CLI action exists, both the server route and daemon fail
closed; the login endpoint never falls back to a host shell.
One session per host × adapter × copy; a new stream supersedes the old, and a
closed stream sends `login_close`. The server-host login engine
(`providers/cli/loginEngine.ts`) is unchanged and still owns the server host's
own profiles; the daemon terminal never copies credentials anywhere.

Enabling a registry agent (`modules/acpAgents`, instance admin) publishes a
dynamic adapter `acp_<id>` (`runtimeAdapters/dynamicSpecs.ts`) whose command
is its adapter type and whose only copies are managed ones
(`remote_host_only`, low trust, `model_provider_mode: "none"`). Every process
reloads the enabled set at startup and every 60s. Disabling is refused (409)
while any host still reports a copy (`GET /api/v1/acp-agents` lists
`installed_on`), so nothing is orphaned on a machine and no pinned thread
stalls silently. ADR 0016 is amended in place for managed copies; the
machine's own installs are still never touched.

In the UI (command center → Hosts) this is host-major: each remote host card
has an **Agents** section listing only the agents that host has a copy of,
with source (`own`/`managed`), a cleaned version number that does not repeat
the Agent name, log-in / remove, and an "Add agent…"
picker for the enabled catalog. The card does not repeat the raw PATH runtime
inventory above this list (and does not surface the daemon's Git utility as an
Agent). The host×adapter **Model source** is rendered inside that same Agent
row rather than in a disconnected backend grid: adapters with a supported
ModelProvider binding get a selector whose ambient option reads **Agent-managed
account**; generic registry Agents such as Cursor remain visible and state
**Agent-managed · no Rainver override**, because ACP authentication does not
describe how Rainver should inject an arbitrary ModelProvider into the Agent's
config. This describes Rainver's integration boundary, not whether the Agent's
own product settings support BYOK. Agent name, copies, login actions and Model
source share one compact row; copy controls scroll horizontally if the viewport
cannot hold them rather than turning every normal desktop row into two lines.
Login remains per installation while Model source remains per host×adapter;
the visual grouping does not collapse those two authority scopes. For
an instance admin, the same picker lazily reads the whole ACP registry: search
results remain visible while installing and after installation, with explicit
**Installing…** and **Installed** states. A not-yet-enabled entry offers one
**Enable & install** action: the server first snapshots and enables it
instance-wide, then installs its managed copy on that host. An enabled entry
that is absent from this host offers **Install**. A failed install leaves the
successfully enabled catalog entry visible and reports the partial outcome;
the picker never sends an arbitrary registry distribution directly to the
daemon. Non-admin host owners see only the already-enabled catalog. No agent is labelled "built-in": the builtin
CLIs and registry agents differ only in server-side capability (provider
binding, subagent lockdown, usage), which is not a host concern.

The instance admin's **ACP registry** panel on Instance Settings
(`modules/runtime_tools/AcpRegistryPanel`) remains the instance-wide management
surface next to the server-host runtime tools: enabled agents (Disable, refused
while installed anywhere) and a registry search to Enable an entry without
installing it on a particular host.

Direct Agent chat, Room, and Project sidecar expose the selected installation's
generic ACP options through the shared composer. The request stores selected
`{ id, type, value, category }`
entries as `model_override_json.acp_session_config`. The controller validates
each selection against `session/new`, applies them in category order (model,
mode, thought level, model config, then unknown), and requires every
`session/set_config_option` response to return the requested current value
before prompting. Each response replaces the option snapshot because a model
change may change available reasoning levels. There are no `set_model`,
`set_effort`, legacy `modes`, or vendor-config compatibility paths.

**Which model a run is recorded as having used is the server's own answer, not
the runtime's echo of it.** The controller takes `attributed_model` separately
from the model-category session selection because the two identifier spaces
can differ — Claude is told no model at all yet runs on one the server chose,
and OpenCode is asked for `<provider>/<model>` but runs on `<model>`.
Reading the echo instead reports an alias (`default`) on a fresh session and
the *previous* turn's model on a resumed one, which is precisely when the
answer matters.

The server-host and remote paths use this same generic controller. Provider-
bound Codex/OpenCode runs add their translated model as a normal model-category
selection. Claude remains environment-controlled because provider model names
do not share Claude ACP's alias namespace. Usage attribution remains the
server's resolved provider model rather than the runtime's display alias.

B67's remote enforcement point is that same spawn: for a bound run the daemon
rebuilds the environment from an **allowlist** rather than filtering a denylist
— B67 states the rule positively for a reason, and a denylist of vendor
prefixes lets `CLAUDE_CODE_OAUTH_TOKEN`, `XDG_DATA_HOME` (OpenCode's credential
store) and `NODE_OPTIONS` (which injects code into the runtime process) through.
The allowlist is the same shape the server host uses in `cliSubprocessEnv.ts`.
A run with **no** binding keeps the machine's environment untouched, exactly as
before.

- `GET /api/v1/hosts/runtime-adapters` (P3, C6) — catalog of remote-eligible
  adapters (`implemented` + ACP protocol): the builtin specs plus dynamic
  adapters for instance-enabled ACP registry entries, sourced from
  `listRuntimeAdapterSpecs()`. Session-authenticated
  only (`getCurrentUser`, no space scoping — the catalog carries no per-user
  or per-space data). The single source of truth the frontend reads instead
  of re-deriving the dispatch route's own ACP-only eligibility rule a third
  time. Each entry's `capability_probe` is what a trusted host's capability
  probe actually reports for that adapter when it differs from `command` (an
  ACP adapter's own bundled executable, e.g. `codex-acp`, vs. the vendor CLI
  binary a host reports, e.g. `codex`).

## WebSocket (`GET /internal/hosts/ws`, `@fastify/websocket`)

**The wire is one contract, `packages/protocol/src/hostWire.ts`.**
`HostServerFrameSchema` is every frame the control plane pushes to a daemon
and `HostDaemonFrameSchema` every frame a daemon sends back, as Zod
discriminated unions. Both ends parse inbound frames with them once
(`parseServerFrame` in the daemon's `commands/run.ts`, `safeParse` in this
route's socket handler) and type outbound frames against them
(`HostFrameSink.send`, `ReconnectableFrameSink.send`, the daemon's
`helloInfo()` return type), so no frame is rebuilt field by field on either
side and a field exists in exactly one place. The daemon depends on
`@rainver/protocol` at runtime for this — it is wire contracts only, which is
what the daemon is allowed to know. Objects are deliberately not strict, so a
newer peer's extra field is dropped rather than fatal; what guards against a
field being *lost* is that nothing names fields by hand any more. This is the
repair for a class of defect that shipped three times — `provider_binding`,
`server_url`, and `work_surface` each vanished at a hand-written mapping
while the sender believed it delivered them. A frame that fails to parse is
answered with an `error` frame naming the path, never dropped silently; a
`launch` that fails is answered with a `complete` so the run does not hang.

Every `launch` carries a `launch_id` nonce the daemon echoes on that run's
`launched`/`output`/`stderr`/`complete` frames, and the registry routes a run
frame only to the dispatch whose nonce it carries. A supervisor retry reuses
the run id within seconds of the first attempt's kill, before that attempt's
child has finished uploading and reported: without the nonce the late
`complete` resolved the second attempt's promise with the first attempt's
exit code and revoked the second attempt's tool token under a live process.
The daemon keeps the same distinction: a newer attempt takes over the run
id's registration, and the older attempt's cleanup leaves the shared
`<config>/runs/<run_id>/` in place when a newer attempt owns it.

Two placeholders on the wire (`REMOTE_CWD_PLACEHOLDER`,
`WORK_SKILL_PATH_PLACEHOLDER`, in the contract) stand for values only the
executing machine knows; the daemon substitutes them in argv, the initial
stdin, and every `stdin` frame, so a prompt can point at the Skill file by a
path the server never had rather than an unexpanded `$RAINVER_SKILL_PATH`.
The one hand-written mapping left is `sandbox/runner.mjs`, which runs with no
dependencies; `server/test/sandboxRunnerClient.test.ts` pins it to
`SandboxRuntimeEnvironment` field by field instead.

`hello` (authenticates the bearer token, marks `online`, records
capabilities, applies the daemon's complete workspace Location reports, and
answers `hello_ack { host_id, runtime_probes }`)
and `heartbeat` (refreshes `last_heartbeat_at`, reported capabilities, and
Location branch/head/dirty/readiness). A remote Location omitted from a
heartbeat is marked `execution_ready = false`. On socket close, the host is
marked `offline` immediately; Host liveness remains distinct from Location
readiness.
Heartbeat staleness (`HEARTBEAT_STALE_MS`, 45s) is computed at read time in
`PgHostRepository`, not swept by a background job — a host that dies without
closing its socket reports offline the next time anyone lists hosts.

The dev Vite entrypoint proxies `/internal` with WebSocket upgrade forwarding
to the server service, so a daemon registered against the browser's dev origin
(`http://localhost:3000` in dev) can use the same origin for its outbound WS.
The Command Center's `HostsPanel` refreshes only its own host list every three
seconds while mounted; it does not reload the page or trigger unrelated module
queries. This is a component-scoped read refresh, not the planned general
browser real-time event layer.

Job dispatch/execution frames (`RemoteHostExecutionAdapter` in
`server/src/modules/runs/remoteHostCliAdapter.ts`): `launch` (server → daemon,
rendered argv + timeout), `stdin` (server → daemon, one frame per ACP
JSON-RPC message — the ACP runtime replatform's P2 duplex extension to this
protocol; stdin is no longer written once and closed), `output`/`complete`
(daemon → server, routed through `sharedHostConnectionRegistry`
(`server/src/modules/hosts/connectionRegistry.ts`) to whichever
`RemoteWsCliCommandExecutor` call is awaiting that run), `terminate` (server →
daemon, cancel closures registered the same way `SandboxRunnerCliCommandExecutor`
registers them for the server-host path). Every adapter (`claude_code`,
`codex_cli`, `opencode`) can run remotely now — all three speak ACP, a
bidirectional JSON-RPC protocol the duplex `stdin`/`output` frame pair
carries natively.

The daemon-supervised HTTP/SSE runtime endpoints sketched in 2026-08-21 were
superseded 2026-08-22 before anything was built, in favor of the duplex-frame
ACP extension above (the ACP runtime replatform plan, P1-P5, complete and
retired 2026-08-23; ledger in git history).

C5: the daemon also sends a live `stderr` frame per chunk (not only the
`complete` frame's existing failure-tail), routed the same way as `output`
through a new `HostConnectionRegistry.receiveStderr`/`onStderr` pair.

Workspace registration is reachable from the web UI through three owner-only
frames the daemon answers: `list_dirs` (one level of subdirectory names for an
absolute path — lazy, ≤500 entries, directories only), `workspace_register`
(runs the daemon's own `workspace add` validation and registration, so
terminal and UI produce identical state), and `workspace_forget` (drops the
local path mapping after a server-side unregister; offline daemons keep it and
`workspace list` shows the divergence). `hosts.default_adapter_type` is the
owner's preferred CLI on this machine, set from the Command Center host card
(`POST /hosts/:hostId/default-adapter`, validated against reported
installations): auto-provisioned Assistant backends, execution-target adapter
ordering, and dispatch-option defaults all read it, with the built-in
OpenCode-first ordering as the null fallback.

Files & Code uses a separate bounded pull on the same socket: `folder_read`
(server → daemon, Location id + relative path + Folder protection flag) and
`folder_read_result` (daemon → server, one `tree`, `file`, `git_status`, or
`git_diff` result). The daemon resolves the registered root, applies
`@rainver/folder-read` PathPolicy and size limits, and never sends an absolute
path. The server authorizes the requested active Location for its registered owner,
records `force_record` audit metadata including `host_id`, and maps offline,
timeout, forbidden, and missing-location outcomes to structured HTTP errors.

A pending run survives a brief WS drop: `HostConnectionRegistry` tracks
pending runs by `run_id` (not nested per-connection) and gives a reconnect
`RECONNECT_GRACE_MS` (60s) to resume the same in-flight run before failing it
as `host_disconnected`. This is a narrower reading of the retired phase-1
plan §5's "interruption semantics" bullet than the plan's
full wording — a disconnect that outlasts the grace window still resolves as
an ordinary run failure, not a distinct `interrupted` run status with its own
reconciliation-on-reconnect lifecycle (adding a new terminal run status would
touch retry policy, the supervisor, and finalization across the whole run
subsystem). See the deferred register.

## Host threads (D14, `server/src/modules/hosts/threadRepository.ts`)

A `host_threads` row pins a vendor-CLI conversation to one registered
`workspace_location_id`, or to a daemon-derived managed Agent × container
workspace, for session resume via ACP's own `session/resume` (the general
`AcpController` in `server/src/modules/runs/cliConversationProtocol.ts` drives
this for every adapter now) — not server-side Runtime Context continuity
(remote runs get none of that; see "No server-brokered Runtime Context" below).
`getForLocation` is scoped by `workspace_location_id` so a thread from one
physical checkout can never be resumed against another. Managed rows have a
null Location and `workspace_mode='managed'`; Conversation rows use
`container_kind='conversation'` with their `session_id`, while direct owner
chats use `container_kind='direct'` plus `container_user_id`. A row is either
a Task-shaped thread or an Agent conversation. The partial unique indexes
permit one active/session-reset Conversation × Agent thread and one
active/session-reset Agent × direct-owner conversation, releasing each when
the thread is closed.
`last_session_id` tracks the conversation that last established prompt
continuity.
`dispatch_lock_id` is the persistent atomic in-flight claim: a Conversation ×
Agent thread is claimed before its Run exists, bound to that Run before commit,
and released only by the terminal outcome hook. This prevents two turns from
concurrently sharing or overwriting one vendor session; explicit context reset
waits until that claim is released.

`recordRunOutcome` clears `vendor_session_id` outright (not
COALESCE) whenever a resume degrades (`session_reset`) — retrying an already-
broken vendor session id forever was a real P3 discovery-review bug, fixed
before this landed. **Since the phase-2 event-pipeline work**, it is called
from `agentRunHandler.ts`'s `handleAgentRun` (via
`server/src/modules/hosts/threadOutcome.ts`'s `recordHostThreadOutcome`)
once the dispatched Run's `agent_run` job reaches terminal — not from the
dispatch route itself, which no longer waits around for that. Every session id a thread moves on from — reset, close, or a degraded resume — is appended to `retired_vendor_session_ids`, and ambient session import excludes those alongside the live id; clearing the live id alone would let the Agent's old sessions come back as the owner's own history.

`vendor_session_id` is the thread's own resume target, deliberately distinct
from the server-owned `runs.session_id`. No surface displays it any more — the
Command Center thread page that did was deleted with the rest of that surface;
what a remote Run produced is read as a turn, from the normalized event log
below, through `modules/conversation`.

Removing a managed Room specialist or deleting an owner's direct session
closes its thread and sets `pending_archive_at`. The server asks the connected
daemon to rename the live directory to its timestamped `.removed-*` archive;
if the daemon is offline, the pending row is replayed on the next hello or
heartbeat. Re-adding a Room or sending the first direct message can request an
explicit restore when the heartbeat reports `archived_available`; restore
never restores the vendor session. Archives older than 30 days are swept by
the daemon on heartbeat.

## Thread events (P1, `server/src/modules/hosts/threadEventRepository.ts` /
`threadEventNormalization.ts`)

`host_thread_events` is the normalized, per-thread conversation log —
`assistant_text` (coalesced text segments), `tool_activity_started`/
`tool_activity_finished` (ACP ToolCall/ToolCallUpdate fields, upserted by
`tool_call_id` when projected), `status` (`run_started`/`run_succeeded`/`run_failed`/
`run_timeout`), `diagnostic` (one stderr line each), and `assistant_thought`
(reasoning, coalesced the same way as `assistant_text`).

Reasoning follows the ACP channel exactly, as Zed's client does:
`agent_thought_chunk` becomes `assistant_thought` and `agent_message_chunk`
becomes `assistant_text`. The normalizer does not inspect prose or infer that
inline `<think>` text is reasoning. The turn's `output_text` stays free of
protocol-level reasoning — it is the answer. The conversation view renders
reasoning as a collapsed disclosure, never as the reply. `event_index` is a monotonic
cursor **per thread**, not per run, since the read model is the whole
conversation across every run/turn dispatched into it; enforced by
`uq_host_thread_events_thread_event_index`.

This is a sibling table to `run_events`, not a new `run_events.event_type`
value — that table's CHECK constraint is a closed vocabulary built for the
server-host semantic-event stream (`tool_call_started`, etc.), has no
`assistant_text`/`diagnostic` concept, and (before this phase) had no
incremental-write path for a remote run at all.

`RemoteHostExecutionAdapter` (`remoteHostCliAdapter.ts`) normalizes and
persists events as stdout/stderr chunks arrive — a `thread_event_sink`
callback, distinct from the pre-existing `runtime_event_sink`/`run_events`
callback, constructed per-run in `orchestrationService.ts` via
`createSerializedThreadEventSink`. Per-chunk writes are fire-and-forget
(`void`); the run's terminal status event is `await`ed, guaranteeing every
earlier event has committed before the Run is reported terminal. Both this
sink and the pre-existing `runtime_event_sink` are serialized (via the shared
`serializeCalls` in `routeUtils/common.ts`) for the same reason:
`on_stdout_chunk`/`on_stderr_chunk` are synchronous, un-awaited callbacks,
and a single stdout chunk can carry several JSONL lines that each normalize
to an event — un-awaited concurrent appends would race `event_index`'s
`COALESCE(MAX+1, 0)` read. The `runtime_event_sink` race was pre-existing
(found via this phase's own test, the first to produce two
`RuntimeSemanticEvent`s from one remote-run stdout chunk) and fixed
alongside it; that fix needs only the in-process chain, since `run_events`'
uniqueness is per-run and `tryAcquireExecutionLock` already guarantees one
process per run. `host_thread_events`' cursor is per-**thread**, spanning
every run dispatched into it, so the in-process chain alone is not enough —
a `createSerializedThreadEventSink` instance is scoped to one Run, and two
concurrently active Runs on the same thread (not currently prevented by
anything in phase 1 — Phase P2's queue is what will make this scenario rare
in practice) would each hold an independent chain and could still race.
`PgHostThreadEventRepository.append()` closes that gap at the database
level: the whole batch runs inside one transaction holding
`pg_advisory_xact_lock(hashtext('host_thread_events:' || threadId))`, so its
constructor takes a real `Pool`, not the generic `Queryable` most repos in
this module accept (same reasoning as `evolution/bundleRepository.ts`, which
needs the identical connection control for its own advisory locks).

`host_thread_events` carries no `data_exposure_level`/redaction-tier column
the way `run_events` does — `tool_input_summary` is a 200-char-bounded raw
`JSON.stringify` of a tool's input, readable by any Project member with read
access via the events endpoint, not gated by host ownership. This is
consistent with the already-accepted low-trust model for remote-host CLI
runs (the daemon already uploads full unredacted diffs/output files today),
not a new exposure category, but the asymmetry with `run_events` was found
during P1 discovery review and is recorded here as a conscious, accepted gap
rather than an oversight — a redaction-tier column is deferred, not built,
since a real redaction system is disproportionate for what P1 needs.

## The work surface a dispatched Run reports back through

A remote Run that carries tool grants is given a way to call Rainver back, and
it is the same one a server-host Run gets: two files and a few environment
variables, with no branch on which runtime is executing.

The launch frame gains `work_surface` — `{ env, files, dir_env }`, the same
shape `provider_binding` uses and for the same reason (the control plane names
relative paths; only the machine knows absolute ones). The launch frame is
`HostLaunchFrameSchema` on the shared wire contract (see the WebSocket
section): the server's `dispatchLaunch` is typed against it and the daemon
hands the parsed frame to execution by spread, tested against a
fully-populated `Required<HostLaunchFrame>` so a field added to the contract
fails the daemon's test until execution receives it. The daemon materializes
it under `<config dir>/runs/<run_id>/`, exports the resulting environment over
the binding's and the machine's, and removes the directory when the Run ends.
`RAINVER_CLI` names a launcher the daemon generates there, pointing at the
`rainver` command in `@rainver/agent-cli` through the same Node the daemon
runs — the command is a script, not an executable, and nothing is installed
onto `PATH` (ADR 0016 §6).

Which Skill a Run gets is decided from the Run (`workSkillOptionsForRun`): a
conversation turn — it has a Session — reads "your reply is the message the
person reads; the commands record the Project alongside it" and names
`project.propose_definition`, `task.create` and `proposal.decide`, while a
dispatched Task keeps "nothing you write in your reply reaches Rainver"; the
output-delivery section is rendered only when `artifact.submit` was actually
granted. The dispatched default was rendered for every remote run, so a Room
agent was told its reply reached nobody and sent to an action it did not have.

The Run's identity is a `run_tool_identities` row, issued with the surface and
revoked on every exit path from the adapter. It is durable rather than
in-process because a remote CLI keeps running across a server restart, and it
carries the content hash of the Skill that Run was given, so explaining the
Run later can name the exact text it saw. The token is not a provider
credential and selects no model backend, so ADR 0008 and B67 — both about
upstream credentials — are untouched by it.

`RAINVER_API_URL` is the address *this host* reaches the control plane at,
derived from `hosts.daemon_server_url` (its origin and path, so a control
plane behind a path prefix is not truncated). The server cannot guess it: its
own hostname is a Compose service name no paired machine resolves. A host that
reported none is offered no surface at all rather than one pointing somewhere
unreachable.

A remote Run is also the only path where `artifact.submit` is granted. The
daemon uploads whatever the Run left in `$RAINVER_OUTPUT_DIR`, and
`recordOutputArtifacts` applies the Run's declarations to those uploads —
giving each file the declared `artifact_type` and linking it to its Task with
the declared role, which is what lets settlement match
`tasks.required_outputs_json` and close the Task. A declaration whose file
never arrived is reported into the Task's own stream rather than dropped.

## No server-brokered Runtime Context for a remote run (D1)

`RunOrchestrationService.prepareRuntimeContext` and `enforceRuntimePolicy`
both branch on `hostKind`: a remote run skips the Runtime Context Gateway
entirely (no retrieval, no provider/model resolution — planning a
Delivery would fail outright anyway, since there is no bound provider to
resolve a default model from), skips CLI credential-profile/tool-version
resolution, and never has its `required_sandbox_level` escalated past the
dispatch endpoint's `none` (`resolveSandboxLevelForRuntime` is server-host-only
policy for a workspace the server itself provisions). The daemon runs the
vendor CLI bare, auto-approving edits/commands in the workspace
(trusted-host default — the user reviews the returned diff instead).

## Host daemon (`packages/host-daemon`, binary `rainver-host`)

A deliberately thin bridge — no planner, no memory, no business logic (ADR
0016 principle: "the daemon must not become a second Rainver"). Config at
`~/.rainver-host/config.json` (override root via
`RAINVER_HOST_CONFIG_DIR`), mode 0600, the **only** place a workspace's
real local path is ever written down.

- `rainver-host register --server <url> --code <pairing-code>` — exchanges
  the pairing code for a bearer token.
- `rainver-host unregister` — revokes this Host on the control plane, stops
  its systemd service, and removes the local bearer credential and workspace
  path map. `--local-only` skips remote revocation with an explicit warning.
- `rainver-host workspace add <path> --project <project_id> [--name <name>]`
  — registers a pre-existing local directory (no mkdir/clone/scan, unlike the
  server-host `create` flow). Requires an explicit `project_id` in phase 1 —
  no cross-space "my projects" picker exists yet.
- `rainver-host workspace list` / `workspace remove <id>`.
- The private `dist/daemon.js` systemd entrypoint opens the WS connection, sends
  `hello`, including workspace status reports, then `heartbeat` once on
  `hello_ack` (now knowing the server's `runtime_probes`) and every 15s after;
  reconnects with exponential backoff
  (1s → 30s cap) on any disconnect. Handles `launch`/`terminate` frames
  (`src/execution.ts`): spawns the rendered argv in the local workspace path
  (resolved from the daemon's own `config.workspaces` map by
  `workspace_location_id` — the server never sees the real path), injects
  `RAINVER_OUTPUT_DIR` as a per-run directory outside the workspace
  (phase-1 substitute for Run Exchange), streams stdout as `output` frames,
  and on exit uploads the workspace's git diff (`src/gitDiff.ts` — unified
  `git diff HEAD` with untracked files staged via intent-to-add so new file
  content shows up, reset immediately after so nothing is left staged) and
  the output directory's contents (`src/outputFiles.ts`, UTF-8 only — a
  binary deliverable is a known phase-1 gap) before sending `complete`.
  **`RAINVER_OUTPUT_DIR` is no longer nudged via the prompt** (real-usage
  finding, 2026-08-22): every remote dispatch is workspace-bound, and the
  intent-to-add diff capture above already gives a brand-new file's full
  content, so `remoteHostCliAdapter.ts` stopped instructing the agent to
  write deliverables there — it was misdirecting ordinary workspace writes.
  The env var and upload path stay wired (dormant unless something writes
  there unprompted); a real, structured "information for Rainver itself"
  channel — distinct from workspace file changes — is a deferred design
  question, not this fix (`tasks/deferred-register.md`).
  Termination uses `process.kill(-pid, signal)` against the whole process
  group (`detached: true` at spawn), escalating a graceful `SIGTERM` to
  `SIGKILL` after a 5s grace window if the process ignores it.
  A `host_revoked` or `invalid_token` policy close is terminal rather than a
  reconnect: the daemon removes its local registration, terminates active Run
  process groups, and exits successfully so systemd does not restart it.

Linux distribution uses three rolling public GitHub Releases: `host-stable`
from `master`, `host-edge` from each relevant `dev` push, and `host-nightly`
from the scheduled `dev` build. Each has separate x64/arm64 base, adapter, and
fallback-Node assets, a SHA-256 manifest, and `install-host.sh`; a target host
therefore needs neither a source checkout nor pnpm. A channel-neutral
`host-installer` bootstrap published from `master` is the single public install
URL; it validates the selected channel's installer before executing it, with
`stable` as the default. The installer keeps immutable build directories below
`~/.local/share/rainver-host/releases/`, atomically moves `current`, installs a
systemd user unit, and captures the installing user's PATH for CLI discovery.
The daemon launcher loads the owner-only `service.env` itself before Node
starts; the unit does not rely on systemd `EnvironmentFile` parsing, whose
quoted-path handling can silently discard the captured PATH and reduce
discovery to system directories.
The one-time installer needs no pairing arguments: the installed
`rainver-host register` command exchanges the code and then enables and
restarts the service. Restarting is required even when the unit is already
active because the daemon holds the server URL and bearer token it loaded at
process start; this also makes the fresh WebSocket `hello_ack` deliver the
complete runtime-probe catalog before capability detection. `--auto-update`
optionally installs a six-hour systemd timer;
updates request a daemon restart only when no Run is launching, executing, or
uploading. Each channel also publishes its checksummed `BUILD_ID` as a small
standalone asset. An update compares it with the active build before fetching
Node, daemon, or adapter archives and returns immediately on a match; changing
the timer setting still takes effect on that no-op path. The archive's own
`BUILD_ID` must match the standalone metadata before installation. After the
one-time installer bootstrap, `rainver-host update` owns manual updates,
channel selection, and the optional timer toggle; the selected channel
persists locally and the installer path remains an internal implementation
detail. The package version is read from package metadata, while a release
archive's `BUILD_ID` appends the publishing commit to `daemon_version`, so the
rolling channel remains diagnosable without numbered release tags. See
`packages/host-daemon/README.md`.

The base release excludes both vendor CLI binaries and ACP adapter packages.
It prefers a compatible system Node.js 24 and downloads a single shared Node
fallback only when required, so retained daemon builds do not duplicate the
runtime. When heartbeat discovery later finds `codex` or `claude` on the
captured PATH, the daemon invokes the installed updater to download and verify
the channel's separate adapter pack before reporting that runtime. The bridges
then use the PATH-resolved vendor executable (`CODEX_PATH` and
`CLAUDE_CODE_EXECUTABLE` respectively); an absent vendor CLI makes only that
runtime unavailable.

Managed Agent workspaces are derived only on the daemon: a launch frame names
`workspace.kind = managed`, an Agent id, and either a Conversation or
direct-chat container id. Conversation workspaces are shared at
`conversations/<conversationId>`; direct workspaces remain under
`agents/<agentId>/direct/<userId>`. The server never receives those paths.
`managed_workspace_archive` renames a live directory to a timestamped
`.removed-…` sibling, `managed_workspace_restore` brings back the newest
archive when no live directory exists, and heartbeat sweeps archives older
than 30 days. Heartbeats report only Agent/container ids and the boolean
`archived_available` flag.

Capability discovery (`src/capabilities.ts`) probes PATH via `--version` for
`git` plus every runtime binary the server named in `hello_ack.runtime_probes`
(one per implemented ACP adapter spec — the daemon holds no list of its own,
so the first hello of a fresh daemon reports only `git` until the heartbeat
sent right after the ack). Absent binaries are silently omitted, never
installed or version-managed by the daemon (that stays a `runtimeTools`-style
server concern for the server host only — trusted hosts use whatever the
machine already has).

## Known P1 gaps (not defects — explicitly deferred)

- No scored multi-location routing or lease/scheduler: Conversation dispatch
  uses its pinned active Location, while any remaining Task selection is an
  explicit control-center choice; richer routing remains P2.
- No automated daemon-process-to-live-server integration test — the wire
  contract is verified from the server side (`server/test/hostsRoutes.test.ts`
  drives the real REST + WebSocket surface with the exact frame shapes the
  daemon sends); the daemon's own `fetch`/`WebSocket` client code is
  exercised only by unit tests plus the plan's manual exit demo.
- `workspace list`'s "local_path" merge trusts this machine's own config file
  against the server's registered set; the two can diverge if a workspace is
  removed server-side directly — shown, not reconciled.
- **Host name squatting**: `uq_hosts_owner_name` has no status filter, so an
  abandoned `pending_pairing` row (expired, never exchanged) or a `revoked`
  host permanently occupies its name — there is no automatic cleanup, and a
  later pairing currently needs a different display name. A cleanup policy
  for expired pending rows and retained revoked audit rows is a reasonable
  P2+ addition, not required for P1.
- Remote proposal/apply governance, content synchronization, divergence
  detection, quota probing, and real Windows-native/WSL hardware verification
  remain deferred. Location `execution_ready` is persisted and heartbeat-
  driven now; it is deliberately not inferred from Host liveness.
