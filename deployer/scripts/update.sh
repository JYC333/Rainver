#!/usr/bin/env bash
# One stage of an instance update (ADR 0020 §5). The Python pull loop decides
# the order and reports each stage; this script only performs one.
#
#   update.sh pull      — pull the images for the configured tag
#   update.sh migrate   — pre-migration dump, then migrations (ops/scripts/db/migrate.sh)
#   update.sh recreate  — recreate server, frontend, sandbox-runner
#   update.sh health    — wait for the server to report healthy
#
# The `drain` stage is not here: waiting for the server to report no running
# Runs is an HTTP poll on the internal channel, and the pull loop already holds
# that connection and token.
#
# This script never names the deployer service: the deployer does not update
# itself (B44), and a compose command issued from inside this container would
# resolve the relative ops mount against a path the host does not have.
set -euo pipefail

STAGE="${1:?usage: update.sh pull|migrate|recreate|health}"
MODE="${RAINVER_ENV:-dev}"

# Checked before anything is sourced: dev and test build their images from a
# checkout this container does not mount, so there is nothing here to update.
if [[ "$MODE" != "prod" ]]; then
    echo "ERROR: an instance update is a production operation." >&2
    echo "       $MODE builds its images from a checkout; update it on the host with ops/scripts/start.sh." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# The shared library owns compose/env resolution and the guard that a caller's
# host mode root and its own mode root are the same directory — without it this
# container could read .env from one place and mount another.
# shellcheck source=../../ops/scripts/lib/local-compose.sh
source "$REPO_ROOT/ops/scripts/lib/local-compose.sh"
local_compose_init "$MODE"

# The services an update recreates. The deployer is deliberately absent.
UPDATED_SERVICES=(server frontend sandbox-runner)

case "$STAGE" in
    pull)
        echo "[update] pulling ${UPDATED_SERVICES[*]}..."
        "${COMPOSE[@]}" pull "${UPDATED_SERVICES[@]}"
        # Asked here rather than at `migrate`, because this is the last moment
        # nothing has moved: the new image is on disk and its migration chain
        # can be read, but no Run has been drained and no service recreated.
        # A migration marked maintenance removes something the *running*
        # release still reads, so a UI update cannot apply it (ADR 0016 §10); the operator runs the offline command instead.
        echo "[update] checking for a migration that needs an offline upgrade..."
        pending="$("${COMPOSE[@]}" run --rm -T --no-deps \
            -e SERVER_MIGRATIONS_DIR=/app/server/migrations \
            server node dist/db/migrateCli.js maintenance-pending)" && status=0 || status=$?
        if [[ "${status:-0}" -eq 10 ]]; then
            echo "[update] this release cannot be installed from the UI:" >&2
            echo "$pending" | sed 's/^/[update]   /' >&2
            echo "[update] it removes something the running version still reads." >&2
            echo "[update] run on the server: ./ops/scripts/start.sh --$MODE --maintenance" >&2
            exit 1
        elif [[ "${status:-0}" -ne 0 ]]; then
            # Same rule as migrate.sh: a gate that could not be asked is not
            # clearance. Refusing here — before anything has been drained or
            # recreated — is what makes this the cheapest place to stop.
            echo "[update] could not determine whether this release needs an offline upgrade" >&2
            echo "[update] (migration runner exited ${status:-0}); stopping before anything moves." >&2
            echo "$pending" | sed 's/^/[update]   /' >&2
            exit 1
        fi
        ;;
    migrate)
        # migrate.sh takes the required pre-migration dump and refuses to
        # migrate on a failed one, so backup and migrate are one stage here.
        echo "[update] dumping and migrating..."
        "$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE"
        ;;
    recreate)
        echo "[update] recreating ${UPDATED_SERVICES[*]}..."
        "${COMPOSE[@]}" up -d --no-deps "${UPDATED_SERVICES[@]}"
        ;;
    health)
        echo "[update] waiting for server health..."
        local_compose_wait_service_healthy server "the instance update" 120
        echo "[update] server healthy"
        ;;
    *)
        echo "ERROR: unknown stage '$STAGE'" >&2
        exit 1
        ;;
esac
