import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveStoredArtifactPath } from "../src/modules/sources/customSources/artifactStoragePath.js";

describe("resolveStoredArtifactPath", () => {
  const root = "/tmp/rainver/storage/artifacts";

  it("resolves a relative path inside the artifact root", () => {
    expect(resolveStoredArtifactPath(root, "handlers/a.js")).toBe(resolve(root, "handlers/a.js"));
  });

  it("refuses absolute paths, NUL bytes, and parent escapes", () => {
    expect(resolveStoredArtifactPath(root, "/etc/passwd")).toBeNull();
    expect(resolveStoredArtifactPath(root, "ok\0.js")).toBeNull();
    expect(resolveStoredArtifactPath(root, "../secrets/key")).toBeNull();
  });
});
