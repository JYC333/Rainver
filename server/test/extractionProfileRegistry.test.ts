import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ExtractionProfileRegistry,
  createDefaultExtractionProfileRegistry,
} from "../src/modules/extractionProfiles/registry";

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

  it("resolves every profile referenced by the project-source binding fixture", () => {
    const fixture = readFileSync(
      resolve(process.cwd(), "test/academicPaperMaterializerDb.test.ts"),
      "utf8",
    );
    const referencedKeys = [...fixture.matchAll(/seedBinding\("([^"]+)"\)/g)]
      .map((match) => match[1])
      .filter((key): key is string => Boolean(key));
    expect(referencedKeys.length).toBeGreaterThan(0);

    const registry = createDefaultExtractionProfileRegistry();
    for (const key of referencedKeys) {
      expect(
        registry.get(key),
        `unregistered fixture extraction profile: ${key}`,
      ).not.toBeNull();
    }
  });

  it("keeps concrete profile knowledge out of project routing", () => {
    const routingSource = readFileSync(
      resolve(
        process.cwd(),
        "src/modules/projects/projectSourceRoutingService.ts",
      ),
      "utf8",
    );
    expect(routingSource).not.toContain("../academic/");
    expect(routingSource).not.toContain("academic_paper_v1");
  });
});
