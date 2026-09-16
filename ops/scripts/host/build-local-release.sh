#!/usr/bin/env bash
set -euo pipefail

# Build the same self-contained Host archives as the release workflow, but
# keep the release directory local so install-host.sh can consume it through
# RAINVER_HOST_RELEASE_BASE_URL=file://... . This is intentionally a developer
# helper: it produces a release for the current Linux architecture and does not
# publish anything or alter the Git worktree.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OUTPUT_DIR=""
INSTALL_AFTER_BUILD=false
RELEASE_CHANNEL="edge"

usage() {
  cat <<'EOF'
Usage: build-local-release.sh [--output DIR] [--install] [--channel edge|stable|nightly]

Build the current checkout into a local Rainver Host release directory.

Options:
  --output DIR       Keep release assets in DIR (default: a new directory under /tmp)
  --install          Install the local release with install-host.sh after building
  --channel CHANNEL  Label the local install (default: edge)
  --help             Show this help

Examples:
  ./ops/scripts/host/build-local-release.sh --install
  ./ops/scripts/host/build-local-release.sh --output /tmp/rainver-host-release
EOF
}

while (($# > 0)); do
  case "$1" in
    --output)
      if (($# < 2)) || [[ -z "$2" ]]; then
        echo "--output requires a directory" >&2
        exit 2
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --install)
      INSTALL_AFTER_BUILD=true
      shift
      ;;
    --channel)
      if (($# < 2)) || [[ -z "$2" ]]; then
        echo "--channel requires edge, stable, or nightly" >&2
        exit 2
      fi
      RELEASE_CHANNEL="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$RELEASE_CHANNEL" in
  edge|stable|nightly) ;;
  *) echo "--channel must be edge, stable, or nightly" >&2; exit 2 ;;
esac

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Local Host packaging currently supports Linux only." >&2
  exit 1
fi

for command_name in git node pnpm sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command not found: $command_name" >&2
    exit 1
  }
done

node_command="$(command -v node)"
node_major="$("$node_command" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ "$node_major" != "24" ]]; then
  echo "Local Host packaging requires Node.js 24.x; found $("$node_command" --version 2>/dev/null || echo unknown)." >&2
  echo "Activate the repository's Node version from .nvmrc and try again." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) release_arch="x64" ;;
  aarch64|arm64) release_arch="arm64" ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rainver-host-local-release.XXXXXX")"
else
  if [[ -e "$OUTPUT_DIR" ]]; then
    echo "Refusing to overwrite an existing output directory: $OUTPUT_DIR" >&2
    echo "Choose a new path or remove the old local release explicitly." >&2
    exit 1
  fi
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/rainver-host-local-build.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT

build_id="local-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)-$$"
deploy_dir="$work_dir/deploy"
package_dir="$work_dir/package"
host_payload="$package_dir/rainver-host"
adapter_payload="$package_dir/rainver-host-adapters"
node_payload="$package_dir/rainver-host-node"

echo "Building Rainver Host from $REPO_ROOT..."
echo "  build id: $build_id"
echo "  architecture: linux-$release_arch"

# Keep this order in sync with .github/workflows/host-daemon-release.yml. The
# daemon's deployed node_modules contain the built workspace dependencies, so a
# Host build must rebuild those packages before pnpm deploy.
(
  cd "$REPO_ROOT"
  pnpm --filter @rainver/protocol build
  pnpm --filter @rainver/agent-cli build
  pnpm --filter @rainver/folder-read build
  pnpm --filter @rainver/outbound-guard build
  pnpm --filter @rainver/host-daemon build
  pnpm --filter @rainver/host-daemon deploy --prod --no-optional "$deploy_dir/app"
  pnpm --filter @rainver/host-adapters deploy --prod --no-optional "$deploy_dir/adapters"
)

mkdir -p "$host_payload/app" "$adapter_payload" "$node_payload/bin"
cp -a "$deploy_dir/app/." "$host_payload/app/"
cp -a "$deploy_dir/adapters/." "$adapter_payload/"
printf '%s\n' "$build_id" > "$host_payload/BUILD_ID"
printf '%s\n' "$build_id" > "$adapter_payload/BUILD_ID"
cp -L "$node_command" "$node_payload/bin/node"

cp "$SCRIPT_DIR/install-host.sh" "$OUTPUT_DIR/install-host.sh"
chmod 755 "$OUTPUT_DIR/install-host.sh"
printf '%s\n' "$build_id" > "$OUTPUT_DIR/BUILD_ID"

tar -czf "$OUTPUT_DIR/rainver-host-linux-$release_arch.tar.gz" \
  -C "$package_dir" rainver-host
tar -czf "$OUTPUT_DIR/rainver-host-adapters-linux-$release_arch.tar.gz" \
  -C "$package_dir" rainver-host-adapters
tar -czf "$OUTPUT_DIR/rainver-host-node-linux-$release_arch.tar.gz" \
  -C "$package_dir" rainver-host-node

(
  cd "$OUTPUT_DIR"
  sha256sum \
    BUILD_ID \
    install-host.sh \
    "rainver-host-linux-$release_arch.tar.gz" \
    "rainver-host-adapters-linux-$release_arch.tar.gz" \
    "rainver-host-node-linux-$release_arch.tar.gz" \
    > SHA256SUMS
)

echo "Local Host release ready: $OUTPUT_DIR"
echo "Install it with:"
echo "  RAINVER_HOST_RELEASE_BASE_URL=file://$OUTPUT_DIR bash $SCRIPT_DIR/install-host.sh --channel $RELEASE_CHANNEL --no-auto-update"

if [[ "$INSTALL_AFTER_BUILD" == true ]]; then
  RAINVER_HOST_RELEASE_BASE_URL="file://$OUTPUT_DIR" \
    bash "$SCRIPT_DIR/install-host.sh" --channel "$RELEASE_CHANNEL" --no-auto-update
fi
