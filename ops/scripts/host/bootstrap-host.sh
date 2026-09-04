#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DOWNLOAD_ROOT="${RAINVER_HOST_RELEASE_DOWNLOAD_ROOT:-https://github.com/JYC333/Rainver/releases/download}"
release_channel="${RAINVER_HOST_UPDATE_CHANNEL:-stable}"
original_args=("$@")

while (($# > 0)); do
  case "$1" in
    --channel)
      if (($# < 2)); then
        echo "--channel requires stable, edge, or nightly" >&2
        exit 2
      fi
      release_channel="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done

case "$release_channel" in
  stable|edge|nightly) ;;
  *) echo "--channel must be stable, edge, or nightly" >&2; exit 2 ;;
esac

release_base_url="${RAINVER_HOST_RELEASE_BASE_URL:-$REPOSITORY_DOWNLOAD_ROOT/host-$release_channel}"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rainver-host-bootstrap.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

echo "Resolving the Rainver Host ${release_channel} installer..."
curl --fail --location --silent --show-error \
  "$release_base_url/install-host.sh" \
  --output "$temp_dir/install-host.sh"
curl --fail --location --silent --show-error \
  "$release_base_url/SHA256SUMS" \
  --output "$temp_dir/SHA256SUMS"

installer_hash="$(awk '$2 == "install-host.sh" { print $1; exit }' "$temp_dir/SHA256SUMS")"
if [[ ! "$installer_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "SHA256SUMS has no valid entry for install-host.sh." >&2
  exit 1
fi
printf '%s  %s\n' "$installer_hash" "$temp_dir/install-host.sh" | sha256sum --check --status

RAINVER_HOST_RELEASE_BASE_URL="$release_base_url" \
  /bin/bash "$temp_dir/install-host.sh" "${original_args[@]}"
