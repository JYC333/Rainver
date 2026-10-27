# ADR 0026: Sources isolated execution and per-request admission

Date: 2026-10-26; revised after dual review on the same date.

## Status

Accepted execution foundation. Existing Level 3 remains frozen. This does not
enable the old generated-handler runner or authorize deployment. Stage-two
server orchestration now consumes this foundation; see
[Source Goals](../architecture/SOURCE_GOALS.md) and its acceptance evidence.

## Reuse / dependency check

Reuse the authenticated Host WebSocket/Zod contract, daemon environment filter,
`fetchGuarded` / outbound guard, PostgreSQL transactions, and shared real-PG tests.
Ordinary Run proxies and old handler JS patches cannot confine source code.
Published Apache-2.0 `@crawlee/basic@3.18.2` owns queue/retry in the trusted daemon;
`cheerio@1.2.0` supplies HTML link parsing there. These are pinned Host runtime
dependencies, with transitive versions/integrities in the workspace lockfile.
No browser, CLI, Python or independently deployed collection platform is added.
Framework comparison tooling/locks are separate from the actual isolated path.

## Decision

### Host execution and resource ownership

Sources uses dedicated execute/request/response/cancel/result frames on the
existing authenticated Host connection. No frame accepts a host path, executable,
environment, workspace, provider binding, secret, arbitrary dependency or
isolation override. The server registry generates a fresh execution identity;
duplicate daemon dispatch gets `source_rejected` without cancelling the original.
Hosts explicitly opt in with `RAINVER_SOURCES_EXECUTION=1`; capability checks
advertise `isolated-v1` only with reachable basic facilities. The registry refuses
Hosts without that offer. The offer only describes executability; it grants no
authority. Server-owned Host ownership, Source/Space/Project permission and scope
checks remain mandatory at selection/dispatch, each physical send and result
acceptance. Phase two must not derive authorization from a Host self-report.
Trusted mode grants no exemption. Actual kernel
resource limits are verified before every handler import, not inferred from an
offer or a cooperative JS client.

The daemon resolves the Node executable with realpath and binds only that file,
never its bin directory. Libraries and code are readonly. Bubblewrap creates
private network, PID, user, IPC and mount namespaces, drops capabilities and
provides a readonly empty root plus a sized private `/output` tmpfs. Code sees
no shell, home, workspace, secrets, DB/Docker/user-manager socket or node_modules.
Raw stderr is discarded; non-protocol stdout fails without log retention.

Resources have two explicit backends:

- A user systemd manager creates a service cgroup before the trusted supervisor.
- `RAINVER_SOURCE_CGROUP_ROOT` selects an administrator-delegated cgroup v2
  subtree. The trusted supervisor creates a child, sets CPU/memory/swap/pids/oom
  controls, moves itself into it, verifies the actual files, then starts bwrap.
  This backend needs no user systemd or bus. It does not mount a host directory
  into code or silently relax limits when delegation is absent.

`processes` currently means kernel tasks (threads included), matching TasksMax /
pids.max, and has a minimum of 32 for Node + supervisor + namespace overhead.
CPU quota is verified with bounded integer cross multiplication, avoiding division.
CPU quota, memory with zero swap, tasks, sized tmpfs, output bytes and execution
wall time bound the tree. The trusted supervisor has its own bounded child
wait; the daemon also stops the service or writes cgroup.kill on cancellation.
Direct execution also requires trusted `/usr/bin/prlimit` before the supervisor,
with CORE=0 and FSIZE=output_bytes hard/soft limits inherited by the whole tree.
Missing controllers, namespace/backend startup or supervisor verification refuse
execution. Failed cleanup retains its ownership record and capacity reservation
rather than declaring the slot free. No native/server/old-handler fallback exists.

Recovery reads only ownership records under this daemon's source scratch root,
validates root-derived unit names and delegated cgroup paths, compares owner PID
plus boot/start identity, stops the recorded orphan group, and removes its own
scratch. It never broadly enumerates another user's units. A live other daemon
holding the root prevents recovery from starting a competing executor. Collection
leases are recovered by the same identity check. All state is outside the repo.

The standard sandbox-runner has bubblewrap but no user systemd and normally no
writable delegated cgroup subtree. The direct backend is implemented and tested
in a private delegated subtree with an unusable user bus. Standard-container
provisioning/acceptance remains blocked on administrator-owned delegation; no
instance configuration, system package installation or deployment was performed.

### Actual engine adapter and checkpoint contract

`sourceCollection.ts` runs BasicCrawler in the trusted daemon at concurrency
**one**, matching the single-outstanding-request wire. Framework concurrency-four
benchmarks are comparisons, not measurements of this isolated adapter. A
collection carries server-owned collection identity, seeds, item cap and an
authorization fingerprint. The registry derives that fingerprint from the bound
broker Source/Space/owner scope and reauthorizes dispatch and returned cached data, not caller-supplied wording. Code/input/spec/limits and scope bind
the checkpoint; a changed fingerprint refuses reuse.

The daemon fetches through the bound broker, parses HTML links using Cheerio,
then invokes the same isolated handler with `{context,url,response,links}`.
Code exports `default async ({input,request}) => {items,next_urls}`. It may make
additional sequential controlled requests. No collector dependency or queue
storage is mounted into the handler. Child sequences are translated into one
monotone execution sequence; request budget spans attempts in the checkpoint.
The first 100 valid HTTP(S) HTML links are provided with explicit link coverage;
omitted discoveries are not queued. Aggregate coverage is returned with items.
Crawlee retries transient network/5xx failures once; deterministic HTTP, scope,
contract, output and limit errors use NonRetryableError/noRetry without another
send. Eligible Retry-After stops the run for persistent server-owned cooldown.
The public input remains 1MiB UTF8. An independent daemon-only readonly
collection envelope is capped at 16MiB (response <=8MiB decoded), for at most
17MiB with the independently capped public input; handlers receive
context and response without broadening wire inputs or host writes. JSON output and discovered URLs
are validated and bounded before queue/state writes.

Private queue files and an atomic checkpoint ledger live below the Host-owned
collection directory. A lease excludes concurrent processes. The complete owner file is prewritten and
atomically hard-linked into the lease directory; an old ownerless directory does
not hold ownership. Pre-publication crash files encode boot/start identity and
are cleaned only after proving that owner dead. Release removes only its owner
file then an empty directory, never recursively deleting a new contender. The output ledger
is committed before marking a URL handled; restart rebuilds continuation URLs
and skips already completed output. New-attempt queue keys recover failed URLs.
Checkpoint output is still untrusted candidate data. Only the server's existing
Sources materializer may persist business results and advance business cursors.
There is no second scheduler, goal model or business watermark authority here.

### Framed request transport

The parent-confirmed ready/start handshake precedes import. Strict schemas,
monotone sequence, one outstanding request and no extra frame after final output
are enforced regardless of chunk boundaries. The byte-counting UTF8 decoder
supports fragmented and coalesced input, and the bootstrap awaits write
completion. Parent response writes retain the pending state until drained.
Channel failure, timeout, cancel, disconnect and connection replacement revoke
further HTTP sends. A1's original >64KiB loss inference was not reproduced:
a pre-change real pipe returned a ~200KiB multibyte payload intact. Explicit
write-drain/framing regressions now protect that property and concurrency rules.

### Server network, credentials and minimal API metadata

Each physical hop is scoped and pinned through the existing outbound guard.
Exactly one origin/path-segment/method route must match; overlapping matches,
encoded traversal, noncanonical grants and unlisted query keys refuse. Credentials
are resolved only for the matching route on each physical hop. Credential routes
require HTTPS; public routes never inherit another route's headers. A credential
resolver does not see a handler-controlled header or identity. Every send checks
both construction and per-call/registry signals, live authority, and durable
admission; cancellation while waiting on quota locks rolls the transaction back.

GET/HEAD are supported. Handler headers are limited to Accept, If-None-Match and
If-Modified-Since. Response final URL, bounded ETag/Last-Modified/Link, status,
content type and raw body bytes (base64) form the incremental/pagination contract;
non-2xx bodies are explicitly bounded too. Cookie/auth headers never return.
Secret query injection is intentionally unsupported: keys remain header-only on
the server rather than appearing in handler URLs. Short credential values below
8 bytes refuse resolution to avoid corrupting unrelated binary data. Known raw,
bearer/basic/token and URL-encoded credential bytes are redacted without decoding
and re-encoding the rest of a PDF/GBK/binary response.

Structured source error codes distinguish quota, cancellation/timeout, revoked
authority, credential, scope, channel, network, isolation and output failures.
Quota retryAt survives the registry result. Raw upstream exceptions/logs do not.

### Durable account and endpoint admission

Sources owns opaque operational `source_request_quota_state` with no content read
API. Stable account-group identity is not a plaintext key, run, connection or
caller URL. Account and applicable endpoint windows lock in sorted order and
atomically debit together. UTC minute/hour/day windows only narrow within an
active window. Cooldown refusals without policy changes do not rewrite state.

Only 429, or 503 carrying Retry-After, extends cooldown. A 200 header never does.
Delta and strict HTTP dates use the DB clock; missing/invalid values default to
60s and all new cooldowns clamp to 1..86400s. All account/endpoint groups update
atomically with monotone GREATEST, including shared endpoints across accounts.
Every physical send, redirect, retry, exploration and preview uses admission when
integrated. Key rotation never evades cooldown. The old connection-level
backfill quota remains its compatibility owner until later product integration.

## Verification and limits

Real-PG regressions exercise C1/C2/C4/A2/A3, actual broker-to-registry cancellation,
metadata and errors. Explicit OS tests cover both resource backends, native socket
and alternate HTTP denial, readonly code, isolated real Node file/symlink, tmpfs,
non-timeout OOM, tasks, CPU timeout, cancellation, framing, duplicate dispatch,
owned orphan cleanup and supervisor refusal. The actual adapter fixture uses
real HTTP, two daemon worker processes, isolated handlers and durable restart;
successful URLs are not fetched again. Detailed commands/raw logs/results are
recorded with the implementation plan. Default suites skip OS tests explicitly.
No live model/provider, goal/UI flow, instance migration or deployment is claimed.

## Stage-two integration (2026-10-27)

Goal orchestration reuses the existing Agent Run/Profile, dispatcher, scheduler/jobs
and Source materializer. It binds exact approved network/credential scope, uses
the same per-request broker for exploration, preview, live work and repair, and
advances server business cursors only after materialization. The old unsafe runner
is never a fallback. Goal plans and CAS repair records live in Sources; no second
chat engine, scheduler or collection platform is introduced. Current contracts and
verification limitations are in [Source Goals](../architecture/SOURCE_GOALS.md).


### Conversation and compatibility consumer (stage three)

Goal UI and compatibility mapping do not widen the execution envelope. Mapping
preserves legacy IDs/history/cursors and sends no requests; exact-preview start
atomically transfers scheduler ownership. New generated code remains on the
isolated path, never the old runner. Canonical Session/Run finalization handles
conversation recovery; credential input stays on the existing encrypted channel.
Host self-reported capability remains executability only. See
[SOURCE_GOALS](../architecture/SOURCE_GOALS.md) for transfer/rollback boundaries.
