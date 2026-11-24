#!/usr/bin/env bash
# Verify a restored PostgreSQL-backed instance and artifact files.
#
# Usage:
#   ops/scripts/system/verify-restore.sh [--mode dev|test|prod] [--bundled-postgres]
#
# Checks the restored database/schema and the presence of Artifact files.
# Exit 2 indicates Artifact paths the verifier could not check. File contents
# and HTTP liveness require separate checks.
# --bundled-postgres verifies the database written by the offline restore tool.

set -euo pipefail
# Connection settings must stay out of shell tracing.
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/local-compose.sh
source "$SCRIPT_DIR/../lib/local-compose.sh"

MODE="${RAINVER_MODE:-dev}"
BUNDLED_POSTGRES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundled-postgres) BUNDLED_POSTGRES=true; shift ;;
    --mode) MODE="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
done

local_compose_init "$MODE"

if [[ ! -d "$MODE_ROOT" ]]; then
  echo "ERROR: mode root not found: $MODE_ROOT" >&2
  exit 1
fi
local_compose_lock_instance "verifying a restore"

failures=0

record_failure() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

fatal() {
  echo "ERROR: $*" >&2
  exit 1
}

DB_URI=""
DATABASE_URL_VALUE=""
if [[ "$BUNDLED_POSTGRES" == false ]]; then
  DATABASE_URL_VALUE="$(local_compose_setting DATABASE_URL || true)"
fi
if [[ -n "$DATABASE_URL_VALUE" ]]; then
  # A mode env file may still use the `postgresql+psycopg:` scheme.
  DB_URI="${DATABASE_URL_VALUE/#postgresql+psycopg:\/\//postgresql:\/\/}"
  if [[ "$DB_URI" != postgresql://* && "$DB_URI" != postgres://* ]] ||
     [[ "$DB_URI" == *$'\n'* || "$DB_URI" == *$'\r'* ]]; then
    fatal "DATABASE_URL must be a PostgreSQL connection string"
  fi
fi

psql_query() {
  local sql="$1"
  if [[ -n "$DB_URI" ]]; then
    local status
    # libpq diagnostics can repeat connection parameters or server-supplied
    # text. Report the fixed failure stage and let the caller name the check.
    if (unset DATABASE_URL; exec python3 "$SCRIPT_DIR/verify_restore_libpq.py" "$sql") <<<"$DB_URI" 2>/dev/null; then
      return 0
    else
      status=$?
    fi
    case "$status" in
      10) echo "ERROR: external database client needs libpq on the verification host" >&2 ;;
      11) echo "ERROR: external database connection failed (check DATABASE_URL, network, TLS and authentication)" >&2 ;;
      12) echo "ERROR: external database rejected the verification query" >&2 ;;
      *) echo "ERROR: external database verification client failed (exit $status)" >&2 ;;
    esac
    return "$status"
  else
    "${COMPOSE[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -Atc "$sql"
  fi
}

echo "[verify] mode:      $MODE"
echo "[verify] mode root: $MODE_ROOT"
if [[ -n "$DB_URI" ]]; then
  echo "[verify] database:  DATABASE_URL from env (redacted)"
else
  PGDB="$(local_compose_setting_or_default POSTGRES_DB rainver)"
  PGUSER="$(local_compose_setting_or_default POSTGRES_USER rainver)"

  local_compose_validate_pg_identifier "POSTGRES_DB" "$PGDB"
  local_compose_validate_pg_identifier "POSTGRES_USER" "$PGUSER"

  echo "[verify] database:  compose postgres service database '$PGDB'"
  trap 'local_compose_stop_postgres_if_started "verify"' EXIT

  if ! local_compose_ensure_postgres_ready "verify" "$PGUSER"; then
    fatal "postgres service is not ready for mode '$MODE'"
  fi
  echo "[verify] postgres service: ready"
fi

if ! migration_table_exists="$(psql_query "SELECT to_regclass('public.server_schema_migrations') IS NOT NULL;")"; then
  fatal "failed to query server_schema_migrations"
fi
if [[ "$migration_table_exists" != "t" ]]; then
  fatal "server_schema_migrations table is missing"
fi
if ! migration_versions="$(psql_query "SELECT version FROM server_schema_migrations ORDER BY version;")"; then
  fatal "failed to read server_schema_migrations.version"
fi
if [[ -z "$migration_versions" ]]; then
  fatal "server_schema_migrations has no version rows"
fi
echo "[verify] schema migrations: $(echo "$migration_versions" | paste -sd ',' -)"

for table in spaces users runs proposals artifacts activity_records; do
  if ! exists="$(psql_query "SELECT to_regclass('public.$table') IS NOT NULL;")"; then
    record_failure "failed to check table: $table"
    continue
  fi
  if [[ "$exists" != "t" ]]; then
    record_failure "missing table: $table"
    continue
  fi
  if ! count="$(psql_query "SELECT count(*) FROM \"$table\";")"; then
    record_failure "failed to count table: $table"
    continue
  fi
  echo "[verify] table $table: $count rows"
done

if ! artifact_paths="$(psql_query "SELECT to_json(storage_path) FROM artifacts WHERE storage_path IS NOT NULL AND btrim(storage_path) <> '' ORDER BY id;")"; then
  fatal "failed to query artifact storage paths"
fi

artifact_status=0
if [[ -n "$artifact_paths" ]]; then
  # Use Compose's resolved server environment and binds. Do not print the
  # resolved document, which also contains unrelated application secrets.
  docker_endpoint="${DOCKER_HOST:-}"
  if [[ -n "${DOCKER_CONTEXT:-}" || -z "$docker_endpoint" ]]; then
    docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || docker_endpoint=""
  fi
  compose_config=""
  if [[ "$docker_endpoint" == unix://* ]]; then
    compose_config="$("${COMPOSE[@]}" config --format json 2>/dev/null)" || compose_config=""
  else
    echo "[verify] Artifact paths unavailable: the Docker endpoint is not a local Unix socket." >&2
  fi
  python3 - "$MODE_ROOT" 3<<<"$compose_config" 4<<<"$artifact_paths" <<'PY' || artifact_status=$?
import json
import os
import posixpath
import stat
import sys
from pathlib import Path, PurePosixPath


def container_path(value, base):
    return PurePosixPath("/" + posixpath.normpath(posixpath.join(base, value)).lstrip("/"))


def server_storage(config):
    server = json.load(config)["services"]["server"]
    env = server.get("environment", {})
    working_dir = server.get("working_dir") or "/app/server"
    home = container_path((env.get("RAINVER_HOME") or "").strip() or "/rainver", working_dir)
    root = (env.get("ARTIFACT_STORAGE_ROOT") or "").strip()
    artifact_dir = container_path(root, working_dir) if root else home / "storage/artifacts"
    mounts = [(container_path(m["target"], "/"), m) for m in server.get("volumes", [])]
    for tmpfs in server.get("tmpfs", []):
        mounts.append((container_path(tmpfs.split(":", 1)[0], "/"), {"type": "tmpfs"}))
    return artifact_dir, sorted(mounts, key=lambda pair: len(pair[0].parts), reverse=True)


paths = [json.loads(row) for row in os.fdopen(4) if row.strip()]
mode_root = Path(sys.argv[1]).resolve()
archive_dirs = [mode_root / name for name in ("storage", "artifacts", "config", "workspaces")]
try:
    artifact_dir, mounts = server_storage(os.fdopen(3))
except (KeyError, TypeError, ValueError):
    print("[verify] Artifact paths unavailable: could not resolve the Compose server configuration.", file=sys.stderr)
    artifact_dir, mounts = None, []

present = missing = invalid = unchecked = external = 0
for relative in paths:
    if relative.startswith("/") or ".." in relative.replace("\\", "/").split("/"):
        print(f"ERROR: invalid Artifact storage_path: {relative!r}", file=sys.stderr)
        invalid += 1
        continue
    target = artifact_dir / relative if artifact_dir is not None else None
    bind = next(((mount, spec) for mount, spec in mounts if target is not None and target.is_relative_to(mount)), None)
    if bind is None or bind[1].get("type") != "bind" or not Path(bind[1].get("source") or "").is_absolute():
        unchecked += 1
        continue
    mount, spec = bind
    try:
        host_file = Path(spec["source"]).resolve() / target.relative_to(mount)
        # A symlink appearing inside a bind can resolve differently in the
        # container namespace. A host path check cannot prove its target.
        if host_file.resolve() != host_file:
            unchecked += 1
            continue
        external += not any(host_file.is_relative_to(directory) for directory in archive_dirs)
        if stat.S_ISREG(host_file.stat().st_mode):
            present += 1
            continue
    except FileNotFoundError:
        pass
    except (OSError, RuntimeError):
        unchecked += 1
        continue
    print(f"ERROR: missing or non-regular Artifact file: {relative!r}", file=sys.stderr)
    missing += 1

print(f"[verify] artifact file refs: {len(paths)} total, {present} present, {invalid} invalid, {missing} missing, {unchecked} not checked")
if external:
    print(f"[verify] artifact archive scope: {external} reference(s) outside standard offline archive directories")
if unchecked:
    print("[verify] Some Artifact paths could not be checked on a local bind mount. Verify the corresponding storage separately.", file=sys.stderr)
sys.exit(1 if invalid or missing else 2 if unchecked else 0)
PY
else
  echo "[verify] artifact file refs: 0 total, 0 present, 0 invalid, 0 missing, 0 not checked"
fi
echo "[verify] artifact content: not verified (no general stored checksum)"

if (( artifact_status == 1 )); then
  record_failure "artifact file reference checks failed"
fi
if (( failures > 0 )); then
  echo "[verify] FAILED ($failures issue(s))." >&2
  exit 1
fi
if (( artifact_status != 0 )); then
  echo "[verify] INCOMPLETE (Artifact paths not checked)." >&2
  exit 2
fi

echo "[verify] ok (database checks and Artifact file presence)"
