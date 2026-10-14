import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ContentAccessService } from "../src/modules/contentAccess/service.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { PgMemoryApplyRepository } from "../src/modules/memory/memoryApplyRepository.js";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { insertMemoryEntry } from "./support/memoryFixtures.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Who may read a Memory entry changes through the canonical applier (P04
// D43/D21): a new version with its provenance and grants, decided by the
// owner, with the audience re-checked when the change is accepted.

const db = useTestDatabase(import.meta.filename);
const SPACE = "space-access";
const OWNER = "owner-access";
const ADMIN = "admin-access";
const READER = "reader-access";
const OUTSIDER = "outsider-access";
const PROJECT = randomUUID();

function config() {
  return loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
}

function service() {
  return new ContentAccessService(db.pool);
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: ADMIN, project: PROJECT, spaceType: "household" });
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER });
  await seedSpaceMember(db.pool, { space: SPACE, user: READER });
  await seedSpaceMember(db.pool, { space: SPACE, user: OUTSIDER });
  for (const user of [OWNER, READER]) {
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, PROJECT, user],
    );
  }
});

async function ownMemory(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insertMemoryEntry(db.pool, SPACE, { id, owner_user_id: OWNER, subject_user_id: OWNER, root_memory_id: id, ...over });
  return id;
}

async function activity(visibility: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, project_id, activity_type, title, content,
        payload_json, occurred_at, created_at, updated_at, status, source_trust, visibility, access_level)
     VALUES ($1, $2, $3, $3, $4, 'user_capture', 'Capture', 'what we decided',
             '{}'::jsonb, now(), now(), now(), 'raw', 'user_confirmed', $5, 'full')`,
    [id, SPACE, OWNER, PROJECT, visibility],
  );
  return id;
}

async function grants(memoryId: string) {
  const result = await db.pool.query<{ grantee_user_id: string }>(
    `SELECT grantee_user_id FROM content_access_grants
      WHERE space_id = $1 AND resource_type = 'memory' AND resource_id = $2 AND revoked_at IS NULL`,
    [SPACE, memoryId],
  );
  return result.rows.map((row) => row.grantee_user_id);
}

describe("memoryAccessChangeDb", () => {
  it("writes the owner's access change as a new version that carries provenance and grants", async (ctx) => {
    if (!db.available) return ctx.skip();
    const memoryId = await ownMemory();
    await db.pool.query(
      `INSERT INTO provenance_links (id, space_id, target_type, target_id, source_type, source_id, source_trust, created_at)
       VALUES ($1, $2, 'memory', $3, 'user_confirmation', $4, 'user_confirmed', now())`,
      [randomUUID(), SPACE, memoryId, OWNER],
    );

    const policy = await service().updatePolicy({ spaceId: SPACE, userId: OWNER }, "memory", memoryId, {
      visibility: "selected_users",
      access_level: "full",
      project_id: null,
      grants: [{ user_id: READER, access_level: "summary" }],
    });

    expect(policy.resource_id).not.toBe(memoryId);
    expect(policy).toMatchObject({ visibility: "selected_users", grants: [{ user_id: READER, access_level: "summary" }] });
    const rows = await db.pool.query<{ status: string; supersedes_memory_id: string | null; content: string; approved_by: string }>(
      `SELECT status, supersedes_memory_id, content, approved_by FROM memory_entries WHERE space_id = $1 ORDER BY version`,
      [SPACE],
    );
    expect(rows.rows.map((row) => row.status)).toEqual(["superseded", "active"]);
    expect(rows.rows[1]).toMatchObject({ supersedes_memory_id: memoryId, content: "memory content", approved_by: OWNER });
    const provenance = await db.pool.query<{ source_type: string }>(
      `SELECT source_type FROM provenance_links WHERE target_type = 'memory' AND target_id = $1`,
      [policy.resource_id],
    );
    expect(provenance.rows.map((row) => row.source_type)).toEqual(["user_confirmation"]);
    const relation = await db.pool.query(
      `SELECT 1 FROM memory_relations WHERE source_id = $1 AND target_id = $2`,
      [policy.resource_id, memoryId],
    );
    expect(relation.rowCount).toBe(1);
    expect(await grants(memoryId)).toEqual([]);
    expect(await grants(policy.resource_id)).toEqual([READER]);
  });

  it("refuses a Space admin widening someone else's memory, by either route", async (ctx) => {
    if (!db.available) return ctx.skip();
    const memoryId = await ownMemory();
    await expect(service().updatePolicy({ spaceId: SPACE, userId: ADMIN }, "memory", memoryId, {
      visibility: "selected_users",
      access_level: "full",
      project_id: null,
      grants: [{ user_id: READER, access_level: "full" }],
    })).rejects.toMatchObject({ statusCode: 403 });

    const proposalId = randomUUID();
    await db.pool.query(
      `INSERT INTO proposals (id, space_id, proposal_type, status, payload_json, created_by_user_id, title, risk_level, urgency, visibility, created_at, updated_at)
       VALUES ($1, $2, 'memory_update', 'pending', $3::jsonb, $4, 'Widen', 'low', 'normal', 'space_shared', now(), now())`,
      [proposalId, SPACE, JSON.stringify({
        operation: "update",
        target_memory_id: memoryId,
        target_visibility: "selected_users",
        target_grants: [{ user_id: READER, access_level: "full" }],
        provenance_entries: [{ source_type: "user_confirmation", source_id: ADMIN, source_trust: "user_confirmed" }],
      }), ADMIN],
    );
    await expect(new PgProposalApplyService(config()).accept(proposalId, { spaceId: SPACE, userId: ADMIN }))
      .rejects.toMatchObject({ statusCode: 409, detail: expect.objectContaining({ code: "memory_owner_sharing_required" }) });
    const head = await db.pool.query<{ visibility: string }>(`SELECT visibility FROM memory_entries WHERE id = $1`, [memoryId]);
    expect(head.rows[0]!.visibility).toBe("private");
  });

  it("lets nobody but its owner move a personal memory into a Project or hand it to someone else", async (ctx) => {
    if (!db.available) return ctx.skip();
    // OWNER's entry is shared with READER only; ADMIN owns the Project.
    const memoryId = await ownMemory({ visibility: "selected_users" });
    await db.pool.query(
      `INSERT INTO content_access_grants (id, space_id, resource_type, resource_id, grantee_user_id, access_level, granted_by_user_id, created_at, updated_at)
       VALUES ($1, $2, 'memory', $3, $4, 'full', $5, now(), now())`,
      [randomUUID(), SPACE, memoryId, READER, OWNER],
    );
    const propose = async (payload: Record<string, unknown>) => {
      const proposalId = randomUUID();
      await db.pool.query(
        `INSERT INTO proposals (id, space_id, proposal_type, status, payload_json, created_by_user_id, title, risk_level, urgency, visibility, created_at, updated_at)
         VALUES ($1, $2, 'memory_update', 'pending', $3::jsonb, $4, 'Move', 'low', 'normal', 'space_shared', now(), now())`,
        [proposalId, SPACE, JSON.stringify({
          operation: "update",
          target_memory_id: memoryId,
          provenance_entries: [{ source_type: "user_confirmation", source_id: ADMIN, source_trust: "user_confirmed" }],
          ...payload,
        }), ADMIN],
      );
      return proposalId;
    };
    const intoProject = await propose({ target_scope: "project", target_visibility: "space_shared", project_id: PROJECT });
    await expect(new PgProposalApplyService(config()).accept(intoProject, { spaceId: SPACE, userId: ADMIN }))
      .rejects.toMatchObject({ statusCode: 409, detail: expect.objectContaining({ code: "memory_owner_sharing_required" }) });
    const handOver = await propose({ target_visibility: "private", owner_user_id: ADMIN });
    await expect(new PgProposalApplyService(config()).accept(handOver, { spaceId: SPACE, userId: ADMIN }))
      .rejects.toMatchObject({ statusCode: 409, detail: expect.objectContaining({ code: "memory_owner_sharing_required" }) });
    const head = await db.pool.query<{ scope_type: string; owner_user_id: string; status: string }>(
      `SELECT scope_type, owner_user_id, status FROM memory_entries WHERE id = $1`, [memoryId],
    );
    expect(head.rows[0]).toEqual({ scope_type: "user", owner_user_id: OWNER, status: "active" });
  });

  it("keeps a personal memory out of Space-wide sharing and its derived content behind its source", async (ctx) => {
    if (!db.available) return ctx.skip();
    const memoryId = await ownMemory();
    await expect(service().updatePolicy({ spaceId: SPACE, userId: OWNER }, "memory", memoryId, {
      visibility: "space_shared",
      access_level: "full",
      project_id: null,
      grants: [],
    })).rejects.toMatchObject({ statusCode: 422 });

    const source = await activity("private");
    await db.pool.query(
      `INSERT INTO provenance_links (id, space_id, target_type, target_id, source_type, source_id, source_trust, created_at)
       VALUES ($1, $2, 'memory', $3, 'activity', $4, 'user_confirmed', now())`,
      [randomUUID(), SPACE, memoryId, source],
    );
    await expect(service().updatePolicy({ spaceId: SPACE, userId: OWNER }, "memory", memoryId, {
      visibility: "selected_users",
      access_level: "full",
      project_id: null,
      grants: [{ user_id: READER, access_level: "full" }],
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await grants(memoryId)).toEqual([]);
  });

  it("carries grants through a content revision and back through a revert", async (ctx) => {
    if (!db.available) return ctx.skip();
    const memoryId = await ownMemory({ visibility: "selected_users" });
    await db.pool.query(
      `INSERT INTO content_access_grants (id, space_id, resource_type, resource_id, grantee_user_id, granted_by_user_id, access_level, created_at, updated_at)
       VALUES ($1, $2, 'memory', $3, $4, $5, 'full', now(), now())`,
      [randomUUID(), SPACE, memoryId, READER, OWNER],
    );
    const proposalId = randomUUID();
    await db.pool.query(
      `INSERT INTO proposals (id, space_id, proposal_type, status, payload_json, created_by_user_id, title, risk_level, urgency, visibility, created_at, updated_at)
       VALUES ($1, $2, 'memory_update', 'pending', $3::jsonb, $4, 'Revise', 'low', 'normal', 'space_shared', now(), now())`,
      [proposalId, SPACE, JSON.stringify({
        operation: "update",
        target_memory_id: memoryId,
        proposed_content: "revised",
        provenance_entries: [{ source_type: "user_confirmation", source_id: OWNER, source_trust: "user_confirmed" }],
      }), OWNER],
    );
    // Reviewed by the Space owner: the revision keeps the audience it had.
    await new PgProposalApplyService(config()).accept(proposalId, { spaceId: SPACE, userId: ADMIN });
    const head = await db.pool.query<{ id: string }>(
      `SELECT id FROM memory_entries WHERE supersedes_memory_id = $1 AND status = 'active'`,
      [memoryId],
    );
    const headId = head.rows[0]!.id;
    expect(await grants(headId)).toEqual([READER]);
    expect(await grants(memoryId)).toEqual([]);

    await new PgMemoryApplyRepository(db.pool).revertToPreviousVersion(SPACE, OWNER, headId);
    expect(await grants(memoryId)).toEqual([READER]);
    expect(await grants(headId)).toEqual([]);
  });

  it("turns a Project's Activity into Project Memory only once every Project reader can read it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const owner = { spaceId: SPACE, userId: OWNER };
    const privateCapture = await activity("private");
    await expect(new PgActivityRepository(db.pool).consolidate(owner, privateCapture))
      .rejects.toMatchObject({ statusCode: 409, responseBody: expect.objectContaining({ code: "activity_share_required" }) });

    const sharedCapture = await activity("space_shared");
    const [proposal] = await new PgActivityRepository(db.pool).consolidate(owner, sharedCapture);
    const payload = await db.pool.query<{ payload_json: Record<string, unknown>; visibility: string; project_id: string }>(
      `SELECT payload_json, visibility, project_id FROM proposals WHERE id = $1`,
      [proposal!.id],
    );
    expect(payload.rows[0]).toMatchObject({
      visibility: "space_shared",
      project_id: PROJECT,
      payload_json: expect.objectContaining({ target_scope: "project", target_visibility: "space_shared" }),
    });

    // The Project narrows the record before anyone accepts: the applier asks again.
    await db.pool.query(`UPDATE activity_records SET visibility = 'private' WHERE id = $1`, [sharedCapture]);
    await expect(new PgProposalApplyService(config()).accept(proposal!.id, { spaceId: SPACE, userId: ADMIN }))
      .rejects.toMatchObject({ statusCode: 409, detail: expect.objectContaining({ code: "memory_source_audience" }) });

    await db.pool.query(`UPDATE activity_records SET visibility = 'space_shared' WHERE id = $1`, [sharedCapture]);
    await new PgProposalApplyService(config()).accept(proposal!.id, { spaceId: SPACE, userId: ADMIN });
    const memory = await db.pool.query<{ scope_type: string; project_id: string; visibility: string }>(
      `SELECT scope_type, project_id, visibility FROM memory_entries WHERE space_id = $1 AND status = 'active'`,
      [SPACE],
    );
    expect(memory.rows).toEqual([{ scope_type: "project", project_id: PROJECT, visibility: "space_shared" }]);
  });
});
