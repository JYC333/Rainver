import { describe, expect, it } from "vitest";
import { ContextOpsService } from "../src/modules/contextOps/service.js";
import { RetrievalRegistry } from "../src/modules/retrieval/registry.js";
import type { RetrievalDomainAdapter } from "../src/modules/retrieval/registry.js";

// Objects the fake adapter will revalidate as readable. "ro-hidden" is omitted,
// so the canonical read gate drops it; "ro-restricted" is readable but carries a
// source connection whose policy denies the viewer.
const READABLE = new Set(["ro-readable", "ro-restricted"]);

function fakeKnowledgeRegistry(): RetrievalRegistry {
  const adapter: RetrievalDomainAdapter = {
    objectTypes: ["knowledge_item"],
    async loadCanonical() {
      return null;
    },
    async revalidate(_db, _spaceId, _objectType, objectId) {
      return READABLE.has(objectId) ? { title: `Title ${objectId}`, text: null } : null;
    },
    async listObjectIds() {
      return [];
    },
  };
  const registry = new RetrievalRegistry();
  registry.register(adapter);
  return registry;
}

class DrilldownFakeDb {
  queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();

    if (/FROM retrieval_objects/.test(norm) && /indexed_at < source_updated_at/.test(norm)) {
      return {
        rows: [
          {
            object_type: "knowledge_item",
            object_id: "ro-readable",
            indexed_at: "2026-06-01T00:00:00.000Z",
            source_updated_at: "2026-06-10T00:00:00.000Z",
            source_connection_ids_json: [],
            missing_chunk_count: null,
          },
          {
            object_type: "knowledge_item",
            object_id: "ro-restricted",
            indexed_at: "2026-06-02T00:00:00.000Z",
            source_updated_at: "2026-06-11T00:00:00.000Z",
            source_connection_ids_json: ["src-1"],
            missing_chunk_count: null,
          },
          {
            object_type: "knowledge_item",
            object_id: "ro-hidden",
            indexed_at: "2026-06-03T00:00:00.000Z",
            source_updated_at: "2026-06-12T00:00:00.000Z",
            source_connection_ids_json: [],
            missing_chunk_count: null,
          },
        ] as Row[],
        rowCount: 3,
      };
    }

    if (/FROM retrieval_objects ro/.test(norm) && /JOIN retrieval_chunks rc/.test(norm) && /embedding IS NULL/.test(norm)) {
      return {
        rows: [
          {
            object_type: "knowledge_item",
            object_id: "ro-readable",
            indexed_at: "2026-06-01T00:00:00.000Z",
            source_updated_at: null,
            source_connection_ids_json: [],
            missing_chunk_count: 3,
          },
          {
            object_type: "knowledge_item",
            object_id: "ro-hidden",
            indexed_at: "2026-06-03T00:00:00.000Z",
            source_updated_at: null,
            source_connection_ids_json: [],
            missing_chunk_count: 5,
          },
        ] as Row[],
        rowCount: 2,
      };
    }

    // loadSourcePolicySnapshots: src-1 denies the member viewer.
    if (/FROM source_connections/.test(norm) && /id = ANY/.test(norm)) {
      return {
        rows: [
          {
            id: "src-1",
            owner_user_id: "owner-2",
            consent_json: {
              schema_version: 1,
              owner_user_id: "owner-2",
              allowed_reader_user_ids: [],
              allowed_agent_ids: [],
              allow_space_admins: false,
              allow_local_provider_egress: true,
              allow_external_model_egress: false,
            },
            policy_json: { schema_version: 1, source_egress_class: "local_provider_allowed" },
          },
        ] as Row[],
        rowCount: 1,
      };
    }

    if (/^SELECT role FROM space_memberships/.test(norm)) {
      return { rows: [{ role: "member" }] as Row[], rowCount: 1 };
    }

    // loadSourceWarningDetails
    if (/FROM source_connections/.test(norm) && /status = 'active'/.test(norm)) {
      return {
        rows: [
          {
            id: "src-warn",
            name: "Restricted Notion",
            owner_user_id: "user-1",
            status: "active",
            consent_json: { schema_version: 1, allow_external_model_egress: false, allowed_reader_user_ids: ["user-1"] },
            policy_json: { source_egress_class: "internal_only", derived_write_policy: "disabled" },
          },
        ] as Row[],
        rowCount: 1,
      };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe("ContextOpsService.getDrilldown", () => {
  it("lists only readable, source-allowed objects for index freshness", async () => {
    const db = new DrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "index_freshness",
      limit: 25,
      registry: fakeKnowledgeRegistry(),
      includeAllSources: false,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    expect(result.section).toBe("index_freshness");
    expect(result.objects.map((o) => o.object_id)).toEqual(["ro-readable"]);
    expect(result.objects[0]).toMatchObject({ title: "Title ro-readable", source_updated_at: "2026-06-10T00:00:00.000Z" });
    // The hidden and source-restricted objects never reach the response payload.
    expect(JSON.stringify(result)).not.toContain("ro-hidden");
    expect(JSON.stringify(result)).not.toContain("ro-restricted");
  });

  it("derives source warning labels and scopes by owner when not admin", async () => {
    const db = new DrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "source_warnings",
      limit: 25,
      registry: fakeKnowledgeRegistry(),
      includeAllSources: false,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    expect(result.section).toBe("source_warnings");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ source_connection_id: "src-warn", name: "Restricted Notion" });
    expect(result.sources[0].warnings).toEqual(
      expect.arrayContaining(["external_egress_disabled", "derived_writes_disabled"]),
    );
    const warningQuery = db.queries.find((q) => /status = 'active'/.test(q.sql.replace(/\s+/g, " ")));
    // includeAllSources=false is passed as the scoping flag.
    expect(warningQuery?.params).toEqual(expect.arrayContaining([false, "user-1"]));
  });

  it("lists readable objects awaiting embeddings with missing chunk counts", async () => {
    const db = new DrilldownFakeDb();
    const result = await new ContextOpsService(db).getDrilldown({
      spaceId: "space-1",
      userId: "user-1",
      section: "embedding_backlog",
      limit: 25,
      registry: fakeKnowledgeRegistry(),
      includeAllSources: false,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    expect(result.section).toBe("embedding_backlog");
    expect(result.objects).toEqual([
      expect.objectContaining({
        object_id: "ro-readable",
        title: "Title ro-readable",
        missing_chunk_count: 3,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("ro-hidden");
  });
});
