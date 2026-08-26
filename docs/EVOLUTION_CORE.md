# Evolution Core

## Goal

Rainver keeps improvement loops inside the product boundary. The evolution
core records improvement targets, typed trigger signals, selected strategies,
reviewable plan artifacts, selector decisions, and validated experiences without
delegating the core lifecycle to an external optimizer.

The v1 scope is audit and review. It does not auto-apply changes, deploy code,
write active memory, mutate agent versions, or bind runtime skills directly.

## Core Model

| Concept | Purpose |
|---|---|
| `EvolutionTarget` | Product object or boundary that can be improved over time. |
| `EvolutionSignal` | Typed evidence that a target needs attention. |
| `EvolutionStrategy` | Reusable strategy asset with risk policy, matching signals, steps, and validation policy. |
| `EvolutionSelector` | Backend-owned selector that chooses an active compatible strategy and records why. |
| `EvolutionSelectorDecision` | Durable audit row for candidates, evidence, score trace, and rejection reasons. |
| `EvolutionExperience` | Validated experience distilled from accepted or observed outcomes. |
| `EvolutionSolidifier` | Service that records validated experience and updates strategy counters. |

## Strategy Assets

Strategy assets live in `evolution_strategy_assets`. Built-in system strategies
are seeded in `0001_baseline.sql`; space-specific strategies use the same table
with `space_id` set. System and space keys are separately unique.

Built-ins:

- `repair.runtime_failure`
- `repair.validation_failure`
- `optimize.prompt_asset`
- `optimize.tool_usage`
- `harden.policy_boundary`
- `improve.capability_gap`
- `review.open_skill_import`
- `maintain.memory_health`
- `maintain.knowledge_retrieval`
- `solidifyExperience.successful_run`

## Run Flow

`POST /api/v1/evolution/targets/:targetId/run`:

1. Loads the target in the caller's space.
2. Requires `agent_id` from the request body or `target.metadata_json.agent_id`.
3. Reads recent target signals and active system/space strategies.
4. Uses `EvolutionSelector` to choose a strategy under target risk policy.
5. Builds an `evolution_plan.prompt.v1` system/user prompt from the target,
   selected strategy, selector trace, and evidence.
6. Creates a real `runs` row with `run_type = 'evolution'`.
7. Records a `review_requested` signal.
8. Persists an `evolution_selector_decisions` row.
9. Stores the final prompt on the run with the selector decision and request
   signal ids included.
10. Writes an `evolution_plan.v1` artifact.
11. Marks the run `waiting_for_review`.

Evolution v1 only accepts `mode = "dry_run"` for this route. `live` execution is
rejected because v1 produces review plans, not direct behavior changes.

## Prompt Contract

`buildEvolutionPlanPrompt` is the v1 prompt builder for Evolution runs. The
system prompt defines the product boundary: use only provided evidence, do not
apply changes, do not mutate memory, knowledge, capabilities, agent versions,
policy, files, or runtime skill bindings, and route durable changes through an
existing `ProposalApplierRegistry` type plus review.

The user prompt carries the target, selected `EvolutionStrategy`, selector
decision, evidence signals, and an `rainver.evolution_plan_review.v1`
output schema. It asks for a JSON-only review plan with risk assessment,
evidence summary, proposed steps, validation checks, proposal boundary, and
candidate experience lessons. The prompt includes the allowed
`ProposalApplierRegistry` proposal types as data, so the model does not invent
unregistered apply paths. Unsupported `prompt_update` and `agent_config_update`
changes remain review artifacts until appliers exist.

No fake `succeeded` status or placeholder proposal ids are returned. If a change
can use an existing `ProposalApplierRegistry` proposal type, a later service may
create that proposal. Unsupported `prompt_update` and `agent_config_update`
remain review artifacts until appliers exist.

## Experience Solidification

Validated outcomes can be distilled into `EvolutionExperience` rows. The
solidifier stores lessons, anti-patterns, execution/validation traces, and
environment fingerprints. It updates the selected strategy's success/failure
counters and confidence score, but it does not mutate behavior from experience
alone.

The current lifecycle hook runs after post-run finalization: if the finalized
run has an `EvolutionSelectorDecision`, the run evaluation is recorded as an
idempotent `run_observed` experience keyed by strategy and run. Accepted
proposal and manual observation entry points are service methods; proposal
acceptance does not yet automatically create an Evolution experience.

## Validation Results

`GET /api/v1/evolution/validation` returns deterministic backend-owned
validation results from `target.metadata_json.validation.metrics`. The current
implemented evaluator is `count_signals`; unsupported evaluators are surfaced as
`status = "unsupported"` rather than hidden.

## Memory Boundary

Memory remains proposal-gated. The evolution core can produce maintenance
packets or review artifacts for memory health, but it does not directly write,
archive, or supersede active `MemoryEntry` rows.

Content read traces and retrieval quality signals can feed strategy selection
and experience records. They do not bypass `ContentReadTrace`, cross-person
content-access auditing, source monitoring, or proposal approval.
