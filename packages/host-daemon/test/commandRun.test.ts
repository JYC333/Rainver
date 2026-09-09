import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { runHostCommand } from "../src/commandRun.js";

/**
 * `command_run` is how the Verification Engine
 * reach a host. It had no test at all in the change that introduced it, and
 * two defects survived review because of that: the launch dropped a managed
 * copy's own environment, and the strict path reused the namespace's fd-3
 * readiness handshake without giving the child an fd 3. Both are pinned below.
 */
let configDir: string;
let workspaceDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-command-config-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "rainver-command-workspace-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  await saveConfig({
    server_url: "http://127.0.0.1:1",
    host_id: "host-1",
    token: "secret-token",
    trust: "trusted",
    workspaces: { "location-1": workspaceDir },
  });
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("running a server-defined command on this host", () => {
  it("runs it in the named workspace and reports its whole result", async () => {
    await writeFile(join(workspaceDir, "report.json"), "{}");
    const result = await runHostCommand({
      request_id: "req-1",
      workspace_location_id: "location-1",
      command: ["/bin/sh", "-c", "test -e report.json && echo present"],
      timeout_seconds: 30,
    });
    expect(result).toMatchObject({ exit_code: 0, timed_out: false, error: null });
    expect(result.stdout.trim()).toBe("present");
  });

  it("refuses a workspace this daemon has no path for, rather than running somewhere else", async () => {
    const result = await runHostCommand({
      request_id: "req-2",
      workspace_location_id: "location-unknown",
      command: ["/bin/echo", "hi"],
      timeout_seconds: 30,
    });
    expect(result.exit_code).toBe(1);
    expect(result.error).toMatch(/no local path registered/);
  });

  it("refuses a request id that would place its directory outside the daemon's own", async () => {
    // The same guard the run directory has: `join` normalizes `../..` away, so
    // the escaped path looks ordinary by the time a namespace is built on it.
    const result = await runHostCommand({
      request_id: "../..",
      scratch_workspace: true,
      command: ["/bin/echo", "hi"],
      timeout_seconds: 30,
    });
    expect(result.error).toMatch(/usable directory name/);
  });

  it("refuses to run an installed copy this daemon does not have", async () => {
    const result = await runHostCommand({
      request_id: "req-5",
      scratch_workspace: true,
      adapter_type: "opencode",
      // An installation id the daemon can parse but has not installed. A bare
      // version string used to arrive here from the conformance route and fail
      // the same way, which made every C3 check fail to launch.
      installation: "managed:9.9.9",
      command: ["--version"],
      timeout_seconds: 30,
    });
    expect(result.exit_code).toBe(1);
    expect(result.error).toMatch(/does not have opencode/);
  });

  it("gives the command its own HOME rather than the workspace it runs in", async () => {
    const result = await runHostCommand({
      request_id: "req-6",
      workspace_location_id: "location-1",
      command: ["/bin/sh", "-c", "echo $HOME"],
      timeout_seconds: 30,
    });
    // A recipe that builds writes caches into HOME. Pointing it at the
    // workspace would drop them in someone's checkout.
    expect(result.stdout.trim()).toBe(join(configDir, "commands", "req-6"));
  });

  it("resolves a built-in-host Location the control plane named relative to the workspace root", async () => {
    // The built-in host never runs `workspace add`, so it has no registered
    // path for a Location the control plane created under the root both
    // containers mount. Without this a Run dispatched to a server Location
    // fails at launch with "no local path registered".
    process.env.RAINVER_HOST_WORKSPACES_ROOT = workspaceDir;
    await mkdir(join(workspaceDir, "space-1", "folder-1"), { recursive: true });
    await writeFile(join(workspaceDir, "space-1", "folder-1", "marker"), "here");
    try {
      const result = await runHostCommand({
        request_id: "req-rel",
        workspace: { kind: "location", workspace_location_id: "loc-unregistered", workspace_relative_path: "space-1/folder-1" },
        command: ["/bin/sh", "-c", "cat marker"],
        timeout_seconds: 30,
      });
      expect(result.stdout.trim()).toBe("here");
    } finally {
      delete process.env.RAINVER_HOST_WORKSPACES_ROOT;
    }
  });

  it("refuses a relative path that escapes the workspace root", async () => {
    process.env.RAINVER_HOST_WORKSPACES_ROOT = join(workspaceDir, "root");
    await mkdir(join(workspaceDir, "root"), { recursive: true });
    try {
      const result = await runHostCommand({
        request_id: "req-escape",
        workspace: { kind: "location", workspace_location_id: "loc-x", workspace_relative_path: "../outside" },
        command: ["/bin/echo", "hi"],
        timeout_seconds: 30,
      });
      // The daemon takes a name and resolves it; it does not take a path.
      expect(result.error).toMatch(/no local path registered/);
    } finally {
      delete process.env.RAINVER_HOST_WORKSPACES_ROOT;
    }
  });

  it("kills a command that outlives its budget and says so", async () => {
    const result = await runHostCommand({
      request_id: "req-7",
      workspace_location_id: "location-1",
      command: ["/bin/sh", "-c", "sleep 5"],
      timeout_seconds: 1,
    });
    expect(result.timed_out).toBe(true);
  });
});


it("refuses incomplete output rather than reporting a successful verification", async () => {
  const result = await runHostCommand({
    request_id: "large-output", workspace_location_id: "location-1",
    command: [process.execPath, "-e", 'process.stdout.write("forbidden.txt\\n" + "allowed.txt\\n".repeat(30000))'],
    timeout_seconds: 30,
  });
  expect(result).toMatchObject({ exit_code: 1, error: "command_output_limit_exceeded" });
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(262144);
});
