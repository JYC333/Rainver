import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { probeAcpIdentity } from "../src/acpProbe.js";
import { manageCli } from "../src/managedCli.js";

vi.mock("../src/adapterInstallation.js", () => ({
  ensurePackagedAdapter: async () => true,
  resolvePackagedAdapter: () => "/adapter.js",
}));
vi.mock("../src/acpProbe.js", () => ({ probeAcpIdentity: vi.fn() }));

it.each([
  ["codex_cli", "CODEX_HOME", "CODEX_PATH"],
  ["claude_code", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EXECUTABLE"],
] as const)("creates the isolated config directory before verifying %s", async (runtime, configKey, executableKey) => {
  const root = await mkdtemp(join(tmpdir(), "rainver-managed-cli-test-"));
  const existing = process.env.RAINVER_HOST_CONFIG_DIR;
  process.env.RAINVER_HOST_CONFIG_DIR = root;
  try {
    const tree = join(root, "tools", runtime, "2.0.0");
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, "manifest.json"), JSON.stringify({
      runtime_key: runtime, version: "2.0.0", runtime_version: "2.0.0",
      command: "/adapter.js", args: [], env: { [executableKey]: "/current" },
      home: join(root, "managed-home"), login: null, installed_at: new Date().toISOString(),
      previous_cli: { executable: "/previous", version: "1.0.0" },
    }));
    vi.mocked(probeAcpIdentity).mockImplementationOnce(async (_command, _args, env, cwd) => {
      expect(env[configKey]).toBe(join(cwd, runtime === "codex_cli" ? ".codex" : ".claude"));
      expect((await stat(env[configKey]!)).isDirectory()).toBe(true);
      return { version: null };
    });
    await expect(manageCli({ type: "managed_cli", request_id: "verify", runtime_key: runtime,
      operation: { action: "rollback" } }, () => {})).resolves.toMatchObject({ to_version: "1.0.0" });
  } finally {
    if (existing === undefined) delete process.env.RAINVER_HOST_CONFIG_DIR;
    else process.env.RAINVER_HOST_CONFIG_DIR = existing;
    await rm(root, { recursive: true, force: true });
  }
});
