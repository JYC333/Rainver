#!/usr/bin/env bash
# Health check — returns 0 if the server service is up, 1 otherwise
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MODE="${RAINVER_ENV:-dev}"
INSTANCE_ROOT="${RAINVER_HOME:-/rainver}"
COMPOSE_FILE="$REPO_ROOT/ops/compose/docker-compose.$MODE.yml"
COMPOSE_PROJECT="rainver-$MODE"
API_SERVICE="${API_SERVICE:-server}"

case "$MODE" in
    dev|test|prod) ;;
    *) echo "ERROR: RAINVER_ENV must be dev, test, or prod (got '$MODE')" >&2; exit 1 ;;
esac

if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "ERROR: compose file not found: $COMPOSE_FILE" >&2
    exit 1
fi

COMPOSE=(docker compose --env-file "$INSTANCE_ROOT/.env" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")

if RAINVER_MODE_ROOT="$INSTANCE_ROOT" "${COMPOSE[@]}" exec -T "$API_SERVICE" \
    node -e "fetch('http://localhost:8010/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
    > /dev/null 2>&1; then
    echo "$API_SERVICE: ok"
    exit 0
else
    echo "$API_SERVICE: DOWN" >&2
    exit 1
fi
