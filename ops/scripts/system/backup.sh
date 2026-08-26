#!/usr/bin/env bash
# Full-system backup (offline equivalent of BackupService).
#
# Produces the same archive format as the in-process BackupService:
#   db/rainver.dump   PostgreSQL snapshot (pg_dump custom format)
#   storage/ artifacts/ config/ workspaces/   non-credential file data
#   logs/                 only with --include-logs
#   backup_manifest.json  archive metadata
#
# The live PostgreSQL data directory (db/postgres) is never archived — the
# database is captured as a logical pg_dump snapshot instead. Restore with
# ops/scripts/system/restore.sh.
#
# Use this when app services are stopped; the script starts PostgreSQL if needed
# and stops it afterward only when it started it. When the server is
# running, the scheduled BackupService (or POST /api/v1/system/backups/manual)
# is canonical.
#
# Usage:
#   ops/scripts/system/backup.sh [--mode dev|test|prod] [--output DIR] [--include-logs] [--force-running]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
OUTPUT_DIR=""
INCLUDE_LOGS=false
FORCE_RUNNING=false

# ── Argument parsing (before computing mode-dependent paths) ───────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)         MODE="$2"; shift 2 ;;
    --output)       OUTPUT_DIR="$2"; shift 2 ;;
    --include-logs) INCLUDE_LOGS=true; shift ;;
    --force-running) FORCE_RUNNING=true; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"

if [[ ! -d "$MODE_ROOT" ]]; then
  echo "ERROR: data root not found: $MODE_ROOT" >&2
  exit 1
fi

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

# Backup policy values recorded in the manifest (same fields as BackupService).
BACKUP_INTERVAL_HOURS="$(local_compose_setting_or_default BACKUP_INTERVAL_HOURS 24)"
BACKUP_RETENTION_COUNT="$(local_compose_setting_or_default BACKUP_RETENTION_COUNT 7)"

if [[ ! "$BACKUP_INTERVAL_HOURS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: BACKUP_INTERVAL_HOURS must be a non-negative integer" >&2; exit 1
fi
if [[ ! "$BACKUP_RETENTION_COUNT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: BACKUP_RETENTION_COUNT must be a non-negative integer" >&2; exit 1
fi

require_app_services_stopped() {
  local running_services=""
  local running=()
  local service

  if ! running_services="$("${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null)"; then
    echo "ERROR: unable to inspect running compose services for mode '$MODE'" >&2
    exit 1
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
    echo "WARNING: app service(s) still running during offline full-system backup: ${running[*]}" >&2
    echo "WARNING: database and file snapshots may be inconsistent." >&2
    return 0
  fi

  echo "ERROR: app service(s) still running for mode '$MODE': ${running[*]}" >&2
  echo "       Stop app services first; backup will manage postgres as needed." >&2
  echo "       $COMPOSE_HINT stop frontend server deployer" >&2
  exit 1
}

require_app_services_stopped frontend server deployer

STAGING=""
ARCHIVE_TMP=""
VERIFY_STAGING=""
trap 'local_compose_stop_postgres_if_started "backup"; [[ -z "$STAGING" ]] || rm -rf "$STAGING"; [[ -z "$VERIFY_STAGING" ]] || rm -rf "$VERIFY_STAGING"; [[ -z "$ARCHIVE_TMP" ]] || rm -f "$ARCHIVE_TMP"' EXIT

if ! local_compose_ensure_postgres_ready "backup" "$PGUSER"; then
  exit 1
fi

[[ -z "$OUTPUT_DIR" ]] && OUTPUT_DIR="$MODE_ROOT/backups"
install -d -m 700 "$OUTPUT_DIR"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE_PATH="$OUTPUT_DIR/system-$TIMESTAMP.tar.gz"
ARCHIVE_TMP="$(mktemp "$OUTPUT_DIR/.system-$TIMESTAMP-XXXXXX.tmp")"
chmod 600 "$ARCHIVE_TMP"

STAGING="$(mktemp -d -t rainver-system-backup-XXXXXX)"

echo "[backup] mode:    $MODE"
echo "[backup] output:  $ARCHIVE_PATH"

# ── PostgreSQL snapshot (custom format, no-owner, no-acl) ──────────────────────
echo "[backup] dumping database '$PGDB' (pg_dump custom format)..."
mkdir -p "$STAGING/db"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$PGUSER" -Fc --no-owner --no-acl "$PGDB" > "$STAGING/db/rainver.dump"

# ── File data (db/postgres, cache, sandboxes, backups are never archived) ──────
INCLUDED=("db/rainver.dump (pg_dump_custom)")
EXCLUDED=()
for d in storage artifacts config workspaces; do
  if [[ -d "$MODE_ROOT/$d" ]]; then
    cp -a "$MODE_ROOT/$d" "$STAGING/$d"
    INCLUDED+=("$d/")
  else
    EXCLUDED+=("$d/ (not found)")
  fi
done
if [[ "$INCLUDE_LOGS" == "true" && -d "$MODE_ROOT/logs" ]]; then
  cp -a "$MODE_ROOT/logs" "$STAGING/logs"
  INCLUDED+=("logs/")
else
  if [[ -d "$MODE_ROOT/logs" ]]; then
    EXCLUDED+=("logs/ (excluded by config (backup_include_logs=false))")
  else
    EXCLUDED+=("logs/ (not found)")
  fi
fi

EXCLUDED+=(
  "backups/ (recursion prevention)"
  "cache/ (ephemeral)"
  "sandboxes/ (ephemeral)"
  "db/postgres/ (live PostgreSQL data)"
  "secrets/ (credential material; use ops/scripts/system/backup-credentials.sh)"
)

# ── Version metadata (best-effort; recorded for restore compatibility checks) ──
# Each value is best-effort and may be empty; gathering it never aborts a backup.
MANIFEST_APP_VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$REPO_ROOT/server/package.json" 2>/dev/null | head -1 | grep -oE '"[^"]+"$' | tr -d '"' || true)"
MANIFEST_GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
MANIFEST_PG_SERVER_VERSION="$("${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]' || true)"
MANIFEST_SCHEMA_MIGRATION_VERSION="$("${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -tAc 'SELECT version FROM server_schema_migrations ORDER BY version DESC LIMIT 1' 2>/dev/null | tr -d '[:space:]' || true)"
MANIFEST_SCHEMA_MIGRATION_CHECKSUM="$("${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -tAc 'SELECT checksum FROM server_schema_migrations ORDER BY version DESC LIMIT 1' 2>/dev/null | tr -d '[:space:]' || true)"
MANIFEST_PG_DUMP_VERSION="$("${COMPOSE[@]}" exec -T postgres \
  pg_dump --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)*' | head -1 || true)"

# ── Manifest (same schema as BackupService) ────────────────────────────────────
MANIFEST_APP_VERSION="$MANIFEST_APP_VERSION" \
MANIFEST_GIT_COMMIT="$MANIFEST_GIT_COMMIT" \
MANIFEST_PG_SERVER_VERSION="$MANIFEST_PG_SERVER_VERSION" \
MANIFEST_SCHEMA_MIGRATION_VERSION="$MANIFEST_SCHEMA_MIGRATION_VERSION" \
MANIFEST_SCHEMA_MIGRATION_CHECKSUM="$MANIFEST_SCHEMA_MIGRATION_CHECKSUM" \
MANIFEST_PG_DUMP_VERSION="$MANIFEST_PG_DUMP_VERSION" \
python3 - "$STAGING/backup_manifest.json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE_ROOT" \
  "$BACKUP_INTERVAL_HOURS" "$BACKUP_RETENTION_COUNT" \
  --included "${INCLUDED[@]}" --excluded "${EXCLUDED[@]}" <<'PY'
import json
import os
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
created_at = sys.argv[2]
source_root = sys.argv[3]
backup_interval_hours = int(sys.argv[4])
backup_retention_count = int(sys.argv[5])
included_marker = sys.argv.index("--included")
excluded_marker = sys.argv.index("--excluded")
included_paths = sys.argv[included_marker + 1:excluded_marker]
excluded_paths = sys.argv[excluded_marker + 1:]


def _opt(name):
    val = os.environ.get(name, "").strip()
    return val or None


manifest = {
    "backup_format": "rainver-backup.v1",
    "kind": "manual",
    "created_at": created_at,
    "source_root": source_root,
    "included_paths": included_paths,
    "excluded_paths": excluded_paths,
    "db_snapshot_method": "pg_dump_custom",
    "backup_interval_hours": backup_interval_hours,
    "backup_retention_count": backup_retention_count,
    "warnings": [],
    "app_version": _opt("MANIFEST_APP_VERSION"),
    "git_commit": _opt("MANIFEST_GIT_COMMIT"),
    "schema_migration_version": _opt("MANIFEST_SCHEMA_MIGRATION_VERSION"),
    "schema_migration_checksum": _opt("MANIFEST_SCHEMA_MIGRATION_CHECKSUM"),
    "postgres_server_version": _opt("MANIFEST_PG_SERVER_VERSION"),
    "pg_dump_version": _opt("MANIFEST_PG_DUMP_VERSION"),
}

with manifest_path.open("w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY
python3 -m json.tool "$STAGING/backup_manifest.json" >/dev/null

# ── Archive ────────────────────────────────────────────────────────────────────
tar -czf "$ARCHIVE_TMP" -C "$STAGING" .
tar -tzf "$ARCHIVE_TMP" >/dev/null
VERIFY_STAGING="$(mktemp -d -t rainver-system-backup-verify-XXXXXX)"
python3 "$SCRIPT_DIR/safe_extract.py" "$ARCHIVE_TMP" "$VERIFY_STAGING" \
  db storage artifacts config workspaces logs backup_manifest.json
rm -rf "$VERIFY_STAGING"
VERIFY_STAGING=""
ARCHIVE_PATH="$(python3 "$SCRIPT_DIR/atomic_ops.py" publish "$ARCHIVE_TMP" "$ARCHIVE_PATH")"
ARCHIVE_TMP=""

echo "[backup] done: $ARCHIVE_PATH ($(du -sh "$ARCHIVE_PATH" | cut -f1))"
echo "[backup] restore with: ops/scripts/system/restore.sh $ARCHIVE_PATH --mode $MODE"
