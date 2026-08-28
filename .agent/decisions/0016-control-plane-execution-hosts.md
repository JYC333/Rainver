# ADR 0016: Control Plane And Execution Hosts, Two-Tier Trust

Date: 2026-08-21
Rewritten: 2026-08-27

## Status

Accepted. P0/P1 topology and control-plane implementation are complete
(commits `d0b6b3c5`, `0dcd91ca`); the ACP runtime replatform (A1–A3, retired
2026-08-23) and the remote provider-binding work built on it. P2 (Project
kernel) is deferred by decision; see
[`tasks/deferred-register.md`](../tasks/deferred-register.md). Current state
lives in [`modules/hosts.md`](../modules/hosts.md).

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

## Decision

### 1. An instance is one control plane plus N execution hosts

The control plane (the existing server) remains the sole owner of canonical
state, orchestration, governance, and the Project/Run/Agent model. An
**execution host** is a machine that can run a coding agent against a
workspace on disk: the server itself, or a personal machine the same user
owns. Topology: `Machine → ExecutionHost → WorkspaceLocation → logical
ProjectFolder`.

- `machines` identifies a physical device; no path or runtime state.
- `hosts` identifies one execution environment on a device (`machine_id`,
  `environment_kind` required). The server has one seeded Host; a personal
  device may expose several, such as native Windows and WSL.
- `project_folders` is the logical repository identity owned by one Project;
  it carries no host or path.
- `workspace_locations` is a physical checkout of a Folder on one Host —
  server `root_path` or remote `display_path`, branch/head/dirty metadata,
  preferred selection, persisted `execution_ready`.

Runs and host task threads bind to a Location; `project_folder_id` is a
write-once denormalisation with composite constraints preventing drift.

### 2. Two-tier trust

- **Server host — unchanged.** Every invariant in
  [`SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
  §10 (PathPolicy, forbidden paths, bounded diffs, rootless bubblewrap,
  fail-closed preflight) applies exactly as before, to server-host
  Locations. A remote Location is never passed through the server sandbox
  path resolver.
- **Personal host — trusted-host mode.** A thin daemon (`rainver-host`)
  registers with the control plane over the user's private network (v1:
  Tailscale; no public exposure) and spawns CLIs natively — no bubblewrap,
  no mount containment, no PathPolicy. This is not a smaller version of
  server-host isolation; it is a different trust model, safe only because of
  the hard rule below.

**Hard rule, not relaxable without a new decision:** a host accepts only Runs
whose initiating user is that host's registered owner. There is no
multi-user host sharing.

### 3. Paths are host-owned

The control plane never resolves, mounts, or opens a filesystem path on a
remote host. `root_path` is populated only for server-host Locations; a
remote Location has only a daemon-reported `display_path` for labelling, and
the daemon is authoritative for the real directory. `execution_host_kind` is
a constrained denormalised copy of `hosts.kind` so the database can enforce
the remote-root invariant.

### 4. What does and does not extend to a remote host

**Login state does not.** Subscription/OAuth login state is produced by a
vendor login on a machine's disk and cannot be brokered. The credential
broker's CLI HOME continuity model, subscription-egress allowlists,
login-state brokering, remote multi-account selection, and remote vendor
login remain server-host-only. A remote Run with no binding is a native CLI
invocation using whatever the machine is already logged into; the control
plane supplies the rendered task prompt and an approval preset (headless
mode requires one).

**An explicit ModelProvider binding does.** A remote Run may carry a binding
chosen by the control plane, in which case the server-side provider proxy and
its short-lived leases serve it. This costs reachability, not a trust-model
change: the credential never leaves the server either way, because the CLI
receives a proxy URL and a lease token, never the key
([ADR 0008](0008-credential-channel-isolation.md) decision 4). It is what lets
the control plane answer "which model is this host's agent actually running
against". Materialising what a binding needs on the host — run-scoped
provider config and a profile directory that keeps the runtime off the
machine's ambient one — is a consequence of that, not brokered login-state
continuity: a control-plane-provided directory carrying only binding
material is in scope; copying a user's vendor login state to a remote
machine is not. A binding resolves through an enabled active-Space provider
grant, checked at dispatch and again when the remote binding is built, so it
cannot widen who may spend a credential; a Host default naming a provider not
granted in the dispatching Space simply does not apply there.

**B67** follows: a provider-bound remote Run must not inherit ambient backend
selection from the executing machine, so a selected provider cannot be
shadowed by machine state and a subscription login cannot be silently
converted into API billing.

**Continuity** across turns of one task is the Agent Client Protocol's own
`session/resume`, driven by the general ACP controller for every runtime,
tracked by the control plane only as an opaque `vendor_session_id` per task
thread pinned to one (host, workspace, installation).

### 5. The daemon is identity, connectivity, and supervision — nothing more

The daemon's durable role:

- pairing, bearer-token identity, and the **outbound-only** WebSocket — this
  direction is load-bearing (personal machines sit behind NAT) and no runtime
  integration reverses it: the control plane never dials into a host;
- capability probing and reporting, including every CLI installation it
  knows and whether each is logged in;
- runtime process lifecycle: spawning a one-shot CLI turn, or relaying a
  duplex stdio frame stream through the same outbound connection.

There is **one** transport — a duplex stdin frame extension of the host
WebSocket protocol — and **one** server-side protocol client, because every
supported agent speaks ACP over stdio (natively, or through a thin wrapper;
[ADR 0007](0007-multi-cli-mvp.md) decision 3). Runtime protocol knowledge
lives on the server; the daemon relays bytes and understands no vendor
protocol. Rejected: adopting OpenCode Server as the general execution
foundation (it substitutes API spend for the subscription quota that
motivated this topology and replaces the harness the user actually uses);
exposing host-local engines to inbound network access; per-runtime tunnel
endpoints.

### 6. Own installations versus managed installations

A host runs the person's **own** CLI installations — detected on PATH,
never installed, upgraded, reconfigured, or logged into by the daemon on its
own initiative. It may additionally hold **managed** installations: a copy
the control plane chose at a pinned version, with its own login state, for a
machine where the person's copy is absent, outdated, or on the wrong
account — or an ACP-registry agent that has no "own" copy at all. For any
ACP adapter with a distribution, the daemon installs on the host owner's
request (`install_tool`) into `<config dir>/tools/<adapter_type>/<version>/`
— never onto PATH or into global package trees — gives it a private `home/`,
launches it by the absolute path its manifest records, and removes it on
request. A thread pins the installation it runs on, since the vendor session
lives in that copy's login state. Logging a copy in — the machine's own
included — is the host owner's action, as a terminal the daemon runs on a
PTY and relays; the daemon initiates nothing and stores nothing beyond what
the vendor CLI writes into that copy's HOME.

A registry agent is not offered for server-host execution
(`invocation.remote_host_only`), has no server-side runtime tool, credential
profile, or conformance evidence, and enabling one for the deployment is
instance-admin gated, separately from installing it on a host.

### 7. Readiness and dispatch are separate from liveness

`hosts.status` and heartbeat staleness answer reachability. The server probe
or daemon heartbeat writes `execution_ready` and branch/head/dirty metadata;
dispatch requires a live Host and a ready Location, and omitted remote
reports mark Locations not ready. The dispatch surfaces are
`POST /api/v1/tasks/:taskId/runs` and `POST /api/v1/tasks/runs`, which accept
a Location, default to the Folder's preferred one, enforce Project write
access and Host ownership/capability/readiness, and enqueue the same agent
job. Every terminal Run flows through one Run-terminal → Task-status
projection: a Task becomes `done` only after all linked Runs are
hard-terminal and none failed, degraded, cancelled, or orphaned.

### 8. Deferred by decision

Remote in-place execution lands changes on disk before review — the reverse
of propose-then-apply. Code-patch proposal apply/rollback is not extended to
remote hosts; a remote diff is a read-only review artifact and undo is git.
This is an open question for deliberate design ("pit 3" in the deferred
register), not settled by default. Capability-based routing, distributed
scheduling, host leasing, cross-host sync/divergence detection, remote quota
probing, and full local-first replication are likewise out of scope.

## Consequences

- The security narrative is no longer "every agent execution is isolated"
  but "execution is isolated on the server host; on a host you own and have
  paired, it runs with the trust you already extend to that machine". This
  must be visible in the product (pairing flow, dispatch composer), not only
  in documentation.
- Runtime conformance suites are not applied to trusted hosts; a remote
  adapter cannot claim conformance evidence.
- Raising remote isolation later (for example a containerised daemon) is
  compatible with this decision.
- Documents that previously stated unqualified server-side execution —
  `INDEX.md`, `BOUNDARIES.md` (B62, B67), `LOCAL_FIRST_COMPATIBILITY.md`,
  `SECURITY_AND_ACCESS_BOUNDARIES.md` §10, `PRODUCT_AND_BOUNDARIES.md`,
  `ARCHITECTURE.md`, `modules/mobile-client.md`,
  `modules/sync-and-conflicts.md`, and ADRs 0005, 0008, 0014 — are scoped to
  the server host and point here.

## Revision history

- **2026-08-21** — accepted; daemon role narrowed the same day after
  evaluating `opencode serve`.
- **2026-08-22** — one ACP transport instead of per-runtime endpoints.
- **2026-08-24** — explicit ModelProvider bindings extend to remote hosts;
  B67 added; provider-proxy "local" wording swept across `.agent/`.
- **2026-08-26** — managed installations and relayed login terminals.
- **2026-08-27** — rewritten. Four amendments folded into decisions 4–6;
  the amended-documents ledger reduced to the Consequences list and extended
  to ADRs 0005 and 0014, which the original sweeps had missed.
