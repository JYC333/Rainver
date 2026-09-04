#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DOWNLOAD_ROOT="https://github.com/JYC333/Rainver/releases/download"
INSTALL_ROOT="${RAINVER_HOST_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/rainver-host}"
BIN_DIR="${RAINVER_HOST_BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_DIR="${RAINVER_HOST_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
CONFIG_DIR="${RAINVER_HOST_CONFIG_DIR:-$HOME/.rainver-host}"
original_args=("$@")

download_file() {
  local url="$1"
  local output="$2"
  if [[ -t 2 ]]; then
    curl --fail --location --progress-bar "$url" --output "$output"
  else
    curl --fail --location --silent --show-error "$url" --output "$output"
  fi
}

case "$INSTALL_ROOT" in
  ""|/|"$HOME") echo "Refusing unsafe installation root: $INSTALL_ROOT" >&2; exit 1 ;;
esac

auto_update="preserve"
ensure_adapters=false
resolved_installer=false
release_channel="${RAINVER_HOST_UPDATE_CHANNEL:-}"
if [[ -z "$release_channel" && -f "$INSTALL_ROOT/channel" ]]; then
  release_channel="$(tr -d '\r\n' < "$INSTALL_ROOT/channel")"
fi
release_channel="${release_channel:-stable}"

usage() {
  cat <<'EOF'
Usage: install-host.sh [--channel stable|edge|nightly] [--auto-update|--no-auto-update]
       install-host.sh --update [--channel stable|edge|nightly]

Installs the latest Linux rainver-host release and its systemd user service.
Automatic update checks are disabled unless --auto-update is supplied.
EOF
}

while (($# > 0)); do
  case "$1" in
    --update) shift ;;
    --ensure-adapters) ensure_adapters=true; shift ;;
    --resolved-installer) resolved_installer=true; shift ;;
    --channel) release_channel="${2:-}"; shift 2 ;;
    --auto-update) auto_update="enable"; shift ;;
    --no-auto-update) auto_update="disable"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$release_channel" in
  stable|edge|nightly) ;;
  *) echo "--channel must be stable, edge, or nightly" >&2; exit 2 ;;
esac
RELEASE_BASE_URL="${RAINVER_HOST_RELEASE_BASE_URL:-$REPOSITORY_DOWNLOAD_ROOT/host-$release_channel}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer currently supports Linux only." >&2
  exit 1
fi
for command_name in cmp curl find grep install sha256sum tar systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Required command not found: $command_name" >&2; exit 1; }
done
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "The systemd user manager is unavailable. Log in as the target user and ensure systemd user services are enabled." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) release_arch="x64" ;;
  aarch64|arm64) release_arch="arm64" ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rainver-host-install.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

download_file "$RELEASE_BASE_URL/install-host.sh" "$temp_dir/install-host.sh"
download_file "$RELEASE_BASE_URL/SHA256SUMS" "$temp_dir/SHA256SUMS"
installer_hash="$(awk '$2 == "install-host.sh" { print $1; exit }' "$temp_dir/SHA256SUMS")"
if [[ ! "$installer_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "SHA256SUMS has no valid entry for install-host.sh." >&2
  exit 1
fi
printf '%s  %s\n' "$installer_hash" "$temp_dir/install-host.sh" | sha256sum --check --status
if [[ "$resolved_installer" == false && -f "$0" ]] \
  && grep -q -- '--resolved-installer)' "$temp_dir/install-host.sh" \
  && ! cmp -s "$0" "$temp_dir/install-host.sh"; then
  /bin/bash "$temp_dir/install-host.sh" --resolved-installer "${original_args[@]}"
  exit $?
fi

download_and_verify() {
  local asset="$1"
  local expected_hash
  download_file "$RELEASE_BASE_URL/$asset" "$temp_dir/$asset"
  expected_hash="$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$temp_dir/SHA256SUMS")"
  if [[ ! "$expected_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "SHA256SUMS has no valid entry for $asset." >&2
    exit 1
  fi
  printf '%s  %s\n' "$expected_hash" "$temp_dir/$asset" | sha256sum --check --status
}

install_adapter_pack() {
  local asset="rainver-host-adapters-linux-${release_arch}.tar.gz"
  local unpacked="$temp_dir/unpacked-adapters"
  download_and_verify "$asset"
  mkdir -p "$unpacked"
  tar -xzf "$temp_dir/$asset" -C "$unpacked"
  local payload="$unpacked/rainver-host-adapters"
  if [[ ! -f "$payload/package.json" || ! -f "$payload/BUILD_ID" ]]; then
    echo "Downloaded adapter pack has an invalid layout." >&2
    exit 1
  fi
  local adapter_build_id
  adapter_build_id="$(tr -d '\r\n' < "$payload/BUILD_ID")"
  if [[ ! "$adapter_build_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Downloaded adapter pack has an invalid build id." >&2
    exit 1
  fi
  mkdir -p "$INSTALL_ROOT/adapters/releases"
  local previous_adapter_build_id=""
  if [[ -f "$INSTALL_ROOT/adapters/current/BUILD_ID" ]]; then
    previous_adapter_build_id="$(tr -d '\r\n' < "$INSTALL_ROOT/adapters/current/BUILD_ID")"
  fi
  local adapter_dir="$INSTALL_ROOT/adapters/releases/$adapter_build_id"
  if [[ ! -d "$adapter_dir" ]]; then mv "$payload" "$adapter_dir"; fi
  ln -s "releases/$adapter_build_id" "$INSTALL_ROOT/adapters/.current-$$"
  mv -Tf "$INSTALL_ROOT/adapters/.current-$$" "$INSTALL_ROOT/adapters/current"
  while IFS= read -r -d '' candidate; do
    candidate_id="$(basename "$candidate")"
    if [[ "$candidate_id" != "$adapter_build_id" && "$candidate_id" != "$previous_adapter_build_id" ]]; then
      rm -rf -- "$candidate"
    fi
  done < <(find "$INSTALL_ROOT/adapters/releases" -mindepth 1 -maxdepth 1 -type d -print0)
  echo "Installed Rainver Host adapters $adapter_build_id."
}

if [[ "$ensure_adapters" == true ]]; then
  install_adapter_pack
  exit 0
fi

mkdir -p "$INSTALL_ROOT/releases" "$INSTALL_ROOT/runtime" "$BIN_DIR" "$SYSTEMD_DIR" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

node_command="$(command -v node || true)"
node_major=""
if [[ -n "$node_command" ]]; then
  node_major="$("$node_command" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi
if [[ "$node_major" != "24" ]]; then
  node_asset="rainver-host-node-linux-${release_arch}.tar.gz"
  echo "No compatible system Node.js found; downloading the shared Node.js runtime..."
  download_and_verify "$node_asset"
  mkdir -p "$temp_dir/unpacked-node"
  tar -xzf "$temp_dir/$node_asset" -C "$temp_dir/unpacked-node"
  node_payload="$temp_dir/unpacked-node/rainver-host-node"
  if [[ ! -x "$node_payload/bin/node" ]]; then
    echo "Downloaded Node.js runtime has an invalid layout." >&2
    exit 1
  fi
  node_version="$("$node_payload/bin/node" --version | tr -d '\r\n')"
  node_dir="$INSTALL_ROOT/runtime/node-${node_version}-${release_arch}"
  if [[ ! -d "$node_dir" ]]; then mv "$node_payload" "$node_dir"; fi
  ln -s "$(basename "$node_dir")" "$INSTALL_ROOT/runtime/.node-current-$$"
  mv -Tf "$INSTALL_ROOT/runtime/.node-current-$$" "$INSTALL_ROOT/runtime/node-current"
  node_command="$INSTALL_ROOT/runtime/node-current/bin/node"
else
  echo "Using system Node.js: $node_command"
fi

asset="rainver-host-linux-${release_arch}.tar.gz"
echo "Downloading Rainver Host ${release_channel} for linux-${release_arch}..."
download_and_verify "$asset"

mkdir -p "$temp_dir/unpacked"
tar -xzf "$temp_dir/$asset" -C "$temp_dir/unpacked"
payload="$temp_dir/unpacked/rainver-host"
if [[ ! -f "$payload/app/dist/cli.js" || ! -f "$payload/app/dist/daemon.js" || ! -f "$payload/BUILD_ID" ]]; then
  echo "Downloaded release has an invalid layout." >&2
  exit 1
fi
build_id="$(tr -d '\r\n' < "$payload/BUILD_ID")"
if [[ ! "$build_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Downloaded release has an invalid build id." >&2
  exit 1
fi
payload_version="$("$node_command" "$payload/app/dist/cli.js" --version)"
if [[ -z "$payload_version" ]]; then
  echo "Downloaded release did not report a version." >&2
  exit 1
fi

printf '%s\n' "$release_channel" > "$INSTALL_ROOT/channel"
changed=true
previous_build_id=""
if [[ -f "$INSTALL_ROOT/current/BUILD_ID" ]]; then
  previous_build_id="$(tr -d '\r\n' < "$INSTALL_ROOT/current/BUILD_ID")"
fi
if [[ -f "$INSTALL_ROOT/current/BUILD_ID" ]] && [[ "$(tr -d '\r\n' < "$INSTALL_ROOT/current/BUILD_ID")" == "$build_id" ]]; then
  changed=false
  echo "Rainver Host ${release_channel} ($build_id) is already installed."
else
  release_dir="$INSTALL_ROOT/releases/$build_id"
  if [[ ! -d "$release_dir" ]]; then
    mv "$payload" "$release_dir"
  fi
  ln -s "releases/$build_id" "$INSTALL_ROOT/.current-$$"
  mv -Tf "$INSTALL_ROOT/.current-$$" "$INSTALL_ROOT/current"
  echo "Installed Rainver Host build $build_id."
fi

# Retain the active daemon build and one rollback build rather than
# accumulating every rolling build. Node and adapters are stored separately.
# The previous directory may still serve this daemon until its idle restart.
while IFS= read -r -d '' candidate; do
  candidate_id="$(basename "$candidate")"
  if [[ "$candidate_id" != "$build_id" && "$candidate_id" != "$previous_build_id" ]]; then
    rm -rf -- "$candidate"
  fi
done < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -print0)

if command -v codex >/dev/null 2>&1 || command -v claude >/dev/null 2>&1; then
  install_adapter_pack
fi

printf '#!/usr/bin/env bash\nexport RAINVER_HOST_INSTALL_ROOT=%q\nexport RAINVER_HOST_UPDATE_CHANNEL=%q\nexport RAINVER_HOST_ADAPTER_ROOT=%q\nexec %q %q "$@"\n' \
  "$INSTALL_ROOT" \
  "$release_channel" \
  "$INSTALL_ROOT/adapters/current" \
  "$node_command" \
  "$INSTALL_ROOT/current/app/dist/cli.js" > "$BIN_DIR/rainver-host"
chmod 755 "$BIN_DIR/rainver-host"

daemon_launcher="$INSTALL_ROOT/rainver-host-daemon"
printf '#!/usr/bin/env bash\nexport RAINVER_HOST_INSTALL_ROOT=%q\nexport RAINVER_HOST_UPDATE_CHANNEL=%q\nexport RAINVER_HOST_ADAPTER_ROOT=%q\nexec %q %q\n' \
  "$INSTALL_ROOT" \
  "$release_channel" \
  "$INSTALL_ROOT/adapters/current" \
  "$node_command" \
  "$INSTALL_ROOT/current/app/dist/daemon.js" > "$daemon_launcher"
chmod 755 "$daemon_launcher"

installed_script="$INSTALL_ROOT/install-host.sh"
install -m 755 "$temp_dir/install-host.sh" "$installed_script"

service_env="${XDG_CONFIG_HOME:-$HOME/.config}/rainver-host/service.env"
mkdir -p "$(dirname "$service_env")"
if [[ ! -f "$service_env" ]]; then
  escaped_path="${PATH//\\/\\\\}"; escaped_path="${escaped_path//\"/\\\"}"
  escaped_config="${CONFIG_DIR//\\/\\\\}"; escaped_config="${escaped_config//\"/\\\"}"
  printf 'PATH="%s"\nRAINVER_HOST_CONFIG_DIR="%s"\n' "$escaped_path" "$escaped_config" > "$service_env"
  chmod 600 "$service_env"
fi

unit_exec="${daemon_launcher//\\/\\\\}"; unit_exec="${unit_exec//\"/\\\"}"
unit_env="${service_env//\\/\\\\}"; unit_env="${unit_env//\"/\\\"}"
cat > "$SYSTEMD_DIR/rainver-host.service" <<EOF
[Unit]
Description=Rainver execution host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile="$unit_env"
ExecStart="$unit_exec"
Restart=on-failure
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF

if [[ "$auto_update" == "enable" ]]; then
  updater_exec="${installed_script//\\/\\\\}"; updater_exec="${updater_exec//\"/\\\"}"
  cat > "$SYSTEMD_DIR/rainver-host-update.service" <<EOF
[Unit]
Description=Update Rainver execution host to the latest release

[Service]
Type=oneshot
ExecStart="$updater_exec" --update
EOF
  cat > "$SYSTEMD_DIR/rainver-host-update.timer" <<'EOF'
[Unit]
Description=Check for a Rainver Host update

[Timer]
OnBootSec=10m
OnUnitActiveSec=6h
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
elif [[ "$auto_update" == "disable" ]]; then
  systemctl --user disable --now rainver-host-update.timer >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_DIR/rainver-host-update.service" "$SYSTEMD_DIR/rainver-host-update.timer"
fi

systemctl --user daemon-reload
if [[ "$auto_update" == "enable" ]]; then
  systemctl --user enable --now rainver-host-update.timer
fi

if systemctl --user is-active --quiet rainver-host.service; then
  if [[ "$changed" == true ]]; then
    touch "$CONFIG_DIR/update-restart-requested"
    echo "The service will restart into the new build as soon as its active Runs finish."
  fi
elif [[ -f "$CONFIG_DIR/config.json" ]]; then
  rm -f "$CONFIG_DIR/update-restart-requested"
  systemctl --user enable --now rainver-host.service
fi

echo "Rainver Host: $payload_version"
echo "Update channel: $release_channel"
if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  echo "Next: rainver-host register --server <Rainver URL> --code <pairing-code>"
else
  echo "Service status: systemctl --user status rainver-host"
  echo "Service logs:   journalctl --user -u rainver-host -f"
fi
if [[ "$auto_update" == "enable" ]]; then
  echo "Automatic latest updates: enabled"
elif [[ "$auto_update" == "disable" ]]; then
  echo "Automatic latest updates: disabled"
fi
