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
