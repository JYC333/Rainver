import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { daemonVersion } from "../src/version.js";

describe("daemonVersion", () => {
  it("uses package metadata instead of a duplicated source constant", () => {
    expect(daemonVersion()).toBe(packageMetadata.version);
  });
});
