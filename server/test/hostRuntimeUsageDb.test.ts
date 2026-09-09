import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import type { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import {
  listHostRuntimeChanges,
  mergeRunQuota,
  readHostUsage,
  recordHostRuntimeChange,
  refreshAllHostUsage,
  refreshHostUsage,
} from "../src/modules/hosts/usageService.js";

/**
 * Subscription quota is readable only on the host that holds the login (ADR
 * 0016 §7), so the control plane asks and caches. These pin what is cached —
 * numbers and a reason, never a credential — and that the cache is the only
 * thing a page read touches.
 */
const db = useTestDatabase(import.meta.filename);

function registry(answers: Record<string, unknown>, online = true): HostConnectionRegistry {
  return {
    isOnline: () => online,
    requestUsageProbe: (_hostId: string, frame: { adapter_type: string }) =>
      Promise.resolve(answers[frame.adapter_type] ?? {
        available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null,
        error: "no answer",
      }),
  } as unknown as HostConnectionRegistry;
}

beforeEach(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await resetTables(db.pool, ["hosts", "machines", "users"], { cascade: true });
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ('user-1', 'Owner', 'active', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ('machine-1', NULL, 'Instance', 'server', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO hosts (
       id, owner_user_id, machine_id, name, kind, environment_kind, status,
       capabilities_json, last_heartbeat_at, created_at, updated_at
     ) VALUES (
       'host-1', NULL, 'machine-1', 'Server', 'server', 'server', 'online',
       $2::jsonb, $1, $1, $1
     )`,
    [now, JSON.stringify({
      runtimes: [], versions: {},
      installations: {
        claude_code: [{ id: "own", version: "1.0.0", logged_in: true, options: null }],
        codex_cli: [{ id: "managed:2.0.0", version: "2.0.0", logged_in: false, options: null }],
        opencode: [{ id: "own", version: "3.0.0", logged_in: true, options: null }],
      },
    })],
  );
});

describe("host subscription quota cache (real Postgres)", () => {
  it("caches what the host answered, including a reason it could not answer", async (ctx) => {
    if (!db.available) return ctx.skip();
    const answered = await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 61, session_resets: "Resets soon", week_pct: 18, week_resets: null, error: null },
    }));

    expect(answered.quota).toMatchObject({ available: true, session_pct: 61, week_pct: 18 });
    const [cached] = await readHostUsage(db.pool, "host-1");
    expect(cached).toMatchObject({ adapter_type: "claude_code", installation: "own" });
    expect(cached!.quota.session_pct).toBe(61);
  });

  it("answers without a probe for a runtime that has no subscription to report", async (ctx) => {
    if (!db.available) return ctx.skip();
    let probed = false;
    const watching = {
      isOnline: () => true,
      requestUsageProbe: () => { probed = true; return Promise.resolve({} as never); },
    } as unknown as HostConnectionRegistry;

    const answered = await refreshHostUsage(db.pool, "host-1", "opencode", "own", watching);

    // OpenCode bills through whichever provider it is pointed at; launching it
    // to be told there is nothing to say is a CLI launch for no information.
    expect(probed).toBe(false);
    expect(answered.quota.available).toBe(false);
    expect(answered.quota.error).toMatch(/no subscription quota/);
  });

  it("sweeps only copies someone has logged into, on hosts that are actually connected", async (ctx) => {
    if (!db.available) return ctx.skip();
    const asked: string[] = [];
    const watching = {
      isOnline: () => true,
      requestUsageProbe: (_hostId: string, frame: { adapter_type: string; installation: string }) => {
        asked.push(`${frame.adapter_type}:${frame.installation}`);
        return Promise.resolve({
          available: true, session_pct: 5, session_resets: null, week_pct: null, week_resets: null, error: null,
        });
      },
    } as unknown as HostConnectionRegistry;

    const probed = await refreshAllHostUsage(db.pool, watching);

    // codex_cli reports `logged_in: false` and opencode has no quota, so the
    // only copy worth a round trip is Claude's.
    expect(asked).toEqual(["claude_code:own"]);
    expect(probed).toBe(1);
  });

  it("skips a host whose row says online but whose socket is gone", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect(await refreshAllHostUsage(db.pool, registry({}, false))).toBe(0);
    expect(await readHostUsage(db.pool, "host-1")).toEqual([]);
  });

  it("folds a Run's live reading into one window without blanking the other", async (ctx) => {
    if (!db.available) return ctx.skip();
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 10, session_resets: null, week_pct: 40, week_resets: "Resets later", error: null },
    }));

    await mergeRunQuota(db.pool, {
      hostId: "host-1",
      adapterType: "claude_code",
      installation: "own",
      quota: { rate_limit_type: "five_hour", utilization: 0.72, resets_at: 1_800_000_000 },
    });

    const [row] = await readHostUsage(db.pool, "host-1");
    expect(row!.quota.session_pct).toBe(72);
    // A partial reading must not erase what the last probe knew about the
    // other window.
    expect(row!.quota.week_pct).toBe(40);
    expect(row!.quota.week_resets).toBe("Resets later");
  });

  it("ignores a window name it does not recognise rather than guessing which one moved", async (ctx) => {
    if (!db.available) return ctx.skip();
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 10, session_resets: null, week_pct: 40, week_resets: null, error: null },
    }));

    await mergeRunQuota(db.pool, {
      hostId: "host-1",
      adapterType: "claude_code",
      installation: "own",
      quota: { rate_limit_type: "some_new_window", utilization: 0.99, resets_at: 1 },
    });

    const [row] = await readHostUsage(db.pool, "host-1");
    expect(row!.quota).toMatchObject({ session_pct: 10, week_pct: 40 });
  });
});

describe("host runtime change log (real Postgres)", () => {
  it("records what changed, newest first, with the host it changed on", async (ctx) => {
    if (!db.available) return ctx.skip();
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", adapterType: "codex_cli", action: "install",
      fromVersion: null, toVersion: "1.0.0", actorUserId: "user-1",
    });
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", adapterType: "codex_cli", action: "upgrade",
      fromVersion: "1.0.0", toVersion: "2.0.0", actorUserId: "user-1",
    });
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", adapterType: "codex_cli", action: "rollback",
      fromVersion: "2.0.0", toVersion: "1.0.0", actorUserId: null,
    });

    const changes = await listHostRuntimeChanges(db.pool, "user-1");

    expect(changes.map((change) => change.action)).toEqual(["rollback", "upgrade", "install"]);
    expect(changes[0]).toMatchObject({ host_name: "Server", from_version: "2.0.0", to_version: "1.0.0" });
  });

  it("keeps the record when the person who made the change is gone", async (ctx) => {
    if (!db.available) return ctx.skip();
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", adapterType: "claude_code", action: "upgrade",
      fromVersion: "1.0.0", toVersion: "2.0.0", actorUserId: "user-1",
    });
    await db.pool.query("DELETE FROM users WHERE id = 'user-1'");

    // The point of the log is answering "since when" long after the fact.
    const [change] = await listHostRuntimeChanges(db.pool, "user-1");
    expect(change).toMatchObject({ adapter_type: "claude_code", actor_user_id: null });
  });

  it("goes with the host it belongs to", async (ctx) => {
    if (!db.available) return ctx.skip();
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", adapterType: "claude_code", action: "install",
      fromVersion: null, toVersion: "1.0.0", actorUserId: null,
    });
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({}));
    await db.pool.query("DELETE FROM hosts WHERE id = 'host-1'");

    expect(await listHostRuntimeChanges(db.pool, "user-1")).toEqual([]);
    expect(await readHostUsage(db.pool, "host-1")).toEqual([]);
  });
});
