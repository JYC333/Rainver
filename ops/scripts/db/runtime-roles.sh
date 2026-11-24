#!/usr/bin/env bash
# Least-privilege runtime database roles (ADR 0031). Explicit operator command;
# nothing here runs on start, deploy or update.
#
# Usage:
#   ./ops/scripts/db/runtime-roles.sh plan     [--mode dev|test|prod]
#   ./ops/scripts/db/runtime-roles.sh apply    [--mode ...] --yes
#   ./ops/scripts/db/runtime-roles.sh activate [--mode ...] --yes
#   ./ops/scripts/db/runtime-roles.sh rollback [--mode ...] --yes
#
# plan      Read-only: connected identity and the app/backup role state (no secrets).
# apply     Owner channel: create or repair `rainver_app` / `rainver_backup`, their
#           grants and plugin SET memberships; generates and stores their
#           passwords in the instance .env when absent. Services may keep running:
#           the server still uses the owner URL until `activate`.
# activate  Writes SERVER_DATABASE_URL / BACKUP_DATABASE_URL for the new roles and
#           RAINVER_DB_REQUIRE_RUNTIME_ROLE=1, keeping the previous URLs for rollback.
#           Requires stopped application services; restart with start.sh afterwards.
# rollback  Restores the saved owner URLs and clears the requirement. Roles stay
#           (they own nothing); dropping them is a separate manual step.
#
# Take a backup first (ops/scripts/system/backup.sh). Migrations, plugin
# install/reconcile and restore always keep using the owner channel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
COMMAND=""
YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    plan|apply|activate|rollback) COMMAND="$1"; shift ;;
    --mode) MODE="$2"; shift 2 ;;
    --yes) YES=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$COMMAND" ]] || { echo "Usage: $0 plan|apply|activate|rollback [--mode dev|test|prod] [--yes]" >&2; exit 1; }
local_compose_init "$MODE"
local_compose_lock_instance "managing the database roles"

APP_ROLE="$(local_compose_setting_or_default RAINVER_DB_APP_ROLE rainver_app)"
BACKUP_ROLE="$(local_compose_setting_or_default RAINVER_DB_BACKUP_ROLE rainver_backup)"
PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
local_compose_validate_pg_identifier "RAINVER_DB_APP_ROLE" "$APP_ROLE"
local_compose_validate_pg_identifier "RAINVER_DB_BACKUP_ROLE" "$BACKUP_ROLE"
local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"

# Every secret reaches the one-off owner container by inherited name (`-e NAME`), never as
# `NAME=value` on the docker argv; the owner URL is never written to the server's environment.
owner_cli() {
  local command=(run --rm -T --no-deps)
  [[ "$MODE" != prod ]] || command+=(--pull never)
  local_compose_prepare_prod_server_image || return
  SERVER_DATABASE_URL="$(local_compose_server_owner_database_url)" \
  RAINVER_DB_APP_ROLE="$APP_ROLE" RAINVER_DB_BACKUP_ROLE="$BACKUP_ROLE" \
    "${COMPOSE[@]}" "${command[@]}" \
    -e SERVER_DATABASE_URL -e RAINVER_DB_APP_ROLE -e RAINVER_DB_BACKUP_ROLE \
    "$@"
}
require_yes() { $YES || { echo "Refusing to $COMMAND without --yes (see --help)." >&2; exit 1; }; }
role_url() {
  printf 'postgresql://%s:%s@postgres:5432/%s\n' "$1" "$(local_compose_urlencode "$2")" "$PGDB"
}

case "$COMMAND" in
  plan)
    owner_cli server node dist/db/migrateCli.js runtime-roles-plan
    echo "server URL role: $(local_compose_setting SERVER_DATABASE_URL | sed -E 's#^postgres(ql)?://([^:@]+).*#\2#')"
    echo "runtime role required at start: $(local_compose_setting RAINVER_DB_REQUIRE_RUNTIME_ROLE || echo 0)"
    ;;
  apply)
    require_yes
    local_compose_ensure_env_secret RAINVER_DB_APP_PASSWORD 32
    local_compose_ensure_env_secret RAINVER_DB_BACKUP_PASSWORD 32
    # Passwords travel by inherited environment (never argv); the CLI sends SCRAM verifiers, never plaintext.
    RAINVER_DB_APP_PASSWORD="$(local_compose_setting RAINVER_DB_APP_PASSWORD)" \
    RAINVER_DB_BACKUP_PASSWORD="$(local_compose_setting RAINVER_DB_BACKUP_PASSWORD)" \
      owner_cli -e RAINVER_DB_APP_PASSWORD -e RAINVER_DB_BACKUP_PASSWORD \
      server node dist/db/migrateCli.js runtime-roles-reconcile
    ;;
  activate)
    require_yes
    local_compose_require_stopped_applications "database role $COMMAND"
    [[ -n "$(local_compose_setting RAINVER_DB_APP_PASSWORD || true)" ]] || { echo "Run apply first." >&2; exit 1; }
    if [[ "$(local_compose_setting RAINVER_DB_REQUIRE_RUNTIME_ROLE || true)" != "1" ]]; then
      local_compose_set_env_value RAINVER_DB_OWNER_SERVER_DATABASE_URL "$(local_compose_setting SERVER_DATABASE_URL || local_compose_server_owner_database_url)"
      local_compose_set_env_value RAINVER_DB_OWNER_BACKUP_DATABASE_URL "$(local_compose_setting BACKUP_DATABASE_URL || true)"
    fi
    local_compose_set_env_value SERVER_DATABASE_URL "$(role_url "$APP_ROLE" "$(local_compose_setting RAINVER_DB_APP_PASSWORD)")"
    local_compose_set_env_value BACKUP_DATABASE_URL "$(role_url "$BACKUP_ROLE" "$(local_compose_setting RAINVER_DB_BACKUP_PASSWORD)")"
    local_compose_set_env_value RAINVER_DB_REQUIRE_RUNTIME_ROLE 1
    local_compose_generate_server_env
    echo "Activated. Start with ops/scripts/start.sh --$MODE; the server refuses to start unless it connects as $APP_ROLE."
    ;;
  rollback)
    require_yes
    local_compose_require_stopped_applications "database role $COMMAND"
    local_compose_set_env_value RAINVER_DB_REQUIRE_RUNTIME_ROLE 0
    local_compose_set_env_value SERVER_DATABASE_URL "$(local_compose_setting RAINVER_DB_OWNER_SERVER_DATABASE_URL || local_compose_server_owner_database_url)"
    local_compose_set_env_value BACKUP_DATABASE_URL "$(local_compose_setting RAINVER_DB_OWNER_BACKUP_DATABASE_URL || true)"
    local_compose_generate_server_env
    echo "Rolled back to the owner URL. Roles $APP_ROLE/$BACKUP_ROLE remain and own nothing."
    ;;
esac
