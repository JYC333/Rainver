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
Imported skills are normalized and risk-scanned before any conversion into
Rainver capability candidates.

## Built-in capabilities

| ID | Purpose |
|---|---|
| `memory.reflect` | Analyze sessions, generate memory proposals |
| `capture-memory-extraction` | Extract memory candidates from raw capture and produce proposal-first memory updates |

## Execution

Capability execution is not active today. The registry entry is
`runtime_key="capability"` (`runtimeAdapters/specs.ts`), still
`implementation_status: "planned"` and not enabled by default; it is not a
selectable ACP Agent runtime. Current server routes expose
capability manifest metadata for catalog and UI use.

Claude Code and Codex receive generated skill files; OpenCode receives a
generated prompt block through ACP Runtime Context Delivery. These are render
targets, not authorities. Rainver capability definitions and approved skill
snapshots remain the source of truth.

## Related code

- `server/src/modules/catalog/`
- `server/src/modules/capabilities/`
- `server/src/modules/runtimeAdapters/specs.ts`
