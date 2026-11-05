import { ProjectOverviewService } from "../src/modules/projects/overviewService.js";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { projectReaders } from "../src/modules/projects/access.js";

// Real-PostgreSQL tests for the project membership management API — the ACL that
// gates project-scoped memory. Covers project_members, the
// add/remove authz (project owner or space owner/admin), the "target must be a
// space member" rule, and the upsert. The suite skips when that database is
// unreachable. CI sets REQUIRE_TEST_POSTGRES, which fails the run instead
// of skipping.

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
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'U', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
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
  it("reports membership requirements consistently and opens internal content only after a grant", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: MEMBER };
    const overview = new ProjectOverviewService(db.pool);
    expect(await repo().get(identity, PROJECT)).toMatchObject({ name: "P", current_user_can_read: false, current_user_grantable_member_role: null });
    expect(await repo().list(identity, { limit: 20, offset: 0 })).toMatchObject({ items: [], total: 0 });
    await expect(overview.getOverview(identity, PROJECT)).rejects.toMatchObject({ statusCode: 404 });
    expect(await repo().get({ spaceId: SPACE, userId: ADMIN }, PROJECT)).toMatchObject({ current_user_can_read: false, current_user_can_write: true, current_user_grantable_member_role: "member" });
    expect(await repo().get({ spaceId: SPACE, userId: OWNER }, PROJECT)).toMatchObject({ current_user_can_read: true, current_user_grantable_member_role: "owner" });
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "viewer" });
    expect(await repo().get(identity, PROJECT)).toMatchObject({ current_user_can_read: true, current_user_can_write: false, current_user_grantable_member_role: null });
    expect((await repo().list(identity, { limit: 20, offset: 0 })).items).toEqual([expect.objectContaining({ current_user_can_read: true })]);
    await expect(overview.getOverview(identity, PROJECT)).resolves.toMatchObject({ project: { id: PROJECT } });
    await repo().removeMember({ spaceId: SPACE, userId: OWNER }, PROJECT, MEMBER);
    expect(await repo().get(identity, PROJECT)).toMatchObject({ current_user_can_read: false });
    expect(await repo().list(identity, { limit: 20, offset: 0 })).toMatchObject({ items: [], total: 0 });
    await expect(overview.getOverview(identity, PROJECT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("filters unreadable Projects before pagination, counts, and status selection while retaining admin management", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: MEMBER };
    const hidden = await repo().create({ spaceId: SPACE, userId: OWNER }, { name: "Unrelated private work" });
    const mine = await repo().create(identity, { name: "My work" });
    await db.pool.query("UPDATE projects SET updated_at = now() + interval '1 day' WHERE id = $1", [hidden.id]);
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "viewer" });
    const first = await repo().list(identity, { limit: 1, offset: 0 });
    expect(first).toMatchObject({ total: 2, items: [expect.objectContaining({ id: mine.id })] });
    const second = await repo().list(identity, { limit: 1, offset: 1 });
    expect(second).toMatchObject({ total: 2, items: [expect.objectContaining({ id: PROJECT })] });
    await db.pool.query("UPDATE projects SET status = 'archived' WHERE id = $1", [hidden.id]);
    expect(await repo().list(identity, { status: "archived", limit: 10, offset: 0 })).toMatchObject({ items: [], total: 0 });
    const adminList = await repo().list({ spaceId: SPACE, userId: ADMIN }, { status: "archived", limit: 10, offset: 0 });
    expect(adminList).toMatchObject({ total: 1, items: [expect.objectContaining({ id: hidden.id, current_user_can_read: false, current_user_grantable_member_role: "member" })] });
  });

  it("does not let a Space admin grant ownership or demote an existing Project owner", async () => {
    if (!db.available) return;
    await expect(repo().addMember({ spaceId: SPACE, userId: ADMIN }, PROJECT, { user_id: MEMBER, role: "owner" })).rejects.toMatchObject({ statusCode: 403 });
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "owner" });
    await expect(repo().removeMember({ spaceId: SPACE, userId: ADMIN }, PROJECT, MEMBER)).rejects.toMatchObject({ statusCode: 403 });
    await expect(repo().addMember({ spaceId: SPACE, userId: ADMIN }, PROJECT, { user_id: MEMBER, role: "viewer" })).rejects.toMatchObject({ statusCode: 403 });
  });

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
