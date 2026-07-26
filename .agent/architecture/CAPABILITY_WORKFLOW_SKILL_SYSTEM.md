# Capability, Workflow, And Open Skill System

Date: 2026-06-20

This document defines the capability/workflow/open-skill control-plane model.
It describes the framework, not a fully active capability executor.

## Position

Agent-space owns capability lifecycle, memory, context, policy, proposals,
activity, artifacts, audit, Project Folder governance, and sandbox governance.
Claude Code, Codex, Cursor, OpenCode, Gemini CLI, `model_api`, and future
runtimes are adapters. They are not the source of truth for agent-space
capabilities.

The current implementation adds a framework for canonical definitions, packs,
workflow templates, imported skill packages, project workflow profiles, governed
skill lifecycle proposals, runtime skill rendering, and workflow run draft
creation. It does not make the native `capability` runtime executable.

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

An Open Skill is not trusted by default. It is not agent-space source of truth
after import. It is source material that can be previewed, risk-scanned,
normalized, stored disabled, and later converted into a capability candidate.

### NormalizedSkill

`NormalizedSkill` is the internal intermediate representation for imported
skills. It captures:

- instructions
- package-root-relative resource inventory
- requested permissions and vendor tool declarations
- script or dependency hints
- execution profile hints
- vendor extensions
- deterministic risk analysis

The normalized representation is the conversion boundary between external skill
formats and agent-space capability candidates. Vendor declarations such as
`allowed-tools` are permission requests, not permission grants.

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

`CapabilityDefinition` is the canonical agent-space ability object. It defines
the semantic ability, input/output contracts, permissions, artifact types,
proposal policy, supported execution modes, runtime support, and lifecycle
status.

Definitions may be built in, official, generated, or converted from an imported
skill. Users configure profiles; they do not directly mutate canonical
definitions.

### CapabilityProfile

`CapabilityProfile` is user-, space-, project-, or agent-specific configuration
for a capability. It can store runtime preference, prompt overrides, source
mode, output policy, budget, and review policy.

The first implementation stores saved project workflow preset configuration
(`ProjectWorkflowProfile`) and capability enablement configuration. Broader
profile surfaces remain future work.

### CapabilityPack

`CapabilityPack` is a grouping and distribution unit. It contains related
capabilities, workflow templates, docs/tests/examples, artifact types, and
possibly artifact renderer mappings.

The first version supports static built-in packs and imported skill-derived
capability candidates. It is not a full marketplace.

### WorkflowTemplate

`WorkflowTemplate` is a user-facing reusable process or mode that composes
capabilities. Examples include academic literature review, news scan, market
research, and technical survey.

Users generally choose workflows or modes rather than raw capabilities.
Templates declare input schema, default config, output artifact types, proposal
policy, and recommended runtime adapters.

### WorkflowDefinition v1

`workflow_definition.v1` is the versioned workflow-as-data shape stored in an
`evolvable_asset_versions.content_json` row whose asset type is
`workflow_template`. It contains bounded nodes, explicit dependency edges,
capability/prompt/agent/runtime bindings, verification-recipe references, node
contract metadata, and approval checkpoints. The protocol schema rejects
duplicate/unknown dependencies and cycles, and caps definitions at 30 nodes.

The built-in research templates are synchronized as system evolvable assets
with approved built-in versions. User or space versions use the existing draft
→ evaluation → promotion-proposal → approval path; the generic evolvable asset
APIs do not grant approval directly.

### ProjectWorkflowProfile / Saved Workflow Preset

`ProjectWorkflowProfile` is the database/API name for a saved project workflow
preset. Product UI should call it a **Saved preset** rather than forcing users
to learn another profile concept. For example, a project can save a
`research.technical_survey` preset with project-source collection and
`research_report.archive.v1` output.

Saved presets are scoped by `space_id` and `project_id`. They store reusable
workflow defaults such as source mode and output artifact types. They do not
bind an Agent, runtime profile, Project Folder, or one-off research question, and
they do not execute research by themselves.

### RuntimeSkillBinding

`RuntimeSkillBinding` maps an agent-space capability to a runtime-specific
rendering or invocation:

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

`RuntimeSkillRenderer` renders canonical capability data, normalized skill data,
and profile configuration into runtime target content. The MVP renderers are
pure functions that produce deterministic:

- Claude Code generated skill directory suggestions with `SKILL.md`
- Codex generated skill directory suggestions with `SKILL.md` and optional
  `agents/openai.yaml`
- generic prompt blocks for `model_api`

Context preparation writes generated Claude/Codex runtime skill files into the
per-run sandbox when an enabled binding is selected for the run/adapter. The
compiled context references those generated files through a mandatory runtime
skill section; `model_api` bindings render inline prompt blocks.

### WorkflowRunDraft

`WorkflowRunDraft` converts either a `WorkflowTemplate` plus request config, or
an enabled saved workflow preset plus request config, into a normal agents
`run_create_body`. It records template/preset provenance when a preset is used,
merged config, artifact expectations, optional selected Agent runtime profile,
the primary capability id stored in `runs.capability_id`, and the complete
workflow capability list stored in `runs.capabilities_json`.

When a workflow draft is submitted, the server resolves the approved
evolvable workflow version and records its id as `runs.workflow_version_id`.
If the system baseline has not been seeded yet, the static built-in template
remains the launch fallback and the pointer is null; this fallback is
deliberately frozen while graph execution is deferred to B2.

Workflow drafts are launch inputs only. Runs still execute through the existing
agent/run/orchestration path. The product launcher should select `agent_id` and
`runtime_profile_id`; it should not use workflow-level naked adapter/provider
overrides. The run creation path snapshots the selected runtime profile on the
Run.

The run draft request is validated against the protocol request schema. Unknown
fields are rejected, request-level `config_json` overrides reuse workflow
preset config validation, and generated prompts use the effective output
artifact types after template/preset/request merging.

Run creation persists `capabilities_json` as run-scoped execution context.
Context preparation prefers a non-empty run-level capability list and falls
back to the AgentVersion `capabilities_json` for ordinary agent runs. This lets
workflow runs render all workflow-selected runtime skills without mutating the
Agent's saved capability configuration, while `runs.capability_id` remains the
single primary capability field for compatibility.

## Frontend Surfaces

The framework is exposed through existing product areas rather than a separate
plugin boundary:

- Project detail pages include a Research workflow panel. The panel can run a
  workflow directly from a template without creating a saved preset. Saving or
  updating a `ProjectWorkflowProfile` is optional and used only to reuse
  defaults. The panel builds `WorkflowRunDraft` payloads, shows warning/prompt/
  output provenance, selects an Agent runtime profile only when multiple
  enabled runtime choices exist, and queues normal agent runs through
  `/api/v1/agents/:agentId/runs`.
- The Capabilities page remains the control-plane inspection surface. It shows
  built-in packs/templates, GitHub skill package preview/import, imported skill
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

Research starts as a capability pack with workflow templates and artifact type
mappings, not as a product plugin.

The built-in `research` pack includes:

- `research.source_collect`
- `research.source_summarize`
- `research.evidence_extract`
- `research.brief_synthesize`
- `research.idea_generate`

It also includes workflow templates:

- `research.academic_literature_review`
- `research.news_scan`
- `research.market_research`
- `research.technical_survey`

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
  capability definition, profile configuration, and agent-space policy.
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
- Runtime-generated Claude/Codex skill files are generated per run/sandbox, not
  committed as source-of-truth files.
- `runtime_skill.render` is checked before rendering. The runtime provider must
  prove that an enabled capability enablement selected the binding. Enabled
  bindings of any risk may render because high/critical review happens at the
  owner-approved `capability_enable` proposal. Direct render policy checks
  without enablement proof fall back to registry approval.
- Runtime skill source refs and retrieval trace record binding/version/path/hash
  metadata, not raw generated file content.
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
actions enforced through `proposal.apply`. `runtime_skill.render` is wired
directly in context preparation. `runtime_skill.execute` remains reserved until
a native execution path exists.

## Module Ownership

- `catalog` remains the raw on-disk catalog reader for bundled manifests.
- `capabilities` is the product/control-plane module for canonical capability
  definitions, packs, workflow templates, safe skill import, runtime bindings,
  and project workflow profiles.
- `runtimeAdapters` remains the adapter type/spec registry.
- `runs` remains the execution lifecycle owner.
- `context` remains the run context compiler and vendor context file writer.
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
