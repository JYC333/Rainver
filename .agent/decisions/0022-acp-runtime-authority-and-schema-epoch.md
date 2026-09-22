# ADR 0022: ACP Runtime Authority And Schema Epoch

Date: 2026-09-20

## Status

Accepted and implemented. The phased implementation and its three
independent review-and-repair rounds completed on 2026-09-21; the execution
ledger was retired into the current-state guides and git history. Current
behavior is described by `architecture/AGENT_RUNTIME_AUTHORITY.md`,
`architecture/ROUTING.md`, `architecture/RUNS_AND_OUTPUTS.md`,
`architecture/GLOSSARY.md`, `modules/agents.md`, `modules/hosts.md`,
`modules/runtime-adapters.md` and `server/migrations/README.md`.

Two consequences of this decision are still open work, recorded in
`plans/backlog.md`: the queued research stages (monitoring comparison,
brief synthesis and its critique) still run as `agent` Runs on a
manufactured `model_provider` Profile until the bounded ProviderTask helper
can materialize their artifacts; and `high` effective trust is undefined, so
`high`/`critical`-risk Agents have no eligible execution target until a
revocable Host-owner grant exists. Push, deployment, publication and the
reset of running instance databases to the new epoch remain separate
operator actions; a database from before the epoch has no upgrade path
(B59, `server/migrations/README.md`).

Supersedes the `allowed_adapter_types` runtime-policy statements in
[ADR 0002](0002-agent-model.md) (decision 1 and its consequence) — AgentVersion
carries no runtime selection, and the key is refused in a Profile option bag —
and the managed `model_api` / `ts_agent_host` runtime sentence in
[ADR 0010](0010-agent-workbench-product-direction.md), whose runtimes no longer
exist: bounded managed API work is a `provider_task` Run in the Provider
subsystem, not an Agent runtime. The rest of both decisions stands.

## Context

Rainver currently has several overlapping runtime authorities. Agent versions
carry provider/model and runtime-policy data; Agent Runtime Profiles carry a
second copy; Hosts expose a host-global default; and the Server still contains
managed API and managed Agent-loop branches alongside the ACP host path. The
wire contract calls runtime identity `adapter_type`, which also names genuine
adapter-internal concepts. These overlaps allow fallback precedence to change
an Agent without an explicit Profile change and make a Run's execution shape
ambiguous.

The implemented Claude, Codex and OpenCode CLI paths already use the shared ACP
controller. Provider-backed ACP already materializes a Run-scoped proxy config
and short-lived lease without releasing the upstream key. The replacement must
strengthen those boundaries, not introduce another protocol or credential
channel.

## Decision

### 1. Control-plane authority

`AgentVersion` is immutable Agent-definition authority: prompt, provenance,
context and memory policy, capabilities/tool permissions, output and schedule
policy, risk classification, and execution limits. It does not select a
runtime, Host, ModelProvider, model, or runtime-specific option.

`AgentRuntimeProfile` is mutable Agent deployment authority, keyed to
`(space_id, agent_id)`. It selects a registry-backed `runtime_key`, execution
Host, concrete installation, workspace binding, and exactly one backend mode:

- `runtime_native`: use the runtime's native state on the selected Host;
- `model_provider`: use a same-Space ModelProvider and explicit model through
  Rainver's existing proxy and short-lived lease.

Profiles are stable when a new AgentVersion is published. A Run resolves and
freezes both the current AgentVersion and selected Profile before dispatch.

### 2. ACP runtime boundary

Rainver has one `AcpRuntimeAdapter` execution implementation. A
`AgentRuntimeDefinition` is a code registry entry keyed by stable dynamic
`runtime_key`; it owns only runtime-varying command, installation, probe,
login, capability, and option facts. Unknown keys and definitions without ACP
support fail closed. OpenCode is the reference/default definition, not a
privileged database type.

The Server retains bounded model calls. They are either incidental
ProviderTask ledger entries or explicit `provider_task` Runs when Run lifecycle,
retry, artifacts, or verification are required. They never acquire fake Agent
or Runtime Profile references.

### 3. Run shape

`runs.execution_kind` is explicit and has exactly two values: `agent` and
`provider_task`. An `agent` Run requires Agent, AgentVersion, selected Profile,
runtime key, Host/workspace target as applicable, and immutable runtime/policy
snapshots. A `provider_task` Run has no Agent/runtime references and points to
the bounded ProviderTask control/delivery/snapshot records. `run_role` remains
orthogonal and is not used to infer execution kind.

### 4. Provisioning

The optional Space-scoped provisioning template affects only future Agent
creation. Absence means Server Runtime + OpenCode + `runtime_native`. Explicit
provider mode validates same-Space Provider and model references. Changing or
removing the template never rewrites existing Profiles and never participates
in dispatch fallback.

### 5. Epoch reset

The replacement schema is released as one newly generated `0000_baseline.sql`.
Old numbered migrations and pre-epoch databases have no upgrade path. The
epoch fold occurs only after all behavior and consumer gates pass; provisional
migrations may be used only for disposable empty-database verification.

## Inventory and classification

The Phase 1 inventory names the current authorities and their destination:

| Current value/consumer | Current authority defect | Destination in this plan |
| --- | --- | --- |
| `agent_versions.model_provider_id`, `model_name`, `model_config_json` | immutable definition row also chooses deployment/model | Profile backend binding; portable Agent behavior stays typed on Version |
| `agent_versions.runtime_config_json`, `runtime_policy_json` | version bags are merged/fallback authority | typed Version constraints plus Profile options and explicit effective-policy assembly |
| `agent_runtime_profiles.adapter_type` | runtime identity uses legacy name | `runtime_key` and `AgentRuntimeDefinition`; temporary read-only compatibility shim only during cutover |
| Host `default_adapter_type` | host-global default crosses Space authority | Space provisioning template; paired Hosts have no provisioning fallback |
| `host_runtime_provider_bindings` | Host-global provider selection crosses Space scope | delete in Phase 3; Profile `model_provider` binding + proxy lease |
| `model_api` and `ts_agent_host` | in-process managed execution competes with ACP | bounded ProviderTask only where applicable; delete Agent-loop/runtime identities |
| `piManagedAgentLoop`, managed tool loop | autonomous Server Agent loop | Host daemon + `AcpRuntimeAdapter`; delete in Phase 3 |
| `runs.adapter_type` and nullable Agent columns | Run shape is inferred from nullable/fallback fields | `execution_kind` plus explicit snapshots; runtime identity becomes `runtime_key` |

Current model-call consumers are classified as follows: title generation,
query rewriting, reranking, extraction and similar short calls remain
incidental ProviderTask ledger entries; bounded operations with Run lifecycle,
retry, artifacts or verification become `provider_task` Runs; autonomous
multi-turn/tool-using work is an `agent` Run and must enter the Host daemon via
ACP. Research's existing bounded `model_api` path is retained as ProviderTask
infrastructure, not as an Agent runtime.

## Consequences

The Profile is the only mutable Agent deployment/backend authority and the Run
becomes explicit about whether it is an ACP Agent execution or a bounded model
task. The schema reset is intentionally operationally disruptive for the
pre-release product, but removes compatibility precedence and makes old rows
unrecoverable by design. Existing ACP normalization, Runtime Context,
System Actions, policy, usage, artifact, and verification authorities remain
in place.

## Non-goals

This ADR does not add a private runtime driver, expose credentials, move
bounded calls out of the Server, automate paired-Host installation, preserve
pre-epoch rows, or authorize deployment/database deletion.

## Revision history

- 2026-09-20 — accepted for the ACP runtime authority reset implementation.
- 2026-09-21 — recorded what this decision supersedes in ADR 0002 and ADR 0010.
- 2026-09-22 — implementation complete; execution plan retired; open consequences moved to `plans/backlog.md`.
