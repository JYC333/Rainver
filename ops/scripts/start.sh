#!/usr/bin/env bash
# Start rainver via Docker Compose (frontend + server + deployer).
#
# Schema migrations are applied by ops/scripts/db/migrate.sh before the app
# services start; the migration chain under server/migrations is committed and
# never generated here (appending one is a deliberate developer step, see
# server/migrations/README.md). Nothing on the host needs the Node toolchain.
#
# dev and test build their images from this checkout. prod never builds: it
# pulls the images CI published to GHCR for the channel or commit named by
# RAINVER_IMAGE_TAG in the prod .env (default stable), so the machine needs
# the checkout only for these scripts and the compose files.
#
# Usage:
#   ./ops/scripts/start.sh              — dev (default)
#   ./ops/scripts/start.sh --dev        — dev (web 3000, API via /api/v1)
#   ./ops/scripts/start.sh --test       — test (web 3100, API via /api/v1)
#   ./ops/scripts/start.sh --prod       — prod (web 28400 → nginx 80 → internal server)
#   ./ops/scripts/start.sh --build      — dev/test only: rebuild images from source
#   ./ops/scripts/start.sh --detach     — start in the background (docker compose up -d)
#
# Data layout: $RAINVER_ROOT/<mode>/ (e.g. ~/.rainver-data/dev). Override the host-side
# parent directory with RAINVER_ROOT when you need a non-default location.
# RAINVER_HOME is NOT this parent: inside a container it is that container's
# mode root — /rainver for server and sandbox-runner, and the host path itself
# for the deployer, which has to name host paths to Compose.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/local-compose.sh
source "$SCRIPT_DIR/lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
build_flag=""
detach_flag=""

for arg in "$@"; do
  case $arg in
    --dev)    MODE="dev" ;;
    --test)   MODE="test" ;;
    --prod)   MODE="prod" ;;
    --build)  build_flag="--build" ;;
    --detach|-d) detach_flag="--detach" ;;
    *) echo "Unknown argument: $arg" && exit 1 ;;
  esac
done

if [[ "$MODE" == "prod" && -n "$build_flag" ]]; then
  echo "--build is not available for prod: images are pulled from GHCR, not built here." >&2
  echo "Set RAINVER_IMAGE_TAG in the prod .env to choose stable, edge, or sha-<commit>." >&2
  exit 1
fi

local_compose_init "$MODE"
ENV_TEMPLATE="$ENV_DIR/.env.$MODE.example"

# ── Initialize data root directories (idempotent) ──────────────────────────────
init_data_dirs() {
  echo "  → rainver root: $RAINVER_ROOT"
  echo "  → mode root:   $MODE_ROOT"

  install -d -m 700 "$RAINVER_ROOT"
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

validate_prod_env() {
  [[ "$MODE" == "prod" ]] || return 0

  local pw
  pw="$(local_compose_env_value POSTGRES_PASSWORD || true)"
  local lower="${pw,,}"

  if [[ -z "$pw" ]]; then
    echo "Refusing to start prod: POSTGRES_PASSWORD is empty in $ENV_FILE" >&2
    exit 1
  fi
  if [[ "$pw" == "rainver_dev_password" ]]; then
    echo "Refusing to start prod: POSTGRES_PASSWORD uses the development password" >&2
    exit 1
  fi
  if [[ "$pw" == \<*\> || "$lower" == "change_me" || "$lower" == "changeme" || "$lower" == replace_me* || "$lower" == *replace*me* || "$lower" == "placeholder" ]]; then
    echo "Refusing to start prod: POSTGRES_PASSWORD is still a placeholder" >&2
    exit 1
  fi
}

# Migrations run in a one-shot server container, so the server image must exist
# before migrate.sh. prod pulls every service image here so the whole stack
# moves to the selected tag in one step; dev/test build the server image from
# source when it is missing or --build was given.
ensure_images() {
  if [[ "$MODE" == "prod" ]]; then
    echo "Pulling rainver images (tag: $(local_compose_setting_or_default RAINVER_IMAGE_TAG stable))..."
    "${COMPOSE[@]}" pull
    return 0
  fi

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

export DOCKER_GID
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 989)

ensure_images
run_database_migrations

echo "Starting rainver ($MODE) with Docker Compose..."
echo "  compose file: $COMPOSE_FILE"
echo "  project:      $COMPOSE_PROJECT"
echo "  mode root:    $MODE_ROOT"

up_args=(up)
if [[ -n "$build_flag" ]]; then
  up_args+=("$build_flag")
fi
if [[ -n "$detach_flag" ]]; then
  up_args+=("$detach_flag")
fi
"${COMPOSE[@]}" "${up_args[@]}"

if [[ -n "$detach_flag" ]]; then
  echo "Started in the background. Follow logs with:"
  echo "  ${COMPOSE[*]} logs -f server"
fi
