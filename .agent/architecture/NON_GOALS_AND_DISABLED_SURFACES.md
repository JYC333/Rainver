# Non-Goals and Disabled Surfaces

## Currently Disabled or Not Implemented

| Surface | Status |
|---|---|
| Broad autonomous discovery / crawling | Not implemented |
| External chat / media / file import pipelines | Not implemented |
| Web crawler | Not implemented |
| Vector index over external corpus | Not implemented |
| Automation / Trigger engine | Not implemented (`Run.trigger_origin` reserves enum values only) |
| Connector marketplace / integration lifecycle | Not implemented |
| Capability marketplace or install/discovery UX | Not implemented (file-defined registry; local workspace roots; external enable state in `config/settings.yaml`; no remote install) |
| Self-evolution behavior execution | Disabled (`ENABLE_SYSTEM_EVOLUTION=false` by default) |
| App-container self-deployment | Blocked by deployer allowlist |
| Deployment job persistence | 501-gated (`POST /deployments/jobs` → 501) |
| Arbitrary deployer commands | Blocked; only `rebuild_agent_space`, `restart_agent_space`, `health_check` |
| Automatic restore | Not implemented; restore is always manual |
| Cloud / offsite backup sync | Not implemented |
| Multi-device conflict resolution | Not implemented |
| Public sharing | Not implemented |
| Public SaaS / multi-tenant | Not in scope |
| API key persistence UI | Feature-gated (501 in production) |
| Files & Code interactive session execution | Removed — never-implemented runtime-status/session create/detail/run/stop stub; Files & Code stays read-only (tree, file, git status, git diff) |
| Runtime adapter bypassing credential resolver | Blocked by `RunOrchestrationService` design |
| Runtime adapter bypassing sandbox/path policy | Blocked by `execution_workspace` contract |
| File mutation without approved proposal + PathPolicy | Blocked by code patch apply |
| Automatic memory promotion from source/evidence content | Blocked by proposal/apply boundary |

**UI status of planned-but-not-built surfaces:**
- `Knowledge` — registry entry with `planned: true`; "soon" badge; non-interactive.
- `Cards` — registry entry with `planned: true`; "soon" badge; non-interactive.
- `Time` — registry entry with `planned: true`; "soon" badge; non-interactive.

No automation, connector marketplace, crawler, or self-evolution controls appear in the frontend.

## What Is Allowed for Current Use

- Personal spaces (`personal` space type) and household shared spaces (`household` space type).
- Explicit two-user membership and space switching.
- Auth via session cookies or API keys. No dev-identity fallback.
- Activity Inbox for non-chat capture (thoughts, notes, snippets, links) via `POST /api/v1/activity`.
- Sources for source connections, manual URL source capture, candidate items, extraction jobs, and citable evidence via `/api/v1/sources/*`.
- Explicit chat sessions for conversations with agents (`POST /api/v1/sessions`).
- Memory proposal creation, review, acceptance, rejection, and archive.
- Memory consolidation producing proposals from Activity.
- Runs through the canonical server runtime adapter path (`capability`, `model_api`, and spec-driven local CLI runtimes).
- RunStep replay and failure diagnosis.
- Artifacts produced by runs; safe export within owned space.
- Task boards and task-linked runs/artifacts/proposals.
- Home summary as read-only command center.
- Automatic local backups through `BackupService` (requires `BACKUP_ENABLED=true`).
- Manual backup via API or `ops/scripts/system/backup.sh` (offline full-system).
- Full-system restore via `ops/scripts/system/restore.sh`; DB-only tools under `ops/scripts/db/`.
- Manual deployment or allowlisted deployer-only flow.

## Non-Goals for Development

These will not be built until their prerequisite foundations are stable:

- Full enterprise RBAC/ABAC.
- Generic `DomainObject` registry or schema editor.
- Full plugin or provider marketplace.
- Broad connector marketplace / integration lifecycle.
- Full vector search or external search index.
- Broad autonomous discovery and crawling pipeline.
- Unconstrained self-evolution.
- Direct app-container self-deployment.
- Cloud/multi-device sync.
- Domain-specific integrations (health, finance, home automation) built into the kernel.
- Publishing connectors or external CMS integrations.
- Full cards as a complete product surface with first-class backend domain models.
- Complex enterprise admin console or billing.
- Public SaaS/multi-tenant launch.

## What Must Be True Before Building Disabled Surfaces

**Before broad automated source ingestion / crawling:**
Sources/Evidence trust vocabulary, retention semantics, and candidate-to-Memory proposal path must stay fully tested. No auto-promotion of external evidence to trusted Memory.

**Before Automation / Trigger:**
Policy engine, ownership model, actor identity, and proposal-safe automation invariants must be documented and tested.

**Before connector marketplace / integrations:**
All connector data must enter Sources or Activity first. No direct-to-Memory connector writes.

**Before self-evolution execution:**
Evaluation gates, sandboxed experiment runs, deployment job persistence, capability lifecycle persistence, and rollback path must all be tested.

**Before any broad external ingestion:**
Retention/deletion semantics, Sources/Evidence candidate-only boundary, and trust gate must be enforced and tested.
