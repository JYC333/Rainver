import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { applyContentCreationContext, resolveContentCreationContext } from "../src/modules/access/creationContext.js";
import { PgActivityConsolidationRepository } from "../src/modules/activity/consolidationRepository.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";
import { ContentAccessAuditService } from "../src/modules/contentAccess/audit.js";
import { ContentDemotionService } from "../src/modules/contentAccess/demotion.js";
import { ContentAccessService } from "../src/modules/contentAccess/service.js";
import { PgProposalRepository } from "../src/modules/proposals/repository.js";
import { RunMaterializationService } from "../src/modules/runs/materializationService.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("contentAccessDefencesDb", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SOURCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const DERIVED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const RUN = "99999999-9999-4999-8999-999999999999";
  const SNAPSHOT = "88888888-8888-4888-8888-888888888888";
  const DELIVERY = "77777777-7777-4777-8777-777777777777";
  const CONTROL = "66666666-6666-4666-8666-666666666666";


  const db = useTestDatabase(`${import.meta.filename}#contentAccessDefencesDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["content_demotion_disclosures", "content_access_logs", "invocation_snapshots", "invocation_deliveries", "execution_control_snapshots", "artifacts", "runs", "agent_versions", "agents", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    for (const [id, name] of [[OWNER, "Owner"], [VIEWER, "Viewer"]]) {
      await db.pool.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at)
         VALUES ($1, $2, 'active', now(), now())`,
        [id, name],
      );
    }
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Team', 'team', $2, now(), now())`,
      [SPACE, OWNER],
    );
    for (const userId of [OWNER, VIEWER]) {
      await db.pool.query(
        `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
        [randomUUID(), SPACE, userId],
      );
    }
    await db.pool.query(
      `INSERT INTO artifacts
         (id, space_id, artifact_type, title, export_formats_json, visibility,
          access_level, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, 'note', 'Source', '[]'::jsonb, 'space_shared', 'full', $3, now(), now())`,
      [SOURCE, SPACE, OWNER],
    );
  });

  describe("content after-the-fact defences (real PostgreSQL)", () => {
    it("writes no row for an owner read and exactly one row for a cross-person read", async () => {
      if (!db.available) return;
      const audit = new ContentAccessAuditService(db.pool);
      expect(await audit.recordReads({
        spaceId: SPACE,
        resourceType: "artifact",
        resourceIds: [SOURCE],
        viewerUserId: OWNER,
        accessType: "explicit_read",
      })).toBe(0);
      expect(await audit.recordReads({
        spaceId: SPACE,
        resourceType: "artifact",
        resourceIds: [SOURCE, SOURCE],
        viewerUserId: VIEWER,
        accessType: "explicit_read",
      })).toBe(1);

      const rows = await db.pool.query(
        `SELECT resource_type, resource_id, owner_user_id, viewer_user_id
           FROM content_access_logs`,
      );
      expect(rows.rows).toEqual([{
        resource_type: "artifact",
        resource_id: SOURCE,
        owner_user_id: OWNER,
        viewer_user_id: VIEWER,
      }]);
      await expect(audit.listForOwner({
        spaceId: SPACE,
        resourceType: "artifact",
        resourceId: SOURCE,
        ownerUserId: VIEWER,
        limit: 50,
        offset: 0,
      })).rejects.toMatchObject({ statusCode: 404 });
      const ownerView = await audit.listForOwner({
        spaceId: SPACE,
        resourceType: "artifact",
        resourceId: SOURCE,
        ownerUserId: OWNER,
        limit: 50,
        offset: 0,
      });
      expect(ownerView.items).toEqual([
        expect.objectContaining({ viewer_user_id: VIEWER, viewer_display_name: "Viewer" }),
      ]);
    });

    it("discloses consuming Runs and derived outputs that remain shared", async () => {
      if (!db.available) return;
      await db.pool.query(
        `INSERT INTO agents
           (id, space_id, owner_user_id, name, status, visibility, access_level, created_at, updated_at)
         VALUES ($1,$2,$3,'Agent','active','private','full',now(),now())`,
        [AGENT, SPACE, OWNER],
      );
      await db.pool.query(
        `INSERT INTO agent_versions
           (id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
            context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json,
            runtime_policy_json, created_at)
         VALUES ($1,$2,$3,'v1','{}','{}','{}','{}','[]','[]','{}',now())`,
        [VERSION, AGENT, SPACE],
      );
      await db.pool.query(
        `INSERT INTO runs
           (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status,
            mode, created_at, updated_at, owner_user_id, visibility, access_level)
         VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',now(),now(),$5,'private','full')`,
        [RUN, SPACE, AGENT, VERSION, OWNER],
      );
      await db.pool.query(
        `INSERT INTO execution_control_snapshots (id,space_id,run_id,snapshot_json,created_at)
         VALUES ($1,$2,$3,'{}'::jsonb,now())`,
        [CONTROL, SPACE, RUN],
      );
      await db.pool.query(
        `INSERT INTO invocation_deliveries
           (id,space_id,invocation_id,attempt,execution_control_snapshot_id,adapter_type,renderer_version,delivery_metadata_json,created_at)
         VALUES ($1,$2,$3,1,$4,'model_api','test.v1','{}'::jsonb,now())`,
        [DELIVERY, SPACE, RUN, CONTROL],
      );
      await db.pool.query(
        `INSERT INTO invocation_snapshots
           (id,space_id,invocation_id,delivery_id,attempt,safe_snapshot_json,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,1,$5::jsonb,'accepted',now(),now())`,
        [SNAPSHOT, SPACE, RUN, DELIVERY, JSON.stringify({ source_refs: [{ type: "artifact", id: SOURCE }] })],
      );
      await db.pool.query(
        `INSERT INTO artifacts
           (id, space_id, run_id, artifact_type, title, export_formats_json,
            visibility, access_level, owner_user_id, created_at, updated_at)
         VALUES ($1,$2,$3,'report','Derived report','[]'::jsonb,
                 'space_shared','full',$4,now(),now())`,
        [DERIVED, SPACE, RUN, OWNER],
      );

      const identity = { spaceId: SPACE, userId: OWNER };
      const accessService = new ContentAccessService(db.pool);
      await expect(accessService.updatePolicy(identity, "artifact", SOURCE, {
        visibility: "private",
        access_level: "full",
        project_id: null,
        grants: [],
      })).rejects.toMatchObject({ statusCode: 409 });

      const disclosure = await new ContentDemotionService(db.pool).disclose(
        identity,
        "artifact",
        SOURCE,
        "private",
      );
      expect(disclosure.exposure.consuming_runs).toEqual([
        expect.objectContaining({ run_id: RUN, link: `/runs/${RUN}` }),
      ]);
      expect(disclosure.exposure.shared_derived_outputs).toEqual([
        expect.objectContaining({ resource_type: "artifact", id: DERIVED, link: `/artifacts/${DERIVED}` }),
      ]);
      await accessService.updatePolicy(identity, "artifact", SOURCE, {
        visibility: "private",
        access_level: "full",
        project_id: null,
        grants: [],
        demotion_confirmation_id: disclosure.confirmation_id,
      });
      const source = await db.pool.query("SELECT visibility FROM artifacts WHERE id = $1", [SOURCE]);
      expect(source.rows[0]?.visibility).toBe("private");
    });
  });
});

describe("contentCreationContextDb", () => {
  const db = useTestDatabase(`${import.meta.filename}#contentCreationContextDb`, { max: 10 });

  describe("content creation context against real PostgreSQL", () => {
    it("resolves personal and Project creation without accepting a visibility default", async (ctx) => {
      if (!db.available || !db.pool) return ctx.skip();
      const userId = randomUUID();
      const viewerId = randomUUID();
      const personalSpaceId = randomUUID();
      const teamSpaceId = randomUUID();
      const projectId = randomUUID();
      const now = new Date().toISOString();
      await resetTables(db.pool, ["spaces", "users"], { cascade: true });
      await db.pool.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at)
         VALUES ($1, 'Creator', 'active', $3, $3),
                ($2, 'Viewer', 'active', $3, $3)`,
        [userId, viewerId, now],
      );
      await db.pool.query(
        `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
         VALUES ($1, 'Personal', 'personal', $3, $4, $4),
                ($2, 'Team', 'team', $3, $4, $4)`,
        [personalSpaceId, teamSpaceId, userId, now],
      );
      await db.pool.query(
        `INSERT INTO space_memberships
           (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $3, $5, 'owner', 'active', $6, $6),
                ($2, $4, $5, 'owner', 'active', $6, $6),
                ($7, $4, $8, 'member', 'active', $6, $6)`,
        [randomUUID(), randomUUID(), personalSpaceId, teamSpaceId, userId, now, randomUUID(), viewerId],
      );
      await db.pool.query(
        `INSERT INTO projects
           (id, space_id, name, owner_user_id, status, created_at, updated_at)
         VALUES ($1, $2, 'Project', $3, 'active', $4, $4)`,
        [projectId, teamSpaceId, userId, now],
      );
      await db.pool.query(
        `INSERT INTO project_members
           (id, space_id, project_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'viewer', 'active', $5, $5)`,
        [randomUUID(), teamSpaceId, projectId, viewerId, now],
      );

      await expect(resolveContentCreationContext(db.pool, {
        userId: viewerId,
        requestSpaceId: teamSpaceId,
        projectId,
      })).rejects.toMatchObject({ statusCode: 403 });

      const personal = await resolveContentCreationContext(db.pool, {
        userId,
        requestSpaceId: teamSpaceId,
      });
      expect(personal).toEqual({
        spaceId: personalSpaceId,
        projectId: null,
        visibility: "private",
      });
      expect(applyContentCreationContext({ visibility: "space_shared", project_id: projectId }, personal)).toEqual({
        visibility: "private",
      });

      const project = await resolveContentCreationContext(db.pool, {
        userId,
        requestSpaceId: teamSpaceId,
        projectId,
      });
      expect(project).toEqual({
        spaceId: teamSpaceId,
        projectId,
        visibility: "space_shared",
      });

      const tasks = new PgTaskRepository(db.pool);
      const personalTask = await tasks.createTask(
        { spaceId: personal.spaceId, userId },
        applyContentCreationContext({ title: "Inbox task" }, personal),
      );
      const projectTask = await tasks.createTask(
        { spaceId: project.spaceId, userId },
        applyContentCreationContext({ title: "Project task" }, project),
      );
      expect(personalTask).toMatchObject({
        space_id: personalSpaceId,
        project_id: null,
        visibility: "private",
      });
      expect(projectTask).toMatchObject({
        space_id: teamSpaceId,
        project_id: projectId,
        visibility: "space_shared",
      });

      const access = new ContentAccessService(db.pool);
      const wholeSpacePolicy = await access.updatePolicy(
        { spaceId: teamSpaceId, userId },
        "task",
        projectTask.id,
        {
          visibility: "space_shared",
          access_level: "full",
          project_id: null,
          grants: [],
        },
      );
      expect(wholeSpacePolicy).toMatchObject({
        resource_id: projectTask.id,
        project_id: null,
        project_folder_id: null,
        visibility: "space_shared",
      });
      const movedTask = await db.pool.query<{ project_id: string | null; project_folder_id: string | null }>(
        "SELECT project_id, project_folder_id FROM tasks WHERE id = $1",
        [projectTask.id],
      );
      expect(movedTask.rows[0]).toEqual({ project_id: null, project_folder_id: null });
    });
  });
});

describe("contentDerivationVisibilityDb", () => {
  const SPACE_ID = "content-derivation-space";
  const OWNER_ID = "content-derivation-owner";
  const MEMBER_ID = "content-derivation-member";
  const OTHER_MEMBER_ID = "content-derivation-other";
  const AGENT_ID = "content-derivation-agent";
  const AGENT_VERSION_ID = "content-derivation-version";


  const db = useTestDatabase(`${import.meta.filename}#contentDerivationVisibilityDb`, { max: 10 });

  beforeEach(async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await resetTables(db.pool, ["spaces", "users"], { cascade: true });
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Owner', 'active', $4, $4),
              ($2, 'Member', 'active', $4, $4),
              ($3, 'Other member', 'active', $4, $4)`,
      [OWNER_ID, MEMBER_ID, OTHER_MEMBER_ID, now],
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, oversight_mode, created_at, updated_at)
       VALUES ($1, 'Content Derivation', 'team', $2, 'full', $3, $3)`,
      [SPACE_ID, OWNER_ID, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships
         (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $4, $5, 'owner', 'active', $8, $8),
              ($2, $4, $6, 'member', 'active', $8, $8),
              ($3, $4, $7, 'member', 'active', $8, $8)`,
      [randomUUID(), randomUUID(), randomUUID(), SPACE_ID, OWNER_ID, MEMBER_ID, OTHER_MEMBER_ID, now],
    );
    await db.pool.query(
      `INSERT INTO agents
         (id, space_id, owner_user_id, name, status, current_version_id,
          created_at, updated_at, visibility)
       VALUES ($1, $2, $3, 'Derivation Agent', 'active', NULL, $4, $4, 'space_shared')`,
      [AGENT_ID, SPACE_ID, OWNER_ID, now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions
         (id, agent_id, space_id, version_label, system_prompt,
          model_config_json, runtime_config_json, context_policy_json,
          memory_policy_json, capabilities_json, tool_permissions_json,
          runtime_policy_json, created_at)
       VALUES ($1, $2, $3, 'v1', 'Test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
      [AGENT_VERSION_ID, AGENT_ID, SPACE_ID, now],
    );
    await db.pool.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [AGENT_ID, AGENT_VERSION_ID]);
  });

  describe("derived content visibility against real PostgreSQL", () => {
    it("keeps artifacts and proposals from a private Run unreadable to another Space member", async (ctx) => {
      if (!db.available || !db.pool) return ctx.skip();
      const run = await new PgRunRepository(db.pool).createQueuedRun({
        agent_id: AGENT_ID,
        space_id: SPACE_ID,
        user_id: OWNER_ID,
        mode: "live",
        run_type: "agent",
        trigger_origin: "manual",
        prompt: "Produce private output",
        visibility: "private",
      });
      const config = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri,
        ARTIFACT_STORAGE_ROOT: "/tmp/agent-space-content-derivation-artifacts",
      });
      const materialized = await new RunMaterializationService(
        config,
        db.pool,
        undefined,
        async () => ({ status: "allow" }),
      ).materializeAdapterResult({
        run,
        adapterResult: {
          adapter_type: "model_api",
          adapter_kind: "managed_api",
          success: true,
          output_text: "",
          output_json: {
            artifacts: [{ title: "Private report", content: "private", visibility: "space_shared" }],
            proposed_changes: [{
              proposal_type: "memory_create",
              title: "Private learning",
              visibility: "private",
              payload_json: { proposed_content: "private" },
            }],
          },
          exit_code: 0,
        },
      });

      expect(materialized.errors).toEqual([]);
      const artifactId = materialized.items.find((item) => item.kind === "artifact")?.artifact_id;
      const proposalId = materialized.items.find((item) => item.kind === "proposal")?.proposal_id;
      expect(artifactId).toBeTruthy();
      expect(proposalId).toBeTruthy();

      const artifactRepository = new PgArtifactRepository(db.pool, config);
      const proposalRepository = new PgProposalRepository(db.pool);
      await expect(artifactRepository.getVisible(SPACE_ID, OWNER_ID, artifactId!)).resolves.not.toBeNull();
      await expect(proposalRepository.getVisible(SPACE_ID, OWNER_ID, proposalId!)).resolves.not.toBeNull();
      await expect(artifactRepository.getVisible(SPACE_ID, MEMBER_ID, artifactId!)).resolves.toBeNull();
      await expect(proposalRepository.getVisible(SPACE_ID, MEMBER_ID, proposalId!)).resolves.toBeNull();

      const stored = await db.pool.query<{ artifact_visibility: string; proposal_visibility: string }>(
        `SELECT a.visibility AS artifact_visibility, p.visibility AS proposal_visibility
           FROM artifacts a CROSS JOIN proposals p
          WHERE a.id = $1 AND p.id = $2`,
        [artifactId, proposalId],
      );
      expect(stored.rows[0]).toEqual({ artifact_visibility: "private", proposal_visibility: "private" });
    });

    it("gives a consolidated proposal the source activity visibility", async (ctx) => {
      if (!db.available || !db.pool) return ctx.skip();
      const activityId = randomUUID();
      const now = new Date().toISOString();
      await db.pool.query(
        `INSERT INTO activity_records
           (id, space_id, user_id, owner_user_id, activity_type, title, content,
            payload_json, occurred_at, created_at, updated_at, status, source_trust,
            visibility, access_level)
         VALUES ($1, $2, $3, $3, 'user_capture', 'Private capture', 'private thought',
                 '{}'::jsonb, $4, $4, $4, 'raw', 'user_confirmed', 'private', 'full')`,
        [activityId, SPACE_ID, OWNER_ID, now],
      );

      const result = await new PgActivityConsolidationRepository(db.pool).runPending({
        spaceId: SPACE_ID,
        actingUserId: OWNER_ID,
        batchLimit: 10,
        activityIds: [activityId],
      });
      expect(result.proposals_created).toHaveLength(1);
      const proposal = await db.pool.query<{ visibility: string; proposed_content: string }>(
        `SELECT visibility, payload_json->>'proposed_content' AS proposed_content
           FROM proposals WHERE id = $1`,
        [(result.proposals_created as string[])[0]],
      );
      expect(proposal.rows[0]).toEqual({ visibility: "private", proposed_content: "private thought" });
    });
  });
});
