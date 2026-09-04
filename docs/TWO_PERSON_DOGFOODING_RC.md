# Two-Person Dogfooding Release Candidate Runbook

**RC declared:** 2026-05-16
**Scope:** Local two-person dogfooding only.

---

## A. RC Purpose

This runbook describes the release-candidate boundary for two-person local dogfooding of
Rainver. The system's foundation — space isolation, actor identity, run replay, runtime
and credential boundaries, policy enforcement, activity provenance, backup/restore, and
deployment control — is hardened and tested.

**What this is:**

- Local two-person dogfooding on a single host instance.
- A gate that is honest about allowed and disabled surfaces.

**What this is not:**

- Public launch.
- SaaS or remote multi-tenant deployment.
- A test of all future ambitions (Automation, connector marketplace, crawler,
  marketplace, mobile client).

**Rule:** Only allowed surfaces may be used for daily dogfood workflows. Disabled surfaces
must not be relied on. If a disabled surface is required for normal use, dogfooding must
stop and the surface must be gated before resuming.

---

## B. Allowed Surfaces

The following surfaces are allowed after all release gates pass:

**Spaces and users**
- Personal spaces (`personal` space type).
- Household shared space (`household` space type).
- Explicit two-user membership and space switching.
- Auth via session cookies or API keys. No dev identity fallback.

**Activity**
- Activity Inbox for non-chat capture: thoughts, notes, snippets, links.
- All non-chat capture enters Activity first via `POST /api/v1/activity`.
- Explicit chat sessions only for real conversations with agents (`POST /api/v1/sessions`).

**Intake and evidence**
- Source connections, manual URL intake, candidate item triage, extraction jobs, and citable evidence.
- Intake content remains candidate material; active Memory still requires proposal review.

**Memory**
- Memory proposal creation, review, acceptance, rejection, and archive.
- Memory read and search with ACL, provenance, and proposal-first boundaries.
- Archived memory excluded from active reads.
- Memory consolidation producing proposals from Activity.

**Runs and execution**
- Runs through the canonical server runtime adapter path only.
- RunStep replay and failure diagnosis via `GET /api/v1/runs/{id}/steps`.
- Artifacts produced by runs; safe export within owned space.

**Proposals**
- Proposals linked to runs, tasks, artifacts, and memory where supported.
- `code_patch` proposals via approved-proposal-only apply path.

**Tasks and boards**
- Task boards and task-linked runs/artifacts/proposals.

**Home and status**
- Home summary as read-only command center.
- Provider/runtime status where secrets are redacted.

**Backup and restore**
- Automatic local backups through `BackupService` (primary — `BACKUP_ENABLED=true` required).
- Manual backup via `POST /api/v1/system/backups/manual` or, offline, `ops/scripts/system/backup.sh`.
- Full-system restore through `ops/scripts/system/restore.sh`. DB-only tools under `ops/scripts/db/`.
- Restore is always manual and explicit.

**Deployment**
- Manual deployment or allowlisted deployer-only flow.
- No arbitrary shell commands through the deployer.

---

## C. Disabled Surfaces

The following surfaces are disabled, 501-gated, feature-gated, or not trusted for RC.
Do not rely on any of these for daily dogfood workflows.

| Surface | Status |
|---|---|
| Broad autonomous discovery / crawling | Not implemented |
| External chat/media/file import pipelines | Not implemented |
| Web crawler | Not implemented |
| Vector index over external corpus | Not implemented |
| Automation/Trigger engine | Not implemented |
| Connector marketplace / integration lifecycle | Not implemented |
| Full capability marketplace or install/discovery UX | Not implemented |
| Automatic system self-evolution | Removed; Evolution runs require an explicit Agent |
| App-container self-deployment | Blocked by 501 product routes and private deployer socket |
| Deployment job persistence | 501-gated (`POST /deployments/jobs` → 501) |
| Arbitrary deployer commands | Blocked; exactly three argument-free core jobs are allowlisted |
| Automatic restore | Not implemented; restore is always manual |
| Cloud/offsite backup sync | Not implemented |
| Multi-device conflict resolution | Not implemented |
| Public sharing | Not implemented |
| Public launch / SaaS | Not in scope |
| Remote multi-tenant deployment | Not in scope |
| API key persistence UI | Feature-gated if not yet implemented |
| Workspace console persisted sessions | Feature-gated if not yet implemented |
| Any runtime adapter bypassing the credential resolver | Blocked by `RunOrchestrationService` design |
| Any runtime adapter bypassing sandbox/path policy | Blocked by `execution_workspace` contract |
| File mutation not protected by approved proposal + PathPolicy | Blocked by code patch apply boundary |

**UI status of planned-but-not-built surfaces:**

- `Knowledge` — registry entry with `planned: true`; displays "soon" badge; non-interactive.
- `Cards` — registry entry with `planned: true`; displays "soon" badge; non-interactive.
- `Time` — registry entry with `planned: true`; displays "soon" badge; non-interactive.

No connector marketplace, crawler, or automatic system self-evolution controls appear in the frontend.

---

## D. RC Config Requirements

The following config must be set in `~/.rainver-data/<mode>/.env` before dogfooding begins.

### Required backup config

```env
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_COUNT=7
BACKUP_INCLUDE_LOGS=false
BACKUP_ON_STARTUP=true
```

`BACKUP_ENABLED=true` is the minimum required setting. Without it, no automatic backups
are created and dogfood data is unprotected.

`BACKUP_ON_STARTUP=true` is the default. It causes the SchedulerRegistry-registered
backup task to run one backup immediately after startup in the background, so service
readiness and dependent containers are not blocked while the archive is created.
Leave it at the default for dogfooding.

`BACKUP_ROOT` defaults to `RAINVER_HOME/backups/`. Override only if you need a
non-standard location.

`INSTANCE_ADMIN_EMAIL` must be set only for the deployment owner who should manage
instance-level runtime tools and other server-wide admin surfaces.

### Auth config

```env
SERVER_DEBUG=false
```

All authenticated calls require a real session cookie or API key. No dev-identity fallback exists.

### Runtime

```env
DEFAULT_USER_ID=default_user
```

This bootstrap default is used only for single-user personal mode initialization;
the default space is this owner's personal space (a generated UUID, resolved from
the DB — there is no fixed/magic space id).
Multi-user dogfooding requires each user to authenticate with their own credentials.

### Where config lives

- Host: `~/.rainver-data/<mode>/.env` (never stored in the repo).
- In Docker: mounted at `/rainver/.env` through the Compose volume.
- See `ops/compose/docker-compose.dev.yml` for volume mapping.

### Where runtime data lives

```
RAINVER_HOME/          (default: ~/.rainver-data/dev/)
  .env                     Deployment settings and secrets
  db/                      PostgreSQL data volume + pg_dump archives
  storage/                 Artifact storage files
  secrets/                 Encrypted provider key files
  config/                  Runtime configuration
  workspaces/              Workspace metadata
  backups/                 Backup archives (auto-pruned to BACKUP_RETENTION_COUNT)
  logs/                    Application logs (optional; BACKUP_INCLUDE_LOGS=false by default)
```

Backups are stored at `RAINVER_HOME/backups/` by default. Normal archives contain `db/`,
`storage/`, `config/`, and `workspaces/`. Logs optional. `secrets/` and the mode `.env` use the
separate sensitive recovery archive workflow; the environment is stored as `instance.env` and
restored to `.env.restored` for review by default. `backups/` and `sandboxes/` are always excluded.

### Allowed runtime adapters for RC

- `model_api` — managed API runtime; credentials resolved through `ModelProvider`
  encrypted keys via `server/src/modules/providers/`.
- `claude_code` / `codex_cli` — local CLI runtimes; credentials are profile-bound
  through the CLI credential broker.

No adapter may read `ANTHROPIC_API_KEY` from the environment directly. Managed API
credentials must resolve through `server/src/modules/providers/`; CLI runtime
credentials must resolve through the CLI CredentialBroker.

### Deployment posture

- `POST /deployments/jobs` returns 501. Deployment job persistence is absent.
- Deployer `ALLOWED_JOB_TYPES` is exactly `rebuild_rainver`,
  `restart_rainver`, and `health_check`; these jobs accept no request arguments.
- The deployer socket is private to its privileged sidecar; product paths cannot submit jobs.
- Evolution runs require an explicitly selected Agent and cannot create a privileged
  system-evolution Agent.

---

## E. Test Commands

Run all of these before declaring RC ready.

### Full server suite

```bash
cd server
pnpm run typecheck
pnpm test -- --hookTimeout=60000
```

Expected: all server tests pass. Tests that need Docker/Postgres may skip
when no container runtime is available.

### Frontend typecheck

```bash
cd apps/web
pnpm run typecheck
```

Expected: no output (no errors).

### Frontend build

```bash
cd apps/web
pnpm run build
```

Expected: clean build with no TypeScript or bundler errors.

### Script syntax check

```bash
bash -n ops/scripts/system/backup.sh ops/scripts/system/restore.sh ops/scripts/db/*.sh
```

Expected: no output (no syntax errors).

### Optional: shellcheck

```bash
shellcheck ops/scripts/system/backup.sh ops/scripts/system/restore.sh ops/scripts/db/*.sh
```

### Focused test groups by boundary

```bash
cd server

# API entrypoint and route registry
pnpm test -- gateway.test.ts composeConfig.test.ts

# Auth, spaces, memory, proposals, artifacts, workspace routes
pnpm test -- authRoutes.test.ts memoryRoutes.test.ts proposalsRoutes.test.ts artifactsRoutes.test.ts workspacesRoutes.test.ts

# Runtime, policy, run orchestration, and path safety
pnpm test -- policyDecisionCore.test.ts policyEnforceService.test.ts policyRoutes.test.ts runsRoutes.test.ts runtimeHost.test.ts workspacesPathPolicy.test.ts

# Jobs, backup, schedulers, deployment boundary
pnpm test -- jobsSchedulers.test.ts backups.test.ts deploymentClient.test.ts
```

---

## F. Two-User Smoke Test

This is a manual test. Run it before first dogfood writes.

**Prerequisites:** frontend and server running with dogfood config. `BACKUP_ENABLED=true`.

### Step 1 — Startup and backup verification

```bash
./ops/scripts/start.sh
# Wait for server to start, then:
curl -s http://localhost:3000/api/v1/server/health
# Expected: {"status": "ok", ...}
```

Verify the scheduler registry started the backup task in startup logs:
```
INFO  scheduler registry started tasks=...backup_scheduler...
```

Or trigger a manual backup and confirm:
```bash
curl -s -X POST http://localhost:3000/api/v1/system/backups/manual \
  -H "X-API-Key: <dogfood-api-key>"
# Expected: {"status": "ok", "backup": "manual-YYYYMMDD-HHMMSS.tar.gz"}

curl -s http://localhost:3000/api/v1/system/backups \
  -H "X-API-Key: <dogfood-api-key>"
# Expected: list with at least one archive containing backup_manifest.json
```

Inspect the manifest:
```bash
tar -xOf ~/.rainver-data/dev/backups/manual-*.tar.gz backup_manifest.json | python3 -m json.tool
# Expected: backup_format="rainver-backup.v1", included_paths lists db/ etc.
```

### Step 2 — User setup

Create or confirm two users with distinct credentials:
- **User A** — personal space `personal`, user ID `user_a` (or registered email).
- **User B** — personal space `personal`, user ID `user_b` (or registered email).
- Confirm a `household` space exists with both as members.

```bash
# As User A: list spaces
curl -s "http://localhost:3000/api/v1/spaces" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: personal space for User A

# As User B: list spaces
curl -s "http://localhost:3000/api/v1/spaces" \
  -H "X-API-Key: <user-b-api-key>"
# Expected: personal space for User B

# As either user: confirm household space membership
curl -s "http://localhost:3000/api/v1/spaces?space_type=household" \
  -H "X-API-Key: <user-a-api-key>"
```

### Step 3 — Private space isolation

```bash
# User B attempts to access User A's personal space — must be 403
curl -s "http://localhost:3000/api/v1/memory?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-b-api-key>"
# Expected: HTTP 403

# User A attempts to access User B's personal space — must be 403
curl -s "http://localhost:3000/api/v1/memory?space_id=<user-b-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: HTTP 403
```

### Step 4 — Shared space access

```bash
# Both users can read household space memory
curl -s "http://localhost:3000/api/v1/memory?space_id=<household-space-id>&status=active" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: 200 (may be empty list)

curl -s "http://localhost:3000/api/v1/memory?space_id=<household-space-id>&status=active" \
  -H "X-API-Key: <user-b-api-key>"
# Expected: 200 (same list)
```

### Step 5 — Non-chat capture and Activity Inbox

```bash
# User A captures a thought — must create ActivityRecord, not Session
curl -s -X POST "http://localhost:3000/api/v1/activity" \
  -H "X-API-Key: <user-a-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"space_id": "<user-a-personal-space-id>", "content": "Test thought for RC smoke test", "source_type": "user_capture", "activity_type": "capture"}'
# Expected: 201 with ActivityRecord id

# Confirm it appears in Activity Inbox
curl -s "http://localhost:3000/api/v1/activity?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: list including the new ActivityRecord
```

### Step 6 — Memory proposal from Activity

Trigger consolidation or create a proposal manually:
```bash
# Consolidate activity into proposal
curl -s -X POST "http://localhost:3000/api/v1/memory/consolidation/run" \
  -H "X-API-Key: <user-a-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"batch_limit": 50}'

# Check proposals
curl -s "http://localhost:3000/api/v1/proposals?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: at least one proposal with provenance_entries referencing the ActivityRecord
```

### Step 7 — Proposal accept and provenance

```bash
# Accept the proposal
curl -s -X POST "http://localhost:3000/api/v1/proposals/<proposal-id>/accept" \
  -H "X-API-Key: <user-a-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"space_id": "<user-a-personal-space-id>"}'
# Expected: 200 with resulting_memory_id

# Confirm MemoryEntry exists and provenance_links carry the Activity source
curl -s "http://localhost:3000/api/v1/memory/<memory-id>?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: source_trust present

psql "$SERVER_DATABASE_URL" -c \
  "select source_type, source_id from provenance_links where target_type = 'memory' and target_id = '<memory-id>';"
# Expected: one row with source_type='activity' and source_id=<activity-id>
```

### Step 8 — Memory archive

```bash
# Archive the memory (must return proposal, not direct delete)
curl -s -X DELETE "http://localhost:3000/api/v1/memory/<memory-id>?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: 202 with memory_archive proposal

# Accept archive proposal
curl -s -X POST "http://localhost:3000/api/v1/proposals/<archive-proposal-id>/accept" \
  -H "X-API-Key: <user-a-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"space_id": "<user-a-personal-space-id>"}'

# Confirm archived memory is excluded from active reads
curl -s "http://localhost:3000/api/v1/memory?space_id=<user-a-personal-space-id>&status=active" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: archived entry not in list
```

### Step 9 — Run and RunStep replay

```bash
# Create a run (model_api adapter — requires a configured ModelProvider)
curl -s -X POST "http://localhost:3000/api/v1/runs" \
  -H "X-API-Key: <user-a-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"space_id": "<user-a-personal-space-id>", "adapter_type": "model_api", "input": "smoke test"}'
# Note run_id

# Check RunSteps (may need to wait for run to complete)
curl -s "http://localhost:3000/api/v1/runs/<run-id>/steps?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: ordered list of RunStep records
```

### Step 10 — Artifact export

```bash
# List artifacts for the run
curl -s "http://localhost:3000/api/v1/artifacts?space_id=<user-a-personal-space-id>&run_id=<run-id>" \
  -H "X-API-Key: <user-a-api-key>"

# Export artifact inline
curl -s "http://localhost:3000/api/v1/artifacts/<artifact-id>/export?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: artifact content

# Cross-space export must fail
curl -s "http://localhost:3000/api/v1/artifacts/<artifact-id>/export?space_id=<user-b-personal-space-id>" \
  -H "X-API-Key: <user-b-api-key>"
# Expected: 404
```

### Step 11 — Home summary

```bash
curl -s "http://localhost:3000/api/v1/home/summary?space_id=<user-a-personal-space-id>" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: 200 with read-only summary object
```

### Step 12 — Disabled surfaces check

```bash
# Deployment jobs must be 501
curl -s -X POST "http://localhost:3000/api/v1/deployments/jobs" \
  -H "X-API-Key: <user-a-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"job_type": "arbitrary", "target": "local"}'
# Expected: 501

# Deployment jobs list must be empty
curl -s "http://localhost:3000/api/v1/deployments/jobs" \
  -H "X-API-Key: <user-a-api-key>"
# Expected: []
```

In the frontend:
- Navigate to all gallery cards; confirm no connector marketplace, crawler, or automatic
  system self-evolution controls are visible.
- Wiki, Cards, and Time cards show "soon" badge and are non-interactive.

---

## G. Backup and Restore Rehearsal

Run this before first write session and periodically during dogfooding.

### Verify automatic backup is configured

```bash
grep BACKUP_ENABLED ~/.rainver-data/dev/.env
# Expected: BACKUP_ENABLED=true

# Check server startup logs for scheduler confirmation
docker compose -p rainver-dev -f ops/compose/docker-compose.dev.yml logs server | grep "backup_scheduler"
# Expected: scheduler registry started with backup_scheduler
```

### Trigger a manual backup (API, or offline CLI)

**API (server running):**
```bash
curl -s -X POST http://localhost:3000/api/v1/system/backups/manual \
  -H "X-API-Key: <dogfood-api-key>"
# Expected: {"status": "ok", "backup": "manual-YYYYMMDD-HHMMSS.tar.gz"}
```

**Offline full-system CLI (server not running, postgres up):**
```bash
ops/scripts/system/backup.sh --mode dev
# Archives to ~/.rainver-data/dev/backups/system-<timestamp>.tar.gz
# Same archive format as BackupService (PostgreSQL snapshot + files + backup_manifest.json)
```

### List backup archives

```bash
curl -s http://localhost:3000/api/v1/system/backups \
  -H "X-API-Key: <dogfood-api-key>"
# Expected: JSON list of archives with name, size, created_at

# Or list on filesystem
ls -lh ~/.rainver-data/dev/backups/
```

### Inspect backup_manifest.json

```bash
ARCHIVE=$(ls ~/.rainver-data/dev/backups/auto-*.tar.gz | tail -1)
tar -xOf "$ARCHIVE" backup_manifest.json | python3 -m json.tool
```

Expected fields in manifest:
- `backup_format: "rainver-backup.v1"`
- `kind: "auto"` or `"manual"`
- `created_at` — ISO timestamp
- `source_root` — absolute path of data root at backup time
- `included_paths` — list: `db/rainver.dump`, `storage/`, `artifacts/`, `config/`, `workspaces/`; never `secrets/`
- `excluded_paths` — `backups/`, `sandboxes/`, `cache/`, `db/postgres/` with reason
- `db_snapshot_method: "pg_dump_custom"`
- `warnings` — empty list for clean backup

### Restore rehearsal (full-system: database + files)

Rehearse against the disposable `test` mode so the live `dev` data is untouched.

**Stop the app, leave postgres running:**
```bash
docker compose -p rainver-test -f ops/compose/docker-compose.test.yml stop server frontend deployer
docker compose -p rainver-test -f ops/compose/docker-compose.test.yml up -d postgres
```

**Restore:**
```bash
ARCHIVE=~/.rainver-data/dev/backups/auto-<timestamp>.tar.gz

# Full-system restore into the disposable test mode (database + files)
ops/scripts/system/restore.sh "$ARCHIVE" --mode test --force
```

`--force` overwrites existing file data; the database is rebuilt with `pg_restore`. The live `db/postgres` directory is never touched.

### Verify restored app starts

```bash
# The restore above targeted --mode test, so start that mode to verify it.
# (start.sh derives the mode root from RAINVER_ROOT, default ~/.rainver-data; it does not
#  read RAINVER_HOME — that is the in-container instance root.)
./ops/scripts/start.sh --test
curl -s http://localhost:3100/api/v1/server/health
# Expected: {"status": "ok", ...}
```

### Verify key data survives restore

```bash
BASE="http://localhost:3000/api/v1"
KEY="X-API-Key: <dogfood-api-key>"
SPACE="<space-id>"

# Spaces
curl -s "$BASE/spaces" -H "$KEY"

# Memory
curl -s "$BASE/memory?space_id=$SPACE&status=active" -H "$KEY"

# Artifacts
curl -s "$BASE/artifacts?space_id=$SPACE" -H "$KEY"

# Proposals
curl -s "$BASE/proposals?space_id=$SPACE" -H "$KEY"

# Runs
curl -s "$BASE/runs?space_id=$SPACE" -H "$KEY"

# RunSteps (use a known run_id from above)
curl -s "$BASE/runs/<run-id>/steps?space_id=$SPACE" -H "$KEY"

# Activity
curl -s "$BASE/activity?space_id=$SPACE" -H "$KEY"
```

All expected: 200 with data matching pre-restore state.

**Restore is always manual and explicit. There is no automatic restore.**

---

## H. Rollback Plan

Use this procedure when a stop condition triggers or a serious incident occurs.

### Step 1 — Stop writes immediately

Prevent new writes from entering the database:
```bash
docker compose -p rainver-dev -f ops/compose/docker-compose.dev.yml stop server frontend deployer
```

Keep postgres running so restore tooling can connect.

### Step 2 — Stop all services

```bash
docker compose -f ops/compose/docker-compose.dev.yml stop
```

### Step 3 — Snapshot current state

Before overwriting anything, copy the current data root:
```bash
cp -a ~/.rainver-data/dev ~/.rainver-data/dev-pre-rollback-$(date +%Y%m%d-%H%M%S)
```

This preserves the failing state for incident analysis.

### Step 4 — Identify previous known-good revision

```bash
git log --oneline -10
# Identify the commit hash before the problem was introduced
```

### Step 5 — Revert app revision

```bash
git checkout <known-good-commit>
# Or if rolling back a branch:
git reset --hard <known-good-commit>
```

### Step 6 — Restore from last known-good backup (if data integrity suspect)

```bash
# Bring postgres back up so pg_restore can connect (the app stays stopped)
docker compose -p rainver-dev -f ops/compose/docker-compose.dev.yml up -d postgres

ARCHIVE=$(ls ~/.rainver-data/dev/backups/auto-*.tar.gz | sort | tail -2 | head -1)
ops/scripts/system/restore.sh "$ARCHIVE" --mode dev --force
```

Use the backup immediately before the problem started, not the latest one (which may
already be corrupted).

### Step 7 — Disable implicated surface

Edit `~/.rainver-data/dev/.env` to disable the problematic surface:
```bash
# Example:
BACKUP_ENABLED=false             # temporarily if backup itself is problematic
```

Or remove the implicated module from `server/src/gateway/routeRegistry.ts`
if a specific backend module must be disabled.

### Step 8 — Record incident note

File an incident note immediately (see §J template) before resuming or discussing.

### Step 9 — Re-run the failed gate

```bash
cd server
pnpm test -- <implicated-tests>
```

Do not resume dogfooding until the failing gate passes.

### Step 10 — Resume

```bash
./ops/scripts/start.sh
```

Resume dogfooding only after the failed gate passes and the incident note is filed.

---

## I. Stop Conditions

**Dogfooding must stop immediately if any of the following occur:**

1. **Cross-user private-space data leak** — User B reads User A's personal space data
   without explicit household membership.

2. **Household membership access bypass** — A non-member user accesses household space
   data.

3. **Memory write bypasses the structural write boundary** — A direct internal memory
   write succeeds without going through the proposal-approval path (`create_from_approved_proposal`)
   or the bootstrap seed path (`create_system_seed_memory`).

4. **Accepted policy does not affect enforcement** — An accepted, active `Policy` row
   with the selected class does not change the enforcement decision it was meant to govern.

5. **RunStep replay missing** — `GET /runs/{id}/steps` returns an empty list for a run
   that completed through the canonical server runtime adapter path.

6. **Runtime secret in output** — A raw API key, secret, or credential appears in run
   output, RunStep metadata, artifact content, logs, or any UI surface.

7. **Backup fails repeatedly** — `BackupService` cannot complete a backup or produce
   `backup_manifest.json` after two consecutive automatic intervals.

8. **Restore rehearsal fails** — `ops/scripts/system/restore.sh` fails, or the restored app
   fails to start, or key data is missing after restore.

9. **Workspace scan deletes metadata** — `POST /workspaces/scan` hard-deletes a
   workspace row instead of marking it `stale`.

10. **Deployer accepts arbitrary command** — The deployer accepts and executes a job type
    not in `ALLOWED_JOB_TYPES`.

11. **Evolution bypasses explicit Agent selection** — An Evolution run creates or selects a
    privileged fallback Agent instead of requiring the target/request to identify an Agent.

12. **Disabled surface required for daily use** — A disabled surface from §C becomes
    necessary for normal dogfood workflows (any disabled surface that must be enabled to
    continue productive use).

13. **Code patch partial apply** — `code_patch` proposal apply reports a partial-apply
    error (some files written, others failed, rollback failed) and the incident is not
    handled before continuing.

14. **Database transaction produces partial state** — An operation leaves partial active
    `MemoryEntry` or `Proposal` rows in an inconsistent state that cannot be traced to a
    clean rollback.

---

## J. Incident Note Template

File one note per incident. Save to `.agent/incidents/YYYYMMDD-<slug>.md`.

```markdown
## Incident: <short title>

Date/time: YYYY-MM-DD HH:MM UTC
User: <user identifier — not email>
Space: <space id and type>
Surface used: <module, API endpoint, or UI page>

### Expected behavior
<what should have happened>

### Actual behavior
<what actually happened — be specific>

### Data affected
<tables, IDs, or records involved; none if no data was mutated>

### Privacy impact
<none | potential | confirmed — describe if confirmed>

### Backup status
Last successful backup: <timestamp or "unknown">
Backup manifest inspected: <yes / no>

### Rollback performed
<yes / no — if yes, describe which backup was used>

### Boundary gate implicated
<space-isolation / actor-identity / run-step-replay / runtime-credential / policy-enforcement / activity-provenance / lifecycle-deployment / backup-service / db-transaction / unknown>

### Follow-up task
<link to task or describe concrete next action>

### Severity
<critical (stop condition triggered) / major (gate regressed) / minor (UX issue only)>
```

---

## Security Notes

- `secrets/provider_keys.key` and the mode `.env` are included only in explicit sensitive
  recovery archives. Keep those separate from normal data archives and treat them as sensitive.
  Archive permissions: `600`; the environment restores to `.env.restored` unless explicitly activated.
- No raw secret values are written to stdout, logs, or `backup_manifest.json`.
- For offsite storage: encrypt data and credential archives separately before transferring;
  until both exist off-host, local backups protect deletion but not host loss.

---

## Residual Risks

| Risk | Status |
|---|---|
| `Credential.secret_ref` full decryption deferred | Only `ModelProvider` encrypted keys decryptable; full secret_ref deferred |
| Obsolete agents-module runtime path | Runtime execution uses `RuntimeAdapterSpec`; new adapters must start there |
| Most PolicyEngine enforcement points not yet wired to persisted policy | Active classes: `memory.private_placement`, `run.user_private_scope`; structural write boundary via sentinel; rest documented in `PRODUCT_AND_BOUNDARIES.md` |
| Artifact archive/delete API not yet implemented | Artifacts accumulate; deferred |
| Activity archive/delete not yet implemented | Deferred |
| Workspace stale status has no recovery UI | Operator must use `PATCH /workspaces/{id}` |
| Deployment job persistence absent | 501-gated; manual deployment only |
| Local advisory lock only (single-host) | Distributed locking is future scope |
| Cloud/offsite backup absent | Manual GPG + offsite upload if required |
| `context_sources` table removed from schema | A future first-class Source model would be a new table |
| QuickCapture `ask` mode still routes to `/sessions` | Correct for real conversations; UX deferred |
| QuickCapture `process` mode creates new Activity | Acceptable; product refinement deferred |
