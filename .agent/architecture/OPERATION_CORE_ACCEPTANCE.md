# Operation core acceptance (Plan 1)

Status: Plan 1 is complete within the scope and exclusions below. All four
stages and the overall code/final documentation passed Claude/Antigravity dual
review. Reviewed scope is `3e3af010` through `c3156a48` plus this documentation-only
correction. Review approval is not evidence that reviewers ran these tests.
This is permanent acceptance evidence, not authorization to deploy or a claim
that the whole Operation Core Program is complete. Stage 1: `95d61d90`; stage 2:
`466f88ef`; stage 3: `2edce778`; stage 4: `c3156a48`. The accepted constraints remain
[ADR 0028](../decisions/0028-operation-execution-core.md) and its
[execution contract](OPERATION_EXECUTION_CONTRACT.md).

## Executable matrix

Run from `server/` with Node 24 and `REQUIRE_TEST_POSTGRES=true`. Use the shared
`useTestDatabase` fixture, never product connections or another test container.
`pnpm exec vitest run test/operationFaultsDb.test.ts test/operationExecutorDb.test.ts`
runs the new core fault/transaction cases. `buildServerDist` rebuilds actual
server artifacts once per test run with the existing shared build lock.

| Promise | Permanent executable evidence | Scope/result |
|---|---|---|
| Actor identity, current grants, isolation | operationExecutorDb: same Agent/key with different instructing persons; revoked success replay; operationContracts immediate seven-origin mapping; runLineageDb root, delegation/continuation verification; projectResearchOperationCancelDb old grants and current authority | No identity substitution or new grants. Production cancellation is Run-bound; separate Runs/audiences have separate scopes. No generic Room-content operation has been enabled. |
| Same key, conflicting input, version change, redaction | operationExecutorDb: version advances then successful replay, concurrent 409, changed input/unsupported version, redacted receipt 410 | No durable executing row or repeat effect; archived/missing results never substitute for current authority. |
| Transaction/mandatory audit/output/Job | operationExecutorDb invalid output, audit trigger refusal, required Job failure, business savepoint, pool/COMMIT/ABORT escapes, actual note writer savepoints | Real PostgreSQL rollback, not mocked SQL. Required Jobs commit with the cancellation state. |
| Process dies before COMMIT | operationFaultsDb: pause actual Job INSERT in PG, observe backend, SIGKILL HTTP server, observe connection exit/rollback, retry same key | Status/version, Job, decision and request roll back. No in-progress tombstone. A dead process cannot append a post-rollback audit; the retry is a new audited admission. |
| Connection dies before COMMIT | operationFaultsDb: pg_terminate_backend during real enqueue | Typed retryable 503, server survives, no partial status/request; retry commits once. Checked-out Client error events cannot crash the process; query failures still propagate. |
| COMMIT succeeds but response disappears | operationFaultsDb: hold actual onSend after commit then SIGKILL; PG TCP relay withholds actual CommandComplete(COMMIT) from pg then either kills the server process or drops only the PG connection while the server survives | Retry resolves the durable key. No second Job/write, failed state, or duplicate failure audit. The relay passes real authentication/SQL bytes, not a fake database. |
| Worker discovery/recovery | operationFaultsDb: committed pending Job, actual startJobsWorker loop/registry/queue and cancellation handler; SIGKILL worker after effect before settlement, reclaimStuckJobs, new process claims/completes | Screening batch effect happens once; retry reports zero repeated effects, job attempt 2 completes. The canonical stale-claim sweep uses an explicit test clock/threshold; production timing is unchanged. Existing projectResearchOperationCancelJobDb covers Runs, backfills, checkpoints and Workflow executions. No new worker/scheduler is implemented. |
| HTTP and Host file bridge keys/response loss | operationFaultsDb: actual built CLI, actual Run tool HTTP route/token, actual localToolBridge/toolHttp; kill server or Host bridge after commit before response; restart and reuse explicit key | One Job/request and original flat Agent receipt; expired token rejects even a replay. Agent-cli localBridge/rainverCli cover no automatic write retry, new correlation ids, old-Host explicit-key refusal and bounded input. |
| Canonical approval, races, failures | operationExecutorDb: actual PgProposalApplyService/registry/hook integration; accept vs accept/reject try-lock, accepted retry, reject, expiry vs cleanup reservation, precondition/mapping/version drift, missing mapping/revoked authority, accepted-without-result inconsistency, output/audit failure and independent denial recovery | Test registrations only. Business/result/Proposal/audit share one transaction. Direct supersession fixture uses the same key→Proposal→request reservation and same-transaction reconcile; rollback keeps both pending. |
| Query readonly, policy, Source/audience, B11 | operationExecutorDb readonly write refusal; independent policy denial; Source canonical egress gate withdrawal, visibility narrowing, required B11 failure and same-owner exclusion; two concurrent queries with every slot of a two-connection data pool held | No business/progress mutation or unchecked content release. Host-only audit capacity is independent of the data pool. Only production query is metadata catalog; content tests are controlled registrations. |
| Existing errors/consumer compatibility | projectResearchOperationCancelDb REST↔generic omitted-project normalization, 409/422/404, receipts and Job rollback; agentIdDiscoveryReadsDb real Agent discovery with grant/Project/private/Space controls; operationRoutes exact inventory | Old URL/flat success receipt and Agent lifecycle retained. REST writer preflight keeps 403; policy denial inside core uses hidden 404 (documented compatibility exception). |
| Old/new server/schema | operationFaultsDb compiles actual pre-core `95d61d90` source and serves its real REST route against the additive migrated fixture, interleaving old/new calls and Job effects | Requires reachable Git history (CI fetch-depth 0); missing basis fails, never silently skips. Uses installed workspace dependencies, not an old deployment image/old dependency lock. No product migration/rollback was performed. |
| Legacy invalid material attempts | sourceGoalsDb selected `corrects invalid schema`, `existing links use the same granted material`, `collect grants only`; full existing suite | Legacy invalidInputExecutor remains authoritative for its bounded attempts/failed records. New core schema rejection runs no domain executor. |
| Retention/inconsistency | operationExecutorDb seven-day terminal retention, actionable pending preservation, expiry, missing Proposal evidence, redaction, independent terminal/pending/anomaly budgets | Corrupt pending evidence remains visible to scheduler health and cannot starve terminal cleanup. |

## Space equivalence, not a cross-Space existence oracle

Cancellation missing-id discovery checks existence only in the actor's Space.
An existing UUID in another Space and a random absent UUID produce the same
status, code and current-Project hint (apart from the caller's echoed target and
request correlation id). `agentIdDiscoveryReadsDb` checks this equivalence using
real rows in two Spaces. It returns only the current Run Project's canonical
visible active list, after current grant/Project authority checks. Existing
in-Space other-Project/private targets get no hint. No other-Space row is read.

## Approval enablement boundary: eight legacy writer families

The cancellation pilot has no approval gate; no actual approval-bearing business
operation is necessary to this pilot. The core's production registry contains
only `system.actions.list` and `research.cancel_acquisition`; neither has an
approval mapping. The dynamic production test attempts every legacy registry
entry with a Proposal type and proves generic writes fail closed (404).
Canonical engine fixture acceptance is not production family enablement.

| Legacy owner | Current production condition / later obligation |
|---|---|
| proposals/applyService.ts | Canonical optional hooks exist; dependent Source supersession/multi-key cascades are not enabled core mappings. |
| projects/projectDefinitionProposalService.ts | Direct replacement/supersession remains legacy. |
| projects/monitoring/service.ts | Monitoring Proposal replacement remains legacy. |
| memory/proposalRepository.ts | Frozen payload writers remain legacy; memory authority/applier gates unchanged. |
| plans/repository.ts | Review lifecycle remains legacy. |
| runs/repository.ts | Run Proposal lifecycle remains legacy. |
| importedSessions/extraction.ts | Extraction payload updates remain legacy. |
| skills/proposalApplier.ts | Skill transitions remain legacy. |

Before any affected production mapping is enabled, migrate its complete writer/
effect closure with the same key order and same-transaction request transitions.
No internal assertion, this document, or test-only mapping permits bypassing that
work. Broader family migration remains program Plan 5, not a hidden Plan 1 scope
reduction or claim that all existing writes now pass through the new core.

## Review, skips and retirement

The core fault tests require real PG and child processes; they have no fake-DB
fallback and no conditional skip when REQUIRE_TEST_POSTGRES=true. Existing OS/
provider smoke skips in the full suites remain separate environmental acceptance,
not counted as passes. Native cgroup/Host provider termination is exercised by
its owning existing smoke path, not manufactured by the operation tests.

Live rollout, product-data migrations, full old release images/dependency-lock
combinations, multi-node deployment and production rollback remain unperformed
and unauthorized. The historical source test establishes local additive-schema
compatibility; it does not claim deployed mixed-version safety for every module.

The implemented Plan 1 temporary ledger body is retired. Its normative contract moved
to [OPERATION_EXECUTION_CONTRACT](OPERATION_EXECUTION_CONTRACT.md); this matrix
and owning guides retain implementation/evidence and exclusions. Program plans
00/02–06 remain uncompleted and retain their links. The former ledger/contract
paths contain only retirement/move pointers because protected historical reports
and the unrelated worktree plan still link there; those files were not rewritten.
The implementation task list itself was removed, not retained as a second plan.
Overall review of `3e3af010` through `c3156a48` found no implementation/code
blockers in either review. Claude required correction of stale current-state
documentation; that documentation-only correction subsequently passed both
reviewers. Plan 1 is complete within this matrix's scope; Plans 00/02–06 remain
uncompleted. Review approval does not imply new test execution or deployment.

The optional-Postgres contract is implemented by `useTestDatabase` itself:
its registered beforeEach calls `context.skip()` when unavailable, rather than
returning from test bodies and falsely counting passes. operationFaultsDb's own
beforeAll/beforeEach guard their setup and afterAll guards its temporary home;
afterEach has an empty child list when skipped. REQUIRE_TEST_POSTGRES=true fails
in global setup before those tests. Do not add per-test early returns to bypass
this shared skip/failure contract.
The unavailable-runtime probe used an intentionally nonexistent Docker socket:
REQUIRE_TEST_POSTGRES=false reported nine skipped tests and zero passed tests;
REQUIRE_TEST_POSTGRES=true exited 1 from setupOfficialPlugins global setup.
The strict positive suite uses the real shared PG separately. No body-level
return was added and no fake database fallback was introduced.


## Recorded local verification, 2026-11-05

On stage-3 HEAD `2edce778` with this uncommitted stage-4 implementation:
`REQUIRE_TEST_POSTGRES=true pnpm exec vitest run --maxWorkers=8` passed
548 files / 6311 tests; one file and five tests were conditionally skipped.
The five are four `SOURCE_GOAL_OS_SMOKE=1` opt-ins in sourceGoalsDb.1 and one
`SOURCE_GOAL_AGENT_SMOKE=1` opt-in. They are not PostgreSQL-unavailable skips and
are not counted as passes. No test/performance threshold was raised.
All nine operationFaultsDb process/socket/worker/CLI cases passed without skip.
CLI full suite: 49; protocol full suite: 363; related typechecks, server build,
guide/link, boundary, SQL and test-hygiene checks passed. The lockfile is unchanged
from the historical pre-core basis; the test still makes no deployed-image claim.
Stage 4 passed stage-specific dual review. The temporary ledger is retired;
overall code and final documentation have since passed both reviewers. The
numbers above record pre-commit implementation verification, not tests run by
reviewers or a deployment result.
