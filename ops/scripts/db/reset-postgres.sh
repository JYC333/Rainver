#!/usr/bin/env bash
# Drop the PostgreSQL database, optionally restore the private dev setup
# baseline, then run server migrations.
# WARNING: This destroys ALL data in the target database.
#
# Usage (Docker Compose dev environment):
#   ./ops/scripts/db/reset-postgres.sh [--mode dev|test|prod] [--force-running] [--no-dev-setup]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
FORCE_RUNNING=false
USE_DEV_SETUP=true

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="$2"; shift 2 ;;
    --force-running) FORCE_RUNNING=true; shift ;;
    --no-dev-setup)  USE_DEV_SETUP=false; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,2\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"
local_compose_ensure_mode_env_file
local_compose_ensure_server_database_env
local_compose_generate_server_env

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"
DEV_SETUP_DUMP="$MODE_ROOT/setup/database.dump"

# Validate identifiers — only allow alphanumeric + underscore to prevent injection
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
    echo "WARNING: app service(s) still running during DB reset: ${running[*]}" >&2
    return 0
  fi

  echo "ERROR: app service(s) still running for mode '$MODE': ${running[*]}" >&2
  echo "       Stop app services first; reset will manage postgres as needed." >&2
  echo "       $COMPOSE_HINT stop frontend server deployer" >&2
  exit 1
}

trap 'local_compose_stop_postgres_if_started "reset"' EXIT

require_app_services_stopped frontend server deployer

restore_dev_setup=false
if [[ "$MODE" == "dev" && "$USE_DEV_SETUP" == "true" && -f "$DEV_SETUP_DUMP" ]]; then
  restore_dev_setup=true
fi

echo "WARNING: This will destroy ALL data in '$PGDB' (mode: $MODE)."
if [[ "$restore_dev_setup" == "true" ]]; then
  echo "After the drop, the database will be migrated to the current schema, then data from the"
  echo "private dev setup baseline will be imported into it:"
  echo "  $DEV_SETUP_DUMP"
elif [[ "$MODE" == "dev" && "$USE_DEV_SETUP" == "true" ]]; then
  echo "No private dev setup baseline exists; the reset will create an empty migrated database."
  echo "Create one first with: ops/scripts/db/save-dev-setup.sh"
fi
read -r -p "Type 'yes' to continue: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

if ! local_compose_ensure_postgres_ready "reset" "$PGUSER"; then
  exit 1
fi

if [[ "$restore_dev_setup" == "true" ]] &&
   ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DEV_SETUP_DUMP" >/dev/null 2>&1; then
  echo "ERROR: dev setup baseline is not a readable pg_restore custom-format archive:" >&2
  echo "       $DEV_SETUP_DUMP" >&2
  exit 1
fi

echo "Terminating active connections to '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PGDB' AND pid <> pg_backend_pid();"

echo "Dropping database '$PGDB'..."
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$PGDB\";"

echo "Running server migrations (Docker-native, inside a one-shot server container)..."
# Rebuild the schema fresh from the current migration baseline first, always —
# restoring the dev setup archive's OWN (possibly older) schema and then
# migrating on top of it, as this used to do, fails under this repo's
# single-baseline-squash model as soon as the baseline SQL changes after the
# archive was saved (the archive's tracking row still records the OLD
# checksum for what is now an immutable but different applied migration).
# Migrating first means the reset database is always on the current schema.
if ! "$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE"; then
  echo "ERROR: database was dropped but server migration FAILED." >&2
  echo "       The database may now be missing or EMPTY and unmigrated. Re-run:" >&2
  echo "       ops/scripts/db/migrate.sh --mode $MODE" >&2
  exit 1
fi

if [[ "$restore_dev_setup" == "true" ]]; then
  echo "Importing data from the private dev setup baseline into the current schema..."
  # Data-only, not the archive's own schema — reimports rows into the tables
  # migrate.sh just created. pg_restore does not abort on a per-statement
  # error (a table/column dropped or changed since the archive was saved); it
  # reports and continues, so this is a best-effort import, not a hard gate.
  if ! "${COMPOSE[@]}" exec -T postgres \
    pg_restore -U "$PGUSER" --data-only --disable-triggers --no-owner --no-acl -d "$PGDB" \
    < "$DEV_SETUP_DUMP"; then
    echo "WARNING: some rows from the dev setup baseline could not be imported into the current" >&2
    echo "         schema (expected when a table/column changed since it was saved). Once the" >&2
    echo "         database looks right, refresh the baseline with:" >&2
    echo "         ops/scripts/db/save-dev-setup.sh" >&2
  fi
  echo "Database reset complete; migrated to the current schema and imported data from the saved baseline."
else
  echo "Database reset complete."
fi
