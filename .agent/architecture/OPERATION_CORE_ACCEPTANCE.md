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
claimed complete, nor is checkpoint5. Existing Note-link choice stays pending.

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
