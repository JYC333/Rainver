import { describe, expect, it, vi } from "vitest";
import {
  ExtractionProfileRegistry,
  createDefaultExtractionProfileRegistry,
} from "../src/modules/extractionProfiles/registry.js";

describe("ExtractionProfileRegistry", () => {
  it("registers the academic module profile with its entity type", () => {
    const registry = createDefaultExtractionProfileRegistry();
    expect(registry.registeredKeys()).toEqual(new Set(["academic_paper_v1", "generic_document_v1"]));
    expect(registry.get("academic_paper_v1")?.entityType).toBe(
      "academic_paper",
    );
    expect(registry.defaultKey()).toBe("generic_document_v1");
    expect(registry.get("academic_paper_v1")?.graphLensId).toBe("academic_citation_v1");
    expect(registry.get("generic_document_v1")?.graphLensId).toBeUndefined();
  });

  it("dispatches materialization through the registered entry", async () => {
    const materializer = vi.fn(async () => ({
      objectId: "object-1",
      created: true,
    }));
    const registry = new ExtractionProfileRegistry();
    registry.register({
      key: "test_document_v1",
      displayName: "Test document",
      entityType: "document",
      materializer,
    });

    const db = {} as never;
    await expect(
      registry.materialize("test_document_v1", db, {
        spaceId: "space-1",
        projectId: "project-1",
        sourceItemId: "item-1",
      }),
    ).resolves.toEqual({ objectId: "object-1", created: true });
    expect(materializer).toHaveBeenCalledWith(db, {
      spaceId: "space-1",
      projectId: "project-1",
      sourceItemId: "item-1",
    });
    await expect(
      registry.materialize("test_document_v1", db, {
        spaceId: "space-1",
        projectId: "",
        sourceItemId: "item-1",
      }),
    ).rejects.toThrow("requires projectId");
    expect(materializer).toHaveBeenCalledTimes(1);
  });
});
