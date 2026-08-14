#!/usr/bin/env bash
# Start agent-space via Docker Compose (frontend + server + deployer).
#
# Usage:
#   ./ops/scripts/start.sh              — dev (default)
#   ./ops/scripts/start.sh --dev        — dev (web 3000, API via /api/v1)
#   ./ops/scripts/start.sh --test       — test (web 3100, API via /api/v1)
#   ./ops/scripts/start.sh --prod       — prod (web/nginx 80 proxies /api to internal server)
#   ./ops/scripts/start.sh --build      — same as above with image rebuild
#
# Data layout: $ASPACE_ROOT/<mode>/ (e.g. ~/.aspace/dev). Override the host-side
# parent directory with ASPACE_ROOT when you need a non-default location.
# AGENT_SPACE_HOME is NOT this parent: inside containers it is the mounted mode
# root (/aspace).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/local-compose.sh
source "$SCRIPT_DIR/lib/local-compose.sh"

SANDBOX_IMAGE="agent-space-sandbox"

MODE="${AGENT_SPACE_MODE:-dev}"
build_flag=""

for arg in "$@"; do
  case $arg in
    --dev)    MODE="dev" ;;
    --test)   MODE="test" ;;
    --prod)   MODE="prod" ;;
    --build)  build_flag="--build" ;;
    *) echo "Unknown argument: $arg" && exit 1 ;;
  esac
done

local_compose_init "$MODE"
ENV_TEMPLATE="$ENV_DIR/.env.$MODE.example"

# ── Initialize data root directories (idempotent) ──────────────────────────────
init_data_dirs() {
  echo "  → aspace root: $ASPACE_ROOT"
  echo "  → mode root:   $MODE_ROOT"

  install -d -m 700 "$ASPACE_ROOT"
  install -d -m 700 "$MODE_ROOT"
  install -d -m 700 "$MODE_ROOT/storage"
  install -d -m 700 "$MODE_ROOT/logs"
  install -d -m 700 "$MODE_ROOT/db"
  install -d -m 700 "$MODE_ROOT/db/postgres"
  install -d -m 700 "$MODE_ROOT/db/dumps"
  install -d -m 700 "$MODE_ROOT/secrets"
  install -d -m 700 "$MODE_ROOT/artifacts"
  install -d -m 700 "$MODE_ROOT/cache"
  install -d -m 700 "$MODE_ROOT/cache/runtime-homes"
  install -d -m 700 "$MODE_ROOT/cache/conversation-runtime-homes"
  install -d -m 700 "$MODE_ROOT/cache/login-homes"
  install -d -m 700 "$MODE_ROOT/run"
  install -d -m 700 "$MODE_ROOT/sandboxes"
  install -d -m 700 "$MODE_ROOT/workspaces"
  install -d -m 700 "$MODE_ROOT/runtime-tools"
}

# ── Ensure .env exists in mode root ───────────────────────────────────────────
ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_TEMPLATE" ]]; then
      echo "Missing env template: $ENV_TEMPLATE" >&2
      exit 1
    fi
    echo "No .env found — copying $ENV_TEMPLATE to $ENV_FILE"
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
}

generate_schema_migrations() {
  echo "Generating Drizzle migration artifacts from TypeScript schema..."
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required to run server schema generation before start" >&2
    exit 1
  fi
  if [[ ! -x "$REPO_ROOT/server/node_modules/.bin/drizzle-kit" ]]; then
    echo "Server dependencies are required to generate Drizzle migrations before start." >&2
    echo "Run: corepack enable && pnpm install --frozen-lockfile" >&2
    exit 1
  fi

  (
    cd "$REPO_ROOT/server"
    pnpm run schema:generate
  )
}

validate_prod_env() {
  [[ "$MODE" == "prod" ]] || return 0

  local pw
  pw="$(local_compose_env_value POSTGRES_PASSWORD || true)"
  local lower="${pw,,}"

  if [[ -z "$pw" ]]; then
    echo "Refusing to start prod: POSTGRES_PASSWORD is empty in $ENV_FILE" >&2
    exit 1
  fi
  if [[ "$pw" == "agent_space_dev_password" ]]; then
    echo "Refusing to start prod: POSTGRES_PASSWORD uses the development password" >&2
    exit 1
  fi
  if [[ "$pw" == \<*\> || "$lower" == "change_me" || "$lower" == "changeme" || "$lower" == replace_me* || "$lower" == *replace*me* || "$lower" == "placeholder" ]]; then
    echo "Refusing to start prod: POSTGRES_PASSWORD is still a placeholder" >&2
    exit 1
  fi
}

ensure_server_image_for_migrations() {
  local image="$COMPOSE_PROJECT-server"

  if [[ -n "$build_flag" ]] || ! docker image inspect "$image" &>/dev/null; then
    echo "Building server image for database migrations..."
    "${COMPOSE[@]}" build server
  fi
}

run_database_migrations() {
  echo "Preparing PostgreSQL database schema from generated Drizzle migrations..."
  "$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE"
}

init_data_dirs
ensure_env
validate_prod_env
local_compose_ensure_server_database_env
local_compose_generate_server_env
generate_schema_migrations

export DOCKER_GID
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 989)

if ! docker image inspect "$SANDBOX_IMAGE" &>/dev/null; then
  echo "Building sandbox image ($SANDBOX_IMAGE)..."
  docker build --network=host -f "$REPO_ROOT/sandbox/Dockerfile" -t "$SANDBOX_IMAGE" "$REPO_ROOT"
fi

ensure_server_image_for_migrations
run_database_migrations

echo "Starting agent-space ($MODE) with Docker Compose..."
echo "  compose file: $COMPOSE_FILE"
echo "  project:      $COMPOSE_PROJECT"
echo "  mode root:    $MODE_ROOT"

up_args=(up)
if [[ -n "$build_flag" ]]; then
  up_args+=("$build_flag")
fi
"${COMPOSE[@]}" "${up_args[@]}"
