# Agent Runtime Authority

Rainver separates Agent definition, runtime deployment, and bounded provider
work. Each has one authority; none is a fallback for another.

## Agent definition: `AgentVersion`

`agent_versions` owns immutable Agent behavior and constraints: prompt and its
provenance, risk and maximum duration, context and memory policies,
capabilities, tool permissions/policy, output policy/schema, and scheduling
configuration. Publishing a version does not clone, rewrite, or select a
runtime Profile. AgentVersion has no runtime key, ModelProvider/model binding,
or runtime configuration/policy fallback.

## Deployment: `AgentRuntimeProfile`

`agent_runtime_profiles` is the mutable, Agent-scoped deployment authority. A
Profile identifies the ACP `runtime_key`, execution Host, installed copy,
workspace mode/location, backend mode, optional same-Space ModelProvider/model,
and narrowly scoped runtime options. Each Agent is provisioned with one
enabled default Profile. With no Space provisioning template, the product
default is the Server Runtime's managed OpenCode copy using
`backend_mode = runtime_native`.

The two backend modes are explicit:

- `runtime_native`: the runtime uses the login/configuration on that execution
  Host; no ModelProvider binding is stored.
- `model_provider`: a Profile selects a Space-selectable Provider and model.
  The server authorizes the spend and issues a short-lived proxy lease;
  upstream credentials never enter a runtime process.

Either backend mode is valid on either Host kind. `model_provider` is **not**
Server-only: the dispatched Run is handed a lease URL, never a key, and
`hostProviderProxyBaseUrl` resolves that address for a paired Host from its
per-host override, the instance-wide external proxy URL, or the control-plane
address plus the proxy port. The host daemon's bound-run environment filter
(`filterAmbientEnv`) exists for exactly this case, so a paired machine's own
vendor keys cannot displace the binding. What `model_provider` may not be is
*unbound*: a Profile with no execution Host, workspace mode and installation
has nothing to hand the lease to, and admission refuses it.

A Provider is selectable in a Space through exactly one mechanism: an enabled
`model_provider_space_grants` row for that Space joined to an enabled Provider.
A Provider owned by another Space and never granted is not selectable on a
Profile or on the Space provisioning template, whatever else the caller knows
about it.

The optional Space runtime default is a provisioning template for future
Profiles only. Dispatch does not consult it. Updating it never rewrites an
existing Profile. Disabling or ungranting the Provider it names does not
rewrite it either: the template keeps its selection, the read model reports
`state = "needs_repair"` with a reason, and Agent creation fails with the
`space_runtime_default_needs_repair` error naming the selection and the repair
rather than a Profile-level "provider is not selectable". Writing the template
back to `runtime_native` is the repair and the reset — absence of a row and an
explicit native row mean the same product default, so there is no separate
delete endpoint. The Server Runtime is instance-wide; a paired Host's native
account belongs to its owner. The UI must disclose the shared-account semantics
when the Server copy is signed in to a paid account.

### Profile option bags

A Profile carries two narrowly scoped option bags, and a key has exactly one
authoring authority between them:

| Bag | Authors | Read by |
|---|---|---|
| `runtime_config_json` | `tools`, `tool_ids`, `supports_live`, `supports_dry_run` | route candidate filtering |
| `runtime_policy_json` | `allow_permission_bypass` (a runtime's `permission_bypass_policy_key`) | CLI command rendering |

Admission refuses a key stored in the bag that does not author it, so no reader
resolves the same key from two bags by precedence. Everything else in either
bag is runtime-specific and belongs to whichever the author chose. Neither bag
may carry credential material, or shadow runtime identity or an immutable
AgentVersion constraint, at any depth; `RuntimeProfileOptionsJsonSchema` in
`@rainver/protocol` is the single implementation of that rule, parsed at the
route boundary and again in repository admission rather than re-walked.

## Runtime definitions and execution

`runtime_key` resolves through the code-owned runtime registry to an
`AgentRuntimeDefinition`; it is not a database identity. Only implemented ACP
definitions are selectable Agent runtimes. OpenCode, Claude Code and Codex CLI
all use the same Rainver `AcpRuntimeAdapter` and `AcpController`. The execution
Host daemon resolves and launches the installed copy. There is no private
Server Agent loop and no `model_api` Agent runtime.

Bounded model requests remain in the Provider subsystem. Incidental work such
as query rewriting or reranking uses its ProviderTask/policy/usage records
without a Run. A bounded operation that needs Run-level lifecycle or
attribution uses a `provider_task` Run linked to ProviderTask control,
delivery and snapshot records.

## Run authority and snapshots

`runs.execution_kind` determines the valid shape; `run_role` remains an
independent execution/coordinator dimension.

| Run kind | Agent / version | Runtime Profile and key | ProviderTask refs |
|---|---|---|---|
| `agent` | required | selected Profile and runtime key required; Profile snapshot is stamped before dispatch | absent, except for separately ledgered incidental subcalls |
| `provider_task` | absent | absent | required for the formal bounded operation |

An Agent Run resolves its AgentVersion and Profile independently. The selected
Profile snapshot records the deployment/backend inputs used by that Run;
editing the live Profile later cannot change the historical interpretation.
Queued Runs may await route selection, but they cannot dispatch without the
selected Profile, runtime key, Host and required snapshot. There is no
AgentVersion selector fallback and no Host-global Provider fallback.

Conversation bindings and Host threads additionally freeze their selected
Profile/Host/installation and workspace context when initialized. Later edits
can make a subsequent Run unavailable, but cannot silently rebind that
conversation.

Project Research stage executions are ordinary Agent Runs pinned to the
provisioned research Agent's Profile. Its bounded incidental provider calls
remain ProviderTasks. Native Automation and deterministic Workflow Action
results retain their owning Automation/Workflow lifecycle rather than gaining
synthetic Agent Runs.

## Policy and credentials

AgentVersion constraints define what the Agent may do; Profile settings define
where and how its ACP runtime is deployed. Live Space membership, provider
eligibility, Host trust, workspace isolation, credential-spend policy and
System Action authorization may narrow the effective request. A runtime choice
cannot grant tools or weaken policy. Run snapshots and the route decision
record the effective execution selection and its source.

Provider API keys are resolved only in the server/provider boundary. ACP
runtimes use either their Host-local native login or the lease-based Provider
proxy path. Never pass provider secrets through ambient variables, CLI
arguments, or persisted runtime options.

## Source of truth

- Schema: `server/src/db/schema/agents.ts`, `runs.ts`, and ProviderTask schema.
- Profile admission and the single Profile row writer:
  `server/src/modules/agents/runtimeProfileAdmission.ts`.
- Agent/AgentVersion provisioning and the Space template:
  `server/src/modules/agents/repository.ts`.
- Request contracts for Profile and template writes:
  `packages/protocol/src/agents.ts`.
- ACP registry and adapter: `server/src/modules/runtimeAdapters/`.
- Route selection and persisted decision: `server/src/modules/routing/`.
- Run creation, snapshotting, and execution: `server/src/modules/runs/`.
- Bounded model calls and spend authorization: `server/src/modules/providers/`.

See [ROUTING.md](ROUTING.md), [RUNS_AND_OUTPUTS.md](RUNS_AND_OUTPUTS.md),
and [runtime-adapters.md](../modules/runtime-adapters.md) for the corresponding
execution details.
