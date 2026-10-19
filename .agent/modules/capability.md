# Module: Capability

## Purpose
Product capabilities are the built-in definitions in
`server/src/modules/capabilities/registry.ts`. Product surfaces read them
through `/api/v1/capability-definitions`. Catalog YAML under
`catalog/capabilities/` is a diagnostic catalog. Do not install or execute it.

## Owns
- Built-in capability definitions from `server/src/modules/capabilities/registry.ts`.
- Framework capability-definition read APIs and capability packs (`/api/v1/capability-packs`).
- Enable/disable state in `capability_enablements`, changed only through
  `capability_enable` / `capability_disable` proposals that the
  `/api/v1/capability-definitions/:id/enable-proposal` and `/disable-proposal`
  routes create, and their applier.
- Skill packages: skill-source import preview/import from GitHub
  (`/api/v1/skill-sources/*`; import must carry the preview's `package_hash`),
  `/api/v1/skill-packages` reads (with the caller's `pending_proposal`),
  idempotent review proposals, conversion to a capability, and the local
  skill overlay (`/api/v1/capabilities/skills/*`). See
  [CAPABILITY_WORKFLOW_SKILL_SYSTEM](../architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md)
  for the preview binding, the immutable imported snapshot and the pending
  proposal identity.

## Does Not Own
- Automation, schedules, or cron triggers.
- Capability marketplace installation.
- Repository clone/install flows.
- Agent-produced capability updates.
- Proposal approval decisions for code or capability changes (the proposals
  module decides; this module creates the proposals and applies accepted ones).

## Manifest Shape

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

`entrypoint.type: none` means the catalog entry is not executable. There is
no server-native capability executor. Shell commands, remote code loading,
package installation, broad filesystem access, and subprocess execution are
not supported.

## Discovery

The catalog registry is not a product API authority. Product capability
pages consume `/api/v1/capability-definitions`; built-in capability definitions
come from the server registry module. Catalog YAML under `catalog/capabilities/`
is a read-only diagnostic catalog. It does not enter the product path.

The catalog registry loads one source when used internally:

- `builtin`: diagnostic/example capabilities bundled under `catalog/capabilities/`.

The capability package registry does not infer package identity from Project
Folder metadata. Package identity comes from the explicit package source and
reviewed import record; no current code path scans Project Folders for
capability manifests.

Built-in definitions come from `RESEARCH_CAPABILITIES` (`registry.ts`); there is
no external capability discovery. Enabling or disabling a capability creates a
`capability_enable` / `capability_disable` proposal and takes effect only when
that proposal is accepted (ADR 0009); the enabled state lives in
`capability_enablements`, not in manifests. This is not a marketplace or
remote install system.

## Execution Model

Capability execution is not active. `runtime_key="capability"` is a declared,
`planned`, not-enabled-by-default registry entry in
`server/src/modules/runtimeAdapters/specs.ts`, and `getAgentRuntimeDefinition`
returns nothing for it.
Capability manifests are catalog metadata only. Run materialization persists
`output.artifacts` as Artifact rows. Each `output.activities` entry records
`output_activity_materialization_error` and is not written as Activity.

## Boundaries

- Executing a capability never installs, updates, or enables capabilities.
- Capability code must not mutate core code directly.
- Durable changes still go through proposals; capability execution does not bypass proposal approval.
- `capability_update` is applied by the capabilities module's registered applier.
- This module does not install external capabilities and does not schedule Runs.

## Workflow-as-data (B1)

Versioned workflow definitions use the shared `workflow_definition.v1` protocol
schema and are stored as `workflow_template` evolvable assets. User/space
workflow versions remain proposal-promotion governed. This module stores and
resolves definitions and records `runs.workflow_version_id`. It does not
execute node graphs.

## Related Files

- `server/src/modules/capabilities/` (`routes.ts`, `service.ts`, `registry.ts`, `repository.ts`, `packRegistry.ts`, `skillImporter.ts`)
- `server/src/modules/catalog/` (read-only `/api/v1/server/catalog*` listing of `catalog/`)
- `server/src/modules/runtimeAdapters/`
- `server/src/modules/runs/materializationService.ts`
- `catalog/capabilities/memory_reflect/`
