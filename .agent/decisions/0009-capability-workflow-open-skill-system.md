# ADR 0009: Capability, Workflow, And Open Skill Framework

Date: 2026-06-20

## Status

Accepted; amended 2026-08-14

## Context

Agent-space needs a vendor-neutral way to represent canonical capabilities,
group them into packs, configure them per project, import external
Agent-Skills-compatible packages safely, and render
capabilities for runtime adapters such as Claude Code, Codex, and `model_api`.

The existing capability surface is catalog metadata only. Runtime adapters are
already modeled separately, and vendor context files are generated artifacts,
not source of truth.

## Decision

Add a server-owned `capabilities` control-plane module beside the existing
`catalog` module.

`catalog` remains the raw on-disk manifest reader. `capabilities` owns canonical
framework data and APIs for:

- capability definitions
- capability packs
- imported skill sources/packages
- normalized skills
- runtime skill bindings
- runtime skill rendering

External Open Skills are untrusted source material. Imports are disabled by
default, scripts are not executed, dependencies are not installed, and vendor
permission declarations are treated as permission requests only.

Claude Code, Codex, `model_api`, and future runtimes are rendering/invocation
targets. Runtime skill files are generated artifacts and do not become
agent-space source of truth.

## Amendment — Skill Content Authority (2026-08-14)

The original decision made imported skill content source material for a second,
canonical agent-space representation. That part is amended.

An external Agent Skill package is the source of truth for its own procedural
content. Agent-space does not own or produce a canonical re-representation of
that content and does not convert an imported skill into a
`CapabilityDefinition`. Agent-space owns the surrounding control plane:

- source, version or commit, content hash, package-root-relative file inventory,
  license and import provenance;
- deterministic risk scanning, requested permissions, trust and approval state;
- scope and Agent binding, pinned package version, runtime compatibility and
  enablement policy;
- the exact package/version selected for a Run, its Runtime Context Delivery
  authorization references, and safe content hashes used for audit.

Runtime-specific layouts or prompt blocks are adapter artifacts generated from
the approved package snapshot. They never become a second content authority.
Skill content remains model-visible durable context and therefore reaches every
runtime through Runtime Context Delivery; this amendment does not create a
side channel around Delivery or its per-turn authorization binding.

A skill is a procedure, not callable authority. Package declarations of tools,
hooks, scripts, dependencies, or MCP servers remain untrusted requests. They do
not install dependencies, execute scripts, register a System Action, expose an
MCP server, or grant any permission. System Actions and their policy-enforced
gateway remain agent-space-owned and separate from Skills. Workflows likewise
remain enforced process definitions rather than soft skill instructions.

The existing `NormalizedSkill`, imported-skill conversion, capability binding,
pack, and renderer paths are transitional implementation state. The amendment
sets their replacement direction; it does not claim their removal in this
documentation-only change. Until that work lands, existing import, proposal,
policy, Delivery, and audit checks remain mandatory and must not be bypassed.

Where the original Decision or Consequences describe normalized imported skills
or conversion into capability candidates as the intended authority model, this
amendment supersedes those statements. The original untrusted-import posture
and all proposal, policy, Runtime Context, and execution-safety boundaries remain
in force.

## Amendment — Workflow Template Layer Removed (2026-08-14)

The original decision gave the `capabilities` module a workflow template layer:
`WorkflowTemplate` as a user-facing reusable process composing capabilities,
`ProjectWorkflowProfile` as its saved project-scoped preset, and
`CapabilityPack.workflow_template_ids` grouping templates into packs.
The capability-shrink plan deleted that layer in full — the types, their protocol schemas, the
`/workflow-templates` and `/projects/{projectId}/workflow-profiles` routes, and
the `project_workflow_profiles` table.

The layer never carried a production workflow. Its built-in registry returned an
empty array outside tests, so every preset creation failed validation and no
preset could exist. What survives is the enforced-process side that was always
the real mechanism: an approved `workflow_definition.v1` version stored as a
`workflow_template` evolvable asset and executed by the Workflow execution
engine. A user-chosen reusable process is that; it is not a capability grouping.

Accordingly, `workflow templates` and `project workflow profiles` are struck
from the module's owned APIs in the Decision above, `workflow templates` is
struck from the Context paragraph, and the Consequences bullet about modeling
Research as "a capability pack and workflow templates" reads as a capability
pack alone. Capability definitions, packs, imported skill sources/packages,
normalized skills, and runtime skill bindings and rendering are unaffected here;
the capability-shrink plan's remaining items address those separately.

## Consequences

- Capability lifecycle remains reviewable and can later use proposal types such
  as `capability_install`, `capability_update`, and `capability_enable`.
- Research can be modeled first as a capability pack rather than as a product
  plugin.
- Imported skills can be stored, inspected, normalized, risk-scanned, and
  converted to capability candidates without enabling execution.
- The native `capability` runtime remains disabled until a separate executor
  design is approved.

## Non-Goals

- Full marketplace.
- Arbitrary third-party code execution.
- Runtime hot-loading of plugin/server code.
- Native web search provider.
- Research product UI.
- Capability executor rewrite.
