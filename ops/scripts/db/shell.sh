#!/usr/bin/env bash
# Open an interactive psql shell against the running PostgreSQL container.
#
# Usage:
#   ops/scripts/db/shell.sh [--mode dev|test|prod]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"

# ── Argument parsing (before computing mode-dependent paths) ───────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

if ! "${COMPOSE[@]}" exec -T postgres true 2>/dev/null; then
  echo "ERROR: postgres service is not running for mode '$MODE'." >&2
  echo "       Start postgres only:" >&2
  echo "       $COMPOSE_HINT up -d postgres" >&2
  exit 1
fi

echo "Connecting to PostgreSQL ($PGDB) as $PGUSER (mode: $MODE)..."
"${COMPOSE[@]}" exec postgres \
  psql -U "$PGUSER" "$PGDB"
