import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { DecisionCaseService } from "../src/modules/decisions/caseService";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for the Decision slice: Decision Case referencing
// Inquiry Thread findings by
// reference (never copying them), Options/Criteria/Trade-offs, the decide()
// checkpoint, Commitment, and the explicit Decision -> Delivery Task action.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

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
    console.warn(`[decisions-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE decision_option_scores, decision_commitments, decision_criteria, decision_options,
       decision_case_sources, decision_cases, tasks, inquiry_threads, projects, space_memberships,
       users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
});

describe("Decision Domain (real Postgres)", () => {
  it("golden path: Case referencing a Thread, Options, Criteria, Trade-offs, decide, Commitment, and Decision -> Delivery", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const thread = await threadSvc.createThread(identity, PROJECT, { kind: "hypothesis", statement: "Switching providers reduces cost" });

    const cases = new DecisionCaseService(pool);
    const decisionCase = await cases.createCase(identity, PROJECT, {
      title: "Which provider to switch to",
      framing: "Cost pressure from the current vendor",
      source_thread_ids: [thread.id],
    });
    expect(decisionCase).toMatchObject({ status: "open", title: "Which provider to switch to" });

    const detail = await cases.getCase(identity, PROJECT, decisionCase.id as string);
    expect(detail.source_thread_ids).toEqual([thread.id]);
    await expect(threadSvc.getThread(identity, PROJECT, thread.id as string)).resolves.toMatchObject({
      decision_cases: [{
        id: decisionCase.id,
        title: "Which provider to switch to",
        status: "open",
      }],
    });

    const optionA = await cases.addOption(identity, PROJECT, decisionCase.id as string, { title: "Provider A" });
    const optionB = await cases.addOption(identity, PROJECT, decisionCase.id as string, { title: "Provider B" });
    const criterion = await cases.addCriterion(identity, PROJECT, decisionCase.id as string, { name: "Cost", weight: 5 });

    await cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: optionA.id, criterion_id: criterion.id, score: 4 });
    await cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: optionB.id, criterion_id: criterion.id, score: 2 });
    // Re-scoring the same (option, criterion) pair upserts rather than duplicating.
    const rescored = await cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: optionA.id, criterion_id: criterion.id, score: 5, rationale: "cheaper than expected" });
    expect(rescored).toMatchObject({ score: 5, rationale: "cheaper than expected" });
    const scoreCount = await pool.query(`SELECT count(*)::int AS n FROM decision_option_scores WHERE decision_case_id=$1`, [decisionCase.id]);
    expect(scoreCount.rows[0].n).toBe(2);

    // A Commitment requires a decided Case — too early while still open.
    await expect(cases.addCommitment(identity, PROJECT, decisionCase.id as string, { statement: "too early" })).rejects.toMatchObject({ statusCode: 409 });

    const decided = await cases.decide(identity, PROJECT, decisionCase.id as string, { option_id: optionA.id });
    expect(decided).toMatchObject({ status: "decided", decided_option_id: optionA.id });
    await expect(cases.decide(identity, PROJECT, decisionCase.id as string, { option_id: optionB.id })).rejects.toMatchObject({ statusCode: 409 });
    // Once decided, Options can no longer be added — too late.
    await expect(cases.addOption(identity, PROJECT, decisionCase.id as string, { title: "too late" })).rejects.toMatchObject({ statusCode: 409 });

    const commitment = await cases.addCommitment(identity, PROJECT, decisionCase.id as string, { statement: "Migrate to Provider A by Q3" });
    expect(commitment).toMatchObject({ created_delivery_task_id: null });

    const delivery = await cases.createDeliveryFromCommitment(identity, PROJECT, decisionCase.id as string, commitment.id as string, {});
    const taskId = (delivery.task as { id: string }).id;
    expect(delivery.commitment).toMatchObject({ created_delivery_task_id: taskId });
    const taskRow = await pool.query<{ project_id: string; task_type: string; metadata_json: { source_decision_commitment_id: string } }>(
      `SELECT project_id, task_type, metadata_json FROM tasks WHERE id=$1`, [taskId],
    );
    expect(taskRow.rows[0]).toMatchObject({ project_id: PROJECT, task_type: "delivery" });
    expect(taskRow.rows[0]!.metadata_json).toMatchObject({ source_decision_commitment_id: commitment.id, source_decision_case_id: decisionCase.id });

    // Idempotency: a second attempt on the same (already-delivered) Commitment is rejected.
    await expect(cases.createDeliveryFromCommitment(identity, PROJECT, decisionCase.id as string, commitment.id as string, {})).rejects.toMatchObject({ statusCode: 409 });
    const taskCount = await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE metadata_json->>'source_decision_commitment_id' = $1`, [commitment.id]);
    expect(taskCount.rows[0].n).toBe(1);
  });

  it("serializes concurrent Delivery creation without leaving an orphan Task", async () => {
    if (!available || !pool) return;
    const cases = new DecisionCaseService(pool);
    const decisionCase = await cases.createCase(identity, PROJECT, { title: "Concurrent delivery" });
    const option = await cases.addOption(identity, PROJECT, decisionCase.id as string, { title: "Proceed" });
    await cases.decide(identity, PROJECT, decisionCase.id as string, { option_id: option.id });
    const commitment = await cases.addCommitment(identity, PROJECT, decisionCase.id as string, { statement: "Ship it" });
    const results = await Promise.allSettled([
      cases.createDeliveryFromCommitment(identity, PROJECT, decisionCase.id as string, commitment.id as string, {}),
      cases.createDeliveryFromCommitment(identity, PROJECT, decisionCase.id as string, commitment.id as string, {}),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const tasks = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tasks WHERE metadata_json->>'source_decision_commitment_id'=$1`,
      [commitment.id],
    );
    expect(tasks.rows[0]?.count).toBe(1);
  });

  it("rejects a source Thread that does not belong to the Project, and a decided Option from a different Case", async () => {
    if (!available || !pool) return;
    const cases = new DecisionCaseService(pool);
    await expect(cases.createCase(identity, PROJECT, { title: "x", source_thread_ids: [randomUUID()] })).rejects.toMatchObject({ statusCode: 422 });

    const caseOne = await cases.createCase(identity, PROJECT, { title: "Case One" });
    const caseTwo = await cases.createCase(identity, PROJECT, { title: "Case Two" });
    const optionInCaseTwo = await cases.addOption(identity, PROJECT, caseTwo.id as string, { title: "Option in Two" });
    await expect(cases.decide(identity, PROJECT, caseOne.id as string, { option_id: optionInCaseTwo.id })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a non-integer or missing Trade-off score instead of silently storing it", async () => {
    if (!available || !pool) return;
    const cases = new DecisionCaseService(pool);
    const decisionCase = await cases.createCase(identity, PROJECT, { title: "Case" });
    const option = await cases.addOption(identity, PROJECT, decisionCase.id as string, { title: "Option" });
    const criterion = await cases.addCriterion(identity, PROJECT, decisionCase.id as string, { name: "Cost" });

    await expect(cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: option.id, criterion_id: criterion.id })).rejects.toMatchObject({ statusCode: 422 });
    await expect(cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: option.id, criterion_id: criterion.id, score: "5" })).rejects.toMatchObject({ statusCode: 422 });
    await expect(cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: option.id, criterion_id: criterion.id, score: 3.5 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(cases.scoreOption(identity, PROJECT, decisionCase.id as string, { option_id: option.id, criterion_id: criterion.id, score: 6 })).rejects.toMatchObject({ statusCode: 422 });
    const count = await pool.query(`SELECT count(*)::int AS n FROM decision_option_scores WHERE decision_case_id=$1`, [decisionCase.id]);
    expect(count.rows[0].n).toBe(0);
  });
});
