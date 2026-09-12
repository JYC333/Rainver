# ADR 0016: Control Plane And Execution Hosts, Two Trust Modes

Date: 2026-08-21 · revised 2026-09-07

## Status

Accepted. Defines the execution topology, the two trust modes one host daemon
runs in, and the remote trusted-host exception to the server-host Gateway and
isolation requirements of ADR 0014. Current implementation lives in
[modules/hosts.md](../modules/hosts.md); pending Project-kernel work and
real-host acceptance gates remain in
[tasks/deferred-register.md](../tasks/deferred-register.md).

Both trust modes are built: CLI execution runs on the host daemon protocol on
every host, the sandbox line is deleted, and B63 states the two safety models.
§7's server-side credential profiles and runtime-tool catalog are retired,
§9's drain-then-replace upgrades and host-side usage probes are in, and §2's
per-Run egress policy is enforced by a host-side proxy. One piece of §2 was
not built: the vendor CLI's own sandbox is still never relaxed in strict mode.
What that costs was measured on 2026-09-08 and is recorded in §2 and the
deferred register; the symptom is not the one this ADR originally assumed. Read this record for what was decided and
`modules/hosts.md` for what exists.

## Context

Before this decision every Run executed inside a single server-owned
filesystem and one strictly isolated sandbox-runner, and several documents
stated "agents run server-side inside isolated sandboxes" as an unqualified
invariant. The product need is a control center: one server acting as control
plane, with a personal laptop and desktop (and the server itself) each running
coding agents against real projects, unified in one dispatch/monitor/review
surface. Those personal machines are not local-first sync clients (drafts,
offline capture); they are machines the same user owns, with their own
installed CLIs and login state, that the user wants work dispatched to.

An execution audit (a temporary report, retrievable from git history) found
that the sandbox-runner's isolation is entirely a property of Linux
namespaces and proxy URLs colocated with the server — meaningless for a
process on another machine — and that credential brokering, CLI login-state
continuity, runtime-tool version management, and egress enforcement are all
server-local by construction.

The first version of this decision drew the conclusion that the server host
and a personal host were two different things and let them grow two
implementations: the sandbox line (a private Runner protocol, a server-side
vendor CLI adapter, a server-host login engine, credential-profile brokering,
a runtime-tool version catalog) and the paired-host line (the `rainver-host`
daemon over an outbound WebSocket, managed copies, a PTY login terminal). A
year of use settled which was right: the sandbox line never ran a CLI on any
instance — no runtime was ever installed into it and its conformance gate was
never crossed — while every real Run went through a paired host, to the point
that the production machine was paired with itself as a workaround. The
difference between the two was never the protocol. It was the trust.

## Decision

### 1. An instance is one control plane plus N execution hosts

The control plane (the existing server) remains the sole owner of canonical
state, orchestration, governance, and the Project/Run/Agent model. An
**execution host** is a machine that can run a coding agent against a
workspace on disk: the instance's own built-in host, or a personal machine the
same user owns. Topology: `Machine → ExecutionHost → WorkspaceLocation →
logical ProjectFolder`.

- `machines` identifies a physical device; no path or runtime state.
- `hosts` identifies one execution environment on a device (`machine_id`,
  `environment_kind` required). The instance has one built-in Host; a personal
  device may expose several, such as native Windows and WSL.
- `project_folders` is the logical repository identity owned by one Project;
  it carries no host or path.
- `workspace_locations` is a physical checkout of a Folder on one Host —
  server `root_path` or remote `display_path`, branch/head/dirty metadata, and
  persisted `execution_ready`; the active row is the only candidate for new
  work. A stale row may still serve an initialized Conversation that already
  pins it; archived rows are not dispatch targets.

Runs and host task threads bind to a Location when they execute against a
registered Project checkout. A host-bound Agent may instead use a **managed
workspace**: a daemon-created directory under its own config directory, named
by Agent plus conversation container. The control plane stores no path for a
managed workspace. `project_folder_id` remains a write-once denormalisation for
Location-backed Runs, with composite constraints preventing drift.

### 2. One daemon, two trust modes

There is one execution host implementation — the `rainver-host` daemon — and
it runs in one of two trust modes, chosen by how it registered. The mode is a
property of the host, never of a Run.

- **Strict — the built-in host.** The daemon runs inside the instance's own
  `sandbox-runner` container and wraps **every** Run in a fresh rootless
  bubblewrap mount/PID namespace: an empty root, an explicit bind allowlist,
  and the workspace bound per the Run's `sandbox_mode`. The namespace is built
  on the host, from paths only the host knows; what the control plane supplies
  is policy — how the workspace is bound and whether the namespace gets a
  network at all. The vendor CLI's own sandbox is *meant* to be relaxed in
  strict mode   so there is exactly one boundary and it is ours. The daemon writes
  `sandbox_mode = "workspace-write"` into the Codex copy's `config.toml` before
  spawn; `RAINVER_STRICT_SANDBOX=1` is exported for anything that reads it.

  The reason first recorded here — that a nested vendor sandbox *fails* inside
  this namespace because it needs a user-namespace call already spent — was
  never tested and is **false**. Measured on 2026-09-08 in the real
  `sandbox-runner` container with a real `codex` binary: user namespaces nest
  (the kernel allows 32 levels), and the vendor sandbox starts and exits 0. It
  stacks its policy instead, and its default is read-only, so the Run's own
  working directory and HOME — bound read-write by this namespace — answer
  "Read-only file system" through it. The consequence is worse than the one
  imagined: not a Run that refuses to start, but one that runs and cannot
  write, with nothing naming the second sandbox. The conclusion stands and the
  symptom does not.
- **Trusted — a paired personal host.** The daemon registers over the user's
  private network (v1: Tailscale; no public exposure) and spawns CLIs
  natively — no bubblewrap, no mount containment. Read-only browse requests
  still run the shared `@rainver/folder-read` PathPolicy on the daemon before
  any file or Git data leaves the machine. This is not a smaller version of
  strict isolation; it is a different trust model, safe only because of the
  safety model below.

Do not weaken strict isolation to make the two look uniform, and do not claim
trusted execution carries guarantees it does not have.

### 3. Two safety models, not one rule with an exception

Who may dispatch to a host follows from the host's trust mode, because the two
modes make a Run safe in different ways.

- **A trusted host serves its own registered owner, and no one else.** Its
  safety is that the owner already extends that machine the trust a native
  process has. There is no multi-user sharing of a paired host: a dispatch or
  a live file read for anyone but the owner is rejected before any job or read
  is sent. This is not relaxable without a new decision.
- **The built-in host serves every Space of the instance.** It has no owner.
  It accepts a Run from anyone allowed to dispatch in that Run's Space, and
  the per-Run namespace is what makes that safe — one Run cannot read
  another's workspace, another Run's HOME, another Agent's profile, the
  instance's secrets or its internal token, or the daemon's own registration,
  because none of them is in its namespace and none of them is in its
  environment.

  The one thing every Run on this host *can* read is the login of the copy it
  runs on, because decision 7 puts the credential with the copy and there is
  one copy per instance. That is inherent to a shared host and is stated here
  rather than left to be discovered: a subscription installed on the built-in
  host is spent by everyone who may dispatch there. It is bound read-only, so
  a Run cannot replace the account other members' Runs will bill to, and an
  instance that wants a login not shared this way keeps it on a paired host.

**Managing** the built-in host is a separate question from dispatching to it,
and a separate answer: installing a runtime on it, logging a copy in or out,
removing a copy and upgrading one are instance-admin actions, because there is
one copy per instance and it is spent by everyone. Members see what is
installed and whether it is logged in, because that is what says whether their
Run can run there at all. The built-in host is registered by the control plane
rather than paired, cannot be revoked, and never appears in the pairing flow.

A Room specialist bound to a remote Workspace Location is still an Agent
identity, but its Conversation turns are sent through the same host daemon and
one opaque vendor session is kept per Conversation × Agent. On a trusted host
the owner-only gate applies to a managed workspace too, including a direct chat
between the Host owner and the Agent. A rendered Room prompt (Project state
plus Room summary/recent messages) or direct-chat history is prompt content
the reader already may read, not Runtime Context, memory, credentials, or
provider state; none of those cross the host boundary.

### 4. Paths are host-owned

The control plane never resolves, mounts, or opens a filesystem path on any
host — including the built-in one, whose paths are inside a container the
server does not reach into. `root_path` is populated only for a server-host
Location; a remote Location has only a daemon-reported `display_path` for
labelling, and the daemon is authoritative for the real directory.
`folder_read` frames carry only a Workspace Location id and relative path; the
daemon resolves the root from its local registration and applies the shared
read policy. Managed launch frames carry only `{ agent, container }`; the
daemon derives `<config>/agents/<agent>/direct/<container>` or the shared
`<config>/conversations/<container>` and validates the opaque identifiers
before joining them. The owner of a trusted host may also browse and register
a directory from the web UI: the daemon answers per-level directory-name
listings and runs its own `workspace add` validation — the control plane
forwards the request and stores, as ever, only the reported display path.

**The built-in host has managed workspaces only.** No existing directory on
the server machine is ever attached to it; its Locations are always created
under the instance's own workspace root. Attaching a directory that is already
there is the trusted host's job — it is the one thing a personal machine is
for. `execution_host_kind` is a constrained denormalised copy of `hosts.kind`
so the database can enforce the remote-root invariant.

### 5. What does and does not extend to a trusted host

**Login state does not travel.** Subscription/OAuth login state is produced by
a vendor login on a machine's disk and cannot be brokered. Remote installation
selection and owner-initiated login terminals follow section 7; relaying a
terminal does not copy or broker login state from anywhere else. A Run with no
binding is a native CLI invocation using whatever that copy is already logged
into; the control plane supplies the rendered task prompt and an approval
preset (headless mode requires one).

**A Run-scoped tool surface does.** A Run that carries tool grants receives a
bearer identity for itself, the address this host reaches the control plane
at, and the `rainver` command with the Skill that explains it — materialized
by the daemon into the Run's own directory and removed with the Run. It is
what makes a dispatched agent able to say what it did; without it a Run is a
black box until it exits, which is not an execution-host property but an
absence of one.

This is reachability, not a trust-model change, for the same reason the
binding below is. The identity authorizes one Run's calls against Rainver's
own API. It is not a provider credential, selects no model backend, and is
therefore outside ADR 0008's channel isolation and B67's mutual exclusion,
which both govern what the *upstream* sees. Nothing is installed onto `PATH`
(§7): the command is named by absolute path in the Run's environment.

**An explicit ModelProvider binding does.** A Run may carry a binding chosen
by the control plane, in which case the server-side provider proxy and its
short-lived leases serve it. This costs reachability, not a trust-model
change: the credential never leaves the server either way, because the CLI
receives a proxy URL and a lease token, never the key
([ADR 0008](0008-credential-channel-isolation.md) decision 4). It is what lets
the control plane answer "which model is this host's agent actually running
against". Materialising what a binding needs on the host — run-scoped provider
config and a profile directory that keeps the runtime off the machine's
ambient one — is a consequence of that, not brokered login-state continuity: a
control-plane-provided directory carrying only binding material is in scope;
copying a user's vendor login state to another machine is not. A binding
resolves through an enabled active-Space provider grant, checked at dispatch
and again when the binding is built, so it cannot widen who may spend a
credential; a Host default naming a provider not granted in the dispatching
Space simply does not apply there.

**B67** follows: a provider-bound Run must not inherit ambient backend
selection from the executing machine, so a selected provider cannot be
shadowed by machine state and a subscription login cannot be silently
converted into API billing.

**Continuity** across turns of one task is the Agent Client Protocol's own
`session/resume`, driven by the general ACP controller for every runtime,
tracked by the control plane only as an opaque `vendor_session_id` per task
thread pinned to one (host, workspace, installation).

Conversation continuity uses the same host-thread authority, generalized from
Task threads: one live `host_threads` row per Conversation × Agent, resettable
by the host owner, and closed when the specialist leaves the Room. Direct
continuity is one live row per Agent × Host owner, with the direct session's
recent history rendered into the next prompt. A managed thread has no Location
and carries the managed Agent/container in its launch frame; a Location thread
pins the registered Location. Reset retires the opaque vendor session but
leaves the directory in place. Removal archives the directory by rename, and a
later opt-in restore can move the newest archive back; the daemon reports only
the boolean archive inventory in heartbeats. The Room/direct identity and
prompt stay in the control plane's Run record, while the daemon remains
authoritative for the directory.

### 6. The daemon is identity, connectivity, isolation and supervision

The daemon's durable role:

- pairing or built-in registration, bearer-token identity, and the
  **outbound-only** WebSocket — this direction is load-bearing (personal
  machines sit behind NAT) and no runtime integration reverses it: the control
  plane never dials into a host;
- capability probing and reporting, including every CLI installation it
  knows and whether each is logged in;
- runtime process lifecycle: spawning a one-shot CLI turn, or relaying a
  duplex stdio frame stream through the same outbound connection — inside the
  Run's namespace in strict mode, natively in trusted mode;
- bounded read-only tree, file, and Git requests for registered workspaces,
  with the same path policy and byte/file-count limits on the daemon;
- managed-workspace lifecycle: derive a shared Conversation or per-Agent
  direct-owner directory, create it for launch, archive on Conversation/Room
  removal or direct-session deletion, restore only after an explicit request,
  sweep archives older than 30 days, and report the opaque availability
  inventory on heartbeat.

Isolation belongs here and not in a separate service because it is the one
thing that has to be applied where the process actually starts. A boundary
built beside the control plane protects nothing on another machine, and the
Runner that was built there was never used at all.

There is **one** transport — a duplex stdin frame extension of the host
WebSocket protocol — and **one** server-side protocol client, because every
supported agent speaks ACP over stdio (natively, or through a thin wrapper;
[ADR 0007](0007-multi-cli-mvp.md) decision 3). Runtime protocol knowledge
lives on the server; the daemon relays bytes and understands no vendor
protocol. It also accepts no free-form command: the fixed frames it answers
are named by the control plane's own recipes and specs, never by a caller.
Rejected: adopting OpenCode Server as the general execution foundation (it
substitutes API spend for the subscription quota that motivated this topology
and replaces the harness the user actually uses); exposing host-local engines
to inbound network access; per-runtime tunnel endpoints;
one-container-per-Run instead of bubblewrap, which needs the Docker socket —
host-equivalent authority this system deliberately keeps out of the product
path (B44).

### 7. Own installations versus managed installations

A trusted host runs the person's **own** CLI installations — detected on PATH,
never installed, upgraded, reconfigured, or logged into by the daemon on its
own initiative. Any host may additionally hold **managed** installations: a
copy the control plane chose at a pinned version, with its own login state,
for a machine where the person's copy is absent, outdated, or on the wrong
account — or an ACP-registry agent that has no "own" copy at all. The built-in
host has managed copies only; it is a container, and there is no person's own
install on it to respect. For any ACP adapter with a distribution, the daemon
installs on request (`install_tool`) into
`<config dir>/tools/<adapter_type>/<version>/` — never onto PATH or into
global package trees — launches it by the absolute path its manifest records,
and removes program versions on request. Managed user state has a stable private
HOME at `<config dir>/managed-state/<adapter_type>/home/`; it is not versioned
with the executable. Agent sessions remain in their separate Agent profiles.

**Credentials live with the copy**, on every host. Logging a copy in is the
host owner's action on a trusted host and an instance admin's on the built-in
one; either way it is a terminal the daemon runs on a PTY and relays, the
daemon initiates nothing, and it stores nothing beyond what the vendor CLI
writes into that copy's HOME. A Run gets its Agent's profile with that copy's
credential **linked** into it — never copied into a shared credential store,
never handed to a subprocess as a token, and never brokered per Run.

Enabling a registry agent for the deployment is instance-admin gated,
separately from installing it on a host.

### 8. Readiness and dispatch are separate from liveness

`hosts.status` and heartbeat staleness answer reachability, for the built-in
host as much as a paired one — it is a daemon connection, and reporting it
permanently online would hide the one failure an operator most needs to see.
The server probe or daemon heartbeat writes `execution_ready` and
branch/head/dirty metadata; dispatch requires a live Host and a ready
Location, and omitted remote reports mark Locations not ready. The dispatch
surfaces accept a Location, enforce Project write access, the host's own
authorization rule from §3, capability and readiness, and enqueue the same
agent job. Every terminal Run flows through one Run-terminal → Task-status
projection: a Task becomes `done` only after all linked Runs are
hard-terminal and none failed, degraded, cancelled, or orphaned.

The built-in host carries a concurrency cap as a property of the instance:
bubblewrap has no cgroups, so that cap and the container's own CPU and memory
limits are the only levers, and both are sized per machine rather than per
Run. A paired machine's capacity is its owner's to size.

### 9. One version per adapter, instance-wide

There is no per-Space runtime version policy. A copy is upgraded by draining
its active Runs first, keeping the previous version directory for a one-step
rollback, and recording both in Updates.

The host reports only the current copy, so an Agent has one version per host,
not a list. The version kept behind it is a binary rollback target. Upgrade,
reinstall, rollback, pruning and binary removal retain the same managed HOME,
including login, native CLI history, Skills and user settings. Older binaries
may not understand a newer vendor data format; rollback never rewinds that data.
A drain that does not converge abandons the upgrade rather than killing a Run.
This does not authorize importing the machine's own CLI state.

### 10. Retiring a mechanism may require an offline upgrade

Most schema changes are compatible with the release they replace and apply
under it — expand now, contract later (B59), which is what lets an update run
while the previous build is still serving. Retiring a whole mechanism cannot
always be split that way: the migration that drops the CLI credential tables
removes rows the running release still reads.

Such a migration is marked `-- rainver:maintenance` and applied only by
`start.sh --maintenance`, which pulls images, waits for Runs to finish without
killing any, stops the applications while keeping PostgreSQL, takes a dump,
applies the migration only if the dump is restorable, starts again and checks
health. On failure it leaves the applications stopped and keeps the dump;
nothing is rolled back automatically, because restoring is an explicit
decision and changing image tags alone is not a recovery. Ordinary start and
the UI update both refuse a pending maintenance migration and name that
command; a gate that cannot be asked refuses too, since "I do not know" before
an irreversible migration is not clearance.

The distinction is compatibility with the running version, not whether a
database changes. Reach for the marker only when expand-then-contract cannot
be split across releases: a maintenance upgrade is downtime someone has to
schedule. A UI-triggered offline upgrade would need an executor that survives
stopping the server that requested it, and is not built.

### 11. Deferred by decision

Remote in-place execution lands changes on disk before review — the reverse
of propose-then-apply. Code-patch proposal apply/rollback is not extended to
trusted hosts; a remote diff is a read-only review artifact and undo is git.
This is an open question for deliberate design ("pit 3" in the deferred
register), not settled by default. Capability-based routing, distributed
scheduling, host leasing, and cross-host sync/divergence detection are
likewise out of scope. A second shared strict host is not built here, and
nothing here stands in its way: it would be another strict daemon registered
from another machine.

## Consequences

- The security narrative is "execution is isolated on the instance's built-in
  host, one namespace per Run; on a host you own and have paired, it runs with
  the trust you already extend to that machine". This must be visible in the
  product (pairing flow, dispatch composer), not only in documentation.
- Runtime conformance was retired on 2026-09-09 rather than extended. It was a
  one-shot behavioural certification of a vendor CLI, cached against a version
  key and blind to the model actually selected, gating dispatch. Its strongest
  question — will the runtime write outside what it was given — is answered
  structurally by this decision's own namespace, and the rest were single
  samples of a non-deterministic system. What contains a Run is the namespace,
  the egress profile and ADR 0008's credential channel, none of which vary by
  risk; that this leaves risk level with no effect on CLI dispatch is recorded
  in the deferred register rather than implied by a check that no longer runs.
- Isolation is now a property of software the user can also run on their own
  machine. Raising a paired host's isolation later is a registration choice
  rather than a rewrite.
- Retiring the server-side CLI credential path is not only a deletion: the
  conversation-backend catalog, routing candidacy, Runtime Context continuity
  and the managed Assistant's provisioning each carried a credential-profile
  dimension, and each now keys on the host and installation instead. A CLI
  runtime profile that names no execution host is not a runnable backend
  (B46), which is the one behaviour change a Space can notice.
- A Run's network reach on the built-in host is stated per Run and applied by
  the daemon's own egress proxy, but only `none` confines: the namespace shares
  the container's network stack, so `HTTP_PROXY` directs a cooperating runtime
  rather than binding a hostile one. The registry refusal is policy and a
  record; the private-range refusal is a boundary, because the proxy declines
  rather than the client neglecting to ask. Saying which is which is part of
  the security narrative above, not a footnote — a policy described as
  containment is worse than no policy.
- The migration that drops the retired tables cannot run under the release it
  retires, so it is marked `-- rainver:maintenance` and applied only by
  `start.sh --maintenance`, with the applications stopped and a dump taken
  first (ADR 0016 §10). Ordinary start and the UI update refuse it and name that
  command. This is a scoped exception to B59's expand-then-contract rule, not
  a general licence.
- Documents that previously stated unqualified server-side execution —
  `INDEX.md`, `BOUNDARIES.md` (B62, B67), `LOCAL_FIRST_COMPATIBILITY.md`,
  `SECURITY_AND_ACCESS_BOUNDARIES.md` §10, `PRODUCT_AND_BOUNDARIES.md`,
  `ARCHITECTURE.md`, `modules/mobile-client.md`,
  `modules/sync-and-conflicts.md`, and ADRs 0005, 0008, 0014 — are scoped to
  the strict host and point here.

## Revision history

- **2026-08-21** — original: control plane plus N execution hosts, the
  Machine → Host → Location → Folder topology, two-tier trust with the server
  host's existing sandbox unchanged and a paired host in trusted mode,
  host-owned paths, the outbound-only WebSocket, and the owner-only hard rule.
- **2026-08-24** — the ModelProvider binding for a remote Run: what a binding
  materializes on the host, and B67's remote enforcement point.
- **2026-09-08** — the daemon gained its own egress proxy: `egress_profile`
  became `none` / `default` / `install`, package registries are refused unless
  a Run was granted them (ADR 0017's exposure row), this instance's own network
  is refused under every profile, and what a Run reached comes back on the
  `complete` frame as an `egress_refused` Run event. Recorded with its limit:
  outside `none` this directs a cooperating runtime rather than confining any
  runtime.
- **2026-09-08** — the server-side CLI credential and runtime-tool mechanisms
  were retired: no broker, no profiles, no per-Space version policy, no
  server-installed copies. Subscription quota moved to a `usage_probe` frame
  the host answers (§7's consequence); upgrade gained drain-then-replace with
  a kept previous version and a rollback action (§9); B45–B49 were rewritten
  around a login that lives with its copy; the destructive migration became an
  offline maintenance upgrade (ADR 0016 §10).
- **2026-09-08** — dispatch, verification and conformance moved onto the daemon
  protocol and the sandbox line was deleted; §3's two safety models and §4's
  managed-workspaces-only rule became the implemented gates.
- **2026-09-07** — one daemon, two trust modes. The server host became a
  built-in host running the same daemon in strict mode, and isolation moved
  into the daemon; retiring the private Runner protocol beside it follows with
  the dispatch switch. The
  owner-only rule became one of **two** safety models (§3) rather than a rule
  with an exception: a trusted host serves its owner, a strict host serves
  every Space and is made safe by the per-Run namespace, with management of
  the built-in host instance-admin gated. Added: built-in registration with no
  pairing and no revocation, credentials living with the copy on every host
  (§7), managed workspaces only on the built-in host (§4), instance-wide
  versions (§9), and the concurrency cap (§8).
