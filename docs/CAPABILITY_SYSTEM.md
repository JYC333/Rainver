# Skills, Tools And Workflows

| Concept | Meaning and authority |
|---|---|
| Skill | Procedural content read by a model. Imported original package files remain authoritative. |
| Tool / System Action | Code-owned, registered operation, gated on every invocation. |
| Workflow / pipeline | Server-enforced order, gates, checkpoints and retries that start Runs. |
| Official Optional Module | Product feature package with its own per-Space or per-user enablement. |

Rainver owns a Skill's provenance, risk review, scoped bindings and Runtime
Context Delivery authorization. It does not convert the package into a canonical
ability definition. `NormalizedSkill` is the parser and scan result, not a new
content authority. The Skill library lives in `server/src/modules/skills/`
and `/skills`; the legacy definitions, packs, conversion APIs and `/capabilities`
page are removed. One resolver selects reviewed original packages for Delivery;
Hosts materialize their authorized original bytes. Declared tools, hooks,
scripts, dependencies and MCP servers install nothing and grant no permissions.

The required Rainver Work Skill is a code module defining the work-surface
contract, not an optional library package. Auto Research's eight stage tags
belong to its pipeline, not the Skill library. Its future process shape is a
separate decision. Builtin library packages are not implemented by this cleanup.

## Diagnostic catalog

`catalog/capabilities/` retains read-only manifest metadata. Its routes are
`GET /api/v1/server/catalog`, `/server/catalog/capabilities` and
`/server/catalog/agent-templates`. It is not a callable registry or marketplace;
no catalog manifest is executed. Session reflection writes a Memory proposal
through its own service rather than executing the `memory.reflect` manifest.

## Using the unified Skill library

Open **Skills** in the Agent navigation. Import a Skill from the global CLI
directories on a connected Host, GitHub, or a local file.
In the Files tab, drag in one Markdown (`.md`, up to 256 KiB) or ZIP
(`.zip`, up to 3 MiB) file, or click to choose it, then preview and confirm
the import. Markdown content is retained unchanged as `SKILL.md`; use ZIP
for a Skill with supporting files. A ZIP made with macOS Finder imports as
its Skill folder: `__MACOSX/`, AppleDouble `._*` and `.DS_Store` entries are
dropped.
The Local CLIs tab discovers Skills automatically after selecting an online Host;
choose a discovered Skill, preview it, then import. It needs no Project Folder. Preview first, then import that exact hash. By default, importing
files one Proposal that reviews the package and enables it: for the Space when
you are a Space owner or admin, otherwise only for you (only owners and admins
are offered the Space scope). Choose "Import only" to enable it later. If the
enabling request cannot be filed, the import is kept, its review alone is filed
and the dialog says what is left. Approve that Proposal directly in the Skill's
panel, or from Proposals, and the Skill appears in the `/` and `@` menus. Skill
review and scope Proposals need a Space owner or admin (or the Project owner for
a Project scope); a critical-risk package needs the owner. An unreviewed Skill in
the library can likewise be reviewed and enabled for the Space, yourself or an
Agent with one Proposal; Project scope is requested after review. While your
review is pending, asking for a different one points you to the pending one
instead. Binding changes also take effect through Proposals. A more specific
scope overrides a broader scope (Project, Agent, user, Space), including disablement.

In a direct or Room conversation, type `/` or `@` and choose a Skill. Its
`/Skill name` reference appears at the current input position, highlighted like
an `@Agent` mention, with the package version pinned separately. Backspace
removes the whole reference. Delete or change the reference to deselect; typing
a name alone does not select a package. Historical messages that predate inline
references keep their Skill chips. A Room's `@Agent` mention
continues to choose the recipient. All addressed recipients must have the Skill
enabled, so a Room menu lists only Skills enabled for everyone the message will
reach (the manager when nobody is named). Up to four distinct Skills may accompany
a turn, and no text is required. History and retries retain the selected version;
when another Room member retries your turn, your selection must still be enabled
for each recipient or the retry is refused. Updating a Skill means importing and
reviewing a new package.

Limits: 200 files, 256 KiB per file, 2 MiB total; ZIP input up to 3 MiB. Original
text and binary files are retained. Inventory-only older packages need reimport.
Local CLI import follows the Host's folder-read policy and omits forbidden paths,
symlinks and dependency directories. Arbitrary website/registry acquisition is
not available. Hooks and dependencies are not installed automatically; existing
runtime permissions continue to apply. Execution Hosts require daemon **0.4.3+**.

API and storage details:
[Skill, Tool and Workflow architecture](../.agent/architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md).
