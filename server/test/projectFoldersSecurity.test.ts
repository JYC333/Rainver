import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

class SecurityDb {
  readonly queries: string[] = [];

  constructor(
    private readonly projectOwnerId = "user-1",
    private readonly deleteRowCount = 1,
  ) {}

  async query(sql: string): Promise<QueryResult> {
    const norm = sql.replace(/\s+/g, " ").trim();
    this.queries.push(norm);
    if (norm.startsWith("SELECT id, status FROM projects")) {
      return { rows: [{ id: "project-1", status: "active" }], rowCount: 1 };
    }
    if (norm.startsWith("SELECT owner_user_id FROM projects")) {
      return { rows: [{ owner_user_id: this.projectOwnerId }], rowCount: 1 };
    }
    if (
      norm.startsWith("SELECT role FROM space_memberships") ||
      norm.startsWith("SELECT role FROM project_members") ||
      norm.startsWith("SELECT root_path FROM project_folders") ||
      norm.startsWith("SELECT id FROM project_folders")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("DELETE FROM project_folders")) {
      return { rows: [], rowCount: this.deleteRowCount };
    }
    return { rows: [], rowCount: 0 };
  }
}

const identity = { spaceId: "space-1", userId: "user-1" };
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "project-folders-security-"));
  tempRoots.push(root);
  const spaceRoot = join(root, identity.spaceId);
  await mkdir(spaceRoot, { recursive: true });
  return { root, spaceRoot };
}

function repository(db: SecurityDb, root: string) {
  return new PgProjectFolderRepository(
    db as never,
    loadConfig({ WORKSPACE_ROOT: root }),
  );
}

describe("Project Folder security boundaries", () => {
  it("uses the owning Project ACL for Folder list and detail reads", async () => {
    const { root } = await setup();
    const db = new SecurityDb();
    const repo = repository(db, root);

    await repo.list(identity, "project-1", { status: null, limit: 20, offset: 0 });
    await repo.get(identity, "project-1", "folder-1");

    const readQueries = db.queries.filter((sql) => sql.includes("FROM project_folders"));
    expect(readQueries.length).toBeGreaterThan(0);
    expect(readQueries.every((sql) => sql.includes("folder_access_project"))).toBe(true);
    expect(readQueries.every((sql) => !sql.includes("project_folders.visibility"))).toBe(true);
    expect(readQueries.every((sql) => !sql.includes("project_folders.access_level"))).toBe(true);
    expect(readQueries.every((sql) => !sql.includes("project_folders.owner_user_id"))).toBe(true);
  });

  it("requires Project write access before exposing scan candidates", async () => {
    const { root, spaceRoot } = await setup();
    await mkdir(join(spaceRoot, "candidate"));
    const db = new SecurityDb("another-user");

    await expect(
      repository(db, root).scanCandidates(identity, "project-1"),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(db.queries.some((sql) => sql.startsWith("SELECT root_path FROM project_folders"))).toBe(false);
  });

  it("returns only direct real directories and rejects arbitrary nested paths and escaping symlinks", async () => {
    const { root, spaceRoot } = await setup();
    const candidate = join(spaceRoot, "candidate");
    const nested = join(candidate, "nested");
    const outside = join(root, "outside");
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(spaceRoot, "escape"));
    const repo = repository(new SecurityDb(), root);

    await expect(repo.scanCandidates(identity, "project-1")).resolves.toEqual([
      { name: "candidate", path: candidate },
    ]);
    await expect(
      repo.create(identity, "project-1", { name: "Nested", root_path: nested }),
    ).rejects.toThrow(/pick from scanCandidates/);
    await expect(
      repo.create(identity, "project-1", { name: "Escape", root_path: join(spaceRoot, "escape") }),
    ).rejects.toThrow(/pick from scanCandidates/);
  });

  it("requires Project write access to unregister and never removes the physical directory", async () => {
    const { root, spaceRoot } = await setup();
    const folderPath = join(spaceRoot, "keep-me");
    await mkdir(folderPath);

    const deniedDb = new SecurityDb("another-user");
    await expect(
      repository(deniedDb, root).unregister(identity, "project-1", "folder-1"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(deniedDb.queries.some((sql) => sql.startsWith("DELETE FROM project_folders"))).toBe(false);

    const allowed = await repository(new SecurityDb(), root)
      .unregister(identity, "project-1", "folder-1");
    expect(allowed).toBe(true);
    await expect(stat(folderPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});
