# ADR 0009: Capability And Open Skill Framework

Date: 2026-06-20

## Status

Accepted. Current state lives in
[`architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md`](../architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md).

## Context

Rainver needs a vendor-neutral way to represent canonical capabilities, group
them into packs, configure them per Project, import external
Agent-Skills-compatible packages safely, and deliver them to runtime adapters
such as Claude Code, Codex, and `model_api`. The existing capability surface
was catalog metadata only; runtime adapters are modelled separately
([ADR 0007](0007-multi-cli-mvp.md)) and vendor files are never source of truth
([ADR 0004](0004-context-wrapper.md)).

## Decision

### 1. A `capabilities` control-plane module beside `catalog`

`catalog` remains the raw on-disk manifest reader. `capabilities` owns
capability definitions, capability packs, imported skill sources and
packages, and runtime skill bindings and delivery.

### 2. External skills are untrusted source material

Imports are disabled by default; scripts are not executed; dependencies are
not installed; vendor permission declarations are permission **requests**
only. A skill is a procedure, not callable authority: package declarations of
tools, hooks, scripts, dependencies, or MCP servers install nothing, execute
nothing, register no System Action, expose no MCP server, and grant no
permission. System Actions and their policy-enforced gateway remain
Rainver-owned and separate from skills; Workflows remain enforced process
definitions, not soft instructions.

### 3. The package is the authority for its own content

An imported Agent Skill package is the source of truth for its procedural
content. Rainver does not produce a canonical re-representation of it and
does not convert an imported skill into a `CapabilityDefinition`. Rainver
owns the surrounding control plane:

- source, version or commit, content hash, package-root-relative file
  inventory, license, and import provenance;
- deterministic risk scanning, requested permissions, trust and approval
  state;
- scope and Agent binding, pinned package version, runtime compatibility and
  enablement policy;
- the exact package/version selected for a Run, its Runtime Context Delivery
  authorization references, and content hashes for audit.

Runtime-specific layouts or prompt blocks are adapter artifacts generated
from the approved snapshot; they never become a second content authority.
Skill content is model-visible durable context and reaches every runtime
through Runtime Context Delivery
([ADR 0014](0014-unified-runtime-context-engine.md)) — no side channel around
Delivery or its per-turn authorization binding.

### 4. There is no workflow template layer in this module

An earlier version gave `capabilities` a `WorkflowTemplate` /
`ProjectWorkflowProfile` layer. It never carried a production workflow (its
built-in registry returned an empty array outside tests, so no preset could
ever be created) and was deleted in full. A user-chosen reusable process is an
approved `workflow_definition.v1` version stored as a `workflow_template`
evolvable asset and executed by the Workflow execution engine
([ADR 0011](0011-inquiry-domain-model.md) decision 4). It is not a capability
grouping.

### 5. Transitional state

`NormalizedSkill`, imported-skill conversion, capability binding, pack, and
renderer paths still exist as transitional implementation. Decision 3 sets
their replacement direction; their removal is the parked capability-shrink
plan (trigger recorded in
[`tasks/deferred-register.md`](../tasks/deferred-register.md)). Until it
lands, existing import, proposal, policy, Delivery, and audit checks remain
mandatory and `NormalizedSkill` must gain no new consumers.

## Consequences

- Capability lifecycle stays reviewable and may later use proposal types such
  as `capability_install`, `capability_update`, `capability_enable`.
- Research is modelled as a capability pack, not a product plugin.
- Imported skills can be stored, inspected, risk-scanned, and bound without
  enabling execution.
- The native `capability` runtime adapter remains `planned` and disabled
  until a separate executor design is approved.

## Non-goals

- Full marketplace; arbitrary third-party code execution; runtime
  hot-loading of server code; native web search provider; research product
  UI; capability executor rewrite.
