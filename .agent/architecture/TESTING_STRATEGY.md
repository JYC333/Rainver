# Testing Strategy

How the test suites are organized, what they protect, and the rules that keep
them fast. Commands are in [`../COMMANDS.md`](../COMMANDS.md).

## Scope

Eight Vitest suites, one per package, each run from its package root:

Server no-emit typechecking includes its cross-package Host integration fixtures
under the repository root; the production server build keeps `rootDir: src`.

| Package | Tests | Notes |
|---|---|---|
| `server/` | `test/**/*.test.ts` | Real PostgreSQL for anything durable; shared helpers in `test/support/` |
| `packages/protocol/` | `test/**/*.test.ts` | Schema parsing and frozen registry fixtures |
| `packages/host-daemon/` | `test/**/*.test.ts` | Pure node |
| `packages/agent-cli/` | `test/**/*.test.ts` | Spawns the command as a real child process against a stub control plane |
| `packages/folder-read/` | `test/**/*.test.ts` | Path policy, reads, and git |
| `packages/reader-document/` | `test/**/*.test.ts` | Reader tree normalization and the Markdown converter (pure) |
| `packages/outbound-guard/` | `test/**/*.test.ts` | Outbound block list and fetch guard |
| `apps/web/` | `src/**/*.test.{ts,tsx}` | jsdom by default; pure-logic files opt out |

Web layout has a separate `pnpm run test:layout` Chromium check against the
built app (`src/__tests__/conversation-layout.browser.mjs`, and
`src/__tests__/reader-layout.browser.mjs` for the shared Reader's typography,
narrow widths, phone drawer and shortcuts, and
`src/__tests__/reader-journeys.browser.mjs` for the Reader's end-to-end
journeys over an in-memory fixture server and its long-document performance
budget, measured under 4× CPU throttling as a low-end proxy; set
`READER_PERF_OUT` to write the measurements, and `READER_INTERACTION_OUT` for
the drag-selection, anchor-placement and highlighting case). It uses Playwright
Core with browser-local API fixtures to protect Room and Agent Work geometry,
clipping ancestors and Streamdown CSS integration; jsdom cannot measure these.
Browser setup and an optional hosted-build target are in COMMANDS.

Tests are unit-style (deterministic rules, parsers, state transitions, no
database or network), route-style (status codes, response shapes, validation,
side effects across a public boundary), or workflow-style (a multi-step product
flow asserted on its durable result and audit trail). Pick by what the test
protects, not by which file it happens to exercise.

Real-Postgres file teardown also clears the composed auth runtime and Run
finalization registry before dropping its database. Shared Vitest workers retain
module state; a registered reconciler or auth repository from one file must not
connect to that file's deleted database in a later suite. Production services
and access checks are unchanged by this test-fixture cleanup.

## What To Test

Protect product behavior that must survive refactors:

- API contracts and public response shapes.
- Durable database state: artifacts, proposals, activity records, memories,
  runs, audit records.
- Authorization, space isolation, Project Folder path boundaries, proposal gates.
- Runtime failure behavior and the absence of partial side effects.
- Run output materialization from structured runtime output.

A useful test stays meaningful when the implementation moves behind the same
public behavior. Do not test removed routes, private call chains, mock call
order, implementation-specific module boundaries, vendor internals behind
runtime/provider adapters, or styling from backend tests; do not add
coverage-only tests with no product assertion.

The Room execution-context DB contract test imports only the browser-safe pure
`runtimeChoice` DTO projector from the web package to validate the same four-field
input against the real server boundary. This is a test-only contract probe, with
no React, browser globals, API client or production server-to-web dependency.

## Fixtures And Fakes

Search `server/test/support/` first, then a neighbouring test in the same
domain, before writing setup; promote setup that appears a second time into
`support/` instead of copying it (reuse obligation:
[`REUSE_AND_DEPENDENCY_POLICY.md`](REUSE_AND_DEPENDENCY_POLICY.md) §7).

- Factories create valid minimal objects; ownership fields (`space_id`,
  `created_by_user_id`, `project_folder_id`, actor ids) are visible at the call
  site when the rule under test depends on them.
- Invalid states are explicit in the test body or the factory name.
- A factory creates proposals, memories, artifacts, or approval events only if
  its name says so; assertion helpers never create data.
- Cross-space and cross-user variants stay easy to create.

Runtime and provider execution are external boundaries: use deterministic fakes
(fixed `output_text`/`output_json`/errors/`produced_artifact_paths`, fixed model
responses and structured failures), never live providers, CLIs, or sandboxes in
the canonical suite. Workflow tests may fake that boundary but use real services
and database state around it. Runtime adapter behavior and model provider
behavior stay separate, in tests as in production.

## Shared PostgreSQL

Durable behavior is tested against real PostgreSQL, never a fake database: a
fake validates SQL shape while missing constraints, transactions, locks, JSON
queries, triggers, and cross-table invariants. Database fakes are allowed only
in narrowly scoped unit tests whose stated purpose is SQL/parameter shape or a
pure adapter boundary.

**One container, one database per file.** Global setup
(`server/test/setupOfficialPlugins.ts`) starts one `pgvector/pgvector:pg18`
Testcontainers instance and applies the baseline once to a template database
named by the migrations' content hash. A test file declares
`const db = useTestDatabase(__filename)` (`test/support/testDatabase.ts`) at
module scope and gets its own clone of that template as `db.pool`, dropped in
`afterAll`. When the container is unreachable the fixture reports every test in
the file as skipped, never passed; hooks that use the pool still guard with
`if (!db.available) return;`, since a hook cannot be skipped. CI sets
`REQUIRE_TEST_POSTGRES=true`, which fails the run in global setup instead of
skipping. Do not start a
second container or create ad-hoc databases. A clone already carries the
baseline, so never call `migrate()` on it; tests of the migration runner,
plugin migrations, or a hand-authored schema pass `{ empty: true }` and
migrate themselves.

**Unavailable is narrow.** Only an unreachable container or a connection
error (`isTestPostgresUnavailableError`) makes `db.available` false; the
fixture rethrows migration, schema, seed, and service construction errors so
they fail the suite.

**Seed with the shared fixtures.** `test/support/domainSeeds.ts` holds the
rows most Project-domain files need (`seedSpaceOwnerProject`,
`seedAgentWithVersion`); inline the same INSERTs in a new file only when the
fixture's options cannot express the difference, and promote a seed that
appears in a third file. A file that inserts `projects` rows directly must
call `seedMainlineRoomsForAllProjects(pool)` afterwards: every Project is
created with its mainline Room (ADR 0018 decision 4), and a fixture without
one builds a shape production cannot produce, which reads that assume the
mainline exists then report as a broken invariant.

**Clearing rows between tests.** Use `resetTables(pool, tables, { cascade })`
from `test/support/resetTables.ts`, never `TRUNCATE`. `cascade: true` follows
foreign keys exactly as `TRUNCATE ... CASCADE` would, so the call site still
names the tables it cares about; the implementation deletes only from tables
that ever held rows, in one round trip with FK triggers off. Sequences are not
reset; tests must not depend on sequence values.

**Container settings.** The container is test-only: tmpfs, `fsync=off`,
`synchronous_commit=off`, `full_page_writes=off`, `autovacuum=off`, `jit=off`,
`wal_level=minimal`, a one-hour checkpoint horizon, `max_locks_per_transaction=512`
(applying the baseline in one transaction takes thousands of lock slots, and the
default 64 runs the shared lock table out when migration-chain tests overlap),
and the PostgreSQL 18 tmpfs mount at `/var/lib/postgresql`. Local runs on the
same migration fingerprint reuse the container and its migrated template across
invocations. The fingerprint is part of the container reuse key, so worktrees
on different baselines use distinct containers. Setup leaves templates in
place. `TESTCONTAINERS_REUSE_ENABLE=false` disables reuse and tears down on exit. Per-file databases are always recreated, and setup
reclaims databases left by runs killed before teardown once they are older than
two hours (younger ones may belong to a concurrent run).

**Rules the hygiene test enforces.** A real-Postgres file declares its
database with `useTestDatabase`, never its own container or `Pool`; a file
mocks `src/db/pool.js` — or anything, see Runtime — only if it is already on
the hygiene test's list, which must only shrink; a module's barrel (`../src/modules/<x>/index.js`) is imported
only for its `xModule` object — everything else comes from its own file; and a
family that already has a `*Group.test.ts` takes new small tests there rather
than in a new file. Test data keys on UUIDs: `resetTables` does not reset
sequences, so nothing may depend on a sequence value.

## Test Support Index

`server/test/support/` is the one place for test infrastructure. Search it
before writing setup.

| File | Provides |
|---|---|
| `testDatabase` | `useTestDatabase(import.meta.filename)` — the file's real-Postgres database |
| `sharedPostgres` | The shared container handle behind it; not called from tests directly |
| `resetTables` | `resetTables(pool, tables, { cascade })` between tests |
| `moduleServer` | `buildModuleServer(config, [xModule])` — the app shell with only the modules under test |
| `domainSeeds` | Space/owner/project (with its mainline Room), member, agent + version, run, server host; `seedMainlineRoomsForAllProjects` for files that insert Projects directly |
| `researchSeeds` | arXiv source chain, relevant corpus item, research Operation, screening gate, question Thread |
| `customSourceWorld` | The Custom Source connector/provider/mapping world and its Space policy row |
| `customSourceFixtures` | Runner settings, policy envelopes, listing-page HTML for Custom Source unit tests |
| `knowledgeFixtures` | Knowledge items and note collections |
| `memoryFixtures` | Memory entries |
| `researchWorkflow` | `insertResearchWorkflowFixture` |
| `routeFakes` | Fake auth repository, retrieval settings row for route tests |
| `sourceRetrievalTestSql` | SQL router shared by the fake-db source tests |
| `retrievalEval`, `usageAttribution` | Domain fixtures for retrieval evaluation and usage attribution |
| `mockUpstream`, `piAiHttp` | Provider HTTP fakes (proxy upstream, Pi SSE wire) |
| `sourceFiles` | `listTsFiles` for meta-tests that scan the source tree |
| `sqlCapture` | Records executed SQL when `SQL_CAPTURE_DIR` is set (see COMMANDS.md) |
| `agentAttentionSeeds` | `seedAttentionRun` — a real Agent Run/Attempt on the canonical Agent/Profile fixture |
| `baselineSql` | Reads `0000_baseline.sql` with normalized identifiers for schema-decision assertions |
| `briefingFixture`, `briefingQualityCorpus` | Project briefing world (team Space, writer/viewer, consenting Source, Agent) and a synthetic briefing-quality corpus |
| `briefingWorkerHarness`, `briefingWorkerProcess`, `briefingWorkerProtocol` | A real jobs-worker OS process from the built server with a synthetic Host, for restart/stop tests; `await buildServerDist()` builds `dist` once per run |
| `syntheticAcpHost` | `SyntheticAcpHost` — an in-process daemon on a `HostConnectionRegistry` that speaks the launch/stdin/complete frames and a minimal ACP agent, records every `launch` frame and `session/prompt` it receives, and answers or fails each turn as the test says (an answer may make the Run's own tool calls with the token its launch frame carried) |
| `promptProvenance` | `joinedInvocation(pool, host, runId)` — matches one Run's canonical current input, persisted Delivery and Invocation Snapshot, and the ACP prompt the synthetic Host received |
| `testPartition` | `partitionTests(part, parts, routes)` — deals one long `<name>.suite.ts` across `<name>.N.test.ts` entry files |
| `builtinSkillFixture` | The sample built-in Skill package (test data only) |
| `lockWait` | Waits until a backend in the file's own database is blocked on a lock, for race tests |
| `webDist` | `await requireCurrentWebDist()` — first line of a browser case that serves `apps/web/dist` through `vite preview`; refuses a missing build, or one whose `dist/build-inputs.json` (content hashes the web build records, `apps/web/buildInputs.ts`) no longer matches the checkout, before a browser starts (build web first; it never builds; never compares mtimes) |
| `modernIteration` | `ModernIterationService` — Inquiry iteration service sending the complete current command |
| `monitoringFixture` | Real-Postgres Project monitoring world (`ProjectMonitoringService` over an arXiv source chain) |
| `outboundGuard` | Outbound guard settings that admit loopback/`.test` upstreams in tests |
| `readingMaterial` | `retainReaderBody` — a retained Sources Reader document |

## Route Tests Build Only Their Module

Route tests build the app with `buildModuleServer(config, [xModule, ...])` from
`server/test/support/moduleServer.ts`, listing the modules whose routes they
exercise. It composes the real app shell (`src/gateway/appShell.ts`: body
handling, error envelope, request-id headers, unknown-API catch-all), so status
codes and envelopes match production; routes from unlisted modules answer 404.
Requests go through `app.inject()`, so setup rows must be committed before the
request and re-queried after it.

`buildServer` loads every module — several seconds of import per file — and is
reserved for tests about the gateway or the registry as a whole: gateway
conventions, health, registry ownership, and modules whose `onReady` validates
cross-module registrations (automation targets).

## Runtime

Vitest 4 with `experimental.fsModuleCache` on, cached per package under
`node_modules/.vitest-cache`; the first run after a dependency change
repopulates it.

**Server projects split by setup needs and `vi.mock`.** Module evaluation is the largest
cost of the server suite: every file that imports a service pulls in most of
the module graph (~1.3s). `server/vitest.config.ts` therefore runs files
without `vi.mock()` in a `shared` project with `isolate: false` — one module
graph per worker, evaluated once — and files that `vi.mock()` in an `isolated`
project, because a mock stays registered for every file that follows in its
worker. A conservative, reviewed pure-file list gets the same isolation split
(`pure` / `pure-isolated`) without global setup or SQL capture. Remaining files
retain `shared` / `isolated` integration setup; a filename containing `Db` is
not the classifier. Unreviewed files keep integration preparation. Config
regression checks compare all project assignments with the complete on-disk
file set and require exactly one assignment and unchanged mock isolation.
The hygiene test freezes the mocking list so it only shrinks.

`test/setupIntegration.ts` shares one coordinator-owned setup and root-provided
Postgres context between the two integration projects, including when CI disables
container reuse. Its dynamic import keeps Testcontainers, migrations and plugin
builds outside pure runs. Both integration projects release their reference at
teardown; the last release runs the existing global cleanup. Explicit browser
configs opt back into integration setup and SQL capture after replacing projects.

Reuse / Dependency Check: extends Vitest projects and provided context plus the
existing shared-Postgres setup; Vitest remains the external runner. No new
runner or container manager. A small coordinator reference count prevents two
integration projects from starting two containers when reuse is disabled.

Sharing a worker means module-level state outlives a file. Three rules follow,
all enforced by the hygiene test: a file that sets a `__set*ForTests` seam
resets it (`null`) in `afterEach`/`afterAll`; a file that fakes timers restores
them in `afterEach`; and `useTestDatabase` closes the `getDbPool` pool for its
database in teardown (`closeDbPool`), because `DROP DATABASE` waits on any
connection a service opened. A failure that appears only in the full run and
not when the file runs alone is a leak of this kind in whichever file ran
before it in that worker.

The web suite runs at full parallelism and starts a jsdom environment per file.
Test files that touch no DOM declare `// @vitest-environment node` on their
first line; `src/test/setup.ts` awaits `setupDom.ts` only where a DOM exists.
Node files do not import Testing Library, React or jest-dom through setup.
`setupDom.ts` retains DOM shims, React cleanup and localStorage cleanup.
`asyncUtilTimeout` is 15s so `findBy*` waits out a lazy
chunk that is still transforming under load.

Two Vitest 4 behaviors to write for: a `vi.fn()` used as a class needs a
`function` implementation (arrow functions are not constructible), and
`vi.spyOn` on an already-spied method reuses that spy with its call log, so
files that spy on the same method in several tests restore mocks in
`afterEach`.

## Time Budgets Are Advisory

Pure performance measurements warn; they never determine whether a completed
run passes. Functional assertions, collection errors and infrastructure errors
still fail. Do not catch arbitrary errors and relabel them as performance warnings.

1. Server/web `experimental.importDurations` uses `failOnDanger: false` and
   `print: "on-warn"`: slow imports remain visible, including danger imports.
2. `tools/vitest/budgetReporter.mjs` prints individual file-import and test
   exceedances, whole-suite total exceedances and the ten slowest files.
   Thresholds remain in `server/test/perf-budget.json` and
   `apps/web/src/test/perf-budget.json`. Totals are per-file sums, not wall clock;
   partial runs do not check totals. Exceedances produce warnings without changing
   the exit status. Invalid configuration or reporter errors still fail.
3. Reader browser timings and test-only elapsed-time checks warn on threshold
   exceedance. Reader memory/DOM checks, query-count invariants, and assertions
   that production safety deadlines reject/abort still fail normally.
4. `testHygiene.test.ts` still enforces fixture/runtime hygiene, including
   real-time sleeps and bare `userEvent.setup()`, with per-file exemptions.

### Execution deadlines are not completed performance measurements

All eight packages set `testTimeout: 0` and `hookTimeout: 0`. The four
explicit server browser configs inherit those values. Per-test/hook runtime
arguments and the baseline-schema override have been removed; the Node browser
case's explicit whole-test runtime limit is removed too. No test is failed merely
for taking longer than a runtime budget.

The existing reporter also uses Vitest's `onTestCaseResult` and
`onTestModuleEnd` hooks to warn when a test or a file's tests and hooks took more
than 5s. Packages without committed aggregate budgets use this same reporter for
these warnings only. Server/web retain their existing end-of-run budgets.
Worker events can be buffered, so warnings use Vitest's completed measurements
rather than promising an exact mid-test alarm. No custom timers, runner or
supervisor are added. An unfinished test/hook cannot produce its completed
measurement warning; lack of a warning is not evidence of completion.

Testing Library's 15s DOM waits, Playwright observations, `expect.poll`,
`vi.waitFor` / `vi.waitUntil` and fixture waits for an expected state retain their
assertion timeouts: an observation that never appears is a real unmet condition.
Production API, network, DB and execution safety deadlines are unchanged.

CI retains its existing outer job deadlines (verify: 45 minutes). Local commands
have no uniform outer supervisor: with `testTimeout: 0`, a stuck test or hook can
hang indefinitely. Use the terminal tool's existing session cancellation or
Ctrl-C to stop it; do not add an inner hard failure to compensate. Report a
cancelled run as **incomplete**, separately from assertion failures and completed
passes. The reporter labels a runner-reported interruption incomplete; abrupt
process termination may prevent any final reporter output. Inspect the terminal
exit/signal and unfinished work, never interpret absent errors or partial passed
cases as a passing run. No catch may turn cancellation into success.

The reporter cancellation fixture uses a separate POSIX process group and
terminates its remaining forks after the intentional coordinator cancellation.
Its Linux regression checks that the reported worker is no longer live. This
covers that fixture, not arbitrary descendant cleanup after an operator kills a
whole suite. Windows retains the existing coordinator-only cancellation check.
The private deep-reading recovery case observes its rerun's durable terminal
status while waiting for a prompt. A failed/cancelled/orphaned Run fails that
business assertion and reaches existing worker teardown; it cannot hold the
fixture forever waiting for a prompt that will never arrive. This uses the
existing state-observation helper, not a whole-test runtime deadline.

Reporter regression checks: `node --test tools/vitest/budgetReporter.test.mjs`
from the repository root (requires the server's installed Vitest dependency).
They exercise budget/import warnings and a failing assertion in real Vitest
subprocesses, plus deterministic threshold details and browser timing warnings. They also load
all eight package configs and four server browser configs to protect unlimited
test/hook runtime and budget reporter registration.

Wall clock has two floors: total work divided by workers, and the slowest
single file, whose tests run one after another. The server config caps workers
at 16 (CI's smaller runners keep Vitest's default): past that, every worker
contends for one PostgreSQL container and the forked worker processes, per-file
time more than doubles and the run gets slower, not faster. A file that becomes
the long pole is split rather than tolerated: its body moves unchanged into
`<name>.suite.ts` as `define…Suite(filename, partition)`, and `<name>.1.test.ts`
… `<name>.N.test.ts` each register one part with
`partitionTests(i, N)` (`test/support/testPartition.ts`) against their own
database. Tests are dealt round-robin in registration order; a `describe` too
small to appear in every part is routed to explicit parts. Run all parts by the
shared prefix (`vitest run test/roomsDb`). A suite file must not `vi.mock`, since
the config decides isolation from the entry files.

## Product Rules Tests Protect

- `/api/v1/proposals` is the only product API for proposal review and
  application; acceptance is explicit, proposals are never auto-applied.
- Runs stay auditable through durable state and activity/output records;
  `output_text` alone never creates a proposal; structured output creates
  artifacts and proposals only through current materialization rules.
- Auth required; cross-space denied as 404, not 403; same-space private content
  denied to non-owners as 404; owner allowed.
- A failed mutation leaves the database unchanged; a failed consolidation
  creates no proposals.
- Secrets never appear in API responses; path traversal is blocked.
- Intentional cross-space exceptions are preserved: personal memory egress
  approval, `/me` routes, personal-memory-grants; targeted publications remain
  snapshot-only transfer.

Name security tests after the invariant they protect, e.g.
`it("hides private task subresources from non-owners")` or
`it("returns 404 for a run in another space")` — never after the bug's history
(`"gap S1 fixed"`, `"regression after audit"`).

## Flake Attribution

Failures rotating across files may indicate contention; this alone does not
rule out a regression. Re-run only the failing file first. If baseline comparison
is needed, use an isolated checkout and preserve the current uncommitted work;
do not automatically stash or reset it. A file that passes alone but times out
under full fan-out needs concurrency and timing investigation before attribution.
Four patterns have produced such flakes here: assuming the order in which
concurrent fakes are reached; attaching a
rejection handler one event-loop turn after the commit that triggers the
rejection (Vitest 4 counts that as an unhandled error); querying a
server-wide catalog view such as `pg_locks` or `pg_stat_activity` without
limiting it to the file's own database, which reaches into other files sharing
the container; and acting on a web page after its first render but before its
start-up loads have run, which a later reset then undoes — wait for the request
or the loaded element, not only for the first visible text.

Every real-Postgres file clones the migrated baseline. Do not load a
hand-written subset schema: a test that seeds rows the real constraints
refuse must fail for a real reason. Request `{ empty: true }` only to test the
migration runner or a plugin's own migrations.

Sources execution foundation separates deterministic transport/contract tests,
real-PG account/endpoint admission and HTTP-fixture tests, and an explicit OS
smoke (`SOURCE_EXECUTION_OS_SMOKE=1`) in the Host package. The latter is skipped
in the canonical suite and requires bubblewrap plus user-systemd or delegated cgroup v2; only an explicit successful smoke verifies namespace/resource behavior.
Reproduction commands are in COMMANDS. Engine benchmark/queue-restart fixtures
run in temporary directories through `tools/source-engine`, not a second
scheduler, test database or product data path.

Dual-review Sources regressions additionally use the actual serial Host adapter
with real HTTP and two separate daemon worker processes. The checkpoint is
outside the code namespace; this is distinct from the framework-only benchmark.
`tools/source-engine/direct-smoke.mjs` tests a delegated private cgroup subtree
while making the user bus unavailable. Default tests never depend on that OS
infrastructure. Broker-to-registry cancellation and cached-output reauthorization
use real-PG fixtures around the transport boundary.

## Workspace dependency preparation

Server and Host daemon `verify` prepare their dependencies once, then invoke
TypeScript and Vitest directly. Independent `typecheck` / `test` retain their
preparation hooks. The five dependency libraries keep their existing build
scripts and use TypeScript's incremental `-p` compilation, with metadata under
`dist/.tsbuildinfo`; CI's explicit builds populate the same metadata. A warm
preparation invokes compilers for content validation but emits no unchanged
outputs. This is not a promise of zero compiler processes.

`tools/typescript/prepareIncremental.mjs` handles two gaps in compiler metadata:
a changed lock hash, and a missing expected JS/declaration output, discard only
that library's build info. `tsc -p` then checks source and compiler options by
content, including new files and edits with preserved mtimes. Do not replace it
with an mtime-only `tsc -b` up-to-date check: it can miss deleted outputs. The
helper is confined to the five libraries' existing `src/**/*.ts` → `dist`
layout; new output kinds require extending the owning build deliberately.

Reuse / Dependency Check: reuses the existing package build/preparation hooks,
pnpm dependency selection and installed TypeScript incremental compiler. The
compiler owns source/config invalidation; the small prebuild repair checks lock
identity and missing outputs only. No custom source cache, build graph or runner
is introduced.

Compiler-preparation regression: `node --test tools/typescript/prepareIncremental.test.mjs`
uses temporary libraries to verify warm no-emit, preserved-mtime source/config
and lock changes, new source files and missing JS/declaration repair.
