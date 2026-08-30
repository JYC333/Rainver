import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { projectReaders } from "../src/modules/projects/access.js";

// Real-PostgreSQL tests for the project membership management API — the ACL that
// gates project-scoped memory. Validates the new project_members table, the
// add/remove authz (project owner or space owner/admin), the "target must be a
// space member" rule, and the upsert. Skips when Docker is unavailable.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // project owner + space member
const ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // space admin
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // plain space member
const OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // not a space member
const PROJECT = "55555555-5555-4555-8555-555555555555";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Team', 'household', now(), now())`,
    [SPACE],
  );
  for (const id of [OWNER, ADMIN, MEMBER, OUTSIDER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
  }
  for (const [id, role] of [
    [OWNER, "member"],
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ] as const) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [`sm-${id}`.slice(0, 36), SPACE, id, role],
    );
  }
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'P', 'active', now(), now())`,
    [PROJECT, SPACE, OWNER],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
});

function repo(): PgProjectRepository {
  return new PgProjectRepository(db.pool);
}

describe("Project membership management (real Postgres)", () => {
  it("project owner adds a member; listMembers reflects it; upsert updates role", async () => {
    if (!db.available) return;
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "member" });
    let members = await repo().listMembers({ spaceId: SPACE, userId: OWNER }, PROJECT);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ user_id: MEMBER, role: "member", status: "active" });

    // Upsert: same user, new role → still one row, updated role.
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "viewer" });
    members = await repo().listMembers({ spaceId: SPACE, userId: OWNER }, PROJECT);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ user_id: MEMBER, role: "viewer" });
  });

  it("a space admin can add members", async () => {
    if (!db.available) return;
    await repo().addMember({ spaceId: SPACE, userId: ADMIN }, PROJECT, { user_id: MEMBER });
    expect(await repo().listMembers({ spaceId: SPACE, userId: ADMIN }, PROJECT)).toHaveLength(1);
  });

  it("a non-owner, non-admin space member cannot add members (403)", async () => {
    if (!db.available) return;
    await expect(
      repo().addMember({ spaceId: SPACE, userId: MEMBER }, PROJECT, { user_id: OWNER }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("cannot add a user who is not an active member of the space (422)", async () => {
    if (!db.available) return;
    await expect(
      repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: OUTSIDER }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an invalid project member role (422)", async () => {
    if (!db.available) return;
    await expect(
      repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "superuser" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("removeMember drops the row", async () => {
    if (!db.available) return;
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER });
    await repo().removeMember({ spaceId: SPACE, userId: OWNER }, PROJECT, MEMBER);
    expect(await repo().listMembers({ spaceId: SPACE, userId: OWNER }, PROJECT)).toHaveLength(0);
  });

  // Readers are `project_members ∪ owner`, which is deliberately not the
  // members list: the owner is never a `project_members` row, and a roster
  // picker built from that list would omit the one person who certainly
  // belongs in the Room.
  it("counts the owner among a Project's readers, and a plain space member only once added", async () => {
    if (!db.available) return;
    await expect(projectReaders(db.pool, SPACE, PROJECT))
      .resolves.toEqual([expect.objectContaining({ user_id: OWNER })]);

    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "member" });
    const readers = await projectReaders(db.pool, SPACE, PROJECT);
    expect(readers.map(reader => reader.user_id).sort()).toEqual([OWNER, MEMBER].sort());
    // What the picker renders, so the query has to carry it.
    expect(readers[0]).toMatchObject({ display_name: expect.any(String) });
    expect(readers[0]).toHaveProperty("email");
  });

  it("leaves a disabled account out of the readers, as the audience queries do", async () => {
    if (!db.available) return;
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "member" });
    await db.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [MEMBER]);
    await expect(projectReaders(db.pool, SPACE, PROJECT))
      .resolves.toEqual([expect.objectContaining({ user_id: OWNER })]);
  });
});
