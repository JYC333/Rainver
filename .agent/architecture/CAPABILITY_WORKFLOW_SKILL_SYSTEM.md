# Capability, Workflow, And Open Skill System

Date: 2026-06-20

This document defines the capability/workflow/open-skill control-plane model.
It describes the framework, not a fully active capability executor.

## Position

An external Agent Skill package is the source of truth for its own procedural
content. Rainver owns the immutable import snapshot and provenance, risk and
trust review, requested and granted policy, scope/Agent binding, pinned version,
runtime compatibility, Runtime Context Delivery authorization, and audit. It
does not own a canonical re-representation of imported skill content.

Claude Code, Codex, Cursor, OpenCode, Gemini CLI, `model_api`, and future
runtimes are adapters. Runtime-specific files or prompt blocks are generated
adapter artifacts, not content authorities. Skill content is model-visible
durable context and reaches a Run only through Runtime Context Delivery.

A Skill is a procedure for a model. A System Action / Tool is an
rainver-owned callable operation exposed through the policy-enforced
gateway. A package's tool, hook, script, dependency, or MCP declaration is a
request only and grants no callable or execution authority. A Workflow is a
third concept: an enforced process definition, not a soft instruction package.

The current implementation is transitional: it still contains canonical
capability definitions, packs, `NormalizedSkill`, imported skill conversion,
capability runtime bindings, and renderers built from the normalized
representation. The workflow template layer that this list also named was
deleted by the capability-shrink plan. Those paths remain subject to all existing
proposal, policy, Delivery, and audit checks until the plan's remaining items
replace them; this document does not treat them as the target authority model or invite
new callers to extend them. The native `capability` runtime remains disabled.

Terminology for runtime binaries, adapters, extensions, tool bindings, skill
bindings, and product plugins is defined in
[GLOSSARY.md](GLOSSARY.md). These are separate ownership boundaries; an
imported Open Skill is source material and is not a plugin or a runtime
permission grant.

## Concepts

### Open Skill

An Open Skill is an external, portable skill source package. It may come from
GitHub, future registries, a local workspace, an upload, or an official catalog.
It usually contains `SKILL.md` plus optional references, assets, scripts, and
vendor metadata.

An Open Skill is not trusted by default, but its approved package snapshot
remains the content of record. Rainver may preview, inventory, hash,
risk-scan, review, approve, bind, pin, and deliver that snapshot; it does not
rewrite it into a canonical Rainver skill definition. Approval governs
whether and where the content may be delivered, not whether Rainver owns it.

### NormalizedSkill

`NormalizedSkill` is a transitional internal intermediate representation still
used by the current importer and conversion path. It captures:

- instructions
- package-root-relative resource inventory
- requested permissions and vendor tool declarations
- script or dependency hints
- execution profile hints
- vendor extensions
- deterministic risk analysis

It is not a content authority and must not gain new consumers. Capability-shrink
item 4 removes it so policy metadata is extracted alongside the immutable
package snapshot without regenerating the skill's instructions. Vendor
declarations such as `allowed-tools` remain permission requests, not grants.

### SkillPackageFile

`SkillPackageFile` records the reviewed import snapshot for a package-root
relative Agent Skill directory. GitHub imports treat a tree URL as the skill
root and a blob/raw `SKILL.md` URL as a file inside its containing root.

The importer records file path, kind, hash where available, byte length,
content type, inclusion state, executable/script flags, and risk flags. Text
files under the package root are fetched within size caps. Non-text assets are
recorded as inventory metadata when available, but they are not executed or
installed.

### SkillLocalOverlay

`skill_local_overlays` stores local configuration for an imported
`SkillPackage`. It is scoped by `space`, `user`, `project`, `project_folder`, or
`agent`, and is intentionally separate from `skill_packages.normalized_json`.

The overlay may store alias/display name, endpoint defaults, credential/profile
reference, default scope, runtime preference, and user preferences. It must not
embed provider secrets; secret-bearing keys such as API keys, passwords, or
access tokens are rejected at the API boundary. Public or imported skill
snapshots remain immutable source material, while overlays capture local
binding choices and private environment names.

API:

- `GET /api/v1/capabilities/skills/index` returns a lightweight Skill Library
  Index with effective name/alias plus the active space overlay.
- `GET /api/v1/capabilities/skills/:skillPackageId/local-overlay` reads the
  active overlay for the requested scope.
- `PUT /api/v1/capabilities/skills/:skillPackageId/local-overlay` upserts or
  archives the local overlay. It does not mutate `normalized_json` and does not
  create/enable capabilities.

### CapabilityDefinition

`CapabilityDefinition` is the current Rainver ability object. It defines
the semantic ability, input/output contracts, permissions, artifact types,
proposal policy, supported execution modes, runtime support, and lifecycle
status.

Definitions may currently be built in, official, generated, or converted from
an imported skill. Imported-skill conversion is transitional and must not be
extended: an external Skill remains a `SkillPackage`, while rainver-owned
System Actions retain their own registry and gateway. Users do not directly
mutate definitions.

### CapabilityProfile

`CapabilityProfile` is user-, space-, project-, or agent-specific configuration
for a capability. It can store runtime preference, prompt overrides, source
mode, output policy, budget, and review policy.

The first implementation stores capability enablement configuration. Broader
profile surfaces remain future work.

### CapabilityPack

`CapabilityPack` is a grouping and distribution unit. It contains related
capabilities, docs/tests/examples, artifact types, and possibly artifact
renderer mappings.

The first version supports static built-in packs and imported skill-derived
capability candidates. It is not a full marketplace.

### WorkflowDefinition v1

`workflow_definition.v1` is the versioned workflow-as-data shape stored in an
`evolvable_asset_versions.content_json` row whose asset type is
`workflow_template`. It contains bounded nodes, explicit dependency edges,
capability/prompt/agent/runtime bindings, verification-recipe references, node
contract metadata, and approval checkpoints. The protocol schema rejects
duplicate/unknown dependencies and cycles, and caps definitions at 30 nodes.

Project Research does not publish built-in workflow presets from its capability
pack. Its internal immutable execution-per-pass definitions are created under
`project_research.*` asset keys when a managed pass needs them; they are
execution provenance, not user-selectable domain Templates. User or space
workflow versions still use the existing draft → evaluation →
promotion-proposal → approval path; the generic evolvable asset APIs do not
grant approval directly.

### RuntimeSkillBinding

`RuntimeSkillBinding` is the transitional implementation name for the governed
selection of skill content for a runtime. Its target responsibility is to bind
an approved, pinned `SkillPackage` to an allowed scope/Agent and record runtime
compatibility, not to own or regenerate that package's content. Current rows
still map capability versions to these runtime-specific forms:

- Claude Code skill layout
- Codex skill layout
- generic prompt block for `model_api`
- future native executor config
- future MCP tool binding

Runtime skill files are generated adapter files. They are not source of truth.
Built-in capabilities can use their default runtime bindings after an enabled
capability enablement is selected. Imported skill capabilities use persisted
`capability_runtime_bindings` rows attached to reviewed capability versions.
`capability_versions.status = 'available'` is a lifecycle state and may apply
to multiple reviewed versions in one Space. The approved version for a Space,
Project, Agent, or User scope is pinned only by that scope's
`capability_enablements.capability_version_id`; publishing or enabling another
version never rewrites other scopes' pins. A null version pin is reserved for
the matching built-in definition and never selects persisted imported runtime
bindings; imported conversion also rejects ids that collide with built-in keys.

### RuntimeSkillRenderer

`RuntimeSkillRenderer` currently renders canonical capability data, normalized
skill data, and profile configuration into runtime target content. This is
transitional adapter glue. Its target input is the approved package snapshot
plus binding/policy metadata, without a canonical content representation. The
MVP renderers are pure functions that produce deterministic:

- Claude Code generated skill directory suggestions with `SKILL.md`
- Codex generated skill directory suggestions with `SKILL.md` and optional
  `agents/openai.yaml`
- generic prompt blocks for `model_api`

Runtime Context turns selected Claude/Codex skill renderings into typed,
mandatory delegated-instruction items and persists them through the Gateway as
ordered Delivery message blocks. No vendor instruction file is written.
`model_api` bindings use the same path with their inline prompt block.

Run creation persists `capabilities_json` as run-scoped execution context.
Context preparation prefers a non-empty run-level capability list and falls
back to the AgentVersion `capabilities_json` for ordinary agent runs, while
`runs.capability_id` remains the single primary capability field.

## Frontend Surfaces

The framework is exposed through existing product areas rather than a separate
plugin boundary:

- Project Research uses its own governed standing and Thread-scoped focus
  services. It does not expose the deleted zero-difference research workflow
  presets. Internal passes still execute through immutable Workflow Executions,
  while user-facing Project Research controls call the domain application
  service rather than constructing generic run drafts in the browser.
- The Capabilities page remains the control-plane inspection surface. It shows
  built-in packs, GitHub skill package preview/import, imported skill
  review/convert proposal actions, and imported package details including
  requested permissions, package root/hash/source, instructions, diagnostics,
  and package file risk inventory.
- The Context Configuration page consumes the Skill Library Index as a lighter
  directory view. It can show active local overlays but does not collapse Open
  Skill, Capability, runtime skill, or official optional module boundaries.
- Project Research materializes `research_report.v1` into its domain Reader.
  Its `research_report.archive.v1` Artifact is a hidden audit/export backup;
  Artifact Detail does not render it as the report.

The frontend does not bypass proposal or run boundaries. Skill review,
conversion, and capability enablement remain proposal-governed; Research
execution remains a normal queued agent run.

## Research Example

Research starts as a capability pack with reusable actions and artifact type
mappings, not as a product plugin.

The built-in `research` pack includes:

- `research.source_collect`
- `research.source_summarize`
- `research.evidence_extract`
- `research.brief_synthesize`
- `research.idea_generate`

It declares no workflow presets. The four former label-only research templates
were removed because a preset is admitted only when it changes concrete
behaviour or configuration, and the whole workflow template layer was deleted
by the capability-shrink plan.

The synthesis output artifact type is `research_report.archive.v1`; the
user-facing report is the corresponding `project_research_reports` row.

This model allows future Research Lab product surfaces to consume the same
capabilities and profiles without making Research a plugin boundary from day
one.

## Security And Governance

- External skills default to imported, unreviewed, and disabled.
- Scripts are never executed during import.
- Import does not install npm, pnpm, Python, or other dependencies.
- Vendor tool declarations are permission requests, not permission grants.
- Actual runtime permissions are the intersection of the skill request,
  capability definition, profile configuration, and Rainver policy.
- Skill import records source URL, source ref, commit SHA when available, fetch
  time, package hash, package root, and bounded same-repository file inventory.
- GitHub imports must pin a commit SHA when available or at least record source
  ref plus content hash.
- GitHub package imports are limited to files under the detected skill root.
  Text files are fetched with size/type caps and traversal checks. Non-text
  assets remain inventory metadata unless a later storage path is explicitly
  added.
- Truncated or over-limit GitHub package trees fail closed because an incomplete
  inventory cannot be treated as a reviewed package snapshot.
- Raw external content remains untrusted.
- Untrusted external content must not directly enter active Memory.
- Memory writes remain proposal-based.
- Skill import approval, capability install/update/enable/disable, and runtime
  skill binding changes go through `proposal.apply` and registered proposal
  appliers.
- Skill local overlays are configuration, not capability trust grants. They do
  not approve a skill, convert a skill, enable a capability, or bypass proposal
  review. Capability conversion and enablement continue through existing
  `capability_overlays` / proposal boundaries.
- Conversion requests create a `capability_install` proposal. Applying it
  produces a disabled draft capability version plus disabled runtime bindings;
  requesting direct enablement during conversion (`enable_for_project_id`) fails
  closed.
- Skill import and conversion are atomic units of work: a partial failure leaves
  no orphaned source, draft version, or runtime binding behind.
- Claude/Codex renderer file representations are converted to Delivery content;
  they are never written into the runtime sandbox.
- `runtime_skill.render` is checked before rendering. The runtime provider must
  prove that an enabled capability enablement selected the binding. Enabled
  bindings of any risk may render because high/critical review happens at the
  owner-approved `capability_enable` proposal. Direct render policy checks
  without enablement proof fall back to registry approval.
- Safe Invocation Snapshots record the selected binding/version source ref and
  delivered content hash, not raw rendered instructions.
- Unsupported source hosts fail closed in the MVP.
- Private-network URL import is rejected in the MVP.

## Proposal And Policy Integration

Registered proposal types:

- `capability_install`
- `capability_update`
- `capability_enable`
- `capability_disable`
- `skill_import_approve`
- `runtime_skill_binding_update`

Policy actions:

- `capability.update`
- `capability.enable`
- `capability.disable`
- `skill.import`
- `skill.convert`
- `runtime_skill.binding_update`
- `runtime_skill.render`
- `runtime_skill.execute`

`skill.import`, `skill.convert`, `capability.update`, `capability.enable`,
`capability.disable`, and `runtime_skill.binding_update` are proposal-governed
actions enforced through `proposal.apply`. `runtime_skill.render` is enforced
during Runtime Context acquisition before Gateway Delivery. `runtime_skill.execute` remains reserved until
a native execution path exists.

## Module Ownership

- `catalog` remains the raw on-disk catalog reader for bundled manifests.
- `capabilities` is the product/control-plane module for canonical capability
  definitions, packs, safe skill import, and runtime bindings.
- `runtimeAdapters` remains the adapter type/spec registry.
- `runs` remains the execution lifecycle owner.
- `runtimeContext` remains the sole typed acquisition, planning, Delivery, and continuity authority.
- `proposals` remains the review/apply orchestrator.

## Current Limitations

- The native `capability` runtime adapter is still planned and disabled.
- Import preview supports safe GitHub `blob`/`tree` package roots and
  `raw.githubusercontent.com` URLs that resolve to `SKILL.md`.
- Registry, local workspace, upload, and official-catalog skill source types
  remain modeled but not implemented.
- Binary asset storage is not implemented; binary/non-text assets are kept as
  package inventory metadata where GitHub exposes blob metadata.
- No native web search service is implemented.
- Workflow drafts set one primary `runs.capability_id` for compatibility and
  persist the full workflow capability list in `runs.capabilities_json`.
- Native runtime skill execution is not implemented; rendering only supplies
  adapter-specific instructions or prompt blocks.
- `RuntimeAdapterSpec` entries declare the executor family consumed by runs
  orchestration. Adapter capability and trust declarations are conservative;
  conformance-backed route enforcement remains scoped to C3.
- Runtime-internal CLI subagents are not represented uniformly by the current
  capability model. Managed API delegation remains group-scoped and
  policy-gated. Claude runs render and verify a run-scoped settings file that
  denies the `Task` tool; Codex remains `unknown` until C3 verifies an
  equivalent control, and planned runtimes are not executable by declaration.
