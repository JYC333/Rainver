# Evolution Signal System

This document describes the current rule-based signal path. It is the D1
foundation for the later evaluation, supervisor, and conformance consumers.

## Ownership and storage

`evolution_signals` remains the single observation stream owned by the
`evolution` module. D1 reuses the existing table and does not add a parallel
metrics or telemetry store. `EvolutionSignalEmitter` lives at
`server/src/modules/evolution/signalEmitters.ts`.

Signals are emitted only when an evolution target can be resolved. Evolution
runs resolve through `evolution_selector_decisions`; ordinary task, workflow,
automation, and capability-backed runs use a bounded source-keyed target
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
| Summed `token_usage_events.estimated_cost_usd` reaches 80% of the A1 contract maximum | `run_cost_threshold` | `PostRunFinalizationService` + `PgUsageRepository` |
| Observed duration reaches 80% of the A1 contract maximum | `run_latency_threshold` | `PostRunFinalizationService` |
| A proposal is rejected | `proposal_rejected` | `PgProposalApplyService` post-commit callback (including Bundle reject) |
| A future proposal status requests changes | `proposal_request_changes` | Emitter rule is ready; no such current status exists |
| A deterministic verification check fails | `verification_failed` | Emitted from finalized RunEvaluation verification facts; A2 engine owns result production |
| A supervisor records an outcome | `supervisor_outcome` | `PgRunSupervisor` emits after its durable decision |
| A runtime conformance check fails | `runtime_conformance_violation` | `RuntimeConformanceService` emits after persistence |
| An autonomous Run exceeds its review wait bound | `supervisor_outcome` | `AutonomyRecoveryService` emits after cancellation and operational alert persistence |

Signals expose a triage state (`new`, `acknowledged`, `dismissed`, or
`actioned`) and support `PATCH /api/v1/evolution/signals/:signalId` plus the
convenience `POST /api/v1/evolution/signals/:signalId/dismiss`. Triage is
space-scoped and does not mutate system-wide signals.

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

## Evolution bundles (D3)

The evolution module exposes `/api/v1/evolution/bundles` for grouping visible,
pending ordinary proposals into one review context; the Inbox uses the same
visible-pending read model, so memory, code-patch, workflow-save, and other
reviewable proposal types are not hidden behind an evolution-specific prefix.
Incomplete `code_patch` proposals and granting-user `egress_review` proposals
are intentionally not bundleable: their confirmation/approval flows must stay
on their dedicated server endpoints.
A bundle never replaces
the proposal apply boundary: each member is accepted or rejected through the
standard `PgProposalApplyService`, including its policy, role, risk, and
owning-domain applier checks. Members may be decided independently, so a
bundle can remain `partially_approved` while other members are still pending.
An active bundle exclusively owns its pending members: the ordinary proposal
accept/reject endpoints fail closed and direct reviewers to the bundle.

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
advisory lock, then sorted asset-level transaction advisory locks shared with
promotion apply, verifies that each asset is unchanged since the recorded
post-apply snapshot, restores approved members in reverse bundle order, and
writes an `evolution.bundle.rolled_back` activity record in the same
transaction. Snapshot capture itself takes the asset lock before reading any
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
advisory lock for that target/source tuple and checks the window atomically,
so repeated finalization or worker delivery does not flood the stream without
requiring a new migration or a second uniqueness table.

Signal writes are advisory telemetry. Finalization and proposal decisions
remain authoritative if signal persistence fails; a signal failure is
swallowed inside a savepoint. Supervisor decisions and their
`supervisor_outcome` signal are attempted on the same transaction-bound
`PoolClient`, so a signal cannot commit independently before a decision that
later rolls back.

## Deferred boundaries

D1 does not claim that a successful run passed acceptance criteria. Verification
facts are now owned by the A2 engine; finalized failed verification results
produce a `verification_failed` signal through the same bounded target and
deduplication path. Supervisor facts remain owned by A3 and runtime
conformance facts by C3; both production hooks emit through the bounded
target/deduplication path. The D1 triage/dismiss surface is now present;
proposal `request_changes` remains a future status because the current proposal
lifecycle has no such state.

The D1.1 inventory is complete for current durable event classes. The manual
`review_requested` signal is an explicit user intent record, and the direct
signal-create route is an explicit ingestion surface; neither represents a
missing automatic performance emitter. Direct Artifact edit evidence remains
D1.2 (see [../plans/product-capability-followups-plan.md](../plans/product-capability-followups-plan.md))
because there is not yet an authoritative Artifact revision event.
