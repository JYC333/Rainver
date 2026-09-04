#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DOWNLOAD_ROOT="https://github.com/JYC333/Rainver/releases/download"
INSTALL_ROOT="${RAINVER_HOST_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/rainver-host}"
BIN_DIR="${RAINVER_HOST_BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_DIR="${RAINVER_HOST_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
CONFIG_DIR="${RAINVER_HOST_CONFIG_DIR:-$HOME/.rainver-host}"

case "$INSTALL_ROOT" in
  ""|/|"$HOME") echo "Refusing unsafe installation root: $INSTALL_ROOT" >&2; exit 1 ;;
esac

auto_update="preserve"
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
for command_name in curl find install sha256sum tar systemctl; do
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

asset="rainver-host-linux-${release_arch}.tar.gz"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rainver-host-install.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

echo "Downloading Rainver Host ${release_channel} for linux-${release_arch}..."
curl --fail --location --silent --show-error "$RELEASE_BASE_URL/$asset" --output "$temp_dir/$asset"
curl --fail --location --silent --show-error "$RELEASE_BASE_URL/install-host.sh" --output "$temp_dir/install-host.sh"
curl --fail --location --silent --show-error "$RELEASE_BASE_URL/SHA256SUMS" --output "$temp_dir/SHA256SUMS"
expected_hash="$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$temp_dir/SHA256SUMS")"
if [[ ! "$expected_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "SHA256SUMS has no valid entry for $asset." >&2
  exit 1
fi
printf '%s  %s\n' "$expected_hash" "$temp_dir/$asset" | sha256sum --check --status
installer_hash="$(awk '$2 == "install-host.sh" { print $1; exit }' "$temp_dir/SHA256SUMS")"
if [[ ! "$installer_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "SHA256SUMS has no valid entry for install-host.sh." >&2
  exit 1
fi
printf '%s  %s\n' "$installer_hash" "$temp_dir/install-host.sh" | sha256sum --check --status

mkdir -p "$temp_dir/unpacked"
tar -xzf "$temp_dir/$asset" -C "$temp_dir/unpacked"
payload="$temp_dir/unpacked/rainver-host"
if [[ ! -x "$payload/node/bin/node" || ! -f "$payload/app/dist/cli.js" || ! -f "$payload/BUILD_ID" ]]; then
  echo "Downloaded release has an invalid layout." >&2
  exit 1
fi
build_id="$(tr -d '\r\n' < "$payload/BUILD_ID")"
if [[ ! "$build_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Downloaded release has an invalid build id." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT/releases" "$BIN_DIR" "$SYSTEMD_DIR" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
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

# ACP adapters include large native vendor executables. Retain the active
# build and one rollback build, rather than accumulating every rolling build.
# The previous directory may still serve this daemon until its idle restart.
while IFS= read -r -d '' candidate; do
  candidate_id="$(basename "$candidate")"
  if [[ "$candidate_id" != "$build_id" && "$candidate_id" != "$previous_build_id" ]]; then
    rm -rf -- "$candidate"
  fi
done < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -print0)

printf '#!/usr/bin/env bash\nexport RAINVER_HOST_INSTALL_ROOT=%q\nexport RAINVER_HOST_UPDATE_CHANNEL=%q\nexec %q %q "$@"\n' \
  "$INSTALL_ROOT" \
  "$release_channel" \
  "$INSTALL_ROOT/current/node/bin/node" \
  "$INSTALL_ROOT/current/app/dist/cli.js" > "$BIN_DIR/rainver-host"
chmod 755 "$BIN_DIR/rainver-host"

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

unit_exec="${BIN_DIR//\\/\\\\}/rainver-host"; unit_exec="${unit_exec//\"/\\\"}"
unit_env="${service_env//\\/\\\\}"; unit_env="${unit_env//\"/\\\"}"
cat > "$SYSTEMD_DIR/rainver-host.service" <<EOF
[Unit]
Description=Rainver execution host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile="$unit_env"
ExecStart="$unit_exec" run
Restart=always
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

echo "Rainver Host: $($BIN_DIR/rainver-host --version)"
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
