#!/usr/bin/env bash
# Run server migrations against the PostgreSQL database.
#
# Two execution modes:
#
#   docker (default) — ensure the target database exists, then run the compiled
#     server migration runner inside a one-shot server container, using the
#     in-network `postgres` host. This is the reliable path for the default
#     Docker Compose setup, where Postgres is NOT published to the host.
#
#   host (--host)    — run the same server migration runner on the host against an
#     explicitly configured, reachable external PostgreSQL. Requires DATABASE_URL
#     (or a complete set of POSTGRES_* with POSTGRES_HOST).
#
# Pre-migration backup safety:
#   For --mode prod a pre-migration pg_dump custom-format backup is REQUIRED and
#   is taken before migrations run, written to:
#       $ASPACE_ROOT/<mode>/db/dumps/pre-migrate-<timestamp>.dump
#   If that dump fails, migration aborts before the schema is touched.
#   Non-prod modes skip it for convenience; opt in with PRE_MIGRATION_BACKUP=1
#   or the --pre-migration-backup flag to get the identical safety net.
#
# PostgreSQL is the server database. Drizzle owns schema authoring through
# server/src/db/schema/; generated server migrations own schema creation and
# migration. This helper runs the no-write Drizzle schema check before database
# bootstrap. Server startup does not mutate schema files or auto-migrate from
# the long-running server process.
#
# Credentials are never printed — the target is shown with credentials redacted.
#
# Usage:
#   ops/scripts/db/migrate.sh [--mode dev|test|prod]            # docker-native (default)
#   ops/scripts/db/migrate.sh --host [--mode dev|test|prod]     # host mode, external Postgres
#   ops/scripts/db/migrate.sh --mode dev --pre-migration-backup # opt into pre-migration dump
#   DATABASE_URL=postgresql://... ops/scripts/db/migrate.sh --host

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${AGENT_SPACE_MODE:-dev}"
RUN_MODE="docker"
PRE_MIGRATION_BACKUP="${PRE_MIGRATION_BACKUP:-0}"

# ── Argument parsing (before computing mode-dependent paths) ───────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --host) RUN_MODE="host"; shift ;;
    --docker) RUN_MODE="docker"; shift ;;
    --pre-migration-backup) PRE_MIGRATION_BACKUP="1"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"
local_compose_ensure_mode_env_file
local_compose_ensure_server_database_env
local_compose_generate_server_env
trap 'local_compose_stop_postgres_if_started "migrate"' EXIT

redacted_target() {
  # Show only host:port/db — never user:pass.
  local safe="${1#*://}"   # drop scheme://
  safe="${safe##*@}"       # drop user:pass@, keep host:port/db
  echo "postgresql://[credentials-redacted]@${safe}"
}

urlencode() {
  python3 -c 'from urllib.parse import quote; import sys; print(quote(sys.argv[1], safe=""))' "$1"
}

postgres_password_or_default() {
  local pgpass
  pgpass="$(local_compose_setting POSTGRES_PASSWORD || true)"
  if [[ -n "$pgpass" ]]; then
    printf '%s\n' "$pgpass"
    return 0
  fi
  if [[ "$MODE" == "prod" ]]; then
    echo "ERROR: POSTGRES_PASSWORD is required for production migrations." >&2
    exit 1
  fi
  printf '%s\n' "agent_space_dev_password"
}

compose_admin_database_url() {
  local pguser pgpass pgdb
  pguser="$(local_compose_setting_or_default POSTGRES_USER agent_space)"
  pgpass="$(postgres_password_or_default)"
  pgdb="$(local_compose_setting_or_default POSTGRES_DB agent_space)"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$pguser"
  local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"
  printf 'postgresql://%s:%s@postgres:5432/%s\n' \
    "$(urlencode "$pguser")" "$(urlencode "$pgpass")" "$pgdb"
}

ensure_docker_database_exists() {
  local pguser pgdb exists
  pguser="$(local_compose_setting_or_default POSTGRES_USER agent_space)"
  pgdb="$(local_compose_setting_or_default POSTGRES_DB agent_space)"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$pguser"
  local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"

  local_compose_ensure_postgres_ready "migration database bootstrap" "$pguser" "postgres" 60
  exists="$(
    "${COMPOSE[@]}" exec -T postgres psql -X -q -U "$pguser" -d postgres \
      -v ON_ERROR_STOP=1 \
      -tAc "SELECT 1 FROM pg_database WHERE datname = '$pgdb';" |
      tr -d '[:space:]'
  )"
  if [[ "$exists" == "1" ]]; then
    return 0
  fi

  echo "[migrate] database '$pgdb' does not exist; creating it before migrations..."
  "${COMPOSE[@]}" exec -T postgres psql -X -q -U "$pguser" -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$pgdb\";"
}

run_drizzle_schema_check_docker() {
  if [[ "$MODE" == "prod" ]]; then
    echo "[migrate] Drizzle schema check is enforced during production server image build."
    return 0
  fi

  echo "[migrate] checking Drizzle schema artifacts before database bootstrap..."
  "${COMPOSE[@]}" run --rm -T --no-deps \
    -v "$REPO_ROOT/server/src:/app/server/src:ro" \
    -v "$REPO_ROOT/server/drizzle:/app/server/drizzle:ro" \
    -v "$REPO_ROOT/server/migrations:/app/server/migrations:ro" \
    -v "$REPO_ROOT/server/drizzle.config.ts:/app/server/drizzle.config.ts:ro" \
    -v "$REPO_ROOT/server/scripts:/app/server/scripts:ro" \
    server pnpm run schema:check
}

run_drizzle_schema_check_host() {
  echo "[migrate] checking Drizzle schema artifacts before database bootstrap..."
  cd "$REPO_ROOT/server"
  pnpm run schema:check
}

# Resolve a host-mode DATABASE_URL (env, mode .env, or POSTGRES_* parts). Sets the
# global MIGRATION_DATABASE_URL or exits with a clear error. Never prints credentials.
resolve_host_database_url() {
  local database_url="${DATABASE_URL:-}"
  if [[ -z "$database_url" ]]; then
    database_url="$(local_compose_env_value DATABASE_URL || true)"
  fi
  if [[ -z "$database_url" ]]; then
    local pguser pgpass pgdb pghost pgport
    pguser="$(local_compose_setting POSTGRES_USER || true)"
    pgpass="$(local_compose_setting POSTGRES_PASSWORD || true)"
    pgdb="$(local_compose_setting POSTGRES_DB || true)"
    if [[ -n "$pguser" && -n "$pgpass" && -n "$pgdb" ]]; then
      pghost="$(local_compose_setting_or_default POSTGRES_HOST localhost)"
      pgport="$(local_compose_setting_or_default POSTGRES_PORT 5432)"
      local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"
      database_url="postgresql://$(urlencode "$pguser"):$(urlencode "$pgpass")@${pghost}:${pgport}/${pgdb}"
    fi
  fi
  if [[ -z "$database_url" ]]; then
    echo "ERROR: host mode requires a reachable external Postgres." >&2
    echo "       Set DATABASE_URL, or provide $ENV_FILE with POSTGRES_USER/PASSWORD/DB (+ POSTGRES_HOST)." >&2
    exit 1
  fi
  # Existing mode env files may still carry the old SQLAlchemy-style scheme.
  database_url="${database_url/#postgresql+psycopg:/postgresql:}"
  case "$database_url" in
    postgresql://*|postgres://*) ;;
    *)
      echo "ERROR: host mode DATABASE_URL must be a PostgreSQL connection string." >&2
      exit 1
      ;;
  esac
  export MIGRATION_DATABASE_URL="$database_url"
}

# ── Pre-migration backup (custom-format pg_dump) ──────────────────────────────
pre_migration_backup_docker() {
  local out="$1"
  local pgdb pguser
  pgdb="$(local_compose_setting_or_default POSTGRES_DB agent_space)"
  pguser="$(local_compose_setting_or_default POSTGRES_USER agent_space)"
  local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$pguser"

  # Ensure postgres is up so it can be dumped before any schema change.
  if ! local_compose_ensure_postgres_ready "migration" "$pguser"; then
    return 1
  fi
  "${COMPOSE[@]}" exec -T postgres \
    pg_dump -U "$pguser" -Fc --no-owner --no-acl "$pgdb" > "$out"
}

pre_migration_backup_host() {
  local out="$1"
  resolve_host_database_url
  pg_dump -Fc --no-owner --no-acl "$MIGRATION_DATABASE_URL" > "$out"
}

ensure_pre_migration_backup() {
  local dumps_dir="$MODE_ROOT/db/dumps"
  install -d -m 700 "$dumps_dir"
  local ts dump_path
  ts="$(date -u +%Y%m%d-%H%M%S)"
  dump_path="$dumps_dir/pre-migrate-$ts.dump"

  echo "[migrate] taking required pre-migration backup before server migrations (mode: $MODE)..."
  if [[ "$RUN_MODE" == "host" ]]; then
    pre_migration_backup_host "$dump_path" || true
  else
    pre_migration_backup_docker "$dump_path" || true
  fi

  if [[ ! -s "$dump_path" ]]; then
    echo "ERROR: pre-migration backup failed or produced an empty dump." >&2
    echo "       Aborting BEFORE migrations run so the database is never migrated unprotected." >&2
    rm -f "$dump_path"
    exit 1
  fi
  chmod 600 "$dump_path"
  echo "[migrate] pre-migration backup written: $dump_path ($(du -sh "$dump_path" | cut -f1))"
}

# ── Docker-native path (default) ──────────────────────────────────────────────
run_docker() {
  echo "Checking/applying generated server migrations in a one-shot migration container (mode: $MODE)..."
  echo "  target: in-network postgres service (generated from POSTGRES_*)"

  local pguser pgdb database_url
  pguser="$(local_compose_setting_or_default POSTGRES_USER agent_space)"
  pgdb="$(local_compose_setting_or_default POSTGRES_DB agent_space)"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$pguser"
  local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"
  local_compose_ensure_postgres_ready "migration" "$pguser" "$pgdb"
  database_url="$(compose_admin_database_url)"

  "${COMPOSE[@]}" run --rm -T --no-deps \
    -e SERVER_DATABASE_URL="$database_url" \
    -e SERVER_MIGRATIONS_DIR=/app/server/migrations \
    server node dist/db/migrateCli.js up
  echo "Migrations complete."
}

# ── Host path (explicit external Postgres only) ───────────────────────────────
run_host() {
  resolve_host_database_url

  echo "Checking/applying generated server migrations on host (mode: $MODE)..."
  echo "  target: $(redacted_target "$MIGRATION_DATABASE_URL")"

  cd "$REPO_ROOT/server"
  SERVER_DATABASE_URL="$MIGRATION_DATABASE_URL" \
    SERVER_MIGRATIONS_DIR="$REPO_ROOT/server/migrations" \
    pnpm run migrate
  echo "Migrations complete."
}

# ── Target database bootstrap + pre-migration backup gate ─────────────────────
if [[ "$RUN_MODE" == "docker" ]]; then
  run_drizzle_schema_check_docker
  ensure_docker_database_exists
else
  run_drizzle_schema_check_host
fi

# prod always requires it; other modes only when explicitly opted in.
if [[ "$MODE" == "prod" || "$PRE_MIGRATION_BACKUP" == "1" ]]; then
  ensure_pre_migration_backup
else
  echo "[migrate] pre-migration backup skipped (mode: $MODE)."
  echo "          Opt in with PRE_MIGRATION_BACKUP=1 or --pre-migration-backup."
fi

if [[ "$RUN_MODE" == "host" ]]; then
  run_host
else
  run_docker
fi
