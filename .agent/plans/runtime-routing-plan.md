# Runtime Routing Plan

Date: 2026-08-13
Status: STAGE A READY, NOT SCHEDULED; STAGE B TRIGGER-GATED

Two claims in the original version of this document were wrong and are corrected
below: the router's cost signal is not a weak one, it is absent entirely; and
the argument against the `model_api` scoring bonus was based on a false premise.

## Purpose

Make the router decide from what a task needs and what capacity costs, instead
of from adapter names.

Two defects, with different prerequisites and therefore separate stages:

- **Stage A** — routing is written against adapter identifiers. `model_api` wins
  conversational work by name; `opencode` wins agentic work by name.
- **Stage B** — the router cannot see cost at all, and therefore cannot see that
  some capacity has already been paid for.

## Entry trigger

**Stage A** prerequisite was satisfied when the managed execution replatform
completed on 2026-08-14. Its implemented boundary is recorded in
[EXECUTION_MODEL.md](../architecture/EXECUTION_MODEL.md) and
[runtime-adapters.md](../modules/runtime-adapters.md).

**Corrected 2026-08-14.** The reason first given here does not survive contact
with the replatform's non-goals. It read: today every routing decision has
exactly one candidate, so rewriting the scoring function now means designing
against imagined candidates. True — but the replatform does not change it. It
explicitly does not install a CLI runtime ("that gate stands"), and it *merges*
`model_api` and `ts_agent_host`, so the candidate count goes from one to one.
P5's OAuth credentials do produce a second `(profile × credential)` candidate,
but the two are identical in execution capability and differ only in funding —
which is Stage B's dimension, not Stage A's.

The real reason is narrower and does hold: after the replatform, **tool grants
are the only thing deciding whether a run loops**, so "what this work needs" and
"what this candidate provides" become expressible in the same vocabulary for
the first time. Before it, the same question has two encodings — adapter
identity for the managed path, spec declarations for the CLI path — and a
requirements comparison written against both is a comparison written against
neither.

The consequence for the completion gate is stated there: Stage A must be
validated on the rejection path, because the selection path still has one
candidate.

**Stage B** additionally requires one funding channel that is not
pay-as-you-go — a subscription or prepaid token plan actually connected.
Otherwise `funding_mode` has a single value and the dimension cannot be
validated.

That trigger changed on 2026-08-13. It previously read "install a CLI runtime",
on the assumption that subscription capacity was reachable only through a vendor
CLI. The implemented in-process managed subscription channel carries
Anthropic Claude Pro/Max and OpenAI Codex ChatGPT Plus/Pro capacity without a
CLI profile; see [ADR 0008](../decisions/0008-credential-channel-isolation.md).
Subscription capacity therefore arrives without the CLI gate. Stage B is recorded in
[../tasks/deferred-register.md](../tasks/deferred-register.md) against the
corrected trigger.

Stage A is worth landing without Stage B. Stage B is not worth landing without
Stage A, because it would add a scoring input to a function whose primary term
is still an adapter-name bonus.

## Current implemented baseline

Verified against `master` on 2026-08-13.

### The scoring special cases

`routing/router.ts` — `executionShapeScore()` is thirteen lines and awards +30,
the single largest term in the scoring function:

- `conversational` or `structured_generation` + `adapter_type === "model_api"`
- `agentic_files` or `code_execution` + `adapter_type === "opencode"` and
  conformance passed

Every remaining term is small by comparison: verification pass rate maxes at 20,
default profile 3, latency and cost budgets 4 each. The adapter-name bonus
decides the route.

The second branch has never executed — `opencode` is not installed and its
conformance has never run. The first branch has never had a competitor.

**Correction to the original argument.** This document first claimed the
`model_api` branch was wrong because `model_api` is not an agent runtime. That
premise is false: `AgentToolGateway.execute` is called unconditionally from
`managedApiAdapter.ts:156`, so `model_api` runs a tool loop whenever the run
carries tool grants. Execution class is a property of the run, not the adapter.

The branch is still wrong, but for a narrower reason: it hands the largest
scoring term to an adapter *name* rather than to any property of the candidate,
so `model_api` also wins `agentic_files` work whenever no `opencode` candidate
is present — which is always, on this instance. A requirement that cannot be met
must reject, not silently settle for whatever is available.

`execution_shape` itself is a real declaration and is not the problem. It
arrives from `capabilities/workflowContract.ts` and `workflowAssets.ts`
(defaulting to `structured_generation`), from `agentGroups/service.ts` (pinned
`conversational`), and through `runs/runInputEnvelope.ts`. What is wrong is the
inference from shape to a named adapter.

### The cost signal

`routing/repository.ts:252` builds `estimated_cost_usd` as
`avg(usage.estimated_cost_usd)` over verification history from the last 90 days,
alongside average latency and a pass rate that requires at least 3 samples.

**Historical baseline, corrected 2026-08-13:** that average was over a column
of nulls. This document first described the cost signal as
historically-accurate but subscription-blind. Before managed replatform P3,
there was no cost signal at all.

`token_usage_events.estimated_cost_usd` was never populated. The
`UsageObservation` built after every provider call sets tokens and
`usage_accuracy` but not cost, and the pricing engine that would fill it has no
write path — `model_pricing_rules` has one reader and zero writers, so
`findPricingRuleForEvent()` always returned null. The replacement accounting
boundary is documented in
[TOKEN_USAGE_METERING.md](../../docs/TOKEN_USAGE_METERING.md).

Managed replatform P3 changes only new managed chat events: pi-ai catalog cost
now reaches `estimated_cost_usd`, while unknown custom models and non-chat
paths remain null. Historical rows are not backfilled. Consequently routing
can acquire a cost average after enough newly costed verification samples; its
previous decisions used trust, sandbox fit, conformance, the default-profile
bonus and the adapter-name bonus alone.

This changes the shape of Stage B rather than its direction. It is not "replace
a crude cost estimate with a better one"; it is "cost enters routing for the
first time", and it does so as a byproduct of the replatform writing pi-ai's
per-call cost into the ledger.

`RouteCandidate` in `routing/types.ts` carries: `estimated_cost_usd`,
`estimated_latency_ms`, `historical_verification_pass_rate`,
`credential_available`, `conformance_status`, trust levels, sandbox support, and
capability/tool lists. There is no funding, quota, or channel field.

### Quota state already exists — the router simply does not read it

This is the finding that most changes the shape of Stage B, and it contradicts
the assumption that a quota subsystem must be built.

`providers/cli/credentialBroker.ts` already implements the full cycle:

- `QuotaResult` carries `session_pct`, `session_resets`, `week_pct`,
  `week_resets`, `checked_at`, `available`, and `source`.
- `recordLiveQuota()` ingests Claude Code's `rate_limit_event` — `utilization`,
  `resets_at`, `rate_limit_type`, `is_using_overage` — as a byproduct of a run,
  tagged `source: "run_piggyback"`, exactly as ADR 0007 specifies.
- `refreshCliQuota()`, `listQuotaRefreshTargets()`, and an age check support a
  scheduled probe as the fallback path.
- `quotaForProfile()` is the read accessor.

And it already has a consumer. `autonomy/automationTarget.ts` reads
`quotaForProfile()`, takes `max(session_pct, week_pct)` as utilization, and
enforces `max_subscription_utilization_pct` as an autonomous-run admission gate.

So the system can already answer "how much of this subscription is spent". One
subsystem asks; the router does not.

**One structural obstacle.** `writeQuotaCache()` writes a JSON file to disk, not
a table. The router's candidate list is assembled by a single SQL query in
`routing/repository.ts`, which cannot join a file cache. Stage B must resolve
this deliberately — either the quota snapshot gains a table and the query joins
it, or the router enriches candidates through the broker after the query
returns. The second keeps the broker as the single quota authority and is
probably right, but it makes scoring inputs arrive from two sources, which
should be a decision on the record rather than an accident of implementation.

### The hardcoded research adapter

`projectResearch/executionProfileService.ts` pins
`const RESEARCH_ADAPTER = "model_api"`, referenced at five sites including the
profile lookup key. The comment states users may choose provider and model but
not runtime implementation.

The effect: the system's most developed long-running workflow cannot reach any
agent runtime regardless of what is installed or what the router would decide.
This contradicts ADR 0010's two-path position directly.

## Work — Stage A

### 1. Replace shape-to-adapter inference with declared requirements

Delete both `adapter_type` comparisons from `executionShapeScore()`. A route
requirement is expressed as what the work needs; a candidate advertises what it
provides; scoring compares the two.

**There is no `execution_class` to compare against, and there will not be.** An
earlier version of this plan expected the replatform to add
`execution_class × transport` to the adapter spec. That was dropped once it
became clear the property is run-scoped: the same adapter is a bounded inference
call without tool grants and an agent runtime with them. Writing the label onto
the adapter would repeat the current mistake with better vocabulary.

The comparison is therefore against capability the candidate actually
advertises, resolved for the run in question:

- `conversational`, `structured_generation` → any candidate that can produce a
  completion. Prefer the cheaper one where several qualify.
- `agentic_files`, `code_execution` → require a candidate that can be granted
  file and execution tools for this run. A candidate that cannot is not a
  low-scoring option here; it is ineligible and belongs in `RouteRejection` with
  a stated reason.

That last distinction is the substance of the change. The current code expresses
"agentic work prefers OpenCode" as a bonus, so a `model_api` candidate still
wins agentic work whenever OpenCode is absent — which is always, on this
instance. A requirement that cannot be met must reject, not silently settle.

A third requirement dimension joins those two, added 2026-08-14:

- **internal-delegation posture** — whether this candidate may spawn its own
  subagents during a run. A task that must not be decomposed by the runtime
  needs to be able to say so.

The system already holds this fact; it is simply in the wrong place. C3
conformance records subagent-attempt detection, and `ROUTING.md` makes "declares
a runtime-config subagent disable mechanism" a *condition on a trust upgrade*.
As a trust input it can only be reached indirectly, through risk level. As a
requirement it is directly expressible, which is what a task needs when the
reason it must not be internally decomposed has nothing to do with risk.

Write it into the vocabulary while the vocabulary is being written. Adding it
afterwards means reopening a scoring function that will by then be the only one
the system has.

**Declare the new dimensions on the live path, not the dead one.** Checked
2026-08-14. `execution_shape` has five producers and they do not share a fate.
The three live ones — `agentGroups/service.ts` (pinned `conversational`),
`runs/runInputEnvelope.ts`, and the router's own defaults in
`routing/repository.ts:441-448` — are untouched by other plans. The two in the
capability layer, `capabilities/workflowContract.ts:29` and
`workflowAssets.ts:105`, are already dead: both are reached only through the
built-in `WorkflowTemplate` registry, which returns an empty array in
production, and
[capability-shrink-plan.md](capability-shrink-plan.md) deletes the
`WorkflowTemplate` type outright. A new requirement dimension declared there
would be born unreachable and then removed by a plan that has no idea routing
started depending on it.

`conformance_status === "passed"` stays a condition on candidates that execute
tools with real side effects, but as a property of the candidate rather than
part of a named-adapter clause.

### 2. Rebalance the remaining terms

With +30 gone, the surviving terms decide routes for the first time and their
relative weights become load-bearing. Verification pass rate at 20, cost and
latency at ±10, budget bonuses at 4, default profile at 3 were calibrated in a
world where a single term dominated. Re-derive them against the two-candidate
case rather than inheriting them unexamined.

`preferred_adapter_types` in `RouteHints` and explicit runtime pins are
unaffected. An explicit user or workflow pin is a different mechanism from
inference and stays exactly as strict as it is.

### 3. Unpin Project Research

Remove `RESEARCH_ADAPTER`. Each research stage declares its own execution
requirement rather than the module declaring one adapter for all of them:

| Stage | Needs tools / turns? |
|---|---|
| query planning / expansion | no — one bounded call |
| bulk screening | no — one bounded call per item |
| schema extraction | no — one bounded call |
| exploratory analysis | yes |
| evidence synthesis | yes |
| critique / gap discovery | yes |

The right-hand column is the requirement, and it resolves to tool grants rather
than to an adapter label — which is also what makes it expressible after the
replatform, where a single managed path loops or does not depending on grants.

Stage decomposition stays in agent-space. This is not "hand Project Research to
an agent runtime" — it is the opposite: agent-space keeps the workflow and each
node routes independently. A runtime executes one bounded node.

The five call sites include a profile lookup keyed on the constant, so this is a
real change to how research execution profiles are resolved, not a constant
deletion.

## Work — Stage B (gated)

### 4. Add the funding dimension to the candidate model

New `RouteCandidate` fields:

```
funding_mode:        subscription_included | prepaid_token_plan | payg_api | local
quota_utilization:   0..1 | null      # from the broker; null when unknown
quota_resets_at:     timestamp | null
marginal_cash_cost:  number | null    # what this run costs beyond what is paid
```

`funding_mode` is a property of the access path, not of the runtime and not of
the provider. The same runtime reached through a subscription and through an API
key are different funding modes; the same provider reached through Pi and
through a vendor CLI likewise. It therefore belongs on the candidate — which is
already a (runtime profile × credential) pairing — and must not be folded into
`RuntimeAdapterSpec` or the provider record.

`marginal_cash_cost` replaces `estimated_cost_usd` as the primary cost term
without deleting it: historical average spend remains the input from which
marginal cost is derived for `payg_api`, and is near zero for
`subscription_included` while quota remains.

### 5. Score quota pressure, not just cost

Subscription capacity is finite, so treating it as free spends it on whatever
runs first. A subscription at 95% utilization with a reset three days out should
be reserved for work that needs it while cheaper channels absorb low-value
tasks.

Derive pressure from `max(session_pct, week_pct)` — the same reduction
`automationTarget.ts` already performs. Reuse it rather than inventing a second
definition, and if the shared derivation deserves a home, extract it to one
rather than copying the expression.

A stale reading is not a zero reading. `checked_at` and the existing age check
must gate whether the term participates at all; a quota snapshot from last week
should abstain, not report low utilization.

### 6. Record the two-source decision

Whichever resolution is chosen for the file-cache obstacle, state it in this
document and in the routing architecture document at the time it lands.

## Non-goals

- Not building a quota subsystem. It exists; this connects a second consumer.
- Not changing the CLI credential channel.
  [ADR 0008](../decisions/0008-credential-channel-isolation.md) already records
  the separate managed subscription channel; this plan consumes that boundary,
  it does not extend it.
- Not adding a user-facing routing configuration surface. The router explains
  its decision through `RouteRejection` reasons and score components, which it
  already does.
- Not implementing per-stage execution for anything other than Project Research.
  A general stage-level requirement mechanism is workflow work, not routing
  work.
- Not introducing `execution_class` / `transport` on the adapter spec. Dropped
  2026-08-13; see Stage A work item 1.
- Not populating cost. Managed chat already records pi-ai's per-call catalog
  cost as documented in
  [TOKEN_USAGE_METERING.md](../../docs/TOKEN_USAGE_METERING.md); this plan
  consumes the field.

## Completion gate

**Stage A**

Ordered 2026-08-14 by what actually discriminates. With one candidate in the
pool, the selection path cannot fail; the rejection path can, and it is where
this stage's substance lives.

1. **Primary.** An `agentic_files` request with no candidate that can be granted
   file and execution tools produces a rejection with a stated reason, not a
   route. Today it silently routes to the managed path.
2. **Primary.** A request declaring that it must not be internally decomposed
   rejects a candidate with no subagent disable mechanism, on the requirement
   rather than through a risk-level side effect.
3. `executionShapeScore()` contains no `adapter_type` string comparison.
4. Project Research executes at least one stage with tool grants and at least
   one without, in the same workflow run.
5. `RESEARCH_ADAPTER` no longer exists.
6. Routing architecture documentation updated in the same change.

Two conditions from the earlier draft were removed rather than reordered,
because with a single candidate they are true regardless of the change and
therefore assert nothing: "a `conversational` request still routes to the
managed path", and "`estimated_cost_usd` is non-null so the `cost` term
participates". The first is tautological; the second is a fact about the
replatform's ledger writes, verified there, and only becomes a routing
observation once two candidates differ in cost. Score components remain
readable in the recorded decision either way, which is what those conditions
were reaching for.

**Stage B**

8. Two candidates differing only in funding mode score differently, and the
   difference is attributable in the recorded score components.
9. A subscription above the utilization threshold demonstrably yields to a
   cheaper channel for a low-value task.
10. A stale quota snapshot abstains rather than scoring as unused capacity.

## Dependencies

- Requires: the completed managed execution boundary for Stage A (satisfied
  2026-08-14); one connected non-payg funding channel for Stage B.
- Unblocks: nothing else in the current plan set. Both scope work and capability
  work are independent of routing.
