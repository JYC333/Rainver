# Runtime and Extension Glossary

This glossary records the vocabulary used by the execution, capability, and
workflow layers. It is a naming boundary, not a code-renaming plan.

| Term | Meaning and ownership |
|---|---|
| **RuntimeInstallation** | One concrete copy of a runtime on one execution host — `own` (the machine's own PATH binary) or `managed:<version>` (a copy the daemon installed), named by an `AgentRuntimeProfile.runtime_installation`. It is the physical CLI, not the adapter that invokes it. |
| **RuntimeAdapter** | The server-side execution implementation for an Agent Run. There is exactly one: `AcpRuntimeAdapter`, which constructs the shared `AcpController` and materializes the Run's result. The managed-API and managed-Agent-loop adapters are deleted; a bounded model call is a ProviderTask, not a runtime adapter. Owned by `runs` and `runtimeAdapters`. |
| **AcpRuntimeAdapter** | The single Rainver execution implementation for ACP Agent runtimes (`runtimeAdapters/acpRuntimeAdapter.ts`). It admits a `runtime_key` through `assertAgentRuntimeDefinition` and delegates the loop to `runs/cliConversationProtocol.ts`. "Adapter" remains correct for this one implementation and for a bounded provider transport inside the Provider module; it is not a synonym for runtime identity. |
| **`runtime_key`** | The stable dynamic string that names a runtime product — `opencode`, `claude_code`, `codex_cli`, or a dynamic `acp_<registry id>`. It looks up an `AgentRuntimeDefinition`; it is not a database identity or a display name. It replaces `adapter_type`, which is not used for runtime identity (B58). Stored on `agent_runtime_profiles.runtime_key` and `runs.runtime_key`. |
| **AgentRuntimeDefinition** | The narrow ACP-facing projection of the runtime registry (`runtimeAdapters/runtimeDefinitions.ts`): `runtime_key`, display name, `protocol: "acp"`, and the backend modes the runtime contract supports. Profile admission, routing and dispatch read this; an unknown key or a non-ACP spec yields no definition and fails closed. Projected from `RuntimeAdapterSpec`, never a second authority. |
| **AgentRuntimeProfile** | Mutable Agent *deployment* authority, keyed to `(space_id, agent_id)` (`agent_runtime_profiles`). It selects the `runtime_key`, execution Host, `RuntimeInstallation`, workspace binding, backend mode and runtime-specific options. AgentVersion stays immutable definition authority and selects none of these ([ADR 0022](../decisions/0022-acp-runtime-authority-and-schema-epoch.md) §1). |
| **Backend mode** (`backend_mode`) | Which backend a Profile's runtime talks to: `runtime_native` uses the runtime's own login on its execution Host and binds no Provider or model; `model_provider` names an enabled same-Space ModelProvider and an explicit model, reached through a Run-scoped proxy lease. Support is declared per runtime by its `AgentRuntimeDefinition` and enforced by `assertBackendModeBinding`. |
| **`execution_kind`** | The explicit shape of a Run (`runs.execution_kind`), with exactly two values. An `agent` Run carries Agent, AgentVersion, selected Profile, `runtime_key` and immutable snapshots; a `provider_task` Run carries no Agent or runtime reference and points at ProviderTask control/delivery/snapshot rows. A database CHECK enforces both shapes, and `run_role` is orthogonal — it never implies an execution kind. |
| **ProviderTask** | A bounded, in-process model invocation with its own policy, control, delivery and safe-snapshot records (`provider_task_controls` and siblings) plus usage accounting. Short calls — title generation, rewriting, reranking, extraction — stay ledger entries; a bounded operation that needs Run lifecycle, retry, artifacts or verification becomes a `provider_task` Run. Never an Agent runtime, and it fabricates no Agent or Profile reference. |
| **Server Runtime** | The built-in execution Host (`hosts.kind = 'server'`), which speaks the same daemon protocol as a paired Host. It is the product label for that Host and the default execution target; its managed OpenCode copy is pinned by the Rainver release and reconciled by the control plane. `host_kind`, never the label, is what code branches on. |
| **RuntimeAdapterSpec** | The declarative catalog entry describing an adapter's executor family, invocation, credentials, sandbox, model, permissions, output, limits, and conservative runtime capability claims. The catalog is the source for adapter capabilities and dispatch selection. |
| **RuntimeExtension** | A future, separately governed extension point that augments a runtime with tools or protocol support. It is not synonymous with a runtime adapter or a product plugin. |
| **RuntimeSkillBinding** | Currently maps a capability version to runtime-specific rendering or invocation settings. This implementation is transitional. Its target responsibility is to select an approved, pinned external Skill package for a scope/Agent and record runtime compatibility; runtime artifacts and the binding itself must not become a second content authority. |
| **Focus area** (`focus_area`; "Domain" in product language) | A user-created durable aggregation of a long-term focus — the Projects, Notes and Knowledge pointing at it. It holds no data and decides no access; `contentScopeSql()` never reads it. Distinguished from a module by whether the thing needs code, and from a Project by whether it has an end state. See [ADR 0015](../decisions/0015-focus-area-classification.md). The internal identifier avoids `domain`, which this codebase already uses for DDD aggregates, retrieval groupings, and hostnames. |
| **ProductPlugin** | An optional product module with its own module lifecycle and UI/backend surface. It is distinct from a runtime extension, skill package, or CLI binary. |
| **Agent Skill / Open Skill** | An untrusted external package that is the source of truth for its own procedural content. Rainver records its immutable snapshot, provenance, risk, approval, binding and Delivery audit; it does not canonically re-represent the content. Package declarations are requests only and never grant tools, hooks, scripts, MCP authority, or runtime permissions. |

## Deliberate non-equivalences

- A RuntimeInstallation is a copy on a host; a RuntimeAdapter is server
  execution policy and lifecycle; a RuntimeAdapterSpec is its declaration.
- A `runtime_key` is runtime identity; an `AgentRuntimeDefinition` is what that
  key resolves to; an `AgentRuntimeProfile` is one Agent's deployment choice of
  it. None of the three is `adapter_type`, which no longer names anything.
- An `agent` Run executes through the ACP adapter on a Host; a `provider_task`
  Run is a bounded ProviderTask with Run lifecycle. A ProviderTask is not an
  Agent runtime and never acquires an Agent or Profile reference.
- A RuntimeSkillBinding is exposure, not authorization: it maps a capability
  version to runtime rendering settings and will move to selecting approved
  procedural content for governed Runtime Context Delivery.
- A ProductPlugin is a product module. It must not be used as a catch-all name
  for a runtime, skill, tool, or adapter.

No source rename is implied by this document. New code should use the terms
above, and existing names should change only as part of an explicitly scoped
refactor.
