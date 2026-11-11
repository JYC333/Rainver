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
| Query readonly, policy, Source/audience, B11 | operationExecutorDb readonly write refusal; independent policy denial; Source canonical egress gate withdrawal, visibility narrowing, required B11 failure and same-owner exclusion; two concurrent queries with every slot of a two-connection data pool held | No business/progress mutation or unchecked content release. Host-only audit capacity is independent of the data pool. Production queries include the metadata catalog and Source backfill preview; content tests are controlled registrations. |
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
[P5 plan](../plans/operation-core/05-core-module-operation-migration.md#project-total-package--4335ee20-baseline-continuous-implementation).
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
[P5 plan](../plans/operation-core/05-core-module-operation-migration.md#project-package--verification-gate-on-06cf3cfc-2026-11-10).
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

All 59 in-scope Agent, Agent-template, Room, Agent-group, Run and direct-session
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
[P5 plan](../plans/operation-core/05-core-module-operation-migration.md);
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
