# Deferred Register

Date: 2026-08-13
Status: every item here waits on a recorded trigger.

Merged on 2026-08-13 from three scattered registers — the Project / Inquiry defer
table, the hardening plan's watch table and trigger-gated sections, and the
capability plan's parked ideas. They were three lists of the same kind of thing
in three files, which is why nobody read any of them.

**Rule:** do not pull an item into active work without its recorded trigger, or a
newly observed correctness or security requirement that supersedes it. Real work
with no trigger belongs in [../plans/backlog.md](../plans/backlog.md).

## Project and Inquiry — usage-triggered

Audited 2026-08-08 and re-checked against the code on 2026-08-13; none is
implemented, as expected for trigger-gated items.

| Item | Trigger | Owner |
|---|---|---|
| A creation-time setup preset distinct from Mode and Sources | Two or more real Projects repeat the same setup, and the repeated state cannot be owned by Primary Mode, Project Sources/extraction profiles, a saved Workflow, or an owning Area | Projects + owning domains |
| Revisit the four-Mode taxonomy | A real Project cannot be classified by how its work advances as research, delivery, operations, or learning | Projects |
| Review cursor/chunking | Measured pending volume makes bounded complete-pool selection too slow/noisy | Inquiry / Knowledge Promotion |
| Thread labels/tags | Navigation or search use demonstrates the need | Inquiry |
| Adaptive Learning scheduling | Real review behavior supplies scheduling requirements | Learning |
| Retrieval Project scope in every recall arm | Large multi-Project results make endpoint post-filtering lossy | Retrieval |
| Shared graph composer/tier tags | A second non-`space_objects` producer or a behavior consumer exists | Graph |
| Additional typed Thread links | A concrete named relationship requires its own lifecycle | Inquiry / Experiments |
| Incident/Runbook aggregates | Demonstrated lifecycle is not owned by Tasks, Runs, Automations, or Activity | Operations |
| Generic conditional branching + Checkpoint migration | A second domain needs runtime-conditional checkpoints | Workflow engine |
| Move question refinement into a Model node | Pre-start refinement must become governed execution provenance | Project Research |

## Personal / team content boundary leftovers

[ADR 0013](../decisions/0013-personal-team-content-boundary.md) is implemented;
current-state behavior lives in the ADR and in
[Security and Access Boundaries](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md).
These three were left open deliberately: none blocks single- or two-person use,
and each needs a real second member before its shape is knowable.

| Item | Trigger |
|---|---|
| **Orphaned `private` rows after a member leaves a Space.** Their owner can no longer read them and no one else ever could, so they are unreachable but still counted, indexed, and backed up. Deleting them destroys content the person may return for; reassigning them hands their private material to someone else. | A member actually leaves a real shared Space |
| **Explicit consent to `oversight_mode` when joining an existing Space.** The mode is immutable and visible to members, but nothing makes a joiner acknowledge it before their content lands under it. | Someone joins a Space they did not create |
| **Detail-read auditing beyond the four wired types.** `recordDetailRead` covers Task, Activity, Artifact, and note/`space_object`; Run, Proposal, Agent, Reader annotation, and the Source types record nothing on a detail read, so a demotion disclosure for those reports no readers even when there were some. Mechanical to extend, but each addition is a write on a read path — extend on evidence. | A demotion disclosure for one of those types is actually consulted |

## Runtime and operations

| Item | Trigger |
|---|---|
| **Codex cancellation evidence.** Codex internal delegation is accepted rather than disabled (decision below), and `cancellation_reliability` is `best_effort` — whether internal agents stop when the main process is terminated is unverified, so a cancelled Run may still be writing. The `cancel_reliability` C3 probe already exists; it just cannot run without the binary. | A CLI runtime is installed into the sandbox image |
| **Funding-aware routing.** The router cannot see cost or funding, so it cannot see that some capacity is already paid for. Design below. The trigger is a configuration state, not a purchase: the candidate query returns one row per runtime profile with at most one credential attached, so a connected subscription alone produces no second candidate. | Two enabled runtime profiles on one agent, same adapter and model, differing in funding channel |
| **Let Project Research stage runs route.** Today they cannot: they pin, so their `route_decisions` rows record a foregone conclusion — no candidate comparison, no usable score trace, and **no fallback chain, so a failed stage cannot retry onto another profile**. Unpinning requires [backlog C3.2](../plans/backlog.md) first, because the pin is currently the only way a caller can insist on the user's chosen provider. Three pins must then go, not one: the `RESEARCH_ADAPTER` constant, the per-run explicit pin, and — decisively — Work Context binding, which derives `explicit` for any run whose Setup carries a runtime profile (`bindRunToWorkContext`, `applyEffectiveWorkContextBindings`). The third is correct for a conversation, where it keeps a run on its owner's credential, and wrong for a system-managed stage. Two constraints found during a reverted attempt: the research profile lookup cannot simply drop its adapter filter, because nothing guards the `system_research` agent against a user-added CLI profile that cannot serve its structured-output contract; and there are six stage run-creation sites, the sixth being the screen/extract stage in `sources/postProcessing`. | Routing can express a provider/model requirement |
| **Internal-delegation routing requirement.** A task that must not be decomposed by the runtime cannot say so: `subagent_disable_mechanism` exists on the candidate but there is no matching request dimension, and adding one needs a producer as well. Only local CLIs have runtime-internal subagents, so nothing it could reject exists yet. Dropped on 2026-08-15 from the routing admission work that shipped in `47efdf59`, for that reason. | A CLI runtime is installed into the sandbox image |
| **Retention and pruning design.** Append-only Run/Event/Evolution/usage data and Artifact storage need explicit retention semantics that preserve audit obligations, Proposal/Artifact provenance, and per-type policy. It cannot be a generic age-based delete job. | The database reaches a few GB, backups exceed 15 minutes, or real Run logs make growth materially visible |
| **Operations runbook consolidation.** One operator page covering service placement and health, backup/restore and host-loss recovery, runtime-tool and credential recovery, retry/alert/scheduler diagnosis, and safe stop and escalation boundaries. | Unattended hardening completes |

**Codex internal delegation is not required to be disabled** (decided
2026-08-13). Runtime-internal subagents do not widen the permission surface:
they run in the same worktree sandbox, the same freshly cleared `HOME`, behind
the same loopback provider proxy, and under the same Run cost cap, and
file-scope conformance judges the resulting worktree diff regardless of which
internal agent wrote it. What remains is attribution and cancellation quality,
and Codex is already priced for that — its `unknown` declaration makes the
subagent conformance check fail by construction, which pins every Codex route at
`low` trust. The spec keeps `unknown` because that is the truth; inventing a
verified value would be worse. This replaced a former acceptance blocker
requiring a disable mechanism or opt-in Codex; only the cancellation evidence
above remains gated.

## Runtime composition and generated code

Two architectural boundaries were recorded during the 2026-08-14 runtime
boundary audit. The non-trigger-gated registry work is complete; these remain
triggered boundaries, not backlog items. Nothing about them is "not yet built",
and pulling either in early costs an architecture, not a week. Current runtime
composition is recorded in
[runtime-adapters.md](../modules/runtime-adapters.md).

### Cordis / live runtime composition

**Trigger.** At least two real stateful runtime components need in-process
replacement, **and** switching only on the next Attempt or on process restart
causes a demonstrated product limitation. Or: generated runtime extensions
become a real, evaluated product capability.

Neither half is close. The registry inventory in the plan above found seventeen
contribution registries, all populated at boot from a static composition, none
registering in response to a user action, and nothing anywhere unregistering.
The one lifecycle that exists — `scheduler/registry.ts` — belongs to the task
loop, not to the registration.

Until the trigger fires: no Cordis dependency, no `RuntimeCompositionEngine`, no
Everything-is-a-Plugin migration, no live generated code in the main server
process, and no `Registration`/`dispose()` primitive added for architectural
symmetry.

**Record explicitly, because this is the expensive mistake:** a Cordis runtime
scope is not a Space, Project, or Domain scope. Runtime composition answers
"which code is loaded"; Space answers "who may read this". If the trigger ever
fires, the two must not be allowed to become one enum, one id, or one predicate.

### Generated executable lifecycle

**Trigger.** A real Automation or Workflow requires generated deterministic code
that cannot be expressed through the existing ActionNode, SystemAction, or
Workflow mechanisms, **and** there is observed reuse value — the same generated
thing wanted a second time.

The future lifecycle is conceptual only: Ephemeral → Candidate → Promoted
Executable Asset. Do not implement schema or runtime for it now, and do not
create the states in anticipation.

Until the trigger fires: generated one-off code stays Run/Attempt-scoped,
execution stays sandbox or subprocess based, promotion is never automatic, there
is no in-process `eval`, and none of it requires Cordis. The parked
**native capability executor** item below is the adjacent decision and stays
disabled on its own terms.

## Enablement gates

These are not deferred work. Each states what must be true before a capability
may be turned on, so they are stated as standing conditions rather than as the
state of any one instance — check the running instance for whether a condition
currently holds.

| Gate | Requirement |
|---|---|
| Enabling `autonomous_tick` (Always-on) | Provider-fallback and tool-degradation evidence must exist, because an autonomously launched Run has nobody reading its result. The `model_provider_mismatch` and `managed_tool_degraded` events serve this; no change may remove them while Always-on is enabled. |
| Any CLI runtime use | Install the runtime into the sandbox image, then run the C3 conformance suite for that runtime×version. Codex additionally carries the cancellation-evidence item above. This gate covers spawning a vendor CLI and nothing else: it does not gate subscription capacity, which reaches runs through the isolated in-process OAuth channel described by [ADR 0008](../decisions/0008-credential-channel-isolation.md). |
| Enabling retry or Always-on once cost is non-null | The Run retry cost cap (`runs/supervisor.ts`) and the autonomy daily cost limit were calibrated before catalog cost reached `estimated_cost_usd`. Re-check both against observed spend before enabling either feature, rather than discovering the thresholds by a run being refused. |
| Controlled product acceptance | Follow [../architecture/PRODUCT_ACCEPTANCE.md](../architecture/PRODUCT_ACCEPTANCE.md). Its OpenCode smoke section depends on the CLI gate above; the managed-API and Source sections do not. |
| Unattended dogfooding | [../plans/unattended-execution-hardening-plan.md](../plans/unattended-execution-hardening-plan.md) must pass its completion gate first. |

## Funding-aware routing — design

Carried over when `runtime-routing-plan.md` was retired on 2026-08-15. Nothing
here is scheduled; it is the design the trigger above unlocks. Current-state
routing facts live in [../architecture/ROUTING.md](../architecture/ROUTING.md).

### Rebalance the scoring terms

With one candidate the scoring function is inert, so re-deriving weights today
would be calibration against no observation. Two candidates that differ is the
first moment any weight is falsifiable.

Re-derive all nine terms together, including the two name-based ones
(`preference` at 20, and `profile_preference` at 25, which is *lower* than the
+30 shape bonus it can lose to). Deleting `executionShapeScore()` may be done
earlier as cleanup, but it is not a behaviour change and must not be recorded
as one. `request.adapter_types` and `request.runtime_profile_is_explicit` are
hard constraints and stay exactly as strict as they are.

### Add the funding dimension to the candidate model

```
funding_mode:        subscription_included | prepaid_token_plan | payg_api | local
quota_utilization:   0..1 | null      # from the broker; null when unknown
quota_resets_at:     timestamp | null
marginal_cash_cost:  number | null    # what this run costs beyond what is paid
```

`funding_mode` is a property of the access path, not of the runtime and not of
the provider. The same runtime reached through a subscription and through an
API key are different funding modes. It belongs on the candidate and must not
be folded into `RuntimeAdapterSpec` or the provider record.

`marginal_cash_cost` cannot simply be derived from `estimated_cost_usd`: that
average is grouped by `adapter_type`, so it mixes every funding mode and every
model on that adapter into one number. Either the history CTE gains a finer
grouping key or marginal cost comes from somewhere else. Decide this explicitly.

### Score quota pressure, not just cost

Subscription capacity is finite, so treating it as free spends it on whatever
runs first. A subscription at 95% utilization with a reset three days out should
be reserved for work that needs it while cheaper channels absorb low-value
tasks.

Derive pressure from `max(session_pct, week_pct)` — the same reduction
`autonomy/automationTarget.ts` already performs. Reuse it rather than inventing
a second definition; if the shared derivation deserves a home, extract it to
one. A stale reading is not a zero reading: `checked_at` and the existing age
check must gate whether the term participates at all.

### The quota cache is not joinable

`credentialBroker.writeQuotaCache()` writes a JSON file, not a table, and the
candidate list is one SQL query that cannot join a file cache. Either the
snapshot gains a table the query joins, or the router enriches candidates
through the broker after the query returns. The second keeps the broker as the
single quota authority and is probably right, but it makes scoring inputs
arrive from two sources — record whichever is chosen, here and in
[../architecture/ROUTING.md](../architecture/ROUTING.md).

### Definition of done

Carried from the retired routing plan. Each needs two candidates that
differ, which is what the trigger provides.

1. Two candidates differing only in funding mode score differently, and the
   difference is attributable in the recorded score components.
2. A subscription above the utilization threshold demonstrably yields to a
   cheaper channel for a low-value task.
3. A stale quota snapshot abstains rather than scoring as unused capacity —
   asserted by a test, not merely intended.
4. The `estimated_cost_usd` grouping question above is resolved and recorded,
   including how `cost_accuracy` (see
   [TOKEN_USAGE_METERING.md](../../docs/TOKEN_USAGE_METERING.md)) separates a
   genuine zero from an unpriced null, so uncosted runs are not treated as free.

### Out of scope when this is picked up

- Not giving the managed path file access. It has no working directory by
  design, a provider API has no file primitive, and a server-side `file.write`
  tool would be a worse version of what a CLI runtime does natively while
  turning an ungated mutation surface loose in the one path that currently has
  none. The related gap — a managed run cannot produce an artifact — is
  [backlog G1.4](../plans/backlog.md).
- Not building a quota subsystem. It exists; this connects a second consumer.
- Not changing the CLI credential channel.
  [ADR 0008](../decisions/0008-credential-channel-isolation.md) records the
  separate managed subscription channel.
- Not adding a user-facing routing configuration surface.
- Not introducing `execution_class` / `transport` on the adapter spec.

## Watch items

| Item | Trigger |
|---|---|
| Browser E2E coverage — note there is currently **none at all**: no Playwright config exists anywhere in the repo, so this is establishing a suite, not broadening one | Second real user, or a frontend regression that loses/corrupts data |
| TLS/rate limiting/CSRF hardening | Any move toward public internet exposure, currently forbidden |
| Multi-user sharing regression expansion | Second member joins a real shared Space |
| Private content carried into shared digests. Only `highly_restricted` is excluded from digests and maintenance outputs; ordinary `private` source content can reach a digest that its owner later shares by hand. Owned by the digest/context mechanism, not by any single digest producer (see [autonomy.md](../modules/autonomy.md)) | Second member joins a real shared Space |
| Offline queue — until then docs must not claim unsupported behavior | Real mobile/offline usage |
| Large-file/module splits | Next substantive edit to the affected oversized file |
| Master-key rotation | Suspected exposure or a future multi-instance requirement |
| Commercialization posture | A real external-user/product decision |

## Parked ideas

Not part of any implementation sequence. Do not pull one in without a separately
observed trigger.

- **OMO / oh-my-openagent integration** — benchmark/reference track only.
- **ML-based routing** — the deterministic Router remains authoritative.
- **Native capability executor** — keep disabled until separately designed and
  policy-gated.
- **Workflow canvas UI** — structured Plan/Workflow views remain sufficient.
- **AgentRunGroup extensions into a task graph** — keep AgentRunGroup as a
  collaboration surface. The delivered Room layer ([rooms.md](../modules/rooms.md))
  does not violate this: AgentRunGroup keeps its "one collaboration task"
  semantics and becomes a task opened inside a Room. Room is a persistent
  conversation container, not a DAG.

## Retirement

Remove an item when its trigger fires and the work moves to
[../plans/backlog.md](../plans/backlog.md) or lands, or when the item stops being
true. Retire this file when nothing remains.
