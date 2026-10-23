# Capability, Workflow, And Open Skill System

This document defines the capability/workflow/open-skill control-plane model.
It describes the framework, not a fully active capability executor.

## Position

An external Agent Skill package is the source of truth for its own procedural
content. Rainver owns the immutable import snapshot and provenance, risk and
trust review, requested and granted policy, scope/Agent binding, pinned version,
runtime compatibility, Runtime Context Delivery authorization, and audit. It
does not own a canonical re-representation of imported skill content.

Implemented and planned ACP runtimes are execution adapters. Runtime-specific
files or prompt projections are generated adapter artifacts, not content
authorities. Skill content is model-visible durable context and reaches an
Agent Run only through Runtime Context Delivery; bounded provider calls remain
ProviderTask operations, not another Agent runtime.

A Skill is a procedure for a model. A System Action / Tool is an
rainver-owned callable operation exposed through the policy-enforced
gateway. A package's tool, hook, script, dependency, or MCP declaration is a
request only and grants no callable or execution authority. A Workflow is a
third concept: an enforced process definition, not a soft instruction package.

The current paths are canonical capability definitions, packs,
`NormalizedSkill`, imported skill conversion, capability runtime bindings,
and renderers built from the normalized representation. They stay under the
existing proposal, policy, Delivery, and audit checks. Do not treat them as
the authority model, and do not add callers that extend them. The native
`capability` runtime remains disabled.

Terminology for runtime binaries, adapters, extensions, tool bindings, skill
bindings, and product plugins is defined in
[GLOSSARY.md](GLOSSARY.md). These are separate ownership boundaries; an
imported Open Skill is source material and is not a plugin or a runtime
permission grant.

## Concepts

### The builtin Work Skill

The Rainver Work Skill (`capabilities/workSkill.ts`) is the harness contract a
dispatched agent works under: how to reach the tool surface, when to report,
how to hand a decision back. It is a builtin skill: `SkillSourceType`
`"builtin"` is content Rainver owns and versions with the server,
with no provenance, risk, or approval state, because there is no third party to
trust. It is not an enablement: a Run that has tool grants gets it, with nothing to
turn on and nothing that can turn it off, because a Run that can act and
cannot report is an error state rather than a configuration. A Run with no
grants gets no Skill and no surface, which is the same fail-closed answer
`SYSTEM_ACTIONS.md` states as "tool-free Runs remain tool-free".

Its judgement rules come from `systemActions/conversationPolicy.ts`, the same
constants the conversational surfaces assemble — `IDENTIFIER_POLICY`,
`DURABLE_ACTION_CLAIM_POLICY` and `ACTION_RESULT_REPORTING_POLICY`, which is
the set the Room dispatch prompt uses (`agentGroups/roomStandingContext.ts`).
Editing one of those constants changes
what every surface that includes it tells an agent. What
is Skill-specific and hand-written is the command mechanics and the ADR 0017
§2 paragraph on direct writes and bounds — the latter restates substance
`QUESTION_DECOMPOSITION_ACTION_POLICY` also carries, and is the one place this
arrangement still has two copies of a rule. What an agent may actually call is
unchanged by it — the Run's
`permission_snapshot_json.tool_grants`, enforced call by call — and the Skill
points at `list` rather than naming a fixed set. Each Run records the content
hash of the Skill it was given.

The Work Skill is delivered as a file. Explicitly selected imported Skills
are delivered as their original package files, separately from builtin
capability renderings; see the unified library below.

### Open Skill

An Open Skill is an external, portable skill source package. Import accepts
GitHub, uploaded Markdown/folder files or ZIP, and a Skill discovered in the
global CLI Skill directories of an owned Host. Remote URL acquisition supports GitHub only; arbitrary
websites and registries are not fetched. A package usually contains `SKILL.md` plus optional references, assets, scripts, and
vendor metadata.

`capabilities/skillSourceFetch.ts` uses the shared `sources/outboundUrlSafety`
`fetchGuarded` boundary for content and GitHub API metadata. The original host
must remain unchanged on every redirect (`raw.githubusercontent.com` for files,
`api.github.com` for metadata); each hop is checked before connecting. The shared
guard owns address pinning, HTTPS enforcement, redirect limits and the request
deadline. Files are read under the existing 256 KiB ceiling, metadata under an
8 MiB ceiling, and excess or unsuccessful bodies are cancelled. The existing
200-file and 2 MiB included-package limits still apply. Commit resolution
remains optional; a refused or unavailable lookup retains its existing
unresolved-ref fallback.

An Open Skill is not trusted by default, but its approved package snapshot
remains the content of record. Rainver may preview, inventory, hash,
risk-scan, review, approve, bind, pin, and deliver that snapshot; it does not
rewrite it into a canonical Rainver skill definition. Approval governs
whether and where the content may be delivered, not whether Rainver owns it.

### NormalizedSkill

`NormalizedSkill` is an internal representation used by the importer and the
conversion path. Do not extend it. It captures:

- instructions
- package-root-relative resource inventory
- requested permissions and vendor tool declarations
- script or dependency hints
- execution profile hints
- vendor extensions
- deterministic risk analysis

It is not a content authority and must not gain new consumers. Vendor
declarations such as `allowed-tools` remain permission requests, not grants.

### SkillPackageFile

`SkillPackageFile` records the reviewed import snapshot for a package-root
relative Agent Skill directory. GitHub imports treat a tree URL as the skill
root and a blob/raw `SKILL.md` URL as a file inside its containing root.

The importer records file path, kind, hash, byte length, content type,
inclusion state, executable/script flags, and risk flags. Text and binary files under the package root are fetched within size caps.
`skill_package_files.content_base64` stores the exact original bytes, including
BOM and line endings. The inventory hash covers each file hash and length.
Older inventory-only packages remain inspectable but require reimport for delivery.

### Unified Skill library and explicit invocation

`POST /api/v1/skill-sources/import-preview` and `/import` accept one of:
`{url}`, `{source_type:"upload",files:[{path,content_base64}]}`,
`{source_type:"upload",archive_base64}`, or
`{source_type:"local_workspace",host_id,skill_id}` (global CLI discovery,
below). Import repeats acquisition and requires the preview's `package_hash`.
Desktop metadata is not package content: `__MACOSX/` trees, AppleDouble `._*`
files and `.DS_Store` are dropped from ZIP entries (within their own expansion
bound, and the archive entry cap of 1,000 counts them) and from file lists
before path validation and hashing (`isPlatformMetadataPath`).
The single root must contain exactly one `SKILL.md`. Packages are bounded to
200 files, 256 KiB per file and 2 MiB total; ZIP is bounded to 3 MiB encoded
input bytes before base64 (4 MiB base64), with streaming expansion limits and
central-directory completeness checks through `fflate`. No extraction occurs
on the server filesystem. New content is a new imported immutable package.

`GET /api/v1/skill-packages/:id/content` returns integrity-checked original
files for inspection within the Space. `GET .../:id/bindings` reads permitted
bindings; `POST .../:id/binding-proposal` creates a
`runtime_skill_binding_update` proposal with operation
`skill_package_binding_update`. Review must finish before a binding proposal.
`POST .../:id/review-proposal` optionally takes `{binding}` (enabled; Space,
user or Agent scope, never Project because a review is a Space decision): the
`skill_import_approve` proposal then reviews the package and writes that pinned
binding in the same apply, so one explicit approval makes an import usable. A
person has one pending review per snapshot: asking again for the same review
(same binding, or none) returns it with 200; asking for a different one answers
409 `skill_review_pending` with its `proposal_id`, and the package panel shows
that pending proposal to decide first. Approving a review supersedes every other
pending review of the package (their bindings must be requested again as binding
proposals). Reviews, bindings and turn selection take the package advisory lock
(`lockSkillPackage`) before the package row, and the supersede step skips
reviews another transaction holds (`FOR UPDATE SKIP LOCKED`), so two reviews
approved at once do not deadlock: the second finds the package reviewed and its
approval marks it `superseded` (`superseded_by_proposal_id`) instead of failing,
which is also what approving any review skipped that way does later. Nothing is
enabled without that approval. The applier
owns `skill_bindings`; each binding pins a package id and hash and one scope:
Space, current user, Project or Agent. Effective precedence is
Project > Agent > user > Space; a narrower disabled binding suppresses the
broader enabled one (`resolveSkillBindingsForScopes` resolves several
Project/Agent scopes of one person in one query). Scope writes reuse the
local-overlay authority checks when filed. Review and binding proposals both
carry `required_approver_role: "admin"`, matching that Space-scope writes are a
Space owner's or admin's: an admin or owner approves either (a Project owner
also approves a Project binding through `effectiveApproverRole`), and the
proposal-type risk ceiling still leaves critical-risk packages to the owner.
Applying an Agent binding re-checks that the Agent exists, is not archived and
is still managed by the proposer.

`GET /api/v1/capabilities/skills/available` takes optional conversation,
Project and Agent ids and returns eligible typed selections. For a Room
conversation it also takes `recipient_agent_ids` (comma-separated active Room
Agents; none means the manager, who receives an unaddressed message) and returns
only Skills enabled for every one of them, as admission requires; the Room
composer passes its addressed Agents. Both `/` and `@`
menus create `{kind:"skill",skill_package_id,package_hash,display_name}` input
parts, with at most four distinct selections. Selection also inserts a visible
`/display_name` at the caret in both composers, highlighted like an `@Agent`
mention and deleted as one token; removing it clears the selection.
This text is presentation, not package identity or authorization. Existing
message history without inline references retains its Skill chips.
Room `@Agent` mentions remain
recipient routing; selected Skills apply to all addressed recipients and each
recipient must have an effective binding (422 `selected_skill_not_enabled`
naming the `agent_ids` otherwise). Admission
(`assertSelectedSkillsForRecipients`) resolves all recipients' bindings in one
query and verifies each package's complete bytes once per turn; message
preparation reuses that verification. Skill-only turns are valid. Drafts,
message history and retries retain the selected package/version.

The message author's bindings govern a selection. A Room member who can see a
failed turn may retry it; the retry re-checks the original author's selection
for every recipient, while the retrier's Work Context supplies the Project
override. `loadSelectedSkills` reads a message's selections whoever the viewer
is (the viewer must be able to read the conversation, otherwise 404), so what is
delivered always matches the rendered `[Explicitly selected Skills]`
descriptors; a selection no longer enabled for the author fails closed.

Runtime Context acquisition reads the canonical message selections, resolves
reviewed original files against the execution control snapshot's scope, and
creates required delegated-instruction items. Gateway revalidates the live
bindings, complete package hash and exact payload before accepting
`Delivery.skill_packages`. Run-specific item versions keep files present on
continuation turns. Host launches materialize verified base64 bytes beneath
`RAINVER_SKILL_ROOT`; structured ACP resource links identify each `SKILL.md`.
Claude Code and Codex read the same original bytes. User prompt text is never
rewritten to substitute paths. Additional Skill directories are admitted only
in negotiated ACP directory fields. Host daemon **0.4.3+** is required; older
Hosts fail the existing compatibility gate before accepting work.

Scripts, hooks, dependency declarations and vendor tool hints are retained as
content, not installed or automatically executed. Existing execution and tool
authority continues to govern every action. Original-package selection does
not invoke the legacy normalized conversion/rendering path.

### Global CLI discovery and library UI

The `/skills` page lists imported packages with search, loading/error states,
a single empty state and automatic first-package selection. Import is a
separate modal with Local CLIs, GitHub and Files tabs. The Local CLIs tab calls
`POST /api/v1/skill-sources/hosts/:hostId/scan` and displays bounded candidates
with runtime, installation and logical source directory. It does not require a
Project or Folder binding. Host changes/rescans invalidate previous selections.
The Files tab accepts one `.md` (256 KiB) or `.zip` (3 MiB) file by click or
drag-and-drop, with drag feedback. A standalone Markdown upload uses the
existing `files` request with path `SKILL.md` and unmodified original bytes;
packages with supporting files use ZIP. Replacing a file invalidates its
preview; imports still require explicit preview and confirmation of that
package hash.

The daemon's `skill_scan`/`skill_read` frames reuse the typed single-frame Host
request transport. Roots are resolved on the Host: Claude's personal Skill
root, Codex `$HOME/.agents/skills` and legacy `$CODEX_HOME/skills`, and OpenCode's
XDG config Skill directory; explicit CLI config roots and installed managed
runtime HOMEs are respected. Discovery is bounded to 1,000 directories, depth
five and 200 candidates, with truncation/warnings reported. Top-level linked
Skill directories are supported and deduplicated by canonical target within a
root. Reads use folder-read's safe handles and path policy; internal symlinks,
credential-like paths and dependency directories are not copied.

Import source `{source_type:"local_workspace",host_id,skill_id}` names only an
opaque discovery id, never an arbitrary Host path. The daemon rediscovers it
for each read; removed/retargeted entries are refused. The control plane checks
owner access (built-in Host requires instance admin), online state and daemon
compatibility before requesting scan/read. Preview and import both reacquire
original bytes and use the existing immutable hash/review flow; provenance
records `origin:"cli_global"`, Host, candidate, runtime and installation.
Nothing is automatically enabled or installed in the CLI's own directories.

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

Overlay authority follows the scope it configures
(`PgCapabilitiesRepository.assertOverlayScopeAuthority`). Reading needs read
access to the scope's object, and an unreadable one is answered 404. Writing a
`space` overlay needs a Space owner/admin; a `project` or `project_folder`
overlay a Project writer who also reads the Project; a `user` overlay is that
person's; an ordinary `agent` overlay its manager's (`canChangeAgent`); a
managed Assistant's overlay its configurer's (`canConfigureAssistant`), so a
Space admin's general overlay authority does not reach a creator's or Project
owner's Assistant. An overlay grants no capability trust, egress or credential
use.

Capability proposal approval follows the scope its effect lands in. A Skill
import review, an installation, a shared version update and a shared runtime
binding change the Space and are refused at apply when filed under a Project
(a Project owner could otherwise approve them); a capability enablement's
payload `project_id` must equal the proposal's own `project_id`, so a
Space-wide enablement cannot be approved under a Project's authority nor a
Project enablement at Space level.

### CapabilityDefinition

`CapabilityDefinition` is the current Rainver ability object. It defines
the semantic ability, input/output contracts, permissions, artifact types,
proposal policy, supported execution modes, runtime support, and lifecycle
status.

Definitions may currently be built in, official, generated, or converted from
an imported skill. Do not extend imported-skill conversion: an external Skill
remains a `SkillPackage`, while rainver-owned
System Actions retain their own registry and gateway. Users do not directly
mutate definitions.

### CapabilityProfile

`CapabilityProfile` is user-, space-, project-, or agent-specific configuration
for a capability. It can store runtime preference, prompt overrides, source
mode, output policy, budget, and review policy.

The implementation stores capability enablement configuration. Broader
profile surfaces are not implemented.

### CapabilityPack

`CapabilityPack` is a grouping and distribution unit. It contains related
capabilities, docs/tests/examples, artifact types, and possibly artifact
renderer mappings.

Packs are static built-in packs and imported skill-derived capability
candidates. There is no marketplace.

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
workflow versions use the draft → evaluation →
promotion-proposal → approval path; the generic evolvable asset APIs do not
grant approval directly.

### RuntimeSkillBinding

`RuntimeSkillBinding` selects skill content for a runtime. Rows map
capability versions to these runtime-specific forms:

- Claude Code skill layout
- Codex skill layout

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

### Runtime skill render

`renderClaudeSkill` and `renderCodexSkill` (`capabilities/runtimeRenderers.ts`),
reached through `renderRuntimeSkillCandidate`, render canonical capability
data, normalized skill data, and profile configuration into runtime target
content. That input is not a canonical content representation. The
renderers are pure functions that produce deterministic:

- Claude Code generated skill directory suggestions with `SKILL.md`
- Codex generated skill directory suggestions with `SKILL.md` and optional
  `agents/openai.yaml`

Runtime Context turns selected Claude/Codex skill renderings into typed,
mandatory delegated-instruction items and persists them through the Gateway as
ordered Delivery message blocks. No vendor instruction file is written.

Run creation persists `capabilities_json` as run-scoped execution context.
Context preparation prefers a non-empty run-level capability list and falls
back to the AgentVersion `capabilities_json` for ordinary agent runs, while
`runs.capability_id` remains the single primary capability field.

## Frontend Surfaces

The framework is exposed through existing product areas rather than a separate
plugin boundary:

- Project Research uses its own governed standing and Thread-scoped focus
  services. Internal passes still execute through immutable Workflow Executions,
  while user-facing Project Research controls call the domain application
  service rather than constructing generic run drafts in the browser.
- The Capabilities page shows builtin definitions and packs. The separate
  `/skills` page owns import preview, original-file inspection, review proposals
  and scope-binding proposals. Import defaults to filing a review-and-enable
  proposal for the Space when the person is a Space owner or admin and for
  themselves otherwise (the Space scope is offered only to owners/admins), or
  "import only". If filing the enabling review fails after import, the dialog
  files the review alone and explains the outcome inline. The package panel
  decides a pending review or binding proposal in place through the normal
  proposal accept/reject API, and the server still enforces the approver role.
  Empty `/` and `@` Skill menus link to the conversation Space's library.
  Conversion remains a legacy API with no web client, not the new library
  workflow.
- The Skill Library Index and local-overlay APIs have no web consumer; they
  remain server APIs only.
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

It declares no workflow presets. A preset is admitted only when it changes
concrete behaviour or configuration.

The synthesis output artifact type is `research_report.archive.v1`; the
user-facing report is the corresponding `project_research_reports` row.

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
- Import is bound to the preview the person looked at. Preview returns
  `package_hash`, the hash of the package inventory with each fetched file's
  SHA-256. `POST /api/v1/skill-sources/import` must carry that
  `package_hash`, re-fetches the source, and saves the snapshot only when the
  bytes it fetched hash to it. Otherwise it answers 409
  `skill_package_changed`, and the Skills page withdraws the preview and
  asks for a new one. Approval of one preview never applies to other content.
- An imported Skill's capability version carries its reviewed snapshot in
  `metadata_json`: `normalized_skill`, the `capability_definition` derived
  from it, `skill_package_id` and `created_from_proposal_id`. `content_ref` and
  `content_hash` name the package and its hash. Runtime rendering reads these
  keys. `capability_update` refuses to change any of them on a
  `source = 'imported_skill'` version (422
  `imported_skill_snapshot_immutable`); new content comes only from a new
  import, which produces a new snapshot and hash. Status and other metadata
  remain updatable.
- Package imports are limited to files under the selected Skill root. Both
  text and binary bytes are retained within bounds. Unsafe, colliding or
  nonportable paths and incomplete packages fail closed.
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
  review. Capability conversion and enablement continue through
  `capability_enablements` and proposal boundaries.
- Review (`skill_import_approve`) and Convert (`capability_install`) are
  idempotent per person, package snapshot and operation. The proposal's
  `pending_operation_key` is `skill_package:<package>:<package_hash>:<operation>:<person>`,
  unique among pending proposals of its type in a Space
  (`uq_proposals_pending_operation`). Asking again while that proposal is
  pending returns it with 200 instead of 201, and two concurrent requests
  file one proposal. A review request whose binding differs from the pending
  one answers 409 `skill_review_pending` instead. Once it is decided, a new
  request files a new one. Skill package reads include the caller's
  `pending_proposal` (`{id, operation}` or null), counting a review only while
  the package is `imported` and a Convert only while it is `reviewed`. The
  `/skills` package panel shows it as pending and disables the scope actions.
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
- Unsupported source hosts fail closed.
- Private-network URL import is rejected.

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

- The native `capability` runtime adapter is declared and disabled.
- Import preview supports safe GitHub `blob`/`tree` package roots and
  `raw.githubusercontent.com` URLs that resolve to `SKILL.md`.
- Registry and official-catalog acquisition are not implemented. GitHub,
  uploads and global CLI discovery on an owned Host share the same preview path.
  Project Folder acquisition is not an import source.
- Host acquisition follows the daemon's folder-read policy; forbidden paths,
  symlinks and dependency directories omitted by that policy are not copied. No
  arbitrary server-local path import exists.
- No native web search service is implemented.
- Workflow drafts set one primary `runs.capability_id` and
  persist the full workflow capability list in `runs.capabilities_json`.
- Native runtime skill execution is not implemented; rendering only supplies
  adapter-specific instructions or prompt blocks.
- `RuntimeAdapterSpec` entries declare the executor family consumed by runs
  orchestration. Adapter capability and trust declarations are conservative.
  There is no conformance-backed route gate. Do not treat a static declaration
  as one.
- Runtime-internal CLI subagents are not represented uniformly by the current
  capability model. Managed API delegation remains group-scoped and
  policy-gated. Claude runs render and verify a run-scoped settings file that
  denies the `Task` tool. Codex has no equivalent verified control, so it stays
  `unknown`. Planned runtimes are not executable by declaration.
