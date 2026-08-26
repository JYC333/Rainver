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
  export RAINVER_MODE_ROOT="$MODE_ROOT"

  # Host shells and Node tooling often export DEBUG for their own purposes
  # (for example DEBUG=release). Keep that generic variable out of compose;
  # the server uses SERVER_DEBUG, with DEBUG accepted only for old env files.
  COMPOSE=(env -u DEBUG docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")
  COMPOSE_HINT="docker compose --env-file $ENV_FILE -p $COMPOSE_PROJECT -f $COMPOSE_FILE"
  LOCAL_COMPOSE_POSTGRES_STARTED=false
}

local_compose_ensure_mode_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return 0
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
  local line parsed_key value

  [[ -f "$file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(local_compose_trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue

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
        value="${value%%#*}"
        value="$(local_compose_trim "$value")"
      fi

      printf '%s\n' "$value"
      return 0
    fi
  done < "$file"

  return 1
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

  install -d -m 700 "$(dirname "$file")"
  [[ -f "$file" ]] || : > "$file"
  tmp="$(mktemp "${file}.tmp.XXXXXX")"

  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*#?[[:space:]]*" key "[[:space:]]*=" {
      print key "=" value
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
  python3 -c 'from urllib.parse import quote; import sys; print(quote(sys.argv[1], safe=""))' "$1"
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
  pgdb="$(local_compose_setting_or_default POSTGRES_DB rainver)"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$pguser"
  local_compose_validate_pg_identifier "POSTGRES_DB" "$pgdb"
  printf 'postgresql://%s:%s@postgres:5432/%s\n' \
    "$(local_compose_urlencode "$pguser")" "$(local_compose_urlencode "$pgpass")" "$pgdb"
}

local_compose_ensure_server_database_env() {
  [[ -f "$ENV_FILE" ]] || return 0

  local_compose_ensure_env_secret SERVER_INTERNAL_TOKEN 32

  local current_url desired_url
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
  local server_env="$MODE_ROOT/.server.env"
  local runner_env="$MODE_ROOT/.runner.env"
  grep -vE '^[[:space:]]*(POSTGRES_(MAJOR|DB|USER|PASSWORD)|DATABASE_URL)[[:space:]]*=' \
    "$ENV_FILE" > "$server_env"
  printf 'SANDBOX_RUNNER_TOKEN=%s\n' \
    "$(local_compose_setting SERVER_INTERNAL_TOKEN)" > "$runner_env"
  chmod 600 "$server_env" "$runner_env"
}
