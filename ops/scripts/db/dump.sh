#!/usr/bin/env bash
# DB-only dump — write the PostgreSQL database to a portable custom-format
# archive using pg_dump. Expert tool; for a full-system backup use
# ops/scripts/system/backup.sh or the BackupService API.
#
# Dumps are written to $RAINVER_ROOT/<mode>/db/dumps/ and restore with
# ops/scripts/db/restore.sh or pg_restore.
#
# Usage:
#   ops/scripts/db/dump.sh [--mode dev|test|prod] [output.dump]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"

# ── Argument parsing (before computing mode-dependent paths) ───────────────────
OUTPUT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$OUTPUT_PATH" ]]; then OUTPUT_PATH="$1"; else
        echo "ERROR: unexpected argument: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

local_compose_init "$MODE"

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

# Validate identifiers
local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

trap 'local_compose_stop_postgres_if_started "dump"' EXIT

DUMPS_DIR="$MODE_ROOT/db/dumps"
install -d -m 700 "$DUMPS_DIR"

if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$DUMPS_DIR/dump-$(date +%Y%m%d-%H%M%S).dump"
fi

if ! local_compose_ensure_postgres_ready "dump" "$PGUSER"; then
  exit 1
fi

echo "Dumping '$PGDB' (custom format, no-owner, no-acl) to: $OUTPUT_PATH"
# -Fc — custom format (portable, selective restore, smaller than plain SQL)
# --no-owner / --no-acl — restore as any superuser without original roles/grants
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$PGUSER" -Fc --no-owner --no-acl "$PGDB" > "$OUTPUT_PATH"
chmod 600 "$OUTPUT_PATH"
echo "Dump complete: $OUTPUT_PATH ($(du -sh "$OUTPUT_PATH" | cut -f1))"
echo "Restore with: ops/scripts/db/restore.sh $OUTPUT_PATH --mode $MODE"
