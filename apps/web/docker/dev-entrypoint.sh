#!/bin/sh
set -eu

cd /repo/apps/web

STAMP_DIR="node_modules/.cache/rainver"
STAMP_FILE="$STAMP_DIR/package-inputs.sha256"

dependency_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml \
      /repo/packages/protocol/package.json /repo/server/package.json package.json \
      | sha256sum | awk '{print $1}'
    return
  fi
  shasum -a 256 /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml \
    /repo/packages/protocol/package.json /repo/server/package.json package.json \
    | shasum -a 256 | awk '{print $1}'
}

if [ ! -f package.json ] || [ ! -f /repo/pnpm-lock.yaml ]; then
  echo "[web-dev] package.json and /repo/pnpm-lock.yaml are required" >&2
  exit 1
fi

current_hash="$(dependency_hash)"
installed_hash="$(cat "$STAMP_FILE" 2>/dev/null || true)"
install_reason=""

if [ ! -d node_modules ]; then
  install_reason="node_modules is missing"
elif [ ! -x node_modules/.bin/vite ]; then
  install_reason="node_modules is incomplete"
elif [ "$installed_hash" != "$current_hash" ]; then
  install_reason="package inputs changed"
fi

if [ -n "$install_reason" ]; then
  echo "[web-dev] $install_reason; running pnpm install"
  pnpm --dir /repo install --frozen-lockfile \
    --filter @rainver/protocol \
    --filter @rainver/web
  mkdir -p "$STAMP_DIR"
  printf '%s\n' "$current_hash" > "$STAMP_FILE"
else
  echo "[web-dev] node_modules is current"
fi

exec "$@"
