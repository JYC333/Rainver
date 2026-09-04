#!/usr/bin/env bash
# Create a separate sensitive recovery archive containing RAINVER_HOME/secrets
# and a review-only snapshot of the mode .env. This archive is intentionally
# never created by BackupService or backup.sh. Stop app writers first so CLI
# login state, the master key, and deployment secrets are copied consistently.
#
# Usage:
#   ops/scripts/system/backup-credentials.sh [--mode dev|test|prod] [--output DIR] [--force-running]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
OUTPUT_DIR=""
FORCE_RUNNING=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --force-running) FORCE_RUNNING=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"

if [[ ! -d "$MODE_ROOT/secrets" ]]; then
  echo "ERROR: credential directory not found: $MODE_ROOT/secrets" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  echo "ERROR: mode environment file is missing or not a regular file: $ENV_FILE" >&2
  exit 1
fi

running_services="$("${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null)" || {
  echo "ERROR: unable to inspect running compose services for mode '$MODE'" >&2
  exit 1
}
running=()
for service in frontend server deployer; do
  if [[ $'\n'"$running_services"$'\n' == *$'\n'"$service"$'\n'* ]]; then
    running+=("$service")
  fi
done
if (( ${#running[@]} > 0 )) && [[ "$FORCE_RUNNING" != "true" ]]; then
  echo "ERROR: app service(s) still running for mode '$MODE': ${running[*]}" >&2
  echo "       Stop app services before copying credential state." >&2
  exit 1
fi
if (( ${#running[@]} > 0 )); then
  echo "WARNING: credential state may change while being copied: ${running[*]}" >&2
fi

[[ -z "$OUTPUT_DIR" ]] && OUTPUT_DIR="$MODE_ROOT/credential-backups"
install -d -m 700 "$OUTPUT_DIR"

timestamp="$(date -u +%Y%m%d-%H%M%S)"
archive="$OUTPUT_DIR/credentials-$timestamp.tar.gz"
staging="$(mktemp -d -t rainver-credential-backup-XXXXXX)"
archive_tmp="$(mktemp "$OUTPUT_DIR/.credentials-$timestamp-XXXXXX.tmp")"
chmod 600 "$archive_tmp"
verify_staging=""
trap 'rm -rf "$staging"; [[ -z "$verify_staging" ]] || rm -rf "$verify_staging"; rm -f "$archive_tmp"' EXIT

cp -a "$MODE_ROOT/secrets" "$staging/secrets"
install -m 600 "$ENV_FILE" "$staging/instance.env"
python3 - "$staging/credential_backup_manifest.json" "$MODE_ROOT" <<'PY'
import json
import sys
from datetime import datetime, timezone

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump({
        "backup_format": "rainver-credentials.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_root": sys.argv[2],
        "included_paths": ["secrets/", "instance.env"],
    }, fh, indent=2)
    fh.write("\n")
PY

tar -czf "$archive_tmp" -C "$staging" .
tar -tzf "$archive_tmp" >/dev/null
verify_staging="$(mktemp -d -t rainver-credential-backup-verify-XXXXXX)"
python3 "$SCRIPT_DIR/safe_extract.py" "$archive_tmp" "$verify_staging" \
  secrets instance.env credential_backup_manifest.json
rm -rf "$verify_staging"
verify_staging=""
archive="$(python3 "$SCRIPT_DIR/atomic_ops.py" publish "$archive_tmp" "$archive")"
archive_tmp=""
echo "[credential-backup] done: $archive"
echo "[credential-backup] encrypt before offsite transfer; keep the passphrase separate"
echo "[credential-backup] includes a sensitive snapshot of $ENV_FILE"
echo "[credential-backup] restore with: ops/scripts/system/restore-credentials.sh $archive --mode $MODE"
