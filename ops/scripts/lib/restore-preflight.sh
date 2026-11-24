#!/bin/sh
# Sent on stdin to the selected server image, whose working directory has
# the compiled CLI and the migration files it will use after restore.
set -eu

# Older compatible images print the command list with exit 2 for --help.
# Invoking help does not connect to the target DB or grant any privileges.
status=0
commands="$(node dist/db/migrateCli.js --help 2>&1)" || status=$?
case "$status:$commands" in
  0:*plugin-reconcile*runtime-roles-reconcile*|2:*plugin-reconcile*runtime-roles-reconcile*) ;;
  *) echo "ERROR: the selected server image lacks the restore reconciliation commands." >&2; exit 1 ;;
esac

node --input-type=module <<'JS'
import { loadMigrations, requiresMaintenance } from "./dist/db/migrator.js";

const migrations = loadMigrations("migrations");
if (!migrations.length) {
  console.error("The selected server image has no migration files.");
  process.exit(1);
}
for (const migration of migrations) {
  const policy = requiresMaintenance(migration.sql) ? "maintenance" : "normal";
  console.log([migration.version, migration.name, migration.checksum, policy].join("\t"));
}
JS
