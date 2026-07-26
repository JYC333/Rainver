import { describe, expect, it } from "vitest";
import { ContentAccessService } from "../src/modules/contentAccess/service";

class AccessDb {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  resource = {
    id: "artifact-1",
    space_id: "space-1",
    owner_user_id: "owner-1",
    visibility: "private",
    access_level: "full",
    project_folder_id: null,
    project_id: null,
  };
  activeUsers = new Set(["owner-1", "member-1"]);
  grants: Array<{ grantee_user_id: string; access_level: string; created_at: string; updated_at: string }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("FROM artifacts")) {
      return { rows: [{ ...this.resource }] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE artifacts")) {
      this.resource.visibility = String(params[2]);
      this.resource.access_level = String(params[3]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes("SELECT user_id FROM space_memberships")) {
      const requested = Array.isArray(params[1]) ? params[1].map(String) : [];
      const rows = requested
        .filter((userId) => this.activeUsers.has(userId))
        .map((user_id) => ({ user_id }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (normalized.includes("SELECT role FROM space_memberships")) {
      const active = this.activeUsers.has(String(params[1]));
      return { rows: (active ? [{ role: "member" }] : []) as Row[], rowCount: active ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE content_access_grants")) {
      this.grants = [];
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT INTO content_access_grants")) {
      this.grants.push({
        grantee_user_id: String(params[4]),
        access_level: String(params[6]),
        created_at: String(params[7]),
        updated_at: String(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes("FROM content_access_grants")) {
      return { rows: this.grants as Row[], rowCount: this.grants.length };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

describe("ContentAccessService", () => {
  it("atomically replaces visibility, access level, and selected-user grants", async () => {
    const db = new AccessDb();
    const service = new ContentAccessService(db as never);

    const result = await service.updatePolicy(
      { spaceId: "space-1", userId: "owner-1" },
      "artifact",
      "artifact-1",
      {
        visibility: "selected_users",
        access_level: "summary",
        grants: [{ user_id: "member-1", access_level: "full" }],
      },
    );

    expect(result).toMatchObject({
      visibility: "selected_users",
      access_level: "summary",
      grants: [{ user_id: "member-1", access_level: "full" }],
    });
    expect(db.calls.map((call) => call.sql.trim())).toContain("COMMIT");
  });

  it("persists grants on space_shared visibility too (disclosure upgrades)", async () => {
    const db = new AccessDb();
    const service = new ContentAccessService(db as never);

    const result = await service.updatePolicy(
      { spaceId: "space-1", userId: "owner-1" },
      "artifact",
      "artifact-1",
      {
        visibility: "space_shared",
        access_level: "summary",
        grants: [{ user_id: "member-1", access_level: "full" }],
      },
    );

    expect(result).toMatchObject({
      visibility: "space_shared",
      access_level: "summary",
      grants: [{ user_id: "member-1", access_level: "full" }],
    });
    expect(db.grants).toEqual([
      { grantee_user_id: "member-1", access_level: "full", created_at: expect.any(String), updated_at: expect.any(String) },
    ]);
  });

  it("space_shared does not require any grantee (grants are optional disclosure upgrades)", async () => {
    const db = new AccessDb();
    const service = new ContentAccessService(db as never);

    const result = await service.updatePolicy(
      { spaceId: "space-1", userId: "owner-1" },
      "artifact",
      "artifact-1",
      { visibility: "space_shared", access_level: "full", grants: [] },
    );

    expect(result).toMatchObject({ visibility: "space_shared", grants: [] });
  });

  it("revokes all active grants when visibility is switched to private", async () => {
    const db = new AccessDb();
    db.grants.push({ grantee_user_id: "member-1", access_level: "full", created_at: "t", updated_at: "t" });
    const service = new ContentAccessService(db as never);

    await service.updatePolicy(
      { spaceId: "space-1", userId: "owner-1" },
      "artifact",
      "artifact-1",
      { visibility: "private", access_level: "full", grants: [] },
    );

    expect(db.grants).toEqual([]);
  });

  it("rolls back when any grantee is not an active Space member", async () => {
    const db = new AccessDb();
    const service = new ContentAccessService(db as never);

    await expect(service.updatePolicy(
      { spaceId: "space-1", userId: "owner-1" },
      "artifact",
      "artifact-1",
      {
        visibility: "selected_users",
        access_level: "full",
        grants: [{ user_id: "outsider-1", access_level: "full" }],
      },
    )).rejects.toMatchObject({ statusCode: 422 });

    expect(db.calls.map((call) => call.sql.trim())).toContain("ROLLBACK");
    expect(db.grants).toEqual([]);
  });
});
