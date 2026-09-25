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
commits that followed, retired 2026-08-28). So is the task-branch merge plan
(`task-branch-merge-plan.md`, ADR 0016 §11: P1 in `bf27f3c5`, P2–P3 in
`8353eaec`, retired 2026-09-24); its decisions and deviations are the Task
worktree and "Merging a done Task" sections below. The later ACP runtime authority
reset removed Host-wide ModelProvider defaults, their routes and UI. Current
backend choice is Profile-owned; a selected Profile's authorized provider
binding may be materialized into the Host launch frame, but Hosts do not
select or default that binding. **This document describes the current system.**

## Purpose

`hosts` is the control-plane registry of ExecutionHosts: the instance's
built-in host (exactly one row, seeded automatically, `owner_user_id` NULL)
and any personal machine a user has paired. It owns pairing, authentication,
and liveness for hosts — it does not execute anything itself and does not know
any host's real filesystem paths.

Both kinds run the **same** daemon (`packages/host-daemon`), in one of two
trust modes chosen at registration (ADR 0016 §2). A paired machine is
`trusted`: native spawn, no namespace. The built-in host is `strict`: the
daemon runs inside the `sandbox-runner` container and wraps every Run in its
own rootless bubblewrap namespace.

## The built-in host

The instance's own execution host is the `rainver-host` daemon inside
`sandbox-runner`. It is not paired: at startup the server publishes a
registration credential into a directory both containers share
(`<RAINVER_HOME>/cache/builtin-host/registration.json`, mounted read-only at
`/runner/builtin-host`), and the daemon adopts it
(`hosts/builtinRegistration.ts` on the server, `builtinRegistration.ts` on the
daemon). Publishing is idempotent — the file is rewritten only when it is
missing, unreadable, or no longer hashes to the row's `token_hash` — because a
token rotated on every boot would cut the instance off from its own execution
host at each restart. The server keeps only a hash, so a lost file necessarily
means a new token; the daemon re-reads the file on every reconnect and, unlike
a revoked paired host, never disables itself over a rejected token.

The row is `kind = 'server'`, `owner_user_id` NULL, and its status now follows
the daemon connection like any other host's. It used to be reported
permanently `online` because it was an in-process boundary with no heartbeat
to be stale; that would now hide the one failure an operator most needs to
see. It cannot be revoked (`revoke` is `kind = 'remote'`-only, and
`/hosts/me/revoke` refuses an ownerless host), and the pairing flow never
lists it — a pairing code always creates a `remote` row.

**Managing it is instance-admin work, dispatching to it is not.** There is one
copy of a runtime per instance and everyone spends it, so installing,
removing, and logging a copy in or out are admin actions:
`resolveOwnedHost(..., { allowBuiltin: true })` marks the routes that reach it
and falls through to `requireInstanceAdmin`. It answers 403 rather than 404
there, unlike a paired host someone does not own, because the built-in host is
on every member's host list already. The routes that stay 404 for it are the
ones that mean nothing here: attaching an existing directory on the machine
(ADR 0016 §4 — its Locations are always managed workspaces under the
instance's workspace root), browsing its directories, its provider-proxy
address (it reaches the proxy in-network), and any Host-level provider
binding/default. When a supported Profile selects `model_provider`, its
Run-scoped binding is carried with that Run; it is not stored as a Host
default.

`BUILTIN_HOST_MAX_CONCURRENT_RUNS` (default 3) is how many Runs it executes at
once, surfaced as `max_concurrent_runs` on `GET /api/v1/hosts` and shown on
its card. bubblewrap has no cgroups, so this and the container's own
`cpus`/`mem_limit` are the only levers, and both are sized per machine rather
than per Run.

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
  contains a filesystem path, and it lists workspaces only — runtime profiles
  are not reported, so nothing outside the daemon enumerates them.

Each ACP installation's heartbeat also records normalized prompt capabilities
under `installations[*].options.prompt_capabilities`: `image`,
`embedded_context`, and `resource_link`. Missing ACP optional variants become
explicit `false` values after a successful initialize; a probe that could not
initialize remains `null` and is treated as unknown by conversation admission.
Conversation image eligibility intersects this runtime report with the selected
provider/model's known image capability when Rainver owns that Provider binding.
For an unbound Host-owned ACP CLI, the runtime's initialize capability is the
authoritative image answer because the model is selected inside the ACP session.
The daemon resolves server-issued live-folder `ResourceLink` ids to registered
Workspace Location paths only after validating the launch's explicit access set;
it never accepts an absolute path from the browser or launch payload. Current
Files & Code attachments are database-backed immutable message resources, so
they do not materialize as Host temporary files and do not enter this path
resolver. Legacy live-folder links retain the existing containment checks: for
the built-in Host, Location paths are relative to the shared instance workspace
root and checked lexically and by canonical `realpath`; a paired Host uses only
its registered local path map.

Managed workspaces are daemon-owned directories, not Workspace Locations. A
launch names an Agent and either a Conversation id or the direct owner's user
id; the daemon derives the directory under its private config root. The server can
request archive/restore actions and records a pending archive when the daemon
is offline, but it never receives or stores the derived path.

Conversation launches carry a Run-start Git snapshot (`branch`, commit, dirty
state, readiness, and source/location identity) in the immutable Run contract.
For a registered Location the snapshot comes from the current Location row;
for a managed workspace it records the managed-workspace source and readiness.
The Conversation execution context stores the baseline used to admit the next
turn. A changed branch, commit, or readiness blocks direct and Room sends until
the user explicitly refreshes that baseline. This is an admission/read-model
control only: neither the browser nor the Host protocol gains branch switching,
commit, push, or deployment authority.

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

- `POST /api/v1/hosts/pairing-codes` — `{ name }` → `{ host_id, pairing_code, expires_at }` (13-character Crockford base32, 10 min TTL).
- `GET /api/v1/hosts` — the server host plus every remote host the caller owns.
- `GET /api/v1/hosts/execution-targets?project_id=` — the caller's online
  remote hosts and ACP installations, plus the built-in host, which is listed
  whether or not it is online. Without `project_id`, hosts have no
  registered Locations; with it, only Locations in that readable Project are
  returned. Every target advertises the managed-workspace choice. This is the
  canonical Host/CLI/Workspace candidate projection for both Project Settings
  and Conversation first-Run setup; neither surface derives a separate list
  from Agent runtime profiles. Conversation preflight resolves each target
  against the Host's current capability report: native login or a successful
  ACP session admits the installation, including anonymous model choices.
  Each target carries `host_kind` (`server` | `remote`,
  `HostExecutionTargetSchema` in `packages/protocol/src/hosts.ts`), and that
  field — never a label — is the lifecycle authority the composer and the
  execution-target picker branch on. `host_name` for the built-in host is the
  product string **"Server Runtime"**, substituted in
  `projectFolders/workspaceLocations.ts`; it is presentation and must not be
  parsed back into authority.
- `GET /api/v1/hosts/runtime-definitions` — the static ACP runtime catalog the
  frontend reads instead of re-deriving eligibility. Per runtime:
  `runtime_key`, `display_name`, launch `command`, `capability_probe`,
  `remote_eligible`, `registry_id`, `latest_managed_version`,
  `server_supported_version`, `reports_managed_cli_version`, `provider_api`
  (`claude_compatible`, `openai_compatible`, or `vendor` — OpenCode, which
  follows each Provider's vendor protocol; the composer's Provider picker then
  requires the URL that protocol needs),
  and the two backend-mode flags `supports_runtime_native` /
  `supports_model_provider`, read from the same `AgentRuntimeDefinition` that
  Profile admission enforces so the composer cannot offer a mode the server
  answers with 422. There is no `provider_binding` field on this endpoint.
- `POST /api/v1/hosts/:hostId/revoke` — terminal; a revoked host's token stops
  authenticating. Also closes the host's live WebSocket connection
  immediately if it has one (`HostConnectionRegistry.closeConnection`) — so
  revoke cuts off an already-connected daemon right away, not just its next
  reconnect attempt.

Unauthenticated (the pairing code itself is the one-time credential):

- `POST /api/v1/hosts/register` — `{ pairing_code, platform?, arch?, daemon_version?, capabilities_json? }` → `{ host_id, token, name }`. Failed and successful attempts from one *source* are rate-limited (10 / 10 minutes), persisted under the instance cache so a restart does not hand a caller who has just spent their quota a fresh one. The snapshot is written when a bucket fills and otherwise at most every 30s, so a restart can lose the most recent attempts of a bucket that is not yet full — the window is a floor, not an exact replay. The source is the caller's address for IPv4 and its **/64** for IPv6 (`rateLimitKey`), because a /64 is the smallest block an ISP hands out and counting whole v6 addresses gave one caller the full quota once per address; an IPv4-mapped `::ffff:` spelling, which is how a proxy writes a v4 caller into `X-Forwarded-For`, is keyed as the v4 address it is rather than sharing one bucket with every other mapped caller. The window map is bounded (10 000 sources, least-recently-touched evicted) so an unauthenticated caller cannot grow it without limit, and the snapshot is written asynchronously — a synchronous write per attempt was itself a way to stall the event loop from this unauthenticated path.

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
  The diff body is `HostRunDiffUploadSchema` (`@rainver/protocol`): `diff`
  (null when none could be captured) and optional `git_before` / `git_after
  { branch, head }` — where the Run's checkout stood before and after it (see
  "Location lease, Task worktrees and `git_after`" below). `recordDiffArtifact`
  writes `git_after` to the Run's `output_json.workspace_after` (kept through
  finalization) and, under the conditions listed there, to
  `conversation_execution_contexts.last_run_git_branch/head`; a body with
  only git fields records no artifact.

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

### Profile-owned backend selection and Host launch

Hosts have no ModelProvider defaults, host×runtime binding table, or
`runtime-provider-bindings` API. `AgentRuntimeProfile` is the only Agent
backend authority: it pins `runtime_key`, `backend_mode`, and, when the
selected runtime supports it, a same-Space ModelProvider and explicit model.
Routing validates that Profile against the Agent Run's Space and the provider
grant before the immutable Run snapshot is dispatched. A Host cannot choose a
different provider or fall back to a Host-wide default.

For a supported Profile binding, the Server authorizes credential spend and
creates a short-lived, Run-scoped proxy lease. The optional `provider_binding`
launch frame contains only the proxy address, lease token, model and
Profile-scoped configuration files; the upstream API key remains inside the
Server/provider boundary. The Host daemon writes the supplied bytes into the
Run's isolated runtime profile and starts ACP. Native mode instead links the
runtime to its owner-controlled Host login without copying credential bytes.
Switching backend mode changes the runtime profile key so a session created
under one backend is not resumed under another.

The proxy address is resolved from server configuration and the Host's
registered control-plane context, never from a daemon-reported URL or an
untrusted request header. `PROVIDER_PROXY_PORT` and any externally published
port remain deployment settings. Host revocation removes its active leases;
terminal Runs revoke their Run lease. See
[`AGENT_RUNTIME_AUTHORITY.md`](../architecture/AGENT_RUNTIME_AUTHORITY.md)
and [`CREDENTIAL_STORAGE.md`](../architecture/CREDENTIAL_STORAGE.md) for the
Profile and credential boundaries.

### The runtime profile: one per Agent × container

`profile_key` is
`agents/<agent_id>/<container_kind>/<container_id>/<runtime_key>/<provider_id|ambient>`,
and the profile lives at
`agents/<agent_id>/profiles/<container_kind>/<container_id>/<runtime_key>/<provider_id|ambient>`
under the daemon's config directory — beside the Agent's managed workspaces,
not inside them. The container is the **Conversation** for a Room turn, the
**owner** for a direct chat, and the **WorkspaceLocation** for everything else
(a Task thread, an Automation, a Plan or Workflow node, an evolution run whose
Folder prefers a remote Location — none of which has a conversation to be the
boundary of). A Location thread's vendor session therefore lives in the
profile of the Agent whose Run last used it, while the thread itself carries
no Agent (`ck_host_threads_owner`). Task admission reads the latest Run's
Agent beside its status: when the Agent dispatched now is a different one, the
session is retired at admission (`retireLocationSessionForAgentChange`,
recorded in `retired_vendor_session_ids`) and the Run starts a fresh session
in its own profile, rather than resuming into another Agent's profile and
resetting mid-turn with "no such conversation". Switching a Task's Agent is
thus a fresh session, by design.
`resolveRuntimeProfileScope` reads the container from `host_threads`, not from
the launch workspace: a Conversation pinned to a registered Location has
`workspace.kind = "location"` while still being a Conversation, and keying off
the workspace would put two Rooms back into one directory.

**Every host-bound Agent run carries a profile**, including a run with no
ModelProvider binding — the frame then has empty `files`, empty `env`, and only
`profile_env` plus `login_link`, and the provider segment is the literal
`ambient`. This is what changed in the Agent identity work
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §6): the key used to be
`<adapter_type>/<provider_id>`, shared by every run with that adapter and
provider on the machine, and an unbound run had no profile at all and simply
read the machine's own `~/.claude` or `~/.codex`. Both were the leak — two
Agents on one machine, and one Agent in two Rooms, shared one login, one
session store, and one pile of vendor auto-memory. The CLI's own working memory
is still delegated scratch that Rainver never reads, syncs or promotes; what
keeps it from crossing a boundary is this key.

Never per-run, in either shape. A CLI keeps its conversation state inside the
profile, so a profile deleted when its run exits takes with it the session the
next turn is about to resume: every turn after the first then fails with the
runtime reporting no such conversation, and the thread is reset. Keeping one
per Agent × container × adapter × backend keeps a conversation resumable for as
long as its backend does not change, and makes changing the backend start a
fresh session rather than resume one whose context another vendor's model
produced. The daemon validates every segment before building a path from it —
it runs unsandboxed on a machine the user owns.

Two consequences of a profile that outlives its run: a written config keeps
that run's lease token after the lease is revoked (a dead credential in a 0700
directory; the provider's real key is never there), and two concurrent runs of
the same Agent in the same container on the same backend share the directory,
so one can end up using a sibling run's lease — same upstream, but usage
attributes to the sibling.

**All three runtimes need a profile**, and all three keep conversation state
inside one: Claude Code under `CLAUDE_CONFIG_DIR`, Codex under
`CODEX_HOME/sessions/YYYY/MM/DD`, OpenCode under `HOME/.local/share/opencode`
— for a **bound** run reached through `HOME`, since `XDG_DATA_HOME` is not on
B67's allowlist and there would be nothing to point; an unbound run points the
XDG roots instead and keeps the machine's `HOME` (below).
Each profile's state-root variables are set so that every `home_subdir` a
login spec names resolves inside it. Nothing brokers a profile from the control
plane on either host kind (ADR 0016), so environment injection alone would
leave the machine's own `~/.claude` or `~/.codex` in play.

The frame's `credential_source` tells the daemon which of two environment
rules applies, and they are deliberately different:

- `provider_lease` — B67 in full. The machine contributes nothing to which
  backend, credential or upstream the runtime reaches, so the ambient
  environment is rebuilt from `filterAmbientEnv`'s allowlist. Unchanged from
  before this phase, including its stated cost: a bound run cannot see
  `~/.gitconfig` or `~/.ssh`.
- `host_login` — B67's closing rule stands: a run with no binding is not
  affected. It keeps `HOME` and therefore `~/.gitconfig` and `~/.ssh/config`,
  the proxy variables, and the language toolchains a paired machine needs.
  `clearStateRootEnv` drops two closed sets and nothing else: the four XDG
  **roots** by exact name, and the vendor prefixes **the launched runtime**
  reads as a credential or a state root — `ANTHROPIC_*`/`CLAUDE_*` for Claude
  Code, `OPENAI_*`/`CODEX_*` for Codex, `GEMINI_*`/`GOOGLE_*` for Gemini CLI
  (the `GOOGLE_` family is how it chooses between API-key and Vertex billing),
  every vendor prefix for OpenCode (it routes to whichever provider it finds a
  key for) and for a runtime the daemon does not know. Per runtime, not one
  list for all: `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT` are
  how gcloud and a GCS toolchain authenticate in a Task run, and Claude Code
  reads neither. The XDG set is named rather than prefixed on purpose:
  `XDG_RUNTIME_DIR` is how a git credential helper reaches the keyring and how
  rootless podman finds its socket, so dropping it would break a Task run that
  pushes or builds — the same class of regression as moving `HOME`. The
  credential set matters as much as the state roots: this run exists to spend
  the owner's *subscription*, linked into its profile, and a runtime that
  prefers an ambient `ANTHROPIC_API_KEY` bills an API account instead — B67's
  own second named failure.

The daemon's own short-lived **helper** spawns take the same rule through one
builder, `helperProcessEnv(ambient, adapterType, { keepStateRoots? })`: the
machine's environment minus that runtime's vendor credentials. These are the
version probe, the installer, the `login --help` capability check, the Codex
usage probe and the ambient `session/list`. Each of them used to spread
`process.env` whole or delete two named keys beside it — a denylist of length
two, so a new vendor key was picked up by every one of them. `keepStateRoots`
is the one deliberate exception: a helper that reads the machine's *own*
history must be pointed at where that history is, and `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` / `OPENCODE_CONFIG` / `GEMINI_CONFIG_DIR` share a prefix with the
credentials, so clearing by prefix sent `session/list` to the default location
and reported the machine as having no history at all. Those four are named
rather than prefix-matched, because that is exactly the distinction.

The daemon's credential-carrying HTTP calls use `redirect: "error"`: the
control-plane calls in `api.ts`, which carry this host's long-lived bearer
token, and the Claude usage probe in `usageProbe.ts`, which carries the
*owner's OAuth access token* — a different credential, and the reason that one
matters as much. A followed redirect would hand either to whatever host the
response named, and these endpoints have no legitimate redirect. The adapter
download is the deliberate exception: it follows redirects, because a release
asset always 302s, and re-applies the https requirement to where it landed.

The state root is therefore **not** `HOME` for an unbound run. Each runtime
names its own, and each is the variable that runtime's binding already uses:
`CLAUDE_CONFIG_DIR` for Claude Code (its transcripts and its
`.credentials.json` both live there), `CODEX_HOME` for Codex, and the XDG
roots for OpenCode, whose data directory is `$XDG_DATA_HOME/opencode` before
it falls back to `HOME/.local/share/opencode`. A **bound** run still gets
`HOME: "."`, because B67 wants the machine contributing nothing at all, and
pays for it by losing `~/.gitconfig` and `~/.ssh` — a cost recorded in the
deferred register and unchanged by this phase.

Redirecting `HOME` for unbound runs too was considered and rejected: it would
have broken `git commit` (no author identity) and `git push` (no ssh config)
for every Task run on a paired machine, which is a price the memory boundary
does not need to pay. OpenCode's XDG redirect is the one state root **not
verified on a real host** — if it ignores `XDG_DATA_HOME`, its state stays
machine-global, which is no worse than before this phase but is not the
isolation claimed here. See the deferred register.

This granularity extends the HostThread's opaque `vendor_session_id` to the
Runtime Context cursor. The HostThread and Runtime Context binding must resume
the same ACP session; a mismatch or authority rotation starts a fresh session.
The server does not materialize CLI state directories on a remote Host.

### Login state: one per host × installation, shared by link

An Agent-managed login (a subscription, no ModelProvider binding) is the main
path for CLI conversations — the driving need is that subscription quota is
usable for them — and a login per Agent × container profile would multiply
logins by Agents × Rooms. So the login stays where it was:

- each host × installation has exactly one **login home** — the machine's own
  `~/.claude` / `~/.codex` / OpenCode data directory for `own`, the adapter's
  stable managed HOME for `managed:<version>` — and login happens there through the
  existing login stream;
- when the daemon materializes a profile for an **unbound** run, it links
  **only** the runtime's credential file (the `credential_file` under
  `home_subdir` the login spec already names) from that login home into the
  profile. Everything else in the profile — sessions, auto-memory, settings —
  is the profile's own;
- a runtime that declares **no** login/state-root spec is not host-executable.
  A dynamic ACP registry agent is the current case: moving it into an empty
  profile would break authentication, while leaving it in the managed copy's
  shared home would mix sessions and auto-memory across Agents. Dispatch fails
  closed with `runtime_profile_isolation_unsupported` until its registry entry
  can name the credential file and state-root variable; the host adapter
  catalog therefore exposes such a copy for installation/management but marks
  it `remote_eligible: false`, and the default-adapter endpoint refuses it;
- a link, never a copy and never a token in the environment. Passing the
  credential through `CLAUDE_CODE_OAUTH_TOKEN` or its equivalents would mean
  Rainver read a credential and injected it into a subprocess, the shape
  [ADR 0008](../decisions/0008-credential-channel-isolation.md) forbids. A
  symlink is tried first and a hard link is the fallback, because Windows
  refuses `symlink` without Developer Mode;
- missing login file → the profile is created without the link, and the first
  dispatch surfaces the runtime's own login prompt. That is the intended
  behavior. A symlink already at the target is removed then, because it points
  into a login home that has no credential any more (for example after logout)
  and the runtime's own login would otherwise write through it
  into a removed directory; a regular file there is a credential this profile
  holds itself and is left alone;
- a symlink at the target is followed and checked: while it still resolves to
  *this* login home there is nothing to do, since a symlink tracks a re-login
  by path on its own. When it does not — the profile key carries no
  installation, so the same directory is reached again after an Agent moves
  between `own` and `managed:<version>`, or after a managed copy is replaced
  and its tree removed — it is dangling or authenticating as the wrong
  installation, and it is relinked. A regular file is the Windows hard-link
  fallback or a
  credential the runtime refreshed into the profile itself, and once a
  temp-file rename has dropped the shared inode's link count the two look
  identical on disk. **Recency decides**: a login home newer than the target is
  followed (relinked), a profile that refreshed itself later is left alone —
  and logged, once per launch, as no longer sharing that login, because that
  divergence is the one state nothing else on the machine would ever surface
  (a hard link to the same inode, the Windows fallback, is not divergence).
  Without that, a hard link would pin a profile to an orphaned inode silently
  and forever. A link that *fails* throws rather than leaving the run to
  discover it has no credential — a headless dispatch cannot answer a login
  prompt. **Not yet verified on a paired host**: whether each runtime refreshes
  in place or by temp-file rename, and whether a rotating refresh token would
  invalidate the siblings. See the deferred register;
- provider-bound runs are unchanged: the profile carries the lease
  configuration and no login link, because linking the machine's subscription
  credential into a profile that is not using it puts a credential where it
  does not belong.

### Archiving what an Agent leaves behind

Profiles join the archive-not-delete rule the managed workspaces already
follow, on the same 30-day sweep. Two things move, with different owners:

- the Agent's **runtime profile** is the Agent's alone, so it is archived
  whenever that Agent leaves — removed from a Room, or its direct session
  deleted — which is what keeps what it learned there out of the next Room;
- the **workspace** is shared by every Agent in a Conversation, so it follows
  only when the last one leaves. `include_workspace` on the
  `managed_workspace_archive` / `_restore` frames says which of the two the
  daemon should move, computed by `listPendingManagedWorkspaceArchives` and
  `closeConversationAgentForRoom` rather than guessed on the host.

The re-add offer and the restore itself now ask the same question — "is there
a closed thread for this Agent in this Room on this host" — rather than two
different ones. The candidate flag is `host_state_archive_available`; it used
to require a managed workspace *and* a heartbeat entry reporting one archived,
which was false for every Room specialist because a conversation heartbeat
entry carries no `agent_id` by contract, so the offer never appeared at all.

Restoring rides the existing "restore workspace" request, and its target query
is deliberately **not** gated on an archived workspace being available: that
gate was right when the workspace was the only thing archived, and now the
common case — one Agent leaves while others stay — archives only the profile,
so requiring a workspace archive would have made every one of those
permanently unrestorable and swept after 30 days. The workspace half is a flag
on the same request. The daemon restores whichever archives exist and reports
what moved; the workspace goes first, because a live shared cwd is a real
conflict and a live profile only means this Agent has dispatched here since.

The old `<configDir>/profiles/<adapter>/<provider>` tree — the shared logins,
session stores and dead lease tokens the new key exists to end — is archived by
the daemon on connect (`archiveLegacyProfileTree`, to `profiles.removed-<ts>`
at the config root) and swept with every other archive after the retention
window. Nothing reads it; it is moved aside rather than deleted, like every
other retired directory here.

`POST /api/v1/agents/:agentId/host-state/reset` is the **"clear this Agent's
CLI memory on this host"** action: owner-only twice over (the caller must own
the Host, and be the Agent's owner when it has one), it archives every profile
the Agent has on that machine, touches no workspace, and refuses while a
dispatch holds a lock **or a Run is still in flight** on one of the Agent's
threads — a Task or Automation thread never claims the lock and serialises on
its latest Run's status instead, so the guard asks both, else the Run's outcome
would re-arm a retired thread with a session whose store is gone. Which threads
are the Agent's: those carrying its `agent_id`, and the Location threads whose
**latest** Run was its (that is where the session currently lives; an earlier
Run of the same Agent does not make a session now in another Agent's profile
this reset's to retire). Inside one transaction it retires that Agent's vendor
sessions through the existing `session_reset` path **first**, then asks the
host, and rolls the retirement back if the host refuses. The two orderings fail
differently and only one is recoverable: a thread still claiming a
`vendor_session_id` whose store has been archived resumes into nothing, while a
thread reset without the archive happening starts a fresh session in a profile
that still holds the old one — wasteful, visible in the error the caller gets,
and fixed by running it again. There is no web surface for it yet.

A remote run is given up on for two distinct reasons, and the failure says
which: `runtime_timeout` when the whole run budget elapsed, and
`runtime_stall_timeout` when the runtime produced no output for the stall
budget. Both carry how long the runtime had been silent. The stall budget is
one rule for both execution paths (`runs/stallTimeout.ts`): five minutes by
default, `adapter_config.stall_timeout_seconds` per dispatch, never longer
than the run budget. The remote path briefly used a third of the run budget
instead — 100s for the default — which killed legitimate turns in the middle
of a long tool call, since a runtime busy inside one emits nothing until it
returns; the Run then retried from scratch on the same run id. The remote path
originally accepted the option and never implemented it, so a runtime that went
quiet — an OpenCode turn waiting on a free-tier model that never answered —
burned the entire timeout and then reported only that it "timed out", which is
equally true of a run that worked the whole time. Both codes are retryable.
Their server-host twins `cli_adapter_timeout` and `cli_stall_timeout` went with
the sandbox line (ADR 0016): nothing emits them, and the retry set no longer
lists them.

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
  request into `<config dir>/tools/<runtime_key>/<version>/`, with its own
  stable HOME at `<config dir>/managed-state/<runtime_key>/home/`, separate
  from the machine's own CLI and other adapters. Removal deletes binaries,
  retaining managed user state for reinstallation.

For a managed Claude or Codex copy, `<version>` is the ACP adapter package
version. The adapter spec also declares a fixed command for reading the vendor
CLI bundled inside that package. Installation records that answer separately as
`runtime_version`. The Host card displays only that vendor CLI version; the ACP
package and its version remain internal installation details. A failed metadata
probe does not fail the installation and is shown as an unavailable CLI version.

`hello_ack.runtime_probes` is the daemon's initial whole catalog, one entry per
adapter: the PATH binary to look for (`runtime`, null for a registry agent),
the launch `argv`, the `distribution` to install a managed copy from (a
builtin spec names its ACP registry entry — `distribution: { registry_id }` —
resolved by the acpAgents refresh loop, persisted in instance settings and
read from memory, never fetched on the hello path; a registry agent carries
a snapshot), and the `login` knowledge (`credentials.login` in the spec:
command, `managed_command` inside a tree, `home_subdir`, `credential_file`).
Every
`heartbeat_ack` carries the current catalog again; when enabling an ACP agent
changes it, the connected daemon adopts the new probes and immediately sends a
fresh heartbeat, so installing an agent never requires a daemon reconnect.

A runtime on a host has **one identity: runtime key × copy**, and
everything about a copy lives on the copy. The capability report is
`{ runtimes, versions, installations }`: `installations[runtime_key]` holds
one `{ id, version, logged_in, options }` per copy. `logged_in` describes
native account state: the configured credential file for built-ins, or the
ACP authentication result for an Agent without a login spec. Separately,
`options.session_available` records whether `session/new` succeeded. It can
be true while `logged_in` is false: a CLI can offer anonymous models through
ACP without a native account. The ACP probe opens a temporary session and
reads `configOptions`, including the generic `category: "model"` selector;
Rainver does not maintain a CLI-specific model catalog. When session setup
answers `auth_required`, it tries one advertised Agent-Auth method and asks
again. A refused authenticate reports session unavailable; an unrelated
failure is inconclusive and keeps advertised login methods. `options.auth_methods`
holds ACP auth flows; `options.cli_login_available` is a separate verified
Rainver compatibility capability, never an ACP method. The Space Assistant
accepts a copy with either a signed-in native account or a successful ACP
session, without assuming every advertised model is anonymously callable.
`runtimes`/`versions` are the plain PATH inventory (vendor binaries and git),
for display only.
The shape is the protocol's (`packages/protocol/src/hosts.ts`:
`HostCapabilitiesSchema`), so server and web share one definition and the
server validates what it stores and serves. Daemon and server deploy together;
`hosts/capabilities.ts` accepts only the current installations shape and does
not translate obsolete heartbeat layouts.

Install (`POST /api/v1/hosts/:hostId/installations/:runtimeKey`, host owner)
sends `install_tool { request_id, runtime_key, version, distribution, login,
runtime_version_command }`;
the daemon materializes the distribution — `npx` as a pinned `npm install
--prefix`, `uvx` as `uv tool install` with a private `UV_TOOL_DIR`, `binary`
as an https download verified against its sha256 and extracted — behind a
staging rename, writes `manifest.json` (absolute command, args, env, `home`,
the rendered `login_command`), answers `tool_result { installation }` and
heartbeats. `DELETE .../installations/:runtimeKey/:installation` sends
`uninstall_tool`; only a managed copy can be removed.

An install of a *different* version is an upgrade, and an upgrade replaces the
runtime every Run of that Agent is talking to. So the daemon drains that
adapter's Runs first and, if the drain does not converge inside five minutes,
refuses the upgrade rather than killing anything — "still in use" is an
ordinary answer here, not a fault. It then keeps exactly one previous version
directory (ADR 0016 §9). Both versions use the same managed HOME: login, native
history, Skills and configuration survive upgrade, reinstall and pruning.
`POST .../installations/:runtimeKey/rollback` (`rollback_tool`) drains the same
way, deletes the current binaries, and promotes the previous version without
rewinding user data. The host reports only the current
copy plus `rollback_version`, so an Agent has one version per host and one
place to undo it. During a replacement — install, rollback or removal — that
adapter's door is held closed on the host: a launch, a verification command
and a usage probe are all refused with "being upgraded, retry in a moment"
rather than started against a directory about to be renamed away. Draining
alone would not do it, because a drain reports quiet and the download that
follows takes long enough for the next dispatch to arrive.
Runtime artifact downloads stream into a temporary file, using one request
while it succeeds. A broken connection retries within the bounded download
deadline, resuming from the last written byte when a checksum or HTTP validator
can protect the join; a publisher that ignores Range starts a fresh copy.
Every retry repeats the guarded HTTPS/redirect/address checks. The shorter
inactivity timeout resets on each received chunk, and the verified file is
renamed into place only after the complete transfer and optional SHA-256 check.
The control plane's install wait also covers the download budget and health
check.

The built-in Host also carries the instance-admin-selected network transport on
`install_tool`; paired Hosts use direct download. `direct` keeps public-address
pinning. `system_tun` accepts only hostname fake-IP answers with no real
private/internal answer, and pins the selected fake address for the TUN.
`http_proxy` uses the configured HTTP(S) CONNECT proxy unless a NO_PROXY
exception selects direct; the upstream proxy owns final DNS resolution.
Non-direct binary downloads require a pinned SHA-256. A saved mode change
applies to the next install request, including an explicit OpenCode retry.

**The Server Runtime's own copy reconciles itself.**
`hosts/serverOpenCodeProvisioner.ts` runs every 15s
(`scheduler/backgroundServices.ts`) and drives one release-pinned OpenCode copy
on the built-in host toward `runtimeAdapters/opencodeRelease.ts`, through the
same `install_tool` lifecycle a paired host's owner triggers by hand — there is
no second, Server-direct installer. Desired state lives in
`host_runtime_provisioning` (`hosts/runtimeProvisioningRepository.ts`), and
`claim()` is an atomic `queued → installing` transition so only one process
owns an install. The owner then *heartbeats* that claim on every later tick
while it waits on the daemon, because `last_attempt_at` would otherwise only
record when the install began, and a long install would be indistinguishable
from one whose process died — a second Server process would fail it out from
under its owner. `running` and the owned claim are per-instance, so there is
exactly one provisioner per process (`sharedServerOpenCodeProvisioner`): the
scheduler builds it and the admin retry route *wakes* it rather than building
a one-shot instance whose claim nothing would then heartbeat.
Only a claim that has gone `INSTALL_HEARTBEAT_STALE_MS` without a heartbeat is
declared interrupted, and the placeholder that leaves behind is the one error
message the daemon's real answer is allowed to replace; every other failure
stays sticky until an explicit owner retry or a new pinned release. A paired
host is never provisioned this way: the reconciler resolves the built-in host
by authority and refuses to write desired state for anything else.

The states are `queued → installing → ready | failed`, and only `failed` is
retryable: `retry()` moves `failed → queued` and nothing else, so a `ready` or
`installing` row answers the route with 409. Two routes expose the row, both in
`hosts/routes.ts` and both 404 on a host that is not `kind = 'server'`:

- `GET /api/v1/hosts/:hostId/runtime-provisioning/opencode` — the
  `serverOpenCodeProvisioningStatus` projection: installation state, desired /
  installed / active version, error, attempt count, and the active copy's
  native-login account summary.
- `POST /api/v1/hosts/:hostId/runtime-provisioning/opencode/retry` — host-owner
  (built-in allowed); requeues a failed row, wakes the process-wide
  provisioner for one reconcile, answers 202.

**A version becomes active only after it answers ACP.** `complete()` is
reached only when the host reports `managed:<desired version>` with
`health_check_protocol === "acp"`; a copy that installed but does not speak ACP
leaves the row short of `ready`, and a `ready` row whose healthy copy has
disappeared is requeued for another health check rather than trusted. That same
transaction is what activates the version for Agents: under `FOR UPDATE` it
writes `state = 'ready'` plus `installed_version`, repoints
`agent_runtime_profiles.runtime_installation` from `managed:pending` (and from
the previous `managed:<version>` for a default Profile) to the new copy, and
records one `host_runtime_changes` row only when the version actually changed.
The previous version directory stays on disk under the daemon's one-previous
rule, so `POST .../installations/opencode/rollback` remains the undo.

**Where the artifact comes from differs by host kind.**
`runtimeProbes.ts`'s `resolveDistribution(spec, hostKind)` returns
`SERVER_OPENCODE_RELEASE` — the release-pinned archive and sha256 in
`runtimeAdapters/opencodeRelease.ts` — for the built-in host's OpenCode, and
the ACP registry entry for every other host/runtime pair. A probe with no host
kind named means `"remote"`, so only the Server Host's own install path sees
the pin.

Install, upgrade, rollback and removal are recorded in
`host_runtime_changes` and listed on the Updates page
(`GET /api/v1/hosts/runtime-changes`); `hosts/usageService.ts`'s
`recordHostRuntimeChange` is the one writer, used by the routes and by the
provisioner's own completion transaction alike. The host's own report stays the
authority on what is installed now.

**Installation readiness gates the Server Runtime only.** A route candidate is
admitted only when its Profile's runtime installation is healthy *on the
built-in host* (`routing/repository.ts`'s `hostInstallationReady` short-circuits
for any other host kind). A paired Host's runtime lifecycle belongs to its
owner, not to the control plane: nothing here knows when they will install or
upgrade a copy, and refusing a Profile because the machine is currently offline
or a version behind would make routing guess at someone else's machine. The
cost of that asymmetry is explicit — a Profile naming a `managed:x` copy the
paired Host does not have passes admission and fails at launch, where the host
itself answers.
`GET /api/v1/hosts/runtime-adapters` also exposes each adapter's current
registry version. The Host card compares it with the installed package and
shows its compact CLI upgrade control only while they differ; neither internal
package version is exposed in that UI.

The stable HOME protects files, not a vendor guarantee that older binaries can
read newer session formats.

**Subscription quota.** `usage_probe { runtime_key, installation, login,
timeout_seconds }` asks a host what one copy has left; the daemon reads that
copy's own login and answers `usage_probe_result { quota }` — percentages,
reset text, and a reason when it could not read one. Never the credential.
Claude's is an OAuth call against `api.anthropic.com/api/oauth/usage`; Codex's
runs `codex -s read-only -a untrusted app-server` and asks
`account/rateLimits/read`, recovering the numbers from the refusal an
over-limit account gets. Anything else answers "no subscription quota" rather
than launching a CLI to learn nothing. The control plane caches the answer in
`host_runtime_usage`, refreshes every three hours, folds in the live reading a
finished Run carries back, and shows it beside the copy on the host card.
`GET /api/v1/hosts/:hostId/usage` is a cache read; `POST
.../installations/:runtimeKey/:installation/usage` is the probe. One gate reads
the cache: an Agent-triggered Room turn waits while its login is past the
Space's `subscription_quota.reserve_pct` (`rooms/quotaGate.ts`, `modules/rooms.md`
"Subscription quota gate"), probing first when the reading is older than a
minute; that probe keeps a readable cached number rather than overwriting it
with "offline" or "did not answer in time" (`keepReadingWhenUnreadable`). The
host's own usage endpoint is its owner's; a Room shows more widely only what
its conversations run on: any member of the Room reads, for the logins its
Agents run on in that conversation, the window's percentage and reset time
under the label "Runtime · Host (installation)" (`GET …/conversations/:id/quota`,
a discussion's cost lines) — the account window is what a discussion's header
must show, and it carries no credential or account identity.

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
set to that copy's home and the same per-runtime vendor credential filter a
Run uses (`clearVendorCredentialEnv`), so leftover `ANTHROPIC_*` / `CLAUDE_*`
/ `CODEX_*` keys cannot divert the login onto an API account. Output comes back as
`login_output` frames (`{ type: "output" }` on the stream, rendered as-is by
the browser's terminal emulator, escape codes included; http(s) URLs in it
are clickable through the web-links addon); typed text goes
through `POST .../login/input` →
`login_input` — a real terminal in the browser (`LoginTerminalView`, xterm.js,
loaded on first use) renders the PTY stream and sends every keystroke as the
byte sequence a terminal would, so vendor pickers such as `opencode auth
login` work with arrow keys and Enter; keystrokes are sent one request each,
chained to keep their order. Input is bounded at three points that do not
rely on each other: the wire schema and the route cap one message at
`LOGIN_INPUT_MAX_CHARS` (4096, 413 above it), and the daemon's session
admits input through a token bucket (32 KiB burst, 8 KiB/s) — a too-fast
frame is dropped with a one-line notice and the session goes on — and a
256 KiB lifetime budget, which ends the session with a visible reason.
Known limits: the grid is fixed at `LOGIN_TERMINAL_COLS × LOGIN_TERMINAL_ROWS`
at both ends (no resize frame yet; `script(1)` gives the daemon no PTY fd to
resize), so the browser scrolls sideways when the card is narrower; and input
travels one authenticated request per batch of keystrokes rather than over a
socket, which is why the daemon bounds it.
None of that is an authorization boundary — stdin reaches only the fixed
login program the adapter spec names, behind `exec`, so there is never a
shell to type into — it bounds the channel to what a keyboard can produce;
the command's exit is `login_exit { exit_code, logged_in }`,
after which the daemon clears that copy's ACP capability cache and heartbeats
so both `installations[].logged_in` and its advertised auth methods are current.
Some Agents advertise Agent Auth but wait indefinitely for credentials their
own CLI must create first (Cursor: `agent login`, then `authenticate` with
`cursor_login`). A managed installation without an explicit login spec is
probed with its fixed top-level `login --help`; when that succeeds, Rainver
reports a separate restricted **CLI login** compatibility capability without
altering any Agent Auth or Terminal Auth method the Agent advertised. In the
host card that copy shows **one** Log in — the CLI login, the step a person
has to do — and not the advertised Agent-Auth method beside it: that
handshake runs unattended afterwards, in the daemon's probe and in every Run
session (`cliConversationProtocol.ts` answers an authenticate-first
`session/new` with `authenticate` and reopens the session; a refused
`authenticate` fails the Run with a "log this Agent in on its host first"
error). Agents without the CLI fallback still show every method they
advertised. The login request selects either an ACP method id or this
Rainver-owned action, never a synthetic ACP method. It runs only that
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
closed stream sends `login_close`. This is the only login path there is — the
server-side login engine that once owned the server host's own profiles is
gone (ADR 0016 §7), and the built-in host logs in through this same terminal.
The daemon terminal never reads or copies credential contents.
It may **link** one owner's login file into that owner's Agent profiles on the
same machine (above) — the CLI opens its own file and the daemon never holds
the bytes.

**Logout and accounts.** `login_action=logout` runs the vendor's own logout
from the login spec (`logout_command`, or `managed_logout_command` inside a
managed tree: `claude /logout`, `codex logout`, `opencode auth logout`), or —
for a registry agent Rainver logs in through its fixed `<entry> login` — that
same entry's `logout`; anything else is refused (422), never guessed. It runs
in the copy's HOME on the same PTY terminal, so OpenCode's picker over stored
providers works as the "remove one account" it is. A CLI whose credential
file holds several accounts declares `accounts_format` in its login spec
(`json_object_by_provider`, OpenCode's `auth.json`); the daemon reports each
copy's `accounts` as provider ids and credential kinds (`api`, `oauth`) and
never reads past the `type` field. The host card shows such a copy as
`own · 1.18 · 2 accounts` with the names on hover, its login as **Add
account** and its logout as **Remove account**; a single-account CLI keeps
**Log in / Log in again** (a login replaces the account) and gains **Log out**
while logged in.

Enabling a registry agent (`modules/acpAgents`, instance admin) publishes a
dynamic adapter `acp_<id>` (`runtimeAdapters/dynamicSpecs.ts`) whose command
is its adapter type and whose only copies are managed ones
(`remote_host_only`, low trust, `credential_mode: "cli_profile"`, so
`supportsRuntimeBackendMode` admits only `runtime_native`). Every process
reloads the enabled set at startup and every 60s. Disabling is refused (409)
while any host still reports a copy (`GET /api/v1/acp-agents` lists
`installed_on`), so nothing is orphaned on a machine and no pinned thread
stalls silently. ADR 0016 is amended in place for managed copies; the
machine's own installs are still never touched.

In the UI (command center → Hosts) this is host-major: each remote host card
has an **Agents** section listing only the agents that host has a copy of,
with source (`own`/`managed`), a cleaned version number that does not repeat
the Agent name, log-in / remove, and an "Add agent…"
picker that is one list, the ACP registry — nothing is shown above it as a
default: the builtin CLIs are ordinary registry entries there (mapped through
the spec's `registry_id`) and offer **Install** like any enabled agent. The card does not repeat the raw PATH runtime
inventory above this list (and does not surface the daemon's Git utility as an
Agent). The card presents Agent copies and host-local install/login state; it
has no Host-level ModelProvider selector or default. Backend selection belongs
to the Agent's Runtime Profile, and the runtime registry determines whether
that Profile may use a provider-backed mode. Login remains per installation
and is not a Host-wide ModelProvider default. The
picker lazily reads the registry for every host owner: search results remain
visible while installing and after installation, with explicit
**Installing…** and **Installed** states. A not-yet-enabled entry offers one
**Enable & install** action: the server first snapshots and enables it
instance-wide, then installs its managed copy on that host. An enabled entry
that is absent from this host offers **Install**. A failed install leaves the
successfully enabled catalog entry visible and reports the partial outcome;
the picker never sends an arbitrary registry distribution directly to the
daemon. A non-admin host owner sees only the entries that need no enabling —
the builtin CLIs and already-enabled agents. No agent is labelled "built-in": the builtin
CLIs and registry agents differ only in server-side capability (provider
binding and usage projections), which is not a Host concern. The Host owns
ACP launch and process lifecycle; the server owns policy and tool authority.

The instance admin's **ACP registry** panel on Instance Settings
(`modules/instance_settings/AcpRegistryPanel`) is the instance-wide management
surface: enabled agents (Disable, refused while installed anywhere) and a
registry search to Enable an entry without installing it on a particular
host. Installing one on a machine is still a host action, on the host card.

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
The allowlist is the same shape the deleted server-host path used.
A run on the machine's own login is governed by the other rule instead: it
keeps the machine's environment apart from `clearStateRootEnv`'s two sets, and
carries a runtime profile of its own — see "The runtime profile" above.

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
No hand-written mapping is left anywhere on this wire: the Runner that held the
last one is deleted, and every host speaks this contract.

`hello` (the upgrade already authenticated the host bearer; hello records
capabilities, applies the daemon's complete workspace Location reports, and
answers `hello_ack { host_id, runtime_probes }`)
and `heartbeat` (refreshes `last_heartbeat_at`, reported capabilities, and
Location branch/head/dirty/readiness). A remote Location omitted from a
heartbeat is marked `execution_ready = false`. On socket close, the host is
marked `offline` immediately; Host liveness remains distinct from Location
readiness.
A `hello` reporting a daemon older than `MIN_HOST_DAEMON_VERSION`
(`hosts/daemonCompatibility.ts`, currently `0.4.0` — the release that merges a
done Task's branch: the `task_merge_*` frames and a resolution Run launched
into the Task worktree as a merge left it) is refused with
`daemon_outdated`: the reported version is recorded and the host stays offline
rather than accepting Runs an older daemon would fail one at a time, so a
paired host must update before it can execute again. The refused daemon
recognises that close (`isOutdatedDaemonClose` in `commands/run.ts`), logs the
update instruction once and retries on a 15-minute floor rather than the
ordinary ≤30s backoff, so an un-updated host does not re-record its version
every half minute; its registration stays valid, unlike revocation.
Heartbeat staleness (`hosts/liveness.ts`: `HEARTBEAT_STALE_MS`, 45s) is
computed at read time wherever a host's status is read, not swept by a
background job — a host that dies without closing its socket reports offline
the next time anyone lists hosts.

The dev Vite entrypoint proxies `/internal` with WebSocket upgrade forwarding
to the server service, so a daemon registered against the browser's dev origin
(`http://localhost:3000` in dev) can use the same origin for its outbound WS.
The production nginx image (`apps/web/nginx.conf`) exposes exactly
`/internal/hosts/ws` the same way and nothing else under `/internal/` — the
other routes there are service-to-service and stay behind the internal token,
unreachable from the public entrypoint. The upgrade itself requires
`Authorization: Bearer` (a pairing code is not a bearer); hello still has to
run before other frames. `server/test/frontendProxy.test.ts` pins both halves.
The Command Center's `HostsPanel` refreshes only its own host list every three
seconds while mounted; it does not reload the page or trigger unrelated module
queries. This is a component-scoped read refresh, not a general browser
real-time event layer (none exists).

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

A `launch` the daemon queues behind another writer of its Location is
answered with `waiting_for_workspace` (same nonce) before its `launched`; see
"Location lease, Task worktrees and `git_after`".

Request pairs carry a Task branch's lifecycle (ADR 0016 §11), routed by
`HostConnectionRegistry.requestTaskBranch` / `receiveTaskBranchResult` and
answered in the reply's own shape when the host is offline or silent
(`host_offline`, `host_timeout`, fifteen minutes): `task_run_settle` →
`task_run_settle_result { branch, commit }` ends one Run on the branch, and
`task_branch_delete` → `task_branch_delete_result { deleted }` removes a
cancelled or deleted Task's branch and worktree, and the merge steps
`task_merge_prepare` / `task_merge_continue` → `task_merge_step_result`,
`task_merge_abort` → `task_merge_abort_result` and `task_merge_finish` →
`task_merge_finish_result` land a done one. Each names the Task by a
Location workspace carrying `worktree: { task_id }` (`HostTaskWorkspaceSchema`).
A Run that executed in its Task worktree also reports
`complete.task_worktree { branch, start_commit }`. See "Location lease, Task
worktrees and `git_after`".

C5: the daemon also sends a live `stderr` frame per chunk (not only the
`complete` frame's existing failure-tail), routed the same way as `output`
through a new `HostConnectionRegistry.receiveStderr`/`onStderr` pair.

Workspace registration is reachable from the web UI through three owner-only
frames the daemon answers: `list_dirs` (one level of subdirectory names for an
absolute path — lazy, ≤500 entries, directories only), `workspace_register`
(runs the daemon's own `workspace add` validation and registration, so
terminal and UI produce identical state), and `workspace_forget` (drops the
local path mapping after a server-side unregister; offline daemons keep it and
`workspace list` shows the divergence). Hosts do not store a preferred Agent
runtime: the selected AgentRuntimeProfile determines the runtime, while the
execution-target picker uses the built-in Server Runtime as its product
default (found by `host_kind === 'server'`, not by its name) and requires
explicit selection for paired Hosts.

Files & Code uses a separate bounded pull on the same socket: `folder_read`
(server → daemon, Location id + relative path + Folder protection flag) and
`folder_read_result` (daemon → server, one `tree`, `file`, `git_status`, or
`git_diff` result). The daemon resolves the registered root, applies
`@rainver/folder-read` PathPolicy and size limits, and never sends an absolute
path. The server authorizes the requested active Location for its registered owner,
records `force_record` audit metadata including `host_id`, and maps offline,
timeout, forbidden, and missing-location outcomes to structured HTTP errors.

Save to Folder uses a matching bounded write exchange after the server has
flushed and revalidated the exact owner draft version:
`folder_write` (server → daemon, Location id, relative path, content, and the
observed existence/hash) and `folder_write_result` (daemon → server, resulting
existence/hash and bounded metadata). Only the server-authorized owner can reach
this path; the daemon resolves the Location from its local registration and
never accepts an absolute filesystem path. This is a direct human save, not an
Agent Run and not a `code_patch` proposal; history restore never reaches the
daemon until the user explicitly saves the resulting draft. Explicit UTF-16
conversion carries a narrow conversion flag; compensating rollback carries the
original encoding so a failed save restores the byte encoding rather than
silently leaving a UTF-8 replacement.

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
COALESCE) whenever a resume degrades (`session_reset`) — which
`recordHostThreadOutcome` concludes only when the runtime proved it: the Run
failed with `runtime_session_invalid`, or finished a turn without a session id.
A resume the runtime never answered — `session/resume` sent, no reply before the
stall timeout or deadline — is reported as `runtime_session_invalid` too
(`resume_unanswered`), so a session that hangs on load is given up instead of
timing out every turn. A Run that failed before the runtime tried (the host
offline, a launch that waited out its budget behind another writer, a person's
stop, a runtime silent before it initialized) leaves the session in place. A
Run that reports on a session the thread has since retired (dispatched before
a rotation or reset, run after it — held for the subscription window, say)
records only that it was the last Run: the retired session is never written
back, nor its identity digest or occupancy. Clearing rather than preserving the id matters: retrying an
already-broken vendor session id forever was a real P3 discovery-review bug,
fixed before this landed. **Since the phase-2 event-pipeline work**, it is called
from `agentRunHandler.ts`'s `handleAgentRun` (via
`server/src/modules/hosts/threadOutcome.ts`'s `recordHostThreadOutcome`)
once the dispatched Run's `agent_run` job reaches terminal — not from the
dispatch route itself, which no longer waits around for that. Every session id a thread moves on from — reset, close, or a degraded resume — is appended to `retired_vendor_session_ids`, and ambient session import excludes those alongside the live id; clearing the live id alone would let the Agent's old sessions come back as the owner's own history.

`recordRunOutcome` also keeps what the live vendor session holds.
`identity_digest` / `identity_digest_run_id` name the standing context (identity
block + Room rules) it last received, written only for a Run that carried the
block and completed, and cleared when the session is replaced or reset
(`modules/rooms.md`). `context_tokens` / `context_window_tokens` are the
occupancy the runtime last reported through ACP `usage_update` (`used`,
`size`), carried on the Run's `output_json.result.context_window`; a runtime
that reports none leaves them null, and such a thread never rotates. A drop in
reported occupancy within one session means the vendor compacted it, which may
have summarized the standing context away, so it clears the digest and the
next turn sends the block again. A runtime that reports nothing gives no such
signal: its compaction can drop the block unnoticed until the session is
replaced (a residual).

### Session rotation with a self-written handoff (`agentGroups/sessionHandoff.ts`)

When a Room turn would resume a Conversation × Agent session whose reported
occupancy is at or past 60 % of its window (`roomContextBudgets.rotate_at`,
below any vendor's own auto-compaction; the share is the fixed
`ROOM_SESSION_ROTATE_SHARE` — no Space policy overrides it yet, see the
deferred register), the send first creates a **handoff
turn**: an ordinary Room Run for the same Agent, placed in the Conversation's
serial chain immediately before that Agent's own turn, resuming the old
session, whose prompt is the
Prompt Library asset `agent.handoff` and whose only granted action is
`handoff.write` (policy action `handoff.write`, `declared_resource`, ungated).
The action writes one `agent_handoff` Artifact per handoff Run (a second call
in the same turn replaces that turn's document, the Agent correcting itself; a
later handoff or a retry writes its own, so the document a rotation used is
never overwritten) — goal, decisions taken, files and their state, next step,
open questions —
bounded to 4 % of the window, visible to exactly whom the Run was
(`selected_users` inheriting the Run's grants). Its Runtime Context input is
its own request, with no conversation window — the resumed session already
holds the conversation, and a window read then would end in the person's
pending message. Its reply is posted neither to the transcript nor to the
group timeline, and a later recipient's admission is never handed it as a
reply. The renewed session's replay is sized without the "no summary"
widening, so it does not start near the rotation share again. The person's turn is parked behind it and carries, beside the
prompt it was dispatched with, the fresh prompt it switches to: standing
context, the conversation title, the handoff, and the replay window.

The rotation happens where that turn is admitted
(`AgentGroupRunLifecycleProjector`), in one transaction: when the handoff Run
succeeded and wrote its document, `rotateAfterHandoff` retires the session
(`session_reset`, `vendor_session_id` null, digest and occupancy cleared,
`handoff_artifact_id` set), the turn's prompt and `host_thread` override
become the fresh ones, and an internal marker message
(`continuation_event_kind = session_handoff`) keeps replay order. The handoff
Run's own outcome can arrive afterwards and is ignored for the thread it
already rotated. A handoff that failed or wrote nothing records a `warning`
Run event on the turn, which then resumes the old session; the vendor's own
compaction stays the safety net, and the same session is not handed off again
until it has grown by a tenth of its window since that attempt. Rotation
retires only the session the handoff was written from: a reset while the
handoff ran leaves the thread as the reset left it, and an explicit context
reset clears the handoff as well. Any later fresh prompt on the thread — a
renewed turn that failed before its session existed, a broken resume —
carries the last handoff, and a thread with no vendor session is always
treated as fresh. Stopping the person's parked turn stops its handoff turn
too; a stopped Run, or one that never started, is never read as a broken
resume. The
execution-context summary reports each pinned Agent's occupancy and links its
handoff. Real-host acceptance is recorded in `tasks/deferred-register.md`.

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
onto `PATH` (ADR 0016 §7).

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

`RAINVER_API_URL` is the address *this host* reaches the control plane at:
`hostControlPlaneUrl`, which is `FRONTEND_URL` for a paired host (origin and
path, so a control plane behind a path prefix is not truncated) and the
in-network address for the built-in host. It is configuration: neither the
daemon's report nor the request that carried it can move where a Run's bearer
token is sent. `hosts.daemon_server_url` is no longer read or written; the
column drop waits in the deferred register. Production nginx forwards `/api/`
and `/internal/hosts/ws` and nothing else, which is why the tool surface a
paired host's children call lives at `/api/v1/runs/:runId/tools…`: it is gated
by the Run's own bearer token, not by the instance token `/internal` carries,
and a Run reaches the instance through `FRONTEND_URL` like any other client.
The dev Vite proxy forwards that one WebSocket path rather than all of
`/internal`, so dev exposes exactly what production does.

A remote Run is also the only path where `artifact.submit` is granted. The
daemon uploads whatever the Run left in `$RAINVER_OUTPUT_DIR`, and
`recordOutputArtifacts` applies the Run's declarations to those uploads —
giving each file the declared `artifact_type` and linking it to its Task with
the declared role, which is what lets settlement match
`tasks.required_outputs_json` and close the Task. A declaration whose file
never arrived is reported into the Task's own stream rather than dropped.

## Runtime Context Delivery through ACP

Every Agent Run, on either the built-in Server Host or a paired Host, passes
through the server-owned Runtime Context Gateway. The Gateway authorizes,
plans and records the Delivery; orchestration projects its semantic sections
into ACP's single user-prompt channel. ACP does not expose a distinct system
message role, so the projection labels authoritative Agent/task instructions,
reference data and the current user input. Those labels do not replace
server-side authorization: live tools and side effects still pass through the
Run-scoped gateway and policy checks. Runtime Context does not grant the daemon
additional filesystem access or change the Host trust model.

For a persistent HostThread, the Runtime Context event cursor follows the same
opaque ACP vendor session id. When the session and context binding disagree,
or the binding rotates with changed authority, orchestration starts a fresh
ACP session rather than resuming stale transcript state. A threadless Run gets
a full Delivery and does not persist an unused cursor.

## Dispatch: the runtime decides, not the machine

Every `local_cli` runtime is dispatched to a host daemon —
`dispatchesToHostDaemon(runtime_key)` (`runs/runRemoteness.ts`) is the one
predicate, and it asks about the runtime, not the host. The built-in host is a
daemon like any other, so a CLI Run on a server Location goes over the same
WebSocket a paired machine's does. Bounded ProviderTask calls remain
Server-owned invocations and are not Agent runtime executors.

That distinction decides more than where a process starts. The Server prepares
Runtime Context Delivery and the permission snapshot, while the daemon owns
runtime launch, local paths and namespace construction. A daemon Run's tools
are reached through the `rainver` work surface, separately from its prompt
context; the daemon uploads diffs/output for Server-side materialization. The
server-local CLI Run Exchange is not used by the current ACP Agent path.
`hostKind` is left meaning only *which machine*. It decides where a Run's
**ModelProvider** spend is checked, not whether: the Run executor checks a
server-host Run's recorded provider before it starts, and a daemon Run on
either kind of host is checked when its proxy lease is minted — no lease exists
without a decided spend. The `cli_profile` credential check is gone with the
server-host CLI branch that raised it — a daemon Run spends the copy's own
login, which no server-side profile grants.

`resolveExecutionPort` returns a `HostDaemonExecutionAdapter` for a CLI Run on
either kind of host, and for a CLI Run with nothing bound only when its runtime
profile snapshot carries a managed workspace: that names a Conversation or a
direct owner, which is the container B68 keys a profile by. A CLI Run with
neither a Location nor one of those has no container at all, and minting a
per-run one is what B68 forbids — it reaches the adapter registry's fail-closed
entry instead of executing somewhere undefined.

**Who may dispatch** follows the host's trust mode, per the two safety models
(ADR 0016 §3, B63). A paired host serves its own owner: `prepareRemoteTaskRun`
rejects a caller who is not `host_owner_user_id`. The built-in host has no
owner, so that check does not apply to it and the authorization is the Project
write access the task-run admission already verified — the per-Run namespace is
what makes serving every Space safe. The dispatch also states an `isolation`
policy (`dispatchIsolation`): `sandbox_mode` from the Run's
`required_sandbox_level`, and `default` egress unless the dispatch asked for
`install` (`model_override_json.egress_profile`, which the server composes and
no request body reaches). A *standing* grant on the Agent runtime profile is
deliberately not read: writing a runtime profile takes only read access to an
ordinary Agent and `runtime_config_json` is free-form, so a privilege honoured
from there is one any member who can see the Agent could grant themselves.
Nothing reads the key, and the two runtime-profile routes refuse it outright
rather than accepting it silently — a config blob written through another
route still carries it harmlessly, because there is no reader. Granting `install` through the
product needs an authorization surface — ADR 0017 puts egress in the Exposure
row — and that is in the deferred register.

**The same ownership fact sets routing's effective trust for a paired Host.**
A Run whose responsible user is that Host's `owner_user_id` counts as at least
`medium` (`routing/repository.ts`'s `effectiveTrustLevel`, reading the boolean
`host_dispatch_permitted` already computed), so the product-default
`medium`-risk Agent routes to its owner's own machine; a Run there by anyone
else keeps the runtime baseline and is refused `execution_host_not_permitted`
first. The built-in host's `medium` is its per-Run namespace, a different
control for the same level. Neither reaches `high`, so `high`/`critical`-risk
Agents have no candidate on either host. Owner trust says who bears the risk —
it is not a containment claim, and a paired host still spawns natively with no
namespace (B62, ADR 0016 §3 and its 2026-09-21 owner-trust amendment; the
table is in `architecture/ROUTING.md`, "Effective trust").

**Capacity.** `HostConnectionRegistry.dispatchLaunch` takes the built-in host's
cap and queues past it, releasing a slot on every path that ends a Run — a
`complete` frame, an offline host, a disconnect that outlasted its grace
window. An uncapped dispatch still sends its `launch` synchronously: awaiting
unconditionally would push the send and its pending entry into a microtask, a
window in which a frame for that run has no dispatch to route to.

## Where the sandbox line went

`modules/sandbox.md` is retired. The dedicated Runner service, its private
protocol (`server/src/modules/sandboxRunner/`), the server-side vendor CLI
adapter and `sandbox/runner.mjs` are deleted: every CLI
runtime is dispatched to a host daemon now, and the isolation that service
provided is the strict-mode namespace documented above.

Two things that document described still exist and moved here rather than
disappearing. **Run Exchange** is server-host-only and no longer reachable from
a CLI run at all — `HostDaemonExecutionAdapter`'s port throws, because the
Exchange is a directory pair the server stages and reads back and there is none
on another machine; a dispatched Run returns its work as a diff and as the
files the daemon uploads from `$RAINVER_OUTPUT_DIR`, which
`recordOutputArtifacts` matches against the Task's declared outputs.
**`required_sandbox_level`** remains a routing and risk value on the Run, but it
no longer selects an execution mechanism for a CLI run: the server escalates
nothing it does not provision, and what the Run actually gets is the dispatch's
`isolation` policy applied by the daemon. `projectFolders/sandbox.ts` and its
B62 guard stay, because code-patch apply and rollback still touch server-host
Locations.

## Host daemon (`packages/host-daemon`, binary `rainver-host`)

A deliberately thin bridge — no planner, no memory, no business logic (ADR
0016 principle: "the daemon must not become a second Rainver"). Config at
`~/.rainver-host/config.json` (override root via
`RAINVER_HOST_CONFIG_DIR`), mode 0600, the **only** place a workspace's
real local path is ever written down. It also records the daemon's `trust`
mode, written with the credential it registered with; a config that predates
the field is a paired host, which is all a daemon could be then.

### Location lease, Task worktrees and `git_after`

Writers on one directory are serialized; nothing else is. Two writers in one
checkout would each see, and each diff, the other's half-finished edits, so
the lease is taken by every writing launch, whatever kind of Run it is.
What stays serial is deliberate: a Room conversation's Agents — a
multi-recipient message, a discussion's waves — share the Conversation's
directory by design and run one at a time by that design, a cost accepted
until wall-clock complaints say otherwise (deferred register). An execution
Task Run avoids the wait by working in its Task's worktree (below).
`src/locationLease.ts` holds one execution lease per WorkspaceLocation id.
A `launch` whose `isolation.sandbox_mode` is not `read_only`
(`launchMayWrite`; a strict host told nothing counts as read-only, a paired
host told nothing as a writer) takes the lease of its own Location — unless
it runs in its Task's worktree, which takes the Task's lease instead — and of every `workspace_access` attachment
granted `write`, all in sorted id order so two multi-Location writers cannot
deadlock, before its baseline tree is captured. If any is held it queues in
arrival order and sends `waiting_for_workspace` once (`HostDaemonFrameSchema`).
Holders and waiters are launch attempts (`launch_id`), because a supervisor
retry reuses the run id. The leases are released together in a `finally`
right after the exit diff and HEAD are read — nothing after that reads the
directory — or in `handleLaunch` when the launch fails before spawning. A
queued launch is not in `launchingRuns` (an upgrade drain does not wait for
it) but counts for `hasInFlightRuns`; revocation cancels every queued
launch. A `read_only` Run, a managed workspace (already keyed by Conversation
or owner) and a Task worktree's own Location take no lease. On a paired host
`read_only` is the dispatch's declared intent, not enforcement. Locations are
keyed by id, so overlapping registrations are not serialized (deferred
register).

`terminate` carries the `launch_id` of the dispatch the server is waiting on:
the daemon cancels that attempt's wait or signals that attempt's process and
nothing else; a `terminate` without one cancels every queued attempt of the
run and signals its running one. An attempt still being prepared — resolving
its workspace, or between being granted its leases and spawning — is marked
stopped and completes without starting (`launchingRuns` and the stop marks are
kept per launch attempt, so a retry's cleanup never clears an earlier
attempt's entry). `HostConnectionRegistry` owes a host every
stop it could not deliver — a `terminate` while the host was offline, and a
forced stop for each dispatch given up as `host_disconnected` after the
reconnect grace window — and sends them, by launch, when the host
reconnects, so a launch the daemon still had queued for its directory never
starts after the server reported it failed. A revoked host is owed nothing
(`forgetRevokedHost`): it never reconnects, and its daemon stops its own Runs
on the revocation close.

Server side, `HostConnectionRegistry.receiveWaitingForWorkspace` marks the
live dispatch (nonce-checked) until `launched` or `complete`;
`isWaitingForWorkspace(runId)` is read by `runs/turnReadModel.ts`, which
reports a `running` Run so marked as `state: "blocked"`,
`blocked_on: "workspace"` through the existing blocked-turn rendering.
**A Run's time budget starts at `launched`.** `RemoteWsCliCommandExecutor`
arms the Run's timeout when the daemon reports the process started, as the
daemon's own timer does, so a launch queued behind another writer (or for a
built-in host slot) spends none of it; the wait itself is bounded by one
budget from dispatch, after which the dispatch ends as a timeout and a
`terminate` for it is sent. The stall clock does not run before `launched`.

**Task worktrees and Task branches (ADR 0016 §11).** `withTaskWorktree`
(`runs/remoteHostCliAdapter.ts`) sets `LaunchWorkspace.worktree: { task_id }`
for a write-capable execution Task Run on a Location — its contract came from
a Task, `run_type` is `agent`, and its sandbox level is not `read_only`
(`executionTaskId`); a planning or read-only Run and every Conversation turn
work in the checkout. The verification target carries the same workspace.

*Where.* One worktree per Task, never inside the person's checkout:
`realpath(<config>)/task-worktrees/<location_id>/<task_id>`
(`src/taskWorktree.ts`; parents created 0700 one component at a time, each a
real directory; the Task id must be a valid ref component). It checks out
`rainver/task-<task_id>`, created when absent — compare-and-swap, create-only
`update-ref` — at the tip of the main branch (`src/mainBranch.ts`: the local
branch `origin/HEAD` names, then `main`, then `master`, else the checkout's
current branch or detached commit — never a `rainver/task-*` branch, which
names no main branch, so a merge there answers `no_main_branch`; nothing is
fetched or pushed). A merge resolves the main branch the same way when it
runs, not as it was when the Task branch was made. It is made
with `git worktree add --lock` (locked because the entry records the daemon's
path, which from the built-in host's neighbours looks prunable) and nothing is
written in the checkout beyond git's own worktree entry and the branch — no
`.rainver/`, no `info/exclude`. `checkLocationRepository` decides from the
filesystem first: no real `.git` directory at the Location's top (a
subdirectory, a `.git` file pointing elsewhere) or an unborn HEAD (a freshly
`git init`ed managed folder) runs the Run in place under the Location's lease,
with `git_before`/`git_after` as for any in-place Run; a real `.git` directory
that is git's common directory with a commit gets the worktree; a real `.git`
directory git fails or refuses on (a planted `core.worktree`, a broken HEAD)
fails the launch ("This Location is a git checkout Rainver cannot make a Task
worktree of: …"), as does a worktree that cannot be prepared — a Task never
falls back to writing a checkout that is a repository. The branch is never
moved while it is checked out anywhere else.

The daemon never runs `git worktree prune`, `unlock` or `repair`: `.git` is
Agent-writable, prune deletes through a symlink planted under `.git/worktrees`
and drops the person's own entries, and repair rewrites every entry there —
a planted one makes git write a `.git` file into any directory it names. It
removes a worktree with `git worktree remove --force --force` (ten-minute
timeout, as for `add` and each capture step), and when git refuses, deletes
only a real directory that resolves to itself and then only that worktree's
own entry — a real directory under a real `<common>/worktrees` whose `gitdir`
backlink names it. Pointer files an Agent can write (a worktree's `.git`, an
entry's `gitdir`) are read with `O_NOFOLLOW|O_NONBLOCK`, as regular files, at
most 4 KiB. A worktree is recognised only when its pointer (relative ones
resolved) names a real entry under `<common>/worktrees` whose backlink points
back and git lists it at that path; when exactly one entry's backlink names
it, the daemon rewrites the pointer itself (`relinkWorktree`), and otherwise
the worktree is unrecognised. A symlink, file or FIFO at the worktree path is
unlinked, never followed.

A `<config>/task-records/<location_id>/<task_id>.creating` marker is written
before `git worktree add` and removed once the worktree checks out; a worktree
found with the marker still set (an add killed midway, which leaves a
complete-looking, partly checked-out tree) holds no Run's work and is deleted
without capture, and a command asked to run in it fails.

*Quarantine* is `<config>/task-worktrees-quarantine/<location_id>/`, one
target `<task_id>-<time>-<rand>` (and its `.git-modules` sibling) per event,
created only when something is moved there. A worktree kept **whole** is never
deleted automatically; the **parts** of a worktree whose work is on the
branch go to a `-retired` target, which the sweep deletes 30 days after the
time in its name — a repository with submodules leaves one set per Run. A
worktree goes there **whole** when a launch or branch delete
finds an unrecognised directory at the path (recognised: its `.git` names a
real entry under `<common>/worktrees` whose backlink points back, whose
`commondir` is absent or names this repository, and which git lists at that
path — `git worktree list --porcelain -z`); when git cannot capture it (at a
launch committing another Run's leftovers, at the sweep, and at settle, which
then answers `ok: false` saying the uncommitted work is not on the branch); and
when taking it down fails part-way (whatever is left). When a worktree whose
work is on the branch is taken down — at settle after its commit, at launch
after leftovers, at the sweep, at branch delete — only **parts** go there:
each directory below its top holding a `.git` (a nested repository, ignored
directories included; a symlink-free walk that does not descend into them),
and each unreadable directory, at `<target>-retired/<relative path>`, plus the entry's
`modules/` (submodule git directories) at `<target>-retired.git-modules`; the rest —
files already on the branch, and ignored files — is deleted. A nested
repository with a commit is committed only as a gitlink, so its files and
history exist only there; a preserved submodule git directory still names the
old worktree in `core.worktree` and is opened with `--work-tree`. An
unrecognised directory found by a settle is left in place (`ok: false`, no
fallback to the branch tip) and skipped by the sweep. After a settle has
recorded its commit, taking the worktree down is best-effort and the settle
still answers `ok`.

With the Task's lease held, launch, settle, delete and sweep clear exactly two
stale locks a killed git leaves — the entry's `index.lock` and
`refs/heads/rainver/task-<task_id>.lock` — when they are regular files older
than ten minutes or dated more than a minute in the future.

*Serialization.* A Task's execution Runs run one at a time. Server side, the
`agent_run` job defers (keeping its attempt) while another execution Run of
the same Task on the same Location has started and not ended — `running`,
`cancelling`, or parked on a delegated Agent or its own review request (a
failed Run a supervisor holds for review has ended and does not count) — is
`queued` with a live job and was admitted first (so two Runs checking at once
agree on an order: a Run that already started — a parked Run resuming keeps
its `started_at` — before one that has not, then by admission), or still has a
settle owed to its host (`taskRunAhead`, joined through `task_runs`). Only a
`queued` Run waits: a `running` one whose job was reclaimed after a worker
died has already taken its turn.
Daemon side, a launch takes the lease `task:<location_id>:<task_id>` (plus its
`workspace_access` write leases, but not the Location's), so a second launch
of the Task queues with `waiting_for_workspace`, and then also waits for a
verification command still running in the worktree.

*Launch.* With the lease held, `prepareTaskWorktree` deals with what it finds
— an interrupted add is deleted, an unrecognised directory quarantined, a
listed entry whose directory is gone removed, a worktree an Agent switched off
the Task branch has its content committed onto the branch and is recreated —
and
reads the per-Task record `<config>/task-records/<location_id>/<task_id>.json`
(`{ run_id, start_commit, location_root, updated_at }`, 0600, atomic; ids
validated before any path is built from them). The same run id not yet
settled (a retry, a parked Run resuming) reuses the worktree untouched and
keeps its original start commit. A run id already settled — a supervisor retry
after a failed Run's settle — continues that Run when the branch tip is still
its settled commit: the worktree is recreated at the tip, the original start
commit is kept, and its next settle replaces the earlier commit, so a retried
Run still ends as one commit; if anything landed on the branch since, it
starts from the tip. Any other Run first has an earlier unsettled Run's
leftovers committed on top of the tip as one unsigned system commit
(`Rainver <rainver@localhost>`, naming that run), and starts in a freshly
recreated worktree at the new tip. The Run's diff baseline is its start commit,
so its uploaded diff includes commits the Agent made itself. `complete`
carries `task_worktree { branch, start_commit }` only when the process ran in
the worktree, and the worktree is kept after `complete`.

*Verification.* The server verifies in the Task worktree — a `command_run`
whose workspace names the Task runs there when the worktree exists (a
read-only check: it changes nothing in the repository), in the Location when
none does, and errors when an unrecognised directory is there — and git-backed verifiers diff against the reported start commit
(`base_commit_sha`).

*Settle.* After verification, whatever the Run's outcome — also for a Run
given up on a timeout or a lost host, which never sent `complete` (a parked
Run is never settled) — orchestration asks the daemon to `task_run_settle`
(`runs/taskRunSettlement.ts`). Author and committer are the Agent at
`<agent_id>@agents.rainver.invalid`; the message is the Task title (with the
outcome when it is not `succeeded`), the first 20 lines of the Agent's
reply (redacted as the Run's stored summary is), and `Rainver-Task:` /
`Rainver-Run:` / `Requested-by:` trailers. The
daemon captures the whole working tree through a temporary index, and when it
differs from the start commit's tree writes `commit-tree --no-gpg-sign -p
<start_commit>` — squashing the Agent's own intermediate commits away — and
moves the branch by compare-and-swap from the tip it read; then it removes the
worktree. Files the repository ignores (`.gitignore`, `info/exclude`,
`core.excludesFile`) are never committed and go with the worktree — at settle,
branch delete, sweep, and whenever the worktree is recreated; a nested
repository is committed as its commit id only. Capture steps get ten minutes
each. It answers `task_busy` while a launch of the Task, a command in the
worktree or another settle, delete or sweep holds it, and refuses when the
branch no longer contains the Run's start commit. The answer is recorded in
`<config>/task-runs/<run_id>.json` with the start commit (kept 30 days); a
repeated settle replays it unless a later attempt of the same Run has
launched since, which settles anew. A Run that never ran in the worktree (the
Location is not a git checkout) is answered with neither branch nor commit,
and the server records nothing; and the server keeps it as the Run's
`output_json.result.task_branch { branch, commit, error }` — also when a
cancellation wins the terminal publication. A settle that fails is a
`task_run_settle_failed` warning, not a Run failure. One the host did not
answer (`host_offline`, `host_timeout`) or refused as busy (`task_busy`) is
owed: a durable `task_run_settle` job (`hosts/taskBranchJobs.ts`) retries it
once the Run has published, defers without spending an attempt while the host
is unavailable, gives up as `location_unavailable` once the Location is no
longer active or its host is revoked, and writes the answer into the same
record; the Task's next Run waits for it. A settle the host refused otherwise leaves
the change in the worktree for the Task's next Run or the sweep.

*Cancel and delete.* A Task moved to `cancelled` or soft-deleted enqueues, in
the same transaction, one durable `task_branch_delete` job per Location its
Runs worked on (`hosts/taskBranchJobs.ts`). The job skips a Task
reopened since and a Location no longer active, defers while a Run of the Task
has not ended (a queued one only with a live job) or its settle is owed, and defers without spending an attempt
while the host is unavailable or answers `task_busy`; a host's `hello` brings
its waiting Task branch jobs forward (`wakeTaskBranchJobs`). What these jobs
and the merge share — the job names, which host answers mean "not now" and
how long to wait (`deferForHostAnswer`), whether a Location can still answer
(`loadTaskLocation` / `taskLocationUsable`), the Task's workspace as the host
resolves it (`taskWorkspace`), the owed-settle predicate — is
`hosts/taskBranchRequests.ts`, which neither imports. The daemon
removes the worktree, deletes exactly `refs/heads/rainver/task-<task_id>` by
compare-and-swap and drops the Task's record.

*Sweep.* On connect (after `hello_ack`) and every 24 hours the daemon sweeps
Task worktrees last used more than a day ago (the record's `updated_at`, else
the directory's mtime; re-read once the Task's lease is held) with no live or
queued launch and no running command:
it commits their leftovers on top of the tip, takes the worktree down
(removed, or quarantined as above), and keeps the record so a later settle or resume still counts from the Run's
start commit. It never deletes a branch. A paired host resolves Locations from
its registrations, the built-in host from the recorded `location_root` while it
is under `RAINVER_HOST_WORKSPACES_ROOT`; a Location it cannot resolve keeps
its directory and logs a line. On the built-in host `<config>` is the
bind-mounted `cache/host-daemon`, so worktrees survive container restarts;
wiping that cache loses only uncommitted work in unsettled worktrees.

**Merging a done Task (ADR 0016 §11).** Each `done` write — automatic
acceptance (`projectWork/settlement.ts`), a person (`tasks/repository.ts`
`updateTask`), the Agent's `task.complete` (`projectWork/taskActions.ts`) —
calls `enqueueTaskMerges` (`hosts/taskMerges.ts`) in its own transaction: one
`task_merges` row per Location an execution Run of the Task names (settled or
not — a Run that closes its own Task does so before its settle, which the
merge then waits for; a Location with no Task branch answers `no_changes`),
keyed by Task × Location × basis (the write that asked), with a `task_merge`
job. An *execution Run* here and everywhere the merge looks at the Task's Runs
— which Locations it merges into, whose contract it verifies again, which
Agent resolves its conflict, who authored the Task commit — is one definition
(`tasks/executionRuns.ts`): an Agent Run allowed to write in a role other than
`planning`, `review` or `merge`. `requested_by_user_id` is whom the merge acts
for: on a paired host its owner (ADR 0016 §3), whoever closed the Task;
otherwise the person whose `done` write asked, or the Task's creator when
nobody did. The job runs as that user and a resolution Run is admitted for
them. A Task closed again replaces, on each Location, only a merge that
stopped there (a conflict, failed checks, a failure — superseded); one under
way, or verified and waiting for the checkout, is left to finish and lands
the branch as it is when it gets there, the new close's work included, so
nothing new is asked for beside it. The job drives the row through the host's
steps; no step uses git's sequencer (`rebase`, `cherry-pick`), whose state
files a Run could write and git would obey:

1. `rebasing` — `task_merge_prepare`: the daemon squashes the branch since its
   merge base with the main branch into one unsigned commit (`commit-tree`,
   compare-and-swap) — authored by the Agent of the Task's latest execution
   Run, the Task title and description head, a `Rainver-Task:` trailer and a
   `Requested-by:` trailer naming the Task's creator — and merges it onto the
   main branch's tip with `git merge-tree
   --write-tree` (git 2.38 or newer, else `git_too_old`), every merge driver
   the repository's own configuration defines disabled. Clean: the merged tree
   becomes the Task commit (`commit-tree -p <main tip>`, the branch moved by
   compare-and-swap) — `rebased`, with `main_branch`, `onto_commit`,
   `task_commit`; a merged tree equal to main's means `no_changes`, which ends
   the merge and deletes the branch. Conflicts: the merged files, markers
   included, are written into the worktree (`read-tree --reset -u`) with HEAD
   left on the squashed commit — no sequencer state is created — and the
   merge goes to step 2. Any error restores the squashed commit.
2. `resolving` — the Task's Agent gets one resolution Run
   (`tasks/mergeResolution.ts`): the Agent, runtime profile and host thread of
   the Task's latest execution Run, on the same Location, `task_runs.role =
   'merge'`, `trigger_origin = 'system'`, the contract naming
   `task_merge_id`, admitted as any Task Run is for the merge's requester
   (Project write access, the host's owner, the Task's budget — a `done` Task
   is admitted only for this; a refused admission hands the conflict to the
   person) and then through the subscription quota gate
   (`admitAgentOriginRun`), in the same transaction as the merge's move to
   `resolving`. The conflict's main branch and base are recorded, so the Run
   is told the other side by name. It launches into the worktree as the merge
   left it (`worktree.merge_id`: no preparation, leftovers or start commit,
   never settled), told the Task's side (HEAD) and the main branch's, and the
   conflicted files: edit or delete each, and do nothing else — no commit,
   reset, stash, checkout or branch move. The merge waits for the Run to end
   (a failed one a supervisor holds for review counts as ended), then
   `task_merge_continue`. When the Run left HEAD off the Task branch, deleted
   the branch, or moved it anywhere but a descendant of the squashed commit,
   the daemon puts the conflict back as the merge left it — branch at the
   squashed commit (recreated if deleted), HEAD on the Task branch, the merged
   files rewritten — and answers `unresolved`. Otherwise it captures the worktree through a private index
   seeded from the merged tree and builds the result as the merged tree with
   **only the conflicted paths** (and anything beneath them) taken from that
   capture: everything else stays as the merge wrote it, so a Run that reset
   or stashed cannot revert the main branch's changes, and anything more the
   Task needs is for a later Task Run. A conflicted path is `unresolved` while
   its blob holds a marker line (seven or more `<` or `>`, so a longer
   `conflict-marker-size` counts), while a conflict that had no markers (a
   binary file, a modify/delete) is left exactly as the merge wrote it, or when
   git cannot say; every path is when the conflict list was too long to answer
   in full (500 paths); and a result equal to the main branch's tree is too —
   keeping nothing of the Task is the person's call, so continue never answers
   `no_changes`. Else the result becomes the Task commit on `onto_commit` (its
   id recorded before the branch moves, so an interrupted continue finishes on
   retry). A Run stopped before it worked, an unresolved answer, or a second
   conflict gives the conflict to the person: `task_merge_abort` restores the
   squashed commit, to merge by hand, and the merge is `conflict` (`failed`,
   if the host could not give the worktree back).
3. `verifying` — the Task's declared checks again, in the merged worktree
   (`verifyTaskWorkspace`, `runs/verification/engine.ts`): the checks a
   workspace can answer (commands, tests, file and git checks, recipes), from
   the Task's latest execution Run's contract and the Folder's recipe,
   git-backed ones against `onto_commit`; a check that could not run fails the
   gate, unless the host went away (then the merge waits). Failed →
   `verification_failed`, and the main branch does not move — also after an
   Agent's resolution, whose checks failing is not handed back to it. Files a check
   leaves behind are thrown away, never merged.
4. `task_merge_finish` — the daemon fast-forwards. It waits
   (`waiting_local_changes`) while someone is busy with the main branch — a
   rebase or bisect of it in any worktree, a merge, cherry-pick or revert in
   progress in the checkout holding it. When the Location's checkout has the
   main branch checked out it takes the Location's lease (`location_busy`
   defers), rechecks HEAD, waits while the person's uncommitted or untracked
   files — or an existing file, ignored ones included, where the Task adds one,
   or a file where the Task needs a directory, in either case one `onto_commit`
   does not track — overlap the Task commit's files, then runs `merge --ff-only
   --no-overwrite-ignore --no-autostash` and confirms the main branch moved;
   otherwise it moves the branch by compare-and-swap from `onto_commit`. The
   main branch checked out in another worktree is `main_checked_out_elsewhere`.
   A main branch no longer at `onto_commit` (`main_moved`), or a host whose
   record of the merge no longer matches, goes back to step 1 — a main branch
   that moves under the merge five times in a row stops it instead
   (`failed`, `main_kept_moving`: each move costs the Task's checks again),
   and the next move of the main branch tries it again from a clean count;
   one already at `task_commit` (a crash right after the fast-forward) is
   `merged`. `merged` removes the Task worktree and branch.

The daemon's merge record (`<config>/task-records/<location_id>/<task_id>.merge.json`,
state `preparing`, `conflict` or `rebased`, with the merged tree and each
conflicted path's object in it) holds the worktree while a merge
is under way: settles answer `task_busy` and the sweep skips it; an ordinary
launch is refused while it is `preparing` or `conflict` and drops a `rebased`
one (a merge that stopped after rebasing), running from the rebased commit.
Finished merges are answered again from `<config>/task-merges/<merge_id>.json`
(pruned after 30 days).

Server side, a Task's Runs on that Location wait while its merge is `queued`,
`rebasing`, `verifying`, `resolving` or `waiting_local_changes` (its own
resolution Run excepted, and a Run resuming from a delegated Agent or a
review, which the merge waited for), and a merge waits for the Task's Runs
that started and have not ended — a resuming one included — and for owed
settles, but not for one not yet started, which waits for the merge instead;
the resolution Run waits for nothing, and starts a host thread of its own
when another of the Task's Runs is queued on the Task's. A Task that leaves
`done` — reopened, cancelled, deleted — withdraws its merges
(`withdrawTaskMerges`), and a merge re-reads the Task before each host step
that changes something, so one reopened while it verified does not move the
main branch: each is superseded only once the host has given back what it
held (a busy or absent host is waited for), and a resolution Run of it not
yet started is cancelled then. A Task closed again before that happened
keeps the merge as it is (see above): the Agent's resolution under way is
not thrown away to be asked for a second time. Every stop — failed checks, a
failure, a job whose attempts ran out (`stopAfterExhaustedAttempts`) — goes
through the same door (`block`): the host gives the rebased branch back at
once, best effort, and the person is told. A host that is away is waited
for, not given up on.
`waiting_local_changes` keeps its job polling every five minutes; a
Location whose HEAD or dirty state changed runs it now. A merge blocked on a
conflict, failed checks or a failure is retried when the checkout reports its
main branch checked out at a commit other than the one the merge was blocked
against — the person may have fixed it there — and, for a merge that stopped
before it knew its main branch, on any HEAD move (`wakeTaskMergesForLocations`);
a commit on another branch changes nothing the merge depends on and does not
run the Task's checks again. A paired host's
heartbeat reports that change (`recordDaemonHeartbeat`); a built-in host
Location has no heartbeat, so while it has such a merge the server reads its
git state every two minutes (`refreshBuiltinMergeLocations`, scheduler task
`builtin_task_merge_refresh`). A host's `hello` wakes its merges. A Run of the
Task that settles a commit after the Task is already `done` — queued before
it closed, or resumed after — gets a merge of its own on its own Location
(`enqueueLateTaskMerge`, basis `late:<run_id>`), by the same rule as any
`done` write: a merge under way there takes the commit when it prepares (the
usual case of a Run that closed its own Task), a stopped one is replaced.
Other Locations' merges are not touched.

Each blocked outcome writes `task.merge_blocked` (reason, files, failed checks) once per
distinct outcome — the same conflict, the same failing checks, is one event
however often it is tried and however far the main branch moves under it —
and `merged` writes `task.merged`, even for
a merge superseded while it finished; both are Project Updates and Task
timeline entries, and when the Task came from a Room conversation
(`tasks.source_run_id`, recorded by `task.create`) a notice there says what
happened. A Task outside a Project has no stream, so its merge writes no
event, notice or attention item — the merge itself runs the same. `waiting_local_changes`, `conflict`, `verification_failed` and
`failed` are attention items for the responsible person of a Task still
`done` (`tasks/projectIntegration.ts`, `source_type: task_merge`), with the
failure reason in words (`mergeFailureText`). Rainver never pushes.

A fast-forward in the checkout moves its HEAD, which the Room Git gate would
refuse (`modules/rooms.md`). The conversation the Task came from — the one
told it merged — takes that move as its own: when its accepted baseline or
last-Run HEAD is the main branch at `onto_commit`, `merged` records the main
branch at the merged commit as its `last_run_git_branch/head` through the
gate's one writer (`sessions/conversationGitGate.ts`
`recordConversationHeadMove`, which a Conversation Run's `git_after` goes
through too), so its next send advances the baseline. Any other state there
is someone else's move and still the person's to refresh; other conversations
on the Location were not told and keep the gate.

In strict mode the launch binds its cwd — now the Task worktree — by
`sandbox_mode` and the repository's git common directory as a write bind
capped by the same mode; a `command_run` in a Task worktree binds both the
same way.

**Git on an Agent-written checkout.** A Run that can write `.git/` must not
get code executed as the daemon or the server (B62/B63), so every git call on
a Location or Folder checkout goes through `runLocationGit` /
`locationGitOutput` (`@rainver/folder-read`): the daemon's diff capture,
`captureGitHead`, worktree commands and heartbeat status; the server's
`refreshGitStatus` on built-in Locations (whose directory `sandbox-runner`
Runs also write), Files & Code status and diff, and the server-host sandbox
and code-patch collection. Each call disables hooks, the fsmonitor, submodule
recursion and automatic maintenance (`maintenance.auto`, `gc.auto` — a
`merge` would otherwise spawn a gc that prunes worktrees), reads
the filter drivers the checkout's own configuration defines (`git config
--show-scope --get-regexp`, which executes nothing) and blanks every one not
from global or system configuration — the owner's `git lfs` stays — and
refuses a checkout whose own configuration sets `core.worktree`. Overrides
travel as `GIT_CONFIG_COUNT`/`KEY`/`VALUE` environment, not `-c` (the fixed
hooks and fsmonitor ones as both). It fails closed: git older than 2.31, which
ignores that environment, and a configuration the probe could not read (any
exit but 0 or 1, a timeout) refuse the checkout rather than run git blind; git's
version is read once per process in the system temporary directory, and only a
version actually read is kept, so one failed attempt does not refuse every
later call. Diffs pass `--no-ext-diff --no-textconv`, and every `status` and
`diff` gets `--ignore-submodules=dirty`: to tell whether a nested repository's
work tree is dirty git runs `status` inside it, under that repository's own
configuration, which none of the overrides reach. A nested repository whose
commit moved still shows as a change (so a Task Run that moved one is settled as a change);
only its uncommitted edits are not looked at, and `diff.submodule=short` and
`status.submoduleSummary=false` are pinned, so the change is shown as commit
ids and git never runs a diff or log inside the nested repository. Gaps are recorded in the deferred register: an
in-place capture follows a `.git` file; the configuration is probed by one
git process and the command run by another, so a writer fast enough can
change it between them. Removing a Task worktree whose `git worktree remove` failed deletes the directory only when it is a real directory that resolves to itself, then only that worktree's own entry.

**`git_before` / `git_after`.** Just before spawn, with its leases held, the
daemon reads the branch and HEAD (`captureGitHead`: `rev-parse --abbrev-ref
HEAD` / `rev-parse HEAD`, the reads a heartbeat reports); after the exit diff
it reads them again, and uploads both with the diff. Neither is sent for a
worktree Run, whose detached HEAD is not the Location's. The server always
keeps `git_after` as the Run's `output_json.workspace_after`, and records it
as the Conversation's `last_run_git_branch/head` — through the gate's one
writer, `sessions/conversationGitGate.ts` `recordConversationHeadMove`, which
a done Task's fast-forward goes through too — only for a Run that may
write (`required_sandbox_level` is not `read_only`), is not yet terminal,
ran in its Conversation's Primary Location on the uploading host, and whose
`git_before` equals the Conversation's baseline or its current last-Run HEAD
— so the move to `git_after` happened while this Run held the directory. The
Conversation send gates use it (`modules/rooms.md`, Git gate); refreshing or
advancing the baseline clears it. A branch name longer than the record's 256
characters is not kept — the diff still is — and the gate then treats a moved
HEAD as it would with no report; a Location's status report records such a
branch as unknown too.

### Strict mode (`strictNamespace.ts`)

In strict mode `execution.ts` does not spawn the runtime — it spawns `bwrap`
around it. The namespace is ported from the Runner it replaces
(`sandbox/runner.mjs`'s `buildNamespaceCommand`): `--die-with-parent
--new-session --unshare-pid`, a tmpfs root, `--proc`/`--dev`, a private
`/tmp`, the system roots and the minimal `/etc` files bound read-only, and
`--unshare-net` when the Run's egress profile is `none`. The child starts
through `sh -c` so it can report `ready` on fd 3 before `exec`ing the runtime:
"the namespace could not be built" and "the runtime exited immediately" are
the same exit code otherwise, and the daemon says which in the `complete`
frame's error.

**One deliberate deviation from the Runner.** The Runner remapped every
authority root onto a canonical target (`/workspace`, `/home/sandbox`,
`/runtime-tool`) because the server addressed mounts by managed id and never
knew a real path. The daemon is the opposite — it is the only component that
resolves paths at all (B64), and everything it has already materialized for
the Run is an absolute path on this machine — so each path is bound **at its
own path**. The containment property is unchanged; what is dropped is a
translation that would have to be undone again in every variable the daemon
writes.

What a Run sees, and nothing else: its workspace (read-only or read-write per
`sandbox_mode`), any explicitly attached Workspace Location roots (each bound
read-only or read-write from its persisted attachment grant, then capped by the
Run's isolation policy), its own `runs/<run_id>/` directory — which is also its HOME,
one per Run — the Agent's runtime profile, the login home the profile links
its credential out of, a managed copy's versioned executable tree, and the
daemon's own install root, where the ACP adapter and the `rainver` command
live. The managed executable tree and its stable login home are separate
read-only binds. The instance's other authority roots, the daemon's own
registration, and every sibling workspace are simply absent.

Two of those are deliberately read-only. The login home, because on a shared
host it holds the instance's one subscription login: a Run that could rewrite
it could point every other member's Runs at an account of its own choosing. A
token refresh through the link therefore fails rather than succeeding
quietly, and surfaces as the runtime's login prompt, which an instance admin
answers through the host card — outside any namespace. The managed copy's
tree, for the same reason and because nothing at runtime writes there: each
runtime keeps its state under its own state-root variable, inside the profile.

**The environment is an allowlist, not this container's own.** A trusted host
keeps the machine's environment because it is the owner's machine; the built-in
host is nobody's machine and its environment is the instance's. Strict mode
therefore starts from `filterAmbientEnv`'s allowlist (the same one B67 already
applies to a provider-bound run) and adds only what the daemon itself built for
the Run. `planStrictLaunch` is the one place that decides this, and it is
unit-tested for exactly that reason.

The container no longer receives the control plane's internal token at all.
`.runner.env` existed to give the Runner `SANDBOX_RUNNER_TOKEN`, which unlocks
the internal credential and execution routes from the network this container is
on; with the Runner gone the file, the variable and that reachability go with
it, and the daemon holds a bearer token for its own Host row and nothing else.
(`SANDBOX_RUNNER_SERVER_HOST` survives under its old name: it is the server's
own in-network hostname, which the built-in host's control-plane URL and the
provider proxy address both derive from. Renaming it would silently break an
instance whose `.env` still spells it the old way.)

HOME is `runs/<run_id>/home`, never the container's and never a managed copy's
shared login home. The runtime reaches its own state through the state-root
variable its profile sets, which is what B68 keys by Agent × container; HOME
is only where a vendor CLI drops scratch, and one directory shared by every
Run of every Space is precisely what a shared host must not have. The
consequence: a runtime whose registry entry declares no state-root variable
cannot be logged in through HOME here — which is the same
`runtime_profile_isolation_unsupported` refusal that already gates dispatch
for it.

The launch frame's `isolation { sandbox_mode, egress_profile }` is the policy
the control plane owns; everything else about the namespace is derived on the
host. Three profiles:

- **`none`** — `--unshare-net`. The namespace has loopback and nothing else,
  and this is the only profile that *confines* a Run's network.
- **`default`** — the general web, git and the vendor a subscription belongs
  to, through the host's own egress proxy (`egressProxy.ts`, one CONNECT
  server on the container's loopback, started once in strict mode). Package
  registries are refused with a reason the runtime prints.
- **`install`** — `default` plus package registries.

`default` and `install` point the Run at the proxy with `HTTP_PROXY` and a
per-Run credential, so one Run cannot borrow another's policy; the grant is
revoked when the Run completes, after its log has been read. **Pointing is
advisory.** Every vendor CLI, git and package manager honours the variable; a
process that opens its own socket does not, because the namespace still shares
the container's network stack. So these two are policy and a record, not
containment — see `SECURITY_AND_ACCESS_BOUNDARIES` §10, and the deferred
register for what a real boundary would take.

The one part that holds regardless is the proxy's own refusal: no address
inside this instance's network — RFC 1918, loopback, link-local, unique-local,
CGNAT, or the cloud metadata endpoint — is dialled under any profile,
`install` included, and it is the *resolved* address that is judged, so a
public name pointing at a private one is refused too. The proxy also speaks
CONNECT only: a plain proxied GET would put the request's own headers through
the daemon, which is not something it should ever hold.

The built-in Host has one explicit instance-admin-selected transport: `direct`
(the fail-closed default), `system_tun`, or `http_proxy`. It is stored with the
other instance operations settings and copied into each strict Host launch
frame and built-in Host install request, so a saved change applies to the next
Run or install without changing environment variables or restarting containers.
Paired trusted Hosts ignore the field.
`system_tun` lets RFC 2544 benchmarking addresses (`198.18.0.0/15`) returned
for a hostname act as opaque fake-IP handles for the host's TUN. `http_proxy`
chains through the configured HTTP(S) CONNECT endpoint and supports explicit
NO_PROXY-style direct exceptions. The Run still sees only Rainver's loopback
proxy and per-Run credential; it never receives the upstream coordinates.

Rainver applies the Run's name policy and resolved-address guard before opening
either transport. `direct` never interprets a reserved address as synthetic.
Under `system_tun`, a literal `198.18/15` target, any real private/internal
answer, or a synthetic answer mixed with a real private answer remains refused;
only a hostname with exclusively public/synthetic answers can use the fake-IP
route. Under `http_proxy`, the original hostname is passed upstream so that
proxy owns final resolution. These are transport strategies, not vendor-domain
allowlists.

What a Run reached and was refused comes back on the `complete` frame
(`egress`, bounded at 200 entries) and orchestration turns the *refusals* into
an `egress_refused` Run event. Only the refusals: an allowed request is the
ordinary case, and a Run that fetches a hundred URLs would bury its own
history. The refusal is the thing nobody could otherwise explain, since the
CLI only saw a 403 from a proxy it did not choose.

A frame without `isolation` falls closed on both axes — a read-only workspace
and no network at all. A trusted host ignores the field entirely: it is its
owner's machine, its Runs use the machine's own network, and it runs no proxy.

`RAINVER_STRICT_SANDBOX=1` is exported into every strict namespace, marking it
for anything that needs to know it is inside one. Codex does not read it; the
daemon consumes the same fact (`trust === "strict"`) by writing
`sandbox_mode = "workspace-write"` into that copy's `config.toml` before spawn
(`packages/host-daemon/src/codexStrictSandbox.ts`). That is the switch measured
on 2026-09-08 to stop Codex's default read-only sandbox stacking on this
namespace. Claude Code has no vendor sandbox to relax.

It sets the **top-level** key and only that one. TOML scopes a key to the table
above it, so rewriting `sandbox_mode` wherever it appeared changed the first one
found — in a config with named profiles, `[profiles.x]`'s — which left the
top-level default untouched (the Run still could not write) and silently altered
a profile the owner configured for something else.

Finding where the top-level table ends took three conjuncts, each added after
the previous one proved insufficient. A table header is a bracketed name
**alone on its line** — a bare leading `[` also matched a multi-line array's
continuation (`notify = [` … `  ["a"],`), which stopped the scan early and
produced two top-level `sandbox_mode` keys, a duplicate-key error that stops
Codex from starting. It must be at **bracket depth zero** — a final array
element carries no trailing comma, so `  ["a"]` reads exactly like a header.
And the depth is counted over the line with **strings and comments removed** —
one unbalanced `[` inside either pinned the depth above zero for the rest of
the file, so no header was ever found and the scan fell back to rewriting the
first named profile's key, which is the original bug reinstated by its own fix.
The scan for an *existing* key carries the same string-awareness: without it a
`sandbox_mode` line inside a multi-line string was rewritten instead of the
real one, which leaves Codex starting cleanly and the Run silently unable to
write — a failure with no error anywhere.

- `rainver-host register --server <url> --code <pairing-code>` — exchanges
  the pairing code for a bearer token. `--server` must be `https://` or
  loopback `http://` (plain HTTP to a LAN or public address is refused).
  Loopback means the two named forms or a loopback *address*:
  `startsWith("127.")` was also true of `127.evil.com`, a hostname somebody
  else controls and can point anywhere. The same rule is re-applied by
  `loadConfig` on every read, because the config file is an ordinary file on
  the owner's machine and one edited afterwards would otherwise send this
  host's bearer token to a plain-HTTP address off-box. The built-in host is
  exempt — it adopts a credential the instance published to it over the Compose
  network, where the control plane is `http://server:8010` and there is no
  pairing — and that exemption is decided by `builtinCredentialPath()`, an
  environment variable set only inside the `sandbox-runner` container, **not**
  by the config's own `trust` field, which lives in the file the check
  distrusts.
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
  and on exit uploads the Run's own git diff (`src/gitDiff.ts`: before the
  process starts the daemon writes the working tree — tracked and untracked,
  `.gitignore` respected — as a tree object through a private
  `GIT_INDEX_FILE`, and at exit diffs that baseline against the tree then,
  so the diff is what *this* Run changed rather than every uncommitted edit
  in the directory, and the repository's own index is never read or written;
  the dangling blobs are what `git stash create` leaves and `git gc` prunes
  them; a launch whose baseline capture failed falls back to tree-vs-HEAD) and
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
  `SIGKILL` after a 5s grace window if the process ignores it. A `terminate`
  for a launch still queued for its Location's lease removes it from the
  queue and answers `complete` without starting it; a `terminate` naming a
  `launch_id` reaches only that attempt.
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
sent right after the ack). Absent binaries are silently omitted. A binary
found on PATH is the machine's own copy and is never installed or upgraded by
the daemon; installing and version-managing is only ever done to a *managed*
copy, on either host kind, through `install_tool` (above).

## Known current gaps

- Conversation dispatch uses its pinned active Location. Remaining Task
  host selection is an explicit control-center choice. There is no scored
  multi-location router; the only scheduling across Runs is the daemon's
  per-Location execution lease (below) and the built-in host's run cap.
- Worktrees and attempt records from the earlier per-Run Task worktree
  scheme (`<location>/.rainver/worktrees/`, `<config>/worktrees/*.json`) are
  neither migrated nor removed.
- There is no automated daemon-process-to-live-server integration test.
  The wire contract is verified from the server side
  (`server/test/hostsRoutes.test.ts`); the daemon's `fetch`/`WebSocket`
  client is covered by unit tests.
- `workspace list`'s `local_path` merge trusts this machine's config
  against the server's registered set; the two can diverge if a workspace
  is removed server-side — shown, not reconciled.
- **Host name occupancy:** `uq_hosts_owner_name` has no status filter, so
  an expired `pending_pairing` or `revoked` host keeps its name. A later
  pairing needs a different display name. There is no automatic cleanup.
- Content sync, divergence detection, quota probing, and
  Windows-native/WSL hardware verification are not implemented (ADR 0016).
  How a host Run's change lands is settled and built (ADR 0016 §11). Location `execution_ready` is persisted and
  heartbeat-driven; it is not inferred from Host liveness.

Unimplemented host ideas: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §25.

### Conformance probes: retired

There were instance-admin C3 probes here, and they are gone (2026-09-09). They
certified a vendor CLI by asking it five behavioural questions once — write
only this file, do not print that secret, stop when told — and cached the
verdict against `(adapter_type, runtime_version)`, which the router then
required before any non-low-risk or file-shaped CLI work.

Three things stopped holding at once. The behaviours are the *model's*, and the
verdict carried no model, so a pass measured on one model spoke for every model
that copy could select. One sample of a non-deterministic runtime is weak
evidence for a permanent verdict. And the strongest question — will it write
outside what it was given — cannot be answered by a behavioral probe. Only the
built-in strict Host provides per-Run namespace containment; a trusted paired
Host runs natively under its owner's OS permissions and has no namespace
containment. Removing the probe does not imply filesystem confinement; the
execution Host trust mode is the boundary (B62 and
`SECURITY_AND_ACCESS_BOUNDARIES.md` §10).

A vendor CLI's own interactive question (translated into an ordinary reply,
`modules/runtime-adapters.md`) is therefore not certified by a probe either:
the translation is covered by recorded-frame controller tests
(`server/test/acpVendorQuestion.test.ts`), and each runtime's real question
shape is a paired-host acceptance item in `tasks/deferred-register.md`.

Filesystem containment follows the execution Host trust mode as described
above. Provider-bound calls use their separately authorized egress profile
and ADR 0008's credential channel. Fixed verification recipes keep using
`command_run`; when the Run uses a managed installation, its adapter and
installation identity travel with that frame so the same namespace binds the
versioned executable tree.
