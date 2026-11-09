# Plan 5 — Core Module Migration to the Operation Core

Status: in progress. Depends on the completed [Plan 1 contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md),
not on P3/P4. Current authorization: implement the five Project packages continuously, run
affected checks, then the coordinator schedules one Claude/Antigravity review.
No per-family review stop, staging, commit, push or deployment is authorized.
Historical family review/commit notes below remain evidence of their own snapshots.

## Delivery contract

One domain implementation per migrated capability, one operation execution core.
REST, Agent and browser adapters call it; no parallel old executor, dual write,
fallback, compatibility switch or legacy error translator remains in that family.
Unused endpoints and their callers can be removed together. A retained URL is a
formal adapter, not a retained implementation. Existing domain history,
provenance, approval evidence and business uniqueness rules are not transport
deduplication and must survive. Unmigrated families remain explicit pending work.

Use strict operation schemas/DTOs, authenticated manual origin for user calls,
explicit caller idempotency keys and canonical errors. Preserve authorization and
domain outcomes; do not broaden Agent surfaces to match human interfaces. Product
semantics that genuinely differ get separate operations; existing accepted ADRs
are constraints, not new decisions requiring permission. No automatic write retry.

Reuse / Dependency Check: reuse P1 OperationExecutor, operationTransaction,
PolicyGateway/audit recovery, canonical Proposal appliers and existing domain
services/Jobs. Use current protocol Zod schemas and typed browser helpers, plus
shared real PostgreSQL fixtures. No new execution, approval or retry engine,
parser or dependency is needed for this migration.

## Finite baseline and ownership (e54d44e1)

The method/path source list is
[`routeInventory.json`](../../../server/src/modules/systemActions/operations/routeInventory.json),
checked against actual Fastify registration by `operationRoutes.test.ts`.
The initial saved inventory had 632 rows (599 legacy, 31 transport exemptions,
2 core entries); the actual registration test exposed a missing Host managed
update route. The corrected baseline is **633** mutating-method entries:
**600** legacy, **31** transport exemptions, **2** core entries. This is a route
count, not an operation count. Aliases may share a capability.

- P4 owns 15 diary/finance plugin writes (2 + 13); P3's future PhD plugin is
  excluded. Host plugin installation/enablement is still a core control plane.
- The remaining 585 baseline legacy-method entries are the P5 core migration
  queue. All must end as migrated operations or individually justified transport
  exceptions; do not silently call them completed after the first batches.
- The 31 existing exemptions are 23 auth, 5 internal and 3 upload/media paths.
  They are candidates requiring owner review, not automatic permission to keep
  domain mutations outside governance (including media deletion/Run tool calls).
- GETs are outside this method inventory. Review stateful GETs separately using
  actual `stateChangingReadAllowed` call sites in providers, hosts, ordinary tool
  accounts, Project Folders and runs; the historical count of eight is not an
  exhaustive mutation guarantee. Ordinary reads migrate only as needed.
- Current production core registrations are catalog query and research cancellation;
  legacy registry metadata does not establish executable migration. Cancellation
  is already migrated and is a regression consumer, not new implementation work.

The saved inventory remains the single exact list, not a second hand-maintained
route ledger. Stage completion requires both owning service evidence and inventory
changes; a route annotation alone is insufficient.

## Three delivery stages, eight internal checkpoints

| Stage | Checkpoint | Concrete closure / gate |
|---|---|---|
| Ordinary capabilities | 1. Inventory and contracts | Baseline above, per-family entry/authority/transaction/error/consumer closure; distinguish product decisions from fixed security boundaries |
| Ordinary capabilities | 2. Ready commands | First: policy.action_grant.create/revoke. Then separately scoped Project operation and Source DB-only commands; no external work inside core transactions |
| Ordinary capabilities | 3. Board/Task controls | configure/move/status/delete, revision/WIP/execution constraints; task.create deferred to checkpoint 7 |
| Approval and domain work | 4. Approval writer closures | All writers for a mapped proposal type, including frozen payload updates, supersession, expiry and dependent multi-request cascades |
| Approval and domain work | 5. Note/Source actions | Resolve policy and approval prerequisites before enabling promotion/activation; preserve Source consent/egress and invalid-material attempt semantics |
| Approval and domain work | 6. ProjectWork/Inquiry/Task advancement | Single work event writer, report vs complete, review responsibility, Inquiry rounds/revisions and settlement |
| Semantics and closure | 7. Divergent/sensitive behavior | task.create fields/visibility, canonical Memory direct/proposal conditions and proposal decision conversation/person authority |
| Semantics and closure | 8. Remaining core families | Exhaust remaining baseline core paths by owning module, review stateful GETs/exemptions, delete duplicate paths, update permanent evidence |

Checkpoint 2's first complete public operation family has no external calls,
Jobs or approval mapping. AuthorizationRequestService's separate approval command
uses the same transaction-bound grant writer and retains its own audited grant
admission; it must not lose audit evidence or gain a recursive top-level dispatch.
This is a separate still-unmigrated approval command, not a second implementation
of grant creation. Grant consumption/lookup remain domain operations under their
existing owning Proposal/Run transaction.

Other initial candidates are not ready for indiscriminate registration:

- Source backfill proposal/start depends on canonical approval/auto-grant writers.
  Its domain idempotency key is also used by orchestrator/monitoring and cannot
  be dropped as if it were only transport dedupe. Project write authority must
  be revalidated when linking backfill and Project operations.
- Source recipe plan/dry-run perform external work. Separate DB intent/Job and
  completion boundaries before core-owned execution; activation needs its complete
  approval closure. Do not leave a hidden legacy fallback.
- Project operation creation currently accepts reserved kinds/progress used by
  other services; inventory those callers before changing input semantics.
  Generic cancel and research cancellation differ on terminal behavior; do not
  accidentally collapse different contracts.

## Eight approval writer families

Before enabling a production approval mapping, audit and migrate the complete
writer/effect closure for the actual proposal type, following key -> Proposal ->
request -> domain locks (all keys sorted for cascades):

| Owner | Required closure |
|---|---|
| proposals/applyService | accept/reject, typed applier effects and dependent status cascades |
| projects/projectDefinitionProposalService | replacement/supersession and frozen definition payload |
| projects/monitoring/service | monitoring direction replacement and approval supersession |
| memory/proposalRepository | canonical versioned payload/provenance and ADR0003/B10 gates |
| plans/repository | review lifecycle and request state |
| runs/repository | Run materialization/Proposal lifecycle and finalization |
| importedSessions/extraction | extracted payload updates and request state |
| skills/proposalApplier | package transition and bulk supersession |

The list describes ownership boundaries, not eight files whose edits alone prove
closure. Approval mappings stay failclosed until every relevant writer and race
is covered. Do not wrap a proposal-producing command in an approval of proposal
creation; do not replace requester authority with approver authority.

## Per-family acceptance and retirement

- Strict schemas and output DTOs, explicit user/Agent surface and live role/scope
  authorization, one final policy decision per invocation, rollback on audit failure.
- Real PG cross-entry replay, key/input conflict, concurrent reservation, authority
  revocation, stale resource/approval checks and atomic domain/audit/Job effects.
- Known 409/422 errors are typed/allowlisted; no arbitrary private error reflection.
- Retire duplicate route/service enforcement and transport idempotency only after
  the replacement covers every caller; retain domain uniqueness/history.
- Update owning guides, route inventory and typed consumers in the same change.
  Focused tests only, plus relevant types/build/guide checks. No full-suite claim.
- Record actual review results, skipped reviewers and remaining scope. A skipped
  reviewer is not approval; a passed fixture is not a production migration claim.

## Bounded delivery matrix

| Checkpoint / family | Implementation scope | State |
|---|---|---|
| P5-1 inventory/contracts | Corrected baseline, approval writer closure, family gates and permanent guide links above | Closed |
| P5-2 action grants / Project operation | Public grant create/revoke and Project operation commands with shared core contracts | Committed; original ready scope accepted/completed after7594f2ec |
| P5-2 remaining ready commands | Source DB-only families, including processing/extraction controls | Original23 ready entries completed; Source processing38-file family committed7594f2ec |
| P5-3 Board configure / exact Task placement | REST, generic, Agent and typed Board consumers share core writers | Committed in 4ffdeca8 |
| P5-3 remaining Task controls | set_status/delete and standalone Space Board placement | Lifecycle committed in b2a47192; standalone placement closure below completes this checkpoint's capability scope |
| P5-6 Task advancement | report/complete/request_review/handoff; original done/review delegation | Committed in b2a47192; Inquiry and other advancement remain pending |
| P5-4 internal writer subsets | canonical decisions/cascade, replacement/frozen payload, Plan review, Skill set, Run/root/nested owners and Evolution mixed effects | Committed through8600172e; final standalone effect/creation closure below awaits review, no production mapping enabled |
| P5-4 through P5-8 remaining | Approval closures, Note/Source, advancement, sensitive semantics and remaining inventory | Pending |

At the grant-family basis, inventory was 633 entries = 598 legacy + 31 exemptions + 4 core
entries. This batch moves only two grant URLs from legacy to core. Of the 585
baseline core legacy entries, 583 remain; 15 plugin legacy entries stay outside
this P5 queue. The human collaboration participant operation is preserved and
uses the existing generic URL, adding no standalone inventory row.

Reuse / Dependency Check: existing OperationExecutor and transaction-aware
PolicyGateway admission/audit, Zod DTOs, grant writer and shared real PG fixtures
are reused; no new commodity implementation or dependency is needed. Public
route/service duplicate enforcement is retired. Internal authorization-request
approval is a separate unmigrated command using the same writer with its own
transaction-bound audit. Domain active-scope uniqueness, stale expiry, grant
consumption and proposal approval provenance are preserved. No production
approval mapping, external call, Job or fallback is added.

Permanent current-state owners updated with this family:
[SYSTEM_ACTIONS](../../architecture/SYSTEM_ACTIONS.md),
[execution contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md),
[acceptance matrix](../../architecture/OPERATION_CORE_ACCEPTANCE.md#p5-action-grant-family)
and [policy guide](../../modules/policy.md#action-approval-grant-commands).
Plan 1 historical results and review evidence remain unchanged.

Verification and handoff: Node 24 workspace dependencies build passed. Initial
sandbox PG attempt failed global setup (container runtime unavailable), with no
executed tests; the approved shared-container retry passed all six focused
files / 88 tests, zero skips. Final checks after review hardening are recorded
below. No full-suite result is claimed. Independent Claude/Antigravity review is
coordinator-owned and pending; this worker does not delegate or commit. Preserve
unrelated INDEX edits, automatic-worktree-concurrency plan and reports.

Final family verification (2026-11-06, uncommitted on 02ffcc40):
- `build:workspace-deps` and server `tsc -p tsconfig.typecheck.json --noEmit` passed.
- Shared real-PG focused run plus guide/boundary/hygiene checks: 9 files,
  115 tests passed, zero skips. Grant family: 12 tests; writer: 3; authorization
  request: 13; executor: 52; routes: 1; runToolGroup: 9; guides: 8;
  boundaries: 5; hygiene: 12. No threshold raised.
- Protocol focused check exposed an old placeholder-schema assertion that also
  treated the existing human collaboration command as accepting `{}`. The check
  now limits that legacy placeholder expectation to nonmigrated definitions;
  concrete operation contracts retain their required fields.
- After that correction, protocol `operations.test.ts` and `systemActions.test.ts`
  passed: 2 files / 25 tests, zero skips. Protocol typecheck, rebuilt workspace
  dependencies, final server typecheck and `git diff --check` passed.
- P5 completion is not claimed. Reviewers have not been dispatched by this worker.

Next candidate for coordinator scoping: Project operation DB-only commands,
after auditing reserved kind/progress consumers and cancel semantics. This is a
recommendation only; no next-family implementation begins in this handoff.

## Grant review follow-up (2026-11-06)

Claude's B1/P1 finding was confirmed: authorization-request approval's grant
policy audit joined the transaction but was lost on refusal or downstream
failure. `AuthorizationRequestService.decide` now wraps its complete private
transaction owner with the existing `withPolicyAuditRecovery`, matching the
canonical Proposal apply pattern. Recovery runs after rollback and release,
restores the original audit id with `operation_outcome: failed`, and leaves a
committed success audit alone. There is no new recovery mechanism, independent
success audit, changed public grant key/envelope, or enabled approval mapping.

Existing real-PG authorization fixtures in runToolGroup are reused. Five new
cases cover deny, require_approval, grant failure, Job failure and unavailable
audit storage; the existing success case also asserts one audit and no duplicate
on a repeated decision. Grant/Job trigger failures expose the in-transaction audit
id only to the test, which verifies recovery retains exactly that id. All failed
approval cases preserve a pending request and no grant/reconcile Job; audit
storage failure remains failclosed.

Antigravity's stale SYSTEM_ACTIONS paragraph now explicitly labels its 631-entry
count as the Plan 1 historical snapshot. Current 633 = 598 legacy + 31 exempt +
4 core adapter entries remains consistent with this matrix. Broader migration
is still pending; review of the fixes and commit remain coordinator-owned.

This review run's focused shared-PG verification passed 4 files / 42 tests,
zero skips: authorizationRequestService 13, runToolGroup 14 (five new),
actionGrantOperationDb 12, actionApprovalGrantService 3. The initial ordinary
sandbox attempt failed container-runtime global setup and executed no tests;
the approved shared-container retry passed. This is new execution evidence,
not a repetition of the earlier 115-test or protocol results.

Final independent checks for this fix: Node 24 workspace-dependency build,
server build (including bundled official plugins), server
`tsc -p tsconfig.typecheck.json --noEmit`, and `git diff --check` passed.
Guide/hygiene checks passed separately: 2 files / 20 tests, zero skips.
No full-suite run or new protocol-suite run is claimed. The worker changed only
the transaction owner, existing runToolGroup fixtures/tests, SYSTEM_ACTIONS
historical wording, policy guide, acceptance evidence and this P5 matrix.
The confirmed B1 behavior is repaired and tested; coordinator recheck remains
pending. No next-family implementation or commit was performed.

## Project operation public command family

Implemented on 7aea6793; independent review pending. This batch migrates exactly
`project.operation.create/cancel`, not the surrounding Source or Research
orchestrators. No public progress-update command exists. No Agent grant or
production approval mapping is added. At that family basis, inventory was 633 = 596 legacy +
31 exemptions + 6 core entries; this batch subtracts two of the prior 583 P5
core legacy entries, leaving 581 (15 plugin legacy entries remain separate).
Earlier grant verification/counts above describe that completed batch's basis.

Reuse / Dependency Check: reuse OperationExecutor, existing Project ACL/active
Project locks, canonical ProjectOperationService/Repository, the Research stop
closure and transaction-bound cancellation/Job writer, Zod and shared real PG
fixtures. No new dependency or commodity engine; these are domain adapters.

Caller closure and preserved authorities:
- Public REST creation and cancellation plus typed browser helpers use core.
  Both are user-only. Neither previously had an Agent executor; actual Run tool
  calls remain refused even with an injected immutable grant snapshot.
- Public drafts preserve custom/source_setup/source_backfill type labels, optional
  intent, ordered steps and nullable initiating_run_id/plan_artifact_id refs.
  References use existing writer same-Space/Project checks plus canonical live
  content/Room read checks; they grant no execution authority. Research creation,
  caller-provided progress and step status remain internal. The initial narrower
  custom-only/without-refs draft was corrected during review, not accepted as a
  product requirement or attributed to user confirmation.
- Source setup/backfill proposals in projectSourceProposalService retain their
  canonical internal create/link writer and multi-effect/domain idempotency.
  Research acquisition uses createManagedResearch and setManagedState; Source
  and monitoring lifecycle/projection writers remain internal. They are not
  registered as generic progress updates or claimed migrated by this batch.
- Generic cancellation keeps its own terminal behavior: nonresearch completed/
  cancelled rows conflict, while failed nonresearch rows can be cancelled;
  research completed/failed/cancelled rows conflict. Dedicated research cancel
  retains successful already_terminal receipts. Generic research cancellation
  shares Research stop/Thread/Run visibility and canonical status/reconcile/Job
  work in the core transaction. The worker owns process IO after commit.
- Public receipts are strict minimal metadata (id, project_id, kind, status,
  version), never raw progress/Research bindings/content. Formal URLs return
  canonical envelopes and require explicit keys. Old route enforcement is
  removed; the same domain implementation serves both public adapters.

The unrelated INDEX, worktree plan and reports remain untouched. No handover
file, commit, push, deployment, online database write or next-family work is
included. Independent Claude/Antigravity review is coordinator-owned.

Initial pre-review verification of this family (2026-11-06, uncommitted on 7aea6793):
- Initial ordinary-sandbox PG attempt failed container-runtime global setup,
  executing no tests. Tool-approved shared real-PG execution succeeded.
- Final related server run: 8 files / 105 tests passed, zero skips:
  projectOperationCommandsDb 12, projectOperationService 3,
  projectResearchOperationCancelDb 12, operationExecutorDb 52, operationRoutes 1,
  agentGuides 8, boundaries 5, testHygiene 12. Inventory was regenerated once
  through UPDATE_OPERATION_ROUTE_INVENTORY=1 and then verified without it.
- Protocol operations/systemActions: 2 files / 26 tests passed, zero skips.
  Browser conversation-scope-api: 1 file / 6 tests passed, zero skips.
- Node 24 workspace dependencies and server build (including bundled official
  plugins), server tsc -p tsconfig.typecheck.json --noEmit, protocol/web
  typechecks and git diff --check passed. No thresholds raised or full suite run.
- Known limit: no new process-death/COMMIT-loss experiment; canonical P1 core
  evidence remains separate. Research stop process effects remain worker-owned;
  this batch proves only the atomic DB intent, not live execution-host stopping.
- Current next action is independent review of this complete family, especially
  the preserved draft labels/readable refs and strict metadata-only receipts.
  Other P5-2 Source commands and P5-3 Board controls remain pending.

## Project operation review corrections

N1: restored nonresearch type labels and nullable Run/Artifact refs in the same
strict operation schema. The public adapter reuses canonical content/Room read
predicates, locks referenced resource rows and checks same Space/Project. The
existing domain createLocked reference checks remain in place, and internal
managed writers are unchanged. No fallback/dual schema or association execution
authority is introduced. Default-null fields normalize omitted and explicit null
for same-key replay.

N2: real-PG tests cover archived create/cancel and replay returning canonical 409;
actual bound Research fixtures prove generic stop refuses both an invisible Run
and a Thread readable via oversight without personal change authority, with
hidden 404 and no stop Job/state change.

N3: the existing common HTTP body limit is 32 MiB (appShell createServerApp),
shared by formal REST and generic routes before JSON parsing. The frontend
nginx API proxy does not override its inherited/default limit; that may be
stricter, and no live proxy size acceptance is claimed. There are no
new intent/detail length or step-count quotas; the ungrounded 100-step ceiling
from the initial migration draft was removed. Large intent/detail and 101-step
HTTP drafts succeed; over-limit requests return 413 before any write.

N4: formal adapters reuse canonical cache-control and gateway request-id
conventions. Tests assert response headers and correlation on success/error;
extra route blank lines are removed. Current inventory and migration totals
remain 633 = 596/31/6, with 581 baseline core legacy paths pending.

New verification after N1–N4 corrections (2026-11-06):
- Tool-approved shared real PostgreSQL, 9 related server files / 120 tests
  passed, zero skips: projectOperationCommandsDb 18, researchOperationRepairDb 9,
  projectOperationService 3, projectResearchOperationCancelDb 12,
  operationExecutorDb 52, operationRoutes 1, agentGuides 8, boundaries 5,
  testHygiene 12. This is a new run, separate from initial 105-test evidence.
- Protocol operations/systemActions: 2 files / 26 tests passed, zero skips.
  Browser conversation-scope-api: 1 file / 6 tests passed, zero skips; it sends
  the restored label/Run/Artifact fields through the typed generic helper.
- Node 24 workspace dependency build, server typecheck --noEmit, protocol/web
  typechecks and git diff --check passed. No new full-suite, live-proxy or
  process-death check is claimed. No test thresholds or production limits moved.
- No identified review issue remains unhandled; final coordinator verification
  is still pending. No delegation, commit, push, deployment, online data write,
  handover file or next-family implementation was performed.

## Board configuration and exact Task placement subfamily

Basis dac5d44b. This batch scopes board.configure and task.move_to_column.
set_status(done/waiting_for_review) calls completeTask/requestTaskReview, while
Task deletion owns unfinished Run/Plan refusal and Host branch/merge withdrawal;
those separate writer closures remain pending. No report/complete/handoff/review,
task.create or production approval mapping is migrated by this batch.

Reuse / Dependency Check: reuse existing Board schemas, configureProjectBoard,
PgTaskRepository.updateTask with explicit transaction port, Project/full Task
access gates, actor resolvers, canonical work-event/merge Job writers and the
OperationExecutor. Zod/Fastify/shared real PG are installed mechanisms; no new
dependency or execution engine. WIP remains a stored/display hint, not a new
hard quota. Ordinary status changes and exact column selection remain distinct.

Board subfamily closure: public PUT configuration, named POST exact movement,
generic calls, Agent Run tools and the parent Board UI all use the same core.
Old Agent executors are removed. Project Task PATCH rejects column_id; ordinary
metadata/status editing and standalone Space Board placement remain explicit
unmigrated domains, not a failure fallback. configureProjectBoard joins the
core transaction port; updateTask preserves work events, completion admission
and required merge Job writers. Human completion acknowledgement and Agent
actor/Run attribution remain distinct. No active execution owner is invented.

WIP is an existing hint. Keys/revision/columns are read through canonical Board
reads; no stale-key retry or inferred revision is introduced. Unassigned and
same-status multi-column semantics are covered. There is no production approval
mapping; unattended Agent changes remain failclosed. Public schemas are shared
with typed clients and Agent metadata, not copied legacy DTOs.

Inventory: 634 = 595 legacy + 31 exemptions + 8 core entries. Relative to 633 =
596/31/6, the existing configure PUT moves from legacy to core and the explicit
move URL adds one core entry. Exactly one more baseline core legacy path is
retired: 580 remain. The legacy Task PATCH keeps its unmigrated editing/status
scope; registration metadata alone does not mark it migrated. P5-2 as a whole
and the remaining P5-3 commands are not complete. Coordinator review/commit is
pending; no handover file, delegation, push, deployment or online DB change.

Verification on dac5d44b with this uncommitted Board subfamily (2026-11-06):
- Shared real PostgreSQL, REQUIRE_TEST_POSTGRES=true: 8 files / 105 tests passed,
  zero skips: boardAgentActionsDb 16, projectBoardColumnsDb 5, taskDeletionDb 6,
  operationExecutorDb 52, operationRoutes 1, agentGuides 8, boundaries 5,
  testHygiene 12. taskDeletionDb confirms unfinished execution/Plan refusal stays
  intact; deletion itself is not migrated by these passing regressions.
- Existing taskMergesDb fixture selected with `-t 'Board core required'`: 2
  tests passed. Thirty unrelated tests were not selected (Vitest reports them
  skipped); these are not PG-unavailable skips or passes. Real Job rejection
  is proved by a nontransactional sequence, not a fake database/queue.
- Protocol operations/systemActions: 2 files / 27 tests passed, zero skips.
  Web ProjectBoardPage/conversation-scope-api: 2 files / 35 tests passed, zero
  skips. Parent Board interactions, completion dialogue and explicit transport
  keys are covered; no visual/layout acceptance is claimed for this API change.
- Node 24 workspace dependency build, server build (including bundled official
  plugins), server typecheck --noEmit, protocol/web typechecks and diff check
  passed. No full suite run or threshold increase. No live Host/process effects
  or new process-death experiment performed.
- During verification the core pool-acquisition guard exposed a pool lookup
  inside domain work. Registration now captures its repository pool at
  composition time and every domain query joins the issued transaction port.
  The failing cases were repaired and rerun; only the final passes above count.
- Independent reviewer selection and final commit remain coordinator-owned.
  The next authorized scope is still pending set_status/delete closures, not an
  implicit declaration that P5-3 or the whole P5 program is complete.

### Board review corrections N1–N5

Review corrections only, still based on dac5d44b with no commit:
- N1: origin-gated unattended writes remain require_approval and fail closed
  without a production mapping (503 operation_approval_mapping_unavailable,
  nonretryable). The Agent response explains the human initiation/approval
  boundary, missing migrated approval path and no automatic retry/origin spoofing.
  Real autonomous/job/continuation-root fixtures prove no Board/Task mutation,
  receipt or authorization request, and exactly one durable failed policy audit
  per command.
- N2: the existing generated tool-schema function has a bounded Board projection
  derived from canonical Zod: reason required, human override omitted. Human
  operation input remains optional/default-null reason with completion override;
  runtime Agent validation is unchanged. No second executor or schema registry.
- N3: the public PATCH placement gate now lives inside the existing writer
  transaction, after Task locking and scope revalidation. Both board_id and
  column_id, mixed reparenting and concurrent standalone-to-Project moves are
  covered. Internal writers keep their transaction port; standalone placement
  stays available. Only the retired placement refusal uses the core error
  envelope; other legacy PATCH failures retain their existing route errors.
- N4: a hidden Task blocking configuration gives hidden 404, without detailed
  disclosure or partial changes. The domain private-Task assertion now expects
  404; the separate domain viewer permission assertion remains 403.
- N5: both named required merge Job failures assert one failed policy audit,
  retaining the nontransactional sequence proof of actual enqueue and all
  Task/events/merge/receipt/revision rollback assertions.

New verification after corrections:
- Real shared PG: boardAgentActionsDb 21 passed; projectBoardColumnsDb 5 passed.
  Related operationExecutorDb 52, operationRoutes 1, agentGuides 8, boundaries 5
  and testHygiene 12 passed (78 checks). These final results span focused runs;
  an earlier run caught the old domain 403 assertion, which was corrected and
  the affected domain file rerun successfully. No PG-unavailable skips counted.
- taskMergesDb selected with -t 'Board core required': 2 passed, 30 unrelated
  tests not selected. Both new failed-audit assertions passed.
- Protocol operations/systemActions: 28 passed; web Board/API: 35 passed.
- Node 24 workspace dependencies and server build (including official plugins),
  server typecheck --noEmit and protocol/web typechecks passed; diff check passed.
  Initial sandbox execution could not access the container runtime; the actual
  PG runs used tool-approved access to the shared isolated test container.
- Route totals unchanged at 634 = 595/31/8; baseline core legacy remaining 580.
  No new family, approval mapping, full-suite run, visual acceptance, live data
  access, deployment, delegation or commit. Independent review remains pending.


## Task lifecycle family (P5-3 controls / P5-6 Task advancement)

Basis 4ffdeca8. Implemented six commands: task.set_status, task.delete,
task.report, task.complete, task.request_review and task.handoff. Preserve the
existing actor boundary: human status/delete and Agent six-command surface;
the four advancement verbs do not become human API capabilities. Run grants,
responsible person, audience/full access and stored Run Project stay current.

Reuse / Dependency Check: reuse OperationExecutor, canonical work event writer,
Task completion/responsibility functions, existing Task repository transaction
port, branch/merge Job intents and workers, protocol Zod and real shared PG
fixtures. These are Rainver domain semantics; no external commodity engine,
new dependency, transport dedupe table, or approval mechanism is needed.

Call closure: named status and retained delete URLs, generic commands, Agent
Run tool transport, browser Task quick actions and explicit delete confirmations.
Old Agent handlers are removed, and PATCH refuses status in the locked writer
instead of retaining a second public path. Ordinary metadata, task.create,
standalone Space Board placement and internal settlement/undo are separate.
Agent complete/review delegation is retained, not replaced by raw status SQL.
Task deletion is DB admission plus persisted cleanup intents; actual Host IO
stays in existing workers and never runs inside the core transaction.

Internal writers retain their explicit transaction port and domain uniqueness.
The core owns retry identity; no hidden compatibility dispatcher or automatic
stale/input/key retry is added. Unattended status/complete/delete still fail
closed without approval mapping, with the existing nonretryable Agent explanation.
No Proposal status writer or B10 memory path is widened or mapped.

Inventory: 635 = 594 legacy + 31 exempt + 10 core adapters. Relative to the
Board basis 634 = 595/31/8, delete retires one existing path and status adds
one named adapter; baseline core legacy remaining 579. Registry count is not
route retirement. P5-3/6 remain in progress with unreviewed/unmigrated scopes,
and P5-2 as a whole remains incomplete. No handover file or next family.

Verification on 4ffdeca8 with this uncommitted lifecycle family (2026-11-06):
- Shared real PG, REQUIRE_TEST_POSTGRES=true. Initial final related command:
  taskLifecycleOperationsDb 28, taskDeletionDb 6, projectWorkActionsDb 50,
  projectConversationWritesDb 5, operationExecutorDb 52, operationRoutes 1,
  runToolGroup 14, boardAgentActionsDb 21, taskBranchLifecycleDb 14:
  9 files / 191 passed, zero skips.
- Subsequent focused additions: taskLifecycleOperationsDb now 30 passed;
  agentGuides 8, boundaries 5 and testHygiene 12 also passed (4 files / 55).
  Across final focused runs, the 12 distinct server files contain 218 passing
  tests. The earlier 28-test lifecycle count is replaced, not added again.
- taskMergesDb with -t 'Board core required|Task core cleanup intent receipt':
  9 passed, 30 unrelated cases not selected. Includes real complete/status/
  cancellation/delete Job rejection via trigger plus sequence, failed audit
  recovery, and successful required Job receipt replay without duplicate intent.
  Actual Host branch worker regressions are the 14 taskBranchLifecycleDb cases.
- Protocol operations/systemActions: 2 files / 30 passed. Web Board/Task list/
  Task Detail/API initially 4 files / 45 passed; the API file then passed 8
  and Task list 4 after added assertions. Final distinct coverage is 47 tests
  across those four files, including explicit key, delete confirmation and
  parent list reload. No visual acceptance claim.
- Node 24 workspace dependency build, server build including official plugins,
  server typecheck --noEmit, protocol/web typechecks and git diff --check passed.
  Inventory updated through UPDATE_OPERATION_ROUTE_INVENTORY=1 once and then
  verified in the normal route test without the update flag.
- Early runs exposed stale catalog-order expectations, a wrong responsible
  field name and an invalid role-revocation fixture that retained Space-owner
  authority. Those tests were corrected using actual non-owner membership;
  only the final successful runs above are counted. No fake DB fallback,
  threshold change, full-suite run, live data access, Host deployment,
  handover file, delegation, commit or push. Independent review is pending.

### Task lifecycle review corrections (same 4ffdeca8 basis)

- Restored safe Agent Task-id correction via one Task-domain MissingTaskTarget
  path for all six commands, modeled on Research target discovery. It rechecks
  live Run/Agent/grant/person and current Run Project writer authority before
  using task.list's canonical content ACL, ordering and existing 50-row limit.
  Existing same-Space private/foreign/deleted targets stay hidden. Other Spaces
  are not queried; their ids and random missing ids receive indistinguishable
  current-Project-only discovery. Human requests remain hidden. No legacy
  handler, transport dedupe or policy bypass is restored.
- Fixed TaskContractEditor: Project contracts omit placement and do not show the
  invalid standalone Board selector. Standalone Board selection/changes remain.
  Added the missing existing wire field project_id to the typed web Task model.
  The backend locked placement guard is unchanged.
- Agent completion refusals keep canonical missing/unacknowledged metadata and
  gain fixed Artifact-type/artifact.submit/review instructions. No arbitrary
  private domain message is forwarded.
- N1: existing HTTP bodyLimit is 32 MiB in gateway/appShell.ts; blocked_reason
  still uses optionalString in the writer (trim, empty => null). No arbitrary
  new field quota. Human reason remains input/fingerprint information and does
  not become a ProjectWork event reason; the existing Agent reason still does.

New verification after these corrections:
- Shared real PG, REQUIRE_TEST_POSTGRES=true: 9 server files / 164 passed,
  zero skips. taskLifecycleOperationsDb 41 (including the real browser parent
  case), projectWorkActionsDb 50, operationContracts 16, boardAgentActionsDb 21,
  projectConversationWritesDb 5, taskDeletionDb 6, agentGuides 8, boundaries 5,
  testHygiene 12. All six commands have positive discovery plus private/foreign/
  revoked Project/revoked grant cases; cross-Space/no-signal and list bound
  assertions are explicit. The original positive correction assertion is back.
- The actual built Task Detail parent and editor use real Fastify routes and PG
  for Project contract saves and standalone Board changes; the former mixed
  Project placement payload still gives 422 without partially changing its
  title. Browser bootstrap chrome alone is synthetic. This is not merely a
  mocked onSubmit payload check.
- Chromium captured entry/dialog states in dark/light, en/zh-CN, 390/1280.
  Inspected settled desktop dark and phone light dialogs, the phone parent
  header with its neighbouring actions, and the standalone Board selector.
  Shared controls, focus, wrapping and save/cancel remain visible; the Project
  selector is absent. Initial transition-frame screenshots were discarded and
  recollected after actual animation completion. Existing English Task form
  labels in the Chinese shell are unchanged; no translation rollout is claimed.
- Web: the four affected parent/API files passed 47 tests, and the existing
  TaskContractEditor file passed 3 (5 files / 50 total). Protocol operations/
  systemActions passed 30. Node24 server/protocol/web types, server build with
  official plugins, web build and diff check passed.
- Verification caught the missing typed project_id and new-browser-file hygiene
  violations. The browser case is now in its owning lifecycle group, uses the
  existing afterEach seam reset, and waits on animation completion instead of a
  long fixed sleep. No hygiene exemption, quota or threshold was changed.
- Inventory remains 635 = 594 legacy + 31 exempt + 10 core, baseline remaining
  579. No new capability family, production approval mapping, full suite,
  online DB, delegation, commit, push, deployment or handover file.


## P5-4 internal decision and replacement subset

Started on b2a47192. The coordinator concurrently committed unrelated reviewed
Task/Research/chat changes as c610c5dc; this run made no commit. Its edits are
limited to Proposal transition admission, canonical decision/dependency creation,
Project definition/monitoring replacements, focused tests and the owner/contract/
acceptance/plan documents. Unrelated INDEX, worktree plan and reports remain.

Reuse / Dependency Check: reuse P1 lock identity/canonical encoding, existing
pg nonblocking transaction advisory locks, branded query ports, canonical
Proposal appliers and audit recovery, withQueryableTransaction, real PG fixtures.
No dependency, second approval/transaction engine, delayed-reconcile substitute
or direct Memory writer is introduced.

Actual SQL and caller inventory, not an eight-filename completion claim:
- applyService owns reject, final status with/without final payload patch, Source
  dependent supersession and external code-patch rollback. DB decisions/cascade
  now participate; linked grant apply/rollback fail closed, not bypass mappings.
- projectDefinitionProposalService direct supersession and both monitoring
  supersession branches now use the port before domain locks.
- memory/proposalRepository still revises pending version payload/provenance.
  importedSessions/extraction still merges pending Brief payloads shared with
  definition proposals. They need a reviewed frozen-payload replacement flow
  that preserves the human review/provenance, not a request invalidated while
  an edited pending Proposal silently becomes unacceptably stranded.
- plans/repository review supersession is inside the Plan version/budget owner.
  runs/repository recovery and finalization change proposals inside multi-object
  Run/Attempt/lock CTEs. Their complete preflight/key admission must move to those
  transaction owners; a late request update cannot prove atomicity/order.
- skills/proposalApplier bulk supersession holds the package lock and skips
  sibling Proposal locks. Its outer sibling request/creation set must be frozen
  before that domain lock; it is not migrated by generic service hooks.
- systemActions/operations/approvals retains its canonical mapped supersession;
  retry/retention reconciliation remains a backstop, not a legacy writer fix.
- Additional caller owner found: evolution/bundleRepository locks bundle/member/
  Proposal rows before acceptInTransaction/rejectInTransaction and lacks the
  mapped audit recovery lifecycle. It remains ineligible for a linked mapping.

Implemented subset: full sorted request-key admission, then Proposal closure
gates/rows, requests, domain locks. Recursive Source rejection terminalizes
pending descendants and their linked requests in the same transaction. Changed
dependency/key-link sets conflict without late keys or auto retry; canonical
dependency insertion joins the gate. Pending request attachment revalidates
Proposal state, expiry and exact frozen payload. Canonical acceptance requires
the real validated atomic result and policy recovery owner. Replacements roll
back new drafts/versions, old status and linked request together.

This is a reviewable independent subset, not P5-4 completion. The five remaining
writer families plus outer Evolution/effect owners still block enablement.
No production approval mapping, public proposal.decide permission or secondary
approval of proposal creation is enabled. URL accounting stays 635 = 594/31/10;
baseline core legacy remaining 579.

Verification for this subset on c610c5dc (2026-11-06):
- REQUIRE_TEST_POSTGRES=true related server run: 10 files / 188 passed, zero
  skips, followed by the affected operationExecutorDb file / 66 passed after
  adding the descendant-linked external rollback guard. Final distinct coverage
  is 189 tests across those ten files, not 188+66.
- Durable PG files: operationExecutorDb 66, projectInformationMonitoringDb 62,
  projectConversationWritesDb 5, memoryProposalIntegration 4, pluginOperationsDb
  17 (154 tests). Pure/route/guide checks: proposalApplyService 2,
  proposalsRoutes 8, agentGuides 8, boundaries 5, testHygiene 12 (35 tests).
  The route seams/pure checks are not presented as durable PG evidence.
- New core coverage includes successful recursive multi-request Source rejection,
  failed ledger-update rollback of Source/Proposal/request state, actual sorted
  full-scope key acquisition before any Proposal row, real PG table-lock
  coordination of graph growth, dependency creation versus cascade, accept/
  reject concurrency, expired and old terminal request cleanup under held keys,
  rejected late request attachment after terminal/payload drift, and no synthetic
  accepted result. Existing P1 failure-audit recovery and mapping-only fixtures
  remain passing. No fake durable database is introduced.
- Direct definition replacement has linked success and real SQL-failure rollback
  cases; monitoring scope/details each have linked success and rollback cases
  retaining the original version/proposal set. The monitoring fixtures use P1
  reserve/record in a real transaction, not a production mapping registration.
- Protocol operations/systemActions: 2 files / 30 passed. Node24 workspace deps,
  server/protocol types, server build including official plugins, and diff check
  passed. No UI changes or visual acceptance claim; no full suite.
- Early fixture attempts exposed Source provider/connector uniqueness and the
  reach of partial reset cascades. The core test file now fully rebuilds its
  isolated per-case fixture before seeding. Original inactive-membership refusal
  semantics were retained. Only corrected final results above count; no test
  threshold, production constraint or permission was relaxed.
- Remaining five writer families and external/effect owners have no claimed
  linked-writer closure evidence or new mapping qualification. P5-4 remains
  in progress. Reviewers/commit remain coordinator-owned; no delegation, commit,
  push/deploy, online DB or handover file was performed.


## P5-4 second subset — 41e8f5c7 working diff

Status: implemented independent subset, awaiting coordinator review; P5-4 remains
in progress. The previous 12-file subset was committed by the coordinator as
41e8f5c7. This run does not commit or alter unrelated INDEX/worktree-plan/reports.

Reuse / Dependency Check: extend the existing transition port to whole Skill
review sets and globally ordered multi-Space Run admission. Reuse P1 key locks,
canonical insertion/appliers, transaction brand/owner helpers, content grant
inheritance, policy-audit recovery and real PG fixtures. No new approval engine,
transaction framework, direct Memory writer or dependency is introduced.

| Actual writer/caller closure | Current implementation | Remaining limitation |
|---|---|---|
| memory/proposalRepository payload revision | Pre-admit linked keys; frozen old draft/request superseded with fresh review, retaining audience/provenance/deadlines, no copied approvals | Active Memory still only canonical B10 applier; no mapping enabled |
| importedSessions/extraction shared Brief payload | Full pending Brief key set before Project/mutex; merged fresh review and read marks commit together; no model IO in DB transaction | New pending set outside admission returns conflict; no auto retry |
| plans/repository plan_review supersession | Old review keys before Run/Task/Plan/version locks; same transaction for old/new versions and linked states; review insertion canonical | Plan/Workflow-owned Run terminal composition is not qualified |
| skills/proposalApplier bulk supersession | Complete package sibling closure before package locks; no SKIP LOCKED; insertion gate plus live package recheck; linked sibling makes policy audit atomic | No production mapping; original per-person pending uniqueness/human scope gates retained |
| runs/repository recovery CTE | Snapshot eligible Runs; per-Run sorted admission and independent transactions; same CTE effects and requests | Independent owner only; snapshot growth waits for next sweep |
| runs/repository terminal CTE | Independent calls pre-admit complete Run Proposal set; original output/Attempt/lock CTE; staged insertion uses current terminal state | Composed owners already holding domain locks refuse linked transitions before keys until migrated |
| runs/materializationService | External IO first, then short audit/Proposal/audience/provenance DB transaction; canonical audit recovery; staged creation records required publication Job | Other external artifact/Host/finalization owner semantics are not newly mapped |
| knowledgePromotion/candidateService insertion-only caller | Retains ordinary canonical pending insertion; no Run insertion gate | No Inquiry capability migration or permission change |
| proposals/applyService and canonical insertion | Shared admitted closure passed to Skill applier; unlinked root/linked sibling uses atomic audit; raw clients require existing BEGIN | Unprepared outer accept/reject with linked descendants refuses before keys |
| evolution/bundleRepository outer owner | Inventory verified; remains unmigrated and mapping-ineligible | Session gate/per-member snapshot and external code-patch effect owner need complete pre-admission and DB intent/required Job split |

First-review N1–N4: preserve nonretryable changed-set 409 (caller rereads and starts
an explicit new action); definition/monitoring preflight Project writer authority
before keys and retain locked authoritative checks; raw-client BEGIN contract is
documented and checked without nested commit; Source binding dependencies require
same-Space/same-Project full-readable activation for the actual channel, checked
at creation and canonical apply. Legitimate composite Source setup is retained.

Search covered all current literal proposals.status/payload_json UPDATE sites,
including applyService final payload/status and external rollback, monitoring,
definition, Memory/import revision, Plan reviews, both Run CTEs, Skill bulk
supersession and P1 mapped supersession. Evolution is an additional caller owner,
not a ninth direct SQL file. Insertion-only Run attachment callers were also
checked; Plan review now uses canonical insertion and Candidate insertion shares
the Run gate. No production mapping/public decision authority is enabled. None
of the new business families is qualified for mapping enablement yet.

Exact route inventory remains **635 = 594 legacy / 31 exempt / 10 core**, with
**579** P5 baseline core legacy routes remaining. Internal closure removes no URL.
Run composed owners and Evolution remain explicit remaining P5-4 work; no other
checkpoint or overall P5 completion is inferred.

Verification for this working subset (2026-11-06, Node 24.18.0):
- REQUIRE_TEST_POSTGRES=true, final selected server run: **16 files / 317 passed,
  zero skipped**. Thirteen shared real PG files / 292 tests: operationExecutorDb
  67, memoryMaintenanceRevisionDb 5, importedSessionsExtractionDb 18,
  planGraphExecutionDb 19, skillsApprovalDb 21, runProposalTransitionsDb 11,
  runMaterializationService 19, projectSourceDependencyDb 11,
  projectInformationMonitoringDb 62, projectConversationWritesDb 5,
  knowledgePromotionDb 12, jobsRunSettlementDb 5, runSupervisorDb 37.
  Guide/pure checks: agentGuides 8, boundaries 5, testHygiene 12 (25 tests).
- Web ProposalDetailPage: **1 file / 5 passed**, including retained-id and fresh-id
  revision from the parent editor. Protocol operations/systemActions:
  **2 files / 30 passed**. No visual acceptance is claimed for this navigation-only
  consumer correction; no layout, style or browser appearance changed.
- Workspace dependency build, server typecheck (--noEmit), server build including
  official plugin builds, web typecheck and git diff --check passed. No full suite.
- Initial sandbox container access failed; approved isolated shared PG access
  supplied the results above. Earlier fixture/consumer failures were corrected:
  duplicate seeds, actual Space-owner authority, required Proposal payload tags,
  scoped audit resets and the browser navigation mock. The temporary skip in
  converted materialization fixtures was removed; all 19 final cases ran on PG.
  Failed/partial attempts are not counted as passes. No durable fake fallback,
  production permission relaxation, online DB write, delegation, commit or deploy.
- Reviewable scope: 39 own files (18 server source, 9 server test/support,
  2 web source/test, 10 owner/contract/plan docs). Unrelated .agent/INDEX.md,
  automatic-worktree-concurrency plan and reports are excluded. No handover file.

### Second-subset review corrections (uncommitted, same basis)

N1 supersedes the previous creation-gate/global-batch description: ordinary
insertion does not hold the Run gate. That fence now belongs only to request
attachment. Unlinked terminal calls preserve the existing CTE without admitting
Proposal/package locks; their fence plus recheck prevents a late linked request
from being silently omitted. Each staged insertion atomically enqueues a required
run_proposal_publication Job; the existing Job worker closes late committed output
without losing the terminal result or retrying a business action. Recovery uses
one transaction per candidate, sorted keys per transaction and SKIP LOCKED Run
selection. Busy admission leaves only that Run eligible for the next existing
sweep, not a failed entire Space batch. Linked composed owners and Evolution
remain failclosed pending their true owner/effect closure; they are not qualified.

N2 inventory inspected every current insertProposalRow call (including Pool-backed
Session/Reader/Knowledge/Activity/Source/Evolution repositories, pure packet
functions, branded appliers, and explicit client owners in ContentAccess, Source
recipe/custom flows, imported extraction, definition/monitoring, Plan, Skills,
Memory and Evolution bundle). Direct Pool.connect sites were separately traced:
Proposal/authorization/bundle decision clients have BEGIN; OAuth/provider clients
are unrelated; Source annotation's session-lock client is not passed to packet
writers. Current production routes supply a Pool, explicit BEGIN client or branded
port; no confirmed raw-autocommit production insertion caller was found. The
strict guard remains; arbitrary raw clients still fail rather than pretending
single-statement advisory locks provide transaction safety. Representative real PG
coverage includes materialization, Memory, Source/monitoring, and workflow saving.

N3 retains the old request key/receipt/Proposal association; revision returns a
fresh id and never redirects replay or inherits approvals. N4 application uses
the canonical Proposal review view, while submission remains full/no-oversight;
shared/private/oversight reach is checked against the same existing view. N5
records that txid_current assigns/consumes XIDs; the core brand avoids that probe.

Review correction final verification: server selected 13 files / 268 passed,
zero skipped (real PG 11 files / 250; guide/skill 2 files / 18). Per-file PG:
RunProposalTransitions 15, RunMaterializationService 19, JobsRunSettlement 5,
OperationExecutor 67, ProjectSourceDependency 14, MemoryMaintenanceRevision 5,
SkillsApproval 21, RunWorkflowService 5, ProjectInformationMonitoring 62,
PlanGraphExecution 19, ImportedSessionsExtraction 18. Web ProposalDetailPage 5
passed; server deps/build/types, web types and diff check passed. No full suite.
Initial concurrency-test synchronization and mock accept-options expectations
were corrected before these results; failed intermediate runs are not passes.
The current own diff is 42 files: the prior 39, minus unnecessary Candidate Run
creation-gate change, plus P1 request attachment repository, publication Job,
worker registration and Agent work-skill guidance. Unrelated files stay excluded.
Recovery now also uses NOWAIT Proposal/request admission and SKIP LOCKED Run
selection so row contention does not stop the other candidate transactions.


### R1 targeted terminal concurrency correction

Only the Run attachment/admission lock modes change: attachment now takes the
exclusive try fence; unlinked terminal/recovery uses shared try admission, while
linked transitions retain exclusive admission after complete sorted key locking.
Two unlinked terminals therefore serialize on the existing Run row and preserve
first-result/later-null semantics. No caught-409 success, late key, advisory wait,
new retry engine or permission change is introduced. A link committed before
shared admission remains caught by the existing recheck. Linked outer owners
and Evolution remain failclosed and mapping-ineligible.

Eight added real PG cases: mark/mark, publish/publish and both mixed orders;
actual Job cancel owner/background terminal in both orders; terminal/attachment
in both orders. The first transaction remains open while the other reaches a
real database row-lock wait, then COMMIT releases it. Tests assert the later null
noop and exact retained status/output/timestamps, rather than accepting 409.
Existing late insertion/publication Job, required Job rollback and busy key/Run/
Proposal recovery cases remain unchanged and pass. Final scoped validation:
4 files / 114 passed, zero skipped (runProposalTransitionsDb 23,
operationExecutorDb 67, jobsRunSettlementDb 5, runMaterializationService 19).
Node24 workspace deps and server tsc --noEmit passed. No full suite or delegation.
Only five existing own files changed in this targeted repair: transition port,
Run Proposal tests, RUNS_AND_OUTPUTS, OPERATION_CORE_ACCEPTANCE and this matrix.
The full pending 42-file own scope and unrelated work remain preserved; no commit,
push/deploy, online DB write, new capability or handover file.


## P5-4 third subset — Pool-owned Run terminal roots (basis 6bcba36d)

Current status: implemented independent root-owner subset for review, not full
P5-4 closure. The coordinator committed the preceding 42 files and R1 evidence
as 6bcba36d. Earlier “working diff / awaiting review” entries above are historical
verification snapshots, not the current commit state. Route accounting remains
**635 = 594 legacy / 31 exempt / 10 core; 579 remaining**. Internal writer work
removes no URL. Production mappings and public proposal.decide authority remain
disabled; no business family gains enablement qualification in this batch.

Reuse / Dependency Check: reuse `withQueryableTransaction`, P1 complete sorted
key/fence admission, the existing expiring operation transaction brand,
`withPolicyAuditRecovery` and original Run CTE/Job workers. A purpose-bound
WeakMap associates the exact admitted Run set with that transaction object;
callers cannot supply a readiness flag. No new retry engine, dependencies,
external-effect executor, Memory writer or compatibility path is introduced.

| Actual root owner | Implemented boundary / evidence | Remaining outer qualification |
|---|---|---|
| jobs/repository cancelJob / reclaimStuckJobs | Exact eligible Run set before Job writes; full sorted keys once, existing worker/status selectors, exhaustion cleanup inside same owner; linked commit/rollback and reference-growth PG tests | Existing Job lease/retry rules retained; no new capability |
| projects/repository archive / archived update | Nonlocking writer preflight plus original locked check; discover Workflow root/node Runs before Project lock; graph/Job/Run/Proposal/request atomic rollback | Other Project/Research composed owners are not covered by archive evidence |
| plans/repository reconcilePlan | Existing coordinator and Task ACL discovery before Plan/version locks; graph and root publication together, forced publication failure rollback | Checkpoint Proposal owner must prepare the combined Proposal/Run closure before its own locks |
| automations/workflowExecutionService reconcile | Existing root before Project/execution locks; linked failed graph/request rollback; action savepoint recognizes the existing brand | Workflow checkpoint Proposal and Research-owned callbacks remain unprepared; arbitrary action policy/effect closure unchanged |
| autonomy/recoveryService stale child cancellation | Candidate child set before Run/candidate locks; linked rejection and rollback tests | Coordinator settlement and launch/tick transaction graph remain separate direct owners |
| hosts/taskMerges cancelUnstartedResolutionRun | Exact resolution reference admission before merge/Run locks, queued guard retained; cancellation commits before Host abort; failed request rolls back and original merge Job retries | General Host merge external-effect/receipt family not newly mapped |
| prompts/reading providerGeneration / providerTrial finalize | Already completed external provider IO followed by admission before authority/Run locks; real generation and both comparison ProviderTasks carry linked reviews | Legacy Room/Research or other composed provider callers require their own prepared owner |
| runs/repository child terminal writer | Consumes exact prepared scope; root finishes requests once. Unprepared raw/branded clients require BEGIN and retain linked refusal before keys | No late key admission or claimed readiness; not a family-complete mapping |

Search and remaining owners:
- Enumerated every markRunTerminal/publishRunTerminal caller: independent
  orchestration, agent handler, route, bounded provider and publication paths;
  Job cancellation/exhaustion; Plan/Workflow/Project/Host/autonomy; Reading
  generation/trial cancellation and provider finalizers; Daily Report fresh Run.
  Separate status UPDATE search also found `autonomy/finalizationReconciler`
  `settleAutonomyCoordinator` and `rooms/discussionService.cancelHeldClosing`.
  These direct terminal writers still need linked Proposal publication closure;
  no unlinked path there was replaced in this batch.
- `plans/proposalApplier.applyPlanCheckpoint`,
  `automations/workflowExecutionProposalApplier` and Research graph callbacks
  already run inside another owner. They need the canonical decision/Research
  root to discover all related Run and Proposal/cascade keys before any lock.
  The exact Research path is `projectResearch/orchestrator` ->
  `researchPassExecution.startResearchReconcilePass` -> `settleSynchronousNodes`
  (including the existing active-execution branch). A child helper cannot
  safely repair that order after Proposal/domain locks.
- Evolution bundle `decide`/`requestRollback` still takes a session gate then
  per-member transactions. Mixed members include code-patch apply/rollback with
  synchronous external effects. The existing result callback requires an applied
  result immediately; no durable effect-intent/worker-result receipt boundary
  exists for the whole mixed bundle. A DB-only alternate dispatcher would leave
  parallel ownership and partial commits, so none is introduced. Bundle/member
  all-or-nothing and session-lock ordering remain actual work, not “failclosed
  means complete”. No Evolution file is claimed migrated in this subset.
- Literal proposals.status/payload UPDATE inventory remains canonical
  apply/revision, Project definition/monitoring, Skill, Plan, Run CTE/publication
  Job and P1 supersession. Memory canonical applier/B10, provenance, Source
  consent/egress and human approval/risk gates remain unchanged.

Final related validation (Node24.18.0, REQUIRE_TEST_POSTGRES=true):
**15 files / 282 passed, zero skipped**. Shared real PG **12 files / 257**:
linkedRunJobOwnersDb 12, autonomyLaunchDb 18, planGraphExecutionDb 19,
projectArchiveLifecycleDb 5, taskMergesDb 40, runProposalTransitionsDb 23,
jobsRunSettlementDb 5, operationExecutorDb 67, runMaterializationService 19,
readingMethodGenerationDb.1 27, readingMethodGenerationDb.2 17,
readingMethodRevisionDb 5. Guides/pure **3 files / 25**: agentGuides 8,
boundaries 5, testHygiene 12. Explicit vitest file list is exactly those 15;
no full suite. Existing R1 eight concurrency cases, late publication intent,
busy per-Run recovery and P1 cascade/expiry/cleanup/result tests all remain.
New root tests cover sorted multi-Run keys before domain writes, changed Run
reference, expired port, autocommit-client refusal, linked Job/archive/graph/Host
rollback and required Job failure with one canonically recovered failed audit.
Reading tests use real ProviderTask/Delivery and existing external test fixtures,
not fake durable storage. Host failure sends no abort, then its original durable
Job retries and converges. Plan success publication failure and Workflow rejected
request failure roll back graph/root/draft/request before explicit retry.

Workspace dependency build, server tsc -p tsconfig.typecheck.json --noEmit,
server build with official plugin build and git diff --check passed. No public
DTO/web API/UI changed, so no web/protocol consumer or visual acceptance is
claimed. Initial fixture/savepoint and SQL-trace typing failures were corrected;
intermediate failed/name-filtered attempts are not included in final counts.
Approved isolated shared PG access was used; no online DB/deploy/commit/delegation.
Own review scope is source/test/docs listed in the reply. Unrelated INDEX,
automatic-worktree plan/reports and other parallel work are excluded; no handover.


## P5-4 direct terminal owners and review corrections (basis 0ac06ce2)

Implemented in this working subset:
- Autonomous coordinator terminal SQL is replaced by canonical Run publication.
  Tick final success/failure, finalization and timeout roots prepare coordinator
  (and timeout child) keys before domain locks, preserving original output and
  report/provenance/cursor transaction. Linked coordinator and child failure
  rollback is exercised by the production launch/timeout fixtures.
- Room held closing cancellation uses canonical publication. Open/stop/extend
  root owners prepare all closing Runs before session/discussion locks and keep
  original Room/Project and spend/round rules. Real parent capped discussion
  request failure rolls back discussion/Run/Proposal, then explicit retry succeeds.
- N1: reclaim and timeout scans use independent nonwaiting candidate admission;
  busy key/fence/row leaves only that candidate for next sweep. Orphan lock
  cleanup is independent. Atomic archive/graph operations retain whole-action
  conflict, not partial busy skipping. No retry engine is added.
- N2: static entry tracing covers existing/new withRunTerminalOwner calls:
  worker queue is fromConfig Pool, scheduler timeout uses getDbPool, Room holds
  Pool, tick/finalization uses Pool/prepared port; Proposal/Research composed
  clients remain unprepared/strict. No confirmed production autocommit owner
  was found. Existing raw-client refusal is retained and exercised on real PG.
- N3: stale Host merge resolution reference now returns a Run no-op. Admission
  is limited to the captured reference, so no replacement Run key is taken or
  replacement Run cancelled. Two real parent worker races cover removal/change.
- N4: Pool options.connectionString is mandatory for root audit recovery;
  missing configuration fails before business work. A real Pool wrapper fixture
  without options proves no Job/Run/request write. Existing failed audit recovery
  remains the canonical mechanism.

Reuse / Dependency Check: existing withRunTerminalOwner/Run CTE, nonwaiting P1
keys and PostgreSQL NOWAIT, existing per-sweep maintenance and durable worker
retry. No new executor, readiness flag, Memory writer or dependency. Per-Job
multi-Proposal requests sort before writes; independent candidates commit
separately. Earlier whole-scan/global ordering descriptions are superseded by
this section, not by weakening each transaction's complete-key invariant.

Still **not implemented**: combined canonical checkpoint Proposal/Research
outer admission and Evolution session/bundle/member + synchronous code-patch
intent/worker/result contract. CodePatchFileTransaction currently applies files
before recording snapshot/activity, returns an in-memory rollback callback;
bundle decide still commits per member. Neither is a durable mixed-bundle receipt.
This run does not claim an enablement boundary implemented without those changes,
nor invent a new product-authority choice to label unfinished work blocked.
Production mapping/public decision permissions remain disabled; qualification
none. P5-4 remains in_progress. URL635=594/31/10, remaining579, unchanged.

Related validation: Node24 shared real PG; explicit files linkedRunJobOwnersDb,
autonomyLaunchDb, taskMergesDb, jobsRunSettlementDb, runProposalTransitionsDb,
operationExecutorDb and roomsDb partitions1/2/3; guides agentGuides/boundaries/
testHygiene. Final results are recorded in the reply after execution. Initial
fixture failures (second link violating domain uniqueness and replacement Run
seeded terminal rather than queued) were corrected without relaxing constraints
or accepting409. No full suite, fake durable DB, UI/visual claim, online DB,
delegation, commit, deployment or handover file.

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

## P5-4 nested/Evolution complete decision owner extension (basis33466aee)

This extends the 14-file nested subset above; earlier “Evolution unimplemented”
statements are historical subset boundaries, superseded by the code in this
extension. No route is migrated by these internal writer changes (635=594/31/10,
remaining579). P5-4 remains in_progress for independent review; no production
approval mapping or new public proposal.decide authority is enabled.

Reuse / Dependency Check: canonical P1 sorted key/cascade admission and internal
transaction host bridge; PgProposalApplyService + B10 appliers; existing Job queue,
JobDeferredError, worker recovery sweep and dedicated nonwaiting session locks;
existing CodePatchFileTransaction/path anchor/snapshot writer and audit recovery.
No dependency, generic retry engine, alternate decision dispatcher or second
business writer was added. Drizzle authored the private decision ledger and the
normal generator produced migration0013 plus snapshot/journal.

Writer inventory delta: canonical checkpoint/history acceptance admits graph
roots/related Project Runs and all selected/cascade keys before domain rows;
known empty sets prepare fresh-creation scope; branded nested ports inherit its
actual lifetime, not a boolean. History extension's required extraction Job joins
the parent transaction and storage failure is no longer masked by writes on an
aborted transaction. Related immutable terminal history is excluded unless staged
output still needs publication; explicit checkpoint roots/cascades remain admitted.
Still-active related staged outputs retain pending requests. No lost frozen-key
history is redirected to a new revision.

Evolution decide/approve/reject now share one selected-member DB transaction;
requestRollback joins the same key-before-Bundle/asset order. Mixed code_patch
selections freeze decisions and effects into a private durable intent with a
required Job. Worker preparation and final commit recheck canonical authority,
frozen inputs, target and live Job claim. File preimages and receipts persist
outside domain transactions; canonical appliers commit all selected DB members,
linked requests, activity/snapshot/results and intent receipt together. Compensation
restores only known content; independent edits leave compensation_failed and block
new decisions. A stopped worker gets one cleanup handoff on existing recovery;
no false all-or-nothing claim across filesystem IO. HTTP202/pending receipt, typed
protocol/API, both Inbox parent tabs, and refresh consumption are implemented.
Standalone synchronous Proposal code-patch apply/explicit rollback remain existing
legacy surfaces, not new production mapping qualifications. The new worker does
not invoke that synchronous IO branch inside its commit transaction.

Recovery additionally preserves the existing bounded queue attempts after a
compensated failure. Explicit resubmission after Job exhaustion rechecks authority
and frozen members under full admission, replacing only the backing Job on the
same intent; concurrent/lost-response replay cannot enqueue a second live Job.
Succeeded receipts never rerun. This is not a new retry engine or new approval.

New evidence is recorded after the final focused runs below. No new Task/Proposal
or stage/commit/deployment is part of this implementation.


Final focused verification (2026-11-06, Node24, REQUIRE_TEST_POSTGRES=true):
12 server files /227 tests passed, zero skips: evolutionBundleDecisionDb17,
evolutionGroup14, codePatch12 (real filesystem), nestedProposalOwnersDb8,
researchProblemCallsDb19, planGraphExecutionDb20, linkedRunJobOwnersDb22,
runProposalTransitionsDb23, operationExecutorDb67, agentGuides8, boundaries5,
testHygiene12. Durable tests used the shared isolated real PostgreSQL template
including generated migration0013; no durable fake DB or online DB was used.
The mixed mapped tests cover both linked Memory and linked code-patch results,
receipt refusal rollback, failed audit recovery and existing Job retry/exhaustion.
Null-root/history fallback, historical receipt noninterference and active related
staged output behavior now have actual parent-domain PG fixtures.

Protocol evolutionBundle2 passed; web3 files /21 passed (evolutionInboxDecision2,
inbox8, evolution11). Local browser parent surface2 scenarios passed: English
1280px/dark and Chinese390px/light, both Bundles and Approval tabs; pending and
compensation-failure screenshots inspected. The browser uses offline API fixtures,
not live production; the separate real-PG HTTP test proves the actual 202/pending
and GET/succeeded contract. Filesystem crash recovery is tested by real persisted
preimages plus interrupted receipt storage, not by an actual process SIGKILL in
this batch. No claim of cross-filesystem/PG atomic visibility or remote Host IO.

Workspace dependencies, server build/official plugins and typecheck, protocol
and web types/build, generated schema check and diff check passed. Web emits the
existing large-chunk warning and existing inbox tests emit React act warnings;
neither is represented as a clean-warning visual or full-suite acceptance.
Own review scope44 files including the pre-existing14-file nested subset;
unrelated INDEX/worktree-plan/reports remain excluded. No delegation, stage,
commit, push, deployment, live migration or new Project object/proposal.

Coordinator verification after implementation (2026-11-06): inspected the new
Bundle intent/worker/conditional compensation, canonical member transaction,
live claim checks, receipt projection, generated migration and nested owner
paths against the existing execution boundary. Independently reran four focused
server files: evolutionBundleDecisionDb17, nestedProposalOwnersDb8,
codePatch12 and agentGuides8; all45 passed with zero skips. Durable tests used
the shared isolated PostgreSQL environment; codePatch used real temporary files.
The implementer's broader227-test and browser results above are separate runs,
not independent review reruns. No new blocking issue was established in this
verification. Production mappings remain disabled; this evidence does not
qualify the standalone legacy code-patch IO surface or complete all P5 work.

## P5-3 standalone Space Board closure (basis8600172e)

The remaining standalone placement capability now has a strict user-only
task.place_in_space_board registration, generic/formal POST adapters and typed
browser consumption. Its changes preserve one atomic contract+placement save.
Current full Task authority and a same-Space active standalone destination are
rechecked under locks, with Board pinned before Task. New Project or lifecycle
authority cannot be smuggled into changes; the domain writer retains completion,
revision-independent Space column semantics and required Job effects. Changing
Board without a column clears the previous Board's column and preserves status.
PATCH placement is refused for every Task under its lock, including null clears
and mixed edits; ordinary metadata PATCH is still legacy, not a fallback for
placement. Existing Project exact movement remains revision-bearing and unchanged.

Reuse / Dependency Check: searched the existing Board/lifecycle registrations,
Task writer, structured field schema, core runtime, typed client and PG/browser
fixtures. Reused them plus the existing task.column.move policy and installed
Zod. This is a purpose-bound domain adapter, not a commodity mechanism needing
a new package; no dependency or second writer is introduced.

Final validation: server6 files /91 passed with zero skips, including new
taskSpacePlacementDb8, boardAgentActionsDb21, taskLifecycleOperationsDb41
(actual Chromium Task Detail -> Fastify -> isolated shared PG save),
operationRoutes1, agentGuides8 and testHygiene12. Protocol operations8 and
web API/Task Detail16 pass. Types/builds and diff check pass. Earlier failures
were fixed: Pool binding is composition-scoped rather than looked up inside
core work; the previous legacy test uses the new entry; a completion assertion
uses the stored initial state. A browser run overlapping a web rebuild failed;
the stable-build parent run and final full relevant selection passed without
changing timeout/performance limits. No full-suite or new visual claim.

Review: coordinator inspected authorization/lock/replay, atomic writer and
consumer closure. Independent Room review is skipped due to the already fixed
collaboration budget being exhausted; it is not represented as approval.
No budget reset, new Agent permission, production mapping, push/deploy or online
DB operation. Preserve unrelated INDEX/worktree-plan/reports and parallel usage
work. P5-3's configured capability scope is complete; task.create, general Board
CRUD and ordinary metadata remain their explicit P5-7/8 scopes.
Exact inventory636=594legacy+31exempt+11core; remaining baseline579 is unchanged
because this adds one named URL and retires a branch of the still-legacy PATCH.


## P5-2 Source history planning/control (basis d44e3cb1)

Migrated source.backfill.preview/create_plan/pause/resume as one complete
ordinary family. Strict shared schemas preserve actual strategy/quota bounds
and return bounded core receipts. All four retained URLs call the same core
registrations as generic query/action entry; former route-local policy/writer
paths are removed. Preview is metadata-only and readonly. Commands retain
current Source manage authority and pin/recheck active Project writer scope,
binding/operation references, channel/connection and plan in domain lock order.
Original-key replay revalidates current authority. Create's domain uniqueness
key survives independently of the explicit transport header; a reused domain
key cannot change Project scope. Required audit, plan, segments, ProjectOperation
link and transport receipt share the existing core transaction.

Browser preview/create now consume typed core query/command output, with a
current-authority detail reread after creation. No hidden retry, Agent surface,
new approval mapping, external execution or provider egress is introduced.
propose_start's existing Agent preauthorized grant and canonical start behavior
remain separate pending work rather than being silently replaced by review.

Reuse / Dependency Check: searched the planning service, strategy normalizer,
Source connection access, Project fences, OperationExecutor, route adapters,
protocol Zod schemas, typed client and shared PG/lock fixtures. Reused them all;
no commodity mechanism or dependency is added. Owned deterministic errors are
classified explicitly; unknown backend messages are not reflected.

Validation: server7 files/73 passed, zero skips, including new real PG13 and
existing execution real PG17, strategy3/service19, routes1/guides8/hygiene12.
Protocol operations9, web API10 and server/web typechecks passed. No UI visual
claim or full-suite run. Self-review covered live scope/locks/atomicity/replay
and all known callers. Independent Room reviewers are skipped because the fixed
budget is already exhausted; no reset/delegation or claimed approval.
Exact inventory636=590legacy+31exempt+15core;575 baseline core legacy remain.
Four old URLs migrated, none added. P5-2 and overall P5 remain in progress.
Unrelated usage/INDEX/runtime-adapters/worktree-plan/reports are preserved.


## Note-link policy decision isolated from continuing implementation

Source review found a real policy/implementation conflict for P5-5:
`POLICY_ACTION_REGISTRY.note.link.create` is explicitly reserved/default-deny
and says not implemented; the live Knowledge POST/DELETE note-link routes and
NoteEditor already create/remove navigational links under canonical object
write/read authority without consulting that action. Core migration cannot
silently change deny to allow or disable existing human functionality.

Concrete recommended decision: wire existing human-only create/remove linking
as allowed ordinary commands, with mandatory core policy audit/receipt, current
writable Note plus writable source for incoming links, readable typed target,
Project authority and same-Space constraints. Preserve navigational-only edges,
no canonical graph authority, Agent grant or approval bypass. Alternative:
retain the deny and remove/disable both current mutations and UI affordances.
This permission choice applies only to Note link operations. Note-to-Question,
Source ordinary work and other P5 implementation continue independently.


## Human Inquiry creation and Note-to-Question (basis 3c906199)

The Note policy choice above is isolated: implementation continued independently
with human-only inquiry.thread.create and note.raise_as_question, whose existing
inquiry.thread.create policy permits manual structure creation. Both retained
POST routes are core adapters. Strict protocol contracts preserve question/
hypothesis state, parent and producer uniqueness; explicit transport keys are
separate. Core current Project writer/active fence and Note/Thread read gates
cover new work and replay. The existing Thread/revision/outbox/Project work-event
writer and optional Note reference run in the core transaction alongside audit
and receipt, with no copy of the domain writer. Note content is unchanged.
The browser's typed helpers use commands then authorized detail reads. Project
workspace kind state is narrowed to the actual protocol enum. Existing Agent
inquiry.create_thread remains independent and unmigrated; no new Agent grant,
Wiki approval, navigational Note-link permission or production mapping.

Reuse / Dependency Check: inspected Inquiry Thread service/access/revision,
Note reference, domain outbox, Project work-event writer, protocol definitions,
NoteEditor/Project workspace consumers and PG fixtures. Reused them with core
transaction/admission and installed Zod; no generic mechanism, dependency or
additional execution writer. Owner-typed producer conflicts are explicitly
classified; missing Note reach remains hidden, including execution withdrawal.

Validation: server two related selections cover7files/66passed, zero skips:
16 new real PG plus existing Note-raise5/Thread18, object actions6 and
routes1/guides8/hygiene12. Protocol operations/policy/systemActions46 and web
API12/NoteEditor10/Project workspace15 pass. Server/web types and protocol build
pass. Broader protocol consumer checking revealed stale frozen registry
metadata/count from earlier P5 migrations; fixture now matches the existing121
policies and current enforcement points, without a policy permission change.
No full suite or visual change claim. Independent reviewers remain skipped for
the fixed exhausted budget; own review is not called independent approval.
Exact inventory636=588legacy+31exempt+17core;573 baseline core legacy remain.
Two existing URLs migrated, none added. P5-6 continues; P5-5's specific Note-link
choice remains waiting for review while other implementation proceeds.


## P5-2 Project Source consumption (basis991fc8b5)

Completed the four ordinary user commands project.source.bind/update/unbind/
backfill. Their existing formal routes and both typed Sources/Projects browser
facades share strict core contracts, current active Project writer and original
Source metadata/delivery authority. Immutable input replay rechecks requested
Source sharing; result replay rechecks current binding ownership. Restricted
Source delivery to Project members still requires its Source owner; ordinary
Project consumption pause does not gain a new Source-manager requirement.
Binding uniqueness/archive/restore remain domain semantics. Pending approval
bind/setup/backfill and acquisition execution are separate and unchanged.

Canonical binding/routing, item/evidence links, Corpus, notifications, optional
Standing notes/batch and required dispatch Job use the core transaction with
audit and receipt. No provider IO or second routing writer. Owned deterministic
validation/conflicts and the named unique constraint are explicitly classified;
private SQL/error strings are not returned. The actual backfill DTO's channel
id replaces an inaccurate connection-id frontend declaration.

Reuse / Dependency Check: inspected canonical binding service/repository,
Project fences, Source metadata/delivery policy, routing/Corpus, Standing area/
Job writers, client facades, protocol schemas and real PG fixtures. Reused all
with P1's port, policy admission and Zod. No dependency, retry or execution
framework was added. Alias browser helpers delegate to one typed operation path.

Validation: focused server selections cover7files/70passed, zero skips,
including new PG16 plus evidence-routingPG20/StandingPG11, service boundaries2
and routes1/guides8/hygiene12. Protocol47 and web API13/ProjectSources18 pass;
server/web types and server/workspace-dependency build pass. Standing required
Job failure and receipt refusal withdraw initialized Notes/batch/links/Corpus
and binding together; key replay creates one backing Job. Existing pg/Router
warnings remain visible. No full-suite or visual change claim. Self-review
completed; independent Room review skipped for exhausted fixed budget, no
reset or substituted delegation. Inventory636=584legacy+31exempt+21core;
569 baseline legacy remain. P5 overall remains in progress and mappings off.


## P5-8 exact retired Source connection review (basis82a3199e)

Read all ten Source connection fixed410 handlers. Their exact method/path/detail
list now registers the same transport responses from one purpose-specific
manifest. Eight mutating-method rows are individually classified as retired
transport refusals: create, draft, proposal, recommendation, subscription,
update, delete and scan. Two GET refusals are outside the method inventory.
All10 were invoked with no DB configuration or identity and returned only the
original410 detail; nearby live Channel subscription and connection recipe
read paths remain outside the exemption. No domain writer, policy/effect,
authority, alias fallback or new service/dependency was introduced. Reuse is
the existing Fastify route registration and owning-module refusal behavior.

Tests sourceRetiredRoutes11/operationRoutes1 and server types pass. No durable
mutation exists in these handlers, so no fake durable DB or unnecessary PG
fixture is used. No full-suite claim or repeat independent review. Inventory
636=576legacy+39exempt+21core;561 baseline core legacy remain. This removes eight
already-retired refusals from the write queue, not eight new domain migrations.
Other auth/internal/upload exemptions remain subject to their own owner review;
P5-8 and overall P5 remain unfinished. No mapping, deployment or push.


## Personal Source subscriptions and recommendation decisions (basisd801177b)

Completed source.channel.set_subscription and source.recommendation.decide as
strict user-only core commands. Retained URLs and typed Sources browser calls
share existing canonical state/window writers, explicit request keys and a
new wired/audited source.subscription.manage policy for this pre-existing
human own-row capability. It does not permit Source configuration, content
access/consent changes, Agent calls or topic activation. Current own-row and
Channel authority protect every call/replay. A pending recommendation remains
required for new decisions, while resolved original-key receipts replay safely.
An existing subscriber can opt out without Source-manager/content permissions.

Canonical setSubscription now runs automatic-interest-fact cleanup inside the
same transaction as subscription/window changes, for Pool and core-port callers.
Only deterministic observations/candidate counts are cleared; accepted topics
and dismissal decisions survive. History windows and current Source consent
keep their original Reader eligibility. No external IO, alternate writer or
automatic retry is added.

Reuse / Dependency Check: inspected SourceChannelService, subscription windows,
InterestProfileService/repository, the digest owner guide, reading eligibility,
core registrations, protocol/client and PG fixtures. Reused the exact domain
writers, transaction helper, policy/audit core and Zod. No new dependency,
scheduler or approval mechanism. Actual production callers were the two replaced
REST handlers; browser callers now use one typed core path.

Validation: focused server selections cover5 files/61 tests, zero skips:
new PG14, reading eligibility PG15, route contract12, guides8 and hygiene12.
Protocol48, web API14/SourceChannels9 and both server/web types pass. Small
retired transport cases were moved to operationRoutes rather than extending
hygiene exceptions; all11 checks remain. No full-suite/visual claim; existing
Router/act warnings remain visible. Independent review remains skipped for the
exhausted fixed budget, no reset/delegation. Inventory636=574legacy+39exempt+
23core;559 baseline core legacy remain. P5 remains in progress, mappings off.


## Source Recipe draft and canonical creation placement (basise9244c3c)

Migrated one retained POST to the strict user-only `source.recipe.create` core
command. The browser uses that same command. Source Recipe create reuses its
canonical Channel/version/scheduler writer and joins Queryable transactions;
plan/dry-run/activation/bridge stay separate, with no IO added to a core tx.
Named Source-name conflicts and schedule validation keep safe domain failures.

P5-7 remains in progress. Its first new-content registration resolves canonical
Personal/Project placement before key admission, with no client target Space,
Agent/grant/approval authority, or relocation of existing content. The fixed
registration guard limits this access-owned mechanism to manual human drafts;
current source and destination memberships plus Project/result authority are
rechecked. Receipt/policy/domain all use the destination Space, audit metadata
retains request Space, and placement drift conflicts rather than rebinding late.

Reuse / Dependency Check: inspected creationContext, access/Project mutation
fences, SourceRecipeCreateService, SourceChannelService, recipe-version store,
schedule parser, Custom Source creator/credential settings, P1 executor/ports,
shared schemas/browser API and existing real-PG fixtures. Reused canonical
access resolution and DB writers, existing transaction/key/audit mechanisms and
Zod. This is product authority semantics, not a commodity engine; no new
dependency, queue, retry framework or cross-Space writer. A narrowly constrained
server registration option replaces route-only placement so generic and formal
transports cannot diverge.

P1 catalog regression assertions were stale from prior P5 registrations; they
now use a fixed explicit current enabled-user allowlist, while retaining the
negative legacy-approval generic-admission check. No registry-derived self-proof.

Inventory636=573legacy+39exempt+24core;558 baseline core legacy remain. Internal
writer closure is not counted as URL migration. Production approval mappings
remain disabled. P5-7 and overall P5 are not complete; independent model review
is skipped under the exhausted fixed budget, not marked passed.

Validation: six affected server files/131 tests pass, zero skips; real PG99
(new creation18, P1 executor67, existing Recipe14), route inventory12, guides8
and hygiene12. Protocol37 and browser API15 pass; Node24 dependencies/server
build with plugins, server source+test types, web types and diff check pass.
No full-suite or visual acceptance claim. Existing pg concurrent-query warning
and deliberate P1 projection-failure log remain visible.


## Source Monitor controls (basisb5351250)

Migrated two existing writes: SourceChannelService.update and scan, under
strict human-only source.channel.update/scan registrations and the existing
source.connection.manage policy. Browser APIs and formal transports use the
same typed keyed command; creator authority remains narrower than generic
Space admin/read permission. Configuration, optional parent label, scheduler,
audit and receipt join the canonical transaction. Search query versions and
Goal scheduling ownership remain protected. Manual scan only writes the
existing extraction Job;202 means enqueue succeeded, while the unchanged
worker owns IO/completion. Original receipt replay never enqueues again.

Canonical Channel DTOs convert pg timestamps to ISO strings before protocol
validation, matching their prior JSON wire form. Typed Channel schedule/input
and Goal scheduling errors retain safe status classification. Recipe drafts
now reuse the same Channel schedule validation directly, removing the redundant
pre-validation introduced in the preceding batch. Named Source-name uniqueness
failures roll back the full savepoint before recording a sanitized conflict.

Reuse / Dependency Check: inspected Channel update/scan/creator projection,
Goal compatibility ownership and DB guards, scheduler, extraction worker/Job
DTO, protocol, P1 keyed admission and typed browser calls. Reused all canonical
writers, existing transaction/audit/worker mechanisms, Zod and shared PG/domain
fixtures. No new dependency, schedule engine, retry or approval mechanism.

Inventory636=571legacy+39exempt+26core;556 baseline core legacy remain. P5-2
and overall P5 remain unfinished. Production approval mappings/public decision
expansion remain disabled. The fixed collaboration budget remains exhausted;
self-inspection/tests replace no claimed independent approval.

Validation: eight explicitly affected server files/201 tests pass, zero skips;
real PG169 (Monitor18, Goal compatibility52, Recipe creation18/Recipe14, P1 67),
route inventory12, guides8 and hygiene12. Protocol38 and web53 across API,
Sources list/detail and Project Sources parents pass. Node24 workspace deps,
server build/plugins, server source+test types, web types and diff check pass.
No full-suite/visual claim. Existing pg/Router/act warnings and deliberate P1
projection-failure log remain visible; no new warning suppression.


## Human Note history/trash controls (basisfea06988, uncommitted)

Implemented knowledge.note.rollback/delete with strict user-only contracts,
current canonical Note/Project write authority and explicit transport keys.
The existing formal endpoints join the same canonical NoteWriter/core tx.
Only the already-available manual restore/soft-delete capability is evaluated
by new wired/audited note.edit; plain Note linking stays reserved/default-denied
and its human choice is still pending. No Agent, Wiki/Memory promotion, purge,
Note create/update/placement or new selection-toolbar action is enabled here.

Project authority is pinned before the Note root, then authority/scope rechecked
after waiting. Revision/outbox/root/extension/read-audit/policy/receipt writes
are atomic. The derived retrieval projection retains its existing private
savepoint recovery. Immutable receipts contain only id/Space/version: the typed
client then reads the current Note via the existing authorized GET/B11 in that
Space. Historical key replay does not reapply after newer content or restore.
Explicit revision conflicts are typed/cached409, not arbitrary reflected errors.

Reuse / Dependency Check: inspected canonical Note access/writer/revisions,
placement lock discipline, Project authority gates, read-audit and retrieval
savepoints, existing Notes client/editor and real PG fixtures. Reused all domain
writes and version/outbox/index mechanisms, P1 admission/audit and Zod. No new
writer, dependency, queue or retry engine. Namespace knowledge.note separates
ordinary controls from the existing note.* selection actions without changing
those menus or their exhaustive type contract.

Working inventory636=569legacy+39exempt+28core,554 baseline core legacy remain;
HEAD before this draft remains556. This is preparatory P5-5 Note work, not P5-8 execution or completion. Independent dual review is outstanding because the fixed shared budget
is exhausted; self-inspection/test evidence is not a substitute approval.
Other partial checkpoints have been returned to ready, retaining their commit
reports. P5-5 still waits only on the explicit Note-link policy decision.

Verification for this uncommitted draft: affected selections cover8 server
files/141 tests, zero skips (real PG103: Note controls19, canonical writer8,
Project binding9, P1 67; object actions6, route inventory12, guides8, hygiene12).
The new canonical Project-move race exposed an admission conflict mapped to500;
it is now explicitly409 before domain execution, and all19 PG cases pass.
Protocol51 and web63 pass, including the Notes parent/editor and API body reload
in the receipt Space. Node24 deps/server/plugins build, source+test/web types
and diff check pass. No full-suite/visual or independent dual-review claim.
Existing act warnings and intentional projection-failure logs remain visible.
The draft remains uncommitted and unqualified for completion/review acceptance.


## Delivery-order correction after user review

P5-8 is the final inventory/exception/stateful-GET/retirement/evidence closure,
not a bucket for advancing independent easy writes before earlier checkpoints
close. The Note history/trash working diff above belongs to P5-5 preparation;
it remains uncommitted and independently unreviewed. Earlier attribution to
active P5-8 was incorrect. The interrupted correction had not changed the Board;
the current turn actually returned P5-8 to ready and restored P5-2 as the sole
active checkpoint (the overall P5 umbrella stays active). P5-1/3 remain done.

Resume by identifying and closing the actual P5-2 remainder and review/evidence
debt before advancing later stages. Preserve all earlier committed subfamilies
and the Note draft, without counting them twice or declaring incomplete
checkpoints done. Fixed collaboration-budget exhaustion must be reported;
self-inspection/tests are not independent dual-review acceptance.

## P5-2 Source review batch (HEAD fea06988; no independent approval yet)

Only checkpoint2 is active. Checkpoints1/3 remain done; Note24-file draft and
its two inventory rows belong to checkpoint5 preparation and are excluded.
The following committed, coordinator-authored Source changes need independent
Claude/Antigravity review; this implementation self-check is not that review:

| Commit | Exact capability / primary review roots | Related evidence |
|---|---|---|
| 0b0ab8f9 | source.backfill preview/create_plan/pause/resume; sources/sourceBackfillOperations,OperationRoutes,Service,Strategy,Errors; protocol/sourceBackfillOperations | sourceBackfillOperationsDb13 |
| 82a3199e | project.source bind/update/unbind/backfill; projects/projectSourceOperations,OperationRoutes,BindingRepository,BindingService,MutationError | projectSourceOperationsDb16 |
| e9244c3c | source.channel.set_subscription/recommendation.decide; sources/sourceSubscriptionOperations,OperationRoutes,channels/sourceChannelService subscription windows/fact cleanup | sourceSubscriptionOperationsDb14; retired Source transport inventory integration |
| b5351250 | source.recipe.create; sources/sourceRecipeCreateOperation,sourceRecipeRoutes,sourceRecipes/recipeCreateService; core executor/types/userContentCreation placement, canonical human actor | sourceRecipeCreationOperationsDb18; no activation/dry-run/generation qualification |
| fea06988 | source.channel.update/scan; sources/sourceMonitorOperations,OperationRoutes,channels/sourceChannelService,goals/compatibility | sourceMonitorOperationsDb18; enqueue202 is not external completion |

For each row, include its named protocol schemas/operations/systemActions/policy
changes, runtime registration, retained REST adapters, typed client and response
DTO changes, conversation-scope API tests, and its owning/permanent docs/inventory
hunks. Review the exact commit diff for that row, not an aggregate git range
that includes unrelated intervening Task/Inquiry/Note work. d801177b is a retired
transport inventory dependency, not another newly migrated business family.
Already dual-reviewed grant/Project operation/Board/Task families are regression
consumers only and are not resubmitted as this batch's independent-review scope.

This batch adds the missing public Monitor creation closure:
`source.channel.create`, POST /sources/channels, generic action and typed browser
createChannel all use SourceChannelService.create under the same core transaction.
The existing public creation placement is retained: context-free human content
is private Personal content; explicit Project creation uses its live writer gate.
Existing human Monitor creation is active/paused with a durable scheduler, not a
recipe draft. The creation port therefore admits exactly this named durable
command alongside its existing draft restriction; no other durable command,
Agent, grantable command or approval mapping gets that placement mechanism.
This is preservation of the old authenticated REST behavior, not new authority.
No network or worker execution occurs inside the command transaction. Internal
Research/native-draft callers keep the same domain writer and their own authority.
Strict public fields preserve query/provider/connection/credential/config/consent/
policy/schedule semantics; internal force/initial-status/Agent fields are refused.
The output DTO is strict and keeps existing channel metadata. Domain fingerprint
reuse remains independent of explicit transport keys. New creation output guards
reload current creator/Source visibility before returning a retained receipt.

Reuse / Dependency Check: existing OperationExecutor, human placement resolver,
creationContext, SourceChannelService, provider compiler, governance normalizer,
scheduler transaction writer, protocol Zod and real PG fixtures. No new dispatcher,
policy gate, retry engine, parser, dependency or production approval mapping.

Finite inventory: committed HEAD636=571legacy/39exempt/26core =>556 P5 core legacy
remaining. This Source family moves one URL: Source-only projection becomes
636=570/39/27 =>555 remaining. The working tree also contains the unrelated Note
rollback/delete draft, so its actual inventory is636=568/39/29 =>553 remaining.
Do not attribute those two Note rows to Source or claim checkpoint2 complete.

Remaining checkpoint2 screening is confined to ordinary Source DB-only service
closures: post-processing rule configuration/dispatch and existing extraction Job
controls still need their complete caller/policy/Job inspection and implementation.
This is not the checkpoint8 global556-path queue. Backfill propose/start, Source
activation/consent, recipe plan/dry-run, generated/custom external effects, goals/
material writes, and Note are not silently imported into checkpoint2; their
approval/effect/product gates remain with their original later checkpoint.
Independent review and the remaining ready-family acceptance are still pending.

P5-2 Source continuation validation (Node24, 2026-11-06):
- REQUIRE_TEST_POSTGRES=true focused server9 files/177 pass, zero skips:
  sourceBackfillOperationsDb13, projectSourceOperationsDb16,
  sourceSubscriptionOperationsDb14, sourceRecipeCreationOperationsDb18,
  sourceMonitorOperationsDb18, sourceChannelCreationOperationsDb11,
  operationRoutes12, operationExecutorDb67, agentGuides8. All durable Source
  evidence uses shared isolated real PG. Inventory refresh followed the existing
  UPDATE_OPERATION_ROUTE_INVENTORY convention and preserves the two Note rows.
- Protocol operations17 pass. Web conversation-scope-api18,
  ProjectSourcesPage18, SourceChannelsPage9 =>3 files/45 pass.
  Workspace deps, server build (including official plugins), server/web/protocol
  types and diff check pass. No full suite or visual acceptance claimed; changed
  browser behavior is the typed API transport, not presentation.
- First runs exposed the creation-port draft guard, the stale catalog expected
  set and test fixture/type assumptions; corrected with the exact named durable
  exception and retained all other guard assertions. Those failed runs are not
  counted as passes. Existing Project Source tests emit a pg concurrent-query
  deprecation and existing web tests emit React warnings; these are not new
  whole-suite/clean-warning claims.
- No schema/migration, production mapping, Agent permission, commit, push,
  deployment, online DB, delegation or new checkpoint. The five old Source
  commits and the new Monitor creation family still await independent review.
- Own new changes21 files (Source hunks only in shared Note-draft files):
  architecture OPERATION_CORE_ACCEPTANCE/OPERATION_EXECUTION_CONTRACT/
  SECURITY_AND_ACCESS_BOUNDARIES/SYSTEM_ACTIONS; modules/sources; this plan;
  web api/client and conversation-scope-api test; protocol index/operations/
  systemActions/sourceChannelCreateOperation and operations.test;
  server sources/routes/sourceChannelCreateOperation; core executor/runtime/
  types/routeInventory; tests operationExecutorDb/sourceChannelCreationOperationsDb.
  Note policy/fixture/knowledge files, INDEX, worktree plan and reports excluded.

## P5-2 Source bounded review repair (basis fea06988, no new family)

Read Claude's complete report and the available Antigravity report (its final
message is truncated). Findings were checked against the actual code, not treated
as automatic authority. Neither report supplies independently run PG evidence.
Only this Source repair is implemented; post-processing and later checkpoints
are not started, Note/Board/INDEX/worktree-plan/reports remain excluded.

- P2 error classification: remove blanket HttpError422 matching. The actual
  provider-query and consent/governance validation throw sites have explicit
  ResearchQueryInputError/SourceGovernanceInputError types, with existing named
  channel/schedule errors. No catch-all helper wrapper converts arbitrary422 to
  a business type. The exact ensureConnection no-insert/no-row conflict is typed409.
  Injected unknown Http422/409 after real domain writes yields500, rolls everything
  back, retains no terminal request and recovers exactly one failed audit; known
  input/conflict failures cache and replay canonically.
- P2 parent context: discover an existing parent only in the authenticated request
  Space before keys; child creation keeps that actor/Space, requires live Source
  manage/read + actual Project writer and rejects explicit Project mismatch.
  Root creation still uses the established Personal/private or Project/shared
  owner rule. No global id-to-Space lookup or generic actor rewrite callback.
  After keys the authoritative order is Project -> Source -> Monitor; recheck
  Project/owner/visibility and reject scope growth without late keys. Parent id,
  not observed mutable Project state, binds child creation authority/fingerprint.
  Creation reads actual parent DTO metadata; a stale create receipt is not copied
  or redirected after the parent's Project changes.
- P2 current parent: Monitor controls retain creator as a mandatory gate, adding
  canonical parent Source management/current Project writer rather than granting
  controls to admins. get/getRaw exclude deleted parents and use canonical Source
  read. update/scan resolve parent scope before keys, recheck under locks and
  refuse deletion/member downgrade races without partial edits or Jobs. Personal
  subscription opt-out has no new Source/Project writer gate.
- N4 policy: old REST used source_channel/null resource id. Preserve that exact
  request scope through the single core enforce, using nullable resourceId in its
  existing resolved-operation port. The actual engine is builtin rules followed
  by canonical registry defaults; there is no configurable DB scope-rule matcher
  to seed. A test registry DENY goes through the real engine/PG audit pipeline and
  blocks both transports, with no business write and one failed audit per call.
- N2 key scope: the cited guide sentence is the Project-operation helper rule.
  Source helpers already accept keys and preserve a caller-supplied key on an
  explicit second call, now tested. No production createChannel UI caller or
  automatic mutation retry was found; no new retry engine or forced API/UI
  signature break is introduced. Typed callers need not repeat a parent's Project.
- N3/N5 domain admission: reuse transaction advisory admission keyed to owner/Space
  before Source creation row locks, shared with Recipe's channel writer. Public
  roots wait before Project/parent rows; composed writers reenter or try only,
  never block on that gate after domain locks. This serializes the existing
  fingerprint lookup/insert across distinct keys and overlapping implicit/explicit
  parent scope without changing domain identity into transport identity. Different
  explicit parents, Recipe's forced new Source and Research selected-attempt ids
  retain their distinct identities/provenance. No inappropriate unique index.
  Real PG barriers force two distinct-key entries and Recipe/Monitor to wait on
  the actual gate together, then require both201 and correct final cardinality;
  tests do not accept409/500 as progress.
- Parent controls lock the Source for update before any child row: two different
  Monitor keys may both rename their shared parent, so shared-parent lock upgrades
  after child locks would be unsafe. A real two-waiter PG test requires both
  REST/generic saves to succeed, preserving both labels and two policy decisions.

Reuse / Dependency Check: canonical Source access and Project writer predicates,
existing creation port and query-only transaction scope, PostgreSQL transaction
advisory gates, canonical compiler/governance/scheduler/domain writers and PG
fixtures. One Source-purpose parent/admission module, no general engine or new
dependency, schema/migration, policy gate or production approval mapping.

Repair increment (Source hunks only; before this repair the Source subset was21
files): sourceChannelCreateOperation, new sourceMonitorParent, channels/
sourceChannelService, sourceConsent, research/queryPlanning/providerCompiler,
sourceMonitorOperations, sourceRecipeCreateOperation, sourceRecipes/
recipeCreateService, core userContentCreation/executor/types; creation+Monitor
PG tests; the Source key-reuse API test; permanent Source/contract/security/
SystemActions/acceptance guides and this plan. No Note/Board hunk belongs here.
This repair changes no route inventory row: formal556, Source-only555,
Note-inclusive working553 remaining. P5-2 stays in_progress, pending coordinator
verification/targeted review and exact submission before another capability family.

Repair verification (this run, not reviewer-run evidence):
- Shared real PG/server: sourceChannelCreationOperationsDb27,
  sourceMonitorOperationsDb22, sourceRecipeCreationOperationsDb18,
  sourceSubscriptionOperationsDb14, projectSourceOperationsDb16,
  sourceBackfillOperationsDb13, operationExecutorDb67, sourceConsent11,
  researchGroup31, operationRoutes12, agentGuides8 =>11 files/239 passed.
- After the final parent-lock correction, rerun the three affected Source files:
  creation27 + Monitor23 + Recipe18 =>3 files/68 passed. The new concurrency
  fixture initially collided with the existing active fingerprint constraint;
  corrected its distinct Monitor identity, without weakening that constraint or
  accepting a failed request. The failed fixture run is not pass evidence.
- Protocol operations17; browser conversation-scope-api18,
  SourceChannelsPage9, SourceChannelDetailPage10 =>3 files/37 passed.
  Caller-supplied Source keys are reused across two actual API helper calls.
- Node24 workspace dependency build, server typecheck/build including official
  plugins, protocol/web types and diff check pass. Server types/build rerun after
  the final parent-lock change. No full suite or visual acceptance is claimed.
  Existing pg concurrent-query deprecation and React test warnings remain.
- No new URL migration/count change, later Source post-processing family, schema,
  production mapping or Agent permission. P5-2 and the overall Task stay open.
  The concurrent Board commit52d877c2 is preserved and excluded from this repair.

## P5-2 Source N1 lock-order correction (basis52d877c2)

This is a bounded follow-up to the already reviewed Source creation repair,
not another family review or post-processing migration. Check actual access.ts:
Project mutation uses FOR UPDATE, not FOR NO KEY UPDATE. Cross-Project reference
A -> Source B and personal Sources cannot rely on a shared Project row to
serialize with Monitor controls.

- Replace pair JOIN rowmarks in Project bind/update, backfill and recommendation
  with explicit Source share lock, then child share lock constrained to the
  discovered parent. Re-evaluate existing live/status/visibility/authority
  predicates under those locks. No late parent, new gate, retry or privilege.
- Check canonical services as well as registrations: the activation applier's
  pair UPDATE rowmarks use the same bounded helper with update mode. Custom
  Source handler activation/repair/rollback had an actual child UPDATE followed
  by parent UPDATE; move its existing parent lock before the channel query.
  Its version CAS, scheduling and approval rules stay unchanged.
- Channel-only subscription, Goal scheduling/transfer and binding repositories
  were inspected; their channel locks do not subsequently lock/update the
  Source parent. Recommendation's service updates subscription/window rows,
  not the parent. Do not add parent read/ownership to personal opt-out.
- Real PG barriers cover bind vs update/scan with Source in B or Personal and
  target Project A, plus backfill referencing A and recommendation vs update.
  While the reference is blocked on the parent, another connection must acquire
  child FOR UPDATE NOWAIT. Then both commands must succeed and replay their
  exact receipts; scan creates one Job and backfill retains its binding id.
  A separate reparent race refuses the changed child instead of late locking.
- Real PG negative control executes the old JOIN rowmarks while parent is held:
  it must retain a child lock (probe returns55P03). This demonstrates the old
  RTE rowmark order on actual PostgreSQL rather than inferring it from FROM text.

Reuse: extend the existing Source-purpose parent-lock module for one exact
parent/channel reference pair; reuse owning transaction/query ports and existing
ACL/domain writers. No generic locking framework, advisory gate, dependency,
schema, transport, Agent permission or production mapping change.

Own incremental scope9 files: sourceMonitorParent.ts (only appended reference
lock helper), projects/projectSourceOperations.ts, sourceBackfillOperations.ts,
sourceSubscriptionOperations.ts, sourceChannelProposalApplier.ts,
customSources/customSourceCreateFlowService.ts (move existing parent lock), new
sourceParentLockOrderDb.test.ts, modules/sources.md and this plan (new N1 sections).
Earlier Source/Note shared hunks, INDEX/worktree plan/reports and Board commit
remain intact and excluded from this incremental manifest. No inventory row
change: Source-only555/formal556/Note-inclusive553 remaining. P5-2 remains open
for post-processing/extraction controls after this repair's coordinator check.

N1 verification from server owning package, Node24/shared isolated real PG:
- Final new sourceParentLockOrderDb:8/8 pass, including the actual old-rowmark
  negative control. Its explicit test pool has4 connections: three lock holders /
  probes plus the pg_stat_activity reader (default3 would exhaust the pool).
- Other affected files in the related run: projectSourceOperationsDb16,
  sourceBackfillOperationsDb13, sourceSubscriptionOperationsDb14,
  sourceMonitorOperationsDb23 (including shared-parent rename),
  sourceCustomSourceCreateFlow34, projectSourceDependencyDb14, agentGuides8:
  7 files/122 pass. Together with the final new file,130 distinct passing tests.
  Do not label the earlier combined run all-pass: its negative-control pool
  starvation failed; earlier fixtures also lacked search-spec / required Source
  columns and were corrected rather than accepting500 as success.
- Server typecheck, build including workspace deps/official plugins and diff check
  pass; typecheck rerun after final test correction. No protocol/API/UI change,
  full-suite run or visual acceptance claim. Existing pg warnings remain.
- No delegation/stage/commit/push/deploy/online data, mapping enable or Agent reach
  change. Coordinator verifies this bounded correction before exact Source commit.

## P5-2 rules / manual dispatch / extraction continuation (basis4da4b82d)

The previous Source creation/review36-file subset is committed in4da4b82d after
independent review and coordinator verification; older pending-review prose is
historical, not a request to re-review those batches. This continuation implements
four user-only operations and five retained URLs: rule create/update, run/drain
manual dispatch, extraction `/run`. Actual route/service closure has no separate
extraction cancel/resume public command; do not invent state transitions.

Reuse / Dependency Check: existing core transaction, Source parent/child helper,
Project authority locks, canonical post-processing normalizers/repository/service,
Agent create/prompt writer transaction ports, PgJobQueueRepository and existing
Source workers/Jobs result storage. No new schema/dependency/approval executor.
Existing run/drain and extraction run did synchronous external work: public
commands now only enqueue; workers use those same implementations. Add one
Source-purpose start/result fence in existing Job result_json, not a retry engine.
It records intent before I/O and receipt before acknowledgement; unresolved
external outcomes fail without replay. Default managed Agent provisioning joins
the actual core transaction, never a separate successful commit.

DoD coverage: strict DTO/user-only surfaces/explicit keys; actual Source/Project
scope discovery, sorted Project -> parent -> child admission and drift refusal;
current result authorization; one policy/audit per invocation; atomic rule/Agent/
scheduler or required Job with receipt; formal/generic/browser single core;
known validation throw-site types (unknown Http failures stay internal); existing
consent/history/worker effects, running conflict and finished/noop semantics.
No activation/approval/Memory/Note change, production mapping or Agent expansion.
run-once, decision derived-content actions and external generation are explicitly
outside this ordinary DB-only family, not silently counted migrated. P5-2 stays
in_progress until review and remaining original ready-family DoD acceptance.

Inventory:5 actual old URLs migrate, none added: formal636=565legacy+39exempt+
32core =>550 P5 core legacy after15 plugins; Note-inclusive working636=563/39/34
=>548 remaining. Note's two draft entries and all shared hunks remain preserved;
internal Agent/worker port changes do not reduce URL counts separately.

Own review manifest (only this run's Source hunks;31 containers):

- `packages/protocol/src/sourceProcessingOperations.ts`
- `packages/protocol/src/operations.ts`
- `packages/protocol/src/systemActions.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/test/operations.test.ts`
- `server/src/modules/sources/sourceProcessingOperations.ts`
- `server/src/modules/sources/sourceDispatchExecution.ts`
- `server/src/modules/sources/postProcessing/commandErrors.ts`
- `server/src/modules/sources/postProcessing/service.ts`
- `server/src/modules/sources/postProcessing/repository.ts`
- `server/src/modules/sources/postProcessing/job.ts`
- `server/src/modules/sources/extractionJob.ts`
- `server/src/modules/sources/repository.ts`
- `server/src/modules/sources/routes.ts`
- `server/src/modules/agents/repository.ts`
- `server/src/modules/systemActions/operations/runtime.ts`
- `server/src/modules/systemActions/operations/routeInventory.json`
- `server/test/sourceProcessingOperationsDb.test.ts`
- `server/test/operationExecutorDb.test.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/modules/sources/sourceActions.ts`
- `apps/web/src/modules/sources/SourceChannelsPage.tsx`
- `apps/web/src/modules/sources/SourceChannelDetailPage.tsx`
- `apps/web/src/modules/sources/__tests__/SourceChannelsPage.test.tsx`
- `apps/web/src/modules/sources/__tests__/SourceChannelDetailPage.test.tsx`
- `apps/web/src/__tests__/conversation-scope-api.test.ts`
- `.agent/modules/sources.md`
- `.agent/architecture/OPERATION_EXECUTION_CONTRACT.md`
- `.agent/architecture/OPERATION_CORE_ACCEPTANCE.md`
- `.agent/architecture/SYSTEM_ACTIONS.md`
- `.agent/plans/operation-core/05-core-module-operation-migration.md`

Shared protocol/runtime/client/test/docs/inventory containers also contain Note
hunks; only the new Source registrations/DTOs/adapters/tests/sections belong to
this batch. No Note policy/knowledge writer/INDEX/worktree-plan/report change.
Parallel Run/CLI work advanced HEAD to588a1021 during execution; that commit and
its shared client changes are preserved, not claimed as this batch's work.

Verification (Node24, own runs, not independent-review evidence):
- Related server run6 files/161 tests pass: new family27 at that point,
  SourcePostProcessingConfig18, SourcePostProcessingRepository29,
  OperationRoutes12, OperationExecutorDb67, AgentGuides8.
- Final expanded family30 tests pass, including formal update replay and
  extraction Job/audit/terminal-receipt failure cases:164 distinct related tests
  across the two runs. Failed development runs are not counted as passes.
- Protocol operations18 pass. Browser conversation-scope-api19,
  SourceChannelsPage10 and SourceChannelDetailPage11 =>3 files/40 pass;
  parent list/detail interactions assert queued rather than completed messaging.
  This is semantic feedback coverage, not a visual/layout acceptance claim.
- Workspace dependencies, server/protocol/web types, server build including
  official plugins and diff check pass. No full-suite or online-data action.
- Development runs corrected actual Jobs status pending/claimed/running, terminal
  receipt INSERT (not UPDATE), audit-count baseline including an earlier changed-
  input refusal, Date sanitization via configuration fingerprint, nullable schema
  defaults and typed browser key widening. No failing response was accepted as
  concurrent progress, no audit assertion was weakened to permit duplicate audit.
- Required Job receipts contain IDs/status/counts only. Source text/metadata
  stays in original history tables behind current ACL. An indeterminate external
  outcome remains failed, with its start fence intact; no external atomicity or
  automatic retry claim. Configuration fingerprints exclude normal cursor/fire
  progress, preserving legitimate successive manual dispatch.

P5-2 remains in_progress pending independent review/coordinator verification of
this family and original ready-family acceptance. No task status/mapping enable,
other checkpoint, delegation, stage, commit, push, deployment or handover file.

## P5-2 bounded post-processing review closure (basis588a1021)

Coordinator reports both independent reviews have no blocker. Claude's complete
report was read by the coordinator; Antigravity's first8000 characters were read
with its tail truncated. This follow-up verifies actual code, not that report's
invented class/line/ADR descriptions. It is not another five-family review.

N1: each user's manual extraction intent retains that user's Job/policy/authority;
no other user's Job id or execution identity is substituted. Strong PG overlap
holds the external scan boundary while the original automatic worker owns the
real extraction claim. Both manual deliveries defer using the existing Job
mechanism, release only their exact pre-effect busy marker, then observe terminal
noop; scan executes once. Revoked peer authority still refuses queued work. Rule
scheduled/manual overlap uses the actual session advisory claim plus a PG row
barrier; manual delivery defers without consuming its sole effect attempt, then
executes its distinct intent and replays its receipt. No409/500 is counted as
completed progress and independent manual intents are not globally deduplicated.
N3: Agent version/prompt stays current-at-execution, matching original Run
semantics; it is deliberately absent from rule configuration admission.
N4: existing Job Queue already has error/event/result presentation. Source parent
pages now explain queued-not-completed and unknown outcome/no automatic retry;
failed Source Job start markers get a specific warning in the existing result
view. SpaceLink keeps this navigation in the authenticated Space. English/Chinese
copy uses existing translation/theme controls, no dashboard or retry engine.
N5: PgAgentRepository constructor really accepts Pool, not Queryable. Preserve
that general contract; expose only the two bound canonical transaction methods to
Source commands/managed Agent helper. No fabricated PoolClient/Pool casts and no
repository-wide refactor. Default Agent failure rollback evidence remains valid.

### Original P5-2 DoD audit (implementation vs acceptance)

| Original ready family | Actual retained entry closure | Independent review / evidence |
|---|---|---|
| Grants create/revoke |2 adapters, canonical grant writer; approval request remains separate |7aea6793 committed; previous reviewed PG/audit/permission evidence retained, not rerun or re-reviewed here |
| Project operation create/cancel |2 adapters; reserved managed progress stays internal; custom/source_setup/source_backfill and nullable refs retained |dac5d44b committed after review/corrections; generic vs research cancel terminal semantics retained |
| Source backfill ordinary planning/control |preview/create/pause/resume4; start/propose-start still approval-bound |0b0ab8f9 committed; domain keys and Project binding authority evidence in original section |
| Project Source consumption |bind/update/unbind/backfill4 |82a3199e committed; source reach/current Project/delivery scope and atomic Corpus/link tests retained |
| Personal preference/recommendations |2 adapters; personal opt-out independent |e9244c3c committed; current subscription and recommendation evidence retained |
| Recipe DB draft creation |1 adapter, original consent/default placement |b5351250 committed; plan/dry-run/activation excluded by original ordinary-stage gate |
| Monitor controls/create |update/scan2 + create1, ordered parent/child and actual Project authority |fea06988 +4da4b82d committed; coordinator confirms independent reviews including final helper/PG negative control |
| Rule config/manual dispatch/extraction control |4 operations/5 adapters, strict typed browser and existing worker closure |Current uncommitted family, coordinator reports reviews passed; this bounded follow-up adds concurrency/UI/port evidence before exact submission |

For that original scoped ready list, all23 retained mutating adapters are now
implemented (18 committed +5 projected), plus their required metadata reads.
No ordinary entry from that list remains on a legacy writer. This does NOT mean
all Source legacy rows or the entire P5 program are finished. Actual remaining
Source inventory: proposal/start/activation belongs to approval/Source gates;
item/evidence/derived decision actions are original checkpoint5 object flows;
recipe generation/plan/dry-run, credential/settings/catalog and Goal/Run/
material-processing orchestration retain their sensitive/remaining-owner gates.
They are not silently counted as checkpoint2 ready commands or migrated here.
The eight already-retired transport refusals are baseline exemptions, not new
P5-2 capabilities. Original checkpoints4/5/6/7/8 are not moved into2.

DoD strict schemas/explicit keys/current authority, canonical writer and atomic
policy/audit/required Job/result, error classification, retired transport writes,
typed consumers/history and worker bounds are evidenced by the committed family
sections and this family's focused tests. Review and test evidence are separate.
Remaining acceptance action: coordinator verifies this limited delta, commits the
five projected adapters and accepts the original ready-family DoD. Task remains
in_progress until that acceptance; this agent makes no commit/completion claim.
Counts unchanged by this follow-up: HEAD remaining555; family projection550;
Note-inclusive working548. Internal port/claim corrections do not reduce URLs.

Bounded DoD audit also found two concrete multiline relevance-profile validation
throws still using raw HttpError422 (inverted criteria date range, enabled profile
without objective/include criteria). Give those actual sites the existing
SourceProcessingInputError type; PG checks typed cached422 with no Agent/rule.
No blanket HttpError classifier or arbitrary-helper wrapper was added.

Own follow-up delta18 files/hunk containers (original family31 ->38 containers;
all existing Note/protocol/runtime/client/other parallel hunks remain excluded):
sourceDispatchExecution, extractionWorker, postProcessing/service +repository,
sourceProcessingOperations; sourceProcessingOperationsDb test; SourceChannelsPage,
SourceChannelDetailPage, new SourceDispatchNotice; existing JobQueuePage +test;
sourcesUi.en/zh-CN; new source-dispatch.browser.mjs; permanent Sources guide,
operation execution contract, core acceptance and this original plan. No route
inventory change in this follow-up. No AGENTS/INDEX/worktree-plan/reports edited.

Follow-up validation (own runs, not a new independent-review claim):
- Shared isolated real PG: SourceProcessingOperationsDb34,
  SourcePostProcessingRepository29, SourcePostProcessingConfig18,
  OperationRoutes12, AgentGuides8 =>5 files/101 pass. Includes the literal original
  scheduled Job handler and original automatic extraction worker, not a fabricated
  SQL claim. Only external scan I/O is substituted in the held-scan test; all
  domain/intent/ACL/audit/claim/finish/receipt storage is real PG.
- Web SourceChannelsPage10, SourceChannelDetailPage11, JobQueuePage3 =>3 files/24
  pass. Server/web types and server build pass; final web build and browser
  screenshot matrix are separately recorded below. No full suite.
- Chromium initially found a genuinely wrong unscoped `/jobs` notice link; reuse
  existing SpaceLink, then verify Source list/detail ->same-Space Job Queue,
  expanded logs/result and unknown-external-effects/no-auto-retry warning. No
  dashboard, layout system, generic retry or new permission was introduced.
- Failed browser attempts and the earlier type-only test annotation correction
  are not pass evidence. Default-Agent failure rollback tests remain passing;
  no checked-out client is disguised as Pool or full repository handed to commands.

Final UI evidence: the final web build passes. Real Chromium completes one
four-context journey (en/dark/1280, zh-CN/dark/390, en/light/390,
zh-CN/light/1280), each checking Source list action, detail action, SpaceLink
navigation to existing Job Queue, expanded logs/result and unknown-effect warning.
12 screenshots generated; phone list, desktop detail and phone result screenshots
were actually inspected for wrapping/readability/action reach/theme consistency,
not just overflow. Four selected fixture-only screenshots are copied into this
Run's preview output (all below1MiB). A prior unscoped-link browser failure is
recorded above and not counted as pass. No live backend/online DB is accessed.
Server5 files101 tests and Web3 files24 tests pass after the final code changes;
server/web typechecks, deps/server build (official plugins), final web build and
diff check pass. Existing warnings are not a clean/full-suite claim. No further
old-family review is requested by this implementation turn.

## P5-4 final writer/effect closure (basis7594f2ec, uncommitted)

Only checkpoint4 is active. Checkpoints1/2/3 are accepted/done; checkpoint8 stays
last. Historical sections describing unimplemented Evolution or synchronous
standalone patching are snapshots superseded by committed8600172e and this diff,
not reasons to re-review old families or enable later permissions.

Reuse / Dependency Check: reused `withCheckpointDecisionOwner`, canonical
`insertProposalRow`/`acceptInTransaction`, `withPolicyAuditRecovery`, existing
PgJobQueue/JobWorker, dedicated advisory gates and Evolution's prepared file
transaction/recovery pattern. Extracted only the purpose-specific file-effect
helper shared by both workers; no dependency, generic retry/transaction framework,
second business applier or synchronous fallback. Added Drizzle-generated0014
intent persistence. Schema generation did not apply anything to a live database.

Actual remaining gap implemented: standalone code-patch apply/rollback now persist
frozen intent + required Job, expose pending receipt and finalize canonical
Proposal/request/snapshot/history/result only after real file IO outside the DB
transaction. Conditional compensation preserves unrelated edits. Receipt loss,
Job exhaustion/cleanup and explicit retry retain the original human decision and
intent; old keys are not redirected to new revisions. Proposal detail and Room
cards read the sanitized per-user receipt and do not claim enqueue means applied.
Three previously raw INSERT sites (Plan checkpoint, Workflow checkpoint, Knowledge
Candidate promotion) now join canonical insertion/fresh registration on their
actual transaction owner with existing fields/audience intact.

Final SQL inventory: reviewPackets INSERT; payloadRevision UPDATE; canonical
applyService status/payload/cascade/rollback; definition and monitoring replacement;
Skill bulk supersession; Plan review supersession; Run terminal CTE/publication;
P1 approval hooks. Memory/import use payloadRevision; no direct B10 table writer.
Outer/root/nested owner implementations already committed remain unchanged.
The detailed original-DoD and candidate qualification matrix is in permanent
OPERATION_CORE_ACCEPTANCE's basis7594f2ec section, not a new checklist fork.

New evidence: real shared PG8 files108 pass (codePatchDecision13, routes8,
nested8, Candidate12, Plan20, Run23, linked Job owners22, apply unit2); safe
file12/Evolution17 pass in the prior focused run after shared-helper extraction.
P1 targeted9 pass/58 intentionally not selected: sorted cascades, expiry/cleanup,
rollback and accepted-without-result refusal. Web parent/detail/Room/list/Today/
Evolution affected checks and protocol receipt checks are separately recorded on
completion. No full-suite claim. Earlier fixture/type assertions failed before
correction and are not included as passes.

Production mappings/public proposal.decide/Agent reach remain disabled. No known
current eight-family writer/effect gap remains unimplemented; candidate permission,
Source consent/egress, Note/Memory and conversation semantics retain checkpoints5–7.
P5-4 is not marked complete before coordinator review/acceptance. No URL was
migrated by this internal closure: formal550, Source inventory636=565/39/32 minus15
plugin; Note draft projection548 excluded. Note shared hunks/INDEX/worktree-plan/
reports and concurrent work are preserved; no staging/commit/deployment performed.

Final qualification evidence for this diff: standalone14 (including hidden private
target with real busy linked keys before either phase's admission) and P1
approval/cascade37 selected/30 not selected pass. Across scoped server runs this
is13 distinct files188 selected passes, not a full-suite result. Web5 files15
pass, protocol receipt1 pass. Workspace deps, server/web typechecks, server build
with official plugins, web build, guide/boundary checks and diff check pass.
Chromium2 actual Space-scoped parent journeys pass (English dark desktop and
Chinese light phone), reading queued/compensation/success receipts without a
second acceptance; four screenshots created and two inspected. Initial browser
fixture attempts wrongly used an unscoped route (Home redirect); they are failures,
not pass evidence. No new Task/Proposal, permission or production mapping enabled.

### Limited dual-review follow-up (basis7594f2ec)

N1: explicit typed policy/frozen/snapshot refusal, durable terminal marker before
safe compensation; existing handler failed-result convention stops automatic
apply retries. Unfinished cleanup never re-enters apply; DB/lease/advisory errors
are not a blanket HTTP-status business whitelist. Explicit user resubmission
retains the original intent/approval history and obtains a new bounded Job.
N2: active fingerprint check is before failed reset/enqueue, returning409 for a
different active intent; the domain unique constraint remains as a final guard.
N3: Folder gate contention defers cleanup in compensating without consuming an
attempt, rather than manufacturing compensation_failed/operator repair.
N4: preserve mandatory audit at each independent authority phase; correlate
worker preparation/commit by decision_id and phase. Fix unlinked final apply's
previous independent-audit choice to join the transaction whenever the trusted
effect receipt is present; original-id failed recovery remains unique.
N5: git-show comparison confirms all three raw INSERTs omitted rationale and
used nullable DB default; restore NULL via canonical input. Visibility, creators,
owner and provenance are unchanged; real Plan/Workflow/Candidate parents assert it.

Scoped PG4 files67 pass: standalone18, Evolution17, Plan20, Candidate12. No new
schema, protocol, visual presentation, mapping or URL migration in this limited
follow-up. Formal550/Note548 unchanged; no subsequent checkpoint advanced.

## P5-5 Codex adoption: Note history/trash (basis9d6613eb)

P5-4 is committed/accepted;1/2/3/4 done,5 is the current scope,8 remains last.
The coordinator's original Note draft was not independently reviewed. This batch
adopts its23 files (excluding INDEX/worktree-plan/reports) as one reviewable
history/trash capability subfamily; no unrelated diff is overwritten or staged.
It does not claim full Note CRUD or full checkpoint5 completion.

Reuse / Dependency Check: canonical PgKnowledgeRepository/NoteWriteScope,
noteRevisionService, typed conflict allowlist, core executor/adapters and the
existing recordDetailRead B11 gate. No dependency, retry/transaction framework,
Memory writer, external IO, artificial revision/outbox or required Job introduced.
No Source code dependency is needed by these two Note commands. The draft's
body-free receipt and receipt-Space GET are retained. New implementation fixes
null default/key normalization, request-id header and historical body audit.
Malformed/unknown errors and real granted-Agent exclusions gain PG evidence.

Original checkpoint5 DoD, bounded current scope:
- Implemented/review-ready: Note rollback+trash REST/generic/typed browser closure;
  current Note/Project authority on replay, reparent/role lock races; canonical
  revision/outbox and policy/request/read-audit atomicity, private projection
  savepoint containment. No old handler for these URLs remains.
- Not implemented by this batch: Note create/edit/collection/placement/jot/promotion
  and Source object mutations/activation/promotion/consent/egress entry closures.
  Existing implementations and all human consent/egress/invalid-material attempts
  remain unchanged. Knowledge evidence Source CRUD (knowledge/routes, sources
  table) is distinct from managed sources/SourceConnection/recipe activation.
  The former still uses retained direct repository calls, the latter keeps its
  canonical appliers/worker boundaries. P5-4 writer qualification is not a flag
  enabling any of those production mappings.
- Awaiting only a permission choice: note.link.create reserved/default-deny versus
  existing human link REST/editor. No link behavior or new Agent rights changed.
  Other remaining engineering does not need another product confirmation.

Final scoped server5files63, protocol2files42, Web3files65 pass. Real PG is used
for durable behavior; one injected unknown HttpError tests classification without
replacing persistence. Tests include a valid manual Agent/current grant identity
before core rejects the human-only surface. Body-reload tests bind to receipt
Space. No presentation changes or visual claim. Deps/types/server build/diffcheck
pass. Existing React act warnings and intentional projection failure logs remain.
Initial erroneous filename selections and the rejected trash-outbox assumption
are not passes; permanent acceptance documents the corrections.

Formal HEAD550 remains unchanged; this two-URL working projection is548
(636=563legacy/39exempt/34core minus15 plugin). No schema changes; committed0014
is preserved. No stage/commit/deploy, Task/Proposal creation or handover file.

## P5-5 ordinary Note create/edit/collection/placement (basis4cf62800)

The23-file history/trash subset is now committed and independently reviewed in
4cf62800; its earlier awaiting-review text is historical. This batch implements
one complete ordinary Note object family:10 retained command URLs and typed
consumers, not another history-only repair. Checkpoints1–4 remain done, current5,
8 last. Independent review of this new diff is coordinator-owned and pending.

Reuse / Dependency Check: NoteWriter/NoteWriteScope/revision/outbox and canonical
repository/placement/reorder/share writers, access-owned creation context,
Project authority locks, core schema/adapters/errors and existing metadata/body
readers. New modules are purpose-bound Note admission/registration/errors/REST;
no dependency, second business writer, generic transaction/retry engine or
external IO. A Note manual draft uses the existing draft seam, with only a
specific authorized-collection child rule; the durable Source exception and
Agent guards are not widened. No schema change or migration generation needed.

Scope includes create/edit (all legitimate rich-editor fields and versions),
collection create/update/delete/Project ensure, add/remove placement, share
revocation and tree reorder. Former direct REST implementations are retired.
Existing selection-object actions and lawful internal Agent writer/ops remain
unchanged. Root-before-extension is unified in the canonical content writer to
avoid inversion with core admission; forced PG overlap preserves the original
ops conflict-append semantics. A bounded ancestor/child/Note/role closure is
rediscovered before/after locks, not a global-row lock or fabricated ready flag.

Transport cutover: explicit keys and canonical envelopes; collection DELETE now
returns a body-free receipt200 instead of204. Typed APIs maintain their existing
Note/collection/void return contracts by current reader calls in receipt Space.
Editor serial saves retain an unresolved snapshot/key for manual Retry, change
key on changed input, and introduce no automatic retry. Human sharing and owning-
entry dialog metadata is preserved; hidden folder blockers give404 and visible
blocker metadata is not retained under a stale key. Existing domain uniqueness,
archived-Project controls and Project viewer ensure no-op are preserved.

Original checkpoint5 DoD progress:
- Done before this batch: Note history/trash, reviewed/committed4cf62800.
- Implemented here, awaiting dual review: complete ordinary Note create/edit/
  collection/placement/reorder family, related current metadata/body consumption,
  strict key/schema/authority/audit/transaction/consumer closure.
- Remaining engineering in5: Note/Wiki promotion and ordinary Source object/
  activation/promotion/consent-egress/invalid-material-attempt entry closures.
  P5-4 writer qualification is reused, not permission to enable mappings.
- Only existing human permission choice: reserved/default-denied Note link versus
  current human linking. Link and its atomic targeted jot public contract stay
  unchanged/excluded; that choice does not block the independent engineering.
- Sensitive purge and final stateful-GET/inventory closure are not smuggled into
  ordinary Note capabilities or used to claim checkpoint5/overall P5 completion.

Working inventory regenerated with UPDATE_OPERATION_ROUTE_INVENTORY:636=553/39/44,
remaining538; formal HEAD548 until coordinator commit. Exactly10 URLs moved,
no internal fix counted. INDEX/worktree plan/reports and any concurrent work
are preserved; no stage/commit/deploy, new Task/Proposal or handover file.

Final evidence: server11files164 pass (objects28, history28, collections11,
placements13, shares16, writer8, binding9, roles7, role guard5, Source creation27,
inventory12); guides/boundaries13 separately. Protocol43, Web68, real Chromium2
parent/editor explicit-retry journeys pass. English desktop includes collection
creation/current metadata; Chinese phone checks editor retry/body refresh.
No live APIs, full suite or visual appearance acceptance claim. Deps/server+web
types/server+official plugins/web build/diffcheck pass. Earlier missing-key/
old-envelope assertions were updated for the intentional cutover without losing
domain placement assertions; the confirmation fixture now genuinely crosses two
Projects. INDEX/worktree-plan/reports remain outside this manifest.

### Ordinary Note scoped review repair on4cf62800

Coordinator reports both independent main reviews without a blocker apart from
Claude's confirmed P2 replay disclosure. This repair does not claim to have read
the truncated Antigravity tail or to substitute local tests for independent review.
P2: notes reorder now checks explicit input Note write authority before and after
waits. Owning-entry help follows collection.delete's current-read/noncacheable
refusal boundary, preserving visible dialog actions without caching private
blocker identity/title/count. PG verifies both transports replay safely after
privatization with unchanged Project membership, initial hidden refusal, actual
root-row overlap, full domain/request rollback and one recovered failed audit.

N2 source comparison found unnecessary tightening, not a newly approved rule:
canonical folder delete controls its own Project, while a shared Note's owning
Project need not be writable; canonical collection reorder only demands writer
for reparenting, not same-parent ordering. Discovery still freezes folder/Note/
role-holder references, but authorization Projects now match those actual writer
requirements. Per-Note reorder and real source/destination placement gates remain.
PG covers both restored legal operations and denied unauthorized reparenting.
Reuse: the existing admission, canonical writers, blocker read shield and plain
OperationError rollback; no dependency, retry engine or new error allowlist.

Only repair increments: noteObjectAdmission.ts, noteObjectOperations.ts,
noteObjectOperationsDb.test.ts, knowledgeNoteOrderingDb.test.ts and these existing
plan/knowledge-owner/acceptance sections. The older ordering consumer now supplies
explicit keys and reads canonical envelopes while retaining durable order and
real duplicate-position checks. No protocol/web production changes in this repair.
Formal548/ordinary10-URL projection538 remains uncommitted; P5-5 remains incomplete,
link choice stays pending, production mappings and Agent reach are unchanged.

Repair validation: real shared PG6files88 pass (32+13+11+16+9+7); guides/boundaries
13 and Web API consumer21 pass. Node24 workspace deps/server noEmit types and
diffcheck pass. First audit query mistakenly included prior request evidence;
it now asserts exactly one failed audit for the refusing request. Old ordering
consumers' missing keys/envelopes were corrected, not bypassed with relaxed
statuses. Those initial failures are excluded from passing evidence. No full
suite or repeated browser/visual claim. This evidence is local verification,
not an independent third review; coordinator retains submission/acceptance.

## P5-5 passage promotion + evidence Source objects (basis1d156dfd)

Prior ordinary Note10-command family and reorder repair are committed in
1d156dfd after coordinator-managed independent review; do not reopen that family.
This batch migrates4 retained URLs: Note passage promotion and evidence Source
create/update/archive. Scope is `knowledge.sources` evidence rows, not managed
SourceConnection activation. Original checkpoint5 stays current;1–4done,8last.

Reuse / Dependency Check: existing PgKnowledgeRepository/proposeCreate,
insertProposalRow/P5-4 transaction port, canonical approval applier/provenance,
profile compiler, source root/extension CTE writer and projection savepoint,
access creation context, current ACL/Project locks, existing core/REST adapter,
policy audit recovery and typed current GET. No dependency, migration/schema,
second writer, generic retry or execution engine. No external IO or required Job
exists in these DB-only commands; future worker-backed controls cannot be claimed
complete by this batch.

The proposal-producing operation uses existing proposal.create; knowledge.create
continues to gate actual accepted Knowledge. This removes the old registry's
submission/apply ambiguity without enabling an operation approval mapping or
public proposal.decide/new Agent capability. The human still reviews the original
knowledge_create proposal exactly once. A 202 command receipt says draft created,
not Knowledge accepted. Body-free id/Space receipts reread current authorized
Proposal; original selected content, author, fields, profile validation, source
refs and Note-version provenance are retained in the canonical payload. Old keys
retain old receipt identity; no revision redirect or duplicated approval occurs.

Scope admission discovers actual current Note/Source Project before key wait,
locks sorted Project authorities then object root, rechecks growth and uses
current object ACL. Source roots preserve private Personal/Project-shared access
placement. Different keys are independent Source creation intent, not transport
substitution for domain uniqueness. Source detail B11 storage is fail-closed.
Only the actual profile compiler's typed validation refusal is cacheable; arbitrary
HTTP422 is not a business allowlist. Link/jot and Agent exposure stay unchanged.

Original checkpoint5 coverage: committed history/trash + ordinary Note objects;
implemented here passage-to-Knowledge proposal submission and evidence Source
CRUD. Actual remaining independent families: curated item-to-evidence Source
links (POST/DELETE /knowledge/items/:itemId/sources...), modern KnowledgeCandidate
promotion submission, managed activation and consent/egress/material-attempt
controls. They are not mislabelled as this evidence CRUD. Note link policy remains
the existing human choice; atomic jot stays excluded. No claim checkpoint5 done.

Inventory: formal HEAD538; working534=636(549legacy/39exempt/48core) minus15plugin.
Exactly4 retained URLs migrate. Internal B11/error/authority fixes do not reduce
URL counts. Independent review is for coordinator to schedule; local tests are
not dual review. INDEX/worktreeplan/reports and parallel changes are excluded.

Scoped final verification: new shared-PG knowledgeObjectOperationsDb19; existing
notePromotionDb6, KnowledgeCandidate/Knowledge revalidation knowledgePromotionDb12,
placement13, selection registry6 and inventory12 pass; guide/boundary13. Protocol
operations21, Web API22 and parent editor mount11 pass. Node24 deps and server/web
noEmit types/diffcheck pass. No full suite or browser/visual acceptance claim.
First invalid private-owner seed and waiting-admission expectation were corrected
to actual schema and nonwaiting P1 contract; B11 Source audit failure now explicitly
returns503 without body, and the Web test uses the real X-Rainver-Space-Id header.
Wrong root-package invocations are not passes. Independent dual review is pending.

Owned review manifest (21 files; excludes INDEX/worktreeplan/reports):
- Protocol src: knowledgeObjectOperations.ts (new), operations.ts, systemActions.ts,
  index.ts; protocol test/operations.test.ts.
- Server knowledge: knowledgeObjectOperations.ts / knowledgeObjectErrors.ts (new),
  noteObjectOperationRoutes.ts, repository.ts, routes.ts.
- Server core integration: operations/runtime.ts and routeInventory.json.
- Server test: knowledgeObjectOperationsDb.test.ts (new).
- Web: api/client.ts, types/api.ts, __tests__/conversation-scope-api.test.ts.
- Permanent docs: knowledge-base.md, SYSTEM_ACTIONS.md,
  POLICY_ENFORCEMENT_INVENTORY.md, OPERATION_CORE_ACCEPTANCE.md; this original plan.
No stage/commit/push/deploy/online writes, new Project Task/Proposal or handover file.

## P5-5 curated evidence and modern Candidate review (basis1d16069e)

The prior21-file passage/evidence CRUD batch is committed and independently
reviewed in1d16069e; it is not being reopened. This batch implements a complete
nine-command DB-only family: curated knowledge_item_sources add/remove; Candidate
creation from Note/Thread/converted Interpretation; promote/dismiss/defer decision,
reopen; and review packet open/close. Seven original Candidate and two evidence
mutating URLs now share core/REST adapters and canonical domain writers. The
Agent-specific combined Thread→Candidate→Proposal path remains its original
scoped internal service/attribution/audience; no new Agent grant is exposed.

Reuse / Dependency Check: existing repository citation/FK/unique index and safe
projection savepoint; Candidate state machine, immutable pinned source refs,
canonical insertProposalRow and accepted ProposalApplyService; P1 transaction/key/
policy/audit recovery; existing Project aggregate fence and authority locks;
current Candidate/list readers and a purpose-bound owner packet reader. No new
library, generic retry/admission/approval engine, schema or external effect.
Manual commands create no required Job. Extraction enqueue/worker is a separate
remaining entry, not faked completed by a receipt from these DB-only commands.

Authority follows actual original owner/role semantics. Evidence mutations need
Knowledge owner plus full personal read of both endpoints, never arbitrary Note
FK carriers or Source ownership/write authority. Candidate mutations retain active
Project writer requirements and source/current Candidate ownership. A full-read
source grantee still may insert a private Candidate for the source owner without
receiving read/decision rights over it. Minimal receipts do not confer those rights.
All Project/root sets are discovered before waits and rechecked; actual target
Project aggregate FOR UPDATE precedes roots and service calls. This fixes the
observed concurrent FOR SHARE→FOR UPDATE upgrade deadlock rather than adding retry
or weakening the PG test to permit503. Real archive transitions are typed at the
actual existing owner throw site; unknown helper409/422 remains internal/uncached.

Candidate promote remains original Proposal submission, not proposal approval.
The tested shared-source/different-submitter failure was real: payload owner was
copied from source owner while Proposal creator belonged to the submitting writer.
New Knowledge payload owner now matches the trusted submitting human, preserving
the applier invariant; source/Candidate ownership/pinned authorship is unchanged.
The new full-chain test proves a member writer can submit but cannot approve;
authorized owner approval still succeeds after submitter writer revocation. No
imagined blanket Project-writer acceptance rule replaces the real canonical gate.

Original checkpoint5 progress: history/trash, ordinary Note objects, passage
promotion/evidence CRUD committed; this batch implements curated citations and
manual modern Candidate/review closure. Actual remaining engineering: Candidate
extraction Job/worker command entry; managed Source activation, consent/egress and
material submission/invalid-attempt controls. Note link still awaits the existing
human choice; atomic jot remains excluded. No checkpoint6/7/8 work is claimed,
no production mapping/publicproposal.decide/Agent authority is enabled, and5 is
not declared complete. Working525=636(540legacy/39exempt/57core) minus15plugins;
formal534 until coordinator commit. Only9 migrated retained URLs reduce counts.
Internal ownership/audit/lock fixes and the new packet GET do not reduce URLs.

Verification: new knowledgeReviewOperationsDb23 real-PG tests pass; original
knowledgePromotionDb12, knowledgeGroup17, operationRoutes12 and guide/boundary13
pass. Protocol operations22 and Web API/Project Knowledge Review parent30 pass.
Node24 workspace deps, Web noEmit types and diffcheck pass. Earlier server types
passed; the final workspace rerun fails8 unrelated parallel Host errors in
acpToolPresentation/threadEventNormalization/threadEventRepository: missing
ToolCallDetails export, unused summarizeToolOutput and missing
MAX_TOOL_RESULT_SUMMARY_CHARS. No parallel file was edited or used to excuse a
pass claim; final server workspace typecheck remains a verification limitation. No full suite
or actual browser/visual acceptance claim; only transports/read-after-write changed.
Initial tests exposed real owner-payload and Project lock-upgrade defects, both
fixed with the strict original assertions retained. A private-vs-selected-user grant
fixture and unused variables/root-package invocations were corrected, not counted
as passes. Local checks are not the coordinator's pending independent dual review.

Owned review manifest (23 files; exclude INDEX/worktreeplan/reports and all parallel
turnParts/Host event/presentation/Run read-model work):
- packages/protocol/src: knowledgeReviewOperations.ts(new), operations.ts,
  systemActions.ts, index.ts; test/operations.test.ts.
- server knowledge: repository.ts and routes.ts.
- server knowledgePromotion: candidateService.ts, routes.ts,
  candidateErrors.ts(new), reviewOperations.ts(new), reviewOperationRoutes.ts(new).
- server projects/access.ts: actual archived aggregate-fence throw uses its
  existing explicit ProjectArchivedMutationError subclass (same409 semantics).
- server systemActions/operations: runtime.ts and routeInventory.json.
- server test/knowledgeReviewOperationsDb.test.ts(new).
- apps/web/src: api/client.ts and __tests__/conversation-scope-api.test.ts.
- Existing docs: knowledge-base.md, OPERATION_CORE_ACCEPTANCE.md, SYSTEM_ACTIONS.md,
  POLICY_ENFORCEMENT_INVENTORY.md and this original plan.
No stage/commit/push/deploy/online DB, new Project Task/Proposal or handover file.

### Curated/Candidate scoped review repair on1d16069e

Coordinator reports the main23-file diff dual-reviewed; this turn fixes confirmed
P2/P3 only, not a new family or repeat full review. Restored original source-
independent Candidate dismiss/defer/reopen, with current Candidate ACL/active
Project writer/state and their current replay checks. Creation/promotion retains
required live/full source checks. Note soft-delete/purge/private and Thread
soft-delete/private PG cases use a non-source-owner writer and preserve pinned
history; cleanup succeeds across REST/generic original keys while promote and
private-Candidate/withdrawn-writer access remain hidden404.
Unlink discovers/locks only current Knowledge and exact association, not inaccessible
Source content. Private/deleted Source cleanup and old-key replay leave a newer
link untouched; add/full-read/FK and B11 rules stay unchanged. Wrong same-Space
item/link binding is hidden, never removed. Supersedes target uses canonical
create()'s original contentReadSql predicate, including readable summary/oversight,
and a shared root lock; no new full-content or reference-Project gate is invented.
Source/root/Project ordering and the fixed aggregate upgrade-deadlock guard remain.

Reuse: bounded action-specific discovery in the existing admission module, original
Candidate/repository writers and existing packet clamp; no framework/DTO/schema/
policy/Agent/mapping changes. Packet.open clamps1..20 before fingerprint (default10),
so100 and20 / negative and1 replay identically; no min/max rejection was added.
All Candidate/packet follow-up GET path segments encode Project and returned id,
with receipt-Space headers unchanged.

Repair increment exactly7 files: reviewOperations.ts; knowledgeReviewOperationsDb.
test.ts; Web api/client.ts and conversation-scope-api.test.ts; knowledge-base.md,
OPERATION_CORE_ACCEPTANCE.md and this original plan. Main23-file manifest remains
the review/commit boundary; INDEX/worktreeplan/reports, parallel Host/turnParts/
conversation work and schema0015/journal are excluded and preserved. No stage,
commit, deployment, new Project Task/Proposal or handover file. Formal534 / nine-
URL working projection525 is unchanged. P5-5/link choice/remaining extraction and
managed activation-consent-material scopes remain open as before.

Repair evidence: new review file33 real-PG tests (10 added) + original promotion12,
inventory12, guides/boundaries13 =5 server files70 pass. Web API25 + Knowledge
Review parent6 =31 pass. Current Node24 deps/server/Web types pass, replacing the
previous Host type limitation with actual new rerun evidence; no parallel file
was repaired. Scoped seven-file diffcheck passes. Global diffcheck still reports
parallel apps/web/src/modules/conversation/ConversationTurn.tsx:252 EOF blank line;
it is preserved, not silently cleaned or reported as a global pass. No full suite,
new presentation/browser acceptance, schema or permission change. Coordinator
retains independent verification/submission; local tests are not another dual review.

## P5-5 Candidate extraction Run/Job/worker family (basis5c407024)

The prior23-file curated/Candidate family and scoped review repair are committed
and reviewed in5c407024; they are not reopened. This batch completes the tightly
owned Candidate extraction queue→existing Agent Run→terminal reconcile closure,
including typed Review caller and original formal POST. It is not just an enqueue
annotation: real required Job, dispatch checks and final durable publication receipt
are implemented. Exactly1 retained URL moves; formal525, working524=
636(539legacy/39exempt/58core) minus15plugins. Internal worker/receipt/read fixes
remove no URL. Checkpoints1–4done,5current,8last.

Reuse / Dependency Check: original KnowledgeExtractionService source resolver and
Candidate writer, PgRunRepository/route/profile/Host execution, PgJobQueueRepository,
original extraction reconcile JobHandler/JobWorker/defer, P1 core, current ACL and
Project aggregate gates, B11/policy audit recovery, canonical Run event writer and
existing orchestration source-dispatch seams. No extra dependency, execution/retry
engine, table, generated migration or second domain writer. Receipt uses existing
action_completed metadata rather than inventing an unsupported event enum or actor.

The command writes queued Run + required Job + audit/request atomically, returns
only Run identity/queued state and preserves source revision in the private
execution contract. Old keys do not recapture new revisions; new intentions use
new keys. Model/Host IO stays in the original worker. Narrow source prompts force
private Run visibility; current source/Agent authority is checked at three existing
orchestration checkpoints before external invocation. Publication rechecks live
Project/user/Agent/source access and only narrows derived audience. Revocation
never erases real Run outputs/expenses or claims external work was rolled back.

Worker publication takes the original event writer try-fence before domain locks,
locks bounded sorted Project/member/grant/Agent/source/Run sets with NOWAIT, and
uses existing JobDeferredError rather than a retry loop. Candidate batch and
required publication receipt event commit together, including zero/skipped counts.
ACK storage failure replays that receipt; record failure rolls Candidates back.
There is no unsupported run_events enum/schema change or fake user-as-actor id.
The current queued toast/Review parent is unchanged; transport tests do not claim
browser/visual acceptance or model/network execution.

Actual next independent owner family is managed Source activation: human Recipe
activation either applies inside its existing envelope or atomically submits its
original approval proposal; Agent Channel activation creates a paused draft and
proposal with different ownership/audience/credential rules. They are not the same
operation, and neither is changed/enabled by this batch. Consent/egress/material
submission/invalid-attempt gates remain real checkpoint5 work, not claimed complete.
Note link/jot remains the existing pending human choice. No production mapping,
new Agent grant or public proposal.decide authority is enabled. No new Task/Proposal
was written in the live Project; review/commit remain coordinator-owned.

Verification: new extraction PG19 pass (real queue, Worker, receipts and ACL),
existing Knowledge promotion PG12 and inventory12 pass; original Run orchestration
unit60 pass separately (not DB evidence). Protocol operations23; Web API26 + Project
Review parent6 pass. Node24 deps/server/Web types pass. Full suite, live model/Host
execution and browser/visual acceptance were not run. No schema or migration is
required; current parallel0015/journal/Host/conversation/turnParts work is excluded.

Failures before these final passes are not passes: the first receipt used an
unsupported event type/actor FK, fixed by reusing action_completed metadata and the
canonical event writer; new Run fixtures needed real routable Host/Profile settings
and start shape; a cross-Project fixture needed a real owning entry. Schedule tests
use a definitely expired time to avoid clock precision races. The canonical source
Project read boundary was verified rather than inventing grant bypass: viewer+full
source grant succeeds, no source Project writer is required, no Project read reach
still denies. Strict Worker completed/deferred and atomic rollback assertions remain.

Owned manifest (21 files; only these own hunks, no aggregate parallel changes):
- Protocol src: knowledgeExtractionOperation.ts(new), index.ts, operations.ts,
  systemActions.ts; test/operations.test.ts.
- KnowledgePromotion: extractionService.ts, extractionOperation.ts(new),
  extractionDispatch.ts(new), reviewOperationRoutes.ts and routes.ts.
- Runs: orchestrationService.ts only three new extraction dispatch-guard calls.
- Core integration: operations/runtime.ts and routeInventory.json.
- server/test/knowledgeExtractionOperationDb.test.ts(new).
- Web: api/client.ts and __tests__/conversation-scope-api.test.ts.
- Existing docs: knowledge-base.md, SYSTEM_ACTIONS.md,
  POLICY_ENFORCEMENT_INVENTORY.md, OPERATION_CORE_ACCEPTANCE.md and this original plan.
No stage/commit/push/deploy/online writes, new live Project Task/Proposal or handover.

## Project total package — 4335ee20 baseline, continuous implementation

The user superseded per-family review stops: implement the following five groups
continuously, then request one independent Claude/Antigravity review. No staging,
commits, deployment or new product permission is authorized. The baseline has
123 exact legacy method/path entries; GETs and already-migrated Project commands
are excluded. Candidate extraction is the existing reviewed draft included here.
Implementation and tests do not constitute independent review or stage acceptance.

Reuse / Dependency Check: reuse OperationExecutor, existing purpose-bound domain
services, NoteWriter, Proposal transitions, Run terminal owner ports and PgJobQueue.
Use explicit per-command Zod DTOs and adapters; no generic business passthrough,
new execution/retry engine or dependency. External effects stay on existing workers.

| Group | Method | Retained path | Implementation status |
|---|---|---|---|
| 1 | POST | `/api/v1/projects/:projectId/research/acquisitions` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/area` | implemented Research workspace command; focused verification below |
| 1 | POST | `/api/v1/projects/:projectId/research/ask-ai` | implemented `research.ask_ai`; continuation evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/checklist` | implemented Research workspace command; focused verification below |
| 1 | DELETE | `/api/v1/projects/:projectId/research/checklist/:itemId` | implemented Research workspace command; focused verification below |
| 1 | PATCH | `/api/v1/projects/:projectId/research/checklist/:itemId` | implemented Research workspace command; focused verification below |
| 1 | POST | `/api/v1/projects/:projectId/research/claims` | implemented Research workspace command; focused verification below |
| 1 | PATCH | `/api/v1/projects/:projectId/research/claims/:claimLinkId` | implemented Research workspace command; focused verification below |
| 1 | POST | `/api/v1/projects/:projectId/research/evidence-matrix/rebuild` | pending |
| 1 | PUT | `/api/v1/projects/:projectId/research/initial-intake` | implemented in parallel Project batch; focused evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/initial-intake/start` | pending |
| 1 | PUT | `/api/v1/projects/:projectId/research/item-limit` | implemented workspace command; continuation evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/operations/:operationId/adopt-result` | pending |
| 1 | PUT | `/api/v1/projects/:projectId/research/operations/:operationId/item-limit` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/operations/:operationId/reconcile` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/operations/:operationId/rescan` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/operations/:operationId/retry` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/question/apply-forward` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/question/assessment/confirm` | implemented `research.question.assessment.confirm`; continuation evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/question/refine` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/question/resolve` | pending |
| 1 | PUT | `/api/v1/projects/:projectId/research/reading-list/:sourceItemId/card` | implemented Research workspace command; focused verification below |
| 1 | POST | `/api/v1/projects/:projectId/research/reports` | implemented `research.report.snapshot`; continuation evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/reports/:reportId/integrity` | pending |
| 1 | PUT | `/api/v1/projects/:projectId/research/screening-criteria` | implemented Research workspace command; focused verification below |
| 1 | POST | `/api/v1/projects/:projectId/research/standing/advice/:adviceId/action` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/standing/advice/:adviceId/dismiss` | implemented workspace command; continuation evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/standing/batches/:batchId/retry` | implemented workspace command; continuation evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/workflow/:workflowId/checkpoints/:checkpointId/decide` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/workflow/:workflowId/history-backfill` | pending |
| 1 | POST | `/api/v1/projects/:projectId/research/workflow/:workflowId/stages/:stageKey/run` | implemented in parallel Project batch; focused evidence below |
| 1 | POST | `/api/v1/projects/:projectId/research/workflow/:workflowId/trigger` | pending |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/candidates/:candidateId/decision` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/candidates/:candidateId/reopen` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/delta-briefs` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/relations` | implemented in parallel Project batch; focused evidence below |
| 2 | DELETE | `/api/v1/projects/:projectId/inquiry/relations/:relationId` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/review-packets` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/review-packets/:packetId/close` | implemented in parallel Project batch; focused evidence below |
| 2 | PUT | `/api/v1/projects/:projectId/inquiry/settings/shared-focus-wip-limit` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/definition-revisions` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/iterations` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/lifecycle-transitions` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/notes` | implemented in parallel Project batch; focused evidence below |
| 2 | DELETE | `/api/v1/projects/:projectId/inquiry/threads/:threadId/notes/:noteObjectId` | implemented in parallel Project batch; focused evidence below |
| 2 | PUT | `/api/v1/projects/:projectId/inquiry/threads/:threadId/personal-focus` | implemented in parallel Project batch; focused evidence below |
| 2 | PUT | `/api/v1/projects/:projectId/inquiry/threads/:threadId/primary-parent` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/problem/close-round` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/problem/work` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/signals` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/tasks` | implemented in parallel Project batch; focused evidence below |
| 2 | POST | `/api/v1/projects/:projectId/inquiry/threads/:threadId/tasks/:taskId/reference-result` | implemented in parallel Project batch; focused evidence below |
| 2 | PATCH | `/api/v1/projects/:projectId/inquiry/threads/:threadId/work-state` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions` | implemented in parallel Project batch; focused evidence below |
| 3 | PATCH | `/api/v1/projects/:projectId/experiments/definitions/:definitionId` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/interpretations` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/runs/:runId/complete` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/runs/:runId/observations` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions/:versionId/approve` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions/:versionId/runs` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions/:versionId/runs/launch` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/interpretations/:interpretationId/convert-to-signal` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/experiments/interpretations/:interpretationId/review` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders` | implemented `project.folder.create`; continuation evidence below |
| 3 | DELETE | `/api/v1/projects/:projectId/folders/:folderId` | implemented in parallel Project batch; focused evidence below |
| 3 | PATCH | `/api/v1/projects/:projectId/folders/:folderId` | implemented in parallel Project batch; focused evidence below |
| 3 | PATCH | `/api/v1/projects/:projectId/folders/:folderId/execution-config` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/execution-config` | implemented in parallel Project batch; focused evidence below |
| 3 | PUT | `/api/v1/projects/:projectId/folders/:folderId/file/draft` | implemented `project.folder.draft.upsert`; continuation evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/file/draft/discard` | implemented `project.folder.draft.discard`; continuation evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/file/draft/rebase` | implemented `project.folder.draft.upsert`; continuation evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/file/draft/save` | implemented `project.folder.draft.save`; continuation evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/file/revisions/restore-as-draft` | implemented `project.folder.revision.restore`; continuation evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/locations/:locationId/activate` | implemented in parallel Project batch; focused evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/:folderId/unregister` | implemented `project.folder.unregister`; continuation evidence below |
| 3 | POST | `/api/v1/projects/:projectId/folders/scan` | implemented `project.folder.scan`; continuation evidence below |
| 4 | POST | `/api/v1/projects/:projectId/corpus` | implemented `project.corpus.upsert`; continuation evidence below |
| 4 | PATCH | `/api/v1/projects/:projectId/corpus/:corpusItemId` | implemented `project.corpus.update`; continuation evidence below |
| 4 | POST | `/api/v1/projects/:projectId/corpus/backfill-source-items` | pending |
| 4 | PATCH | `/api/v1/projects/:projectId/information-monitoring/details` | implemented in parallel Project batch; focused evidence below |
| 4 | POST | `/api/v1/projects/:projectId/information-monitoring/items/:itemId/feedback` | pending |
| 4 | POST | `/api/v1/projects/:projectId/information-monitoring/proposals` | pending |
| 4 | POST | `/api/v1/projects/:projectId/information-monitoring/reconcile` | pending |
| 4 | POST | `/api/v1/projects/:projectId/information-monitoring/runs` | pending |
| 4 | POST | `/api/v1/projects/:projectId/information-monitoring/source-setup` | pending |
| 4 | PATCH | `/api/v1/projects/:projectId/information-monitoring/state` | implemented in parallel Project batch; focused evidence below |
| 4 | POST | `/api/v1/projects/:projectId/knowledge-candidate-extractions` | existing extraction draft + finite review fixes; 21 PG tests passed |
| 4 | POST | `/api/v1/projects/:projectId/sources/bindings/:bindingId/propose-backfill` | implemented `project.source.propose_backfill`; continuation evidence below |
| 4 | POST | `/api/v1/projects/:projectId/sources/propose-bind` | pending |
| 4 | POST | `/api/v1/projects/:projectId/sources/propose-setup` | pending |
| 5 | POST | `/api/v1/projects` | implemented in parallel Project batch; focused evidence below |
| 5 | PATCH | `/api/v1/projects/:projectId` | implemented `project.update`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/archive` | implemented `project.archive`; continuation evidence below |
| 5 | PUT | `/api/v1/projects/:projectId/attention/:sourceType/:sourceId/state` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/brief-versions` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/brief-versions/:versionId/publish` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/brief-versions/:versionId/submit-review` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases/:caseId/commitments` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases/:caseId/commitments/:commitmentId/deliver` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases/:caseId/criteria` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases/:caseId/decide` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases/:caseId/options` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/decision-cases/:caseId/scores` | implemented in parallel Project batch; focused evidence below |
| 5 | PUT | `/api/v1/projects/:projectId/focus-area` | implemented `project.focus_area.set`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/imported-sessions/extraction` | pending |
| 5 | POST | `/api/v1/projects/:projectId/instruction-versions` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/instruction-versions/:versionId/publish` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/instruction-versions/:versionId/submit-review` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/members` | implemented in parallel Project batch; focused evidence below |
| 5 | DELETE | `/api/v1/projects/:projectId/members/:userId` | implemented in parallel Project batch; focused evidence below |
| 5 | POST | `/api/v1/projects/:projectId/notebook-chat` | implemented `project.notebook.chat`; continuation evidence below |
| 5 | PUT | `/api/v1/projects/:projectId/public-summary` | implemented `project.public_summary.save`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/public-summary/draft` | pending |
| 5 | POST | `/api/v1/projects/:projectId/public-summary/publish` | implemented `project.public_summary.publish`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/public-summary/revoke` | implemented `project.public_summary.revoke`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/review-sessions` | implemented `project.review_session.open`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/updates` | implemented `project.update.report`; continuation evidence below |
| 5 | POST | `/api/v1/projects/:projectId/updates/:eventId/undo` | implemented `project.update.undo`; continuation evidence below |
| 5 | POST | `/api/v1/projects/public-summaries/feedback` | pending |
| 5 | POST | `/api/v1/projects/public-summaries/search` | pending |
| 5 | POST | `/api/v1/projects/retrieval/brief` | pending |

### Project total-package implementation progress (not unified review/acceptance)

- Group 1: 8/32 implemented: area initialization, three checklist commands,
  Claim link/create and update, evidence-card update, screening configuration.
  The remaining 24 Research URLs are still legacy. Groups 2/3/5 are not migrated
  by this increment (21/24/32 remain). Group 4 includes the existing extraction
  draft (1/14 implemented; 13 remain). Total **9/123**, **114 pending**.
- The eight new user-only operations use strict DTOs, default/null/text/array
  normalization, original domain writers, sorted Project fences and parent/child
  Source admission. An initialized area retains its original reader inspection
  path without repairing/creating notes. No Agent surface/grant is added.
- Retained REST adapters replace those business handlers. Browser commands carry
  explicit event keys (optional helper defaults create a new event, no retries),
  accept ID/Space/Project-only receipts and fetch current content through GET.
  Checklist and evidence-card exact GETs are new reads, not migrated write counts.
- Canonical Source/content read levels are retained: Claim references use the old
  contentReadSql predicate; editing a card uses the old readable Source gate, not
  a new full-content publication entitlement. Source/Claim Project changes are
  discovered before domain locks and rejected if they grow/change after waiting.
- ResearchWorkspaceMutationError marks only the actual known domain validation
  sites (duplicate Claim/date ordering/declared domain criteria); unknown helper
  Http422 rolls back with internal/no cached request/message. No generic HTTP
  allowlist or approval mapping is introduced.
- The extraction review fix locks the actual interpretation table, not an absent
  space_objects row; its receipt is server-authored (actor_id NULL), written only
  for succeeded Runs. Real agent_run JobWorker redelivery after terminal persistence
  re-enqueues the missing reconciliation nudge without running the model again.
- Counts: formal HEAD remains **525**. Working projection **516** = 636 total,
  531 legacy / 39 exempt / 66 core, subtracting the unchanged 15 plugin paths.
  Only the 9 exact retained URL changes count. Internal fixes/new GETs count zero.
- This is incomplete implementation, not a request to stop for a small-family
  review. The unified five-package review and overall migration acceptance remain
  pending. No new product choice, production mapping or public proposal.decide
  permission was introduced. The independent Note link choice stays unchanged.

### Current Project-package file ownership and executed checks

This explicit 35-file manifest includes the inherited 21-file extraction draft
and 14 additional Research files. It excludes all parallel Conversation/tool/i18n,
Host/runtime-adapter changes, INDEX, automatic-worktree plans and reports. It is
not a staging list or a claim that all 123 URLs are done.

- `.agent/architecture/OPERATION_CORE_ACCEPTANCE.md`
- `.agent/architecture/POLICY_ENFORCEMENT_INVENTORY.md`
- `.agent/architecture/PROJECT_RESEARCH_CALLS.md`
- `.agent/architecture/SYSTEM_ACTIONS.md`
- `.agent/modules/knowledge-base.md`
- `.agent/plans/operation-core/05-core-module-operation-migration.md`
- `apps/web/src/__tests__/conversation-scope-api.test.ts`
- `apps/web/src/__tests__/research-workspace-api.test.ts`
- `apps/web/src/api/client.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/operations.ts`
- `packages/protocol/src/policy.ts`
- `packages/protocol/src/systemActions.ts`
- `packages/protocol/src/knowledgeExtractionOperation.ts`
- `packages/protocol/src/researchWorkspaceOperations.ts`
- `packages/protocol/test/operations.test.ts`
- `packages/protocol/test/researchWorkspaceOperations.test.ts`
- `server/src/modules/knowledgePromotion/extractionService.ts`
- `server/src/modules/knowledgePromotion/reviewOperationRoutes.ts`
- `server/src/modules/knowledgePromotion/routes.ts`
- `server/src/modules/knowledgePromotion/extractionDispatch.ts`
- `server/src/modules/knowledgePromotion/extractionOperation.ts`
- `server/src/modules/projectResearch/areaRoutes.ts`
- `server/src/modules/projectResearch/areaService.ts`
- `server/src/modules/projectResearch/repository.ts`
- `server/src/modules/projectResearch/routes.ts`
- `server/src/modules/projectResearch/screeningCriteria.ts`
- `server/src/modules/projectResearch/workspaceErrors.ts`
- `server/src/modules/projectResearch/workspaceOperationRoutes.ts`
- `server/src/modules/projectResearch/workspaceOperations.ts`
- `server/src/modules/runs/orchestrationService.ts`
- `server/src/modules/systemActions/operations/routeInventory.json`
- `server/src/modules/systemActions/operations/runtime.ts`
- `server/test/knowledgeExtractionOperationDb.test.ts`
- `server/test/researchWorkspaceOperationDb.test.ts`

Shared hunks: client.ts only knowledgePromotionApi.extract and the six
projectResearchApi workspace helpers; protocol index/operations/systemActions
only extraction + Research imports/exports/schema/registry entries; policy.ts only
the new Research workspace policy definition; runtime.ts only their registration
imports and composition entries; routeInventory only the 9 exact method/path
classifications. orchestrationService.ts retains only the inherited extraction
pre-dispatch authority guards. No parallel Conversation/Host/schema hunk belongs
to this manifest.

Executed with Node 24.18.0 (isolated shared real PostgreSQL required, no fake DB):

- `pnpm run build:workspace-deps`: passed.
- `REQUIRE_TEST_POSTGRES=true pnpm exec vitest run test/knowledgeExtractionOperationDb.test.ts test/researchWorkspaceOperationDb.test.ts test/researchAreaDb.test.ts test/researchScreeningCriteriaDb.test.ts test/projectResearchIntegrityDb.test.ts test/operationRoutes.test.ts test/agentGuides.test.ts`:
  **7 files / 97 tests passed**, including 21 extraction and 16 new workspace
  tests at that invocation. No client concurrent-query deprecation remained.
- The final archived-Project admission fix moved the preliminary writer check
  to its existing allowArchived precheck, retaining the authoritative active
  aggregate lock/409 and initialized viewer inspection. Re-ran the affected
  `test/researchWorkspaceOperationDb.test.ts`: **17/17 passed**, including the new
  archived new-key/replay/viewer case. Other tests above are unchanged consumers.
- Protocol `test/operations.test.ts test/researchWorkspaceOperations.test.ts`:
  **2 files / 24 tests passed**.
- Web `src/__tests__/research-workspace-api.test.ts src/__tests__/conversation-scope-api.test.ts`:
  **2 files / 29 tests passed**. No matching `projectResearchSurfaces.test.tsx`
  exists; an earlier multi-pattern invocation did not run that nonexistent file,
  so no parent/visual test is claimed. Presentation components were not changed.
- Server `tsc -p tsconfig.typecheck.json --noEmit` and web `tsc --noEmit` passed.
  The web helper key parameters explicitly accept string keys (not the inferred
  UUID template type). Scoped diff whitespace checks passed. No schema change,
  migration generation, full suite, online data, staging or commit was performed.

Remaining implementation is still 114 baseline Project URLs, before the planned
single unified independent review. This evidence does not close a whole package,
P5 or a live Task, and does not transfer any production mapping/Agent authority.

### Project package continuation — initial limit and standing controls

Implemented another 3 exact retained routes: initial intake item limit, standing
advice dismiss, standing batch retry. Research is now **11/32**, ingress **1/14**,
Inquiry **0/21**, Folder/Experiment **0/24**, management **0/32**: total **12/123**,
**111 remain**. Formal remaining stays **525**; working projection **513**
(636 total = 528 legacy / 39 exempt / 69 core, excluding 15 plugin writes).
No unified review or package completion is claimed.

Reuse: extend the existing strict workspace DTO/adapter/registration mechanism,
use ProjectResearchOrchestrator.updateInitialItemLimit and the standing service
inside the core port. Initial-limit null workflow creates a genuinely new Workflow
once; old request replay never redirects to another/newer Workflow or resets its
limit. Standing retry preserves pending/running/completed behavior, writes only
the existing dispatch Job and never invokes a provider in the transaction.
Dismiss retains Project-writer-only cleanup, including a private/withdrawn Source;
its receipt contains no advice detail or Source body. Browser standing consumers
already refresh status and ignore the old mutation row; they now consume a safe
receipt. Limit editing follows the actual receipt Workflow through current GET.
Only the two specific retry conflicts and the specific active-limit conflict were
marked ResearchWorkspaceMutationError at their domain throw sites.

Self-owned file additions beyond the prior 35-file manifest: orchestrator.ts and
standingComparisonService.ts under server/src/modules/projectResearch (37 total).
Shared changes here: researchWorkspaceOperations protocol/schema and server port,
workspaceOperationRoutes paths/params, runtime passes config to the same DB-bound
writer, routes.ts retires three old handlers, client.ts switches the corresponding
three typed helpers, policy description and focused workspace PG/web tests. No
parallel Conversation/Host or schema file is owned by this continuation.

Verification: dependency build and server/web types passed. Related PG run:
researchWorkspaceOperationDb (20), projectResearchStandingDb (11), operationRoutes
(12): **3 files / 43 passed**. After the additional private-Source dismiss case,
workspace PG **21/21 passed**. Protocol workspace contract **1/1 passed**.
Standing parent surface test passed (2 cases); API mock reused a consumed Response,
fixed to return a new Response per fetch and rerun separately. No presentation or
visual change/acceptance, no full suite. No production approval mapping or new
Agent/public proposal decision authority; no stage/commit/push/deploy/online DB.

Final web rerun after fixing the response fixture: **2 files / 6 tests passed**
(API 4 + existing standing parent 2). Focused diff whitespace check passed.

## Parallel Project continuation — HTTP implementation and capability closure

The user's request explicitly authorized parallel agents for this continuation.
Three workers own Inquiry, Experiment/Folder and Project/Decision management;
the coordinator owns Research, monitoring controls and shared integration.
No per-family approval pause, staging, commit, push, deployment or product data
operation is included. Existing INDEX, worktree plans/reports and concurrent
Host/subscription work are preserved and excluded from this batch.

| Project group | Implemented HTTP URLs | Remaining HTTP URLs |
|---|---:|---:|
| Research | 13/32 | 19 |
| Inquiry | 21/21 | 0 |
| Experiment / Folder | 16/24 | 8 |
| Corpus / monitoring / Source ingress | 3/14 | 11 |
| Project / Decision management | 17/32 | 15 |
| Total | **70/123** | **53** |

This continuation adds **58** exact retained URL migrations to the inherited
12. The route inventory is **636 = 470 legacy + 39 exemptions + 127 core**;
excluding the unchanged 15 plugin URLs leaves **455** P5 legacy entries.
Formal committed HEAD and historical counts above remain their own snapshots.
These HTTP counts do not establish complete capability or package acceptance.

Reuse / Dependency Check: existing OperationExecutor/operationTransaction,
canonical domain services, Project/Thread/Source/content predicates and locks,
Proposal transitions, NoteWriter, Run/Job writers, Zod and shared PostgreSQL
fixtures are reused. No dependency, schema change, new execution/retry engine
or external execution inside core transactions is introduced. The only core
port extension is a readonly host-authored invocation context carrying the
already validated request ID/key, required to preserve trusted Agent call
provenance; it cannot be supplied through a business/model DTO.

The new user-facing contracts are strict and ungrantable. Formal adapters and
browser helpers use explicit event keys, body-free receipts and current reads
in the receipt Space. Old HTTP business handlers are retired for these exact
paths. Domain idempotency/history, Run/attempt provenance, review/role gates
and business uniqueness remain distinct from transport deduplication.

Research adds initial-intake draft saving and workflow-stage metadata records,
including current Workflow/Thread/Run gates and replay without reverting later
edits. Monitoring adds details and paused-state CAS through its existing writer:
version/query locks, lower-limit validation, Project/scheduler updates and core
audit commit together. Experiment launch retains atomic Run/Attempt/Job intent;
its worker executes externally. Folder closes metadata update/archive, Location
activation and execution-config create/update without filesystem/Host IO.
Management closes Project creation/member controls, six Brief/Instruction
version commands, private attention and seven Decision commands including the
atomic delivery Task. Inquiry HTTP closes its 21 listed routes; the overlapping
Agent tools require their separate grant/origin/provenance closure below.

Remaining scope is explicit: Research execution/planning/provider/checkpoint and
result workflows (19 URLs); Folder create/scan/unregister and five draft/history
operations (8); corpus, monitoring runs/proposals/reconciliation/feedback and
Source proposals (11); Project update/archive, focus, import/notebook, summary,
retrieval, reviews and updates/undo (15). Archive still requires the canonical
complete Run/Proposal terminal owner. No endpoint is retired merely to reduce
these counts, and no production approval mapping is enabled.

Verification from isolated real PostgreSQL (Node 24, no fake DB):
- Integrated HTTP batch: 10 server files / **105 tests passed**, zero skips:
  Inquiry 12, Project management 13, ingress 5, Experiment 21, Folder 9+8,
  route inventory 12, guides 8, boundaries 5 and hygiene 12.
- Research affected run: 5 files / **93 passed** (workspace 24, area 22,
  repository 17, rescan/drafts 18 and route inventory 12).
- Monitoring consumer plus route/guides/boundaries/hygiene: 5 files / **99 passed**
  (including 62 original monitoring cases). New ingress tests separately passed 5.
- Core invocation-context and existing core regressions: **68 passed** in
  operationExecutorDb, including immutable host identity and no reexecution on
  replay. The catalog fixture now includes the explicitly migrated contracts.
- Protocol focused run: 7 existing files / **58 passed**, no nonexistent-pattern
  file is claimed. Research browser API/parent surfaces: 4 files / **32 passed**.
- Management worker additionally ran kernel/members/decisions/integration;
  Experiment/Folder worker ran their protocol and existing parent UI consumers.
  Their final exact handoffs remain evidence for their scopes, not a full suite.
- The ordinary sandbox PG attempt could not reach the container runtime and ran
  no tests; the tool-approved shared-container runs above passed. No product
  database was used. Presentation components were not changed; no visual
  acceptance, full-suite pass or independent Claude/Antigravity review is claimed.

### Inquiry Agent closure in the same parallel batch

The five overlapping tools now use the same core under their existing IDs:
`inquiry.record_work`, `inquiry.close_round`, `inquiry.record_conclusion`,
`inquiry.link_task`, `inquiry.reference_task_result`. Their old callback executors
are removed. Separate Agent input contracts preserve original grants, effective
origin and domain producer/provenance semantics; they do not reuse a human
identity, accept caller Project/Run authority or add a new grant. Task calls use
the host-authored core invocation key plus the current Run attempt as before;
models cannot inject the trusted identity. Resolve discovers without row locks;
key reservation precedes authoritative lock/recheck. Both direct Dispatcher and
CLI use the existing dispatchRunOperation helper and core, not a second gateway
policy. No new production approval mapping is enabled; unattended calls return
canonical mapping-unavailable and create no Proposal or domain effect.

The first complete Agent run passed 4 real-PG files / **53 cases**: new Inquiry
operation tests 23 (including 11 Agent cases), original Task associations 10,
direct writes 10 and system-action gateway 10. This is additional capability
closure evidence, adding no HTTP inventory count. Core/Dispatcher regressions
also passed **72 cases** (executor 68 + Dispatcher 4). Server build including
bundled plugins and web production/PWA build passed. Five browser API files
passed **18 cases**. Web tsc passed at that snapshot; concurrent Host/subscription edits are preserved
and excluded from this Project batch.

The remaining 53 HTTP URLs and whole five-package independent review are still
pending. This closes the five overlapping Agent execution paths, not P5 or the
entire Project package. Final guide/type/fan-out checks follow their actual run
results below.

### Parallel Project continuation — lifecycle and durable effects

The next continuation adds 24 retained adapters. The current registered
projection is **94/123**. The exact method/path matrix and registered inventory
agree, with focused continuation evidence below:

| Group | Implemented HTTP adapters | Remaining legacy |
|---|---:|---:|
| Research | 16/32 | 16 |
| Inquiry | 21/21 | 0 |
| Experiment / Folder | 24/24 | 0 |
| Corpus / monitoring / Source ingress | 6/14 | 8 |
| Project / Decision management | 27/32 | 5 |
| Total | **94/123** | **29** |

The exact inventory is **636 = 446 legacy + 39 exemptions + 151 core**.
Excluding the unchanged 15 plugin writes leaves **431** P5 legacy entries.
This supersedes the working projection of 70/123 above, not its historical
verification. Committed HEAD 4ff817a7 still has 540 legacy entries (525 excluding
plugins). The concurrent Host/subscription commit and unrelated working changes
are preserved. No Project change has been staged, committed, pushed or deployed.

Reuse / Dependency Check: existing OperationExecutor, branded transaction,
canonical domain services, prepared Run terminal owners, policy/audit recovery,
PgJobQueue, Folder read/write CAS, private revision/draft stores and shared real
PostgreSQL fixtures are reused. No dependency or generic execution/retry engine
is added. Unlike the earlier 70-URL checkpoint, this continuation appends Drizzle
schema and generated migration `0016_project_folder_io_intents.sql` for private
Folder IO intent state. Core admission stores metadata receipts and required
Jobs; filesystem, Host and provider effects execute outside core transactions.

Project update/archive declare a core-host Run terminal discovery hook. The
executor pairs its actual transaction client with the branded domain port,
prepares the entire existing set before domain locks and finishes linked
transitions once after successful domain/output/request validation. Replay skips
this owner and cannot stop work created after reactivation. Unknown Run-set
growth rolls back with 409; a child cannot prepare itself or acquire late keys.
The existing concurrent synthesis regression now protects this exact-set rule
and confirms one execution/Run/Job, with later active-operation retry refused.

Research adds assessment confirmation, queued Ask AI and immutable report
snapshot admission. Ask AI and Notebook freeze private Source/Note provenance,
including historical assistant-message provenance, and check authority before
dispatch and publication. Snapshot executions and resumed leaves retain frozen
private visibility. Operation GET/list also apply current Workflow/Thread/Source
gates; hiding only the Run would leave private questions exposed in progress.

Folder adds draft upsert/discard/rebase, unregister with durable Host cleanup,
and create/scan/save/restore intent commands. Job payloads contain opaque intent
IDs; paths and source bytes stay in private state. Workers persist preimages
before IO, recover uncertain acknowledgements by exact hashes and refuse
independent edits. Unknown outcomes block a new same-scope write. Safe terminal
body cleanup must preserve the original draft/revision retention boundary.

Corpus upsert/update and the binding history-import proposal retain canonical
domain writers and separate transport/domain keys. History submission commits
Operation, Plan/segments and the pending owner Proposal together, without an
execution Job or approval mapping. Cross-checking found a cached-replay channel
retirement race; the expected-parent channel is now locked/rechecked after the
Project wait without acquiring a newly discovered Source parent late. Corpus
source-connection provenance and decision-channel closure now enforce live,
same-Space, non-oversight access and canonical-origin matching. Materialized
Objects retain their actual Source origins even before Project routing exists;
unreadable origins cannot be mistaken for a source-free manual Object.

Management additionally closes focus, combined review, Project work report/undo,
private queued Notebook, lifecycle controls and public-summary save/publish/revoke.
Summary owner/version/Run/Room gates remain. Publication, canonical search
projection, required embedding Job, receipt and mandatory audit commit together;
revocation removes the projection atomically.

Confirmed verification at this checkpoint (Node 24; isolated real PostgreSQL
for durable behavior, with pure/adapter checks counted separately):

- Core/Dispatcher/Synthesis/boundaries/migration artifacts: 5 files / **107 passed**
  (73 + 4 + 8 + 5 + 17). This includes the actual registered catalog.
- Research continuation: **77 real-PG cases** across workspace/confirmation/Ask AI,
  snapshot/existing synthesis/Source Evidence and frozen visibility restoration;
  Web API/ResearchAreaPage 13, protocol 4 and guide checks 8 passed.
- Project lifecycle: 3 PG files / **33 passed**. Management/summary/Notebook
  continuation: 5 files / **48 passed**, including 12 hygiene checks; summary
  protocol 5, browser API 9 and guide checks 8 passed.
- Source history/monitoring ingress: **13 passed**, including retirement while
  cached admission waits for the Project and five mandatory-store rollback cases.
- Corpus before cross-check tightening: **28 real-PG + 2 Graph unit cases passed**;
  browser API/Reading List/Project Sources 25 passed. The global-origin
  checkpoint passed **44 cases** in four files: Corpus operations 14, existing
  Academic Corpus 21 and snapshot 7 (42 real-PG), plus Graph 2 pure query tests.
  The final multiple-origin selection adjustment then passed the current
  **14 real-PG Corpus cases** again, including a second valid source, one hidden
  alternative and all origins hidden on both new/cached calls. Those consumer
  files were not rerun after that last narrow selection adjustment.
- Protocol combined run: 9 files / **66 passed**. Route inventory/guides/hygiene:
  3 files / **32 passed**. `schema:check` passed with 17 synchronized migrations.
- Folder IO final runs: real PG/FS 28, HTTP/atomic PG 24 and pure SQL/path 8,
  **60 passed** in total; browser API/FilesPage/controller 58, protocol 7 and
  guides 8 passed. This includes exact-hash redelivery, independent edits,
  authority withdrawal, cancellation fences and safe terminal body cleanup.
- Integrated server typecheck and build including bundled plugins passed.
  Web typecheck and production/PWA build passed. Final guide/inventory/hygiene
  checks again passed **32 cases** after the continuation guides were updated.

The remaining 29 exact routes stay pending in the finite matrix: 16 Research
execution/planning/checkpoint/result writes; eight Corpus/monitoring/Source setup,
proposal, run/reconcile or private-feedback writes; five imported extraction,
summary generation/search/feedback and retrieval-brief writes. Their blockers are
complete Source/Artifact authority closure, canonical Proposal/checkpoint owners,
or separating provider/embedding IO from transaction-owned admission. Existing
routes are retained. These implementation checks are not unified package review,
stage acceptance, production mapping or new Agent permission.

Final integration: current production code passed server typecheck/build with
bundled plugins, web typecheck/production/PWA build and `git diff --check`.
Folder's unavailable-PostgreSQL path still uses the shared fixture's explicit
test skip; no silent pass or fake fallback was introduced. Private IO intent
migration0016 has only been applied to isolated test databases. At that continuation checkpoint, full-suite verification and independent package
review had not yet run. Visual redesign acceptance and P5 completion were not
claimed; the 29 remaining implementation rows stay open.


## Current batch test repair and joint commit — 2026-11-08

This delivery combines the current P5 implementation with the latest native
workspace-integration fixes. It does not complete the 29 pending route migrations.
Temporary reports and generated build/cache files are excluded from the commit.

Legacy Proposal persistence tests now use the shared real PostgreSQL fixture,
including rollback after a driver-boundary INSERT failure and canonical apply
replay. Production transaction assertions remain intact. Source compatibility
mapping, takeover, pause and rollback lock Project, parent connections and then
channels; rollback locks all distinct parents in order. Real-PG lock barriers
cover the compatibility paths. Research no-oversight projections require full
primary-Thread content, including summary-only denial. Corpus global-origin
readability checks remain enforced on new and cached calls.

Final checks ran in the same native workspace with Node 24:

- Server: **7,428 passed, 5 existing smoke skips** across 597 files. The final
  CPU-bounded full run passed the unchanged performance budgets (import total
  29.7 seconds; test total 910.1 seconds). Earlier contended runs are not counted
  as passes.
- Web: **2,440 passed**; protocol: **439 passed**; Host: **656 passed, 22 existing
  environment/OS-smoke skips**. Agent CLI: **49 passed**; Folder Read: **54**;
  Outbound Guard: **52**; Reader Document: **12**.
- Chromium: **12 passed**, covering folded final replies and native integration
  in the original conversation across English/Chinese, phone/desktop and themes.
- Server, Web and Host typechecks/builds passed, including bundled plugins and
  the production/PWA build. Schema checks passed with **17 synchronized
  migrations**; no production migration or deployment was performed.

Claude and Antigravity independently reviewed the final implementation snapshot
and found no blockers. These were code reviews, not independent executions of
all suites; the coordinator ran the checks above. No performance threshold,
production authority guard or transaction requirement was weakened to pass.
