# Backup and Restore — agent-space Local Instance

**Scope:** Local two-person dogfooding instance. PostgreSQL is the server database.

---

## Model

There is one full-system backup concept and one full-system restore concept.

| Tool | Role |
|---|---|
| `BackupService` (`server/src/modules/backups/service.ts`) | **Canonical full-system backup** — scheduled, on-startup, and via API. Produces a manifested archive. |
| server scheduler registry | Runs backup ticks and exposes manual/list API operations. |
| `ops/scripts/system/backup.sh` | App-services-stopped full-system backup — same archive format as `BackupService`, for when `frontend`, `server`, and `deployer` are stopped while postgres remains running. |
| `ops/scripts/system/restore.sh` | Full-system restore — restores **both** the database and file data from one archive. |
| `ops/scripts/db/dump.sh` | DB-only expert tool — `pg_dump` custom-format dump to `db/dumps/`. |
| `ops/scripts/db/restore.sh` | DB-only expert tool — `pg_restore` from a `.dump` file. |

A full-system backup archive contains a logical PostgreSQL snapshot **and** the file data, together with a manifest. Restore is a single command that rebuilds the database and the files.

**Two-person dogfooding must set `BACKUP_ENABLED=true`** (or `backup_enabled: true` in `.env`). The service defaults to `False` for test safety.

The local compose stack uses the bundled `postgres` service by default. Setting
`DATABASE_URL` in the mode `.env` points database scripts at another PostgreSQL
connection, but the bundled `postgres` service remains defined in the local
compose files until a separate external-db compose profile is added.
Across dev, test, and prod the client-facing API entrypoint is `server`.
Dev publishes server at `http://localhost:3000/api/v1`; test publishes it at
`http://localhost:3100/api/v1`. The test frontend uses server.
The bundled PostgreSQL containers have stable names per mode:
`agent-space-dev-postgres`, `agent-space-test-postgres`, and `agent-space-prod-postgres`.

---

## Data locations

> **Path semantics.** `ASPACE_ROOT` is the host-side parent directory that holds the
> `dev/`, `test/`, `prod/` mode roots (default `~/.aspace`); the scripts locate a mode
> root as `$ASPACE_ROOT/<mode>`. Inside containers the running app sees that mode
> root as `AGENT_SPACE_HOME=/aspace`. `AGENT_SPACE_HOME` is never the parent of the mode dirs.
> The DB/system scripts share `ops/scripts/lib/local-compose.sh` with `ops/scripts/start.sh`,
> so mode validation, `$MODE_ROOT/.env`, `AGENT_SPACE_MODE_ROOT`, compose project/file,
> and `docker compose --env-file "$ENV_FILE"` stay consistent.
> Docker-native `ops/scripts/db/migrate.sh`, DB-only `ops/scripts/db/{dump,restore,reset-postgres}.sh`,
> and offline `ops/scripts/system/{backup,restore,verify-restore}.sh` stop the compose
> `postgres` service after completion only if that script started it; they do not
> stop a database that was already running.

| Path | Meaning | In normal backups? |
|---|---|---|
| `$ASPACE_ROOT/<mode>/db/postgres` | Live PostgreSQL data directory (bind-mounted into the postgres container) | **No** — never archived. The database is captured logically via `pg_dump`. |
| `$ASPACE_ROOT/<mode>/db/dumps` | `pg_dump` custom-format dump files written by `ops/scripts/db/dump.sh` | Operator-managed; not part of the system archive |
| `storage/`, `artifacts/`, `config/`, `workspaces/` | Non-credential file data | Yes |
| `secrets/` | Credential master key and CLI login state | **No** — separate credential archive only |
| `logs/` | Application logs | Optional (`BACKUP_INCLUDE_LOGS=true`) |
| `backups/`, `cache/`, `sandboxes/` | Archives / ephemeral | No |

---

## Automatic backup (canonical)

### Enable

In `$ASPACE_ROOT/<mode>/.env`:

```
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_COUNT=7
BACKUP_INCLUDE_LOGS=false
BACKUP_ON_STARTUP=true
```

The server reads these on startup and registers its backup tick with the server scheduler registry. `BACKUP_ON_STARTUP=true` triggers an immediate backup in the background after the server starts; it does not block readiness or dependent services while `pg_dump` and archive compression run.

### Archive contents

| Path in archive | Contents |
|---|---|
| `db/agent_space.dump` | PostgreSQL snapshot (`pg_dump -Fc --no-owner --no-acl`) — all memory, proposals, runs, activity, artifacts, policies, run steps |
| `storage/` | Artifact storage files |
| `artifacts/` | Artifact storage root |
| `config/` | Runtime configuration (no secret values) |
| `workspaces/` | Workspace metadata directories |
| `logs/` | Only when `BACKUP_INCLUDE_LOGS=true` |
| `backup_manifest.json` | Archive metadata (see below) |

`backups/`, `cache/`, `sandboxes/`, and the live `db/postgres` directory are never included.

**Credential separation:** normal archives never contain `secrets/`. Use
`ops/scripts/system/backup-credentials.sh` for an explicit credential-only archive and
`restore-credentials.sh` to restore it separately. This prevents one ordinary data archive
from containing both the encrypted provider-key database rows and their decryption key.

### Archive naming

```
$ASPACE_ROOT/<mode>/backups/auto-YYYYMMDD-HHMMSS.tar.gz     ← scheduled
$ASPACE_ROOT/<mode>/backups/manual-YYYYMMDD-HHMMSS.tar.gz   ← API trigger
$ASPACE_ROOT/<mode>/backups/system-YYYYMMDD-HHMMSS.tar.gz   ← ops/scripts/system/backup.sh
```

### backup_manifest.json

Every full-system backup archive — whether written by `BackupService` or by
`ops/scripts/system/backup.sh` — contains a `backup_manifest.json` at its root with
the same schema:

- `backup_format: "agent-space-backup.v1"` — backup format version
- `kind` — `"auto"` | `"manual"`
- `created_at` — ISO timestamp
- `source_root` — absolute path of the data root at backup time
- `included_paths` / `excluded_paths` — what was copied and what was skipped (with reasons)
- `db_snapshot_method` — `"pg_dump_custom"`
- `backup_interval_hours`, `backup_retention_count`
- `warnings` — non-fatal issues
- **Version metadata** (best-effort; `null` when undeterminable):
  - `app_version` — application version at backup time
  - `git_commit` — source commit if the instance is a git checkout
  - `schema_migration_version` — latest server migration version recorded in the dumped DB
  - `schema_migration_checksum` — checksum for that migration file
  - `postgres_server_version` — PostgreSQL server version that produced the dump
  - `pg_dump_version` — `pg_dump` client version that wrote the dump

No raw secret values appear in the manifest. PostgreSQL is the server database.

### PostgreSQL consistency

`BackupService` runs `pg_dump -Fc --no-owner --no-acl` for a consistent custom-format database snapshot using PostgreSQL MVCC — the server does not need to be stopped. The dump is restored with `pg_restore`. **If `BACKUP_DATABASE_URL` is unset or `pg_dump` fails, the backup fails closed**: no archive is produced.

Full-system backup also copies non-credential file data (`storage/`, `artifacts/`, `config/`, `workspaces/`). The database dump and file copies are not one cross-resource transaction, so restore verification should check restored `artifacts.storage_path` rows against files under `storage/artifacts/`. Use `ops/scripts/system/verify-restore.sh` after restore.

### pg_dump client version (must match the server)

`pg_dump` refuses to dump a server **newer** than the client. The online `BackupService`
uses the `pg_dump` available to the server runtime; the offline backup script runs
`pg_dump` inside the postgres container. When the `postgres` server major is upgraded, keep
the runtime/client image in lockstep. The server never mounts the Docker socket.

### Backup safety guard (prod)

When `AGENT_SPACE_ENV=prod` and `BACKUP_ENABLED=false`, the server **fails fast at startup**
rather than silently running without backups. To run prod without automatic backups you must
explicitly acknowledge the risk with `BACKUP_ACCEPT_NO_BACKUP=true`; non-prod environments only
log a strong warning. See `server/src/modules/backups/guard.ts`.

### Overlap protection and retention

- Local advisory lock file `backups/.backup.lock` prevents overlapping backups across server processes on the same host.
- Auto backups: the latest `BACKUP_RETENTION_COUNT` (default 7) are kept; older ones are pruned after each run. Manual backups are never pruned automatically.

### API

```bash
# Trigger a manual full-system backup
curl -X POST http://localhost:3000/api/v1/system/backups/manual -H "X-API-Key: <key>"

# List backups
curl http://localhost:3000/api/v1/system/backups -H "X-API-Key: <key>"
```

---

## Offline full-system backup

When app services are stopped, produce an identical-format archive with:

```bash
# Stop writers first; backup starts postgres automatically if needed.
docker compose --env-file "${ASPACE_ROOT:-$HOME/.aspace}/dev/.env" -p agent-space-dev -f ops/compose/docker-compose.dev.yml stop frontend server deployer

ops/scripts/system/backup.sh --mode dev
ops/scripts/system/backup.sh --mode prod --include-logs
ops/scripts/system/backup.sh --mode dev --output /mnt/backups
```

This runs `pg_dump` inside the postgres container, copies the file data, writes a `backup_manifest.json` with the same schema as `BackupService` (including `backup_interval_hours` and `backup_retention_count`, read from `BACKUP_INTERVAL_HOURS` / `BACKUP_RETENTION_COUNT` in the mode `.env`, defaulting to `24` / `7`), and produces `system-<timestamp>.tar.gz`. It starts PostgreSQL automatically if needed and stops it afterward only if backup started it. By default, `ops/scripts/system/backup.sh` refuses to run while `frontend`, `server`, or `deployer` are active because file data can change during the backup. Use `BackupService` or `POST /api/v1/system/backups/manual` for online backup while the server is running.

## Separate credential backup

Credential state is deliberately excluded from every normal data archive. With app services
stopped, create and restore it explicitly:

```bash
ops/scripts/system/backup-credentials.sh --mode dev
# output: ~/.aspace/dev/credential-backups/credentials-<timestamp>.tar.gz

ops/scripts/system/restore-credentials.sh \
  ~/.aspace/dev/credential-backups/credentials-<timestamp>.tar.gz \
  --mode dev --force
```

The credential archive contains only `secrets/` plus a
`credential_backup_manifest.json`. It is mode `0600`, but it is not encrypted by default.
Normal data restore never overwrites `secrets/`; restore the credential archive as a separate
operator decision before starting the app.

### Manual encrypted offsite copy (required for host-loss protection)

Local archives protect against accidental deletion, not disk or host loss. After producing a
normal data archive and a credential archive, encrypt and transfer them as two separate files:

```bash
gpg --symmetric --cipher-algo AES256 ~/.aspace/dev/backups/<data-archive>.tar.gz
gpg --symmetric --cipher-algo AES256 ~/.aspace/dev/credential-backups/<credential-archive>.tar.gz

# Verify the encrypted copies before transfer.
gpg --decrypt ~/.aspace/dev/backups/<data-archive>.tar.gz.gpg | tar -tzf - >/dev/null
gpg --decrypt ~/.aspace/dev/credential-backups/<credential-archive>.tar.gz.gpg | tar -tzf - >/dev/null
```

Copy both `.gpg` files to offsite storage, keep the passphrase in a different password manager
or physical location, and do not place the unencrypted data and credential archives together
off-host. Periodically rehearse decrypting both and restoring into the test mode.

---

## Restore (full-system, single command)

Restore rebuilds the database and the file data from one archive. Stop `frontend`, `server`, and `deployer`; restore starts `postgres` automatically if needed and stops it afterward only if restore started it.

> **Do not use `ops/scripts/start.sh` as a restore preflight** — it starts the app services (`frontend`, `server`, `deployer`), which `restore.sh` then refuses. Run `ops/scripts/start.sh --<mode>` only *after* the restore succeeds.

```bash
# 1. Stop the app (leave postgres running)
docker compose --env-file "${ASPACE_ROOT:-$HOME/.aspace}/dev/.env" -p agent-space-dev -f ops/compose/docker-compose.dev.yml stop frontend server deployer

# 2. Keep or start postgres only
docker compose --env-file "${ASPACE_ROOT:-$HOME/.aspace}/dev/.env" -p agent-space-dev -f ops/compose/docker-compose.dev.yml up -d postgres

# 3. Restore database + files from one archive
ops/scripts/system/restore.sh ~/.aspace/dev/backups/auto-20260101-120000.tar.gz --mode dev --force

# 4. Start the app after restore succeeds, then verify
ops/scripts/start.sh --dev
ops/scripts/system/verify-restore.sh --mode dev
```

`restore.sh` extracts the archive to a temporary staging directory before any destructive database operation. It validates `backup_manifest.json`, verifies `db/agent_space.dump`, checks file-directory overwrite preconditions, refuses to continue while `frontend`, `server`, or `deployer` are running, then runs `pg_restore` (terminate connections → drop → create → restore) against the maintenance database and restores the non-credential file directories into `$ASPACE_ROOT/<mode>/`. `--force` is required to overwrite existing file directories. It never restores or overwrites `secrets/`; use `restore-credentials.sh` explicitly. The live `db/postgres` directory is never touched — the database is rebuilt logically.

During preflight, `restore.sh` reads the manifest **version metadata** (`backup_format`,
`app_version`, `git_commit`, `schema_migration_version`, `schema_migration_checksum`, `postgres_server_version`, `pg_dump_version`),
prints the recorded values, and **fails closed before any destructive operation** on a missing
or unexpected `backup_format`, a PostgreSQL **major-version** mismatch between the backup
source and the live restore target, or a `schema_migration_checksum` that differs from this
build's `server/migrations/0001_baseline.sql`. The last one means the archive predates a schema
change: the runtime schema is a single regenerated baseline, so restoring it would produce a
database the migration runner refuses to start against — prefer a build whose baseline matches
the archive. For controlled recovery you can override this check with
`--force-incompatible-backup`; `--force` (file overwrite) and `--force-running` (active
services) do **not** imply it. The metadata is never silently ignored.

For `test` or `prod`, use the matching compose project and file, for example `agent-space-test` with `ops/compose/docker-compose.test.yml` or `agent-space-prod` with `ops/compose/docker-compose.prod.yml`.

`--force-running` bypasses the running-service refusal and should only be used for controlled recovery when you have independently stopped all writers. `--force-incompatible-backup` bypasses the backup-compatibility preflight (unexpected `backup_format`, PostgreSQL major-version mismatch, or schema-checksum mismatch) and should only be used when you have verified the archive is restorable **and startable** on the target build.

### DB-only expert path

To dump or restore only the database (no file data):

```bash
ops/scripts/db/dump.sh --mode dev                       # → db/dumps/dump-<ts>.dump
ops/scripts/db/restore.sh ~/.aspace/dev/db/dumps/dump-<ts>.dump --mode dev
```

DB-only dump/restore/reset start `postgres` automatically and stop it afterward only if that script started it. Restore and reset refuse to run while app services are active; stop `frontend`, `server`, and `deployer` first. `ops/scripts/db/restore.sh` validates the dump with `pg_restore --list` before any destructive drop, so an unreadable archive is rejected before the database is touched.

---

## Restore verification checklist

Use the restore verification script first. It checks the compose `postgres` service,
server migration rows, core table counts, and artifact file consistency:

```bash
ops/scripts/system/verify-restore.sh --mode dev
ops/scripts/system/verify-restore.sh --mode test
ops/scripts/system/verify-restore.sh --mode prod
```

For targeted API checks after the verifier passes:

```bash
curl -s "http://localhost:3000/api/v1/spaces?space_id=personal"
curl -s "http://localhost:3000/api/v1/memory?space_id=personal&status=active"
curl -s "http://localhost:3000/api/v1/artifacts?space_id=personal"
curl -s "http://localhost:3000/api/v1/proposals?space_id=personal"
curl -s "http://localhost:3000/api/v1/runs?space_id=personal"
curl -s "http://localhost:3000/api/v1/activity?space_id=personal"
curl -s "http://localhost:3000/api/v1/runs/<run_id>/steps?space_id=personal"   # RunStep replay survives
```

---

## Rollback strategy

1. Stop writes: `docker compose --env-file "${ASPACE_ROOT:-$HOME/.aspace}/dev/.env" -p agent-space-dev -f ops/compose/docker-compose.dev.yml stop frontend server deployer`.
2. Snapshot current state: `cp -a ~/.aspace/dev ~/.aspace/dev-pre-rollback-$(date +%Y%m%d-%H%M%S)`.
3. Restore from the last known-good archive: `ops/scripts/system/restore.sh <archive> --mode dev --force`.
4. Restart: `ops/scripts/start.sh --dev`.
5. Verify with `ops/scripts/system/verify-restore.sh --mode dev`.

---

## Security considerations

- Normal data archives exclude `secrets/`. Credential archives contain the master key and
  CLI login state and must be handled as high-sensitivity material.
- Archive permissions are set to `600` (owner only) and the output directory to `700`.
  **`chmod 600` is necessary but is not encryption** — it only restricts other local
  users; it does nothing once the file leaves the machine.
- **Store backups securely, and encrypt them before moving them off-machine.** There is
  no archive passphrase by default; for any offsite/cloud/transfer copy, encrypt first,
  e.g. `gpg --symmetric <archive.tar.gz>`, and protect the passphrase separately.
- Raw secret values are never printed to stdout or written to the manifest. Scripts never
  print database passwords.

---

## Residual risks

| Risk | Mitigation |
|---|---|
| Automatic backup requires `BACKUP_ENABLED=true` | Prod fails fast at startup when backups are off unless `BACKUP_ACCEPT_NO_BACKUP=true`; dogfood operators set `BACKUP_ENABLED=true` in `.env` before first write |
| `pg_dump` client older than the server would fail | Keep the server runtime/client and offline postgres image in lockstep with `POSTGRES_MAJOR` |
| `BackupService` fails closed when `pg_dump` raises — no partial archive | Fix the underlying database/connection error before retrying |
| Database dump and file copy are not one cross-resource transaction | Keep normal writers quiescent for offline backup, and run `ops/scripts/system/verify-restore.sh` after restore |
| `workspaces/` captures directory structure, not external mount contents | Document external dependencies separately |
| Local archives are lost with the host | Manually encrypt and store both data and credential archives offsite; until that exists backups protect deletion only |

---

## Implementation notes

- `BackupService`: `server/src/modules/backups/service.ts` — creates archives via `pg_dump`, prunes.
- server scheduler registry: backup tick and API helper.
- `BackupManifest`: `server/src/modules/backups/manifest.ts` — `backup_manifest.json` structure.
- Backup API: `GET /api/v1/system/backups`, `POST /api/v1/system/backups/manual`.
- `ops/scripts/system/backup.sh` / `ops/scripts/system/restore.sh` — offline full-system tools.
- `ops/scripts/system/verify-restore.sh` — restored DB/schema/artifact consistency check.
- `ops/scripts/db/dump.sh` / `ops/scripts/db/restore.sh` — DB-only expert tools.
- `ops/scripts/lib/local-compose.sh` — shared mode/env/compose resolution for start, DB, and system scripts.
