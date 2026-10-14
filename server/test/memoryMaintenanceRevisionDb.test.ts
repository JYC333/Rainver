import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { PgMemoryProposalRepository } from "../src/modules/memory/proposalRepository.js";
import {
  createMemoryMaintenanceJob,
  runMemoryMaintenanceJobOnce,
} from "../src/modules/memory/maintenanceJobs.js";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { insertMemoryEntry } from "./support/memoryFixtures.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { MemoryMaintenanceJobCreateRequestSchema } from "@rainver/protocol";

// Maintenance hands only real changes to a person (P04 D13/D72): a revision
// the finding asked for is written before it can be accepted, an accept that
// changes nothing writes no version, and a capped scan resumes where it
// stopped instead of finishing early.

const db = useTestDatabase(import.meta.filename);
const SPACE = "space-revision";
const OWNER = "owner-revision";
const ADMIN = "admin-revision";
const PROJECT = randomUUID();

function config() {
  return loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: ADMIN, project: PROJECT, spaceType: "household" });
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER });
});

async function ownMemory(content: string): Promise<string> {
  const id = randomUUID();
  await insertMemoryEntry(db.pool, SPACE, { id, owner_user_id: OWNER, subject_user_id: OWNER, root_memory_id: id, content });
  return id;
}

async function pendingUpdate(payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO proposals (id, space_id, proposal_type, status, payload_json, created_by_user_id, title, risk_level, urgency, visibility, created_at, updated_at)
     VALUES ($1, $2, 'memory_update', 'pending', $3::jsonb, $4, 'Maintenance', 'medium', 'normal', 'space_shared', now(), now())`,
    [id, SPACE, JSON.stringify({ operation: "update", ...payload }), OWNER],
  );
  return id;
}

async function activeVersions(memoryRoot: string) {
  const result = await db.pool.query<{ content: string; source_trust: string | null }>(
    `SELECT content, source_trust FROM memory_entries WHERE root_memory_id = $1 AND status = 'active'`,
    [memoryRoot],
  );
  return result.rows;
}

describe("memoryMaintenanceRevisionDb", () => {
  it("refuses a finding's update until its owner writes the revision, then applies what they wrote", async (ctx) => {
    if (!db.available) return ctx.skip();
    const memoryId = await ownMemory("The office opens at 9.");
    const packetId = randomUUID();
    const proposalId = await pendingUpdate({
      target_memory_id: memoryId,
      maintenance_action: "review_contradiction",
      requires_operator_edit: true,
      provenance_entries: [{ source_type: "proposal", source_id: packetId }],
    });
    const apply = new PgProposalApplyService(config());

    await expect(apply.accept(proposalId, { spaceId: SPACE, userId: ADMIN }))
      .rejects.toMatchObject({ statusCode: 409, detail: expect.objectContaining({ code: "memory_operator_edit_required" }) });

    const repository = new PgMemoryProposalRepository(db.pool, config());
    // Someone who cannot read the entry cannot rewrite it, nor learn it exists.
    await expect(repository.reviseOperatorEditProposal(SPACE, ADMIN, proposalId, { content: "Opens at 7." }))
      .rejects.toMatchObject({ statusCode: 404 });
    const revised = await repository.reviseOperatorEditProposal(SPACE, OWNER, proposalId, { content: "The office opens at 8." });
    expect(revised.operator_revision).toMatchObject({ edited_by_user_id: OWNER });
    expect(revised.provenance_entries?.map((entry) => entry.source_type)).toEqual(["proposal", "user_confirmation"]);

    await apply.accept(proposalId, { spaceId: SPACE, userId: ADMIN });
    expect(await activeVersions(memoryId)).toEqual([{ content: "The office opens at 8.", source_trust: "user_confirmed" }]);
  });

  it("accepts an update that changes nothing without writing a version", async (ctx) => {
    if (!db.available) return ctx.skip();
    const memoryId = await ownMemory("Unchanged.");
    const proposalId = await pendingUpdate({
      target_memory_id: memoryId,
      proposed_content: "Unchanged.",
      provenance_entries: [{ source_type: "user_confirmation", source_id: OWNER, source_trust: "user_confirmed" }],
    });

    await new PgProposalApplyService(config()).accept(proposalId, { spaceId: SPACE, userId: ADMIN });

    const versions = await db.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM memory_entries WHERE space_id = $1`,
      [SPACE],
    );
    expect(versions.rows).toEqual([{ id: memoryId, status: "active" }]);
    const proposal = await db.pool.query<{ status: string; payload_json: Record<string, unknown> }>(
      `SELECT status, payload_json FROM proposals WHERE id = $1`,
      [proposalId],
    );
    expect(proposal.rows[0]).toMatchObject({
      status: "accepted",
      payload_json: expect.objectContaining({ no_change: true, resulting_memory_id: memoryId }),
    });
  });

  it("keeps a capped job open until every finding is out, and resumes a failed page", async (ctx) => {
    if (!db.available) return ctx.skip();
    for (let index = 0; index < 3; index += 1) await ownMemory("tiny");
    await db.pool.query(`UPDATE memory_entries SET updated_at = '2020-01-01T00:00:00Z', title = id WHERE space_id = $1`, [SPACE]);
    const job = await createMemoryMaintenanceJob(db.pool, {
      spaceId: SPACE,
      ownerUserId: OWNER,
      request: MemoryMaintenanceJobCreateRequestSchema.parse({ max_findings: 2, persist_report: false, stale_after_days: 30, thin_content_chars: 10 }),
    });
    const run = () => runMemoryMaintenanceJobOnce(db.pool, { spaceId: SPACE, userId: OWNER, jobId: job.id, includeSpaceOps: false });

    const findings: number[] = [];
    let status = "pending";
    for (let page = 0; page < 10 && status !== "completed"; page += 1) {
      const result = await run();
      findings.push(result!.report?.findings.length ?? 0);
      status = result!.job.status;
    }
    expect(status).toBe("completed");
    expect(findings.reduce((sum, count) => sum + count, 0)).toBe(6);

    await db.pool.query(
      `UPDATE memory_maintenance_jobs SET status = 'failed', cursor = NULL, completed_at = NULL, error_message = 'boom' WHERE id = $1`,
      [job.id],
    );
    const resumed = await run();
    expect(resumed!.job).toMatchObject({ status: "pending", error_message: null, completed_at: null });
    expect(resumed!.report?.findings).toHaveLength(2);
  });
});
