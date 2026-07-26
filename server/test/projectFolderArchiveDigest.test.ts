import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository";

type Captured = { sql: string; params: readonly unknown[] };

class FakeDb {
  readonly queries: Captured[] = [];
  constructor(
    private readonly folderRowCount: number,
    private readonly projectOwnerId = identity.userId,
  ) {}

  async query(sql: string, params: readonly unknown[] = []) {
    this.queries.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT id, status FROM projects")) {
      return { rows: [{ id: "project-1", status: "active" }], rowCount: 1 };
    }
    if (norm.startsWith("SELECT owner_user_id FROM projects")) {
      return { rows: [{ owner_user_id: this.projectOwnerId }], rowCount: 1 };
    }
    if (
      norm.startsWith("SELECT role FROM space_memberships") ||
      norm.startsWith("SELECT role FROM project_members")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("UPDATE project_folders")) {
      return { rows: [], rowCount: this.folderRowCount };
    }
    if (norm.startsWith("UPDATE context_digests")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const identity = { spaceId: "space-1", userId: "user-1" };

function repoWith(db: FakeDb): PgProjectFolderRepository {
  return new PgProjectFolderRepository(db as never, loadConfig({}));
}

describe("PgProjectFolderRepository.archive — digest lifecycle", () => {
  it("disables the Folder's active/dirty digests when the Folder is archived", async () => {
    const db = new FakeDb(1);
    const ok = await repoWith(db).archive(identity, "project-1", "folder-1");

    expect(ok).toBe(true);
    const disable = db.queries.find((q) => q.sql.includes("UPDATE context_digests"));
    expect(disable).toBeDefined();
    expect(disable?.sql).toContain("status = 'disabled'");
    expect(disable?.sql).toContain("status IN ('active', 'dirty')");
    // params: [now, spaceId, scopeType, scopeId]
    expect(disable?.params).toContain("space-1");
    expect(disable?.params).toContain("project_folder");
    expect(disable?.params).toContain("folder-1");
  });

  it("does not touch digests when the Folder was not found (no-op archive)", async () => {
    const db = new FakeDb(0);
    const ok = await repoWith(db).archive(identity, "project-1", "missing-folder");

    expect(ok).toBe(false);
    expect(db.queries.some((q) => q.sql.includes("UPDATE context_digests"))).toBe(false);
  });

  it("rejects archive when the caller is not a Project writer", async () => {
    const db = new FakeDb(1, "another-user");

    await expect(
      repoWith(db).archive(identity, "project-1", "folder-1"),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(db.queries.some((q) => q.sql.includes("UPDATE project_folders"))).toBe(false);
  });

  it("rolls back the archive when disabling digests fails (atomic)", async () => {
    const client = {
      queries: [] as string[],
      released: false,
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim();
        this.queries.push(norm);
        if (norm.startsWith("SELECT id, status FROM projects")) {
          return { rows: [{ id: "project-1", status: "active" }], rowCount: 1 };
        }
        if (norm.startsWith("SELECT owner_user_id FROM projects")) {
          return { rows: [{ owner_user_id: identity.userId }], rowCount: 1 };
        }
        if (norm.startsWith("UPDATE project_folders")) return { rows: [], rowCount: 1 };
        if (norm.startsWith("UPDATE context_digests")) throw new Error("disable failed");
        return { rows: [], rowCount: 0 };
      },
      release() {
        this.released = true;
      },
    };
    const pool = {
      async query(sql: string) {
        return client.query(sql);
      },
      async connect() {
        return client;
      },
    };

    await expect(
      new PgProjectFolderRepository(pool as never, loadConfig({})).archive(identity, "project-1", "folder-1"),
    ).rejects.toThrow(/disable failed/);

    expect(client.queries).toContain("BEGIN");
    expect(client.queries).toContain("ROLLBACK");
    expect(client.queries).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });
});
