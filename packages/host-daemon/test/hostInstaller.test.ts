import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const installerPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../ops/scripts/host/install-host.sh",
);
const localReleaseBuilderPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../ops/scripts/host/build-local-release.sh",
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
  it.runIf(process.platform === "linux")("exposes the local release builder for development installs", async () => {
    const result = await runCommand("/bin/bash", [localReleaseBuilderPath, "--help"], process.env);

    expect(result.stdout).toContain("Build the current checkout into a local Rainver Host release directory.");
    expect(result.stdout).toContain("--install");
    expect(result.stdout).toContain("--output DIR");
  });

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
      await writeFile(join(binDir, "rainver-host"), "#!/bin/sh\necho 'Read-only parallel review: ready.'\n", { mode: 0o755 });
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
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
        XDG_CONFIG_HOME: join(root, "xdg-config"),
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
      // The installer reads service.env itself; systemd EnvironmentFile parsing can drop the captured PATH.
      expect(await readFile(join(systemdDir, "rainver-host-update.service"), "utf8")).not.toContain("EnvironmentFile=");
      expect(await readFile(systemctlLog, "utf8")).toContain("enable --now rainver-host-update.timer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("refuses an adapter request from a build that is no longer current before downloading anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-ensure-test-"));
    const installRoot = join(root, "install");
    const releaseDir = join(root, "release");
    try {
      await mkdir(join(installRoot, "current"), { recursive: true });
      await mkdir(releaseDir, { recursive: true });
      await writeFile(join(installRoot, "current", "BUILD_ID"), "newbuild\n");
      // The release is empty: any download attempt would fail with a curl error instead.
      const failure = await runCommand("/bin/bash", [installerPath, "--ensure-adapters"], {
        ...process.env,
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_ADAPTER_ROOT: join(installRoot, "adapters", "releases", "oldbuild"),
        RAINVER_HOST_CONFIG_DIR: join(root, "config"),
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      }).then(() => null, (error: Error) => error.message);
      expect(failure).toContain("This Host build (oldbuild) is not the installed current build");
      expect(existsSync(join(installRoot, "adapters"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("keeps an adapter request on the requesting build when an update switches current mid-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-ensure-pin-test-"));
    const installRoot = join(root, "install");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "fake-bin");
    const requesting = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const switched = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";
    const adapterAsset = `rainver-host-adapters-linux-${releaseArch}.tar.gz`;
    const env = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      RAINVER_HOST_INSTALL_ROOT: installRoot,
      RAINVER_HOST_ADAPTER_ROOT: join(installRoot, "adapters", "releases", requesting),
      RAINVER_HOST_CONFIG_DIR: join(root, "config"),
      RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
    };
    // The release publishes `build`'s adapter pack; fetching it switches
    // `current` to the other build when `switchOnFetch`, as a concurrent update
    // would, which also installs that build's adapter pack.
    const prepare = async (build: string, switchOnFetch: boolean) => {
      await rm(root, { recursive: true, force: true });
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      for (const id of [requesting, switched]) {
        await mkdir(join(installRoot, "releases", id), { recursive: true });
        await writeFile(join(installRoot, "releases", id, "BUILD_ID"), `${id}\n`);
      }
      await mkdir(join(installRoot, "adapters", "releases", switched), { recursive: true });
      await writeFile(join(installRoot, "adapters", "releases", switched, "BUILD_ID"), `${switched}\n`);
      await writeFile(join(installRoot, "adapters", "releases", switched, "package.json"), "{}\n");
      if (!switchOnFetch) await symlink(`releases/${switched}`, join(installRoot, "adapters", "current"));
      await symlink(`releases/${requesting}`, join(installRoot, "current"));
      await Promise.all([mkdir(adapterPayload, { recursive: true }), mkdir(releaseDir, { recursive: true }), mkdir(fakeBin, { recursive: true })]);
      await writeFile(join(adapterPayload, "BUILD_ID"), `${build}\n`);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await writeFile(join(releaseDir, "install-host.sh"), await readFile(installerPath), { mode: 0o755 });
      await runCommand("tar", ["-czf", join(releaseDir, adapterAsset), "-C", packageDir, "rainver-host-adapters"], process.env);
      const sums = await Promise.all(["install-host.sh", adapterAsset].map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
      const realCurl = (await runCommand("/bin/sh", ["-c", "command -v curl"], process.env)).stdout.trim();
      await writeFile(join(fakeBin, "curl"), [
        "#!/bin/sh",
        switchOnFetch
          ? `case "$*" in *${adapterAsset}*) ln -sfn releases/${switched} '${installRoot}/current' ;; esac`
          // An update's own adapters/current write lands inside the request's window.
          : `case "$*" in *${adapterAsset}*) ln -sfn releases/${switched} '${installRoot}/adapters/.u' && mv -Tf '${installRoot}/adapters/.u' '${installRoot}/adapters/current' ;; esac`,
        `exec '${realCurl}' "$@"`,
        "",
      ].join("\n"), { mode: 0o755 });
    };
    try {
      // The published pack is the newly switched build's: never installed for
      // the daemon that asked, which still runs the other build.
      await prepare(switched, true);
      const refused = await runCommand("/bin/bash", [installerPath, "--ensure-adapters"], env)
        .then(() => null, (error: Error) => error.message);
      expect(refused).toContain("The adapter pack does not match the active Host build");
      expect(existsSync(join(installRoot, "adapters", "current"))).toBe(false);

      // Its own build's version directory is installed without replacing or
      // pruning the pack an update installed, and without touching the
      // update-owned adapters/current that a writer is moving meanwhile.
      await prepare(requesting, false);
      const installed = await runCommand("/bin/bash", [installerPath, "--ensure-adapters"], env);
      expect(installed.stdout).toContain(`Installed Rainver Host adapters ${requesting}.`);
      expect((await readdir(join(installRoot, "adapters", "releases"))).sort()).toEqual([requesting, switched]);
      expect(await readFile(join(installRoot, "adapters", "releases", requesting, "BUILD_ID"), "utf8")).toBe(`${requesting}\n`);
      expect(await readFile(join(installRoot, "adapters", "current", "BUILD_ID"), "utf8")).toBe(`${switched}\n`);

      // Run beside a writer that keeps moving adapters/current as an update
      // does: the request still succeeds and the writer's link is what remains.
      for (let round = 0; round < 3; round += 1) {
        await prepare(requesting, false);
        const writer = runCommand("/bin/sh", ["-c", [
          "i=0; while [ $i -lt 200 ]; do",
          `ln -sfn releases/${switched} '${installRoot}/adapters/.w' && mv -Tf '${installRoot}/adapters/.w' '${installRoot}/adapters/current';`,
          "i=$((i+1)); done",
        ].join(" ")], process.env);
        const [parallel] = await Promise.all([runCommand("/bin/bash", [installerPath, "--ensure-adapters"], env), writer]);
        expect(parallel.stdout).toContain(`Installed Rainver Host adapters ${requesting}.`);
        expect(await readFile(join(installRoot, "adapters", "current", "BUILD_ID"), "utf8")).toBe(`${switched}\n`);
        expect(await readFile(join(installRoot, "adapters", "releases", requesting, "package.json"), "utf8")).toBe('{"private":true}\n');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("checks the active build under the install lock, refusing a pack whose build an update replaced while the request waited", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-host-ensure-locked-check-test-"));
    const installRoot = join(root, "install");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const requesting = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const switched = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";
    const adapterAsset = `rainver-host-adapters-linux-${releaseArch}.tar.gz`;
    const env = {
      ...process.env,
      RAINVER_HOST_INSTALL_ROOT: installRoot,
      RAINVER_HOST_ADAPTER_ROOT: join(installRoot, "adapters", "releases", requesting),
      RAINVER_HOST_CONFIG_DIR: join(root, "config"),
      RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
    };
    try {
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      for (const id of [requesting, switched]) {
        await mkdir(join(installRoot, "releases", id), { recursive: true });
        await writeFile(join(installRoot, "releases", id, "BUILD_ID"), `${id}\n`);
      }
      await symlink(`releases/${requesting}`, join(installRoot, "current"));
      await Promise.all([mkdir(adapterPayload, { recursive: true }), mkdir(releaseDir, { recursive: true })]);
      await writeFile(join(adapterPayload, "BUILD_ID"), `${requesting}\n`);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await writeFile(join(releaseDir, "install-host.sh"), await readFile(installerPath), { mode: 0o755 });
      await runCommand("tar", ["-czf", join(releaseDir, adapterAsset), "-C", packageDir, "rainver-host-adapters"], process.env);
      const sums = await Promise.all(["install-host.sh", adapterAsset].map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      // An update holds the lock; before releasing it, it switches current.
      const ready = join(root, "holder-ready");
      const holder = runCommand("flock", [join(installRoot, ".install.lock"), "/bin/sh", "-c",
        `touch "${ready}" && sleep 2 && ln -sfn releases/${switched} "${installRoot}/.c" && mv -Tf "${installRoot}/.c" "${installRoot}/current"`], process.env);
      for (let waited = 0; !existsSync(ready); waited += 20) {
        if (waited > 5_000) throw new Error("lock holder did not start");
        await new Promise(done => setTimeout(done, 20));
      }
      const refused = await runCommand("/bin/bash", [installerPath, "--ensure-adapters"], env)
        .then(() => null, (error: Error) => error.message);
      await holder;

      expect(refused).toContain("The adapter pack does not match the active Host build");
      expect(existsSync(join(installRoot, "adapters", "releases", requesting))).toBe(false);
      expect(existsSync(join(installRoot, "adapters", "current"))).toBe(false);
      expect(await readFile(join(installRoot, "current", "BUILD_ID"), "utf8")).toBe(`${switched}\n`);
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
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'if (process.argv[2] === "check-read-only" && process.env.RAINVER_TEST_PROBE_FAIL === "1") process.exit(1); console.log(process.argv[2] === "check-read-only" ? "Read-only parallel review: ready." : "0.1.0")\n');
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

      await expect(runCommand("/bin/bash", [installerPath, "--update"], {
        ...process.env,
        RAINVER_TEST_PROBE_FAIL: "1",
        PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: binDir,
        RAINVER_HOST_SYSTEMD_DIR: systemdDir,
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      })).rejects.toThrow("no new Host build was activated");
      expect(existsSync(join(installRoot, "current"))).toBe(false);
      expect(existsSync(join(systemdDir, "rainver-host.service"))).toBe(false);

      const result = await runCommand("/bin/bash", [installerPath, "--update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
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

  it.runIf(process.platform === "linux")("keeps the release a daemon still waiting to restart runs from", async () => {
    // Build A is running a long Run; update B was installed and the restart
    // into it is still waiting for the daemon to go idle. Update C then lands:
    // "keep current and previous" would be B and C, and delete A under the
    // daemon still executing from it.
    const root = await mkdtemp(join(tmpdir(), "rainver-host-retention-test-"));
    const installRoot = join(root, "install");
    const binDir = join(root, "bin");
    const systemdDir = join(root, "systemd");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "fake-bin");
    const running = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pending = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const incoming = "cccccccccccccccccccccccccccccccccccccccc";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";

    try {
      const hostPayload = join(packageDir, "rainver-host");
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      await Promise.all([
        mkdir(join(hostPayload, "app", "dist"), { recursive: true }),
        mkdir(adapterPayload, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(join(installRoot, "releases", running, "app"), { recursive: true }),
        mkdir(join(installRoot, "releases", pending, "app"), { recursive: true }),
      ]);
      await writeFile(join(installRoot, "releases", running, "BUILD_ID"), `${running}\n`);
      await writeFile(join(installRoot, "releases", pending, "BUILD_ID"), `${pending}\n`);
      await symlink(`releases/${pending}`, join(installRoot, "current"));
      await writeFile(join(configDir, "update-restart-requested"), "");
      // The service is active: every systemctl query succeeds.
      await writeFile(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(process.execPath, join(fakeBin, "node"));

      const installer = await readFile(installerPath);
      const buildIdFile = `${incoming}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), installer, { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "app", "package.json"), '{"type":"module"}\n');
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'if (process.argv[2] === "check-read-only" && process.env.RAINVER_TEST_PROBE_FAIL === "1") process.exit(1); console.log(process.argv[2] === "check-read-only" ? "Read-only parallel review: ready." : "0.1.0")\n');
      await writeFile(join(hostPayload, "app", "dist", "daemon.js"), "\n");
      await writeFile(join(adapterPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      await runCommand("/bin/bash", [installerPath, "--update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: binDir,
        RAINVER_HOST_SYSTEMD_DIR: systemdDir,
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      });

      expect(await readFile(join(installRoot, "current", "BUILD_ID"), "utf8")).toBe(buildIdFile);
      expect((await readdir(join(installRoot, "releases"))).sort()).toEqual([running, pending, incoming]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("keeps the replaced build's adapter pack that an adapter request added", async () => {
    // Build A's daemon added its adapter pack through --ensure-adapters, which
    // never names it in adapters/current (still on an older pack Z). Update C
    // must keep A's version directory for the daemon until it restarts.
    const root = await mkdtemp(join(tmpdir(), "rainver-host-adapter-retention-test-"));
    const installRoot = join(root, "install");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "fake-bin");
    const running = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const stale = "dddddddddddddddddddddddddddddddddddddddd";
    const older = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const incoming = "cccccccccccccccccccccccccccccccccccccccc";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";

    try {
      const hostPayload = join(packageDir, "rainver-host");
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      await Promise.all([
        mkdir(join(hostPayload, "app", "dist"), { recursive: true }),
        mkdir(adapterPayload, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(join(installRoot, "releases", running, "app"), { recursive: true }),
      ]);
      await writeFile(join(installRoot, "releases", running, "BUILD_ID"), `${running}\n`);
      await symlink(`releases/${running}`, join(installRoot, "current"));
      for (const id of [running, stale, older]) {
        await mkdir(join(installRoot, "adapters", "releases", id), { recursive: true });
        await writeFile(join(installRoot, "adapters", "releases", id, "BUILD_ID"), `${id}\n`);
        await writeFile(join(installRoot, "adapters", "releases", id, "package.json"), "{}\n");
      }
      await symlink(`releases/${stale}`, join(installRoot, "adapters", "current"));
      // The service is active with no restart pending; a vendor CLI is on PATH.
      await writeFile(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(process.execPath, join(fakeBin, "node"));

      const buildIdFile = `${incoming}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), await readFile(installerPath), { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "app", "package.json"), '{"type":"module"}\n');
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'console.log(process.argv[2] === "check-read-only" ? "Read-only parallel review: ready." : "0.1.0")\n');
      await writeFile(join(hostPayload, "app", "dist", "daemon.js"), "\n");
      await writeFile(join(adapterPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      await runCommand("/bin/bash", [installerPath, "--update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: join(root, "bin"),
        RAINVER_HOST_SYSTEMD_DIR: join(root, "systemd"),
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      });

      expect(await readFile(join(installRoot, "adapters", "current", "BUILD_ID"), "utf8")).toBe(buildIdFile);
      expect((await readdir(join(installRoot, "adapters", "releases"))).sort()).toEqual([running, incoming, stale]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("does not switch to a release directory an interrupted install left half-copied", async () => {
    // Moving the unpacked payload from the temporary directory to the final
    // release name is a copy when the two are on different filesystems, and a
    // copy can be interrupted. A directory that exists under the build's name
    // but is not a complete release is one such leftover: it is replaced, not
    // activated.
    const root = await mkdtemp(join(tmpdir(), "rainver-host-partial-release-test-"));
    const installRoot = join(root, "install");
    const binDir = join(root, "bin");
    const systemdDir = join(root, "systemd");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "fake-bin");
    const installed = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const incoming = "cccccccccccccccccccccccccccccccccccccccc";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";

    try {
      const hostPayload = join(packageDir, "rainver-host");
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      await Promise.all([
        mkdir(join(hostPayload, "app", "dist"), { recursive: true }),
        mkdir(adapterPayload, { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(join(installRoot, "releases", installed, "app", "dist"), { recursive: true }),
        // The leftover: the build id arrived, app/ did not.
        mkdir(join(installRoot, "releases", incoming, "app"), { recursive: true }),
      ]);
      await writeFile(join(installRoot, "releases", installed, "BUILD_ID"), `${installed}\n`);
      await writeFile(join(installRoot, "releases", installed, "app", "dist", "cli.js"), "\n");
      await writeFile(join(installRoot, "releases", incoming, "BUILD_ID"), `${incoming}\n`);
      await symlink(`releases/${installed}`, join(installRoot, "current"));
      await writeFile(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(process.execPath, join(fakeBin, "node"));

      const installer = await readFile(installerPath);
      const buildIdFile = `${incoming}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), installer, { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "app", "package.json"), '{"type":"module"}\n');
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'if (process.argv[2] === "check-read-only" && process.env.RAINVER_TEST_PROBE_FAIL === "1") process.exit(1); console.log(process.argv[2] === "check-read-only" ? "Read-only parallel review: ready." : "0.1.0")\n');
      await writeFile(join(hostPayload, "app", "dist", "daemon.js"), "\n");
      await writeFile(join(adapterPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      const result = await runCommand("/bin/bash", [installerPath, "--update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: binDir,
        RAINVER_HOST_SYSTEMD_DIR: systemdDir,
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      });

      expect(result.stderr).toBe("");
      expect(await readFile(join(installRoot, "current", "BUILD_ID"), "utf8")).toBe(buildIdFile);
      expect(await readFile(join(installRoot, "current", "app", "dist", "daemon.js"), "utf8")).toBe("\n");
      // Nothing of the staging step is left beside the releases.
      expect((await readdir(join(installRoot, "releases"))).sort()).toEqual([installed, incoming]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("loads the captured CLI PATH and install bin directory through the generated daemon launcher", async () => {
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
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'if (process.argv[2] === "check-read-only" && process.env.RAINVER_TEST_PROBE_FAIL === "1") process.exit(1); console.log(process.argv[2] === "check-read-only" ? "Read-only parallel review: ready." : "0.1.0")\n');
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
      await symlink(process.execPath, join(fakeBin, "node"));

      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

      const result = await runCommand("/bin/bash", [installerPath], {
        ...process.env,
        // Deliberately omit binDir: the installer must make the directory it
        // just installed into visible to the daemon even when shell startup
        // did not put it on PATH yet.
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath, // executable presence; the fixture CLI models the probe
        XDG_CONFIG_HOME: join(root, "xdg-config"),
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
      const cliLauncher = await readFile(join(binDir, "rainver-host"), "utf8");
      const daemonLauncher = await readFile(join(installRoot, "rainver-host-daemon"), "utf8");
      const serviceEnv = join(xdgConfig, "rainver-host", "service.env");
      expect(cliLauncher).toContain(realpathSync(process.execPath));
      expect(daemonLauncher).toContain(realpathSync(process.execPath));
      expect(cliLauncher).not.toContain(join(fakeBin, "node"));
      expect(daemonLauncher).not.toContain(join(fakeBin, "node"));
      expect((await readFile(serviceEnv, "utf8")).split("\n")[0]!.split(delimiter).slice(0, 2)).toEqual([
        `PATH="${binDir}`,
        fakeBin,
      ]);
      await runCommand(join(installRoot, "rainver-host-daemon"), [], {
        PATH: "/usr/bin:/bin",
        RAINVER_TEST_OUTPUT: daemonEnvironment,
      });
      expect((await readFile(daemonEnvironment, "utf8")).split(delimiter).slice(0, 2)).toEqual([binDir, fakeBin]);

      // A launcher produced by an update must also repair the effective PATH
      // of an existing service.env without overwriting that user-owned file.
      await writeFile(serviceEnv, `PATH="${fakeBin}"\nRAINVER_HOST_CONFIG_DIR="${configDir}"\n`);
      await runCommand(join(installRoot, "rainver-host-daemon"), [], {
        PATH: "/usr/bin:/bin",
        RAINVER_TEST_OUTPUT: daemonEnvironment,
      });
      expect((await readFile(daemonEnvironment, "utf8")).split(delimiter)).toEqual([binDir, fakeBin]);
      expect(await readFile(serviceEnv, "utf8")).toBe(`PATH="${fakeBin}"\nRAINVER_HOST_CONFIG_DIR="${configDir}"\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("serializes concurrent installs of one build and leaves another holder's staging directory alone", async () => {
    // Two updates of the same build race (a timer and a manual update) while
    // a third process holds the install lock with a staging directory of its
    // own. The installers wait for it, then place the release once: the
    // second finds it complete under the lock and keeps it as placed.
    const root = await mkdtemp(join(tmpdir(), "rainver-host-concurrent-install-test-"));
    const installRoot = join(root, "install");
    const configDir = join(root, "config");
    const releaseDir = join(root, "release");
    const packageDir = join(root, "package");
    const fakeBin = join(root, "fake-bin");
    const installed = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const incoming = "dddddddddddddddddddddddddddddddddddddddd";
    const releaseArch = process.arch === "arm64" ? "arm64" : "x64";
    const foreignStage = join(installRoot, "releases", ".stage.foreign");

    try {
      const hostPayload = join(packageDir, "rainver-host");
      const adapterPayload = join(packageDir, "rainver-host-adapters");
      await Promise.all([
        mkdir(adapterPayload, { recursive: true }),
        mkdir(join(hostPayload, "app", "dist"), { recursive: true }),
        mkdir(releaseDir, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(join(installRoot, "releases", installed, "app", "dist"), { recursive: true }),
      ]);
      await writeFile(join(installRoot, "releases", installed, "BUILD_ID"), `${installed}\n`);
      await writeFile(join(installRoot, "releases", installed, "app", "dist", "cli.js"), "\n");
      await symlink(`releases/${installed}`, join(installRoot, "current"));
      await writeFile(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(process.execPath, join(fakeBin, "node"));

      const installer = await readFile(installerPath);
      const buildIdFile = `${incoming}\n`;
      await writeFile(join(releaseDir, "install-host.sh"), installer, { mode: 0o755 });
      await writeFile(join(releaseDir, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(hostPayload, "app", "package.json"), '{"type":"module"}\n');
      await writeFile(join(hostPayload, "app", "dist", "cli.js"), 'console.log(process.argv[2] === "check-read-only" ? "Read-only parallel review: ready." : "0.1.0")\n');
      await writeFile(join(hostPayload, "app", "dist", "daemon.js"), "\n");
      await chmod(join(hostPayload, "app"), 0o750);
      // An installer that finds codex or claude on PATH also installs the adapter pack.
      await writeFile(join(adapterPayload, "BUILD_ID"), buildIdFile);
      await writeFile(join(adapterPayload, "package.json"), '{"private":true}\n');
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host"], process.env);
      await runCommand("tar", ["-czf", join(releaseDir, `rainver-host-adapters-linux-${releaseArch}.tar.gz`), "-C", packageDir, "rainver-host-adapters"], process.env);
      const assets = ["BUILD_ID", "install-host.sh", `rainver-host-linux-${releaseArch}.tar.gz`, `rainver-host-adapters-linux-${releaseArch}.tar.gz`];
      const sums = await Promise.all(assets.map(async asset => (
        `${createHash("sha256").update(await readFile(join(releaseDir, asset))).digest("hex")}  ${asset}`
      )));
      await writeFile(join(releaseDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
      const env = {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        RAINVER_HOST_UPDATE_CHANNEL: "stable",
        RAINVER_HOST_BWRAP: process.execPath,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        RAINVER_HOST_INSTALL_ROOT: installRoot,
        RAINVER_HOST_BIN_DIR: join(root, "bin"),
        RAINVER_HOST_SYSTEMD_DIR: join(root, "systemd"),
        RAINVER_HOST_CONFIG_DIR: configDir,
        RAINVER_HOST_RELEASE_BASE_URL: `file://${releaseDir}`,
      };

      // The other holder: its staging directory must survive until it is done.
      const ready = join(root, "holder-ready");
      const verdict = join(root, "holder-verdict");
      const holder = runCommand("flock", [join(installRoot, ".install.lock"), "/bin/sh", "-c",
        `mkdir -p "${foreignStage}" && touch "${foreignStage}/part" "${ready}" && sleep 2 `
          + `&& { test -f "${foreignStage}/part" && echo intact || echo removed; } > "${verdict}" && rm -rf "${foreignStage}"`], process.env);
      for (let waited = 0; !existsSync(ready); waited += 20) {
        if (waited > 5_000) throw new Error("lock holder did not start");
        await new Promise(done => setTimeout(done, 20));
      }
      const results = await Promise.all([runCommand("/bin/bash", [installerPath, "--update"], env), runCommand("/bin/bash", [installerPath, "--update"], env)]);
      await holder;

      expect(await readFile(verdict, "utf8")).toBe("intact\n");
      for (const result of results) expect(result.stderr).toBe("");
      const outputs = results.map(result => result.stdout);
      expect(outputs.filter(output => output.includes(`Installed Rainver Host build ${incoming}.`))).toHaveLength(1);
      expect(outputs.filter(output => output.includes(`(${incoming}) is already installed.`))).toHaveLength(1);
      expect(await readFile(join(installRoot, "current", "BUILD_ID"), "utf8")).toBe(buildIdFile);
      expect((await stat(join(installRoot, "releases", incoming, "app"))).mode & 0o777).toBe(0o750);
      expect((await readdir(join(installRoot, "releases"))).sort()).toEqual([installed, incoming]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
