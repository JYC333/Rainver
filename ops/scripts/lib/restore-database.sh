#!/usr/bin/env bash
# Used by both restore entry points while the instance lock is held.

RESTORE_DB_CANDIDATE=""
RESTORE_DB_PREVIOUS=""

restore_database_check_target() {
  if [[ ${#PGDB} -gt 63 || "$PGDB" == postgres || "$PGDB" == template0 ||
        "$PGDB" == template1 || "$PGDB" == rainver_restore_* ]]; then
    echo "ERROR: '$PGDB' is not a supported restore target." >&2
    return 1
  fi
}

restore_database_psql() {
  "${COMPOSE[@]}" exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U "$PGUSER" "$@"
}

restore_database_cleanup() {
  [[ "$RESTORE_DB_CANDIDATE" == rainver_restore_stage_* ]] || return 0
  if ! restore_database_psql -d postgres -v candidate="$RESTORE_DB_CANDIDATE" <<'SQL'
DROP DATABASE IF EXISTS :"candidate" WITH (FORCE);
SQL
  then
    echo "WARNING: staging database '$RESTORE_DB_CANDIDATE' could not be cleaned up." >&2
  fi
  return 0
}

restore_database_promote() {
  restore_database_psql -d postgres -v target_db="$PGDB" -v candidate="$1" -v previous_db="$2" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db') AS had_previous \gset
\if :had_previous
-- Stop new access to the retained generation after commit. RENAME also
-- refuses the transaction if a writer manages to reconnect before the lock.
ALTER DATABASE :"target_db" ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid, 5000)
FROM pg_stat_activity WHERE datname = :'target_db' AND pid <> pg_backend_pid()
\g /dev/null
ALTER DATABASE :"target_db" RENAME TO :"previous_db";
\endif
ALTER DATABASE :"candidate" RENAME TO :"target_db";
COMMIT;
\echo :had_previous
SQL
}

restore_database_verify_runtime_roles() {
  local database="$1" privileges
  [[ "$(local_compose_setting RAINVER_DB_REQUIRE_RUNTIME_ROLE || true)" == 1 ]] || return 0
  privileges="$(restore_database_psql -d "$database" \
    -v app_role="$(local_compose_setting_or_default RAINVER_DB_APP_ROLE rainver_app)" \
    -v backup_role="$(local_compose_setting_or_default RAINVER_DB_BACKUP_ROLE rainver_backup)" <<'SQL'
SELECT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'app_role' AND rolcanlogin
    AND has_database_privilege(oid, current_database(), 'CONNECT')
    AND has_table_privilege(oid, 'public.server_schema_migrations', 'SELECT')
) AND EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'backup_role' AND rolcanlogin
    AND has_database_privilege(oid, current_database(), 'CONNECT')
    AND pg_has_role(oid, 'pg_read_all_data', 'USAGE')
);
SQL
  )" || return
  if [[ "$privileges" != t ]]; then
    echo "ERROR: the restored database does not grant the configured application and backup roles access." >&2
    return 1
  fi
}

restore_database() {
  local dump="$1" operation="$2" force="$3" generation candidate promoted
  generation="$(date -u +%Y%m%d_%H%M%S)_${BASHPID}_${RANDOM}"
  candidate="rainver_restore_stage_$generation"
  RESTORE_DB_PREVIOUS="rainver_restore_before_$generation"
  echo "[restore] staging database: $candidate"
  echo "[restore] retained database after cutover (if '$PGDB' exists): $RESTORE_DB_PREVIOUS"

  restore_database_psql -d postgres -v candidate="$candidate" <<'SQL' || return
CREATE DATABASE :"candidate" TEMPLATE template0;
SQL
  RESTORE_DB_CANDIDATE="$candidate"
  "${COMPOSE[@]}" exec -T postgres \
    pg_restore -U "$PGUSER" --exit-on-error --no-owner --no-acl -d "$candidate" < "$dump" || return

  # Restore strips dump ownership and ACLs. Repair and check access on the
  # isolated database while the active database still has its original name.
  local_compose_run_restore_server "$candidate" node dist/db/migrateCli.js plugin-reconcile || return
  local_compose_run_restore_server "$candidate" node dist/db/migrateCli.js runtime-roles-reconcile --if-present || return
  restore_database_verify_runtime_roles "$candidate" || return
  local_compose_require_stopped_applications "$operation" "$force" || return

  if ! promoted="$(restore_database_promote "$candidate" "$RESTORE_DB_PREVIOUS")"; then
    echo "ERROR: database cutover failed. Before restarting, check '$PGDB' and '$RESTORE_DB_PREVIOUS' in PostgreSQL." >&2
    return 1
  fi
  RESTORE_DB_CANDIDATE=""
  if [[ "$promoted" == t ]]; then
    echo "[restore] previous database retained as '$RESTORE_DB_PREVIOUS' with connections disabled."
  fi
}
