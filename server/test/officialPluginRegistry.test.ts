import { describe, expect, it } from "vitest";
import { BUILT_IN_PLUGINS } from "../src/modules/plugins/builtInPlugins.js";
import { getOfficialPlugin, listOfficialPlugins } from "../src/modules/plugins/registry.js";

describe("official plugin registry", () => {
  it("does not expose the retired research atlas plugin", () => {
    expect(getOfficialPlugin("research_atlas")).toBeUndefined();
    expect(listOfficialPlugins().some((descriptor) => descriptor.id === "research_atlas")).toBe(false);
    expect(BUILT_IN_PLUGINS.some((plugin) => plugin.id === "research_atlas")).toBe(false);
  });
});
