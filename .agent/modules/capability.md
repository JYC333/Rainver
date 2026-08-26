# Module: Capability

## Purpose
Capabilities are installed, file-defined units of backend behavior. Product
surfaces use the capability framework read model exposed through
`/api/v1/capability-definitions`.

## Owns
- Built-in capability definitions from `server/src/modules/capabilities/registry.ts`.
- Framework capability-definition read APIs.
- Enable/disable state: manifest `enabled` for builtins; persisted instance config for external capabilities.

## Does Not Own
- Automation, schedules, or cron triggers.
- Capability marketplace installation.
- GitHub or remote repository scanning.
- Repository clone/install flows.
- Legacy catalog product routes (`/api/v1/capabilities*`).
- Agent-produced capability updates.
- Proposal approval for code or capability changes.

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

Builtin capabilities follow their manifest `enabled` value. External capabilities default to disabled when discovered. Enable/disable for external capabilities is persisted outside manifests in `$RAINVER_HOME/config/settings.yaml`:

```yaml
capabilities:
  enabled_external_capabilities:
    - research_intake
    - rss_watch
```

Manifests are source definitions only — they are not the local trust/enable store. Persisted enabled IDs that no longer resolve to a discovered capability are ignored safely on reload. Newly discovered external capabilities are never auto-enabled. This is still not a marketplace or remote install system.

## Execution Model

Capability execution is not active today. `adapter_type="capability"` remains a
planned runtime adapter type in `server/src/modules/runtimeAdapters` and
is disabled by default. Until a server-native capability executor exists,
capability manifests are used for catalog/UI metadata only.

Returned artifacts are materialized as `Artifact` rows linked to the Run and project. Returned activities are materialized as `ActivityRecord` rows with `source_kind="run_event"` unless the capability supplies a valid source kind.

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

- `server/src/modules/catalog/`
- `server/src/modules/runtimeAdapters/`
- `server/src/modules/runs/materializationService.ts`
- `catalog/capabilities/memory_reflect/`
