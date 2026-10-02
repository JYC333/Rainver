import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withDedicatedSessionAdvisoryLock } from "../src/db/advisoryLock.js";
import { useTestDatabase } from "./support/testDatabase.js";

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

      // Migrations are an append-only committed chain: start never generates
      // one as a side effect, and the host needs no pnpm to run the stack.
      expect(start).not.toContain("schema:generate");
      expect(start).not.toContain("pnpm");
      expect(start).toContain("run_database_migrations()");
      expect(start).toContain('"$REPO_ROOT/ops/scripts/db/migrate.sh" --mode "$MODE"');
      // The server image must exist before migrate.sh runs it: dev/test build
      // it, prod pulls the CI-published stack and never builds on the host.
      expect(start).toContain("ensure_images");
      expect(start).toContain('"${COMPOSE[@]}" pull');
      expect(start).toContain('"${COMPOSE[@]}" build server');
      expect(start).not.toContain("docker build");
    });

    it("verifies the pre-migration dump by streaming it, never by a path inside the container", () => {
      const migrate = readRepoFile("ops/scripts/db/migrate.sh");
      const restore = readRepoFile("ops/scripts/db/restore.sh");
      const saveSetup = readRepoFile("ops/scripts/db/save-dev-setup.sh");

      // `pg_restore -l /dev/stdin` reopens the path and loses the pipe, so it
      // reports "did not find magic string in file header" for an archive that
      // is perfectly good — and the check aborts the upgrade on a backup that
      // was never broken. All three callers read stdin as a stream instead.
      for (const script of [migrate, restore, saveSetup]) {
        expect(script).not.toContain("pg_restore -l /dev/stdin");
        expect(script).not.toContain("pg_restore --list /dev/stdin");
      }
      expect(migrate).toContain('"${COMPOSE[@]}" exec -T postgres pg_restore -l >/dev/null 2>&1 < "$dump_path"');
      // The host binary is optional — a machine that runs the stack in Docker
      // has no client tools — so its absence must fall through to the
      // container rather than count as a failed verification.
      expect(migrate).toContain("command -v pg_restore");
    });

    it.skipIf(process.platform === "win32")("refuses to migrate when pg_dump fails after writing a readable archive head", () => {
      // pg_dump writes the custom-format header and table of contents before
      // any table data, so a dump that dies mid-data is non-empty and passes
      // `pg_restore -l`. Only pg_dump's own exit status says it failed.
      const dir = mkdtempSync(join(tmpdir(), "rainver-migrate-backup-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "pg_dump"), "#!/bin/sh\nprintf 'PGDMP partial archive'\nexit 1\n", { mode: 0o755 });
        writeFileSync(join(bin, "pg_restore"), "#!/bin/sh\ncat >/dev/null 2>&1 || true\nexit 0\n", { mode: 0o755 });
        const script = join(repoRoot, "ops/scripts/db/migrate.sh");
        const harness = [
          "set -euo pipefail",
          `eval "$(sed -n '/^pre_migration_backup_host() {/,/^}/p; /^ensure_pre_migration_backup() {/,/^}/p' '${script}')"`,
          "resolve_host_database_url() { MIGRATION_DATABASE_URL=postgresql://unused; }",
          "ensure_pre_migration_backup",
          "echo MIGRATING",
        ].join("\n");
        const result = spawnSync("bash", ["-c", harness], {
          env: { PATH: `${bin}:${process.env.PATH ?? ""}`, MODE_ROOT: dir, RUN_MODE: "host", MODE: "prod" },
          encoding: "utf8",
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("MIGRATING");
        expect(result.stdout).not.toContain("pre-migration backup written");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
      // afterward. The archive is a private convenience snapshot, never
      // restored with its own schema.
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

describe("advisoryLockDb", () => {
  const db = useTestDatabase(`${import.meta.filename}#advisoryLockDb`, { max: 2 });

  it("survives losing the dedicated lock connection while the work runs", async () => {
    const lockKey = `test-lock:${randomUUID()}`;
    const result = await withDedicatedSessionAdvisoryLock(db.pool, lockKey, async () => {
      // `pg_locks` is cluster-wide: unscoped, this picked whichever backend
      // of a concurrently running file held an advisory lock and killed it.
      const holder = await db.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      const pid = holder.rows[0]!.pid;
      await db.pool.query(`SELECT pg_terminate_backend($1)`, [pid]);
      // Wait until the backend is gone; each round trip also lets the lock
      // client read the termination off its socket.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const alive = await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1`, [pid]);
        if (alive.rowCount === 0) break;
      }
      await new Promise((resolve) => setImmediate(resolve));
      return "done";
    });
    expect(result).toBe("done");
    // The lock went with its session, so the key is free again.
    const free = await db.pool.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired`,
      [lockKey],
    );
    expect(free.rows[0]?.acquired).toBe(true);
  });
});
