# Evolution Signal System

This document describes the current rule-based signal path.

## Ownership and storage

`evolution_signals` remains the single observation stream owned by the
`evolution` module. That table is the observation stream. Do not add a parallel
metrics or telemetry store. `EvolutionSignalEmitter` lives at
`server/src/modules/evolution/signalEmitters.ts`.

Signals are emitted only when an evolution target can be resolved. Evolution
runs resolve through `evolution_selector_decisions`; ordinary task, workflow,
and automation runs use a bounded source-keyed target
provisioner only when a failure, repeat, or threshold rule is actually present.
The provisioner creates one low/medium-policy target per source reference and
never starts an evolution run itself. Proposal signals use the creating
evolution run or an explicit proposal target reference. Unidentifiable direct
runs and unrelated proposals do not create orphan evolution signals.

## Current rule sources

| Source fact | Signal types | Current hook |
|---|---|---|
| A run is finalized with a failed or partial outcome | `run_finalization_failed` | `PostRunFinalizationService` |
| A completed finalization is requested again | `run_finalization_repeated` | `PostRunFinalizationService` |
| Summed `token_usage_events.estimated_cost_usd` reaches 80% of `contract_snapshot_json.max_cost` | `run_cost_threshold` | `PostRunFinalizationService` + `PgUsageRepository` |
| Observed duration reaches 80% of `contract_snapshot_json.max_duration_seconds` | `run_latency_threshold` | `PostRunFinalizationService` |
| A proposal is rejected | `proposal_rejected` | `PgProposalApplyService` post-commit callback (including Bundle reject) |
| No proposal status requests changes | `proposal_request_changes` | The emitter rule exists; no such status exists |
| A deterministic verification check fails | `verification_failed` | Emitted from finalized RunEvaluation verification facts; the verification engine owns result production |
| A supervisor records an outcome | `supervisor_outcome` | `PgRunSupervisor` emits after its durable decision |
| An autonomous Run exceeds its review wait bound | `supervisor_outcome` | `AutonomyRecoveryService` emits after cancellation and operational alert persistence |

Signals expose a triage state (`new`, `acknowledged`, `dismissed`, or
`actioned`) and support `PATCH /api/v1/evolution/signals/:signalId` plus the
convenience `POST /api/v1/evolution/signals/:signalId/dismiss`, which pins
`dismissed`. Triage is space-scoped and does not mutate system-wide signals.

Target create/edit (`POST /api/v1/evolution/targets`, `PATCH .../:targetId`),
manual signal creation (`POST .../targets/:targetId/signals`) and both triage
URLs are formal adapters over strict, keyed, human-only core commands
(`evolution.target.create|update`, `evolution.signal.create|triage`,
`evolution/operations.ts`). Authority is unchanged: any active member of the
Space, fenced by the executor's locked person check. A target edit locks the
Space-owned row (a system target is a 409 refusal, a retired type may only stay
archived); a signal share-locks its target; triage locks the signal. Receipts
carry ids only; clients reread through `GET .../targets/:targetId` and the
signal reader `GET /api/v1/evolution/signals/:signalId`. A replay is released
only while the Space can still read that target or signal.

`POST /api/v1/evolution/targets/:targetId/run` is the keyed core command
`evolution.target.run` (`evolution/assetOperations.ts`). It selects a strategy
and writes the queued dry-run Evolution Run, its review signal, the selector
decision and the `agent_run` Job intent in one transaction (`202`); the Run
executes in that Job, never in the request. The command share-locks the target
row before its first runnable read and holds it to commit — the target writer
(`updateTarget`) takes the same row `FOR UPDATE` first — so a concurrent
disable/archive either commits first and the start refuses (409), or waits until
the Run, decision and Job are committed. When no active strategy passes the
selector, the receipt is `status: not_selected` with the recorded selector
decision and reason, so that decision is kept instead of being rolled back with
a refusal. The web client surfaces it as `EvolutionRunNotSelected`; the
Evolution page shows a translated hint (not a failure) and reloads, so the
decision appears under Selection records, while a queued start shows the queued
toast and the Run appears in the Runs list after the same reload. A missing Agent, an Agent without a version, live mode or a Run
budget refusal is a deterministic 422/409.

Evolvable-asset writes are keyed core commands under the same owners
(`EvolvableAssetRepository`, `EvaluationHarnessService`,
`EvolvableAssetEvaluationRepository`, `RunWorkflowService`): asset create,
version create/edit/forward move, pin set/remove, evaluation case create (direct
or from a Run), evaluation evidence, evaluation case execution (the queued
evaluation run and its `evolvable_asset_evaluation` Job commit together),
promotion Proposal and workflow save from a Run (a draft within its risk bounds
or a `workflow_save` Proposal). Every command on an existing asset takes the
canonical asset lock (`lockEvolutionAssets`) before the owner reads the version
state, so the checks and the write hold until commit; asset creation takes the
Space asset-key lock. Owner refusals are the marked `EvolutionAssetRefusal`
class (409/422; a daily limit is a 409 conflict for that key); other errors stay
internal. Asset resolution and workflow-from-Run preview are read-only core
queries on their retained POST URLs. Every command or query that copies or
derives from a Run's body — evaluation case from a Run, evaluation of a
candidate Run, workflow preview/save from a Run and its child Runs — requires
full read access to each Run in the caller's own right (`bodyWithheld` on its
`getVisibleRun` level and `ownRunBodyLevel` = `full`, which excludes
oversight); summary-level or oversight-only visibility is a 422 refusal that
returns no body. Child Runs are listed by `listChildRuns` under the same
content, Room and domain read gates as `getVisibleRun`, so a child the caller
cannot discover contributes nothing and is not mentioned, and the
evaluation Job reads the gated candidate output internally. Receipts carry ids; clients reread
through the asset, versions, pins, evaluation-case and evaluation-run readers.

## Autonomous review consumption

The Evolution module registers `evolution_review` with the Autonomy candidate
registry. The discoverer selects `new` and `acknowledged` signals for active
space-owned targets after the Automation owner's durable successful-review
cursor. It links the exact set to a deduplicated candidate without changing
signal triage. A successful private review report marks only those links
consumed and advances the cursor transactionally; a failed or in-flight review
does neither. This consumption model is separate from manual triage.

Cost uses the finalization-time sum of `token_usage_events.estimated_cost_usd`
for the run. Duration uses the run's `started_at` to `ended_at` timestamps.
Unknown observations do not produce threshold signals.

## Evolution bundles

The evolution module exposes `/api/v1/evolution/bundles` for grouping visible,
pending ordinary proposals into one review context; the Inbox uses the same
visible-pending read model, so memory, code-patch, workflow-save, and other
reviewable proposal types are not hidden behind an evolution-specific prefix.
Incomplete `code_patch` proposals and granting-user `egress_review` proposals
are intentionally not bundleable: their confirmation/approval flows must stay
on their dedicated server endpoints. The Inbox uses the shared Proposal acceptance
result to display expired or superseded approvals as refusals.
`POST /api/v1/evolution/bundles` is the keyed core command
`evolution.bundle.create`; it locks every named Proposal, then checks
membership, in the operation transaction. Deciding (`/decide`, `/approve`,
`/reject`) and `/rollback` remain on the bundle routes: they are the canonical
Proposal decision path (`PgProposalApplyService` accept/reject with its policy
audit recovery, applier rollback/post-commit compensation and the durable
code-patch decision Job), the same owner as `/proposals/:id/accept|reject|rollback`,
and move with that family.
A bundle never replaces
the proposal apply boundary: each member is accepted or rejected through the
standard `PgProposalApplyService`, including its policy, role, risk, and
owning-domain applier checks. Members may be decided independently, so a
bundle can remain `partially_approved` while other members are still pending.
An active bundle exclusively owns its pending members: the ordinary proposal
accept/reject endpoints fail closed and direct reviewers to the bundle.

A single decision request is now one transaction for all selected DB members,
including their canonical applier results, Proposal/request transitions, member
snapshots, required Jobs and mandatory policy audits. The outer owner discovers
the entire selected/cascade/checkpoint Run set, takes sorted request keys and
nonwaiting closure fences before the Bundle/asset/domain rows. The previous
session gate around separately committed member decisions is retired. A request
may still intentionally select only some members; `partially_approved` describes
that explicit selection, never a failed subset of a multi-member decision.

A selection approving `code_patch` creates `evolution_bundle_decisions` plus a
required `evolution_bundle_decision` Job in one admission transaction. The
existing endpoints return HTTP202 and a safe `decision` summary while pending;
GET and the Inbox's Refresh decision show the retained status. Frozen payloads,
file roots and binary preimages are private ledger data, not response fields or
Job payloads. The original approver, member decisions and notes are frozen;
worker preparation and final canonical application both recheck live authority,
risk/owner/Source consent and the frozen inputs. No new human/Agent authority,
Proposal approval copy, operation key redirection or production mapping is added.
An identical retained decision replays its receipt; a changed frozen draft needs
its new Proposal id and a new decision, never reuse of the old receipt.

Only the existing worker performs file IO. Its DB-only preparation commits
before file preimages are read; preimages are persisted before any content write.
It reuses `CodePatchFileTransaction` path/protected-folder checks and atomic file
replacement, with per-Folder nonwaiting session coordination also used by the
standalone applier. Binary preimages and repeated-path sequential replacements
are preserved. A crash after a file write resumes from exact known content
boundaries without rewriting completed effects. The internal worker receipt
feeds the canonical code-patch applier's existing activity/snapshot/result writer;
that final DB transaction performs no filesystem IO. It commits the decision
receipt with all selected DB members and linked request results, or rolls all of
those DB changes back and recovers failed audits through the canonical helper.
The Job's live claim is checked before IO and locked through final DB commit.
Both Bundle and standalone patch workers also fence by the Job attempt number,
check ownership before compensation, and hold the claim through preparation.
An expired delivery cannot change an active intent or compensate its files;
immutable terminal receipts remain replayable without re-executing effects.

This is **not** cross-filesystem/database atomic visibility: files may be changed
while the receipt is `applying`. Failure starts durable `compensating`; recovery
restores only this intent's known content, in reverse path/member order, and
leaves independent edits untouched. A conflict becomes `compensation_failed`,
blocks further Bundle decisions and requires operator repair; it never reports the Bundle applied. Empty parent directories created
by the existing safe path helper can remain. Cancelled/exhausted/missing effect
Jobs receive one bounded cleanup Job on the existing recovery sweep; a failed
cleanup stays explicit, without an endless requeue. A compensated failed attempt
can use the existing Job retry cap. After that Job is exhausted, an explicit
resubmission rechecks canonical authority/frozen inputs and replaces only the
backing Job on the original intent; lost-response/concurrent submissions do not
create another live Job. A succeeded receipt is never re-executed. `failed` means no selected
member approval committed, not that every external filesystem observation was
reversible. Existing explicit Bundle rollback support remains limited to
promotion snapshots; code-patch members do not gain a new rollback permission.

For `evolvable_asset_version_promote` members, the bundle records a durable
pre- and post-apply snapshot of the asset's version status/scope set, system
version pointer, active pins, and active prompt deployment references. The
rollback first creates an `evolution_bundle_rollback` proposal and applies it
through the standard proposal policy gate in the same transaction. System-scoped
promotions therefore require owner-level approval, while lower-risk bundle
rollbacks remain subject to the normal owner/admin risk matrix. The API performs
rollback preflight and returns `rollbackable` plus `rollback_blockers`; no
rollback proposal is persisted when policy or preflight rejects the request.
Pending rollback requests are idempotently reused. The applier takes the bundle
row lock after Proposal/request admission, then sorted asset-level transaction advisory locks shared with
promotion apply, verifies that each asset is unchanged since the recorded
post-apply snapshot, restores approved members in reverse approval order (one
decision request approves its members in bundle order), and writes an
`evolution.bundle.rolled_back` activity record in the same transaction.
Snapshot capture itself takes the asset lock before reading any
asset/version/reference state, so the snapshot and promotion apply share one
serialized critical section. A mismatch or unsupported proposal type aborts the
transaction and leaves the bundle unchanged; no best-effort partial restore is
reported as success. Proposals without a supported rollback adapter can still
be grouped and individually reviewed, but such members are marked as
historical/released after a partial rollback and remain unavailable for a new
bundle. `rollback_supported` is only a boolean for approved members; other
member states return `null`.

## Deduplication and failure behavior

Each rule carries a source type, source id, signal type, and dedup window. The
payload stores a stable `dedup_key`. Insertion takes a PostgreSQL transaction
advisory lock for that target/source tuple in a statement of its own, then
checks the window and inserts in the same transaction (a lock and an
existence check inside one statement would let the second writer wait and
then act on a snapshot from before the first commit), so repeated
finalization or worker delivery does not flood the stream without requiring a
new migration or a second uniqueness table. Auto-provisioned targets are
created the same way, one per target key.

Signal writes are advisory telemetry. Finalization and proposal decisions
remain authoritative if signal persistence fails: finalization, proposal
decisions (emitted post-commit) and autonomy recovery catch and swallow a
signal failure outside any decision transaction. Supervisor decisions and their
`supervisor_outcome` signal are attempted on the same transaction-bound
`PoolClient`, where a signal failure is swallowed inside a savepoint, so a
signal cannot commit independently before a decision that later rolls back.

## Current boundaries

A successful run is not claimed to have passed acceptance criteria. Verification
facts are owned by the verification engine; finalized failed verification results
produce a `verification_failed` signal through the same bounded target and
deduplication path. Supervisor facts are owned by the run supervisor and emit
through the same bounded target/deduplication path. There is no
runtime-conformance emitter. Triage and dismiss are the signal routes above.
The proposal lifecycle has no `request_changes` status.

The inventory covers the current durable event classes. The manual
`review_requested` signal is an explicit user intent record, and the direct
signal-create route is an explicit ingestion surface; neither represents a
missing automatic performance emitter. There is no direct Artifact-edit
signal. There is no authoritative Artifact revision event to emit one from.

## Retired target kinds

Evolution supports Agent versions, Memory, Knowledge, Workflows, Project Folders
and system targets. Research stage ids never auto-provision targets. The two
legacy capability-layer target kinds and runtime-binding evolvable assets are
not registrations; their rows, versions and pins are archived by migration
`0004_remove_capability_layer` (its second part, originally `0005_retire_evolution_targets_and_rename_skills`), with reasons on the owning
rows. Historical labels and references remain readable only as archive data;
constraints prevent them from becoming active, and API create/update accepts
only supported target types. No retired target becomes a Skill. The Skill
library's own review/binding proposal path remains separate from Evolution.

Standalone Proposal accept/rollback now share the same purpose-specific
`projectFolders/codePatchEffects` implementation with the mixed Bundle worker.
Its optional internal restore/remove operations do not expand the public patch
schema. Bundle member ordering, frozen hashes, current decision authority,
conditional compensation, bounded cleanup and the single final member/request
transaction remain unchanged. There is still no transaction across filesystem
visibility and PostgreSQL, nor a second member business applier.
