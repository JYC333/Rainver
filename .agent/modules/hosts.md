# Module: Hosts

See [decisions/0016-control-plane-execution-hosts.md](../decisions/0016-control-plane-execution-hosts.md)
for the design decision this module implements. The phase-1 rollout plan
(`control-center-plan.md`) is retired — execution ledger in git history, as is
phase 2's (`control-center-phase2-plan.md`, which shipped the conversational
thread surface, normalized event pipeline, and setup simplification). So is
`plans/acp-runtime-replatform-plan.md` (P1-P5, 2026-08-22): every conversation
runtime — `claude_code`, `codex_cli`, `opencode` — now speaks the Agent Client
Protocol exclusively on both the server-host and remote-host execution paths;
the self-maintained vendor CLI protocol implementations (stream-json argv,
NDJSON-RPC) it replaced are deleted. **This document describes the ACP-based
system as it stands today.**

## Purpose

`hosts` is the control-plane registry of execution hosts: the server host
(exactly one row, seeded automatically, `owner_user_id` NULL) and any
personal machine a user has paired in trusted-host mode. It owns pairing,
authentication, and liveness for hosts — it does not execute anything itself
and does not know any host's real filesystem paths.

## Data model

`server/src/db/schema/hosts.ts` — one table, `hosts`:

- `kind`: `server` (exactly one row ever, enforced by
  `uq_hosts_single_server`) or `remote`.
- `status`: `pending_pairing` → `offline` → `online` (round-trips on
  connect/disconnect) → `revoked` (terminal).
- `token_hash` doubles as the pairing-code hash before registration and the
  long-lived bearer-token hash afterward — a pairing code **is** a host row
  in `pending_pairing` status; there is no separate pairing-code table.
- `owner_user_id` is NULL only for the server host (`ck_hosts_server_no_owner`
  / `ck_hosts_remote_has_owner`); every remote host has exactly one owner.

`project_folders` (`server/src/db/schema/projectFolders.ts`) carries `host_id`
(FK, NOT NULL) and a write-once denormalized `host_kind` copy (a host's kind
never changes, so this cannot drift) so filesystem-touching repository code
can guard on it without a join. `display_path` is a daemon-reported,
UI-only label; `root_path` is schema-forced NULL for every `host_kind =
'remote'` row (`ck_project_folders_remote_no_root_path`) — the control plane
never possesses a remote path (ADR 0016 B64).

## Server-host guard (ADR 0016 B62)

`assertServerHostFolder()` (`server/src/modules/projectFolders/repository.ts`)
throws before any local-filesystem operation runs against a Folder whose
`host_kind` is not `server`. It gates `getTree`, `getFile`, `getGitStatus`,
`getGitDiff`, `PgRunSandboxManager.prepareRunWorkspace`
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
- `POST /api/v1/hosts/:hostId/revoke` — terminal; a revoked host's token stops
  authenticating. Also closes the host's live WebSocket connection
  immediately if it has one (`HostConnectionRegistry.closeConnection`) — so
  revoke cuts off an already-connected daemon right away, not just its next
  reconnect attempt.

Unauthenticated (the pairing code itself is the one-time credential):

- `POST /api/v1/hosts/register` — `{ pairing_code, platform?, arch?, daemon_version?, capabilities_json? }` → `{ host_id, token, name }`.

Host-bearer-token authenticated (`Authorization: Bearer <token>`, never a
user session — the daemon has no session to present):

- `POST /api/v1/hosts/me/workspaces` — `{ project_id, name, display_path? }`,
  requires the host owner to hold Project write access
  (`PgProjectFolderRepository.createRemoteWorkspace`); creates a `host_kind
  = 'remote'`, `root_path = NULL` Folder row.
- `GET /api/v1/hosts/me/workspaces` — every Folder registered under this host.
- `DELETE /api/v1/hosts/me/workspaces/:folderId` — unregisters (never touches
  the daemon's disk; the daemon owns that).
- `POST /api/v1/hosts/me/runs/:runId/diff` / `.../outputs` — daemon uploads a
  completed run's git diff and `AGENT_SPACE_OUTPUT_DIR` contents as read-only
  artifacts (D7: never fed into code-patch proposal apply). Scoped by
  `runOwnedByHost` — a host can only upload for a Run bound to its own Folder.
  Size-capped server-side (`MAX_DIFF_BYTES`, `MAX_OUTPUT_FILE_BYTES`,
  `MAX_OUTPUT_FILES` in `repository.ts`) regardless of what the daemon sends.

User-session authenticated, dispatch (D10 — bypasses route selection
entirely):

- `POST /api/v1/hosts/dispatch` — `{ project_folder_id, adapter_type,
  prompt, thread_id?, timeout_ms? }`. `agent_id` is gone from the request
  contract entirely since the control-center phase-2 work (retired plan, git
  history; its C8 decision) — see
  "System remote-dispatch agent" below; every dispatch always resolves the
  space's system agent, and a caller that still sends `agent_id` (the
  frontend `DispatchComposer.tsx` does — its picker UI is unchanged, still
  requires selecting one before Dispatch enables, per discovery review; P2
  is server-scoped, so the picker's removal is left to P3's entry rework)
  has it silently discarded, not read or validated. Guards in order: session auth →
  Project write access → Folder must be `host_kind = 'remote'` (never a
  server-host Folder — use the normal Run flow) → B63 host ownership
  (`host.owner_user_id === caller`) → host online → implemented, ACP
  runtime protocol → runtime capability match against the host's reported
  `capabilities_json.runtimes`. Resolves/creates a task thread (D14, below);
  an existing thread remains pinned to its original runtime adapter. Every
  send — including the very first into a brand-new thread — goes through the
  message queue (P2, C4, below): the endpoint enqueues a `host_thread_messages`
  row, then immediately tries to advance the queue, so "dispatch now" and
  "queue for later" are one code path. Response:
  `{ message_id, thread_id, run_id: string | null, status: "dispatched" |
  "queued" }` — `run_id` is only set when this specific message actually
  dispatched.
- `POST /api/v1/hosts/threads/:threadId/messages/:messageId/withdraw` — pulls
  back a still-`queued` message before it ever becomes a Run; 409 if the
  message is already `dispatched` or `withdrawn`. Requires Project write
  access (`requireThreadProjectWriter`, resolved via the thread's Folder) —
  any writer, not only the message's own sender, matching dispatch's own
  Project-wide (not per-user) trust boundary. `requireThreadProjectWriter`
  resolves a thread by id alone with no space scoping before checking write
  access, unlike the sibling `GET .../events` endpoint's `identity.spaceId`-
  scoped lookup — an authenticated caller with no relationship to a given
  Space can distinguish "this thread id exists somewhere" (403) from
  "doesn't" (404). Low practical severity (opaque UUIDs, existence-only) and
  it matches dispatch's own Folder-resolution pattern, but it's an internal
  inconsistency between this phase's own new endpoints — recorded as a
  conscious, accepted gap (discovery review, P2), not fixed: closing it
  would mean switching these three endpoints off `getCurrentUser` onto
  `introspectIdentity` (the events endpoint's space-scoped auth), a real
  auth-flow change out of proportion for a minor, low-severity finding.
- `POST /api/v1/hosts/threads/:threadId/resume-queue` — clears a paused
  queue (P2, C4) and immediately tries to advance it. The only way a pause
  clears; never automatic. Requires Project write access.
- `POST /api/v1/hosts/threads/:threadId/cancel` — cancels the thread's
  current active Run via the existing generic `orchestration.cancelRun`
  (same mechanism `PATCH /api/v1/runs/:runId/stop` uses) — this endpoint's
  job is finding "the active run for this thread" and gating it behind
  Project write access, not new cancellation machinery. 409 if no active run.
  Never touches the queue directly (C4: cancel is explicit, never coupled to
  sending) — the queue pauses as a side effect of the cancelled Run reaching
  a non-`succeeded` terminal status through the ordinary post-terminal hook,
  the same as any other failure.
- `GET /api/v1/hosts/threads/:threadId/events?after=<index>` — cursor read
  for a thread's normalized conversation events (below), everything after
  `after` (default `-1`, i.e. from the start), oldest first. Space-scoped via
  the thread's Folder → Project, same `assertProjectReadable` pattern as
  `GET /api/v1/hosts/threads`.
- `GET /api/v1/hosts/threads/:threadId/messages` (P3) — read side for
  `host_thread_messages`, the durable per-thread message ledger; same
  space-scoped `assertProjectReadable` auth shape as the events read above.
  `runs.prompt` is redacted on read, so this is the only readable record of
  what was actually sent into a thread.

Space-scoped, not user-scoped like the rest of this module (P4, control
center work stream):

- `GET /api/v1/hosts/threads?project_id=X` — every task thread across every
  remote workspace in a Project. Authenticated via `introspectIdentity`
  (session + `X-Agent-Space-Id`, the standard space-scoped pattern every
  other Project-owned read endpoint uses) rather than the bare
  `getCurrentUser` this module's other routes use, because a thread's
  visibility follows Project **read** access (`assertProjectReadable`), not
  host ownership — a Project member who has never registered a host can
  still see what's been dispatched to one. 422 without `project_id`.
- `GET /api/v1/hosts/threads/recent?limit=N` (P3, C10) — cross-project
  landing read for the Command Center: every thread in the space the caller
  can read, most-recently-updated first, joined with
  project_id/project_name/folder_name. Space membership alone is **not**
  the readability bar here — a household/team space's Projects each carry
  their own membership list, so the query inlines the same rule
  `canReadProject` (`projects/access.ts`) applies per-Project: personal
  space, or the caller owns the Project, or an active `project_members`
  row, and (added after a discovery-review finding) `deleted_at IS NULL`,
  matching the project-scoped route's own `assertProjectReadable` boundary.
- `GET /api/v1/hosts/runtime-adapters` (P3, C6) — static catalog of
  remote-eligible adapters (`implemented` + ACP protocol — since the ACP
  runtime replatform, that's all three: `claude_code`, `codex_cli`,
  `opencode`), sourced from `listRuntimeAdapterSpecs()`. Session-authenticated
  only (`getCurrentUser`, no space scoping — the catalog carries no per-user
  or per-space data). The single source of truth the frontend reads instead
  of re-deriving the dispatch route's own ACP-only eligibility rule a third
  time. Each entry's `capability_probe` is what a trusted host's capability
  probe actually reports for that adapter when it differs from `command` (an
  ACP adapter's own bundled executable, e.g. `codex-acp`, vs. the vendor CLI
  binary a host reports, e.g. `codex`).

## WebSocket (`GET /internal/hosts/ws`, `@fastify/websocket`)

`hello` (authenticates the bearer token, marks `online`, records
capabilities) and `heartbeat` (refreshes `last_heartbeat_at` and reported
capabilities). On socket close, the host is marked `offline` immediately.
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

Job dispatch/execution frames (P3, `RemoteHostExecutionAdapter` in
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
ACP extension above; see
[plans/acp-runtime-replatform-plan.md](../plans/acp-runtime-replatform-plan.md)
(now complete, P1-P5).

C5: the daemon also sends a live `stderr` frame per chunk (not only the
`complete` frame's existing failure-tail), routed the same way as `output`
through a new `HostConnectionRegistry.receiveStderr`/`onStderr` pair.

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

## Task threads (D14, `server/src/modules/hosts/taskThreadRepository.ts`)

A `host_task_threads` row pins a vendor-CLI conversation to one (host,
workspace) pair for session resume via ACP's own `session/resume` (the
general `AcpController` in `server/src/modules/runs/cliConversationProtocol.ts`
drives this for every adapter now) — not server-side Runtime Context
continuity (remote runs get none of that; see
"No server-brokered Runtime Context" below). `getForFolder` is scoped by
`project_folder_id` so a thread from one Folder can never be resumed against
another. `recordRunOutcome` clears `vendor_session_id` outright (not
COALESCE) whenever a resume degrades (`session_reset`) — retrying an already-
broken vendor session id forever was a real P3 discovery-review bug, fixed
before this landed. **Since the phase-2 event-pipeline work**, it is called
from `agentRunHandler.ts`'s `handleAgentRun` (via
`server/src/modules/hosts/threadOutcome.ts`'s `recordHostTaskThreadOutcome`)
once the dispatched Run's `agent_run` job reaches terminal — not from the
dispatch route itself, which no longer waits around for that.

The Command Center displays the thread's opaque `vendor_session_id` so a
successful remote Run and its resume target are visible without confusing
them with the server-owned `runs.session_id`. Run output/progress display is
no longer a client-side parse of the raw vendor stream-json summary (that
mechanism — `apps/web/src/modules/command_center/runOutput.ts` — was deleted
in P1, superseded by the normalized event log below); the P3 conversation UI
is what renders it.

`host_task_threads.queue_paused_at` (P2, non-null while the message queue is
paused) is a separate concern from `status`/`session_reset` — a thread can be
`active` (vendor session fine) and queue-paused (something needs the user's
attention) at the same time.

## Message queue (P2, C4 — `server/src/modules/hosts/{threadMessageRepository,queueAdvance}.ts`)

`host_thread_messages` is the durable, per-thread message ledger — `queued`
(waiting its turn), `dispatched` (became `run_id`'s Run), or `withdrawn`.
Rows are never deleted, including `dispatched`/`withdrawn` ones: `runs.prompt`
is unconditionally redacted to null on every API read (`runReadModel.ts`), so
this table is the canonical, readable record of what a user actually said
into a remote thread, not merely a pending-work buffer.

`advanceThreadQueue(pool, threadId)` is the single decision point for "should
the next queued message actually dispatch right now" — called from the
dispatch route (right after enqueueing, in case nothing blocks an immediate
send) and from `agentRunHandler.ts`'s post-terminal hook (right after a Run
completes). It pops the oldest `queued` message unless: the thread is paused;
the thread's latest Run is not yet in a terminal status (`isTerminalRunStatus`
— **not** a hand-rolled status list; an earlier draft of this check omitted
`waiting_for_review`, silently deadlocking the queue forever after any Run
that landed there, since nothing besides `succeeded` was ever expected);
or the host is currently offline (the message stays queued — nothing in this
phase re-triggers on host reconnect, so it waits for the next dispatch or
completion to try again). A clean `succeeded` terminal advances the queue;
anything else (`failed`, `cancelled`, `degraded`, `orphaned`, timed out,
`waiting_for_review`) pauses it instead of firing the next message on top of
whatever just went wrong — resuming is always an explicit user action
(`POST .../resume-queue`), never automatic.

`createAndQueueRun` (`queueAdvance.ts`) is the shared "insert the Run row,
enqueue its `agent_run` job" core the dispatch route's first send and every
later auto-advance both call, so the two paths cannot silently drift.

Cancel (`POST .../threads/:threadId/cancel`) does not touch the queue
directly — it finds the thread's active Run and calls the existing generic
`orchestration.cancelRun`, the same mechanism `PATCH /api/v1/runs/:runId/stop`
already used for any other Run. The queue pausing is a side effect of the
cancelled Run reaching a non-`succeeded` terminal status through the ordinary
post-terminal hook, not special-cased in the cancel endpoint itself. For a
Run whose job has not yet been claimed by the worker, `cancelRun` resolves
synchronously with no daemon round trip (`CliProcessRegistry.terminate`
finds nothing registered yet, so `confirmedExit` stays at its default
`true`); for a Run already executing, cancellation waits (up to 5s) for the
daemon to confirm the process exited, mirroring the server-host cancel path
exactly — this is pre-existing `orchestration.cancelRun` behavior, not new
P2 machinery.

### System remote-dispatch agent (P2, C8 — `server/src/modules/hosts/remoteDispatchAgent.ts`)

The Agent selection requirement is gone from dispatch — `agent_id` is not
part of the request contract at all (see the REST surface entry above) — D1
already strips every server-Agent input from a remote run (no runtime
context, no provider resolution, no credentials), so requiring one was
ceremony. `runs.agent_id`/`agent_version_id` stay NOT NULL
FKs (loosening them would ripple through the whole runs subsystem), so
`ensureRemoteDispatchAgent` lazily creates one space-shared, system-owned
Agent per space (`agent_kind = 'system_remote_dispatch'`, a new value in
`ck_agents_agent_kind`, with the same `uq_agents_system_*_per_space`
unique-while-active pattern as `system_research`/etc) and reuses it for
every agent-id-less dispatch in that space. Its own `adapter_type`/model
config are never read by anything — a remote run's execution is driven
entirely by `runs.adapter_type`, not the Agent.

Written as a direct `INSERT` into `agents`/`agent_versions`, not through
`PgAgentRepository.create()` — that path's `resolveRuntimeConfig` has real
requirements for an Agent that will actually execute (a configured model
provider for `model_api`-family adapter types, a registered CLI runtime tool
version for `local_cli`-family types like `claude_code`) that have nothing
to do with a placeholder whose `adapter_type` is inert; paying either cost
would make remote dispatch depend on unrelated server-host configuration.

This is a registered cleanup item (deferred-register.md), not a permanent
model — it must be replaced when the next-phase agent/Room-supervision model
lands.

## Thread events (P1, `server/src/modules/hosts/threadEventRepository.ts` /
`threadEventNormalization.ts`)

`host_thread_events` is the normalized, per-thread conversation log —
`assistant_text` (coalesced text segments), `tool_activity_started`/
`tool_activity_finished` (paired by `tool_call_id`, never carrying tool
result content), `status` (`run_started`/`run_succeeded`/`run_failed`/
`run_timeout`), and `diagnostic` (one stderr line each). `thinking`/
`thinking_delta` are dropped by construction — no event_type exists for them
— not filtered from a wider vocabulary (C5). `event_index` is a monotonic
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

## No server-brokered Runtime Context for a remote run (D1)

`RunOrchestrationService.prepareRuntimeContext` and `enforceRuntimePolicy`
both branch on `hostKind`: a remote run skips the Runtime Context Gateway
entirely (no retrieval, no provider/model resolution, no MCP — planning a
Delivery would fail outright anyway, since there is no bound provider to
resolve a default model from), skips CLI credential-profile/tool-version
resolution, and never has its `required_sandbox_level` escalated past the
dispatch endpoint's `none` (`resolveSandboxLevelForRuntime` is server-host-only
policy for a workspace the server itself provisions). The daemon runs the
vendor CLI bare, auto-approving edits/commands in the workspace
(trusted-host default — the user reviews the returned diff instead).

## Host daemon (`packages/host-daemon`, binary `agent-space-host`)

A deliberately thin bridge — no planner, no memory, no business logic (ADR
0016 principle: "the daemon must not become a second Agent Space"). Config at
`~/.agent-space-host/config.json` (override root via
`AGENT_SPACE_HOST_CONFIG_DIR`), mode 0600, the **only** place a workspace's
real local path is ever written down.

- `agent-space-host register --server <url> --code <pairing-code>` — exchanges
  the pairing code for a bearer token.
- `agent-space-host workspace add <path> --project <project_id> [--name <name>]`
  — registers a pre-existing local directory (no mkdir/clone/scan, unlike the
  server-host `create` flow). Requires an explicit `project_id` in phase 1 —
  no cross-space "my projects" picker exists yet.
- `agent-space-host workspace list` / `workspace remove <id>`.
- `agent-space-host run` — service mode: opens the WS connection, sends
  `hello`, then `heartbeat` every 15s; reconnects with exponential backoff
  (1s → 30s cap) on any disconnect. Handles `launch`/`terminate` frames
  (`src/execution.ts`): spawns the rendered argv in the local workspace path
  (resolved from the daemon's own `config.workspaces` map by
  `project_folder_id` — the server never sees it), injects
  `AGENT_SPACE_OUTPUT_DIR` as a per-run directory outside the workspace
  (phase-1 substitute for Run Exchange), streams stdout as `output` frames,
  and on exit uploads the workspace's git diff (`src/gitDiff.ts` — unified
  `git diff HEAD` with untracked files staged via intent-to-add so new file
  content shows up, reset immediately after so nothing is left staged) and
  the output directory's contents (`src/outputFiles.ts`, UTF-8 only — a
  binary deliverable is a known phase-1 gap) before sending `complete`.
  **`AGENT_SPACE_OUTPUT_DIR` is no longer nudged via the prompt** (real-usage
  finding, 2026-08-22): every remote dispatch is workspace-bound, and the
  intent-to-add diff capture above already gives a brand-new file's full
  content, so `remoteHostCliAdapter.ts` stopped instructing the agent to
  write deliverables there — it was misdirecting ordinary workspace writes.
  The env var and upload path stay wired (dormant unless something writes
  there unprompted); a real, structured "information for agent-space itself"
  channel — distinct from workspace file changes — is a deferred design
  question, not this fix (`tasks/deferred-register.md`).
  Termination uses `process.kill(-pid, signal)` against the whole process
  group (`detached: true` at spawn), escalating a graceful `SIGTERM` to
  `SIGKILL` after a 5s grace window if the process ignores it.

Capability discovery (`src/capabilities.ts`) probes PATH for `claude`,
`codex`, `opencode`, `git` via `--version`; absent binaries are silently
omitted, never installed or version-managed by the daemon (that stays a
`runtimeTools`-style server concern for the server host only — trusted hosts
use whatever the machine already has).

## Known phase-1 gaps (not defects — accepted during the retired phase-1 plan)

- No routing-location axis: dispatch to a specific host/workspace will be
  explicit, not scored, when it lands in P3.
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
  host permanently occupies its name — there is no automatic cleanup. The
  owner can see the stuck row via `GET /api/v1/hosts` and revoke it manually
  to free the name (`revoke()` does not filter by current status, so this
  works even on a `pending_pairing` row); a scheduled sweep of expired
  `pending_pairing` rows is a reasonable P2+ addition, not required for P1.
- **No DB-level trigger enforces `project_folders.host_kind` staying in sync
  with `hosts.kind`.** It is a write-once denormalization upheld today only
  by the two INSERT call sites (`create()` always writes `'server'`;
  `createRemoteWorkspace()` always writes `'remote'`, correct because
  `!host.owner_user_id` is equivalent to `host.kind !== 'server'` given the
  schema's CHECK constraints); no UPDATE path touches either column. Correct
  by inspection, but as more writers are added in P2/P3 a DB trigger (or a
  generated column) would remove the need to keep re-verifying this by hand.
