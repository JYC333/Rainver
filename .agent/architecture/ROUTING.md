# Agent Runtime Profile Routing

Routing deterministically selects an eligible `AgentRuntimeProfile` before an
Agent Run is dispatched. It selects the deployment Profile as a unit; it does
not independently choose a model, credential, or Host, and it grants no
permissions.

## Candidate scope and authority

`PgRouteDecisionRepository` loads Profiles belonging to the Run's Agent,
validates Provider eligibility for the Run's responsible user, and resolves
the execution target from the Profile. An ordinary Agent Run admits any
Profile that names a complete execution target — Host, workspace mode and
installed copy — whether that Host is the built-in Server Runtime or a paired
Host; what the ACP runtime-authority cutover removed from this path is the
Conversation HostThread, not the paired Host. A Conversation or Task with a pinned Host thread is limited to
that thread's Host, workspace mode/location and runtime key. A Conversation
uses its persisted backend snapshot rather than rebinding to later Profile or
Provider edits, so `credential_available` is recomputed from that snapshot's own
backend mode and Provider instead of being inherited from the Profile's, and a
snapshot whose backend mode is neither mode is refused
(`conversation_backend_mode_invalid`) rather than read as `runtime_native` —
`session_conversation_backends` carries the Profile's backend-mode and binding
CHECKs on the columns it freezes.

Who may dispatch follows the Host's trust mode (ADR 0016 section 3): the strict
Server Host serves the instance, while a paired Host serves only its registered
owner, so a Profile on someone else's paired Host is rejected
`execution_host_not_permitted` rather than silently dropped from the candidate
set.

The candidate's `runtime_key` must resolve to an implemented ACP runtime. The
selected Profile determines the runtime, backend mode, Provider/model (when
`model_provider`), Host and installation. `AgentVersion` supplies task
capabilities and risk constraints only; it is not a fallback for missing
Profile fields. Capability declarations are read from the Agent's current
`AgentVersion` — a Runtime Profile is deployment authority and never restates
what the Agent may be asked to do. Credential eligibility is checked before
scoring, and an ineligible Provider does not fall through to another user's
credential.

The Profile's backend mode decides which credential that check asks about,
because it decides what the Run will spend:

| Backend mode | `credential_available` |
|---|---|
| `model_provider` | the Provider is enabled, granted to the Space, and holds a usable credential for the responsible user |
| `runtime_native` | the Profile names a Host, workspace mode and installation (B46); a runtime whose `credential_mode` is `none` needs nothing, and a local CLI that names no Host is refused |

A `model_provider` Profile is always Host-bound, so answering with the Host
alone would skip Provider eligibility entirely: a disabled Provider or a
withdrawn Space grant would pass routing and surface only at launch, after
dispatch, as `model_provider_not_found`. The gate instead persists a
`credential_unavailable` rejection, which is the same answer the pinned
Conversation path gives as `conversation_model_provider_unavailable`.

## Admission, scoring and retry

Hard filters reject disabled candidates, runtimes that are not implemented ACP
definitions, installations the execution Host has not reported healthy, Hosts
the responsible user may not dispatch to, unavailable credentials, explicit
runtime/profile mismatches, retry exclusions, missing required capabilities or
tools, unsupported execution mode, insufficient isolation, missing required
workspace/file access, and trust below the effective minimum. A critical local
CLI candidate additionally needs explicit one-shot Docker support. Risk and
hints can increase sandbox and trust requirements; hints cannot weaken the
Run's requirements. File/code execution shapes require a runtime that declares
file access. Low/medium-risk CLI work may use an ephemeral run directory where
no persistent workspace is required; high-risk work requires a persistent
workspace.

Profile state, runtime implementation and installation readiness stay three
separate rejection reasons — `candidate_disabled`, `runtime_not_runnable` and
`runtime_installation_not_ready` — because they need different repairs and an
asynchronous Server install must not read as a configuration error. Automation
preflight answers installation readiness with the same predicate
(`isRuntimeInstallationReady`), so it cannot admit a fire that routing will
then refuse.

### Effective trust

Effective trust is a property of the execution target the Profile is bound to,
not of the runtime registry. Current ACP Host-daemon dispatch does not apply
the legacy generated subagent-deny configuration, so a declaration that a
vendor supports a restriction is not proof that this Run received it, and no
runtime declaration raises a candidate.

| Execution target | Effective trust |
|---|---|
| Built-in strict Server Host (`hosts.kind = 'server'`) | at least `medium` |
| Paired trusted Host (`hosts.kind = 'remote'`), responsible user is the Host's `owner_user_id` | at least `medium` |
| Paired trusted Host (`hosts.kind = 'remote'`), any other responsible user | the runtime's baseline (`low` today) |
| No execution Host | the runtime's baseline (`low` today) |

The two `medium`s rest on different things. The Server Host's is an enforced
control: its daemon wraps every Run in a fresh rootless bubblewrap namespace
built from an empty root and an explicit bind allowlist (B62,
[ADR 0016](../decisions/0016-control-plane-execution-hosts.md) section 2). A
paired Host's is ownership: it is the responsible user's own machine, and they
extend to it the same trust they extend to a Run they start there themselves
([ADR 0016](../decisions/0016-control-plane-execution-hosts.md) section 3 and
its 2026-09-21 owner-trust amendment). That is a statement about who bears the
risk, not about containment — a paired Host still spawns natively with no
namespace, and no isolation claim follows from this level. A Run on that Host
by anyone else is not the owner's own and keeps the baseline; it is already
refused as `execution_host_not_permitted` before trust is reached. Routing
derives both from the one ownership fact `host_dispatch_permitted` records, on
the pinned Conversation path as well as the unpinned one.

Risk requires trust: `low` risk needs `low`, `medium` needs `medium`, and
`high`/`critical` need `high`. The product-default AgentVersion risk is
`medium`, so an ordinary Agent routes on the Server Host, and the same Profile
on a paired Host routes for that Host's owner and for no one else. No current
runtime or Host reaches `high`, so `high`- and `critical`-risk Agent Runs have
no eligible candidate on either Host.

### Scoring and retry

Every surviving Profile receives a deterministic additive score. The current
terms are:

| Term | Weight / range | Current behavior |
|---|---:|---|
| `profile_preference` | 0 or 25 | Requested or hinted Profile match |
| `preference` | 0 or 20 | Requested or hinted runtime-key preference |
| `verification_pass_rate` | 0–20 | Historical rate, with 0.5 neutral default |
| `cost`, `latency` | −10..+5 each | Estimated values when available; otherwise 0 |
| `latency_budget`, `cost_budget` | 0 or 4 each | Candidate fits a supplied budget |
| `default_profile` | 0 or 3 | Profile is marked default |

Ties resolve by verification pass rate, then Profile id. This is an additive
heuristic, not a learned classifier. Execution shape is an admission input, not
a scoring term: file and code shapes are filtered on declared capabilities and
file access, and no term rewards a Profile for a shape. Being the Agent's
default is worth `default_profile` and nothing more, so it cannot outrank the
Profile a caller explicitly preferred.

An explicitly selected Profile is a hard pin. A preferred Profile is only a
score; non-explicit dispatch may select another eligible Profile. On retry,
the persisted fallback chain constrains which untried Profiles can be selected.
Routing records a decision per physical attempt; the Supervisor, not the
router, decides whether a failed Run should be retried.

## Tool and capability channels

`required_capabilities` checks the candidate's capability declarations, which
come from the Agent's current `AgentVersion` and only from there. Registered
System Action ids are filtered out of runtime requirements because those
actions execute through the server-owned `AgentToolGateway`; their authority
comes from the Run's immutable permission snapshot and call-time policy checks.

The `required_tools` request/hint channel currently has an important limitation:
the repository supplies an empty candidate-side tool list, while client-owned
hints may still provide required tools. Such a hint can therefore reject every
candidate. Do not use it as an authorization mechanism or equate it with Run
tool grants. Any future use must define a server-owned candidate capability
source and retain the System Action authorization boundary.

## Durable decision and failure behavior

`route_decisions` stores the selected runtime Profile/key, Provider reference,
score trace, rejected reasons, hint provenance and fallback chain. The Run
records the requested Profile separately from the selected Profile and receives
the selected runtime key and Profile snapshot before execution.

`runs.runtime_profile_snapshot_json` is written through the one projection in
`sessions/runtimeProfileSnapshot.ts`, the same shape a Conversation binding
freezes, extended with the selected execution target. It therefore always
carries `backend_mode`: the provider-lease resolver, the execution-control
egress gate and Runtime Context planning all branch on that field, and a Run
missing it silently executes on the Host's native login instead of the
server-issued lease. A route with
no eligible candidate fails closed; no adapter is invoked. The public Run
failure may be more general than the detailed `no_route` reason persisted in
the route-decision row.

Provider id and model name are attributes of the selected Profile, not
independent dimensions in the scoring function. A caller that requires a
specific Provider/model must select the corresponding Profile explicitly.

See [AGENT_RUNTIME_AUTHORITY.md](AGENT_RUNTIME_AUTHORITY.md) for ownership and
[RUNS_AND_OUTPUTS.md](RUNS_AND_OUTPUTS.md) for the Run contract.
