# Operations and Safety

See also: [docs/BACKUP_AND_RESTORE.md](../../docs/BACKUP_AND_RESTORE.md) and [docs/TWO_PERSON_DOGFOODING_RC.md](../../docs/TWO_PERSON_DOGFOODING_RC.md).

## Data Root

All runtime data for the running environment lives under `RAINVER_HOME` — the single
instance root (in Docker it is the `/rainver` bind mount). Never store runtime data in the source repository.

`RAINVER_HOME` is **not** the parent of the `dev/`/`test/`/`prod/` mode dirs. That host-side
parent is `RAINVER_ROOT` (default `~/.rainver-data`), used only by `ops/scripts/`, which derive
`MODE_ROOT="$RAINVER_ROOT/<mode>"`.

```
RAINVER_HOME/
  .env         Deployment settings and secrets (sensitive recovery archive only)
  db/postgres/ Live PostgreSQL data directory (bind-mounted into the postgres container; never archived)
  db/dumps/    pg_dump custom-format dump files (written by ops/scripts/db/dump.sh)
  storage/     Artifact storage files
  secrets/     Encrypted provider key files (AES key, CLI credentials)
  config/      Runtime configuration
  workspaces/  Project Folder files
  backups/     Backup archives (auto-pruned to BACKUP_RETENTION_COUNT)
  credential-backups/ Sensitive recovery archives (operator-managed; never in normal backups)
  logs/        Application logs (optional; excluded from backup by default)
  sandboxes/   Ephemeral sandbox state and stable CLI conversation cwd state (never backed up)
  cache/       Ephemeral cache, including isolated CLI conversation HOME state (never backed up)
```

## Backup — Canonical: Server BackupService

`BackupService` (`server/src/modules/backups/service.ts`) is the canonical full-system backup mechanism. It runs automatically on the server scheduler and writes a structured manifest into every archive. The full procedure lives in [docs/BACKUP_AND_RESTORE.md](../../docs/BACKUP_AND_RESTORE.md).

**Enable the deployment capability in `$RAINVER_ROOT/<mode>/.env`:**

```
BACKUP_ENABLED=true
```

Without `BACKUP_ENABLED=true`, no automatic backups are created. For dogfooding, this setting is required.
The instance admin manages interval, retained automatic archive count, log
inclusion, startup backup behavior, and content-access-log retention from
**Instance Settings → Operations & retention**. Those policies use the shared
instance-scoped settings store and take effect without a server restart.

**What is backed up:**

| Directory | Included |
|---|---|
| `db/rainver.dump` — PostgreSQL snapshot (`pg_dump` custom format) | Always |
| `storage/` — artifact files | Always |
| `secrets/` — master key and CLI login state | **Never**; separate credential archive only |
| `config/` — runtime config | Always |
| `workspaces/` — Project Folder files | Always |
| `cache/host-daemon/` — the built-in execution host's own state | **Not yet**, and it holds login state — see below |
| `backups/` — previous archives | **Never** (recursion prevention) |
| `sandboxes/` — ephemeral sandbox | **Never** |
| `cache/` — ephemeral cache | **Never** |
| `logs/` — application logs | Only if `BACKUP_INCLUDE_LOGS=true` |

**A gap this topology created.** The built-in execution host keeps its managed
copies of runtimes, **their login state**, every Agent's runtime profile and its
managed workspaces under `cache/host-daemon/`, because they are the daemon's own
directory rather than the server's. `cache/` has always been excluded from
backups, and CLI login state used to live in `secrets/`, which the separate
credential archive covers. A restored instance therefore comes back without the
built-in host's logins, and an operator has to log each copy in again from the
host card. Either that directory joins the credential archive or the daemon's
config root moves out of `cache/`; until then this is a stated recovery step,
not an assumption.

CLI continuity is the vendor session inside the Agent's own runtime profile on
the execution host, tracked by the control plane as an opaque
`vendor_session_id`. Each physical invocation runs through that host's daemon:
on the built-in host in a fresh bubblewrap namespace with a per-Run HOME, on a
paired host natively under the owner's trust. Missing or invalid state fails
closed and the next turn starts a fresh session rather than resuming into one
whose store is gone; no shared vendor HOME is replay authority.

Paths are resolved on the host from a Location id or a managed container. The
application server cannot send host paths, images, or environment maps, has no
local subprocess fallback, and no longer has a vendor CLI of its own to fall
back to. Namespace failure is terminal. Runtime Context Delivery is sent directly to the adapter and no
read-only-context staging directory or generated vendor context file exists.

**PostgreSQL backup:** `BackupService` uses `pg_dump -Fc --no-owner --no-acl` (custom format) for a consistent snapshot. It fails closed if `BACKUP_DATABASE_URL` is unset or `pg_dump` fails — no partial archive is produced. `db_snapshot_method` in the manifest is `"pg_dump_custom"`. The dump is restored with `pg_restore`. The live `db/postgres` data directory is **never** copied into an archive — the database is only captured logically.

**Manifest version metadata:** every manifest records `backup_format`, `app_version`, `git_commit`, `schema_migration_version`, `schema_migration_checksum`, `postgres_server_version`, and `pg_dump_version` (best-effort, `null` when undeterminable). `ops/scripts/system/restore.sh` reads these during preflight and **fails** on an incompatible `backup_format`, a PostgreSQL major-version mismatch, a `schema_migration_version` this build's `server/migrations/` chain does not contain (the archive came from a newer build), or a `schema_migration_checksum` that differs from this build's copy of that file, unless `--force-incompatible-backup` is supplied — the metadata is never silently ignored. An archive from an older build is compatible: migrations are append-only (`server/migrations/README.md`), so the normal migrate step at the next `start.sh` brings the restored database forward.

**Pre-migration backup:** `ops/scripts/db/migrate.sh --mode prod` takes a `pg_dump` custom-format dump to `$RAINVER_ROOT/<mode>/db/dumps/pre-migrate-<ts>.dump` before server migrations run and aborts if it fails; non-prod opts in via `PRE_MIGRATION_BACKUP=1` / `--pre-migration-backup`.

**Archive naming:**
- Auto: `$RAINVER_ROOT/<mode>/backups/auto-YYYYMMDD-HHMMSS.tar.gz`
- Manual (API): `$RAINVER_ROOT/<mode>/backups/manual-YYYYMMDD-HHMMSS.tar.gz`
- Offline CLI: `$RAINVER_ROOT/<mode>/backups/system-YYYYMMDD-HHMMSS.tar.gz`

**Local overlap protection:** `backups/.backup.lock` (local lock file with stale-lock recovery). Fails closed if `pg_dump` fails.

**Retention:** The configured number of latest auto archives are kept; older
ones are pruned. Manual archives are never pruned automatically.

**Every BackupService archive contains `backup_manifest.json`** with format version, kind, timestamp, source root, included/excluded paths, db snapshot method, and warnings.

**Manual trigger:**
```bash
curl -X POST http://localhost:3000/api/v1/system/backups/manual -H "X-API-Key: <key>"
```

## Backup — Offline: ops/scripts/system/backup.sh

Use `ops/scripts/system/backup.sh` when app services are stopped. It produces the same archive format as `BackupService` (PostgreSQL snapshot + file data + `backup_manifest.json`). PostgreSQL must be running.

Sensitive recovery state is separate: `ops/scripts/system/backup-credentials.sh` writes an
archive containing `secrets/` plus the mode `.env` as `instance.env`, and
`restore-credentials.sh` restores `secrets/` explicitly while publishing `.env.restored` for
review by default. `--restore-env` is required to replace the active `.env`. Normal restore
never overwrites either sensitive location. Local data and sensitive archives protect against
deletion only, not host loss; encrypt both separately with GPG and copy them offsite, with the
passphrase stored separately, before claiming host-loss protection.

```bash
ops/scripts/system/backup.sh --mode dev
ops/scripts/system/backup.sh --mode prod --include-logs
```

DB-only expert tools live under `ops/scripts/db/` (`dump.sh`, `restore.sh`).

## Restore

Restore is always **manual and explicit**. There is no automatic restore. One command restores both the database and the file data:

```bash
# 1. Stop the app, leaving postgres running
docker compose -p rainver-dev -f ops/compose/docker-compose.dev.yml stop frontend server deployer

# 2. Ensure PostgreSQL is up
ops/scripts/start.sh --dev

# 3. Restore database + files from one archive
ops/scripts/system/restore.sh ~/.rainver-data/dev/backups/auto-<timestamp>.tar.gz --mode dev --force
```

`ops/scripts/system/restore.sh` runs `pg_restore` against the database and restores the file directories; `--force` overwrites existing file data. The live `db/postgres` directory is never touched.

**After restore, verify before resuming writes:**
1. `curl -s http://localhost:3000/api/v1/server/health` — expected: `{"status":"ok","service":"server","checks":{"database":"ok"}}`
1b. `GET /api/v1/status` as a space owner/admin — expected `overall: "ok"`, a
   running `jobs_worker`, and no `stalled` entry in `scheduler_tasks`. A
   restored instance whose background loops did not come back reads healthy on
   step 1 alone.
2. Spaces and users readable.
3. Memory, artifacts, proposals, and runs readable.
4. Activity inbox survives.
5. RunStep replay survives for a known run.

## Object Lifecycle States

| State | Meaning |
|---|---|
| `active` | Normal, readable, participates in queries and UI by default |
| `hidden` | Not shown in default queries but recoverable |
| `archived` | Removed from active use; preserved for audit; not in default reads |
| `stale` | Path or dependency unavailable; metadata preserved; recoverable |
| `superseded` | A newer version exists; old row kept for provenance |
| `pending_delete` | Marked for deletion; awaiting approval, retention period, or review gate |
| `deleted` | Soft-deleted; row retained for audit; content may be redacted |
| `redacted` | Content replaced with tombstone; identity and timestamps preserved |

## Archive, Delete, and Hard Delete

- **Archive** — marks object `archived`. Reversible. Full provenance preserved. Not shown in default reads.
- **Soft delete** — marks status `deleted`. Row retained for audit. Content may be redacted.
- **Hard delete** — permanently removes row and linked files. **Not exposed through any public API.** Reserved for legal compliance only, requiring `pending_delete` → review → execute sequence.

## Project Folder Lifecycle

Archiving a Project Folder (`DELETE /projects/{id}/folders/{folderId}`) disables
new Folder-backed execution but never deletes, moves, or rewrites the
physical directory; all metadata (id, name, tasks, runs, artifacts,
proposals, audit references) is fully preserved. Unregistering
(`POST /projects/{id}/folders/{folderId}/unregister`) removes only the
Rainver registration row — it never touches disk either. There is no
automatic missing-path detection or stale-marking scan; `POST
/projects/{id}/folders/scan` only lists unregistered directories eligible
for the "connect existing" creation flow.

Operator restores an archived Folder: `PATCH /projects/{id}/folders/{folderId}` setting `status=active`.

## Minimal Failure Alerting

- `/health` and `/api/v1/server/health` execute a database probe and return 503 when
  PostgreSQL is unreachable. They are a container probe only: they stay 200 while a
  scheduled task has silently stopped turning or the jobs worker never started.
- `GET /api/v1/status` (space owner/admin) reports component-level status —
  database, per-scheduled-task liveness, jobs worker presence, and queue depth.
  This is the surface that detects a *stalled* task, which raises no exception
  and therefore triggers no alert on its own. See
  [../modules/server-status.md](../modules/server-status.md).
- A job that reaches `max_attempts`, a scheduled automation fire failure, or a scheduler
  task exception writes a deduplicated `operational_alert` pointer into Activity Inbox.
- A scheduled task that exceeds its reporting deadline emits the same
  `scheduler_task_failed` alert as a thrown error, and no further pass of that
  task starts until the outstanding one settles. The hung pass itself is not
  cancelled; the deadline reports, it does not abort.
- Job and automation alerts are scoped to their owning space/user. Instance scheduler alerts
  fan out to an active owner/admin in every space, including shared/team-only instances. Alert persistence is best-effort and never masks the
  originating failure or changes retry/schedule semantics.
- These alerts are durable in-product signals, not an external paging guarantee. Operators
  must still inspect Activity Inbox and logs; webhook paging remains separately configured.

## Deployment Boundary

- App container does not restart or rebuild itself.
- Production runs CI-published images (`ghcr.io/jyc333/rainver-*`, tag from
  `RAINVER_IMAGE_TAG`, default `stable`); the prod machine pulls and never builds.
  Rolling back is re-running `start.sh --prod` with a `sha-<commit>` tag.
- Product deployment routes create instance-admin `deployment_jobs`; the deployer's pull loop claims one every thirty seconds and reports each stage. A failed stage ends the job with that stage named and the dump path in its log tail; nothing rolls back automatically. An update is refused when no deployer has reported in three minutes, because a queued one pauses unattended work until the sweep releases it.
- **An update carries the four images and nothing else.** The compose files, `ops/scripts` and `migrate.sh` come from the host checkout, and the deployer's own image is never recreated (ADR 0020 §6). A release that changes any of them — or the server↔deployer internal contract — needs a host step: `git pull && ops/scripts/start.sh --prod`. The instance reports the skew as `deployer_behind` in Instance Settings — a content digest of `deployer/` and `ops/` stamped on every image, so it fires when that surface changed rather than after every update — and the panel names that command; it cannot detect a stale `ops/` on its own, so treat the deployer image and the checkout as moving together.
- Migrations are applied before the services are recreated, so a release's schema must stay readable by the build it replaces (B59).
- The privileged deployer socket is container-private and is not reachable from server or agent runtimes.
- Deployer `ALLOWED_JOB_TYPES`: `rebuild_rainver`, `restart_rainver`, `health_check`. No arbitrary shell.
- Self-evolution/code-patch/capability paths cannot submit deployer jobs. The product
  trigger is an administrator-created job the deployer pulls (ADR 0020); its stage
  events are the durable audit, and no Agent, automation, job, or scheduler path can
  create one. An update is refused outside production.
- The instance must not be exposed directly to the public internet until TLS termination,
  rate limiting, and general CSRF-token hardening have been implemented and reviewed.

## Stop Conditions

Dogfooding must stop immediately on any of these:

1. Cross-user private-space data leak.
2. Household membership access bypass.
3. Memory write bypasses proposal or active policy boundary.
4. Accepted active Policy row does not affect its enforcement decision.
5. RunStep replay missing for a completed canonical-path run.
6. Raw secret in run output, RunStep, artifact, logs, or UI.
7. BackupService fails repeatedly (no `backup_manifest.json` after two intervals).
8. Restore rehearsal fails or key data missing after restore.
9. Project Folder archive or unregister deletes, moves, or rewrites the physical directory.
10. Deployer accepts a job type not in `ALLOWED_JOB_TYPES`.
11. Self-evolution executes behavior changes without approved proposal and deployer gate.
12. Code patch partial apply with rollback failure.
13. Database transaction produces partial inconsistent active state.

## Rollback Procedure

1. Stop writes: `docker compose stop frontend server deployer`.
2. Snapshot current state: `cp -a ~/.rainver-data/dev ~/.rainver-data/dev-pre-rollback-$(date +%Y%m%d-%H%M%S)`.
3. Identify known-good revision: `git log --oneline -10`.
4. Revert app: `git checkout <known-good-commit>`.
5. If data integrity is suspect, restore from last known-good backup (not the latest, which may already contain the problem).
6. Disable implicated surface in `.env`.
7. File incident note: `.agent/incidents/YYYYMMDD-<slug>.md`.
8. Re-run failing gate tests. Do not resume until they pass.

## Security Notes

- Normal backup archives exclude `secrets/` and `.env`; sensitive recovery archives contain
  `secrets/provider_keys.key`, CLI login state, the mode environment, and its deployment secrets.
- Archive permissions: `600` (owner only). Output directory: `700`.
- No raw secret values are written to stdout, logs, or manifests.
- For offsite storage: encrypt the data and credential archives separately with
  `gpg --symmetric`, verify both encrypted streams, and keep the passphrase elsewhere.
