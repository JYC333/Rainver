#!/usr/bin/env bash
# Standalone production installer. Distributed as a release asset; no checkout required.
# Usage: install-prod.sh [--sha <40-character commit SHA>]
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

selected_sha=""
pin_requested=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      [[ $# -ge 2 ]] || die "--sha needs a commit SHA"
      selected_sha="$2"
      pin_requested=1
      shift 2
      ;;
    -h|--help)
      echo "Usage: install-prod.sh [--sha <40-character commit SHA>]"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

for command_name in curl tar sha256sum install mktemp stat; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

data_root="${RAINVER_ROOT:-$HOME/.rainver-data}"
data_root="${data_root/#\~/$HOME}"
install_root="${RAINVER_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/rainver-prod}"
bin_dir="${RAINVER_BIN_DIR:-$HOME/.local/bin}"
bin_dir="${bin_dir/#\~/$HOME}"
[[ "$data_root" == /* && "$install_root" == /* && "$bin_dir" == /* ]] || die "RAINVER_ROOT, RAINVER_INSTALL_DIR and RAINVER_BIN_DIR must be absolute paths"
export RAINVER_ROOT="$data_root"

private_dir() {
  local path="$1"
  if install -d -m 700 "$path"; then return 0; fi
  echo "ERROR: cannot set private permissions on $path as $(id -un)." >&2
  [[ ! -e "$path" ]] || stat -c '       Current owner: %U:%G; permissions: %a' "$path" >&2 || true
  echo "       Fix this directory's ownership on the host; do not recursively chown PostgreSQL data." >&2
  exit 1
}

# Fail on the host ownership problem before downloading anything.
private_dir "$data_root"
private_dir "$data_root/prod"
private_dir "$install_root"
private_dir "$install_root/releases"

release_base="${RAINVER_RELEASE_BASE_URL:-https://github.com/jyc333/rainver/releases/download}"
scratch="$(mktemp -d)"
stage=""
next_link=""
cli_stage=""
cleanup() {
  rm -rf "$scratch"
  [[ -z "$stage" ]] || rm -rf "$stage"
  [[ -z "$next_link" ]] || rm -f "$next_link"
  [[ -z "$cli_stage" ]] || rm -f "$cli_stage"
}
trap cleanup EXIT

if [[ -z "$selected_sha" ]]; then
  curl -fLsS --retry 3 "$release_base/prod-stable/BUILD_ID" -o "$scratch/BUILD_ID"
  selected_sha="$(tr -d '\r\n' < "$scratch/BUILD_ID")"
fi
[[ "$selected_sha" =~ ^[0-9a-f]{40}$ ]] || die "invalid release commit SHA"

release_url="$release_base/prod-sha-$selected_sha"
curl -fLsS --retry 3 "$release_url/rainver-prod.tar.gz" -o "$scratch/rainver-prod.tar.gz"
curl -fLsS --retry 3 "$release_url/rainver-prod.tar.gz.sha256" -o "$scratch/rainver-prod.tar.gz.sha256"
(cd "$scratch" && sha256sum --check --status rainver-prod.tar.gz.sha256) || die "release checksum mismatch"

release_dir="$install_root/releases/$selected_sha"
if [[ ! -d "$release_dir" ]]; then
  stage="$(mktemp -d "$install_root/releases/.stage.XXXXXXXX")"
  tar -xzf "$scratch/rainver-prod.tar.gz" -C "$stage"
  [[ -f "$stage/BUILD_ID" ]] || die "release is missing BUILD_ID"
  [[ "$(tr -d '\r\n' < "$stage/BUILD_ID")" == "$selected_sha" ]] || die "release commit does not match archive"
  [[ -x "$stage/ops/scripts/start.sh" && -x "$stage/ops/scripts/rainver" && -f "$stage/ops/compose/docker-compose.prod.yml" ]] || die "incomplete production bundle"
  mv "$stage" "$release_dir"
  stage=""
fi
[[ -x "$release_dir/ops/scripts/rainver" ]] || die "installed production bundle has no CLI"

# Do not activate a new release if its command would overwrite another program.
mkdir -p "$bin_dir"
if [[ -e "$bin_dir/rainver" || -L "$bin_dir/rainver" ]] \
    && ! grep -Fq '# Rainver production CLI launcher (managed by install-prod.sh).' "$bin_dir/rainver"; then
  die "$bin_dir/rainver already exists and is not managed by this installer"
fi

[[ ! -e "$install_root/current" || -L "$install_root/current" ]] || die "$install_root/current is not a symlink"
next_link="$install_root/.current.$$"
ln -s "releases/$selected_sha" "$next_link"
mv -Tf "$next_link" "$install_root/current"
next_link=""
echo "Installed production scripts for $selected_sha at $install_root/current"

# Keep the command stable while current/ changes atomically between releases.
# The launcher records non-default roots so later shells manage this instance.
cli_stage="$(mktemp "$bin_dir/.rainver.XXXXXXXX")"
printf '#!/usr/bin/env bash\n# Rainver production CLI launcher (managed by install-prod.sh).\nexport RAINVER_ROOT=%q\nexport RAINVER_INSTALL_DIR=%q\nexport RAINVER_BIN_DIR=%q\nexec %q "$@"\n' \
  "$data_root" "$install_root" "$bin_dir" "$install_root/current/ops/scripts/rainver" > "$cli_stage"
chmod 755 "$cli_stage"
mv -f "$cli_stage" "$bin_dir/rainver"
cli_stage=""
echo "Installed command: $bin_dir/rainver"
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
  echo "Add $bin_dir to PATH to run it as 'rainver' in this shell."
fi

# A pinned image needs the matching deployment scripts. The stable channel is
# allowed to move normally; the deployer reports when its surface lags.
source "$install_root/current/ops/scripts/lib/local-compose.sh"
local_compose_init prod

env_file="$data_root/prod/.env"
if [[ ! -e "$env_file" ]]; then
  if [[ "$pin_requested" == 1 ]]; then
    RAINVER_INITIAL_IMAGE_TAG="sha-$selected_sha" RAINVER_IMAGE_TAG="sha-$selected_sha" \
      "$install_root/current/ops/scripts/start.sh" --prod --detach
  else
    RAINVER_IMAGE_TAG="sha-$selected_sha" \
      "$install_root/current/ops/scripts/start.sh" --prod --detach
  fi
  exit 0
fi
image_tag="$(local_compose_setting_or_default RAINVER_IMAGE_TAG stable)"
if [[ "$pin_requested" == 1 && "$image_tag" != "sha-$selected_sha" ]]; then
  die "the requested --sha needs RAINVER_IMAGE_TAG=sha-$selected_sha in $env_file."
fi
if [[ "$image_tag" != stable && "$image_tag" != "sha-$selected_sha" ]]; then
  die "RAINVER_IMAGE_TAG=$image_tag does not match this bundle. Set it to sha-$selected_sha in $env_file, or use stable."
fi

if [[ "$image_tag" == stable ]]; then
  # Start this exact verified release, even if the stable tag moves between
  # bundle download and image pull. The .env stays on stable for later UI updates.
  RAINVER_IMAGE_TAG="sha-$selected_sha" "$install_root/current/ops/scripts/start.sh" --prod --detach
else
  "$install_root/current/ops/scripts/start.sh" --prod --detach
fi
