#!/usr/bin/env bash
# Restore the PostgreSQL database from a pg_dump custom-format archive.
#
# Drops the target database, recreates it, then runs pg_restore.
# Terminates active connections before drop so the operation never blocks.
#
# Usage:
#   ./ops/scripts/db/restore.sh /path/to/dump.dump [--mode dev|test|prod] [--force-running]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"

# ── Argument parsing ──────────────────────────────────────────────────────────
DUMP_FILE=""
FORCE_RUNNING=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="$2"; shift 2 ;;
    --force-running) FORCE_RUNNING=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$DUMP_FILE" ]]; then DUMP_FILE="$1"; else
        echo "Unexpected argument: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

local_compose_init "$MODE"

if [[ -z "$DUMP_FILE" ]]; then
  echo "Usage: $0 <dump-file.dump> [--mode dev|test|prod] [--force-running]" >&2
  exit 1
fi
if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Error: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

# Validate identifiers
local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

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
    echo "WARNING: app service(s) still running during DB restore: ${running[*]}" >&2
    return 0
  fi

  echo "ERROR: app service(s) still running for mode '$MODE': ${running[*]}" >&2
  echo "       Stop app services first; restore will manage postgres as needed." >&2
  echo "       $COMPOSE_HINT stop frontend server deployer" >&2
  exit 1
}

trap 'local_compose_stop_postgres_if_started "restore"' EXIT

require_app_services_stopped frontend server deployer

if ! local_compose_ensure_postgres_ready "restore" "$PGUSER"; then
  exit 1
fi

if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DUMP_FILE" >/dev/null 2>&1; then
  echo "ERROR: dump file is not a readable pg_restore custom-format archive" >&2
  exit 1
fi

echo "WARNING: This will overwrite all data in '$PGDB' (mode: $MODE)."
read -r -p "Type 'yes' to continue: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo "Terminating active connections to '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PGDB' AND pid <> pg_backend_pid();"

echo "Dropping database '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$PGDB\";"

echo "Creating database '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "CREATE DATABASE \"$PGDB\";"

echo "Restoring '$PGDB' from: $DUMP_FILE"
# --clean       — drop objects before recreating (safe with fresh DB; harmless here)
# --if-exists   — suppress errors if object doesn't exist when dropping
# --no-owner    — restore without setting ownership (avoids role requirement)
# --no-acl      — skip GRANT/REVOKE statements
"${COMPOSE[@]}" exec -T postgres \
  pg_restore -U "$PGUSER" --clean --if-exists --no-owner --no-acl -d "$PGDB" \
  < "$DUMP_FILE"
echo "Restore complete."
