# Backup and Restore — Rainver Local Instance

**Scope:** Local two-person dogfooding instance. PostgreSQL is the server database.

---

## Model

There is one full-system backup concept and one full-system restore concept.

| Tool | Role |
|---|---|
| `BackupService` (`server/src/modules/backups/service.ts`) | **Canonical full-system backup** — scheduled, on-startup, and via API. Produces a manifested archive. |
| server scheduler registry | Runs backup ticks and exposes manual/list API operations. |
| `ops/scripts/system/backup.sh` | App-services-stopped full-system backup — same archive format as `BackupService`, for when `frontend`, `server`, `sandbox-runner`, and `deployer` are stopped while postgres remains running. |
| `ops/scripts/system/restore.sh` | Full-system restore — restores **both** the database and file data from one archive. |
| `ops/scripts/db/dump.sh` | DB-only expert tool — `pg_dump` custom-format dump to `db/dumps/`. |
| `ops/scripts/db/restore.sh` | DB-only expert tool — `pg_restore` from a `.dump` file. |

A full-system backup archive contains a logical PostgreSQL snapshot **and** the file data, together with a manifest. Restore is a single command that rebuilds the database and the files.

**Two-person dogfooding must set `BACKUP_ENABLED=true`** in `.env`. The service defaults to `false` for test safety.

The offline full-system backup and restore scripts use the bundled Compose
`postgres` service. The DB-only dump and restore scripts also use that service.
Online backups use `BACKUP_DATABASE_URL`, which Compose defaults to the bundled
database. For an external database, configure that backup connection explicitly
and use a recovery procedure for the external database. The verification script
uses `DATABASE_URL` by default when set. External verification connects from
the verification host using Python 3 and the libpq shared library (for example,
`libpq5` on Debian). The host must be able to reach the database and read any
TLS files named in the URI. The complete URI reaches libpq through standard
input. Failures identify the client, connection, or query stage without printing
raw diagnostics. The bundled PostgreSQL service can stay stopped. After an
offline restore, use `--bundled-postgres` to verify the database that the restore
script rebuilt.

File backups include only the listed directories under the mode root. Back up a
custom `ARTIFACT_STORAGE_ROOT` outside those directories separately.

Across dev, test, and prod the client-facing API entrypoint is `server`.
Dev publishes server at `http://localhost:3000/api/v1`; test publishes it at
`http://localhost:3100/api/v1`. The test frontend uses server.
The bundled PostgreSQL containers have stable names per mode:
`rainver-dev-postgres`, `rainver-test-postgres`, and `rainver-prod-postgres`.

---

## Data locations

> **Path semantics.** `RAINVER_ROOT` is the host-side parent directory that holds the
> `dev/`, `test/`, `prod/` mode roots (default `~/.rainver-data`); the scripts locate a mode
> root as `$RAINVER_ROOT/<mode>`. Inside containers the running app sees that mode
> root as `RAINVER_HOME=/rainver`. `RAINVER_HOME` is never the parent of the mode dirs.
> The DB/system scripts share `ops/scripts/lib/local-compose.sh` with `ops/scripts/start.sh`,
> so mode validation, `$MODE_ROOT/.env`, `RAINVER_MODE_ROOT`, compose project/file,
> and `docker compose --env-file "$ENV_FILE"` stay consistent.
> Docker-native `ops/scripts/db/migrate.sh`, DB-only `ops/scripts/db/{dump,restore,reset-postgres}.sh`,
> and offline `ops/scripts/system/{backup,restore,verify-restore}.sh` stop the compose
> `postgres` service after completion only if that script started it; they do not
> stop a database that was already running.

| Path | Meaning | In normal backups? |
|---|---|---|
| `$RAINVER_ROOT/<mode>/db/postgres` | Live PostgreSQL data directory (bind-mounted into the postgres container) | **No** — never archived. The database is captured logically via `pg_dump`. |
| `$RAINVER_ROOT/<mode>/db/dumps` | PostgreSQL custom-format dumps | Generated `pre-migrate`/`pre-squash` dumps have automatic retention; manual dumps are operator-managed; not part of the system archive |
| `$RAINVER_ROOT/<mode>/db/migration-archives` | Registered frozen migration pairs and dependency records | Separately retain/copy with old backups; not part of the system archive |
| `storage/`, `artifacts/`, `config/`, `workspaces/` | Non-credential file data | Yes |
| `secrets/` | Credential master key and CLI login state | **No** — separate sensitive recovery archive only |
| `.env` | Deployment settings and secrets | **No** — snapshotted as `instance.env` in the sensitive recovery archive |
| `logs/` | Application logs | Optional (`BACKUP_INCLUDE_LOGS=true`) |
| `backups/`, `cache/`, `sandboxes/` | Archives / ephemeral | No |

---

## Automatic backup (canonical)

Generated safety dumps are pruned hourly using the same retained count as
automatic full-system backups (default 7), even if automatic backup creation is
disabled. Only ordinary, recognizable `pre-migrate-*.dump`/`pre-squash-*.dump`
files are eligible, counted per schema recovery point (retries before the same
schema change keep only the newest). Production takes a pre-migrate dump only
when a migration is pending, so routine restarts do not rotate it out. Manual
`dump-*.dump` files and manual full-system archives are preserved. Managed
migration archives are removed only after conversion succeeds (or this
instance's database has already passed the archived target by normal
migration) and all recorded local backup dependencies are gone. Keep a source
release/chain with any old backup copied elsewhere: local retention cannot
discover offsite copies. External source catalogs remain operator-owned.

An interrupted cutover pins recovery material until recovery/retry (cleanup
logs a warning meanwhile), and cleanup shares an exclusive filesystem mutex
with cutover. Backups from before the one-time 2026-10-22 migration rebase
need the procedure in `server/migrations/README.md`. See
[Operations and Safety](../.agent/architecture/OPERATIONS_AND_SAFETY.md) for
stale-lock recovery; do not bypass a live operation's lock.

### Enable

In `$RAINVER_ROOT/<mode>/.env`:

```
BACKUP_ENABLED=true
```

The server reads this deployment capability on startup and registers its backup
reconciler with the server scheduler registry. Configure the interval, retained
automatic archive count, log inclusion, and startup backup behavior in
**Instance Settings → Operations & retention**. These database-backed policies
take effect without restarting the server. A startup backup runs in the
background and does not block readiness or dependent services.

### Archive contents

| Path in archive | Contents |
|---|---|
| `db/rainver.dump` | PostgreSQL snapshot (`pg_dump -Fc --no-owner --no-acl`) — all memory, proposals, runs, activity, artifacts, policies, run steps |
| `storage/` | Artifact storage files |
| `artifacts/` | Artifact storage root |
| `config/` | Runtime configuration (no secret values) |
| `workspaces/` | Workspace metadata directories |
| `logs/` | If included by the instance backup policy, or selected for an offline backup |
| `backup_manifest.json` | Archive metadata (see below) |

`backups/`, `cache/`, `sandboxes/`, and the live `db/postgres` directory are never included.

**Sensitive-state separation:** normal archives never contain `secrets/` or the mode `.env`.
Use `ops/scripts/system/backup-credentials.sh` for an explicit sensitive recovery archive and
`restore-credentials.sh` to restore it separately. The archive contains `secrets/` plus an
`instance.env` snapshot. This prevents one ordinary data archive from containing both the
encrypted provider-key database rows and their decryption key or deployment secrets.

### Archive naming

```
$RAINVER_ROOT/<mode>/backups/auto-YYYYMMDD-HHMMSS.tar.gz     ← scheduled
$RAINVER_ROOT/<mode>/backups/manual-YYYYMMDD-HHMMSS.tar.gz   ← API trigger
$RAINVER_ROOT/<mode>/backups/system-YYYYMMDD-HHMMSS.tar.gz   ← ops/scripts/system/backup.sh
```

### backup_manifest.json

Every full-system backup archive — whether written by `BackupService` or by
`ops/scripts/system/backup.sh` — contains a `backup_manifest.json` at its root with
the same schema:

- `backup_format: "rainver-backup.v1"` — backup format version
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

Full-system backup also copies non-credential file data (`storage/`, `artifacts/`, `config/`, `workspaces/`). The database dump and file copies are not one cross-resource transaction. Use `ops/scripts/system/verify-restore.sh` to verify restored `artifacts.storage_path` references against the target storage layout.

### pg_dump client version (must match the server)

`pg_dump` refuses to dump a server **newer** than the client. The online `BackupService`
uses the PostgreSQL 18 client installed in the server image. The offline backup
script runs `pg_dump` inside the postgres container. When the `postgres` server
major is upgraded, update the client package in `server/Dockerfile` at the same
time. The server never mounts the Docker socket.

### Backup safety guard (prod)

When `RAINVER_ENV=prod` and `BACKUP_ENABLED=false`, the server **fails fast at startup**
rather than silently running without backups. To run prod without automatic backups you must
explicitly acknowledge the risk with `BACKUP_ACCEPT_NO_BACKUP=true`; non-prod environments only
log a strong warning. See `server/src/modules/backups/guard.ts`.

### Overlap protection and retention

- Local advisory lock file `backups/.backup.lock` prevents overlapping backups across server processes on the same host.
- Auto backups: the latest configured count (default 7) are kept; older ones
  are pruned after each run. Manual backups are never pruned automatically.

### API

```bash
# Set ADMIN_COOKIE_JAR to the cookie file from an instance administrator login.
# Trigger a manual full-system backup.
curl -X POST http://localhost:3000/api/v1/system/backups/manual --cookie "$ADMIN_COOKIE_JAR" -H "Idempotency-Key: $(uuidgen)"
# A keyed system command: 202 {"status":"succeeded","data":{"id":"<command-id>","status":"pending",...}}.
# The archive is written after commit; its name is the command's result:
curl -s http://localhost:3000/api/v1/system/commands/<command-id> --cookie "$ADMIN_COOKIE_JAR"
# Expected once settled: {"status":"succeeded","result":{"status":"ok","backup":"manual-YYYYMMDD-HHMMSS.tar.gz"},...}

# List backups
curl http://localhost:3000/api/v1/system/backups --cookie "$ADMIN_COOKIE_JAR"
```

---

## Offline full-system backup

When app services are stopped, produce an identical-format archive with:

```bash
# Stop writers first; backup starts postgres automatically if needed.
docker compose --env-file "${RAINVER_ROOT:-$HOME/.rainver-data}/dev/.env" -p rainver-dev -f ops/compose/docker-compose.dev.yml stop frontend server sandbox-runner deployer

ops/scripts/system/backup.sh --mode dev
ops/scripts/system/backup.sh --mode prod --include-logs
ops/scripts/system/backup.sh --mode dev --output /mnt/backups
```

This runs `pg_dump` inside the postgres container, copies the file data, writes a `backup_manifest.json` with the same schema as `BackupService` (including `backup_interval_hours` and `backup_retention_count`, read from `BACKUP_INTERVAL_HOURS` / `BACKUP_RETENTION_COUNT` in the mode `.env`, defaulting to `24` / `7`), and produces `system-<timestamp>.tar.gz`. It starts PostgreSQL automatically if needed and stops it afterward only if backup started it. By default, `ops/scripts/system/backup.sh` refuses to run while `frontend`, `server`, `sandbox-runner`, or `deployer` are active because file data can change during the backup. Use `BackupService` or `POST /api/v1/system/backups/manual` for online backup while the server is running.

## Separate sensitive recovery backup

Credential state and the mode `.env` are deliberately excluded from every normal data archive.
With app services stopped, create and restore them explicitly:

```bash
ops/scripts/system/backup-credentials.sh --mode dev
# output: ~/.rainver-data/dev/credential-backups/credentials-<timestamp>.tar.gz

ops/scripts/system/restore-credentials.sh \
  ~/.rainver-data/dev/credential-backups/credentials-<timestamp>.tar.gz \
  --mode dev --force
```

The sensitive archive contains `secrets/`, an `instance.env` snapshot, and
`credential_backup_manifest.json` (`rainver-credentials.v1`). It is mode `0600`, but it is not
encrypted by default. Normal data restore never overwrites either sensitive location; restore
this archive as a separate operator decision before starting the app.

By default, `restore-credentials.sh` restores `secrets/` and publishes the environment snapshot
as `$RAINVER_ROOT/<mode>/.env.restored` for review. It never silently replaces the active `.env`.
An existing `secrets/` is replaced with the same atomic exchange as `restore.sh` file directories (never missing, wholly old or wholly restored; it stops unchanged where the exchange is unavailable).
On a fresh replacement host the command can run before an active `.env` exists; it checks for
running services through Docker's Compose labels in that case.
After checking target-specific IPs, URLs, paths, and ports, either merge it manually or explicitly
restore it as the active environment:

```bash
ops/scripts/system/restore-credentials.sh \
  <credential-archive.tar.gz> --mode prod --force --restore-env
```

Generated `.server.env` and `.deployer.env` files are not archived; the ops scripts recreate them
from the reviewed mode `.env`.

### Manual encrypted offsite copy (required for host-loss protection)

Local archives protect against accidental deletion, not disk or host loss. After producing a
normal data archive and a credential archive, encrypt and transfer them as two separate files:

```bash
gpg --symmetric --cipher-algo AES256 ~/.rainver-data/dev/backups/<data-archive>.tar.gz
gpg --symmetric --cipher-algo AES256 ~/.rainver-data/dev/credential-backups/<credential-archive>.tar.gz

# Verify the encrypted copies before transfer.
gpg --decrypt ~/.rainver-data/dev/backups/<data-archive>.tar.gz.gpg | tar -tzf - >/dev/null
gpg --decrypt ~/.rainver-data/dev/credential-backups/<credential-archive>.tar.gz.gpg | tar -tzf - >/dev/null
```

Copy both `.gpg` files to offsite storage, keep the passphrase in a different password manager
or physical location, and do not place the unencrypted data and credential archives together
off-host. Periodically rehearse decrypting both and restoring into the test mode.

---

## Restore (full-system, single command)

Restore rebuilds the database and the file data from one archive. Stop
`frontend`, `server`, `sandbox-runner`, and `deployer`. Restore checks for
running, restarting, and paused containers. It starts `postgres` automatically
if needed and stops it afterward only if restore started it. The shared
instance lock keeps packaged startup, migration, update, and restore commands
from interleaving. Wait for restore to finish before using direct Docker commands.

> **Do not use `ops/scripts/start.sh` as a restore preflight** — it starts the app services (`frontend`, `server`, `deployer`), which `restore.sh` then refuses. Run `ops/scripts/start.sh --<mode>` only *after* the restore succeeds.

```bash
# 1. Stop the app (leave postgres running)
docker compose --env-file "${RAINVER_ROOT:-$HOME/.rainver-data}/dev/.env" -p rainver-dev -f ops/compose/docker-compose.dev.yml stop frontend server sandbox-runner deployer

# 2. Keep or start postgres only
docker compose --env-file "${RAINVER_ROOT:-$HOME/.rainver-data}/dev/.env" -p rainver-dev -f ops/compose/docker-compose.dev.yml up -d postgres

# 3. Restore database + files from one archive
ops/scripts/system/restore.sh ~/.rainver-data/dev/backups/auto-20260101-120000.tar.gz --mode dev --force

# 4. Start the app after restore succeeds, then verify
ops/scripts/start.sh --dev
ops/scripts/system/verify-restore.sh --mode dev --bundled-postgres
```

After checking the archive and the selected server image, `restore.sh` copies
each file directory beside its target. It then imports the dump with
`pg_restore --exit-on-error --no-owner --no-acl` into a new
`rainver_restore_stage_*` database. The selected image reconciles plugin and
runtime role grants in that staging database. If runtime-role activation is
enabled, restore checks the configured application and backup roles before
switching over. A failure in any of these steps leaves the active database name
and existing file data intact.

PostgreSQL switches both database names in one transaction. If the target
already exists, it moves to the reported `rainver_restore_before_*` protection
point with connections disabled. The fully imported database takes the target
name. The protection point stays on the same PostgreSQL cluster and consumes
space until an operator explicitly disposes of it after verification. Plan for
space for the staged database and one additional copy of the restored files.

Once the database switch commits, each prepared directory replaces its target
atomically. The directories and PostgreSQL use separate operations. If a file
replacement fails, keep the apps stopped, consult the error for the directories
already replaced and the preserved database name, and retry the intended
archive with `--force`. If the connection was lost during the switch, inspect
both database names before restarting.

Restore cleans up failed staging databases when it can run cleanup. A hard kill
can leave a `rainver_restore_stage_*` database behind. A retry stages a new one
without reusing a partial import. Confirm that no restore is running before
removing a leftover staging database. Use `restore-credentials.sh` separately
for credential data. Full-system restore leaves the PostgreSQL storage directory
in place.

During preflight, `restore.sh` reads the manifest **version metadata** (`backup_format`,
`app_version`, `git_commit`, `schema_migration_version`, `schema_migration_checksum`, `postgres_server_version`, `pg_dump_version`),
prints the recorded values, and **fails closed before any destructive operation** on a missing
or unexpected `backup_format`. When both versions are available, it rejects a PostgreSQL
**major-version** mismatch between the source and target. Before staging the database it also verifies
that the selected server image supports the required reconciliation commands. The
selected image supplies the migration chain used to check the recorded schema version and
checksum. If the archive provides both, restore rejects an unknown migration version
or a checksum that differs from the selected image's migration file. The last two mean the archive came from a newer build,
or an applied migration was edited, or the archive belongs to the previous schema epoch:
restoring it would produce a database the migration runner refuses to start against. An archive
from an **older** build within the current epoch is fine — migrations are append-only, and the
next `start.sh` applies the ones the archive predates. If restore reports pending
maintenance migrations, run the documented `start.sh --<mode> --maintenance` path. A previous-epoch database has no upgrade
path and must be recreated from the new baseline; do not use the override to cross the epoch.
For other controlled recovery cases you can override this check with
`--force-incompatible-backup`; `--force` (file overwrite) and `--force-running` (active
services) do **not** imply it. For archives with incomplete metadata, verify the missing compatibility information before restoring.

In production, restore resolves the configured channel to a commit once and
uses the verified server image at that commit for inspection and reconciliation.
For an offline restore or rollback, select the intended `sha-<commit>` in
`RAINVER_IMAGE_TAG` and ensure that image is already present locally. Use the
same tag for startup after restore.

For `test` or `prod`, use the matching compose project and file, for example `rainver-test` with `ops/compose/docker-compose.test.yml` or `rainver-prod` with `ops/compose/docker-compose.prod.yml`.

`--force-running` bypasses the running-service refusal and should only be used for controlled recovery when you have independently stopped all writers. `--force-incompatible-backup` bypasses the backup-compatibility preflight (unexpected `backup_format`, PostgreSQL major-version mismatch, or schema-checksum mismatch) and should only be used when you have verified the archive is restorable **and startable** on the target build.

### DB-only expert path

To dump or restore only the database (no file data):

```bash
ops/scripts/db/dump.sh --mode dev                       # → db/dumps/dump-<ts>.dump
ops/scripts/db/restore.sh ~/.rainver-data/dev/db/dumps/dump-<ts>.dump --mode dev
```

DB-only dump, restore, and reset start `postgres` automatically and stop it
afterward if they started it. Stop `frontend`, `server`, `sandbox-runner`,
and `deployer` before restore or reset. `ops/scripts/db/restore.sh` checks the
dump with `pg_restore --list` and uses the same staging, role reconciliation,
transactional cutover, and retained protection point as full-system restore.
The `postgres`, `template0`, and `template1` databases are reserved for PostgreSQL
administration. Names beginning with `rainver_restore_` identify restore generations.

---

## Restore verification checklist

Use the restore verification script first. It checks the Compose `postgres` service,
server migration rows, core table counts, and Artifact file presence.

```bash
ops/scripts/system/verify-restore.sh --mode dev --bundled-postgres
ops/scripts/system/verify-restore.sh --mode test --bundled-postgres
ops/scripts/system/verify-restore.sh --mode prod --bundled-postgres
```

The verifier resolves the server's `ARTIFACT_STORAGE_ROOT` and most specific
local bind mount from the target Compose configuration. It flags references
outside the standard offline archive directories even when their files are
present. Restore external mounts separately and validate their contents
against your backup manifest. Artifact rows do not record a general content
checksum, so file presence is the limit of this check. Invalid paths or
missing mapped files fail verification. Exit status 2 means some paths could
not be checked, for example with a remote Docker daemon, a named volume, or
a storage root without a local bind mapping.

For targeted API checks after the verifier passes:

```bash
curl -s "http://localhost:3000/api/v1/spaces/<space_id>"
curl -s "http://localhost:3000/api/v1/memory?space_id=personal&status=active"
curl -s "http://localhost:3000/api/v1/artifacts?space_id=personal"
curl -s "http://localhost:3000/api/v1/proposals?space_id=personal"
curl -s "http://localhost:3000/api/v1/runs?space_id=personal"
curl -s "http://localhost:3000/api/v1/activity?space_id=personal"
curl -s "http://localhost:3000/api/v1/runs/<run_id>/trace?space_id=personal"   # `steps`: RunStep replay survives
```

---

## Rollback strategy

1. Stop writes: `docker compose --env-file "${RAINVER_ROOT:-$HOME/.rainver-data}/dev/.env" -p rainver-dev -f ops/compose/docker-compose.dev.yml stop frontend server sandbox-runner deployer`.
2. Snapshot current state: `cp -a ~/.rainver-data/dev ~/.rainver-data/dev-pre-rollback-$(date +%Y%m%d-%H%M%S)`.
3. Restore from the last known-good archive: `ops/scripts/system/restore.sh <archive> --mode dev --force`.
4. Restart: `ops/scripts/start.sh --dev`.
5. Verify with `ops/scripts/system/verify-restore.sh --mode dev --bundled-postgres`.

---

## Security considerations

- Normal data archives exclude `secrets/` and `.env`. Sensitive recovery archives contain the
  master key, CLI login state, database/internal tokens, and deployment configuration, and must
  be handled as high-sensitivity material.
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
