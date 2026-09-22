import { describe, expect, it } from "vitest";
import { SERVER_OPENCODE_RELEASE } from "../src/modules/runtimeAdapters/opencodeRelease.js";
import { acpRuntimeProbe } from "../src/modules/hosts/runtimeProbes.js";

describe("release-owned Server OpenCode artifact", () => {
  it("pins verified Linux artifacts and starts the ACP entrypoint", () => {
    const { distribution } = SERVER_OPENCODE_RELEASE;
    if (distribution.kind !== "binary") throw new Error("Server OpenCode release must remain a binary distribution");
    expect(SERVER_OPENCODE_RELEASE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(distribution.platforms).sort())
      .toEqual(["linux-aarch64", "linux-x86_64"]);
    for (const [platform, artifact] of Object.entries(distribution.platforms)) {
      expect(artifact.archive).toContain(`/v${SERVER_OPENCODE_RELEASE.version}/`);
      expect(artifact.archive).toContain(`opencode-${platform === "linux-aarch64" ? "linux-arm64" : "linux-x64"}.tar.gz`);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.args).toEqual(["acp"]);
    }
  });

  // One resolution, host-kind aware: whoever asks what OpenCode copy a machine
  // installs gets the answer from the probe, not from a second branch at the
  // route that installs it.
  it("answers the Server Host with the release pin and a paired Host with the registry", () => {
    expect(acpRuntimeProbe("opencode", "server")).toMatchObject({
      runtime_key: "opencode",
      version: SERVER_OPENCODE_RELEASE.version,
      distribution: SERVER_OPENCODE_RELEASE.distribution,
    });

    // The registry entry is resolved by the acpAgents refresh loop, which has
    // not run here: a paired Host is told there is nothing to install rather
    // than being handed the Server's pin.
    const remote = acpRuntimeProbe("opencode", "remote");
    expect(remote).toMatchObject({ runtime_key: "opencode" });
    expect(remote?.distribution).toBeNull();
    expect(remote?.version).toBeNull();
    expect(acpRuntimeProbe("opencode")).toEqual(remote);
  });
});
