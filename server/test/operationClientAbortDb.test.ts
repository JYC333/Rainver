import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { projectsModule } from "../src/modules/projects/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// The client side of an explicit-key command over real HTTP: the caller stops
// waiting (its own timeout, or the person cancelling) while the server is still
// inside the transaction. The server finishes once, the original key reads
// back that one receipt, and an overlapping retry neither waits for it nor
// writes again. Process death and lost COMMIT acknowledgements are covered in
// `operationFaultsDb.test.ts`; this file covers the caller giving up.

const db = useTestDatabase(import.meta.filename, { max: 6 });
let space: string, owner: string, project: string, operation: string;
let app: ReturnType<typeof buildModuleServer> | undefined;
let address: string;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  space = randomUUID(); owner = randomUUID(); project = randomUUID(); operation = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project });
  await db.pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, version, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Client abort','active',$4,'{}'::jsonb,1,now(),now())`,
    [operation, space, project, owner],
  );
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [projectsModule, systemActionsModule]);
  __setAuthIdentityForTests({ spaceId: space, userId: owner });
  await app.listen({ host: "127.0.0.1", port: 0 });
  address = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

function cancel(key: string, signal?: AbortSignal) {
  return fetch(`${address}/api/v1/actions/research.cancel_acquisition`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ operation_id: operation, project_id: project, reason: "client gave up" }),
    signal,
  }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
}

/** The single business write and its receipt, as the database holds them. */
async function writes(key: string) {
  const target = await db.pool.query("SELECT status, version FROM project_operations WHERE id = $1", [operation]);
  const jobs = await db.pool.query("SELECT id FROM jobs WHERE job_type = 'research_operation_cancel' AND space_id = $1", [space]);
  const receipt = await db.pool.query("SELECT state FROM operation_idempotency WHERE idempotency_key = $1", [key]);
  return { target: target.rows[0], jobs: jobs.rows.length, receipt: receipt.rows };
}

/** Holds the target row so the command is still inside its transaction when the client leaves. */
async function holdTarget() {
  const holder = await db.pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT id FROM project_operations WHERE id = $1 FOR UPDATE", [operation]);
  return holder;
}

describe("explicit-key command when the client stops waiting (real HTTP, real Postgres)", () => {
  it.for(["timeout", "cancel"] as const)("finishes once after a client %s and the original key reads back that receipt", async (mode, ctx) => {
    if (!db.available) return ctx.skip();
    const key = randomUUID();
    const holder = await holdTarget();
    try {
      const controller = new AbortController();
      const signal = mode === "timeout" ? AbortSignal.timeout(150) : controller.signal;
      const abandoned = cancel(key, signal).then(() => "answered", (error: Error) => error.name);
      await waitForLockWaiter(db.pool);
      if (mode === "cancel") controller.abort();
      expect(await abandoned).toBe(mode === "timeout" ? "TimeoutError" : "AbortError");
      // Nothing is committed while the server still waits; the caller's departure changes nothing yet.
      expect(await writes(key)).toEqual({ target: { status: "active", version: 1 }, jobs: 0, receipt: [] });
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    await vi.waitUntil(async () => (await writes(key)).receipt.length > 0, { timeout: 10_000, interval: 25 });
    const replay = await cancel(key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ status: "succeeded", data: { already_terminal: false } });
    expect(await cancel(key)).toEqual(replay);
    expect(await writes(key)).toEqual({ target: { status: "cancelled", version: 2 }, jobs: 1, receipt: [{ state: "succeeded" }] });
  });

  it("refuses an overlapping same-key retry instead of writing again, then replays the one receipt", async (ctx) => {
    if (!db.available) return ctx.skip();
    const key = randomUUID();
    const holder = await holdTarget();
    let first: ReturnType<typeof cancel> | undefined;
    try {
      first = cancel(key);
      await waitForLockWaiter(db.pool);
      const overlapping = await cancel(key, AbortSignal.timeout(5_000));
      expect(overlapping.status, JSON.stringify(overlapping.body)).toBe(409);
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    const original = await first!;
    expect(original.status).toBe(200);
    expect(await cancel(key)).toEqual(original);
    // A new key is a new intent: it answers from the target's state, with no second effect.
    const fresh = await cancel(randomUUID());
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ status: "succeeded", data: { already_terminal: true } });
    expect(await writes(key)).toEqual({ target: { status: "cancelled", version: 2 }, jobs: 1, receipt: [{ state: "succeeded" }] });
  });
});
