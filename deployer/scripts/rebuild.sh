#!/usr/bin/env bash
# Rebuild and restart server + frontend from a checkout. dev/test build from a
# checkout, which the deployer sidecar does not mount — run those on the host.
# prod never rebuilds: a production instance changes images only through the
# instance update, and this script refuses before touching an image.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
MODE="${RAINVER_ENV:-dev}"
INSTANCE_ROOT="${RAINVER_HOME:?RAINVER_HOME must be the mode root this container mounts}"
# Compose volume sources are resolved by the host daemon, so it must be given
# the host path, not this container's view of it.
HOST_MODE_ROOT="${RAINVER_HOST_MODE_ROOT:?RAINVER_HOST_MODE_ROOT must be the host path of the mode root}"
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

echo "[rebuild] repo=$REPO_ROOT"
if [[ "$MODE" == "prod" ]]; then
    # A production instance changes images only through the instance update
    # (ADR 0020): drain, backup, migrate, recreate, in that order, reported
    # stage by stage. Pulling and recreating two services here would skip the
    # dump and the migration and leave the stack half on a new build. Refused
    # before any image is pulled; the guidance names the real path.
    echo "ERROR: rebuild is not a production operation; no image was pulled or replaced." >&2
    echo "       Update the instance instead: 'rainver update' on a standalone host, or" >&2
    echo "       'git pull && ./ops/scripts/start.sh --prod --detach' on a checkout deployment." >&2
    echo "       Both run the deployer update stages (deployer/scripts/update.sh)." >&2
    exit 1
fi
if [[ ! -f "$REPO_ROOT/server/Dockerfile" ]]; then
    echo "ERROR: $MODE images are built from the checkout, which this container does not mount." >&2
    echo "       Build on the host instead: ops/scripts/start.sh --$MODE --build" >&2
    exit 1
fi
echo "[rebuild] building $API_SERVICE and $FRONTEND_SERVICE images..."
RAINVER_MODE_ROOT="$HOST_MODE_ROOT" "${COMPOSE[@]}" build "$API_SERVICE" "$FRONTEND_SERVICE"

echo "[rebuild] restarting $API_SERVICE and $FRONTEND_SERVICE..."
RAINVER_MODE_ROOT="$HOST_MODE_ROOT" "${COMPOSE[@]}" up -d --no-deps "$API_SERVICE" "$FRONTEND_SERVICE"

echo "[rebuild] waiting for $API_SERVICE health..."
for i in $(seq 1 30); do
    if RAINVER_MODE_ROOT="$HOST_MODE_ROOT" "${COMPOSE[@]}" exec -T "$API_SERVICE" \
        node -e "fetch('http://localhost:8010/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
        > /dev/null 2>&1; then
        echo "[rebuild] $API_SERVICE healthy after ${i}s"
        exit 0
    fi
    sleep 1
done
echo "[rebuild] WARNING: $API_SERVICE did not become healthy within 30s" >&2
exit 1
