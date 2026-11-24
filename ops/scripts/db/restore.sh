#!/usr/bin/env bash
# Restore the PostgreSQL database from a pg_dump custom-format archive.
#
# Restores and validates a separate database before switching it in.
# The previous database is kept under a separate name with connections disabled.
#
# Usage:
#   ./ops/scripts/db/restore.sh /path/to/dump.dump [--mode dev|test|prod] [--force-running]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"
source "$SCRIPT_DIR/../lib/restore-database.sh"

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
restore_database_check_target

local_compose_lock_instance "restoring the database"
trap 'restore_database_cleanup; local_compose_stop_postgres_if_started "restore"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

local_compose_require_stopped_applications "DB restore" "$FORCE_RUNNING"

if ! local_compose_ensure_postgres_ready "restore" "$PGUSER"; then
  exit 1
fi

if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DUMP_FILE" >/dev/null 2>&1; then
  echo "ERROR: dump file is not a readable pg_restore custom-format archive" >&2
  exit 1
fi
local_compose_prepare_prod_server_image
local_compose_restore_preflight "$PGDB" >/dev/null

echo "WARNING: This will replace the active database '$PGDB' (mode: $MODE)."
read -r -p "Type 'yes' to continue: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

local_compose_require_stopped_applications "DB restore" "$FORCE_RUNNING"
restore_database "$DUMP_FILE" "DB restore" "$FORCE_RUNNING"

echo "Restore complete."
