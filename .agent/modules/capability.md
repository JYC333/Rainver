# Module: Capability

## Purpose
Capabilities are installed, file-defined units of backend behavior. Product
surfaces use the capability framework read model exposed through
`/api/v1/capability-definitions`.

## Owns
- Built-in capability definitions from `server/src/modules/capabilities/registry.ts`.
- Framework capability-definition read APIs and capability packs (`/api/v1/capability-packs`).
- Enable/disable state in `capability_enablements`, changed only through
  `capability_enable` / `capability_disable` proposals that the
  `/api/v1/capability-definitions/:id/enable-proposal` and `/disable-proposal`
  routes create, and their applier.
- Skill packages: skill-source import preview/import from GitHub
  (`/api/v1/skill-sources/*`), `/api/v1/skill-packages` reads, review proposals,
  conversion to a capability, and the local skill overlay
  (`/api/v1/capabilities/skills/*`).

## Does Not Own
- Automation, schedules, or cron triggers.
- Capability marketplace installation.
- Repository clone/install flows.
- Legacy catalog product routes (`/api/v1/capabilities*`).
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

`entrypoint.type: none` is the active manifest convention for catalog-only
capabilities. A future server-native capability executor must be added through the
runtime adapter layer; shell commands, remote code loading, package
installation, broad filesystem access, and subprocess execution are not
supported.

## Discovery

The legacy catalog registry is not a product API authority. Product capability
pages consume `/api/v1/capability-definitions`; built-in capability definitions
come from the server registry module. Historical catalog YAML manifests may
exist for diagnostics or development but do not enter the product path.

The legacy catalog registry loads one source when used internally:

- `builtin`: diagnostic/example capabilities bundled under `catalog/capabilities/`.

The capability package registry does not infer package identity from Project
Folder metadata. Package identity comes from the explicit package source and
reviewed import record; no current code path scans Project Folders for
capability manifests.

Built-in definitions come from `RESEARCH_CAPABILITIES` (`registry.ts`); there is
no external capability discovery. Enabling or disabling a capability creates a
`capability_enable` / `capability_disable` proposal and takes effect only when
that proposal is accepted (ADR 0009); the enabled state lives in
`capability_enablements`, not in manifests. This is still not a marketplace or
remote install system.

## Execution Model

Capability execution is not active. `runtime_key="capability"` is a declared,
`planned`, not-enabled-by-default registry entry in
`server/src/modules/runtimeAdapters/specs.ts`, and `getAgentRuntimeDefinition`
returns nothing for it.
Capability manifests are catalog/UI metadata only.

Returned artifacts are materialized by `materializationService` as `Artifact` rows linked to the Run and project. Returned activities are not materialized: each one records an `output_activity_materialization_error` (activity materialization is deliberately deferred).

## Boundaries

- Executing a capability never installs, updates, or enables capabilities.
- Capability code must not mutate core code directly.
- Durable changes still go through proposals; capability execution does not bypass proposal approval.
- Capability development remains a separate coding-agent workspace, sandbox, and reviewed `code_patch` or future `capability_update` proposal flow.
- External capability installation and updates should eventually go through proposal review.
- Automation can later trigger capability Runs, but scheduling is not part of this module.

## Workflow-as-data (B1)

Versioned workflow definitions use the shared `workflow_definition.v1` protocol
schema and are stored as `workflow_template` evolvable assets. User/space
workflow versions remain proposal-promotion governed. This phase stores and
resolves definitions and records `runs.workflow_version_id`; it does not
execute node graphs. The built-in-template synchronization and static fallback
that this section also described were deleted along with the rest of the
workflow template layer by the capability-shrink plan.

## Related Files

- `server/src/modules/capabilities/` (`routes.ts`, `service.ts`, `registry.ts`, `repository.ts`, `packRegistry.ts`, `skillImporter.ts`)
- `server/src/modules/catalog/` (read-only `/api/v1/server/catalog*` listing of `catalog/`)
- `server/src/modules/runtimeAdapters/`
- `server/src/modules/runs/materializationService.ts`
- `catalog/capabilities/memory_reflect/`
