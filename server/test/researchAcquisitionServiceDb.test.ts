import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { ResearchAcquisitionService } from "../src/modules/projectResearch/pipeline/researchAcquisitionService";
import { RESEARCH_PIPELINE_START_JOB } from "../src/modules/projectResearch/pipeline/researchAcquisitionPipelineJob";
import { HttpError } from "../src/modules/routeUtils/common";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for the synchronous half of `research.start_acquisition`
// (room-advancement-reliability-plan Phase 4): Thread validation, the
// "already starting" idempotency guard, and the enqueued job payload shape.
// The pipeline itself (assessment -> evaluate -> activate -> startInitialIntake)
// is covered in researchAcquisitionPipelineDb.test.ts.

const SPACE = "21111111-1111-4111-8111-111111111111";
const OWNER = "2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "25555555-5555-4555-8555-555555555555";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["jobs", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

describe("ResearchAcquisitionService (real Postgres)", () => {
  it("rejects a thread id that is not an active Question Thread", async () => {
    if (!db.available) return;
    await expect(
      new ResearchAcquisitionService(db.pool).startAcquisition(identity, PROJECT, {
        threadId: randomUUID(),
        originRoomId: null,
        originSessionId: null,
      }),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
  });

  it("enqueues a research_pipeline_start job carrying the Thread and Room origin", async () => {
    if (!db.available) return;
    const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "How should agents remember?",
    });
    const result = await new ResearchAcquisitionService(db.pool).startAcquisition(identity, PROJECT, {
      threadId: String(thread.id),
      intentNote: "test kickoff",
      originRoomId: "room-1",
      originSessionId: "session-1",
    });
    expect(result).toEqual({ status: "queued", thread_id: String(thread.id) });

    const jobs = await db.pool.query<{ payload_json: Record<string, unknown>; status: string }>(
      `SELECT payload_json, status FROM jobs WHERE space_id=$1 AND job_type=$2`,
      [SPACE, RESEARCH_PIPELINE_START_JOB],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.status).toBe("pending");
    expect(jobs.rows[0]!.payload_json).toMatchObject({
      thread_id: String(thread.id),
      project_id: PROJECT,
      intent_note: "test kickoff",
      origin_room_id: "room-1",
      origin_session_id: "session-1",
    });
  });

  it("no-ops with already_starting when a pipeline job for the Thread is already pending", async () => {
    if (!db.available) return;
    const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "What drives agent reliability?",
    });
    const service = new ResearchAcquisitionService(db.pool);
    const first = await service.startAcquisition(identity, PROJECT, {
      threadId: String(thread.id),
      originRoomId: null,
      originSessionId: null,
    });
    expect(first.status).toBe("queued");

    const second = await service.startAcquisition(identity, PROJECT, {
      threadId: String(thread.id),
      originRoomId: null,
      originSessionId: null,
    });
    expect(second).toEqual({ status: "already_starting", thread_id: String(thread.id) });

    const jobs = await db.pool.query(`SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2`, [SPACE, RESEARCH_PIPELINE_START_JOB]);
    expect(jobs.rows).toHaveLength(1);
  });

  // Regression test for the discovery-review finding: without an advisory
  // lock serializing the "already starting" check against the enqueue, two
  // concurrent calls can both observe no active job and both enqueue one —
  // duplicating real LLM-assessment/live-search pipeline cost. Same idiom as
  // InquiryThreadProposalService's coalesce lock.
  it("serializes concurrent calls for the same Thread so only one job is enqueued", async () => {
    if (!db.available) return;
    const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "Does concurrent start_acquisition enqueue exactly one job?",
    });
    const service = new ResearchAcquisitionService(db.pool);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.startAcquisition(identity, PROJECT, { threadId: String(thread.id), originRoomId: null, originSessionId: null }),
      ),
    );
    expect(results.filter((result) => result.status === "queued")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_starting")).toHaveLength(4);

    const jobs = await db.pool.query(`SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2`, [SPACE, RESEARCH_PIPELINE_START_JOB]);
    expect(jobs.rows).toHaveLength(1);
  });
});
