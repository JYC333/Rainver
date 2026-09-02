import { randomUUID } from "node:crypto";
import { seedServerHost, seedRoomManager } from "./support/domainSeeds.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { ProjectKernelService } from "../src/modules/projects/kernelService.js";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService.js";
import { ProjectOverviewService } from "../src/modules/projects/overviewService.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
import { registerAutomationsProjectIntegration } from "../src/modules/automations/projectIntegration.js";
import { registerInquiryProjectIntegration } from "../src/modules/inquiry/projectIntegration.js";
import { registerDecisionsProjectIntegration } from "../src/modules/decisions/projectIntegration.js";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration.js";
import { registerProposalsProjectIntegration } from "../src/modules/proposals/projectIntegration.js";
import { OperationalAlertService } from "../src/modules/notifications/operationalAlerts.js";
import { WorkContextService } from "../src/modules/runtimeContext/workContextService.js";
import { PgRuntimeContextAcquisitionRepository } from "../src/modules/runtimeContext/acquisitionRepository.js";

// Real-Postgres coverage for the Project Kernel: Profile application at
// creation, Brief versioning, Primary Mode transitions, Attention
// aggregation, and Overview composition. See ADR 0011 and PROJECTS.md.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_operations", "workspace_locations", "projects", "space_memberships", "users", "spaces", "hosts", "machines"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`,
    [SPACE, now],
  );
  await seedServerHost(db.pool, { id: HOST, now });
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES
       ($1, 'Owner', 'active', $4, $4), ($2, 'Outsider', 'active', $4, $4), ($3, 'Viewer', 'active', $4, $4)`,
    [OWNER, OUTSIDER, VIEWER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES
       ($1, $2, $3, 'owner', 'active', $5, $5), ($4, $2, $6, 'member', 'active', $5, $5)`,
    [randomUUID(), SPACE, OWNER, randomUUID(), now, VIEWER],
  );
  registerBuiltInAttentionAdapters();
});

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
});

const ownerIdentity = { spaceId: SPACE, userId: OWNER };
const outsiderIdentity = { spaceId: SPACE, userId: OUTSIDER };
const viewerIdentity = { spaceId: SPACE, userId: VIEWER };

describe("Project Kernel (real Postgres)", () => {
  it("creates a Project with Research as the default Primary Mode and an initial Mode Transition", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Fresh Project" });
    // Creation presets nothing about the Project's shape (ADR 0019); it
    // only opens the first Brief version.
    expect(project).not.toHaveProperty("primary_mode");
    expect(project.active_brief_version_id).toBeTruthy();
  });

  it("loads a newly created Project summary when it has no Project Folders", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Fresh Project" });

    await expect(repo.summary(ownerIdentity, project.id as string)).resolves.toMatchObject({
      project_id: project.id,
      project_folder_count: 0,
    });
  });

  it("creates a Project with its mainline Room, empty and with no manager Agent", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Fresh Project" });

    // The mainline is a Project attribute on the same footing as the Brief v1
    // row (ADR 0018 decision 4), so "a Project with no Room" is not a state
    // any caller has to handle. Continuing an imported CLI session was the one
    // that could not, and failed on a freshly bound Project.
    const rooms = await db.pool.query<{ id: string; is_mainline: boolean; title: string; status: string }>(
      `SELECT id, is_mainline, title, status FROM rooms WHERE space_id = $1 AND project_id = $2`,
      [SPACE, project.id],
    );
    expect(rooms.rows).toHaveLength(1);
    expect(rooms.rows[0]).toMatchObject({ is_mainline: true, title: "Fresh Project", status: "active" });

    // Its creator is on the roster; nobody else exists yet, and later Project
    // members enrol when they first open it.
    const members = await db.pool.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM room_user_members WHERE space_id = $1 AND room_id = $2 AND status = 'active'`,
      [SPACE, rooms.rows[0]!.id],
    );
    expect(members.rows).toEqual([{ user_id: OWNER, role: "owner" }]);

    // Nothing that can fail runs on this path. An Assistant resolves a prompt
    // asset and needs an eligible backend, and a conversation nobody wrote is
    // exactly what decision 5 removes — so a Project cannot fail to be created
    // because of either, and this fixture has neither configured.
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM room_agent_members WHERE space_id = $1 AND room_id = $2`,
      [SPACE, rooms.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions WHERE space_id = $1 AND room_id = $2`,
      [SPACE, rooms.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  /** Creation binds no Sources. The Project Template that used to do so is
   *  gone, and a Space's Sources are bound from the Project's Sources Area. */
  it("binds no Project Source at creation", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Lit Review" });
    const bindings = await db.pool.query(
      `SELECT id FROM project_source_bindings WHERE space_id = $1 AND project_id = $2`,
      [SPACE, project.id],
    );
    expect(bindings.rows).toHaveLength(0);
  });

  it("moves the active Brief pointer only after review and publish", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const project = await repo.create(ownerIdentity, {
      name: "Brief Project",
      current_focus: "Ship the context cutover",
    });

    const initial = await kernel.getActiveBriefVersion(ownerIdentity, project.id as string);
    expect(initial).toMatchObject({
      version: "v1",
      goal: null,
      project_status: "active",
      current_focus: "Ship the context cutover",
      confirmed_decisions: [],
      workspace_identity: {},
      workspace_boundary: {},
      source_refs: [],
      created_by_user_id: OWNER,
    });
    await expect(kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: 123 }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Valid", embedded_context: "not allowed" }))
      .rejects.toMatchObject({ statusCode: 422 });

    const v2 = await kernel.createBriefVersion(ownerIdentity, project.id as string, {
      goal: "Understand X",
      confirmed_decisions: ["Use one runtime gateway"],
      workspace_identity: { project_folder_id: "folder-1" },
      workspace_boundary: { mode: "read_write_worktree" },
      source_refs: [{ type: "decision", id: "adr-14" }],
    });
    expect(v2.version).toBe("v2");
    expect(v2).toMatchObject({
      project_status: "active",
      current_focus: "Ship the context cutover",
      confirmed_decisions: ["Use one runtime gateway"],
      workspace_identity: { project_folder_id: "folder-1" },
      workspace_boundary: { mode: "read_write_worktree" },
      source_refs: [{ type: "decision", id: "adr-14" }],
    });
    expect(await kernel.getActiveBriefVersion(ownerIdentity, project.id as string)).toMatchObject({ id: initial!.id, version: "v1" });
    const submittedV2 = await kernel.submitBriefForReview(ownerIdentity, project.id as string, v2.id as string);
    expect(submittedV2).toMatchObject({ status: "in_review", reviewed_by_user_id: null, reviewed_at: null });
    const publishedV2 = await kernel.publishBrief(ownerIdentity, project.id as string, v2.id as string);
    expect(publishedV2).toMatchObject({ status: "published", reviewed_by_user_id: OWNER, published_by_user_id: OWNER });
    expect(await kernel.getActiveBriefVersion(ownerIdentity, project.id as string)).toMatchObject({ id: v2.id, version: "v2" });

    const v3 = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Understand X and Y" });
    expect(v3.version).toBe("v3");
    await kernel.submitBriefForReview(ownerIdentity, project.id as string, v3.id as string);
    await kernel.publishBrief(ownerIdentity, project.id as string, v3.id as string);
    expect(await kernel.getActiveBriefVersion(ownerIdentity, project.id as string)).toMatchObject({ id: v3.id, version: "v3" });

    const stale = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Stale candidate" });
    const newest = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Newest candidate" });
    await kernel.submitBriefForReview(ownerIdentity, project.id as string, stale.id as string);
    await kernel.submitBriefForReview(ownerIdentity, project.id as string, newest.id as string);
    await kernel.publishBrief(ownerIdentity, project.id as string, newest.id as string);
    await expect(kernel.publishBrief(ownerIdentity, project.id as string, stale.id as string))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await kernel.getActiveBriefVersion(ownerIdentity, project.id as string)).toMatchObject({ id: newest.id, version: "v5" });

    const history = await kernel.listBriefVersions(ownerIdentity, project.id as string);
    expect(history.map((v) => v.version)).toEqual(["v5", "v4", "v3", "v2", "v1"]);
  });

  it("binds Work Context Setup to published Project context only", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const work = new WorkContextService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Runtime Context Project" });
    const privateAgentId = randomUUID();
    await db.pool.query(`INSERT INTO agents (id,space_id,owner_user_id,name,status,created_at,updated_at,visibility,access_level) VALUES ($1,$2,$3,'Private Agent','active',$4,$4,'private','full')`, [privateAgentId, SPACE, OWNER, new Date().toISOString()]);
    await expect(work.create(viewerIdentity, {
      base_version: null, reason: "test setup",
      work_context_scope_id: randomUUID(), scope_kind: "direct_session", project_id: null,
      project_folder_id: null, agent_id: privateAgentId, runtime_ref: null, pinned_refs: [],
      excluded_refs: [], retrieval_preferences: {}, continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 404 });
    const instruction = await kernel.createInstructionVersion(ownerIdentity, project.id as string, { title: "Delivery rules", instruction_text: "Use the approved release checklist." });
    expect(await kernel.getActiveInstructionVersion(ownerIdentity, project.id as string)).toBeNull();
    await kernel.transitionInstruction(ownerIdentity, project.id as string, instruction.id as string, false);
    await kernel.transitionInstruction(ownerIdentity, project.id as string, instruction.id as string, true);

    const policyId = randomUUID();
    await db.pool.query(`INSERT INTO runtime_context_policy_versions (id,space_id,scope_type,scope_id,version,policy_json,typed_diff_json,reason,created_by_user_id,created_at) VALUES ($1,$2,'space',$2,1,'{"constraints":{},"preferences":{}}','{}','test',$3,$4)`, [policyId, SPACE, OWNER, new Date().toISOString()]);
    await db.pool.query(`INSERT INTO runtime_context_policy_bindings (space_id,scope_type,scope_id,active_version_id,updated_by_user_id,updated_at) VALUES ($1,'space',$1,$2,$3,$4)`, [SPACE, policyId, OWNER, new Date().toISOString()]);
    const unboundDirectSession = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',$4,$4)`,
      [unboundDirectSession, SPACE, OWNER, new Date().toISOString()],
    );
    const bootstrappedDirect = await work.ensureForInvocation(
      ownerIdentity,
      unboundDirectSession,
      { agentId: privateAgentId, runtimeProfileId: null },
    );
    expect(bootstrappedDirect).toMatchObject({
      version: 1,
      scope_kind: "direct_session",
      work_context_scope_id: unboundDirectSession,
      agent_id: privateAgentId,
      runtime_ref: null,
    });
    await expect(work.ensureForInvocation(
      ownerIdentity,
      unboundDirectSession,
      { agentId: privateAgentId, runtimeProfileId: null },
    )).resolves.toMatchObject({ id: bootstrappedDirect.id, version: 1 });
    const initiallyInstructionlessProject = await repo.create(ownerIdentity, { name: "Initially Instructionless" });
    const initiallyInstructionlessSession = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [initiallyInstructionlessSession, SPACE, OWNER, initiallyInstructionlessProject.id, new Date().toISOString()],
    );
    const instructionlessSetup = await work.create(ownerIdentity, {
      base_version: null,
      reason: "test setup",
      work_context_scope_id: initiallyInstructionlessSession,
      scope_kind: "direct_session",
      project_id: initiallyInstructionlessProject.id,
      project_folder_id: null,
      agent_id: null,
      runtime_ref: null,
      pinned_refs: [],
      excluded_refs: [],
      retrieval_preferences: {},
      continuity_preferences: {},
    });
    expect(instructionlessSetup).toMatchObject({
      project_instruction_version_id: null,
      project_instruction_enabled: true,
    });
    const firstInstruction = await kernel.createInstructionVersion(
      ownerIdentity,
      initiallyInstructionlessProject.id as string,
      { title: "First authority", instruction_text: "Apply this authority." },
    );
    await kernel.transitionInstruction(ownerIdentity, initiallyInstructionlessProject.id as string, firstInstruction.id as string, false);
    await kernel.transitionInstruction(ownerIdentity, initiallyInstructionlessProject.id as string, firstInstruction.id as string, true);
    await expect(new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE,
      initiallyInstructionlessProject.id as string,
      initiallyInstructionlessSession,
      OWNER,
      { type: "work_context_setup", id: instructionlessSetup.id as string, version: String(instructionlessSetup.version) },
      { brief: null, instruction: null },
    )).rejects.toMatchObject({ statusCode: 409 });
    const boundFolderId = randomUUID();
    const otherFolderId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_folders
         (id,space_id,project_id,created_by_user_id,name,status,kind,is_primary,
          protected,system_managed,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'Bound Folder','active','code',false,false,false,$6,$6),
              ($5,$2,$3,$4,'Other Folder','active','code',false,false,false,$6,$6)`,
      [boundFolderId, SPACE, project.id, OWNER, otherFolderId, new Date().toISOString()],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id,space_id,project_folder_id,execution_host_id,execution_host_kind,
         execution_ready,status,created_at,updated_at
       ) VALUES (gen_random_uuid()::varchar,$1,$2,$4,'server',true,'active',now(),now()),
                (gen_random_uuid()::varchar,$1,$3,$4,'server',true,'active',now(),now())`,
      [SPACE, boundFolderId, otherFolderId, HOST],
    );
    const otherPrivateAgentId = randomUUID();
    await db.pool.query(`INSERT INTO agents (id,space_id,owner_user_id,name,status,created_at,updated_at,visibility,access_level) VALUES ($1,$2,$3,'Other Private Agent','active',$4,$4,'private','full')`, [otherPrivateAgentId, SPACE, OWNER, new Date().toISOString()]);
    const sessionId = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions
         (id,space_id,user_id,project_id,project_folder_id,agent_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7)`,
      [sessionId, SPACE, OWNER, project.id, boundFolderId, privateAgentId, new Date().toISOString()],
    );
    await expect(work.create(viewerIdentity, {
      base_version: null, reason: "test setup",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: null,
      project_folder_id: null, agent_id: null, runtime_ref: null, pinned_refs: [], excluded_refs: [],
      retrieval_preferences: {}, continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(work.create(ownerIdentity, {
      base_version: null, reason: "test setup",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id,
      project_folder_id: otherFolderId, agent_id: privateAgentId, runtime_ref: null,
      pinned_refs: [], excluded_refs: [], retrieval_preferences: {}, continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(work.create(ownerIdentity, {
      base_version: null, reason: "test setup",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id,
      project_folder_id: boundFolderId, agent_id: otherPrivateAgentId, runtime_ref: null,
      pinned_refs: [], excluded_refs: [], retrieval_preferences: {}, continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 422 });
    const initialBrief = await kernel.getActiveBriefVersion(ownerIdentity, project.id as string);
    const setup = await work.create(ownerIdentity, {
      base_version: null, reason: "test setup",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id,
      project_folder_id: null, agent_id: privateAgentId, runtime_ref: null,
      pinned_refs: [{ type: "project_brief_version", id: initialBrief!.id as string }], excluded_refs: [],
      retrieval_preferences: {}, continuity_preferences: {},
    });
    expect(setup).toMatchObject({
      version: 1,
      base_version: null,
      reason: "test setup",
      project_id: project.id,
      project_folder_id: boundFolderId,
      agent_id: privateAgentId,
      project_instruction_version_id: instruction.id,
    });
    expect(setup.project_brief_version_id).toBeTruthy();
    expect(setup.typed_diff).toMatchObject({ project_id: { before: null, after: project.id } });
    await expect(work.create(ownerIdentity, {
      base_version: null,
      reason: "stale editor",
      work_context_scope_id: sessionId,
      scope_kind: "direct_session",
      project_id: project.id,
      project_folder_id: null,
      agent_id: privateAgentId,
      runtime_ref: null,
      pinned_refs: [],
      excluded_refs: [],
      retrieval_preferences: {},
      continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 409 });
    const foreignInstructionProject = await repo.create(ownerIdentity, { name: "Foreign Instruction Project" });
    const foreignInstruction = await kernel.createInstructionVersion(ownerIdentity, foreignInstructionProject.id as string, {
      title: "Foreign authority",
      instruction_text: "This must not govern another Project.",
    });
    await kernel.transitionInstruction(ownerIdentity, foreignInstructionProject.id as string, foreignInstruction.id as string, false);
    await kernel.transitionInstruction(ownerIdentity, foreignInstructionProject.id as string, foreignInstruction.id as string, true);
    await expect(work.create(ownerIdentity, {
      base_version: 1, reason: "test setup",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id,
      project_folder_id: boundFolderId, agent_id: privateAgentId, runtime_ref: null,
      pinned_refs: [{ type: "project_instruction_version", id: foreignInstruction.id as string }],
      excluded_refs: [], retrieval_preferences: {}, continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 422 });
    const replacementBrief = await kernel.createBriefVersion(ownerIdentity, project.id as string, {
      goal: "Replacement goal",
      confirmed_decisions: ["Use the canonical Context Engine"],
      workspace_identity: { repository: "rainver" },
      workspace_boundary: { writable_roots: ["/workspace"] },
      source_refs: [{ type: "decision", id: "decision-1" }],
    });
    await kernel.submitBriefForReview(ownerIdentity, project.id as string, replacementBrief.id as string);
    await kernel.publishBrief(ownerIdentity, project.id as string, replacementBrief.id as string);
    const pinnedContext = await new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE,
      null,
      sessionId,
      OWNER,
      { type: "work_context_setup", id: setup.id as string, version: String(setup.version) },
      { brief: null, instruction: null },
    );
    expect(pinnedContext.brief).toMatchObject({ id: setup.project_brief_version_id });
    expect(pinnedContext.brief).not.toMatchObject({ id: replacementBrief.id });
    expect(pinnedContext.pinnedReferences).toEqual([
      expect.objectContaining({
        type: "project_brief_version",
        value: expect.objectContaining({
          id: initialBrief!.id,
          confirmed_decisions: [],
          workspace_identity: {},
          workspace_boundary: {},
          source_refs: [],
          published_by_user_id: OWNER,
        }),
      }),
    ]);
    expect(pinnedContext.pinnedReferences[0]?.value).not.toHaveProperty("confirmed_decisions_json");
    const replacementInstruction = await kernel.createInstructionVersion(ownerIdentity, project.id as string, { title: "Replacement rules", instruction_text: "Use the new checklist." });
    await kernel.transitionInstruction(ownerIdentity, project.id as string, replacementInstruction.id as string, false);
    await kernel.transitionInstruction(ownerIdentity, project.id as string, replacementInstruction.id as string, true);
    await expect(new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE, project.id as string, sessionId, OWNER,
      { type: "work_context_setup", id: setup.id as string, version: String(setup.version) },
      { brief: null, instruction: null },
    ))
      .rejects.toMatchObject({ statusCode: 409 });
    const refreshedSetup = await work.create(ownerIdentity, {
      base_version: 1, reason: "refresh published instruction",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id,
      project_folder_id: null, agent_id: privateAgentId, runtime_ref: null, pinned_refs: [], excluded_refs: [],
      retrieval_preferences: {}, continuity_preferences: {},
    });
    expect(refreshedSetup).toMatchObject({ version: 2, project_instruction_version_id: replacementInstruction.id });
    const refreshedAuthority = await new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE, project.id as string, sessionId, OWNER,
      { type: "work_context_setup", id: refreshedSetup.id as string, version: String(refreshedSetup.version) },
      { brief: null, instruction: null },
    );
    expect(refreshedAuthority.instruction).toMatchObject({ id: replacementInstruction.id });
    expect(refreshedAuthority.brief).toMatchObject({
      id: replacementBrief.id,
      space_id: SPACE,
      project_id: project.id,
      goal: "Replacement goal",
      project_status: "active",
      confirmed_decisions: ["Use the canonical Context Engine"],
      workspace_identity: { repository: "rainver" },
      workspace_boundary: { writable_roots: ["/workspace"] },
      source_refs: [{ type: "decision", id: "decision-1" }],
      status: "published",
      published_by_user_id: OWNER,
      created_by_user_id: OWNER,
    });
    const exclusionSetup = await work.create(ownerIdentity, {
      base_version: 2, reason: "exclude superseded brief",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id,
      project_folder_id: null, agent_id: privateAgentId, runtime_ref: null, pinned_refs: [],
      excluded_refs: [{ type: "project_brief_version", id: replacementBrief.id as string }],
      retrieval_preferences: {}, continuity_preferences: {},
    });
    await expect(work.create(ownerIdentity, {
      base_version: 3, reason: "invalid instruction exclusion",
      work_context_scope_id: sessionId, scope_kind: "direct_session", project_id: project.id as string,
      project_folder_id: null, agent_id: privateAgentId, runtime_ref: null, pinned_refs: [],
      excluded_refs: [{ type: "project_instruction_version", id: replacementInstruction.id as string }],
      retrieval_preferences: {}, continuity_preferences: {},
    })).rejects.toMatchObject({ statusCode: 422 });
    const excludedBrief = await new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE, project.id as string, sessionId, OWNER,
      { type: "work_context_setup", id: exclusionSetup.id as string, version: String(exclusionSetup.version) },
      { brief: null, instruction: null },
    );
    expect(excludedBrief.brief).toBeNull();

    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',$5,$5)`, [randomUUID(), SPACE, project.id, VIEWER, new Date().toISOString()]);
    const roomId = randomUUID();
    const roomSessionId = randomUUID();
    const roomAgentId = randomUUID();
    const roomAgentMemberId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO agents (id,space_id,owner_user_id,name,status,created_at,updated_at,visibility,access_level) VALUES ($1,$2,$3,'Room Agent','active',$4,$4,'space_shared','full')`, [roomAgentId, SPACE, OWNER, now]);
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Context room','active',$5,$5)`, [roomId, SPACE, project.id, OWNER, now]);
    await seedRoomManager(db.pool, { id: roomAgentMemberId, space: SPACE, room: roomId, agent: roomAgentId, now });
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner','active',$7,$7),($5,$2,$3,$6,'member','active',$7,$7)`, [randomUUID(), SPACE, roomId, OWNER, randomUUID(), VIEWER, now]);
    await db.pool.query(`INSERT INTO sessions (id,space_id,project_id,room_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)`, [roomSessionId, SPACE, project.id, roomId, now]);
    const roomInput = {
      base_version: null, reason: "test room setup",
      work_context_scope_id: roomAgentMemberId, scope_kind: "room_recipient" as const, project_id: project.id as string,
      project_folder_id: null, agent_id: roomAgentId, runtime_ref: null, pinned_refs: [], excluded_refs: [],
      retrieval_preferences: {}, continuity_preferences: {},
    };
    await expect(work.ensureForInvocation(
      ownerIdentity,
      roomAgentMemberId,
      { agentId: roomAgentId, runtimeProfileId: null },
    )).resolves.toMatchObject({
      version: 1,
      user_id: OWNER,
      scope_kind: "room_recipient",
      project_id: project.id,
      agent_id: roomAgentId,
    });
    const viewerRoomSetup = await work.create(viewerIdentity, roomInput);
    expect(viewerRoomSetup).toMatchObject({ version: 1, user_id: VIEWER });
    await expect(work.getActive(viewerIdentity, roomAgentMemberId)).resolves.toMatchObject({ user_id: VIEWER, agent_id: roomAgentId });
    const otherProject = await repo.create(ownerIdentity, { name: "Other Runtime Context Project" });
    await expect(work.create(ownerIdentity, { ...roomInput, project_id: otherProject.id as string }))
      .rejects.toMatchObject({ statusCode: 422 });
    await db.pool.query(`UPDATE project_members SET status='revoked', updated_at=$4 WHERE project_id=$1 AND space_id=$2 AND user_id=$3`, [project.id, SPACE, VIEWER, new Date().toISOString()]);
    await expect(work.getActive(viewerIdentity, roomAgentMemberId)).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query(`UPDATE project_members SET status='active', updated_at=$4 WHERE project_id=$1 AND space_id=$2 AND user_id=$3`, [project.id, SPACE, VIEWER, new Date().toISOString()]);
    await db.pool.query(`UPDATE room_user_members SET status='removed', updated_at=$4 WHERE room_id=$1 AND space_id=$2 AND user_id=$3`, [roomId, SPACE, VIEWER, new Date().toISOString()]);
    await expect(work.getActive(viewerIdentity, roomAgentMemberId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE, project.id as string, roomAgentMemberId, VIEWER,
      { type: "work_context_setup", id: viewerRoomSetup.id as string, version: String(viewerRoomSetup.version) },
      { brief: null, instruction: null },
    )).rejects.toMatchObject({ statusCode: 404 });

    const restrictivePolicyId = randomUUID();
    await db.pool.query(
      `INSERT INTO runtime_context_policy_versions
         (id,space_id,scope_type,scope_id,version,policy_json,typed_diff_json,reason,created_by_user_id,created_at)
       VALUES ($1,$2,'space',$2,2,$3::jsonb,'{}','restrict setup',$4,$5)`,
      [restrictivePolicyId, SPACE, JSON.stringify({
        constraints: {
          explicit_reference_max: 0,
          retrieval_max_candidates: 0,
          continuity_modes: ["none"],
          allow_project_brief: false,
          allow_project_instructions: false,
        },
        preferences: { retrieval_enabled: false },
      }), OWNER, new Date().toISOString()],
    );
    await db.pool.query(
      `UPDATE runtime_context_policy_bindings
          SET active_version_id=$1, updated_by_user_id=$2, updated_at=$3
        WHERE space_id=$4 AND scope_type='space' AND scope_id=$4`,
      [restrictivePolicyId, OWNER, new Date().toISOString(), SPACE],
    );
    const restrictedBase = {
      base_version: 3, reason: "apply restrictive policy",
      work_context_scope_id: sessionId, scope_kind: "direct_session" as const,
      project_id: project.id as string, project_folder_id: null, agent_id: privateAgentId,
      runtime_ref: null, pinned_refs: [], excluded_refs: [], retrieval_preferences: {},
      continuity_preferences: {},
    };
    const policyOmitted = await work.create(ownerIdentity, restrictedBase);
    expect(policyOmitted).toMatchObject({
      project_brief_version_id: null,
      project_instruction_version_id: null,
      project_instruction_enabled: false,
    });
    const policyOmittedContext = await new PgRuntimeContextAcquisitionRepository(db.pool).loadPublishedProjectContext(
      SPACE, project.id as string, sessionId, OWNER,
      { type: "work_context_setup", id: policyOmitted.id as string, version: String(policyOmitted.version) },
      { brief: null, instruction: null },
    );
    expect(policyOmittedContext).toMatchObject({ brief: null, instruction: null });
    await expect(work.create(ownerIdentity, {
      ...restrictedBase,
      base_version: 4,
      pinned_refs: [{ type: "project_brief_version", id: initialBrief!.id as string }],
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(work.create(ownerIdentity, {
      ...restrictedBase,
      base_version: 4,
      retrieval_preferences: { enabled: true },
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(work.create(ownerIdentity, {
      ...restrictedBase,
      base_version: 4,
      continuity_preferences: { strategy: "stateful_cli", continue_vendor_session: true },
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("does not publish Project instructions after co-owner authority is revoked concurrently", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Authority Race Project" });
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'owner','active',now(),now())`,
      [randomUUID(), SPACE, project.id, VIEWER],
    );
    const instruction = await kernel.createInstructionVersion(viewerIdentity, project.id as string, {
      title: "Delegated authority",
      instruction_text: "Only publish while authorized.",
    });
    await kernel.transitionInstruction(viewerIdentity, project.id as string, instruction.id as string, false);

    const revocation = await db.pool.connect();
    try {
      await revocation.query("BEGIN");
      await revocation.query(
        `SELECT 1 FROM project_members
          WHERE space_id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE`,
        [SPACE, project.id, VIEWER],
      );
      let settled = false;
      const publishing = kernel.transitionInstruction(
        viewerIdentity,
        project.id as string,
        instruction.id as string,
        true,
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await revocation.query(
        `DELETE FROM project_members WHERE space_id=$1 AND project_id=$2 AND user_id=$3`,
        [SPACE, project.id, VIEWER],
      );
      // Attach the expectation before the commit releases the lock: the
      // rejection can land in the same event-loop turn as the commit's reply,
      // and a rejection with no handler yet fails the whole run.
      const publishingRejected = expect(publishing).rejects.toMatchObject({ statusCode: 403 });
      await revocation.query("COMMIT");
      await publishingRejected;
      await expect(kernel.getActiveInstructionVersion(ownerIdentity, project.id as string)).resolves.toBeNull();
    } finally {
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
    }
  });

  it("does not create or submit Project Brief drafts after writer authority is revoked concurrently", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Brief Writer Race Project" });
    const memberId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [memberId, SPACE, project.id, VIEWER],
    );

    const revocation = await db.pool.connect();
    try {
      await revocation.query("BEGIN");
      await revocation.query(
        `SELECT 1 FROM project_members
          WHERE space_id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE`,
        [SPACE, project.id, VIEWER],
      );
      let createSettled = false;
      const creating = kernel.createBriefVersion(
        viewerIdentity,
        project.id as string,
        { goal: "Must not be created" },
      ).finally(() => { createSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(createSettled).toBe(false);
      await revocation.query(
        `DELETE FROM project_members WHERE space_id=$1 AND project_id=$2 AND user_id=$3`,
        [SPACE, project.id, VIEWER],
      );
      // Attach the expectation before the commit releases the lock: the
      // rejection can land in the same event-loop turn as the commit's reply,
      // and a rejection with no handler yet fails the whole run.
      const creatingRejected = expect(creating).rejects.toMatchObject({ statusCode: 403 });
      await revocation.query("COMMIT");
      await creatingRejected;

      await db.pool.query(
        `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
        [randomUUID(), SPACE, project.id, VIEWER],
      );
      const draft = await kernel.createBriefVersion(
        viewerIdentity,
        project.id as string,
        { goal: "Draft before revocation" },
      );

      await revocation.query("BEGIN");
      await revocation.query(
        `SELECT 1 FROM project_members
          WHERE space_id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE`,
        [SPACE, project.id, VIEWER],
      );
      let submitSettled = false;
      const submitting = kernel.submitBriefForReview(
        viewerIdentity,
        project.id as string,
        draft.id as string,
      ).finally(() => { submitSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(submitSettled).toBe(false);
      await revocation.query(
        `DELETE FROM project_members WHERE space_id=$1 AND project_id=$2 AND user_id=$3`,
        [SPACE, project.id, VIEWER],
      );
      // Attach the expectation before the commit releases the lock: the
      // rejection can land in the same event-loop turn as the commit's reply,
      // and a rejection with no handler yet fails the whole run.
      const submittingRejected = expect(submitting).rejects.toMatchObject({ statusCode: 403 });
      await revocation.query("COMMIT");
      await submittingRejected;
      await expect(kernel.listBriefVersions(ownerIdentity, project.id as string))
        .resolves.toContainEqual(expect.objectContaining({ id: draft.id, status: "draft" }));
    } finally {
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
    }
  });

  it("restricts Project Instruction drafts to owner-level authority and validates the DTO", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Instruction Authority Project" });
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',$5,$5)`, [randomUUID(), SPACE, project.id, VIEWER, new Date().toISOString()]);
    await expect(kernel.createInstructionVersion(viewerIdentity, project.id as string, { title: "Unsafe", instruction_text: "Do it" })).rejects.toMatchObject({ statusCode: 403 });
    const ownerDraft = await kernel.createInstructionVersion(ownerIdentity, project.id as string, { title: "Owner draft", instruction_text: "Use the checklist" });
    await expect(kernel.transitionInstruction(viewerIdentity, project.id as string, ownerDraft.id as string, false)).rejects.toMatchObject({ statusCode: 403 });
    await db.pool.query(`UPDATE project_members SET role='owner', updated_at=$4 WHERE space_id=$1 AND project_id=$2 AND user_id=$3`, [SPACE, project.id, VIEWER, new Date().toISOString()]);
    await expect(repo.get(viewerIdentity, project.id as string)).resolves.toMatchObject({
      current_user_can_approve_context: true,
    });
    await expect(kernel.createInstructionVersion(viewerIdentity, project.id as string, { title: "Co-owner draft", instruction_text: "Use the co-owner checklist" })).resolves.toMatchObject({ status: "draft" });
    const coOwnedBrief = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Co-owned goal" });
    await kernel.submitBriefForReview(ownerIdentity, project.id as string, coOwnedBrief.id as string);
    await expect(kernel.publishBrief(viewerIdentity, project.id as string, coOwnedBrief.id as string)).resolves.toMatchObject({ status: "published" });
    await expect(kernel.createInstructionVersion(ownerIdentity, project.id as string, { title: "x".repeat(257), instruction_text: "Do it" })).rejects.toMatchObject({ statusCode: 422 });
    const newerDraft = await kernel.createInstructionVersion(ownerIdentity, project.id as string, { title: "Newer", instruction_text: "Use the newer checklist" });
    await kernel.transitionInstruction(ownerIdentity, project.id as string, ownerDraft.id as string, false);
    await kernel.transitionInstruction(ownerIdentity, project.id as string, newerDraft.id as string, false);
    await kernel.transitionInstruction(ownerIdentity, project.id as string, newerDraft.id as string, true);
    await expect(kernel.transitionInstruction(ownerIdentity, project.id as string, ownerDraft.id as string, true))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("database constraints keep the active Brief pointer inside its Project", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const first = await repo.create(ownerIdentity, { name: "First Brief Project" });
    const second = await repo.create(ownerIdentity, { name: "Second Brief Project" });
    await expect(
      db.pool.query(
        `UPDATE projects SET active_brief_version_id=$1 WHERE id=$2 AND space_id=$3`,
        [second.active_brief_version_id, first.id, SPACE],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("aggregates Attention items from registered adapters and respects snooze", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const attention = new ProjectAttentionService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Attention Project" });
    const now = new Date().toISOString();
    const opId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, progress_json, created_at, updated_at)
       VALUES ($1, $2, $3, 'custom', 'Needs review', 'waiting_review', '{}'::jsonb, $4, $4)`,
      [opId, SPACE, project.id, now],
    );

    const items = await attention.listAttentionItems(ownerIdentity, project.id as string);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_type: "project_operation",
      source_id: opId,
      severity: "normal",
      href: `/projects/${project.id}/research?tab=runs&open=${opId}`,
    });

    const future = new Date(Date.now() + 3_600_000).toISOString();
    await attention.setUserState(ownerIdentity, project.id as string, "project_operation", opId, { snoozed_until: future });
    expect(await attention.listAttentionItems(ownerIdentity, project.id as string)).toHaveLength(0);

    const past = new Date(Date.now() - 3_600_000).toISOString();
    await attention.setUserState(ownerIdentity, project.id as string, "project_operation", opId, { snoozed_until: past });
    expect(await attention.listAttentionItems(ownerIdentity, project.id as string)).toHaveLength(1);
  });

  it("surfaces a project-scoped operational alert at its exact Operations destination", async () => {
    if (!db.available) return;
    registerAutomationsProjectIntegration();
    const project = await new PgProjectRepository(db.pool).create(ownerIdentity, { name: "Operations Project" });
    await new OperationalAlertService(db.pool).emit({
      kind: "automation_fire_failed",
      title: "Automation failed",
      message: "The scheduled health check could not start.",
      dedupeKey: "automation_fire_failed:automation-1",
      spaceId: SPACE,
      userId: OWNER,
      projectId: project.id as string,
      payload: { automation_id: randomUUID() },
    });

    const items = await new ProjectAttentionService(db.pool).listAttentionItems(ownerIdentity, project.id as string);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_type: "operational_alert",
      title: "Automation failed",
    });
    // Alerts are activity records; they are read in the Space Inbox filtered
    // to the Project, since the Project's Operations Area is retired.
    expect(items[0]?.href).toBe(`/activity?project_id=${project.id}`);
  });

  it("composes the Overview from the Brief, its definition status, and Attention", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const overview = new ProjectOverviewService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Overview Project" });
    const brief = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Ship the Project Kernel" });
    await kernel.submitBriefForReview(ownerIdentity, project.id as string, brief.id as string);
    await kernel.publishBrief(ownerIdentity, project.id as string, brief.id as string);

    const result = await overview.getOverview(ownerIdentity, project.id as string);
    expect(result.project).toMatchObject({ id: project.id });
    expect(result.brief).toMatchObject({ goal: "Ship the Project Kernel", version: "v2" });
    expect(result.definition_status).toEqual({
      status: "initialized",
      basis: "published_brief_goal",
      goal_or_problem: "Ship the Project Kernel",
    });
    // No Project type field, no mode list (ADR 0019).
    expect(result).not.toHaveProperty("available_modes");
    // A fresh Project has no Folder; the front page says so until one is connected.
    expect(result.has_project_folder).toBe(false);
    expect(result).not.toHaveProperty("mode_projection");
    expect(result).not.toHaveProperty("entity_summaries");
    expect(result.attention).toEqual([]);
    // No readiness checklist: a Project needs nothing configured before it can
    // be talked to or have work put on it. The one Project-level readiness
    // fact is whether its goal is defined, and that is `definition_status`.
    expect(result).not.toHaveProperty("setup_checklist");
  });

  it("refuses an adapter that cannot say why its item needs a person", async () => {
    if (!db.available) return;
    // A plugin adapter is not compiled with this repo, and the front page
    // renders only the four classes — an unclassed item would vanish into a
    // panel that says nothing rather than failing where the wiring is wrong.
    const repo = new PgProjectRepository(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Unclassed adapter" });
    projectAttentionRegistry.replace({
      areaKind: "rogue",
      async listAttentionItems() {
        return [{
          id: "rogue:1", project_id: project.id as string, area_kind: "rogue",
          source_type: "rogue", source_id: "1", severity: "normal",
          title: "No class", summary: null, reason: null, due_at: null,
          blocking_refs: [], action_descriptors: [], href: "/",
        } as never];
      },
    });

    await expect(new ProjectAttentionService(db.pool).listAttentionItems(ownerIdentity, project.id as string))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  it("emits nothing that cannot say why it needs a person", async () => {
    if (!db.available) return;
    // ADR 0017 §4 / ADR 0011 decision 6: attention is only worth reading while
    // everything on it needs a decision, so each item names which of the four
    // reasons it is. An adapter that cannot is a wiring bug, not a runtime
    // condition — six identical "confirm what I already did" cards is what
    // this keeps out of the list.
    const repo = new PgProjectRepository(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Classed attention" });
    await db.pool!.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'research', 'Waiting operation', 'waiting_review', $4, '{}'::jsonb, 1, now(), now())`,
      [randomUUID(), SPACE, project.id, OWNER],
    );

    // A second adapter with a row of its own, so the assertion is over a
    // merged list rather than one adapter's single item.
    await db.pool!.query(
      `INSERT INTO proposals (id, space_id, project_id, proposal_type, status, risk_level, urgency,
         preview, title, payload_json, created_by_user_id, owner_user_id, visibility, access_level, created_at, updated_at)
       VALUES ($1, $2, $3, 'project_brief_publish', 'pending', 'low', 'normal', false, 'A pending definition',
         '{}'::jsonb, $4, $4, 'space_shared', 'full', now(), now())`,
      [randomUUID(), SPACE, project.id, OWNER],
    );
    // Every adapter the product registers, not only the built-in one: the
    // invariant is about the list a person reads, which is all of them merged.
    registerInquiryProjectIntegration();
    registerDecisionsProjectIntegration();
    registerTasksProjectIntegration();
    registerProposalsProjectIntegration();
    registerAutomationsProjectIntegration();

    const items = await new ProjectAttentionService(db.pool).listAttentionItems(ownerIdentity, project.id as string);
    expect(new Set(items.map((item) => item.area_kind)).size).toBeGreaterThan(1);
    for (const item of items) {
      expect(["gate", "remainder", "next_step", "uncertain"]).toContain(item.attention_class);
    }
  });

  it("says what is running, not only what is waiting on a person", async () => {
    if (!db.available) return;
    // The failure this closes: the front page read the Task board and nothing
    // else, so a research acquisition screening 873 documents for four hours
    // rendered as "nothing is being worked on right now". Attention answers
    // "what needs me"; this answers "what is happening".
    const repo = new PgProjectRepository(db.pool);
    const overview = new ProjectOverviewService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Running Project" });
    const insert = async (id: string, title: string, status: string, progress: Record<string, unknown>) => {
      await db.pool!.query(
        `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'research', $4, $5, $6, $7::jsonb, 1, now(), now())`,
        [id, SPACE, project.id, title, status, OWNER, JSON.stringify(progress)],
      );
    };
    const screening = {
      current_stage: "screening",
      screening_progress: { phase: "screening_batches", total_items: 873, classified_items: 848 },
    };
    await insert(randomUUID(), "Start initial material intake", "active", screening);
    await insert(randomUUID(), "Earlier sweep", "completed", {});
    await insert(randomUUID(), "Abandoned sweep", "cancelled", {});

    const result = await overview.getOverview(ownerIdentity, project.id as string);
    const running = result.in_progress as Array<Record<string, unknown>>;
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ title: "Start initial material intake", status: "active", kind: "research" });
    // The progress the Area's renderer reads travels with it, so the front
    // page shows that same sentence instead of composing a second one.
    expect((running[0]!.progress_json as Record<string, unknown>).screening_progress)
      .toMatchObject({ total_items: 873, classified_items: 848 });
  });

  it("says a Project without a published goal still needs definition", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const overview = new ProjectOverviewService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Delivery Project" });

    const result = await overview.getOverview(ownerIdentity, project.id as string);
    expect(result.definition_status).toEqual({
      status: "needs_definition",
      basis: "missing_published_brief_goal",
      goal_or_problem: null,
    });
  });

  it("keeps every Project Kernel route Space- and membership-gated", async () => {
    if (!db.available) return;
    const repo = new PgProjectRepository(db.pool);
    const kernel = new ProjectKernelService(db.pool);
    const project = await repo.create(ownerIdentity, { name: "Gated Project" });

    // Space member but not a project member/owner: read is not readable (404,
    // avoids leaking existence); write is an authorization failure against a
    // project known to exist in this space (403), matching `assertProjectWriter`
    // elsewhere in this module.
    await expect(kernel.listBriefVersions(viewerIdentity, project.id as string)).rejects.toMatchObject({ statusCode: 404 });
    await expect(kernel.createBriefVersion(viewerIdentity, project.id as string, { goal: "x" })).rejects.toMatchObject({ statusCode: 403 });

    // Not even a space member: not readable.
    await expect(kernel.listBriefVersions(outsiderIdentity, project.id as string)).rejects.toMatchObject({ statusCode: 404 });

    // Add as an active viewer-role project member: readable, still not a writer.
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', now(), now())`,
      [randomUUID(), SPACE, project.id, VIEWER],
    );
    expect(await kernel.listBriefVersions(viewerIdentity, project.id as string)).toHaveLength(1);
    await expect(kernel.createBriefVersion(viewerIdentity, project.id as string, { goal: "x" })).rejects.toMatchObject({ statusCode: 403 });
  });
});
