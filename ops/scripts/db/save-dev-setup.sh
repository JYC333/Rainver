#!/usr/bin/env bash
# Save the current development database as the private reset baseline.
#
# The archive contains application data, including encrypted credential rows
# and sessions. It is stored under the private dev instance root, never in the
# source repository. CLI login files and the provider master key already live
# under the same instance root and are not duplicated.
#
# Usage:
#   ./ops/scripts/db/save-dev-setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="dev"
local_compose_init "$MODE"
local_compose_ensure_mode_env_file

PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"
local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

SETUP_DIR="$MODE_ROOT/setup"
SETUP_DUMP="$SETUP_DIR/database.dump"
TEMP_DUMP="$SETUP_DIR/database.dump.tmp"

cleanup() {
  rm -f "$TEMP_DUMP"
  local_compose_stop_postgres_if_started "save-dev-setup"
}
trap cleanup EXIT

install -d -m 700 "$SETUP_DIR"

if ! local_compose_ensure_postgres_ready "save dev setup" "$PGUSER" "$PGDB"; then
  exit 1
fi

provider_credential_count="$(
  "${COMPOSE[@]}" exec -T postgres \
    psql -X -q -U "$PGUSER" -d "$PGDB" -tAc \
      "SELECT count(*) FROM credentials WHERE credential_type = 'api_key';"
)"
provider_credential_count="$(local_compose_trim "$provider_credential_count")"
if [[ "$provider_credential_count" != "0" && ! -f "$MODE_ROOT/secrets/provider_keys.key" ]]; then
  echo "ERROR: database contains encrypted API credentials but the dev provider master key is missing:" >&2
  echo "       $MODE_ROOT/secrets/provider_keys.key" >&2
  echo "       Refusing to save a baseline whose credentials cannot be decrypted." >&2
  exit 1
fi

echo "Saving private dev database setup to: $SETUP_DUMP"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$PGUSER" -Fc --no-owner --no-acl "$PGDB" > "$TEMP_DUMP"

if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$TEMP_DUMP" >/dev/null 2>&1; then
  echo "ERROR: generated dev setup archive failed pg_restore validation" >&2
  exit 1
fi

chmod 600 "$TEMP_DUMP"
mv -f "$TEMP_DUMP" "$SETUP_DUMP"

echo "Dev setup saved ($(du -sh "$SETUP_DUMP" | cut -f1))."
echo "Future dev resets restore this archive automatically."
echo "Credential files remain in: $MODE_ROOT/secrets"
