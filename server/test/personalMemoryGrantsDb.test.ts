import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { personalMemoryGrantsModule } from "../src/modules/personalMemoryGrants/index.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { waitForLockWaiter } from "./support/lockWait.js";

// Real-Postgres coverage for personal memory grants: a grant whose read
// window has closed is expired, not active; a Run gets a new grant once the
// old one lapsed; and a revoke never undoes a delivery that already used it.

const PERSONAL = "9e11a001-0000-4000-8000-000000000001";
const TEAM = "9e11a001-0000-4000-8000-000000000002";
const OWNER = "9e11a001-0000-4000-8000-000000000003";
const TEAM_PROJECT = "9e11a001-0000-4000-8000-000000000005";
const AGENT = "9e11a001-0000-4000-8000-000000000006";
const VERSION = "9e11a001-0000-4000-8000-000000000007";
const RUN = "9e11a001-0000-4000-8000-000000000008";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["personal_memory_grant_events", "personal_memory_grants", "runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: TEAM, owner: OWNER, project: TEAM_PROJECT, spaceType: "team", spaceName: "Team" });
  // The granting person's own personal Space, where the memory lives.
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Personal','personal',$2,$2)`, [PERSONAL, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), PERSONAL, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: TEAM, owner: OWNER });
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       owner_user_id, instructed_by_user_id, created_at, updated_at, execution_kind)
     VALUES ($1,$2,$3,$4,'agent','manual','queued','live',$5,$5,now(),now(),'agent')`,
    [RUN, TEAM, AGENT, VERSION, OWNER],
  );
  __setAuthIdentityForTests({ spaceId: TEAM, userId: OWNER });
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [personalMemoryGrantsModule]);
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
});

async function insertGrant(status: string, readExpiresAt: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO personal_memory_grants (
       id, granting_user_id, personal_space_id, target_space_id, target_run_id,
       target_agent_id, grant_scope, access_mode, status, memory_filter_json,
       read_expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NULL, 'run', 'summary_only', $6, '{}'::jsonb, $7, now(), now())`,
    [id, OWNER, PERSONAL, TEAM, RUN, status, readExpiresAt],
  );
  return id;
}

const createBody = { target_space_id: TEAM, target_run_id: RUN, access_mode: "summary_only" };

describe("personal memory grants (real Postgres)", () => {
  it("reports a grant whose read window closed as expired and lets the Run be granted again", async () => {
    if (!db.available) return;
    const lapsed = await insertGrant("active", new Date(Date.now() - 60_000).toISOString());

    const active = await app.inject({ method: "GET", url: "/api/v1/personal-memory-grants?status=active" });
    expect(active.json()).toEqual([]);
    const all = await app.inject({ method: "GET", url: "/api/v1/personal-memory-grants" });
    expect(all.json()).toEqual([expect.objectContaining({ id: lapsed, status: "expired" })]);

    const again = await app.inject({ method: "POST", url: "/api/v1/personal-memory-grants", payload: createBody });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ status: "active", target_run_id: RUN });
  });

  it("answers a second grant for a Run that already has an active one as a conflict", async () => {
    if (!db.available) return;
    const first = await app.inject({ method: "POST", url: "/api/v1/personal-memory-grants", payload: createBody });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/v1/personal-memory-grants", payload: createBody });
    expect(second.statusCode).toBe(409);
  });

  it("does not revoke a grant a delivery used while the revoke was in flight", async () => {
    if (!db.available) return;
    const grant = await insertGrant("active", new Date(Date.now() + 3_600_000).toISOString());
    // The delivery has moved the grant to used but not committed; the revoke
    // read it active and must not write over the committed use.
    const delivery = await db.pool.connect();
    try {
      await delivery.query("BEGIN");
      await delivery.query(`UPDATE personal_memory_grants SET status='used', used_at=now() WHERE id=$1`, [grant]);
      let settled = false;
      const revoke = app.inject({ method: "POST", url: `/api/v1/personal-memory-grants/${grant}/revoke` })
        .then((response) => response)
        .finally(() => { settled = true; });
      await waitForLockWaiter(db.pool, { settled: () => settled });
      await delivery.query("COMMIT");
      const response = await revoke;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "used" });
    } finally {
      await delivery.query("ROLLBACK").catch(() => undefined);
      delivery.release();
    }
    const events = await db.pool.query<{ event_type: string }>(`SELECT event_type FROM personal_memory_grant_events WHERE grant_id=$1`, [grant]);
    expect(events.rows.map((row) => row.event_type)).not.toContain("revoked");
  });
});
