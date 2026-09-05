# Testing Strategy

How the test suites are organized, what they protect, and the rules that keep
them fast. Commands are in [`../COMMANDS.md`](../COMMANDS.md).

## Scope

Five Vitest suites, one per package, each run from its package root:

| Package | Tests | Notes |
|---|---|---|
| `server/` | `test/**/*.test.ts` | Real PostgreSQL for anything durable; shared helpers in `test/support/` |
| `packages/protocol/` | `test/**/*.test.ts` | Schema parsing and frozen registry fixtures |
| `packages/host-daemon/` | `test/**/*.test.ts` | Pure node |
| `packages/agent-cli/` | `test/**/*.test.ts` | Spawns the command as a real child process against a stub control plane |
| `apps/web/` | `src/**/*.test.{ts,tsx}` | jsdom by default; pure-logic files opt out |

Tests are unit-style (deterministic rules, parsers, state transitions, no
database or network), route-style (status codes, response shapes, validation,
side effects across a public boundary), or workflow-style (a multi-step product
flow asserted on its durable result and audit trail). Pick by what the test
protects, not by which file it happens to exercise.

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
`afterAll`; tests start with `if (!db.available) return;`. Do not start a
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
`wal_level=minimal`, a one-hour checkpoint horizon, and the PostgreSQL 18 tmpfs
mount at `/var/lib/postgresql`. Local runs reuse the container and its migrated
template across invocations; `TESTCONTAINERS_REUSE_ENABLE=false` disables reuse
and tears down on exit. Per-file databases are always recreated, and setup
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

**Two server projects, split by `vi.mock`.** Module evaluation is the largest
cost of the server suite: every file that imports a service pulls in most of
the module graph (~1.3s). `server/vitest.config.ts` therefore runs files
without `vi.mock()` in a `shared` project with `isolate: false` — one module
graph per worker, evaluated once — and files that `vi.mock()` in an `isolated`
project, because a mock stays registered for every file that follows in its
worker. Membership is computed from the file contents; the hygiene test
freezes the isolated list so it only shrinks.

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
first line; `src/test/setup.ts` installs its DOM shims and per-test cleanup only
where a DOM exists. `asyncUtilTimeout` is 15s there because `findBy*` used to
give up while a lazy chunk was still transforming under load.

Two Vitest 4 behaviors to write for: a `vi.fn()` used as a class needs a
`function` implementation (arrow functions are not constructible), and
`vi.spyOn` on an already-spied method reuses that spy with its call log, so
files that spy on the same method in several tests restore mocks in
`afterEach`.

## Time Budgets Are Enforced

The suites blew up twice without anyone writing a slow test: the cost of old,
reasonable tests grew with the schema (`TRUNCATE ... CASCADE` across 300 tables)
and with the module graph (building the whole server to test one module). Rules
cannot catch a cost that appears retroactively, so every run is measured and
fails on a doubling:

1. Vitest's `experimental.importDurations` with `failOnDanger` fails a run when
   any one import exceeds the danger threshold.
2. `tools/vitest/budgetReporter.mjs` fails a run when a file's import time or a
   test's duration exceeds the package budget, or when the suite's total import
   or test time exceeds the committed baseline by more than the tolerance.
   Budgets: `server/test/perf-budget.json`, `apps/web/src/test/perf-budget.json`.
   Totals are per-file sums, not wall clock, but still swing with machine load,
   so the tolerance is 2x: the gate catches doublings and the ten slowest files
   it prints every run make drift visible. Raising a limit is an edit to the
   budget file, reviewed with the change that needed it.
3. `testHygiene.test.ts` in each suite fails on the patterns behind past
   blow-ups (the rules in the two sections above, plus real-time sleeps and
   bare `userEvent.setup()`), with exemptions listed per file.

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
Two patterns have produced such flakes here: assuming the order in which
concurrent fakes are reached, and attaching a
rejection handler one event-loop turn after the commit that triggers the
rejection (Vitest 4 counts that as an unhandled error).

There are no hand-written subset schemas any more: every real-Postgres file
clones the migrated baseline, so a test that seeds rows the real constraints
refuse fails for a real reason. Request `{ empty: true }` only to test the
migration runner or a plugin's own migrations.
