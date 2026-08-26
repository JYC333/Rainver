import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("dbMigrationOps", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");

  function readRepoFile(path: string) {
    return readFileSync(join(repoRoot, path), "utf8");
  }

  describe("database migration ops scripts", () => {
    it("lets docker-native migrate initialize a missing target database", () => {
      const migrate = readRepoFile("ops/scripts/db/migrate.sh");
      const reset = readRepoFile("ops/scripts/db/reset-postgres.sh");
      const start = readRepoFile("ops/scripts/start.sh");

      expect(migrate).toContain("ensure_docker_database_exists()");
      expect(migrate).toContain("SELECT 1 FROM pg_database WHERE datname = '$pgdb';");
      expect(migrate).toContain('CREATE DATABASE \\"$pgdb\\";');
      expect(migrate).toContain('if [[ "$RUN_MODE" == "docker" ]]; then');
      expect(migrate.lastIndexOf("run_drizzle_schema_check_docker")).toBeLessThan(
        migrate.lastIndexOf("ensure_docker_database_exists"),
      );
      expect(migrate).toContain("ensure_docker_database_exists");
      expect(migrate).toContain("run_drizzle_schema_check_host");

      expect(reset).toContain('"$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE"');

      expect(start).toContain("generate_schema_migrations()");
      expect(start).toContain("pnpm run schema:generate");
      expect(start.lastIndexOf("generate_schema_migrations")).toBeLessThan(
        start.lastIndexOf("ensure_server_image_for_migrations"),
      );
      expect(start).toContain("run_database_migrations()");
      expect(start).toContain('"$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE"');
      expect(start).toContain("ensure_server_image_for_migrations");
    });

    it("keeps the private dev setup outside the repo and imports it after migration", () => {
      const saveSetup = readRepoFile("ops/scripts/db/save-dev-setup.sh");
      const reset = readRepoFile("ops/scripts/db/reset-postgres.sh");

      expect(saveSetup).toContain('SETUP_DIR="$MODE_ROOT/setup"');
      expect(saveSetup).toContain('SETUP_DUMP="$SETUP_DIR/database.dump"');
      expect(saveSetup).toContain("pg_dump -U");
      expect(saveSetup).toContain('chmod 600 "$TEMP_DUMP"');
      expect(reset).toContain('DEV_SETUP_DUMP="$MODE_ROOT/setup/database.dump"');
      expect(reset).toContain('[[ "$MODE" == "dev"');
      // Migration runs first, always, so the reset database is on the current
      // schema; the dev setup archive is imported data-only on top of it
      // afterward. Restoring the archive's own (possibly older) schema before
      // migrating — the previous order — breaks under this repo's
      // single-baseline-squash model as soon as the baseline SQL changes after
      // the archive was saved.
      expect(reset.indexOf('"$REPO_ROOT/ops/scripts/db/migrate.sh"')).toBeLessThan(
        reset.indexOf("pg_restore -U"),
      );
      expect(reset).toContain("--data-only");
      expect(reset).toContain("--no-dev-setup");
    });

    it("waits for stable postgres SQL readiness during compose bootstrap", () => {
      const localCompose = readRepoFile("ops/scripts/lib/local-compose.sh");

      expect(localCompose).toContain("required_successes=3");
      expect(localCompose).toContain('psql -X -q -U "$pguser" -d "$db"');
      expect(localCompose).toContain("-tAc \"SELECT 1;\"");
      expect(localCompose).toContain("consecutive_successes=0");
    });
  });
});

describe("dbOwnerRoleCutover", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");

  function readRepoFile(path: string) {
    return readFileSync(join(repoRoot, path), "utf8");
  }

  describe("server database ownership cutover", () => {
    it("does not provision a separate per-table server database role", () => {
      const files = [
        "ops/scripts/lib/local-compose.sh",
        "ops/scripts/start.sh",
        "ops/scripts/db/migrate.sh",
        "ops/scripts/db/reset-postgres.sh",
        "ops/env/.env.dev.example",
        "ops/env/.env.test.example",
        "ops/env/.env.prod.example",
      ];

      const combined = files.map((path) => readRepoFile(path)).join("\n");
      const forbidden = [
        ["SERVER_DB", "_RW"].join(""),
        ["rainver", "_cp"].join(""),
        ["local_compose_provision", "_server_db_role"].join(""),
        ["GRANT SELECT ON TABLE public.", "participation_records"].join(""),
        ["least", "-privilege"].join(""),
      ];

      for (const value of forbidden) {
        expect(combined).not.toContain(value);
      }
      expect(readRepoFile("ops/scripts/lib/local-compose.sh")).toContain(
        "local_compose_server_owner_database_url",
      );
      expect(readRepoFile("ops/scripts/lib/local-compose.sh")).toContain(
        "env -u DEBUG docker compose",
      );
    });
  });
});
