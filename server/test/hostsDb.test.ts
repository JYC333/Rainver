import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { PgHostRepository } from "../src/modules/hosts/repository";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

// Real-Postgres coverage for ADR 0016's hosts model: the seeded server host
// bootstrap, pairing-code issuance/exchange (a pending host row doubling as
// the pairing credential), heartbeat/staleness, and owner-scoped visibility.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[hosts-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE hosts, users CASCADE");
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now()), ($2, 'Other', 'active', now(), now())`,
    [OWNER, OTHER_USER],
  );
});

describe("hosts repository", () => {
  it("bootstraps exactly one server host, idempotently", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const first = await repo.ensureServerHostId();
    const second = await repo.ensureServerHostId();
    expect(first).toBe(second);
    const rows = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM hosts WHERE kind = 'server'`);
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("rejects a second server host at the database level", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    await repo.ensureServerHostId();
    await expect(
      pool.query(
        `INSERT INTO hosts (id, owner_user_id, name, kind, status, created_at, updated_at)
         VALUES ($1, NULL, 'server-2', 'server', 'online', now(), now())`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("issues a pairing code and completes registration into a bearer token", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const issued = await repo.issuePairingCode(OWNER, "Desktop");
    if ("statusCode" in issued) throw new Error("expected success");
    expect(issued.pairing_code).toBeTruthy();

    const registered = await repo.registerViaPairingCode(issued.pairing_code, {
      platform: "linux",
      arch: "x64",
      daemon_version: "0.1.0",
      capabilities_json: { runtimes: ["codex"] },
    });
    if ("statusCode" in registered) throw new Error("expected success");
    expect(registered.host_id).toBe(issued.host_id);
    expect(registered.name).toBe("Desktop");

    // The pairing code itself no longer authenticates once registration is complete.
    const reuse = await repo.registerViaPairingCode(issued.pairing_code, {});
    expect("statusCode" in reuse && reuse.statusCode).toBe(401);

    const authenticated = await repo.authenticate(registered.token);
    expect(authenticated?.id).toBe(issued.host_id);
    expect(authenticated?.platform).toBe("linux");
  });

  it("rejects an expired or unknown pairing code", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const bogus = await repo.registerViaPairingCode("not-a-real-code", {});
    expect("statusCode" in bogus && bogus.statusCode).toBe(401);
  });

  it("never authenticates a pending pairing code as a bearer token", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const issued = await repo.issuePairingCode(OWNER, "Unexchanged");
    if ("statusCode" in issued) throw new Error("expected success");
    // The pairing code shares the token_hash column with the real bearer
    // token — presenting the raw code before /register runs must not
    // authenticate as if it were the token.
    expect(await repo.authenticate(issued.pairing_code)).toBeNull();
  });

  it("lets only one of two concurrent exchanges of the same pairing code succeed", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const issued = await repo.issuePairingCode(OWNER, "Raced");
    if ("statusCode" in issued) throw new Error("expected success");
    const [first, second] = await Promise.all([
      repo.registerViaPairingCode(issued.pairing_code, {}),
      repo.registerViaPairingCode(issued.pairing_code, {}),
    ]);
    const results = [first, second];
    const succeeded = results.filter((r) => !("statusCode" in r));
    const failed = results.filter((r) => "statusCode" in r);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { statusCode: number }).statusCode).toBe(401);
    // The winner's token is the one actually persisted.
    const winnerToken = (succeeded[0] as { token: string }).token;
    expect(await repo.authenticate(winnerToken)).not.toBeNull();
  });

  it("enforces one name per owner but allows the same name across different owners", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const first = await repo.issuePairingCode(OWNER, "Laptop");
    expect("statusCode" in first).toBe(false);
    const duplicate = await repo.issuePairingCode(OWNER, "Laptop");
    expect("statusCode" in duplicate && duplicate.statusCode).toBe(409);
    const otherOwnerSameName = await repo.issuePairingCode(OTHER_USER, "Laptop");
    expect("statusCode" in otherOwnerSameName).toBe(false);
  });

  it("reports heartbeat staleness without a background sweep", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const issued = await repo.issuePairingCode(OWNER, "Stale Box");
    if ("statusCode" in issued) throw new Error("expected success");
    const registered = await repo.registerViaPairingCode(issued.pairing_code, {});
    if ("statusCode" in registered) throw new Error("expected success");
    await repo.recordHeartbeat(registered.host_id, {});
    const fresh = await repo.listVisibleTo(OWNER);
    const freshHost = fresh.find((h) => h.id === registered.host_id);
    expect(freshHost?.status).toBe("online");

    // Backdate the heartbeat past the staleness window instead of sleeping in the test.
    await pool.query(`UPDATE hosts SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [registered.host_id]);
    const stale = await repo.listVisibleTo(OWNER);
    const staleHost = stale.find((h) => h.id === registered.host_id);
    expect(staleHost?.status).toBe("offline");
  });

  it("keeps the in-process server host online without a daemon heartbeat", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const serverHostId = await repo.ensureServerHostId();

    const visible = await repo.listVisibleTo(OWNER);
    const serverHost = visible.find((h) => h.id === serverHostId);
    expect(serverHost).toMatchObject({ kind: "server", status: "online", last_heartbeat_at: null });
  });

  it("scopes visibility to the server host plus the caller's own remote hosts", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const serverHostId = await repo.ensureServerHostId();
    const mine = await repo.issuePairingCode(OWNER, "Mine");
    if ("statusCode" in mine) throw new Error("expected success");
    const theirs = await repo.issuePairingCode(OTHER_USER, "Theirs");
    if ("statusCode" in theirs) throw new Error("expected success");

    const visible = await repo.listVisibleTo(OWNER);
    const ids = visible.map((h) => h.id);
    expect(ids).toContain(serverHostId);
    expect(ids).toContain(mine.host_id);
    expect(ids).not.toContain(theirs.host_id);
  });

  it("revokes only a host the caller owns, and a revoked host cannot authenticate again", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgHostRepository(pool);
    const issued = await repo.issuePairingCode(OWNER, "ToRevoke");
    if ("statusCode" in issued) throw new Error("expected success");
    const registered = await repo.registerViaPairingCode(issued.pairing_code, {});
    if ("statusCode" in registered) throw new Error("expected success");

    const wrongOwner = await repo.revoke(OTHER_USER, registered.host_id);
    expect(wrongOwner).toBe(false);
    expect(await repo.authenticate(registered.token)).not.toBeNull();

    const revoked = await repo.revoke(OWNER, registered.host_id);
    expect(revoked).toBe(true);
    expect(await repo.authenticate(registered.token)).toBeNull();
  });

  it("rejects a remote host row with no owner and a server host row with an owner at the database level", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    await expect(
      pool.query(
        `INSERT INTO hosts (id, owner_user_id, name, kind, status, created_at, updated_at)
         VALUES ($1, NULL, 'Orphan Remote', 'remote', 'offline', now(), now())`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO hosts (id, owner_user_id, name, kind, status, created_at, updated_at)
         VALUES ($1, $2, 'Owned Server', 'server', 'online', now(), now())`,
        [randomUUID(), OWNER],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
