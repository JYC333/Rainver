import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePackagedAdapter, resolvePackagedAdapter } from "../src/adapterInstallation.js";

describe("on-demand ACP adapter installation", () => {
  it.runIf(process.platform === "linux")("installs a missing adapter through the installed host updater", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-adapter-test-"));
    const adapterRoot = join(root, "adapters", "current");
    const packageRoot = join(adapterRoot, "node_modules", "@agentclientprotocol", "codex-acp");
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "install-host.sh"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RAINVER_TEST_PACKAGE_ROOT/dist"
printf '{"name":"rainver-host-adapters","private":true}' > "$RAINVER_HOST_ADAPTER_ROOT/package.json"
printf '{"name":"@agentclientprotocol/codex-acp","type":"module"}' > "$RAINVER_TEST_PACKAGE_ROOT/package.json"
printf 'export {};' > "$RAINVER_TEST_PACKAGE_ROOT/dist/index.js"
`);
      const env = {
        ...process.env,
        RAINVER_HOST_INSTALL_ROOT: root,
        RAINVER_HOST_ADAPTER_ROOT: adapterRoot,
        RAINVER_TEST_PACKAGE_ROOT: packageRoot,
      };
      expect(resolvePackagedAdapter("codex-acp", env)).toBeNull();
      expect(await ensurePackagedAdapter("codex-acp", env)).toBe(true);
      expect(resolvePackagedAdapter("codex-acp", env)).toBe(join(packageRoot, "dist", "index.js"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
