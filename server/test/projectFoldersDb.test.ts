import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { loadConfig } from "../src/config";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository";
import { PgRunSandboxManager } from "../src/modules/projectFolders/sandbox";
import { PgHostRepository } from "../src/modules/hosts/repository";
import type { RunRecord } from "../src/modules/runs/repository";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SECOND_PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";
const HOST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[project-folders-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE workspace_locations, project_folders, projects, space_memberships, users, spaces, hosts, machines CASCADE");
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`,
    [USER],
  );
  await pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, NULL, 'Test server', 'server', now(), now())`,
    [HOST],
  );
  await pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, NULL, $1, 'server', 'server', 'server', 'online', now(), now())`,
    [HOST],
  );
  for (const spaceId of [SPACE, OTHER_SPACE]) {
    await pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Space', 'household', $2, now(), now())`,
      [spaceId, USER],
    );
  }
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES
       ($1,$4,$5,'One','active',now(),now()),
       ($2,$4,$5,'Two','active',now(),now()),
       ($3,$6,$5,'Other','active',now(),now())`,
    [PROJECT, SECOND_PROJECT, OTHER_PROJECT, SPACE, USER, OTHER_SPACE],
  );
});

async function insertFolder(
  db: Pool,
  input: { id: string; spaceId?: string; projectId?: string; rootPath: string; primary?: boolean },
) {
  await db.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, created_by_user_id, name, status,
       kind, is_primary, protected, system_managed, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$1,'active','code',$5,false,false,now(),now())`,
    [
      input.id,
      input.spaceId ?? SPACE,
      input.projectId ?? PROJECT,
      USER,
      input.primary ?? false,
    ],
  );
  // Every folder this helper creates gets exactly one Location, so that
  // Location is always `preferred` — distinct from `is_primary` above,
  // which is a Folder/Project-level concept (a folder's primary-ness has
  // no bearing on whether its own single Location is the one Runs resolve
  // to; see workspaceLocations.ts's doc comment).
  return db.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       root_path, execution_ready, status, preferred, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'server',$5,true,'active',true,now(),now())`,
    [randomUUID(), input.spaceId ?? SPACE, input.id, HOST, input.rootPath],
  );
}

describe("Project Folder database invariants", () => {
  it("lists and gets Project-inherited Folders without a Folder-local visibility ACL", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const folderId = "60606060-6060-4060-8060-606060606060";
    await insertFolder(pool, {
      id: folderId,
      rootPath: "/managed/readable",
    });
    const repo = new PgProjectFolderRepository(
      pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/agent-space-project-folders-test" }),
    );
    const identity = { spaceId: SPACE, userId: USER };

    await expect(repo.list(identity, PROJECT, { status: null, limit: 20, offset: 0 }))
      .resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ id: folderId })] });
    await expect(repo.get(identity, PROJECT, folderId))
      .resolves.toMatchObject({ id: folderId, project_id: PROJECT });
  });

  it("rejects a cross-space Project ownership reference", async (ctx) => {
    if (!available || !pool) return ctx.skip();

    await expect(
      insertFolder(pool, {
        id: "66666666-6666-4666-8666-666666666666",
        spaceId: SPACE,
        projectId: OTHER_PROJECT,
        rootPath: "/managed/cross-space",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("prevents one physical root from being registered to two Projects", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const rootPath = "/managed/shared";
    await insertFolder(pool, {
      id: "77777777-7777-4777-8777-777777777777",
      rootPath,
    });

    await expect(
      insertFolder(pool, {
        id: "88888888-8888-4888-8888-888888888888",
        projectId: SECOND_PROJECT,
        rootPath,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("allows at most one primary Folder under concurrent inserts", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const attempts = await Promise.allSettled([
      insertFolder(pool, {
        id: "99999999-9999-4999-8999-999999999999",
        rootPath: "/managed/primary-a",
        primary: true,
      }),
      insertFolder(pool, {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        rootPath: "/managed/primary-b",
        primary: true,
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM project_folders
        WHERE project_id = $1 AND is_primary`,
      [PROJECT],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("prepares a zero-copy read-only Folder without requiring Git or writing context into it", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const root = await mkdtemp(join(tmpdir(), "aspace-read-only-folder-"));
    try {
      const workspaceRoot = join(root, "workspaces");
      const folderRoot = join(workspaceRoot, "plain-project");
      const sandboxRoot = join(root, "sandboxes");
      await mkdir(folderRoot, { recursive: true });
      await writeFile(join(folderRoot, "source.txt"), "authoritative source");
      const folderId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      await insertFolder(pool, { id: folderId, rootPath: folderRoot });
      const manager = new PgRunSandboxManager(loadConfig({
        AGENT_SPACE_HOME: root,
        WORKSPACE_ROOT: workspaceRoot,
        SANDBOX_ROOT: sandboxRoot,
      }), pool);
      const prepared = await manager.prepareRunWorkspace({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        space_id: SPACE,
        project_folder_id: folderId,
        required_sandbox_level: "read_only",
      } as RunRecord);

      expect(prepared).toMatchObject({
        sandbox_cwd: folderRoot,
        sandbox_kind: "read_only_project",
        cleanup_kind: "plain_workdir",
        project_folder_root: folderRoot,
        base_commit_sha: null,
      });
      expect(prepared.context_cwd).toContain(join(sandboxRoot, "read-only-context"));
      await expect(readFile(join(folderRoot, "source.txt"), "utf8"))
        .resolves.toBe("authoritative source");
      await expect(readFile(join(folderRoot, "AGENTS.md"), "utf8")).rejects.toThrow();

      await manager.cleanupRunWorkspace({
        runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        spaceId: SPACE,
        cleanupKind: prepared.cleanup_kind,
        sandboxCwd: prepared.context_cwd,
        workspaceRoot: prepared.project_folder_root,
      });
      await expect(readFile(join(folderRoot, "source.txt"), "utf8"))
        .resolves.toBe("authoritative source");
      await expect(readFile(prepared.context_cwd!, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stamps a new Folder to the server host (ADR 0016)", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repo = new PgProjectFolderRepository(
      pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/agent-space-project-folders-test" }),
    );
    const identity = { spaceId: SPACE, userId: USER };
    const created = await repo.create(identity, PROJECT, { name: "New Managed Folder" });
    const row = await pool.query<{ execution_host_id: string; execution_host_kind: string }>(
      `SELECT execution_host_id, execution_host_kind FROM workspace_locations WHERE project_folder_id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toMatchObject({ execution_host_id: HOST, execution_host_kind: "server" });
  });

  it("refuses local-filesystem reads and sandbox prep for a remote-host Folder (ADR 0016 B62-B64)", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const hosts = new PgHostRepository(pool);
    const issued = await hosts.issuePairingCode(USER, "Remote Test Box");
    if ("statusCode" in issued) throw new Error("expected success");
    const remoteFolderId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await pool.query(
      `INSERT INTO project_folders (
         id, space_id, project_id, created_by_user_id, name, status,
         kind, is_primary, protected, system_managed, registered_from, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'Remote Folder','active','code',false,false,false,'daemon_registered',now(),now())`,
      [remoteFolderId, SPACE, PROJECT, USER],
    );
    await pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, preferred, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'remote',NULL,false,'active',true,now(),now())`,
      [randomUUID(), SPACE, remoteFolderId, issued.host_id],
    );
    const repo = new PgProjectFolderRepository(
      pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/agent-space-project-folders-test" }),
    );
    const identity = { spaceId: SPACE, userId: USER };

    await expect(repo.getTree(identity, PROJECT, remoteFolderId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(repo.getFile(identity, PROJECT, remoteFolderId, "x")).rejects.toMatchObject({ statusCode: 409 });
    await expect(repo.getGitStatus(identity, PROJECT, remoteFolderId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(repo.getGitDiff(identity, PROJECT, remoteFolderId, null)).rejects.toMatchObject({ statusCode: 409 });

    const manager = new PgRunSandboxManager(
      loadConfig({ WORKSPACE_ROOT: "/tmp/agent-space-project-folders-test" }),
      pool,
    );
    await expect(
      manager.prepareRunWorkspace({
        id: "fefefefe-fefe-4fef-8fef-fefefefefefe",
        space_id: SPACE,
        project_folder_id: remoteFolderId,
        required_sandbox_level: "read_only",
      } as RunRecord),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a remote-host Folder that carries a root_path at the database level", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const folderId = randomUUID();
    await pool.query(
      `INSERT INTO project_folders (
         id, space_id, project_id, created_by_user_id, name, status,
         kind, is_primary, protected, system_managed, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'Bad Remote Folder','active','code',false,false,false,now(),now())`,
      [folderId, SPACE, PROJECT, USER],
    );
    await expect(
      pool.query(
        `INSERT INTO workspace_locations (
           id, space_id, project_folder_id, execution_host_id, execution_host_kind,
           root_path, execution_ready, status, preferred, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'remote','/should/not/exist',false,'active',true,now(),now())`,
        [randomUUID(), SPACE, folderId, HOST],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
