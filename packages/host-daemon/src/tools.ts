import type { HostEgressTransport, HostServerFrameOf, RuntimeDistribution, RuntimeLoginSpec, RuntimeAccount } from "@rainver/protocol";
import { helperProcessEnv } from "./providerBinding.js";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, parse, resolve } from "node:path";
import { configDir } from "./config.js";
import { probeAcpHealth } from "./acpProbe.js";
import { downloadRuntimeArtifact, type RuntimeArtifactDownloadDependencies } from "./toolDownload.js";

/**
 * Agents from the ACP registry that the control plane asked this daemon to
 * install. Each lives under `<config dir>/tools/<id>/<version>/` — never on
 * PATH, never in the machine's own package managers' global trees — and is
 * launched by the absolute path its manifest records. Versions are pinned by
 * the server; the daemon reports what it has and installs what it is told.
 *
 * This is the one exception to "the daemon runs what the machine already
 * has" (ADR 0016, amended): the machine's own claude/codex/opencode logins
 * stay untouched, and a registry agent is only ever the control plane's
 * choice, at the control plane's version, in a directory it can remove.
 */

/** `managed:<version>` — an installation id, as opposed to `own`. */
export const MANAGED_PREFIX = "managed:";
export const OWN_INSTALLATION = "own";

/** How a runtime is logged into and how a login is recognised (the spec's `credentials.login`). */
/** The wire contract's login spec; the server's adapter spec is the source. */
export type ToolLoginSpec = RuntimeLoginSpec;
export interface ToolManifest {
  runtime_key: string;
  version: string;
  /** Version reported by the vendor CLI bundled inside this ACP package. */
  runtime_version: string | null;
  health_check_protocol?: "acp" | null;
  /** How to launch: the command, resolved to an absolute path where one exists. */
  command: string;
  args: string[];
  /** Args required to enter the installed CLI, before protocol/login args. */
  entry_args?: string[];
  env: Record<string, string>;
  /** Stable managed HOME for this runtime, separate from binaries and the machine's own CLI. */
  home: string;
  /** The login command inside this tree, rendered; null when the runtime declares none. */
  login_command: string[] | null;
  login: ToolLoginSpec | null;
  installed_at: string;
}

export type ToolDistribution = RuntimeDistribution;
/** The wire's `install_tool` frame, minus its type tag; nothing is rebuilt from it. */
export type InstallToolFrame = Omit<HostServerFrameOf<"install_tool">, "type">;
export type UninstallToolFrame = Omit<HostServerFrameOf<"uninstall_tool">, "type">;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function toolsDir(): string {
  return join(configDir(), "tools");
}

/** Persistent vendor-owned data for one managed runtime, outside versioned binaries. */
export function managedToolHome(runtimeKey: string): string {
  if (!SAFE_SEGMENT.test(runtimeKey)) throw new Error(`Unusable runtime key: ${runtimeKey}`);
  return join(configDir(), "managed-state", runtimeKey, "home");
}

/** `managed:<version>` → the version, or null for `own` and anything malformed. */
export function managedVersion(installation: string): string | null {
  if (!installation.startsWith(MANAGED_PREFIX)) return null;
  const version = installation.slice(MANAGED_PREFIX.length);
  return SAFE_SEGMENT.test(version) ? version : null;
}

export function managedInstallationId(version: string): string {
  return `${MANAGED_PREFIX}${version}`;
}

function toolDir(runtimeKey: string, version: string): string {
  if (!SAFE_SEGMENT.test(runtimeKey) || !SAFE_SEGMENT.test(version)) throw new Error(`Unusable runtime key or version: ${runtimeKey}@${version}`);
  return join(toolsDir(), runtimeKey, version);
}

/** The versioned executable tree for a managed installation; its stable HOME lives elsewhere. */
export function managedToolTree(runtimeKey: string, installation: string): string | null {
  const version = managedVersion(installation);
  if (!version || !SAFE_SEGMENT.test(runtimeKey)) return null;
  return toolDir(runtimeKey, version);
}

function manifestPath(runtimeKey: string, version: string): string {
  return join(toolDir(runtimeKey, version), "manifest.json");
}

/** Synchronous because launch resolution is; a manifest is one small file. */
export function readToolManifestSync(runtimeKey: string, installation: string): ToolManifest | null {
  const version = managedVersion(installation);
  if (!version || !SAFE_SEGMENT.test(runtimeKey)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath(runtimeKey, version), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    // A manifest must declare the same runtime key as the runtime-keyed path
    // it was opened under; anything else is an unreadable installation, which
    // callers treat as "no managed copy" rather than guessing at its identity.
    if (
      record.runtime_key !== runtimeKey
      || typeof record.command !== "string"
      || !Array.isArray(record.args)
      || typeof record.home !== "string"
    ) return null;
    return record as unknown as ToolManifest;
  } catch {
    return null;
  }
}

/**
 * The *current* managed copy of each runtime — one per runtime key (ADR 0016 §9).
 *
 * A version kept behind the current one is a rollback target, not a second
 * installation: reporting it would put two copies of one Agent on the host
 * card, each with its own login, which is exactly the confusion one-version
 * addresses.
 */
export async function installedTools(): Promise<Map<string, ToolManifest[]>> {
  const result = new Map<string, ToolManifest[]>();
  let runtimeKeys: string[];
  try {
    runtimeKeys = await readdir(toolsDir());
  } catch {
    return result;
  }
  for (const runtimeKey of runtimeKeys) {
    const current = managedVersionsFor(runtimeKey)[0];
    if (current) result.set(runtimeKey, [current]);
  }
  return result;
}

/** The login command inside a managed tree, rendered from the spec's template. */
/** A spec's managed command form with its placeholders filled for this tree and daemon. */
export function renderManagedCommand(tree: string, parts: string[] | undefined): string[] | null {
  if (!parts) return null;
  return parts.map((part) => part
    .split("{tree}").join(tree)
    .split("{node}").join(process.execPath)
    .split("{platform}").join(platformKey())
    .split("{node_platform}").join(`${process.platform}-${process.arch}`));
}

export function renderManagedLoginCommand(tree: string, login: ToolLoginSpec | null): string[] | null {
  return renderManagedCommand(tree, login?.managed_command);
}

/** Whether a login has been completed for this HOME, by the runtime's own credential file. */
export function loggedIn(home: string, login: ToolLoginSpec | null): boolean | null {
  if (!login) return null;
  return existsSync(join(home, login.home_subdir, login.credential_file));
}

/**
 * The accounts a multi-account CLI holds in this HOME — provider ids and
 * credential kinds only. Undefined for a CLI whose spec declares no
 * accounts format (single-account CLIs), an empty list when the file is
 * missing or unreadable. Secrets are never read past the `type` field.
 */
export function heldAccounts(home: string, login: ToolLoginSpec | null): RuntimeAccount[] | undefined {
  if (!login?.accounts_format) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(home, login.home_subdir, login.credential_file), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).flatMap(([id, value]): RuntimeAccount[] => {
      const kind = value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
        ? (value as { type: string }).type
        : "unknown";
      return id ? [{ id, kind }] : [];
    });
  } catch {
    return [];
  }
}

export async function uninstallTool(frame: UninstallToolFrame): Promise<boolean> {
  const dir = toolDir(frame.runtime_key, frame.version);
  if (!existsSync(manifestPath(frame.runtime_key, frame.version))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Every managed version of one runtime on this machine, newest install first.
 *
 * The current copy is the newest; at most one older copy is kept behind it, as
 * the one-step rollback target (ADR 0016 §9). Older than that is
 * deleted on the next install. User state is kept outside those directories.
 */
export function managedVersionsFor(runtimeKey: string): ToolManifest[] {
  if (!SAFE_SEGMENT.test(runtimeKey)) return [];
  let versions: string[];
  try {
    versions = readdirSync(join(toolsDir(), runtimeKey));
  } catch {
    return [];
  }
  return versions
    .flatMap((directory) => {
      const manifest = readToolManifestSync(runtimeKey, managedInstallationId(directory));
      // Keyed by the directory it was found in, not by what the file claims:
      // a manifest whose `version` disagrees would otherwise make a rollback
      // delete some other version's directory. `installed_at` may be missing
      // in a manifest an older release wrote, and must not throw on the
      // heartbeat path — an unknown install time sorts oldest.
      return manifest ? [{ ...manifest, version: directory, installed_at: manifest.installed_at ?? "" }] : [];
    })
    .sort((a, b) => b.installed_at.localeCompare(a.installed_at));
}

/** The version an upgrade of this runtime could be undone to, or null when there is none. */
export function rollbackTargetFor(runtimeKey: string): ToolManifest | null {
  return managedVersionsFor(runtimeKey)[1] ?? null;
}

/**
 * Undoes the last upgrade by deleting the current copy, promoting the one
 * kept behind it.
 *
 * Only binaries roll back: the latest login, native history and configuration
 * remain in the runtime's stable HOME.
 */
export async function rollbackTool(runtimeKey: string): Promise<ToolManifest | null> {
  const versions = managedVersionsFor(runtimeKey);
  const [current, previous] = versions;
  if (!current || !previous) return null;
  await rm(toolDir(runtimeKey, current.version), { recursive: true, force: true });
  return previous;
}

/**
 * Installs into a staging directory and renames it into place, so a
 * half-finished install never reads as an installed tool. Re-installing an
 * existing version replaces it.
 */
export async function installTool(
  frame: InstallToolFrame,
  log: (line: string) => void,
  downloadDependencies?: RuntimeArtifactDownloadDependencies,
): Promise<ToolManifest> {
  const finalDir = toolDir(frame.runtime_key, frame.version);
  const home = managedToolHome(frame.runtime_key);
  const stagingDir = `${finalDir}.installing`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const launch = await materialize(frame.distribution, stagingDir, log, downloadDependencies, frame.egress_transport ?? { mode: "direct" });
    // User data is outside the version directory, so replacing or pruning
    // binaries cannot remove login, native history, settings, or Skills.
    await mkdir(home, { recursive: true, mode: 0o700 });
    const runtimeVersion = await probeManagedRuntimeVersion(
      stagingDir,
      frame.runtime_version_command,
      home,
      launch.env,
    );
    if (frame.health_check_protocol === "acp") {
      const healthy = await probeAcpHealth(
        launch.command,
        [...(launch.entry_args ?? []), ...launch.args],
        { ...launch.env, ...managedHomeEnvironment(home) },
        stagingDir,
      );
      if (!healthy) throw new Error("The managed runtime failed its ACP initialize health check; the previous installation remains active.");
    }
    const manifest: ToolManifest = {
      runtime_key: frame.runtime_key,
      version: frame.version,
      runtime_version: runtimeVersion,
      health_check_protocol: frame.health_check_protocol ?? null,
      ...launch,
      home,
      login_command: renderManagedLoginCommand(stagingDir, frame.login),
      login: frame.login,
      installed_at: new Date().toISOString(),
    };
    await writeFile(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
  // One current copy per runtime key, plus exactly one kept behind it so the
    // upgrade has something to be undone to (ADR 0016 §9). User state is outside
    // this tree.
    const keep = new Set([frame.version, ...managedVersionsFor(frame.runtime_key)
      .filter((manifest) => manifest.version !== frame.version)
      .slice(0, 1)
      .map((manifest) => manifest.version)]);
    for (const sibling of await readdir(join(toolsDir(), frame.runtime_key)).catch(() => [] as string[])) {
      if (!keep.has(sibling)) await rm(join(toolsDir(), frame.runtime_key, sibling), { recursive: true, force: true });
    }
    // The launch was resolved against the staging path; rewrite every
    // string of it against the final one.
    const relocate = (value: string) => value.split(stagingDir).join(finalDir);
    manifest.command = relocate(manifest.command);
    manifest.args = manifest.args.map(relocate);
    manifest.entry_args = manifest.entry_args?.map(relocate);
    manifest.env = Object.fromEntries(Object.entries(manifest.env).map(([key, value]) => [key, relocate(value)]));
    manifest.home = relocate(manifest.home);
    manifest.login_command = manifest.login_command?.map(relocate) ?? null;
    await writeFile(join(finalDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** A version label is useful metadata, but failure to print it must not abort a valid install. */
function probeManagedRuntimeVersion(
  tree: string,
  commandTemplate: string[] | null | undefined,
  home: string,
  toolEnv: Record<string, string>,
  timeoutMs = 4_000,
): Promise<string | null> {
  const rendered = renderManagedCommand(tree, commandTemplate ?? undefined);
  if (!rendered?.[0]) return Promise.resolve(null);
  const [command, ...args] = rendered;
  return new Promise((resolvePromise) => {
    let settled = false;
    let output = "";
    const child = spawn(command, args, {
      cwd: tree,
      env: { ...helperProcessEnv(process.env), ...toolEnv, ...managedHomeEnvironment(home) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-2_000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const firstLine = output.trim().split("\n").find(Boolean)?.slice(0, 200) ?? null;
      finish(code === 0 ? firstLine : null);
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
  });
}

function managedHomeEnvironment(home: string): Record<string, string> {
  if (platform() !== "win32") return { HOME: home };
  const root = parse(home).root;
  if (root.length < 3) return { HOME: home, USERPROFILE: home };
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: root.slice(0, 2),
    HOMEPATH: home.slice(2),
  };
}

async function materialize(
  distribution: ToolDistribution,
  dir: string,
  log: (line: string) => void,
  downloadDependencies?: RuntimeArtifactDownloadDependencies,
  transport: HostEgressTransport = { mode: "direct" },
): Promise<Pick<ToolManifest, "command" | "args" | "entry_args" | "env">> {
  if (distribution.kind === "npx") {
    // A pinned `npm install` into this directory, not `npx`: what runs is what
    // was installed, at the version the server named, and nothing is cached
    // anywhere the machine's own npx would later pick up.
    await run("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", "--no-package-lock", distribution.package], dir, log);
    const name = packageName(distribution.package);
    const packageRoot = join(dir, "node_modules", ...name.split("/"));
    const bin = await packageBin(packageRoot);
    return { command: process.execPath, args: [bin, ...distribution.args], entry_args: [bin], env: distribution.env };
  }
  if (distribution.kind === "uvx") {
    const toolBin = join(dir, "bin");
    await run("uv", ["tool", "install", distribution.package], dir, log, { UV_TOOL_DIR: join(dir, "uv"), UV_TOOL_BIN_DIR: toolBin });
    const entries = await readdir(toolBin);
    const command = entries.find((entry) => entry === packageName(distribution.package)) ?? entries[0];
    if (!command) throw new Error(`uv installed ${distribution.package} but exposed no executable`);
    return { command: join(toolBin, command), args: distribution.args, entry_args: [], env: distribution.env };
  }
  if (distribution.kind !== "binary") throw new Error(`Unsupported distribution kind: ${String((distribution as { kind: unknown }).kind)}`);
  const key = platformKey();
  const target = distribution.platforms[key];
  if (!target) throw new Error(`No binary for this platform (${key}); available: ${Object.keys(distribution.platforms).join(", ")}`);
  const archive = join(dir, "archive");
  await downloadRuntimeArtifact(target.archive, archive, target.sha256, log, downloadDependencies, transport);
  await extract(archive, target.archive, dir, log);
  await rm(archive, { force: true });
  const command = resolve(dir, target.cmd);
  if (!command.startsWith(`${dir}/`) && !command.startsWith(`${dir}\\`)) throw new Error(`Binary cmd escapes the tool directory: ${target.cmd}`);
  if (!existsSync(command)) throw new Error(`Archive did not contain ${target.cmd}`);
  return { command, args: target.args, entry_args: [], env: target.env };
}

/** `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`. */
export function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

async function packageBin(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { bin?: string | Record<string, string>; name?: string };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin ? Object.values(manifest.bin)[0] : undefined;
  if (!bin) throw new Error(`${manifest.name ?? packageRoot} declares no bin entry`);
  return join(packageRoot, bin);
}

export function platformKey(): string {
  const os = platform() === "win32" ? "windows" : platform();
  const cpu = arch() === "x64" ? "x86_64" : arch() === "arm64" ? "aarch64" : arch();
  return `${os}-${cpu}`;
}

async function extract(archive: string, url: string, dir: string, log: (line: string) => void): Promise<void> {
  if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)(\?.*)?$/i.test(url)) {
    await run("tar", ["-xf", archive, "-C", dir], dir, log);
    return;
  }
  if (/\.zip(\?.*)?$/i.test(url)) {
    await run(platform() === "win32" ? "tar" : "unzip", platform() === "win32" ? ["-xf", archive, "-C", dir] : ["-q", archive, "-d", dir], dir, log);
    return;
  }
  // Not an archive: the download is the executable itself.
  await rename(archive, join(dir, "bin"));
}

function run(command: string, args: string[], cwd: string, log: (line: string) => void, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    log(`${command} ${args.join(" ")}`);
    const child = spawn(command, args, { cwd, env: { ...helperProcessEnv(process.env), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const collect = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => reject(new Error(`${command} could not be started: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}: ${tail.trim().split("\n").slice(-5).join(" | ")}`));
    });
  });
}
