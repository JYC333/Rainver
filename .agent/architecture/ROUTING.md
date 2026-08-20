# Model–Runtime Routing

C2 routing is a deterministic server decision made before a run is dispatched.
It is not an LLM classifier and it does not grant permissions that the run
contract or runtime policy did not already allow.

## Decision flow

1. Candidate profiles are loaded for the run's agent and space. Credential
   availability is checked against the configured model-provider credential or
   a CLI credential selected only from the Run owner's enabled space grants.
   A conversation's explicit user × session binding pins both the runtime
   profile and that user's credential; an invalid or foreign credential produces
   no candidate and never falls back to another member's capacity.
2. Hard filters reject disabled/unimplemented profiles, missing capabilities or
   tools, insufficient sandbox support, incompatible execution mode, and a
   trust level below the risk requirement. File and code execution shapes are
   admitted on the candidate's declared `requires_file_access`: a runtime
   without it has no working directory to act in and is rejected with
   `execution_shape_incompatible`, and one with it must additionally carry a C3
   pass before serving those shapes. No adapter name appears in either
   condition. A candidate's declared minimum
   sandbox level must be at least the effective requirement; one-shot Docker
   is additionally gated by the runtime's explicit Docker capability. For a
   critical run, every local-CLI candidate is evaluated as requiring
   one-shot Docker even when the initial Run adapter is managed API; an unsafe
   local candidate is rejected before scoring so a safe fallback can win.
   Stronger isolation is eligible, weaker isolation is fail-closed. Security
   minima use the stricter of the run-derived requirement and any hint; hints
   cannot downgrade either.
   Managed runtimes retain their declared trust baseline; every local CLI has
   baseline `low`. A local CLI reaches at most `medium` only when the exact
   runtime version has a complete C3 pass and declares a runtime-config
   subagent disable mechanism. Every non-low local-CLI route therefore requires
   C3 pass; no adapter name is special-cased in any trust or admission decision.
   (Scoring is a separate matter — `execution_shape_default` below still keys on
   two adapter names.)
3. Remaining candidates receive a stable rule score. `scoreCandidate` returns
   nine additive terms and the highest total wins; there is no normalisation and
   no term that vetoes another. Ties resolve by pass rate, then profile id.

   | Term | Weight | Driven by |
   |---|---|---|
   | `execution_shape_default` | 30 | `executionShapeScore()` — matches `model_api` for conversational/structured shapes, conformant `opencode` for file/code shapes |
   | `profile_preference` | 25 | candidate matches `hints.preferred_runtime_profile_id` or the request's `runtime_profile_id`. Scored, not hard-required — when the request's profile is *explicit* the hard filter has already removed every other candidate, so this term only decides anything for a non-explicit profile |
   | `preference` | 20 | candidate's adapter type is in the requested or hinted adapter list |
   | `verification_pass_rate` | 0–20 | 90-day history, neutral 0.5 prior below three samples |
   | `cost` | −10..+5 | `max(-10, 5 - estimated_cost_usd)` |
   | `latency` | −10..+5 | `max(-10, 5 - seconds)` |
   | `latency_budget`, `cost_budget` | 4 each | candidate fits a hinted budget |
   | `default_profile` | 3 | `is_default` |

   Two consequences worth stating. The shape bonus outranks an explicitly
   hinted profile, so a preferred profile can lose to one the shape term
   favours — an *explicit* profile pin is a hard filter and is unaffected.
   And `request.adapter_types` is already a hard filter
   (`adapter_not_requested`), so its contribution to `preference` is redundant;
   that term does real work only for `hints.preferred_adapter_types`.
4. The sorted candidates become the persisted fallback chain. A3 consumes this
   chain when a retryable attempt fails: the next untried eligible profile is
   selected for the next physical attempt and stamped as a new attempt-scoped
   route decision. Routing still never silently retries a failed run; the
   Supervisor owns the retry decision.

Runtime capabilities are resolved from the selected profile's explicit
capability restriction when present, otherwise from the AgentVersion currently
attached to the agent. A runtime profile describes execution transport and
does not need to duplicate the agent's declared task capabilities.

`runs.capabilities_json` also carries declarations for server-owned System
Actions used to build the immutable Run tool-grant snapshot. Registered System
Action ids are removed before `required_capabilities` is evaluated because
they execute through the server's Agent Tool Gateway rather than the selected
runtime. Their authorization remains fail-closed through
`permission_snapshot_json`; non-System-Action capability ids continue to
participate in the runtime hard filter.

Persistent Project Folder availability is evaluated separately from a runtime's
minimum sandbox level. A file-access CLI whose adapter declares
`requires_workspace_for_execution=false` may be routed without a project
Folder for low/medium-risk work; execution then provisions an ephemeral
run directory. High-risk work requires a persistent Project Folder/worktree, while
critical local-CLI work uses the explicit one-shot Docker path. Managed/API
runtimes that do not access files continue to run without a Project Folder.

Hints are merged with provenance from task contract, workflow node, and
evolution strategy. They influence preference and stricter constraints only; a
hint cannot bypass credential, sandbox, policy, or trust filters. A manually
selected runtime profile is stamped as `explicit` and is a hard route pin;
default/automation/plan selections may be routed among eligible candidates.
When a user explicitly supplies a profile while starting a plan, that explicit
choice is propagated to its child runs as the same hard pin.

## Persistence and execution boundary

`route_decisions` stores the selected profile, candidate score trace, rejected
reasons, fallback chain, hint sources, baseline/effective trust, and C3 suite
evidence per physical attempt. `runs.route_decision_id` stamps the current run
route. `runs.requested_runtime_profile_id` remains immutable while current
selected route fields are refreshed per attempt. Historical verification rates use only runs with verification results in
the last 90 days and require at least three samples; candidates without enough
evidence receive the neutral prior. The selected profile snapshot is also refreshed on the run before
`markRunRunning`, so the existing policy and adapter layers execute the same
profile that the router selected.

`GET /api/v1/runs/:runId/route-decision` exposes the durable decision to the
space-visible run read path. A route with no eligible candidate fails closed and
never invokes an adapter. The decision row records `status = 'no_route'` and the
`route_no_candidate` reason, but the run itself terminates as
`run_orchestration_failed` — `RouteSelectionError` is not a
`RunPreparationError`, so the orchestration catch does not surface its code.

The C3 conformance suite remains the source for runtime-specific trust upgrades;
until it supplies evidence, the static adapter declarations and current trust
levels are used.

## What routing does not decide

Verified 2026-08-15. These are properties of the current implementation, not
intentions, and each is a trap someone has already fallen into.

**Routing selects a runtime profile row, nothing finer.** A candidate is one
`agent_runtime_profiles` row — adapter, model provider, model, runtime config —
with at most one credential resolved onto it. The query selects every profile
of that run's own agent; `enabled` and the adapter's `implementation_status`
are then applied as hard filters rather than as query predicates. Selecting a
row settles adapter, provider, model and credential at once; there is no way to
route one of them independently.

**The router never reads `model_provider_id` or `model_name`.** They are
carried on `RouteCandidate` and referenced nowhere in `router.ts`. Two profiles
differing only in provider are indistinguishable to it. A caller that needs a
specific provider or model therefore has no way to express that as a routing
requirement, and must pin the profile explicitly — which is why Project
Research pins, and why removing that pin would silently drop the user's
provider choice rather than free the router to honour it.

**Scoring only decides anything when a pool has more than one surviving
candidate, and the main producers of routing traffic pin.** A conversation pins
its profile through the user x session binding, and Project Research pins
because provider choice has no other expression (below). A pinned run's pool is
one candidate by construction, so the nine terms sum to a foregone conclusion
and no weight is falsifiable from its trace. Whether that is true of any
particular instance is a question for the instance, not for this document —
note that `ProjectResearchExecutionProfileService.ensureProfile` creates a new
enabled profile per distinct provider/model selection and never disables the
old one, so a `system_research` agent accumulates profiles even though every
one of its runs is pinned to a single one.

**The `required_tools` channel is live on the request side and unpopulated on
the candidate side, which makes it a trap.** `routing/repository.ts` passes a
hardcoded `[]`, but `hints.required_tools` has at least four producers, each an
unfiltered pass-through of client-authored JSON: a Task's `policy_json` via
`contractRouteHints`, a workflow node's `contract_json` via
`workflowExecutionService`, a plan node's `policy_json` via `plans/repository`,
and an automation's `config_json` via `targetSupport`.

Meanwhile `candidate.tools` reads `runtime_config_json.tools` / `tool_ids` /
`runtime_policy_json.tools`, and no server code writes any of those keys — a
user *can* set `runtime_config_json` when creating a runtime profile, but
nothing the system provisions carries them. So any of those four carriers
declaring a `required_tools` value rejects every system-created candidate with
`required_tool_missing`. `server/test/routing.test.ts` already exercises the
workflow-node carrier with this field.

The run then fails as `run_orchestration_failed`, not as `route_no_candidate`:
`RouteSelectionError` is not a `RunPreparationError`, so the orchestration catch
maps it to the generic code. `route_no_candidate` survives only inside
`route_decisions.status = 'no_route'` and its reason text. Anyone diagnosing
this from the run alone sees nothing about routing.

This is why wiring run tool grants into `required_tools` would break routing
rather than constrain it — the candidate side has to be populated first.

`required_capabilities` is the channel that works: it compares the run's
`capabilities_json` against the candidate's, resolved as described above —
profile restriction first, AgentVersion as fallback.

**Tool grants are not file capability.** The System Action Registry holds
domain operations — retrieval, memory, project summary, notes, knowledge,
delegation — and no file or execution tool, and CLI adapters reach it through
the same `AgentToolGateway` as the managed path. What separates the paths is
the sandbox, which is what `requires_file_access` names.

**Historical cost, latency and pass rate are grouped by `adapter_type`.** The
history CTE aggregates per adapter and joins on it, so two profiles on the same
adapter receive identical figures regardless of model or funding. Any per-
candidate cost reasoning has to introduce a finer grouping first. The cost
average is also mostly null in practice — CLI usage, models absent from the
catalog, and every row predating catalog-derived pricing contribute nothing —
and a null cost scores 0, so the `cost` term is usually inert as well. See
[TOKEN_USAGE_METERING.md](../../docs/TOKEN_USAGE_METERING.md) for which events
carry a priced value.

**The fallback chain is the scoring order, and it constrains retry admission.**
It is `scored.map(...)`. `hasFallbackRoute` reads it to answer whether a retry
has anywhere to go, and `retryRouteContext` feeds it back as
`fallback_runtime_profile_ids`, which is a *hard filter*
(`runtime_profile_not_in_fallback_chain`) — so the chain decides which profiles
a retry may legally use, not just whether one exists. Simplifying scoring away
would also remove the deterministic retry order.
