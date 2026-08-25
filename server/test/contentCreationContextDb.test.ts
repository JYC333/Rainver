import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../src/modules/access/creationContext";
import { ContentAccessService } from "../src/modules/contentAccess/service";
import { PgTaskRepository } from "../src/modules/tasks/repository";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";


const db = useTestDatabase(__filename, { max: 10 });

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
