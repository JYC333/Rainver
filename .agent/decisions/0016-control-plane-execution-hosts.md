# Decision 0016: Control Plane and Execution Hosts, Two-Tier Trust

Date: 2026-08-21
Status: Accepted; phases 1 and 2 implemented and retired (plan documents
deleted, execution ledgers in git history; current state in
[modules/hosts.md](../modules/hosts.md)). The follow-on
[plans/acp-runtime-replatform-plan.md](../plans/acp-runtime-replatform-plan.md)
(P1-P5) is also complete: every conversation runtime speaks the Agent Client
Protocol exclusively on both execution paths.
Amended 2026-08-21 (daemon role) and again 2026-08-22 (runtime protocol
transport) — see the amendment sections below.

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

### 1. An Agent Space instance is one control plane plus N execution hosts

The control plane (the existing server) remains the sole owner of canonical
state, orchestration, governance (proposals, policy, audit), and the
Project/Run/Agent model. An **execution host** is a machine — the server
itself, or a personal laptop/desktop the same user owns — that can actually
run a coding agent against a workspace on disk. `hosts` is a new first-class
table; every `project_folders` row is now bound to exactly one host.

### 2. Two-tier trust, not one isolation model stretched thin

- **Server host**: unchanged. Every existing invariant in
  [SECURITY_AND_ACCESS_BOUNDARIES.md](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
  §10 (PathPolicy, forbidden path patterns, bounded diffs, rootless
  bubblewrap namespace, fail-closed preflight) continues to apply exactly as
  today, to Project Folder rows whose `host_id` names the server host.
- **Remote (personal) host**: a new, deliberately weaker **trusted-host**
  mode. A thin daemon (`agent-space-host`) registers with the control plane
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
remote host. `project_folders.root_path` is populated only for server-host
rows (as today); remote (`host_kind = "remote"` — shipped as a write-once
denormalized copy of `hosts.kind`, not the `origin` field this ADR originally
named; the retired phase-1 plan's D4 amendment) rows carry no authoritative
path at all, only a daemon-reported `display_path` used for UI labeling. This
narrows, rather than contradicts, the existing "Project Folder filesystem
paths are Server-Only" classification: the control plane still never accepts
or exposes a raw path as identity — it now additionally never *possesses* the
remote path at all. The daemon is the sole authority for translating a
`project_folders.id` into a real directory on its own machine.

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
daemon must not become a second Agent Space" continues to hold. What the
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
The rejections in the previous paragraph are unchanged. Decision record:
[plans/acp-runtime-replatform-plan.md](../plans/acp-runtime-replatform-plan.md)
§2 (A1–A3).

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
