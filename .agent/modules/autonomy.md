# Autonomy

## Ownership

`server/src/modules/autonomy/` owns the durable candidate registry,
materialization, deterministic ranking, tick audit, and the
`autonomous_tick` native Automation target. Automations decides when the tick
runs; Autonomy decides what durable candidate facts exist. Domain modules
register discoverers with `autonomyDiscovererRegistry`; Autonomy does not
import domain implementations.

## Candidate lifecycle

The enabled kinds are `periodic_digest` and `evolution_review`. The Projects
module registers the digest discoverer and filters active Projects through the
owner's Project read ACL. Its logical key is Project plus UTC day, and its
durable fact reference pins the Project `updated_at` value.

The Evolution module registers the review discoverer. It reads active,
space-owned targets and `new` or `acknowledged` signals after the owner's last
successful review cursor. Five accumulated signals trigger a review by
default; an `error` or `critical` signal triggers immediately. The exact signal
set is hashed into the candidate key and linked through
`autonomy_candidate_evolution_signals`. Dismissed and already-cursor-consumed
signals are excluded.

One observe tick writes:

- an `autonomy_ticks` coordinator audit, including zero-candidate ticks;
- one deduplicated `autonomy_candidates` row per logical candidate;
- one `autonomy_tick_candidates` decision row per tick/candidate encounter.

Ranking is deterministic: score descending, then kind and key. Repeated and
concurrent ticks use the candidate unique key and cannot duplicate logical
work. Existing admitted/launched/terminal candidate state is not overwritten
by a later observation. `last_seen_tick_id` remains observational history;
`launch_tick_id` is fixed when a Run is admitted and is the sole coordinator
settlement/provenance key, so observing an in-flight candidate cannot orphan
its original coordinator.

The observe tick and all candidate/link writes share one transaction. A process
failure therefore rolls back the entire tick instead of exposing a recoverable
half-materialized state. Observe-only ticks never create a Run.

## Bounded launch

An `autonomous_tick` Automation may set `observe_only=false` with a complete
`autonomy_budget`. Any active Space member enables and configures their own
tick through the self-service `.../automations/autonomy` routes — see
[automations.md](automations.md). Each fire creates a
private coordinator Run and `automation_runs` audit, then admits each
materialized candidate independently. Admission re-locks the candidate,
rechecks Project ACL and the Automation credential grant, enforces the
Automation contract and autonomous day pool, validates fresh CLI subscription
utilization, and atomically writes the decision plus queued execution Run/job.
One refusal does not roll back sibling outcomes.

Execution Runs use `trigger_origin='autonomous'`, carry the Automation owner as
`instructed_by_user_id`, remain owner-private, and are independent autonomous
roots linked to the coordinator through `parent_run_id`. They may receive only
declared read-only retrieval grants; `authorization.request` and side-effecting
system actions are removed from their immutable permission snapshot.

A terminal successful candidate creates one immutable private report
(`autonomous_periodic_digest` or `autonomous_evolution_review`) and persists
candidate → Run → Artifact provenance. Evolution links are marked consumed
and `autonomy_review_cursors` advances only in the same successful
finalization transaction; signal triage state is unchanged. Candidate
reconciliation is idempotent and settles the coordinator when all launched
children are terminal.

The scheduler runs `autonomous_review_timeout_recovery` every five minutes.
Autonomous Runs left in `waiting_for_review` for an hour are cancelled
idempotently, pending authorization requests are rejected, and an operational
alert plus evolution signal are emitted.

## Boundaries

- Candidate facts are system-produced; callers cannot submit candidate rows.
- Identity is the authorizing Automation owner.
- A candidate records whether its kind may require interactive authorization.
- Candidate-kind handlers own discovery, launch instructions, report shape,
  and completion projection through the exact-coverage registry.
- Evolution review uses the same lifecycle rows and launch path. It can only
  produce a private report; its prompt may recommend a standard Proposal for
  later human review, but the autonomous Run has no mutation or proposal tool
  grant and cannot directly change Capability, Memory, or evolution assets.
- Enablement is self-service and self-scoped, not an admin/owner privilege: any
  active Space member can enable, read, and reconfigure only their own tick
  through `automations`' dedicated routes (see automations.md). The
  `autonomy` module itself never authorizes anything; Automations owns that
  policy carve-out (`ruleAutomation`'s `autonomous_tick` + `actor_is_owner`
  branch), scoped so it can never reach another member's tick.
- A failed launched candidate (e.g. `evolution_review`) is retried on its next
  materialization if its durable fact set — and therefore its candidate key —
  is unchanged: `'failed'` is a revertible pre-launch state, not a terminal
  one. Only `'completed'` is final for that fact set.

## Related files

- `server/src/modules/autonomy/`
- `server/src/modules/projects/autonomyDiscoverer.ts`
- `server/src/modules/evolution/autonomyDiscoverer.ts`
- `server/src/db/schema/autonomy.ts`
- [automations.md](automations.md)
- [RUNS_AND_OUTPUTS.md](../architecture/RUNS_AND_OUTPUTS.md)
