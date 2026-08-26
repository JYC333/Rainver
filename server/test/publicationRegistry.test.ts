import { describe, expect, it } from "vitest";
import { contentResourceDefinitions } from "../src/modules/access/contentAccessRegistry.js";
import { PUBLICATION_ADAPTERS, publicationAdapter } from "../src/modules/publications/publicationRegistry.js";

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
});
