# Capability System

> **Capability ≠ Official Optional Module.**
> A product capability is a definition in `server/src/modules/capabilities/`.
> Catalog YAML is diagnostic and is not executed.
> An Official Optional Module is a product feature package with DB-backed enable/disable state per space/user.
> They are separate concepts. See `.agent/architecture/OFFICIAL_OPTIONAL_MODULES.md` and ADR 0009.

## What is a capability?

A product capability is a definition owned by
`server/src/modules/capabilities/`. The YAML under `catalog/capabilities/`
is a read-only diagnostic catalog. It is not the product capability path.
Do not execute a catalog manifest.

A catalog directory may hold `capability.yaml`, a README, and prompt files.
Those files are metadata.

## capability.yaml fields

```yaml
id: research_intake
name: Research Intake
version: 0.1.0
description: Parse an intake payload into structured research output
enabled: false

entrypoint:
  type: none

permissions:
  network:
    allow: []
  filesystem:
    read: []
    write: []
  subprocess:
    allow: false

outputs:
  artifact_types:
    - research_intake.result.v1
```

`entrypoint.type: none` means the catalog entry is not directly executable.
The `capability` runtime key is `implementation_status: "planned"` and is not
enabled. Do not route a catalog manifest through `runtimeAdapters`. Shell
commands, remote code loading, broad filesystem access, and subprocess
execution are not supported.

## Catalog

The `catalog` server module reads the bundled manifests under
`catalog/capabilities/` (and agent template specs under
`catalog/agent-templates/`) read-only. Its routes are
`GET /api/v1/server/catalog`, `GET /api/v1/server/catalog/capabilities`, and
`GET /api/v1/server/catalog/agent-templates`. There is no reload route and no
external or workspace capability source.

This is not a marketplace or remote install system.

## Capability / Workflow / Open Skill Framework

The product control plane for canonical capability definitions, capability
packs, imported Open Skill packages, and runtime skill bindings is the
`capabilities` server module.
`catalog` remains the raw on-disk manifest reader.

Key distinctions:

| Concept | Meaning |
|---|---|
| Open Skill | External portable source package, usually `SKILL.md`; untrusted by default. |
| NormalizedSkill | Internal intermediate representation produced from imported skill content. |
| CapabilityDefinition | Rainver canonical ability object and source of truth. |
| CapabilityPack | Grouping of related capabilities, artifact types, docs/tests/examples. |
| Runtime Skill | Generated Claude/Codex/OpenCode ACP content; not source of truth. |
| Product Plugin | Optional product feature package; separate from capabilities. |

Open Skill import must not execute scripts, install dependencies, load
third-party server code, write active memory, or auto-enable capabilities.
Imported Skills retain their original package bytes and are risk-scanned.
The unified library reviews and binds packages directly; normalized conversion
remains a legacy API and is not required for invocation.

## Catalog entries

`catalog/capabilities/` holds `memory.reflect` and
`capture-memory-extraction`. They are manifest metadata. Session reflection
(`POST /api/v1/sessions/:sessionId/reflect`) writes a `memory_create`
proposal from the recent transcript. It does not run `memory.reflect`.

## Execution

The `capability` runtime (`runtime_key="capability"` in
`runtimeAdapters/specs.ts`) has `implementation_status: "planned"` and is not
enabled by default. It is not a selectable ACP Agent runtime. Server routes
expose capability manifest metadata for catalog and UI use.

Explicitly selected Skills reach Claude Code, Codex and other Host ACP
runtimes as original package files through authorized Runtime Context Delivery.
Builtin capability renderings remain a separate path. Approved original
package snapshots are the content authority for imported Skills.

## Related code

- `server/src/modules/catalog/`
- `server/src/modules/capabilities/`
- `server/src/modules/runtimeAdapters/specs.ts`

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
[Capability/Skill architecture](../.agent/architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md).
