import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgRunContextRepository } from "../src/modules/context/repository";

// Real-PostgreSQL coverage for the per-run ContextBuilder project cut: a run
// bound to project P sees P's memory (only if the instructing user can access P)
// plus project-free memory; other projects are excluded; a run with no project
// sees project-free memory only; omitted projectId follows the same fail-closed cut.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJ_P = "55555555-5555-4555-8555-555555555555";
const PROJ_Q = "66666666-6666-4666-8666-666666666666";

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
    console.warn(
      `[context-project-cut-db] skipped — Docker/Postgres unavailable: ${
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
  await pool.query(
    "TRUNCATE memory_entries, project_members, projects, space_memberships, users, spaces CASCADE",
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Team', 'household', now(), now())`,
    [SPACE],
  );
  for (const id of [VIEWER, OTHER]) {
    await pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
  }
  // project_members(space_id, user_id) FKs to space_memberships(space_id, user_id).
  for (const id of [VIEWER, OTHER]) {
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, id],
    );
  }
  // Both projects owned by OTHER, so VIEWER needs explicit membership to access.
  for (const [id, name] of [[PROJ_P, "P"], [PROJ_Q, "Q"]] as const) {
    await pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [id, SPACE, OTHER, name],
    );
  }
  // VIEWER-owned, user-scope memories so symbolMatch surfaces them deterministically.
  for (const [id, projectId] of [
    ["m-free", null],
    ["m-p", PROJ_P],
    ["m-q", PROJ_Q],
  ] as const) {
    await insertMemory(id, projectId);
  }
});

async function insertMemory(id: string, projectId: string | null): Promise<void> {
  await pool!.query(
    `INSERT INTO memory_entries (
       id, space_id, scope_type, memory_type, content, status, visibility,
       sensitivity_level, owner_user_id, project_id, confidence, importance,
       version, access_count, created_at, updated_at
     ) VALUES (
       $1, $2, 'user', 'fact', 'note', 'active', 'space_shared',
       'normal', $3, $4, 1, 0.5, 1, 0, now(), now()
     )`,
    [id, SPACE, VIEWER, projectId],
  );
}

async function addMember(projectId: string, userId: string): Promise<void> {
  await pool!.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
    [`pm-${projectId}`.slice(0, 36), SPACE, projectId, userId],
  );
}

async function retrieveIds(projectId: string | null | undefined): Promise<string[]> {
  const out = await new PgRunContextRepository(pool!).retrieve({
    spaceId: SPACE,
    userId: VIEWER,
    projectFolderId: null,
    agentId: null,
    query: null,
    agentMemoryPolicy: null,
    includeSystemScope: false,
    projectId,
  });
  return out.memories.map((m) => m.id).sort();
}

describe("Per-run ContextBuilder project cut (real Postgres)", () => {
  it("run bound to P (no access) sees only project-free memory", async () => {
    if (!available || !pool) return;
    expect(await retrieveIds(PROJ_P)).toEqual(["m-free"]);
  });

  it("run bound to P (member) sees P + project-free, never other projects", async () => {
    if (!available || !pool) return;
    await addMember(PROJ_P, VIEWER);
    expect(await retrieveIds(PROJ_P)).toEqual(["m-free", "m-p"]);
  });

  it("run with no project sees only project-free memory", async () => {
    if (!available || !pool) return;
    await addMember(PROJ_P, VIEWER); // even with access elsewhere, a null-project run is project-free only
    expect(await retrieveIds(null)).toEqual(["m-free"]);
  });

  it("omitted projectId applies the project-free cut", async () => {
    if (!available || !pool) return;
    expect(await retrieveIds(undefined)).toEqual(["m-free"]);
  });
});
