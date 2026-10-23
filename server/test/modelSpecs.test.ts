import { describe, expect, it } from "vitest";
import { modelSpec, registeredModelSpecs } from "../src/modules/providers/modelSpecs.js";
import { resolveModelWindow } from "../src/modules/usage/modelCatalog.js";
import { recommendedMaxOutputTokens } from "../src/modules/providers/modelOutputLimits.js";

// One registry backs both the completion cap and the context window. A model
// registered on one side only is planned against the generic 16k fallback.
// Do not register output guidance without a window.

describe("modelSpecs", () => {
  it("registers MiniMax M3 with its published window in every common spelling", () => {
    for (const id of ["MiniMax-M3", "minimax-m3", "minimax/MiniMax-M3"]) {
      expect(modelSpec(id)?.contextWindowTokens).toBe(512_000);
    }
  });

  it("covers the MiniMax M2 family, including the speed variants", () => {
    for (const id of ["MiniMax-M2", "MiniMax-M2.5", "MiniMax-M2.7-highspeed"]) {
      expect(modelSpec(id)?.contextWindowTokens).toBe(204_800);
    }
  });

  it("keeps a reserve that leaves usable window on every registered model", () => {
    for (const id of ["MiniMax-M3", "MiniMax-M2.7", "claude-opus-5", "claude-haiku-4-5", "gpt-4o"]) {
      const spec = resolveModelWindow(id);
      const available = spec.contextWindowTokens - spec.defaultOutputReserveTokens - spec.providerOverheadTokens;
      expect(available, `${id} has no usable window`).toBeGreaterThan(64_000);
    }
  });

  it("returns null for unregistered models so the catalog fallback applies", () => {
    expect(modelSpec("some-local-model")).toBeNull();
    expect(modelSpec("")).toBeNull();
    expect(resolveModelWindow("some-local-model").contextWindowTokens).toBe(16_384);
  });
});

describe("registry consumers stay in sync", () => {
  it("gives every model with output guidance a window that fits it", () => {
    for (const id of ["MiniMax-M3", "MiniMax-M2.7", "claude-opus-5", "gpt-4o"]) {
      const recommended = recommendedMaxOutputTokens(id);
      if (recommended === null) continue;
      expect(resolveModelWindow(id).contextWindowTokens).toBeGreaterThan(recommended);
    }
  });
});

// Vendor windows change as models ship. A figure with no source and no date is
// unre-checkable, so provenance is part of the row rather than tribal memory.
describe("model spec provenance", () => {
  it("carries a source and a verification date on every row", () => {
    for (const spec of registeredModelSpecs()) {
      expect(spec.source, `missing source: ${JSON.stringify(spec)}`).toMatch(/^https?:\/\//);
      expect(spec.verifiedOn, `missing verifiedOn: ${spec.source}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(spec.verifiedOn))).toBe(false);
      expect(Date.parse(spec.verifiedOn), `${spec.source} is dated in the future`)
        .toBeLessThanOrEqual(Date.now());
    }
  });
});
