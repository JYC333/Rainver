# Roadmap

## Shipped Foundations

- Space / user / Project Folder data model with space isolation and two-user membership
- Actor identity and `ActorRef` on new audit/event surfaces
- Proposal-first memory and policy write boundaries
- Memory ACL, read traces, source monitoring, and provenance chain
- Activity-first non-chat capture; consolidation → proposal pipeline
- Canonical Intake/Evidence foundation: source connectors/connections, intake items, snapshots, extraction jobs, evidence links, and context evidence refs
- `Run` as central execution object; `RunStep` replay spine
- Runtime adapter abstraction (`server/src/modules/runtimeAdapters/` canonical); credential resolver
- Artifact persistence, export, and path safety
- Task board ORM (`Task`, `Board`, `TaskRun`, `TaskArtifact`, `TaskProposal`)
- Persisted policy enforcement: `memory.private_placement` and `run.user_private_scope` through server policy services; structural write boundary through proposal apply services
- Explicit server transaction helpers; savepoint-isolated RunStep evidence
- `BackupService` canonical full-system backup; `ops/scripts/system/backup.sh` + `ops/scripts/system/restore.sh` offline full-system tools; `ops/scripts/db/` DB-only tools
- Project Folder lifecycle: archive/unregister on missing paths (no hard-delete; the physical directory is left untouched)
- Deployer allowlist and Unix domain socket boundary
- Home summary aggregation API
- Layered `.agent/` context documentation

## Current Engineering Focus

- Incident collection and post-cutover audit from dogfooding
- Documentation/source sync against current route registry, module ownership,
  frontend contracts, and explicit deferred/fail-closed surfaces
- Frontend/backend type contract alignment (memory proposals, Project Folder fields, space type)
- Home command center work over backend aggregate read models, not frontend
  reconstruction of domain logic
- Artifact archive/delete API
- Activity archive/delete
- Additional persisted policy enforcement classes

## Intentionally Deferred

- Full mobile app (PWA stubs only)
- Full desktop app (Tauri scaffold; see [0005](decisions/0005-desktop-runtime.md))
- Full local-first sync
- Broad autonomous discovery, crawling, and external corpus indexing
- Connector marketplace / integration lifecycle
- Self-evolution execution (disabled by default)
- Cloud/offsite backup sync
- Deployment job persistence
- Capability marketplace or lifecycle persistence
- Full RBAC/ABAC policy system

## Reference

- [ARCHITECTURE.md](ARCHITECTURE.md) — layer map
- [BOUNDARIES.md](BOUNDARIES.md) — invariants
- [architecture/ROADMAP_AND_FUTURE_RISKS.md](architecture/ROADMAP_AND_FUTURE_RISKS.md) — capability line roadmap and future risks
- [architecture/NON_GOALS_AND_DISABLED_SURFACES.md](architecture/NON_GOALS_AND_DISABLED_SURFACES.md) — disabled surfaces
