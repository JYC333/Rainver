import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { insertProposalRow } from "../src/modules/proposals/reviewPackets.js";
import { runsModule } from "../src/modules/runs/index.js";
import { __setRunsIdentityForTests } from "../src/modules/runs/routes.js";
import { runToOut } from "../src/modules/runs/runReadModel.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgSourcesRepository } from "../src/modules/sources/repository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { seedAgentWithVersion, seedMainlineRoomsForAllProjects, seedSpaceMember } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const ACTIVITY = "66666666-6666-4666-8666-666666666666";
const ARTIFACT = "77777777-7777-4777-8777-777777777777";

const db = useTestDatabase(import.meta.filename, { max: 2 });
const owner = { spaceId: SPACE, userId: OWNER };
const other = { spaceId: SPACE, userId: OTHER };

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "task_runs",
      "tasks",
      "policy_decision_records",
      "proposals",
      "artifacts",
      "activity_records",
      "source_items",
      "runs",
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
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,'Owner','active',$2,$2)`,
    [OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "member", now });
  await db.pool.query(
    `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
     VALUES ($1,$2,'Project','active',$3,$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool, now);
  await seedAgentWithVersion(db.pool, {
    agent: AGENT,
    version: VERSION,
    space: SPACE,
    owner: OWNER,
    systemPrompt: "SECRET AGENT PROMPT",
    now,
  });
});

describe("skipped-surface access (real Postgres)", () => {
  it("hides private Agent versions and restore from another member", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE agents SET visibility='private' WHERE id=$1`, [AGENT]);
    const repo = new PgAgentRepository(db.pool);

    await expect(repo.getCurrentVersion(SPACE, OTHER, AGENT)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repo.listVersions(SPACE, OTHER, AGENT)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repo.getVersion(SPACE, OTHER, AGENT, VERSION)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repo.restoreVersion(SPACE, AGENT, VERSION, OTHER)).rejects.toMatchObject({ statusCode: 404 });

    expect(await repo.getCurrentVersion(SPACE, OWNER, AGENT)).toMatchObject({
      id: VERSION,
      system_prompt: "SECRET AGENT PROMPT",
    });
    await expect(repo.restoreVersion(SPACE, AGENT, VERSION, OWNER)).resolves.toMatchObject({ id: AGENT });
  });

  it("withholds Agent system_prompt from summary viewers and refuses their restore", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE agents SET visibility='space_shared', access_level='summary' WHERE id=$1`,
      [AGENT],
    );
    const repo = new PgAgentRepository(db.pool);

    expect(await repo.getVisible(SPACE, OTHER, AGENT)).toMatchObject({ system_prompt: null });
    expect(await repo.getCurrentVersion(SPACE, OTHER, AGENT)).toMatchObject({
      id: VERSION,
      system_prompt: null,
    });
    expect(await repo.getVisible(SPACE, OWNER, AGENT)).toMatchObject({
      system_prompt: "SECRET AGENT PROMPT",
    });
    await expect(repo.restoreVersion(SPACE, AGENT, VERSION, OTHER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("withholds Activity, Artifact, and Run bodies from summary viewers", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO activity_records
         (id, space_id, user_id, owner_user_id, activity_type, title, content,
          payload_json, occurred_at, created_at, updated_at, status, source_trust,
          visibility, access_level)
       VALUES ($1,$2,$3,$3,'user_capture','Shared note','SECRET ACTIVITY BODY',
               '{"secret":"payload"}'::jsonb,$4,$4,$4,'raw','user_confirmed','space_shared','summary')`,
      [ACTIVITY, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO artifacts
         (id, space_id, artifact_type, title, content, export_formats_json, visibility,
          access_level, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,'note','Shared artifact','SECRET ARTIFACT BODY','[]'::jsonb,
               'space_shared','summary',$3,$4,$4)`,
      [ARTIFACT, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         owner_user_id, visibility, access_level, output_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'space_shared','summary',
                 '{"text":"SECRET RUN OUTPUT"}'::jsonb,$6,$6)`,
      [RUN, SPACE, AGENT, VERSION, OWNER, now],
    );

    const activity = new PgActivityRepository(db.pool);
    const listed = await activity.list(other, { limit: 10, offset: 0 });
    expect(listed).toEqual([expect.objectContaining({
      id: ACTIVITY,
      title: "Shared note",
      content: "",
      metadata_json: {},
    })]);
    expect(await activity.getOut(other, ACTIVITY)).toMatchObject({ content: "", metadata_json: {} });
    expect(await activity.getOut(owner, ACTIVITY)).toMatchObject({
      content: "SECRET ACTIVITY BODY",
      metadata_json: { secret: "payload" },
    });
    await expect(activity.consolidate(other, ACTIVITY)).rejects.toMatchObject({ statusCode: 404 });

    const artifacts = new PgArtifactRepository(db.pool, {
      artifactStorageRoot: "/tmp",
      sandboxRoot: "/tmp",
    });
    expect(await artifacts.getVisible(SPACE, OTHER, ARTIFACT, true)).toMatchObject({
      title: "Shared artifact",
      content: null,
    });
    expect(await artifacts.exportVisible(SPACE, OTHER, ARTIFACT)).toBeNull();
    expect(await artifacts.getVisible(SPACE, OWNER, ARTIFACT, true)).toMatchObject({
      content: "SECRET ARTIFACT BODY",
    });

    const runs = new PgRunRepository(db.pool);
    const otherRun = await runs.getVisibleRun(SPACE, OTHER, RUN);
    expect(otherRun?.effective_access_level).toBe("summary");
    expect(runToOut(otherRun!)).toMatchObject({ output_json: null });
    const ownerRun = await runs.getVisibleRun(SPACE, OWNER, RUN);
    expect(runToOut(ownerRun!)).toMatchObject({ output_json: { text: "SECRET RUN OUTPUT" } });
  });

  it("withholds a Run's output from summary viewers of its Task's run list", async () => {
    const now = new Date().toISOString();
    const TASK = "88888888-8888-4888-8888-888888888888";
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         owner_user_id, visibility, access_level, output_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'space_shared','summary',
                 '{"text":"SECRET RUN OUTPUT"}'::jsonb,$6,$6)`,
      [RUN, SPACE, AGENT, VERSION, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO tasks (id, space_id, title, owner_user_id, visibility, access_level, created_at, updated_at)
       VALUES ($1,$2,'Shared task',$3,'space_shared','full',$4,$4)`,
      [TASK, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at) VALUES ($1,$2,$3,$4,'primary',$5)`,
      [randomUUID(), SPACE, TASK, RUN, now],
    );

    const tasks = new PgTaskRepository(db.pool);
    const forOther = await tasks.listTaskRuns(other, TASK, 10, 0);
    expect(forOther.items).toEqual([expect.objectContaining({ run: expect.objectContaining({ output_json: null }) })]);
    const forOwner = await tasks.listTaskRuns(owner, TASK, 10, 0);
    expect(forOwner.items[0]?.run).toMatchObject({ output_json: { text: "SECRET RUN OUTPUT" } });
  });

  it("serves an Agent's owner their own prompt in every write response", async () => {
    const repo = new PgAgentRepository(db.pool);
    expect(await repo.update(SPACE, OWNER, AGENT, { status: "active" })).toMatchObject({
      system_prompt: "SECRET AGENT PROMPT",
    });
    expect(await repo.updateConfig(SPACE, AGENT, { userId: OWNER, systemPrompt: "NEW OWNER PROMPT" })).toMatchObject({
      system_prompt: "NEW OWNER PROMPT",
    });
  });

  it("withholds a Run's error text from summary viewers while keeping its status", async () => {
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         owner_user_id, visibility, access_level, error_message, error_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'agent','manual','failed','live',$5,'space_shared','summary',
                 'SECRET FAILURE TEXT','{"detail":"SECRET"}'::jsonb,$6,$6)`,
      [RUN, SPACE, AGENT, VERSION, OWNER, now],
    );
    const runs = new PgRunRepository(db.pool);
    const forOther = runToOut((await runs.getVisibleRun(SPACE, OTHER, RUN))!);
    expect(forOther).toMatchObject({ status: "failed", error_message: null, error_json: null });
    expect(runToOut((await runs.getVisibleRun(SPACE, OWNER, RUN))!)).toMatchObject({
      error_message: "SECRET FAILURE TEXT",
    });
  });

  it("returns an Activity's body to its author on create", async () => {
    const created = await new PgActivityRepository(db.pool).create(owner, {
      source_type: "user_capture",
      content: "SECRET CREATED BODY",
    });
    expect(created).toMatchObject({ content: "SECRET CREATED BODY" });
  });

  it("returns a source item's URI to its creator on manual-URL create", async () => {
    const created = await new PgSourcesRepository(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri }))
      .createManualUrl(owner, { url: "https://example.com/secret-page", visibility: "private" });
    expect(created).toMatchObject({
      source_uri: "https://example.com/secret-page",
      effective_access_level: "full",
    });
  });

  it("refuses code_patch rollback without the apply gate", async () => {
    if (!db.available) return;
    const proposal = await insertProposalRow(db.pool, {
      spaceId: SPACE,
      proposalType: "code_patch",
      title: "Accepted patch",
      payload: { file_count: 1 },
      rationale: "fixture",
      createdByUserId: OWNER,
      ownerUserId: OWNER,
      visibility: "space_shared",
      status: "accepted",
      riskLevel: "high",
      requiredApproverRole: "owner",
    });
    const apply = PgProposalApplyService.fromConfig(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    }));
    await expect(apply.rollback(proposal.id, other)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("run trace over HTTP (real Postgres)", () => {
  afterEach(() => {
    __setRunsIdentityForTests(null);
  });

  it("withholds step text on /trace from a summary viewer and serves it to the owner", async () => {
    const now = new Date().toISOString();
    const actorId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         owner_user_id, visibility, access_level, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'space_shared','summary',$6,$6)`,
      [RUN, SPACE, AGENT, VERSION, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO actors (id, actor_type, metadata_json, created_at, updated_at) VALUES ($1,'agent','{}'::jsonb,$2,$2)`,
      [actorId, now],
    );
    await db.pool.query(
      `INSERT INTO run_steps (id, space_id, run_id, actor_id, step_index, step_type, status, title,
                             output_summary, metadata_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,0,'adapter_completed','succeeded','Call model','SECRET STEP OUTPUT','{}'::jsonb,$5,$5)`,
      [randomUUID(), SPACE, RUN, actorId, now],
    );
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule]);
    try {
      __setRunsIdentityForTests({ spaceId: SPACE, userId: OTHER });
      const forOther = await app.inject({ method: "GET", url: `/api/v1/runs/${RUN}/trace` });
      expect(forOther.statusCode).toBe(200);
      expect(forOther.json().steps).toEqual([
        expect.objectContaining({ title: "Call model", output_summary: null }),
      ]);
      __setRunsIdentityForTests({ spaceId: SPACE, userId: OWNER });
      const forOwner = await app.inject({ method: "GET", url: `/api/v1/runs/${RUN}/trace` });
      expect(forOwner.json().steps).toEqual([
        expect.objectContaining({ output_summary: "SECRET STEP OUTPUT" }),
      ]);
    } finally {
      await app.close();
    }
  });
});
