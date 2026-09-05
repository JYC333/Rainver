import { spawn } from "node:child_process";
import { installedTools, loggedIn, managedInstallationId, OWN_INSTALLATION, type ToolLoginSpec, type ToolManifest } from "./tools.js";
import type { RuntimeOptions } from "@rainver/protocol";
import { homedir } from "node:os";
import { terminalAuthAvailable } from "./terminalAuth.js";

/**
 * The daemon discovers whatever the machine already has installed — it
 * never installs or manages a CLI's version tree itself (that would make it
 * a second `runtimeTools` service; ADR 0016 keeps execution-host capability
 * discovery to "what is on PATH right now").
 *
 * *Which* runtimes to look for is the control plane's knowledge, not this
 * daemon's: the adapter specs name them and `hello_ack` passes them down
 * (`runtime_probes`). The daemon itself only ever looks for `git`.
 */
const ALWAYS_PROBED = ["git"] as const;

/** A binary name the capability probe reports, as the adapter spec names it. */
export type ProbedBinary = string;

/** One copy of a runtime on this machine. */
export interface RuntimeInstallation {
  /** `own` or `managed:<version>`. */
  id: string;
  version: string | null;
  /** Whether its login state exists; null when the runtime declares no login. */
  logged_in: boolean | null;
  /** What this copy reports through ACP; null when it could not be asked. */
  options: RuntimeOptions | null;
}

/** What the server says to look for, per adapter (`hello_ack.runtime_probes`). */
export interface RuntimeLookup {
  adapter_type: string;
  /** The PATH binary of the machine's own install; null for a managed-only runtime. */
  runtime: string | null;
  login: ToolLoginSpec | null;
}

/**
 * What this machine can run. One identity for a runtime on a host — the
 * adapter type and the copy — and everything about a copy lives on the
 * copy. `runtimes`/`versions` remain as the plain PATH inventory (vendor
 * binaries and git) for display and for readers that predate installations.
 */
export interface DaemonCapabilities {
  runtimes: ProbedBinary[];
  versions: Partial<Record<ProbedBinary, string>>;
  /** Every copy of every adapter, keyed by adapter type. */
  installations: Record<string, RuntimeInstallation[]>;
}

function probeVersion(bin: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, timeoutMs);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout.trim().split("\n")[0]!.slice(0, 200) : null);
    });
  });
}

/**
 * How long a set of ACP-probed options stays usable. The answer changes only
 * when a CLI is reconfigured or upgraded, while the capability probe itself
 * runs every heartbeat — so this is cached rather than re-asked, because each
 * ask starts an agent process.
 */
const OPTIONS_TTL_MS = 15 * 60 * 1000;
const FAILED_OPTIONS_TTL_MS = 60 * 1000;
const optionsCache = new Map<string, { at: number; value: RuntimeOptions | null }>();

/** Exported for tests: the next `detectCapabilities` re-asks every runtime. */
export function __clearRuntimeOptionsCache(): void {
  optionsCache.clear();
  cliLoginSupport.clear();
}

/** A reconnect is a useful retry boundary, without throwing away valid catalogs. */
export function clearFailedRuntimeOptionsCache(): void {
  for (const [key, cached] of optionsCache) {
    if (cached.value === null) optionsCache.delete(key);
  }
}

/** Authentication changes this copy's session probe immediately. */
export function clearRuntimeOptionsCache(adapterType: string, installation: string): void {
  optionsCache.delete(`${adapterType}@${installation}`);
}

function loginState(home: string, login: ToolLoginSpec | null, options: RuntimeOptions | null): boolean | null {
  const fileState = loggedIn(home, login);
  if (fileState !== null) return fileState;
  return options?.auth_methods?.length ? options.authenticated ?? null : null;
}

/** Built-ins with an explicit host login command keep that flow authoritative. */
function reportedOptions(login: ToolLoginSpec | null, options: RuntimeOptions | null): RuntimeOptions | null {
  if (!login || !options?.auth_methods?.length) return options;
  return { ...options, auth_methods: [] };
}

const cliLoginSupport = new Map<string, Promise<boolean>>();

function supportsManagedCliLogin(manifest: ToolManifest, entryArgs: string[]): Promise<boolean> {
  const key = `${manifest.command}\0${entryArgs.join("\0")}`;
  const cached = cliLoginSupport.get(key);
  if (cached) return cached;
  const result = new Promise<boolean>((resolve) => {
    let settled = false;
    const env = { ...process.env, ...manifest.env, HOME: manifest.home } as Record<string, string | undefined>;
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    const child = spawn(manifest.command, [...entryArgs, "login", "--help"], {
      cwd: manifest.home,
      env,
      stdio: "ignore",
    });
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(supported);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish(false);
    }, 4_000);
    timer.unref?.();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
  cliLoginSupport.set(key, result);
  return result;
}

/**
 * Compatibility for Agents that advertise ACP auth but require their own
 * top-level `login` command first. This is a fixed managed command, not a
 * remotely programmable shell. Old binary manifests safely imply no entry
 * args; old Node package manifests must be reinstalled to learn that prefix.
 */
async function withManagedCliLogin(manifest: ToolManifest, options: RuntimeOptions | null): Promise<RuntimeOptions | null> {
  if (manifest.login || !options || options.cli_login_available || !terminalAuthAvailable()) return options;
  // This compatibility path is only useful for Agents that advertised ACP
  // Agent Auth but cannot complete it until their own CLI has credentials.
  if (!options.auth_methods?.some((method) => method.type === "agent")) return options;
  const entryArgs = manifest.entry_args ?? (manifest.command === process.execPath ? null : []);
  if (!entryArgs) return options;
  if (!(await supportsManagedCliLogin(manifest, entryArgs))) return options;
  return {
    ...options,
    // ACP remains authoritative. This is a Rainver-owned fallback and does
    // not masquerade as an Agent-advertised authentication method.
    cli_login_available: true,
  };
}

async function runtimeOptions(
  key: string,
  ask: () => Promise<RuntimeOptions | null>,
): Promise<RuntimeOptions | null> {
  const cached = optionsCache.get(key);
  const ttl = cached?.value === null ? FAILED_OPTIONS_TTL_MS : OPTIONS_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.value;
  const value = await ask();
  optionsCache.set(key, { at: Date.now(), value });
  return value;
}

/** Asks one copy for its options; the caller decides how (`api.ts`). */
export type AskRuntimeOptions = (lookup: RuntimeLookup, installation: string) => Promise<RuntimeOptions | null>;
export type EnsureOwnRuntime = (lookup: RuntimeLookup) => Promise<boolean>;

export async function detectCapabilities(
  askOptions?: AskRuntimeOptions,
  /** What the server can dispatch to; nothing until `hello_ack` says. */
  lookups: readonly RuntimeLookup[] = [],
  ensureOwnRuntime?: EnsureOwnRuntime,
): Promise<DaemonCapabilities> {
  const runtimes: ProbedBinary[] = [];
  const installations: Record<string, RuntimeInstallation[]> = {};
  const versions: Partial<Record<ProbedBinary, string>> = {};
  const managed = await installedTools();

  for (const lookup of lookups) {
    const found: RuntimeInstallation[] = [];
    if (lookup.runtime) {
      const version = await probeVersion(lookup.runtime);
      if (version !== null) {
        if (ensureOwnRuntime && !(await ensureOwnRuntime(lookup))) continue;
        runtimes.push(lookup.runtime);
        versions[lookup.runtime] = version;
        const asked = askOptions ? await runtimeOptions(`${lookup.adapter_type}@${OWN_INSTALLATION}`, () => askOptions(lookup, OWN_INSTALLATION)) : null;
        found.push({
          id: OWN_INSTALLATION,
          version,
          logged_in: loginState(homedir(), lookup.login, asked),
          options: reportedOptions(lookup.login, asked),
        });
      }
    }
    for (const manifest of managed.get(lookup.adapter_type) ?? []) {
      const id = managedInstallationId(manifest.version);
      const asked = askOptions ? await runtimeOptions(`${lookup.adapter_type}@${id}`, () => askOptions(lookup, id)) : null;
      found.push({
        id,
        version: manifest.version,
        logged_in: loginState(manifest.home, manifest.login, asked),
        options: reportedOptions(manifest.login, await withManagedCliLogin(manifest, asked)),
      });
    }
    if (found.length > 0) installations[lookup.adapter_type] = found;
  }
  for (const bin of ALWAYS_PROBED) {
    const version = await probeVersion(bin);
    if (version === null) continue;
    runtimes.push(bin);
    versions[bin] = version;
  }
  return { runtimes, versions, installations };
}
