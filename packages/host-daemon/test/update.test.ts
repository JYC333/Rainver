import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostInstallRoot, updateHost } from "../src/commands/update.js";

describe("host updater", () => {
  it("uses the installation root exported by the installed CLI launcher", () => {
    expect(hostInstallRoot({ RAINVER_HOST_INSTALL_ROOT: "/opt/rainver-host" })).toBe("/opt/rainver-host");
  });

  it("uses XDG_DATA_HOME when the launcher has no explicit root", () => {
    expect(hostInstallRoot({ XDG_DATA_HOME: "/data" })).toBe(join("/data", "rainver-host"));
  });

  it.runIf(process.platform === "linux")("passes channel and automatic-update choices to the internal updater", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-update-test-"));
    const invocation = join(root, "invocation");
    try {
      await writeFile(
        join(root, "install-host.sh"),
        `#!/usr/bin/env bash\nprintf '%s' "$*" > "$RAINVER_TEST_INVOCATION"\n`,
        { mode: 0o755 },
      );
      await updateHost(
        { channel: "edge", autoUpdate: "enable" },
        { ...process.env, RAINVER_HOST_INSTALL_ROOT: root, RAINVER_TEST_INVOCATION: invocation },
      );
      expect(await readFile(invocation, "utf8")).toBe("--update --channel edge --auto-update");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
