import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const installerPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../ops/scripts/host/install-host.sh",
);

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`installer exited with code ${code ?? "unknown"}: ${stderr}`));
    });
  });
}

describe("host release installer", () => {
  it.runIf(process.platform === "linux")("does not download release archives when the selected channel build is already active", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-installer-test-"));
    const installRoot = join(root, "install");
    const binDir = join(root, "bin");
    const systemdDir = join(root, "systemd");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const fakeBin = join(root, "fake-bin");
    const systemctlLog = join(root, "systemctl.log");
    const buildId = "0123456789abcdef0123456789abcdef01234567";

    try {
      await Promise.all([
        mkdir(join(installRoot, "current", "app", "dist"), { recursive: true }),
        mkdir(binDir, { recursive: true }),
        mkdir(systemdDir, { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);

      const installer = await readFile(installerPath);
      const buildIdFile = `${buildId}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), installer, { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(
        join(releaseDir, "SHA256SUMS"),
        `${createHash("sha256").update(buildIdFile).digest("hex")}  BUILD_ID\n`
          + `${createHash("sha256").update(installer).digest("hex")}  install-host.sh\n`,
      );

      await writeFile(join(installRoot, "current", "BUILD_ID"), buildIdFile);
      await writeFile(join(installRoot, "current", "app", "dist", "cli.js"), "// installed\n");
      await writeFile(join(installRoot, "channel"), "stable\n");
      await writeFile(join(binDir, "rainver-host"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(installRoot, "rainver-host-daemon"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(systemdDir, "rainver-host.service"), "[Service]\n");
      await writeFile(
        join(fakeBin, "systemctl"),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RAINVER_TEST_SYSTEMCTL_LOG\"\n",
        { mode: 0o755 },
      );
      await chmod(join(fakeBin, "systemctl"), 0o755);

      // There are intentionally no daemon, Node, or adapter archives in the
      // fake release. Success proves the metadata match returned before any
      // of those assets was requested. Timer toggles must still take effect.
      const result = await runCommand("/bin/bash", [installerPath, "--update", "--auto-update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: binDir,
        RAINVER_HOST_SYSTEMD_DIR: systemdDir,
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
        RAINVER_TEST_SYSTEMCTL_LOG: systemctlLog,
      });

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Checking Rainver Host stable release metadata...");
      expect(result.stdout).toContain(`Rainver Host stable (${buildId}) is already up to date.`);
      expect(result.stdout).toContain("No runtime or release archives were downloaded.");
      expect(await readFile(join(systemdDir, "rainver-host-update.timer"), "utf8")).toContain("OnUnitActiveSec=6h");
      expect(await readFile(systemctlLog, "utf8")).toContain("enable --now rainver-host-update.timer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("reuses the shared Node runtime on update instead of downloading it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-node-reuse-test-"));
    const installRoot = join(root, "install");
    const binDir = join(root, "bin");
    const systemdDir = join(root, "systemd");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "fake-bin");
    const buildId = "00112233445566778899aabbccddeeff00112233";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";

    try {
      const hostPayload = join(packageDir, "rainver-host");
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      const sharedNodeDir = join(installRoot, "runtime", "node-v24-shared");
      await Promise.all([
        mkdir(join(hostPayload, "app", "dist"), { recursive: true }),
        mkdir(adapterPayload, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(join(sharedNodeDir, "bin"), { recursive: true }),
      ]);
      // The machine's own Node is a 25: present, but not what Rainver Host
      // runs on. The shared runtime a previous install downloaded is a 24.
      await writeFile(
        join(fakeBin, "node"),
        '#!/bin/sh\ncase "$1" in --version) echo v25.2.1 ;; -p) echo 25 ;; *) exit 1 ;; esac\n',
        { mode: 0o755 },
      );
      await writeFile(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(process.execPath, join(sharedNodeDir, "bin", "node"));
      await symlink("node-v24-shared", join(installRoot, "runtime", "node-current"));

      const installer = await readFile(installerPath);
      const buildIdFile = `${buildId}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), installer, { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "app", "package.json"), '{"type":"module"}\n');
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'console.log("0.1.0")\n');
      await writeFile(join(hostPayload, "app", "dist", "daemon.js"), "\n");
      await writeFile(join(adapterPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      // Deliberately no Node archive in the release: a download attempt fails the install.
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      const result = await runCommand("/bin/bash", [installerPath, "--update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: binDir,
        RAINVER_HOST_SYSTEMD_DIR: systemdDir,
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      });

      expect(result.stdout).toContain("System Node.js v25.2.1 is not usable (Rainver Host needs 24.x); reusing the shared runtime v24.");
      expect(result.stdout).not.toContain("Downloading shared Node.js runtime");
      expect(result.stdout).toContain(`Downloading Rainver Host stable for linux-${releaseArch}...`);
      expect(await readFile(join(installRoot, "current", "BUILD_ID"), "utf8")).toBe(buildIdFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("loads the captured CLI PATH through the generated daemon launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-path-test-"));
    const installRoot = join(root, "install");
    const binDir = join(root, "bin");
    const systemdDir = join(root, "systemd");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "captured-bin");
    const xdgConfig = join(root, "xdg-config");
    const daemonEnvironment = join(root, "daemon-environment");
    const buildId = "fedcba9876543210fedcba9876543210fedcba98";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";

    try {
      const hostPayload = join(packageDir, "rainver-host");
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      await Promise.all([
        mkdir(join(hostPayload, "app", "dist"), { recursive: true }),
        mkdir(adapterPayload, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);
      const installer = await readFile(installerPath);
      const buildIdFile = `${buildId}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), installer, { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "app", "package.json"), '{"type":"module"}\n');
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'console.log("0.1.0")\n');
      await writeFile(
        join(hostPayload, "app", "dist", "daemon.js"),
        'import { writeFileSync } from "node:fs"; writeFileSync(process.env.RAINVER_TEST_OUTPUT, process.env.PATH ?? "")\n',
      );
      await writeFile(join(adapterPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await writeFile(
        join(fakeBin, "systemctl"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );

      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      const result = await runCommand("/bin/bash", [installerPath], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: xdgConfig,
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: binDir,
        RAINVER_HOST_SYSTEMD_DIR: systemdDir,
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      });

      expect(result.stdout).toContain("Checking Rainver Host stable release metadata...");
      expect(result.stdout).toContain(`Downloading Rainver Host stable for linux-${releaseArch}...`);

      const unit = await readFile(join(systemdDir, "rainver-host.service"), "utf8");
      expect(unit).not.toContain("EnvironmentFile=");
      await runCommand(join(installRoot, "rainver-host-daemon"), [], {
        PATH: "/usr/bin:/bin",
        RAINVER_TEST_OUTPUT: daemonEnvironment,
      });
      expect((await readFile(daemonEnvironment, "utf8")).split(delimiter)[0]).toBe(fakeBin);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
