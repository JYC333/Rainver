import { join } from "node:path";
import { seedServerHost, seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository.js";
import { PgRunSandboxManager } from "../src/modules/projectFolders/sandbox.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import type { FolderReadResult } from "../src/modules/hosts/connectionRegistry.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SECOND_PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";
const HOST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";


const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["workspace_locations", "project_folders", "projects", "space_memberships", "users", "spaces", "hosts", "machines"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`,
    [USER],
  );
  await seedServerHost(db.pool, { id: HOST });
  for (const spaceId of [SPACE, OTHER_SPACE]) {
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Space', 'household', $2, now(), now())`,
      [spaceId, USER],
    );
  }
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES
       ($1,$4,$5,'One','active',now(),now()),
       ($2,$4,$5,'Two','active',now(),now()),
       ($3,$6,$5,'Other','active',now(),now())`,
    [PROJECT, SECOND_PROJECT, OTHER_PROJECT, SPACE, USER, OTHER_SPACE],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
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
  // Every folder this helper creates gets exactly one active Location.
  return db.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       root_path, execution_ready, status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'server',$5,true,'active',now(),now())`,
    [randomUUID(), input.spaceId ?? SPACE, input.id, HOST, input.rootPath],
  );
}

describe("Project Folder database invariants", () => {
  it("lists and gets Project-inherited Folders without a Folder-local visibility ACL", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const folderId = "60606060-6060-4060-8060-606060606060";
    await insertFolder(db.pool, {
      id: folderId,
      rootPath: "/managed/readable",
    });
    const repo = new PgProjectFolderRepository(
      db.pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }),
    );
    const identity = { spaceId: SPACE, userId: USER };

    await expect(repo.list(identity, PROJECT, { status: null, limit: 20, offset: 0 }))
      .resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ id: folderId })] });
    await expect(repo.get(identity, PROJECT, folderId))
      .resolves.toMatchObject({ id: folderId, project_id: PROJECT });
  });

  it("rejects a cross-space Project ownership reference", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();

    await expect(
      insertFolder(db.pool, {
        id: "66666666-6666-4666-8666-666666666666",
        spaceId: SPACE,
        projectId: OTHER_PROJECT,
        rootPath: "/managed/cross-space",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("prevents one physical root from being registered to two Projects", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const rootPath = "/managed/shared";
    await insertFolder(db.pool, {
      id: "77777777-7777-4777-8777-777777777777",
      rootPath,
    });

    await expect(
      insertFolder(db.pool, {
        id: "88888888-8888-4888-8888-888888888888",
        projectId: SECOND_PROJECT,
        rootPath,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("atomically activates one stale Location for new work", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const folderId = "12121212-1212-4212-8212-121212121212";
    await insertFolder(db.pool, {
      id: folderId,
      rootPath: "/managed/original-checkout",
    });
    const activeId = (await db.pool.query<{ id: string }>(
      `SELECT id FROM workspace_locations WHERE project_folder_id = $1 AND status = 'active'`,
      [folderId],
    )).rows[0]!.id;
    const candidateId = "13131313-1313-4313-8313-131313131313";
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'server','/managed/replacement-checkout',true,'stale',now(),now())`,
      [candidateId, SPACE, folderId, HOST],
    );
    const repo = new PgProjectFolderRepository(
      db.pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }),
    );

    await expect(repo.activateLocation(
      { spaceId: SPACE, userId: USER },
      PROJECT,
      folderId,
      candidateId,
    )).resolves.toMatchObject({ id: candidateId, status: "active" });
    await expect(db.pool.query<{ id: string; status: string; execution_ready: boolean }>(
      `SELECT id, status, execution_ready FROM workspace_locations
        WHERE project_folder_id = $1 ORDER BY id`,
      [folderId],
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { id: activeId, status: "stale", execution_ready: true },
        { id: candidateId, status: "active", execution_ready: true },
      ]),
    });
  });

  it("rechecks writer authority after a concurrent Project ownership change", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const folderId = "14141414-1414-4414-8414-141414141414";
    await insertFolder(db.pool, { id: folderId, rootPath: "/managed/race-original" });
    const candidateId = "15151515-1515-4515-8515-151515151515";
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'server','/managed/race-replacement',true,'stale',now(),now())`,
      [candidateId, SPACE, folderId, HOST],
    );
    const authorityChange = await db.pool.connect();
    await authorityChange.query("BEGIN");
    await authorityChange.query(`UPDATE projects SET owner_user_id = NULL WHERE id = $1`, [PROJECT]);
    const repo = new PgProjectFolderRepository(
      db.pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }),
    );
    const activation = repo.activateLocation({ spaceId: SPACE, userId: USER }, PROJECT, folderId, candidateId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await authorityChange.query("COMMIT");
    authorityChange.release();

    await expect(activation).rejects.toMatchObject({ statusCode: 403 });
    await expect(db.pool.query<{ status: string }>(
      `SELECT status FROM workspace_locations WHERE id = $1`,
      [candidateId],
    )).resolves.toMatchObject({ rows: [{ status: "stale" }] });
  });

  it("allows at most one primary Folder under concurrent inserts", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const attempts = await Promise.allSettled([
      insertFolder(db.pool, {
        id: "99999999-9999-4999-8999-999999999999",
        rootPath: "/managed/primary-a",
        primary: true,
      }),
      insertFolder(db.pool, {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        rootPath: "/managed/primary-b",
        primary: true,
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const count = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM project_folders
        WHERE project_id = $1 AND is_primary`,
      [PROJECT],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("prepares a zero-copy read-only Folder without requiring Git or writing context into it", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const root = await mkdtemp(join(tmpdir(), "rainver-read-only-folder-"));
    try {
      const workspaceRoot = join(root, "workspaces");
      const folderRoot = join(workspaceRoot, "plain-project");
      const sandboxRoot = join(root, "sandboxes");
      await mkdir(folderRoot, { recursive: true });
      await writeFile(join(folderRoot, "source.txt"), "authoritative source");
      const folderId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      await insertFolder(db.pool, { id: folderId, rootPath: folderRoot });
      const manager = new PgRunSandboxManager(loadConfig({
        RAINVER_HOME: root,
        WORKSPACE_ROOT: workspaceRoot,
        SANDBOX_ROOT: sandboxRoot,
      }), db.pool);
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
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgProjectFolderRepository(
      db.pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }),
    );
    const identity = { spaceId: SPACE, userId: USER };
    const created = await repo.create(identity, PROJECT, { name: "New Managed Folder" });
    const row = await db.pool.query<{ execution_host_id: string; execution_host_kind: string }>(
      `SELECT execution_host_id, execution_host_kind FROM workspace_locations WHERE project_folder_id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toMatchObject({ execution_host_id: HOST, execution_host_kind: "server" });
  });

  it("reports an offline remote host while keeping server-only sandbox prep blocked (ADR 0016 B62-B64)", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const issued = await hosts.issuePairingCode(USER, "Remote Test Box");
    if ("statusCode" in issued) throw new Error("expected success");
    const remoteFolderId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.pool.query(
      `INSERT INTO project_folders (
         id, space_id, project_id, created_by_user_id, name, status,
         kind, is_primary, protected, system_managed, registered_from, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'Remote Folder','active','code',false,false,false,'daemon_registered',now(),now())`,
      [remoteFolderId, SPACE, PROJECT, USER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'remote',NULL,false,'active',now(),now())`,
      [randomUUID(), SPACE, remoteFolderId, issued.host_id],
    );
    const repo = new PgProjectFolderRepository(
      db.pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }),
    );
    const identity = { spaceId: SPACE, userId: USER };

    await expect(repo.getTree(identity, PROJECT, remoteFolderId)).rejects.toMatchObject({ statusCode: 409, responseBody: { code: "host_offline" } });
    await expect(repo.getFile(identity, PROJECT, remoteFolderId, "x")).rejects.toMatchObject({ statusCode: 409, responseBody: { code: "host_offline" } });
    await expect(repo.getGitStatus(identity, PROJECT, remoteFolderId)).rejects.toMatchObject({ statusCode: 409, responseBody: { code: "host_offline" } });
    await expect(repo.getGitDiff(identity, PROJECT, remoteFolderId, null)).rejects.toMatchObject({ statusCode: 409, responseBody: { code: "host_offline" } });

    const manager = new PgRunSandboxManager(
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }),
      db.pool,
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
    if (!db.available || !db.pool) return ctx.skip();
    const folderId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_folders (
         id, space_id, project_id, created_by_user_id, name, status,
         kind, is_primary, protected, system_managed, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'Bad Remote Folder','active','code',false,false,false,now(),now())`,
      [folderId, SPACE, PROJECT, USER],
    );
    await expect(
      db.pool.query(
        `INSERT INTO workspace_locations (
           id, space_id, project_folder_id, execution_host_id, execution_host_kind,
           root_path, execution_ready, status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'remote','/should/not/exist',false,'active',now(),now())`,
        [randomUUID(), SPACE, folderId, HOST],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("round-trips all live remote read kinds with owner/audit gates", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const issued = await hosts.issuePairingCode(USER, "Remote Read Box");
    if ("statusCode" in issued) throw new Error("expected success");
    await db.pool.query(`UPDATE hosts SET status = 'online', last_heartbeat_at = now() WHERE id = $1`, [issued.host_id]);
    const folderId = "abababab-abab-4aba-8bab-abababababab";
    const locationId = "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd";
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status, kind, is_primary, protected, system_managed, registered_from, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Remote Read Folder','active','code',false,false,false,'daemon_registered',now(),now())`,
      [folderId, SPACE, PROJECT, USER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind, root_path, execution_ready, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'remote',NULL,false,'active',now(),now())`,
      [locationId, SPACE, folderId, issued.host_id],
    );
    const remoteResults: Record<string, unknown> = {
      tree: { name: "repo", path: ".", type: "dir", children: [] },
      file: { path: "README.md", content: "hello\n", size: 6, line_count: 2 },
      git_status: { is_repo: true, branch: "main", files: [] },
      git_diff: { diff: "", path: null, truncated: false, redacted: false },
    };
    const request = vi.spyOn(sharedHostConnectionRegistry, "requestFolderRead").mockImplementation(async (_hostId, frame) => ({
      ok: true,
      kind: frame.kind as "tree" | "file" | "git_status" | "git_diff",
      result: remoteResults[String(frame.kind)]!,
    }) as FolderReadResult);
    try {
      const repo = new PgProjectFolderRepository(db.pool, loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-project-folders-test", SERVER_DATABASE_URL: db.connectionUri }));
      const identity = { spaceId: SPACE, userId: USER };
      await expect(repo.getTree(identity, PROJECT, folderId)).resolves.toMatchObject({ name: "repo" });
      await expect(repo.getFile(identity, PROJECT, folderId, "README.md")).resolves.toMatchObject({ content: "hello\n" });
      await expect(repo.getGitStatus(identity, PROJECT, folderId)).resolves.toMatchObject({ branch: "main" });
      await expect(repo.getGitDiff(identity, PROJECT, folderId, null)).resolves.toMatchObject({ diff: "" });
      expect(request).toHaveBeenCalledTimes(4);
      await expect(repo.getFile(identity, PROJECT, folderId, "/Users/alice/private.txt"))
        .rejects.toMatchObject({ statusCode: 403, responseBody: { code: "path_forbidden" } });
      await expect(repo.getGitDiff(identity, PROJECT, folderId, "/Users/alice/private.txt"))
        .rejects.toMatchObject({ statusCode: 403, responseBody: { code: "path_forbidden" } });
      expect(request).toHaveBeenCalledTimes(4);

      await db.pool.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Viewer', 'active', now(), now())`,
        ["dededede-dede-4ded-8ded-dededededede"],
      );
      await db.pool.query(
        `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES (gen_random_uuid()::varchar,$1,$2,'member','active',now(),now())`,
        [SPACE, "dededede-dede-4ded-8ded-dededededede"],
      );
      await db.pool.query(
        `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'viewer','active',now(),now())`,
        [SPACE, PROJECT, "dededede-dede-4ded-8ded-dededededede"],
      );
      await expect(repo.getTree({ spaceId: SPACE, userId: "dededede-dede-4ded-8ded-dededededede" }, PROJECT, folderId))
        .rejects.toMatchObject({ statusCode: 403, responseBody: { code: "host_not_owned" } });
      request.mockResolvedValueOnce({ ok: false, error: "path_forbidden", message: "blocked" });
      await expect(repo.getFile(identity, PROJECT, folderId, "README.md"))
        .rejects.toMatchObject({ statusCode: 403, responseBody: { code: "path_forbidden" } });
      request.mockResolvedValueOnce({ ok: false, error: "host_timeout" });
      await expect(repo.getTree(identity, PROJECT, folderId))
        .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "host_timeout" } });
      const audits = await db.pool.query<{ metadata_json: Record<string, unknown> }>(
        `SELECT metadata_json FROM policy_decision_records WHERE resource_id = $1 AND action = 'project_folder.read' ORDER BY created_at DESC LIMIT 5`,
        [folderId],
      );
      expect(audits.rows.length).toBeGreaterThanOrEqual(5);
      expect(audits.rows.every((row) => row.metadata_json?.host_id === issued.host_id)).toBe(true);
    } finally {
      request.mockRestore();
    }
  });
});
