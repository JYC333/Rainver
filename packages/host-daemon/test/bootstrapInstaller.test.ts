import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bootstrap = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../ops/scripts/host/bootstrap-host.sh",
);

function runBootstrap(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("/bin/bash", [bootstrap, ...args], { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolveRun();
      else reject(new Error(`bootstrap exited with code ${code ?? "unknown"}`));
    });
  });
}

describe("host installer bootstrap", () => {
  it.runIf(process.platform === "linux")("selects, verifies, and invokes the requested channel installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-bootstrap-test-"));
    const releaseDir = join(root, "host-edge");
    const invocation = join(root, "invocation");
    const installer = "#!/usr/bin/env bash\nprintf '%s\\n%s' \"$*\" \"$RAINVER_HOST_RELEASE_BASE_URL\" > \"$RAINVER_TEST_INVOCATION\"\n";
    try {
      await mkdir(releaseDir);
      await writeFile(join(releaseDir, "install-host.sh"), installer);
      const hash = createHash("sha256").update(installer).digest("hex");
      await writeFile(join(releaseDir, "SHA256SUMS"), `${hash}  install-host.sh\n`);

      await runBootstrap(["--channel", "edge", "--auto-update"], {
        ...process.env,
        RAINVER_HOST_RELEASE_DOWNLOAD_ROOT: `file://${root}`,
        RAINVER_TEST_INVOCATION: invocation,
      });

      expect(await readFile(invocation, "utf8")).toBe(
        `--channel edge --auto-update\nfile://${root}/host-edge`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
