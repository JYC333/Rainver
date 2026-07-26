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
   trust level below the risk requirement. A candidate's declared minimum
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
   C3 pass; no adapter name is special-cased.
3. Remaining candidates receive a stable rule score from explicit adapter/profile
   preferences, default-profile status, estimated cost and latency, and the
   historical verification pass rate. Ties resolve by pass rate and profile id.
4. The sorted candidates become the persisted fallback chain. A3 consumes this
   chain when a retryable attempt fails: the next untried eligible profile is
   selected for the next physical attempt and stamped as a new attempt-scoped
   route decision. Routing still never silently retries a failed run; the
   Supervisor owns the retry decision.

Runtime capabilities are resolved from the selected profile's explicit
capability restriction when present, otherwise from the AgentVersion currently
attached to the agent. A runtime profile describes execution transport and
does not need to duplicate the agent's declared task capabilities.

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
space-visible run read path. A route with no eligible candidate fails closed
with `route_no_candidate` and never invokes an adapter.

The C3 conformance suite remains the source for runtime-specific trust upgrades;
until it supplies evidence, the static adapter declarations and current trust
levels are used.
