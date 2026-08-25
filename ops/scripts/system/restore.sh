#!/usr/bin/env bash
# Full-system restore — restores both the PostgreSQL database and file data
# from a canonical backup archive (produced by BackupService or
# ops/scripts/system/backup.sh).
#
# Restore sequence (single command):
#   1. Extract to staging and validate archive/file restore preconditions.
#   2. Refuse active app services unless --force-running is supplied.
#   3. Restore the database from db/agent_space.dump via pg_restore
#      (terminate connections, drop, create, restore).
#   4. Restore non-credential file data (config/ storage/ artifacts/ workspaces/, and
#      logs/ if present) into $ASPACE_ROOT/<mode>/.
#
# The live PostgreSQL data directory (db/postgres) is never overwritten — the
# database is rebuilt logically with pg_restore. The script starts PostgreSQL if
# needed and stops it afterward only when it started it.
#
# Backup-compatibility preflight fails closed, before any destructive operation:
# a missing/unexpected backup_format, a PostgreSQL major-version mismatch, or a
# schema checksum that differs from this build's migrations/0001_baseline.sql.
# The last one means the archive predates a schema change: restoring it would
# leave a database the migration runner refuses to start against, so prefer a
# build whose baseline matches. --force-incompatible-backup overrides any of
# the three for controlled recovery.
# --force (file overwrite) and --force-running (active services) do NOT imply it.
#
# Usage:
#   ops/scripts/system/restore.sh <archive.tar.gz> [--mode dev|test|prod] [--force] [--force-running] [--force-incompatible-backup]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${AGENT_SPACE_MODE:-dev}"
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

PGDB="$(local_compose_setting_or_default POSTGRES_DB agent_space)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER agent_space)"

local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

preflight_error() {
  echo "ERROR: preflight failed before destructive DB operation started: $*" >&2
  exit 1
}

require_app_services_stopped() {
  local running_services=""
  local running=()
  local service

  if ! running_services="$("${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null)"; then
    preflight_error "unable to inspect running compose services for mode '$MODE'"
  fi

  for service in "$@"; do
    if [[ $'\n'"$running_services"$'\n' == *$'\n'"$service"$'\n'* ]]; then
      running+=("$service")
    fi
  done

  if (( ${#running[@]} == 0 )); then
    return 0
  fi

  if [[ "$FORCE_RUNNING" == "true" ]]; then
    echo "WARNING: app service(s) still running during restore: ${running[*]}" >&2
    return 0
  fi

  echo "ERROR: app service(s) still running for mode '$MODE': ${running[*]}" >&2
  echo "       Stop app services first; restore will manage postgres as needed." >&2
  echo "       $COMPOSE_HINT stop frontend server deployer" >&2
  exit 1
}

echo "[restore] archive: $ARCHIVE"
echo "[restore] mode:    $MODE"
echo "[restore] target:  $MODE_ROOT"

# ── Safely extract to staging ──────────────────────────────────────────────────
STAGING="$(mktemp -d -t aspace-system-restore-XXXXXX)"
trap 'local_compose_stop_postgres_if_started "restore"; rm -rf "$STAGING"' EXIT
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
if [[ "$(basename "$DUMP_FILE")" != "agent_space.dump" ]]; then
  preflight_error "archive dump must be db/agent_space.dump"
fi

if ! install -d -m 700 "$MODE_ROOT"; then
  preflight_error "cannot create target root: $MODE_ROOT"
fi

FILE_DIRS=()
for d in config storage artifacts workspaces logs; do
  [[ -d "$STAGING/$d" ]] || continue
  FILE_DIRS+=("$d")
  if [[ -e "$MODE_ROOT/$d" && "$FORCE" != "true" ]]; then
    preflight_error "$MODE_ROOT/$d already exists. Re-run with --force to overwrite file data."
  fi
done

require_app_services_stopped frontend server deployer

# ── PostgreSQL must be ready for pg_restore ────────────────────────────────────
if ! local_compose_ensure_postgres_ready "restore" "$PGUSER"; then
  preflight_error "postgres service is not ready for mode '$MODE'"
fi

if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DUMP_FILE" >/dev/null; then
  preflight_error "db/agent_space.dump is not a readable pg_restore custom-format dump"
fi

# ── Manifest version metadata (read + validate; fail closed on mismatch) ───────
# Manifest fields are never silently ignored: each is reported, and an incompatible
# backup_format, a PostgreSQL major-version mismatch, or a schema checksum that
# differs from this build's baseline aborts before any destructive operation.
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

EXPECTED_FORMAT="agent-space-backup.v1"
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

# The runtime schema is a single regenerated baseline (server/migrations/README.md),
# so its checksum changes whenever the schema does. A backup taken before that
# rewrite restores a database whose recorded checksum no longer matches the
# file on disk, and the migration runner refuses to reapply it — leaving a
# restored-but-unstartable stack. Say so here, where the operator can still
# choose a different archive, rather than at the next `start.sh`.
BASELINE_FILE="$SCRIPT_DIR/../../../server/migrations/0001_baseline.sql"
if [[ -n "$BK_SCHEMA_MIGRATION_CHECKSUM" && -f "$BASELINE_FILE" ]]; then
  LIVE_SCHEMA_CHECKSUM="$(sha256sum "$BASELINE_FILE" | cut -d' ' -f1)"
  if [[ "$BK_SCHEMA_MIGRATION_CHECKSUM" != "$LIVE_SCHEMA_CHECKSUM" ]]; then
    incompatible_backup "backup schema checksum (${BK_SCHEMA_MIGRATION_CHECKSUM:0:12}...) != this build's baseline (${LIVE_SCHEMA_CHECKSUM:0:12}...); the migration runner will refuse to start against the restored database. Restore into a build whose baseline matches, or accept that this data cannot be carried across the schema change."
  fi
fi

echo "[restore] preflight complete; no destructive DB operation has started."
echo "WARNING: this overwrites database '$PGDB' and file data in $MODE_ROOT (mode: $MODE)."
read -r -p "Type 'yes' to continue: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# ── Restore database (maintenance DB 'postgres' for terminate/drop/create) ─────
echo "[restore] terminating active connections to '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PGDB' AND pid <> pg_backend_pid();" >/dev/null

echo "[restore] recreating database '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$PGDB\";" >/dev/null
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "CREATE DATABASE \"$PGDB\";" >/dev/null

echo "[restore] restoring database from $(basename "$DUMP_FILE")..."
"${COMPOSE[@]}" exec -T postgres \
  pg_restore -U "$PGUSER" --clean --if-exists --no-owner --no-acl -d "$PGDB" \
  < "$DUMP_FILE"

# ── Restore file data ──────────────────────────────────────────────────────────
for d in "${FILE_DIRS[@]}"; do
  if [[ -e "$MODE_ROOT/$d" ]]; then
    rm -rf "${MODE_ROOT:?}/$d"
  fi
  cp -a "$STAGING/$d" "$MODE_ROOT/$d"
done

for d in config; do
  [[ -d "$MODE_ROOT/$d" ]] && chmod 700 "$MODE_ROOT/$d"
done

echo "[restore] complete."
echo "[restore] resume the app, then verify the restored instance:"
echo "          ops/scripts/start.sh --$MODE"
case "$MODE" in
  dev)
    echo "          ops/scripts/system/verify-restore.sh --mode dev"
    echo "          # API health URL: http://localhost:3000/api/v1/server/health"
    ;;
  test)
    echo "          ops/scripts/system/verify-restore.sh --mode test"
    echo "          # API health URL: http://localhost:3100/api/v1/server/health"
    ;;
  prod)
    echo "          ops/scripts/system/verify-restore.sh --mode prod --api-base-url <production-api-url>"
    ;;
esac
