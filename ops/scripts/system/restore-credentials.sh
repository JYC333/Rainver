#!/usr/bin/env bash
# Restore a credential-only archive created by backup-credentials.sh.
# This operation is separate from normal data/database restore by design.
#
# Usage:
#   ops/scripts/system/restore-credentials.sh <archive.tar.gz> [--mode dev|test|prod] [--force]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
ARCHIVE=""
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -n "$ARCHIVE" ]]; then echo "ERROR: unexpected argument: $1" >&2; exit 1; fi
      ARCHIVE="$1"; shift ;;
  esac
done

local_compose_init "$MODE"

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "ERROR: credential archive not found: ${ARCHIVE:-<missing>}" >&2
  exit 1
fi

running_services="$("${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null)" || {
  echo "ERROR: unable to inspect running compose services for mode '$MODE'" >&2
  exit 1
}
for service in frontend server deployer; do
  if [[ $'\n'"$running_services"$'\n' == *$'\n'"$service"$'\n'* ]]; then
    echo "ERROR: app service '$service' is running; stop app services before credential restore" >&2
    exit 1
  fi
done

staging="$(mktemp -d -t rainver-credential-restore-XXXXXX)"
trap 'rm -rf "$staging"' EXIT
python3 "$SCRIPT_DIR/safe_extract.py" "$ARCHIVE" "$staging" \
  secrets credential_backup_manifest.json

python3 - "$staging/credential_backup_manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    manifest = json.load(fh)
if manifest.get("backup_format") != "rainver-credentials.v1":
    raise SystemExit("credential archive has an incompatible backup_format")
if manifest.get("included_paths") != ["secrets/"]:
    raise SystemExit("credential archive has unexpected included_paths")
PY

if [[ ! -d "$staging/secrets" ]]; then
  echo "ERROR: credential archive is missing secrets/" >&2
  exit 1
fi
if [[ -e "$MODE_ROOT/secrets" && "$FORCE" != "true" ]]; then
  echo "ERROR: $MODE_ROOT/secrets already exists; re-run with --force to replace it" >&2
  exit 1
fi

install -d -m 700 "$MODE_ROOT"
new_secrets="$(mktemp -d "$MODE_ROOT/.secrets-restore-new-XXXXXX")"
cleanup_swap() {
  [[ ! -e "$new_secrets" ]] || rm -rf "$new_secrets"
}
trap 'cleanup_swap; rm -rf "$staging"' EXIT
cp -a "$staging/secrets/." "$new_secrets/"
find "$new_secrets" -type d -exec chmod 700 {} +
find "$new_secrets" -type f -exec chmod 600 {} +

python3 "$SCRIPT_DIR/atomic_ops.py" replace-directory "$new_secrets" "$MODE_ROOT/secrets"
new_secrets=""
echo "[credential-restore] restored credential state to $MODE_ROOT/secrets"
