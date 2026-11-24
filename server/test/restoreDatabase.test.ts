import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { expect, inject, it, type TestContext } from "vitest";
import "./support/sharedPostgres.js";

const library = resolve(import.meta.dirname, "../../ops/scripts/lib/restore-database.sh");

function testFixture(context: TestContext) {
  const postgres = inject("sharedPostgres");
  if (!postgres.available || !postgres.adminUri || !postgres.containerId) {
    if (process.env.REQUIRE_TEST_POSTGRES === "true") throw new Error("Shared Postgres test container is unavailable");
    return context.skip();
  }
  const container = postgres.containerId;
  const user = new URL(postgres.adminUri).username;
  const prefix = "rainver_restore_test_" + randomBytes(6).toString("hex");
  const active = prefix + "_active";
  const stage = prefix + "_stage";
  const previous = prefix + "_previous";
  const psql = (database: string, sql: string) => execFileSync(
    "docker", ["exec", "-i", container, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database],
    { encoding: "utf-8", input: sql },
  ).trim();
  const runRestoreShell = (command: string, ...args: string[]) => spawnSync(
    "bash", ["-ec", String.raw`source "$1"
    readonly PGUSER="$2" PGDB="$3" test_container="$4"
    shift 4
    fixture_compose() {
      [[ "$1 $2 $3" == "exec -T postgres" ]] || return 1
      shift 3
      docker exec -i "$test_container" "$@"
    }
    COMPOSE=(fixture_compose)
    ` + command, "_", library, user, active, container, ...args],
    { encoding: "utf-8" },
  );
  return {
    active, stage, previous, psql,
    promote: () => runRestoreShell('restore_database_promote "$1" "$2"', stage, previous),
    verifyRoles: (app: string, backup: string) => runRestoreShell(`
      readonly app="$2" backup="$3"
      local_compose_setting() { printf '1'; }
      local_compose_setting_or_default() {
        case "$1" in
          RAINVER_DB_APP_ROLE) printf '%s' "$app" ;;
          RAINVER_DB_BACKUP_ROLE) printf '%s' "$backup" ;;
        esac
      }
      restore_database_verify_runtime_roles "$1"`, stage, app, backup),
    clean: () => psql("postgres", [active, stage, previous].map(
      (name) => `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`,
    ).join("\n")),
  };
}

it("atomically promotes the stage and keeps the old data under a disabled name", (context) => {
  const fixture = testFixture(context);
  if (!fixture) return;
  const { active, stage, previous, psql } = fixture;
  try {
    psql("postgres", `CREATE DATABASE "${active}"; CREATE DATABASE "${stage}";`);
    psql(active, "CREATE TABLE marker (name text); INSERT INTO marker VALUES ('previous');");
    psql(stage, "CREATE TABLE marker (name text); INSERT INTO marker VALUES ('restored');");
    const result = fixture.promote();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("t");
    expect(psql(active, "SELECT name FROM marker;")).toBe("restored");
    expect(psql("postgres", `SELECT datallowconn FROM pg_database WHERE datname = '${previous}';`)).toBe("f");
    psql("postgres", `ALTER DATABASE "${previous}" ALLOW_CONNECTIONS true;`);
    expect(psql(previous, "SELECT name FROM marker;")).toBe("previous");
  } finally {
    fixture.clean();
  }
});

it("rolls back the first rename when PostgreSQL rejects the second", (context) => {
  const fixture = testFixture(context);
  if (!fixture) return;
  const { active, previous, psql } = fixture;
  try {
    psql("postgres", `CREATE DATABASE "${active}";`);
    psql(active, "CREATE TABLE marker (name text); INSERT INTO marker VALUES ('live');");
    const result = fixture.promote();
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(fixture.stage);
    expect(psql(active, "SELECT name FROM marker;")).toBe("live");
    expect(psql("postgres", `SELECT datname FROM pg_database WHERE datname = '${previous}';`)).toBe("");
  } finally {
    fixture.clean();
  }
});

it("checks the activated application and backup access on the staged database", (context) => {
  const fixture = testFixture(context);
  if (!fixture) return;
  const { stage, psql } = fixture;
  const app = stage + "_app";
  const backup = stage + "_backup";
  try {
    psql("postgres", `CREATE DATABASE "${stage}"; CREATE ROLE "${app}" LOGIN; CREATE ROLE "${backup}" LOGIN;`);
    psql(stage, `CREATE TABLE public.server_schema_migrations (version text);
      GRANT SELECT ON public.server_schema_migrations TO "${app}";`);
    const denied = fixture.verifyRoles(app, backup);
    expect(denied.status, denied.stderr).toBe(1);
    expect(denied.stderr).toContain("database does not grant");
    psql("postgres", `GRANT pg_read_all_data TO "${backup}";`);
    const accepted = fixture.verifyRoles(app, backup);
    expect(accepted.status, accepted.stderr).toBe(0);
  } finally {
    fixture.clean();
    psql("postgres", `DROP ROLE IF EXISTS "${app}"; DROP ROLE IF EXISTS "${backup}";`);
  }
});
