# Operation core acceptance (Plan 1)

Status: Plan 1 is complete within the scope and exclusions below. All four
stages and the overall code/final documentation passed Claude/Antigravity dual
review. Reviewed scope is `3e3af010` through `c3156a48` plus this documentation-only
correction. Review approval is not evidence that reviewers ran these tests.
This permanent record covers the reviewed Plan 1 candidate. Stage 1: `95d61d90`; stage 2:
`466f88ef`; stage 3: `2edce778`; stage 4: `c3156a48`. The accepted constraints remain
[ADR 0028](../decisions/0028-operation-execution-core.md) and its
[execution contract](OPERATION_EXECUTION_CONTRACT.md).

## Program closeout

The Operation Core implementation program is complete within its accepted
scope. The execution contract and System Actions guide own P1. The
[plugin platform contract and acceptance](OFFICIAL_OPTIONAL_MODULES.md#operation-platform-acceptance)
owns P2, including the later invocation-role correction. P0 and P4 are
documented in [ADR 0031](../decisions/0031-runtime-database-roles.md) and
[ADR 0030](../decisions/0030-plugin-agent-data-access.md). Instance activation
and unsupported sensitive-read paths remain in the
[deferred register](../tasks/deferred-register.md). P5 and P7 closeout evidence
is below. Applications product follow-ups and conditional plugin platform
extensions have independent plans.

## P5 closeout

As of 2026-11-14, P5 is complete within its core-module migration scope.
Original delivery remains **23 / 41 / 26 = 90**; Activity upload adds one
separate correction and the account/daemon workspace follow-up adds four.
Verified dev landings are `8283ccece4ee0203ea16053414548c9fee30454a`
and `b09de48bc2649f0426fd3439d2f1ff52ca9e5ac0`. These are implementation
landings, not a deployment claim. This section supersedes older P5 candidate,
private-only and open-gate snapshots below without rewriting their evidence.

| Completion condition | Final evidence / disposition |
|---|---|
| No P5 legacy writes | Actual inventory: 630 = 575 core + 15 P4 legacy + 40 exempt. The remaining entries are Diary (2) and Finance (13); P4 is excluded. |
| Whole-batch independent review | Earlier 23/41 batches retained their accepted reviews; full third-26 Claude/Antigravity review followed by targeted repair reviews closed ContextOps closure capacity/sealed-plan issues and upload terminal input retention. Final four-entry correction also passed independent Claude/Antigravity static reviews, P1/P2 zero. Reviewers did not independently rerun implementation tests. |
| Exemption owner review | Remaining 40 = auth21 + pending conversation media2 + Host10 + subscription credential input1 + Run tool transport1 + internal5. Auth/credential channels own secret/session lifecycles; media is pending/unclaimed staging only; interactive relays do not retain replayable secrets. Host outputs use attempt-bound transactional ownership and deduplication. Run tool transport delegates to the admitted action owner. Policy is the decision/audit owner; internal Run execution uses existing Run authority/execution locks; deployment callbacks consume already admitted Jobs with event deduplication. These are protocol-owner exemptions, not claims of zero persistence. Admin enable/disable and daemon workspace create/remove were removed from exemption. |
| Stateful GET review | Saved-item processing and Source Goal GET no longer cancel/settle/reconcile or persist cleanup. Existing Run finalizer, scheduler and retention owners retain those duties. Folder/Run file release and live credential streams retain their explicit access/audit or authentication lifecycle boundaries, not a pure-query claim. |
| Executable evidence | Prior family evidence remains attributed to its recorded candidates. Final four-entry prepared landing: Node24 protocol/server/daemon/web typechecks, five workspace dependency builds, server routes19/contracts16/guides8/hygiene12, mandatory real-PG17, protocol2/daemon3/web2 passed. Earlier sandbox PG skips and setup failures are not passes; the mandatory shared-test-PG rerun passed. |
| Canonical boundaries | Memory canonical applier/provenance, frozen production linked mappings, current-authority replay, mandatory atomic audit/receipt/domain effects and existing Job/Run effect ownership remain; no P4/schema migration or second execution engine is implied. |

**Explicit scope limits accepted for P5 closeout:** focused affected checks are
the plan's acceptance method; full server/web, 18-browser, stress/fault-process,
live provider/Host and production deployment acceptance were not rerun or
claimed. They are not hidden passing checks or newly imposed P5 blockers.
Upload normal terminal/cancel/reclaim paths clear private input. If the database
is unavailable or a process dies before trustworthy cleanup/terminal state,
private bytes or an unreachable file can remain; uncertain ownership is never
resolved by blind deletion or resend. This documented conservative residue is
accepted for this bounded migration; no scavenger or backup-history rewrite is
part of P5. Further lifecycle work requires its own scope. P5 completion does
not authorize deployment or assert all forty protocol implementations are free
of every possible defect.

## P7 closeout

Diary and Finance shipped as operation-manifest packages with existing pages
wired to scoped Web operations. Their legacy routes and descriptors were
removed. The packages retain their ids and existing enablement scopes.
Diary is user-scoped, with human save/delete and Agent append through a reviewed
Proposal. Finance is Space-scoped, with owner filtering and separate import
and posting operations. See the [package contracts](OFFICIAL_OPTIONAL_MODULES.md#diary-package).

The migration landed on dev at `aeb85954` and was included in master at
`1af12fd38`. The unused legacy table copy was removed at `d1591b6d`; the
installer creates the package schema and retains existing migration journals.
The read-only inspection of `rainver-test` found the new schemas and no old
Diary or Finance public tables. The page redesign remains deferred.

The P7 landing passed 303 targeted server and 67 Web tests, Server and Web
typechecks, and the Web build. The legacy copy removal passed 131 targeted
server checks. Finance's test schema cleanup passed 78 targeted checks.
These are repository checks and do not establish production deployment.

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
| Host WebSocket, local bridge keys and response loss | runToolSurfaceRoutesDb drives the real CLI through an authenticated Host socket with real PostgreSQL. operationFaultsDb kills the local bridge after commit before response, then retries with the same explicit key. | One Job and the original Agent receipt. Expired identities reject a replay. The daemon settles disconnected requests without resending them. |
| Canonical approval, races, failures | operationExecutorDb: actual PgProposalApplyService/registry/hook integration; accept vs accept/reject try-lock, accepted retry, reject, expiry vs cleanup reservation, precondition/mapping/version drift, missing mapping/revoked authority, accepted-without-result inconsistency, output/audit failure and independent denial recovery | Test registrations only. Business/result/Proposal/audit share one transaction. Direct supersession fixture uses the same key→Proposal→request reservation and same-transaction reconcile; rollback keeps both pending. |
| Query readonly, policy, Source/audience, B11 | operationExecutorDb readonly write refusal; independent policy denial; Source canonical egress gate withdrawal, visibility narrowing, required B11 failure and same-owner exclusion; two concurrent queries with every slot of a two-connection data pool held | No business/progress mutation or unchecked content release. Host-only audit capacity is independent of the data pool. Production queries include the metadata catalog and Source backfill preview; content tests are controlled registrations. |
| Existing errors/consumer compatibility | projectResearchOperationCancelDb REST↔generic omitted-project normalization, 409/422/404, receipts and Job rollback; agentIdDiscoveryReadsDb real Agent discovery with grant/Project/private/Space controls; operationRoutes exact inventory | Old URL/flat success receipt and Agent lifecycle retained. REST writer preflight keeps 403; policy denial inside core uses hidden 404 (documented compatibility exception). |
| Old/new server/schema | operationFaultsDb compiles actual pre-core `95d61d90` source and serves its real REST route against the additive migrated fixture, interleaving old/new calls and Job effects | Requires reachable Git history (CI fetch-depth 0); missing basis fails, never silently skips. Compiles against protocol declarations from the same historical revision; external dependencies and runtime workspace packages remain installed versions, not an old deployment image/old dependency lock. No product migration/rollback was performed. |
| Legacy invalid material attempts | sourceGoalsDb selected `corrects invalid schema`, `existing links use the same granted material`, `collect grants only`; full existing suite | Legacy invalidInputExecutor remains authoritative for its bounded attempts/failed records. New core schema rejection runs no domain executor. |
| Retention/inconsistency | operationExecutorDb seven-day terminal retention, actionable pending preservation, expiry, missing Proposal evidence, redaction, independent terminal/pending/anomaly budgets | Corrupt pending evidence remains visible to scheduler health and cannot starve terminal cleanup. |

## Space equivalence, not a cross-Space existence oracle

Cancellation target resolution checks only the actor's Space. An existing UUID
in another Space and a random absent UUID produce the same Agent status, code
and fixed unavailable message (apart from request correlation ids), with no
target echo or inline list. `agentIdDiscoveryReadsDb` checks this equivalence,
private/foreign targets, explicit authorized discovery, and grant revocation
against real rows. Only explicit `research.list_operations` and
`inquiry.list_threads` reads return canonical visible objects, under current
Run/Project/content gates. Revoked Run action grants return 403; hidden objects
retain 404. No other-Space row is read.

## Approval enablement boundary: eight legacy writer families

The cancellation pilot has no approval gate; no actual approval-bearing business
operation is necessary to this pilot. The accepted Plan 1 baseline contained
`system.actions.list` and `research.cancel_acquisition`; neither has an approval
mapping. Later registrations, including the user-only collaboration participant
command, are documented in SYSTEM_ACTIONS. The dynamic production test attempts every legacy registry
entry with a Proposal type and proves generic writes fail closed (404).
Canonical engine fixture acceptance is not production family enablement.

| Legacy owner | Current production condition / later obligation |
|---|---|
| proposals/applyService.ts | DB decision/recursive Source cascade now joins sorted-key atomic transitions; advance-grant and external code-patch rollback refuse linked requests. External owners and proposal-type effect closure still block production mapping. |
| projects/projectDefinitionProposalService.ts | Direct replacement atomically supersedes linked requests; frozen Brief edits use the shared payload revision port. |
| projects/monitoring/service.ts | Scope/details replacement now atomically supersedes linked requests; public command/Source approval mapping remains disabled. |
| memory/proposalRepository.ts | Linked pending revision supersedes the old draft/request and returns a fresh review; active Memory remains canonical B10 only. |
| plans/repository.ts | Review supersession and Pool-owned root reconciliation admit linked requests before domain locks; nested checkpoint Proposal owners now admit the combined request/Run closure (see the later nested-owner evidence). |
| runs/repository.ts | Independent recovery/publication and the prepared root owner subset below are migrated; composed Proposal/Research and direct coordinator/Room owners still block full qualification. |
| importedSessions/extraction.ts | Linked Brief merge creates a fresh frozen review and atomically supersedes the old request with read marks. |
| skills/proposalApplier.ts | Complete package sibling request set is admitted before package locks; original human/risk/uniqueness gates retained. |

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

## P5 action-grant family

This section is subsequent family evidence, not a revision of Plan 1's historical
review or test results. Independent review of this uncommitted family is pending
with the coordinator; no commit, deployment or live database change is claimed.
The current composition preserves the user-only collaboration participant
command and adds user-only `policy.action_grant.create/revoke`; no production
approval mapping is enabled.

| Invariant | Evidence | Boundary |
|---|---|---|
| Strict DTOs, nullable defaults, canonical errors | actionGrantOperationDb: omitted/null cross-entry replay, malformed/nonobject JSON, unknown fields/types, missing key, nongrantable action | Shared schema validates before business effects; no private error reflection |
| Cross-entry idempotency | actionGrantOperationDb: create/revoke REST and generic replay; changed-input 422; actual PG blocked-writer same-key 409 | One grant/request, no transport dedupe or retry |
| Live authority and Space hiding | actionGrantOperationDb: downgraded-owner fresh write and success replay, foreign Agent targets | Locked owner and owning Agent/Project/Run/grant closure; current denial wins |
| Agent authority stays bounded | actionGrantOperationDb: actual CliAgentToolTransport calls on running, owner-instructed Run with injected immutable grant snapshot | Both grant commands refuse 404 without grant/request mutation |
| Domain uniqueness and transactions | actionGrantOperationDb: active-scope 409, spent grant replacement; required admission-audit failure; outcome trigger refusal after domain write | No partial grant/request; independent final failure audit, one decision per admitted invocation |
| Consumers and composition | operationExecutorDb enabled catalog and no production approval mapping; operationRoutes exact inventory; actionApprovalGrantService, authorizationRequestService and runToolGroup | Internal request approval uses same writer; consumption/provenance unchanged |
| Internal request approval audit recovery | runToolGroup: grant-policy deny/require_approval refuse with pending request and persistent failed audit; actual grant/Job INSERT failures restore the original audit id after rollback; successful approval and repeated-decision refusal keep one audit; failed transactional/recovery storage stays failclosed | Complete decide transaction owner uses canonical withPolicyAuditRecovery after rollback/release; no independent success audit or production approval mapping |

Focused verification uses the six named test files with shared real PostgreSQL
and REQUIRE_TEST_POSTGRES=true; unavailable infrastructure is a failed check,
never a fake DB pass. The exact latest counts are recorded in Plan 5. Process
death/COMMIT-loss evidence remains the core's Plan 1 matrix; no new grant-specific
process-kill or live rollout claim is made. Remaining P5 families are pending.

## P5 Project operation commands

Subsequent family evidence on 7aea6793; independent review pending. The existing
P1/grant evidence above is historical, not a claim that those checks reran here.
No production approval mapping or new Agent surface is enabled.

| Invariant | Focused executable evidence | Boundary |
|---|---|---|
| Strict public draft/receipt contracts | projectOperationCommandsDb; protocol operations; browser conversation-scope-api | custom/source_setup/source_backfill draft labels and nullable scoped/readable refs; research/progress stay internal; no raw Research content in receipts |
| Cross-entry keys and live authority | projectOperationCommandsDb REST/generic replay, changed input/target, same-key PG contention, membership downgrade, foreign/absent targets | One command/domain effect; hidden refusal, no automatic retries |
| Atomic mandatory audit/result | projectOperationCommandsDb audit trigger refusal, result receipt failure after create/steps | No partial domain/request; one final failed audit after rollback |
| Research stop and terminal semantics | projectOperationCommandsDb generic-vs-dedicated terminal cases and required Job failure; projectResearchOperationCancelDb | Same Research stop closure, status/reconcile/Job transaction; worker owns process IO |
| Existing consumers and no added Agent reach | projectOperationService; operationExecutorDb catalog; actual CliAgentToolTransport create/cancel refusals in projectOperationCommandsDb | Canonical internal writers retained; dedicated Research Agent grant behavior unchanged |
| Archive, reference and Research permissions | projectOperationCommandsDb reference visibility/scope/replay and archived 409; researchOperationRepairDb real bound-call Run denial and readable-by-oversight but no Thread change | No domain/Job effects; hidden 404 without content disclosure |
| HTTP metadata and size boundary | projectOperationCommandsDb headers, large intent/detail/101 steps, shared body-limit 413 | Canonical cache-control/request-id and existing 32 MiB whole-request bound; no new field quotas |
| Exact route retirement | operationRoutes with UPDATE_OPERATION_ROUTE_INVENTORY convention | Two formal URLs move to core; 581 baseline P5 legacy paths remain |

Current owner/caller boundary: [Project operations](PROJECTS.md#project-operations).
This family adds no external IO and performs no deployment/data conversion.

## P5 Project Board subfamily

Implemented on dac5d44b and committed in 4ffdeca8. Only board.configure and
task.move_to_column migrate here. Task set_status's done/review command closure,
delete's execution/Host cleanup closure and standalone Space Board placement
were pending at that basis. The lifecycle section below records subsequent work.
At the Board basis, taskDeletionDb was a regression consumer, not evidence
that delete migrated. No production approval mapping is enabled.

| Invariant | Executable evidence | Boundary |
|---|---|---|
| One writer and scoped replay | boardAgentActionsDb formal/generic configure and move replay/input conflict, same-key PG races; executor catalog | Human and Agent scopes stay separate; no identity coercion |
| Agent authority and history | boardAgentActionsDb real CliAgentToolTransport/core replay, stored principal/person, Agent work event and revoked grants; old executor absence | Verified current Run/Project/grants and actual Agent actor; no human override |
| Revision, column identity and WIP | boardAgentActionsDb; projectBoardColumnsDb | Stale 409, Unassigned refusal, multiple columns sharing status, blocked overlay, WIP remains hints |
| Live reach and atomic configuration | boardAgentActionsDb private Task/downgrade/foreign Task, failed relocation rollback, mandatory audit/result storage triggers | No partial Board/Task/receipt, no private existence/content disclosure |
| Required Job rollback | taskMergesDb selected Board core required merge Job transaction cases | Real existing Host/location/TaskRun fixture; trigger plus nontransactional sequence proves Job admission was reached; configure/move rollback Task/events/merge/receipt |
| Browser parent behavior | ProjectBoardPage tests and conversation-scope-api | Explicit key/revision transport, optimistic rollback, completion acknowledgement and post-save Board read; no visual acceptance claim |

Taskboard/ProjectWork guides own the API and pending boundaries. Inventory at that basis
was 634 = 595 legacy + 31 exemptions + 8 core entries: one baseline PUT migrated
and one new named move URL was added. 580 baseline P5 core legacy entries remained at that basis.

## P5 Task lifecycle family

Basis 4ffdeca8, implementation awaiting independent review. Six commands retain
their existing actor surfaces: user+Agent status/delete; Agent-only
report/complete/request_review/handoff. No approval mapping is enabled.

| Invariant | Executable evidence | Boundary |
|---|---|---|
| REST/generic replay and changed input | taskLifecycleOperationsDb | User status/delete share receipts; user and Agent key scopes remain distinct |
| Agent replay/concurrency/current grants | taskLifecycleOperationsDb, all six commands | One domain event chain, actual Agent/Run, nonblocking key conflict, revoked grants hide replay |
| Origin and access | taskLifecycleOperationsDb including safe target discovery; projectConversationWritesDb | Unattended advancement fails closed, report/handoff/review remain available, same-Space foreign Project and cross-Space/summary Tasks hidden |
| Reporting/completion/review | taskLifecycleOperationsDb; projectWorkActionsDb | Report outcome does not close, done/review use original writers, required outputs and human acknowledgement distinct |
| Delete execution/Plan refusal | taskLifecycleOperationsDb; taskDeletionDb | Evidence retained; deletion is never cancel/status substitution |
| Atomic audit/result/Jobs | taskLifecycleOperationsDb; taskMergesDb named required Job and cleanup receipt cases | No partial Task/event/merge/receipt; failed policy audit retained on SQL/Job failures; sequence proves real enqueue |
| Existing Host workers | taskBranchLifecycleDb | Worker owns actual branch cleanup; no Host effect is claimed by a core receipt |
| Typed consumers | protocol operations/systemActions, web Board/Task pages and conversation-scope-api | Explicit caller keys, canonical errors, confirmation retained; no visual acceptance claim |

Inventory now 635 = 594 legacy + 31 exemptions + 10 core adapters. One old
delete URL retired, one named status URL added; Agent-only commands already use
the generic Run tool transport and add no route rows. Baseline core legacy
remaining 579; P5-3/6 and P5 overall are not declared closed.


Task lifecycle review corrections additionally use taskLifecycleOperationsDb (Task contract browser case): the real
built Task Detail parent and editor save through Fastify routes into shared real
PG, for Project contract-only edits and standalone Board changes. The old mixed
Project payload still returns 422 without partial writes. Chromium screenshots
cover dark/light themes, en/zh-CN locales and 390/1280 widths; inspect settled
dialogs and the parent entry, not transition frames. Existing untranslated Task
form labels remain outside this correction; this is not a localization rollout.


## P5 approval writer first subset (through 41e8f5c7)

This batch migrates internal decision/cascade and replacement paths, not the
eight-family gate as a whole. No route or registration is newly enabled.

| Invariant | Real PG evidence | Limits |
|---|---|---|
| Canonical accept/reject and result/audit atomicity | operationExecutorDb existing P1 cases plus P5 transition cases; pluginOperationsDb | Test/P2 registered mappings only; no new production mapping |
| Source recursive multi-request cascade | operationExecutorDb rejection, trigger rollback, sorted-key and graph-growth cases | Same-Space dependency closure; no new Source execution/egress permission |
| Dependency creation/link races | operationExecutorDb closure gate and late pending-attachment checks | Existing canonical insertion participates; unmigrated mutable payload owners remain blockers |
| Expiry/retention and conflicting decisions | operationExecutorDb pending expiry, terminal retention under held cascade keys, accept/reject race | No late reconcile claimed as writer atomicity |
| Project definition replacement | operationExecutorDb successful/failed replacement, projectConversationWritesDb | Import extraction's shared Brief payload writer is not migrated |
| Monitoring scope/details replacement | projectInformationMonitoringDb four linked success/rollback cases | Uses P1 request-record fixtures; does not authorize monitoring mapping |
| Unlinked behavior | Memory/Proposal/Project/Source/plugin related regressions | Unlinked regressions are not linked-writer closure evidence for deferred families |

At that first subset basis, Run recovery/publication CTEs, Plan review's outer
version transaction, Skills' package-lock/SKIP LOCKED siblings, pending Memory/import
payload revision and Evolution bundle/member ownership remained disabled enablement paths.
Their owners must predeclare the complete key set before their own domain
locks; a post-update hook is insufficient. Code-patch external rollback is not
eligible for a core-owned DB mapping. Mapping qualification from this subset:
none of the new business families may be enabled.

Route accounting is unchanged: 635 = 594 legacy + 31 exempt + 10 core adapters;
579 baseline P5 core legacy routes remain. Internal ledger synchronization is
not URL retirement.


## P5-4 second writer subset (basis 41e8f5c7, awaiting review)

The current diff extends internal admission, not URL migration. No production
mapping or proposal.decide authority is enabled.

| Invariant | Executable real PG evidence | Qualification boundary |
|---|---|---|
| Frozen Memory revision | memoryMaintenanceRevisionDb | Linked old payload/request retained and superseded; fresh review with audience/deadlines/provenance, no copied approvals; rollback leaves no new draft or active version |
| Imported Brief payload merge | importedSessionsExtractionDb | Linked merge creates fresh review and invalidates old request with read marks in the same transaction; failed transition restores draft/claim state; unlinked merge keeps id |
| Plan version/review replacement | planGraphExecutionDb | Keys before planning Run/Task/Plan locks; linked review, versions and requests commit or roll back together |
| Whole Skill review set | skillsApprovalDb | No SKIP LOCKED; sibling requests terminalize together, concurrent decisions conflict, original pending uniqueness retained; failed request write restores package/Proposals and one failed audit; audit storage failure fails closed |
| Run recovery and independent terminal publication | runProposalTransitionsDb | Per-Run sorted keys, busy candidate isolation across Spaces, staged pending/rejected semantics, required publication intent and terminal-result rollback |
| Materialization | runProposalTransitionsDb; runMaterializationService | Mandatory audit/Proposal/audience transaction after external IO, failed audit recovery, no partial result; former materialization fake DB replaced by SQL observation on shared real PG |
| Current authority and dependency domain | projectSourceDependencyDb | Project writer preflight before keys plus authoritative locked check; valid activation refs, foreign Project/Space/type/channel/private denial and legacy forged payload rejected by canonical apply; raw client without BEGIN refused |
| P1 races and incomplete outer owners | operationExecutorDb | Existing cascade/expiry/retention/accept-reject/result tests remain; unprepared owner with linked descendant refuses before held key; accepted without atomic result remains failclosed |
| Existing consumers | projectInformationMonitoringDb, projectConversationWritesDb, knowledgePromotionDb, jobsRunSettlementDb, runSupervisorDb | Source setup, Project writes, pending candidate creation and existing Run settlement behavior; no new execution/egress authority |
| Browser review identity | ProposalDetailPage web test | Parent editor follows returned new draft id; no layout/style or visual acceptance claim |

Remaining blockers are concrete transaction owners, not missing registry flags:
Run terminal composition in Plan/Workflow/Host/Project/autonomy/provider owners can
already hold domain locks and must pre-admit the full closure before them. These
linked transitions currently refuse before key admission, including link-growth
rechecks; unlinked behavior uses the same writer. Evolution still takes an outer
session bundle lock and per-member transactions/snapshots before the canonical
decision. Its external code-patch apply/rollback needs DB intent/required Job and
worker outcome boundaries before core-owned mapping; no Host/LLM/network work was
moved into these transactions. This subset does not claim those owners migrated.
Mapping enablement qualification remains **none** for these business families.

Route accounting remains 635 = 594 legacy + 31 exempt + 10 core; 579 baseline P5
core legacy entries remain. No P5-4, P5-3/6 or overall P5 completion is claimed.

Current subset verification (2026-11-06): final selected server run 16 files /
317 passed, zero skipped (13 shared real PG files / 292 tests, 3 guide/pure files /
25 tests); web parent revision test 1 file / 5 passed; protocol operations and
systemActions 2 files / 30 passed. Node24 workspace dependencies, server build and
types, web types and diff check passed. This is scoped verification, not a full
suite or new business-mapping qualification. Exact per-file counts are in the
P5 migration plan; historical P1 evidence above is unchanged.

Review correction verification (same working diff, 2026-11-06): final related
server run **13 files / 268 passed, zero skipped** (11 real PG files / 250 tests;
agentGuides 8 and workSkill 10). Run Proposal tests now 15: real Job cancellation
concurrent with uncommitted staged insertion, required intent rollback, worker
publication convergence, plus independent recovery with a busy request key, Run
row or Proposal row across Spaces. Source dependency tests now 14, including
canonical shared/private review reach. Web parent review tests: 5 passed, including
acceptance of the new returned id; server build/types and web types passed.
Ordinary insertion no longer holds the Run fence. P1 request attachment uses it;
staged insertions record a required publication Job. Recovery's row admission is
nonwaiting and each candidate has its own transaction. These corrections supersede
the earlier creation-gate/global-batch descriptions, not the P1 historical evidence.
Evolution and linked outer Run owners remain unqualified; no mapping is enabled.


R1 targeted correction (same basis, uncommitted): runProposalTransitionsDb now
23 tests. Eight added real-PG cases cover every mark/publish pairing, actual Job
cancel owner versus background publication in both orders, and both attachment
race orders. Competing terminal transactions overlap before the first COMMIT;
a real PostgreSQL lock waiter is observed before release. First status/output/
ended_at/updated_at remain identical after the later null noop. Attachment
conflicts leave no partial request or frozen-payload drift. Final scoped run:
4 real PG files / 114 passed, zero skipped (Run Proposal 23, P1 executor 67, Job
settlement 5, materialization 19). Node24 workspace dependency build and server
typecheck passed; no full-suite or new mapping qualification is claimed.


## P5-4 Pool-owned terminal roots (basis 6bcba36d)

The coordinator committed the preceding writer subset and R1 correction in
6bcba36d. This new independent subset uses `withRunTerminalOwner` to discover
all affected Runs before domain locks, admit their entire sorted request set,
then pass an expiring transaction-bound port to existing child writers. Child
membership is checked against the actual prepared object, not a boolean. A
changed set conflicts before any late key; requests finish once with the root.
Unlinked terminals still share admission and serialize/noop on the Run row.

| Root / invariant | New or extended shared real PG evidence | Limit |
|---|---|---|
| Backing Job cancel/exhaust | linkedRunJobOwnersDb; jobsRunSettlementDb | Job/Run/Proposal/request commit or roll back together; exact original status/worker selectors, multi-Run globally sorted keys before writes, changed reference conflicts; pending review stays pending |
| Project archive | linkedRunJobOwnersDb; projectArchiveLifecycleDb | Original Project writer preflight and locked authority; Workflow/Automation/Job/Run/request rollback together; status update uses the same owner |
| Plan/Workflow root reconcile | planGraphExecutionDb | Linked success and rejection, failed Proposal publication/request persistence restores graph/root; action savepoints recognize the existing branded transaction |
| Stale autonomous child cancel | autonomyLaunchDb | Original candidate/tick fixtures, linked rejection and storage-failure rollback; postcommit alerts and reconciliation retained |
| Host queued resolution cancel | taskMergesDb | Failed request causes no terminal publication or Host abort; the existing persistent merge Job retries, cancellation commits before external abort |
| Reading provider generation/trial finalize | readingMethodGenerationDb partitions; readingMethodRevisionDb | Real ProviderTask/Delivery graph and linked requests, original private review/visibility/consent behavior; external provider work precedes the short DB owner |
| Lifetime, required Job and audit | linkedRunJobOwnersDb | Expired port refused, raw autocommit client rejected before Job write, required Job trigger rolls back all state and canonical recovery retains one failed audit after rollback/release |
| Existing R1/late publication/busy recovery | runProposalTransitionsDb; runMaterializationService; operationExecutorDb | All prior terminal/noop pairings, attachment fences, required publication Job, per-Run busy recovery and P1 result/retention races retained |

Unclosed owners are concrete and remain mapping blockers:
- `plans/proposalApplier.applyPlanCheckpoint` and
  `automations/workflowExecutionProposalApplier` join a canonical Proposal
  decision already holding Proposal locks. Their true decision owner must admit
  the combined root/cascade Proposal and graph Run set first. The child cannot
  prepare keys late. `projectResearch/orchestrator` calls
  `researchPassExecution.startResearchReconcilePass` / `settleSynchronousNodes`
  inside the Research transaction; existing active Workflow roots there need
  that same whole-owner admission.
- `autonomy/finalizationReconciler.settleAutonomyCoordinator` directly terminalizes
  a parked coordinator from candidate/tick owners; `rooms/discussionService`
  `cancelHeldClosing` directly cancels queued held groups and releases Host
  threads. Neither direct writer has linked publication closure evidence here.
- Evolution bundle `decide`/`requestRollback` takes a session bundle lock before
  canonical decisions and currently commits decisions member by member. A mixed
  bundle can invoke synchronous code-patch filesystem/Host effects. There is no
  durable effect-intent/worker-result receipt contract for those appliers yet;
  migrating only DB members or running IO inside a core transaction would not
  prove the requested all-or-nothing boundary. No such split/fallback is added.
- General action-handler policy/effect ownership is unchanged. Root graph
  terminal evidence does not qualify arbitrary nested appliers or handler effects.

Direct terminal-call inventory additionally checked orchestration/agent/route/
bounded-provider/publication paths (independent Run owners), Reading cancellation
(Pool calls), and Daily Report (a fresh unlinked Run created and ended in one
transaction). Literal Proposal status/payload UPDATE search still resolves to
canonical apply/revision, definition/monitoring, Skill, Plan, both Run CTEs,
publication Job and P1 supersession; Evolution is an outer caller owner, not an
additional direct Proposal SQL writer. No production mapping or public decision
authority is enabled. Mapping qualification remains **none**; P5-4 is in progress.
Route counts remain **635 = 594 / 31 / 10**, with **579** P5 legacy entries left.

Verification (2026-11-06, Node24.18.0): **15 files / 282 passed, zero skipped**;
12 shared real PG files / 257 tests and 3 guide/pure files / 25 tests. Exact
per-file counts and commands are in the P5 matrix. Workspace dependencies, server
build (including official plugins), server tsc --noEmit and diff check passed.
No full suite, web/protocol API change, visual acceptance or online DB write.


## P5-4 maintenance and direct terminal owners (basis 0ac06ce2)

The autonomous coordinator no longer updates terminal Run status directly.
Tick success/failure roots and finalization discover coordinator Runs before
candidate/tick locks; timeout recovery admits child and coordinator together.
The existing canonical terminal CTE publishes staged Proposals and their linked
requests in the same transaction as candidate/report/tick state. Linked timeout
and coordinator fixtures exercise success and failed-request rollback.

Room discussion open/stop/extend similarly discover closing Runs before session
and discussion locks, with Room/Project preflight plus authoritative checks.
`cancelHeldClosing` now uses the canonical terminal writer, preserves non-hold
output, and releases Host thread locks transactionally. The real capped-discussion
parent test forces request failure, verifies discussion/Run/Proposal rollback,
then explicitly retries and observes rejected request plus cancelled Run.

Maintenance differs from atomic user actions: Job reclaim and autonomous timeout
scan process independent snapshot candidates in separate nonwaiting transactions.
Busy request keys/fences/rows leave the candidate for the next existing sweep;
other candidates continue. Orphan execution-lock cleanup stays independent of
request admission. Project archive and graph actions still roll back as a whole
on admission conflict. Real PG tests cover Job progress across two Spaces for
busy key/fence/Run row and later convergence, and busy autonomous timeout retry.
Per-Job admission sorts its complete multiple-Proposal request set before writes;
there is deliberately no cross-candidate transaction or global lock retention.

Host stale withdrawal only admits its captured resolution reference; missing or
replaced reference is a safe Run no-op after the locked recheck. Real parent
merge worker concurrency tests cover removal/replacement without cancelling
old or new queued Runs. A Pool root without `options.connectionString` now fails
before work instead of silently losing failed-audit recovery. Raw autocommit
clients retain strict refusal. Static production entry tracing found Job worker
uses `PgJobQueueRepository.fromConfig`, timeout scheduler uses `getDbPool`, Room
holds a real Pool, and tick/finalization roots use Pool or an already prepared
transaction. No production autocommit owner was substituted or allowed.

Scope remains incomplete: canonical checkpoint Proposal + Research composite
owner admission and Evolution mixed bundle durable external-effect/receipt
boundaries have not been implemented here. They are unfinished engineering work,
not a new authority decision or evidence that permanent failclosed is completion.
No production mapping/public proposal.decide authority is enabled. Current URL
inventory remains 635=594/31/10, remaining579. P5-4 stays in progress.

Final verification (2026-11-06, Node24): 12 files / 351 passed, zero skipped.
Nine real PG files / 326: linkedRunJobOwnersDb16, autonomyLaunchDb19,
taskMergesDb42, jobsRunSettlementDb5, runProposalTransitionsDb23,
operationExecutorDb67, roomsDb partitions21/73/60. Three guide/pure files /25:
agentGuides8, boundaries5, testHygiene12. Workspace dependency/server build
(including official plugins), server tsc --noEmit and git diff --check passed.
Existing Room tests emitted pg concurrent-query deprecation warnings; they were
not silenced or represented as new correctness failures. No full suite.


### D1 / bounded N1–N4 review corrections (same uncommitted subset)

D1 open/extend Room writer discovery is explicitly nonlocking; locked work
retains its authoritative recheck. Two real PG tests lock the Room row and the
linked request key together: both commands must reject the key while that Room
lock is still held, not await it. They also verify foreign Space/revoked Room
membership stays404 and no partial discussion/Run/request write.

N1 maintenance entry points reject checkout/BEGIN/branded ports before any SQL;
three PG cases verify both scanners reject without aborting the caller transaction.
N2 JSON-null run_id is excluded consistently from abandoned Run projection, while
the exhausted Job still becomes failed once (one real PG case).
N3 held closing with an execution lock records durable cancelling intent with
requesting-user attribution, keeps that lock and uses existing RunRecoveryService
job admission then canonical stop/settlement. A real capped-discussion parent
case verifies eventual cancelled, not a swallowed null terminal result. Parking
may retain its execution lock until orchestration finally, so no impossible-state
claim is made. No unsafe direct terminal SQL or new retry/Job engine is added.
N4 removes `port as PoolClient`: only query-only signatures in the Room dispatch,
AgentGroup and managed-assistant repository call chain use Queryable. The six
additional source files contain type/import edits only; no second writer or API
behavior is introduced. Other eighteen-file behavior and unrelated work remain.

Nested checkpoint/Research and Evolution remain explicitly outside this repair;
no P5-4 completion or production mapping/public decision authority is enabled.
URL635=594/31/10, remaining579, unchanged.

D1 correction final verification (2026-11-06, Node24): 12 files / 358 passed,
zero skipped. Nine shared real PG files /333: linkedRunJobOwnersDb20,
autonomyLaunchDb19, taskMergesDb42, jobsRunSettlementDb5,
runProposalTransitionsDb23, operationExecutorDb67, roomsDb partitions21/74/62.
Three guide/pure files /25: agentGuides8, boundaries5, testHygiene12.
Server tsc -p tsconfig.typecheck.json --noEmit and git diff --check passed.
Seven added PG cases versus the prior351: open/extend lock ordering2,
maintenance caller ownership3, JSON-null reclaim1, held-lock eventual settlement1.
No full suite or new web/protocol/visual acceptance. Existing pg query-concurrency
warnings remain visible. The pending own scope is24 files (previous18 plus six
query-only type-chain files); this correction touches15 of them: three runtime,
six type-only source, two tests and four docs. No commit/push/deploy/delegation.


## P5-4 nested checkpoint / Research owner subset (basis33466aee)

Implemented canonical accept's combined checkpoint/cascade + related graph Run
admission immediately after BEGIN and nonlocking visible-decision preflight.
All linked keys sort before Run fences and Proposal/request/domain locks. Nested
transition calls reuse the transaction-bound closure, not a caller readiness
flag. Root membership is rechecked after fences; unseen existing Runs conflict.
Canonical fresh Run inserts register on the live scope; terminal publication
refuses a linked fresh Run instead of taking late keys. Old receipt associations
and accepted-without-atomic-result refusal remain unchanged.

Research pass and operation/checkpoint/post-processing root owners pre-discover
Project graph Run sets before locks. General Workflow reconcile does the same
when Research-bound, including background entry. Pure draft/item-limit/pending
item writers remain ordinary owners. Canonical checkpoint appliers, work events,
responsibilities, Run terminal CTE, required Job writers and B10 are retained.
No production mapping/public proposal.decide permissions are enabled.

Reuse / Dependency Check: existing P1 admitTransitions/fences, canonical Run
writer, transaction WeakMap capability, withRunTerminalOwner, Job enqueue and
policy audit recovery. No new transaction/retry/effect engine or dependency.

New real PG evidence: Plan checkpoint required Job refusal restores Proposal/
request/Job state and recovers exactly one failed policy audit; explicit retry
schedules its successor and repeat accept returns null. Workflow checkpoint
failed root publication restores checkpoint/graph/request before explicit retry.
Research existing-pass root tests linked failed graph publication with successful
commit and forced request-storage rollback. Existing P1/Run races are reused.
This evidence does not yet prove every requested composite multi-Run/attachment
race for the new owner; no full mapping qualification is claimed.

**Not implemented in this subset:** Evolution session/bundle/member mixed-effect
DB intent/required Job/result receipt boundary. Existing bundle per-member
transactions and synchronous code-patch apply remain unchanged. This is unfinished
engineering work, not a claimed product/permission blocker or completed failclosed
migration. Therefore the requested two-closure scope and P5-4 remain incomplete;
mapping qualification remains none. Route635=594/31/10, remaining579 unchanged.

Final related verification (2026-11-06, Node24): 12 files /223 passed, zero skips.
Nine shared real PG files /198: planGraphExecutionDb20,
linkedRunJobOwnersDb22, projectResearchDb17, projectResearchIntegrityDb11,
projectResearchRescanDb18, projectResearchExecutionProfileDb1,
operationExecutorDb67, runProposalTransitionsDb23, runMaterializationService19.
Guide/pure3 files /25: agentGuides8, boundaries5, testHygiene12.
Workspace dependencies, server build including official plugins, server
`tsc -p tsconfig.typecheck.json --noEmit`, diff check passed. No full suite,
public protocol/web/UI change, online DB, delegation, commit or deployment.
Initial graph/field/status fixture failures were corrected using the real schema
and original domain constraints; failed attempts are not counted as passes.
Discovery now requires actual checkpoint-to-node approval linkage, and history
extension preflights existing Project writer authority before Run/key discovery;
locked canonical applier authority is retained. Own scope14 files: six source,
two tests, six owner/contract/matrix docs. Unrelated INDEX/worktree-plan/reports
are excluded. Evolution remains unimplemented, not claimed a completed closure.

## P5-4 Evolution durable mixed decision extension (basis33466aee)

`bundleRepository.decide`/`requestRollback` now use one prepared selected/cascade
set before Bundle/asset rows, one DB transaction and the original canonical
appliers. There is no session-gated per-member commit path. Mixed `code_patch`
selection admission persists a private frozen intent plus required Job; the
existing worker prepares, records preimages/effect receipts, performs IO outside
transactions, and returns to the same canonical appliers for a single final
member/Proposal/request/result/receipt transaction. Default production mappings
remain absent. Test-only P1 mapping demonstrates linked Memory success and
receipt-storage rollback inside the mixed worker; accepted without an actual
atomic result remains refused. No public proposal.decide authority is enabled.

External effects are recoverable, not transactionally invisible: exact-content
replay, hash-conditional compensation, explicit compensation failure, one bounded
cleanup handoff after cancelled/exhausted Jobs, and live Job claim checks are
implemented. Canonical Memory provenance/B10, folder protection, owner/risk gates
and pre-existing rollback support are unchanged. Unsupported foreign Host folders
are still refused by the existing code-patch target resolver. No second executor,
network call inside a transaction or direct Memory table writer was introduced.

Nested evidence now includes null-root Workflow acceptance, same-Project related
Run busy-key admission, set growth after discovery, fresh canonical Run registration
through branded ports, same-transaction linked fresh Run refusal, unknown nested
Run refusal, real history-extension/payload Project fallback and required extraction
Job rollback with exactly one failed audit. Active related staged outputs stay
pending; terminal history without staged output is excluded from related discovery.
Historical statements above about unimplemented Evolution describe earlier subsets;
this extension replaces that implementation gap, not their historical test results.

P5-4 remains in_progress pending independent review/qualification of this combined
extension. Production mapping eligibility is **none enabled**; enabling a specific
family still requires its complete inventory and effect/result/security evidence
review. Route accounting stays635=594 legacy/31 exempt/10 core, remaining579.

Evidence (2026-11-06): focused server12 files/227 pass with real shared PG for
durable behavior, protocol2 pass, web3 files/21 pass and local browser2 parent
scenarios pass; exact files and limits are in the P5 matrix. Current extension
requires generated migration0013. No full suite, online DB, production mapping
or deployment occurred. File-effect interruption tests preserve real PG and
filesystem state; this batch does not claim an actual SIGKILL test or distributed
transaction across remote Hosts. Both linked code-patch and linked Memory mapping
paths were exercised only through test registrations, with real canonical appliers.

## P5 standalone Space Board placement closure

`task.place_in_space_board` is a strict user-only command with a formal named
POST adapter and typed browser consumer. Placement-bearing contract saves join
the existing Task writer in one core transaction. Raw PATCH placement is retired
under the Task lock for Project and standalone Tasks; ordinary metadata PATCH,
Task creation and general Board CRUD remain separate migration scopes.

Real PostgreSQL evidence covers formal/generic replay and changed input,
same-key concurrency, current authority revocation, Project/foreign destination
refusal, concurrent Task reparenting, stored completion requirements, audit and
success-receipt failure rollback. Existing Board/Agent regressions and the real
Chromium Task Detail parent save (Project and standalone contracts) pass.
Final server selection: six files /91 passed, zero skips. Protocol operations8
and web API/Task Detail16 pass. Server/web types, protocol and web builds and
route inventory checks pass; existing frontend chunk/router warnings remain.
No presentation change or new independent visual acceptance is claimed.

The existing OperationExecutor, policy task.column.move, structured Task fields,
Task writer and test/browser fixtures are reused. No new dependency, duplicate
domain writer, Agent grant/tool or production mapping is added. This closes the
P5-3 capability scope after the prior configure/move/status/delete batches.
Inventory636=594 legacy+31 exempt+11 core;579 baseline core legacy URLs remain:
the new named URL does not migrate the remaining metadata PATCH URL wholesale.
Independent Agent review was not rerun because the fixed collaboration budget
was exhausted; this is recorded as skipped, not as approval. The implementing
coordinator reviewed the transaction and consumer boundaries and ran the focused
checks above. No push, deployment, full-suite run or online migration occurred.


## P5 Source backfill planning/control family

The four retained Source POST URLs are core adapters: preview is a readonly
metadata query; create_plan, pause and resume are strict user-only commands.
Source manage/read gates, current Space and Project writer authority, binding/
operation scope and active Project fences apply to new work and receipt replay.
Domain uniqueness remains distinct from request replay. Invalid domain scope
cannot return another Project's receipt. Existing internal orchestration still
uses the same planning writer; no start approval or Agent grant changes.

Evidence (2026-11-06): sourceBackfillOperationsDb13 covers formal/generic replay,
independent domain uniqueness, same-key concurrent contention, revoked Source
and Project rights, active Project/binding/operation scope, terminal conflicts,
unknown input/path authority, link persistence and plan/segments/receipt/audit
storage rollback. sourceBackfillExecutionDb17 verifies existing shared item
budgets and execution; existing strategy/service regressions22, route inventory1,
agentGuides8 and testHygiene12 also pass. Server total73 with zero skips;
protocol operations9, web API10 and server/web types pass. No presentation
change or new visual claim; no full suite. Coordinator reviewed transaction,
locks, caller and replay closure; independent Room review remains skipped due
to the exhausted fixed collaboration budget, not represented as approval.

Inventory636=590 legacy+31 exemptions+15 core;575 baseline P5 core legacy routes
remain. This migrates four existing URLs and adds none. P5-2 remains in progress
for its remaining ordinary capability scopes; Source gated submission/activation
and Note/Source promotion remain separate work. Production mappings stay off.


## P5 human Thread creation and Note selection

Two ordinary human commands now join the same canonical domain transaction:
`inquiry.thread.create` and `note.raise_as_question`. Their two retained URLs
are thin core adapters. Strict kind/statement/state/parent contracts, explicit
transport keys, independent producer uniqueness, active Project writer checks
and current Note/Thread read authority apply before new work and on replay.
Thread identity/state, revision, domain-change outbox, Project work event,
optional Note reference, policy audit and receipt commit atomically. Source
Note content/version are unchanged. No plain Note-link default policy, Wiki
approval, Agent origin rule or production approval mapping is changed.

Validation: two relevant server selections cover7 files/66 passed, zero skips:
new noteQuestionOperationDb16, existing noteRaiseAsQuestionDb5 and inquiryThreadDb18
(shared real PG39); noteObjectActions6, operationRoutes1, agentGuides8 and
hygiene12. New PG cases include human and Note formal/generic replay, separate
operation scope, producer conflicts, hypothesis fields, current grant/Project
revocation, cross-Space absence equivalence, same-key contention and individual
reference/revision/outbox/work-event/receipt/audit failures with no partial rows.
Protocol operations/policy/systemActions46 and web API/NoteEditor/Project workspace37
pass; server/web typechecks and protocol build pass. Parent tests exercise the
existing Note selection and typed Project human creation. Presentation remains
unchanged; no new visual acceptance or full-suite claim.

Consumer checking also exposed a frozen policy registry fixture stale from
previous P5 commits. It now matches the actual121 registered policies and
already-committed enforcement-point metadata, without changing those policies.
Self-review checked permission, transaction, writer and replay closure;
independent Room review remains skipped due to the fixed exhausted budget.
Inventory636=588legacy+31exempt+17core;573 baseline P5 core legacy remain.
P5-5/6 and overall P5 remain unfinished.


## P5 Project Source consumption family

project.source.bind/update/unbind/backfill and their four retained URLs now
share core admission and the canonical binding/routing service. Strict current
Project writer/active fence and original Source reach/delivery checks protect
new work and replay. Creation can read metadata but does not imply Source
management; pausing an existing binding remains a Project writer operation
when Source read scope is later withdrawn. Restricted Source sharing to all
Project members still requires the Source owner. No acquisition/activation
approval, Source consent/egress or Agent surface is widened.

Evidence: projectSourceOperationsDb16 (shared real PG) covers formal/generic
replay, conflicting input, binding uniqueness/archive/restore and private SQL
redaction, same-key contention, current Source/Project rights, cross-Space/path
scope, profile validation, Corpus/link changes and receipt/audit failure.
Standing notes/batch/required Job commit with the binding; Job/receipt failure
rolls all of them back, and replay creates no duplicate Job. Existing real-PG
sourceEvidenceProjectLink20 and projectResearchStanding11 pass with the new
port; sourceServiceBoundaries2 also passes. Selected server coverage totals
7files/70 tests (47 real PG) with zero skips, including route1/guides8/hygiene12.
Protocol47, web API/ProjectSources31, typechecks and server/dependency build
pass. Existing pg concurrent-query deprecation and Router future warnings are
visible; no suppression, full-suite or new visual acceptance claim. Coordinator
review covered current authority, domain/error/replay and all browser callers;
independent Room review remains skipped for the fixed exhausted budget.
Inventory636=584legacy+31exempt+21core;569 baseline core legacy remain.
No overall P5 checkpoint completion is inferred from this capability family.


## P5-8 retired Source connection entries

Superseded: these ten URLs were later removed outright; see
[Retired Source connection URLs removed](#p5-retired-source-connection-urls-removed-source-parent-479a709e-private).
The record below describes its own snapshot.

Reviewed all ten fixed410 connection handlers and extracted their exact
method/path/detail manifest without changing responses. Eight mutating-method
rows are transport-only retirement refusals, now individually exempted from
the domain queue. No prefix exemption applies to live connection/recipe/Channel
routes. sourceRetiredRoutes11 plus operationRoutes1 pass with no database,
including each refusal and live-path controls; server types pass. This is
transport behavior, not durable-state testing with a substitute database.
Inventory636=576legacy+39exempt+21core;561 baseline P5 core legacy remain.
Eight existing refusals were reclassified; no new executable capability or
business migration is claimed. The other31 exemptions and remaining writes
still require their own owner evidence. P5-8 remains in progress.


## P5 personal Source subscription/recommendation family

Two existing human paths now share core commands and the audited
source.subscription.manage action. Authority is the current person's existing
subscription row, pinned after the Channel (and current shared Source for a
recommendation). No actor/user/grant fields come from input. Source ownership
or current content reach is not newly required for an existing personal opt-out;
actual reading still obeys current consent/withdrawal rules. Pending is a domain
transition precondition, not a replay permission: resolved original decisions
can replay while new non-pending decisions are refused.

The canonical service now joins automatic-fact cleanup to the same transaction
as preference and delivery-window changes, including direct Pool callers.
Accepted topics/dismissed decisions remain. Profile facts, windows, preference,
mandatory audit and transport receipt roll back together. No Source config,
egress, semantic-topic activation, Agent or provider execution authority.

Evidence: sourceSubscriptionOperationsDb14 and existing
sourceReadingEligibilityDb15 pass against shared real PG (29 tests); ownership,
revocation, absence/cross-Space equivalence, same-key contention, recommendation
window rollback, profile cleanup failure, receipt/audit failure and direct Pool
rollback are exercised. Source/Reader historical eligibility and consent remain
covered. operationRoutes12, guides8 and hygiene12 pass:61 server tests across
5 relevant files, zero skips. The retired-route tests were moved into the
existing route contract file to satisfy grouping hygiene, without weakening its
rule or deleting coverage. Protocol48, web API/SourceChannels23 and server/web
types pass. Existing Router/act warnings remain visible. No full suite or visual
change claim; independent Room reviewers remain skipped for the fixed budget.
Inventory636=574legacy+39exempt+23core;559 baseline core legacy remain.


## P5 Source draft creation and placement

`sourceRecipeCreationOperationsDb` covers context-free Team-page to Personal
placement, same-Space Project sharing, actual target creator role, hidden
Projects, revoked/absent/ambiguous placement, both memberships on replay,
source deletion, concurrent formal/generic same-key admission, membership
revocation while waiting and placement drift before admission. Trigger failures
on version/scheduler/audit/receipt stores roll back all business rows. Real
recipe-origin rejection, safe name conflict, schedule-error replay and startup
refusal of Agent/grantable/durable placement definitions are covered. No fake DB
or broadened Agent permission is used.

P1's enabled-user catalog expectations include the already-migrated P5 families
and this draft, with an explicit fixed allowlist; unmigrated approval metadata
still cannot open generic execution. Production approval mappings remain off.
Independent model review was skipped because the fixed collaboration budget is
exhausted; this is not recorded as an approval or a completed P5 stage.


## P5 Monitor update and scan enqueue

sourceMonitorOperationsDb protects formal/generic receipt sharing, paused/
active/manual/archived scheduling, Source label updates, canonical versioned
query and Goal ownership conflicts, creator and Space revocation, foreign
Space hiding, strict input, bounded same-key concurrent admission and safe
schedule/name conflicts. Trigger failures on scheduler/Source/Job/request/audit
stores prove no partial configuration, scheduler intent or enqueue success.
A scan receipt remains the original enqueue result after worker completion;
new keys represent new manual scans. Existing Goal compatibility and P1
regressions cover the retained domain owner and core boundaries. Parent Sources
list/detail and Project Sources consumer tests retain current behavior. No
external scan IO, visual acceptance or independent-model review is claimed.


## Note history/trash controls — implemented, independent review outstanding

noteControlOperationsDb covers actual canonical rollback revisions/outbox and
soft-delete timestamps, formal/generic key replay after later edits/restore,
stale-version conflict caching, private/oversight/shared/summary/Project writer
permissions, creator/membership revocation, foreign scope hiding and strict
input. Concurrent same-key restore, owner change while waiting and Project
writer downgrade are exercised with real PG locks. Revision/outbox/request/
policy failure rolls back canonical state; required cross-person read-audit
failure withholds results and rolls back. Derived-index failure is contained
by the existing NoteWriter savepoint. UI API tests require one core command
then an authorized body GET scoped to the receipt Space; parent Notes/history/
trash consumers retain their behavior. No independent dual review or complete
P5 checkpoint is claimed under the exhausted fixed collaboration budget.

P5-2 Source continuation (basis fea06988): new Monitor creation closure is awaiting
independent review alongside the five coordinator Source commits listed precisely
in the P5 matrix. Real PG tests cover REST/generic replay/input conflict, same-key
concurrency, Project membership revocation, actual foreign-Space references and a
real Agent Run refusal; scheduler/subscription/audit/result-storage failures roll
back all domain rows. Strict creation schemas/typed API and retained formal URL
join the existing SourceChannelService writer. No deployment, approval mapping or
new Agent permission is earned by self-checks. Committed remaining556; Source-only
projection555; Note-inclusive draft inventory553. Checkpoint2 is not complete.

P5-2 Source review repairs (uncommitted, basis fea06988): actual parent Project /
Source authority, same-Space child inheritance, key-before-domain scope discovery
and locked rechecks, soft-deleted parent hiding and exact creator preservation
are implemented for create/update/scan. Distinct-key domain admission is shared
with Recipe's canonical channel creation; forced real PG owner-gate overlap tests
prove progress rather than accepting 500/409. Known validation/conflict throw
sites are typed; unknown helper Http422/409 rolls real writes back, leaves no
terminal request and recovers one failed audit. The old source_channel/null-id
policy scope is preserved. The canonical engine currently has builtin rules and
registry defaults, not a configurable DB scope-rule matcher; the denial fixture
uses that real registry/engine/audit path, not an invented policy table. Neither
reviewer is credited with running the implementer's PG tests.

P5-2 Source processing/extraction family (implementation awaiting independent
review): strict rule create/update, queued run/drain and extraction dispatch;
five retained adapters, canonical browser calls, current actual-parent authority,
required Job/audit/result atomicity and worker receipt boundary. Manual Jobs use
one external attempt and refuse indeterminate-effect replay. This is not an
activation/derived-content approval migration or stage completion claim.
P5-2 bounded follow-up: coordinator reports independent reviews without blocker;
separate real PG evidence covers cross-user extraction intents vs original
worker, actual scheduled-vs-manual rule handler overlap, existing Job deferral,
terminal noop, revoked peer authority and default Agent rollback. No different
user's Job id/identity is reused. The UI parent-to-existing-result journey is
checked in real Chromium for en/zh-CN, light/dark, phone/desktop; review and tests
are not interchangeable, and this uncommitted family is not called submitted.
Original checkpoint2 DoD/remaining acceptance is audited in its original plan.

## P5-4 standalone effects and final writer inventory (basis7594f2ec)

Implementation is awaiting the coordinator's independent reviews; the checks
below are Codex execution evidence, not reviewer-run evidence or task acceptance.
The earlier standalone synchronous-effect exclusion is now replaced by a real
frozen intent/required Job/receipt path. Evolution and standalone effects share
one file implementation; canonical DB appliers remain singular. Both apply and
explicit rollback perform IO outside DB transactions and finalize through the
prepared checkpoint/cascade owner. The resulting file effect is recoverable,
not atomically invisible to filesystem observers.

| Original checkpoint4 requirement | Current implementation/evidence |
|---|---|
| All eight writer families and actual insertion sites | Canonical apply/cascade, definition/monitoring replacement, versioned Memory/import payload, Plan review/checkpoint, Run/root/nested/publication, Skill whole-package and Evolution owners remain prepared; the three raw Plan/Workflow/Candidate INSERT sites now use canonical insertion on the real owner port. Only reviewPackets inserts Proposal rows directly. |
| Frozen payload and immutable old-key evidence | Versioned payload replacement/supersession ports remain unchanged. Standalone intent freezes payload/options/snapshot/target; drift refuses without IO. Old successful request result remains byte-for-byte unchanged after rollback/replay. |
| Complete sorted keys before domain, multi-Run/root qualification | Existing purpose-bound owner, fresh registration and shared terminal/exclusive attachment fences reused. Real nested/Plan/Run/Job parent regressions pass; no late boolean readiness, new waiting gate or retry engine. |
| Cascades, expiry, cleanup, atomic results | Selected real P1 tests cover sorted cascade keys, dependency growth, request rollback, expiry/retention and accepted-without-atomic-result refusal. No reconcile is substituted for same-transaction writes. |
| Pure DB and mixed/standalone effects | Mixed Bundle17 + safe file12 tests pass; standalone14 tests cover actual Job, concurrent worker gate, linked final result rollback, required Job/audit failures, frozen drift, revoked authority before/after IO, exact recovery, orphan cleanup and independent-edit compensation refusal. |
| Mandatory audit and required result/Job | Storage refusal leaves pending Proposal/request; failed transactional audits recover through the existing helper. If audit storage itself is unavailable, admission fails closed; no fabricated audit pass. |
| Original permissions, B10 and consumers | Canonical Memory applier untouched. Existing approver/content/Room/risk/Folder gates are reused. Pending HTTP/typed consumers do not report applied files or advance a Room; personal receipt reads use existing Proposal authority and filter deciding user. |

Technical qualification matrix (no production mapping enabled):

| Candidate type/group | Writer/effect boundary | Enablement still requires |
|---|---|---|
| `project_brief_publish`, `project_information_monitoring_activation/details` | Prepared replacement/frozen/cascade owners and canonical DB appliers | Review of the actual proposed operation mapping/authority/input/precondition/result contract; no permission changes here |
| `source_channel_activation`, `project_source_bind`, `source_backfill_start` | Canonical DB apply + existing transactional scheduler/Job intents; dependent requests included | Checkpoint5 Source consent/egress/activation semantics and a candidate-specific mapping review |
| `plan_review` and nested Plan/Workflow checkpoints | Prepared outer graph/Run/Proposal owner and original required Jobs | Actual operation mapping and live requester/approval preconditions; no new Plan/Agent grant |
| `knowledge_create` (Note/Inquiry promotion) | Canonical Candidate creation/applier and linked transition infrastructure | Checkpoint5 Note policy and checkpoint6/7 conversation/person semantics; Note draft excluded |
| Memory/import revisions and Skill package/bindings | Canonical payload/version/provenance, B10, complete Skill sibling set and original human review | Candidate-specific mapping contract/authority evidence; no direct Memory or Skill review bypass |
| `code_patch`, Evolution mixed members/rollback | Durable effect intents/Jobs and receipt-only canonical final DB writers | Independent review of this diff and future explicit mapping/operation contract; no current first-party grantable code-patch action exists |

No known current writer/effect gap from the eight-family inventory is left as a
permanent failclosed implementation substitute. This does not qualify arbitrary
new plugin/contributor appliers or approve any mapping. P5-4 remains in progress
until independent review and coordinator acceptance; subsequent checkpoints are
not advanced by these internal edits. Formal inventory stays636=565/39/32,
remaining550 after15 plugin paths; Note workspace projection548 is separate.

Final verification for basis7594f2ec: server13 distinct files/188 selected tests
passed across scoped runs (including final standalone14 and P1 approval37, with
30 P1 tests intentionally not selected); Web5 files15 tests and protocol1 test
passed. Node24 workspace dependencies, server/web types, server build including
official plugins, web build and diff check passed. Real Chromium2 journeys passed
(en/dark1280 and zh-CN/light390): actual Space-scoped Proposal list acceptance,
detail pending/read/compensation/success receipt, existing Job link, no second
accept. Four screenshots were generated; desktop pending and phone restoration
were inspected for readable wrapping, reachable controls and theme consistency.
Earlier browser attempts used the wrong unscoped route and timed out at Home;
those fixture failures are not visual acceptance. No live API/online DB was used.

P5-4 limited pre-submit review fixes (basis7594f2ec): standalone PG18,
Evolution17, Plan20 and Candidate12 pass (4 files67). Coverage adds actual
JobWorker definitive final policy/frozen refusal, repeated handler delivery with
one external write/compensation, failed-A/active-B/retry-A concurrent409 without
partial Jobs/state, and held Folder gate cleanup defer/attempt preservation and
subsequent convergence. The existing independent-edit refusal remains passing.
Policy refusal uses a real Project/Space authority downgrade; no durable DB,
policy decision or audit writer is mocked. One failed final audit is restored
under its original unique id and correlated to the worker decision. Earlier
fixture attempts (default write_patch denial is overridden by the canonical
approved-patch invariant) are not passes. The actual downgrade exercises the
canonical proposal.apply policy refusal instead.

The three converted INSERTs now retain their original NULL rationale (not new
explanatory prose). Generated Plan/Workflow checkpoints remain space_shared and
Candidate ownership/creator remain unchanged, with PG assertions at the real
parent entry points. No schema or wire/UI change is part of these review fixes.
Writer/effect DoD is implemented, pending coordinator acceptance; later permission
and mapping decisions are not checkpoint4 engineering gaps. None is enabled.

## P5-5 Note history/trash adoption (basis9d6613eb, awaiting independent review)

Codex took over the coordinator's unreviewed draft; this is not a dual-review
claim. The complete two-command history/trash subfamily shares core transactions
across retained REST/generic/browser calls. Current content/write authority,
Project writer locks and post-wait scope/ACL rechecks protect original and replay
calls. Agent surface remains excluded, even for a real valid manual Run with
explicit matching tool grants. Canonical body-free receipts cannot release old
content after an authority change; browser rereads in their bound Space.

New takeover fixes: canonical omitted/null expect_version fingerprint; canonical
malformed JSON/primitive handling with request-id/no-store headers; B11 audit
before historical whole-body release. Real PG tests cover conflicts/concurrency,
foreign/private/summary access, membership/owner/Project revocation and reparent
races, outbox/revision/request/policy/read-audit storage failures, derived-index
savepoint containment and unknown422→internal/no terminal cache. Trash emits no
new content revision, so its required atomic effects are status/request/policy;
revision/outbox rollback coverage belongs to the restore writer, not an invented
new trash event or external Job.

Validation: server5 files63 pass (Note control28, canonical writer8, Project
binding9, route inventory12, original object actions6), protocol2 files42 pass,
Web3 files65 pass including Notes parent/editor and receipt-Space API calls.
Node24 deps/server+web types and server build pass; no full-suite or visual
acceptance claim (no presentation change). Two initial PG command patterns named
nonexistent Project-binding files; they selected only controls/writer and are not
claimed Project evidence. The final run used knowledgeNoteProjectBindingDb.
An initial test incorrectly expected trash to emit a content-revision outbox;
the real canonical contract was verified and retained instead of changed.

Only two retained URLs are projected from legacy to core: working636=563/39/34,
remaining548 after15 plugin paths; committed HEAD remains550. No internal/read
fix decreases URL counts. P5-5 remains incomplete: other Note object/placement/
collection/promotion and Source object/activation/consent closures remain distinct
implementation work. The only current permission choice awaiting a person is
Note linking; it does not block those independent engineering scopes. No production
approval mapping, new Agent reach or public proposal.decide authority is enabled.

## P5-5 ordinary Note object family (basis4cf62800, awaiting independent review)

The ten retained Note create/edit/collection/placement/share-revoke/reorder URLs
are thin core adapters; old business handlers are removed. Existing canonical
writers and domain constraints remain singular. Root creation uses private
Personal/Project-shared placement, children use their authorized collection
context; a real granted manual Agent cannot borrow the new human entry. Source
creation guard regressions pass after the bounded draft addition. Memory,
canonical Knowledge promotion, consent/egress and public proposal.decide authority
are unchanged, and no production approval mapping is enabled.

Evidence includes REST/generic key replay, changed input, distinct-key version
concurrency, actual row-wait overlap with history restore/placement/internal Agent
ops, closure growth during folder deletion, Project-role transfer/rebind, current
private/Project/Space authority, real membership-row revocation, hidden blockers,
required B11 storage failure, new-root and edit root/extension/placement/revision/
outbox/request/policy rollback, derived projection savepoint containment and
unknown422 refusal without a cached request. Existing archive controls are not
silently narrowed; the active-Project refusal is typed at its actual access-owner
site, not by broadly matching HTTP409. Sharing decisions still require explicit
confirmation; owning-entry actionable metadata is preserved.

Route accounting: the exact regenerated working inventory is636=553 legacy/
39 exempt/44 core, remaining538 after15 plugin routes. HEAD remains548 until
commit. Exactly10 retained URLs migrate; internal lock/error/read fixes remove
no URL. Statefully bootstrapped metadata GETs are retained with their current
reader behavior and not falsely classified as readonly core queries.

Final scoped validation for basis4cf62800: server11 files164 pass (new Note
objects28; history/trash28; collections11; placements13; cross-Project shares16;
writer8; Project binding9; Project roles7; role guard5; Source creation port27;
route inventory12). Guide/boundary2 files13 pass separately. Protocol2 files43
and Web3 files68 pass. Node24 workspace deps, server/web types, server including
official plugin builds, web build and diff check pass. No full suite was run.
Existing React act warnings, the Source fixture pg query deprecation warning and
intentional derived-projection failure logs remain visible.

Actual local Chromium2 journeys (en/dark1280, zh-CN/light390) exercise the Notes
parent/editor, simulated lost command response, explicit Retry with the same
key and no second write, changed snapshot/new key, and current body reload;
English desktop also creates a collection and reads its current metadata. APIs
are intercepted fixtures, not live backend/DB. No presentation redesign or visual
appearance acceptance is claimed. Earlier missing-key/envelope legacy-test
failures were corrected to the explicit canonical contract while retaining
placement-state assertions; a cross-Project fixture was corrected to actually
use a second Project, not a normal Space folder. Those failures are not passes.

P5-5 Note ordinary review repair (still uncommitted on4cf62800): coordinator
reports the main diff independently reviewed; this is the scoped P2/N2 repair,
not another full-family review. Notes-kind reorder authorizes every input Note
before/after waits. Visible owning-entry refusals remain actionable but are not
cached; unreadable blockers return hidden404 with no title/id/count. Real PG
covers visible refusal/one recovered failed policy decision, same-key REST and
generic replay after privatization without Project membership changes, fresh-key
hidden refusal, no request/domain/outbox/placement partial writes, and a forced
root-row wait followed by privatization. Existing collection-delete shielding
continues to pass. Project admission is aligned with canonical folder-delete and
collection-order writers, with PG coverage for destination-only writer deleting
a shared entry and nonwriter same-parent ordering without reparent authority.
No new policy, Agent authority, link choice, schema or migrated URL is added.

New repair verification: shared real PG6 files88 pass (objects32, placements13,
collections11, cross-Project shares16, Project binding9, ordering7); guide/boundary
2 files13 pass after documentation edits; Web API consumer1 file21 pass. Node24
workspace-dependency build, server tsc --noEmit and diffcheck pass. Initial global
instead-of-request audit selection and old key/envelope consumer assertions failed
and were corrected; they are not passes. Intentional derived-projection failure
logging remains. No full suite, schema, frontend presentation change or new visual
acceptance claim; previous browser evidence is not represented as rerun here.

## P5-5 passage promotion / evidence Source family (basis1d156dfd)

Four retained commands are implemented, awaiting coordinator-owned independent
review. Core owns explicit keys, strict DTOs, current authority, policy/audit and
request outcome in the same transaction as the original domain writer. Promotion
creates a pending canonical knowledge_create Proposal, never a Knowledge item or
secondary approval. Minimal receipt/current Proposal GET preserves caller and
reviewer separation. Existing approved provenance and KnowledgeCandidate pinned
revision/revalidation tests are regression evidence, not migrated candidate URLs.
Source create/update/archive are ordinary evidence objects, not managed Channels.
Current Source body reads require B11 audit; no external work or required Job is
claimed by this DB-only family. No mapping/Agent/link policy was enabled.

Real PG covers REST/generic replay, changed input, same-key nonwaiting admission
and explicit subsequent replay, independent-key Source edits, Personal private
roots/default-null fingerprint, current private/foreign scope, actual Agent Run
refusal, Project membership revocation while waiting, Note scope growth under
root-row wait, pending payload/provenance/old receipt identity and Proposal/root/
extension/request/mandatory audit rollback. Unknown helper422 remains internal.
Full P5-5 remains incomplete; promotion/Source-link/candidate/activation/consent/
egress/material boundaries are listed precisely in the owner and original plan.

Scoped final evidence: knowledgeObjectOperationsDb19; existing notePromotionDb6,
knowledgePromotionDb12, knowledgeNotePlacementDb13, noteObjectActions6 and route
inventory12; guide/boundary13. Protocol operations21; Web API22 and parent editor
mount11. Node24 workspace dependency builds, server/web noEmit types and diffcheck
pass. Initial invalid private-owner fixture, incorrect expectation of waiting
same-key admission, wrong test header and generic500 B11 audit refusal were fixed;
those failures are not passing evidence. No full suite or actual browser/visual
acceptance was run: this batch changes transport/result retrieval, not rendering.
No required external Job exists here; invalid-material-attempt/external-worker
failure tests are not falsely claimed as this family's new evidence.

## P5-5 curated evidence and Candidate review (basis1d16069e)

Nine retained commands are implemented for independent coordinator-scheduled
review, not declared reviewed by local verification. Actual FK-backed evidence
add/remove, three manual Candidate creation variants, decision/reopen and review
packet open/close share canonical writers with their formal/generic entries.
Typed Knowledge Review consumers fetch current Candidate/packet state after
body-free receipts; no private proposed text or blocker metadata is cached.

Real shared-PG evidence covers retained REST/generic replay, changed input,
original unlink replay after a new association, distinct-key citation uniqueness,
forced same-key decision admission before a root wait, distinct-key decision
serialization, private/selected-user summary/full/revoked/oversight and real
foreign Space/Agent refusal, scope growth, source soft deletion, packet/state
transitions, converted Interpretation and Thread revision pins, Proposal/request/
audit/result-store rollback with unique failed recovery, and B11 quote audit
failure. A full-read source grantee may create the original owner's private
Candidate without gaining review/read authority over it.

Full-chain acceptance exposed and fixed copying a shared source owner's identity
into a different submitter's new Knowledge payload. The canonical creator-owner
invariant is preserved, source/Candidate authorship and provenance stay pinned,
and actual ProposalApply role gates remain unchanged. Target Project admission
now takes its existing aggregate update fence before root locks, eliminating a
real shared-to-exclusive upgrade deadlock without retrying or accepting503.
Current archive conflicts use the concrete archived owner error, not HTTP409
classification. No new schema, external effect/required Job, Memory writer or
approval mapping is introduced. Remaining checkpoint5 work stays explicit in
the original plan; this is not whole-stage acceptance.

Scoped evidence for this batch: new knowledgeReviewOperationsDb23 real-PG tests;
existing knowledgePromotionDb12 (including legitimate Agent/selected-user audience
and pinned revalidation), knowledgeGroup17, inventory12 and guide/boundary13 pass.
Protocol operations22 and Web API/current Project review parent surface30 pass.
Node24 dependency builds, Web noEmit types and diffcheck pass. Earlier server
noEmit passed before parallel Host edits; the final workspace server check fails
with8 errors in unrelated hosts/acpToolPresentation.ts, threadEventNormalization.ts
and threadEventRepository.ts (ToolCallDetails export, unused summarizeToolOutput,
missing MAX_TOOL_RESULT_SUMMARY_CHARS). Those parallel files are preserved; final
workspace types are not reported as passing. No full suite
or browser/visual acceptance was run; rendering is unchanged. The first cross-author
acceptance failure and concurrent503 were actual defects repaired without relaxing
those assertions. The grant fixture was corrected to selected_users (a private
row does not grant access by adding a grant). Early unused-variable/root-package
command failures are not passes. Required external Job failure is not claimed:
these commands are DB-only and extraction-worker dispatch remains a separate entry.

### Scoped review repair on1d16069e (no new family)

Candidate source-dependent admission now applies only to creation/actual promote.
Dismiss/defer/reopen retain original Candidate visibility/Project-writer/state
rules even after source soft delete, purge or privatization. Evidence unlink
retains original Knowledge-owner cleanup authority and exact link binding, without
requiring source read/full access; add and both-endpoint B11 reads stay protected.
Minimal old unlink receipts never delete a newly inserted relation. Supersession
uses canonical create()'s original readable-reference predicate and shared root
lock, without imposing full-body or extra Project authority. Packet clamp inputs
normalize before fingerprint; follow-up browser ids are encoded.
New real-PG cases use a reviewer who is not the source owner, include Thread
sources, unchanged pinned history, original-key REST/generic success, current
Project/Candidate refusal and missing/private-source promote refusal. No private
body or new approval/request partial outcome is introduced. Previous parallel Host
workspace errors are historical: current dependency build/server types rerun now
passes after parallel work; no Host/schema0015 fix is part of this repair.

New repair verification: shared-PG review file33 tests (10 added), original
Knowledge promotion12, inventory12 and guide/boundary13: five server files70 pass.
Web API25 plus Project review parent6:31 pass. Current Node24 dependency build,
server and Web noEmit checks pass; prior eight Host type errors no longer reproduce
in the current parallel workspace, and no Host/schema0015 repair was made here.
The seven repair files pass scoped diffcheck. Global diffcheck still flags only
parallel ConversationTurn.tsx:252 (new EOF blank line), preserved and not counted
as a clean whole-workspace check. No full suite or new visual/browser claim.

## P5-5 Candidate extraction queued command/worker closure (basis5c407024)

The existing extraction POST/generic/typed Review command share canonical queue
and source resolver, not a new execution engine. The minimal202 queued receipt
binds the original Run, never a later source revision. Source snapshot, current
Agent/Profile, Run/required Job, B11/policy audit and operation outcome remain one
transaction. Real-PG coverage includes formal/generic replay/defaultnull/changed
input, independent intent keys, scope growth under a real row wait, current Agent/
Project/foreign Space/source ACL, real Agent-command refusal, private snapshot
Run visibility, source-read audit and terminal request/Job storage failures.

The original terminal reconcile worker publishes Candidate rows and its durable
Run-event receipt together, including zero results for revoked/unavailable sources.
Actual JobWorker tests cover non-attempt-consuming defer under a held Run row,
subsequent and duplicate delivery, publication receipt failure rollback and Worker
ACK/result-store failure followed by receipt recovery without duplicate rows.
Run execution and costs remain historical; no model/Host/network IO occurs inside
publication or the core transaction. Existing Run orchestration dispatch seams
also check the extraction source before external execution; revoked dispatch is
not confused with a completed extraction. No new schema or event vocabulary was
added: the existing action_completed event/writer carries a named domain receipt.

This closes this extraction owner family only. Managed Channel/Recipe activation
have distinct existing Agent proposal and human envelope semantics, and consent/
egress/material invalid attempts remain independent checkpoint5 work. They are not
claimed complete, nor is checkpoint5. Human Note-link permission is resolved; core migration remains separate work.

Scoped evidence: new knowledgeExtractionOperationDb19 real-PG tests pass, existing
knowledgePromotionDb12, operationRoutes12 and Run orchestration unit regression60
pass. The unit tests are not durable-DB evidence. Protocol operations23; Web API26
and Project Review parent6 pass. Node24 workspace dependency build and server/Web
noEmit checks pass; no browser/visual acceptance or full suite was run. Initial
unsupported event type/actor-FK attempt was corrected to the existing event model;
Run routing/owning-entry and scheduled-time fixtures were corrected to valid
production shapes, without relaxing success/defer or current-ACL assertions.
Job rescheduling uses a clearly expired time to avoid PG microsecond/Node millisecond
boundary flakiness. No schema/migration was added; parallel0015 is excluded.

## Project 123-URL total package — incomplete implementation evidence

The exact five-group 4335ee20 mapping and per-route status are in the original
P5 execution ledger preserved in Git at `a37ed3b36ca475a91d1fa870429ca1b2ba2daf09`
(section “Project total package — 4335ee20 baseline continuous implementation”).
Eight Research workspace commands use the existing core and canonical DB writers;
Candidate extraction remains the reviewed draft with finite source-table lock and
terminal Worker recovery evidence. These are 9/123 implemented writes; 114 remain.
There is no unified Project-package review or stage acceptance yet. No production
approval mapping, Agent grant or public proposal decision permission was enabled.

`researchWorkspaceOperationDb` uses real PostgreSQL for cross-transport replay,
P1 same-key nonwaiting conflict then explicit replay, distinct-key ordering, current
Project revocation, Source privatization and scope growth, Claim uniqueness,
body-free receipts/current reads, unknown Http422 no-cache rollback, NoteWriter
outbox rollback and mandatory audit/request/result failure. Original Research area
and screening tests remain domain-consumer evidence. Extraction tests additionally
exercise an interpretation row fence and actual terminal agent_run redelivery,
without a second model execution. Tests are implementation evidence, not reviewers'
execution claims; the final exact run results are appended to the original plan.

Project-package continuation adds research.intake.limit, research.standing.dismiss
and research.standing.retry to the same human-only workspace core adapter. Limit
configuration uses the canonical Workflow writer; retry persists the existing
standing dispatch Job in the receipt/audit transaction and retains the original
pending/running/finished semantics. Dismiss does not require Source content access
that the original cleanup did not need, and caches no advice detail. Browser
standing controls refresh their existing parent status surface; limit editing
reads the exact receipt Workflow. Subsequent parallel implementation brings the
HTTP total to 70/123; 53 baseline Project URLs remain legacy. Precise verification
and file ownership remain in the original P5 plan.

The parallel batch includes two further Research commands, 21 Inquiry HTTP
adapters, 11 Experiment commands, five Folder DB controls, two monitoring controls
and 17 Project/Decision commands. New real-PG evidence protects replay, authority
revocation, concurrent key/resource locks, canonical domain outcomes and rollback
of domain/Run/Job/receipt/audit effects. Browser API and existing parent-surface
tests check the changed consumers; presentation components were not changed and
no visual acceptance is claimed.

The five overlapping Agent capabilities (`inquiry.record_work`,
`inquiry.close_round`, `inquiry.record_conclusion`, `inquiry.link_task`,
`inquiry.reference_task_result`) now use core registrations under the same old
IDs, immutable Run grants, effective origin, provenance and trusted attempt/call
identity. The old callbacks are removed; direct Dispatcher and CLI entry points
share the existing operation adapter. Eleven additional real-PG cases protect
all five manual success/replay/grant-revocation paths, all five unattended
failclosed paths with no Proposal/domain effects, and Task attempt isolation with
refusal of model-injected trusted keys. InquiryOperationDb passed 23 cases in the
first complete Agent run; original direct-write, Task-association and gateway
consumers passed alongside it (4 files / 53 cases total).
No unified five-package independent review has run; all production operation
approval mappings and existing Agent authority remain unchanged.

The subsequent parallel continuation reaches **94/123** retained Project HTTP
adapters, with **29** still pending. Research is 16/32, Inquiry 21/21,
Experiment/Folder 24/24, ingress 6/14 and management 27/32. The working inventory
is 636 = 446 legacy + 39 exemptions + 151 core; P5 legacy excluding the unchanged
15 plugin writes is 431. These counts do not change formal committed acceptance.

Additional evidence covers Project lifecycle linked-request rollback and replay
after reactivation; private Ask AI/Notebook Source/Note authority at dispatch and
publication; snapshot Workflow/Thread/Source privacy across Run, detail and list
reads; canonical Corpus source provenance; binding-history Proposal bundle
rollback; and summary owner/version/Run/Room gates with atomic search projection
and required embedding Job. Folder IO adds private durable intents and the
existing Job worker boundary, exact-hash uncertain-effect recovery, refusal to
overwrite independent edits, cancelled-Job recovery and terminal body cleanup.
The generated Folder intent migration is a new schema change in this continuation.

Core/Dispatcher/Synthesis/boundaries/migration-artifact verification passed
107 cases, combined protocol contracts passed 66, route/guides/hygiene passed 32,
and schema:check passed. Exact domain, browser and final build evidence is kept
in the original P5 plan's continuation rather than inferred from inventory
metadata. Cross-checking identified and fixed source-origin binding and cached
channel-retirement races, and Folder uncertain-effect/cancel recovery gaps.
These engineering cross-checks do not replace the planned independent
Claude/Antigravity package review; no stage acceptance or production mapping is
enabled by this continuation.

### Project package — remaining 29 URL closure (working tree on 886b1aaf)

The final 29 Project rows are settled: 28 retained URLs are formal core adapters
and the unused `POST /projects/public-summaries/search` endpoint is retired with
its only test caller (Agents keep the separate `project.summary.search` tool).
Inventory is 636 = 418 legacy + 39 exemptions + 179 core, with no Project legacy
row; excluding the 15 plugin writes leaves 403 P5 legacy entries.

- DB-only commands (15 Research controls, Corpus rebuild on two URLs, five
  monitoring and two Source-proposal commands, private summary feedback) reuse
  the owning writers inside the core transaction. Workflow/Thread/Operation
  closures are discovered read-only, locked after the Project writer lock and
  rechecked; Run-owning paths declare the host Run-terminal owner. Deterministic
  domain 409/422 sites are marked explicitly; other errors stay uncached.
- Provider-backed writes are admission + durable work, never provider IO inside a
  core transaction: public-summary draft queues a private `provider_task` Run; every
  provider attempt re-checks writer authority and the complete frozen source
  closure (no oversight) after admitting every Project it names in one id order
  (own Project exclusive, others shared; a Project reached later refuses 409) and
  share-locking the rest, at the access level each frozen
  body needs (full→summary refuses a frozen excerpt/rationale), and finalize writes the draft with server-authored
  `generated_by_run_id` and the Run's success in one Run-terminal-owner
  transaction, only while that Run is still `running`; imported
  history extraction commits its claim with a Job, the worker refreshes the claim,
  releases unshared records and writes the canonical Brief/memory proposals;
  question refine commits the pending turn with its frozen request and a
  single-attempt Job, and the worker recovery pass fails a pending turn whose Job
  was cancelled or reclaimed-exhausted without re-enqueuing it, and completion is
  fenced on the Job's running claim/attempt so a late provider return after
  cancel/reclaim writes nothing; each completed
  assistant turn carries its own refinement and only the newest completed turn
  replaces the session projection; the
  public-summary Context Brief runs in a requester-owned Job.
- Evidence: `researchControlOperationDb` (13 real-PG cases, including incremental
  trigger with named scanned items: business-key replay across transport keys,
  transport-key reuse refused, unmonitored/unknown/revoked/summary-only items
  refused, list bound, another Workflow's business key 409),
  `publicSummaryDraftOperationDb` (20: admission/idempotent finalize, revoked source closure, cancelled Run and
  rolled-back terminal failure, grant revocation held mid-transaction against
  attempt and publish, a checked attempt holding off revocation, Room removal
  held mid-roster-transaction, Activity and Proposal full→summary through the
  content access policy, summary-level admission by title; research-call output
  Artifact admitted by title and refused after its researched Source narrows
  full→summary, researched Source grant revocation held mid-transaction against
  attempt and publish, a checked attempt holding off that revocation, research
  closure growing while the attempt waits (409 rebuild), a Run frozen
  without levels; and over real connection → channel → subscription → window →
  item chains: two Projects whose research read each other's Sources attempted
  and published concurrently behind a held Space row (deadlocked on the prior
  order, both succeed now), a connection revocation in the other Project held off
  by a checked attempt and one held mid-transaction against attempt and publish,
  a closure growing into a third, externally locked Project refused 409 without
  waiting on it, and a research request's Room removal held mid-roster against
  the attempt), `projectSummaryBriefOperationDb` (2), extended
  `importedSessionsExtractionDb` (+2), refine route suite (+5: cancelled Job,
  dead worker reclaim, concurrent turns, provider call held open across reclaim
  and across cancel then released before the sweep), the web receipt-turn consumer case,
  adapted acquisition HTTP suites, plus the unchanged domain
  suites recorded in the original P5 plan. No production approval mapping, Agent
  grant or public proposal decision permission is enabled.

### Project package — verification gate on 06cf3cfc (2026-11-10)

The checks below were run by Claude on the full candidate (71 files over 886b1aaf), with Node 24
and the shared real-PG test container. Every check passed except the
server suite's exit code. All 7,616 server tests pass (5 smoke tests are skipped as usual). The
unchanged budget reporter still exits 1, because `pluginFrontendDb` takes
48.8–52.0s against the 30s per-test limit. That test is ~24s run alone, and has been 48–88s
in every full run since 2026-11-08 on unrelated branches, so the overrun predates this
candidate rather than coming from it. Halving the worker count did not remove it. No threshold, reporter or coverage was changed,
so the full server gate is **not** green. Exact commands and counts are in the
P5 execution ledger preserved in Git at `a37ed3b36ca475a91d1fa870429ca1b2ba2daf09`
(section “Project package — verification gate on 06cf3cfc”).
The Codex run reviewed all 71 files / 29 routes statically and found no executable blocker. That is not test or global acyclicity
evidence. Antigravity has not reviewed (quota exhausted), so there is no dual
review. This does not complete P5 or the four packages.

### Project package — review completion and accepted verification exception (2026-11-10)

Antigravity subsequently reviewed the full 71-file / 29-URL candidate
248b88d2 independently and reported no new actionable blockers. Codex and
Antigravity reviews were static, not independent test executions. The user
explicitly accepted the existing pluginFrontendDb duration-budget failure and
authorized committing this block and continuing in the previously agreed order.
The server suite still exited 1; this acceptance does not turn that check green
or change its threshold. Project implementation/review is complete for this
block (28 adapters migrated, one unused search URL retired). Remaining work now
moves to Agent/Room, then Host, then system settings/tool configuration. No shared
branch publication or deployment is implied by this local commit authorization.

## Agent/Room block (working tree on fb827016)

All 59 in-scope Agent, Agent-role, Room, Agent-group, Run and direct-session
write URLs are settled: 58 formal core adapters and one reviewed transport
exemption (`POST /runs/:runId/tools/:actionId`, the Run bearer-token Agent tool
transport). Inventory 636 = 359 legacy + 40 exemptions + 237 core; `host-state/reset`
and the `/me/agent-attention/*` markers stay with the Host and personal blocks.
The Agent tools `research.start_acquisition` / `research.adopt_result` are
core-owned. Behavior, IO placement and retired transport replay tables are
described in [SYSTEM_ACTIONS](SYSTEM_ACTIONS.md#agent-and-room-commands).

Evidence (shared real PG unless noted):

- `agentOperationsDb` (7): Personal/Project placement, formal/generic same-key
  replay and changed-input 422, kept definition policies, identity+config
  rollback on an invalid field, owner-only edits hidden from members, version
  restore, Runtime Profile credential/egress refusal, explicit-null clears,
  cached default conflict, Space default and Assistant configurer gates,
  server-owned Run origin, template creation, direct reset 409 during dispatch.
- `agentChatOperationsDb` (4): session+message+Run+Job in one transaction with
  replay, frozen restore request, Job-insert failure rollback, hidden sessions /
  Agents, retry once per key keeping the restore request; `promptProvenanceAcceptanceDb`
  direct turn and retry through the synthetic ACP Host and real worker;
  `remoteHostCliAdapter` restore-before-launch and no launch on a failed restore.
- `roomsDb` "Room commands through the operation core" (4): Room create replay
  across entries, personal-Room reuse, viewer hidden; private-share refusal
  metadata, roster receipts, owner self-removal refusal, outsider hidden; turn
  send/queue/withdraw receipts with structured `conversation_turn_in_progress`;
  Agent-group create/edit/message (restated `group_id`)/pause/resume/cancel;
  the discussion route test under the Run terminal owner and the quota route.
- `runOperationsDb` (4): `run.execute` queues a Job (no synchronous execution,
  `?runtime=` still refused), stop settles before the reply, abandon under the
  terminal owner with a linked Proposal request plus after-commit finalization,
  resume with its Job; `runtimeContextDeliveryDb` live input through the core
  (record, deliver after commit, delivery read); `sharedAuthorizersDb` and
  `quotaRecoveryDb` standing and race through the adapters.
- `sessionOperationsDb` (2) and `conversationExecutionContextDb` (+1): placement,
  message/reflect (pending private `memory_create`), delete, hidden foreign
  conversations, read-only preflight/GET writing no draft row, keyed initialize.
- `researchOperationRepairDb` / `agentIdDiscoveryReadsDb`: Agent acquisition and
  adoption through the core (call-key domain key, replay, key reuse, grant
  revocation, Run provenance) and the visible-Thread hint.
- Web: typed helper tests (`chat-api`, `conversation-scope-api`) and the Chromium
  `runtime-recovery` / `workspace-concurrency` live-input flows use keyed
  commands and reads.

No production approval mapping, Agent grant or public proposal decision is enabled.

### Agent/Room review repairs (on candidate 72f5ff4a)

Two independent reviews of the block found reproducible gaps; all seven are
repaired, and every after-commit effect of the block was re-audited for durable
recovery. Behaviour is described in
[SYSTEM_ACTIONS](SYSTEM_ACTIONS.md#agent-and-room-commands).

| Finding | Repair | Evidence (shared real PG unless noted) |
|---|---|---|
| Room authorize applied roster visibility to every command | `room.invitation.decide` / `room.owner.claim` admit and replay on Room visibility or `hasRoomCommandStanding`, re-read each time | `roomsDb` special-standing case: non-member approval owner decides, same-key replay, exact invitation read, replay 404 after Project access revoked, unrelated reader 404, non-member Project owner claims and replays; negative control without the fix returns 404 |
| `room.agent.add` restore lived only in after-commit memory | `room_agent_workspace_restore` Job committed with the membership (exact thread/Host/conversation, one pending per thread) | `roomsDb` restore case: no Host call in the command, replay adds no Job, offline/timeout/unsent defer under one operation identity ordered after the archive, restore, empty restore noticed, `live_conflict` and missing Host capability definite, a week unsettled warned once and still pending until the receipt settles it, removed-before-run `withdrawn`, newer thread `superseded`; `managedWorkspaceRestoreHostDb` drives the daemon's real journal on a real filesystem: crash between workspace and profile, lost reply, server crash before Job completion, a held archive delivered after the restore, and a fenced older generation |
| Live input delivered once after commit, pending forever on loss | `run_live_input_deliver` Job committed with the message; exact-binding owner delivers; recovery settles inputs of non-running Runs | `runtimeContextDeliveryDb`: missed first attempt stays `pending` with its Job and is delivered later; binding replaced → `not_injected`, nothing enters the new binding; stranded input settled once by recovery, running Runs untouched |
| Injected input recorded `not_injected` when its acknowledgement failed | durable claim before injection; acknowledgement never rewrites the outcome and is retried before finalization | PG trigger fails the acknowledgement write: outcome `injected`, Job retry injects nothing; a claim without outcome settles `unconfirmed` without injecting |
| `run.resume` replay refused 409 once queued | visibility-only authorize; state/authority in execution; replay re-checks current standing or approval authority for the granted `risk_level` | `runOperationsDb`: supervisor resume replays 202 with one Job, new key 409; approval resume records `risk_level`, replays, 404 after the role loses approval authority |
| Group resume wake lived only in after-commit memory | `agent_group_resume_wake` Job committed with the status | `roomsDb` wake case: Job-only wake, replay adds none, repeat queues no second Run Job, cancel before wake and lost management wake nothing; an injected management-read failure leaves the Job pending and a later attempt wakes |
| Browser read-backs used the newest 200 invitations/messages | exact `invitation_id` / `message_id` reads under the page's access | web `conversation-scope-api`: decision and continuation read their own old object; live input stays `pending` instead of `not_injected` |

After-commit audit: archive intents (`pending_archive_at`) are also retried for
Hosts that stay connected (`retryPendingArchivesForConnectedHosts`,
`roomAgentHostStateRestoreDb`: online-only, acknowledged once, fresh intents
left to their first attempt); `run.stop`, `run.abandon` / `run.finalize` and
native workspace integration already had sweeps or Jobs. Trailing blank lines
at four documentation/test EOFs were removed, and a `roomsDb.suite` type error
(`it.each` context) was fixed with `it.for`.

### Agent/Room verification close-out (2026-11-10)

Production candidate: `77c72840`; block base: Project commit `fb827016`.
Codex (`d38ba8f0`) and Antigravity (`ce45081d`) independently reviewed the
whole candidate and reported no new actionable code blockers. Their static
reviews are not evidence of executing the suites.

The coordinator ran the complete server suite in this worktree using Node
24.22.2, real shared PostgreSQL, and
`REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run --maxWorkers=4`
from `server/`, after building the web app. Result: 606 files passed, one
skipped; 7629 tests passed, five skipped, zero failed. Exit 1 is retained:
the unchanged budget reporter flags pluginFrontendDb (55.1s / 30s) and the
killed-worker deep-reading recovery case (33.4s / 30s). The person explicitly
accepted duration-budget overruns on 2026-11-10 and instructed continuation
when tests do not fail. No budget, reporter, coverage or production code was
changed to obtain this result. A prior missing-web-build Task Detail failure
passed after building the actual web app (23.0s); the earlier sandbox run
without Docker access, which skipped database tests, is not acceptance evidence.

Same-candidate implementation-run terminal evidence additionally records:
protocol 442 passed; web 2515 passed; daemon 779 passed / 22 skipped, all exit 0;
protocol/daemon/server/web type checks and web build exit 0. Focused daemon
filesystem tests cover concurrent drains and file/directory fsync failure and
retry; real-PG/daemon restore tests include the held legacy direct-restore
request across an upgrade. Runtime logs remain outside the repository
(`/tmp/rv-logs/c93`, `cb71-*`, `parent-server-pg4.log`).

Browser limitation: the 18-file comparison has nine failing groups on both
candidate and the earlier c7 candidate, not a green browser suite. The recorded
failure-name comparison has no candidate-only failures (reader journeys has
three versus four). The 62 differently formatted messages normalize to the
same assertions; an inspected recovery-fixture API error is identical on both
sides, and that API call already exists at Project base `fb827016`. Because the
comparison base already contains migration changes, this alone does not prove
absence of every browser regression against the Project base. These failures
remain explicitly recorded; they are not reported as passing tests. Host and
settings/tool migration blocks remain outstanding.

## Host block (working tree on 1127954190bd)

All 32 Host-, Location- and execution-host-owned write URLs are settled:
20 formal core adapters (13 durable Host commands, 7 transactional) and 12
exact exemptions. Inventory 636 = 327 legacy + 52 exemptions + 257 core. The
exact list, the fourth-block boundary and the narrowings are in the
[P5 plan](#p5-closeout);
behaviour in [SYSTEM_ACTIONS](SYSTEM_ACTIONS.md#host-commands) and
[hosts.md](../modules/hosts.md), section "Host commands".

Evidence (shared real PG unless noted):

- `hostCommandWorkerDb` (10): unsent first send returns to pending then one
  effect with exact result and runtime-change readback; unjournaled lost answer
  `needs_attention`, never resent; dispatch marker without a known send is
  unknown; journal `interrupted` / `mismatch` / `refused` / not-ok mapping;
  journaled repeat across disconnect, offline and timeout with one identical
  frame; revocation before send (failed, transport replay 404) and during send
  (needs attention, result withheld); actor removed from the Space; cancelled
  Job before/after send; transport key replay vs `host_command_busy` vs
  `idempotency_key_reused`, other member / other Space hidden; Location
  registration under Project write with the private path dropped once settled.
- `agentHostStateResetDb` (9): hidden Host/Agent, receipt capability required,
  ownerless Agent, dispatch-lock and in-flight Run refusals, unfinished Room
  restore refusal with rollback, fence while offline / answer lost, replay of
  the same command, cancelled-after-send fence.
- `remoteHostCliAdapter`: a pending reset blocks a direct turn's restore and
  the launch before any Host frame. `roomsDb` restore case: the restore Job
  defers on an unsettled reset without a Host request.
- `hostsRoutes`, `builtinHostRoutes`, `hostOrdinaryToolsRoutes` (egress route
  dropped once settled), `hostOrdinaryToolAccountsRoutes`, `hostRuntimeUsageDb`,
  `importedSessionsDb`, `acpAgentsRoutes`, `operationExecutorDb` (catalog),
  `operationRoutes` (exact exemption pairs and inventory).
- Daemon `hostCommandJournal` (8, real filesystem with the durable-IO seam):
  start fsynced before the effect and outcome before the answer, replay in a
  restarted process, concurrent repeat runs once, mismatch, interrupted never
  re-run, interrupted reset finished by running again, unrecordable start
  refused with no effect, unreadable receipt refused, prune keeps in-progress.
- Web: `host-command-api` (real client, stubbed HTTP: keyed command, status
  polling in the receipt Space, needs-attention error, no resubmit, logout
  readback, transactional outputs) and `HostAgents` (unknown install outcome
  shown as an error, never as installed).

No production approval mapping, Agent grant or public proposal decision is
enabled. Browser (Chromium) suites do not cover Host surfaces; none were run
for this block.

### Host block fix checkpoint (review 319dfcc7, four blockers)

Source parent `809a0cfe` (tree identical to the Host candidate `7aea6597`,
`c517a46a`); formal base `1127954190bd`. The Project (`fb827016`) and
Agent/Room (`11279541`) migrations are unchanged by this checkpoint.

1. Receipt durability (`hostCommandJournal.ts`, protocol `HostCommandOutcome`):
   `completed` only for a durably `done` receipt. The final write is retried,
   and a replayed `done` passes `syncExistingDurable` first; otherwise the
   answer is `unrecorded` (new outcome, no result), the outcome is held in
   process memory and a repeat records it without a second effect. The worker
   reads `unrecorded` as not answered (repeat, no `effect_json.receipt`, so the
   reset fence holds), and `reconcileEarlierResets` reads it as `waiting`.
2. Stale settlement redaction: `settleStaleHostCommand` (cancelled / exhausted
   Job) applies the shared `REDACTED_FROZEN`, exactly like the worker's
   terminal writes; ids the read authority needs are kept.
3. Unsent expiry: checked inside the dispatch transaction before the first
   send, online or offline (`host_command_expired` / `host_offline`), so no frame
   is sent; a sent command is never settled by it.
4. Partial history replay: `AmbientSyncReport.partial_sessions` (defaults to 0
   for older recorded reports); a written `load_state: partial` session sets the
   report error → `needs_attention` `ambient_sync_partial` with the real report,
   not repeated; the panel never shows it as success.

Evidence (Node 24.22.2, the pinned engine; shared real PG, none skipped):

- Daemon `hostCommandJournal` 12/12 (real filesystem, faults only through the
  durable-IO seam): file-fsync failure retried, then `completed`; persistent
  file-fsync failure → `unrecorded` with the receipt still `in_progress`,
  concurrent repeats single-flight and still `unrecorded`, then `completed` once
  the write succeeds, effect once; directory-fsync failure after rename →
  `unrecorded` in the process and after a restart (replay barrier), then
  `completed`, effect once; an unrecorded reset is not re-run in its process and
  is finished by a restarted process.
- `agentHostResetReconcileHostDb` 6/6, including real journal + real
  `archiveAgentProfiles`: an unrecordable reset keeps the command `dispatched`
  and the fence closed; after a daemon restart the repeat finishes it and its
  own receipt opens the fence; a late copy then only replays and a profile
  created since stays live.
- `hostCommandWorkerDb` 16/16: unsent >10 min with the Host online → `failed`
  `host_command_expired`, no send, no runtime change; sent before expiry and
  older than 10 min → identical frame repeated → `succeeded`; `unrecorded` twice
  → `dispatched`, no receipt or result, then `completed` → `succeeded` with one
  runtime change.
- `hostCommandAuthorityDb` 16/16: cancel and exhaust, sent and unsent,
  `workspace_register` / `ordinary_tool_register` / `ordinary_tool_install`,
  settled through the status read and through a barrier transaction: no `path`,
  `operation.path` or `egress_transport` (credential proxy URL) remains, and the
  same kept ids as a normal terminal write; a live Job is not touched. Partial
  import through the real connection registry, with daemon frames parsed as
  `HostDaemonFrameSchema` (`ambient_import_result` `ok`, one session
  `load_state: partial`) → `needs_attention` `ambient_sync_partial`, report
  `sessions_written 2, partial_sessions 1`, both sessions committed (one
  `partial` with its error), not repeated by its Job; a later full sync →
  `succeeded`, no duplicates, no partial left.
- `agentHostStateResetDb` 9/9, `importedSessionsDb` 33/33.
- Web 37/37: `AmbientSessionImportPanel` (new: a partial report shows an error
  naming what it kept, never success; a whole import shows success),
  `host-command-api`, `HostAgents`.
- Typecheck: protocol, host-daemon, server (`tsconfig.typecheck.json`), web;
  protocol suite 442/442; `agentGuides` 8/8.
- Mutation checks: reverting each fix makes its new tests fail (journal 3,
  reconcile 1, redaction 1, partial 1, expiry 2). The worker's `unrecorded` line
  is explicit for clarity: its fall-through was already "not answered".

Not run: the full suites (deferred to the block's final pre-commit gate), and
browser (Chromium) suites (none cover Host surfaces). Under Node 25 the web
jsdom suites fail on `localStorage.clear` (environmental); the pinned Node 24
run above passes.

### Host block final pre-commit gate (2026-11-11, on `edbbba21`)

Candidate `edbbba21` (tree `a58ac828`; source parent `809a0cfe`, formal base
`1127954190bd`; Project `fb827016` and Agent/Room `11279541` unchanged).
Codex (`59533e86`) and Antigravity (`88e76b0b`) reviewed the whole block with
no new actionable blockers; that static review covers `edbbba21`, not the
gate repairs below. Node 24.22.2, shared real PostgreSQL (testcontainers,
`REQUIRE_TEST_POSTGRES=true`). The worktree path contains `:`, so pnpm cannot
put `node_modules/.bin` on PATH; each command ran as `node <pkg>/node_modules/…`
in the dependency order of COMMANDS (protocol, outbound-guard, folder-read,
reader-document, agent-cli builds → server → daemon → web). Logs:
`/tmp/rainver-gate-edbb/` (`summary.txt`, per-command logs; `targeted/` for
the repair re-checks; scripts under `scripts/`).

Full runs on `edbbba21` (unchanged tree):

| Command | Result |
|---|---|
| builds (5 workspace deps, server, daemon), server/daemon/web typecheck, web build | exit 0 |
| daemon `vitest run` | exit 0: 72 files passed, 2 skipped; 791 tests passed, 22 skipped |
| web `vitest run` (alone) | exit 1: 2523 passed, 2 failed (`ProjectExecutionAreas` Pulse badge ×2) |
| server `vitest run --maxWorkers=4` | exit 1: 7669 passed, 2 failed, 5 skipped; 607 files passed, 1 skipped |

Failures, located and handled:

1. `hostFolderReadRegistry` expected `host_offline` for a generic Host action
   lost to a disconnect; the block deliberately answers `host_disconnected`
   (sent, outcome unknown). Stale expectation updated. Tracing its callers found
   `POST /hosts/:id/browse-directories` still mapping only `host_offline` /
   `host_timeout` to 409, so a disconnect mid-listing became a 422 with a raw
   code: **production fix** (`hosts/routes.ts`, one condition), new
   `hostsRoutes` case (409, `code: host_disconnected`); reverting the fix fails
   it (422).
2. `operationFaultsDb` pre-core case: the immutable `95d61d90` server source no
   longer compiled against the current protocol because the fix round declared
   `AmbientSyncReport.partial_sessions` `.default(0)` (required in the inferred
   type). **Protocol/production fix**: `.optional()` (nothing parses the schema
   at runtime on the server; older recorded reports lack it; the web panel
   already reads `?? 0`; `needs_attention` is decided by `report.error`), and the
   single writer increments `(partial_sessions ?? 0) + 1`.
3. Web `ProjectExecutionAreas` (Project block, untouched by Host): fails only
   under the full parallel run; alone 3/3 passes (5/5 tests) and the whole
   `src/modules/projects` directory passes 383/383. `ProjectAreaLayout` and
   this test are identical in the formal base `1127954` and the candidate.
   Located afterwards as a test synchronization race; test-only repair, no
   production change. Both failed cases waited 15s for a badge refresh that
   never came: the triggering event was lost. Cause: the tests fired it
   (`notifyReviewAttentionChanged()`, or the captured SSE `emit`) as soon as
   the badge showed `2`. React commits that text before it runs the commit's
   effects. Both the review-event listener bound to the loaded Project and the
   `useProjectLiveRefresh` subscription are attached by those effects. On a
   loaded event loop, RTL `waitFor`'s `setTimeout(0)` drain can resolve
   before React's scheduler task. The event then reaches the pre-load listener
   (`loadedScope !== scope`, returns) or the not-yet-captured `emit` no-op.
   Measured with a scratch probe (deleted) rendering the layout 80× under
   64 busy-loop processes on 32 cores: the subscription was missing when the
   badge appeared in 1/80 (2/60 in an earlier run). The review event was lost
   in exactly those cases (1/80). After waiting for the subscription request,
   it was missing 0/80 and lost 0/80. Unloaded: 0/40. A second, cascading
   defect: a failed review-event case left its unconsumed
   `getOverview.mockResolvedValueOnce` queued (`vi.clearAllMocks` keeps
   it), which the next case inherited. Repair (test file only): wait for the
   badge **and** `streamUpdates('project-1', …)` before firing the event. Both
   effects belong to the same commit, so the call shows the listener is
   current. `getOverview` is `mockReset()` in `beforeEach`. No sleep, timeout,
   budget, skip or assertion change.
4. Browser, Host entries only: `subscription-usage` failed 4/37 (the en
   "transient refresh failure → retry" cases); the formal base passes 37/37, so
   it is block-introduced. Cause: its fixture still answered the quota-check
   POST with the pre-block synchronous row. Test fixture updated to the real
   contract (admitted receipt in the operation envelope, then the status read
   with the frozen row; a Host timeout succeeds with `quota.error`, as
   `connectionRegistry` produces it). The Host Agent catalog case
   (`conversation-layout`) passed with the same stale shape only because it
   does not assert the install outcome; its fixture now admits and settles the
   install/rollback commands too, and the screenshot shows the success notice.

Targeted re-checks after the repairs (`targeted/summary.txt`, all exit 0, none
skipped): protocol build/typecheck and suite 442/442; server, daemon and web
typecheck; server build; server PG `hostFolderReadRegistry`, `hostsRoutes`,
`operationFaultsDb`, `hostCommandAuthorityDb`, `importedSessionsDb`,
`hostCommandWorkerDb`, `agentGuides` 116/116; web `AmbientSessionImportPanel`,
`host-command-api`, `HostAgents`, `modules/usage` 75/75; web build; browser
`subscription-usage` 37/37 and Host Agent catalog 1/1 (Chromium, synthetic
APIs).

`ProjectExecutionAreas` targeted checks after its repair (Node 24; logs in
`/tmp/rainver-pea-fix/summary.txt`). The file ran 5× under the same 64-process
CPU load, exit 0 each, 5/5. `src/modules/projects` exit 0, 383/383.
`useProjectLiveRefresh` + `testHygiene` exit 0, 7/7. Web `tsc --noEmit` exit 0.
Server `agentGuides` exit 0, 8/8.
Mutation: with the layout's review-event `addEventListener` removed, the file
exits 1 with only the review-event case failing (4 passed). Before the
`mockReset` repair, the next case also failed. Production restored and
unchanged. The full web suite was not rerun, so its recorded exit 1 above
stands. Not addressed: a review event that arrives while the shell's first
overview read is still in flight is dropped by the `loadedScope` guard.
That is pre-existing and not the cause here.

Limits: the full server and web suites were not rerun after these narrow
repairs. Server exit 1 also carries the accepted budget overrun
(`pluginFrontendDb` 64.3s / 30s, import total 203.7s / 190s); no budget was
changed. The 18-file browser comparison was not rerun; its earlier
failing groups remain as recorded. The browser checks use synthetic APIs. The
Host evidence is registry + real PG with constructed daemon frames and the
daemon journal on a real filesystem, not an end-to-end run with a live daemon
process. The production repairs (route condition, protocol optionality,
writer) were made after the dual review and need that review again.

## Settings / tool configuration block (working tree on `fd454edd`)

Scope, outcomes and narrowings: [SYSTEM_ACTIONS](SYSTEM_ACTIONS.md#system-settings-and-tool-configuration-commands)
and the plan's "Fourth block" section. Inventory **636 = 293 legacy + 53
exemptions + 290 core** (was 327 / 52 / 257); exactly the 34 listed rows
changed classification, no route was added or removed.

Acceptance evidence (Node 24.22.2, shared real PostgreSQL; vendor, webhook and
backup effects are local fakes, nothing reached an external service):

| Check | Evidence |
|---|---|
| Strict input, key required, replay vs key reuse, hidden 404, authority revoked before replay | `settingsOperationsDb`, `instanceOperationsSettings`, `deploymentGroup`, `acpAgentsRoutes` |
| No API key / proxy credential in receipts, audit, intents, Jobs; key encrypted only | `settingsOperationsDb` (`persistedText`), `instanceOperationsSettings` |
| Embedding chain change resets and queues backfill in the same transaction | `settingsOperationsDb` |
| System command: receipt, worker after commit, issuer-only status read | `settingsOperationsDb`, `apiPlanUsageDb` |
| Unknown outcome never repeated; expiry; cancelled Job; foreign Job refused | `settingsOperationsDb` |
| Session signed out / account disabled during vendor wait; concurrent same read is `system_command_busy` | `apiPlanUsageDb` |
| Plugin install migrations atomic with settlement; operation-package enable/disable local effects outside the transaction | `settingsOperationsDb`, `pluginLifecycleDb`, `pluginFrontendDb` (real Chromium + PG + HTTP) |
| Browser helpers: keyed submit, exact status read, never resubmit | web `settings-command-api.test.ts`; `subscription-usage.browser.mjs` (page-route fixtures, not a live server) |

Not covered: a real vendor, a real webhook target, a real `pg_dump` archive
through the command (the backup service has its own tests), and the
managed-subscription quota command beyond its authority checks.

### Settings block review repair (Codex 8cba3638, five blockers; working tree = `8265c920` + repair)

Source: full tree of `8265c9205ac7` (parent formal Host `fd454edd`), applied in
this worktree; Project `fb827016`, Agent/Room `11279541` and Host `fd454edd`
are inherited unchanged. Only the five findings' owners changed; no migration
(0020–0025 untouched, none added — the cleanup obligation is a Job and the
refresh record lives in the existing `credentials.metadata_json`).

| # | Finding | Repair | Evidence (shared real PG) |
|---|---|---|---|
| 1 P1 | plugin disable closed local effects before the operation validated key/input/authority | `lifecycle.ts`: nothing local before a new outcome commits; the disable transaction records a delayed `official_plugin_scope_cleanup` Job (generation `disabled_at`); after commit the request cleans under a share lock and retires it; the Job recovers a crash/lost commit and skips a newer generation | `pluginLifecycleDb` "touches no local effect before a new disable commits, and never cleans a newer generation" (no key, malformed, non-admin 404, reused key, replay after re-enable, crash-retry of the old obligation, committed-without-cleanup recovered once then superseded) + the existing LIFO/deadline/concurrency cases |
| 2 P2 | disconnect replay 404 after the credential was deleted | admission/replay/release = instance admin + Provider owner + managed-channel marker (`connected:false`); "still connected" only in the first execution | `settingsOperationsDb` "replays a successful disconnect by key…" (replay equal, second key 404, admin withdrawn → 404) |
| 3 P2 | grant revoke admitted and released without current writer authority | `assertGrantRevokerIn`: Provider owner or target Space owner/admin, from the Provider row and target Space (not the grant row), at admission, replay and release | `settingsOperationsDb` "re-authorizes a grant revoke replay…" (target admin replay, grant row deleted, demotion → 404; owner replay, ownership moved, target-admin path, demotion → 404) |
| 4 P1 | quota command `repeatable` while the OAuth refresh (rotating vendor IO) ran inside a row-lock transaction | `resolveManagedSubscriptionCredential`: durable `oauth_refresh` intent (HMAC `from`, attempt, lease) → vendor call outside every transaction → guarded settle; stale lease or ambiguous failure → `unknown` → `subscription_reconnect_required`, never re-sent; both consumers (Run invocation target, quota command) use it | `managedSubscriptionOAuthDb` (no `credentials` lock held and row `NOWAIT`-lockable during the vendor call, no token in the record; real `pg_terminate_backend` of the settle backend after rotation → in-flight → unknown → refused twice, vendor saw the old token once; ambiguous failure vs definite refusal; relogin clears; original concurrent single-refresh case) + `settingsOperationsDb` quota command `failed subscription_reconnect_required`, not repeated |
| 5 P1 | login stream persisted after the vendor wait without rechecking authority | `persistSubscription` rechecks active user + active Space membership (share-locked) + instance admin in its write transaction; DTO read in it; stream reports a generic failure for 403/404 | `managedSubscriptionOAuthDb` three barrier cases (user disabled / membership removed / admin email withdrawn while the login waited → 404, zero Provider/credential/grant rows); normal login cases unchanged |

Targeted commands (server, real PG; no full server/web/daemon/protocol suite,
no browser suite): `pluginLifecycleDb` 29/29 (one case first failed only because
this fresh worktree lacked `packages/agent-cli/dist`; rerun after building it
passed); `managedSubscriptionOAuthDb` 8/8; `settingsOperationsDb` 15/15;
consumers `providerGroup providersCredentialsAuthority pluginFrontendDb
pluginInvocationDb pluginOperationsDb plugins pluginHost operationRoutes
deploymentGroup sourceGoalCompatibilityDb researchAreaDb
projectResearchSynthesisReconcileDb researchAdhocOperationDb apiPlanUsageDb
instanceOperationsSettings acpAgentsRoutes` 16 files / 251 tests passed;
`tsc -p tsconfig.typecheck.json` exit 0. Limits: the vendor is a local
rotating fake; a refresh that failed before sending (DNS) is also classified
unknown (fail-closed: reconnect); `cleanup_pending` is reported on the first
response only, the durable record is `scope_cleanup_failed`.

### Settings block plugin cleanup repair (Codex a0982f79, two P1; working tree = `044588fc` + repair)

Source: full tree of candidate `044588fc` (itself `8265c920` + the five-blocker
repair above), applied in this worktree on branch HEAD `809a0cfe`; Host
`fd454edd`, Agent/Room `11279541` and Project `fb827016` unchanged. Only the
plugin lifecycle owners changed; no migration (0020–0025 untouched, none
added — the obligation stays the existing Job, events reuse
`official_plugin_events`). The other findings of the block (provider
disconnect/revoke, OAuth refresh, login stream, route/core coverage, HMAC
secret) were not touched.

| # | Finding | Repair | Evidence (shared real PG) |
|---|---|---|---|
| 1 P1 | `runScopeCleanup` awaited arbitrary async dispose inside a transaction holding the enablement row `FOR SHARE` | `lifecycle.ts`: short claim txn (generation current?) → dispose with no transaction/lock → short settle txn (generation fenced again; event or Job retirement). Ordering against a concurrent enable/newer disable is the existing per-scope process serialization + admission hold; `background.ts` Job disposal moved after its transaction | `pluginLifecycleDb` "disposes outside every DB transaction…": inside the dispose, zero other-backend locks on `official_plugin_enablements`, zero idle-in-transaction backends, and a `lock_timeout 1s` UPDATE of the same row in another connection succeeds; a concurrent enable stays uncommitted during the slow dispose, then both finish (no deadlock), Job retired |
| 2 P1 | a rejected dispose deleted the scope and cached the rejected promise; the Job's next empty scan completed | `effectScopes.ts`: per-callback state (done / retry-after-reject / in-flight awaited, never re-invoked); a rejected scope is retained and quarantined (`enter` refused, reenable 409); `unreleased()` reports failed/in-flight. Job: retries only what is not done, never completes while anything is unreleased, 3 bounded attempts, last records `scope_cleanup_needs_attention` and ends `failed`; repair = a new disable; payload carries `process_instance`, a different process reports `origin_process_not_current` | `pluginLifecycleDb` "retains a failed, unreleased scope…" (two scopes, one released, one retained; real `JobWorker` retries only the failed callback → `{cleaned:true}`, then reenable/write 200); "never completes an unreleased cleanup…" (3 real worker attempts → Job `failed` attempts 3, one `scope_cleanup_needs_attention`, 4 `scope_cleanup_failed`, reenable still 409; new disable releases it); deadline case extended (Job during an in-flight callback rejects, callback invoked once, reenable 409; after it settles the Job → cleaned, still once); "recovers an obligation recorded by another process…" (`origin_process_not_current`; payload without identity refused) |

Targeted commands (server, real PG; no full suite, no browser suite, OAuth
consumers not rerun): `vitest run test/pluginHost.test.ts
test/pluginLifecycleDb.test.ts test/pluginFrontendDb.test.ts
test/pluginInvocationDb.test.ts test/settingsOperationsDb.test.ts
test/agentGuides.test.ts` 6 files / 68 tests passed (pluginLifecycleDb 32/32;
final evidence run with `--no-file-parallelism`, exit 0; pluginLifecycleDb alone
3/3 runs 32/32). Run with file parallelism the same set passed 2 of 4 times; the
failures were install/role-DDL cases (`tuple concurrently updated`, `requires
explicit offline repair`) where pluginLifecycleDb and pluginInvocationDb race on
the same cluster-wide `operation_probe` roles/journal — not cleanup cases, and
not compared against the base tree; `tsc -p tsconfig.typecheck.json` exit 0. This fresh worktree needed workspace
packages and `packages/agent-cli/dist` built by direct `tsc` (its path contains
`:`, which breaks `node_modules/.bin` on PATH). Limits: local effects are
process-local, so a restart is reported, not proven cleaned; a retained scope
whose Job exhausted stays quarantined until a new disable or a restart;
dispose callbacks must tolerate retry after their own rejection.

### Settings block plugin cleanup repair (Codex 465e2745, three P1 + one P2; working tree = `d2fb7f89` + repair)

Source: full tree of `d2fb7f89` (the a0982f79 repair above), applied in this
worktree on branch HEAD `809a0cfe`; Host `fd454edd`, Agent/Room `11279541`
and Project `fb827016` unchanged. Only the plugin lifecycle owners, the plugin
list read and its card changed; migration **0026** (`official_plugin_scope_holds`)
is appended, 0000–0025 untouched. Provider/OAuth/HMAC/system-command code and
the route/core coverage were not touched.

| # | Finding | Repair | Evidence (shared real PG unless noted) |
|---|---|---|---|
| 1 P1 | claim/settle fenced only in-process; another process's enable → new work → disable let an old scope-wide cleanup close the new work | resources bound to a durable hold (package, scope, owner process, generation); admission is a short transaction serialized with enable/disable by the scope row locks; a disable marks holds `releasing` in its transaction (release round); a cleanup closes only its round's holds, a newer enable admits under a new hold, an old-generation Job's final transaction refuses once its hold is not `active`; enable 409 while any hold is releasing in any process; dispose stays outside every transaction | `pluginLifecycleDb` "fences generations across processes…": two independent host compositions (own effects/lease); B's disable releases B's hold only, A's stays releasing; B's reenable 409 twice, including while A's dispose is held by a barrier with zero idle-in-transaction backends; A's recovery releases it; B enables, A admits a new hold; the old round replayed by both processes and A's recovery leave it untouched; the old hold no longer commits; the next disable releases exactly the new hold. "disposes outside every DB transaction…" (no lock on enablement/hold tables, `lock_timeout` writes to both succeed) |
| 2 P1 | a Job in another instance returned `cleaned:false` normally and ended the obligation while the owner still held failed resources | the obligation is the hold row; owner = session advisory lock lease; only the owner releases (after commit, own recovery pass, or the Job in its process); another worker defers while the owner is alive (no attempt spent), never completes for a missing plugin, settles only `owner_gone` after the lease was free across a 15 s grace; owner attempts are bounded (3 → `needs_attention`, automatic retries stop); Job exhaustion leaves holds `releasing`; lease loss self-fences the owner (abort, drain, new lease) | "keeps an obligation of a live owner…": two live owners with failed resources; a third process's real `JobWorker` claim → `deferred`, attempts 0, nothing settled; Job cancelled → read still `pending 2`, enable 409; B recovers its own; A's 3 attempts → `needs_attention`; retry round via the HTTP route; the third process at attempt 3 → fails, hold still releasing; A's process closes; a restarted process has a new identity; first free-lease observation → deferred, after grace → `owner_gone`, read empty, enable 200. "fences an owner whose lease session ended…" (`pg_terminate_backend` of the lease) and "never completes an unreleased cleanup…" (3 real worker attempts → Job `failed`, hold `needs_attention`, owner pass does not retry) |
| 3 P1 | `onDispose` after the drain snapshot was never disposed while the scope reported released | per-hold drain loops until no undone callback remains; a callback registered after the snapshot, after a completed drain or after the deadline is tracked and drained; a hold is released only when every callback is done and no entered Job remains (`leave`); done callbacks never rerun, rejected ones are retried by the next owner attempt, in-flight ones are awaited, not re-entered | `pluginHost` (no DB, barriers/fake timers): late registration inside a held drain and after it, not released until the Job leaves; registration after the deadline while in flight, failure kept `failed`, retry runs only the failed callback; newer hold untouched. `pluginLifecycleDb` "drains a resource a running Job registers…": a real canonical Job registers `late` after its SQL was cancelled; the disable reports `cleanup_pending:false` only after it ran (`second, first, late`) |
| 4 P2 | attention was an event only; the disabled card offered only Enable (409) | `GET /api/v1/plugins` and `/:id` add `cleanup` (state, pending/attention counts, last attempt) for the plugin's administrators (B53), no owner/path/error text; the card shows it under the text with **Retry cleanup** (shared `Button`), which is a new disable round; Enable is visibly disabled while it is present | server: the read in the two retain/attention cases (`needs_attention`, private error text absent) and `null` after repair/`owner_gone`; web `PluginsPage.test.tsx` 6/6 (status + Enable disabled, retry → `disable('probe')` → reload clears, retry still pending → message and status kept, retry rejected → action failed, zh-CN); one-off Chromium screenshots (built app, synthetic API, dark/light × en/zh-CN × 390/1280) |

Targeted commands (all exit 0): server `tsc -p tsconfig.typecheck.json`;
`vitest run --no-file-parallelism test/pluginHost.test.ts
test/pluginLifecycleDb.test.ts test/pluginFrontendDb.test.ts
test/pluginInvocationDb.test.ts test/pluginOperationsDb.test.ts
test/plugins.test.ts test/pluginSessionReuseDb.test.ts
test/settingsOperationsDb.test.ts test/agentGuides.test.ts
test/migrationArtifacts.test.ts test/baselineSchema.test.ts` 11 files / 172
tests; `pluginLifecycleDb` alone twice more 35/35; web `tsc --noEmit` and
`vitest run src/modules/plugins/PluginsPage.test.tsx` 6/6 (with
`NODE_OPTIONS=--no-experimental-webstorage`: Node 25's own `localStorage`
otherwise shadows jsdom's for every web test file); `vite build`. No full
server/web/daemon/protocol suite and no browser suite. Limits: the grace
period trusts an owner that lost its lease to drain within 15 s (it fences on
its next 2 s pass); released/owner_gone hold rows are retained (no pruning);
a resource held after an install-state change (not a disable) is not a release
round; at 390 px English the legacy inline action group already lets
Enable/Disable cross the card edge without any cleanup state (pre-existing, not
restyled here).

### Settings block plugin cleanup repair (Codex e566d3a3, two P1 + two P2; working tree = `667bf04b` + repair)

Source: full tree of `667bf04b` (the 465e2745 repair above), applied in this
worktree on branch HEAD `809a0cfe`; Host `fd454edd`, Agent/Room `11279541` and
Project `fb827016` unchanged. Only `plugins/{lifecycle,effectScopes,background}.ts`,
their two test files and the plugin guides changed. No migration (0026 columns
suffice; 0000–0026 untouched), no protocol/DTO or web change, no
Provider/OAuth/HMAC/system-command code touched.

| # | Finding | Repair | Evidence (shared real PG unless noted) |
|---|---|---|---|
| 1 P1 | lease checked once per recovery pass, then up to 50 serial 3 s holds; admission awaited only the first `ready`; Job commit/background check only `state='active'`: a lost lease could keep admitting/committing past a foreign 15 s grace | separate 1 s lease timer (never behind cleanup); lease = (instance, dedicated session pid); admission proves it in its transaction after the scope lock, the Job's commit and 1 s abort check prove hold `active` + current instance + lease held by that pid (`pluginScopeHoldCurrent`); errors fail closed; a lost lease fences at once (abort all holds, drains outside transactions), renews without waiting for the old unlock, adopts still-held holds as `releasing`, records the rest released | "checks its lease apart from a busy cleanup pass…": two Spaces; the recovery pass is provably inside a 3 s in-flight attempt; lease backend `pg_terminate_backend`; before any lease check the in-transaction commit check is false; admission rejects (`lease is not held`); the lease check answers < 1 s while the pass is still blocked; the active hold aborts; a running real Job is not committed; process B sees the old instance free → grace → `owner_gone`; the old instance's holds cannot commit; A's next pass under a new instance adopts the in-flight hold (`scope_cleanup_reopened` from `owner_gone`), records the drained one released, enable of that Space 409; new admission works; after the drain → released, enable 200 |
| 2 P1 | a saved `onDispose` after state deletion / DB `released` revived only memory; nothing durable, enable allowed | lifecycle per hold: open → closing → released; a late registration on a released hold revives it (`onRevive`), drains again, and the owner immediately (and on each pass until done) makes the row `releasing` under its current instance as a new round (attempts 0) with `scope_cleanup_reopened`; read/write of a hold's outcome is ordered per hold (`holdOp`) so adoption never lands between a `released` read and its write | "keeps a callback registered after its hold was released…": Job entry leaves → disable → row `released`, local released; saved reference registers a failing callback → row `releasing`, card `pending 1`, enable 409; owner pass retries only it → released, card empty; re-enable, new hold; saved reference registers an in-flight callback → old row `releasing` (card pending), owner attempt 1 in flight, new hold `active`, not aborted, still commits a real write; after it ends → released; new hold untouched. `pluginHost` (no DB): revive reported once, `closingHolds`, refusal to re-enter, `abortAll` |
| 3 P2 | the Job called the owner settle unconditionally: after three timer failures it ran a fourth | every entry (request, timer, Job) claims one attempt in one short write: due, not attention, below 3, `next_attempt_at` moved forward; the claim of the third marks `needs_attention` (crash-safe), a release clears it; the Job defers while an own retry is pending, fails when all remaining need attention | "shares one durable attempt counter…": owner process with its real interval timer under fake `setInterval` + DB due clock; (a) request 1, timer 2–3, then three real `JobWorker` runs → 0 more calls, Job `failed`, timer → 0 more; (b) new round: request 1, Job runs → `deferred`, `deferred`, `failed` (2nd, 3rd), timer → 0 more; (c) new round: timer + two handler calls + direct pass concurrently ×3 → exactly 2 more calls; (d) repair round → released, no rerun of the done callback, enable |
| 4 P2 | foreign owner judged only by the round's Job: cancel/exhaust Job then owner crash → hold releasing forever, enable 409 | every process's recovery pass judges foreign owners of any `releasing` hold (one probe per instance, ≤ 20 per pass): alive → reset grace, free → mark, after 15 s → `owner_gone`; failed probe/write settles nothing; no Job needed; Job keeps the same judgement scoped to its round | "recovers a crashed owner releasing hold with no cleanup Job left…": (1) Job cancelled, live owner B: A's passes (even with a forced-old `owner_lost_at`) leave it releasing and reset grace, enable 409; B closes; a fresh process **without the plugin** → first pass grace, then `owner_gone`, enable 200; (2) owner C reaches attention, three real Job runs → `failed`; A's pass leaves the live C alone; C closes; A's passes → grace → `owner_gone`; no cleanup Job pending at the end |

Targeted commands (exit codes as stated): server `tsc -p tsconfig.typecheck.json`
exit 0; final `vitest run --no-file-parallelism test/pluginHost.test.ts
test/pluginLifecycleDb.test.ts test/pluginFrontendDb.test.ts
test/pluginInvocationDb.test.ts test/agentGuides.test.ts` exit 0, 5 files / 61
tests; `pluginLifecycleDb` alone twice more (before the last one-line pruning
change) exit 0, 37/37 each. `packages/agent-cli` dist was built for the Agent Run bearer case
(environment only). Not run: full server/web/daemon/protocol suites, browser
suite, OAuth consumers, web tests (no web or DTO change). Limits: a DB fault
during the foreign probe is handled by code (no settlement), not
fault-injected; a process that loses its lease cannot cancel callbacks still
running (writes are fenced, the hold is adopted and stays visible); the
third attempt shows `needs_attention` on the card while it runs; released and
`owner_gone` rows are retained.

### Settings block plugin cleanup repair (Codex fdb60e89, two P1 + two P2; working tree = `3e16e561` + repair)

Source: full tree of `3e16e561` (the e566d3a3 repair above), applied in this
worktree on branch HEAD `809a0cfe`; Host `fd454edd`, Agent/Room `11279541` and
Project `fb827016` unchanged. Changed: `plugins/{lifecycle,effectScopes,background}.ts`,
`db/operationTransaction.ts` (one host-only helper), `protocol` `PluginBackgroundContext`
(`retain()`, `PluginRetainedEffects`), the lifecycle fixture and its two test files,
and the plugin guides. No migration (0026 columns suffice; 0000–0026 untouched,
no 0027), no route, DTO read model or web change, no Provider/OAuth/HMAC/system-command code touched.

| # | Finding | Repair | Evidence (shared real PG) |
|---|---|---|---|
| 1 P1 | `leaseHeldBy` was a `pg_locks` read before COMMIT: the lease backend could be terminated after it, and a paused old transaction commit after a foreign/own settlement; admission the same; the foreign probe acquired the old key (a reused pid could look like the owner) | the commit check reads the hold `active`, owned by the admitting instance, lease held by its pid, **`FOR SHARE`** in the Job's transaction: the row lock lasts through COMMIT, so disable rounds, adoption, own release and `owner_gone` all wait for it (or skip it) and fail the check after it; admission's INSERT and every claim/reopen prove the lease in the same statement/transaction; probes only read `pg_locks` (no one but the owner session ever takes a key); errors fail closed | check passed → barrier → lease backend terminated → own lease check/renewal + adoption, process B's disable and B's foreign pass all wait (hold untouched, disable unresolved, no callback after 300 ms) → old COMMIT first (`disabledAt ≥ commit`), then `releasing`, one claimed drain; a failed statement in the transaction throws; an impersonating session holding the old key does not make the old instance current |
| 2 P1 | a saved `onDispose` after release revived only memory, adoption async with errors swallowed, reopen without scope lock: an enable could see "clean" | a closed handle refuses registration synchronously (before the caller creates anything); late resources use `ctx.retain()`: pin locally, then one transaction with the scope's write locks + hold row lock + lease proof makes the hold `releasing` (new round, `scope_cleanup_reopened`) and only then resolves; failure unpins and rejects; adoption after lease loss uses the same reopen (immediately after renewal and every pass) | saved `onDispose` after DB `released` throws, nothing revived; injected trigger failure → `retain()` rejects, still released; reservation stuck on the hold row while process B enables → B waits, then 409; this process's enable checked but uncommitted → reservation waits for it, then reopens only the old hold, newer generation active and committing; owner exit drains the retained resource and the newer generation's own in one claimed exit attempt each |
| 3 P2 | a revived hold drained without a SQL claim: the late callback's first failure stayed `attempts 0`, then three more | callbacks run only in a drain started by a claimed attempt (`closeHold` after the claim); registration, leave, lease loss and shutdown never start one; inside an attempt's bounded wait a registration/leave continues it; exit claims without waiting for due | a retained late callback does not run before a claim; first failure = attempt 1; not due → neither timer nor Job runs it; Job attempt 2, concurrent timer+Job+timer attempt 3 → `needs_attention`; no fourth; only the product retry route's new round runs it (4 calls total); a real Job's `ctx.retain()` drains in the disable's attempt; unit: closed handle, pin, no callback outside a claim, a registration after an attempt waits for the next |
| 4 P2 | foreign scan `ORDER BY min(updated_at) LIMIT 20`: live owners never update the field and starve the rest | rotation by `owner_instance` after a per-process cursor (per-round cursor for the Job), wrapping, ≤ 20 per pass; lease read inside each settling statement; locked rows skipped; a DB error ends the pass with the cursor at the last finished owner | 20 live owners (real advisory locks, oldest rows, attention) + 1 crashed owner without Job: injected DB fault on the crashed rows over 3 passes settles nothing and returns; then observed within 2 passes, `owner_gone` within 2 more after grace; live owners never marked; one live lease ending is reached too |

Targeted commands (this worktree, Node 25, shared real PG): `packages/protocol`
`tsc -p tsconfig.build.json` exit 0; server `tsc --noEmit -p tsconfig.typecheck.json`
exit 0; `vitest run --no-file-parallelism test/pluginHost.test.ts
test/pluginLifecycleDb.test.ts test/pluginFrontendDb.test.ts
test/pluginInvocationDb.test.ts test/agentGuides.test.ts` exit 0, 5 files / 65
passed, 0 failed, 0 skipped; after the guide updates `pluginLifecycleDb` +
`agentGuides` once more exit 0, 2 files / 48 passed; whole-tree `git diff --check`
against `809a0cfe` clean (the earlier extra blank line at this file's end removed). Environment only: dependencies installed offline
from the lockfile and `packages/agent-cli` dist built (the Agent Run bearer case
needs it; its first run failed for that missing file, then passed). Not run:
full server/web/daemon suites, browser suite, OAuth consumers, web tests
(`PluginsPage` unchanged; the cleanup read model is unchanged).

Limits (honest): the fences cover PostgreSQL state only. A plugin effect
outside PostgreSQL that was already issued is not undone; a process paused or
cut off past the 15 s grace is presumed gone (`owner_gone`) and what it
registers on return is adopted again, but an enable may have run in between;
external effects that must never act for a stale owner need an outbox row in
the Job's transaction or a fencing token checked by the resource. A process
that lost its lease runs no callbacks until it can claim (DB reachable). The
rotation cursor is per process and resets on restart. A hold row a commit
still share-locks is skipped by background settlement until it ends. Real pid
reuse is not reproducible in a test; it is excluded by construction (only the
owner session takes its key).

### Settings block worker-authority and late-resource repair (Codex c80caf46, two P1 + one P2; working tree = `958d897e` + repair)

Source: full tree of `958d897e` (the fdb60e89 repair above; Host `fd454edd`,
Agent/Room `11279541` and Project `fb827016` inherited unchanged), materialized
in this worktree on branch HEAD `809a0cfe`, plus this repair: 16 files vs
`958d897e` (+645/−86, including this section and plan 05): `systemCommands/{worker,routes}.ts`,
`plugins/{effectScopes,lifecycle,background}.ts`, `protocol`
`pluginOperations.ts` (comments only: no type or signature change), the
lifecycle fixture (an original-contract consumer) and manifest, three test files,
and the guides (`SYSTEM_ACTIONS`, `OFFICIAL_OPTIONAL_MODULES`,
`DATABASE_AND_TRANSACTIONS`). No migration (0000–0026 untouched, no 0027), no
route, DTO read model or web change, no Host/OAuth code touched. The
c80caf46-confirmed pieces (hold `FOR SHARE` through COMMIT and transition order,
three-attempt drain main path, foreign-owner fair cursor) are unchanged.

| # | Finding | Repair | Evidence (shared real PG) |
|---|---|---|---|
| 1 P1 | the system-command worker's actor check did not lock: after it passed, another transaction could disable the user, remove the membership or withdraw instance administration and commit while the install DDL ran, and the install still succeeded | the worker's single authority door (`owner`, used by dispatch, settle and `atomic`) calls `assertCurrentActor(…, lock=true)`: user and membership rows `FOR SHARE` before the kind's own check (the users row also carries the instance-admin email), held until that transaction commits; the status read share-locks the same rows. Other kinds use the same door (their external effect still runs after the dispatch commit; a later revocation withholds the result) | for each revocation (admin email changed, user disabled, membership removed): install authorized and paused inside its DDL/settlement transaction (`plugin_installs` locked by a blocker) → the revoking UPDATE is observed waiting on a lock → blocker released → the revoking transaction, once through, reads the intent `succeeded` (the install committed first); afterwards the status read and a keyed replay are 404. Revocation first (uncommitted while the worker waits on `FOR SHARE OF m,u`) → `failed system_command_authority_withdrawn`, `plugin_installs` row unchanged. Negative control: with `lock=false` all four cases fail |
| 2 P1 | `onDispose` through a closed handle threw synchronously, but the original contract (`809a0cfe`) let a handler return, create its resource, then register: that resource existed and was never cleaned | a closed handle takes the callback over: it is tracked locally at once (a released state is restored), so no owner path records the hold released; a release write rechecks the local state inside its own transaction and rolls back (`writeReleased`); a closing hold is reopened through the scope-locked reopen, entered synchronously into this process's scope transition queue; an enable is refused while such a takeover is pending locally (`localCleanupPending`); after the owner exited it is recorded `releasing` under the ended instance (`scope_cleanup_reopened`, `after_exit`) and settles `owner_gone`. The takeover runs as host work outside the plugin's operation work. Protocol types unchanged | real fixture consumer (handler returns → resource created after a test gate → saved `call.onDispose`): taken over while active, the owner pass does not release it, the disable's claimed attempt disposes it once, the saved dispose then replays success with no second effect; after release → same-tick in-process enable refused 409 (ordered after the reopen), process B's enable 409, cleanup card `pending`, disposed only by the next claimed attempt, then B enables; registration while the release write is paused in its transaction (trigger on an advisory lock) → that write rolls back, hold stays `releasing` attempt 1, disposed by attempt 2; owner B exits, then the resource appears → durably `releasing`, enable 409, `owner_gone` after grace, never disposed. Negative control: without the in-transaction recheck the paused-release case fails |
| 3 P2 | the function `onDispose` returns ran the callback directly: unlimited calls after failures, even after `needs_attention`, and inside the Job's transaction | it goes through the same counted invocation as drains: a callback is invoked at most three times per durable round (`DISPOSER_ATTEMPTS`, reset when a claimed attempt of a new round starts), an invocation in flight is shared, a success is never re-run, after the round's last claimed attempt failed nothing is invoked until a new round; inside an open Job transaction (`inJobTransaction`, inherited by continuations, cleared after the transaction ended) it rejects `PluginDisposeRefused` without running; invocations run outside any inherited transaction mark | failing original-contract resource: claimed attempt 1, the saved dispose as invocation 2 (rejects with the callback's error), claimed attempt 2 as invocation 3; the third claimed attempt invokes nothing and marks `needs_attention`; three concurrent saved calls then reject `PluginDisposeRefused` with no fourth invocation; the product retry route's new round invokes it once (4 total) and releases; a saved call then resolves with no effect. Job calling its early dispose inside its transaction: refused, not run, resolved promise not observed (no deadlock), disposed once by the disable. Negative control: without the transaction check that case fails |

Targeted commands (this worktree, Node 25, shared real PG): `packages/protocol`
`tsc -p tsconfig.build.json` exit 0; server `tsc --noEmit -p tsconfig.typecheck.json`
exit 0; `vitest run --no-file-parallelism test/settingsOperationsDb.test.ts
test/pluginHost.test.ts test/pluginLifecycleDb.test.ts test/pluginFrontendDb.test.ts
test/pluginInvocationDb.test.ts test/agentGuides.test.ts` exit 0, 6 files / 90
passed, 0 failed, 0 skipped; after the typing fix of the revocation cases
`settingsOperationsDb` alone exit 0, 19/19. Whole-tree `git diff --check`
against `809a0cfe` clean. Environment only: dependencies installed offline
from the lockfile; `packages/{protocol,folder-read,outbound-guard,reader-document,agent-cli}`
built locally (the Agent Run bearer case first failed on the missing CLI dist,
then passed). Not run: full server/web/daemon/protocol suites, browser suite,
OAuth consumers, web tests (no web, DTO or read-model change).

Limits (honest): a registration made after its resource already exists cannot
be atomic with that resource. A resource an original-contract consumer creates
after its hold's cleanup released it is taken over and reopened, but an enable
that committed before that reopen (in another process, or past its check in
this one) saw the scope clean; the old hold then shows as pending cleanup on
the enabled scope. `ctx.retain()` before creating the resource has no such
window. A taken-over resource of an exhausted round waits for a new disable
round. The per-callback budget is process-local (callbacks are process-local);
the hold's durable counter still bounds claimed attempts. A system command's
external effect (connection test, backup, webhook) runs after its dispatch
commit; a revocation after that withholds only the result.

### Settings block registration-window and early-dispose repair (Codex 4a3d2805, one P1 + one P2; working tree = `53d4c3a9` + repair)

Source: full tree of `53d4c3a94fa0f5cfad9719d20a2738696716c330` (the c80caf46
repair above, with the system-command worker repair; Host `fd454edd`,
Agent/Room `11279541`, Project `fb827016` inherited unchanged), materialized in
this worktree on branch HEAD `809a0cfe`, plus this repair: 11 files vs
`53d4c3a9` (code, tests, guides, this section and plan 05):
`plugins/{effectScopes,lifecycle,background}.ts`, protocol
`pluginOperations.ts` (new optional `PluginJobOptions` third argument of
`jobs.register`, contract comments), the lifecycle fixture runtime,
`pluginHost.test.ts`, `pluginLifecycleDb.test.ts`, `OFFICIAL_OPTIONAL_MODULES`
(invariants A1–A2, R1–R4 written first), `DATABASE_AND_TRANSACTIONS`. No
migration (0000–0026 untouched, no 0027 needed), no route, DTO read model or
web change; system-command, OAuth, hold `FOR SHARE`, fair rotation, owner
lease and retry UI untouched.

| # | Finding | Repair (design) | Evidence (shared real PG) |
|---|---|---|---|
| 1 P1 | a legacy registration after the handler returned was tracked locally, then reopened asynchronously: a foreign enable reading `released` (or past its check) could commit first; the release write's local recheck had its own window | no compensation path remains. **R1/R2**: a handle opens only while its hold is durably an obligation (the Job's entry right after admission; a `retain()` handle confirmed under scope write locks + row lock + lease before the plugin gets it, refusing an ended generation instead of reopening it), and no owner path records a hold released while a handle on it is open. **R3**: the bounded contract (`jobs.register(id, h, {disposeRegistration: 'handler'})`) closes the Job handle when the handler settles; the original contract keeps it open (`linger`, local status `registering`) until the process ends, so its hold stays `releasing` — enable 409 in every process — until the owner exited and its lease was free past the grace (`owner_gone`). **R4**: a closed handle throws `PluginRegistrationClosed`. Removed: `takeOver`, `lateHook`, `recordAfterExit`, `localCleanupPending`. The fixture (the only in-repo producer) uses the bounded contract; its original-contract variant is kept for evidence | original-contract producer in process B: handler returns; disable → attempt 1 `registering` in <2.5 s, foreign (this process) and B enable 409; resource created only then → hold never left `releasing`, no `scope_cleanup_reopened`; drained in a claimed attempt (2); attempt 3 → attention; B exits (no attempt left) → still `releasing`, enable 409 → `owner_gone` after grace → enable succeeds. Failed round write (trigger) → disable rejected, hold `active`, nothing run; exit with the window open → `releasing` attempt 1; a registration after exit is tracked, its early dispose refused, `owner_gone` after grace, never released. Bounded producer registering after its handler → `PluginRegistrationClosed`, disable releases. `retain()`: injected write failure → rejected, nothing pinned; stuck behind the hold row lock while B disables → B waits behind the scope locks, the reservation confirms `active`, B's round makes it `releasing`, B's enable 409 until the owner disposes it; an ended generation behind this process's checked-but-uncommitted enable → waits, then refused, never reopened; exit drains a retained resource. Negative control: Job handle closed instead of lingering → both original-contract cases fail |
| 2 P2 | the function `onDispose` returns invoked the callback with a memory budget; DB attempts could be 0, and the first claimed round reset it (callback 3 vs DB 2 accepted by the test) | **A1/A2**: every invocation runs under an attempt claimed by the one SQL statement (`claimHoldAttempt`: round, due, attention, < 3, lease in-statement), at most once per claim key; no local budget (`DISPOSER_ATTEMPTS`, per-callback rounds removed). The early dispose asks the owner (`earlyAttempt`, host work outside operation work): on a `releasing` hold it is a full `settleOwnHold` attempt; on an `active` hold it claims the active counter (`release_round` null), invokes the requested callbacks (concurrent requests join one claim) and resets the counter only when nothing of the hold failed. Kept: done → resolve without running, in flight shared, refused inside the Job transaction, invocations outside every transaction, new disable round retries | each invocation records the durable `(release_round, attempts)` it ran under: two concurrent early disposes → one active claim `[1]`, counter reset (`disposed`); failing resource: active `[1, 2]` (a repeat before due refused unrun; three concurrent saved calls share one claim), then the disable round `[1, 2, 3]` with saved calls, the timer pass and the cleanup Job interleaved (not due: none; due: exactly one claim); after attention two saved calls are refused and timer/Job invoke nothing; product retry route → one run in a new round, a saved call then resolves with no effect. Negative control: early dispose invoking directly → the case fails |

Targeted commands (this worktree, Node 25, shared real PG): `packages/protocol`
`tsc -p tsconfig.build.json` exit 0; server `tsc -p tsconfig.typecheck.json`
exit 0; `vitest run --no-file-parallelism test/pluginHost.test.ts
test/pluginLifecycleDb.test.ts test/pluginFrontendDb.test.ts
test/pluginInvocationDb.test.ts test/pluginSessionReuseDb.test.ts
test/agentGuides.test.ts` exit 0, 6 files / 71 passed, 0 failed, 0 skipped;
`pluginHost` + `pluginLifecycleDb` twice more exit 0, 52/52 each; the two
negative controls exit 1 (2 and 1 failed, as intended) and were reverted.
`git diff --check` against `53d4c3a9` clean. Environment only: offline install
from the lockfile; `packages/{protocol,folder-read,outbound-guard,reader-document,agent-cli}`
built locally. Not run (by instruction): full server/web/daemon/protocol
suites, browser suites, OAuth consumers, `settingsOperationsDb` (no
system-command change).

Limits (honest): an original-contract package can be re-enabled after a
disable only once its owning process ended (plus the 15 s grace); its disable
rounds report `registering` and reach attention after three attempts. Effects
outside PostgreSQL remain unfenced, as before. An early dispose that finds no
claimable attempt (not due, attention, an attempt claimed by another entry) is
refused and left to the host's round.

### Settings block early-runner hand-off and process-held cleanup read (Codex 77c87dab, one P1 + one P2; working tree = `b7224475` + repair)

Source: full tree of `b7224475db635d7ceb3a43a1262c64a4d3a45782` (the 4a3d2805
repair above; Host `fd454edd`, Agent/Room `11279541`, Project `fb827016`
inherited unchanged), materialized in this worktree on branch HEAD `809a0cfe`
(`git diff --check b7224475` clean before the repair), plus this repair. The
registration-window design, hold reservation (`retain()` refusing an ended
generation), the single SQL claim for every invocation (round/due/attention/
< 3/lease), three attempts with disposal outside transactions, the hold
`FOR SHARE` commit fence, fair foreign rotation, the owner lease, OAuth and the
34 settled routes are unchanged. No migration (0000–0026 untouched): the new
read count is derived from existing `last_outcome` / `owner_lost_at`.

| # | Finding | Repair | Evidence |
|---|---|---|---|
| 1 P1 | `runEarly` settled its callers, then an outer `.finally` cleared `state.early` a few microtasks later: `await a(); b()` let `b` see the old runner, register `b.early` and never be claimed | the runner owns a boolean scheduling right; it clears it in the same synchronous step that found no request pending (no await between check and release), so a request from a settled caller's continuation is either seen by the running loop or starts the next runner; a claim fault refuses the requests it considered; an unexpected fault refuses every pending request and releases the right; the runner promise never rejects (no unhandled rejection). SQL claim and Job-transaction refusal unchanged | Node repro first (vitest on Node 25, temporary file, deleted): `await A(); B()` → B never settled (exit 1); after the fix exit 0. `pluginHost.test.ts` new `Plugin early dispose runner` (6 cases, bounded by event-loop turns, no sleep/timeout): `await a(); await b()` serial, 2 claims, ≤1 runner; caught failure → next request at once, failed one retried by a later claim; repeated/concurrent requests of one callback share one invocation (in flight never re-entered); a request registered in the runner's last step gets a second claim; claims refused (not due/attention/no lease) or faulting → every request refused, none pending, later claimable runs; inside the Job transaction refused with no claim. Negative control (b722 `effectScopes.ts` restored): the serial and caught-failure cases fail (2 failed, exit 1), restored. Real PG (`pluginLifecycleDb`): sequential `await s1(); await s2()` on an active hold → two active claims `[1]`, counter reset |
| 2 P2 | the original contract keeps a hold `releasing` until its process exits, but the card showed it as a generic failure with **Retry cleanup** and "try again later" | `OfficialPluginCleanupStatus` adds `awaiting_restart` (count) and state `awaiting_restart`: a `releasing` hold with last outcome `registering` whose owner is not known lost; `attention` now counts only retryable holds (attention, not `registering`, owner not lost); a hold whose owner is known lost is `pending` (settles `owner_gone` by itself). Counts only, same B53 filter, no process detail. The card shows one line per count; `awaiting_restart` offers only **Refresh status** and says that a retry cannot release it and that it is released after the service process restarts or exits (no restart/deploy action); a retryable part keeps **Retry cleanup**; the retry-still-pending text now points to the status above; Enable stays disabled | real PG legacy case: attempts 3 → `{state:'awaiting_restart', attention:0, awaiting_restart:1}` (was `needs_attention`); owner exited and observed lost → `{state:'pending', pending:1}`; `owner_gone` → `cleanup` null, enable succeeds. Bounded failing holds stay `needs_attention` with `awaiting_restart:0`. `PluginsPage.test.tsx` (9): process-held en (no Retry, Refresh, Enable disabled, refresh → recovered, no disable call), mixed failed + process-held (Retry kept, both lines), zh-CN process-held, updated retry-failed copy. Built-app Chromium one-off (synthetic API, outside repo, not the 18 suites): `awaiting_restart` and mixed × en/zh-CN × dark/light × 390/1280 → 16 screenshots, no overflow, no page errors; inspected restart en dark 1280 and mixed zh-CN light 390 with the neighbouring Enable |

Limits: a hold of a live owner that is both `registering` and has a failed
callback reports `failed` (retryable) until that callback succeeds, then
`awaiting_restart`. The card's legacy inline white surface in dark theme is
pre-existing and was not restyled. A crashed owner shows `awaiting_restart`
until a recovery pass observes its free lease (≤ 2 s pass interval).

### Settings block final pre-commit gate (2026-11-11, on `84d72b1c`)

Candidate `84d72b1c` (tree `25b6aa2a`; source parent `809a0cfe`; Host
`fd454edd`, Agent/Room `11279541` and Project `fb827016` inherited). Two static
reviews of the whole candidate left no blockers; they do not cover the gate
repair below. Node 24.22.2, shared real PostgreSQL (`REQUIRE_TEST_POSTGRES=true`),
each command run as `node <pkg>/node_modules/…` (the worktree path contains `:`).
The 18 browser suites were not part of this gate.

The first run (`/tmp/rainver-gate-84d7/`, worktree of the candidate, clean
tree) recorded the builds, protocol/server/daemon typechecks, protocol tests
and the schema check below, then its process was killed during the daemon tests
(task output ends `[killed]`, no summary line): that daemon run has **no exit
code (unknown)** and web and server never started. The resume
(`/tmp/rainver-gate-84d7-resume/`, `gate-resume.sh`, the same tree `25b6aa2a` in
a fresh worktree) ran only the items without a terminal state, once each, after
an offline install and the dependency builds a fresh worktree needs.

| Command | Run | Result |
|---|---|---|
| builds: protocol, outbound-guard, folder-read, reader-document, agent-cli, server, daemon | first | exit 0 |
| protocol / server / daemon typecheck | first | exit 0 |
| protocol `vitest run` | first | exit 0: 75 files, 442 tests passed |
| server schema-migrations check + drizzle-kit check | first | exit 0 (27 migrations in sync) |
| daemon `vitest run` | first | killed, exit unknown |
| daemon `vitest run` | resume | exit 0: 72 files passed, 2 skipped; 791 passed, 22 skipped |
| web typecheck, web `vite build` | resume | exit 0 |
| web `vitest run` (alone) | resume | exit 0: 278 files, 2536 tests passed; budget within limits |
| server `vitest run --maxWorkers=4` | resume | **exit 1**: 609 files passed, 1 failed, 1 skipped; 7719 passed, 1 failed, 5 skipped; plus 2 budget violations |

Server failures:

1. `testHygiene` "does not wait on real time for more than 100ms" named
   `pluginLifecycleDb.test.ts` (new in this block): five sleeps of 150–300 ms
   used to show a writer was still blocked. **Test-only repair**: four of them
   now wait on the shared `support/lockWait.ts` observation (`waitForBlockedBy`
   the blocker's pid; `waitForLockWaiter` for the disable behind the open Job
   transaction, the disable queued behind the reservation, and the retain behind
   the uncommitted enable), which proves the PostgreSQL wait instead of
   assuming it. The concurrent enable behind the slow cleanup is queued in
   process (`serialized`), with no PostgreSQL wait to observe — a lock-waiter
   wait there hit the enable's own pending-cleanup refusal — so it keeps a
   bounded 100 ms window. Assertions unchanged. Targeted:
   `vitest run test/pluginLifecycleDb.test.ts test/testHygiene.test.ts` exit 0
   (2 files, 57 tests); server typecheck exit 0. No production code changed.
2. Budget (`tools/vitest/budgetReporter.mjs`), reported, not changed:
   `pluginFrontendDb` "renders the real Project entry and bundled slot…" 51.2 s
   (limit 30 s), and suite import total 224.5 s over baseline 95 s × 2 = 190 s.
   `test/perf-budget.json` was not edited, and the full server suite was not re-run, so
   the gate's server result stays exit 1.

Not run: the 18 browser suites, OAuth consumers, a second full server run.

### Rebase onto dev (2026-11-11)

Replayed the four completed blocks onto dev `068d0320`. Preserved dev's
`0020_delegated_workspace_reviews` unchanged; the seven P5 migrations are now
0021–0027, with byte-identical SQL under shifted names and snapshots carrying
the delegated-review table. The Run launch conflict keeps
`ensurePrimaryExecutionWorkspace` plus managed restore/cwd/profile barriers.
Updated the historical-upgrade regression's two migration filenames.

Checks in this worktree, Node 24.22.2: four dependency builds and server
typecheck exit 0; schema check exit 0 (28 migrations in sync); diff check exit 0.
Real shared PostgreSQL targeted checks: remoteHostCliAdapter 48,
managedWorkspaceRestoreHostDb 13, agentGuides 8 passed; profile barrier initially
failed because its old migration filename was missing, then all 18 passed after
the reference correction. Dev workspace placement/reuse regressions passed
26/26. No full-suite rerun; previous final-gate budget limitations remain.

## P5 Note/Source block — Note links/jot and Source item/evidence objects (basis `4b7b650d`, uncommitted)

Scope: nine retained URLs → ten human-only core commands (`source.item.save_url/
update/queue/triage`, `source.evidence.create/update/link`,
`knowledge.note.link.create/delete`, `knowledge.note.jot`). Inventory 636 =
284 legacy + 53 exempt + 299 core (before: 293/53/290). Remaining Note/Source
legacy groups and their boundaries are listed in Plan 5's Note/Source block.

| Invariant | Permanent evidence (`server/test/sourceObjectOperationsDb.test.ts`, real PG) |
|---|---|
| REST/generic replay, key reuse 422, identity-only receipt, Personal placement with request-Space audit | saves a context-free URL once into Personal … |
| Consent: retention policy refusal cached with typed metadata (`SourceRetentionRefusalMetadataSchema`); no item/Job left | refuses a URL save whose Source retention policy forbids full text … |
| Derived projection failure contained by savepoint, canonical write commits | keeps saving the URL when the derived retrieval projection fails … |
| One URL, two policies; queue writes one Job intent; triage writes reader state; unknown action / restated target 422 | routes the retained actions URL by product … |
| Owner refusal cached with stable body | reassigns a saved URL Source and refuses non-manual items … |
| Current reach on new calls and replay; foreign Space 404; no Job | hides items without current reach … |
| Evidence create/review/link; duplicate link cached 409; hidden target 404; replay after evidence narrowed 404 | creates, reviews and links evidence … |
| Atomic rollback of evidence, receipt and audit (3 storage failures) | rolls evidence, receipt and audit back together when … |
| Granted Agent Run refused on all ten commands | a real granted Agent Run cannot reach … |
| Note link/unlink REST/generic replay, duplicate/invalid type, per-invocation `note.link.create` audit, revoked replay | links and unlinks a Note across REST/generic replay … |
| Jot atomic Note+link, append, Project mismatch 409, hidden target 404, link storage failure leaves no Note | jots a Note and its link atomically … |
| Project writer recheck after a real lock wait | rechecks Project writer after waiting on the granting membership … |

Consumers: `operationExecutorDb` explicit enabled-user allowlist; web
`conversation-scope-api.test.ts` (keyed core calls, receipt-Space rereads, no
legacy write). Results recorded in Plan 5. No production approval mapping,
Agent surface, external execution or full-suite claim.

## P5 Note/Source block — continuation (working tree on `c053aefa`, uncommitted)

Scope: 25 more retained URLs → 27 human-only core commands; inventory 636 = 259
legacy + 53 exempt + 324 core (before: 284/53/299). Goals (21 URLs) and the three
Reader/Relations Note entries remain legacy (Plan 5, Note/Source continuation).

| Invariant | Permanent evidence (real PG unless noted) |
|---|---|
| Legal connection + `project_id` kept (connection without Project → writable Project; own Project restated); other Project 422; Evidence source Project restated / differing 422 | `sourceObjectOperationsDb` keeps the legal connection + project_id combinations … |
| Material start: one Run + operation + `agent_run` intent, active reuse, cached selection refusal, key reuse 422; cancel intent (Run cancelling, operation settled) for writers only; storage: one pending proposal per Source policy | `sourceMaterialOperationsDb` (3 tests) |
| Version-fenced Markdown refusal carries `metadata.code`; state-settling GET refuses cross-site | `sourceMaterialOperationsDb` refuses a stale Markdown choice … |
| Decision actions by retained policy, per-invocation audit, Evidence in the core transaction; rerun is a reused single-attempt intent; worker refuses a changed rule and never repeats after its start fence | `sourcePostProcessingOperationsDb` (3 tests) |
| Run-once freezes resolved Agent + Monitor into a Job intent; invalid inputs cached 422 | `sourcePostProcessingOperationsDb` one-off run … |
| Reindex: projection + embedding intent in one command, owner/admin only | `sourceRetrievalOperationsDb` reindex … |
| Search is a Job; general Jobs reader withholds its result; dedicated reader drops hits after access withdrawal; replayed delivery returns the stored outcome | `sourceRetrievalOperationsDb` search … |
| Preview quota spent with the intent; exhausted quota 429 keeps nothing; no secret frozen | `sourceRetrievalOperationsDb` query preview …; `sourceQueryPreviewService` (unit) |
| Backfill propose-start: one canonical proposal per draft plan, replay/new key reuse, non-draft 409, non-manager 404 | `sourceBackfillOperationsDb` propose-start … |
| Recipe plan admission (domain policy refusal cached, nothing queued), dry-run requires management and records via fenced writer, activation refusal until tested | `sourceRecipeOperationsDb` (3 tests) |
| Credential secret never in receipt, request record, audit; same key + other secret 422 | `customSourceOperationsDb` stores a credential once … |
| Custom Source draft/generate/test intent/activation under current management; members 404 on every connection command | `customSourceOperationsDb` drafts, generates … |
| Space/instance settings authority | `customSourceOperationsDb` settings … |
| Trash purge once per key; replay never deletes another batch; private Notes of others untouched | `sourceObjectOperationsDb` purges expired trash … |
| Web helpers send one keyed command, poll only the dedicated reader, promote `metadata.code` | web `conversation-scope-api.test.ts` |

Consumers: `operationExecutorDb` explicit allowlist (27 ids), `operationRoutes`
(inventory regenerated), protocol policy fixture (two new actions, enforcement
points), existing material/goal/deep-reading, post-processing, recipe and Custom
Source suites unchanged and passing. No Agent surface, approval mapping or schema
migration. The protocol run recorded there (75 files / 442) was the full protocol
package suite; no server, web or daemon full suite was run.

## P5 Note/Source block — Goals family (working tree on `afbacb8b`, uncommitted)

Scope: the 21 retained goal-setup / goal control URLs → 21 human-only core commands
(`sourceGoalOperations.ts`); inventory 636 = 238 legacy + 53 exempt + 345 core
(before 259/53/324). Remaining Note/Source legacy: the three Reader/Relations Note
entries, next block (Plan 5, Goals family).

| Invariant | Permanent evidence (real PG unless noted) |
|---|---|
| Retained URL needs an explicit key and strict input; dry-run mapping writes nothing; replay returns the stored receipt; a non-owner is hidden | `sourceGoalOperationsDb` maps a Monitor through the retained URL … |
| Preview is admission + single-attempt `goal_preview` Job (202), one in flight (cached 409 `source_goal_preview_in_progress`), and the Job after a pause executes nothing and marks the reservation stale | `sourceGoalOperationsDb` queues the preview as a single-attempt Job … |
| Job body stores through the existing writer, result read via the goal reader; follow receipt is identity-only; replay refused once the caller no longer manages the goal | `sourceGoalOperationsDb` runs the preview Job body … |
| Pause/delete write Run cancellation intents in the command; deleted goal admits only its delete replay | `sourceGoalOperationsDb` pause and delete … |
| Creation placement receipt (201); setup message + queued Run atomic, refusal leaves no message/Job, domain key dedupes | `sourceGoalOperationsDb` creates a topic … |
| A pause racing dispatch waits on the goal lock and cancels the committed Run; budget refusal leaves no claim; replay never queues twice | `sourceGoalCompatibilityDb` C-P2-2 tests |
| Theme cancel: Run cancelling and briefing settled `cancelled` before any stop; late old settlement ignored | `projectReadingThemesDb` cancelled analysis is not publication … |
| Theme consent/retry through the retained URLs; non-manager hidden | `projectReadingThemesDb` theme-analysis / retry cases |
| Superseded collections marked cancelling only under the active version | `sourceGoalsDb` delayed old activation / stale cleanup cases |
| Contract: 21 ids human-only, ungrantable, `source.goal.manage`, strict inputs, identity receipts (unit) | protocol `sourceGoalOperations.test.ts` |
| Web: keyed core calls with fresh transport key, domain key kept, `metadata.code` promoted | web `conversation-scope-api.test.ts` Goal case |

Consumers: `operationExecutorDb` explicit allowlist (+21), `operationRoutes`
(inventory regenerated), existing goal / compatibility / theme / briefing suites
updated where they used the retained URLs or the removed synchronous preview
(`test/support/sourceGoalPreview.ts` runs admission + Job body in-process). No Agent
surface, approval mapping, schema migration or full-suite claim (protocol: four
explicit operation files only).

## P5 Note/Source block — review closure of 8 commit-barrier findings (on `6466eb82`, uncommitted)

The first two reviews of the whole block disagreed; the specific review found
eight check→write windows, each closed with the existing canonical mechanism (no
new engine, no migration, migrations 0000–0018 untouched). Every new test races the
order the review named — the unlocked check passes, a canonical writer holds its
locks or commits, then the command reaches its commit or read — on real PostgreSQL,
with `lockWait.ts` observers instead of sleeps. All nine new tests were run against
the unmodified `6466eb82` tree and fail there at the race point (purge deleted the
Note; link and pause did not wait; the Goal command and a Delivery deadlocked
(`40P01` → 503); repair re-activated a paused Source; the GET released archived
hits and the brief answer; the fence ran and recorded under a lost claim).

| # | Finding → closure | Permanent evidence (real PG) |
|---|---|---|
| 1 | Retrieval GET re-releases through the canonical gate (`RetrievalSearchService.revalidateForRelease`: adapter revalidation incl. subscription/history and Evidence provenance, Source consent/archive policy, B11 audit), not a bare content ACL | `sourceRetrievalOperationsDb` a stored search or brief leaves only through the canonical retrieval gate … |
| 2 | Brief rebuilt from what may still be released: whole objects only, answer + `uncited_claims`/`contradictions`/`missing_topics` dropped once a source is withheld, `stale`/`thin` filtered | same test (no `PRIVATE_*` text survives) |
| 3 | Custom Source repair settles in one transaction under Project writer → Space role → Source + channels (FOR UPDATE) and re-verifies management, deletion, Source/channel status, `repair_pending`, active version | `sourceCustomSourceRepair` commit barrier: paused while tested stays paused; deleted is not revived |
| 4 | Collection batch holds Project/Goal share, binding, Source read authority to commit and re-verifies; a pause after the final check waits for the batch, no later batch writes | `sourceGoalsDb` a collection batch holds the Goal closure to its commit … |
| 5 | Note purge locks the batch's Project writer authority (id order) then Note roots and re-judges each; receipt carries `project_ids` and is released only while the caller writes them; replay never deletes the next batch | `noteSourceBarriersDb` Note purge (2 tests); `knowledgeGroup`, `sourceObjectOperationsDb` receipt shape |
| 6 | One Project → Goal order: `lockGoal` in every Goal writer, core command, topic analysis, scheduler cohort; creation takes Project FOR UPDATE first; `lockReadingRunAuthority` locks Following goals' Projects before the goals | `noteSourceBarriersDb` Goal command and briefing Delivery share one closure order …; goal, compatibility, theme, deep-reading and briefing Delivery suites unchanged and passing |
| 7 | Incoming link controls both writable endpoints (Projects id order → roots id order → recheck); outgoing target stays read-only | `noteSourceBarriersDb` incoming Note link … (legitimate incoming and read-only outgoing still 201) |
| 8 | Source dispatch fence writes (start, receipt, busy release) carry the queue claim (`running`, `claimed_by`, `attempts`); lost claim never starts work or writes a late receipt; next claim reports unavailable, never repeats | `sourceRetrievalOperationsDb` the Source dispatch fence holds the queue claim … (real `claimNext`/`startJob`/`reclaimStuckJobs`); existing processing/recipe/custom/post-processing tests now claim through `test/support/jobClaim.ts` |

Contract change: `NoteTrashPurgeReceiptSchema` gains `project_ids` (web consumer
fixture updated). No schema/migration change.

Verification (this checkpoint, Node 24.22.2 for the run of record; see plan 05):
server typecheck, web typecheck; the targeted real-PG set of 23 server files;
protocol `operations`, `systemActions`, `policy`, `sourceGoalOperations`; web
`conversation-scope-api`; `agentGuides`. Limitations: no full server/web/protocol
suite, no browser run; the Delivery side of finding 6 is exercised with the real
`lockProjectAudience` plus the Delivery's Goal share statement, not a full Room
turn; the reading-run authority reorder and the scheduler cohort lock are covered
by the existing reading/goal suites, not by a dedicated race test; Source consent
revocation is exercised through Connection archive (the same policy-snapshot path).


### a83 follow-up: four final-authority / execution-ownership findings

Basis: full `a83f7d22345addc414b39cc65955d2b1bfe8ecac` tree (parent `6466eb82`),
identical to starting private checkpoint `82e1d2405d62ab744e4587d143797a2cee41fd53`
(parent `c053aefa`); formal block baseline `4b7b650d`. This implements the four
follow-up findings; it is not an independent clean review or P5 completion.
The eight earlier fixes, full 55-URL implementation and unrelated user reports
remain. Inventory stays 636 = 238 legacy + 53 exempt + 345 core;
Reader/Relations' three Note entries remain the next block. No schema/migration
edit (0000–0018 frozen), Task, delegation, publication or instance operation.

Reuse / Dependency Check: extends the existing Source dispatch fence and Job
lifecycle, canonical retrieval adapter/Source policy/B11, content registry,
Project audience locks and shared real-PG/lockWait fixtures. The narrow Job
execution credential uses Node AsyncLocalStorage, already used for scoped
authority here; this is no new queue/retry engine. An external library cannot
own Rainver's claim/consent/approval semantics, so no dependency was added.

| Finding | Implemented boundary | Real-PG evidence |
|---|---|---|
| Separate adapter, Source-policy and B11 reads | One writable transaction, actual multi-hit Evidence/item/snapshot/ontology/Source/Project/ACL closure; sorted locks including historical windows; lineage rechecked after locks; canonical Source ids reloaded; adapter, policy and B11 use the same client through audit COMMIT | `sourceRetrievalOperationsDb`: B11 blocked → Source archive waits → result/audit commit → next read withholds; reversed multi-Source hit order; two-origin Evidence with stale projection lineage |
| Final repair/collection account gate was unlocked | Project audience then users/active membership before roots and final canonical checks; auth disable's users UPDATE conflicts through commit | `sourceCustomSourceRepair`: real auth disable during testing refuses activation, final activation blocks disable; `sourceGoalsDb`: final collection blocks real auth disable |
| Waited lease used transaction-start now() | Binding FOR UPDATE first, token/revision plus clock_timestamp in one post-lock statement and again at final commit decision | `sourceGoalsDb`: txn starts → waits Goal lock → lease expires after txn start → release → 409 and no item/membership/cursor write; existing pause barrier retained |
| Start CAS did not govern later effects | Credential reaches actual guarded Source HTTP, embedding/rerank/chat HTTP, Host Source/Agent send (including capacity dequeue), and transaction-owned enqueue/ensure. Cancel/reclaim share the same Job row; started unknown dispatch settles terminal instead of reissuing | `sourceRetrievalOperationsDb`: start CAS → async stall → cancel/reclaim → zero effects; Source HTTP pre-send exhaustion → zero HTTP; actual provider target resolution then reclaim → zero HTTP boundary calls; Host capacity wait/reclaim → zero late launch; stale credential cannot enqueue another Job; existing extraction/post-processing/recipe/custom/Goal-preview consumers |

Lease validity is required at post-lock admission and the final commit decision;
the binding stays locked through COMMIT. This is not a wall-clock guarantee at
physical COMMIT acknowledgement. Effect start linearizes at the claim-conditioned
write: cancellation cannot retract an admitted send; a crash after that write is
unknown, never retry authority. No transaction waits for a provider. A durable
Job handoff alone joins the enqueue transaction. Host broker callbacks capture
the credential, and handler exit seals it. No content/spend/consent/approval or
secret authority is granted by this credential.

Verification (Node 24.22.2, shared real PG, REQUIRE_TEST_POSTGRES=true):

- Source consumer command: **exit 1**, 8 files, 89 pass / 1 fail. The new Evidence
  fixture used an invalid evidence-type enum; it was corrected without changing
  product constraints. Six unaffected Source files passed 67 cases; Host nonce
  passed 11. Unchanged groups were not repeated solely for a green aggregate.
- Corrected retrieval plus HTTP/Host/Job consumers: **exit 0**, 6 files, **85 pass**,
  no skips: retrieval 15, Source transport 5, Host nonce 11, Job Run settlement 5,
  provider resilience 45, prior Note/Source barriers 4. Includes the corrected
  fixture and three provider-boundary cases.
- Goal split entries, three explicit collection filters: **exit 0**, **3 pass /
  247 selection skips**, no environment skip. Unselected cases are not verified.
- Server `tsc -p tsconfig.typecheck.json`: **exit 0**. Local protocol/dependency
  builds were preparation, with no protocol contract change. Initial missing
  dependencies, read-only cache and sandbox container-access startup failures
  were not passes. Early auth fixtures were corrected to use a real signed
  session; those disable cases and the full 19-case repair file passed later.
- Guide/structure and final diff checks: recorded in final verification below.

Logs are Run output, not another handoff report. No budget threshold was changed.
No full package suite, browser batch, independent re-review, live provider/Host,
production execution or deployment acceptance is claimed.


Final verification for this follow-up: `agentGuides` **8/8 pass** and
`boundaries` **5/5 pass**. The first hygiene run exited **1** (11 pass / 1 fail):
the Goal suite used an ad-hoc Pool (including the earlier pause-barrier fixture).
Both race fixtures now use the shared `useTestDatabase` pool with enough checked
out connections; no allowlist or threshold changed. The focused rerun exited
**0**: hygiene **12/12**, collection **3/3**, **247 filter skips**. Final server
typecheck and `git diff --check` exited **0**. No unavailable-PG skip. PG emitted
a concurrent-client-query deprecation warning during Goal setup;
no assertion, unhandled error or budget failure remained in these reruns.


Final provider assertion strengthening: require the explicit lost-Job-authority
error, not any provider failure. The first three-case run exited **1** (embedding
and rerank passed; chat SDK wrapped the denial as `Connection error.`). The
credential now retains its lost-authority fact through SDK error wrapping and
retrieval degradation. The corrected full retrieval file exited **0**, **15/15
pass**, no skips, with all three stronger assertions. Final server typecheck
again exited **0**; no other behavior or thresholds changed. This replaces the
weaker provider error assertion in the earlier 85-case evidence, without
claiming a rerun of its unchanged five files.


### Final same-runtime gate (2026-11-11, private; P5 remains unfinished)

Started from clean `82e1d2405d62ab744e4587d143797a2cee41fd53`, tree
`67b57dd62ad5193c6aa3ab3552095964551bc4b0` (identical to a83).
Applied only its 23-path delta to candidate
`ccf7d60e93e8ebaa6e7bbeb8de96cf4b866c4f9f` (parent
`5bde7e05a73089983183423ef2b645ea40510b2f`, tree
`40373cf6d90b8a59484e744058548da5911b81f1`): all 23 paths byte-equal,
then all 4,033 candidate blobs verified against the working files. No shared
ref/history replacement. Older gate logs were a different tree and were not
reused. Every full package gate below ran once here under Node 24.22.2;
server used REQUIRE_TEST_POSTGRES=true and the shared real PostgreSQL fixture.

| Gate / log basename | Terminal result |
|---|---|
| `protocol-types`, `build-protocol`, `protocol-test` | exit 0; full suite 76 files / 445 passed |
| `server-types`, `server-build` | exit 0 |
| `daemon-types`, `daemon-build` | exit 0 |
| `daemon-test` | exit 1; 805 passed, 1 five-second timeout, 22 skipped; 73 passing files, 1 failed, 2 skipped |
| `web-types`, `web-build`, `web-test` | exit 0; full suite 278 files / 2,542 passed |
| `server-test` (maxWorkers=4) | exit 1; 616 passing files, 3 failed, 1 skipped; 7,793 passed, 7 failed, 5 skipped; 3 unhandled broker errors |
| `daemon-targeted` | exit 0; unchanged timeout, branchAlignIsolation 6/6 passed |
| `targeted-repairs` | exit 1; 64 passed, one remaining workspace projection assertion; no unhandled errors |
| `targeted-workspace-final` | exit 0; 5 files / 61 passed, no skips (workspace management/overview, guides, boundaries, hygiene) |
| `server-types-after-fix`, `schema-check` | exit 0; schema reports 19 migrations in sync (0000–0018 unchanged) |

Full server failure diagnosis and bounded repairs:

- Source broker metadata is read-only. Without a Job credential, the binder
  returned that same function and Object.assign threw before dispatch (three
  failures plus three unhandled errors). Always bind a fresh forwarding function,
  preserving the original broker. The corrected Source review (9), retrieval
  (15), Host nonce (11), and capability (12) files all passed in the 64-pass
  targeted run; the sole remaining failure was workspace management below.
- Current protocol supports reclaim 5; the unsupported-version fixture now uses
  6. Missing branches belong in History per the existing owner guide, so stale
  assertions now check History and absence from Current. That revealed a real
  SQL/JS mismatch: acknowledged old missing records hid later saved work.
  Exclude missing_acknowledged from the stale-missing SQL filter. Final workspace
  management (18), overview consumer (18), guides (8), boundaries (5), hygiene
  (12) passed, without changing the user's branch-alignment implementation.
- Full server performance gate remains **exit 1**, not waived: pluginFrontendDb
  52.2s > 30s, the failed Source review timeout 30.0s > 30s, total imports
  232.2s > 190s. No threshold change or repeated full run. Focused repair runs
  have no budget failures; they do not prove whole-suite performance recovery.

Logs: `/tmp/rainver-current-final-gate/` (summary, driver, individual logs).
Offline install initially failed on the read-only local store; approved offline
installation then exited 0. Those startup failures are not test passes. Full
server skips: opt-in Source Agent smoke (1), existing Goal selections (4); no
unavailable-PG skip. Daemon retains its 22 conditional skips. No browser batch,
real provider/Host/webhook, deployment/restart or instance-DB operation. The
final tree differs from ccf only in the two production fixes just named, two
stale test files and documentation; full-suite passes are not claimed for this
corrected tree. Production follow-up requires focused parent review of
connectionRegistry.ts and workspaceOverview.ts. No new delegation/re-review loop.
Inventory remains 636 = 238 legacy + 53 exempt + 345 core, retaining 55 URLs;
Reader/Relations' three entries are next, formal baseline 4b7b650d, P5 unfinished.
Private checkpoint only; no formal commit, prepare, publish or push.

## P5 Relations continuation (partial Knowledge / Memory / Reader block)

The isolated continuation verified the accepted `9b1c80b2` / `fbbb0026` identical
tree before adopting its checked delta from the inherited clean `82e1d240`.
Relations's ten commands are now strict, human-only, explicitly keyed core
commands; the existing affiliation Knowledge proposals/appliers remain canonical.
REST and generic entry share `RelationsService`, which joins the core transaction.
Receipts contain ids and kind only. Identity-delete replay authorizes the surviving
root; source-link replay rechecks current Source readability under the shared
release locks. Project scopes from both the relation card and Source reference
use the same sorted audience lock set. No external effect or approval mapping
was added. See [Relations](../modules/relations.md) and the existing Plan 5 entry.

Actual inventory after regeneration: **636 = 228 legacy + 53 exempt + 355 core**.
The broader requested block is incomplete: Knowledge 27, Memory 16, Reader 12 and
Academic 4 legacy methods remain (59 total); Reader's document Note is pending.
No completion of Memory's full writer/provenance/approval closure or Job migration
is claimed. No later block is included.

Focused real-PG core/boundary gate: six files / 76 passed, exit 0
(`relationOperationsDb`, `operationRoutes`, `policyDecisionContract`,
`policyEnforceService`, `boundaries`, `testHygiene`). Existing Relations consumers:
18 DB tests and 3 service tests passed. Earlier new-test fixture failures were
repaired and rerun explicitly. An earlier sandbox invocation skipped 23 PG cases;
only the REQUIRE_TEST_POSTGRES=true reruns above are durable-behavior evidence.
No full package suite, browser acceptance, independent review, Source/Note gate
rerun, migration, instance change or publication is claimed.

Protocol contract evidence: relationOperations/policy/operations 37 passed;
systemActions had two missing proposal metadata failures, repaired by naming the
existing object-relation proposal types/exposure class, then 23 passed on its
explicit rerun. This declares proposal semantics, not an executable approval
mapping. Protocol typecheck/build and server typecheck exit 0; agentGuides 8
passed. No budget threshold was changed.

Final Relations incremental evidence: server/web typechecks exit 0. The focused
PG file after metadata repair passed six cases, then seven with the added
Source deletion/admission lock race (`pg_blocking_pids` scoped to the fixture's
own database proves the waiter). Citation writes nothing after the Source
revocation commits. The inherited 27-file Note/Source delta was compared with
`9b1c80b2`; only this guide, Plan 5 and the explicitly extended release-lock
helper differ. This is a private partial checkpoint, not whole-block acceptance.


## Knowledge canonical serialization follow-up (partial)

`knowledgeGroup.test.ts` now covers two real-PG archive-versus-update races
through the real Proposal registry and canonical appliers (Claim and object
profile). A lock-wait witness orders the late update behind archive. Both fail
on the original `5d11e2f9` applier and pass on the fixed tree; the stored archived
state and original content/label remain. Claim target/successor roots are locked
in sorted order, Knowledge version mutation locks root before extension, and
profile mutations read status/preserved fields under their row lock.

Final affected consumers: `knowledgeGroup` 19 + `claimGroup` 10 +
`objectProfileRegistry` 18 = 47 passed, 3 files, exit 0, shared real PostgreSQL.
The baseline negative run was exit 1 with 2 failed / 17 filtered skips. An initial
invalid profile key fixture failed and was corrected. Server typecheck and
protocol build exit 0. Guide/structure checks: agentGuides 8, boundaries 5, testHygiene 12;
25 passed across 3 explicit files, exit 0. Diff check exit 0.
No production approval mapping enabled; this does not qualify current Project,
Source, provenance, Reader IO or Memory writer closure. No browser/full suite or
independent review. Inventory unchanged: 636 = 228 legacy + 53 exempt + 355 core;
59 block entries still pending. P5 and the whole block remain in progress.


## Knowledge / Memory continuation after the orphaned Codex layer (partial)

Basis: `6f62a496` (parent `0aaf969b` → `82e1d240`), adopted by fast-forward from
the orphaned run's clean worktree; that layer's own last logs were failing
(5 failed / 30 passed; 3 stale-build web type errors) and are not counted.
This continuation adds Knowledge object-kind/schema-import proposals, Knowledge
and Memory retrieval feedback/reindex and a person's own Memory commands.

Repairs found by tests, not assumed: (1) Knowledge proposal writer refusals came
back as 500 through the core — now 422 with their text; (2) the apply-time
authority wrapper hard-refused ownerless proposals, narrowing an existing Agent
path — it now defers to the base applier's rules; (3) validation-only fake-DB
Claim cases could not answer the new authority reads — the fake answers them,
and the authority replay itself has real-PG coverage; (4) the executor catalog
pin had never included the inherited Relations10 ids; (5) mock-pool/service-mock
route tests of removed handlers were replaced by real-PG adapter tests.

Negative control: with the apply-time authority wrapper disabled, the new
"replays the proposer's current source authority" case fails (exit 1, the
approval resolves instead of rejecting); restored before every positive run.
Concurrency evidence (real row waits): object-kind submission refused after a
committed role demotion; Memory restore refused after a committed ownership move;
Knowledge proposal refused after the cited source became unreadable.

Final verification (Node 24.22.2, shared real PostgreSQL, REQUIRE_TEST_POSTGRES=true):

| Check | Terminal result |
|---|---|
| protocol `tsc --noEmit`, build | exit 0, exit 0 |
| protocol policy, systemActions, operations, knowledgeProposalOperations, relationOperations | exit 0; 5 files / 63 passed |
| server `tsc -p tsconfig.typecheck.json --noEmit` | exit 0 |
| web `tsc --noEmit` | exit 0 |
| server targeted: 4 new real-PG files, Claim/Knowledge/object-profile groups, retained Knowledge/Memory route files, executor catalog, inventory, policy contract/enforce, 12 applier/proposal consumers, agentGuides, boundaries, testHygiene | exit 0; 29 files / 378 passed; no skips |
| web `src/modules/knowledge`, `memory`, `context_ops` | exit 0; 16 files / 135 passed |
| `git diff --check` | exit 0 |

Inventory 636 = 205 legacy + 53 exempt + 378 core; 36 block entries remain
(Plan 5 lists them and the open contract decisions). The policy fixture changed
only by the six new actions. No package-wide suite, browser batch, independent
review, approval mapping, migration, deployment or instance operation is claimed;
partial-run budget totals are not checked by design and no threshold changed.


## Knowledge/Memory request Jobs and Academic continuation (partial)

Basis: the complete private `212919e1` tree, including Note/Source, Relations10,
canonical Knowledge serialization and Claude's 23-URL Knowledge/Memory layer.
The new slice migrates eight content-bearing request URLs and four Academic
mutation URLs; it does not complete the authorized block.

Requests use the existing Job queue and Source single-attempt/effect claim
fence. Admission stores identity/status only. Dedicated requester readers lock
canonical Knowledge/Memory roots, subtype rows, audience/folder scopes, shares,
grants, provenance/Claim-source lineage and Source consent/subscription closure;
rediscovery after waits refuses scope drift. Canonical adapters and privacy audit
run before release. Any summary/denied contributor withholds the entire old
result, including synthesis/provenance/diagnostics. Ordinary Memory search
rereads current active canonical rows. Generic Jobs suppress the stored result.
Explain keeps live maintenance-role checks. Browser callers submit once, then
poll only the owning reader in the receipt Space. Academic keeps access-owned
creation placement, owner/Project authority and canonical author/citation
proposal submission in one joined core transaction.

Final affected checks (real terminal results; tests used Node 24.22.2 and
REQUIRE_TEST_POSTGRES=true, no final skips):

| Check | Result | Raw log basename |
|---|---|---|
| Academic core + existing Academic domain | exit 0; 2 files / 17 passed | `rainver-academic-db.log` |
| Knowledge/Memory retained route consumers | exit 0; 2 files / 19 passed (the same run also had 6 then-current request tests; use the final 8-test run below for that file) | `rainver-content-consumers.log` |
| Content requests, shared Source release and actual Fastify inventory | exit 0; 3 files / 35 passed | `rainver-content-final-db.log` |
| Operation catalog/executor, guides, boundaries, test hygiene | exit 0; 4 files / 98 passed | `rainver-content-structure.log` |
| Protocol Academic/request schemas and policy fixture | exit 0; 3 files / 15 passed | `rainver-content-protocol-tests.log` |
| Web request polling/refusal/ordinary Memory shape | exit 0; 1 file / 3 passed | `rainver-content-web-tests.log` |
| Protocol build and typecheck; server and web typechecks | exit 0 each | `rainver-content-protocol-types.log`, `rainver-final-protocol-types.log`, `rainver-final-server-types.log`, `rainver-final-web-types.log` |
| `git diff --check` | exit 0 | `rainver-final-diff-check.log` |

Distinct final server files: 11 / 169 passed. This does not add earlier iterations
to the count. Meaningful real-PG coverage includes one-attempt Job intent/replay,
worker settled-attempt replay, generic Job result suppression, summary/private
revocation with no old synthesis/provenance, a real root-lock wait followed by
committed demotion, canonical Source provenance/consent withdrawal, active
Memory rereads/archive withdrawal, explain role withdrawal and safe Artifact
metadata, and Academic proposal-only graph edges/owner withdrawal.

Initial pnpm build failed on an unwritable shared store; local dependency links
and package builds resolved it without changing the shared checkout. The first
sandbox Academic run skipped 15 tests because Docker was unavailable; the
subsequent authorized real-PG run executed all 17, and that is the final evidence.
Initial new request tests exposed an invalid summary fixture (an owner retains
full access) and an incorrect getJob test signature; corrected before the final
positive runs. No assertion/budget threshold was relaxed. No package-wide suite,
browser batch or independent review ran; prior 29-server/16-web/5-protocol groups
are not recounted as this slice's evidence.

Verified inventory: **636 = 193 legacy + 53 exempt + 390 core**. **24 block URLs
remain unimplemented: Knowledge scans/reports 8, Memory maintenance/Job/
consolidation 4, Reader 12.** Existing Jobs plus authorized result release are the
person's accepted scan contract, not a pending permission request. The existing
Source split adapter is the Reader discriminator precedent; no one-URL/one-op
restriction blocks that work. The whole block and P5 remain in progress.
No migration (0000–0018 unchanged, no 0019), production approval mapping, new
Task, delegation, independent review, formal commit, prepare/publish/push,
deployment, webhook, restart or instance database action is claimed.

## P5 continuation: report/scan request adapters (partial block)

This continuation adopts the complete private candidate tree at `f0da6901`
(direct parent `212919e1`) by fast-forward in the isolated branch; no old tree
replacement or shared target update occurred. It migrates **12 retained URLs**:
Knowledge maintenance, eval report, calibration record, diagnostics, Claim Candidate
packet, contradiction scan, relation discovery and object-schema suggestion scan;
Memory maintenance scan, maintenance Job create/run and Activity consolidation.
The operations submit one-attempt `content_retrieval_request` Jobs and cache only
identity/status receipts. The existing Knowledge/Memory request readers release
results under current person/Space/Context Ops access, root/provenance/Source
consent locks and B11 audit. A refused nested reference withholds the whole old
result, including counts. Generic Jobs still suppress result bodies. No new
execution or approval engine, production approval mapping, active-Memory writer,
provider channel, schema migration or deletion execution is introduced.

Maintenance Job page execution is owner-only: shared read permission does not
let another person execute a page using the owner's Memory authority. Consolidation
keeps its per-activity canonical transaction and proposal path; normal and failure
writes recheck the person, object and current Job claim in that transaction.
Report services join the Job's transaction. Scan queries on one transaction
connection are sequential, including Source-policy and role reads.


Verification (same isolated runtime, Node24.22.2): final exact terminal commands
and logs are recorded below after checks finish. Earlier report+canonical
consumer run:7 files/38 pass; all-variant+inventory/scanner run:5 files/36 pass;
consolidation consumers:4 files/64 pass. These overlap and are not summed.
Protocol3 files/27 pass; web typed polling1 file/4 pass. No skips reported in
these groups. New durable request tests use shared real PostgreSQL; existing
consumer groups include legacy SQL-boundary tests and their expected missing
retrieval_aliases/savepoint diagnostic messages, not production DB evidence.

Initial limitations/failures: the clean worktree had no dependencies; first pnpm
checks exited1 before compilation (cache DB, then PATH's colon delimiter).
Frozen offline dependencies were installed without version changes, and actual
compiler/runner entrypoints were invoked with Node24 from each owning package.
Initial protocol compilation rejected .strict() on an already-refined schema;
fixed by preserving that strict refined schema. Server compilation exposed
unused transport scaffolding and one incomplete test input; fixed. PostgreSQL
was unavailable inside the ordinary sandbox (exit1, no tests); the approved
shared temporary-container run supplied the actual results above. No fake DB
fallback, performance threshold change, full-suite or visual claim was made.

Final terminal evidence for this private report slice (no full-suite claim):
- `server/`: Node24 `node node_modules/vitest/vitest.mjs run
  test/contextReportOperationsDb.test.ts test/retrievalMaintenanceGroup.test.ts
  test/agentGuides.test.ts` with REQUIRE_TEST_POSTGRES=true: **exit0,
  3 files/27 pass/0 skip**, including10 real-PG request regressions. Log
  `p5-report-final-verification.log`. All12 request variants executed; private
  report/packet atomic rollback and cancelled-claim refusal covered.
- `server/`: report+Activity consumers: **exit0,4 files/64 pass/0 skip**,
  `p5-report-consolidation.log`. The noted legacy diagnostic messages remain;
  the report transaction no longer emitted pg's concurrent-client warning.
- `server/`: actual route inventory plus three scan consumers and request file:
  **exit0,5 files/36 pass/0 skip**, `p5-report-final-db.log`.
- `packages/protocol/`: content request/report/system-action files: **exit0,
  3 files/27 pass**, `p5-report-protocol-tests.log`.
- `apps/web/`: `src/__tests__/content-retrieval-api.test.ts`: **exit0,
  1 file/4 pass**, `p5-report-web-tests.log`.
- Final Node24 compiler invocations: server `-p tsconfig.typecheck.json`,
  protocol/web `--noEmit`: **exit0**; their three `*-types-final.log` files
  are empty. Protocol build and required workspace dependency builds also
  exited0. `git diff --check`: **exit0**. No migration delta againstf0da.

Four old synchronous POST route/fake-pool files were removed. The new real-PG
request tests protect their transport/role/strictness/packet boundaries; existing
Claim Candidate packet, Memory maintenance DB/Jobs, relation discovery and schema
suggestion tests retain domain findings, source promotion and atomicity coverage.
The advisory trajectory GET still uses its original service, with the existing
claim review-loop service tests and a route validation check. This is not a
claim of unchanged test count or a full browser/domain acceptance run.

Private snapshot only; Reader12 and parent-owned independent review/final block
gates remain outstanding. No permission/decision blocker or completed P5 is
asserted. Report files are not a handoff or a new Task.


### Reader internal writer transaction foundation — partial continuation

The isolated checkout fast-forwarded to the complete private candidate
`a5b5c8ce4f5e8a8080f9a6719f0d67ef33042a4b` (direct source parent
`f0da69013add77129657c25f81941e040f9dfb67`), preserving all preceding block
implementations. The complete block baseline remains `9b1c80b2`. This slice adds
Reader internal DB-only writer transactions and target/document/annotation grant
fences, not the final Reader operation family. Plan05 and READER describe the
exact changed owners and still-open closure. Inventory remains
**636 = 181 legacy + 53 exempt + 402 core; Reader12 remains unfinished**.

Terminal evidence in this runtime, Node24.22.2, shared real PostgreSQL fixtures:

- `node node_modules/vitest/vitest.mjs run test/readerDocumentFidelityDb.test.ts
  --maxWorkers=1`: **exit0, 1 file/13 tests passed**, no skipped tests.
  Includes the three new internal-writer invariants: document recycle waits for
  annotation commit, inherited Evidence-grant failure rolls back Evidence, and
  comment edits refuse after document access loss. Log:
  `/tmp/reader12-writer-pg.log`.
- Final affected route/guide/hygiene command:
  `node node_modules/vitest/vitest.mjs run test/sourceReaderRoutes.test.ts
  test/agentGuides.test.ts test/testHygiene.test.ts --maxWorkers=1`:
  **exit0, 3 files/36 tests passed**, no skips; includes16 real-PG Reader
  route/derivation cases,8 guide cases and12 hygiene cases. Log:
  `/tmp/reader12-targeted.log`. The earlier standalone16 route cases overlap,
  so do not add their count again. The old SQL-fake route file was replaced by
  real behavior tests; it is not evidence for transaction/ACL behavior.
- Server `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json`:
  **exit0** (`/tmp/reader12-types.log`). Workspace protocol, Reader document,
  outbound guard and folder-read dependency builds: exit0; those are dependency
  builds, not protocol contract tests. `git diff --check`: exit0.

Initial attempts failed before tests: no local dependencies, pnpm tried its
read-only cache DB; then the reused dependency cache pointed Vite's temporary
output at a read-only directory, and the local compiler shim was absent.
Dependencies were linked read-only with local workspace-package targets and local
writable test caches; no shared source/dependency directories were modified.
Sandboxed Docker discovery was unavailable; the approved test-container command
used only fixture databases. Initial compiler errors from missing built workspace
packages disappeared after local dependency builds. The first old fake-route run
failed14/33; after conversion, real fixture failures (invalid SourceItem type and
incorrect Project/Source binding assumptions) were repaired. Final assertion
failures are zero; no budget threshold was edited and no budget-only failure
occurred in the final commands.

No protocol/web source changed, so no repeated protocol/web/browser group was
run. No UI presentation change, full package suite, whole-block independent audit,
formal commit, prepare/publish/push, instance restart/deployment or user-data
removal occurred. All evidence here is terminal. Remaining work is implementation,
not an asserted permission/design blocker: complete nested report/notebook
provenance locks, outside-transaction FS preparation plus existing Job/effect/claim
settlement, formal typed operations/two proposal variants, current-authority
identity-only replay, typed consumers and final inventory. The parent must still
perform the authorized whole-block independent review after Reader12 is complete.

## Reader12 completion and Knowledge / Relations / Memory / Reader block closure (candidate)

Scope and adoption: Plan05's matching heading. Inventory is the actual Fastify
registration regenerated by `UPDATE_OPERATION_ROUTE_INVENTORY=1` and then
re-verified without it: **636 = 169 legacy + 53 exempt + 414 core**; against
`9b1c80b2` exactly 69 block URLs moved (Knowledge 27, Memory 16, Reader 12,
Relations 10, Academic 4), none added or removed.

Terminal evidence (shared real PostgreSQL fixtures; server via Node 25.2.1 with
the package-local binaries; web tests via Node 24.22.2, the pinned engine):

- Repaired 52fb layer before new work: `sourceReaderRoutes` +
  `readerDocumentFidelityDb`: exit 0, 2 files / 29 tests
  (`/tmp/reader12-final-pg1.log`); server types exit 0.
- New `test/readerOperationsDb.test.ts`: 401 on all 12 URLs, key required,
  identity-only receipts, replay equality, reused key refusal, replay hidden
  after document loss, cached domain refusal without write, all canonical
  writers through adapters incl. Undo restore, cross-member 404s, both proposal
  kinds via one URL with `proposal.create` audit and no Memory/Knowledge rows,
  unsupported/restated proposal refusal, file-backed position Job (one attempt,
  applied/not_accepted, status-only reader, generic `/jobs` result null,
  requester-only), range Job (non-author refused, cancelled claim writes nothing,
  applied, stale → conflict), sealed preparation never reads a new file.
- Final Reader PG group (`readerOperationsDb`, `sourceReaderRoutes`,
  `readerDocumentFidelityDb`, `readerPositionsDb`, `readerSourceVersionsDb`,
  `projectReadingRecordsDb`, `readingDb`): **exit 0, 7 files / 126 tests**
  (`/tmp/reader12-final-pg-group.log`).
- Cross-cutting consumers (`operationExecutorDb`, `systemActionRegistry`,
  `policyEnforceService`, `policyDecisionCore`, `operationRoutes`,
  `contentRetrievalOperationsDb`, `jobsRunSettlementDb`): **exit 0, 7 files /
  174 tests** (`/tmp/reader12-final-consumers2.log`).
- Guides/hygiene (`agentGuides`, `testHygiene`): exit 0, 20 tests
  (`/tmp/reader12-final-guides.log`).
- Protocol: build exit 0; `readerOperations`, `policy`, `systemActions`,
  `operations`: exit 0, 4 files / 61 tests (`/tmp/reader12-final-protocol.log`).
- Web (Node 24): Reader consumers (`ReaderWorkspace`, `readerWorkspaceTools`,
  `readerPosition`, `LibraryItemReaderPage`, `ResearchReportPage`,
  `ProjectSourcesPage`, `ResearchAreaPage.workbench`): exit 0, 7 files / 186
  tests (`/tmp/reader12-final-web2.log`); new `reader-write-api` client test:
  exit 0, 6 tests (`/tmp/reader12-final-web3.log`); web types exit 0.
- Server types exit 0 (`/tmp/reader12-final-types3.log`); `git diff --check`
  exit 0.

Failures met and how they were resolved (no threshold edited):
- `52fb0483` as found: 3 type errors and 16 failing PG tests in the cancelled
  run's own log (`/tmp/reader12-cont-*.log`); repaired as described in Plan05.
- First consumer run ended **exit 124** (600 s timeout): `readerPositionsDb`
  hung after two failures the inherited 47b fence caused — a body rewrite during
  the wait became a 409 instead of "not accepted", and the test's pause hook
  assumed the pre-fence lock order, so its gate was never released. The rerun
  just after the killed run lost its connection at startup (orphaned per-file
  database cleanup), exit 1, no test ran. Fixed by re-pinning a same-root body
  move once and pausing after the document-row lock; then a third inherited
  regression (author's Undo of an archived annotation refused) surfaced and was
  fixed. Final file run: 22/22 exit 0, and the full group above.
- Web tests under Node 25.2.1: all 186 failed with
  `window.localStorage.setItem is not a function` (Node 25's own `localStorage`
  global shadows jsdom); the same files pass under the pinned Node 24.

Limits: no full package suite, no browser batch (no presentation change: the
Reader UI renders the same data, only the transport changed), no independent
review yet, no formal commit/push/prepare/publish, no deployment, restart,
webhook or instance-DB action, no user-data deletion. Position saves now wait
for a one-attempt Job (polling from 150 ms, ≤1 s); a page-exit keepalive report
is sent once and not awaited. Research-report closure locks were exercised by
the shared fence for Source documents and by the unchanged report read gate;
there is no dedicated concurrent report-closure PG case.

### Block review repair: Codex a3db290b (on candidate `2f21bcb5`, private checkpoint)

Scope and design: Plan05's matching heading; guides ARTIFACTS
("Retrieval-derived Briefs and Explain reports"), CONTEXT_AND_RETRIEVAL_LAYER,
READER "Write operations", knowledge-base. Inventory unchanged (636 = 169
legacy + 53 exempt + 414 core); 0000–0018 untouched, no 0019.

Terminal evidence (shared real PostgreSQL; server via Node 25.2.1 package-local
binaries; protocol/web via the server's `tsc`):

- New `retrievalArtifactReleaseDb` (7): lock-wait interleavings with an
  uncommitted holder proven to block the settlement (`waitForBlockedBy`), no
  sleeps — Job claim lost before INSERT → `JobEffectLeaseLost`, 0 Artifacts;
  contributor demoted → `RetrievalArtifactWithheld`, 0 Artifacts; Explain role
  revoked → withheld, 0 Artifacts; real worker Brief still persists under its
  claim; after demotion list/detail return summary rows without body/metadata,
  export 404, `contentDecisionFromDb` `deny`, Reader `assertArtifactReadable`
  404; Source consent withdrawal withholds a Brief and role loss an Explain;
  demoted Brief refused as packet source with no proposal, unrelated Artifact
  type unaffected.
- `readerOperationsDb` +2: real canonical producer (`saveSourceReadingDocument`
  + file-backed body) committed between sealed preparation and settlement →
  position `not_accepted`, 0 `reader_positions`, typed
  `ReaderWriteRequestViewSchema` consumer reads `not_accepted`; cancelled claim
  still refuses; same interleave on range → `conflict`, annotation unchanged.
- Negative control: with the wiring of the 7 changed consumers reverted (new
  module kept so imports resolve), the 7 new race/exit tests fail and the 13
  others pass — exit 1 (`/tmp/rr-negctl.log`); restored, all pass.
- Targeted server set (36 files: the two above, claim packets, content
  retrieval, explain/brief/eval/diagnostics groups, Project public, the Reader
  PG group, Source retrieval/processing/deep reading, artifacts routes, Ask
  Space, managed tools, Context Ops, content access, operation executor, Job
  settlement, `testHygiene`, `agentGuides`): **exit 0, 36 files / 410 tests**
  (`/tmp/rr-server.log`). Server types exit 0 (`/tmp/rr-types.log`).
- Protocol build exit 0; `knowledgeRetrieval`, `readerOperations`,
  `contentRetrievalOperations`: exit 0, 3 files / 14 tests
  (`/tmp/rr-protocol.log`). Web types exit 0 (`/tmp/rr-web-types.log`).

Failures met (no threshold edited): the first targeted run was exit 1 with
7 failures — fixtures whose Briefs cited objects that never existed (now
correctly withheld: claim packets and review-cycle tests now seed the real
Knowledge items), a fake-DB Explain payload test (moved to real PG), and the
Ask Space orchestration fake DB (now injects a persistence seam; authority is
covered on PG). A `vi.mock` attempt and barrel imports were refused by
`testHygiene` (exit 1) and replaced by the seam and deep imports.

Limits: no full package suite, no browser batch (no presentation change), no
independent re-review yet, no formal commit/push/prepare/publish, no
deployment/restart/webhook/instance-DB action. Managed-run tool Briefs are
persisted by Run settlement (outside this block) and protected only by the read
gate. Context Ops summaries are not gated (owner's own query title, surface and
diagnostic codes). Released Artifact list reads audit each contributor through
the release path. The Reader report nested closure still has no dedicated
concurrent race case, and not every writer of every closure dependency is
exercised.

### Block review repair: Codex 51e6826e (on candidate `f90bf452`, private checkpoint)

Scope and design: Plan05's matching heading; guides ARTIFACTS
("Retrieval-derived Briefs and Explain reports"), CONTEXT_AND_RETRIEVAL_LAYER,
knowledge-base. Inventory unchanged (636 = 169 legacy + 53 exempt + 414 core);
0000–0018 and `server/src/db/schema/` untouched, no 0019.

Terminal evidence (shared real PostgreSQL; server via Node 25.2.1
package-local binaries; workspace packages built with their own `tsc`):

- New `retrievalArtifactDomainClosureDb` (10), lock-wait interleavings with an
  uncommitted real-writer statement proven to block the settlement
  (`waitForBlockedBy`), no sleeps: Thread cut to `summary` through
  `ContentAccessService.updatePolicy` → full-saved Inquiry Brief withheld whole
  (detail summary row, export 404, artifact decision `deny`, Reader 404) while
  the Thread stays summary-readable; Thread downgrade and Project membership
  revocation during settlement → `RetrievalArtifactWithheld`, 0 Artifacts;
  extension-row-then-root writer (`inquiry_threads` / `knowledge_items` then
  `space_objects`) → settlement waits on the extension row and completes
  without deadlock; publication revoke (`projects FOR UPDATE` + delete) and
  publication Source consent withdrawal during settlement → withheld, old
  Brief withheld after; Ask Space session with a failed-to-save Inquiry
  Brief → session withheld whole after the Thread is cut while the Knowledge
  Brief stays released; Thread cut during the combined synthesis → session
  settlement waits, then `ask_space_session_withheld`, 0 sessions (2 Briefs);
  legacy/missing-nested-Brief/out-of-domain sessions fail closed, a resolvable
  one is released.
- `retrievalArtifactReleaseDb` +1 assertion: Context Ops Explain drill-down
  codes released, then cleared after role loss. `contextOpsDrilldownArtifacts`
  (fake DB) now expects fail-closed codes; `askSpaceService` injects an
  orchestration session seam.
- Negative control: with `server/src` reverted to `f90bf452` (new test file
  kept), all 10 new tests fail — exit 1 (`/tmp/p1-before.log`), including
  PostgreSQL `deadlock detected` for the Knowledge writer order the f90 closure
  already had; restored, 10/10 pass (`/tmp/p1-after.log`).
- Targeted server set (30 files: the two above, Ask Space, claim packets,
  content retrieval, Context Ops, context reports, Knowledge/Memory/Source
  retrieval operations, Reader operations and Source Reader routes,
  explain/brief/eval/diagnostics groups, Project public, Inquiry read plane,
  artifacts routes, Source policy, shared authorizers, capture filing,
  Knowledge proposals, `testHygiene`, `staticSqlPrepare`): **exit 0, 30 files /
  241 tests** (`/tmp/p1-consumers.log`). `agentGuides` + `boundaries` exit 0,
  13 tests (`/tmp/p1-guides.log`). Server types exit 0 (`/tmp/p1-types.log`).
  No protocol or web change.

Failures met (no threshold edited): the first consumer run was exit 1 with one
failure — the fake-DB Context Ops Explain drill-down, which can confirm no
maintenance role and so now correctly fails closed (released path moved to
PG).

Limits: no full package suite, no browser batch (no presentation change), no
independent re-review yet, no formal commit/push/prepare/publish, no
deployment/restart/webhook/instance-DB action. Sessions written before this
gate have no `contributions` and stay withheld (no runtime decoding, B58).
A Project public summary has no per-person root; it rests on its live
publication, active Project and Source policy. Managed-run tool Briefs remain
persisted by Run settlement behind the read gate only. Writers whose order was
checked: Knowledge applier, Inquiry Thread/problem-fact writers, content access
policy, Project public summary publish/revoke, Project membership; not every
writer of every closure dependency is exercised.

## Block review repair: Codex 286a74da (candidate on 72b33cc2, private)

Scope: the two P1 findings in Plan05's matching heading; no route, protocol,
schema, migration or web change (inventory 636 = 169 + 53 + 414 unchanged;
`0000-0018` untouched, no `0019`).

Writer audit (code, not helper names): root → extension — `writeNote`,
`applyNoteOpsWithConflictFallback`/rollback, Note metadata CTE
(`repository.ts`), `assignNoteProjectRole`, capture relocation `lockNote`,
Knowledge update/archive and Claim update/archive (`lockMutationRoots`, then
`knowledge_items`/`claims`, then `claim_sources`), Source object update CTE,
Inquiry `authorizeInquiry` (roots, then `inquiry_threads`). Extension → root —
Inquiry `iterationService`, `threadService`, `problemFacts`, research
`checkPinnedThreadDrift`: every one after `lockActiveProjectForMutation`
(`projects FOR UPDATE`). Publication publish/revoke: Project `FOR SHARE`,
`project_public_summaries`, then only the publication row. No
`provenance_links` updater; `claim_sources` deleted only after the Claim root.
Hence one closure order (all `FOR SHARE`): Projects → person/Space/folders/
roots/grants/channels → extension rows → provenance/claim sources.

Terminal evidence (shared real PostgreSQL fixtures, package-local binaries,
lock barriers via `waitForBlockedBy`, no sleeps):

- `retrievalArtifactDomainClosureDb` — the two synthetic
  "extension-then-root without a Project lock" cases (no such writer exists)
  replaced by real writers held at their own first lock, then completed in the
  same transaction: Note save (`updateNote`), Note rollback (`rollbackNote`),
  Knowledge update applier (`registerKnowledgeProposalAppliers`; Brief then
  withheld as superseded, 0 Artifacts), Inquiry `reviseDefinition`, and one
  mixed release (Inquiry + Knowledge note/item groups in reverse order) across
  all three writers at once (resolves 1 withheld: the superseded head).
  Negative control with the 72b placement (extensions after Projects):
  exit 1, 4 failed / 1 passed — PostgreSQL `40P01 deadlock detected` for Note
  save, Note rollback, Knowledge applier and the mixed case; the Inquiry case
  passes both ways (Project serialization). Fixed: exit 0, 13/13.
- `contextReportOperationsDb` +2: a real `knowledge.maintenance.scan` whose
  finding names a Source-derived item — consent withdrawn (Knowledge root
  still `full`) → poll `result` null with no title/id; consent restored →
  released; withdrawal committed while the poll waits on the closure →
  withheld. Negative control with the 72b `contextReports.ts`: exit 1, both
  fail (findings and counts returned). Fixed: exit 0, 12/12, including the
  existing demotion/Memory report cases (the first fixed draft used the
  projection-bound `revalidateForRelease` and withheld two legitimate
  unindexed reports — exit 1, 2 failed — hence the canonical gate).
- Consumers: `captureRelocationDb`, `noteProjectRoleDb`,
  `noteProjectRoleGuard`, `noteWriterDb`, `noteControlOperationsDb`,
  `retrievalArtifactReleaseDb`: exit 0, 6 files / 73 tests. Server typecheck
  (`tsconfig.typecheck.json`, tests included) exit 0.

Limits: consent withdrawal is a direct `consent_json` update (no dedicated
consent-edit writer exists in code); relocation and role-assignment root-first
locking is covered by their existing behavior tests, not by a dedicated lock
barrier; Inquiry personal-focus admission (root then Thread under Project
`FOR SHARE`) is covered by the order, not a test. Report references to
Artifacts, Proposals and Activities keep their `contentDecisionFromDb`
decision (they carry no Source connection). Open, not fixed here: a persisted
`retrieval_maintenance_report` Artifact (`persist_report`) is read through the
generic Artifact exits, outside the retrieval-derived gate, so its body is not
re-gated on Source consent. (Repaired in "Block review repair: Codex ccc494de" below.) No full suite, no browser batch, no independent
re-review, no formal commit/push/prepare/publish, no deployment action.

## Block review repair: Codex ccc494de (candidate on 72319d4c, private)

Scope: the one confirmed P1 — a persisted report Artifact bypassed the poll
gate. No route, protocol, schema, migration or web change (inventory 636 =
169 + 53 + 414 unchanged; `0000-0018` untouched, no `0019`). The Antigravity
16c42bc5 claim that `lockMutationRoots` is fictitious is wrong (it exists in
`proposalApplier.ts` and takes the roots `FOR UPDATE` first); the 72319 root
order is kept and no writer changed.

Repair: `withheldContextReport` (`contextReports.ts`) is the one report
closure, used by the poll (`releaseContextReport`) and by
`retrievalArtifactWithheld` for every type in
`CONTEXT_REPORT_ARTIFACT_OPERATIONS` (maintenance, Memory maintenance, eval,
diagnostics, calibration, contradiction, claim candidate packet, relation
discovery, object schema suggestion, review cycle, observation). The stored
metadata's references (`contextReportReferences`, which reads
`findings[].objects`), the operation's current authority, `full` per
reference and the canonical Source policy gate are checked in one
transaction; any refusal withholds the report whole, and a maintenance
finding without well-formed object refs fails closed. Exits: Artifact
list/detail/export (count-bearing title → type label),
`contentDecisionFromDb('artifact')`, Reader, Claim Candidate Packet sources,
eval diagnostics, Context Ops summary counts/diagnostics, maintenance and
diagnostics drill-downs, and maintenance packet titles. Contract:
[ARTIFACTS](ARTIFACTS.md#persisted-knowledge-and-memory-reports).

Terminal evidence (shared real PostgreSQL, package-local binaries; the
worktree path contains `:`, so `pnpm exec` cannot add `.bin` to PATH and the
same binaries were run with `node`):

- `contextReportOperationsDb` +5: real `knowledge.maintenance.scan`
  (`persist_report`, `create_packet`) naming a Source-derived item → released
  at detail/list/export/Reader/decision/Context Ops summary, drill-down and
  packet title; consent withdrawn (Knowledge root still `full`) → poll null,
  detail/list `content`/`metadata_json` null with the type label, export 404,
  decision `deny`, Reader 404, summary `finding_counts` `{}`, drill-down
  finding count null, packet title without the count, Claim Candidate Packet
  refused (404); consent restored → released again. A real
  `memory.maintenance.scan` report whose Memory has the Source as provenance
  → withheld after withdrawal. Withdrawal committed while the Artifact read
  waits on the closure → withheld. A legacy maintenance report without
  finding object refs → withheld; the author demoted to member → withheld.
  A released diagnostics report aggregates codes/trend in Context Ops; after
  the demotion they are dropped.
- Negative control (the 72319 `server/src` with the new tests): exit 1, 4
  failed / 12 passed (the diagnostics case was added after the control).
  Fixed: exit 0, 17/17.
- Consumers (27 files, including `testHygiene`): exit 0, 233/233. Three
  fixtures changed with the contract: `claimCandidatePackets` seeds the
  objects its maintenance reports name and uses the real Memory finding
  shape (`objects`, not the legacy `memories`); the fake-database
  `contextOpsService`/`contextOpsDrilldownArtifacts` cases now expect derived
  counts and codes to fail closed (a fake proves no closure; release is
  covered on PostgreSQL above); `retrievalArtifactReleaseDb` uses an
  ungated type for its "unrelated Artifact" control, since
  `retrieval_eval_report` is now gated.
- Server typecheck (`tsconfig.typecheck.json`, tests included) exit 0.

Limits: the maintenance/diagnostics/claim packet Proposals carry the same
findings in `payload_json`, and generic proposal list/detail do not pass this
gate (only their Context Ops titles do) — repaired in "Block review repair:
Codex 97192023" below; a report reference whose type has no
content resource definition fails the whole report closed, as at poll;
`recent_report_count`/`pending_packet_count` still count the viewer's own
rows. Consent withdrawal is a direct `consent_json` update. No full suite, no
browser batch, no independent re-review, no formal
commit/push/prepare/publish, no deployment action.

## Block review repair: Codex 97192023 (candidate on b7c69a4c, private)

Scope: the three confirmed P1s — producers that dropped dependencies, and
report-derived Proposals outside the report gate. No route, protocol,
schema, migration or web change (inventory 636 = 169 + 53 + 414 unchanged;
`0000-0018` untouched, no `0019`). The root-first lock order and
`lockMutationRoots` are unchanged.

Repair:

1. **Diagnostics dropped its inputs.** `buildRetrievalEvalDiagnosticsReportWithSources`
   returns the released Briefs/maintenance/eval reports it aggregated; the
   diagnostics report (operation and review cycle) stores them as
   `source_artifact_ids` with `dependency_closure: {version: 1}`, and the poll
   result carries them too. Each read rechecks them recursively
   (`contentDecisionFromDb` → `retrievalArtifactWithheld`), with the report
   chain tracked so a cycle or a chain deeper than 8 fails closed. Unstamped
   diagnostics → withheld; stamped with `[]` → released.
2. **Schema suggestions dropped object ids.** Each usage finding now names one
   `evidence_refs` entry per counted row; the stored report is stamped. A
   count without its rows (stored or at poll) or an unstamped report →
   withheld; a stamped report with no usage findings → released.
3. **Proposals.** `proposalReportWithheld` gates Proposal list/detail fields
   (title → type label, `proposed_content`/`rationale` empty, provenance
   null), Context Ops packet titles, and acceptance (409, closure pinned
   before the Proposal row lock, frozen dependencies compared after it).
4. Same inventory found the observation report counting released
   maintenance/diagnostics findings without naming them: it now records
   `source_artifact_ids` from `getSummaryWithSources` and is stamped.
   Matrix: [ARTIFACTS](ARTIFACTS.md#persisted-knowledge-and-memory-reports).

Terminal evidence (shared real PostgreSQL, package-local binaries run
directly because the worktree path contains `:`):

- Negative control (b7c69a4c `server/src`, new tests): `contextReportOperationsDb
  -t "report poll release"` exit 1, 5 failed / 6 passed / 10 skipped
  (diagnostics legacy `full` not `deny`; diagnostics names no source; schema
  finding without refs; Proposal read not waiting on the withdrawal; report
  cycle hung to the 30 s timeout). Fixed: `contextReportOperationsDb` exit 0,
  23/23, including real persisted diagnostics + packet → consent withdrawn →
  Artifact detail/list/export, Context Ops summary/drill-down, Proposal
  detail/list, poll, decision, Reader all withheld, accept 409 and status
  still pending → consent restored → released, accept 200; schema report
  with per-row refs withheld after withdrawal, legitimately empty report
  released, legacy denied; Proposal read waiting on an uncommitted
  withdrawal then withheld; observation report counted/empty/legacy; report
  cycle denied in under a second; dependency naming for packets/children.
- Consumers (28 files: Context Ops, retrieval eval/diagnostics/maintenance/
  release, claim packets, Memory maintenance, relation discovery, object
  schema, proposals routes/apply/registry, nested owners, transitions,
  Source policy, Ask Space): exit 0 after one fixture change —
  `contextOpsContextObservations` mocks `getSummaryWithSources` and asserts
  the stored closure.
- Server typecheck exit 0.

Limits: scan-footprint and Context Ops health counts are not in the closure
(see ARTIFACTS); consent withdrawal is a direct `consent_json` update. No
full suite, no browser batch, no independent re-review, no formal
commit/push/prepare/publish, no deployment action.

## Block review repair: Codex 46775200 (candidate on 2c723008, private)

Scope: the two remaining P1s, found by tracing each producer through
persistence, the DTO, acceptance and the post-lock comparison. Both were
hand-built reference shapes that passed while the production shapes slipped
past the gate. No route, protocol, schema, migration or web change (inventory
636 = 169 + 53 + 414 unchanged; `0000-0018` untouched, no `0019`). Lock order,
B10 appliers, Agent `proposal.decide` and reject are unchanged.

Repair:

1. **Nested child report context.** Claim Candidate Packet children
   (`claim_create`, `object_relation_create`) store their packet context in
   `metadata.claim_candidate_packet` and their source report in
   `metadata.source_artifact_ids`. Relation discovery children
   (`object_relation_create`, `knowledge_create`) store theirs in
   `metadata.relation_discovery_packet.source_report_artifact_id`. The shared
   child INSERT keeps both shapes as built. `proposalReportDependencies` now
   reads these nested shapes beside the top-level keys (maintenance and Memory
   maintenance children). Proposal list/detail, acceptance and the post-lock
   dependency comparison all use this one extractor, so they gate the children
   too. A nested context that names no report fails closed. Per-producer
   matrix: [ARTIFACTS](ARTIFACTS.md#persisted-knowledge-and-memory-reports).
2. **Project public summary exemption removed.** The schema scan names each
   counted published summary (`project_public_summary` / Project id) and
   counts it only while the publication's `source_refs_json` Sources pass the
   viewer's policy. `schemaSuggestionFindingsClosed` no longer accepts a
   positive count with `[]`. `withheldContextReport` routes these refs into
   the shared release closure through the Project retrieval registry, which
   pins the Project audience and the publication row and requires the live
   publication, an active Project and Source policy, as for Ask Space and
   Briefs. No separate ACL was added.

Terminal evidence (shared real PostgreSQL, package-local binaries run
directly because the worktree path contains `:`):

- Negative control (2c723008 `server/src`, new `reportProducerShapesDb`):
  exit 1, 7 failed / 0 passed. Children report no dependencies (`null`). The
  claim child's accept does not wait on the uncommitted withdrawal. The
  stored Project-summary finding has count 1 with `evidence_refs: []` and stays
  released.
- Fixed: `reportProducerShapesDb` exit 0, 7/7.
  - Claim packet from a real maintenance duplicate yields an
    `object_relation_create` child; claim packet from a stored Brief's uncited
    claim yields a `claim_create` child; a real relation discovery scan yields
    `object_relation_create` and `knowledge_create` children.
  - In each case, after Source consent is withdrawn: child detail/list show
    the type label with no derived text, and accept returns 409 with status
    still pending and no canonical row. The `claim_create` accept waits on the
    uncommitted withdrawal and then returns 409. Reject still returns 200.
    Once consent is restored, accept runs the B10 applier (200).
  - Project-summary schema report released, then withheld at Artifact
    detail/list/export, poll, Context Ops summary, content decision and Reader
    after: consent revoke (released again on restore); real publication revoke
    (released again on republish); a publication delete committed while the
    read waits; and Project archive.
  - A rescan with no usage is legitimately empty and released. A stored
    positive Project-summary count with `[]` is denied.
- Consumers (21 files: claim packets, relation discovery (unit and DB),
  object schema, Ask Space, Context Ops (review cycle, routes, service,
  observations), report operations, retrieval Artifact release and domain
  closure, Project public summaries, proposal applier registry, claim and
  proposal DB tests): exit 0, 161/161, no skips. Per-test budgets held.
- Server typecheck exit 0.

Limits: the `claim_create` source Brief is stored with the Brief persisted
shape, because its uncited claim is LLM synthesis output; everything after it
runs in production code. The publication-delete interleave uses a direct
row delete; the non-concurrent revoke uses the real operation. Consent
withdrawal is a direct `consent_json` update. The Project audience is pinned
in the closure but does not by itself decide a Space-public summary (as in Ask
Space). No full suite, no browser batch, no independent re-review, no formal
commit/push/prepare/publish, no deployment action.
## Final same-runtime gate on candidate `72806be5` (2026-11-12, private)

Candidate `72806be52ffba9b39d30e93e6539f31a80a035bc` (parent `2c723008`,
tree `81dcfee83aedb1050e4ba828a2ab2fb3599f94fc`). Formal block baseline
`9b1c80b2`. This worktree was clean at `e99f8391`, which is an ancestor of
`72806be5` (as are `9b1c80b2` and `2f21bcb5`), so it fast-forwarded to the
candidate with no lost layer. Node 24.22.2, shared real PostgreSQL,
package-local binaries run directly (the worktree path contains `:`).

| Gate | Run | Terminal result |
|---|---|---|
| workspace deps build (protocol, outbound-guard, folder-read, reader-document) | earlier session, same tree; again here | exit 0 |
| `protocol-typecheck`, `protocol-test` | reused: earlier session, same tree `81dcfee8` | exit 0; 82 files / 459 passed |
| `server-typecheck`, `server-build` | reused (same tree); build again here | exit 0 |
| earlier `server-test` | started 03:33:20, process killed about 03:34:06 | **exit unknown**. The log has no terminal line, and its partial passes are not counted |
| `server-test` (one full run here) | this session | **exit 1**: 620 files passed, 6 failed, 1 skipped; 7,825 tests passed, 7 failed, 5 skipped; budget exceeded (3) |
| `web-typecheck`, `web-build` | this session | exit 0 |
| `web-test` (full) | this session | **exit 1**: 280 files / 2,552 tests, all passed. The only violation is the import budget (487.9s > 470.0s) |
| `daemon-typecheck` | this session | exit 0 |
| `agent-cli` build (dependency) | this session, after the full run | exit 0 |
| six failing files, targeted at `72806be5` | this session | exit 1; 153 passed, 4 failed (3 files) |
| repaired files + Knowledge authority consumers (7 files) | this session, after the fix | exit 0; 165/165, no skips |
| `server-typecheck` after fix | this session | exit 0 |

Diagnosis of the seven full-suite failures:

- **Environment and order (not code).** `pluginLifecycleDb` needed the unbuilt
  `packages/agent-cli/dist/rainver.js`. `taskLifecycleOperationsDb` serves
  `apps/web` through `vite preview`, but the gate built web only after
  server-test. Both passed in the targeted run once the dependency and web
  were built.
- **Load-sensitive.** `managedSubscriptionOAuthDb` saw two locks during the
  vendor call under full-suite load, then passed in the targeted run. It was not
  changed, and it is not claimed fixed.
- **Candidate regressions, repaired:**
  1. `publicationsRoutes` (mock pool): `contentDecisionFromDb` now reads the
     artifact row for the report release gate (from `2c723008`). The mock
     did not answer it, so the route returned 500. Test-only change: the mock
     answers with a plain markdown Artifact.
  2. `knowledgeReviewOperationsDb`: the apply-time Knowledge authority replay
     (`withKnowledgeAuthority`, from `19e26c80`) required the *submitter* to
     still be a Project writer. An authorized owner's approval therefore
     returned 403 after the submitter was demoted to viewer. That breaks the
     documented invariant: approval belongs to ProposalApplyService.
     Production change in `knowledge/proposalAuthority.ts`: at apply time
     (`applying=true`, the former `mutating`), the submitter's Project check
     is `assertProjectReadableLocked`. The Source release locks, per-ref
     `full` content decision, root locks and the owner check are unchanged.
     Submission still requires a writer.
  3. `sourceRecipeCreationOperationsDb`: the executor's admission error text
     changed with proposal placement. The rejection is unchanged, so the test
     now asserts the new message.
- **Budgets (kept at exit 1, no threshold change).**
  - Server: `pluginFrontendDb` 69.0s > 30s; `taskLifecycleOperationsDb`
    33.1s > 30s, its failed 30s wait; total import time 204.4s > 190s.
  - Web: total import time 487.9s > 470s.
  - No full suite was repeated after the fixes, so whole-suite green is not
    claimed for the repaired tree.

Not run:
- Daemon test suite: there is no daemon source change, and protocol changes
  are additive. Daemon typecheck only.
- Daemon build.
- Browser batch.
- Independent re-review: Codex `5d0afa6e` and Anti `6128732f` found no new
  material blocker. The parent should review the production diff above
  directly.
- Real provider/Host/webhook.
- Deployment, restart or instance-DB operations.
- Formal commit, push, prepare or publish.

No route, protocol, schema, migration or web change. Inventory 636 =
169 legacy + 53 exempt + 414 core, 69 URLs; `0000-0018` frozen, no `0019`.
Logs: `/tmp/claude-g1/` (earlier, killed) and `/tmp/claude-g2/` (summary,
driver, individual and targeted logs). P5 remains open.

## P5 Space block (candidate on `54b805a6`, private)

Scope, mapping and authority: plan 05 "P5 Space block". Nine retained URLs
moved to nine human-only core operations: `space.create`,
`space.invitation.create/accept`, `space.snapshot_defaults.update`,
`space.content_egress.update`, `space.retrieval_settings.update`,
`content.access.update`, `content.demotion.disclose` and
`content.publication.request`. Inventory 636 = 160 legacy + 53 exempt + 423
core. Migrations `0000–0018` are frozen and there is no `0019`.

Evidence. All runs used Node 24.22.2, the shared real-PG container and
`/tmp/claude-space/` logs; every exit was 0 with zero skips:
- Protocol: typecheck and build passed, and the full protocol test run passed
  82 files / 459 tests, including the regenerated frozen policy fixture (+4
  actions).
- Server typecheck passed. The focused run passed 29 files / 532 tests.
- The new `spaceOperationsDb` test covers:
  - retained URL and generic entry replay;
  - key/input conflict, strict schema (personal type, unknown oversight) and
    unkeyed refusal;
  - hidden replay after the creator leaves;
  - URL Space binding against another actor Space and against a body that
    restates a different `space_id`;
  - the role-ladder refusal text, and a non-manager seeing 404;
  - token absent from every `operation_idempotency` row;
  - a single claim, then the same refusal for a reused token;
  - receipts withheld after demotion;
  - a settings write blocked by an uncommitted demotion, then 404;
  - backfill Job queued exactly once with the settings write, and nothing
    left when audit fails.
- The new `contentAccessOperationsDb` test covers:
  - keyed replay with an identity receipt, and grantee membership
    validation;
  - owner or admin may manage, a plain member may not;
  - narrowing needs a disclosure (typed refusal metadata); the disclosure is
    readable by the owner only and is consumed by the narrowing;
  - tainted widening is a typed 409 with its approvers; the publication
    request is one `egress_review` proposal with reviewer grants, and the
    request is idempotent;
  - a concurrent grantee exit blocks the write, then refuses it.
- Ported domain tests: Space writers, role granting and member copy-out.
- Consumers of ContentAccessService, seeding and identity: Memory access,
  content group, public summary, research control, retrieval artifact closure,
  decision learning, registration and Relations.
- Contracts: route inventory, executor catalog, faults, system actions,
  policy, registries, guides, boundaries and hygiene.
- Web: typecheck passed. The focused run passed 6 files / 34 tests, including
  the new `space-operation-api` client test (local secret, Space header,
  readback paths).
- `git diff --check` passed.

Limits:
- No full server, web or daemon suite, browser batch or build-budget run.
  Budgets were not checked in partial runs.
- No independent review yet.
- No UI presentation change, so no visual check.
- Header-mismatch refusal for `spaceParam` routes is code-reviewed but not
  exercised: the PG tests use the identity override, which bypasses header
  resolution.
- The default `node` in this environment is v25, and jsdom `localStorage`
  fails there. Node 24 was used for every recorded run.
- No commit, push, prepare or publish. P5 remains open: Evolution, Prompts,
  Runtime, other controls and the person/me stage.

### First double review — fix (on candidate `90a7f755`, private)

Codex reported one P1, accepted and fixed: `GET .../demotion-disclosures/
:confirmationId` checked only that the caller still owns the source and then
returned `exposure_snapshot_json` as stored. A consuming Run's title is its
instruction and a derived output's title is someone's text, so after the
owner lost access to that Run or output (grant revoked, made private, Project
membership withdrawn) the old disclosure still released it, expired or
consumed included. A summary-level Run reader also received the instruction
when the disclosure was first made.

Fix (`server/src/modules/contentAccess/demotion.ts`, no schema change):
- One title-release rule for both the recorded and the read-back exposure. A
  Run title needs `runReadSql` and full content level. An Artifact title needs
  `artifactReadSql` and a non-deny `contentDecisionFromDb`, which carries the
  retrieval and research release gates. A Proposal title needs
  `proposalReadSql`. Anything else keeps its pointer, status, visibility and
  link, with the placeholder `Run|Artifact|Proposal <id8>`. These are the
  existing `access` readers; no new ACL was written.
- `read()` applies that rule to every entry of the stored snapshot at
  serialization time. The stored bytes are never rewritten, so confirmation
  still compares against exactly what was disclosed. If access has changed
  since then, the comparison sees a different exposure and refuses with
  `demotion_exposure_changed`; a fresh disclosure is required.
- Receipts and replays still carry identities only, and this GET is the only
  exit for exposure contents.
- Concurrency (superseded by the third-review fix below): the GET was a
  non-transactional read. The claim made here, that a revocation committing
  after the check "can only make the narrowing safer", is true of the
  confirming write only; it says nothing about a read, which can still
  return a title its reader lost before the response was built.

Evidence. All runs used Node 24.22.2 and the shared real-PG container:
- The new `contentAccessOperationsDb` test "releases a recorded disclosure
  only as far as each named Run and output is still readable" exercises the
  HTTP GET end to end:
  - Before the change, titles are full for a full grant and the pointer only
    for a summary-level Run.
  - The demotion still commits on an unchanged exposure.
  - After grant revoke, private, and Project-member revoke, the consumed,
    pending and expired disclosures all return pointers only and none of the
    four secrets.
  - The stored snapshot is byte-identical after the reads.
  - The stale confirmation gets a 409 `demotion_exposure_changed`, and a
    fresh disclosure then demotes.
- Negative control on the unfixed `demotion.ts`: exit 1. The summary-level
  Run title equalled its instruction. With those assertions removed, the
  revoked Run's GET still returned `GRANTED INSTRUCTION`.
- Fixed: `contentAccessOperationsDb`, `contentGroup` and `contentAccessService`
  passed 3 files / 20 tests, exit 0, no skips. `agentGuides` and `testHygiene`
  passed 2 files / 20 tests. Server typecheck exit 0.
  `git diff --check` passed.

Limits:
- Only the affected focused files were rerun; no full suite.
- Readers' display names are the owner's own access-log audit and are
  released as recorded.
- Re-review by Codex/Antigravity is pending.

### Third review — fix (on `b06b2165`, parent `e99f8391`, private)

Codex (review `02b71a91`) reported three substantive gaps, all accepted:
1. A Proposal title used `proposalReadSql` only and skipped
   `proposalReportWithheld`. A report-derived Proposal produced by the
   consuming Run kept its count-bearing title in creation and readback after
   the report's contributing Source was withdrawn, while the normal Proposal
   reader already showed the type label.
2. An Artifact title skipped `sourceDerivedArtifactReadableClause` in both the
   SQL and the readback. A shared Project analysis (written with
   `artifacts.run_id` and `reading_history_refs`) kept its title after the
   supporting Source's consent was withdrawn, while the normal detail read
   refused it.
3. The readback checked Runs and then awaited further queries before
   returning the Run instructions it had decided on, with no lock. A Run grant
   revocation committing in that window was not seen.

Fix (no route, protocol, schema or migration change):
- One title decision, `releasedTitles` in `contentAccess/demotion.ts`, used by
  creation, readback and the confirming recompute:
  - Run: `runReadSql` plus full level (unchanged).
  - Artifact: `artifactTitleReleased` (`artifacts/repository.ts`). It is the
    Artifact detail reader's own row gate (content ACL, Run Room,
    `sourceDerivedArtifactReadableClause`) plus its origin gates (research
    call, retrieval/report release), extracted from `getVisible` and
    recording no read. An ordinary summary-level Artifact keeps its title, as
    on its detail page.
  - Proposal: `proposalTitleReleased` (`proposals/repository.ts`). It is the
    detail reader's ACL and Run Room, plus `proposalReportWithheld` over the
    real `proposal_type` / `payload_json` dependencies (top-level packet key,
    child keys, nested `payload.metadata` packet context).
  - Everything else keeps its pointer, status, visibility and link, with the
    `Run|Artifact|Proposal <id8>` placeholder. Readers' names and counts are
    the owner's own access log and are disclosed as before.
- Creation and readback each run in one transaction:
  1. Unlocked owner check.
  2. `lockDemotionReleaseClosure` (`contentAccess/demotionReleaseClosure.ts`).
  3. Owner re-check, then the disclosure row `FOR SHARE`.
  4. Every title decision and the response, built before commit.
  The confirming recompute takes the same closure inside the policy writer's
  transaction, after its resource and disclosure `FOR UPDATE`.
- Closure lock order, every lock `FOR SHARE`. Step 1 reuses
  `lockSourceRetrievalRelease`, which now also accepts `run` refs:
  1. Project audiences: each Run's, output's, Folder's, Room's, research
     chain's, deep read's and Following goal's Project.
  2. The person and their Space membership, then the Space, then Folders,
     then Rooms and this person's Room member rows (the Source closure's
     `beforeContent` step; moved here after the fifth review, below).
  3. Content rows, each followed by its Project shares and this person's
     grants: the demoted resource, Runs, Artifacts (outputs, report
     dependencies, `reading_history_refs` and deep-read Artifacts),
     Proposals, Source items, snapshots and connections, research Threads.
  4. Source channels, then subscriptions, then windows.
  5. Demoted resources of any other type, then their grants.
  6. Research Operations, then Following goals and goal versions.
  7. Run groups, then sessions (Rooms moved before them after the fourth
     review and before the Runs after the fifth, below).
  Each content row comes before its grants, the order the content-policy
  writer uses, so a revocation through the real writer either commits first
  and is seen, or waits for this read to commit. Lineage is discovered
  unlocked and then again after locking. A changed lineage, or a deadlock,
  lock timeout or serialization abort, is a 409 `demotion_exposure_changed`
  (`failClosedOnLockConflict`), never a second, unsorted closure.
- The stored snapshot is still never rewritten by reads, and confirmation
  still compares against it. Expired and consumed disclosures read back
  through the same path. Receipts and replays still carry identities only.

Evidence. The new `contentDemotionReleaseDb` test runs on real PG with the real
producers and the real `ContentAccessService` writer:
- Report-derived Proposal. Knowledge item with Source provenance → Brief →
  Claim Candidate Packet → accepted → `claim_create` child with nested
  `payload.metadata.claim_candidate_packet`, attributed to the consuming Run
  and shared. After consent withdrawal, the normal detail shows "Claim create";
  the readback shows the placeholder with no `PRIVATE` text; the stored
  snapshot is unchanged; the stale confirmation gets a 409; a fresh disclosure
  stores no `PRIVATE` text and confirms.
- Source analysis. Written by `saveSourceReadingDocument` with `agent_run_id`
  (`artifacts.run_id`) and `reading_history_refs` on a supporting Source with
  destination `external_provider`, then shared. After that Source's consent
  is withdrawn, normal `getVisible` returns null; readback and fresh creation
  carry the placeholder; an ordinary summary-granted output of the same Run
  keeps its title; stale confirmation 409, fresh confirmation succeeds.
- Codex's interleaving. The readback is blocked on a later Artifact query
  (`LOCK TABLE artifacts` held by a test transaction, wait proven with
  `pg_blocking_pids`). The real Run grant revocation commits, then the lock is
  released. The readback returns the Run placeholder.
- Release barrier. A test transaction holds the demoted item's Source
  connection `FOR UPDATE`. The readback, already holding the Run and its
  grants, waits on that row. The real revocation is then proven to wait as
  well (two lock waiters). The holder rolls back; the readback returns the
  instruction, the revocation completes after it, and the next readback
  returns the placeholder.
- Waits are lock-state conditions (`waitForBlockedBy` / `waitForLockWaiter`),
  not sleeps.
- Negative control: with the four `b06b2165` source files restored, all 4
  tests fail at the asserted leak (Proposal title, analysis title, stale Run
  instruction, no barrier).

Limits:
- Report closures nested below the report Artifacts named in the disclosure
  are locked by their own gate (`lockRetrievalReleaseClosure`) inside the same
  transaction, after this closure, not pre-sorted into it. A conflicting
  writer there ends in a Postgres deadlock abort, which reads as a 409. It
  never releases a title.
- Room activity and other Run inherit paths read through `roomRunReadAccessSql`
  are covered at the Room and Room member rows only.
- Only the affected focused files were run; no full suite.

### Fourth review — fix (on `ef34e43c`, parent `b06b2165`, private)

Codex reported one P2, accepted and fixed: the closure share-locked the Run's
session before its Room, while the Room Agent context reset
(`RoomRosterService.resetAgentContext`) takes the Room first
(`withRoomWriter` → `getVisibleRoom(..., true)`, `FOR UPDATE OF room`), then
the owner's Room member row, then the `host_threads` row joined with its
session, host and Agent under an unqualified `FOR UPDATE`, then the
conversation append lock (`lockConversationForAppend`, `sessions FOR UPDATE`)
for its system notice. A readback of a disclosure naming a Run of that Room
conversation held the session `FOR SHARE` and waited on the Room, while the
reset held the Room and waited on the session: a real deadlock. The 409
mapping (`failClosedOnLockConflict`) only failed it closed; a reset chosen as
the victim got a raw deadlock error.

Lock owners checked:
- Room-exclusive writers all take the Room first in their transaction: the
  roster writer and its invitation paths (`withRoomWriter`, `getRoomById(...,
  true)`, `incrementRosterRevision`, `clearPersonalMarker`), the context reset
  and `restartFromSummary` (`FOR UPDATE OF thread`, then the same append
  lock), and `room.quota.continue` (Room → queue → conversation → held Runs).
- No transaction holds a session, Run group or Room member row exclusively
  and then asks for a Room exclusively. Message appends hold the session and
  only read or share-lock the Room.
- The reset's own locks are kept: the unqualified `FOR UPDATE` also pins the
  host (owner check) and Agent rows, and the append lock serializes the
  conversation. The closure does not lock `host_threads`, `hosts` or `agents`.
  Narrowing the reset to `OF thread` would not remove the cycle, because the
  append lock takes the session anyway.

Fix (`contentAccess/demotionReleaseClosure.ts` only; no route, protocol,
schema, migration or reset change): step 7 is now Rooms → this person's Room
member rows → Run groups → sessions, matching the Room-first writers.

Evidence. New `contentDemotionReleaseDb` case on real PG: a Room conversation
with an active Host-bound thread on the owner's machine, and a Run of that
conversation consuming the demoted Artifact.
- A test transaction holds the owner's Room member row `FOR UPDATE`. The real
  reset takes the Room and waits on it (`waitForBlockedBy`).
- The real readback is then started and waits on the reset (two lock
  waiters, `waitForLockWaiter`). The holder rolls back.
- Assertions: both operations fulfil; the thread is `session_reset` with no
  vendor session; the conversation has the one reset notice; the readback
  still releases the Run instruction.
- Negative control on the unfixed order: exit 1. The readback was rejected
  with 409 `demotion_exposure_changed`; a temporary probe in
  `failClosedOnLockConflict` showed `40P01 deadlock detected` (probe removed).
- After the fix: the file's 5 tests pass (the new one in about 100 ms).
  Targeted runs: `contentDemotionReleaseDb`, `contentAccessOperationsDb`,
  `contentAccessService`, `contentAccessPolicy`, `contentAccessEquivalence`,
  `hostThreadsDb` and `agentGuides`, 7 files, 441 passed. `roomsDb -t
  "reset|context"`: 5 passed, 161 filtered. The Host-bound Room reset contract
  test (`roomsDb.2`, "dispatches a Room host-bound Agent only for its owner")
  passed. `tsc -p tsconfig.typecheck.json` exit 0.

Limits:
- The same session-before-Room share order exists on `master` in other
  admissions, outside this block and unchanged: `projectWork/
  updateUndoAdmission.ts`, `projects/publicSummaryAdmission.ts` and
  `projects/publicSummarySourceClosure.ts`. They can deadlock with the same
  reset the same way; recorded here for their owners, not fixed here.
- Step 3 still share-locked Runs before the Room. The reasoning recorded
  here, that a Run held for quota has no Invocation Snapshot, was wrong; see
  "Fifth review — fix".
- No full suite was run.

### Fifth review — fix (on `e5a97b49`, parent `ef34e43c`, private)

Codex (`f88fbceb`) reported one P2, accepted and fixed. A quota recovery hold
keeps the Run's Invocation Snapshot, so a disclosure can name it:
- `runs/supervisor.ts`: on `subscription_quota_exhausted` the supervisor calls
  `requeueRunForRetry`, then `holdInterruptedRun`.
- `PgRunRepository.requeueRunForRetry` puts the same Run back to `queued` and
  keeps its accepted `invocation_snapshots` row.
- Consuming Runs are discovered from snapshots, with no status filter, so
  queued and recovery-held Runs count.
- `continueHeldRuns` (`rooms/quotaGate.ts`) locks every held queued Run of
  the conversation `FOR UPDATE OF run` and only then skips recovery holds. So
  it locks the Run even when it does not continue it.

The cycle: the disclosure (creation or readback) share-locks the Run (step 3)
and then waits on the Room. `room.quota.continue` holds the Room
(`getVisibleRoom(..., true)`), takes the queue and turn advisory locks, and
waits on the Run. The 409 mapping did not fix this.

Lock owners checked:
- Room-exclusive writers are the roster writer and its invitation paths, the
  context reset, `restartFromSummary` and `room.quota.continue`. All of them
  take the Room first and lock members, threads, sessions or Runs after it.
  The only Room write outside such a transaction is `getProjectMainline`'s
  `incrementRosterRevision` after inserting a new member, and it takes no Run.
  `UPDATE room_user_members` exists only under the Room lock.
- The Run status writers lock the Run, then append to the session and update
  `room_discussions`. These are the supervisor's `FOR UPDATE`, requeue,
  `holdInterruptedRun` and hold notice. None of them locks a Room or Room
  member row. So Run → session is kept, and the Room has to come before the
  Run.
- The Room cannot move before Projects, membership or Space. Project and
  Space writers lock those rows before any Room, and nothing in the order
  before step 2 changed.

Fix: `lockSourceRetrievalRelease` takes an optional `beforeContent` step that
runs after Folders and before the first content row. Other callers pass
nothing, so their order is unchanged. The disclosure closure uses this step
to share-lock Rooms → this person's Room member rows, and leaves Run groups →
sessions after the Runs. The new order is Projects → person → Space →
Folders → Rooms → members → content rows (Runs included) → … → groups →
sessions.
- The fourth review's reset fix is kept: the reset takes the Room first, so
  the disclosure still waits on the Room before it holds any group or session.
- Unchanged: `continueHeldRuns`, its candidate scan and recovery filter, the
  supervisor, the requeue, the snapshot, admission, reservation, budget and
  hold logic. No route, protocol, schema or migration changed.

Evidence. A new `contentDemotionReleaseDb` case runs on real PG with real
producers:
- Setup: the mainline Room conversation, the server host and its managed
  thread, and a Run with an accepted snapshot consuming the demoted Artifact.
  The Run's attempt fails with `subscription_quota_exhausted`. The real
  `PgRunSupervisor.supervise` requeues and holds it: `queued`, a recovery
  marker with `auto_continue: true`, one accepted snapshot and no
  `agent_run` job.
- Race: a test transaction holds the Run `FOR UPDATE`, acting as a Run status
  writer mid-update. The real `discloseDemotion` waits on it
  (`waitForBlockedBy`). Then the real `POST …/quota/continue` route, through
  `roomsModule` and the operation core, is started. It waits too: two lock
  waiters (`waitForLockWaiter`). The holder rolls back.
- Assertions: both fulfil, and Continue anyway returns 200. The readback
  releases the Run instruction. The quota state is unchanged: Run status and
  marker, snapshot count, job count, conversation messages and the thread's
  `dispatch_lock_id` (Host claim).
- Negative control, unfixed e5 order (test only): exit 1. Continue anyway got
  503 `operation_temporarily_unavailable`, and the PostgreSQL log showed
  `deadlock detected` on the `continueHeldRuns` `FOR UPDATE OF run` scan,
  blocked against the disclosure's `rooms … FOR SHARE`.
- After the fix: `contentDemotionReleaseDb` 6 passed, including the fourth
  review's reset case.
- Targeted runs: `quotaRecoveryDb`, `subscriptionQuotaGate`,
  `agentHostStateResetDb`, `agentHostResetReconcileHostDb` and
  `retrievalArtifactReleaseDb`, 5 files, 67 passed. `roomsDb.{1,2,3} -t
  "quota|continue|restart|summary|host-bound Agent only"`: 15 passed and 151
  filtered. These cover the summary restart, the Host-bound reset contract,
  quota holds, Continue anyway and recovery listing/cancel.
- `agentGuides` passed, and `tsc -p tsconfig.typecheck.json` exited 0.

Limits:
- The three `master` admissions named in the fourth review's limits are
  unchanged and still belong to their owners. They are not wired into this
  block.
- No full suite was run.

### Final same-runtime gate on candidate `cfd54bb8` (2026-11-12, private)

Candidate `cfd54bb8cdc5ecef34bca2d94c5c4eeb3493a00f` (parent `e5a97b49`,
tree `dfed9821f5e1cec941fb8101085d0b7dceacc4fd`), on formal Space block base
`54b805a6`. Every step ran in a clean worktree at that tree, using Node
24.18.0, the shared real PostgreSQL and package-local binaries run directly
(the path contains `:`). Logs are in `/tmp/claude-gate-cfd/`; each step's log
starts with a header line and ends with `EXIT=<rc>`.

| Gate | Run | Terminal result |
|---|---|---|
| `pnpm install` (lockfile up to date) | earlier session, same tree | exit 0 |
| builds: protocol, agent-cli, folder-read, outbound-guard, reader-document | earlier session, same tree | exit 0 |
| `protocol-typecheck`, `server-typecheck`, `web-typecheck`, `daemon-typecheck` | earlier session, same tree | exit 0 |
| `protocol-test` (full) | earlier session, same tree | exit 0; 82 files / 459 passed |
| server schema check (`schema-migrations check`, `drizzle-kit check`) | earlier session, same tree | exit 0; 19 migrations in sync |
| `server-test` (full) | earlier session; started 05:53:26, process gone at about 05:54:50 | **exit unknown**. There is no terminal line or live process, and about 195 of 630 files had reported. The partial passes are not counted, and the full suite was not restarted. One failure was seen before the kill: `taskLifecycleOperationsDb`, a 30.8s wait. That test serves `apps/web` through `vite preview`, and web had not been built yet |
| `server-build`, `daemon-build`, `web-build` | this session (never started before) | exit 0 |
| `daemon-test` (full) | this session | **exit 1**: 73 files passed, 1 failed, 2 skipped; 805 tests passed, 1 failed, 22 skipped. `branchAlignIsolation` hit the default 5s timeout (git-heavy) |
| `daemon-test` targeted `branchAlignIsolation` | this session | exit 0; 6/6. The candidate has no `packages/host-daemon` change relative to `9b1c80b2`. This is a load-sensitive timeout; nothing was changed, and it is not claimed fixed |
| `web-test` (full, run alone) | this session | exit 0; 281 files / 2,555 passed; import 462.9s, within budget |
| server targeted `taskLifecycleOperationsDb` + `operationRoutes` (inventory) | this session, after `web-build` | exit 0; 2 files / 53 passed |
| docs-only delta of this section: `git diff --check`, `agentGuides` | this session, checkpoint tree | exit 0; 8/8 |

Not run or not established:
- The whole-server-suite result, because the only full run was killed.
  `managedSubscriptionOAuthDb` (the earlier load-sensitive OAuth failure) was
  not reached before the kill and was not run separately, so it is neither
  reproduced nor cleared.
- No server budget verdict: a partial run does not check totals.
- Browser and layout batch, a real provider, Host or webhook, deployment,
  restart and instance-DB operations.
- Formal commit, push, prepare or publish.

No production, test, route, protocol, schema, migration or web change in this
gate; only this section and the plan 05 status line were added. Inventory 636
= 160 legacy + 53 exempt + 423 core. `0000–0018` are frozen, with no `0019`.
Re-reviews Codex `c9a42a15` and Anti `b7b43378` of the fifth-review fix found
no new material blocker. P5 remains open.

## P5 Evolution / Prompts / Runtime Context block (basis `62e98d82`, private, partial)

Scope delivered: 10 of the block's 49 legacy rows — Evolution targets/signals
(5 URLs, 4 operations) and Runtime Context policy write, Work Context Setup,
both conversation retrieval switches and checkpoint correction (5 URLs, 5
operations). Plan 05 "P5 Evolution / Prompts / Runtime Context block" has the
URL/operation/policy table, authority and lock decisions, and the remaining 39
rows grouped by kind (shared asset writers, evaluation, proposal-producing,
external IO, read-shaped POSTs). No Agent surface, approval mapping, Job,
schema or migration change; `0000–0018` untouched, no `0019`.

Inventory (regenerated from Fastify registration): **636 = 150 legacy + 53
exempt + 433 core**. Four policy actions were added (fixture diff is purely
additive): `evolution.target.manage`, `evolution.signal.manage`,
`runtime_context.policy.write`, `runtime_context.work_context.update`.

Evidence (this runtime, Node 24.22.2 — the pinned engine; the default Node 25
breaks jsdom's `localStorage`, so it was not used for evidence; workspace
binaries run directly because the worktree path contains `:`):

| Check | Result |
|---|---|
| protocol build + `tsc --noEmit` | exit 0 |
| protocol targeted: `evolutionRuntimeContextOperations` (new), `policy`, `systemActions`, `operations`, `runtimeContext`, `evolutionBundle`, `index` | exit 0; 7 files / 82 passed |
| server `tsc --noEmit` | exit 0 |
| server targeted real PG: `evolutionOperationsDb` (new), `runtimeContextOperationsDb` (new), `evolutionRepository`, `evolutionGroup`, `runtimeContextRetrievalSwitchDb`, `runtimeContextPolicyDb`, `runtimeContextGroup`, `operationRoutes` (inventory), `policyDecisionContract`, `operationExecutorDb`, `boundaries`, `systemActionRegistry`, `sharedAuthorizersDb`, `agentGuides` | exit 0; 14 files / 217 passed, 0 skipped; partial run, budget totals not checked |
| web `tsc --noEmit` | exit 0 |
| web targeted: `evolution-operation-api` (new), `runtime-context-operation-api` (new), `evolution`, `evolutionInboxDecision`, `KnowledgeRetrievalToggle`, `AgentWorkPage` | exit 0; 6 files / 93 passed |

The one assertion failure seen during the work was `operationExecutorDb`'s pinned
list of enabled operations (expected: nine new ids); it was updated and the file
passes. Superseded tests removed: the fake-DB triage test in `evolutionGroup` and
the direct retired-type writer test in `evolutionRepository`; both behaviors are
now asserted through the operation in `evolutionOperationsDb`.

The real-PG tests cover cross-entry replay (retained URL ↔ `/actions/:id`), key
reuse with changed input (422), unkeyed calls, strict-schema refusals, body
restating a URL target, other-Space/system/global rows, membership or standing
loss hiding a replay, cached stale-base refusals, the signal waiting on a locked
target, and the Room switch waiting on a Room writer and then refusing a member
removed in that transaction.

Limits: no full suite (server, web, protocol, daemon) and no browser/layout
batch; a successful semantic checkpoint correction is not exercised at the
operation level (the refusal and authority paths are; the writer is unchanged).
No independent review yet. Private checkpoint only; no formal commit, prepare,
publish or push. P5 remains open.

## P5 Evolution / Prompts / Runtime Context block — remaining rows (basis `aa3737fe`, private)

Scope delivered: 35 of the 39 rows left after the first two subfamilies —
evolvable-asset and prompt writers (asset, version, pin, deployment, rollback),
evaluation (cases, evidence, case execution), proposal-producing commands
(asset/prompt/Reading promotion, workflow save), Evolution bundle creation,
the Evolution Run start (now Run + `agent_run` Job, no in-request execution),
all ten Reading Method writes, five read-only queries (asset/prompt resolve,
render preview, workflow preview, policy resolve) and the Runtime Context
preview as a single-attempt Job with an owning result reader. Plan 05 "remaining
rows" has the URL/operation/policy table and the lock/effect decisions. The
four Bundle decision URLs stay legacy on the canonical Proposal decision owner
boundary recorded there; they are not exempted.

Inventory (regenerated): **636 = 115 legacy + 53 exempt + 468 core**. Mutating
methods only; the new GET reader `GET /runtime-context/preview-requests/:jobId`
(and the previous section's signal reader) are not counted there. Ten additive
policy actions (fixture 180 → 190, existing entries byte-identical). No schema
or migration change; `0000–0018` untouched, no `0019`.

Evidence (this runtime, Node 24.22.2, shared real PostgreSQL; workspace
binaries run directly because the worktree path contains `:`):

| Check | Result |
|---|---|
| protocol build + `tsc --noEmit` | exit 0 |
| protocol targeted: `evolutionAssetPromptOperations` (new), `evolutionRuntimeContextOperations`, `evolutionBundle`, `index`, `operations`, `policy` (fixture), `prompts`, `readingMethod`, `reading`, `runtimeContext`, `systemActions` | exit 0; 11 files / 101 passed |
| server `tsc --noEmit` | exit 0 |
| server targeted real PG, batch 1: `evolutionAssetOperationsDb` (new), `readingMethodOperationsDb` (new), `evaluationHarnessDb`, `evolutionBundleDecisionDb`, `evolutionGroup`, `evolutionOperationsDb`, `evolutionRepository`, `evolvableAssetDb`, `evolvableAssetPromotionDb`, `policyRoutes`, `promptRegistryDb`, `promptSyncDb`, `readingMethodDb`, `readingMethodGenerationDb.1/.2`, `readingMethodRevisionDb`, `runWorkflowServiceDb`, `runtimeContextGroup`, `runtimeContextOperationsDb`, `operationRoutes`, `operationExecutorDb`, `jobsSchedulers` | exit 0; 22 files / 333 passed, 0 skipped; partial run, budget totals not checked |
| server targeted batch 2: `agentGuides`, `boundaries`, `systemActionRegistry`, `policyDecisionContract`, `sharedAuthorizersDb`, `runtimeContextRetrievalSwitchDb`, `runtimeContextPolicyDb`, `operationRoutes` | exit 0; 8 files / 98 passed |
| web `tsc --noEmit` | exit 0 |
| web targeted: `evolution-operation-api` (extended), `prompt-operation-api` (new), `runtime-context-operation-api`, `src/modules/prompts`, `src/modules/evolution`, `evolution`, `evolutionInboxDecision`, `RunDetailPage`, `ReadingWorkspace`, `AutomationsPage` | exit 0; 16 files / 143 passed |
| web `src/i18n` | exit 0; 3 files / 6 passed |

Test changes: `operationExecutorDb`'s pinned enabled-operation list gained the
35 ids; `evolutionRepository`'s explicit-Agent test now sends a key and reads
the core error message; the fake-DB `runtimeContextRoutes` 422-`detail` test
was removed because the preview URL is a core adapter (strict-input refusal is
asserted in `evolutionAssetOperationsDb`). Assertion failures met while writing
the new tests were fixture or expectation errors (strategies come from the boot
seed; the renderer uses `{name}`; an Agent without a version was an unclassified
`RunCreateValidationError`, now classified as a 422 refusal) — no threshold or
budget was changed.

The real-PG tests cover: retained URL ↔ `/actions/:id` replay, changed-input key
reuse (422), unkeyed commands, strict-schema and URL-restatement refusals,
membership/standing loss hiding a replay, owner refusal text, a pin waiting on
a held asset lock and then refusing the version the holder deprecated, the
Evaluation Engine pass reserved to its Job, promotion Proposals filed but not
applied, single bundle membership, the Evolution Run queued with its Job and
the not-selected decision kept, queries with no key, the preview request
hidden for an unreadable Work Context and its reader private to the requester,
Reading initialize/draft/sample/comparison start with exact Run/Job counts,
judgment/promotion/rollback refusals and the comparison cancel recording both
Runs' stop.

Limits: no full suite (server, web, protocol, daemon), no browser batch (the
only visible change is the Evolution Run toast text). Not exercised at the
operation level: a successful preview Job run and release with retrieval
items, a successful Reading generation start (provider/Agent fixtures exist in
the owner suites, which pass), evaluation case execution with a real candidate
Run, workflow save from a real Run, prompt production deployment with an
accepted Proposal. The Bundle decision URLs are unchanged. No independent
review yet; private checkpoint only; no formal commit, prepare, publish or push.

## P5 Evolution / Prompts / Runtime Context block — Codex 4135d35a repair (source parent `006a1064`, private)

Repairs for the two findings and one acceptance gap on candidate `006a1064`
(decisions and the dependency matrix: plan 05, "Block review repair: Codex
4135d35a"). Inventory unchanged: **636 = 115 legacy + 53 exempt + 468 core**;
the preview GET reader stays outside that mutating-method count. No schema or
migration change; `0000–0018` untouched, no `0019`.

| Finding | Permanent evidence | Negative control |
|---|---|---|
| Preview release leaked a non-retrieval source's body/structure/provenance after it was withdrawn | `runtimeContextPreviewReleaseDb`: the real `POST /runtime-context/preview` and the real `runtime_context_preview` Job handler produce an envelope with `message`, `agent_version`, `project_research_evidence_matrix` and `skill_package_binding` items; the GET then withholds the whole result (`result: null, withheld: 1`) after each of: Artifact read withdrawn, Artifact body changed, Skill binding disabled, AgentVersion instruction changed, Agent archived, Project deleted, Session archived, Message changed, a newer Setup version; each restore releases it again; another person gets 404; a pending request stays empty | With `006a1064`'s `previewRequests.ts` the first withdrawal (Artifact read) still released the envelope: test failed; with the repair it passes |
| Evolution Run start queued a Run + Job for a target disabled concurrently | `evolutionAssetOperationsDb` "holds the target from its first runnable read to commit": the real target writer (`updateTarget`) holds an uncommitted disable, the start is observed blocked on it (`waitForBlockedBy`, no sleep), and after commit the start refuses 409 with no Run/Job/decision written; in the other order the start (lock + `recordRunSetup`) holds the target, the real `PATCH` disable waits, and after commit the queued Run exists and the target is disabled | Without the lock the first case returned 202 with a queued Run and Job: test failed |
| Gap: `runtime_context.checkpoint.correct` had only a refusal test | `runtimeContextOperationsDb` "corrects the active semantic checkpoint…": receipt, correction row, `checkpoint_corrected` event, keyed replay, changed-input 422, another person's Message 422, superseded base 409, outsider 404, revoked-member replay 404, exactly one row | — (new success path) |

Evidence (this runtime, Node 24.22.2, shared real PostgreSQL; workspace
binaries run directly because the worktree path contains `:`):

| Check | Result |
|---|---|
| server `tsc -p tsconfig.typecheck.json` (sources and tests) | exit 0. It first reported three unused imports in `test/evolutionGroup.test.ts`, left by `aa3737fe` and not caught by the earlier `tsconfig.json` check, which excludes tests; removed |
| server targeted real PG: `runtimeContextPreviewReleaseDb` (new), `runtimeContextDeliveryDb`, `informationBriefingDestinationDb`, `informationBriefingReferenceDeliveryDb` (consumers of the shared gate), `runtimeContextGateway`, `runtimeContextGroup`, `runtimeContextOperationsDb`, `runtimeContextRetrievalSwitchDb`, `runtimeContextPolicyDb`, `runtimeContextEntrypoints`, `acpRuntimeContextPrompt`, `evolutionAssetOperationsDb`, `evolutionOperationsDb`, `evolutionGroup`, `evolutionRepository`, `evolutionBundleDecisionDb`, `operationRoutes`, `operationExecutorDb`, `agentGuides`, `boundaries` | exit 0; 20 files / 261 passed, 0 skipped; partial run, budget totals not checked |
| web `tsc --noEmit` | exit 0 |
| web targeted: `evolution` (new not-selected case), `evolution-operation-api`, `src/i18n/i18n`, `EvolutionPageParts.i18n` | exit 0; 4 files / 23 passed |
| Minimal entry check (built app, synthetic APIs, Chromium, screenshots in `/tmp/rainver-evolution-visual-shots`) | The "Create improvement plan" action in the target card with its neighbouring actions, the toast and the destination tab, for queued and not-selected, in dark/English at 1280 and light/Simplified Chinese at 390: 8 screenshots inspected; no horizontal overflow |

Limits: no full server/web/protocol suite and no browser batch (the 18
existing layout fixtures were not run). The visual check covered two of the
four theme/locale combinations and two widths, not every state. It showed
behaviour that was already there and is out of scope: the Selection records row
shows the raw `no_strategy` badge and the server's English decision reason in
zh-CN, and the bottom-right toast covers the floating quick-capture button
while it is visible. The preview release test has no retrieval item: the
retrieval path reuses the unchanged Delivery retrieval re-check, whose
real-PG coverage is in `runtimeContextDeliveryDb`. The new trimmed-retrieval
comparison is not exercised by a dedicated test. A Source revocation that
reaches a preview only through retrieval is covered the same way. The Job's own
release check runs in the same transaction shape as the GET; a revocation that
races the Job between planning and that check is not separately staged with a
barrier. No independent review of this repair yet; private checkpoint only; no
formal commit, prepare, publish or push.


## P5 Evolution / Prompts / Runtime Context block — Codex 82551c31 repair (source parent `2e149d8b`, private)

Repair for Codex's remaining P1 and the P2 evidence gap on candidate `2e149d8b`
(decisions: plan 05, "Block review repair: Codex 82551c31"). Inventory
unchanged: **636 = 115 legacy + 53 exempt + 468 core**. No schema or migration
change; `0000–0018` untouched, no `0019`.

| Finding | Permanent evidence | Negative control |
|---|---|---|
| P1: the preview (and Delivery) Evidence Matrix check was a bare ACL, so a Matrix whose producing Research call read a now-revoked Artifact stayed released, and no dependency was locked | `runtimeContextPreviewReleaseDb` "withholds a research Matrix preview exactly when the Artifact reader withholds…": a real Research Operation (`startAcquisition`), a real Matrix (`ensureEvidenceMatrix`) bound to it, `input_refs` naming Input Artifact A (shared through the real content-policy writer), a real preview POST + Job; the GET, `GET /artifacts/:id` and the shared Delivery consumer (`authorize`, execution mode) all release M; after A's grant is revoked through `PUT /content-access` (M's own row, ACL and Project unchanged) and after the operation's Source connection is archived, all three withhold (`result: null, withheld: 1`; detail `content: null`; Delivery refused); each restore releases all three again; a Job planned while A is withdrawn stores nothing. "orders the input Artifact policy writer…": release first — the held release transaction blocks the REST content-policy `PUT` (`waitForBlockedBy`, no sleep) until it commits, then the GET withholds; writer first — the release waits on the uncommitted revocation and returns withheld | With `2e149d8b`'s `src/`: the first withdrawal still released the envelope, and the `PUT` was not blocked by the held release; both tests failed. With the repair both pass |
| P2: the Evolution start/target barrier's second order drove the repository, not the operation | `evolutionAssetOperationsDb` "holds the target… concurrent disable / archive": (a) real writer `updateTarget` holds an uncommitted disable/archive, the REST start is blocked on it and then refuses (404/409) with no Run, decision or Job; (b) the REST start, through the operation core, is held mid-transaction at its strategy-row update; the REST `PATCH` disable/archive waits on the start; after commit the 202 queued Run, selector decision and `agent_run` Job exist and the target is changed | Without `lockTargetForRun`, (a) returned 202 with a queued Run and Job for both disable and archive: failed. (b) passes without the lock (foreign-key key-share from the signal/decision inserts already orders the writer), so (b) is end-to-end ordering evidence, not evidence for the lock |

Evidence (this runtime, Node 24.22.2, shared real PostgreSQL; workspace
binaries run directly because the worktree path contains `:`):

| Check | Result |
|---|---|
| server `tsc -p tsconfig.typecheck.json` | exit 0. Before the repair it reported `TS2322` at `test/runtimeContextPreviewReleaseDb.test.ts:50` (`saveImportedSkill(...).id` is `unknown`), so `2e149d8b`'s "server typecheck 0" did not hold for that file; fixed with `String(...)` |
| server targeted real PG, run 1: `runtimeContextPreviewReleaseDb`, `evolutionAssetOperationsDb`, `contentDemotionReleaseDb`, `contentAccessOperationsDb` (demotion closure consumers), `runtimeContextDeliveryDb` (Skill key order, retrieval canonical trim, Run full/Room, Delivery), `runtimeContextGateway`, `runtimeContextOperationsDb` (checkpoint correction success path through the operation), `problemWorkspaceRepairDb`, `problemWorkspaceDb` (research artifact gate), `sourceEvidenceProjectLinkDb` (Matrix producer), `evolutionGroup` | exit 0; 11 files / 111 passed |
| server targeted real PG, run 2: `researchGroup` (deep/cyclic 200-bound provenance through the moved CTE), `personalMemoryGrantsDb` (execution grant use), `runGroup` | exit 0; 3 files / 69 passed |
| docs: `agentGuides`, `boundaries` | exit 0; 2 files / 13 passed |

Limits: no full suite and no browser batch; web and protocol are unchanged and
were not re-run. The `input_refs` edge and M's binding to its Operation are
written by the test in the shape the Problem call admission and the synthesis
stage store, not by running a full orchestrated research pass. The barrier
covers the input Artifact's content-policy writer; the Source-connection
withdrawal is shown by consistency (withheld/restored), not by a separate
lock barrier. The Job's own pre-store check uses the same function as the GET;
a revocation racing the Job between planning and that check is not staged
separately. The checkpoint correction success path runs through the real
operation on PostgreSQL; the earlier UI screenshots used synthetic APIs and are
visual evidence only, not a backend end-to-end check. No independent review of
this repair yet; private checkpoint only.


## P5 Evolution / Prompts / Runtime Context block — Codex 38585dc1 repair (source parent `157af86e`, private)

Repair for both findings of Codex's review of `157af86e` (decisions: plan 05,
"Block review repair: Codex 38585dc1"). Inventory unchanged:
**636 = 115 legacy + 53 exempt + 468 core**. No schema or migration change;
`0000–0018` untouched, no `0019`.

| Finding | Permanent evidence (`runtimeContextPreviewReleaseDb`) | Negative control (`157af86e`'s `src/`) |
|---|---|---|
| P1: a Project-less input Artifact A readable only through its owning Task T (`task_artifacts`) was not part of the Matrix release closure | Fixture: A written in the host-upload row shape by a Run with no Project and linked to T by the real `declareRunArtifact` + `applyRunArtifactDeclarations`; T private to `other`, shared to this person through the real policy writer; real Research Operation, Matrix M with `input_refs` A, real preview POST + Job. "withholds a Matrix whose Project-less input passes only through its owning Task…": `PUT /content-access/task/T` to a third person → `GET /artifacts/M` content null, GET preview withheld, Delivery refused; restore → all three release. "orders the owning Task policy writer…": release first — the REST `PUT` on T is blocked by the held release until it commits, after which detail and envelope both withhold; writer first — an uncommitted `updatePolicy` on T blocks both the preview release and Delivery, which then withhold. "refuses a Matrix release whose Task-ownership closure changed…": with T's Folder held by another transaction, a link added by the real declaration applier, or the owning Task's row moved to another Project (no product writer moves a Task; written directly), makes the in-flight release withhold (409 drift), and the next read releases | The barrier test failed (the `PUT` on T was not blocked); the drift test failed (the release was never blocked on T's Folder: the old closure did not reach T). The consistency test passes on both: the reader itself already withheld |
| P2: `authorizeEnvelope` held the Run `FOR SHARE` before the Matrix closure took the Run's Room; "Continue anyway" takes Room → held Runs | "a Matrix Delivery of a Run held for quota recovery and 'Continue anyway' on its Room conversation both complete": the Run is in the Project mainline Room's conversation, requested M's research, has an accepted Invocation Snapshot, and is held for recovery by the real `PgRunSupervisor` after a subscription-quota failure. A Project membership writer (`lockProjectAudienceForChange`) holds the Project; the shared Delivery gate (Matrix item) waits on it; the real `POST …/quota/continue` waits behind the gate; on release both complete — the gate releases M, the command returns 200 — and the hold's marker, snapshot, Job count and Host claim are unchanged | The command returned 503 `operation_temporarily_unavailable`: the operation core maps the deadlock victim (40P01) to a transient refusal. With the repair it is 200 |

Evidence (this runtime, Node 24.22.2, shared real PostgreSQL; workspace
binaries run directly because the worktree path contains `:`):

| Check | Result |
|---|---|
| server `tsc -p tsconfig.typecheck.json` | exit 0 |
| `runtimeContextPreviewReleaseDb` (8 tests, 4 new) | exit 0; 8 passed. Against `157af86e`'s `src/`: exit 1; 3 failed / 5 passed |
| server targeted real PG, run 1: `runtimeContextPreviewReleaseDb`, `contentDemotionReleaseDb`, `runtimeContextDeliveryDb`, `runtimeContextGroup`, `runtimeContextRetrievalSwitchDb`, `promptProvenanceAcceptanceDb`, `projectKernelDb`, `informationBriefingReferenceDeliveryDb`, `informationBriefingDestinationDb`, `researchGroup`, `problemWorkspaceRepairDb`, `sourceRetrievalOperationsDb`, `sourceRetrievalAccess`, `relationOperationsDb`, `contentAccessOperationsDb`, `projectResearchArtifactValidation` | exit 0; 16 files / 178 passed |
| server targeted, run 2: `runtimeContextGateway`, `problemWorkspaceDb`, `sourceEvidenceProjectLinkDb`, `evolutionGroup`, `personalMemoryGrantsDb`, `runGroup`, `runtimeContextOperationsDb`, `evolutionAssetOperationsDb`, `agentGuides`, `boundaries` | exit 0; 10 files / 104 passed |

Limits: no full suite and no browser batch; web and protocol are unchanged and
were not re-run. The P2 interleaving is staged with the Delivery consumer
carrying the Matrix item; the preview release runs the same `authorizeEnvelope`
but its REST path for a Room conversation needs a `room_recipient` Work Context,
which this fixture does not build, so the preview order is code-shared, not
separately staged. The 503 is identified as the deadlock victim by the
executor's transient mapping, not by reading the PostgreSQL log. The
`room_recipient` Room is now locked before the Run, which serializes Room-first
roster writers; the recipient, Agent-member and Room Agent grant rows that
`roomScopedAgentReadSql` reads are not row-locked, and their writers were not
all audited. Task links have no product delete writer; a delete would wait on
the link lock. The `input_refs` edge and M's Operation binding are written as
the Problem call admission and synthesis stage store them. No independent
review of this repair yet; private checkpoint only.


## P5 Evolution / Prompts / Runtime Context block — Codex 01c5f42e repair (source parent `32cbcfc1`, private)

Repair for the remaining P2 of Codex's review of `32cbcfc1` (decisions: plan
05, "Block review repair: Codex 01c5f42e"). Inventory unchanged:
**636 = 115 legacy + 53 exempt + 468 core**. No schema or migration change;
`0000–0018` untouched, no `0019`.

| Finding | Permanent evidence (`runtimeContextPreviewReleaseDb`) | Negative control (`32cbcfc1`'s `src/`) |
|---|---|---|
| P2: the shared Delivery/preview gate held the Run `FOR SHARE` before its Project; Project archive holds the Project `FOR UPDATE` and then takes the workflow Run `FOR UPDATE` (`markRunTerminal`, no execution lock) | Fixture: the Run is the coordinator of a running workflow execution of a Project automation (rows in the shape `WorkflowExecutionService.start` writes), with a pending `agent_run` Job and no `run_execution_locks` row. The real `POST /api/v1/projects/:id/archive` (operation core, Run terminal owner) against the shared gate, both consumers (Delivery `authorize`; preview `releaseRuntimeContextPreview`), both orders, staged by a third transaction with `waitForBlockedBy`/`waitForLockWaiter` (no sleep): archive first — the holder keeps the workflow execution row, archive waits on it holding the Project, the gate then waits; gate first — the holder keeps the Setup row, the gate waits on it after its Run, archive then waits. After commit both complete: archive 200; Project `archived`, automation `paused`, execution `cancelled`, Job `cancelled`, Run `cancelled` with `project_archived`. A fifth case uses a `workflow_execution` Work Context scope for the preview (its readable check locks the execution and root Run), archive first, held at the automation row: both complete with the same archive outcome | Delivery, archive first: the gate failed with `deadlock detected`. Delivery, gate first: archive returned 503 `operation_temporarily_unavailable` (the core's transient mapping of the deadlock victim). Preview, workflow Work Context: `deadlock detected`. The two direct-session preview orders do not deadlock on `32cbcfc1` (its Work Context check took the Project before the Run; gate-first was not staged there because that preview waited at the Setup before its Run), so they are positive evidence only. With the repair all five pass |
| Post-lock drift | "refuses a Project reached after the Run…": while the release waits after its Run (holder on the Setup row), the Agent's content row is moved into another Project (direct write; no product writer was used); the Agent content check reaches a Project outside the held set and the release withholds (`withheld: 1`) instead of locking it; the next read takes it first and releases | On `32cbcfc1` the late lock is taken and the release returns the envelope (`withheld: 0`): failed |
| `room_recipient` | The recipient Room is re-derived under the Run lock and compared with the held set. The unlocked rows of `roomScopedAgentReadSql` are covered by the Room share: recipient scope insert-only, member Room immutable, every member-status and Room Agent grant writer takes the Room `FOR UPDATE` first (`withRoomWriter`, `decideInvitation`); the Project check rests on the held Room Project audience. Audit only; no dedicated test of a roster writer against a `room_recipient` preview | — |

The re-staged quota-recovery case ("a Matrix Delivery of a Run held for quota
recovery and 'Continue anyway'…") now holds the Run row (a Run status writer)
instead of the Project: with Projects first, the gate no longer holds the Room
while waiting at the Project, so the old staging stopped exercising
Room-before-Run. Holding the Run, the gate has taken the Room and waits at the
Run, and "Continue anyway" waits on the Room; both complete (200, hold
unchanged). That case also passes on `32cbcfc1` (Room-before-Run predates this
repair).

Evidence (this runtime, Node 24.22.2, shared real PostgreSQL; dependencies
installed offline from the local pnpm store; workspace binaries run directly
because the worktree path contains `:`):

| Check | Result |
|---|---|
| server `tsc -p tsconfig.typecheck.json` (after building protocol, outbound-guard, folder-read, reader-document) | exit 0 |
| `runtimeContextPreviewReleaseDb` (14 tests, 6 new) | exit 0; 14 passed. Against `32cbcfc1`'s `src/` with the same tests: exit 1; 5 failed / 9 passed — the three deadlock cases and the drift case as listed above, and the direct-session preview gate-first case, whose staging is not reachable there ("both wait" failed: that preview waited at the Setup before taking its Run, so archive ran through) |
| server targeted real PG, run 1: `runtimeContextDeliveryDb`, `runtimeContextGateway`, `runtimeContextGroup`, `runtimeContextOperationsDb`, `runtimeContextRetrievalSwitchDb`, `runtimeContextPolicyDb`, `runtimeContextEntrypoints`, `contentDemotionReleaseDb`, `contentAccessOperationsDb`, `informationBriefingReferenceDeliveryDb`, `informationBriefingDestinationDb`, `sourceRetrievalOperationsDb`, `sourceRetrievalAccess`, `contextReportOperationsDb`, `quotaRecoveryDb`, `automationsProjectDb`, `projectKernelDb` | exit 0; 17 files / 228 passed |
| server targeted real PG, run 2: `readingMethodDb`, `readingMethodGenerationDb.1/.2`, `readingMethodOperationsDb`, `readingMethodRevisionDb`, `projectDeepReadingDb.1/.2/.3`, `personalMemoryGrantsDb`, `problemWorkspaceDb`, `problemWorkspaceRepairDb`, `researchGroup`, `runGroup`, `runtimeContextPreviewReleaseDb` | exit 0; 14 files / 185 passed |
| docs: `agentGuides`, `boundaries` | see the checkpoint note |

Limits: no full suite and no browser batch; web and protocol are unchanged
and were not re-run. The workflow linkage (automation, execution, Job) is
written in the start's row shape, not produced by firing a real workflow; the
archive side is the real operation. The Delivery barrier carries the Matrix
item only. The Project discovery mirrors each owner check by reading the same
rows; it is checked by the drift refusal, not proved complete by a test per
source type — a source type whose Project the discovery missed would be
refused with 409 (withheld/Delivery refused), not deadlock. The outer writer
audit is per-file (exclusive Project/Folder/Space/Agent/membership lock with a
Run write in the same file); cross-file compositions were not exhaustively
traced. The briefing closures keep their internal briefing-row-before-audience
order. The preview path now withholds (rather than returning an error) a 4xx
raised by its retrieval release closure. No independent review of this repair
yet; private checkpoint only.

## P5 Evolution / Prompts / Runtime Context block — final gate on candidate `b2e1c965` (private)

Candidate `b2e1c965` (source parent `32cbcfc1`; block on `62e98d82`), tree
`b76060f9`, clean worktree. Codex and Antigravity block reviews of the
candidate raised no new substantive blocker. No production or test change
follows from this gate: every assertion passed, so the delta over
`b2e1c965` is this section and its plan 05 note only. Inventory unchanged:
**636 = 115 legacy + 53 exempt + 468 core**; `0000–0018` untouched, no `0019`.

Each command ran once on that tree under Node 24.18.0 with workspace binaries
invoked directly and shared real PostgreSQL; the exit code is the process's
own. Dependencies were built before their consumers.

| Command (package) | Terminal result |
|---|---|
| `pnpm install --frozen-lockfile --offline` (root) | exit 0 |
| `tsc -p tsconfig.build.json` (protocol, folder-read, outbound-guard, reader-document, agent-cli, host-daemon) | exit 0 each |
| `tsc --noEmit` (protocol, web, host-daemon); `tsc -p tsconfig.typecheck.json` (server) | exit 0 each |
| `tsc -p tsconfig.json` (server build); `vite build` (web) | exit 0 each |
| `schema-migrations.mjs check` + `drizzle-kit check` (server) | exit 0; 19 migrations in sync |
| `vitest run` full (protocol) | exit 0; 84 files / 463 passed |
| `vitest run` full (host-daemon) | exit 1; 73 files passed, 1 failed, 2 skipped; 805 passed, 1 failed, 22 skipped. The failure is a 5000 ms timeout (5405 ms), not an assertion: `branchAlignIsolation` "refuses a Run whose isolated attachment is a quarantined repository…". host-daemon is unchanged since `62e98d82` |
| `vitest run test/branchAlignIsolation.test.ts` alone (host-daemon) | exit 0; 6 passed. This is a single isolated pass; the timeout under full-suite load is not fixed |
| `vitest run` full (server) | exit 1; 634 files passed, 1 skipped; 7873 passed, 5 skipped, 0 failed. Exit 1 comes from the budget reporter only (3 violations): `pluginFrontendDb` 60.7 s and `taskLifecycleOperationsDb` 32.2 s against the 30 s test limit, and suite import time 216.5 s against 190 s (2 × 95 s baseline). Thresholds unchanged |
| `vitest run` full (web) | exit 1; 284 files / 2563 passed, 0 failed. Exit 1 comes from the budget reporter only: 38 files over the 8 s module-import limit (8.1–12.6 s). Thresholds unchanged |

Not run: the agent-cli, folder-read, outbound-guard and reader-document test
suites (built only; none of them changes in this block relative to
`62e98d82`); the web browser layout batch (`test:layout`); OS smoke and other
opt-in suites. Limits: the budget exits and the daemon timeout remain open
gate results, not passes. The gate is not a publication; P5 remains open.


## P5 retired Source connection URLs removed (source parent `479a709e`, private)

The ten fixed-410 connection-level Source handlers (eight mutating entries,
two GETs) are deleted with their registration and the test-only exact
exemption; they were transport refusals with no domain writer, so this is
removal, not migration. Underlying connections, provenance, schema and data
are unchanged; `0000–0018` untouched, no `0019`. No other Source handler
returns a fixed 410. Inventory regenerated from Fastify registration:
**628 = 115 legacy + 45 exempt + 468 core** (from 636 = 115 + 53 + 468); the
two removed GETs are outside that method inventory. `operationRoutes` now
asserts each exact former URL is unregistered and returns 404 (no database
configured; transport only), and that live Channel subscription and the
connection-scoped Recipe/custom Source read routes stay registered. The
Reading browser acceptance consumer's expectation changed from 410 to 404
(not run here). P5 remains open with 100 entries; see the
[plan front page](#p5-closeout).

## P5 group 2 — Task / Board / Plan / Job (source parent `31e3bf58`, private checkpoint `b49c4f77` + three review repairs, final checkpoint `8d8a0e87`; local gate below, not green)

Ten legacy entries become formal core adapters: `task.create` (POST /tasks,
shared with the Agent Run tool), `task.update`, `task.evaluation.record`,
`task.plan.request`, `task.run.create`, `board.create`, `board.update`,
`plan.execute`, `plan.reconcile`, `job.cancel`. Inventory regenerated from
Fastify registration: **628 = 105 legacy + 45 exempt + 478 core**. No schema
change; `0000–0018` untouched, no `0019`.

| Invariant | Executable evidence |
|---|---|
| Explicit key, replay equality, changed-input reuse 422, no second domain effect | `taskBoardPlanJobOperationsDb` (Task create, Task Run, Plan execute), `jobsRunSettlementDb` (Job cancel) |
| Live authority on new work and replay (viewer, revoked writer, Run grant) | `taskBoardPlanJobOperationsDb` (viewer 404 on every family; revoked writer replay 404; Agent grant removal 404) |
| Server-owned provenance and strict fields (`source_*`, visibility, Run role/parent, Agent person-only fields) | `taskBoardPlanJobOperationsDb`, `inquiryTaskAssociationsDb` (forged `source_run_id` refused) |
| No Task born Done/Cancelled on any path (explicit status, raw `column_id`, `board_column`, Agent single/batch, internal writer) | `taskBoardClosureDb` |
| Person placement (ADR 0013 d3): context-free create from a shared Space lands private in the Personal Space; receipt/replay in the placed Space under current authority; no other Space's Project reachable | `taskBoardClosureDb`, `taskBoardPlanJobOperationsDb` |
| Project → … → Task/Plan lock order against archive | `taskBoardPlanJobOperationsDb` (edit and Plan execute waiting on the Project lock → 409, no write), `boardAgentActionsDb` (reparent during edit → 409) |
| Board revision on active-Board selection; Project→Project move with both writers and both revisions, revoked side refused, destination revision changed while waiting refused, Folder consistency; exact delete replay under current authority | `taskBoardPlanJobOperationsDb`, `taskBoardClosureDb` |
| Task reference closure, one owner mechanism (`lockTaskWriteClosure`) in the canonical writers and every entry: Projects (written and read-through, id order) → memberships → Folder → people → Agents → Board → Tasks; parent ancestry locked in id order, loops refused without deadlock | `taskBoardClosureDb` (crossing and four-Task reparents through a real PG lock barrier; a loop across PATCH and Space placement, serial and concurrent; Agent deactivation, account disable, Folder archive committed while the write waits; inactive Agent via placement) |
| Cross-Project references keep their access held: the real `project.member.remove` either waits for the write or commits first and the write is refused; the legal cross-Project Agent/parent stays allowed | `taskBoardClosureDb` (both orders for an Agent read through Q; parent Task of Q on edit) |
| Folder on a Project move: no old-Project Folder kept (409), named elsewhere hidden, explicit null succeeds, Folder archive barrier, internal writer the same; the follow-up writer keeps its existing any-status Folder of the Task's Project | `taskBoardClosureDb`, `followUpTaskDirectDb` (archived Folder of its Project kept) |
| Agent handoff recipient held before the Task: an Agent by its row, a person through `lockActivePerson` with the handoff's own active-account check (same 422) | `taskBoardClosureDb` (Agent deactivated during the handoff → refused, no claim; the real account-disable statement both ways: committed first → 422, no claim, no responsibility event; handoff first → disable waits, handoff commits) |
| Run creation through the Run owner with Job intent and in-progress event atomically | `taskBoardPlanJobOperationsDb` (Task Run, planning Run, Plan coordinator/node) |
| Run terminal admission for Plan reconcile and Job cancel; reconcile keeps the owner/admin contract without an active-Project gate | `taskBoardPlanJobOperationsDb` (node failure ends Plan and root; owner/admin reconcile after archive; cancelled Job ends its Run) |
| Agent `task.create` through the core: Run Project, fan-out ceiling, actor attribution | `projectWorkActionsDb`, `projectConversationWritesDb`, `taskAssociationRepairDb`, `boardAgentActionsDb` |
| Typed browser consumers send keys and read back | web `conversation-scope-api`, `TasksPage`, Task Detail browser case in `taskLifecycleOperationsDb` |

Not claimed: a green full suite (see the gate below), 18-module browser run, production approval mappings
(none enabled; the unattended Agent `task.create` still returns the
nonretryable human-initiation refusal), independent re-review of the repair,
visual acceptance (no presentation change). Job cancel finalization after
commit relies on the existing owed-finalization sweep if lost; this group adds
no new afterCommit-failure test.

Third repair (on `cca391f6`, production diff in `projectWork/taskActions.ts`,
`tasks/taskReferenceLocks.ts`, `tasks/repository.ts`, `tasks/followUpTask.ts`):
the person handoff recipient is held through `lockActivePerson` and the
handoff's own check requires an active account (same 422); the follow-up
writer keeps its existing any-status Folder of the Task's Project
(`folderAnyStatus`, still share-held). Negative controls with only the
production change reverted, same tree otherwise: `taskBoardClosureDb -t "active
account"` fails (handoff to a disabled account returned 200) and passes with it;
`followUpTaskDirectDb -t archived` fails (archived own-Project Folder refused)
and passes with it. The protocol registry fixture was brought to the 197
registered actions.

Final local gate (shared real PG, `REQUIRE_TEST_POSTGRES=1`, Node 24.22.2,
workspace dependencies built first; final tree `8d8a0e87` = `cca391f6` + third
repair + fixture):

| Check | Tree | Result |
|---|---|---|
| protocol `tsc --noEmit` | `8d8a0e87` without the fixture change (TypeScript unaffected) | exit 0 |
| protocol `vitest run` | same, before the fixture change | exit 1: registry 197 vs fixture 190 (stale fixture, not production) |
| protocol `vitest run` | `8d8a0e87` | exit 0, 84 files / 463 tests |
| server `tsc -p tsconfig.json` (build), official plugins build | `8d8a0e87` without the fixture change | exit 0, exit 0 |
| server `vitest run` (full) | `8d8a0e87` without the fixture change (no server file reads it) | **partial, exit unknown**: the process ended with the previous Agent run after 151 of 637 files / 3490 tests, 0 failed; not restarted, not counted as exit 0 |
| server targeted (closure, follow-up, project-work, lifecycle, Plan/Job, Board Agent) | `cca391f6` + third repair | 155 of 156 pass; the real-Chromium Task Detail case timed out (30 s locator), plus the budget reporter; that file alone then passed 41/41 — recorded as a timeout, not as fixed |
| web `tsc --noEmit`, `vite build` | `8d8a0e87` | exit 0, exit 0 |
| web `vitest run` | `8d8a0e87` | 284 files / 2563 tests pass; exit 1 from the budget reporter only (two imports 8.1–8.3 s over 8.0 s, suite import 516.6 s over 470 s); thresholds unchanged |
| host-daemon `tsc --noEmit` | `8d8a0e87` | exit 0 |
| host-daemon `vitest run` | `8d8a0e87` | exit 1: 805 pass, 22 skipped (environment-gated), 1 failed — the known `branchAlignIsolation` 5 s timeout; no daemon change in this group; not re-run alone |
| 18-module browser run | — | not run |

Open gate limits: the server full suite has no terminal result on this tree;
the web budget reporter, the daemon timeout and the Task Detail browser timeout
remain open, not passes.

### Test-failure investigation and gate on `2d129e17` + repair (2026-11-12, private)

Source parent `2d129e17` (code identical to `ccfa402f`; it adds two reports
only). Every earlier log was attributed first, then failures were reproduced
on this tree. Evidence: `/tmp/claude-gate-2d1` (`status` holds a durable exit
line per step; `load-samples.txt` holds host load during the gate).

Attribution and repair:

- **Real assertion failure, fixed.** `sourceGoalsDb.2 > M1: accepted sample
  never masks actual other_action refusal` expected the flat `{ok:false}` from
  `CliAgentToolTransport.call('task.create')`. Since group 2, `task.create` runs
  on the operation core, which returns `OperationToolResponse`. An ungranted
  operation is hidden as `operation_not_found` (404), the core's uniform
  refusal, and the failed `action_completed` RunEvent is still recorded. The
  test now asserts the core `summary` for `task.create` and the flat result for
  `source.material.submit` (still legacy). No production change. Group 2 never
  saw this because its server full suite had no terminal result.
- **Task Detail Chromium first-entry timeout: startup dependency, fixed at its
  cause.** The case serves `apps/web/dist` through `vite preview` and never
  checked it. In the failing group 2 run the targeted tests started at 12:59:48,
  but that worktree's `vite build` ran only at 13:07:46. With no current dist,
  `Edit contract` never rendered. `server/test/support/webDist.ts`
  `requireCurrentWebDist()` now refuses, before a browser starts, a missing
  dist or one older than its web/protocol inputs. Negative control on this
  tree: dist older than a rebuilt protocol fails in 144 ms with the cause
  (previously a 30 s locator timeout, or a pass against stale UI). After
  `vite build`: the case passes alone in 15.2 s and in the full suite in
  28.8 s (budget 30 s, tight). It never builds web; gates build web first.
- **host-daemon `branchAlignIsolation` timeout: spawn volume × concurrent
  start-up, reduced but not resolved.** A git wrapper counted 714 git processes
  in the failing test, 1.25 s alone. 180 of them came from
  `gitOperationInProgress` asking nine `--git-path` names one by one, each
  through `runLocationGit`'s per-call untrusted-config probe (the probe stays
  per call; caching it would weaken B62/B63). One `rev-parse` now answers all
  nine. If a Git directory path holds a newline (more lines than names), the
  per-name loop runs instead. New test: every marker in a main checkout, a
  linked worktree, and a linked worktree whose Git directory path holds a
  newline; the newline case fails with the fallback removed. Result: 554 spawns,
  about 1.0 s alone. Under the full run the test starts about 5 s in, during
  the 31-worker transform/import start-up. Load average then stays around
  6–12 of 32, so the CPU is not saturated. Each spawn inside the worker still
  costs about 5× (quarantine phase 0.4→2.0 s, each refused launch 0.1→0.5 s).
  Measured alternatives, none adopted: fsModuleCache (transform 43→20 s, the
  failure persisted); `--maxWorkers=16` (this test 2.7 s, but three other
  git-heavy tests crossed 5 s). Under load, 14 daemon tests run ≥3 s. The
  package declares explicit timeouts on its other process-heavy tests (30–120
  s), while the branchAlign* files added 2026-11-11 use Vitest's 5 s default.
  Whether to give them a declared timeout is a threshold decision left to the
  parent; it was not changed.
- **Budget reporter (server/web import totals): stale calibration versus
  cold-cache gates, reported only.** Every Agent gate runs in a fresh worktree
  whose per-package `node_modules/.vitest-cache` is empty. Server, recorded
  full runs: warm (transform 28–37 s) import 161–171 s, under the 190 s limit;
  cold (transform 90–99 s) 203–254 s. Web: warm (transform 3.5–4.4 s) 70–80 s;
  cold (127–150 s) 433–935 s, including the per-file >8 s imports. Controlled
  repeat of the same ten web files on this tree: import 27.1→11.7 s, slowest
  file 5.8→1.9 s. The server baseline (`files 541`, 95 s) predates today's 638
  files. `pluginFrontendDb` (a Vite dev server plus Chromium inside the
  canonical suite) has been 51–87 s in every full run since 2026-11-08; it
  stays under the user's earlier accepted exception. No threshold, reporter or
  test selection was changed.

Gate (Node 24.18.0 direct binary, shared real PG, `REQUIRE_TEST_POSTGRES=true`,
protocol/folder-read/outbound-guard/reader-document/agent-cli/daemon/server
built, then web built at 15:49; tree = `2d129e17` + this repair except the
sourceGoals assertion):

| Check | Result |
|---|---|
| daemon `tsc --noEmit`, server typecheck, protocol `vitest run` | exit 0, exit 0, exit 0 |
| daemon targeted (gitBranchAlign, branchAlignIsolation/Durability/Identity, repositoryGate, publicationChain) | exit 0, 47/47 |
| server targeted (taskLifecycleOperationsDb, testHygiene, agentGuides, boundaries) | exit 0, 81/81 |
| daemon full | **exit 1**: 799 pass, 22 skip, 9 timeouts at 5 s (branchAlignIsolation ×2, workspaceRetention ×5, taskMerge, native integration), 94 s instead of the usual 45 s. Load average reached 32.6; another Agent session's `vite build`/tests in workspace `77e10b08` ran beside it. Not re-run |
| server full | **exit 1**: 637 files, 7936 pass, 5 skip, 1 assertion failure (the sourceGoals case above, since fixed and passing 2/2 targeted); budget: pluginFrontendDb 65.4 s, import total 254.5 s, test total 2837 s (last two under the same foreign load) |
| web full | **exit 1, budget only**: 290 files / 2589 tests pass; suite import 563.1 s > 470 s (cold cache, transform 127 s); no per-file violation |
| 18-module browser run | not run |

Still open: daemon load timeouts (decision above); budget calibration and cold
cache; pluginFrontendDb's accepted exception; CI runs the server suite without
building web or installing Chromium, so neither in-suite Chromium case can pass
there. After the sourceGoals fix only the affected case was re-run; no full
suite was repeated.

### Follow-up on `1640fc22`: CI browser setup, content-checked web build, daemon grouping measured (2026-11-12, private)

Source parent `1640fc22` (the repair above). Nothing here changes production
server, daemon or protocol code, a threshold, a timeout, the reporter or the
test selection.

- **CI prepares both in-suite Chromium cases.** `.github/workflows/ci.yml`
  now installs Chromium through the locked `playwright-core` 1.57.0
  (`pnpm --filter @rainver/web exec playwright-core install --with-deps
  chromium`, which picks that version's matching build 1200) and builds web
  before `Test server`. COMMANDS (Server) lists the same two commands for a
  local full run. Locally the existing `~/.cache/ms-playwright/chromium-1200`
  was used; nothing was downloaded or deployed. The CI change itself has not
  run in CI yet.
- **`requireCurrentWebDist` compares content, not modification times.** The
  `1640fc22` version compared the newest mtime under the web inputs and
  `packages/protocol/dist` with `dist/index.html`. Negative control on the
  real tree: in CI order (web built, then the server's `pretest` rebuilt
  protocol with identical bytes) it **refused a current build** ("older than
  packages/protocol/dist/memorySessions.d.ts"), so the Task Detail case could
  never pass in CI. It also **accepted a stale build** after `main.tsx` was
  edited with its old mtime kept. The web build now writes
  `dist/build-inputs.json` (`apps/web/buildInputs.ts`). It holds the sha256 of
  every repository file in Rollup's module graph outside node_modules (799 on
  this tree: app sources, official-plugin views, the protocol and
  reader-document `dist` actually bundled), plus the config, HTML, public
  assets and lockfile. It also holds the entry names of the 89 directories
  above them, so a new plugin an `import.meta.glob` would find, or a removed
  file, also counts. The helper re-hashes those paths. Same controls with the
  new helper: protocol rebuild → accepted; `main.tsx` edited at its old mtime →
  refused, then accepted once reverted; new `plugins/official/zz_probe` →
  refused, then accepted once removed. `server/test/webDist.test.ts` (5 cases)
  runs the real writer against a temporary checkout and holds every file at
  one date, so only content decides. The record is a 103 KB public asset
  beside `version.json` (hashes and repository paths only; not precached).
- **host-daemon process-heavy grouping: measured, not adopted.** Candidate:
  Vitest projects with the 12 git-workflow files as a later `groupOrder`, no
  skip and no timeout change. It ran alternately against the unchanged config
  in the same worktree, each round under 24 synthetic CPU spinners on the
  32-CPU host (`/tmp/claude-gate-1640`, `compare.sh`; another worktree's
  vitest ran beside rounds 1–2):

  | Round | Exit | Failed / passed / skipped | 5 s timeouts | Wall | load1 median |
  |---|---|---|---|---|---|
  | unchanged, no synthetic load | 0 | 0 / 808 / 22 | 0 | 50.2 s | 7.9 |
  | unchanged #1 | 1 | 15 / 793 / 22 | 13 | 117.6 s | 34.2 |
  | grouped #1 | 1 | 20 / 788 / 22 | 17 | 168.7 s | 43.0 |
  | unchanged #2 | 1 | 26 / 782 / 22 | 23 | 126.5 s | 44.7 |
  | grouped #2 | 1 | 8 / 800 / 22 | 7 | 128.2 s | 39.6 |

  Grouping never removed the failures. Its two rounds bracket the unchanged
  config's (8 and 20 against 15 and 26), and the git group still runs its 12
  files concurrently with each other. The failures are the same tests in
  every round. They spawn 1,000–14,000 git processes per file alone
  (`taskMerge` 14,444, `workspaceRetention` 5,986, `taskWorktree` 5,618; per
  file, sequential, git wrapper), because each call into an Agent-writable
  checkout re-runs the B62/B63 configuration probe. Caching that probe would
  weaken the boundary, so it stays per call. `legacyArchiveDrain`, which runs
  no git, also fails in every loaded round, so this is CPU starvation of
  short Vitest default timeouts, not a git-only cost. The candidate config was
  deleted. Its copy `packages/host-daemon/vitest.config.ts.aside` exists only
  in the superseded private checkpoint `49d9a278` (taken during an
  unchanged-config round) and is not in this change.
- **Still open, quantified, not changed:** daemon tests on Vitest's 5 s
  default fail under sustained CPU contention (above; they pass at 0 failures
  without it). A declared timeout for the branchAlign*/git-workflow files
  remains a threshold decision for the parent. `pluginFrontendDb` took 30.4 s
  (limit 30 s) in the targeted run below, beside three sourceGoals files,
  under its already accepted exception. Server/web cold-cache import totals
  are as described above.

Checks (Node 24.18.0, shared real PG `REQUIRE_TEST_POSTGRES=1`, web built
16:24 from this tree, server workspace deps rebuilt after it):

| Check | Result |
|---|---|
| protocol + reader-document build, web `vite build` | exit 0 (record: 799 files, 89 dirs) |
| server `test/webDist.test.ts` | exit 0, 5/5 |
| server `taskLifecycleOperationsDb` (Task Detail case in real Chromium, after `build:workspace-deps`) | exit 0, 56/56; the case 15.3 s |
| server `sourceGoalsDb.1/2/3`, `pluginFrontendDb`, `testHygiene`, `agentGuides`, `webDist` | **exit 1, budget only**: 7 files, 272 pass, 4 skip, 0 fail; `pluginFrontendDb` 30.4 s > 30 s |
| server typecheck, web typecheck | exit 0, exit 0 |
| web `tsc -p tsconfig.node.json` | exit 1: the four `vite.config.ts` errors (`rollup` types) that `1640fc22` also has; none in `buildInputs.ts`; no script runs this config |
| daemon full, grouped vs unchanged | table above; no daemon source changed, so no further daemon run |
| server/web full, 18-module browser run | not run (the `1640fc22` full results above stand; this change touches only test infrastructure, CI and the web build's extra asset) |

### Bounded Git batching on `c23f8526` (2026-11-12, private)

Scope: `taskWorktree.checkLocationRepository` and `workspaceBaseline` only.
Reuse / Dependency Check: existing `runLocationGit` stdin and Git's native
`update-index -z --index-info`; no dependency, runner or cache engine added.
The repository probe combines three queries, preserves the empty prefix, and
refuses incomplete/malformed output. The newline-root fixture exercises Git’s
quoted common-dir output, not an embedded newline in the parser regex branch.
Filesystem ownership,
linked-root exclusion and unborn/broken HEAD classification remain separate.
Baseline index updates use 64 KiB NUL batches, including zero-mode deletions
and held-handle executable bits. Per-file bounds and checks, both captures,
HEAD/status stability, private-index isolation and failure cleanup remain.
Every actual Git call still probes effective untrusted configuration (B62/B63).

**Validation reuse not adopted.** A same-repository full OID and identical
policy do not freeze replace refs: the new negative control validates an OID,
installs a replacement containing a denied tracked `.env`, and verifies that
revalidation refuses it, then succeeds after removing the replacement.
`checkoutMatches` also checks live index/files, submodules, markers and effective
fileMode/symlinks/filter configuration; prepare can change base during idle
sync. Keeping those checks live is necessary. No replacement/config/ref
snapshot or policy change was added merely to enable a small validation cache.

**Measured parent/candidate comparison.** Exact parent source was loaded as
untracked temporary sibling modules (removed after the experiment), against
the same real temporary Git repository per pair: 20 new regular files, two
captures per snapshot, three alternating parent/candidate pairs, one worker,
Node 24.18.0, Git 2.43.0, 32 logical CPUs, no synthetic load. `spawn` was wrapped
to count actual Git processes, including safety probes; the Git-version cache
was warmed. Load1 was 16.81–18.25. All six resulting trees were equal.

| Operation | Parent spawns | Candidate spawns | Parent wall ms (3 rounds) | Candidate wall ms (3 rounds) |
|---|---:|---:|---|---|
| repository check | 8 | 4 | 57.7 / 69.3 / 51.0 | 34.9 / 36.4 / 36.6 |
| source baseline (20 paths) | 188 | 112 | 2101.9 / 1827.5 / 1865.7 | 1257.8 / 1245.0 / 1130.3 |
| update-index within baseline | 40 calls | 2 calls | included above | included above |

These are fixture measurements under changing host load, not production or
full-suite latency guarantees. An initial six-capture single-test experiment
hit the existing 5 s limit; splitting into three independent pairs preserved
that limit and completed 3/3, exit 0. No timeout/budget/skip change was made.
The new focused test covers empty prefix, a newline root and unborn semantics;
linked/nested roots are refused by filesystem preconditions, not parser negative
controls. It also covers rejection after a core.worktree config change (not a
probe-count assertion for every actual Git call), NUL-sensitive names,
deletion/mode preservation, real-Git
tree equivalence and a changed-content negative control, cleanup on symlink
refusal, replace refs, and a multi-batch long-path capture.

Final verification (all processes terminal; no stopped/killed test run):

| Check | Terminal result |
|---|---|
| protocol/folder-read/outbound-guard/agent-cli builds; daemon `tsc --noEmit` | exit 0 each |
| initial affected daemon run, `--maxWorkers=2`, 9 files | exit 1: 118 passed, 15 failed, 152.26 s. 13 default-5-s timeouts; one repositoryGate exit-code assertion (expected 1, got 0); one new test incorrectly expected a file→directory snapshot to succeed |
| corrected final `workspaceGitBatch`, `--maxWorkers=1` | exit 0: 6/6, 5.04 s wall; regular-file→directory still refuses `workspace_snapshot_special_file`, source index unchanged |
| complete daemon suite once, `--maxWorkers=1` | exit 0: 75 files passed, 2 skipped; 814 tests passed, 22 existing environment-gated skips; 216.51 s wall |
| `git diff --check` | exit 0 |

The initial targeted run's load1 rose from about 18 to 38. Its repositoryGate
assertion was not diagnosed as a product defect or attributed solely to load;
the same suite passes in the final complete run. The one-worker full run began
at load1 25.72 and ended at 7.08. This does not establish reliability at default
concurrency or sustained CPU saturation; that prior limitation remains open.
No synthetic CPU workers, test grouping, timeout, budget or skip was changed.
The initial new test expectation was corrected to retain the existing special-
file boundary. Separately, batched `--index-info` implicitly replaces a tracked
directory (`a/b`) with a regular file (`a`), which the previous per-path
updates refused. This index-update behavior matches `git add -A`; the follow-up
regression
compares their trees. Complete capture, however, still refuses `not_directory`
when reading the obstructed child `a/b`; it does not accept this transition.
The regression also checks that refusal and unchanged source-index bytes.
The reverse file→directory transition remains refused. No server/DB/browser checks
were run for these daemon-only edits. Dependencies were linked locally from the
installed checkout (identical lockfile), workspace dependencies rebuilt with
Node 24; no lockfile or installed-checkout source was changed. The first pnpm
attempt failed before tests because this fresh worktree lacked dependencies
and its auto-install store could not open; direct local tool invocation and
real-Git test escalation resolved verification without changing runtime policy.

#### Review follow-up on the batching commit (2026-11-12, private)

Exact parent: `5a1f0c098a08fcc25b58e9c32b8d1fd6f3c44971`. Only test and
documentation corrections; production code, dynamic configuration probes,
held-handle reads, both captures and timeout/budget settings are unchanged.
The new directory-replacement test first exposed `not_directory` in complete
capture; the final test records that boundary and independently compares the
private index replacement tree with `git add -A`, rather than claiming capture
acceptance. No new parser abstraction or review/delegation round was added.

Current-runtime checks (Node 24.22.2, Git 2.43.0; all processes terminal):

| Check | Terminal result |
|---|---|
| daemon `vitest run test/workspaceGitBatch.test.ts --maxWorkers=1` | exit 0, 7/7; 1.73 s |
| server `vitest run test/agentGuides.test.ts --maxWorkers=1` | exit 0, 8/8; 3.33 s; budget reporter passed |
| `git diff --check` | exit 0 |
| full suite | not rerun; earlier 814 pass / 22 skip result above is historical |

Dependencies were reused through temporary local symlinks, removed after checks.
Initial attempts could not resolve dependencies, spawn Git in the ordinary
sandbox, or load the server config through its read-only dependency path.
After dependency linking and approved real-Git/cache access, the commands above
completed. A runner-loader attempt also failed before tests; the passing guide
run used the repository's normal config and reporter. No threshold changed.

## P5 Skills and authorization-request continuation on 5f7246e8

Private implementation basis: exact parent
`5f7246e814516d8201f2f2ec3eb3331733cf3e62`; the Publication layer is retained.
This continuation migrates **Skills 6 + authorization-request 2**, not all
remaining 20 entries. Actual Fastify registration generated and verified
`630 = 491 core + 94 legacy + 45 exempt`: 79 P5 legacy entries remain (plus
P4's unchanged 15), including this batch's **Proposal 4 + Bundle 4 +
Automation 4**. No new exemption, production approval mapping, Task, budget,
review request, migration or schema change. The next executable owners and
limits are in Plan05's current continuation section.

- Six strict protocol-owned Skill commands share formal/generic key namespaces,
  mandatory audit, output validation and live scope replay. Review returns 201
  on creation or 200 for the same pending review; the core persists the actual
  status with the receipt. Same-person review creation joins the transaction
  and serializes its pending lookup instead of recovering a unique violation
  inside an aborted transaction. Canonical binding apply rechecks the proposer
  on every scope before the package lock; review-with-binding follows that
  same order. No second approval of proposal creation is added.
- Skill source admission writes one max-attempts-1 Job. Existing HTTP guard and
  Host transport fence each real send on its current claim. Source acquisition
  is outside transactions; import source/package/files and receipt settle in
  the same transaction under current person/Host authority and claim. Unknown
  starts are never retried. The result reader rechecks Host access; generic Job
  payload/result/error and event detail withhold this content. Changed preview
  hash is a fixed authorized refusal; arbitrary Host errors are not released.
- The canonical AuthorizationRequest owner now joins raw/branded transactions
  for creation and decisions. Request creation takes its Run before the request
  insert. Approval uses the requester's own discovered Agent/Run release
  closure, including Project/Folder/Room membership and grants; it checks their
  ordinary Run and Agent reach independently of the approving Space owner.
  Owner rejection after requester exit is preserved. Grant, decision, policy
  audit, required reconcile Job and operation receipt are atomic.
- Reused closures accept Agent references in their existing global sorted
  resource order. This change claims the evidenced Skill/requester gates, not
  completion of the eight Proposal writer families or an exhaustive global
  deadlock proof for the remaining batch.

Evidence on Node 24 with shared real PostgreSQL, no fake persistence:

- `skillsRoutes` (12 current cases): strict/key validation; formal/generic replay;
  pending review 201/200; no trust/binding effects from proposal creation;
  current Project-writer and Space revocation; deferred mandatory-audit rollback
  and same-key recovery; immutable import/receipt settlement and rollback on
  receipt-write refusal; unknown-start refusal; worker-side requester revocation;
  Host result revocation before/after IO; actual Host transport sends no frame
  after cancellation; actual Job worker reports changed hash with no import.
- `runToolGroup`: real REST/generic authorization replay, independent requester
  and owner checks, current requester reach before exit, owner rejection after
  exit, raw outer rollback and deferred operation-audit failure with same-key
  recovery, plus existing grant/audit/reconcile invariants.
- The final 14-file affected chain initially reported 234 passed / one hygiene
  failure (the new auth identity seam lacked the fixture's `afterEach` reset).
  The reset was added. Focused follow-up `skillsRoutes`, `runToolGroup`,
  `testHygiene`, `agentGuides`: **4 files / 50 passed, exit 0**. The other
  passing affected files were `skillsOverlay`, `skillsApprovalDb`,
  `skillsFramework`, `operationRoutes`, `operationExecutorDb`,
  `hostCommandWorkerDb`, `hostCommandAuthorityDb`, `systemActionRegistry`,
  `contentDemotionReleaseDb`, and `boundaries`. No failing assertion remains
  from that chain; the new hash/transport cases were added in the follow-up.
- Negative control: remove only `lockSourceRetrievalRelease` from
  `lockSkillScopeAuthority`. The Project-writer race then returns **200 where
  404 is required** (exit 1). Restore the original source: the affected file
  passes. An earlier barrier-only version detected the same omission by its
  10-second wait timeout; the final negative control uses the explicit status
  assertion. Runtime-budget warnings remain advisory.
- Protocol: `skillsFramework` + `systemActions`, **27 passed**, no-emit check
  and incremental build pass. Web: `skill-operation-api` + Skills page,
  **30 passed**, no-emit check passes. Explicit Publication client key
  parameters were typed as strings to retain caller-owned non-UUID retry keys;
  Publication runtime behavior was not rewritten or retested. Server no-emit
  check passes; final added-test check and `git diff --check` are recorded with
  the checkpoint. Route inventory verification passed without its update flag.

Limits: no full suite, browser batch, live GitHub acquisition, real remote Host
or deployed acceptance; Host answers and provider-free acquisition are bounded
fixtures around the real registry/Job/database owners. Initial dependency,
serialization, test fixture and sandbox-Docker failures were corrected before
these passes. No threshold changes, product database, push, prepare/publish,
deployment, restart or webhook. Whole-batch review remains the parent's work
once the remaining twelve entries are implemented and verified.

## P5 Automation configuration prerequisite on 92461132

Exact parent `92461132d2060921c6face5737bf7c1fcc52123b` (parent
`5f7246e814516d8201f2f2ec3eb3331733cf3e62`). The isolated branch was clean but
still at that older parent at run entry; it was fast-forwarded to the exact
retained 11-entry basis before editing. No shared target ref was changed.
This delta is **incomplete prerequisite work, zero additional qualified
adapters**. All 23 states: Publication 3, Skills 6 and AuthorizationRequest 2
retain their prior migrated state/evidence; Proposal 4, Bundle 4 and Automation
4 remain pending. Inventory is unchanged: 630 = 491 core + 94 legacy + 45
exempt; P5 remaining 79, including these 12, with P4's 15 frozen. The expected
503/82 and P5 67 are future completion counts, not this result.

Implemented configuration cut:

- REST create/update/autonomy share one configuration transaction and surround
  it with the canonical policy-audit recovery owner. The service's narrow
  `forConfigurationTransaction` factory builds its repository from the same
  raw/branded port; it exposes configuration methods only.
- Agent preflight reads, Workflow normalization and preflight version resolution,
  and Context Ops settings preflight use that port. Schedule, credential grant
  and configuration writes and the policy allow audit therefore settle with
  the owner. Failed COMMIT rolls all of them back, then recovers a failure
  audit after release. Existing internal/scheduler fire callers are retained.
- No core adapter, production approval mapping, universal-refusal substitute,
  legacy-route retirement or exemption is introduced. Fire is not claimed
  transactional or qualified. No schema/migration, protocol or browser contract
  changes; frozen 0000–0018 and unrelated work are untouched.

Reuse / Dependency Check: reused `withQueryableTransaction`, the existing
policy-audit recovery owner, repository, native target registry and
`resolveEvolvableAssetVersion`; no dependency or second engine. This is a
Rainver transaction-ownership seam, not a new commodity mechanism.

Verification in this runtime (Node 24.22.2, shared real PostgreSQL,
`REQUIRE_TEST_POSTGRES=true`, every listed process reached terminal exit):

| Check from owning package | Result |
|---|---|
| server `vitest run test/automationsAutonomyEnableDb.test.ts test/automationsProjectDb.test.ts --maxWorkers=2` | final exit 0, 37 pass; raw/branded outer rollback of enablement, grants, schedule and audit; archive/revocation rollback; uncommitted Agent and Workflow-version reads; uncommitted Context Ops settings; deferred mandatory audit COMMIT failure with no configuration/grant/schedule residue and recovered failure audit; existing REST/fire/Workflow behavior |
| server `vitest run test/automationTargetRegistry.test.ts test/jobsSchedulers.test.ts test/contextOpsReviewCycle.test.ts` as part of the initial explicit five-file chain | these three files exit 0, 51 pass; the chain itself initially exited 1 because two new audit assertions shared a previous test's policy record |
| server `tsc -p tsconfig.typecheck.json` | final exit 0 |
| server `vitest run test/agentGuides.test.ts test/testHygiene.test.ts --maxWorkers=2` | final exit 0, 20 pass including the documentation delta |
| protocol and existing workspace libraries | local incremental builds exit 0, dependency preparation only; no fresh protocol/web behavior-test claim |
| `git diff --check` | exit 0 |

The two initial assertion failures were test isolation: policy audit records do
not disappear when the fixture deletes its Space/users. The fixture now resets
`policy_decision_records` explicitly. No production error was hidden or test
threshold changed. Initial missing direct-run path, missing tsc shim, read-only
linked Vite cache, and ordinary-sandbox container access failures were resolved
with local dependency links/cache and approved isolated test-PG access; they
are failures, not passes. No skipped real-PG verification is counted as success.
All test-only triggers/functions were dropped in `finally`; each owned outer
client rolled back/released and its branded port closed. The app fixture now
also closes its server.

Negative control: remove only the `context.db` choice from Context Ops preflight,
then run the single uncommitted-settings case. Terminal exit 1: it incorrectly
reads the other connection's `private_only` settings and refuses the valid
owner transaction. The exact source bytes were restored in `finally`
(SHA-256 `462f9e5777d8b8074bb706a36e8bcf52e1d68c53780d50df5441f39e2c227dc2`)
and the final 37-case positive chain passed. This is a transaction-read negative
control, **not** the still-required global lock-barrier/concurrency evidence.

Remaining executable work is unchanged in scope: convert Automation fire and
all native target consumers to single-attempt durable intent plus current
Run-owner/autonomy and claim/version settlement, then qualify its four real
adapters. Complete the canonical Proposal/Bundle typed effect owners, eight
writer families, requester/approver and granting-person/B10/provenance gates,
full globally sorted key discovery and drift checks, rollback/replay/revocation
and real lock-barrier controls before qualifying their eight adapters. Do not
request whole-23 review or begin later batches from this partial checkpoint.
No full suite, stress/browser batch, external live IO, deployment or instance DB
operation was performed; no new Task, proposal, delegation or budget was made.

## P5 third batch: first person-scoped filing continuation

`capture.file` migrates the retained `POST /me/filings` into a strict, keyed,
human-only core command with typed client. Its server-only person admission is
a closed exception: a real owned Personal Space stores receipts/audit, while
active person, source ownership/full read and target Project writer gates
independently authorize the operation. Request-Space membership grants nothing.
The canonical filing service joins core's branded transaction and uses the same
Project/audience -> person/membership -> root/grant admission for direct calls.
Closure drift refuses the write. Note creation, Activity lineage/processed state,
mandatory audit and receipt settle together. Replay repeats current capture,
Project and created Note authorization. No active Memory writer or B10 change.

Reuse / Dependency Check: extends OperationExecutor/formal adapters/Zod and
existing filing/Note writers, canonical Project audience and Source-release
locks, shared real-PG fixture and typed browser transport. No new dependency or
schema; third-party evaluation is inapplicable to domain authorization.

Node 24.22.2 verification, terminal results:

- `captureFilingDb.test.ts`: 17 pass, including cross-Space creation and exact
  provenance, canonical personal receipt storage, REST/generic same-key replay
  even with an unrelated request-Space locator, account/target/capture withdrawal,
  target membership lock barrier and deferred mandatory audit rollback/retry.
- `operationRoutes.test.ts`: 18 pass; inventory is 630 = 553 core + 32 legacy +
  45 transport exemptions. Third batch is 9/26 implemented, 17 remain; no whole
  batch or dual-review completion claim.
- Protocol filing contract: 1 pass; typed client filing transport: 2 pass.
  Server, protocol and web no-emit typechecks pass.
- Guides/hygiene: 20 pass. `operationExecutorDb.test.ts`: 71 behavior tests pass,
  two catalog expected-list assertions fail. Replacing only the protocol registry
  and runtime composition with exact source-parent HEAD reproduces those two
  failures (557 actual vs 496 expected; current adds capture.file, 558 actual).
  Current sources were restored in finally and protocol rebuilt. This pre-existing
  expected-list drift is reported separately, not hidden or counted as a pass.
- `git diff --check` passes. Initial missing dependencies, read-only Vite cache,
  unavailable ordinary-sandbox Docker, four invalid Note-column assertions and
  a direct-service hidden-error mismatch were failures, then corrected; none is
  passing evidence. Shared test-PG access used the ordinary approval path.

No instance DB, migration-history edit, full/browser/stress suite, Task/proposal,
delegation/budget, prepare/publish/push/deployment, P4 or unrelated source change.
Remaining: cross-Space retrieval five, personal Memory grants three, attention
two, Research strategy four, Ask/Context Ops three. They remain legacy until
actual canonical writer, current-authority replay and ordered-lock evidence land.

### P5 private catalog expectation reconciliation on exact parent f4aa7044

The two catalog failures above are stale expected-list drift from this task's
retained-route migrations, not missing production registrations. The inherited
explicit fixture listed496 operations; the actual public/user registry lists558.
The62 missing expectations are the migrated automation, proposal/bundle,
Reading, Interest/Digest/briefing, Activity/Capture, Focus/Graph/Learning and
Space-egress operations, including `capture.file`. No expected operation was
removed. The fixture now lists those62 ids explicitly; it does not derive the
expected catalog from the live registry or relax visibility/actor assertions.
Production code, operation classification and enabled mappings are unchanged.

Verification in this isolated worktree, Node24.22.2, shared real PostgreSQL:
`operationExecutorDb.test.ts -t 'serves the real catalog|production composition enables no approval mapping'`
passes2 selected cases;71 unselected cases are skipped, not rerun or counted.
The local protocol and supporting libraries were built from this worktree.
Initial pnpm store/path and sandbox Docker failures are not passing evidence.
The earlier filing17/core71 evidence remains historical evidence on its stated
basis. This catalog-only correction completes no additional route: third batch
remains9/26, with retrieval5, personal Memory grants3, attention2, Research4 and
Ask/ContextOps3 still legacy. No whole26 review or exempt-GET gate is claimed.
No Task/proposal/delegation, schema/P4 change, publication, deployment or
instance-database action is part of this correction.
Server no-emit typecheck, agent-guide8 and hygiene12 checks also pass; all cited
processes are terminal. `git diff --check` passes. These scoped checks do not
constitute a full suite or an additional route acceptance.


## P5 final exempt/GET gate on exact parent 9d0b6f2f (private)

Basis: `9d0b6f2f1eed9e55b7935b72c0e3faa4bdfc1dda`; implementation candidates
**23 + 41 + 26 = 90**, prior64 family/review evidence retained. This record is
not a new dual-review approval, overall Task completion or production acceptance.

**Gate blocked:** `POST /api/v1/activity/upload` persists a domain Activity,
not just upload staging. Removed its false transport exemption and added the
exact route to the non-exemption regression cases. Actual Fastify inventory is
**630 = 570 core + 16 legacy + 44 exempt**: P4 fifteen unchanged, plus this
explicit P5 upload gap. Repair needs the canonical Activity command's current
admission, stable key/replay, file lifecycle and atomic audit/receipt; merely
setting route metadata or sending multipart through a JSON adapter cannot close it.
No speculative upload/storage mechanism was added during this audit.

| Owner inspection of the original45 exemptions | Finding |
|---|---|
| Auth23 (`auth/routes.ts`) | Identity/session/password/OAuth/registration/admin identity lifecycle, not product-content writes. API-key two routes are explicit501 with no canonical storage. Secrets/cookies cannot be retained as ordinary replay results. |
| Internal5 (`deployment/routes.ts`, `policy/routes.ts`, `runs/routes.ts`) | Service-token protocol: deployment heartbeat/stages, policy decisions and admitted Run orchestration. These are not public user-command grants or pure queries; persistence is owned protocol progress/audit/Run execution. |
| Binary3 | Conversation upload and owner-only deletion of **pending, unclaimed** staging remain transport; message media cannot be deleted there. Activity upload is the rejected exception above. |
| Host12 (`hosts/routes.ts`, `ordinaryToolAccountRoutes.ts`) | Pairing-code issuance1, daemon bearer protocol6 (Host/workspace/attempt-bound output delivery), live owner relays5. Persisted daemon progress/output is checked by the Host/Run owner; interactive replies are not durable command results. |
| Subscription input1 + Run tool1 | Live admin credential input; Run-token tool transport delegates to dispatcher/core and does not grant an action. |

Stateful GET owner inspection: Folder tree/file/git status/git diff (four) and
Run file-preview (one) release authorized Host/file data with owner policy/read
audit; no user content mutation is admitted. Runtime login and ordinary-tool
account streams (two) are live owner authentication protocols. Subscription
login stream (one) is an admin credential/OAuth lifecycle, including credential
persistence and current-authority recheck, not a pure-query claim.
Saved-item processing GET (one) previously cancelled overdue Runs and settled
material content/indexes. It now only reads; the existing Run finalizer owns
settlement and admitted deadlines remain in execution. The historical CSRF
guard stays, but is not used as evidence that the endpoint is read-only.

A search beyond those nine guarded GETs found another **open blocker**:
`GET /api/v1/sources/goals/:goalId` -> `SourceGoalService.read` invokes
`reconcileNativeSearch` and `cleanGoalSamples`. Native result settlement and
persistent sample scrubbing are actual writes, not a pure query. Closure must
separate the existing tick/finalizer/retention writers from a currently redacted
read projection; deleting cleanup alone could expose samples after expiry or
policy withdrawal. This audit does not qualify that path or widen P4.

Final local evidence, Node **24.22.2**, terminal processes:

- Protocol full: **98 files /538 tests pass**. Frozen policy fixture explicitly
  adds the missing16 existing actions; existing223 metadata/order is preserved.
  The `activity.create` enforcement pointer now names its actual create owner.
- Server affected combination: **11 files /164 pass**: core executor73,
  contracts16, actual registration inventory19, Ask send fence9, material5,
  guide8/hygiene12, CSRF12, boundaries5, registry ownership3 and Source boundaries2.
  Catalog fixture explicitly adds6 already-enabled Research/Context Ops ids;
  no mapping or visibility assertion is relaxed. GET negative control on the
  exact parent's material implementation fails both new PG cases; current
  source restored and final positive combination passes.
- Web original-family typed consumers: **23 files /66 pass**. Protocol dependency
  builds and protocol/server/web no-emit types pass. No presentation changed.
- Scope audit: compare method/path against `33280edc`'s routeInventory, select
  newly core entries, require90 distinct pairs, then resolve each declared id
  against SYSTEM_ACTION_REGISTRY and its input/output, core-owned execution and
  existing POLICY_ACTION_REGISTRY owner paths. All90 pass. This static ownership
  check complements actual registration/catalog/consumer tests; it is not new
  durable effect evidence. Prior family PG/lock/provider evidence is reused.

Limits: no fresh server/web full suite, 18-browser batch, stress/fault-process
rerun or live provider/Host test. Historical full-suite runs retain their stated
failures/incomplete exits. Initial dependency/cache/container setup, incomplete
fixtures, stale policy/catalog assertions and a cancelled pre-repair run are
not passing evidence. Completed import/time warnings are advisory, not hidden;
no running check remains. Production mapping503, B10 proposal/applier/provenance,
P4, schema0000–0018 and unrelated work are preserved. Private checkpoint only;
no new Task/proposal/delegation/budget, shared-ref move, prepare/publish/push,
deployment or instance-DB operation. Two named owner gaps keep the final gate open.

## P5 upload and Source Goal closeout correction

Exact clean parent: `15782be8d14b78df7834f681bc21442cb3f31fdd`.
The original **23 /41 /26 =90** implementation candidates and earlier64 evidence
are unchanged; **one separate closeout correction** migrates Activity upload.
Actual registered inventory now proves **630 =571 core +15 P4 legacy +44 exempt**.
The earlier blocked audit above is historical; it is not rewritten as a pass.

`activity.upload` has a strict keyed, human-only protocol/policy registration,
formal multipart adapter and typed client. Core admission commits audit,
receipt and one-attempt Job together. The canonical Activity owner preserves
bounded exact private transport bytes in that new Job, rather than truncating
them as generic diagnostic evidence; generic Job payload/result/error/events
withhold them. Current person, Project/Folder and result authority gate replay.
Worker admission/send/settlement use existing sorted creation authority and
the exact trusted current Job claim. File I/O runs outside transactions.
Activity, mandatory audit, byte-copy removal and Job completion commit together.
Unknown starts cannot produce a replacement write. Cleanup resolves uncertain
commit under the Job lock before deleting only proven unreferenced storage.

Source Goal detail GET no longer invokes reconciliation or persistent cleanup.
Read projections apply current sample/collection retention without writes.
Existing scheduler recovery covers pending native manual previews and stopped
goals too; finalizers settle their own Runs, ticks keep collection recovery,
and existing artifact maintenance owns expiry/policy scrubbing. Consumed native
transport copies are cleaned during recovery outside finalizer Run locks.
SQL-terminal fixtures explicitly invoke the recovery lifecycle before reading;
a GET is never smuggled into that writer role.

Focused Node24.22.2 evidence: upload/current replay/authority/claim withdrawal
after real file I/O, generic Job byte withholding, late audit rollback, and
Source detail with real-PG domain-write-refusal triggers pass. The detail test
also proves retained storage is unchanged by GET and existing scheduler/
retention maintenance still advances it. Exact-parent service fails that same
test with “GET tried a domain write”; current source is restored.
Existing native/retention/sample/scheduler selection: **46 pass**,204 not selected.
Earlier protocol538/server164/web66/guide20 evidence is retained, not rerun as
fresh full-suite evidence. Final checks: server core/owner/inventory/contracts/guides **6 files /75 pass**,
existing Source lifecycle **46 pass /204 not selected**, scheduler consumers
**17 pass /98 not selected**; the finalizer/scheduler guard subset repeats2
of those lifecycle tests after the final boundary change. Protocol
**2 files /23 pass**, typed web/capture **2 files /14 pass**; protocol/server/web
no-emit types and dependency builds pass. Diff check is clean. Initial setup,
fixture, missing-config and byte-sanitization failures are not passing evidence.
All checks, including advisory import/time warning runs, are terminal.

Reuse / Dependency Check: canonical Activity creation, operation executor,
PgJobQueueRepository/current claim/effect authority, native reconciliation,
Run finalizers, Source scheduler and existing retention projection/maintenance.
No dependency or schema migration, new storage engine, alternate Source writer,
Memory writer, approval mapping or P4 migration. Generic command JSON transport
now permits36 MiB for bounded base64 uploads; individual schemas remain strict.
Upload title/note are bounded32768 characters; original25 MiB file budget remains.

Limits: failed/interrupted uploads can retain private Job bytes; a process crash
or unavailable database can leave an unreachable transport file whose deletion
cannot be proven safe. No scavenger, automatic resend, live-provider/Host,
browser18, stress, instance-DB, full-suite or deployment acceptance is claimed.
Capture UI reports queued intent, not saved Activity. Coordinator serial
independent review and overall Task completion remain separate gates.
