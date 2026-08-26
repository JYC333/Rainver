import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configDir } from "./config.js";

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
export interface ToolLoginSpec {
  command: string[];
  managed_command?: string[];
  home_subdir: string;
  credential_file: string;
  hint?: string;
}

export interface ToolManifest {
  adapter_type: string;
  version: string;
  /** How to launch: the command, resolved to an absolute path where one exists. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** This installation's own HOME — its login state lives here, apart from the machine's. */
  home: string;
  /** The login command inside this tree, rendered; null when the runtime declares none. */
  login_command: string[] | null;
  login: ToolLoginSpec | null;
  installed_at: string;
}

export type ToolDistribution =
  | { kind: "npx" | "uvx"; package: string; args: string[]; env: Record<string, string> }
  | { kind: "binary"; platforms: Record<string, { archive: string; cmd: string; args: string[]; sha256: string | null; env: Record<string, string> }> };

export interface InstallToolFrame {
  request_id: string;
  adapter_type: string;
  version: string;
  distribution: ToolDistribution;
  login: ToolLoginSpec | null;
}

export interface UninstallToolFrame {
  request_id: string;
  adapter_type: string;
  version: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function toolsDir(): string {
  return join(configDir(), "tools");
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

function toolDir(adapterType: string, version: string): string {
  if (!SAFE_SEGMENT.test(adapterType) || !SAFE_SEGMENT.test(version)) throw new Error(`Unusable adapter or version: ${adapterType}@${version}`);
  return join(toolsDir(), adapterType, version);
}

function manifestPath(adapterType: string, version: string): string {
  return join(toolDir(adapterType, version), "manifest.json");
}

/** Synchronous because launch resolution is; a manifest is one small file. */
export function readToolManifestSync(adapterType: string, installation: string): ToolManifest | null {
  const version = managedVersion(installation);
  if (!version || !SAFE_SEGMENT.test(adapterType)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath(adapterType, version), "utf8")) as ToolManifest;
    return typeof manifest.command === "string" && Array.isArray(manifest.args) && typeof manifest.home === "string" ? manifest : null;
  } catch {
    return null;
  }
}

/** Every managed installation on this machine, grouped by adapter. */
export async function installedTools(): Promise<Map<string, ToolManifest[]>> {
  const result = new Map<string, ToolManifest[]>();
  let adapters: string[];
  try {
    adapters = await readdir(toolsDir());
  } catch {
    return result;
  }
  for (const adapterType of adapters) {
    let versions: string[];
    try {
      versions = await readdir(join(toolsDir(), adapterType));
    } catch {
      continue;
    }
    for (const version of versions) {
      const manifest = readToolManifestSync(adapterType, managedInstallationId(version));
      if (manifest) result.set(adapterType, [...(result.get(adapterType) ?? []), manifest]);
    }
  }
  return result;
}

/** The login command inside a managed tree, rendered from the spec's template. */
export function renderManagedLoginCommand(tree: string, login: ToolLoginSpec | null): string[] | null {
  if (!login?.managed_command) return null;
  return login.managed_command.map((part) => part
    .split("{tree}").join(tree)
    .split("{node}").join(process.execPath)
    .split("{platform}").join(platformKey())
    .split("{node_platform}").join(`${process.platform}-${process.arch}`));
}

/** Whether a login has been completed for this HOME, by the runtime's own credential file. */
export function loggedIn(home: string, login: ToolLoginSpec | null): boolean | null {
  if (!login) return null;
  return existsSync(join(home, login.home_subdir, login.credential_file));
}

function parseLogin(value: unknown): ToolLoginSpec | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record || !Array.isArray(record.command) || typeof record.home_subdir !== "string" || typeof record.credential_file !== "string") return null;
  return {
    command: record.command.map(String),
    ...(Array.isArray(record.managed_command) ? { managed_command: record.managed_command.map(String) } : {}),
    home_subdir: record.home_subdir,
    credential_file: record.credential_file,
    ...(typeof record.hint === "string" ? { hint: record.hint } : {}),
  };
}

function parseIdentity(frame: Record<string, unknown>, type: string): { request_id: string; adapter_type: string; version: string } {
  const requestId = frame.request_id;
  const adapterType = frame.adapter_type;
  const version = frame.version;
  if (typeof requestId !== "string" || typeof adapterType !== "string" || typeof version !== "string") {
    throw new Error(`${type} frame is missing request_id, adapter_type, or version`);
  }
  if (!SAFE_SEGMENT.test(adapterType) || !SAFE_SEGMENT.test(version)) throw new Error(`Unusable adapter or version: ${adapterType}@${version}`);
  return { request_id: requestId, adapter_type: adapterType, version };
}

export function parseInstallToolFrame(frame: Record<string, unknown>): InstallToolFrame {
  const identity = parseIdentity(frame, "install_tool");
  const distribution = frame.distribution as ToolDistribution | undefined;
  if (!distribution || typeof distribution !== "object" || !("kind" in distribution)) throw new Error("install_tool frame has no distribution");
  return { ...identity, distribution, login: parseLogin(frame.login) };
}

export function parseUninstallToolFrame(frame: Record<string, unknown>): UninstallToolFrame {
  return parseIdentity(frame, "uninstall_tool");
}

export async function uninstallTool(frame: UninstallToolFrame): Promise<boolean> {
  const dir = toolDir(frame.adapter_type, frame.version);
  if (!existsSync(manifestPath(frame.adapter_type, frame.version))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Installs into a staging directory and renames it into place, so a
 * half-finished install never reads as an installed tool. Re-installing an
 * existing version replaces it.
 */
export async function installTool(frame: InstallToolFrame, log: (line: string) => void): Promise<ToolManifest> {
  const finalDir = toolDir(frame.adapter_type, frame.version);
  const stagingDir = `${finalDir}.installing`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const launch = await materialize(frame.distribution, stagingDir, log);
    // Its own HOME, so this copy's login state never mixes with the machine's.
    const home = join(stagingDir, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const manifest: ToolManifest = {
      adapter_type: frame.adapter_type,
      version: frame.version,
      ...launch,
      home,
      login_command: renderManagedLoginCommand(stagingDir, frame.login),
      login: frame.login,
      installed_at: new Date().toISOString(),
    };
    await writeFile(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
    // One managed copy per adapter: a re-install at another version replaces
    // the old one rather than accumulating versions, each with a login state
    // nobody remembers. Two accounts of one agent is not what a version
    // directory is for.
    for (const sibling of await readdir(join(toolsDir(), frame.adapter_type)).catch(() => [] as string[])) {
      if (sibling !== frame.version) await rm(join(toolsDir(), frame.adapter_type, sibling), { recursive: true, force: true });
    }
    // The launch was resolved against the staging path; rewrite every
    // string of it against the final one.
    const relocate = (value: string) => value.split(stagingDir).join(finalDir);
    manifest.command = relocate(manifest.command);
    manifest.args = manifest.args.map(relocate);
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

async function materialize(
  distribution: ToolDistribution,
  dir: string,
  log: (line: string) => void,
): Promise<Pick<ToolManifest, "command" | "args" | "env">> {
  if (distribution.kind === "npx") {
    // A pinned `npm install` into this directory, not `npx`: what runs is what
    // was installed, at the version the server named, and nothing is cached
    // anywhere the machine's own npx would later pick up.
    await run("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", "--no-package-lock", distribution.package], dir, log);
    const name = packageName(distribution.package);
    const packageRoot = join(dir, "node_modules", ...name.split("/"));
    const bin = await packageBin(packageRoot);
    return { command: process.execPath, args: [bin, ...distribution.args], env: distribution.env };
  }
  if (distribution.kind === "uvx") {
    const toolBin = join(dir, "bin");
    await run("uv", ["tool", "install", distribution.package], dir, log, { UV_TOOL_DIR: join(dir, "uv"), UV_TOOL_BIN_DIR: toolBin });
    const entries = await readdir(toolBin);
    const command = entries.find((entry) => entry === packageName(distribution.package)) ?? entries[0];
    if (!command) throw new Error(`uv installed ${distribution.package} but exposed no executable`);
    return { command: join(toolBin, command), args: distribution.args, env: distribution.env };
  }
  if (distribution.kind !== "binary") throw new Error(`Unsupported distribution kind: ${String((distribution as { kind: unknown }).kind)}`);
  const key = platformKey();
  const target = distribution.platforms[key];
  if (!target) throw new Error(`No binary for this platform (${key}); available: ${Object.keys(distribution.platforms).join(", ")}`);
  const archive = join(dir, "archive");
  await download(target.archive, archive, target.sha256, log);
  await extract(archive, target.archive, dir, log);
  await rm(archive, { force: true });
  const command = resolve(dir, target.cmd);
  if (!command.startsWith(`${dir}/`) && !command.startsWith(`${dir}\\`)) throw new Error(`Binary cmd escapes the tool directory: ${target.cmd}`);
  if (!existsSync(command)) throw new Error(`Archive did not contain ${target.cmd}`);
  return { command, args: target.args, env: target.env };
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

async function download(url: string, to: string, sha256: string | null, log: (line: string) => void): Promise<void> {
  if (!url.startsWith("https://")) throw new Error(`Refusing to download over ${url.split(":")[0]}: ${url}`);
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, bytes, { mode: 0o600 });
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
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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
