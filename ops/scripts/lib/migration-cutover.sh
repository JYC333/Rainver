#!/usr/bin/env bash
# Internal lifecycle companion to db/squash-migrations.sh cutover.
set -euo pipefail
DB_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../db" && pwd)"
source "$DB_SCRIPT_DIR/../lib/local-compose.sh"
local_compose_init "${1:?mode is required}"
ARCHIVE_DIR="${2:-}"

if [[ ! -f "$ENV_FILE" || ! -f "$MODE_ROOT/.server.env" ]]; then
  echo "ERROR: existing environment files are required" >&2; exit 1
fi
if [[ "$ARCHIVE_DIR" == *:* || "$REPO_ROOT" == *:* || "$RAINVER_ROOT" == *:* ]]; then
  echo "ERROR: mount paths must not contain colons" >&2; exit 2
fi
if [[ "$ARCHIVE_DIR" == /app || "$ARCHIVE_DIR" == /app/* || "$RAINVER_ROOT" == /app || "$RAINVER_ROOT" == /app/* ]]; then
  echo "ERROR: archive/catalog mount must not overlay application code" >&2; exit 2
fi

install -d -m 700 "$MODE_ROOT/db/dumps"
exec 9>"$MODE_ROOT/db/migration-cutover.lock"
flock -n 9 || { echo "ERROR: another cutover is already running" >&2; exit 1; }
running="$("${COMPOSE[@]}" ps --status running --services)"
if ! [[ $'\n'"$running"$'\n' == *$'\npostgres\n'* ]]; then
  echo "ERROR: postgres must already be running" >&2; exit 1
fi
ACTIVE_DIR="$MODE_ROOT/db/.migration-cutover.active"
APPS_FILE="$ACTIVE_DIR/apps"
# Restarting containers (restart: unless-stopped) would write during the
# offline apply too, so they are stopped and later restored like running ones.
# A retry after a failure also restores the apps the failed run stopped: they
# are no longer running, but were before the first attempt.
restarting="$("${COMPOSE[@]}" ps --status restarting --services)"
APPS=()
while IFS= read -r service; do
  case "$service" in
    frontend|server|sandbox-runner|deployer)
      [[ " ${APPS[*]} " == *" $service "* ]] || APPS+=("$service") ;;
  esac
done < <(printf '%s\n' "$running" "$restarting"; [[ ! -f "$APPS_FILE" ]] || cat "$APPS_FILE")
# Build the helper as well as the converter before using either.
if [[ "$MODE" != prod ]]; then
  "${COMPOSE[@]}" build server
fi

# The same filesystem mutex is used by server retention. A stale directory
# after SIGKILL requires operator inspection; never guess that a cutover died.
mkdir "$MODE_ROOT/db/.migration-artifacts.lock" || { echo "ERROR: migration artifact maintenance is locked" >&2; exit 1; }
stopped=false
was_active=false
[[ ! -d "$ACTIVE_DIR" ]] || was_active=true
BACKUP_PARTIAL=""
finish() {
  local status=$?
  [[ -z "$BACKUP_PARTIAL" ]] || rm -f "$BACKUP_PARTIAL"
  if [[ "$status" -ne 0 && "$stopped" == true ]]; then
    echo "ERROR: cutover failed; no automatic recovery follows. Inspect container state, the error and backup before recovery." >&2
    echo "       Stopped applications are recorded in $APPS_FILE; a successful retry of the same cutover restarts them." >&2
  elif [[ "$was_active" == false ]]; then
    rm -f "$APPS_FILE"
    rmdir "$ACTIVE_DIR" 2>/dev/null || true
  fi
  rmdir "$MODE_ROOT/db/.migration-artifacts.lock"
}
trap finish EXIT

# Import the matching pairs into this instance. Legacy/other-mode catalogs are
# read-only discovery sources; their ownership and retention are not changed.
# Selection reads this database's applied history: an instance still on an
# older plan's source converts with that plan's pair first, then with each
# later pair whose source starts with the previous target.
install -d -m 700 "$MODE_ROOT/db/migration-archives"
mkdir -p "$ACTIVE_DIR"
ARTIFACT_MOUNTS=(-v "$DB_SCRIPT_DIR/migration-artifacts.mjs:/app/ops/scripts/db/migration-artifacts.mjs:ro")
SELECT_ARGS=()
for catalog in "$RAINVER_ROOT/migration-archives" "$RAINVER_ROOT"/{dev,test,prod}/db/migration-archives; do
  [[ -d "$catalog" && "$catalog" != "$MODE_ROOT/db/migration-archives" ]] || continue
  ARTIFACT_MOUNTS+=(-v "$catalog:$catalog:ro")
  SELECT_ARGS+=(--catalog "$catalog")
done
if [[ -n "$ARCHIVE_DIR" ]]; then
  ARTIFACT_MOUNTS+=(-v "$ARCHIVE_DIR:$ARCHIVE_DIR:ro")
  SELECT_ARGS+=(--archive "$ARCHIVE_DIR")
fi
selected="$("${COMPOSE[@]}" run --rm -T --no-deps "${ARTIFACT_MOUNTS[@]}" \
  -v "$REPO_ROOT/server/migrations:/squash-checkout:ro" \
  server node /app/ops/scripts/db/migration-artifacts.mjs select --home /rainver --checkout /squash-checkout "${SELECT_ARGS[@]}")"
ARCHIVE_IDS=()
while IFS= read -r archive_id; do
  if [[ ! "$archive_id" =~ ^[a-f0-9]{64}$ ]]; then
    echo "ERROR: archive selection returned an invalid identity" >&2; exit 1
  fi
  ARCHIVE_IDS+=("$archive_id")
  echo "Selected migration archive: $archive_id"
done <<< "$selected"
archive_dir() { printf '%s\n' "$MODE_ROOT/db/migration-archives/$1"; }
TARGET_DIR="$(archive_dir "${ARCHIVE_IDS[-1]}")/target"

# Check the image and checkout carry the same chain, starting with the
# last selected target, before stopping anything. Migrations appended after the
# formal one are counted and run by normal `up` after conversion. Existing
# normal migration loading/checksums are the authority.
LATER_MIGRATIONS="$("${COMPOSE[@]}" run --rm -T --no-deps \
  -v "$TARGET_DIR:/squash-target:ro" \
  -v "$REPO_ROOT/server/migrations:/squash-checkout:ro" \
  server node --input-type=module -e '
    const {loadMigrations} = await import("./dist/db/migrator.js");
    await import("./dist/db/migrationConversion.js");
    const identity = dir => loadMigrations(dir).map(({version,name,checksum}) => JSON.stringify({version,name,checksum}));
    const target = identity("/squash-target");
    const image = identity("/app/server/migrations");
    const checkout = identity("/squash-checkout");
    if (image.join() !== checkout.join() || target.some((file, i) => checkout[i] !== file))
      throw new Error("Image or checkout does not start with the archived target migration chain");
    console.log(checkout.length - target.length);
  ' | tail -n 1)"
if [[ ! "$LATER_MIGRATIONS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not verify the image and checkout migration chains" >&2; exit 1
fi
# Only the first pair can be previewed against the live history; the
# selection already checked that each later source accepts the previous target.
first="$(archive_dir "${ARCHIVE_IDS[0]}")"
"$DB_SCRIPT_DIR/squash-migrations.sh" convert --mode "$MODE" --source "$first/source" --target "$first/target"

# Record the stopped set before stopping, so a retry after any later failure
# restores it rather than only what happens to be running then.
printf '%s\n' "${APPS[@]}" > "$APPS_FILE.tmp"
mv "$APPS_FILE.tmp" "$APPS_FILE"
if [[ ${#APPS[@]} -gt 0 ]]; then
  stopped=true
  "${COMPOSE[@]}" stop "${APPS[@]}"
fi
# Even an instance whose apps were already stopped has recovery material to pin.
stopped=true
# Published only after pg_dump and the readability check succeed, so retention
# and dependency records never count a partial dump as a recovery point.
BACKUP_PARTIAL="$(mktemp "$MODE_ROOT/db/dumps/.pre-squash-$(date -u +%Y%m%d-%H%M%S)-XXXXXXXX.partial")"
partial_name="$(basename "$BACKUP_PARTIAL" .partial)"
BACKUP_FILE="$MODE_ROOT/db/dumps/${partial_name#.}.dump"
"$DB_SCRIPT_DIR/dump.sh" --mode "$MODE" "$BACKUP_PARTIAL"
"${COMPOSE[@]}" exec -T postgres pg_restore -l < "$BACKUP_PARTIAL" >/dev/null
chmod 600 "$BACKUP_PARTIAL"
mv "$BACKUP_PARTIAL" "$BACKUP_FILE"
BACKUP_PARTIAL=""
# Each conversion commits on its own. If a later one fails, the database
# rests on the previous target and a retry selects only the remaining pairs.
for archive_id in "${ARCHIVE_IDS[@]}"; do
  pair="$(archive_dir "$archive_id")"
  "$DB_SCRIPT_DIR/squash-migrations.sh" convert --mode "$MODE" \
    --source "$pair/source" --target "$pair/target" \
    --apply --offline --backup "$BACKUP_FILE"
  "${COMPOSE[@]}" run --rm -T --no-deps "${ARTIFACT_MOUNTS[@]}" \
    server node /app/ops/scripts/db/migration-artifacts.mjs complete --home /rainver --id "$archive_id"
done
if [[ "$LATER_MIGRATIONS" -gt 0 ]]; then
  # Applications are stopped, so a maintenance migration is permitted here;
  # the pre-squash dump above is the recovery point for this whole sequence.
  "${COMPOSE[@]}" run --rm -T --no-deps \
    -e SERVER_MIGRATIONS_DIR=/app/server/migrations \
    server node dist/db/migrateCli.js up
fi

# Recreate only the server to use the verified target image. Restore only
# services that were running; a deliberately stopped app stays stopped.
OTHER_APPS=()
for service in "${APPS[@]}"; do
  if [[ "$service" == server ]]; then
    "${COMPOSE[@]}" up -d --no-deps server
  else
    OTHER_APPS+=("$service")
  fi
done
if [[ ${#OTHER_APPS[@]} -gt 0 ]]; then
  "${COMPOSE[@]}" start "${OTHER_APPS[@]}"
fi
stopped=false
rm -f "$APPS_FILE"
rmdir "$ACTIVE_DIR"
echo "Migration cutover complete. Backup: $BACKUP_FILE"
