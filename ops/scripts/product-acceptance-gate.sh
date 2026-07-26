#!/usr/bin/env bash
# Deterministic product-acceptance gate. Real providers and vendor CLIs are not
# contacted; their boundaries are covered by deterministic test adapters.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Product acceptance requires a working Docker runtime so real PostgreSQL tests cannot be skipped." >&2
  exit 2
fi

run_package() {
  local directory="$1"
  shift
  (
    cd "$REPO_ROOT/$directory"
    COREPACK_ENABLE_AUTO_PIN=0 "$@"
  )
}

echo "==> Protocol contracts"
run_package packages/protocol npm run typecheck
run_package packages/protocol npm test
run_package packages/protocol npm run build

echo "==> Database schema"
run_package server npm run schema:check

echo "==> Server"
run_package server npm run typecheck
run_package server npm test
run_package server npm run build

echo "==> Web"
run_package apps/web npm run typecheck
run_package apps/web npm test
run_package apps/web npm run build

echo "Product acceptance deterministic gate passed."
