# Testing Strategy

Date: 2026-06-17

This document defines the current backend testing architecture. The suite is organized by product confidence layer, not by implementation package.

## Test Layers

Canonical backend tests live under:

```text
server/test/
packages/protocol/test/
```

Server unit-style tests contain deterministic rule and boundary checks. Use them for policy decisions, path decisions, state transitions, parser behavior, serialization contracts, and small pure functions. Unit tests must not require the database, network, real runtime execution, or real provider calls.

Route and integration tests contain public boundary checks. Use them for API response shapes, status codes, request validation, adapter/provider protocol contracts, schema checks, storage/path contracts, and observable side effects across a public boundary.

Invariant-style tests contain cross-cutting product rules that must hold even when internals change. Use them for space isolation, approval gates, run auditability, artifact path boundaries, terminal run state, Project Folder path enforcement, memory mutation boundaries, proposal application boundaries, and runtime/provider separation.

Workflow-style tests contain multi-step product flows from request to durable result. Use them for activity-to-memory, run execution, run output materialization, produced artifact paths, proposal approval, home summary behavior, Project Folder code proposal flows, and runtime failure handling. Workflow tests assert final observable state and audit trail.

Test support files contain shared factories, fixtures, fake runtimes, fake providers, and assertion helpers. Support code should make valid product states easy to create and invalid states explicit at the call site.

## What To Test

Protect product behavior:

- API contracts and public response shapes.
- Durable database state.
- Artifacts, proposals, activity records, memories, runs, and audit records.
- Authorization, space isolation, Project Folder path boundaries, and proposal gates.
- Runtime failure behavior and absence of partial side effects.
- Run output materialization from structured runtime output.

Assert observable outcomes. A useful test should still be meaningful if the implementation moves behind the same public behavior.

## What Not To Test

Do not add tests for:

- Removed routes.
- Retired API surfaces.
- Private service call chains.
- Mock call order.
- Coverage-only execution with no product assertion.
- Implementation-specific module boundaries.
- Vendor internals behind runtime/provider adapters.
- CSS classes or frontend styling details in backend tests.

## Fixtures And Factories

Factories must create valid minimal objects by default. Required ownership fields such as `space_id`, `created_by_user_id`, `project_folder_id`, and related actor IDs should be visible at call sites when the rule under test depends on them.

Rules:

- Prefer real database rows over deep mocks for contracts, invariants, and workflows.
- Keep invalid states explicit in the test body or factory name.
- Do not hide durable mutations behind generic factory names.
- Do not create proposals, memories, artifacts, or approval events as side effects unless the factory name states that behavior.
- Keep cross-space and cross-user variants easy to create.
- Assertion helpers must inspect observable state and must not create data silently.

## Fake Runtime And Provider Rules

Runtime and provider execution are external boundaries. Tests should use deterministic fakes instead of live providers, CLIs, or sandboxes unless a specifically named external integration check is being run outside the canonical suite.

Rules:

- Fake runtimes return deterministic `output_text`, `output_json`, errors, and `produced_artifact_paths`.
- Fake providers return deterministic model responses and structured failures.
- Invariant and workflow tests may mock runtime/provider execution, but should use real services and database state around that boundary.
- Runtime adapter behavior and model provider behavior must remain separate in tests and production code.

## API And TestClient Commit Rules

`TestClient` requests run through the application boundary and must see committed setup state.

Rules:

- Commit database rows before issuing a `TestClient` request that depends on them.
- Commit factory-created setup rows when the API request must load them through a new request/session path.
- After the request, refresh or re-query rows before asserting changed durable state.
- Do not rely on uncommitted ORM identity-map state for API contract assertions.
- Rollback-only setup is acceptable only for tests that never cross the API boundary.

## Shared PostgreSQL Test Infrastructure

Real-PostgreSQL server tests share one `pgvector/pgvector:pg18` Testcontainers
instance per Vitest project. Global setup applies the committed server baseline
once to a template database. Each test file receives its own database cloned
from that template, so files remain isolated while avoiding one container and
one migration run per file.

Tests that specifically exercise the migration runner, plugin migrations, or a
hand-authored minimal schema must request an empty database from the shared
helper. Test files still own and close their `Pool`; calling the helper handle's
`stop()` drops only that file's database, not the shared container.

The shared container is test-only and uses tmpfs plus `fsync=off`,
`synchronous_commit=off`, and `full_page_writes=off`. PostgreSQL 18 requires the
tmpfs mount at `/var/lib/postgresql`, not the pre-18
`/var/lib/postgresql/data` path.

Local runs reuse the container across Vitest invocations. Set
`TESTCONTAINERS_REUSE_ENABLE=false` to disable reuse (for example in a CI job
that requires teardown); global teardown then stops the container. Reuse never
reuses per-file databases or the migrated template: those are recreated for
each Vitest run.

### No Fake Database For Durable Behavior

Tests that claim a database-backed product behavior must run against the
shared real PostgreSQL infrastructure. Reuse an existing domain test file
and call `getTestPostgres(__filename)` from
`server/test/support/sharedPostgres.ts`; do not start a second Testcontainers
instance, create an ad-hoc database, or replace the database with a fake
`Queryable`.

This applies to contracts, invariants, workflows, plans, run dispatch and
budget enforcement, routing persistence, verification persistence, and any
assertion about durable state or transaction behavior. If the shared
PostgreSQL fixture is unavailable, the test must use the repository's
established skip path and report the unavailable runtime. It must never fall
back to a fake database, because that can validate SQL shape while missing
constraints, transactions, locks, JSON queries, triggers, and cross-table
invariants.

The unavailable-runtime path is limited to an explicitly unavailable shared
container or a PostgreSQL connection error. Migration, schema, seed, service
construction, and other setup errors must be rethrown so they fail the suite;
they must never be converted into `available = false`.

Database fakes are allowed only for narrowly scoped, database-free unit tests
whose stated purpose is SQL/parameter shape or a pure adapter boundary. Such
tests must not be used to prove product behavior or to duplicate coverage
that belongs in a real-PostgreSQL workflow test.

## Proposal And Run Rules

- `/api/v1/proposals` is the only product API for proposal review and application.
- Proposal acceptance is explicit; proposals are never auto-applied.
- Runs must remain auditable through durable state and activity/output records.
- `output_text` alone does not create a proposal.
- Structured run output may create artifacts and proposals only through current materialization rules.

## Security Boundary Test Naming

Security boundary tests should be named after the **product invariant they protect**, not
after the history of how a bug was found or fixed.

**Good names:**
- `test_session_messages_require_authenticated_owner`
- `test_private_task_subresources_are_hidden_from_non_owner`
- `test_activity_consolidation_requires_visible_activity`
- `test_capability_reload_requires_authentication`
- `test_cross_space_run_returns_404`

**Avoid:**
- `test_gap_s1_fixed`
- `test_previous_bug_regression`
- `test_foundation_patch`
- `test_post_audit_case`
- `test_cross_space_bug_123`
- `test_high_gap_verification`

Tests should protect these durable behaviors:

- auth required
- cross-space denied (404, not 403)
- same-space private denied for non-owner and ungranted selected-user content denied (404)
- owner allowed
- failed mutation leaves DB unchanged
- failed consolidation creates no proposals
- secrets not exposed in API responses
- path traversal blocked
- intentional cross-space exceptions preserved (personal memory egress approval, `/me`
  routes, personal-memory-grants); targeted publications remain snapshot-only transfer

## Canonical Command

Use the server and protocol suites from their package roots:

```bash
cd server
npx tsc --noEmit
npx vitest run

cd ../packages/protocol
npx vitest run
```

Do not point tests at a real mode data tree. Integration tests that need
Postgres must use explicit test fixtures or the Docker-native ops helpers,
never a live dev/prod instance directory.

## Flake Attribution

A rotating handful of failures across different files each run is a contention
signal, not a regression. Diagnose it by re-running the failing file alone and
by stashing the change: a file that fails at 30s under full fan-out and passes
in under a second by itself is not testing what its failure claims.

The web suite carries two settings for this, each with its reason in the file:
`apps/web/vitest.config.ts` caps the pool at 6 workers rather than starting a
jsdom environment on every core, and `apps/web/src/test/setup.ts` sets
testing-library's `asyncUtilTimeout` to 15s because the real cause was
`findBy*` giving up while a lazy chunk was still transforming, not vitest's own
test timeout. Do not lower either to "speed the suite up" without re-running
the full suite several times — the first attempt at this raised the wrong
timeout and did not settle it.

Hand-written subset schemas under `server/test/fixtures/*.sql` are a known
drift source: they are copies of the real schema and nothing regenerates them,
so a column renamed in `server/migrations/0001_baseline.sql` stays stale there
until a test happens to touch it. Grep them when a schema change renames or
drops a column.
