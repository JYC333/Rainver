# Roadmap

This file records **shipped** foundations. Unimplemented ideas that used to
live here are in
[plans/unimplemented-from-guides.md](plans/unimplemented-from-guides.md).
Work is pulled from [plans/backlog.md](plans/backlog.md) or
[tasks/deferred-register.md](tasks/deferred-register.md).

## Shipped Foundations

- Space / user / Project Folder data model with space isolation
- Actor identity on audit/event surfaces
- Proposal-first memory and policy write boundaries
- Memory ACL, read traces, source monitoring, and provenance chain
- Activity-first non-chat capture; consolidation → proposal pipeline
- Source connectors/connections, intake items, snapshots, extraction jobs,
  evidence links
- `Run` as central execution object; `RunStep` replay spine
- Runtime adapter specs; host-daemon CLI execution (ADR 0016)
- Artifact persistence, export, and path safety under `$RAINVER_HOME/storage/artifacts`
- Task board (`Task`, `Board`, `TaskRun`, `TaskArtifact`, `TaskProposal`)
- Persisted policy classes including `memory.private_placement` and
  `run.user_private_scope`
- Explicit server transaction helpers
- `BackupService` full-system backup; `ops/scripts/system/backup.sh` +
  `restore.sh`; `ops/scripts/db/` DB-only tools
- Project Folder archive/unregister on missing paths (no hard-delete of the
  physical directory)
- Deployer allowlist, Unix domain socket, and persisted `deployment_jobs`
  (ADR 0020)
- Home / `/me` aggregate read models
- Manual and scheduled Automations, including native targets and versioned
  Workflows
- Knowledge / Notes / Graph / targeted publications
- Layered `.agent/` context documentation

## Reference

- [ARCHITECTURE.md](ARCHITECTURE.md) — layer map
- [BOUNDARIES.md](BOUNDARIES.md) — invariants
- [architecture/NON_GOALS_AND_DISABLED_SURFACES.md](architecture/NON_GOALS_AND_DISABLED_SURFACES.md) — current absences
- [plans/unimplemented-from-guides.md](plans/unimplemented-from-guides.md) — extracted unimplemented designs
