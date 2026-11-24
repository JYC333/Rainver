#!/usr/bin/env bash
# Full-system restore — restores both the PostgreSQL database and file data
# from a canonical backup archive (produced by BackupService or
# ops/scripts/system/backup.sh).
#
# Restore sequence (single command):
#   1. Extract to staging and validate archive/file restore preconditions.
#   2. Refuse active app services unless --force-running is supplied.
#   3. Import and reconcile db/rainver.dump in a staging database, then switch
#      it in with a transactional rename that preserves the previous database.
#   4. Restore non-credential file data (config/ storage/ artifacts/ workspaces/, and
#      logs/ if present) into $RAINVER_ROOT/<mode>/.
#
# Failure safety: after confirmation and before the database is touched, every
# file directory is first copied next to its target on the same filesystem; a
# copy failure (disk full, interruption) stops the restore with the database
# and every existing directory unchanged. pg_restore runs with --exit-on-error
# on the staging database, so an unsuccessful import cannot replace the active database.
# Each directory is then swapped in with one atomic exchange (atomic_ops.py
# replace-directory: renameat2 RENAME_EXCHANGE / macOS renamex_np RENAME_SWAP;
# where unavailable it stops with that directory unchanged), so a directory is
# never missing and is either wholly old or wholly restored, even if killed.
# The database and the set of directories are separate operations. A file
# replacement failure leaves the prior database generation available as a
# protection point, and the message names which directories were already replaced.
# Recover by re-running this restore
# with the same (or an earlier) archive; the server's automatic backups live in
# $RAINVER_ROOT/<mode>/backups. Restoring needs free space for one extra copy
# of the restored file data until each swap completes.
#
# The live PostgreSQL data directory (db/postgres) is never overwritten — the
# database is rebuilt logically with pg_restore. The script starts PostgreSQL if
# needed and stops it afterward only when it started it.
#
# Backup-compatibility preflight fails closed, before any destructive operation:
# a missing/unexpected backup_format, a PostgreSQL major-version mismatch, or a
# schema checksum that differs from this build's copy of that migration.
# The last one means an applied migration was edited, or the archive came from
# a newer build than this one: restoring it would leave a database the
# migration runner refuses to start against. An archive from an OLDER build is
# fine — the normal migrate step brings it forward. --force-incompatible-backup
# overrides any of the three for controlled recovery.
# --force (file overwrite) and --force-running (active services) do NOT imply it.
#
# Usage:
#   ops/scripts/system/restore.sh <archive.tar.gz> [--mode dev|test|prod] [--force] [--force-running] [--force-incompatible-backup]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"
source "$SCRIPT_DIR/../lib/restore-database.sh"

MODE="${RAINVER_MODE:-dev}"
ARCHIVE=""
FORCE=false
FORCE_RUNNING=false
FORCE_INCOMPATIBLE=false

# ── Argument parsing (before computing mode-dependent paths) ───────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="$2"; shift 2 ;;
    --force)         FORCE=true; shift ;;
    --force-running) FORCE_RUNNING=true; shift ;;
    --force-incompatible-backup) FORCE_INCOMPATIBLE=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$ARCHIVE" ]]; then ARCHIVE="$1"; else
        echo "ERROR: unexpected argument: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

local_compose_init "$MODE"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage: $0 <archive.tar.gz> [--mode dev|test|prod] [--force] [--force-running]" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "ERROR: archive not found: $ARCHIVE" >&2
  exit 1
fi
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"
restore_database_check_target

preflight_error() {
  echo "ERROR: preflight failed before destructive DB operation started: $*" >&2
  exit 1
}


echo "[restore] archive: $ARCHIVE"
echo "[restore] mode:    $MODE"
echo "[restore] target:  $MODE_ROOT"

# ── Safely extract to staging ──────────────────────────────────────────────────
STAGING="$(mktemp -d -t rainver-system-restore-XXXXXX)"
PREPARED=()
REPLACED=()
RESTORE_STAGE="preflight"
# Prepared copies live under $MODE_ROOT with a fixed prefix; only those are removed.
cleanup_prepared() {
  local prepared
  for prepared in "${PREPARED[@]}"; do
    [[ "$prepared" == "$MODE_ROOT"/.restore-new-* && -e "$prepared" ]] && rm -rf -- "$prepared"
  done
  return 0
}
report_failure() {
  local status=$?
  (( status == 0 )) && return 0
  case "$RESTORE_STAGE" in
    prepare)
      echo "ERROR: could not copy file data onto the target filesystem (is the disk full?)." >&2
      echo "       Nothing was changed: database '$PGDB' and every directory in $MODE_ROOT are as before." >&2
      ;;
    database)
      echo "ERROR: database restore failed. The previous database was preserved. File data was not changed." >&2
      echo "       Re-run this restore with the same archive or an earlier one (automatic backups: $MODE_ROOT/backups)." >&2
      ;;
    files)
      echo "ERROR: file restore stopped. Database '$PGDB' is restored; directories already replaced: ${REPLACED[*]:-none}." >&2
      echo "       If '$PGDB' previously existed, its protection point is '$RESTORE_DB_PREVIOUS'." >&2
      echo "       Every other directory is wholly previous or (the one being swapped when it stopped) wholly restored." >&2
      echo "       Re-run this restore with --force to finish." >&2
      ;;
  esac
  return 0
}
trap 'report_failure; restore_database_cleanup; cleanup_prepared; local_compose_stop_postgres_if_started "restore"; rm -rf "$STAGING"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! python3 "$SCRIPT_DIR/safe_extract.py" "$ARCHIVE" "$STAGING" \
  db storage artifacts config workspaces logs backup_manifest.json; then
  preflight_error "archive failed safe extraction: $ARCHIVE"
fi

if [[ ! -f "$STAGING/backup_manifest.json" ]]; then
  preflight_error "archive is missing backup_manifest.json"
fi
if ! python3 -m json.tool "$STAGING/backup_manifest.json" >/dev/null; then
  preflight_error "backup_manifest.json is not valid JSON"
fi

if [[ ! -d "$STAGING/db" ]]; then
  preflight_error "archive is missing db/"
fi
mapfile -t DUMP_FILES < <(find "$STAGING/db" -maxdepth 1 -type f -name '*.dump' -print | sort)
if (( ${#DUMP_FILES[@]} != 1 )); then
  preflight_error "archive must contain exactly one db/*.dump file"
fi
DUMP_FILE="${DUMP_FILES[0]}"
if [[ "$(basename "$DUMP_FILE")" != "rainver.dump" ]]; then
  preflight_error "archive dump must be db/rainver.dump"
fi

if ! install -d -m 700 "$MODE_ROOT"; then
  preflight_error "cannot create target root: $MODE_ROOT"
fi
local_compose_lock_instance "restoring the instance"

FILE_DIRS=()
for d in config storage artifacts workspaces logs; do
  [[ -d "$STAGING/$d" ]] || continue
  FILE_DIRS+=("$d")
  if [[ -e "$MODE_ROOT/$d" && "$FORCE" != "true" ]]; then
    preflight_error "$MODE_ROOT/$d already exists. Re-run with --force to overwrite file data."
  fi
done

local_compose_require_stopped_applications "full-system restore" "$FORCE_RUNNING"

# ── PostgreSQL must be ready for pg_restore ────────────────────────────────────
if ! local_compose_ensure_postgres_ready "restore" "$PGUSER"; then
  preflight_error "postgres service is not ready for mode '$MODE'"
fi

if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DUMP_FILE" >/dev/null; then
  preflight_error "db/rainver.dump is not a readable pg_restore custom-format dump"
fi
local_compose_prepare_prod_server_image || preflight_error "could not prepare the selected server image"
MIGRATION_INVENTORY="$(local_compose_restore_preflight "$PGDB")" ||
  preflight_error "the selected server image could not verify migrations and restore commands"

# ── Manifest version metadata (read + validate; fail closed on mismatch) ───────
# Manifest fields are never silently ignored: each is reported, and an incompatible
# backup_format, a PostgreSQL major-version mismatch, or a schema checksum that
# differs from this build's migration file aborts before any destructive operation.
# --force-incompatible-backup overrides the check for controlled recovery.
# PostgreSQL is the server database.
read_manifest_field() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
v=d.get(sys.argv[2])
print("" if v is None else v)' "$STAGING/backup_manifest.json" "$1" 2>/dev/null || true
}

BK_FORMAT="$(read_manifest_field backup_format)"
BK_APP_VERSION="$(read_manifest_field app_version)"
BK_GIT_COMMIT="$(read_manifest_field git_commit)"
BK_SCHEMA_MIGRATION_VERSION="$(read_manifest_field schema_migration_version)"
BK_SCHEMA_MIGRATION_CHECKSUM="$(read_manifest_field schema_migration_checksum)"
BK_PG_SERVER="$(read_manifest_field postgres_server_version)"
BK_PG_DUMP="$(read_manifest_field pg_dump_version)"

echo "[restore] manifest backup_format: ${BK_FORMAT:-<none>}"
echo "[restore] manifest app_version:   ${BK_APP_VERSION:-<unknown>}"
echo "[restore] manifest git_commit:    ${BK_GIT_COMMIT:-<unknown>}"
echo "[restore] manifest schema_ver:    ${BK_SCHEMA_MIGRATION_VERSION:-<unknown>}"
echo "[restore] manifest schema_sum:    ${BK_SCHEMA_MIGRATION_CHECKSUM:-<unknown>}"
echo "[restore] manifest pg_server:     ${BK_PG_SERVER:-<unknown>}"
echo "[restore] manifest pg_dump:       ${BK_PG_DUMP:-<unknown>}"

incompatible_backup() {
  if [[ "$FORCE_INCOMPATIBLE" == "true" ]]; then
    echo "WARNING: $*" >&2
    echo "         Continuing because --force-incompatible-backup was supplied." >&2
    return 0
  fi
  echo "ERROR: $*" >&2
  echo "       Aborting before any destructive operation. Restore a compatible backup," >&2
  echo "       or re-run with --force-incompatible-backup for controlled recovery." >&2
  exit 1
}

EXPECTED_FORMAT="rainver-backup.v1"
if [[ -z "$BK_FORMAT" ]]; then
  incompatible_backup "backup_manifest.json has no backup_format — archive provenance is unknown."
elif [[ "$BK_FORMAT" != "$EXPECTED_FORMAT" ]]; then
  incompatible_backup "backup_format '$BK_FORMAT' != expected '$EXPECTED_FORMAT'."
fi

# Compare PostgreSQL server major versions (backup source vs live restore target).
LIVE_PG_SERVER="$("${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]' || true)"
BK_PG_MAJOR="${BK_PG_SERVER%%.*}"
LIVE_PG_MAJOR="${LIVE_PG_SERVER%%.*}"
if [[ -n "$BK_PG_MAJOR" && -n "$LIVE_PG_MAJOR" && "$BK_PG_MAJOR" != "$LIVE_PG_MAJOR" ]]; then
  incompatible_backup "backup PostgreSQL major ($BK_PG_MAJOR) != live server major ($LIVE_PG_MAJOR); restoring a custom-format dump across major versions can fail or misbehave."
fi

# Check the chain inside the image that will reconcile the restored DB.
if [[ -n "$BK_SCHEMA_MIGRATION_VERSION" && -n "$BK_SCHEMA_MIGRATION_CHECKSUM" ]]; then
  backup_migration="" backup_checksum="" latest_migration="" pending_maintenance=""
  while IFS=$'\t' read -r version name checksum policy; do
    latest_migration="${version}_${name}.sql"
    if [[ "$version" == "$BK_SCHEMA_MIGRATION_VERSION" ]]; then
      backup_migration="$latest_migration"
      backup_checksum="$checksum"
    elif [[ -n "$backup_migration" && "$policy" == maintenance ]]; then
      pending_maintenance="$pending_maintenance $latest_migration"
    fi
  done <<< "$MIGRATION_INVENTORY"
  if [[ -z "$backup_migration" ]]; then
    incompatible_backup "backup schema version ${BK_SCHEMA_MIGRATION_VERSION} is not in the selected server image's migration chain. Restore into a build that carries that migration."
  else
    if [[ "$BK_SCHEMA_MIGRATION_CHECKSUM" != "$backup_checksum" ]]; then
      incompatible_backup "backup checksum for migration ${BK_SCHEMA_MIGRATION_VERSION} (${BK_SCHEMA_MIGRATION_CHECKSUM:0:12}...) differs from the selected image's $backup_migration (${backup_checksum:0:12}...)."
    fi
    if [[ "$latest_migration" != "$backup_migration" ]]; then
      echo "[restore] backup is at migration ${BK_SCHEMA_MIGRATION_VERSION}; the selected build continues to $latest_migration."
    fi
    if [[ -n "$pending_maintenance" ]]; then
      echo "[restore] these require an offline maintenance upgrade (ADR 0016 section 10):${pending_maintenance}"
      echo "[restore]   Resume with: ops/scripts/start.sh --$MODE --maintenance"
    fi
  fi
fi

echo "[restore] preflight complete; no destructive DB operation has started."
echo "WARNING: this overwrites database '$PGDB' and file data in $MODE_ROOT (mode: $MODE)."
read -r -p "Type 'yes' to continue: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# ── Prepare file data beside its targets (same filesystem; nothing replaced) ───
RESTORE_STAGE="prepare"
for d in "${FILE_DIRS[@]}"; do
  prepared="$(mktemp -d "$MODE_ROOT/.restore-new-$d-XXXXXX")"
  PREPARED+=("$prepared")
  cp -a "$STAGING/$d/." "$prepared/"
  python3 "$SCRIPT_DIR/atomic_ops.py" check-directory-replace "$prepared" "$MODE_ROOT/$d"
done

# ── Stage and switch the restored database ───────────────────────────────────
local_compose_require_stopped_applications "full-system restore" "$FORCE_RUNNING"
RESTORE_STAGE="database"
restore_database "$DUMP_FILE" "full-system restore" "$FORCE_RUNNING"

# ── Restore file data ──────────────────────────────────────────────────────────
RESTORE_STAGE="files"
for i in "${!FILE_DIRS[@]}"; do
  d="${FILE_DIRS[$i]}"
  python3 "$SCRIPT_DIR/atomic_ops.py" replace-directory "${PREPARED[$i]}" "$MODE_ROOT/$d"
  REPLACED+=("$d")
done
RESTORE_STAGE="done"

for d in config; do
  [[ -d "$MODE_ROOT/$d" ]] && chmod 700 "$MODE_ROOT/$d"
done

echo "[restore] complete."
echo "[restore] resume the app, then verify the restored instance:"
if [[ "$MODE" == prod ]]; then
  echo "          RAINVER_IMAGE_TAG=$RAINVER_IMAGE_TAG ops/scripts/start.sh --prod"
else
  echo "          ops/scripts/start.sh --$MODE"
fi
echo "          ops/scripts/system/verify-restore.sh --mode $MODE --bundled-postgres"
case "$MODE" in
  dev)
    echo "          # API health URL: http://localhost:3000/api/v1/server/health"
    ;;
  test)
    echo "          # API health URL: http://localhost:3100/api/v1/server/health"
    ;;
  prod)
    echo "          # Check /api/v1/server/health on the production frontend."
    ;;
esac
