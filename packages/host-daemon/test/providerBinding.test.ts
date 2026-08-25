import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterAmbientEnv, materializeProviderBinding, sweepOrphanedProfiles } from "../src/providerBinding.js";
import type { ProviderBindingFrame } from "../src/execution.js";

// This machine is a trusted host: its own login state sits in its environment
// and on its disk, right next to the run. These are the assertions that keep
// it out of a run the control plane bound to a specific backend.
//
// The daemon knows nothing about what a Codex or OpenCode config looks like —
// it writes the bytes the server generated. Those shapes are asserted on the
// server side, against the same builders the server-host path uses.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-space-binding-"));
  dirs.push(dir);
  return dir;
}

function frame(overrides: Partial<ProviderBindingFrame> = {}): ProviderBindingFrame {
  return {
    profile_key: "claude_code/provider-1",
    env: { ANTHROPIC_BASE_URL: "http://control-plane.local:8021/anthropic/lease-1", ANTHROPIC_AUTH_TOKEN: "lease-token" },
    profile_env: { HOME: ".", CLAUDE_CONFIG_DIR: ".claude" },
    files: [],
    ...overrides,
  };
}

describe("ambient environment for a bound run", () => {
  it("admits only what a runtime needs from the machine, and nothing that picks a backend", () => {
    const filtered = filterAmbientEnv({
      PATH: "/usr/bin",
      LC_ALL: "C",
      HOME: "/home/someone",
      ANTHROPIC_API_KEY: "sk-machine",
      // The three a denylist of vendor prefixes would have missed:
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-this-machine",
      XDG_DATA_HOME: "/home/someone/.local/share",
      NODE_OPTIONS: "--require /home/someone/inject.js",
      HTTPS_PROXY: "http://corporate-mitm:3128",
      CODEX_HOME: "/home/someone/.codex",
    });

    expect(filtered).toEqual({ PATH: "/usr/bin", LC_ALL: "C" });
  });

  it("matches Windows' own casing, which an exact allowlist would strip", () => {
    // Windows reports `Path`, not `PATH`. Stripping it would leave a bound run
    // unable to spawn at all, and the key must survive as the OS spells it.
    const filtered = filterAmbientEnv({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: "C:\\Users\\someone",
      ANTHROPIC_API_KEY: "sk-machine",
    });
    expect(filtered).toEqual({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
  });
});

describe("materializing a provider binding", () => {
  it("writes the server's files and reports the profile paths as environment", async () => {
    const root = join(await tempDir(), "profile");
    const env = await materializeProviderBinding(
      frame({
        profile_env: { HOME: ".", CODEX_HOME: ".codex" },
        files: [
          { relative_path: ".codex/config.toml", contents: 'model = "MiniMax-M2"\n' },
          { relative_path: ".codex/model-catalogs/agent-space-provider.json", contents: '{"models":[]}' },
        ],
      }),
      root,
    );

    expect(env.HOME).toBe(root);
    expect(env.CODEX_HOME).toBe(join(root, ".codex"));
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("lease-token");
    await expect(readFile(join(root, ".codex", "config.toml"), "utf8")).resolves.toContain("MiniMax-M2");
    // Nested paths are created, not assumed.
    await expect(readFile(join(root, ".codex", "model-catalogs", "agent-space-provider.json"), "utf8")).resolves.toBe('{"models":[]}');
  });

  it("escapes a substituted profile path for the file it lands in", async () => {
    const root = join(await tempDir(), "profile");
    // A Windows profile root inside a TOML basic string would otherwise be
    // read as escape sequences and the config would not parse.
    await materializeProviderBinding(
      frame({
        files: [
          { relative_path: "config.toml", contents: 'catalog = "{{AGENT_SPACE_RUN_PROFILE}}/x.json"', escape: "toml_basic_string" },
          { relative_path: "plain.txt", contents: "{{AGENT_SPACE_RUN_PROFILE}}/x.json" },
        ],
      }),
      root,
    );
    const toml = await readFile(join(root, "config.toml"), "utf8");
    expect(toml).toBe(`catalog = ${JSON.stringify(`${root}/x.json`)}`);
    // Without an `escape`, the raw path is written as-is.
    await expect(readFile(join(root, "plain.txt"), "utf8")).resolves.toBe(`${root}/x.json`);
  });

  it("refuses a file path that would escape the run profile", async () => {
    const dir = await tempDir();
    const root = join(dir, "profile");
    // The daemon runs unsandboxed on a machine the user owns, so a traversing
    // path from the control plane would write anywhere on it.
    for (const relative of ["../escaped.txt", "/etc/passwd", ".codex/../../escaped.txt"]) {
      await expect(
        materializeProviderBinding(frame({ files: [{ relative_path: relative, contents: "x" }] }), root),
      ).rejects.toThrow();
      await expect(stat(join(dir, "escaped.txt"))).rejects.toThrow();
    }
  });

  it("keeps what the runtime wrote last turn and refreshes only the server's files", async () => {
    const root = join(await tempDir(), "profile");
    await materializeProviderBinding(
      frame({ files: [{ relative_path: "config.toml", contents: "token = \"lease-1\"" }] }),
      root,
    );
    // Stands in for a Claude Code session transcript: written by the runtime,
    // not by the binding, and the thing the next turn resumes from. Wiping the
    // profile between runs is what made every turn after the first fail with
    // the runtime reporting no such conversation.
    await writeFile(join(root, "session.jsonl"), "turn one");

    await materializeProviderBinding(
      frame({ files: [{ relative_path: "config.toml", contents: "token = \"lease-2\"" }] }),
      root,
    );

    await expect(readFile(join(root, "session.jsonl"), "utf8")).resolves.toBe("turn one");
    // The lease differs per run, so the config the server sends is rewritten.
    await expect(readFile(join(root, "config.toml"), "utf8")).resolves.toContain("lease-2");
  });

  it("fails rather than running with a half-written profile", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "blocker"), "not a directory");
    // No profile at all would mean the machine's own login by another name.
    await expect(
      materializeProviderBinding(frame(), join(dir, "blocker", "profile")),
    ).rejects.toThrow();
  });
});

describe("sweeping per-run profiles left by an older daemon", () => {
  it("removes an orphaned profile but leaves an active run's alone", async () => {
    const runsRoot = await tempDir();
    for (const runId of ["dead-run", "live-run"]) {
      await materializeProviderBinding(
        frame({ files: [{ relative_path: "config.toml", contents: "token" }] }),
        join(runsRoot, runId, "profile"),
      );
    }

    // A daemon killed mid-run leaves a live lease token on disk; nothing else
    // ever removes it, since the same run id never comes back.
    expect(await sweepOrphanedProfiles(runsRoot, new Set(["live-run"]))).toBe(1);
    await expect(stat(join(runsRoot, "dead-run", "profile"))).rejects.toThrow();
    await expect(stat(join(runsRoot, "live-run", "profile"))).resolves.toBeDefined();
  });

  it("is silent when there is nothing to sweep", async () => {
    await expect(sweepOrphanedProfiles(join(await tempDir(), "missing"), new Set())).resolves.toBe(0);
  });
});
