#!/usr/bin/env bash
# Prepare an unpublished migration squash or convert an existing database.
# Operations entrypoint; server/src/db owns migration validation/transactions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/local-compose.sh"

usage() {
  cat <<'HELP'
Usage from the repository root:
  ./ops/scripts/db/squash-migrations.sh prepare --mode dev --from 0001 --name plan_name
  ./ops/scripts/db/squash-migrations.sh convert [--mode dev|test|prod] --source DIR --target DIR
  ./ops/scripts/db/squash-migrations.sh convert --host --source DIR --target DIR
  ./ops/scripts/db/squash-migrations.sh cutover --mode test [--archive DIR]
cutover performs build/check, stop, backup, conversion and restore of previously running apps.
cutover automatically matches source/target archives by migration checksums.
--archive overrides discovery. cutover executes conversion, not a preview.
Convert previews by default. To apply, add --apply --offline --backup FILE.
Prepare runs locally with Node 24 and the built server libraries (pnpm --dir server run build).
Convert defaults to a one-shot server container using the selected mode's existing .server.env.
--host uses SERVER_DATABASE_URL (or DATABASE_URL) for any reachable PostgreSQL database.
prepare/convert do not bootstrap services, generate environment files, back up or stop applications.
Keep the original chain archive; see server/migrations/README.md before applying.
HELP
}

MODE="${RAINVER_MODE:-dev}"
HOST_MODE=false
ARGS=()
SOURCE_DIR=""
TARGET_DIR=""
BACKUP_FILE=""
ARCHIVE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --host) HOST_MODE=true; shift ;;
    --archive) ARCHIVE_DIR="$(realpath -e "${2:?--archive needs a value}")"; shift 2 ;;
    --source|--target|--backup)
      option="$1"
      path="$(realpath -e "${2:?path option needs a value}")"
      case "$option" in
        --source) SOURCE_DIR="$path" ;;
        --target) TARGET_DIR="$path" ;;
        --backup) BACKUP_FILE="$path" ;;
      esac
      ARGS+=("$option" "$path"); shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

if [[ "${ARGS[0]:-}" == "cutover" ]]; then
  if [[ "$HOST_MODE" == true || ${#ARGS[@]} -ne 1 ]]; then
    usage >&2; exit 2
  fi
  exec bash "$SCRIPT_DIR/../lib/migration-cutover.sh" "$MODE" "$ARCHIVE_DIR"
fi
if [[ -n "$ARCHIVE_DIR" ]]; then
  echo "ERROR: --archive is only supported with cutover" >&2; exit 2
fi
if [[ "${ARGS[0]:-}" != "prepare" && "${ARGS[0]:-}" != "convert" ]]; then
  usage >&2; exit 2
fi
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
if [[ "${ARGS[0]}" == "prepare" || "$HOST_MODE" == true ]]; then
  # Host-side commands run the built server libraries on the host's Node; the
  # repository supports only the engines range in package.json (>=24 <25).
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if [[ "${node_version%%.*}" != 24 ]]; then
    echo "ERROR: host-side '${ARGS[0]}' requires Node 24 (found: ${node_version:-no node on PATH})." >&2
    echo "       Switch to Node 24 (for example 'nvm install 24 && nvm use 24')." >&2
    [[ "${ARGS[0]}" != convert ]] || echo "       Without --host, convert runs in the server container and needs no host Node." >&2
    exit 1
  fi
  if [[ ! -f "$REPO_ROOT/server/dist/db/migrationSquash.js" ]]; then
    echo "ERROR: build server libraries first: pnpm --dir server run build" >&2; exit 1
  fi
  if [[ "${ARGS[0]}" == "convert" ]]; then
    export SERVER_DATABASE_URL="${SERVER_DATABASE_URL:-${DATABASE_URL:-}}"
  fi
  if [[ "${ARGS[0]}" == "prepare" ]]; then
    local_compose_init "$MODE"
    [[ -n "$SOURCE_DIR" ]] || ARGS+=(--source "$REPO_ROOT/server/migrations")
    ARGS+=(--home "$MODE_ROOT")
  fi
  exec node "$SCRIPT_DIR/migration-squash.mjs" "${ARGS[@]}"
fi

# Existing shared mode/path resolution only. Preview must not create an env
# file, start services, generate credentials or bootstrap an empty database.
local_compose_init "$MODE"
if [[ ! -f "$ENV_FILE" || ! -f "$MODE_ROOT/.server.env" ]]; then
  echo "ERROR: existing $MODE environment files are required; nothing was created." >&2; exit 1
fi
if [[ ! -d "$SOURCE_DIR" || ! -d "$TARGET_DIR" ]]; then
  echo "ERROR: convert requires existing --source and --target directories" >&2; exit 2
fi
MOUNTS=(-v "$SCRIPT_DIR/migration-squash.mjs:/app/ops/scripts/db/migration-squash.mjs:ro")
for path in "$SOURCE_DIR" "$TARGET_DIR" "$BACKUP_FILE"; do
  [[ -z "$path" ]] && continue
  # Keep absolute operator paths in the audit and CLI arguments. Never overlay
  # application code or Docker's volume delimiter with an archive mount.
  if [[ "$path" == /app || "$path" == /app/* || "$path" == *:* ]]; then
    echo "ERROR: archive/backup mount path must be outside /app and contain no colon" >&2; exit 2
  fi
  MOUNTS+=(-v "$path:$path:ro")
done
exec "${COMPOSE[@]}" run --rm -T --no-deps "${MOUNTS[@]}" \
  server node /app/ops/scripts/db/migration-squash.mjs "${ARGS[@]}"
