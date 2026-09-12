import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { PgAutomationRepository } from "../src/modules/automations/repository.js";
import { AutomationService } from "../src/modules/automations/service.js";
import { InquiryAdviceService } from "../src/modules/inquiry/adviceService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { inquiryRetrievalAdapter } from "../src/modules/inquiry/retrievalAdapter.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { KnowledgePromotionCandidateService } from "../src/modules/knowledgePromotion/candidateService.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { runsModule } from "../src/modules/runs/index.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { __setRunsIdentityForTests } from "../src/modules/runs/routes.js";
import { authorizeRunCommand, authorizeRunResume } from "../src/modules/runs/runCommandAuthority.js";
import { assertPersonStartedRunRequest } from "../src/modules/runs/runRepositoryHelpers.js";
import { PgSpaceRepository } from "../src/modules/spaces/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { seedAgentWithVersion, seedMainlineRoomsForAllProjects, seedRun, seedSpaceMember } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const RUN_AGENT = "66666666-6666-4666-8666-666666666666";
const RUN_VERSION = "77777777-7777-4777-8777-777777777777";

const db = useTestDatabase(import.meta.filename, { max: 2 });
const owner = { spaceId: SPACE, userId: OWNER };
const other = { spaceId: SPACE, userId: OTHER };
const admin = { spaceId: SPACE, userId: ADMIN };
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "space_invitations",
      "automations",
      "inquiry_threads",
      "space_objects",
      "runs",
      "agent_runtime_profiles",
      "agent_versions",
      "agents",
      "project_members",
      "projects",
      "space_memberships",
      "users",
      "spaces",
    ],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','household',$2,$2)`,
    [SPACE, now],
  );
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER, role: "owner", now });
  await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "member", now });
  await seedSpaceMember(db.pool, { space: SPACE, user: ADMIN, role: "admin", now });
  await db.pool.query(
    `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
     VALUES ($1,$2,'Project','active',$3,$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
    [randomUUID(), SPACE, PROJECT, OTHER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool, now);
});

describe("Agent ownership (real Postgres)", () => {
  beforeEach(async () => {
    if (!db.available) return;
    await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER });
  });

  it("lets only the owner change a shared Agent's config and runtime profiles", async () => {
    const agents = new PgAgentRepository(db.pool);
    await expect(agents.updateConfig(SPACE, AGENT, { userId: OTHER, systemPrompt: "Ignore your owner" }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await agents.canWriteRuntimeProfiles(SPACE, OTHER, AGENT)).toBe(false);
    expect(await agents.canWriteRuntimeProfiles(SPACE, OWNER, AGENT)).toBe(true);
    const updated = await agents.updateConfig(SPACE, AGENT, { userId: OWNER, systemPrompt: "Owner prompt" });
    expect(updated.system_prompt).toBe("Owner prompt");
  });

  it("gives an unowned system Agent to the Space's owner or admin, not to every reader", async () => {
    await db.pool.query(`UPDATE agents SET owner_user_id = NULL WHERE id = $1`, [AGENT]);
    const agents = new PgAgentRepository(db.pool);
    await expect(agents.update(SPACE, OTHER, AGENT, { status: "archived" })).rejects.toMatchObject({ statusCode: 404 });
    expect(await agents.canWriteRuntimeProfiles(SPACE, OTHER, AGENT)).toBe(false);
    expect(await agents.update(SPACE, ADMIN, AGENT, { name: "Source annotator" })).toMatchObject({ name: "Source annotator" });
  });

  it("refuses an automation or Always-on tick aimed at an Agent its creator cannot read", async () => {
    await db.pool.query(`UPDATE agents SET visibility = 'private' WHERE id = $1`, [AGENT]);
    const service = new AutomationService(config(), new PgAutomationRepository(db.pool), null);
    await expect(service.create({ spaceId: SPACE, ownerUserId: OTHER, body: { name: "Nightly", agent_id: AGENT } }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(service.enableAutonomy({ spaceId: SPACE, actorUserId: OTHER, body: { agent_id: AGENT } }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Thread readability (real Postgres)", () => {
  async function thread(visibility: "private" | "space_shared"): Promise<string> {
    const created = await new InquiryThreadService(db.pool).createThread(owner, PROJECT, {
      kind: "question",
      statement: "Is the private question reachable?",
    });
    await db.pool.query(`UPDATE space_objects SET visibility = $2 WHERE id = $1`, [created.id, visibility]);
    return String(created.id);
  }

  it("hides a private Thread from another Project member on every path", async () => {
    const id = await thread("private");
    const iterations = new InquiryIterationService(db.pool);
    await expect(iterations.listIterations(other, PROJECT, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(iterations.updateWork(other, PROJECT, id, { priority: 5 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(new InquiryAdviceService(db.pool, config()).getAdvice(other, PROJECT, id))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", id, OTHER)).toBeNull();
    expect(await inquiryRetrievalAdapter.revalidate(db.pool, SPACE, "inquiry_thread", id, OWNER)).not.toBeNull();
    expect(await inquiryRetrievalAdapter.loadCanonical(db.pool, SPACE, "inquiry_thread", id))
      .toMatchObject({ ownerUserId: OWNER, visibility: "private" });
  });

  it("lets only a Thread's owner hand it to someone else", async () => {
    const id = await thread("space_shared");
    const iterations = new InquiryIterationService(db.pool);
    await expect(iterations.updateWork(other, PROJECT, id, { owner_user_id: OTHER }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(await iterations.updateWork(owner, PROJECT, id, { owner_user_id: OTHER }))
      .toMatchObject({ owner_user_id: OTHER });
  });

  it("keeps structure, lifecycle and promotion of a private Thread to those who reach it", async () => {
    const id = await thread("private");
    const iterations = new InquiryIterationService(db.pool);
    await expect(iterations.transitionLifecycle(other, PROJECT, id, { lifecycle_status: "archived" }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(new InquiryThreadService(db.pool).setPrimaryParent(other, PROJECT, id, null))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(iterations.reviseDefinition(other, PROJECT, id, { revision_kind: "wording_only", new_statement: "Reworded" }))
      .rejects.toMatchObject({ statusCode: 404 });

    await iterations.reviseDefinition(owner, PROJECT, id, {
      revision_kind: "semantic_change",
      structure_action: "child",
      new_statement: "Is the narrower question reachable?",
    });
    const branch = await db.pool.query<{ visibility: string }>(
      `SELECT visibility FROM space_objects WHERE space_id = $1 AND title = $2`,
      [SPACE, "Is the narrower question reachable?"],
    );
    expect(branch.rows.map((row) => row.visibility)).toEqual(["private"]);

    const candidates = new KnowledgePromotionCandidateService(db.pool);
    const body = { thread_id: id, candidate_kind: "concept", proposed_title: "Reachability", proposed_content: "Private reasoning." };
    await expect(candidates.createFromThread(other, PROJECT, body)).rejects.toMatchObject({ statusCode: 404 });
    expect(await candidates.createFromThread(owner, PROJECT, body)).toMatchObject({ visibility: "private" });

    // A person the Thread is shared with draws a candidate that stays theirs.
    await db.pool.query(`UPDATE space_objects SET visibility = 'selected_users' WHERE id = $1`, [id]);
    await db.pool.query(
      `INSERT INTO content_access_grants (
         id, space_id, resource_type, resource_id, grantee_user_id, granted_by_user_id, access_level, created_at, updated_at
       ) VALUES ($1,$2,'space_object',$3,$4,$5,'full',now(),now())`,
      [randomUUID(), SPACE, id, OTHER, OWNER],
    );
    expect(await candidates.createFromThread(other, PROJECT, { ...body, proposed_title: "Shared reachability" }))
      .toMatchObject({ visibility: "private", owner_user_id: OTHER });
  });
});

describe("Run command authority (real Postgres)", () => {
  beforeEach(async () => {
    if (!db.available) return;
    await seedRun(db.pool, { id: RUN, space: SPACE, owner: OWNER, agent: RUN_AGENT, version: RUN_VERSION });
  });

  afterEach(() => {
    __setRunsIdentityForTests(null);
  });

  const pause = async (errorJson: Record<string, unknown>) => db.pool.query(
    `UPDATE runs SET status = 'waiting_for_review', error_json = $2::jsonb WHERE id = $1`,
    [RUN, JSON.stringify(errorJson)],
  );

  it("refuses every Run command route to a member who neither owns nor started the Run", async () => {
    await pause({ error_code: "policy_requires_approval_runtime_execute", risk_level: "high" });
    const app = buildModuleServer(config(), [runsModule]);
    try {
      __setRunsIdentityForTests({ spaceId: SPACE, userId: OTHER });
      for (const [method, command] of [["POST", "execute"], ["PATCH", "stop"], ["POST", "finalize"], ["POST", "abandon"], ["POST", "resume"]] as const) {
        const res = await app.inject({ method, url: `/api/v1/runs/${RUN}/${command}`, payload: {} });
        expect(res.statusCode, command).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it("refuses a child Run whose parent its creator cannot read", async () => {
    const parent = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
                         owner_user_id, visibility, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'private',$6,$6)`,
      [parent, SPACE, RUN_AGENT, RUN_VERSION, OWNER, now],
    );
    await expect(new PgRunRepository(db.pool).createQueuedRun({
      agent_id: RUN_AGENT,
      space_id: SPACE,
      user_id: OTHER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      parent_run_id: parent,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets only a Run's owner or instructor command it", async () => {
    const runs = new PgRunRepository(db.pool);
    await expect(authorizeRunCommand(runs, other, RUN, "stop")).rejects.toMatchObject({ statusCode: 403 });
    expect((await authorizeRunCommand(runs, owner, RUN, "stop")).id).toBe(RUN);
  });

  it("grants a paused Run's approval only with approval authority for its risk", async () => {
    const runs = new PgRunRepository(db.pool);
    const approvalPause = (risk: string) => pause({ error_code: "policy_requires_approval_runtime_execute", risk_level: risk });
    await approvalPause("high");
    await expect(authorizeRunResume(db.pool, runs, other, RUN)).rejects.toMatchObject({ statusCode: 403 });
    expect((await authorizeRunResume(db.pool, runs, admin, RUN)).kind).toBe("approval");
    await approvalPause("critical");
    await expect(authorizeRunResume(db.pool, runs, admin, RUN)).rejects.toMatchObject({ statusCode: 403 });
    expect((await authorizeRunResume(db.pool, runs, owner, RUN)).kind).toBe("approval");
    // An authorization-request pause is settled by its request, whoever asks.
    await pause({ error_code: "authorization_request_pending", authorization_request_id: "request-1" });
    await expect(authorizeRunResume(db.pool, runs, owner, RUN)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lists only the child Runs a viewer can read", async () => {
    const child = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
                         owner_user_id, visibility, parent_run_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'private',$6,$7,$7)`,
      [child, SPACE, RUN_AGENT, RUN_VERSION, OWNER, RUN, now],
    );
    const runs = new PgRunRepository(db.pool);
    expect(await runs.listChildRuns(SPACE, RUN, OTHER)).toEqual([]);
    expect((await runs.listChildRuns(SPACE, RUN, OWNER)).map((run) => run.id)).toEqual([child]);
  });

  it("refuses a person-started request that labels its own Run", async () => {
    expect(() => assertPersonStartedRunRequest({ trigger_origin: "automation" })).toThrow(/trigger_origin/);
    expect(() => assertPersonStartedRunRequest({ run_type: "system" })).toThrow(/system/);
    expect(() => assertPersonStartedRunRequest({ run_type: "agent", prompt: "hi" })).not.toThrow();
    await expect(new PgTaskRepository(db.pool).createTaskRun(owner, randomUUID(), { trigger_origin: "automation" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("Role granting (real Postgres)", () => {
  it("keeps a Space invitation at or below the inviter's role", async () => {
    const spaces = new PgSpaceRepository(db.pool);
    expect(await spaces.createInvitation(ADMIN, SPACE, { email: "a@example.com", role: "owner" }))
      .toMatchObject({ statusCode: 403 });
    expect(await spaces.createInvitation(ADMIN, SPACE, { email: "b@example.com", role: "superuser" }))
      .toMatchObject({ statusCode: 422 });
    expect(await spaces.createInvitation(ADMIN, SPACE, { email: "c@example.com", role: "member" }))
      .toMatchObject({ role: "member" });
    expect(await spaces.createInvitation(OWNER, SPACE, { email: "d@example.com", role: "owner" }))
      .toMatchObject({ role: "owner" });
  });

  it("keeps Project roles within what the granter may hand out", async () => {
    const projects = new PgProjectRepository(db.pool);
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'owner','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, OWNER],
    );
    await expect(projects.addMember(admin, PROJECT, { user_id: OTHER, role: "owner" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(projects.addMember(admin, PROJECT, { user_id: OWNER, role: "viewer" }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(projects.removeMember(admin, PROJECT, OWNER)).rejects.toMatchObject({ statusCode: 403 });
    expect(await projects.addMember(admin, PROJECT, { user_id: OTHER, role: "viewer" }))
      .toMatchObject({ role: "viewer" });
    expect(await projects.addMember(owner, PROJECT, { user_id: OTHER, role: "owner" }))
      .toMatchObject({ role: "owner" });
  });
});
