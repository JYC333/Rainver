#!/usr/bin/env bash
# Restart server + frontend containers without rebuilding
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MODE="${RAINVER_ENV:-dev}"
INSTANCE_ROOT="${RAINVER_HOME:-/rainver}"
COMPOSE_FILE="$REPO_ROOT/ops/compose/docker-compose.$MODE.yml"
COMPOSE_PROJECT="rainver-$MODE"
API_SERVICE="${API_SERVICE:-server}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-frontend}"

case "$MODE" in
    dev|test|prod) ;;
    *) echo "ERROR: RAINVER_ENV must be dev, test, or prod (got '$MODE')" >&2; exit 1 ;;
esac

if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "ERROR: compose file not found: $COMPOSE_FILE" >&2
    exit 1
fi

COMPOSE=(docker compose --env-file "$INSTANCE_ROOT/.env" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")

echo "[restart] restarting $API_SERVICE and $FRONTEND_SERVICE..."
RAINVER_MODE_ROOT="$INSTANCE_ROOT" "${COMPOSE[@]}" restart "$API_SERVICE" "$FRONTEND_SERVICE"

echo "[restart] waiting for $API_SERVICE health..."
for i in $(seq 1 20); do
    if RAINVER_MODE_ROOT="$INSTANCE_ROOT" "${COMPOSE[@]}" exec -T "$API_SERVICE" \
        node -e "fetch('http://localhost:8010/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
        > /dev/null 2>&1; then
        echo "[restart] $API_SERVICE healthy after ${i}s"
        exit 0
    fi
    sleep 1
done
echo "[restart] WARNING: $API_SERVICE did not become healthy within 20s" >&2
exit 1
