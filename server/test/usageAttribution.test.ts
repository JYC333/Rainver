import { describe, expect, it } from "vitest";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common";
import { resolveUsageAttribution } from "../src/modules/usage/attribution";
import type { UsageObservation } from "../src/modules/usage/types";

class AttributionDb implements Queryable {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];

  constructor(
    private readonly handler: (sql: string, params?: readonly unknown[]) => QueryResult<unknown>,
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    return this.handler(sql, params) as QueryResult<Row>;
  }
}

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    space_id: "space-1",
    event_type: "llm.generation",
    source_type: "local_run",
    execution_channel: "managed_api",
    ...overrides,
  };
}

describe("usage attribution", () => {
  it("attributes a direct user call as private after active membership validation", async () => {
    const db = new AttributionDb((sql) => {
      if (sql.includes("FROM space_memberships")) return { rows: [{ one: 1 }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveUsageAttribution(db, observation({ subject_user_id: "user-1" }));

    expect(result).toEqual({
      owner_user_id: "user-1",
      visibility: "private",
      access_level: "full",
      source_resource_type: null,
      source_resource_id: null,
      project_folder_id: null,
      project_id: null,
      grant_snapshots: [],
    });
    expect(db.calls[0]?.params).toEqual(["space-1", "user-1"]);
  });

  it("snapshots owner, scope, policy, and active selected-user grants from a Run", async () => {
    const db = new AttributionDb((sql, params) => {
      if (sql.includes("FROM runs usage_source")) {
        expect(params).toEqual(["space-1", "run-1"]);
        return {
          rows: [{
            owner_user_id: "owner-1",
            visibility: "selected_users",
            access_level: "summary",
            project_folder_id: "workspace-1",
            project_id: "project-1",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM content_access_grants")) {
        return {
          rows: [{
            grantee_user_id: "member-2",
            granted_by_user_id: "owner-1",
            access_level: "full",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveUsageAttribution(db, observation({ run_id: "run-1" }));

    expect(result).toMatchObject({
      owner_user_id: "owner-1",
      visibility: "selected_users",
      access_level: "summary",
      source_resource_type: "run",
      source_resource_id: "run-1",
      project_folder_id: "workspace-1",
      project_id: "project-1",
      grant_snapshots: [{
        user_id: "member-2",
        granted_by_user_id: "owner-1",
        access_level: "full",
      }],
    });
    expect(result.grant_snapshots[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects ownerless sources unless the caller marks an explicit shared Space system task", async () => {
    const db = new AttributionDb((sql) => {
      if (sql.includes("FROM runs usage_source")) {
        return {
          rows: [{
            owner_user_id: null,
            visibility: "space_shared",
            access_level: "full",
            project_folder_id: null,
            project_id: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM content_access_grants")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(resolveUsageAttribution(db, observation({ run_id: "run-1" })))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(resolveUsageAttribution(db, observation({
      run_id: "run-1",
      space_system_task: true,
    }))).resolves.toMatchObject({
      owner_user_id: null,
      visibility: "space_shared",
      source_resource_type: "run",
      source_resource_id: "run-1",
    });
  });

  it("snapshots disclosure-upgrade grants for a space_shared source too", async () => {
    const db = new AttributionDb((sql, params) => {
      if (sql.includes("FROM runs usage_source")) {
        return {
          rows: [{
            owner_user_id: "owner-1",
            visibility: "space_shared",
            access_level: "summary",
            project_folder_id: null,
            project_id: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM content_access_grants")) {
        expect(params).toEqual(["space-1", "run", "run-1"]);
        return {
          rows: [{
            grantee_user_id: "member-2",
            granted_by_user_id: "owner-1",
            access_level: "full",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveUsageAttribution(db, observation({ run_id: "run-1" }));

    expect(result).toMatchObject({
      owner_user_id: "owner-1",
      visibility: "space_shared",
      access_level: "summary",
      grant_snapshots: [{
        user_id: "member-2",
        granted_by_user_id: "owner-1",
        access_level: "full",
      }],
    });
  });

  it("fails before writing when no owner or explicit system attribution exists", async () => {
    const db = new AttributionDb(() => {
      throw new Error("database should not be queried");
    });

    await expect(resolveUsageAttribution(db, observation()))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(db.calls).toHaveLength(0);
  });
});
