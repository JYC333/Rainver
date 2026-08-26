# Capability System

> **Capability ≠ Official Optional Module.**
> A Capability is an agent AI skill/behavior descriptor (this document).
> An Official Optional Module is a product feature package with DB-backed enable/disable state per space/user.
> They are separate concepts. See `.agent/architecture/OFFICIAL_OPTIONAL_MODULES.md` and ADR 0009.

## What is a capability?

A capability is a versioned, self-describing unit of agent behaviour.
It is not just a prompt — it is a folder containing:

```
capabilities/<capability-id>/
├── capability.yaml     Manifest (required)
├── README.md           Human docs (optional)
├── prompts/            Prompt assets (optional)
└── tests/              Capability tests (optional)
```

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

Capability manifests are catalog metadata today. `entrypoint.type: none` means
the capability is discoverable but not directly executable by a capability
runtime. A future server-native capability executor must be added through
`server/src/modules/runtimeAdapters` and guarded like any other runtime
adapter; shell commands, remote code loading, broad filesystem access, and
subprocess execution remain unsupported.

## Capability Registry

The `CapabilityRegistry` loads capabilities from two sources:

1. **Builtin** — manifests under `catalog/capabilities/` (bundled with the server image).
2. **External workspace** — manifests under local roots registered on a `capability_library` workspace.

Reload happens through the server catalog routes, including
`POST /api/v1/capabilities/reload`.

### External workspace discovery

Register a workspace with:

- `workspace_type = "capability_library"` — real `Workspace.workspace_type` column
- `metadata_json.capability_roots` — list of relative local paths, e.g. `["capabilities"]`

Example workspace create payload fields:

```json
{
  "workspace_type": "capability_library",
  "metadata_json": {
    "capability_roots": ["capabilities"]
  }
}
```

External capability roots are **local only**. The registry does not scan GitHub URLs, remote URLs, absolute paths, or paths that escape the workspace root. Ordinary (`project`) workspaces are not scanned.

### Enable / disable state

| Source | Default | Persisted? |
|--------|---------|------------|
| Builtin | manifest `enabled` (default `true`) | No — manifest is source of truth on reload |
| External workspace | disabled | Yes — `$RAINVER_HOME/config/settings.yaml` |

Persisted shape:

```yaml
capabilities:
  enabled_external_capabilities:
    - research_intake
    - rss_watch
```

Manifests define capability code and metadata; they are **not** the local trust/enable store for external capabilities. Persisted IDs for capabilities that are no longer discovered are ignored safely. Newly discovered external capabilities are never auto-enabled.

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
| Runtime Skill | Generated Claude/Codex/model_api adapter content; not source of truth. |
| Product Plugin | Optional product feature package; separate from capabilities. |

Open Skill import must not execute scripts, install dependencies, load
third-party server code, write active memory, or auto-enable capabilities.
Imported skills are normalized and risk-scanned before any conversion into
Rainver capability candidates.

## Built-in capabilities

| ID | Purpose |
|---|---|
| `memory.reflect` | Analyze sessions, generate memory proposals |

## Execution

Capability execution is not active today. `adapter_type="capability"` remains a
planned runtime adapter type and is disabled by default. Current server routes expose
capability manifest metadata for catalog and UI use.

Runtime-specific Claude Code, Codex, and `model_api` skill files are generated
render targets. Rainver capability definitions and profiles remain the
source of truth.

## Related code

- `server/src/modules/catalog/`
- `server/src/modules/capabilities/`
- `server/src/modules/runtimeAdapters/specs.ts`
