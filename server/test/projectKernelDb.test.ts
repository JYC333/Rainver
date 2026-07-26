import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { ProjectKernelService } from "../src/modules/projects/kernelService";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService";
import { ProjectOverviewService } from "../src/modules/projects/overviewService";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry";
import { projectModeProjectionRegistry } from "../src/modules/projects/overviewRegistry";
import { registerAutomationsProjectIntegration } from "../src/modules/automations/projectIntegration";
import { OperationalAlertService } from "../src/modules/notifications/operationalAlerts";

// Real-Postgres coverage for the Project Kernel: Profile application at
// creation, Brief versioning, Primary Mode transitions, Attention
// aggregation, and Overview composition. See ADR 0011 and PROJECTS.md.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
    console.warn(`[project-kernel-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE project_operations, projects, space_memberships, users, spaces CASCADE");
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`,
    [SPACE, now],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES
       ($1, 'Owner', 'active', $4, $4), ($2, 'Outsider', 'active', $4, $4), ($3, 'Viewer', 'active', $4, $4)`,
    [OWNER, OUTSIDER, VIEWER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES
       ($1, $2, $3, 'owner', 'active', $5, $5), ($4, $2, $6, 'member', 'active', $5, $5)`,
    [randomUUID(), SPACE, OWNER, randomUUID(), now, VIEWER],
  );
  registerBuiltInAttentionAdapters();
  projectModeProjectionRegistry.register({
    mode: "inquiry",
    async getOverviewProjection() {
      return { mode: "inquiry", current_state_summary: "Inquiry ready.", progress_indicators: [], focus_set: [], next_actions: [] };
    },
    async getAreaSummary() {
      return { count: 0, status: "ok" };
    },
  });
});

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
  projectModeProjectionRegistry.__resetForTests();
});

const ownerIdentity = { spaceId: SPACE, userId: OWNER };
const outsiderIdentity = { spaceId: SPACE, userId: OUTSIDER };
const viewerIdentity = { spaceId: SPACE, userId: VIEWER };

describe("Project Kernel (real Postgres)", () => {
  it("creates a Blank Template project with Inquiry as the default Primary Mode and records the initial Mode Transition", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const project = await repo.create(ownerIdentity, { name: "Blank Project" });
    expect(project.template_key).toBe("blank");
    expect(project.primary_mode).toBe("inquiry");
    expect(project.active_brief_version_id).toBeTruthy();

    const transitions = await new ProjectKernelService(pool).listModeTransitions(ownerIdentity, project.id as string);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from_mode: null, to_mode: "inquiry", reason: "template_applied" });
  });

  it("loads a newly created Project summary when it has no Project Folders", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const project = await repo.create(ownerIdentity, { name: "Fresh Project" });

    await expect(repo.summary(ownerIdentity, project.id as string)).resolves.toMatchObject({
      project_id: project.id,
      project_folder_count: 0,
    });
  });

  it("creates an Academic Research Template project successfully", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const project = await repo.create(ownerIdentity, { name: "Lit Review", template_key: "academic_research" });
    expect(project.template_key).toBe("academic_research");
    expect(project.primary_mode).toBe("inquiry");
  });

  it("rejects an unknown template_key with 422", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    await expect(repo.create(ownerIdentity, { name: "Bad", template_key: "not_a_template" })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("versions the Project Brief and moves the active pointer on each write", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const kernel = new ProjectKernelService(pool);
    const project = await repo.create(ownerIdentity, { name: "Brief Project" });

    const initial = await kernel.getActiveBriefVersion(ownerIdentity, project.id as string);
    expect(initial).toMatchObject({ version: "v1", goal: null });

    const v2 = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Understand X" });
    expect(v2.version).toBe("v2");
    expect(await kernel.getActiveBriefVersion(ownerIdentity, project.id as string)).toMatchObject({ id: v2.id, version: "v2" });

    const v3 = await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Understand X and Y" });
    expect(v3.version).toBe("v3");
    expect(await kernel.getActiveBriefVersion(ownerIdentity, project.id as string)).toMatchObject({ id: v3.id, version: "v3" });

    const history = await kernel.listBriefVersions(ownerIdentity, project.id as string);
    expect(history.map((v) => v.version)).toEqual(["v3", "v2", "v1"]);
  });

  it("database constraints keep the active Brief pointer inside its Project", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const first = await repo.create(ownerIdentity, { name: "First Brief Project" });
    const second = await repo.create(ownerIdentity, { name: "Second Brief Project" });
    await expect(
      pool.query(
        `UPDATE projects SET active_brief_version_id=$1 WHERE id=$2 AND space_id=$3`,
        [second.active_brief_version_id, first.id, SPACE],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("a Mode transition changes presentation metadata and its append-only log while Workspace-owned data is untouched", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const kernel = new ProjectKernelService(pool);
    projectModeProjectionRegistry.register({
      mode: "decision",
      async getOverviewProjection() {
        return { mode: "decision", current_state_summary: "Decision ready.", progress_indicators: [], focus_set: [], next_actions: [] };
      },
      async getAreaSummary() {
        return { count: 0, status: "ok" };
      },
    });
    const project = await repo.create(ownerIdentity, { name: "Mode Project" });
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, progress_json, created_at, updated_at)
       VALUES ($1, $2, $3, 'custom', 'Untouched op', 'active', '{}'::jsonb, $4, $4)`,
      [randomUUID(), SPACE, project.id, now],
    );

    const transition = await kernel.transitionMode(ownerIdentity, project.id as string, {
      to_mode: "decision",
      reason: "switching focus to a commitment",
    });
    expect(transition).toMatchObject({ from_mode: "inquiry", to_mode: "decision" });

    const updated = await repo.get(ownerIdentity, project.id as string);
    expect(updated?.primary_mode).toBe("decision");

    const opStatus = await pool.query<{ status: string }>(
      `SELECT status FROM project_operations WHERE space_id = $1 AND project_id = $2`,
      [SPACE, project.id],
    );
    expect(opStatus.rows[0]?.status).toBe("active");

    const transitions = await kernel.listModeTransitions(ownerIdentity, project.id as string);
    expect(transitions.map((t) => t.to_mode)).toEqual(["decision", "inquiry"]);
  });

  it("rejects an invalid to_mode", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const kernel = new ProjectKernelService(pool);
    const project = await repo.create(ownerIdentity, { name: "Mode Project" });
    await expect(
      kernel.transitionMode(ownerIdentity, project.id as string, { to_mode: "not_a_mode" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a known Mode until its Overview adapter is registered", async () => {
    if (!available || !pool) return;
    const project = await new PgProjectRepository(pool).create(ownerIdentity, { name: "Unavailable Mode Project" });
    await expect(
      new ProjectKernelService(pool).transitionMode(ownerIdentity, project.id as string, { to_mode: "learning" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("aggregates Attention items from registered adapters and respects snooze", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const attention = new ProjectAttentionService(pool);
    const project = await repo.create(ownerIdentity, { name: "Attention Project" });
    const now = new Date().toISOString();
    const opId = randomUUID();
    await pool.query(
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
      href: `/projects/${project.id}/operations?open=${opId}`,
    });

    const future = new Date(Date.now() + 3_600_000).toISOString();
    await attention.setUserState(ownerIdentity, project.id as string, "project_operation", opId, { snoozed_until: future });
    expect(await attention.listAttentionItems(ownerIdentity, project.id as string)).toHaveLength(0);

    const past = new Date(Date.now() - 3_600_000).toISOString();
    await attention.setUserState(ownerIdentity, project.id as string, "project_operation", opId, { snoozed_until: past });
    expect(await attention.listAttentionItems(ownerIdentity, project.id as string)).toHaveLength(1);
  });

  it("surfaces a project-scoped operational alert at its exact Operations destination", async () => {
    if (!available || !pool) return;
    registerAutomationsProjectIntegration();
    const project = await new PgProjectRepository(pool).create(ownerIdentity, { name: "Operations Project" });
    await new OperationalAlertService(pool).emit({
      kind: "automation_fire_failed",
      title: "Automation failed",
      message: "The scheduled health check could not start.",
      dedupeKey: "automation_fire_failed:automation-1",
      spaceId: SPACE,
      userId: OWNER,
      projectId: project.id as string,
      payload: { automation_id: randomUUID() },
    });

    const items = await new ProjectAttentionService(pool).listAttentionItems(ownerIdentity, project.id as string);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_type: "operational_alert",
      title: "Automation failed",
    });
    expect(items[0]?.href).toMatch(new RegExp(`^/projects/${project.id}/operations\\?alert=`));
  });

  it("composes the Overview from the Brief, Mode projection, and Attention without a registered Mode adapter", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const kernel = new ProjectKernelService(pool);
    const overview = new ProjectOverviewService(pool);
    const project = await repo.create(ownerIdentity, { name: "Overview Project" });
    await kernel.createBriefVersion(ownerIdentity, project.id as string, { goal: "Ship the Project Kernel" });

    const result = await overview.getOverview(ownerIdentity, project.id as string);
    expect(result.project).toMatchObject({ id: project.id, primary_mode: "inquiry", template_key: "blank" });
    expect(result.brief).toMatchObject({ goal: "Ship the Project Kernel", version: "v2" });
    expect(result.mode_projection).toMatchObject({ mode: "inquiry" });
    expect(result.available_modes).toEqual(["inquiry"]);
    expect(result.attention).toEqual([]);
    expect(result.template).toMatchObject({ key: "blank", name: "Blank" });
    expect(result.setup_checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "brief", status: "ready", required: true }),
      expect.objectContaining({ id: "provider", status: "missing", required: false }),
      expect.objectContaining({ id: "folder", status: "missing", required: false }),
    ]));
  });

  it("keeps every Project Kernel route Space- and membership-gated", async () => {
    if (!available || !pool) return;
    const repo = new PgProjectRepository(pool);
    const kernel = new ProjectKernelService(pool);
    const project = await repo.create(ownerIdentity, { name: "Gated Project" });

    // Space member but not a project member/owner: read is not readable (404,
    // avoids leaking existence); write is an authorization failure against a
    // project known to exist in this space (403), matching `assertProjectWriter`
    // elsewhere in this module.
    await expect(kernel.listModeTransitions(viewerIdentity, project.id as string)).rejects.toMatchObject({ statusCode: 404 });
    await expect(kernel.transitionMode(viewerIdentity, project.id as string, { to_mode: "decision" })).rejects.toMatchObject({ statusCode: 403 });

    // Not even a space member: not readable.
    await expect(kernel.listModeTransitions(outsiderIdentity, project.id as string)).rejects.toMatchObject({ statusCode: 404 });

    // Add as an active viewer-role project member: readable, still not a writer.
    await pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', now(), now())`,
      [randomUUID(), SPACE, project.id, VIEWER],
    );
    expect(await kernel.listModeTransitions(viewerIdentity, project.id as string)).toHaveLength(1);
    await expect(kernel.transitionMode(viewerIdentity, project.id as string, { to_mode: "decision" })).rejects.toMatchObject({ statusCode: 403 });
  });
});
