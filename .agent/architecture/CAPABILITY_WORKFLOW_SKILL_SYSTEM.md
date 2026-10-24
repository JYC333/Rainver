# Skills, Tools, And Workflows

## Position

Three layers have separate owners:

| Layer | Meaning | Authority |
|---|---|---|
| Tool / System Action | An atomic gated operation on Rainver state | `systemActions/` registry and gateway |
| Skill | Procedural content the model reads and may follow | Original immutable package, selected through the Skill library |
| Workflow / pipeline | Server-enforced order, gates, checkpoints and retries | `automations/` executor or `projectResearch/` state machine |

A Workflow starts Runs. A Run may receive Skills and call Tools. Reading a
Skill grants no callable authority. Rainver owns provenance, risk review,
policy, scope bindings and Runtime Context Delivery authorization; the package
remains the authority for its own content. There is no capability-definition,
pack, conversion or normalized-rendering layer.

The Skill library module and its selection/overlay API namespace are `skills`. Diagnostic YAML in `catalog/capabilities/` is not an
execution registry. `/skills` is the product surface; `/capabilities` is absent.
See [GLOSSARY.md](GLOSSARY.md) for runtime and extension terms.

## Rainver Work Skill

`skills/workSkill.ts` is a required code module defining the work-surface
contract: how a dispatched Agent lists authorized actions, reports progress and
hands decisions back. `runWorkSurface.ts` and `remoteHostCliAdapter.ts` deliver
it as a file only when a work surface exists. Tool-free Runs stay tool-free.
It is not an optional library package or binding, and cannot be disabled by
turning off an imported Skill.

Judgment rules reuse `systemActions/conversationPolicy.ts`; command mechanics
and the bounded direct-write rules remain in the Work Skill. A Run records its
content hash. Actual authority is always the Run's snapshotted tool grants,
checked on every call. Builtin library packages are separately optional content,
described below; the Work Skill is never registered as one.

## Skill library

### Builtin package source

`skills/builtinPackages.ts` owns the server-shipped package catalog and startup
sync. The catalog is intentionally empty (D9); the only sample package lives in
`server/test/support/builtinSkillFixture.ts`, with no product instructions.
Packages come from code-owned file bytes and an explicit key/release version.
`skill_sources.source_type = 'builtin'` is the existing schema's source-kind
column; no additional `kind` column, table or migration is needed.

Startup `runBuiltInSeeds` syncs each existing Space; `seedSpaceDefaults` also
syncs new Spaces, including registration's personal Space, in its creation
transaction. Each Space gets its own immutable package/source per key and
release, preserving the existing package/binding composite foreign key and
Space read predicates. Stable ids plus a transaction advisory lock serialize
concurrent syncs. Repeating a release leaves its rows and timestamps unchanged;
different bytes under that release are refused, and a new release adds rows
without rewriting prior versions or moving their bindings. Startup validates
the original stored files with the same integrity reader used by Delivery.
Startup sync isolates each Space/release in its own transaction, logs its
failure with Space, package key and version, and continues with other packages
and Spaces. The startup seed runner also catches a sync-level failure so
Evolution, Source and Prompt seeding still runs. New-Space bootstrap remains
strict within the creation transaction; the production-catalog unit test
parses every shipped entry and verifies that its release matches `SKILL.md`.

The shared pure `prepareSkillPackageFiles` builder applies existing path/size
limits, Markdown parsing, inventory hashes and risk scanning. The same atomic
snapshot writer persists source, package and original files. Builtin packages
enter the existing `reviewed` deliverable state as server-provided content,
without external acquisition, import preview, import or review proposals and
without a fabricated human review record. Public import requests cannot claim
this source kind. No scripts, tools, hooks or MCP declarations acquire authority.

Seeding creates **no bindings or proposals** (D10). The library labels the
source **Built-in**, offers no import/content-review controls for it, and keeps
the normal scope binding/enable/disable proposal flow. Only an accepted
`runtime_skill_binding_update` proposal enables it; Runtime Context then uses
the unchanged original-package selection, authorization and Delivery path.
Upgrading a shipped version never enables it or repins an existing binding.

### Open Skill

An Open Skill is an external, portable skill source package. Import accepts
GitHub, uploaded Markdown/folder files or ZIP, and a Skill discovered in the
global CLI Skill directories of an owned Host. Remote URL acquisition supports GitHub only; arbitrary
websites and registries are not fetched. A package usually contains `SKILL.md` plus optional references, assets, scripts, and
vendor metadata.

`skills/skillSourceFetch.ts` uses the shared `sources/outboundUrlSafety`
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

`NormalizedSkill` is the parser, inventory and risk-scan result used by the
importer and content reader. It captures:

- instructions
- package-root-relative resource inventory
- requested permissions and vendor tool declarations
- script or dependency hints
- execution profile hints
- vendor extensions
- deterministic risk analysis

It is not a content authority; runtime delivery reads original package files. Vendor
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

`GET /api/v1/skills/available` takes optional conversation,
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
authority continues to govern every action. Original-package selection reads the immutable files directly.

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

- `GET /api/v1/skills/index` returns a lightweight Skill Library
  Index with effective name/alias plus the active space overlay.
- `GET /api/v1/skills/:skillPackageId/local-overlay` reads the
  active overlay for the requested scope.
- `PUT /api/v1/skills/:skillPackageId/local-overlay` upserts or
  archives the local overlay. It does not mutate `normalized_json` and does not
  approve or enable a Skill binding.

Overlay authority follows the scope it configures
(`PgSkillsRepository.assertOverlayScopeAuthority`). Reading needs read
access to the scope's object, and an unreadable one is answered 404. Writing a
`space` overlay needs a Space owner/admin; a `project` or `project_folder`
overlay a Project writer who also reads the Project; a `user` overlay is that
person's; an ordinary `agent` overlay its manager's (`canChangeAgent`); a
managed Assistant's overlay its configurer's (`canConfigureAssistant`), so a
Space admin's general overlay authority does not reach a creator's or Project
owner's Assistant. An overlay grants no trust, egress or credential use.

## One Runtime Context delivery path

`PgRuntimeSkillProvider.loadCandidatesForRun` delegates to `loadSelectedSkills`
for reviewed packages and effective `skill_bindings`, including canonical
message selections. Acquisition and both Gateway authorization passes use this
same resolver. They retain the execution control's Space, Run, Project, Agent,
viewer, session and canonical message scope; the final pass locks package
selection against concurrent binding/review changes. The Gateway rejects stale
binding ids, versions, instruction text and original-file payloads. An old
`runtime_skill_binding` plan must be rebuilt, never silently accepted.

Items are required delegated instructions with `skill_package_binding` source
references and Run-specific hash versions. Original bytes reach Hosts only in
an accepted `Delivery.skill_packages`, tied to authorized planned-item and
source-item references. Hosts materialize those files, not a normalized
re-rendering. Continuation turns retain the same governed delivery path.

## Review, policy and security

Imports start `imported`, unreviewed and unbound. Review sets `reviewed`;
`rejected`, `archived` and `superseded` remain non-deliverable. The retired
`converted` status is migrated to `reviewed`. Changed external content requires
a new import and hash; changed builtin content requires a new shipped release
and package row. Local overlays cannot change package bytes or grant trust.

Review uses `skill_import_approve`; bindings use `runtime_skill_binding_update`
with operation `skill_package_binding_update`. Both apply through the canonical
proposal registry. Review is a Space decision and cannot be filed under a
Project; binding effects re-check their own scope authority. Pending reviews
are idempotent per person, package hash and operation. No install, conversion,
capability update or capability enable/disable applier remains.

Scripts and dependencies are never executed or installed during import.
Declared tools, hooks and MCP servers register nothing and confer no permission.
Only code-owned System Action entries, Run grants and the gateway can authorize
a call. Imported content is untrusted and cannot directly write active Memory;
Memory retains its own canonical authorization and apply boundary. GitHub
acquisition uses the shared outbound guard; unsupported hosts and private
network destinations fail closed. Preview hashes bind approval to the exact
bounded file inventory that was inspected.

## Workflows and research stages

Reusable enforced processes are approved `workflow_definition.v1` versions,
owned by the Workflow executor, not the Skill library. Auto Research remains a
code-enforced pipeline. Its eight frozen identifiers in
`projectResearch/researchStages.ts` are stage tags, including historical
`runs.capability_id` values; they are neither Skills nor Tools. Research Agents
need no stage ids in `capabilities_json`, and stages deliver no stub Skills.
Procedures remain in `projectResearch/promptRegistry.ts`. The pipeline's future
shape is a separate research-layer plan, not decided by this cleanup.

## Ownership and limits

- `skills`: safe imports, builtin source seeding, original files, risk scan,
  overlays, review and bindings.
- `runtimeContext`: selection acquisition, planning, authorization and Delivery.
- Host adapters: materialization of authorized original files.
- `systemActions`: callable registry and permission-enforced dispatch.
- `automations` / `projectResearch`: enforced process execution.
- `catalog`: read-only diagnostic manifests; `proposals`: review/apply orchestration.

The Skill library does not execute scripts, install dependencies, serve a
marketplace or arbitrary URL importer, or discover ambient runtime Skills.
Runtime compatibility and ambient-discovery rules
remain properties of each adapter. See [runtime-adapters.md](../modules/runtime-adapters.md).
