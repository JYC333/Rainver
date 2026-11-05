import {
  ORDINARY_TOOL_CATALOG,
  ORDINARY_TOOL_IDS,
  ORDINARY_TOOLS_PROTOCOL,
  ordinaryToolVersion,
  type HostEgressTransport,
  type OrdinaryToolAction,
  type OrdinaryToolCatalogEntry,
  type OrdinaryToolId,
  type OrdinaryToolReport,
  type OrdinaryToolResult,
  type OrdinaryToolsHostReport,
} from "@rainver/protocol";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, normalize, resolve } from "node:path";
import { probeVersion } from "./capabilities.js";
import { configDir } from "./config.js";
import { downloadRuntimeArtifact, type RuntimeArtifactDownloadDependencies } from "./toolDownload.js";
import { extract, platformKey } from "./tools.js";

/**
 * Ordinary CLI tools on this machine (protocol `ordinaryTools.ts`).
 *
 * Everything lives under `<config dir>/ordinary-tools/`, apart from the ACP
 * `tools/` tree, so no ordinary tool is ever reported as a Runtime
 * installation or health-checked over ACP. Personal tool state (a later phase)
 * is kept outside `managed/`, so removing a managed copy or a registration can
 * never delete someone's login.
 *
 * Nothing here runs a shell or a caller-supplied command: the catalog names
 * the executable and its version argv, and a registration must resolve to that
 * executable.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_TIMEOUT_MS = 4_000;

interface Registration { path: string }
interface ManagedManifest { tool_id: OrdinaryToolId; version: string; cmd: string; installed_at: string }

export function ordinaryToolsRoot(): string {
  return join(configDir(), "ordinary-tools");
}
function managedRoot(toolId: OrdinaryToolId): string {
  return join(ordinaryToolsRoot(), "managed", toolId);
}
function managedDir(toolId: OrdinaryToolId, version: string): string {
  if (!SAFE_SEGMENT.test(version)) throw new Error("Unusable tool version");
  return join(managedRoot(toolId), version);
}
function registrationsPath(): string {
  return join(ordinaryToolsRoot(), "registrations.json");
}

async function readRegistrations(): Promise<Partial<Record<OrdinaryToolId, Registration>>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(registrationsPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Partial<Record<OrdinaryToolId, Registration>> = {};
    for (const id of ORDINARY_TOOL_IDS) {
      const entry = (parsed as Record<string, unknown>)[id];
      const path = entry && typeof entry === "object" ? (entry as { path?: unknown }).path : null;
      if (typeof path === "string" && isAbsolute(path)) result[id] = { path };
    }
    return result;
  } catch {
    return {};
  }
}

let registrationUpdates: Promise<unknown> = Promise.resolve();

/**
 * Reads the registrations, applies `mutate` and writes the result, one update
 * after another against the latest file (the same discipline as
 * `config.ts` `updateConfig`). The per-tool `busy` guard does not cover this:
 * every tool shares one file, and two tools' read-modify-write would otherwise
 * drop one registration. A failed update releases the queue for the next.
 */
function updateRegistrations(
  mutate: (current: Partial<Record<OrdinaryToolId, Registration>>) => Partial<Record<OrdinaryToolId, Registration>>,
): Promise<void> {
  const next = registrationUpdates.then(async () => {
    const updated = mutate(await readRegistrations());
    await mkdir(ordinaryToolsRoot(), { recursive: true, mode: 0o700 });
    // Unique per write, so a staged file is never another write's.
    const staged = `${registrationsPath()}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, JSON.stringify(updated, null, 2), { mode: 0o600 });
      await rename(staged, registrationsPath());
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  });
  registrationUpdates = next.catch(() => undefined);
  return next;
}

/** One version directory as a copy: a manifest naming this tool and version, with its command inside. */
async function readCopy(toolId: OrdinaryToolId, version: string, dir: string): Promise<{ manifest: ManagedManifest; command: string } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ManagedManifest;
    if (manifest.tool_id !== toolId || manifest.version !== version || typeof manifest.cmd !== "string") return null;
    const command = resolve(dir, manifest.cmd);
    if (!command.startsWith(`${dir}/`)) return null;
    return { manifest, command };
  } catch {
    return null;
  }
}

/** The current managed copy: the newest directory with a manifest naming this tool. */
async function managedCopy(toolId: OrdinaryToolId): Promise<{ manifest: ManagedManifest; command: string } | null> {
  let versions: string[];
  try {
    versions = await readdir(managedRoot(toolId));
  } catch {
    return null;
  }
  const copies: Array<{ manifest: ManagedManifest; command: string }> = [];
  for (const version of versions) {
    // Staging and set-aside directories are never a copy.
    if (!SAFE_SEGMENT.test(version) || version.endsWith(".installing") || version.endsWith(".replaced")) continue;
    const copy = await readCopy(toolId, version, managedDir(toolId, version));
    if (copy) copies.push(copy);
  }
  return copies.sort((a, b) => b.manifest.installed_at.localeCompare(a.manifest.installed_at))[0] ?? null;
}

/**
 * A copy recovery may rely on: a readable manifest, and its executable
 * actually answering the fixed version command with exactly that version.
 * Only the recovery branch pays for this probe; ordinary reports do not.
 */
async function verifiedCopy(entry: OrdinaryToolCatalogEntry, version: string, dir: string): Promise<boolean> {
  const copy = await readCopy(entry.id, version, dir);
  if (!copy || !(await isExecutableFile(copy.command))) return false;
  return ordinaryToolVersion(await probeToolVersion(entry, copy.command)) === version;
}

/**
 * Finishes what an interrupted same-version replacement left behind. Only one
 * window leaves `<version>.replaced` with no `<version>`: the daemon stopped
 * between moving the usable copy aside and promoting the new one. That copy is
 * put back when it verifies. A `.replaced` beside a `<version>` that verifies
 * is the leftover of a completed promotion and is removed. Anything else — an
 * unverifiable recovery source, or an installed copy that does not verify —
 * keeps both directories as evidence and throws; nothing is guessed at.
 *
 * Callers hold the tool's `busy` claim, or the `recovering` claim, so this
 * never races a promotion.
 */
async function recoverInterruptedReplacement(entry: OrdinaryToolCatalogEntry): Promise<void> {
  let names: string[];
  try {
    names = await readdir(managedRoot(entry.id));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".replaced")) continue;
    const version = name.slice(0, -".replaced".length);
    if (!SAFE_SEGMENT.test(version)) continue;
    const finalDir = managedDir(entry.id, version);
    const asideDir = `${finalDir}.replaced`;
    if (!existsSync(finalDir)) {
      if (!(await verifiedCopy(entry, version, asideDir))) {
        throw new Error(`An interrupted ${entry.id} ${version} replacement left a recovery directory that does not verify; it was kept for inspection.`);
      }
      await rename(asideDir, finalDir);
      continue;
    }
    if (!(await verifiedCopy(entry, version, finalDir))) {
      throw new Error(`${entry.id} ${version} has a recovery directory beside an installed copy that does not verify; both were kept for inspection.`);
    }
    await rm(asideDir, { recursive: true, force: true });
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The catalog executable on this daemon's PATH, by name only — no shell lookup. */
export async function resolveOnPath(executable: string, pathValue = process.env.PATH ?? ""): Promise<string | null> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Versions are cached by the resolved file's identity, so a heartbeat every
 * fifteen seconds spawns nothing until a binary actually changes.
 */
const versionCache = new Map<string, string | null>();
async function versionOf(entry: OrdinaryToolCatalogEntry, command: string): Promise<string | null> {
  let key: string;
  try {
    const info = await stat(await realpath(command));
    key = `${command}\0${info.ino}\0${info.size}\0${info.mtimeMs}`;
  } catch {
    return null;
  }
  if (versionCache.has(key)) return versionCache.get(key) ?? null;
  const text = await probeToolVersion(entry, command);
  versionCache.set(key, text);
  return text;
}

/**
 * The tool's version line, or null. A zero exit with nothing printed is not a
 * version: `probeVersion` answers "" for it, and a script that merely exits 0
 * must not register or show as available.
 */
async function probeToolVersion(entry: OrdinaryToolCatalogEntry, command: string): Promise<string | null> {
  const text = await probeVersion(command, VERSION_TIMEOUT_MS, { args: [...entry.version_args] });
  return text && text.trim() ? text.trim() : null;
}

/** Exported for tests. */
export function __clearOrdinaryToolVersionCache(): void {
  versionCache.clear();
}

async function reportFor(
  entry: OrdinaryToolCatalogEntry,
  registrations: Partial<Record<OrdinaryToolId, Registration>>,
  /** The caller holds the tool's claim and its operation has finished. */
  claimHolder = false,
): Promise<OrdinaryToolReport> {
  const managed = await managedCopy(entry.id);
  // A set-aside copy that could not be restored, outside an operation's own
  // promotion window.
  // Recovery removes or restores every `.replaced` it can verify, so one still
  // present outside an operation's own window is a failed recovery: the tool
  // is broken, whatever the installed manifest claims.
  const recoveryFailed = (claimHolder || !busy.has(entry.id)) && (await readdir(managedRoot(entry.id)).catch(() => [] as string[]))
    .some((name) => name.endsWith(".replaced"));
  const registration = registrations[entry.id];
  const onPath = await resolveOnPath(entry.executable);
  const recipe = entry.managed;
  const chosen: { source: "managed" | "registered" | "path"; command: string } | null = managed
    ? { source: "managed", command: managed.command }
    : registration
      ? { source: "registered", command: registration.path }
      : onPath ? { source: "path", command: onPath } : null;
  const text = chosen && await isExecutableFile(chosen.command) ? await versionOf(entry, chosen.command) : null;
  if (recoveryFailed) {
    // A set-aside copy that could not be restored is not "missing": the tool
    // is there and needs attention, and nothing else is reported in its place.
    return {
      tool_id: entry.id, status: "broken", source: "managed", version: null, version_text: null,
      managed_version: managed?.manifest.version ?? null, registered: Boolean(registration),
      managed_installable: Boolean(recipe?.platforms[platformKey()]), managed_catalog_version: recipe?.version ?? null,
    };
  }
  return {
    tool_id: entry.id,
    status: !chosen ? "missing" : text === null ? "broken" : "available",
    source: chosen?.source ?? null,
    version: ordinaryToolVersion(text),
    version_text: text,
    managed_version: managed?.manifest.version ?? null,
    registered: Boolean(registration),
    managed_installable: Boolean(recipe?.platforms[platformKey()]),
    managed_catalog_version: recipe?.version ?? null,
  };
}

export async function ordinaryToolsReport(log: (line: string) => void = () => {}): Promise<OrdinaryToolsHostReport> {
  const registrations = await readRegistrations();
  const tools: OrdinaryToolReport[] = [];
  for (const id of ORDINARY_TOOL_IDS) {
    await recoverUnlessBusy(id, log);
    tools.push(await reportFor(ORDINARY_TOOL_CATALOG[id], registrations));
  }
  return { protocol: ORDINARY_TOOLS_PROTOCOL, tools };
}

/** One operation per tool at a time on this daemon. */
const busy = new Set<OrdinaryToolId>();
/** Account commands currently running a tool's binary (`ordinaryToolAccounts.ts`). */
const inUse = new Map<OrdinaryToolId, number>();

/**
 * The executable this Host would run for the tool now — the copy the report
 * calls available, by the same precedence — or null.
 */
export async function resolveOrdinaryToolCopy(toolId: OrdinaryToolId): Promise<{ source: "managed" | "registered" | "path"; command: string } | null> {
  const entry = ORDINARY_TOOL_CATALOG[toolId];
  const registrations = await readRegistrations();
  const report = await reportFor(entry, registrations);
  if (report.status !== "available" || !report.source) return null;
  const command = report.source === "managed" ? (await managedCopy(toolId))?.command ?? null
    : report.source === "registered" ? registrations[toolId]?.path ?? null
      : await resolveOnPath(entry.executable);
  return command ? { source: report.source, command } : null;
}

/**
 * Leases the tool's current, available executable for one account command.
 * Refused while an install, registration or removal holds the tool; while a
 * lease is held, those are refused in turn, so a binary is never replaced or
 * deleted under a running login. Release exactly once.
 */
export async function leaseOrdinaryToolCommand(toolId: OrdinaryToolId): Promise<{ command: string; release: () => void }> {
  const entry = ORDINARY_TOOL_CATALOG[toolId];
  if (busy.has(toolId) || recovering.has(toolId)) throw new Error(`${entry.label} is being changed on this Host; retry in a moment.`);
  inUse.set(toolId, (inUse.get(toolId) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const count = (inUse.get(toolId) ?? 1) - 1;
    if (count > 0) inUse.set(toolId, count); else inUse.delete(toolId);
  };
  try {
    const copy = await resolveOrdinaryToolCopy(toolId);
    if (!copy) throw new Error(`${entry.label} is not available on this Host.`);
    return { command: copy.command, release };
  } catch (error) {
    release();
    throw error;
  }
}
/** A heartbeat's recovery in flight; an operation that starts meanwhile waits for it. */
const recovering = new Map<OrdinaryToolId, Promise<void>>();

/**
 * Recovery on the report path (a restart's first heartbeat included). Skipped
 * while an operation holds the tool, which recovers for itself; the check and
 * the claim happen in one tick, so an operation never overlaps it. A failure
 * is logged and shows in the report as a broken managed copy.
 */
async function recoverUnlessBusy(toolId: OrdinaryToolId, log: (line: string) => void): Promise<void> {
  if (busy.has(toolId) || recovering.has(toolId)) return;
  const running = recoverInterruptedReplacement(ORDINARY_TOOL_CATALOG[toolId]);
  recovering.set(toolId, running.catch(() => undefined));
  try {
    await running;
  } catch (error) {
    log(`ordinary tool ${toolId} recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    recovering.delete(toolId);
  }
}

export interface OrdinaryToolDependencies {
  download?: RuntimeArtifactDownloadDependencies;
  /** Tests substitute recipes whose archives they build; production uses the catalog. */
  catalog?: Readonly<Record<OrdinaryToolId, OrdinaryToolCatalogEntry>>;
}

export async function handleOrdinaryToolAction(
  operation: OrdinaryToolAction,
  log: (line: string) => void,
  transport: HostEgressTransport = { mode: "direct" },
  dependencies: OrdinaryToolDependencies = {},
): Promise<OrdinaryToolResult> {
  const catalog = dependencies.catalog ?? ORDINARY_TOOL_CATALOG;
  const entry = catalog[operation.tool_id];
  if (!entry) return { ok: false, error: "This tool is not in the Host's catalog.", tool: null };
  if (busy.has(entry.id)) return { ok: false, error: `${entry.label} already has an operation in progress on this Host.`, tool: null };
  if (inUse.has(entry.id)) return { ok: false, error: `${entry.label} is in use by an account login or status check; retry when it finishes.`, tool: null };
  busy.add(entry.id);
  try {
    await recovering.get(entry.id);
    if (operation.action === "install") await installManaged(entry, operation.version, log, transport, dependencies.download);
    else if (operation.action === "register") await register(entry, operation.path);
    else await remove(entry, operation.source);
    return { ok: true, error: null, tool: await reportFor(entry, await readRegistrations(), true) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`ordinary tool ${operation.action} ${entry.id} failed: ${message}`);
    return { ok: false, error: message.slice(0, 2000), tool: await reportFor(entry, await readRegistrations(), true).catch(() => null) };
  } finally {
    busy.delete(entry.id);
  }
}

async function register(entry: OrdinaryToolCatalogEntry, requested: string | null): Promise<void> {
  let path: string;
  if (requested === null) {
    const found = await resolveOnPath(entry.executable);
    if (!found) throw new Error(`${entry.executable} was not found on this Host's PATH.`);
    path = found;
  } else {
    if (requested.includes("\0") || !isAbsolute(requested)) throw new Error("A registered command must be an absolute path.");
    path = normalize(requested);
    // The name is the catalog's: a registration cannot point `jq` at some
    // other program, and a path is never treated as a command line.
    if (basename(path) !== entry.executable) throw new Error(`The path must name the ${entry.executable} executable.`);
  }
  if (path.startsWith(`${ordinaryToolsRoot()}/`)) throw new Error("Rainver's managed copies are not registered as the machine's own.");
  if (!(await isExecutableFile(path))) throw new Error(`${entry.executable} at that path is not an executable file.`);
  const text = await versionOf(entry, path);
  if (text === null) throw new Error(`${entry.executable} did not answer its version command; it was not registered.`);
  await updateRegistrations((registrations) => ({ ...registrations, [entry.id]: { path } }));
}

async function remove(entry: OrdinaryToolCatalogEntry, source: "managed" | "registered"): Promise<void> {
  if (source === "registered") {
    await updateRegistrations((registrations) => {
      if (!registrations[entry.id]) throw new Error(`${entry.label} has no registration on this Host.`);
      const { [entry.id]: _removed, ...rest } = registrations;
      return rest;
    });
    return;
  }
  // Only the binaries Rainver installed. Personal state is elsewhere.
  if (!(await managedCopy(entry.id))) throw new Error(`${entry.label} has no managed copy on this Host.`);
  await rm(managedRoot(entry.id), { recursive: true, force: true });
}

/**
 * Downloads the pinned archive into a staging directory, verifies its SHA-256
 * and that the extracted executable reports exactly the pinned version, then
 * promotes it. Any failure before promotion leaves the current copy in place.
 */
async function installManaged(
  entry: OrdinaryToolCatalogEntry,
  version: string,
  log: (line: string) => void,
  transport: HostEgressTransport,
  downloadDependencies?: RuntimeArtifactDownloadDependencies,
): Promise<void> {
  const recipe = entry.managed;
  if (!recipe) throw new Error(`${entry.label} has no managed installation; register the machine's own copy instead.`);
  if (recipe.version !== version) {
    throw new Error(`This Host's daemon carries ${entry.label} ${recipe.version}, not ${version}; update the Host first.`);
  }
  const artifact = recipe.platforms[platformKey()];
  if (!artifact) throw new Error(`${entry.label} ${version} has no verified build for this platform (${platformKey()}).`);
  const finalDir = managedDir(entry.id, version);
  const stagingDir = `${finalDir}.installing`;
  const asideDir = `${finalDir}.replaced`;
  // A usable copy an earlier interrupted replacement set aside is restored
  // before anything is downloaded, so a failing download cannot lose it.
  await recoverInterruptedReplacement(entry);
  let movedAside = false;
  try {
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const archive = join(stagingDir, "archive");
    await downloadRuntimeArtifact(artifact.archive, archive, artifact.sha256, log, downloadDependencies, transport);
    await extract(archive, artifact.archive, stagingDir, log);
    await rm(archive, { force: true });
    const command = resolve(stagingDir, artifact.cmd);
    if (!command.startsWith(`${stagingDir}/`)) throw new Error("The archive's command escapes the tool directory.");
    if (!(await isExecutableFile(command))) throw new Error(`The archive did not contain an executable ${artifact.cmd}.`);
    const reported = ordinaryToolVersion(await probeToolVersion(entry, command));
    if (reported !== version) {
      throw new Error(`The downloaded ${entry.label} reported ${reported ?? "no version"} instead of ${version}; the previous installation remains active.`);
    }
    const manifest: ManagedManifest = { tool_id: entry.id, version, cmd: artifact.cmd, installed_at: new Date().toISOString() };
    await writeFile(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (existsSync(finalDir)) {
      await rename(finalDir, asideDir);
      movedAside = true;
    }
    await rename(stagingDir, finalDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (movedAside && !existsSync(finalDir)) {
      try {
        await rename(asideDir, finalDir);
      } catch (restoreError) {
        // The previous copy is still in the recovery directory, which the next
        // operation restores; say so rather than reporting only the first error.
        throw new Error(`${error instanceof Error ? error.message : String(error)}; restoring the previous copy also failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)}) and it was kept for recovery.`);
      }
    }
    throw error;
  }
  // Committed. A cleanup failure must not turn a usable copy into a failure.
  try {
    await rm(asideDir, { recursive: true, force: true });
    for (const sibling of await readdir(managedRoot(entry.id))) {
      if (sibling !== version) await rm(join(managedRoot(entry.id), sibling), { recursive: true, force: true });
    }
  } catch (error) {
    log(`${entry.label} installed; old-version cleanup failed: ${String(error)}`);
  }
  log(`installed ${entry.id} ${version}`);
}
