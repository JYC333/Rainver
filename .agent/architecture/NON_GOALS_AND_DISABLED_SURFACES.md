# Non-Goals and Disabled Surfaces

Current absences and product-scope refusals. Unimplemented designs that
used to live here are in
[../plans/unimplemented-from-guides.md](../plans/unimplemented-from-guides.md).

## Currently Disabled or Not Implemented

| Surface | Current fact |
|---|---|
| Broad autonomous discovery / crawling | No crawler engine |
| Connector marketplace / integration lifecycle | No marketplace; Sources connections and recipes exist |
| Capability marketplace or remote install UX | File-defined registry; local workspace roots; no remote install |
| Automatic system self-evolution | Removed; no privileged Evolver Agent |
| App-container self-deployment | Blocked by deployer allowlist |
| Deployment from an Agent, automation, or Proposal | Blocked; instance admin creates the job |
| Arbitrary deployer commands | Only `rebuild_rainver`, `restart_rainver`, `health_check` |
| Automatic restore | Restore is always manual |
| Cloud / offsite backup sync | Not present |
| Multi-device conflict resolution | Not present |
| Public internet sharing | Not present. Instance-local targeted publication exists (`publications`) |
| Public SaaS / multi-tenant | Out of scope |
| API key persistence UI | Feature-gated (501 in production); no `api_keys` table |
| Files & Code interactive session execution | Removed. Files & Code is read-only tree/file/git status/git diff |
| Runtime adapter bypassing credential resolver | Blocked by `RunOrchestrationService` |
| Runtime adapter bypassing sandbox/path policy | Blocked by `execution_workspace` |
| File mutation without approved proposal + PathPolicy | Blocked by code-patch apply |
| Automatic memory promotion from source/evidence | Blocked by proposal/apply |
| Vector index over an **external** corpus | Not present. Space-internal pgvector recall exists |
| Native `capability` runtime adapter | Declared and disabled |
| Time UI | `planned: true` stub at `/time` |
| Cards review UI | Knowledge › Cards placeholder; `/cards` hidden |
| Learning Project Area | `/projects/:id/learning` redirects to Pulse. `learning` HTTP API exists; web client does not call it |

Import and capture that **do** exist: Sources, `POST /api/v1/activity`,
`POST /api/v1/captures`, imported CLI sessions. There is no connector
marketplace UI.

Automation that **does** exist: space-scoped manual and scheduled
Automations, native targets, and versioned Workflows. There is no
external webhook/cron marketplace.

## What Is Allowed for Current Use

- Personal spaces (`personal`) and household shared spaces (`household`).
- Explicit membership and space switching.
- Auth via session cookies or API keys. No dev-identity fallback.
- Activity Inbox via `POST /api/v1/activity`.
- Sources via `/api/v1/sources/*`.
- Capture destinations via `POST /api/v1/captures`.
- Chat sessions (`POST /api/v1/sessions`) and Rooms.
- Memory / Knowledge proposal review and apply.
- Runs through the server runtime adapter path (`model_api` and
  spec-driven local CLI runtimes). The native `capability` adapter is
  disabled.
- RunStep replay, artifacts, task boards, Home / Today aggregates.
- Automatic local backups when `BACKUP_ENABLED=true`.
- Manual backup/restore scripts; allowlisted deployer flow.

## Non-Goals for Development

These are refused product scope, not a backlog:

- Full enterprise RBAC/ABAC.
- Generic `DomainObject` registry or schema editor.
- Full plugin or provider marketplace.
- Broad connector marketplace / integration lifecycle.
- Vector search over an external corpus.
- Broad autonomous discovery and crawling pipeline.
- Unconstrained self-evolution.
- Direct app-container self-deployment.
- Cloud/multi-device sync.
- Domain-specific integrations (health, finance, home automation) in the
  kernel. Official plugins (`diary`, `finance_ledger`) are the opt-in path.
- Publishing connectors or external CMS integrations.
- Full Cards as a complete product surface.
- Complex enterprise admin console or billing.
- Public SaaS/multi-tenant launch.
