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
#   ./ops/scripts/start.sh --maintenance — offline upgrade for a migration the
#         running release cannot survive (ADR 0016 §10). Pulls images,
#         waits for Runs to finish without killing any, stops frontend, server,
#         sandbox-runner and deployer while keeping PostgreSQL, takes a dump,
#         applies the migration only if the dump succeeded, then starts again.
#         On failure it leaves the applications stopped and keeps the dump; it
#         never rolls back by itself.
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
maintenance=0

for arg in "$@"; do
  case $arg in
    --dev)    MODE="dev" ;;
    --test)   MODE="test" ;;
    --prod)   MODE="prod" ;;
    --build)  build_flag="--build" ;;
    --detach|-d) detach_flag="--detach" ;;
    --maintenance) maintenance=1 ;;
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
  # The built-in execution host: where the server publishes its registration
  # credential, and where its daemon keeps everything it owns. Created here
  # because Docker would otherwise create the bind source as root and the
  # daemon runs as an unprivileged user.
  install -d -m 700 "$MODE_ROOT/cache/builtin-host"
  install -d -m 700 "$MODE_ROOT/cache/host-daemon"
  install -d -m 700 "$MODE_ROOT/run"
  install -d -m 700 "$MODE_ROOT/sandboxes"
  install -d -m 700 "$MODE_ROOT/workspaces"
}

# ── Retired directories ───────────────────────────────────────────────────────
# Named, never deleted. A CLI runtime is installed on an execution host now and
# no credential is brokered from here (ADR 0016), so these two are dead weight
# — but one of them is a secrets directory, and a script that deletes those is
# a script nobody can trust.
report_retired_dirs() {
  local retired=()
  [[ -d "$MODE_ROOT/runtime-tools" ]] && retired+=("$MODE_ROOT/runtime-tools")
  [[ -d "$MODE_ROOT/secrets/cli-credentials" ]] && retired+=("$MODE_ROOT/secrets/cli-credentials")
  (( ${#retired[@]} )) || return 0
  echo "  → no longer used by this release; remove by hand when you are ready:"
  printf '      %s\n' "${retired[@]}"
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

# ── Offline maintenance upgrade (ADR 0016 §10) ────────────────────────
# The applications that read the old schema are stopped for the whole window;
# PostgreSQL stays up because the migration and the dump both need it.
APPLICATION_SERVICES=(frontend server sandbox-runner deployer)

# Runs are someone's work in progress. Waiting is the only acceptable way to
# reach a quiet instance: this never kills one, and a drain that does not
# converge abandons the upgrade instead.
maintenance_drain() {
  local deadline=$(( SECONDS + ${MAINTENANCE_DRAIN_SECONDS:-900} ))
  local pguser pgdb active quiet=0
  pguser="$(local_compose_setting_or_default POSTGRES_USER rainver)"
  pgdb="$(local_compose_setting_or_default POSTGRES_DB rainver)"
  while :; do
    active="$("${COMPOSE[@]}" exec -T postgres psql -qtAX -U "$pguser" -d "$pgdb" \
      -c "SELECT count(*) FROM runs WHERE status IN ('queued','running')" 2>/dev/null || echo "")"
    if [[ -z "$active" ]]; then
      echo "  → could not read active Runs; treating the instance as busy" >&2
    elif [[ "$active" == "0" ]]; then
      # Two consecutive quiet reads, not one. Dispatch is still accepted while
      # this runs, so a single zero can be the gap between one Run finishing
      # and the next starting — and stopping into that gap kills the Run this
      # function exists not to kill.
      quiet=$(( quiet + 1 ))
      if (( quiet >= 2 )); then
        echo "  → no Run is queued or running"
        return 0
      fi
      echo "  → quiet; confirming..."
    else
      quiet=0
      echo "  → waiting for $active Run(s) to finish..."
    fi
    if (( SECONDS >= deadline )); then
      echo "ERROR: Runs are still active after the drain window." >&2
      echo "       Nothing was stopped and nothing was migrated. Try again when the instance is quiet," >&2
      echo "       or raise MAINTENANCE_DRAIN_SECONDS." >&2
      return 1
    fi
    sleep 10
  done
}

run_maintenance_upgrade() {
  echo "Maintenance upgrade ($MODE): an offline migration the running release cannot survive."

  # Everything that can fail without touching the instance happens first.
  echo "→ preflight"
  # The drain reads `runs` and the dump reads the database, so PostgreSQL has
  # to be up before either — an operator who brought the stack down first, or
  # a machine that just rebooted, would otherwise spend the whole drain window
  # being told the instance is busy.
  local_compose_ensure_postgres_ready "the maintenance upgrade" \
    "$(local_compose_setting_or_default POSTGRES_USER rainver)" \
    "$(local_compose_setting_or_default POSTGRES_DB rainver)"
  local free_kb
  free_kb="$(df -Pk "$MODE_ROOT/db" | awk 'NR==2 {print $4}')"
  if [[ -n "$free_kb" && "$free_kb" -lt $(( ${MAINTENANCE_MIN_FREE_MB:-2048} * 1024 )) ]]; then
    echo "ERROR: less than ${MAINTENANCE_MIN_FREE_MB:-2048}MB free under $MODE_ROOT/db; the dump needs room." >&2
    exit 1
  fi
  ensure_images

  echo "→ draining Runs (nothing is killed)"
  maintenance_drain || exit 1

  echo "→ stopping applications, keeping PostgreSQL"
  # From here the instance is down until this function finishes. An interrupt
  # in the middle leaves it stopped, which is recoverable — each migration is
  # its own transaction — but must not be silent.
  trap 'echo "" >&2; echo "INTERRUPTED mid-maintenance: applications are stopped and the migration may not have run." >&2; echo "Re-run the same command to continue; nothing is half-applied (each migration is one transaction)." >&2; exit 1' INT TERM
  "${COMPOSE[@]}" stop "${APPLICATION_SERVICES[@]}"

  echo "→ backing up and migrating"
  # The dump is taken after the stop, so it is of a database nothing is still
  # writing to, and the migration runs only if the dump succeeded.
  if ! "$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE" --pre-migration-backup --allow-maintenance; then
    echo "ERROR: the maintenance migration failed. The applications are left stopped on purpose." >&2
    echo "       The pre-migration dump is under $MODE_ROOT/db/dumps/ and is kept." >&2
    echo "       Nothing is rolled back automatically: restoring that dump is an explicit decision," >&2
    echo "       and starting the previous images without restoring it is not a recovery." >&2
    exit 1
  fi

  echo "→ starting the upgraded stack"
  "${COMPOSE[@]}" up --detach
  # Checked, not merely suggested: a stack that crash-loops on the new schema
  # must not be reported as a completed upgrade.
  if ! local_compose_wait_service_healthy server "the maintenance upgrade" 180; then
    echo "ERROR: the stack started but the server did not become healthy." >&2
    echo "       The migration IS applied. The pre-migration dump under $MODE_ROOT/db/dumps/ is kept." >&2
    echo "       Inspect: ${COMPOSE[*]} logs server" >&2
    exit 1
  fi
  report_retired_dirs
  echo "Maintenance upgrade complete; server reports healthy."
  echo "  ${COMPOSE[*]} ps"
}

init_data_dirs
ensure_env
validate_prod_env
local_compose_ensure_server_database_env
local_compose_generate_server_env

export DOCKER_GID
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 989)

if [[ "$maintenance" == "1" ]]; then
  run_maintenance_upgrade
  exit 0
fi

ensure_images
run_database_migrations
report_retired_dirs

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
