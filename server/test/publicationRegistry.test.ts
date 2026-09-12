import { describe, expect, it } from "vitest";
import { MemoryApplyError } from "../src/modules/memory/memoryApplyRepository.js";
import { contentResourceDefinitions } from "../src/modules/access/contentAccessRegistry.js";
import { PUBLICATION_ADAPTERS, publicationAdapter } from "../src/modules/publications/publicationRegistry.js";

function memorySnapshot(memoryType = "semantic") {
  return {
    schema_version: 1,
    resource_type: "memory",
    title: "A note",
    payload: {
      memory_type: memoryType,
      content: "Imported text",
      title: "A note",
      namespace: "user.default",
      confidence: 0.8,
      importance: 0.4,
      tags: ["keep"],
      memory_layer: "semantic",
      event_time: null,
      event_type: null,
      source_trust: "agent_inferred",
    },
  };
}

describe("publication adapter registry", () => {
  it("has exactly one adapter for every publishable content type", () => {
    const publishable = contentResourceDefinitions()
      .filter((definition) => definition.publishable)
      .map((definition) => definition.resourceType)
      .sort();
    const adapted = PUBLICATION_ADAPTERS.map((adapter) => adapter.resourceType).sort();

    expect(adapted).toEqual(publishable);
    expect(new Set(adapted).size).toBe(adapted.length);
  });

  it("fails closed for unregistered content types", () => {
    expect(publicationAdapter("run")).toBeNull();
    expect(publicationAdapter("agent")).toBeNull();
    expect(publicationAdapter("unknown")).toBeNull();
  });

  it("imports memory through the apply repository with importer provenance", async () => {
    const adapter = publicationAdapter("memory");
    expect(adapter).not.toBeNull();
    const inserts: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      async query(sql: string, params: readonly unknown[] = []) {
        inserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    const result = await adapter!.importSnapshot(
      db,
      { targetSpaceId: "space-2", ownerUserId: "user-2" },
      memorySnapshot(),
    );

    expect(result.resource_type).toBe("memory");
    const memoryInsert = inserts.find((call) => call.sql.includes("INSERT INTO memory_entries"));
    const provenanceInsert = inserts.find((call) => call.sql.includes("INSERT INTO provenance_links"));
    expect(memoryInsert).toBeTruthy();
    expect(provenanceInsert).toBeTruthy();
    expect(memoryInsert!.params).toContain("user-2");
    expect(memoryInsert!.params).not.toContain("publication_import");
    expect(JSON.stringify(provenanceInsert!.params)).toContain("user_confirmation");
    expect(JSON.stringify(provenanceInsert!.params)).toContain("publication_import");
  });

  it("keeps the publisher's trust instead of upgrading it to the importer's confirmation", async () => {
    const inserts: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      async query(sql: string, params: readonly unknown[] = []) {
        inserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    await publicationAdapter("memory")!.importSnapshot(
      db,
      { targetSpaceId: "space-2", ownerUserId: "user-2" },
      memorySnapshot(),
    );
    const memoryInsert = inserts.find((call) => call.sql.includes("INSERT INTO memory_entries"));
    expect(memoryInsert!.params).toContain("agent_inferred");
    expect(memoryInsert!.params).not.toContain("user_confirmed");
  });

  it("refuses to import agent-scope memory from a publication snapshot", async () => {
    const adapter = publicationAdapter("memory");
    await expect(
      adapter!.importSnapshot(
        { query: async () => ({ rows: [], rowCount: 0 }) },
        { targetSpaceId: "space-2", ownerUserId: "user-2" },
        memorySnapshot("persona"),
      ),
    ).rejects.toBeInstanceOf(MemoryApplyError);
  });
});
