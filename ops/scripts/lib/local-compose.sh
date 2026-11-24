#!/usr/bin/env bash
# Shared local Docker Compose/env resolution for host-side scripts.
#
# Source this file, parse script-specific arguments into MODE, then call:
#   local_compose_init "$MODE"

local_compose_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

local_compose_validate_mode() {
  case "${1:-}" in
    dev|test|prod) ;;
    *) echo "ERROR: --mode must be dev, test, or prod (got '${1:-}')" >&2; exit 1 ;;
  esac
}

local_compose_init() {
  MODE="${1:-${RAINVER_MODE:-dev}}"
  local_compose_validate_mode "$MODE"

  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  COMPOSE_DIR="$REPO_ROOT/ops/compose"
  ENV_DIR="$REPO_ROOT/ops/env"

  # RAINVER_ROOT is the host-side parent of mode roots: dev/, test/, prod/.
  RAINVER_ROOT="${RAINVER_ROOT:-$HOME/.rainver-data}"
  RAINVER_ROOT="${RAINVER_ROOT/#\~/$HOME}"
  export RAINVER_ROOT

  MODE_ROOT="$RAINVER_ROOT/$MODE"
  ENV_FILE="$MODE_ROOT/.env"
  COMPOSE_PROJECT="rainver-$MODE"
  COMPOSE_FILE="$COMPOSE_DIR/docker-compose.$MODE.yml"

  export REPO_ROOT
  export COMPOSE_DIR
  export ENV_DIR
  export MODE_ROOT

  # Compose volume sources are resolved by the *host* Docker daemon, so a caller
  # running inside a container (the deployer sidecar) must hand Compose the host
  # path. RAINVER_HOST_MODE_ROOT carries that host path; on the host itself the
  # variable is unset and MODE_ROOT already is it. A container whose RAINVER_ROOT
  # and RAINVER_HOST_MODE_ROOT disagree would read .env from one directory and
  # mount another, so that is a hard error rather than a silent split.
  if [[ -n "${RAINVER_HOST_MODE_ROOT:-}" && "$RAINVER_HOST_MODE_ROOT" != "$MODE_ROOT" ]]; then
    echo "ERROR: RAINVER_HOST_MODE_ROOT ($RAINVER_HOST_MODE_ROOT) does not match \$RAINVER_ROOT/$MODE ($MODE_ROOT)" >&2
    exit 1
  fi
  export RAINVER_MODE_ROOT="${RAINVER_HOST_MODE_ROOT:-$MODE_ROOT}"
  export DOCKER_GID="${DOCKER_GID:-$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 989)}"

  # Host shells and Node tooling often export DEBUG for their own purposes
  # (for example DEBUG=release). Strip that from the compose process.
  # The server reads SERVER_DEBUG, then DEBUG from the env file. Do not
  # pass the shell's DEBUG through.
  COMPOSE=(env -u DEBUG docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")
  COMPOSE_HINT="docker compose --env-file $ENV_FILE -p $COMPOSE_PROJECT -f $COMPOSE_FILE"
  LOCAL_COMPOSE_POSTGRES_STARTED=false
}

# The instance directory is already shared with the deployer. Lock its inode,
# which stays in place when a restore swaps the directories below it.
local_compose_lock_instance() {
  local operation="$1" fd="${RAINVER_OPERATION_LOCK_FD:-}"
  if [[ ! "$fd" =~ ^[0-9]+$ || ! "$MODE_ROOT" -ef "/dev/fd/$fd" ]]; then
    if ! exec {fd}<"$MODE_ROOT"; then
      echo "ERROR: cannot open the instance directory for $operation ($MODE_ROOT)." >&2
      return 1
    fi
  fi
  if command -v flock >/dev/null 2>&1; then
    flock --exclusive --nonblock "$fd" || fd=""
  else
    python3 -c 'import fcntl; fcntl.flock(0, fcntl.LOCK_EX | fcntl.LOCK_NB)' <&"$fd" 2>/dev/null || fd=""
  fi
  if [[ -z "$fd" ]]; then
    echo "ERROR: cannot lock instance for $operation; another operation may be active ($MODE_ROOT)." >&2
    return 1
  fi
  export RAINVER_OPERATION_LOCK_FD="$fd"
}

local_compose_unlock_instance() {
  if command -v flock >/dev/null 2>&1; then
    flock --unlock "$RAINVER_OPERATION_LOCK_FD"
  else
    python3 -c 'import fcntl; fcntl.flock(0, fcntl.LOCK_UN)' <&"$RAINVER_OPERATION_LOCK_FD"
  fi
}

# A mutable image tag is a pointer on the server repository. CI moves it
# after the complete release's immutable commit tags are available.
local_compose_pin_image_tag() {
  local tag="${1:-$(local_compose_setting_or_default RAINVER_IMAGE_TAG stable)}"
  case "$tag" in
    stable|edge)
      local ref="ghcr.io/jyc333/rainver-server:$tag" revision
      docker pull "$ref" >&2 || return
      revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")" || return
      tag="sha-$revision"
      ;;
  esac
  if [[ ! "$tag" =~ ^sha-[0-9a-f]{40}$ ]]; then
    echo "ERROR: could not resolve a Rainver release to a valid immutable image tag." >&2
    return 1
  fi
  export RAINVER_IMAGE_TAG="$tag"
}

local_compose_verify_image_revision() {
  local service revision
  for service in "$@"; do
    revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "ghcr.io/jyc333/rainver-$service:$RAINVER_IMAGE_TAG")" || return
    if [[ "sha-$revision" != "$RAINVER_IMAGE_TAG" ]]; then
      echo "ERROR: the $service image does not match release $RAINVER_IMAGE_TAG." >&2
      return 1
    fi
  done
}

# One-off production commands must run the same commit image throughout the
# operation. An existing local copy keeps offline restore possible.
local_compose_prepare_prod_server_image() {
  [[ "$MODE" == prod ]] || return 0
  local_compose_pin_image_tag || return
  if ! docker image inspect "ghcr.io/jyc333/rainver-server:$RAINVER_IMAGE_TAG" >/dev/null 2>&1; then
    "${COMPOSE[@]}" pull server || return
  fi
  local_compose_verify_image_revision server
}

local_compose_run_restore_server() {
  local database="$1" owner_url command=(run --rm -T --no-deps)
  shift
  [[ "$MODE" != prod ]] || command+=(--pull never)
  owner_url="$(local_compose_server_owner_database_url "$database")" || return
  SERVER_DATABASE_URL="$owner_url" \
  RAINVER_DB_APP_ROLE="$(local_compose_setting_or_default RAINVER_DB_APP_ROLE rainver_app)" \
  RAINVER_DB_BACKUP_ROLE="$(local_compose_setting_or_default RAINVER_DB_BACKUP_ROLE rainver_backup)" \
    "${COMPOSE[@]}" "${command[@]}" -e SERVER_DATABASE_URL -e RAINVER_DB_APP_ROLE -e RAINVER_DB_BACKUP_ROLE server "$@"
}

local_compose_restore_preflight() {
  local_compose_run_restore_server "$1" sh -s < "$REPO_ROOT/ops/scripts/lib/restore-preflight.sh"
}

COMPOSE_APPLICATION_SERVICES=(frontend server sandbox-runner deployer)

local_compose_active_application_services() {
  local status services all="" service
  for status in running restarting paused; do
    if ! services="$("${COMPOSE[@]}" ps --services --all --filter "status=$status" 2>/dev/null)"; then
      echo "ERROR: unable to inspect Compose service status for mode '$MODE'." >&2
      return 1
    fi
    all+=$'\n'"$services"
  done
  for service in "${COMPOSE_APPLICATION_SERVICES[@]}"; do
    if [[ $'\n'"$all"$'\n' == *$'\n'"$service"$'\n'* ]]; then
      printf '%s\n' "$service"
    fi
  done
}

local_compose_require_stopped_applications() {
  local operation="$1" force="${2:-false}" active
  active="$(local_compose_active_application_services)" || return
  if [[ -z "$active" ]]; then
    return 0
  fi
  if [[ "$force" == "true" ]]; then
    echo "WARNING: app services active during $operation: ${active//$'\n'/ }" >&2
    return 0
  fi
  echo "ERROR: app services still active for $operation (mode '$MODE'): ${active//$'\n'/ }" >&2
  echo "       To stop application services: $COMPOSE_HINT stop ${COMPOSE_APPLICATION_SERVICES[*]}" >&2
  return 1
}

local_compose_ensure_mode_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return 0
  fi

  if [[ "${RAINVER_ENV_FILE_READONLY:-0}" == "1" ]]; then
    echo "ERROR: $ENV_FILE is missing and this caller may not create it" >&2
    echo "       (RAINVER_ENV_FILE_READONLY=1). Provision the instance on the host." >&2
    exit 1
  fi

  local template="$ENV_DIR/.env.$MODE.example"
  if [[ ! -f "$template" ]]; then
    echo "ERROR: missing env template: $template" >&2
    exit 1
  fi

  install -d -m 700 "$MODE_ROOT"
  echo "No .env found — copying $template to $ENV_FILE"
  cp "$template" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

local_compose_service_running() {
  local service="$1"
  local running=""
  running="$("${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null || true)"
  [[ $'\n'"$running"$'\n' == *$'\n'"$service"$'\n'* ]]
}

local_compose_ensure_postgres() {
  local purpose="${1:-operation}"

  if local_compose_service_running postgres; then
    return 0
  fi

  echo "Starting postgres service for $purpose (mode: $MODE)..."
  if ! "${COMPOSE[@]}" up -d postgres >/dev/null; then
    echo "ERROR: failed to start postgres service for mode '$MODE'." >&2
    return 1
  fi
  LOCAL_COMPOSE_POSTGRES_STARTED=true
}

local_compose_wait_postgres_ready() {
  local pguser="$1"
  local db="${2:-postgres}"
  local timeout_seconds="${3:-30}"
  local attempt consecutive_successes=0
  local required_successes=3

  for ((attempt = 1; attempt <= timeout_seconds; attempt++)); do
    # The official postgres image starts a short-lived bootstrap server during
    # first initdb, then shuts it down before starting the real server. A single
    # pg_isready success can land in that shutdown window. Require consecutive
    # SQL probes so migration/bootstrap scripts only proceed once the final
    # server is stable enough to accept real queries.
    if "${COMPOSE[@]}" exec -T postgres \
      psql -X -q -U "$pguser" -d "$db" \
        -v ON_ERROR_STOP=1 \
        -tAc "SELECT 1;" >/dev/null 2>&1; then
      consecutive_successes=$((consecutive_successes + 1))
      if (( consecutive_successes >= required_successes )); then
        return 0
      fi
    else
      consecutive_successes=0
    fi
    sleep 1
  done

  echo "ERROR: postgres service is not ready for mode '$MODE' after waiting." >&2
  return 1
}

local_compose_ensure_postgres_ready() {
  local purpose="$1"
  local pguser="$2"
  local db="${3:-postgres}"
  local timeout_seconds="${4:-30}"

  if ! local_compose_ensure_postgres "$purpose"; then
    return 1
  fi
  local_compose_wait_postgres_ready "$pguser" "$db" "$timeout_seconds"
}

local_compose_wait_service_healthy() {
  local service="$1"
  local purpose="${2:-service readiness}"
  local timeout_seconds="${3:-120}"
  local attempt container_id status

  for ((attempt = 1; attempt <= timeout_seconds; attempt++)); do
    container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$status" in
        healthy)
          return 0
          ;;
        exited|dead)
          echo "ERROR: service '$service' exited while waiting for $purpose." >&2
          return 1
          ;;
      esac
    fi
    sleep 1
  done

  echo "ERROR: service '$service' was not healthy for $purpose after waiting." >&2
  return 1
}

local_compose_stop_postgres_if_started() {
  local purpose="${1:-operation}"

  if [[ "${LOCAL_COMPOSE_POSTGRES_STARTED:-false}" == "true" ]]; then
    echo "[$purpose] stopping postgres service started for $purpose..."
    "${COMPOSE[@]}" stop postgres >/dev/null || true
    LOCAL_COMPOSE_POSTGRES_STARTED=false
  fi
  return 0
}

local_compose_env_value() {
  local key="$1"
  local file="${2:-$ENV_FILE}"
  local line parsed_key value found=false

  [[ -f "$file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(local_compose_trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ ^export[[:space:]]+(.+)$ ]]; then
      line="${BASH_REMATCH[1]}"
    fi

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      parsed_key="${BASH_REMATCH[1]}"
      [[ "$parsed_key" == "$key" ]] || continue

      value="$(local_compose_trim "${BASH_REMATCH[2]}")"
      if [[ "$value" == \"* ]]; then
        value="${value#\"}"
        value="${value%%\"*}"
      elif [[ "$value" == \'* ]]; then
        value="${value#\'}"
        value="${value%%\'*}"
      else
        # As Compose reads it: an inline comment starts at whitespace followed
        # by `#`; a `#` inside the value (a password) is part of the value.
        value="${value%%[[:space:]]#*}"
        value="$(local_compose_trim "$value")"
      fi

      found=true
    fi
  done < "$file"

  [[ "$found" == true ]] && printf '%s\n' "$value"
}

local_compose_setting() {
  local key="$1"
  local value="${!key-}"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  local_compose_env_value "$key"
}

local_compose_setting_or_default() {
  local key="$1"
  local default="$2"
  local value

  if value="$(local_compose_setting "$key")" && [[ -n "$value" ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default"
  fi
}

local_compose_validate_pg_identifier() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "ERROR: $label contains unsafe characters" >&2
    exit 1
  fi
}

local_compose_is_placeholder_value() {
  local value="${1:-}"
  local lower="${value,,}"

  [[ -z "$value" ]] && return 0
  [[ "$value" == \<*\> ]] && return 0
  case "$lower" in
    change_me|changeme|replace_me*|replace-with-*|*replace*me*|placeholder)
      return 0
      ;;
  esac
  return 1
}

local_compose_random_hex() {
  local bytes="${1:-24}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return 0
  fi
  python3 -c "import secrets; print(secrets.token_hex($bytes))"
}

local_compose_set_env_value() {
  local key="$1"
  local value="$2"
  local file="${3:-$ENV_FILE}"
  local tmp

  # B43: the deployer never writes the instance .env. It runs these helpers
  # through migrate.sh, where every value is already provisioned, so refusing
  # here is a boundary guard rather than a normal branch — it fails the stage
  # loudly instead of letting a privileged container edit deployment inputs.
  if [[ "${RAINVER_ENV_FILE_READONLY:-0}" == "1" ]]; then
    echo "ERROR: refusing to write $key into $file (RAINVER_ENV_FILE_READONLY=1)" >&2
    exit 1
  fi

  install -d -m 700 "$(dirname "$file")"
  [[ -f "$file" ]] || : > "$file"
  tmp="$(mktemp "${file}.tmp.XXXXXX")"

  RAINVER_COMPOSE_ENV_VALUE="$value" awk -v key="$key" '
    BEGIN { done = 0; value = ENVIRON["RAINVER_COMPOSE_ENV_VALUE"] }
    $0 ~ "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      if (!done) print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        if (NR > 0) print ""
        print key "=" value
      }
    }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

local_compose_ensure_env_secret() {
  local key="$1"
  local bytes="${2:-24}"
  local current=""

  current="$(local_compose_setting "$key" || true)"
  if local_compose_is_placeholder_value "$current"; then
    local_compose_set_env_value "$key" "$(local_compose_random_hex "$bytes")"
  fi
}

local_compose_urlencode() {
  printf '%s' "$1" | python3 -c 'from urllib.parse import quote; import sys; print(quote(sys.stdin.read(), safe=""))'
}

local_compose_postgres_password_or_default() {
  local pgpass
  pgpass="$(local_compose_setting POSTGRES_PASSWORD || true)"
  if [[ -n "$pgpass" ]]; then
    if [[ "$MODE" == "prod" ]] && local_compose_is_placeholder_value "$pgpass"; then
      echo "ERROR: POSTGRES_PASSWORD is still a placeholder for production server database URL generation." >&2
      exit 1
    fi
    printf '%s\n' "$pgpass"
    return 0
  fi
  if [[ "$MODE" == "prod" ]]; then
    echo "ERROR: POSTGRES_PASSWORD is required for production server database URL generation." >&2
    exit 1
  fi
  printf '%s\n' "rainver_dev_password"
}

local_compose_server_owner_database_url() {
  local pguser pgpass pgdb
  pguser="$(local_compose_setting_or_default POSTGRES_USER rainver)"
  pgpass="$(local_compose_postgres_password_or_default)"
  pgdb="${1:-$(local_compose_setting_or_default POSTGRES_DB rainver)}"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$pguser"
  local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"
  printf 'postgresql://%s:%s@postgres:5432/%s\n' \
    "$(local_compose_urlencode "$pguser")" "$(local_compose_urlencode "$pgpass")" "$pgdb"
}

local_compose_ensure_server_database_env() {
  [[ -f "$ENV_FILE" ]] || return 0

  local_compose_ensure_env_secret SERVER_INTERNAL_TOKEN 32
  local_compose_ensure_env_secret BETTER_AUTH_SECRET 32

  local current_url desired_url
  # ADR 0031: once the separate runtime role is activated (explicitly, by
  # ops/scripts/db/runtime-roles.sh, never here) the server URL
  # is the operator's explicit choice; never rewrite it back to the owner.
  if [[ "$(local_compose_setting RAINVER_DB_REQUIRE_RUNTIME_ROLE || true)" == "1" ]]; then
    return 0
  fi
  desired_url="$(local_compose_server_owner_database_url)"
  current_url="$(local_compose_setting SERVER_DATABASE_URL || true)"
  if local_compose_is_placeholder_value "$current_url" || [[ "$current_url" == postgresql://*@postgres:* && "$current_url" != "$desired_url" ]]; then
    local_compose_set_env_value SERVER_DATABASE_URL "$desired_url"
  fi
}

# Compose loads application-only variables from a generated file. Database
# helpers must be independently runnable on a fresh mode root, not depend on
# start.sh having generated this file first.
local_compose_generate_server_env() {
  # Deployment inputs are the host operator's. A caller that may not write the
  # instance .env may not regenerate the files derived from it either: doing so
  # from the deployer would rewrite the server's credential env during an update.
  if [[ "${RAINVER_ENV_FILE_READONLY:-0}" == "1" ]]; then
    return 0
  fi

  local server_env="$MODE_ROOT/.server.env"
  local deployer_env="$MODE_ROOT/.deployer.env"
  # ADR 0031: the owner URL kept for rollback and the role passwords are
  # operator inputs; the server only receives its own SERVER/BACKUP URLs.
  grep -vE '^[[:space:]]*(export[[:space:]]+)?(POSTGRES_(MAJOR|DB|USER|PASSWORD)|DATABASE_URL|RAINVER_DB_(APP_PASSWORD|BACKUP_PASSWORD|OWNER_[A-Z_]+))[[:space:]]*=' \
    "$ENV_FILE" > "$server_env"
  # The deployer pull loop authenticates to the server with the internal token
  # (ADR 0020 §1). The execution host is deliberately not given it: it holds a
  # bearer token for its own Host row and nothing that unlocks an internal
  # route. It never receives database,
  # provider, or session credentials.
  {
    printf 'SERVER_INTERNAL_TOKEN=%s\n' "$(local_compose_setting SERVER_INTERNAL_TOKEN)"
    printf 'DEPLOYER_SERVER_URL=%s\n' "http://server:8010"
  } > "$deployer_env"
  chmod 600 "$server_env" "$deployer_env"
}
