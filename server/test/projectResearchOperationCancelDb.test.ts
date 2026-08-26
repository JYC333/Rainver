import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig } from "../src/config.js";
import {
  ResearchOperationCancelService,
  RESEARCH_OPERATION_CANCEL_JOB,
} from "../src/modules/projectResearch/researchOperationCancel.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { researchModule } from "../src/modules/research/index.js";
import { projectResearchModule } from "../src/modules/projectResearch/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

// Real-Postgres coverage for the research cancel: stopping a running
// research Operation. The reform removes the blocking checkpoints that were
// the only way to stop one, so this is the control that replaces them, and
// what it has to guarantee is that "stopped" means the Operation cannot start
// another pass *and* that the request to kill in-flight work is durable.

const CONFIG = loadConfig({});
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

let app: FastifyInstance | undefined;

const db = useTestDatabase(import.meta.filename);

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeAll(async () => {
  if (!db.available) return;
  registerProjectResearchExecutionHandlers();
  __setAuthIdentityForTests(identity);
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "test-internal-token",
    RAINVER_HOME: "/tmp/rainver-research-cancel-test",
  }), [projectResearchModule, researchModule]);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["policy_decision_records", "jobs", "runs", "project_operations", "agent_versions", "agents", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  for (const user of [OWNER, STRANGER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [user, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, user, user === OWNER ? "owner" : "member", now],
    );
  }
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
});

async function seedOperation(status = "active"): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake',$4,$5,'{}'::jsonb,$6,$6)`,
    [OPERATION, SPACE, PROJECT, status, OWNER, now],
  );
}

function service(): ResearchOperationCancelService {
  return new ResearchOperationCancelService(db.pool);
}

async function operationStatus(): Promise<string | undefined> {
  const row = await db.pool.query<{ status: string }>(
    `SELECT status FROM project_operations WHERE id=$1 AND space_id=$2`,
    [OPERATION, SPACE],
  );
  return row.rows[0]?.status;
}

async function cancelJobCount(): Promise<number> {
  const row = await db.pool.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM jobs
      WHERE space_id=$1 AND job_type=$2 AND payload_json->>'operation_id'=$3`,
    [SPACE, RESEARCH_OPERATION_CANCEL_JOB, OPERATION],
  );
  return Number(row.rows[0]?.count ?? 0);
}

async function cancelJobReason(): Promise<string | null | undefined> {
  const row = await db.pool.query<{ reason: string | null }>(
    `SELECT payload_json->>'reason' AS reason FROM jobs
      WHERE space_id=$1 AND job_type=$2 AND payload_json->>'operation_id'=$3`,
    [SPACE, RESEARCH_OPERATION_CANCEL_JOB, OPERATION],
  );
  return row.rows[0]?.reason;
}

describe("ResearchOperationCancelService (real Postgres)", () => {
  it("stops the operation and enqueues one durable request to kill its in-flight work", async () => {
    if (!db.available) return;
    await seedOperation();

    await expect(service().cancelOperation(identity, PROJECT, OPERATION, "Stop after the current evidence check.")).resolves.toEqual({
      operation_id: OPERATION,
      status: "cancelled",
      already_terminal: false,
    });
    expect(await operationStatus()).toBe("cancelled");
    expect(await cancelJobCount()).toBe(1);
    expect(await cancelJobReason()).toBe("Stop after the current evidence check.");
  });

  it("enforces and records the cancel policy on the HTTP route", async () => {
    if (!db.available || !db.pool || !app) return;
    await seedOperation();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/operations/${OPERATION}/cancel`,
      payload: { reason: "The user changed the research scope." },
    });

    expect(response.statusCode).toBe(200);
    expect(await cancelJobReason()).toBe("The user changed the research scope.");
    const decisions = await db.pool.query<{
      action: string;
      decision: string;
      resource_type: string;
      resource_id: string | null;
    }>(
      `SELECT action, decision, resource_type, resource_id
         FROM policy_decision_records
        WHERE space_id=$1 AND action='research.acquisition.cancel'`,
      [SPACE],
    );
    expect(decisions.rows).toEqual([{
      action: "research.acquisition.cancel",
      decision: "allow",
      resource_type: "project_operation",
      resource_id: OPERATION,
    }]);
  });

  it("refuses a caller without project write access, leaving the operation running", async () => {
    if (!db.available) return;
    await seedOperation();

    await expect(
      service().cancelOperation({ spaceId: SPACE, userId: STRANGER }, PROJECT, OPERATION),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await operationStatus()).toBe("active");
    expect(await cancelJobCount()).toBe(0);
  });

  it("treats a second cancel as success without enqueuing another stop", async () => {
    if (!db.available) return;
    await seedOperation();

    await service().cancelOperation(identity, PROJECT, OPERATION);
    await expect(service().cancelOperation(identity, PROJECT, OPERATION)).resolves.toMatchObject({
      status: "cancelled",
      already_terminal: true,
    });
    expect(await cancelJobCount()).toBe(1);
  });

  it("does not rewrite an operation that finished on its own before the cancel arrived", async () => {
    if (!db.available) return;
    await seedOperation("completed");

    await expect(service().cancelOperation(identity, PROJECT, OPERATION)).resolves.toMatchObject({
      already_terminal: true,
    });
    // The race this covers: a Run reaches terminal and completes the Operation
    // between the user pressing stop and this write landing. Cancelling a
    // finished Operation would discard a legitimate result and, worse, would
    // enqueue a kill for Runs that already produced it.
    expect(await operationStatus()).toBe("completed");
    expect(await cancelJobCount()).toBe(0);
  });

  it("keeps reconcile inert after a cancel, so no later tick revives the operation", async () => {
    if (!db.available) return;
    await seedOperation();
    await service().cancelOperation(identity, PROJECT, OPERATION);

    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    expect(await operationStatus()).toBe("cancelled");
  });

  it("stamps a failure notification with the pass generation, so a retried failure is a new Room event", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const roomOrigin = JSON.stringify({ origin_room_id: randomUUID(), origin_session_id: randomUUID() });
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, generation, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Initial literature intake','active',$4,$5::jsonb,7,$6,$6)`,
      [OPERATION, SPACE, PROJECT, OWNER, roomOrigin, now],
    );
    const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG) as unknown as {
      notifyRoomOfOperationStatus(
        operation: { id: string; space_id: string; project_id: string; progress_json: unknown },
        status: string,
        message: string,
      ): Promise<void>;
    };
    const operation = { id: OPERATION, space_id: SPACE, project_id: PROJECT, progress_json: JSON.parse(roomOrigin) };

    // The Room event key dedupes permanently, so an operation that is
    // retried and fails again must produce a distinguishable event — the
    // episode (pass generation) is what separates the two failures. Non-failed
    // statuses carry no episode: one pause and one completion per operation.
    await orchestrator.notifyRoomOfOperationStatus(operation, "failed", "first failure");
    await orchestrator.notifyRoomOfOperationStatus(operation, "waiting_review", "over budget");
    await orchestrator.notifyRoomOfOperationStatus(operation, "completed", "finished");

    const jobs = await db.pool.query<{ status: string; episode: string | null }>(
      `SELECT payload_json->>'status' AS status, payload_json->>'episode' AS episode FROM jobs
        WHERE space_id=$1 AND payload_json->>'operation_id'=$2 ORDER BY payload_json->>'status'`,
      [SPACE, OPERATION],
    );
    expect(jobs.rows).toEqual([
      { status: "completed", episode: null },
      { status: "failed", episode: "7" },
      { status: "waiting_review", episode: null },
    ]);
  });

  it("rejects an operation id belonging to another kind or project", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'source_backfill','Backfill','active',$4,'{}'::jsonb,$5,$5)`,
      [OPERATION, SPACE, PROJECT, OWNER, now],
    );

    await expect(service().cancelOperation(identity, PROJECT, OPERATION)).rejects.toMatchObject({ statusCode: 404 });
    expect(await operationStatus()).toBe("active");
  });
});
