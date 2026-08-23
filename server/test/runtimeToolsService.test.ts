import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  npmInstallEnv,
  RuntimeToolError,
  RuntimeToolRegistry,
  type RuntimeToolInstallRunner,
} from "../src/modules/runtimeTools";

const tmpPaths: string[] = [];

afterEach(async () => {
  for (const path of tmpPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function tempConfig() {
  const root = await mkdtemp(join(tmpdir(), "aspace-runtime-tools-"));
  tmpPaths.push(root);
  return loadConfig({
    AGENT_SPACE_HOME: root,
    RUNTIME_TOOLS_ROOT: join(root, "runtime-tools"),
  });
}

class FakeInstaller implements RuntimeToolInstallRunner {
  calls: Array<{ package_ref: string; prefix: string; cache_dir: string }> = [];

  async run(input: { package_ref: string; prefix: string; cache_dir: string }): Promise<void> {
    this.calls.push(input);
    const isClaudeVendor = input.package_ref.startsWith("@anthropic-ai/claude-code@");
    const isClaudeAcp = input.package_ref.startsWith("@agentclientprotocol/claude-agent-acp@");
    const packageDir = isClaudeVendor
      ? join(input.prefix, "node_modules", "@anthropic-ai", "claude-code")
      : isClaudeAcp
        ? join(input.prefix, "node_modules", "@agentclientprotocol", "claude-agent-acp")
        : join(input.prefix, "node_modules", "@agentclientprotocol", "codex-acp");
    const binName = isClaudeVendor ? "claude" : isClaudeAcp ? "claude-agent-acp" : "codex-acp";
    await mkdir(packageDir, { recursive: true });
    if (!isClaudeVendor && !isClaudeAcp) {
      // codex-acp's own package.json declares no optionalDependencies — the
      // platform-specific native package is declared on its nested,
      // transitively-installed @openai/codex dependency instead.
      const nestedCodexDir = join(input.prefix, "node_modules", "@openai", "codex");
      await mkdir(nestedCodexDir, { recursive: true });
      await writeFile(join(nestedCodexDir, "package.json"), JSON.stringify({
        version: "1.2.3",
        optionalDependencies: {
          "@openai/codex-linux-x64": "npm:@openai/codex@1.2.3-linux-x64",
        },
      }));
      await mkdir(join(input.prefix, "node_modules", "@openai", "codex-linux-x64"), { recursive: true });
    } else if (isClaudeVendor) {
      const nativeDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-code-linux-x64");
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(nativeDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
      await writeFile(join(nativeDir, "claude"), "x".repeat(5000));
      await chmod(join(nativeDir, "claude"), 0o755);
      await mkdir(join(packageDir, "bin"), { recursive: true });
      await writeFile(join(packageDir, "bin", "claude.exe"), "x".repeat(5000));
      await chmod(join(packageDir, "bin", "claude.exe"), 0o755);
    } else if (isClaudeAcp) {
      const sdkDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
      await mkdir(sdkDir, { recursive: true });
      await writeFile(join(sdkDir, "package.json"), JSON.stringify({
        version: "0.3.232",
        optionalDependencies: {
          "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.232",
        },
      }));
      await mkdir(join(input.prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64"), { recursive: true });
    }
    await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify(isClaudeVendor
      ? {
          version: "1.2.3",
          optionalDependencies: {
            "@anthropic-ai/claude-code-linux-x64": "1.2.3",
          },
        }
      : { version: "1.2.3" }));
    const bin = join(input.prefix, "node_modules", ".bin", binName);
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    if (!isClaudeVendor && !isClaudeAcp) {
      const vendorBin = join(input.prefix, "node_modules", ".bin", "codex");
      await writeFile(vendorBin, "#!/bin/sh\nexit 0\n");
      await chmod(vendorBin, 0o755);
    }
  }
}

class MissingClaudeNativeInstaller implements RuntimeToolInstallRunner {
  calls: Array<{ package_ref: string; prefix: string; cache_dir: string }> = [];

  async run(input: { package_ref: string; prefix: string; cache_dir: string }): Promise<void> {
    this.calls.push(input);
    if (input.package_ref.startsWith("@anthropic-ai/claude-code-linux-x64@")) {
      const nativeDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-code-linux-x64");
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(nativeDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
      await writeFile(join(nativeDir, "claude"), "x".repeat(5000));
      await chmod(join(nativeDir, "claude"), 0o755);
      return;
    }

    if (input.package_ref.startsWith("@agentclientprotocol/claude-agent-acp@")) {
      const packageDir = join(input.prefix, "node_modules", "@agentclientprotocol", "claude-agent-acp");
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
      const sdkDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
      await mkdir(sdkDir, { recursive: true });
      await writeFile(join(sdkDir, "package.json"), JSON.stringify({
        version: "0.3.232",
        optionalDependencies: {
          "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.232",
        },
      }));
      await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
      const bin = join(input.prefix, "node_modules", ".bin", "claude-agent-acp");
      await writeFile(bin, "#!/bin/sh\nexit 0\n");
      await chmod(bin, 0o755);
      return;
    }

    if (input.package_ref.startsWith("@anthropic-ai/claude-agent-sdk-linux-x64@")) {
      const nativeDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(nativeDir, "package.json"), JSON.stringify({ version: "0.3.232" }));
      return;
    }

    const packageDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      version: "1.2.3",
      optionalDependencies: {
        "@anthropic-ai/claude-code-linux-x64": "1.2.3",
      },
    }));
    await writeFile(join(packageDir, "install.cjs"), [
      "const { chmodSync, copyFileSync } = require('fs');",
      "const { join } = require('path');",
      "const src = join(__dirname, '..', 'claude-code-linux-x64', 'claude');",
      "const dest = join(__dirname, 'bin', 'claude.exe');",
      "copyFileSync(src, dest);",
      "chmodSync(dest, 0o755);",
      "",
    ].join("\n"));
    await writeFile(join(packageDir, "bin", "claude.exe"), "stub");
    await chmod(join(packageDir, "bin", "claude.exe"), 0o755);
    const bin = join(input.prefix, "node_modules", ".bin", "claude");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
  }
}

class MissingCodexOptionalInstaller implements RuntimeToolInstallRunner {
  calls: Array<{ package_ref: string; prefix: string; cache_dir: string }> = [];

  async run(input: { package_ref: string; prefix: string; cache_dir: string }): Promise<void> {
    this.calls.push(input);
    if (input.package_ref.startsWith("@openai/codex-linux-x64@")) {
      const nativeDir = join(input.prefix, "node_modules", "@openai", "codex-linux-x64");
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(nativeDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
      return;
    }

    const packageDir = join(input.prefix, "node_modules", "@agentclientprotocol", "codex-acp");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    // codex-acp's own package.json declares no optionalDependencies — the
    // native package spec lives on this nested @openai/codex dependency,
    // installed but (in this fixture) without its own optional platform
    // package present yet, exercising ensureNativeOptionalPackage's fallback.
    const nestedCodexDir = join(input.prefix, "node_modules", "@openai", "codex");
    await mkdir(nestedCodexDir, { recursive: true });
    await writeFile(join(nestedCodexDir, "package.json"), JSON.stringify({
      version: "1.2.3",
      optionalDependencies: {
        "@openai/codex-linux-x64": "npm:@openai/codex@1.2.3-linux-x64",
      },
    }));
    await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
    const bin = join(input.prefix, "node_modules", ".bin", "codex-acp");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    // codex-acp bundles a working vendor `codex` binary alongside its own —
    // login and the quota probe resolve this sibling, not codex-acp itself.
    const vendorBin = join(input.prefix, "node_modules", ".bin", "codex");
    await writeFile(vendorBin, "#!/bin/sh\nexit 0\n");
    await chmod(vendorBin, 0o755);
  }
}

class MissingOpenCodeBinaryInstaller implements RuntimeToolInstallRunner {
  calls: Array<{
    package_ref: string;
    prefix: string;
    cache_dir: string;
    ignore_scripts?: boolean;
  }> = [];

  async run(input: {
    package_ref: string;
    prefix: string;
    cache_dir: string;
    ignore_scripts?: boolean;
  }): Promise<void> {
    this.calls.push(input);
    const nativeMatch = input.package_ref.match(/^(opencode-linux-x64(?:-baseline)?)@/);
    if (nativeMatch) {
      const nativeDir = join(input.prefix, "node_modules", nativeMatch[1]);
      await mkdir(join(nativeDir, "bin"), { recursive: true });
      await writeFile(join(nativeDir, "bin", "opencode"), "x".repeat(5000));
      await chmod(join(nativeDir, "bin", "opencode"), 0o755);
      return;
    }

    const packageDir = join(input.prefix, "node_modules", "opencode-ai");
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      version: "1.2.3",
      optionalDependencies: {
        "opencode-linux-x64": "1.2.3",
        "opencode-linux-x64-baseline": "1.2.3",
        "opencode-linux-x64-musl": "1.2.3",
        "opencode-linux-x64-baseline-musl": "1.2.3",
      },
    }));
    const bin = join(input.prefix, "node_modules", ".bin", "opencode");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
  }
}

describe("RuntimeToolRegistry", () => {
  it("passes npm network proxy config without leaking unrelated secrets", () => {
    expect(npmInstallEnv({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.local:8080",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_FETCH_RETRIES: "7",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
    })).toEqual({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.local:8080",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_FETCH_RETRIES: "7",
    });
  });

  it("installs an allowlisted npm CLI into the instance runtime-tools root and resolves active executable", async () => {
    const cfg = await tempConfig();
    const installer = new FakeInstaller();
    const registry = new RuntimeToolRegistry(cfg, installer);

    const result = await registry.install("claude_code", { version: "latest" });
    expect(result).toMatchObject({
      runtime: "claude_code",
      installed: true,
      installed_version: "1.2.3",
      activated: true,
      active_version: "1.2.3",
    });
    expect(installer.calls.map((call) => call.package_ref)).toEqual([
      "@agentclientprotocol/claude-agent-acp@latest",
      "@anthropic-ai/claude-code@latest",
    ]);
    expect(installer.calls[0].cache_dir).toBe(join(cfg.agentSpaceHome, "cache", "npm"));

    const resolved = await registry.resolveForExecution("claude_code");
    expect(resolved).toMatchObject({
      runtime: "claude_code",
      executable_path: join(
        cfg.cliToolsRoot,
        "claude_code",
        "versions",
        "1.2.3",
        "node_modules",
        ".bin",
        "claude-agent-acp",
      ),
      version: "1.2.3",
      source: "npm",
    });
  });

  it("resolves the codex-acp adapter and the bundled vendor codex CLI as two distinct, correctly-scoped executables (ACP runtime replatform P3)", async () => {
    const cfg = await tempConfig();
    const registry = new RuntimeToolRegistry(cfg, new FakeInstaller());

    await registry.install("codex_cli", { version: "latest" });

    const adapter = await registry.resolveForExecution("codex_cli");
    expect(adapter.executable_path).toBe(join(
      cfg.cliToolsRoot, "codex_cli", "versions", "1.2.3", "node_modules", ".bin", "codex-acp",
    ));

    // Conversation execution resolves the adapter above; the CLI device-auth
    // login flow and the TUI quota probe both need this sibling instead —
    // they speak the vendor CLI's own protocol directly, not ACP.
    const vendor = await registry.resolveVendorCliForExecution("codex_cli");
    expect(vendor.executable_path).toBe(join(
      cfg.cliToolsRoot, "codex_cli", "versions", "1.2.3", "node_modules", ".bin", "codex",
    ));
    expect(vendor.executable_path).not.toBe(adapter.executable_path);
  });

  it("resolves Claude's ACP adapter separately from its vendor CLI login binary", async () => {
    const registry = new RuntimeToolRegistry(await tempConfig(), new FakeInstaller());
    await registry.install("claude_code", { version: "latest" });
    const vendor = await registry.resolveVendorCliForExecution("claude_code");
    expect(vendor.executable_path).toContain(join("claude_code", "versions", "1.2.3", "node_modules", ".bin", "claude"));
    expect(vendor.executable_path).not.toContain("claude-agent-acp");
  });

  it("rejects a vendor CLI executable for a runtime that has no such split", async () => {
    const registry = new RuntimeToolRegistry(await tempConfig(), new MissingOpenCodeBinaryInstaller());
    await registry.install("opencode", { version: "latest" });
    await expect(registry.resolveVendorCliForExecution("opencode")).rejects.toMatchObject({
      code: "runtime_tool_vendor_cli_not_applicable",
    });
  });

  it("rejects non-allowlisted runtimes and invalid version refs", async () => {
    const registry = new RuntimeToolRegistry(await tempConfig(), new FakeInstaller());
    await expect(registry.install("random_cli", { version: "latest" })).rejects.toBeInstanceOf(
      RuntimeToolError,
    );
    await expect(registry.install("codex_cli", { version: "../../../bad" })).rejects.toMatchObject({
      code: "invalid_runtime_tool_version",
    });
  });

  it("does not resolve an active symlink outside the managed versions root", async () => {
    const cfg = await tempConfig();
    const runtimeRoot = join(cfg.cliToolsRoot, "claude_code");
    await mkdir(runtimeRoot, { recursive: true });
    await symlink("../../escape", join(runtimeRoot, "active"));

    const status = await new RuntimeToolRegistry(cfg, new FakeInstaller()).status("claude_code");
    expect(status.installed).toBe(false);
    expect(status.active_version).toBeNull();
    expect(status.executable_path).toBeNull();
    expect(status.warnings).toContain("active symlink target is invalid");
  });

  it("marks codex_cli unavailable when the native optional package is missing", async () => {
    const cfg = await tempConfig();
    const versionRoot = join(cfg.cliToolsRoot, "codex_cli", "versions", "1.2.3");
    const packageDir = join(versionRoot, "node_modules", "@agentclientprotocol", "codex-acp");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(versionRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const bin = join(versionRoot, "node_modules", ".bin", "codex-acp");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    await symlink("versions/1.2.3", join(cfg.cliToolsRoot, "codex_cli", "active"));

    const status = await new RuntimeToolRegistry(cfg, new FakeInstaller()).status("codex_cli");
    expect(status.installed).toBe(false);
    expect(status.executable_exists).toBe(false);
    expect(status.warnings).toContain("@openai/codex-linux-x64 is missing; reinstall the Codex CLI runtime tool.");
  });

  it("marks claude_code unavailable when the native package or placed binary is missing", async () => {
    const cfg = await tempConfig();
    const versionRoot = join(cfg.cliToolsRoot, "claude_code", "versions", "1.2.3");
    const packageDir = join(versionRoot, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await mkdir(join(versionRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(join(packageDir, "bin", "claude.exe"), "stub");
    await chmod(join(packageDir, "bin", "claude.exe"), 0o755);
    const bin = join(versionRoot, "node_modules", ".bin", "claude");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    const acpPackageDir = join(versionRoot, "node_modules", "@agentclientprotocol", "claude-agent-acp");
    await mkdir(acpPackageDir, { recursive: true });
    await writeFile(join(acpPackageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const acpBin = join(versionRoot, "node_modules", ".bin", "claude-agent-acp");
    await writeFile(acpBin, "#!/bin/sh\nexit 0\n");
    await chmod(acpBin, 0o755);
    await symlink("versions/1.2.3", join(cfg.cliToolsRoot, "claude_code", "active"));

    const status = await new RuntimeToolRegistry(cfg, new FakeInstaller()).status("claude_code");
    expect(status.installed).toBe(false);
    expect(status.executable_exists).toBe(false);
    expect(status.warnings).toContain("@anthropic-ai/claude-code-linux-x64 is missing; reinstall the Claude Code runtime tool.");
    expect(status.warnings).toContain("@anthropic-ai/claude-agent-sdk-linux-x64 is missing; reinstall the Claude Code runtime tool.");
    expect(status.warnings).toContain("Claude native binary is missing; reinstall the Claude Code runtime tool.");
  });

  it("repairs a codex install by explicitly installing the missing native optional package", async () => {
    const cfg = await tempConfig();
    const installer = new MissingCodexOptionalInstaller();
    const registry = new RuntimeToolRegistry(cfg, installer);

    const result = await registry.install("codex_cli", { version: "latest" });

    expect(installer.calls.map(c => c.package_ref)).toEqual([
      "@agentclientprotocol/codex-acp@latest",
      "@openai/codex-linux-x64@npm:@openai/codex@1.2.3-linux-x64",
    ]);
    expect(result).toMatchObject({
      runtime: "codex_cli",
      installed: true,
      installed_version: "1.2.3",
      activated: true,
    });
  });

  it("installs OpenCode with a libc-compatible binary without running its package postinstall", async () => {
    const cfg = await tempConfig();
    const installer = new MissingOpenCodeBinaryInstaller();
    const result = await new RuntimeToolRegistry(cfg, installer).install("opencode", {
      version: "latest",
    });

    expect(installer.calls[0]).toMatchObject({
      package_ref: "opencode-ai@latest",
      ignore_scripts: true,
    });
    expect(installer.calls.slice(1).every(call => !call.package_ref.includes("musl"))).toBe(true);
    expect(result).toMatchObject({
      runtime: "opencode",
      installed: true,
      installed_version: "1.2.3",
      activated: true,
    });
  });

  it("repairs a claude install by installing the missing native package and running postinstall", async () => {
    const cfg = await tempConfig();
    const installer = new MissingClaudeNativeInstaller();
    const registry = new RuntimeToolRegistry(cfg, installer);

    const result = await registry.install("claude_code", { version: "latest" });

    expect(installer.calls.map(c => c.package_ref)).toEqual([
      "@agentclientprotocol/claude-agent-acp@latest",
      "@anthropic-ai/claude-code@latest",
      "@anthropic-ai/claude-code-linux-x64@1.2.3",
      "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.232",
    ]);
    expect(result).toMatchObject({
      runtime: "claude_code",
      installed: true,
      installed_version: "1.2.3",
      activated: true,
    });
  });

  it("replaces an existing broken same-version claude install without force", async () => {
    const cfg = await tempConfig();
    const versionRoot = join(cfg.cliToolsRoot, "claude_code", "versions", "1.2.3");
    const packageDir = join(versionRoot, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await mkdir(join(versionRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(join(packageDir, "bin", "claude.exe"), "stub");
    await chmod(join(packageDir, "bin", "claude.exe"), 0o755);
    const bin = join(versionRoot, "node_modules", ".bin", "claude");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);

    const installer = new MissingClaudeNativeInstaller();
    const result = await new RuntimeToolRegistry(cfg, installer).install("claude_code", {
      version: "latest",
    });

    expect(installer.calls.map(c => c.package_ref)).toEqual([
      "@agentclientprotocol/claude-agent-acp@latest",
      "@anthropic-ai/claude-code@latest",
      "@anthropic-ai/claude-code-linux-x64@1.2.3",
      "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.232",
    ]);
    expect(result).toMatchObject({
      runtime: "claude_code",
      installed: true,
      installed_version: "1.2.3",
    });
  });
});
