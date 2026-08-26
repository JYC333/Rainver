#!/usr/bin/env bash
# Verify a restored PostgreSQL-backed instance and artifact files.
#
# Usage:
#   ops/scripts/system/verify-restore.sh [--mode dev|test|prod]
#
# This verifies restore integrity through database/schema and artifact-file
# checks. It does not check HTTP liveness.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"

if [[ ! -d "$MODE_ROOT" ]]; then
  echo "ERROR: mode root not found: $MODE_ROOT" >&2
  exit 1
fi

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

failures=0

record_failure() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

fatal() {
  echo "ERROR: $*" >&2
  exit 1
}

DB_URI=""
DATABASE_URL_VALUE="$(local_compose_setting DATABASE_URL || true)"
if [[ -n "$DATABASE_URL_VALUE" ]]; then
  # Existing mode env files may still carry the old SQLAlchemy-style scheme.
  DB_URI="${DATABASE_URL_VALUE/#postgresql+psycopg:\/\//postgresql:\/\/}"
  if [[ "$DB_URI" != postgresql://* ]]; then
    fatal "DATABASE_URL must be a PostgreSQL connection string"
  fi
fi

psql_query() {
  local sql="$1"
  if [[ -n "$DB_URI" ]]; then
    "${COMPOSE[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 "$DB_URI" -Atc "$sql"
  else
    "${COMPOSE[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -Atc "$sql"
  fi
}

path_has_traversal() {
  local normalized="$1"
  local part
  normalized="${normalized//\\//}"
  IFS='/' read -r -a parts <<< "$normalized"
  for part in "${parts[@]}"; do
    if [[ "$part" == ".." ]]; then
      return 0
    fi
  done
  return 1
}

echo "[verify] mode:      $MODE"
echo "[verify] mode root: $MODE_ROOT"
if [[ -n "$DB_URI" ]]; then
  echo "[verify] database:  DATABASE_URL from env (redacted)"
else
  echo "[verify] database:  compose postgres service database '$PGDB'"
fi

trap 'local_compose_stop_postgres_if_started "verify"' EXIT

if ! local_compose_ensure_postgres_ready "verify" "$PGUSER"; then
  fatal "postgres service is not ready for mode '$MODE'"
fi
echo "[verify] postgres service: ready"

if ! migration_table_exists="$(psql_query "SELECT to_regclass('public.server_schema_migrations') IS NOT NULL;")"; then
  fatal "failed to query server_schema_migrations"
fi
if [[ "$migration_table_exists" != "t" ]]; then
  fatal "server_schema_migrations table is missing"
fi
if ! migration_versions="$(psql_query "SELECT version FROM server_schema_migrations ORDER BY version;")"; then
  fatal "failed to read server_schema_migrations.version"
fi
if [[ -z "$migration_versions" ]]; then
  fatal "server_schema_migrations has no version rows"
fi
echo "[verify] schema migrations: $(echo "$migration_versions" | paste -sd ',' -)"

for table in spaces users runs proposals artifacts activity_records; do
  if ! exists="$(psql_query "SELECT to_regclass('public.$table') IS NOT NULL;")"; then
    record_failure "failed to check table: $table"
    continue
  fi
  if [[ "$exists" != "t" ]]; then
    record_failure "missing table: $table"
    continue
  fi
  if ! count="$(psql_query "SELECT count(*) FROM \"$table\";")"; then
    record_failure "failed to count table: $table"
    continue
  fi
  echo "[verify] table $table: $count rows"
done

if ! artifact_paths="$(psql_query "SELECT storage_path FROM artifacts WHERE storage_path IS NOT NULL AND btrim(storage_path) <> '' ORDER BY id;")"; then
  fatal "failed to query artifact storage paths"
fi

artifact_count=0
invalid_paths=0
missing_files=0
artifact_root="$MODE_ROOT/storage/artifacts"

while IFS= read -r storage_path; do
  [[ -n "$storage_path" ]] || continue
  artifact_count=$((artifact_count + 1))

  if [[ "$storage_path" = /* ]] || path_has_traversal "$storage_path"; then
    echo "ERROR: invalid artifact storage_path: $storage_path" >&2
    invalid_paths=$((invalid_paths + 1))
    continue
  fi

  if [[ ! -f "$artifact_root/$storage_path" ]]; then
    echo "ERROR: missing artifact file: storage/artifacts/$storage_path" >&2
    missing_files=$((missing_files + 1))
  fi
done <<< "$artifact_paths"

if (( invalid_paths > 0 )); then
  failures=$((failures + invalid_paths))
fi
if (( missing_files > 0 )); then
  failures=$((failures + missing_files))
fi
echo "[verify] artifact file refs: $artifact_count checked, $invalid_paths invalid, $missing_files missing"

if (( failures > 0 )); then
  echo "[verify] FAILED ($failures issue(s))." >&2
  exit 1
fi

echo "[verify] ok"
