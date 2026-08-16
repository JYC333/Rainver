# Runtime and Extension Glossary

This glossary records the vocabulary used by the execution, capability, and
workflow layers. It is a naming boundary, not a code-renaming plan.

| Term | Meaning and ownership |
|---|---|
| **RuntimeBinary** | A versioned executable installed and governed by `runtimeTools`. It is the physical CLI binary, not the adapter that invokes it. |
| **RuntimeAdapter** | The server-side execution implementation that turns a run into a managed API or local process invocation and materializes its result. Owned by `runs` and `runtimeAdapters`. |
| **RuntimeAdapterSpec** | The declarative catalog entry describing an adapter's executor family, invocation, credentials, sandbox, model, permissions, output, limits, and conservative runtime capability claims. The catalog is the source for adapter capabilities and dispatch selection. |
| **RuntimeExtension** | A future, separately governed extension point that augments a runtime with tools or protocol support. It is not synonymous with a runtime adapter or a product plugin. |
| **RuntimeToolBinding** | A binding that exposes a server-owned tool/action to a runtime under policy and capability checks. A binding grants exposure; it does not grant authorization by itself. |
| **RuntimeSkillBinding** | Currently maps a capability version to runtime-specific rendering or invocation settings. This implementation is transitional. Its target responsibility is to select an approved, pinned external Skill package for a scope/Agent and record runtime compatibility; runtime artifacts and the binding itself must not become a second content authority. |
| **Focus area** (`focus_area`; "Domain" in product language) | A user-created durable aggregation of a long-term focus — the Projects, Notes and Knowledge pointing at it. It holds no data and decides no access; `contentScopeSql()` never reads it. Distinguished from a module by whether the thing needs code, and from a Project by whether it has an end state. See [ADR 0015](../decisions/0015-focus-area-classification.md). The internal identifier avoids `domain`, which this codebase already uses for DDD aggregates, retrieval groupings, and hostnames. |
| **ProductPlugin** | An optional product module with its own module lifecycle and UI/backend surface. It is distinct from a runtime extension, skill package, or CLI binary. |
| **Agent Skill / Open Skill** | An untrusted external package that is the source of truth for its own procedural content. Agent-space records its immutable snapshot, provenance, risk, approval, binding and Delivery audit; it does not canonically re-represent the content. Package declarations are requests only and never grant tools, hooks, scripts, MCP authority, or runtime permissions. |

## Deliberate non-equivalences

- A RuntimeBinary is installed infrastructure; a RuntimeAdapter is server
  execution policy and lifecycle; a RuntimeAdapterSpec is its declaration.
- A RuntimeToolBinding and RuntimeSkillBinding are different: the former
  concerns callable System Action exposure. The latter currently maps a
  capability version to runtime rendering settings and will move to selecting
  approved procedural content for governed Runtime Context Delivery.
- A ProductPlugin is a product module. It must not be used as a catch-all name
  for a runtime, skill, tool, or adapter.

No source rename is implied by this document. New code should use the terms
above, and existing names should change only as part of an explicitly scoped
refactor.
