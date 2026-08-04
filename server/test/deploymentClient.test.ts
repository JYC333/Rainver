import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_DEPLOYER_JOB_TYPES, DeployerSocketClient } from "../src/modules/deployment";

const repoRoot = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("DeployerSocketClient", () => {
  it("limits submitted deployer jobs to the allowlist", async () => {
    expect([...ALLOWED_DEPLOYER_JOB_TYPES].sort()).toEqual([
      "health_check",
      "rebuild_agent_space",
      "restart_agent_space",
    ]);
    const client = new DeployerSocketClient({ deployerSocketPath: "/tmp/missing-deployer.sock" });
    await expect(client.submit("self_evolution_apply" as string)).resolves.toMatchObject({
      status: "failed",
      error: "Unknown deployer job_type: self_evolution_apply",
    });
  });

  it("keeps the privileged deployer limited to its three operator scripts", () => {
    const protocol = readFileSync(join(repoRoot, "deployer", "protocol.py"), "utf8");
    const deployer = readFileSync(join(repoRoot, "deployer", "deployer.py"), "utf8");
    expect(
      readdirSync(join(repoRoot, "deployer", "scripts"))
        .filter((name) => name.endsWith(".sh"))
        .sort(),
    ).toEqual(["health_check.sh", "rebuild.sh", "restart.sh"]);
    expect(protocol).not.toContain("code_patch");
    expect(deployer).not.toContain("code_patch");
    const allowedReferences = new Set([
      join(repoRoot, "server", "src", "modules", "deployment", "client.ts"),
      join(repoRoot, "server", "src", "modules", "deployment", "index.ts"),
    ]);
    const unexpectedCallers = sourceFiles(join(repoRoot, "server", "src"))
      .filter((path) => !allowedReferences.has(path))
      .filter((path) => readFileSync(path, "utf8").includes("DeployerSocketClient"));
    expect(unexpectedCallers).toEqual([]);
  });

  it("fails closed when the configured socket is absent", async () => {
    const client = new DeployerSocketClient({ deployerSocketPath: "/tmp/missing-deployer.sock" });
    await expect(client.submit("health_check")).resolves.toMatchObject({
      status: "failed",
      job_id: null,
    });
  });
});
