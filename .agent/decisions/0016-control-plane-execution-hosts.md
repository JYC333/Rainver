# Decision 0016: Control Plane and Execution Hosts, Two-Tier Trust

Date: 2026-08-21
Status: Accepted; P1 topology and control-plane implementation is complete
(commits `d0b6b3c5` P0, `0dcd91ca` P1). The phase-gated discovery/closure
review and final integration gate are recorded in that plan's execution
ledger — the plan itself is retired; git history holds it in full. P2 is
deferred by decision; see
[tasks/deferred-register.md](../tasks/deferred-register.md)'s "Project
kernel — P2" section for what it covers and its trigger.

## Context

Every Run today executes inside a single server-owned filesystem and a single
strictly isolated sandbox-runner: the server process itself does the pre/post
run filesystem work (worktree provisioning, Run Exchange, artifact
materialization, diff collection), and the actual CLI process runs in a
rootless bubblewrap namespace reachable only over an internal Docker network.
This is documented as an unqualified invariant in several places: "agents run
server-side inside isolated sandboxes" ([INDEX.md](../INDEX.md) §1),
"Agent execution always runs server-side" ([BOUNDARIES.md](../BOUNDARIES.md)
B28, stated there for the mobile client specifically), and "agent execution
... remain[s] server-authoritative"
([LOCAL_FIRST_COMPATIBILITY.md](../architecture/LOCAL_FIRST_COMPATIBILITY.md)
§1), with "Project Folder filesystem paths" and "Sandbox paths" both listed as
**Server-Only** in the same document's data classification (§2).

The product need driving this decision (recorded in the retired phase-1
plan's §1, git history) is a control center: one server acting as control plane, with a personal laptop and
desktop (and the server itself) each running coding agents against real
projects, unified in one dispatch/monitor/review surface. Those personal
machines are not local-first sync clients in the sense
`LOCAL_FIRST_COMPATIBILITY.md` addresses (drafts, offline capture) — they are
machines the same user owns, with their own already-installed CLIs
(Claude Code, Codex, OpenCode) and their own login state, that the user wants
the control plane to dispatch work to and collect results from.

Two audits inform this decision. The execution audit
(`2026-08-21-control-center-execution-audit.md`, a temporary report deleted
after consolidation per its own rider; retrievable from git history)
found that (a) the sandbox-runner's strict isolation model is entirely a
property of Linux network namespaces and proxy URLs colocated with the
server — meaningless for a process on an unrelated machine — and (b) that
credential brokering, CLI login-state continuity, runtime-tool version
management, and egress enforcement are all deeply server-local by
construction, none of it portable to a remote host without being rebuilt.

## Decision

### 1. An Rainver instance is one control plane plus N execution hosts

The control plane (the existing server) remains the sole owner of canonical
state, orchestration, governance (proposals, policy, audit), and the
Project/Run/Agent model. An **execution host** is a machine — the server
itself, or a personal laptop/desktop the same user owns — that can actually
run a coding agent against a workspace on disk. The topology is
`Machine → ExecutionHost → WorkspaceLocation → logical ProjectFolder`:

- `machines` identifies a physical device and carries no path or runtime
  state.
- `hosts` identifies one execution environment on that device. The server has
  one seeded Host; a personal device may expose multiple Hosts such as native
  Windows and WSL. `machine_id` and `environment_kind` are required.
- `project_folders` is the logical repository identity owned by one Project;
  it no longer carries a physical host or filesystem path.
- `workspace_locations` is a physical checkout of a Folder on one Host. A
  Folder may have multiple Locations. A Location owns server `root_path`,
  remote `display_path`, branch/head/dirty metadata, preferred selection, and
  the persisted `execution_ready` fact.

Runs and host task threads bind to a Location. `project_folder_id` remains a
write-once logical denormalization, with composite database constraints
preventing Location/Folder drift.

### 2. Two-tier trust, not one isolation model stretched thin

- **Server host**: unchanged. Every existing invariant in
  [SECURITY_AND_ACCESS_BOUNDARIES.md](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
  §10 (PathPolicy, forbidden path patterns, bounded diffs, rootless
  bubblewrap namespace, fail-closed preflight) continues to apply exactly as
  today, to server-host Locations. A remote Location is never passed through
  the server sandbox path resolver.
- **Remote (personal) host**: a new, deliberately weaker **trusted-host**
  mode. A thin daemon (`rainver-host`) registers with the control plane
  over a private network (v1: the user's own Tailscale network; no public
  exposure), then spawns the machine's natively installed CLI directly —
  no bubblewrap, no mount containment, no PathPolicy enforcement, using the
  machine's own login state and its own already-checked-out repositories.
  This is safe only because the hard rule below holds; it is not a smaller
  version of server-host isolation, it is a different trust model entirely.

**Hard rule (phase 1, not relaxable without a new decision):** a host accepts
only Runs whose initiating user is that host's registered owner. There is no
multi-user host sharing in this decision.

### 3. Paths are host-owned, not control-plane authority

The control plane never resolves, mounts, or opens a filesystem path on a
remote host. `workspace_locations.root_path` is populated only for a
server-host Location. A remote Location has no server root, only a daemon-
reported `display_path` for UI labeling; the daemon is authoritative for the
real directory on its machine. `execution_host_kind` is a constrained
denormalized copy of `hosts.kind` so the database can enforce the remote-root
invariant.

### 4. Credentials, egress, and continuity do not extend to remote hosts

None of the server-local credential broker, provider-proxy leases,
subscription-egress allowlists, or CLI HOME-materialization continuity model
(audit report §3) are extended to remote hosts. A remote Run is a bare native
CLI invocation using whatever the machine is already logged into; the control
plane supplies only the rendered task prompt and an approval preset (headless
mode requires one, since there is no human mid-run to answer a permission
prompt). Continuity across turns of the same task is instead handled by the
Agent Client Protocol's own `session/resume` (driven by the general
`AcpController` for every runtime, since the ACP runtime replatform —
originally `--resume` / `exec resume` at the time this decision was written),
tracked by the control plane only as an opaque `vendor_session_id` per task
thread, pinned to one (host, workspace) pair — task threads, documented in
[modules/hosts.md](../modules/hosts.md).

#### Amended 2026-08-24 — an explicit ModelProvider binding may extend to a remote host

Two sentences above are narrowed to their **login-state** half, which is
unchanged: this section's opening enumeration (the one listing "provider-proxy
leases" among what does not extend) and its blanket "a remote Run is a bare
native CLI invocation using whatever the machine is already logged into". A remote Run MAY now carry an explicit ModelProvider binding
chosen by the control plane, in which case the server-side provider proxy and
its short-lived leases **do** serve that run.

What changed and why: the original wording conflated two independent things
under one exemption. Subscription/OAuth login state genuinely cannot be
brokered to a remote machine — it is produced by a vendor login on that
machine's disk, and the audit's finding about its server-locality stands. An
API-provider binding is not like that: the credential never leaves the server
either way, because what the CLI receives is a proxy URL and a lease token,
never the key ([ADR 0008](0008-credential-channel-isolation.md)). Extending it
therefore costs reachability, not a trust-model change — which is why the
control plane could not previously answer "which model is this host's agent
actually running against", the question this amendment exists to make
answerable.

What stays out, and is not weakened by this amendment:

- **Login-state brokering, remote multi-account selection, and remote vendor
  login remain out.** A remote run with no binding is bit-for-bit today's
  behavior: the machine's own ambient login, no server injection.
- **Subscription-egress allowlists and the credential broker's CLI HOME
  continuity model remain server-host-only.** What extends is the
  provider-proxy lease path. Materializing what a binding needs on the
  executing host — its run-scoped provider config, and the profile directory
  that keeps the runtime off the machine's ambient one (B67) — is a
  consequence of that, and is not the brokered login-state HOME continuity
  this bullet excludes. The distinction is what the directory is
  for, not whether one exists: a control-plane-provided profile directory
  carrying only binding material is in scope; copying a user's vendor login
  state onto a remote machine is not.
- **The two-tier trust model (§2, B62) is untouched.** A bound remote run is
  still a native, unsandboxed process on a trusted machine; it merely points
  its model traffic at the control plane's proxy.
- **The hard rule in §2 (a host serves only its registered owner) is
  untouched.** A binding resolves through an enabled active-space provider
  grant, the same rule the server-host path enforces — checked at dispatch and
  again when the remote binding is built — so a binding cannot widen who may
  spend a credential. A Host is user-scoped and can back Locations in several
  Spaces, so a Host default naming a provider that is not granted in the
  dispatching Space simply does not apply there; the run uses that machine's
  own login, as it did before bindings existed.

One new invariant follows and is recorded as **B67**: a provider-bound remote
run must not inherit ambient backend credentials from the executing machine,
so that a selected provider cannot be shadowed by machine state and a
subscription login cannot be silently converted into API billing.

### 5. What is explicitly deferred, and why that is a decision and not an oversight

- Remote in-place execution means changes land on disk before any review —
  the reverse of the propose-then-apply governance every other write path in
  this system uses. This plan does not extend code-patch proposal apply/
  rollback to remote hosts; a remote diff is a read-only review artifact in
  phase 1, and undo is git, operated by the user or a dispatched agent. This
  is recorded as an open question for deliberate future design, not settled
  by default in this decision ("pit 3" in
  [tasks/deferred-register.md](../tasks/deferred-register.md)).
- Capability-based host routing, distributed scheduling, host leasing,
  cross-host workspace sync/divergence detection, remote quota probing, and
  full local-first replication are all out of scope for this decision; see
  the multi-host section of
  [tasks/deferred-register.md](../tasks/deferred-register.md).

### 6. Readiness and dispatch are separate from host liveness

`hosts.status` and heartbeat staleness answer whether an ExecutionHost is
reachable. The owning server probe or daemon heartbeat writes
`workspace_locations.execution_ready` and branch/head/dirty metadata. Dispatch
requires both a live remote Host and a ready Location; omitted remote reports
mark Locations not ready. The server Host is online in-process and its
preferred Location is refreshed through the local git helpers.

The canonical user-session dispatch surfaces are
`POST /api/v1/tasks/:taskId/runs` for an existing Task and
`POST /api/v1/tasks/runs` for an auto-created lightweight coding Task. Both
accept a Location, default to the Folder's preferred Location, enforce Project
write access, Host ownership/capability/readiness, and enqueue the same agent
job. The former `POST /api/v1/hosts/dispatch` route is removed.

Every terminal Run flows through one shared Run-terminal → Task-status
projection. A Task becomes `done` only after all linked Runs are hard-terminal
and none failed, degraded, cancelled, or orphaned; otherwise it becomes
`blocked`.

## Amended: daemon role (phase 2, 2026-08-21)

Phase 1 implicitly treated the daemon as *the* execution protocol adapter for
every runtime (`launch`/`output`/`complete`/`terminate` frames around a
one-shot argv spawn). Evaluating OpenCode's headless engine (`opencode
serve`: an HTTP/SSE-controllable local engine co-located with the workspace)
showed that framing to be too broad. The daemon's durable role is narrowed to
**identity, connectivity, and supervision**:

- pairing, bearer-token identity, and the **outbound-only** WebSocket — this
  direction is load-bearing (personal machines sit behind NAT with no inbound
  exposure) and is not reversed by any runtime integration: the control plane
  never dials into a host;
- capability probing and reporting;
- runtime process lifecycle: spawning one-shot CLI turns (phase 1 shape),
  and — next — carrying a bidirectional control channel for a runtime that
  needs one, through the same outbound connection.

Runtime protocol knowledge lives on the server side, not in the daemon — "the
daemon must not become a second Rainver" continues to hold. What the
daemon must also never become is a vendor protocol translator. Rejected in
the same decision: adopting OpenCode Server as the general execution
foundation (it substitutes API spend for the subscription quota that
motivated this topology, and replaces the vendor harness the user actually
uses); exposing host-local engines to inbound network access.

**Amended 2026-08-22 — one protocol, not per-runtime endpoints.** The
sketch above imagined two tunneled shapes: HTTP/SSE for an engine like
`opencode serve`, and duplex stdin/stdout frames only for a runtime without a
server mode (Claude Code). Neither was built, and the framing was wrong:
`opencode` speaks the **Agent Client Protocol** over plain stdio natively, as
do most current coding agents, with `claude` and `codex` reachable through
thin wrapper adapters. So there is **one** transport — a duplex stdin frame
extension to the existing WebSocket protocol — and **one** server-side
protocol client, rather than per-runtime endpoint adapters. This
*strengthens* the principle above rather than bending it: under ACP the
daemon does not need to understand even one protocol, only to relay bytes.
The rejections in the previous paragraph are unchanged. Decision record: the
ACP runtime replatform plan (A1–A3), retired 2026-08-23; current state in
[modules/hosts.md](../modules/hosts.md).

## Amendments to existing documents

The following statements are amended **in place** (not superseded, per this
repository's amendment convention — see
[decisions/0013-personal-team-content-boundary.md](0013-personal-team-content-boundary.md)
for precedent) to scope "server-side"/"server-authoritative" execution
language to the server host, and to acknowledge execution hosts as a
qualification rather than a contradiction:

- [`.agent/INDEX.md`](../INDEX.md) §1 — repository context summary.
- [`.agent/BOUNDARIES.md`](../BOUNDARIES.md) — a new boundary item recording
  the two-tier trust model and the host-ownership hard rule.
- [`.agent/architecture/LOCAL_FIRST_COMPATIBILITY.md`](../architecture/LOCAL_FIRST_COMPATIBILITY.md)
  §1 and §2 — distinguishing execution hosts (owned machines, control-plane
  paired) from local-first sync clients (untrusted, offline-capable, draft-only).
- [`.agent/architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
  §10 — scoping the bubblewrap/PathPolicy description to the server host and
  cross-referencing the remote trusted-host model.

A discovery/closure review pass on the P0 amendment sweep found the same
unqualified "agent execution is always server-side" claim recurring in four
further documents, amended in the same P0 phase for the same reason:

- [`.agent/architecture/PRODUCT_AND_BOUNDARIES.md`](../architecture/PRODUCT_AND_BOUNDARIES.md)
  ("Sandbox and path policy boundary") — scoped to the server host.
- [`.agent/modules/mobile-client.md`](../modules/mobile-client.md) — reworded
  to acknowledge execution hosts while keeping "mobile never executes agent
  code locally" as the actual invariant.
- [`.agent/ARCHITECTURE.md`](../ARCHITECTURE.md) — separated memory/proposal
  server-authority from agent-execution host-authority.
- [`.agent/modules/sync-and-conflicts.md`](../modules/sync-and-conflicts.md) —
  same separation.

Each amendment carries an inline pointer back to this ADR; no document is
duplicated or superseded wholesale.

The 2026-08-24 amendment inside §4 amends three further places, on the same
terms:

- [`.agent/BOUNDARIES.md`](../BOUNDARIES.md) — B62 qualified (a remote host
  uses the machine's own login state *unless* the Run carries an explicit
  ModelProvider binding), and **B67** added for the invariant that amendment
  creates.
- [`.agent/decisions/0008-credential-channel-isolation.md`](0008-credential-channel-isolation.md)
  — "local provider-proxy URL" → "provider-proxy URL", with a dated amendment
  recording why the locality was never the load-bearing property and what the
  lease token's network exposure does and does not mean.
- [`.agent/architecture/LOCAL_FIRST_COMPATIBILITY.md`](../architecture/LOCAL_FIRST_COMPATIBILITY.md)
  §7 — "does not receive server-brokered credentials" narrowed to login state.
  This sentence was already amended by this ADR's own P0 sweep in 2026-08-21;
  it needed a second, narrower qualification rather than a rewrite.

A wording sweep accompanies the amendment: "local"/"loopback" provider-proxy
phrasing is corrected wherever it appears, pointing at ADR 0008 rather than at
this ADR — the locality claim is that ADR's invariant, not this one's topology.
The full set, verified by grep across `.agent/` rather than assumed — ADR 0008
itself (listed above) plus:
[`0007-multi-cli-mvp.md`](0007-multi-cli-mvp.md),
[`architecture/CREDENTIAL_STORAGE.md`](../architecture/CREDENTIAL_STORAGE.md),
[`modules/runtime-adapters.md`](../modules/runtime-adapters.md) (which
additionally claimed a loopback bind — false: `providers/proxy/server.ts` binds
`0.0.0.0`. Its "not configurable" claim was true of the listener at the time — the
correction separated that from the URL's host, which
`SANDBOX_RUNNER_SERVER_HOST` configures. Both were superseded when
`PROVIDER_PROXY_PORT` made the listen port configurable, so a paired host can
reach the proxy at a port that survives a restart),
[`modules/provider-policy.md`](../modules/provider-policy.md),
[`architecture/EXECUTION_MODEL.md`](../architecture/EXECUTION_MODEL.md), and
[`tasks/deferred-register.md`](../tasks/deferred-register.md). In the last two
the load-bearing word was "same", not the locality, so only the adjective
changed.

## Consequences

- The security narrative for this system is no longer "every agent execution
  is isolated" but "execution is isolated on the server host; on a host you
  own and have explicitly paired, execution runs with the trust level you
  already extend to that machine by using it." This must be visible to the
  user in the product (host pairing flow, dispatch composer) — it is not
  merely a documentation nuance.
- Runtime conformance suites (`RuntimeConformanceService`,
  `.agent/architecture/RUNTIME_ADAPTER_STANDARD.md`) are not applied to
  trusted hosts in phase 1; a remote adapter cannot claim conformance
  evidence the way the server-host adapter can.
- Future work that wants to raise remote-host isolation (e.g. running the
  daemon inside a container on the remote machine) is compatible with this
  decision — it would strengthen trusted-host mode without changing the
  control-plane/execution-host split itself.

## Amended - 2026-08-26 (managed copies installed by the daemon)

The rule that a trusted host "runs its own already-installed CLIs" and the
daemon "never installs or version-manages a CLI" was written with one copy
of each CLI in mind: the one the person installed and logged into. That copy
— the **own** installation — is still exactly that: detected on PATH, never
installed, upgraded, reconfigured, or logged into by the daemon on its own
initiative.

What the rule did not anticipate is wanting a *second* copy: one the control
plane chose, at a pinned version, with its own login state, on a machine
where the person's own copy may be absent, outdated, or logged into a
different account — or an agent from the ACP registry that has no "own" copy
at all. Those are **managed** installations. For any ACP adapter with a
distribution (the builtin CLIs name their ACP registry entry; registry agents
carry a snapshot), the daemon installs on the host owner's request
(`install_tool` over the host WebSocket) into its own directory
`<config dir>/tools/<adapter_type>/<version>/`, never onto PATH or into the
machine's global npm/uv trees, gives it a private `home/`, launches it by the
absolute path its manifest records, and removes it on request. It reports
every copy (`capabilities_json.installations`) with whether it is logged in.
A thread pins the copy it runs on, since the vendor session lives in that
copy's login state. Logging a copy in — the machine's own included — is the
host owner's action too, as a terminal the daemon runs on a PTY and relays
(`login_open`/`login_input`/`login_output`/`login_exit`): the daemon still
initiates nothing and stores nothing beyond what the vendor CLI writes into
that copy's HOME.

What stays true: the daemon installs nothing on its own initiative; the
machine's own copies are never touched; a registry agent is not offered for
server-host execution (`invocation.remote_host_only`), has no server-side
runtime tool, credential profile, or conformance evidence; and enabling one
for the deployment is instance-admin gated, separately from installing it on
a host.

