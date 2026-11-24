import type { HostCommandFrame, HostServerFrameOf } from "@rainver/protocol";
import { runJournaledHostCommand, resetHostCommandJournalForTest } from "../src/hostCommandJournal.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/acpProbe.js", () => ({ probeAcpHealth: vi.fn() }));

import { probeAcpHealth } from "../src/acpProbe.js";
import { confirmedManagedInstall, installTool, managedToolHome, managedVersionsFor, platformKey, readToolManifestSync, toolsDir } from "../src/tools.js";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-tool-health-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

async function seedHealthyVersion(version: string): Promise<void> {
  const directory = join(toolsDir(), "opencode", version);
  const home = join(configDir, "managed-state", "opencode", "home");
  await mkdir(directory, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    runtime_key: "opencode",
    version,
    health_check_protocol: "acp",
    command: "/bin/false",
    args: ["acp"],
    env: {},
    home,
    login_command: null,
    login: null,
    installed_at: "2026-09-01T00:00:00.000Z",
  }));
}

function stubBinaryDownload() {
  return {
    guard: { pin: async () => [{ address: "93.184.216.34", family: 4 as const }] },
    fetch: async () => new Response("staged runtime binary"),
  };
}

describe("managed runtime health-gated activation", () => {
  it("leaves the current healthy copy untouched when ACP initialize fails", async () => {
    await seedHealthyVersion("1.0.0");
    const download = stubBinaryDownload();
    vi.mocked(probeAcpHealth).mockResolvedValue(false);

    await expect(installTool({
      request_id: "install-bad",
      runtime_key: "opencode",
      version: "2.0.0",
      distribution: { kind: "binary", platforms: {
        [platformKey()]: {
          archive: "https://downloads.example.test/opencode",
          cmd: "bin",
          args: ["acp"],
          sha256: null,
          env: {},
        },
      } },
      login: null,
      health_check_protocol: "acp",
    }, () => {}, download)).rejects.toThrow(/ACP initialize health check/);

    expect(probeAcpHealth).toHaveBeenCalledWith(
      expect.any(String),
      ["acp"],
      expect.objectContaining({ HOME: managedToolHome("opencode") }),
      expect.stringContaining("2.0.0.installing"),
    );
    expect(managedVersionsFor("opencode").map((manifest) => manifest.version)).toEqual(["1.0.0"]);
    expect(readToolManifestSync("opencode", "managed:1.0.0")?.health_check_protocol).toBe("acp");
    await expect(readFile(join(toolsDir(), "opencode", "2.0.0", "manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the health protocol on a verified copy before making it available", async () => {
    const download = stubBinaryDownload();
    vi.mocked(probeAcpHealth).mockResolvedValue(true);

    const frame: HostServerFrameOf<"install_tool"> = {
      type: "install_tool",
      request_id: "install-good",
      runtime_key: "opencode",
      version: "2.0.0",
      distribution: { kind: "binary", platforms: {
        [platformKey()]: {
          archive: "https://downloads.example.test/opencode",
          cmd: "bin",
          args: ["acp"],
          sha256: null,
          env: {},
        },
      } },
      login: null,
      health_check_protocol: "acp",
    };
    const envelope: HostCommandFrame = {
      type: "host_command", request_id: frame.request_id, command_id: "install-command",
      fingerprint: "a".repeat(64), command: frame,
    };
    const install = vi.fn(async () => installTool(frame, () => {}, download, envelope.command_id));
    // Promote the version, then lose the result before the journal can save it.
    void runJournaledHostCommand(envelope, install, { send: vi.fn() });
    await vi.waitFor(() => expect(readToolManifestSync("opencode", "managed:2.0.0")).not.toBeNull());
    const installed = await install.mock.results[0]!.value;
    await expect(confirmedManagedInstall(frame, "different-command")).resolves.toBe(false);
    vi.mocked(probeAcpHealth).mockResolvedValue(false);
    await expect(confirmedManagedInstall(frame, envelope.command_id)).resolves.toBe(false);
    vi.mocked(probeAcpHealth).mockResolvedValue(true);
    resetHostCommandJournalForTest();
    const recovered = await runJournaledHostCommand(envelope, install, { send: vi.fn() });
    expect(recovered).toMatchObject({ outcome: "completed", replayed: true, result: { ok: true, installation: "managed:2.0.0" } });
    expect(install).toHaveBeenCalledTimes(1);
    expect(installed.health_check_protocol).toBe("acp");
    expect(readToolManifestSync("opencode", "managed:2.0.0")?.health_check_protocol).toBe("acp");
  });
});
