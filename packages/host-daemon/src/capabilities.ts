import { spawn } from "node:child_process";
import { installedTools, loggedIn, managedInstallationId, OWN_INSTALLATION, type ToolLoginSpec } from "./tools.js";
import { homedir } from "node:os";

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

export interface RuntimeOption {
  value: string;
  name: string | null;
  description: string | null;
}

export interface RuntimeOptions {
  models: RuntimeOption[];
  current_model: string | null;
  efforts: RuntimeOption[];
  current_effort: string | null;
}

/** One copy of a runtime on this machine. */
export interface RuntimeInstallation {
  /** `own` or `managed:<version>`. */
  id: string;
  version: string | null;
  /** Whether its login state exists; null when the runtime declares no login. */
  logged_in: boolean | null;
  /**
   * What this copy says it can be set to, asked over ACP — or, when it could
   * not be asked, just what its config pins (empty lists, current values).
   * Null when neither was available.
   */
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
const optionsCache = new Map<string, { at: number; value: RuntimeOptions | null }>();

/** Exported for tests: the next `detectCapabilities` re-asks every runtime. */
export function __clearRuntimeOptionsCache(): void {
  optionsCache.clear();
}

async function runtimeOptions(
  key: string,
  ask: () => Promise<RuntimeOptions | null>,
): Promise<RuntimeOptions | null> {
  const cached = optionsCache.get(key);
  if (cached && Date.now() - cached.at < OPTIONS_TTL_MS) return cached.value;
  const value = await ask();
  optionsCache.set(key, { at: Date.now(), value });
  return value;
}

/** Asks one copy for its options; the caller decides how (`api.ts`). */
export type AskRuntimeOptions = (lookup: RuntimeLookup, installation: string) => Promise<RuntimeOptions | null>;

export async function detectCapabilities(
  askOptions?: AskRuntimeOptions,
  /** What the server can dispatch to; nothing until `hello_ack` says. */
  lookups: readonly RuntimeLookup[] = [],
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
        runtimes.push(lookup.runtime);
        versions[lookup.runtime] = version;
        const asked = askOptions ? await runtimeOptions(`${lookup.adapter_type}@${OWN_INSTALLATION}`, () => askOptions(lookup, OWN_INSTALLATION)) : null;
        found.push({
          id: OWN_INSTALLATION,
          version,
          logged_in: loggedIn(homedir(), lookup.login),
          // The runtime's own answer needs no parsing; failing that, what its
          // config pins is still better than nothing.
          options: asked ?? await configuredOptions(lookup.runtime),
        });
      }
    }
    for (const manifest of managed.get(lookup.adapter_type) ?? []) {
      const id = managedInstallationId(manifest.version);
      found.push({
        id,
        version: manifest.version,
        logged_in: loggedIn(manifest.home, manifest.login),
        options: askOptions ? await runtimeOptions(`${lookup.adapter_type}@${id}`, () => askOptions(lookup, id)) : null,
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

async function configuredOptions(bin: string): Promise<RuntimeOptions | null> {
  const configured = await probeConfiguredModel(bin);
  if (!configured?.model && !configured?.effort) return null;
  return { models: [], current_model: configured.model, efforts: [], current_effort: configured.effort };
}

/**
 * The model each installed CLI is configured to use, read from that CLI's own
 * configuration.
 *
 * This is what the machine's own login will run on, and the control plane has
 * no other way to know it: an unbound run's model is the CLI's business, not
 * the server's. Without it the composer can only offer "this machine's login"
 * and leave the actual model — opus or sonnet, sol or luna — unstated at the
 * moment someone is choosing.
 *
 * It is the *configured* model, not a runtime-negotiated one: a session
 * switched with an in-CLI command can differ until the change is written back.
 * Read directly rather than by starting each runtime, because a capability
 * probe runs on every heartbeat and starting three agent processes for it
 * would cost far more than the answer is worth.
 */
interface ConfiguredModel {
  model: string | null;
  /**
   * Both CLIs spell effort the same way when it rides on a model id:
   * `model[effort]` — `gpt-5.6-sol[high]`, `claude-fable-5[1m]`. Codex also
   * accepts it as a config key of its own.
   */
  effort: string | null;
}

/** Splits `model[effort]`, which is how both CLIs encode the pair. */
function splitModelEffort(value: string | null): ConfiguredModel {
  if (!value) return { model: null, effort: null };
  const match = /^(?<model>[^[]+?)\[(?<effort>[^\]]+)\]$/.exec(value.trim());
  if (!match?.groups) return { model: value.trim() || null, effort: null };
  return { model: match.groups.model!.trim() || null, effort: match.groups.effort!.trim() || null };
}

async function probeConfiguredModel(bin: string): Promise<ConfiguredModel | null> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const home = homedir();

  const read = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  };

  if (bin === "claude") {
    const raw = await read(process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, "settings.json")
      : join(home, ".claude", "settings.json"));
    return raw ? splitModelEffort(jsonStringField(raw, "model")) : null;
  }
  if (bin === "codex") {
    const raw = await read(join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml"));
    if (!raw) return null;
    // Only the top-level key: a `model` inside a `[profiles.x]` table belongs
    // to that profile, not to the default invocation.
    const topLevel = raw.split(/^\s*\[/m)[0] ?? "";
    const configured = splitModelEffort(/^\s*model\s*=\s*["']([^"']+)["']/m.exec(topLevel)?.[1] ?? null);
    // Codex's own key wins over a bracket suffix: it is the one Codex reads.
    const key = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(topLevel)?.[1];
    return { model: configured.model, effort: key ?? configured.effort };
  }
  if (bin === "opencode") {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const raw = await read(join(home, ".config", "opencode", name));
      const model = raw ? jsonStringField(raw, "model") : null;
      if (model) return splitModelEffort(model);
    }
    return null;
  }
  return null;
}

/**
 * A top-level string value, without parsing the whole document. OpenCode's
 * config is JSONC (comments are legal), so `JSON.parse` cannot be relied on;
 * matching the key at the outermost nesting level is enough for reading one
 * scalar and cannot be fooled by a same-named key inside a nested object.
 */
function jsonStringField(raw: string, key: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const pattern = new RegExp(`^\\s*"${key}"\\s*:\\s*"([^"]*)"`);
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") { depth += 1; continue; }
    if (ch === "}" || ch === "]") { depth -= 1; continue; }
    if (depth === 1 && (ch === "," || ch === "{")) {
      const match = pattern.exec(raw.slice(i + 1, i + 400));
      if (match) return match[1] || null;
    }
  }
  // A single-key document has no comma before it.
  const first = new RegExp(`\\{\\s*"${key}"\\s*:\\s*"([^"]*)"`).exec(raw);
  return first?.[1] || null;
}
