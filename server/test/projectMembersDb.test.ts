import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";

// Real-PostgreSQL tests for the project membership management API — the ACL that
// gates project-scoped memory. Validates the new project_members table, the
// add/remove authz (project owner or space owner/admin), the "target must be a
// space member" rule, and the upsert. Skips when Docker is unavailable.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // project owner + space member
const ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // space admin
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // plain space member
const OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // not a space member
const PROJECT = "55555555-5555-4555-8555-555555555555";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[project-members-db] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE project_members, projects, space_memberships, users, spaces CASCADE");
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Team', 'household', now(), now())`,
    [SPACE],
  );
  for (const id of [OWNER, ADMIN, MEMBER, OUTSIDER]) {
    await pool.query(
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
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [`sm-${id}`.slice(0, 36), SPACE, id, role],
    );
  }
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'P', 'active', now(), now())`,
    [PROJECT, SPACE, OWNER],
  );
});

function repo(): PgProjectRepository {
  return new PgProjectRepository(pool!);
}

describe("Project membership management (real Postgres)", () => {
  it("project owner adds a member; listMembers reflects it; upsert updates role", async () => {
    if (!available || !pool) return;
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
    if (!available || !pool) return;
    await repo().addMember({ spaceId: SPACE, userId: ADMIN }, PROJECT, { user_id: MEMBER });
    expect(await repo().listMembers({ spaceId: SPACE, userId: ADMIN }, PROJECT)).toHaveLength(1);
  });

  it("a non-owner, non-admin space member cannot add members (403)", async () => {
    if (!available || !pool) return;
    await expect(
      repo().addMember({ spaceId: SPACE, userId: MEMBER }, PROJECT, { user_id: OWNER }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("cannot add a user who is not an active member of the space (422)", async () => {
    if (!available || !pool) return;
    await expect(
      repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: OUTSIDER }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an invalid project member role (422)", async () => {
    if (!available || !pool) return;
    await expect(
      repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "superuser" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("removeMember drops the row", async () => {
    if (!available || !pool) return;
    await repo().addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER });
    await repo().removeMember({ spaceId: SPACE, userId: OWNER }, PROJECT, MEMBER);
    expect(await repo().listMembers({ spaceId: SPACE, userId: OWNER }, PROJECT)).toHaveLength(0);
  });
});
